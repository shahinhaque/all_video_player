import { ext } from '../lib/browser.js';

// Setup Context Menus
ext.runtime.onInstalled?.addListener(() => {
  ext.contextMenus.create({
    id: 'cloudplay-open-link',
    title: '▶ Play in CloudPlay',
    contexts: ['link', 'page'],
  });
});

ext.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'cloudplay-open-link') {
    const targetUrl = info.linkUrl || info.pageUrl;
    if (targetUrl) {
      const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(targetUrl)}`);
      ext.tabs.create({ url: playerUrl, index: (tab?.index ?? 0) + 1 });
    }
  }
});

// Handle incoming messages from content scripts
ext.runtime.onMessage?.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OPEN_PLAYER' && message?.url) {
    const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(message.url)}`);
    ext.tabs.create({ url: playerUrl, index: (sender.tab?.index ?? 0) + 1 });
    sendResponse({ ok: true });
  }
  return true;
});
