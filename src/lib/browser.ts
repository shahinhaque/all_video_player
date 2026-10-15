/**
 * Cross-browser WebExtension API handle.
 * Firefox exposes promise-based `browser.*`; Chrome MV3 `chrome.*` also returns promises.
 * When opened outside an extension (dev preview over http), a tiny localStorage-backed stub is used.
 */
declare global {
  const __TARGET__: 'chrome' | 'firefox';
  const __DEV__: boolean;
}

type Ext = typeof chrome;
const g = globalThis as unknown as { browser?: Ext; chrome?: Ext };

function devStub(): Ext {
  const area = {
    async get(keys?: string | string[] | null) {
      const out: Record<string, unknown> = {};
      const list = keys == null ? Object.keys(localStorage) : Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        const v = localStorage.getItem(`cp:${k}`);
        if (v != null) out[k] = JSON.parse(v);
      }
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) localStorage.setItem(`cp:${k}`, JSON.stringify(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(`cp:${k}`);
    },
  };
  return {
    storage: { local: area, session: area },
    runtime: {
      getURL: (p: string) => new URL(p, location.href).href,
      sendMessage: async () => undefined,
      openOptionsPage: async () => void window.open('options.html'),
    },
    tabs: {
      create: async (o: { url?: string }) => void window.open(o.url),
      query: async () => [],
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
    },
    i18n: {
      getMessage: (key: string) => {
        const msgs: Record<string, string> = {
          appName: 'CloudPlay – Cloud Video Player',
          appShortName: 'CloudPlay',
          appDesc: 'Stream TS, MP4, MKV, HLS & WebM videos straight from MEGA, Google Drive and OneDrive — playlists, next/previous, resume.',
          actionTitle: 'CloudPlay',
          contextMenuPlay: '▶ Play in CloudPlay',
        };
        return msgs[key] || '';
      },
    },
  } as unknown as Ext;
}

function getExtensionApi(): Ext {
  const anyGlobal = globalThis as any;
  if (typeof anyGlobal.browser?.runtime?.sendMessage === 'function') {
    return anyGlobal.browser;
  }
  if (typeof anyGlobal.chrome?.runtime?.sendMessage === 'function') {
    return anyGlobal.chrome;
  }
  if (g.browser?.runtime?.id) return g.browser;
  if (g.chrome?.runtime?.id) return g.chrome;
  return devStub();
}

export const ext: Ext = getExtensionApi();
export const TARGET = typeof __TARGET__ !== 'undefined' ? __TARGET__ : 'chrome';
export const IS_EXTENSION = !!(
  (globalThis as any).browser?.runtime?.id ||
  (globalThis as any).chrome?.runtime?.id ||
  (globalThis as any).browser?.runtime?.sendMessage ||
  (globalThis as any).chrome?.runtime?.sendMessage
);

/**
 * Sends a message to the extension background script.
 * In Firefox: uses browser.runtime.sendMessage(msg) with 1 argument returning a Promise.
 * In Chrome: uses chrome.runtime.sendMessage(msg, callback).
 */
export async function sendExtensionMessage<T = any>(message: Record<string, unknown>): Promise<T | null> {
  const browserApi = (globalThis as any).browser;
  if (typeof browserApi?.runtime?.sendMessage === 'function') {
    try {
      return (await browserApi.runtime.sendMessage(message)) as T;
    } catch (e) {
      console.warn('browser.runtime.sendMessage error:', e);
      return null;
    }
  }

  const chromeApi = (globalThis as any).chrome;
  if (typeof chromeApi?.runtime?.sendMessage === 'function') {
    return new Promise((resolve) => {
      try {
        const maybePromise = chromeApi.runtime.sendMessage(message, (resp: any) => {
          resolve(resp as T);
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((pResp: any) => resolve(pResp as T)).catch(() => resolve(null));
        }
      } catch {
        resolve(null);
      }
    });
  }

  return null;
}

