// Background service worker - manages WebSocket connections

import { TabManager } from './modules/tab-manager.js';

// Single source of truth for all tab state
const tabManager = new TabManager();

// Auto-connect: every page that loads the content script connects on its own
// (default on, toggled from the popup). Tabs the user switched off by hand are
// remembered for the session and left alone until switched back on.
let autoConnect = true;
const optedOutTabs = new Set();

const settingsReady = Promise.all([
  chrome.storage.local.get('autoConnect').then(({ autoConnect: stored }) => {
    if (typeof stored === 'boolean') autoConnect = stored;
  }),
  // Session storage survives service worker restarts, not browser restarts
  chrome.storage.session.get('optedOutTabs').then(({ optedOutTabs: stored }) => {
    (stored || []).forEach((id) => optedOutTabs.add(id));
  }),
]).catch(() => {});

function setOptedOut(tabId, optedOut) {
  if (optedOut) optedOutTabs.add(tabId);
  else optedOutTabs.delete(tabId);
  chrome.storage.session.set({ optedOutTabs: [...optedOutTabs] }).catch(() => {});
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.autoConnect) {
    autoConnect = changes.autoConnect.newValue !== false;
  }
  if (changes.showMascot) {
    broadcastToTabs('_mascot', { show: changes.showMascot.newValue !== false });
  }
  if (changes.showLog) {
    broadcastToTabs('_log', { show: changes.showLog.newValue !== false });
  }
});

// Push an overlay setting to every tab that has the content script
function broadcastToTabs(command, params) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { command, params }).catch(() => {});
    }
  });
}

const CONNECTABLE = /^https?:/;

// Connect every open http(s) tab. Returns how many are connected afterwards.
async function connectAllTabs() {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((tab) => CONNECTABLE.test(tab.url || ''));
  await Promise.all(targets.map(async (tab) => {
    setOptedOut(tab.id, false);
    try {
      await tabManager.connect(tab.id);
    } catch (e) { /* tab without a content script yet - skipped */ }
  }));
  return countConnected();
}

function disconnectAllTabs() {
  let dropped = 0;
  for (const tabState of tabManager.getAllTabs()) {
    if (tabState.getConnectionState().status === 'disconnected') continue;
    setOptedOut(tabState.tabId, true);
    tabManager.disconnect(tabState.tabId);
    dropped++;
  }
  return dropped;
}

function countConnected() {
  let connected = 0;
  for (const tabState of tabManager.getAllTabs()) {
    if (tabState.getConnectionState().status === 'connected') connected++;
  }
  return connected;
}

// Any HTTP answer means the server is up. It rejects the extension's Origin
// (403), which is still a reply - only a network error means "not running".
async function probeServer() {
  try {
    await fetch('http://127.0.0.1:61822/tabs', { method: 'GET' });
    return true;
  } catch (e) {
    return false;
  }
}

const autoConnecting = new Set(); // guards against overlapping connects per tab

async function maybeAutoConnect(tabId) {
  await settingsReady;
  if (!autoConnect || optedOutTabs.has(tabId) || autoConnecting.has(tabId)) return;
  const tabState = tabManager.getTab(tabId);
  const status = tabState?.getConnectionState().status;
  if (status === 'connected' || status === 'retrying' || tabState?.websocket) return;
  autoConnecting.add(tabId);
  try {
    await tabManager.connect(tabId);
  } catch (e) { /* surfaced through tab state */ }
  finally {
    autoConnecting.delete(tabId);
  }
}

// Helper function to send connection state to content script
function sendConnectionStateToTab(tabId, connectionState) {
  chrome.tabs.sendMessage(tabId, {
    command: '_connectionStateChanged',
    params: {
      status: connectionState.status,
      connected: connectionState.connected
    }
  }).catch(err => {
    // Content script might not be injected yet, ignore error
    console.debug('Could not send connection state to tab:', err);
  });
}

// Listen for tab state changes
tabManager.addListener((tabId, event, tabState, data) => {
  switch (event) {
    case 'stateChanged':
      // Broadcast to all ports for this tab
      tabState.broadcastToPorts({
        type: 'state',
        tabId,
        ...tabState.getConnectionState()
      });

      // Send connection state to content script
      const connectionState = tabState.getConnectionState();
      sendConnectionStateToTab(tabId, connectionState);

      // Update action badge for active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id === tabId) {
          updateActionBadge(tabState.getConnectionState());
        }
      });
      break;

    case 'messageReceived':
    case 'messageSent':
      // Broadcast updated messages to all ports
      tabState.broadcastToPorts({
        type: 'messages',
        tabId,
        messages: tabState.getMessages()
      });
      break;

    case 'messagesCleared':
      tabState.broadcastToPorts({
        type: 'messages',
        tabId,
        messages: []
      });
      break;
  }
});

// Update action badge based on connection status
function updateActionBadge(state) {
  switch (state.status) {
    case 'connected':
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
      break;

    case 'retrying':
      chrome.action.setBadgeText({ text: '↻' });
      chrome.action.setBadgeBackgroundColor({ color: '#ff9800' });
      break;

    case 'disconnected':
    default:
      chrome.action.setBadgeText({ text: '' });
      break;
  }
}

// Handle UI connections
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((msg) => {
    if (msg.type === 'subscribe' && msg.tabId) {
      tabManager.addPort(msg.tabId, port);
    } else if (msg.type === 'clearMessages' && msg.tabId) {
      tabManager.clearMessages(msg.tabId);
    }
  });

  port.onDisconnect.addListener(() => {
    // Remove port from all tabs
    tabManager.getAllTabs().forEach(tabState => {
      tabState.removePort(port);
    });
  });
});

// Handle all messages
// One async handler, one sync listener. The listener must NOT be async: Chrome
// answers the sender with the listener's returned promise, which for an async
// listener resolves to its `return true` - so sendResponse's value is thrown
// away and callers see `true` instead of their result.
async function handleMessage(request, sender) {
  // Messages from content scripts
  if (sender.tab) {
    const tabId = sender.tab.id;

    if (request.type === 'contentScriptReady') {
      console.log(`Content script ready in tab ${tabId}`);

      // Send current connection state to the newly ready content script
      const tabState = tabManager.getTab(tabId);
      if (tabState) {
        sendConnectionStateToTab(tabId, tabState.getConnectionState());
      }

      maybeAutoConnect(tabId);
      return { acknowledged: true };
    }

    if (request.type === 'connect') {
      setOptedOut(tabId, false);
      return await tabManager.connect(tabId);
    }

    if (request.type === 'disconnect') {
      setOptedOut(tabId, true);
      return tabManager.disconnect(tabId);
    }

    if (request.type === 'openPopup') {
      chrome.action.openPopup();
      return { ok: true };
    }

    if (request.type === 'mousePosition') {
      const tabState = tabManager.getTab(tabId);
      if (tabState) {
        tabState.setMousePosition({ x: request.x, y: request.y });
      }
      return undefined;
    }

    return undefined;
  }

  // Messages from the popup / DevTools panel
  if (request.type === 'connect' && request.tabId) {
    setOptedOut(request.tabId, false);
    return await tabManager.connect(request.tabId);
  }

  if (request.type === 'disconnect' && request.tabId) {
    setOptedOut(request.tabId, true);
    return tabManager.disconnect(request.tabId);
  }

  if (request.type === 'getState' && request.tabId) {
    const tabState = tabManager.getTab(request.tabId);
    return tabState ? tabState.getConnectionState() : { connected: false, status: 'disconnected' };
  }

  if (request.type === 'connectAll') {
    return { connected: await connectAllTabs() };
  }

  if (request.type === 'disconnectAll') {
    return { disconnected: disconnectAllTabs() };
  }

  if (request.type === 'getStats') {
    return {
      connected: countConnected(),
      tabs: tabManager.getAllTabs().length,
      serverOnline: await probeServer(),
    };
  }

  if (request.type === 'setEvalAllowed' && request.tabId) {
    return tabManager.setEvalAllowed(request.tabId, request.allowed);
  }

  return undefined;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error('Message handler failed:', request?.type, error);
      sendResponse({ ok: false, error: error.message });
    });
  return true; // answer asynchronously
});

// Update badge when active tab changes
chrome.tabs.onActivated.addListener((activeInfo) => {
  const tabState = tabManager.getTab(activeInfo.tabId);
  if (tabState) {
    updateActionBadge(tabState.getConnectionState());
  } else {
    updateActionBadge({ status: 'disconnected' });
  }
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  setOptedOut(tabId, false);
  tabManager.removeTab(tabId);
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    const destination = { url: 'https://imtaqin.github.io/wisp/install.html' };
    // Navigate the current active tab instead of creating a new one
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.update(tabs[0].id, destination);
      }
      else {
        // Fallback: create a new tab if no active tab is found
        chrome.tabs.create(destination);
      }
    });
  } else if (details.reason === 'update') {
    // Show "what's new" on a real version change. 'update' also fires on every
    // reload of an unpacked extension (same version), so guard on the version
    // actually changing. Open a new tab rather than hijacking the active one,
    // since updates land automatically in the background while the user works.
    const currentVersion = chrome.runtime.getManifest().version;
    if (details.previousVersion && details.previousVersion !== currentVersion) {
      chrome.tabs.create({ url: 'https://imtaqin.github.io/wisp/releases.html' });
    }
  }
});

// Open a friendly page when the user removes the extension.
chrome.runtime.setUninstallURL('https://imtaqin.github.io/wisp/uninstalled.html');
