// Emulation and whole-page capture. Overrides set here persist for the tab
// until cleared or the debugger detaches, so each command says how to undo it.

import { respondWith, respondWithError, attachDebugger, acquireDebugger, releaseDebugger } from './background-commands.js';

// Overrides outlive a single command, so the debugger session has to stay
// attached. Tracked per tab so clearing releases exactly one reference.
const held = new Map(); // tabId -> Set of override names

async function hold(tabId, name) {
  let names = held.get(tabId);
  if (!names) {
    names = new Set();
    held.set(tabId, names);
  }
  if (names.has(name)) return;
  await acquireDebugger(tabId);
  names.add(name);
}

async function release(tabId, name) {
  const names = held.get(tabId);
  if (!names || !names.has(name)) return;
  names.delete(name);
  if (!names.size) held.delete(tabId);
  await releaseDebugger(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) held.delete(source.tabId);
});

const send = (tabId, method, params = {}) =>
  chrome.debugger.sendCommand({ tabId }, method, params);

export async function setViewport({ tabId }, { width, height, deviceScaleFactor = 0, mobile = false, reset = false } = {}) {
  try {
    if (reset) {
      await hold(tabId, 'viewport');
      await send(tabId, 'Emulation.clearDeviceMetricsOverride');
      await release(tabId, 'viewport');
      return respondWith(tabId, { viewport: 'reset' });
    }

    if (!width || !height) {
      return respondWithError(tabId, 'SIZE_REQUIRED', 'width and height are required (or reset: true)');
    }

    await hold(tabId, 'viewport');
    await send(tabId, 'Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor, mobile
    });
    if (mobile) {
      await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    return respondWith(tabId, { width, height, deviceScaleFactor, mobile, note: 'Call set_viewport with reset: true to restore the real window size' });
  } catch (error) {
    return respondWithError(tabId, 'VIEWPORT_FAILED', error.message);
  }
}

export async function emulate({ tabId }, { colorScheme, reducedMotion, latitude, longitude, accuracy = 50, timezone, locale, userAgent, reset = false } = {}) {
  try {
    if (reset) {
      await hold(tabId, 'emulate');
      await send(tabId, 'Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
      await send(tabId, 'Emulation.clearGeolocationOverride').catch(() => {});
      await send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
      await send(tabId, 'Network.setUserAgentOverride', { userAgent: '' }).catch(() => {});
      await release(tabId, 'emulate');
      return respondWith(tabId, { emulation: 'reset' });
    }

    const applied = {};
    await hold(tabId, 'emulate');

    const features = [];
    if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
    if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion });
    if (features.length) {
      await send(tabId, 'Emulation.setEmulatedMedia', { features });
      Object.assign(applied, { colorScheme, reducedMotion });
    }

    if (typeof latitude === 'number' && typeof longitude === 'number') {
      await send(tabId, 'Emulation.setGeolocationOverride', { latitude, longitude, accuracy });
      applied.geolocation = { latitude, longitude, accuracy };
    }

    if (timezone) {
      await send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: timezone });
      applied.timezone = timezone;
    }

    if (userAgent || locale) {
      await send(tabId, 'Network.setUserAgentOverride', {
        userAgent: userAgent || navigator.userAgent,
        ...(locale ? { acceptLanguage: locale } : {})
      });
      Object.assign(applied, { userAgent: userAgent || undefined, locale });
    }

    if (!Object.keys(applied).length) {
      await release(tabId, 'emulate');
      return respondWithError(tabId, 'NOTHING_TO_EMULATE',
        'Pass colorScheme, reducedMotion, latitude+longitude, timezone, locale or userAgent - or reset: true');
    }

    return respondWith(tabId, { ...applied, note: 'Call emulate with reset: true to clear these overrides' });
  } catch (error) {
    return respondWithError(tabId, 'EMULATE_FAILED', error.message);
  }
}

// Rough profiles; latency in ms, throughput in bytes/second.
const PROFILES = {
  'slow-3g': { latency: 400, downloadThroughput: 50000, uploadThroughput: 50000 },
  'fast-3g': { latency: 150, downloadThroughput: 180000, uploadThroughput: 84000 },
  'slow-4g': { latency: 60, downloadThroughput: 500000, uploadThroughput: 250000 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
};

export async function throttle({ tabId }, { profile, latency, downloadThroughput, uploadThroughput, reset = false } = {}) {
  try {
    await hold(tabId, 'throttle');
    await send(tabId, 'Network.enable');

    if (reset) {
      await send(tabId, 'Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
      });
      await release(tabId, 'throttle');
      return respondWith(tabId, { throttle: 'reset' });
    }

    const preset = profile ? PROFILES[profile] : null;
    if (profile && !preset) {
      await release(tabId, 'throttle');
      return respondWithError(tabId, 'UNKNOWN_PROFILE',
        `Unknown profile "${profile}". Use one of: ${Object.keys(PROFILES).join(', ')}`);
    }

    const conditions = preset || {
      offline: false,
      latency: latency ?? 0,
      downloadThroughput: downloadThroughput ?? -1,
      uploadThroughput: uploadThroughput ?? -1
    };
    await send(tabId, 'Network.emulateNetworkConditions', { offline: false, ...conditions });

    return respondWith(tabId, { applied: profile || conditions, note: 'Call throttle with reset: true to restore full speed' });
  } catch (error) {
    return respondWithError(tabId, 'THROTTLE_FAILED', error.message);
  }
}

export async function blockRequests({ tabId }, { patterns, reset = false } = {}) {
  try {
    await hold(tabId, 'block');
    await send(tabId, 'Network.enable');

    const urls = reset ? [] : (Array.isArray(patterns) ? patterns : (patterns ? [patterns] : []));
    if (!reset && !urls.length) {
      await release(tabId, 'block');
      return respondWithError(tabId, 'PATTERNS_REQUIRED',
        'Pass patterns (wildcards like "*.doubleclick.net/*") or reset: true');
    }

    await send(tabId, 'Network.setBlockedURLs', { urls });
    if (reset) {
      await release(tabId, 'block');
      return respondWith(tabId, { blocking: 'reset' });
    }
    return respondWith(tabId, { blocked: urls, note: 'Call block_requests with reset: true to stop blocking' });
  } catch (error) {
    return respondWithError(tabId, 'BLOCK_FAILED', error.message);
  }
}

export async function pdf({ tabId }, { landscape = false, printBackground = true, scale = 1, paperWidth, paperHeight, pageRanges } = {}) {
  return attachDebugger(tabId, async () => {
    const params = { landscape, printBackground, scale, transferMode: 'ReturnAsBase64' };
    if (paperWidth) params.paperWidth = paperWidth;
    if (paperHeight) params.paperHeight = paperHeight;
    if (pageRanges) params.pageRanges = pageRanges;

    const { data } = await send(tabId, 'Page.printToPDF', params);
    return respondWith(tabId, { mimeType: 'application/pdf', data, encoding: 'base64' });
  }).catch((error) => respondWithError(tabId, 'PDF_FAILED', error.message));
}
