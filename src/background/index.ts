import { ext } from '../lib/browser.js';

// Setup declarativeNetRequest rules to remove restrictive CORS/CORP and Content-Disposition headers for Google Drive & cloud streams
async function setupDeclarativeRules() {
  const dnr = (globalThis as any).chrome?.declarativeNetRequest || (globalThis as any).browser?.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return;

  try {
    if (dnr.getDynamicRules) {
      const existing = await dnr.getDynamicRules();
      if (existing && existing.length >= 6) {
        return;
      }
    }
  } catch {}

  dnr.updateDynamicRules({
    removeRuleIds: [1000, 1001, 1002, 1003, 1004, 1005],
    addRules: [
      {
        id: 1000,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Accept-Ranges, Content-Type, Authorization' },
            { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Range, Content-Length, Accept-Ranges' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
          ],
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['media', 'xmlhttprequest'],
        },
      },
      {
        id: 1001,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Accept-Ranges, Content-Type, Authorization' },
            { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Range, Content-Length, Accept-Ranges' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
            { header: 'Content-Disposition', operation: 'remove' },
            { header: 'X-Frame-Options', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '*://*.googleusercontent.com/*',
          resourceTypes: ['media', 'xmlhttprequest', 'sub_frame'],
        },
      },
      {
        id: 1002,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
            { header: 'Content-Disposition', operation: 'remove' },
            { header: 'X-Frame-Options', operation: 'remove' },
            { header: 'Content-Security-Policy', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '*://drive.google.com/*',
          resourceTypes: ['media', 'xmlhttprequest', 'sub_frame'],
        },
      },
      {
        id: 1003,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Accept-Ranges, Content-Type' },
            { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Range, Content-Length, Accept-Ranges' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
          ],
        },
        condition: {
          urlFilter: '*://*.userstorage.mega.co.nz/*',
          resourceTypes: ['media', 'xmlhttprequest'],
        },
      },
      {
        id: 1004,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
          ],
        },
        condition: {
          urlFilter: '*://*.mega.co.nz/*',
          resourceTypes: ['media', 'xmlhttprequest'],
        },
      },
      {
        id: 1005,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
          ],
        },
        condition: {
          urlFilter: '*://*.mega.nz/*',
          resourceTypes: ['media', 'xmlhttprequest'],
        },
      },
    ],
  }).catch(() => {});
}

// Setup Context Menus and Declarative Rules
ext.runtime.onInstalled?.addListener(() => {
  try {
    ext.contextMenus?.removeAll(() => {
      const title = ext.i18n?.getMessage('contextMenuPlay') || '▶ Play in CloudPlay';
      ext.contextMenus?.create({
        id: 'cloudplay-open-link',
        title,
        contexts: ['link', 'page'],
      });
    });
  } catch {}
  setupDeclarativeRules();
  setupFirefoxWebRequest();
});

// Setup Firefox blocking webRequest for reliable CORS header override
function setupFirefoxWebRequest() {
  const browserApi = (globalThis as any).browser;
  if (!browserApi?.webRequest?.onHeadersReceived) return;

  try {
    browserApi.webRequest.onHeadersReceived.addListener(
      (details: any) => {
        const headers = details.responseHeaders || [];
        const setHeader = (name: string, value: string) => {
          const idx = headers.findIndex((h: any) => h.name.toLowerCase() === name.toLowerCase());
          if (idx !== -1) headers[idx].value = value;
          else headers.push({ name, value });
        };
        setHeader('Access-Control-Allow-Origin', '*');
        setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        setHeader('Access-Control-Allow-Headers', 'Range, Accept-Ranges, Content-Type, Authorization');
        setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        return { responseHeaders: headers };
      },
      { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media'] },
      ['blocking', 'responseHeaders']
    );
  } catch (err) {
    console.warn('Firefox webRequest setup failed:', err);
  }
}

setupFirefoxWebRequest();

ext.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'cloudplay-open-link') {
    const targetUrl = info.linkUrl || info.pageUrl;
    if (targetUrl) {
      const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(targetUrl)}`);
      ext.tabs.create({ url: playerUrl, index: (tab?.index ?? 0) + 1 });
    }
  }
});

// Handle incoming messages from content scripts and player page
ext.runtime.onMessage?.addListener((message, sender, sendResponse) => {
  const isFirefox = (typeof __TARGET__ !== 'undefined' && __TARGET__ === 'firefox') || typeof (globalThis as any).browser?.runtime !== 'undefined';

  if (message?.type === 'OPEN_PLAYER' && message?.url) {
    const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(message.url)}`);
    ext.tabs.create({ url: playerUrl, index: (sender.tab?.index ?? 0) + 1 });
    sendResponse({ ok: true });
    return isFirefox ? Promise.resolve({ ok: true }) : true;
  }

  if (message?.type === 'FETCH_TEXT' && message?.url) {
    const fetchPromise = fetch(message.url)
      .then(async (res) => {
        const text = await res.text();
        const data = { ok: res.ok, text, status: res.status };
        try { sendResponse(data); } catch {}
        return data;
      })
      .catch((err) => {
        const data = { ok: false, error: err?.message || String(err) };
        try { sendResponse(data); } catch {}
        return data;
      });

    // In Firefox WebExtensions, returning a Promise directly resolves browser.runtime.sendMessage.
    // In Chrome, returning true keeps the sendResponse callback channel open.
    if (isFirefox) {
      return fetchPromise;
    }
    return true;
  }

  if (message?.type === 'FETCH_RANGE' && message?.url) {
    const rangeHeader = message.range || message.headers?.Range;
    const fetchRangePromise = fetch(message.url, {
      headers: rangeHeader ? { Range: rangeHeader } : undefined,
    })
      .then(async (res) => {
        const buf = await res.arrayBuffer();
        const data = {
          ok: res.ok || res.status === 206,
          status: res.status,
          contentRange: res.headers.get('content-range'),
          contentLength: res.headers.get('content-length'),
          contentType: res.headers.get('content-type'),
          bytes: new Uint8Array(buf),
        };
        try { sendResponse(data); } catch {}
        return data;
      })
      .catch((err) => {
        const data = { ok: false, error: err?.message || String(err) };
        try { sendResponse(data); } catch {}
        return data;
      });

    if (isFirefox) {
      return fetchRangePromise;
    }
    return true;
  }

  return undefined;
});
