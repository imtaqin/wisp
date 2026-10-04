// Pointer commands beyond a plain click: double click, right click (context
// menu) and drag and drop. All dispatch through CDP so they hit-test at the
// browser level, the same as click/hover.

import {
  getElement,
  respondWith,
  respondWithError,
  respondWithInputWarning,
  attachDebuggerFocused,
  getFromContentScript
} from './background-commands.js';

/** Resolve a target to viewport coordinates: an element's centre, or x/y as given. */
async function resolveTarget(tabId, { selector, xpath, x, y }, { requireVisible = true } = {}) {
  if (typeof x === 'number' && typeof y === 'number') {
    return { x, y };
  }
  if (!selector && !xpath) {
    return { error: respondWithError(tabId, 'SELECTOR_OR_XPATH_REQUIRED',
      'Either selector, xpath, or x/y viewport coordinates are required') };
  }
  const found = await getElement(tabId, selector, xpath, requireVisible);
  if (found.error) return { error: found };

  const { bounds } = found.element;
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, element: found.element };
}

const press = (tabId, params) =>
  chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);

async function pointerAt(tabId, point, dispatch) {
  return attachDebuggerFocused(tabId, async () => {
    await press(tabId, { type: 'mouseMoved', x: point.x, y: point.y });
    await dispatch();
  });
}

export async function doubleClick({ tabId }, { selector, xpath, x, y } = {}) {
  const target = await resolveTarget(tabId, { selector, xpath, x, y });
  if (target.error) return target.error;

  try {
    await getFromContentScript(tabId, '_cursor', { show: true }).catch(() => {});
    await getFromContentScript(tabId, '_moveMouseSVG', { x: target.x, y: target.y, duration: 160 }).catch(() => {});

    await pointerAt(tabId, target, async () => {
      for (const clickCount of [1, 2]) {
        await press(tabId, { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount });
        await press(tabId, { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount });
      }
    });
    getFromContentScript(tabId, '_clickEffect', { x: target.x, y: target.y }).catch(() => {});

    return respondWithInputWarning(tabId, { doubleClicked: true, x: target.x, y: target.y }, selector, xpath);
  } catch (error) {
    return respondWithError(tabId, 'DOUBLE_CLICK_FAILED', error.message, selector, xpath);
  }
}

export async function rightClick({ tabId }, { selector, xpath, x, y } = {}) {
  const target = await resolveTarget(tabId, { selector, xpath, x, y });
  if (target.error) return target.error;

  try {
    await pointerAt(tabId, target, async () => {
      await press(tabId, { type: 'mousePressed', x: target.x, y: target.y, button: 'right', clickCount: 1 });
      await press(tabId, { type: 'mouseReleased', x: target.x, y: target.y, button: 'right', clickCount: 1 });
    });

    // The native context menu is drawn by the browser, not the page: it is not
    // scriptable and not visible to screenshots. Say so rather than implying it.
    const result = await respondWithInputWarning(tabId,
      { rightClicked: true, x: target.x, y: target.y }, selector, xpath);
    result.note = 'Page-level contextmenu handlers fire. A native browser context menu, if one opens, cannot be read or clicked by any tool.';
    return result;
  } catch (error) {
    return respondWithError(tabId, 'RIGHT_CLICK_FAILED', error.message, selector, xpath);
  }
}

export async function dragAndDrop({ tabId }, { selector, xpath, x, y, toSelector, toXpath, toX, toY, steps = 12 } = {}) {
  const from = await resolveTarget(tabId, { selector, xpath, x, y });
  if (from.error) return from.error;

  const to = await resolveTarget(tabId, { selector: toSelector, xpath: toXpath, x: toX, y: toY });
  if (to.error) return to.error;

  try {
    await attachDebuggerFocused(tabId, async () => {
      await press(tabId, { type: 'mouseMoved', x: from.x, y: from.y });
      await press(tabId, { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });

      // Several moves, not one: HTML5 drag and most JS drag libraries only
      // start dragging after movement while the button is down.
      const stepCount = Math.max(2, steps);
      for (let i = 1; i <= stepCount; i++) {
        const t = i / stepCount;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        await press(tabId, { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        await getFromContentScript(tabId, '_moveMouseSVG', { x, y }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 16));
      }

      await press(tabId, { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    });

    return respondWithInputWarning(tabId, {
      dragged: true,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y }
    }, selector, xpath);
  } catch (error) {
    return respondWithError(tabId, 'DRAG_FAILED', error.message, selector, xpath);
  }
}

/**
 * Put local files into a file input. The paths are read by the browser
 * process, so they must exist on the machine running Chrome.
 */
export async function uploadFile({ tabId }, { selector, xpath, files } = {}) {
  const paths = Array.isArray(files) ? files : (files ? [files] : []);
  if (!paths.length) {
    return respondWithError(tabId, 'FILES_REQUIRED', 'A files parameter (path or array of paths) is required', selector, xpath);
  }

  const found = await getElement(tabId, selector, xpath, false);
  if (found.error) return found;

  try {
    return await attachDebuggerFocused(tabId, async () => {
      const { root } = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 0 });
      const { nodeId } = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
        nodeId: root.nodeId,
        selector: found.element.selector
      });
      if (!nodeId) {
        return respondWithError(tabId, 'ELEMENT_NOT_FOUND',
          'The file input could not be resolved in the page', selector, xpath);
      }

      await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { nodeId, files: paths });
      return respondWith(tabId, { uploaded: true, files: paths, selector: found.element.selector }, selector, xpath);
    });
  } catch (error) {
    const hint = /not of type HTMLInputElement|file input/i.test(error.message)
      ? ' The target must be an <input type="file">.'
      : '';
    return respondWithError(tabId, 'UPLOAD_FAILED', error.message + hint, selector, xpath);
  }
}
