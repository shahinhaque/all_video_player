import { SourceProvider, MediaItem, Playlist, RangeByteSource, ProviderId, SubtitleTrackInfo } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { isVideoName, guessMime } from '../lib/media.js';
import { isSubtitleName, pairSubtitlesWithVideos } from '../lib/subtitles.js';
import { fetchWithRetry } from '../lib/network.js';
import { ext } from '../lib/browser.js';

export function parseDirectoryIndex(
  htmlOrText: string,
  baseUrl: string
): { videos: MediaItem[]; subtitles: SubtitleTrackInfo[] } {
  const videos: MediaItem[] = [];
  const subtitles: SubtitleTrackInfo[] = [];

  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  const seenUrls = new Set<string>();

  while ((match = hrefRegex.exec(htmlOrText)) !== null) {
    const rawHref = match[1].trim();
    if (!rawHref || rawHref.startsWith('?') || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) {
      continue;
    }
    if (rawHref === '../' || rawHref === './' || rawHref === '..') continue;

    let fullUrl: string;
    try {
      fullUrl = new URL(rawHref, baseUrl).href;
    } catch {
      continue;
    }

    if (seenUrls.has(fullUrl)) continue;
    seenUrls.add(fullUrl);

    const cleanPath = new URL(fullUrl).pathname;
    const name = decodeURIComponent(cleanPath.split('/').filter(Boolean).pop() || '');
    if (!name) continue;

    if (isVideoName(name)) {
      videos.push({
        id: fullUrl,
        name,
        size: 0,
        mime: guessMime(name, 'video/mp2t'),
        provider: 'http',
        ref: { url: fullUrl },
      });
    } else if (isSubtitleName(name)) {
      subtitles.push({
        id: fullUrl,
        name,
        label: '',
        srclang: '',
        provider: 'http',
        ref: { url: fullUrl },
      });
    }
  }

  pairSubtitlesWithVideos(videos, subtitles);
  return { videos, subtitles };
}

export class DirectProvider implements SourceProvider {
  readonly id: ProviderId = 'http';
  readonly label = 'Direct Video & Folder';

  canHandle(url: URL): boolean {
    const proto = url.protocol.toLowerCase();
    if (proto !== 'http:' && proto !== 'https:' && proto !== 'sftp:') return false;
    const path = url.pathname.toLowerCase();
    return (
      isVideoName(path) ||
      path.endsWith('/') ||
      !path.includes('.') ||
      url.searchParams.get('type') === 'video' ||
      proto === 'sftp:'
    );
  }

  async resolve(url: URL): Promise<Playlist> {
    const rawUrl = url.href;

    // In MV3, request origin permission dynamically if needed for arbitrary direct domains
    if (ext.permissions?.contains && (url.protocol === 'http:' || url.protocol === 'https:')) {
      try {
        const origin = `${url.protocol}//${url.host}/*`;
        const has = await ext.permissions.contains({ origins: [origin] });
        if (!has && ext.permissions.request) {
          await ext.permissions.request({ origins: [origin] });
        }
      } catch {}
    }

    const isSftp = url.protocol === 'sftp:';
    let targetUrl = rawUrl;
    if (isSftp) {
      targetUrl = `http://${url.host}${url.pathname}${url.search}`;
    }

    // Check if URL is a directory or if probe returns HTML directory index
    const isDirHint = url.pathname.endsWith('/') || !url.pathname.includes('.') || isSftp;
    if (isDirHint) {
      try {
        const res = await fetch(targetUrl);
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('text/html') || ct.includes('text/plain') || ct.includes('application/json')) {
          const body = await res.text();
          const { videos } = parseDirectoryIndex(body, targetUrl);
          if (videos.length > 0) {
            const folderName = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
            return {
              title: decodeURIComponent(folderName),
              items: videos,
              startIndex: 0,
              sourceUrl: rawUrl,
            };
          }
        }
      } catch (e) {
        if (isSftp) {
          throw new PlayerError(
            'network',
            'Cannot connect to SFTP directly through browser sandbox. Please ensure an HTTP/WebDAV gateway is enabled for your SFTP storage, and enter the http:// or https:// URL.'
          );
        }
      }
    }

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
