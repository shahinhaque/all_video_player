/**
 * Cross-browser WebExtension API handle.
 * Firefox exposes promise-based `browser.*`; Chrome MV3 `chrome.*` also returns promises.
 * When opened outside an extension (dev preview over http), a tiny localStorage-backed stub is used.
 */
declare global {
  const __TARGET__: 'chrome' | 'firefox';
  const __DEV__: boolean;
}

// In WebExtension sandboxes, browser and chrome exist as global variables in lexical scope
declare const browser: any;
declare const chrome: any;

export function getRawBrowser(): any {
  if (typeof browser !== 'undefined' && browser?.runtime) return browser;
  const g = globalThis as any;
  if (typeof g.browser !== 'undefined' && g.browser?.runtime) return g.browser;
  if (typeof window !== 'undefined' && (window as any).browser?.runtime) return (window as any).browser;
  return null;
}

export function getRawChrome(): any {
  if (typeof chrome !== 'undefined' && chrome?.runtime) return chrome;
  const g = globalThis as any;
  if (typeof g.chrome !== 'undefined' && g.chrome?.runtime) return g.chrome;
  if (typeof window !== 'undefined' && (window as any).chrome?.runtime) return (window as any).chrome;
  return null;
}

export function getExtensionPermissions(): any {
  const b = getRawBrowser();
  if (b?.permissions) return b.permissions;
  const c = getRawChrome();
  if (c?.permissions) return c.permissions;
  return null;
}

type Ext = typeof chrome;

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
  const b = getRawBrowser();
  if (b?.runtime?.sendMessage) return b as Ext;
  const c = getRawChrome();
  if (c?.runtime?.sendMessage) return c as Ext;
  if (b?.runtime) return b as Ext;
  if (c?.runtime) return c as Ext;
  return devStub();
}

export const ext: Ext = getExtensionApi();
export const TARGET = typeof __TARGET__ !== 'undefined' ? __TARGET__ : 'chrome';
export const IS_EXTENSION = !!(getRawBrowser()?.runtime || getRawChrome()?.runtime);

/**
 * Sends a message to the extension background script.
 * In Firefox: uses browser.runtime.sendMessage(msg) with 1 argument returning a Promise.
 * In Chrome: uses chrome.runtime.sendMessage(msg, callback).
 */
export async function sendExtensionMessage<T = any>(message: Record<string, unknown>): Promise<T | null> {
  const b = getRawBrowser();
  if (typeof b?.runtime?.sendMessage === 'function') {
    try {
      return (await b.runtime.sendMessage(message)) as T;
    } catch (e) {
      console.warn('browser.runtime.sendMessage error:', e);
    }
  }

  const c = getRawChrome();
  if (typeof c?.runtime?.sendMessage === 'function') {
    return new Promise((resolve) => {
      try {
        const maybePromise = c.runtime.sendMessage(message, (resp: any) => {
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

