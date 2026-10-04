// Browser-side data: cookies, downloads and this tab's navigation history.
// Cookies go through CDP rather than chrome.cookies so no extra permission is
// needed beyond the debugger attachment the extension already uses.

import { respondWith, respondWithError, attachDebugger } from './background-commands.js';

export async function cookiesGet({ tabId }, { urls, name, domain } = {}) {
  return attachDebugger(tabId, async () => {
    const params = Array.isArray(urls) && urls.length ? { urls } : {};
    const { cookies } = await chrome.debugger.sendCommand({ tabId }, 'Network.getCookies', params);

    const filtered = cookies.filter((cookie) =>
      (!name || cookie.name === name) &&
      (!domain || cookie.domain.includes(domain))
    );

    return respondWith(tabId, {
      cookies: filtered.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session',
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite
      })),
      count: filtered.length
    });
  }).catch((error) => respondWithError(tabId, 'COOKIES_GET_FAILED', error.message));
}

export async function cookieSet({ tabId }, { name, value, url, domain, path = '/', secure, httpOnly, sameSite, expires } = {}) {
  if (!name) return respondWithError(tabId, 'NAME_REQUIRED', 'A cookie name is required');

  return attachDebugger(tabId, async () => {
    const params = { name, value: value ?? '', path };
    if (url) params.url = url;
    if (domain) params.domain = domain;
    if (secure !== undefined) params.secure = secure;
    if (httpOnly !== undefined) params.httpOnly = httpOnly;
    if (sameSite) params.sameSite = sameSite;
    if (expires) params.expires = Math.floor(new Date(expires).getTime() / 1000);

    if (!params.url && !params.domain) {
      const tab = await chrome.tabs.get(tabId);
      params.url = tab.url;
    }

    const { success } = await chrome.debugger.sendCommand({ tabId }, 'Network.setCookie', params);
    if (!success) {
      return respondWithError(tabId, 'COOKIE_REJECTED',
        'The browser rejected the cookie - check domain, secure and sameSite against the page URL');
    }
    return respondWith(tabId, { set: true, name });
  }).catch((error) => respondWithError(tabId, 'COOKIE_SET_FAILED', error.message));
}

export async function cookiesClear({ tabId }, { name, domain } = {}) {
  return attachDebugger(tabId, async () => {
    if (!name) {
      // Browser-wide: this signs the user out everywhere, so it is opt-in by
      // omitting a name deliberately.
      await chrome.debugger.sendCommand({ tabId }, 'Network.clearBrowserCookies', {});
      return respondWith(tabId, { cleared: 'all' });
    }

    const { cookies } = await chrome.debugger.sendCommand({ tabId }, 'Network.getCookies', {});
    const targets = cookies.filter((c) => c.name === name && (!domain || c.domain.includes(domain)));
    for (const cookie of targets) {
      await chrome.debugger.sendCommand({ tabId }, 'Network.deleteCookies', {
        name: cookie.name, domain: cookie.domain, path: cookie.path
      });
    }
    return respondWith(tabId, { cleared: targets.length, name });
  }).catch((error) => respondWithError(tabId, 'COOKIES_CLEAR_FAILED', error.message));
}

/** The tab's own back/forward entries - scoped to this tab, not browsing history. */
export async function navHistory({ tabId }, { limit = 25 } = {}) {
  return attachDebugger(tabId, async () => {
    const { currentIndex, entries } = await chrome.debugger.sendCommand(
      { tabId }, 'Page.getNavigationHistory', {}
    );
    const start = Math.max(0, entries.length - limit);
    return respondWith(tabId, {
      currentIndex: currentIndex - start,
      entries: entries.slice(start).map((e, i) => ({
        index: i,
        url: e.url,
        title: e.title,
        current: start + i === currentIndex
      }))
    });
  }).catch((error) => respondWithError(tabId, 'HISTORY_FAILED', error.message));
}

export async function downloadsList({ tabId }, { limit = 20, state } = {}) {
  try {
    const items = await chrome.downloads.search({
      limit,
      orderBy: ['-startTime'],
      ...(state ? { state } : {})
    });
    return respondWith(tabId, {
      downloads: items.map((d) => ({
        id: d.id,
        filename: d.filename,
        url: d.url,
        state: d.state,
        bytesReceived: d.bytesReceived,
        totalBytes: d.totalBytes,
        startTime: d.startTime,
        error: d.error
      })),
      count: items.length
    });
  } catch (error) {
    return respondWithError(tabId, 'DOWNLOADS_FAILED', error.message);
  }
}
