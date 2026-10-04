// Popup UI

let tabId;
let port;
let isUpdatingUI = false;

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// --- settings (stored, all default on) --------------------------------
const SETTINGS = {
  autoConnect: 'auto-toggle',
  showMascot: 'mascot-toggle',
  showLog: 'log-toggle',
  evalByDefault: 'eval-default-toggle',
};

chrome.storage.local.get(Object.keys(SETTINGS)).then((stored) => {
  for (const [key, elementId] of Object.entries(SETTINGS)) {
    $(elementId).checked = stored[key] !== false;
  }
});

for (const [key, elementId] of Object.entries(SETTINGS)) {
  $(elementId).addEventListener('change', (e) => {
    chrome.storage.local.set({ [key]: e.target.checked });
    toast(e.target.checked ? 'enabled' : 'disabled');
  });
}

// --- current tab ------------------------------------------------------
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  tabId = tab.id;
  $('tab-title').textContent = tab.title || tab.url || 'This tab';

  port = chrome.runtime.connect();
  port.postMessage({ type: 'subscribe', tabId });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'state' && msg.tabId === tabId) {
      updateUI(msg.connected, msg.status, msg.evalAllowed);
    }
  });

  chrome.runtime.sendMessage({ type: 'getState', tabId }, (state) => {
    updateUI(state.connected, state.status, state.evalAllowed);
  });

  refreshStats();
});

$('version').textContent = `v${chrome.runtime.getManifest().version}`;

// --- connection toggles ----------------------------------------------
$('toggle').addEventListener('change', (e) => {
  if (isUpdatingUI) return;
  const type = e.target.checked ? 'connect' : 'disconnect';
  chrome.runtime.sendMessage({ type, tabId }, () => {
    // Reconcile from authoritative state - a failed connect (e.g. content
    // script missing after extension reload) must snap the toggle back.
    chrome.runtime.sendMessage({ type: 'getState', tabId }, (state) => {
      updateUI(state.connected, state.status, state.evalAllowed);
      refreshStats();
    });
  });
});

$('eval-toggle').addEventListener('change', (e) => {
  if (isUpdatingUI) return;
  send({ type: 'setEvalAllowed', tabId, allowed: e.target.checked });
});

// --- quick actions ----------------------------------------------------
$('connect-all').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'connectAll' }, (res) => {
    toast(`${res?.connected ?? 0} tabs connected`);
    refreshStats();
  });
});

$('disconnect-all').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnectAll' }, (res) => {
    toast(`${res?.disconnected ?? 0} tabs dropped`);
    refreshStats();
  });
});

$('dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:61822/' });
  window.close();
});

$('copy-tab').addEventListener('click', async () => {
  await navigator.clipboard.writeText(String(tabId));
  toast(`copied ${tabId}`);
});

$('reconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect', tabId }, () => {
    chrome.runtime.sendMessage({ type: 'connect', tabId }, () => {
      toast('reconnecting');
      refreshStats();
    });
  });
});

$('reload-ext').addEventListener('click', () => {
  chrome.runtime.reload();
  window.close();
});

// --- state rendering --------------------------------------------------
function updateUI(connected, status = 'disconnected', evalAllowed = false) {
  isUpdatingUI = true;

  const card = $('main-card');
  card.classList.remove('connected', 'retrying');
  if (status === 'connected' || status === 'retrying') card.classList.add(status);

  $('toggle').checked = status === 'connected' || status === 'retrying';
  $('status-text').textContent =
    status === 'connected' ? 'Connected' : status === 'retrying' ? 'Connecting' : 'Disconnected';

  // Per-tab "Allow JS" row only means anything once the tab is connected
  const evalRow = $('eval-row');
  const evalToggle = $('eval-toggle');
  evalRow.classList.toggle('disabled', status !== 'connected');
  evalToggle.disabled = status !== 'connected';
  evalToggle.checked = !!evalAllowed;
  $('eval-sub').textContent =
    status !== 'connected' ? 'Connect the tab first'
      : evalAllowed ? 'Scripts allowed - resets on disconnect'
      : 'Clients may run any script here';

  setTimeout(() => { isUpdatingUI = false; }, 100);
}

function refreshStats() {
  chrome.runtime.sendMessage({ type: 'getStats' }, (stats) => {
    if (typeof stats?.connected !== 'number') return;
    const n = stats.connected;
    $('stats').textContent =
      n === 0 ? 'no tabs connected' : n === 1 ? '1 tab connected' : `${n} tabs connected`;

    const server = $('server');
    server.classList.toggle('online', stats.serverOnline);
    server.classList.toggle('offline', !stats.serverOnline);
    $('server-text').textContent = stats.serverOnline ? 'server online' : 'server offline';
  });
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}
