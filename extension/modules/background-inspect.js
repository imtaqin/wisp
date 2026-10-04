// Inspection commands that need CDP rather than the DOM: waiting for the
// network to go quiet, and reading the accessibility tree.

import { respondWith, respondWithError, attachDebugger } from './background-commands.js';

/**
 * Resolve once no request has been in flight for `quietMs`, or give up at
 * `timeout`. Counts requests from Network events rather than guessing from
 * load events, so XHR/fetch chains after load are covered too.
 */
export async function waitIdle({ tabId }, { quietMs = 500, timeout = 15000 } = {}) {
  return attachDebugger(tabId, async () => {
    let inFlight = 0;
    let quietTimer = null;
    let settle;
    const finished = new Promise((resolve) => { settle = resolve; });

    const armQuiet = () => {
      clearTimeout(quietTimer);
      if (inFlight > 0) return;
      quietTimer = setTimeout(() => settle({ idle: true }), quietMs);
    };

    const listener = (source, method) => {
      if (source.tabId !== tabId) return;
      if (method === 'Network.requestWillBeSent') {
        inFlight++;
        clearTimeout(quietTimer);
      } else if (
        method === 'Network.loadingFinished' ||
        method === 'Network.loadingFailed' ||
        method === 'Network.requestServedFromCache'
      ) {
        inFlight = Math.max(0, inFlight - 1);
        armQuiet();
      }
    };

    const started = Date.now();
    chrome.debugger.onEvent.addListener(listener);
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
      armQuiet(); // already quiet when nothing is pending

      const capped = new Promise((resolve) =>
        setTimeout(() => resolve({ idle: false }), Math.max(0, timeout))
      );
      const outcome = await Promise.race([finished, capped]);
      clearTimeout(quietTimer);

      if (!outcome.idle) {
        return respondWithError(tabId, 'WAIT_TIMEOUT',
          `Network still busy after ${timeout}ms (${inFlight} request(s) in flight)`);
      }
      return respondWith(tabId, { idle: true, waitedMs: Date.now() - started, inFlight });
    } finally {
      chrome.debugger.onEvent.removeListener(listener);
      clearTimeout(quietTimer);
    }
  }).catch((error) => respondWithError(tabId, 'WAIT_IDLE_FAILED', error.message));
}

// Roles that carry no meaning on their own - dropping them keeps the snapshot
// to what a screen reader would actually announce.
const SKIP_ROLES = new Set(['none', 'presentation', 'generic', 'InlineTextBox', 'StaticText']);

/**
 * A compact accessibility tree: what the page exposes to assistive tech, which
 * is usually a far smaller and more stable read than the DOM.
 */
export async function a11ySnapshot({ tabId }, { maxNodes = 400, interestingOnly = true } = {}) {
  return attachDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Accessibility.enable', {});
    const { nodes } = await chrome.debugger.sendCommand({ tabId }, 'Accessibility.getFullAXTree', {});

    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const value = (node, key) => node?.[key]?.value;

    const keep = (node) => {
      if (node.ignored) return false;
      if (!interestingOnly) return true;
      const role = value(node, 'role');
      if (!role || SKIP_ROLES.has(role)) return false;
      return Boolean(value(node, 'name') || node.childIds?.length);
    };

    const out = [];
    const walk = (nodeId, depth) => {
      if (out.length >= maxNodes) return;
      const node = byId.get(nodeId);
      if (!node) return;

      const included = keep(node);
      if (included) {
        const entry = { depth, role: value(node, 'role'), name: value(node, 'name') };
        const val = value(node, 'value');
        if (val !== undefined && val !== '') entry.value = val;
        if (node.backendDOMNodeId) entry.backendDOMNodeId = node.backendDOMNodeId;
        out.push(entry);
      }
      for (const childId of node.childIds || []) {
        walk(childId, included ? depth + 1 : depth);
      }
    };

    const root = nodes[0];
    if (root) walk(root.nodeId, 0);

    return respondWith(tabId, {
      nodes: out,
      nodeCount: out.length,
      truncated: out.length >= maxNodes
    });
  }).catch((error) => respondWithError(tabId, 'A11Y_SNAPSHOT_FAILED', error.message));
}
