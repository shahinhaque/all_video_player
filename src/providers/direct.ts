import { SourceProvider, MediaItem, Playlist, RangeByteSource, ProviderId } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { isVideoName, guessMime } from '../lib/media.js';
import { fetchWithRetry } from '../lib/network.js';

export class DirectProvider implements SourceProvider {
  readonly id: ProviderId = 'http';
  readonly label = 'Direct Video';

  canHandle(url: URL): boolean {
    const path = url.pathname.toLowerCase();
    return isVideoName(path) || url.searchParams.get('type') === 'video';
  }

  async resolve(url: URL): Promise<Playlist> {
    const rawUrl = url.href;
    const path = url.pathname;
    let name = path.split('/').filter(Boolean).pop() || 'stream.ts';

    let size = 0;
    let mime = guessMime(name, 'video/mp2t');

    try {
      const probeRes = await fetch(rawUrl, {
        method: 'HEAD',
        headers: { Range: 'bytes=0-0' },
      });

      const disp = probeRes.headers.get('content-disposition');
      if (disp) {
        const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
        if (match && match[1]) name = decodeURIComponent(match[1]);
      }

      const ct = probeRes.headers.get('content-type');
      if (ct && ct.startsWith('video/')) mime = ct;

      const cr = probeRes.headers.get('content-range');
      if (cr) {
        const m = /\/(\d+)$/.exec(cr);
        if (m) size = parseInt(m[1], 10);
      } else {
        const cl = probeRes.headers.get('content-length');
        if (cl) size = parseInt(cl, 10);
      }
    } catch {
      // Probing is best-effort; fallback to default metadata
    }

    const item: MediaItem = {
      id: rawUrl,
      name,
      size,
      mime,
      provider: 'http',
      ref: { url: rawUrl },
    };

    return {
      title: name,
      items: [item],
      startIndex: 0,
      sourceUrl: rawUrl,
    };
  }

  async open(item: MediaItem, signal?: AbortSignal): Promise<RangeByteSource> {
    const directUrl = item.ref.url || item.id;
    const knownSize = item.size;

    return {
      name: item.name,
      size: knownSize,
      mime: item.mime,
      directUrl,
      encrypted: false,
      async read(start: number, end: number, readSignal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        const reqSignal = readSignal || signal;
        const res = await fetchWithRetry(directUrl, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: reqSignal,
        });

        if (!res.ok && res.status !== 206) {
          throw new PlayerError('network', `HTTP ${res.status} error reading range.`);
        }

        if (!res.body) {
          throw new PlayerError('network', 'Empty response body from direct stream.');
        }

        return res.body;
      },
    };
  }
}
