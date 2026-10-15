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

export const ext: Ext = g.browser?.runtime?.id ? g.browser : g.chrome?.runtime?.id ? g.chrome : devStub();
export const TARGET = __TARGET__;
export const IS_EXTENSION = !!(g.browser?.runtime?.id || g.chrome?.runtime?.id);
