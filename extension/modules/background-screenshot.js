// Import helper functions from background-commands
import { getElement, getTabInfo, respondWithError, attachDebugger, getFromContentScript } from './background-commands.js';

/** The rendered document box, for full-page captures. */
async function documentSize(tabId) {
  return attachDebugger(tabId, async () => {
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics', {});
    const size = metrics.cssContentSize || metrics.contentSize;
    return { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height) };
  });
}

export async function screenshot({tabId}, { scale = 0.5, quality = 0.5, format = 'webp', selector, xpath, fullPage = false }) {
  let elementResult;
  if (selector || xpath) {
    // No visibility requirement: captureBeyondViewport renders the whole page,
    // so elements outside the current viewport are still capturable.
    elementResult = await getElement(tabId, selector, xpath);
    if (elementResult.error) return elementResult;
    const { width, height } = elementResult.element.bounds;
    if (!(width > 0) || !(height > 0)) {
      return respondWithError(tabId, 'SCREENSHOT_ERROR', 'Element has no rendered size (display:none or collapsed)', selector, xpath);
    }
  }
  else {
    elementResult = await getTabInfo(tabId)
    // fullPage measures the rendered document rather than the window, so the
    // capture covers everything below the fold in one image.
    const pageSize = fullPage ? await documentSize(tabId) : null;
    elementResult.element = {
      bounds: pageSize || {
        x: 0,
        y: 0,
        width: elementResult.viewportDimensions.width,
        height: elementResult.viewportDimensions.height
      }
    };
  }

  const clip = { ...elementResult.element.bounds };

  // Bounds are viewport-relative; the clip needs document coordinates.
  // This holds for fixed positioned elements too: the capture renders them
  // at their on-screen position mapped to document coordinates. A full-page
  // clip is already in document coordinates, so it is left alone.
  if (!fullPage || selector || xpath) {
    clip.x += elementResult.scrollPosition.x;
    clip.y += elementResult.scrollPosition.y;
  }

  if (scale) {
    clip.scale = scale;
  }

  // Keep the control overlay (border, badge, cursor) out of the capture
  await getFromContentScript(tabId, '_capturing', { on: true }).catch(() => {});

  return attachDebugger(tabId, async () => {
    const screenshot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format,
      quality: Math.round(quality * 100), // Chrome needs an integer percentage,
      clip,
      // Element captures work anywhere on the page; viewport captures are the
      // viewport by definition, so skip the full-page render the flag forces.
      captureBeyondViewport: !!(selector || xpath || fullPage)
    });

    return {
      success: true,
      ...elementResult,
      element: undefined,
      selector: elementResult.element?.selector || undefined,
      mimeType: `image/${format}`,
      data: screenshot.data,
    };
  })
  .catch((err) => {
    return respondWithError(tabId,'SCREENSHOT_ERROR', err.message, null, null);
  })
  .finally(() => getFromContentScript(tabId, '_capturing', { on: false }).catch(() => {}));
}