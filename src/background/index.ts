import { ext, getRawBrowser, getRawChrome } from '../lib/browser.js';

// Setup declarativeNetRequest rules strictly for media streams initiated by our extension player
let dnrSetupPromise: Promise<void> | null = null;

function setupDeclarativeRules(): Promise<void> {
  if (dnrSetupPromise) return dnrSetupPromise;
  dnrSetupPromise = (async () => {
    const dnr = (globalThis as any).chrome?.declarativeNetRequest || (globalThis as any).browser?.declarativeNetRequest;
    if (!dnr?.updateDynamicRules) return;

    // Always purge ALL existing dynamic rules first so no stale or global wildcard rules persist
    try {
      const existing = await dnr.getDynamicRules?.();
      if (existing && existing.length > 0) {
        await dnr.updateDynamicRules({ removeRuleIds: existing.map((r: any) => r.id) });
      }
      const session = await dnr.getSessionRules?.();
      if (session && session.length > 0) {
        await dnr.updateSessionRules({ removeRuleIds: session.map((r: any) => r.id) });
      }
    } catch (err) {
      console.warn('Error clearing previous DNR rules:', err);
    }

    const extId = (globalThis as any).chrome?.runtime?.id || (globalThis as any).browser?.runtime?.id || ext.runtime?.id;
    // If extId is not a valid string, never register any rules — never risk global interception
    if (!extId || typeof extId !== 'string') return;

    const rules: any[] = [
      {
        id: 1000,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'X-Requested-With', operation: 'set', value: 'XMLHttpRequest' },
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Accept-Ranges, Content-Type, Authorization, X-Requested-With' },
            { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Range, Content-Length, Accept-Ranges' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
            { header: 'Content-Disposition', operation: 'remove' },
            { header: 'X-Content-Type-Options', operation: 'remove' },
            { header: 'Content-Type', operation: 'set', value: 'text/plain' },
          ],
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['xmlhttprequest'],
          initiatorDomains: [extId],
        },
      },
      {
        id: 1009,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'X-Requested-With', operation: 'set', value: 'XMLHttpRequest' },
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Accept-Ranges, Content-Type, Authorization, X-Requested-With' },
            { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Range, Content-Length, Accept-Ranges' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
            { header: 'Content-Disposition', operation: 'remove' },
            { header: 'X-Content-Type-Options', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['media'],
          initiatorDomains: [extId],
        },
      },
      {
        id: 1010,
        priority: 3,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'X-Requested-With', operation: 'set', value: 'XMLHttpRequest' },
          ],
          responseHeaders: [
            { header: 'Content-Disposition', operation: 'remove' },
            { header: 'X-Content-Type-Options', operation: 'remove' },
            { header: 'Content-Type', operation: 'set', value: 'video/webm' },
          ],
        },
        condition: {
          urlFilter: '*.mkv*',
          resourceTypes: ['media'],
          initiatorDomains: [extId],
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
          ],
        },
        condition: {
          urlFilter: '*://*.googleusercontent.com/*',
          resourceTypes: ['media', 'xmlhttprequest', 'sub_frame'],
          initiatorDomains: [extId],
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
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Accept-Ranges, Content-Type, Authorization' },
            { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Range, Content-Length, Accept-Ranges' },
            { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
            { header: 'Content-Disposition', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '*://drive.usercontent.google.com/*',
          resourceTypes: ['media', 'xmlhttprequest', 'sub_frame'],
          initiatorDomains: [extId],
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
          initiatorDomains: [extId],
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
          initiatorDomains: [extId],
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
          initiatorDomains: [extId],
        },
      },
      {
        id: 1006,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'X-Frame-Options', operation: 'remove' },
            { header: 'Content-Security-Policy', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '*://*.youtube.com/embed/*',
          resourceTypes: ['sub_frame'],
          initiatorDomains: [extId, 'youtube.com', 'www.youtube.com', 'drive.google.com'],
        },
      },
      {
        id: 1007,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'X-Frame-Options', operation: 'remove' },
            { header: 'Content-Security-Policy', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '*://*.youtube-nocookie.com/embed/*',
          resourceTypes: ['sub_frame'],
          initiatorDomains: [extId, 'youtube.com', 'www.youtube.com', 'drive.google.com'],
        },
      },
      {
        id: 1008,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'X-Frame-Options', operation: 'remove' },
            { header: 'Content-Security-Policy', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '*://drive.google.com/file/*/preview*',
          resourceTypes: ['sub_frame'],
          initiatorDomains: [extId, 'drive.google.com'],
        },
      },
    ];

    try {
      await dnr.updateDynamicRules({
        addRules: rules,
      });
    } catch (err) {
      console.warn('Declarative rules setup error:', err);
    }
  })().finally(() => {
    dnrSetupPromise = null;
  });
  return dnrSetupPromise;
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
setupDeclarativeRules();

// Setup Firefox blocking webRequest for reliable CORS header override
function setupFirefoxWebRequest() {
  const browserApi = getRawBrowser();
  if (!browserApi?.webRequest?.onHeadersReceived) return;

  try {
    const extPrefix = ext.runtime?.getURL ? ext.runtime.getURL('') : '';
    browserApi.webRequest.onHeadersReceived.addListener(
      (details: any) => {
        const origin = details.originUrl || details.documentUrl || '';

        // STRICT SAFETY: Only modify headers for requests initiated by our extension player!
        // Never touch requests initiated by Google Drive, YouTube, or any web page.
        const isFromExtension = Boolean(extPrefix && origin.startsWith(extPrefix));
        if (!isFromExtension) {
          return undefined;
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

let lastRightClicked: { url: string; tabId?: number; timestamp: number } | null = null;

// Track download manager extensions temporarily paused while CloudPlay player is open
const pausedDownloadManagerIds = new Set<string>();
const activePlayerTabIds = new Set<number>();

function getManagementApi(): any {
  const rawChrome = getRawChrome();
  const rawBrowser = getRawBrowser();
  return rawChrome?.management || rawBrowser?.management || (ext as any)?.management;
}

function getAllExtensions(mgmt: any): Promise<any[]> {
  return new Promise((resolve) => {
    try {
      const res = mgmt.getAll((items: any[]) => {
        if (Array.isArray(items)) resolve(items);
      });
      if (res && typeof res.then === 'function') {
        res.then((items: any[]) => resolve(Array.isArray(items) ? items : [])).catch(() => resolve([]));
      }
    } catch {
      resolve([]);
    }
  });
}

function setExtensionEnabled(mgmt: any, id: string, enabled: boolean): Promise<void> {
  return new Promise((resolve) => {
    try {
      const res = mgmt.setEnabled(id, enabled, () => resolve());
      if (res && typeof res.then === 'function') {
        res.then(() => resolve()).catch(() => resolve());
      }
    } catch {
      resolve();
    }
  });
}

let suppressPromise: Promise<void> | null = null;

async function suppressDownloadManagers(tabId?: number): Promise<void> {
  if (typeof tabId === 'number' && tabId >= 0) {
    activePlayerTabIds.add(tabId);
  }
  if (suppressPromise) {
    return suppressPromise;
  }
  suppressPromise = (async () => {
    const mgmt = getManagementApi();
    if (!mgmt?.getAll || !mgmt?.setEnabled) return;

    try {
      const stored = await ext.storage?.local?.get?.('pausedDownloadManagers');
      if (Array.isArray(stored?.pausedDownloadManagers)) {
        for (const id of stored.pausedDownloadManagers) {
          if (typeof id === 'string') pausedDownloadManagerIds.add(id);
        }
      }
    } catch {}

    const selfId = ext.runtime?.id;
    const all = await getAllExtensions(mgmt);
    let changed = false;

    for (const item of all) {
      if (!item || !item.id || item.id === selfId || (item.type && item.type !== 'extension')) continue;
      const text = `${item.name || ''} ${item.shortName || ''} ${item.description || ''} ${item.homepageUrl || ''}`;
      const isDownloadManager =
        item.id === 'ngpampappnmepgilojfohadhhmbhlaek' || // Official IDM Integration Module
        /\bidm\b|internet download manager|idm integration|tonec|neat download manager|eagleget|xtreme download manager/i.test(text);

      if (isDownloadManager && item.enabled) {
        await setExtensionEnabled(mgmt, item.id, false);
        pausedDownloadManagerIds.add(item.id);
        changed = true;
      }
    }

    if (changed) {
      try {
        await ext.storage?.local?.set?.({
          pausedDownloadManagers: Array.from(pausedDownloadManagerIds),
        });
      } catch {}
      // Allow Chrome 80ms to fully tear down the disabled extension's webRequest listeners and native host
      await new Promise((r) => setTimeout(r, 80));
    }
  })().finally(() => {
    suppressPromise = null;
  });

  return suppressPromise;
}

async function restoreDownloadManagers(): Promise<void> {
  const mgmt = getManagementApi();
  if (!mgmt?.setEnabled) return;

  try {
    const stored = await ext.storage?.local?.get?.('pausedDownloadManagers');
    if (Array.isArray(stored?.pausedDownloadManagers)) {
      for (const id of stored.pausedDownloadManagers) {
        if (typeof id === 'string') pausedDownloadManagerIds.add(id);
      }
    }
  } catch {}

  if (pausedDownloadManagerIds.size === 0) return;
  const ids = Array.from(pausedDownloadManagerIds);
  pausedDownloadManagerIds.clear();

  for (const id of ids) {
    await setExtensionEnabled(mgmt, id, true);
  }

  try {
    await ext.storage?.local?.remove?.('pausedDownloadManagers');
  } catch {}
}

function queryAllTabs(): Promise<any[]> {
  const rawChrome = getRawChrome();
  const rawBrowser = getRawBrowser();
  const tabsApi = rawChrome?.tabs || rawBrowser?.tabs || ext.tabs;
  if (!tabsApi?.query) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const res = tabsApi.query({}, (tabs: any[]) => {
        if (Array.isArray(tabs)) resolve(tabs);
      });
      if (res && typeof res.then === 'function') {
        res.then((tabs: any[]) => resolve(Array.isArray(tabs) ? tabs : [])).catch(() => resolve([]));
      }
    } catch {
      resolve([]);
    }
  });
}

async function checkPlayerTabsState(): Promise<void> {
  const playerPrefix = ext.runtime?.getURL ? ext.runtime.getURL('player.html') : 'player.html';
  const tabs = await queryAllTabs();
  const playerTabs = tabs.filter((t) => {
    const u = t?.url || t?.pendingUrl || '';
    return u.startsWith(playerPrefix) || u.includes('/player.html') || activePlayerTabIds.has(t?.id);
  });

  if (playerTabs.length > 0) {
    for (const pt of playerTabs) {
      if (typeof pt?.id === 'number') activePlayerTabIds.add(pt.id);
    }
    await suppressDownloadManagers();
  } else if (activePlayerTabIds.size === 0) {
    closeAllStreamSessions();
    await restoreDownloadManagers();
  }
}

const rawChromeForTabs = getRawChrome();
const rawBrowserForTabs = getRawBrowser();
const tabsEvents = rawChromeForTabs?.tabs || rawBrowserForTabs?.tabs || (ext.tabs as any);
tabsEvents?.onRemoved?.addListener?.((tabId: number) => {
  activePlayerTabIds.delete(tabId);
  void checkPlayerTabsState();
});

void checkPlayerTabsState();

// Persistent Single-Connection Stream Reader to avoid firing repeated Range GET requests during playback
interface ActiveStreamSession {
  url: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abortCtrl: AbortController;
  buffer: Uint8Array;
  bufferStart: number;
  streamOffset: number;
  totalSize: number;
  contentType: string | null;
  status: number;
  eof: boolean;
  busy: boolean;
  lastUsed: number;
}

const activeStreams = new Map<string, ActiveStreamSession>();

function closeStreamSession(url: string): void {
  const s = activeStreams.get(url);
  if (!s) return;
  activeStreams.delete(url);
  try { s.reader.cancel().catch(() => {}); } catch {}
  try { s.abortCtrl.abort(); } catch {}
}

function closeAllStreamSessions(): void {
  for (const url of Array.from(activeStreams.keys())) {
    closeStreamSession(url);
  }
}

function maskDirectMediaUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.search && u.pathname.toLowerCase().endsWith('.mkv')) {
      u.search = '?_cp=1.vtt';
      return u.href;
    }
  } catch {}
  return rawUrl;
}

async function openStreamSession(url: string, startByte: number): Promise<ActiveStreamSession> {
  closeStreamSession(url);

  // Evict stale stream sessions if more than 2 URLs are cached
  if (activeStreams.size >= 2) {
    let oldestUrl = '';
    let oldestTime = Infinity;
    for (const [k, v] of activeStreams.entries()) {
      if (!v.busy && v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestUrl = k;
      }
    }
    if (oldestUrl) closeStreamSession(oldestUrl);
  }

  const abortCtrl = new AbortController();
  const maskedUrl = maskDirectMediaUrl(url);
  let res = await fetch(maskedUrl, {
    headers: {
      Range: `bytes=${startByte}-`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: abortCtrl.signal,
  });

  if (!res.ok && res.status !== 206 && maskedUrl !== url) {
    res = await fetch(url, {
      headers: {
        Range: `bytes=${startByte}-`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: abortCtrl.signal,
    });
  }

  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error('Empty response body');
  }

  const cr = res.headers.get('content-range');
  const cl = res.headers.get('content-length');
  let totalSize = 0;
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) totalSize = parseInt(m[1], 10);
  } else if (cl) {
    const parsedLen = parseInt(cl, 10);
    if (res.status === 200) {
      totalSize = parsedLen;
    } else if (res.status === 206) {
      totalSize = startByte + parsedLen;
    }
  }

  const actualStart = res.status === 200 ? 0 : startByte;
  const session: ActiveStreamSession = {
    url,
    reader: res.body.getReader(),
    abortCtrl,
    buffer: new Uint8Array(0),
    bufferStart: actualStart,
    streamOffset: actualStart,
    totalSize,
    contentType: res.headers.get('content-type'),
    status: res.status,
    eof: false,
    busy: false,
    lastUsed: Date.now(),
  };

  activeStreams.set(url, session);
  return session;
}

async function readRangeFromPersistentStream(
  url: string,
  start: number,
  end: number
): Promise<{
  bytes: Uint8Array;
  totalSize: number;
  contentType: string | null;
  status: number;
  contentRange: string | null;
}> {
  let session = activeStreams.get(url);

  const canReuse =
    session &&
    !session.busy &&
    start >= session.bufferStart &&
    start <= session.streamOffset + 512 * 1024;

  if (!canReuse) {
    session = await openStreamSession(url, start);
  }

  session!.busy = true;
  session!.lastUsed = Date.now();

  try {
    const targetEndExclusive = session!.totalSize > 0
      ? Math.min(end + 1, session!.totalSize)
      : end + 1;

    const newChunks: Uint8Array[] = [];
    let newBytesLen = 0;

    while (!session!.eof && session!.streamOffset + newBytesLen < targetEndExclusive) {
      const { done, value } = await session!.reader.read();
      if (done || !value) {
        session!.eof = true;
        break;
      }
      newChunks.push(value);
      newBytesLen += value.byteLength;
    }

    if (newBytesLen > 0) {
      const merged = new Uint8Array(session!.buffer.byteLength + newBytesLen);
      merged.set(session!.buffer, 0);
      let off = session!.buffer.byteLength;
      for (const c of newChunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      session!.buffer = merged;
      session!.streamOffset += newBytesLen;
    }

    const relStart = Math.max(0, start - session!.bufferStart);
    const relEnd = Math.min(session!.buffer.byteLength, targetEndExclusive - session!.bufferStart);
    const slice =
      relEnd > relStart
        ? session!.buffer.slice(relStart, relEnd)
        : new Uint8Array(0);

    // Keep at most 4 MB in rolling buffer, retaining at least 384 KB before current start for header/cluster overlap
    const MAX_BUFFER = 4 * 1024 * 1024;
    const KEEP_BEHIND = 384 * 1024;
    if (session!.buffer.byteLength > MAX_BUFFER) {
      const trimTo = Math.max(
        session!.bufferStart,
        Math.min(start - KEEP_BEHIND, session!.streamOffset - 2 * 1024 * 1024)
      );
      const dropBytes = trimTo - session!.bufferStart;
      if (dropBytes > 256 * 1024 && dropBytes < session!.buffer.byteLength) {
        session!.buffer = session!.buffer.slice(dropBytes);
        session!.bufferStart += dropBytes;
      }
    }

    const actualEnd = slice.byteLength > 0 ? start + slice.byteLength - 1 : start;
    const cr =
      session!.totalSize > 0
        ? `bytes ${start}-${actualEnd}/${session!.totalSize}`
        : null;

    return {
      bytes: slice,
      totalSize: session!.totalSize,
      contentType: session!.contentType,
      status: 206,
      contentRange: cr,
    };
  } catch (err) {
    closeStreamSession(url);
    throw err;
  } finally {
    if (session) session.busy = false;
  }
}

function openPlayerTab(url: string, tab?: any): void {
  void suppressDownloadManagers();
  const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(url)}`);
  const createOptions: any = {
    url: playerUrl,
    index: (tab?.index ?? 0) + 1,
  };
  if (tab?.windowId !== undefined) {
    createOptions.windowId = tab.windowId;
  }
  ext.tabs.create(createOptions, (createdTab?: any) => {
    if (typeof createdTab?.id === 'number') {
      activePlayerTabIds.add(createdTab.id);
    }
  });
}

ext.contextMenus?.onClicked.addListener((info: any, tab: any) => {
  if (info.menuItemId === 'cloudplay-open-link') {
    const isFreshContext =
      lastRightClicked &&
      Date.now() - lastRightClicked.timestamp < 30000 &&
      (lastRightClicked.tabId === undefined || lastRightClicked.tabId === tab?.id);
    const contextUrl = isFreshContext ? lastRightClicked?.url : null;
    lastRightClicked = null;

    const targetUrl = contextUrl || info.linkUrl || info.srcUrl || info.pageUrl || tab?.url;
    if (targetUrl) {
      const isDriveOrYT = tab?.url && (tab.url.includes('drive.google.com') || tab.url.includes('youtube.com'));
      if (isDriveOrYT && tab?.id) {
        try {
          ext.tabs.sendMessage(tab.id, { type: 'PLAY_IN_PAGE', url: targetUrl }, (resp: any) => {
            const rawChrome = getRawChrome();
            const err = rawChrome?.runtime?.lastError;
            if (err || !resp?.handled) {
              openPlayerTab(targetUrl, tab);
            }
          });
          return;
        } catch {
          openPlayerTab(targetUrl, tab);
          return;
        }
      }
      openPlayerTab(targetUrl, tab);
    }
  }
});

// Handle incoming messages from content scripts and player page
const rawBrowser = getRawBrowser();
const msgTarget = rawBrowser?.runtime?.onMessage ? rawBrowser : ext;

msgTarget.runtime.onMessage?.addListener((message: any, sender: any, sendResponse: any) => {
  const isFirefox = (typeof __TARGET__ !== 'undefined' && __TARGET__ === 'firefox') || !!rawBrowser?.runtime;

  if (message?.type === 'SET_CONTEXT_URL' && message?.url) {
    lastRightClicked = {
      url: message.url,
      tabId: sender?.tab?.id,
      timestamp: Date.now(),
    };
    sendResponse({ ok: true });
    return isFirefox ? Promise.resolve({ ok: true }) : true;
  }

  if (message?.type === 'SUPPRESS_DOWNLOAD_MANAGERS') {
    const p = suppressDownloadManagers(sender?.tab?.id)
      .then(() => {
        const res = { ok: true };
        try { sendResponse(res); } catch {}
        return res;
      })
      .catch(() => {
        const res = { ok: false };
        try { sendResponse(res); } catch {}
        return res;
      });
    return isFirefox ? p : true;
  }

  if (message?.type === 'OPEN_PLAYER' && message?.url) {
    void suppressDownloadManagers();
    const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(message.url)}`);
    const winId = sender.tab?.windowId;
    const createOptions: any = {
      url: playerUrl,
      index: (sender.tab?.index ?? 0) + 1,
    };
    if (winId !== undefined) {
      createOptions.windowId = winId;
    }
    ext.tabs.create(createOptions, (createdTab?: any) => {
      if (typeof createdTab?.id === 'number') {
        activePlayerTabIds.add(createdTab.id);
      }
    });
    sendResponse({ ok: true });
    return isFirefox ? Promise.resolve({ ok: true }) : true;
  }

  if (message?.type === 'FETCH_TEXT' && message?.url) {
    const fetchPromise = suppressDownloadManagers(sender?.tab?.id)
      .then(() =>
        fetch(message.url, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        })
      )
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
    const rm = rangeHeader ? /bytes=(\d+)-(\d+)/.exec(rangeHeader) : null;

    const encodeResponse = (
      bytes: Uint8Array,
      totalSize: number,
      contentType: string | null,
      status: number,
      contentRange: string | null
    ) => {
      let b64 = '';
      if (typeof btoa === 'function' && bytes.byteLength > 0) {
        const CHUNK = 0x8000;
        const parts: string[] = [];
        for (let i = 0; i < bytes.byteLength; i += CHUNK) {
          parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
        }
        b64 = btoa(parts.join(''));
      }
      return {
        ok: true,
        status,
        contentRange,
        contentLength: String(bytes.byteLength),
        contentType,
        totalSize,
        b64,
        bytes: bytes.byteLength <= 65536 ? Array.from(bytes) : undefined,
      };
    };

    const fetchRangePromise = (async () => {
      await suppressDownloadManagers(sender?.tab?.id);

      if (rm) {
        const s = parseInt(rm[1], 10);
        const e = parseInt(rm[2], 10);
        try {
          const streamRes = await readRangeFromPersistentStream(message.url, s, e);
          const data = encodeResponse(
            streamRes.bytes,
            streamRes.totalSize,
            streamRes.contentType,
            streamRes.status,
            streamRes.contentRange
          );
          try { sendResponse(data); } catch {}
          return data;
        } catch {
          // Fallback to single range fetch below if persistent stream failed
        }
      }

      const reqHeaders: Record<string, string> = {
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (rangeHeader) {
        reqHeaders.Range = rangeHeader;
      }
      const res = await fetch(message.url, { headers: reqHeaders });
      const cr = res.headers.get('content-range');
      const cl = res.headers.get('content-length');
      let totalSize = 0;
      if (cr) {
        const m = /\/(\d+)$/.exec(cr);
        if (m) totalSize = parseInt(m[1], 10);
      } else if (cl && res.status === 200) {
        totalSize = parseInt(cl, 10);
      }

      let bytes: Uint8Array;
      if (res.status === 200 && rm && res.body) {
        const s = parseInt(rm[1], 10);
        const e = parseInt(rm[2], 10);
        const maxBytes = e + 1;
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        try {
          while (received < maxBytes) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            chunks.push(value);
            received += value.byteLength;
          }
        } finally {
          try { await reader.cancel(); } catch {}
        }
        const combined = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
          combined.set(c, off);
          off += c.byteLength;
        }
        bytes = s < combined.byteLength ? combined.subarray(s, Math.min(e + 1, combined.byteLength)) : new Uint8Array(0);
      } else {
        const buf = await res.arrayBuffer();
        bytes = new Uint8Array(buf);
        if (res.status === 200 && rm) {
          const s = parseInt(rm[1], 10);
          const e = parseInt(rm[2], 10);
          if (e >= s && s < bytes.byteLength) {
            bytes = bytes.subarray(s, Math.min(e + 1, bytes.byteLength));
          }
        }
      }

      const data = encodeResponse(
        bytes,
        totalSize,
        res.headers.get('content-type'),
        res.status,
        cr
      );
      data.ok = res.ok || res.status === 206;
      try { sendResponse(data); } catch {}
      return data;
    })().catch((err) => {
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
