import { ext } from '../lib/browser.js';

// Setup declarativeNetRequest rules to remove restrictive CORS/CORP and Content-Disposition headers for Google Drive & cloud streams
function setupDeclarativeRules() {
  const dnr = (globalThis as any).chrome?.declarativeNetRequest || (globalThis as any).browser?.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return;

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
          resourceTypes: ['media', 'xmlhttprequest', 'sub_frame', 'other'],
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
  const title = ext.i18n?.getMessage('contextMenuPlay') || '▶ Play in CloudPlay';
  ext.contextMenus.create({
    id: 'cloudplay-open-link',
    title,
    contexts: ['link', 'page'],
  });
  setupDeclarativeRules();
});

// Also ensure rules are active on startup
setupDeclarativeRules();

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
  if (message?.type === 'OPEN_PLAYER' && message?.url) {
    const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(message.url)}`);
    ext.tabs.create({ url: playerUrl, index: (sender.tab?.index ?? 0) + 1 });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === 'FETCH_TEXT' && message?.url) {
    fetch(message.url)
      .then(async (res) => {
        const text = await res.text();
        sendResponse({ ok: res.ok, text, status: res.status });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }
  return true;
});
