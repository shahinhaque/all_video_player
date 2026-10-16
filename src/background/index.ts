import { ext, getRawBrowser, getRawChrome } from '../lib/browser.js';

// Setup declarativeNetRequest rules to remove restrictive CORS/CORP and Content-Disposition headers for Google Drive & cloud streams
async function setupDeclarativeRules() {
  const dnr = (globalThis as any).chrome?.declarativeNetRequest || (globalThis as any).browser?.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return;

  const extId = (globalThis as any).chrome?.runtime?.id || (globalThis as any).browser?.runtime?.id || ext.runtime?.id;
  const initiatorDomains = extId ? [extId] : undefined;

  const rules: any[] = [
    {
      id: 1000,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
          { header: 'Access-Control-Allow-Headers', operation: 'Range, Accept-Ranges, Content-Type, Authorization' },
          { header: 'Access-Control-Expose-Headers', operation: 'Content-Range, Content-Length, Accept-Ranges' },
          { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
        ],
      },
      condition: {
        urlFilter: '*',
        resourceTypes: ['media', 'xmlhttprequest'],
        ...(initiatorDomains ? { initiatorDomains } : {}),
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
          { header: 'Access-Control-Allow-Headers', operation: 'Range, Accept-Ranges, Content-Type, Authorization' },
          { header: 'Access-Control-Expose-Headers', operation: 'Content-Range, Content-Length, Accept-Ranges' },
          { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
          { header: 'Content-Disposition', operation: 'remove' },
          { header: 'X-Frame-Options', operation: 'remove' },
        ],
      },
      condition: {
        urlFilter: '*://*.googleusercontent.com/*',
        resourceTypes: ['media', 'xmlhttprequest', 'sub_frame'],
        ...(initiatorDomains ? { initiatorDomains } : {}),
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
        ...(initiatorDomains ? { initiatorDomains } : {}),
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
          { header: 'Access-Control-Allow-Headers', operation: 'Range, Accept-Ranges, Content-Type' },
          { header: 'Access-Control-Expose-Headers', operation: 'Content-Range, Content-Length, Accept-Ranges' },
          { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
        ],
      },
      condition: {
        urlFilter: '*://*.userstorage.mega.co.nz/*',
        resourceTypes: ['media', 'xmlhttprequest'],
        ...(initiatorDomains ? { initiatorDomains } : {}),
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
        ...(initiatorDomains ? { initiatorDomains } : {}),
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
        ...(initiatorDomains ? { initiatorDomains } : {}),
      },
    },
  ];

  try {
    await dnr.updateDynamicRules({
      removeRuleIds: [1000, 1001, 1002, 1003, 1004, 1005],
      addRules: rules,
    });
  } catch (err) {
    console.warn('Declarative rules setup error:', err);
  }
}

// Setup Context Menus with persistence across service worker restarts
function setupContextMenu() {
  const title = ext.i18n?.getMessage('contextMenuPlay') || '▶ Play in CloudPlay';
  const menuConfig = {
    id: 'cloudplay-open-link',
    title,
    contexts: ['all'],
  };

  const rawChrome = getRawChrome();
  const rawBrowser = getRawBrowser();
  const api = rawChrome?.contextMenus || rawBrowser?.contextMenus || ext.contextMenus;
  if (!api?.create) return;

  try {
    api.create(menuConfig, () => {
      const lastErr = rawChrome?.runtime?.lastError || rawBrowser?.runtime?.lastError;
      if (lastErr && api.update) {
        api.update('cloudplay-open-link', { title }, () => {
          void rawChrome?.runtime?.lastError;
        });
      }
    });
  } catch {}
}

ext.runtime.onInstalled?.addListener(() => {
  const rawChrome = getRawChrome();
  const rawBrowser = getRawBrowser();
  const api = rawChrome?.contextMenus || rawBrowser?.contextMenus || ext.contextMenus;
  try {
    api?.removeAll?.(() => {
      setupContextMenu();
    });
  } catch {
    setupContextMenu();
  }
  setupDeclarativeRules();
  setupFirefoxWebRequest();
});

setupContextMenu();

// Setup Firefox blocking webRequest for reliable CORS header override
function setupFirefoxWebRequest() {
  const browserApi = getRawBrowser();
  if (!browserApi?.webRequest?.onHeadersReceived) return;

  try {
    const extPrefix = ext.runtime?.getURL ? ext.runtime.getURL('') : '';
    browserApi.webRequest.onHeadersReceived.addListener(
      (details: any) => {
        const origin = details.originUrl || details.documentUrl || '';
        const url = details.url || '';

        // Only modify headers for requests initiated by our extension player, or for targeted cloud stream CDNs
        const isFromExtension = extPrefix && origin.startsWith(extPrefix);
        const isCloudMedia =
          url.includes('googleusercontent.com') ||
          url.includes('drive.google.com') ||
          url.includes('userstorage.mega.co.nz') ||
          url.includes('mega.nz') ||
          url.includes('mega.co.nz');

        if (!isFromExtension && !isCloudMedia) {
          return undefined; // Do not touch normal websites like YouTube, Twitter, etc.
        }

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
      { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
      ['blocking', 'responseHeaders']
    );
  } catch (err) {
    console.warn('Firefox webRequest setup failed:', err);
  }
}

setupFirefoxWebRequest();

let lastRightClickedUrl: string | null = null;

ext.contextMenus?.onClicked.addListener((info: any, tab: any) => {
  if (info.menuItemId === 'cloudplay-open-link') {
    const targetUrl = lastRightClickedUrl || info.linkUrl || info.srcUrl || info.pageUrl || tab?.url;
    lastRightClickedUrl = null;
    if (targetUrl) {
      const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(targetUrl)}`);
      const createOptions: any = {
        url: playerUrl,
        index: (tab?.index ?? 0) + 1,
      };
      if (tab?.windowId !== undefined) {
        createOptions.windowId = tab.windowId;
      }
      ext.tabs.create(createOptions);
    }
  }
});

// Handle incoming messages from content scripts and player page
const rawBrowser = getRawBrowser();
const msgTarget = rawBrowser?.runtime?.onMessage ? rawBrowser : ext;

msgTarget.runtime.onMessage?.addListener((message: any, sender: any, sendResponse: any) => {
  const isFirefox = (typeof __TARGET__ !== 'undefined' && __TARGET__ === 'firefox') || !!rawBrowser?.runtime;

  if (message?.type === 'SET_CONTEXT_URL' && message?.url) {
    lastRightClickedUrl = message.url;
    sendResponse({ ok: true });
    return isFirefox ? Promise.resolve({ ok: true }) : true;
  }

  if (message?.type === 'OPEN_PLAYER' && message?.url) {
    const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(message.url)}`);
    const winId = sender.tab?.windowId;
    const createOptions: any = {
      url: playerUrl,
      index: (sender.tab?.index ?? 0) + 1,
    };
    if (winId !== undefined) {
      createOptions.windowId = winId;
    }
    ext.tabs.create(createOptions);
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
