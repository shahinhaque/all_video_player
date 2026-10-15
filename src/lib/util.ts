/** Small dependency-free helpers. */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function joinChunks(parts: Uint8Array[], total?: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const len = total ?? parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Drains a stream into one buffer. */
export async function readAll(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let len = 0;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      len += value.length;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return joinChunks(parts, len);
}

/** Wraps a stream so it ends after `limit` bytes (cancelling the upstream). */
export function limitStream(src: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let left = limit;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (left <= 0) {
        ctl.close();
        void reader.cancel().catch(() => undefined);
        return;
      }
      const { done, value } = await reader.read();
      if (done) return ctl.close();
      const chunk = value.length > left ? value.subarray(0, left) : value;
      left -= chunk.length;
      ctl.enqueue(chunk);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function bytesFromStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(ctl) {
      ctl.enqueue(data);
      ctl.close();
    },
  });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Natural sort: "Ep 2" < "Ep 10". */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(n: number): string {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));
}

/** Tiny stable hash (FNV-1a) for storage keys. */
export function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
