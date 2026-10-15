import { SourceProvider, MediaItem, Playlist, RangeByteSource, ProviderId, SubtitleTrackInfo } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { isVideoName, guessMime } from '../lib/media.js';
import { isSubtitleName, pairSubtitlesWithVideos } from '../lib/subtitles.js';
import { fetchWithRetry } from '../lib/network.js';
import { ext } from '../lib/browser.js';

/**
 * Fetches text content from a URL, with automatic fallback to extension background worker
 * if direct browser fetch encounters CORS or network restrictions.
 */
export async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (res.ok) {
      return await res.text();
    }
  } catch {}

  // Fallback to background worker messaging
  if (typeof ext?.runtime?.sendMessage === 'function') {
    try {
      const resp: any = await new Promise((resolve) => {
        let settled = false;
        try {
          const maybePromise = (ext.runtime as any).sendMessage({ type: 'FETCH_TEXT', url }, (cbResp: any) => {
            if (!settled && cbResp !== undefined) {
              settled = true;
              resolve(cbResp);
            }
          });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then((pResp: any) => {
              if (!settled) {
                settled = true;
                resolve(pResp);
              }
            }).catch(() => {
              if (!settled) {
                settled = true;
                resolve(null);
              }
            });
          }
        } catch {
          resolve(null);
        }
      });

      if (resp?.ok && typeof resp.text === 'string') {
        return resp.text;
      }
      if (resp?.error) {
        throw new PlayerError('network', `Background fetch failed: ${resp.error}`);
      }
    } catch (e) {
      if (e instanceof PlayerError) throw e;
    }
  }

  throw new PlayerError('network', `Failed to fetch directory from ${url}`);
}

export interface DirectoryParseResult {
  videos: MediaItem[];
  subtitles: SubtitleTrackInfo[];
  subdirs: { name: string; fullUrl: string }[];
}

/**
 * Parses directory HTML/text index, cleanly isolating video files, subtitle files,
 * and valid subdirectories while filtering out non-video media, icons, and parent links.
 */
export function parseDirectoryHtml(htmlOrText: string, baseUrl: string): DirectoryParseResult {
  const videos: MediaItem[] = [];
  const subtitles: SubtitleTrackInfo[] = [];
  const subdirs: { name: string; fullUrl: string }[] = [];

  const baseObj = new URL(baseUrl);
  const basePath = baseObj.pathname.endsWith('/') ? baseObj.pathname : baseObj.pathname + '/';

  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  const seenUrls = new Set<string>();

  while ((match = hrefRegex.exec(htmlOrText)) !== null) {
    const rawHref = match[1].trim();
    if (!rawHref || rawHref.startsWith('?') || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) {
      continue;
    }
    // Filter out parent directory links
    if (rawHref === '../' || rawHref === './' || rawHref === '..') continue;

    let fullUrl: string;
    try {
      fullUrl = new URL(rawHref, baseUrl).href;
    } catch {
      continue;
    }

    if (seenUrls.has(fullUrl)) continue;
    seenUrls.add(fullUrl);

    const urlObj = new URL(fullUrl);
    // Ignore external hostnames (documentation links, CDN fonts, etc.)
    if (urlObj.hostname !== baseObj.hostname) continue;

    const path = urlObj.pathname;
    const cleanSegments = path.split('/').filter(Boolean);
    const lastSegment = cleanSegments.pop() || '';
    const name = decodeURIComponent(lastSegment);
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
    } else {
      // Check if it's a valid subfolder under this directory
      const isSubdir = rawHref.endsWith('/') || path.endsWith('/') || !path.slice(basePath.length).includes('.');
      const lowerName = name.toLowerCase();
      const isIgnored =
        name.startsWith('.') ||
        name.startsWith('_') ||
        ['icons', 'css', 'js', 'images', 'assets', 'public'].includes(lowerName);

      if (isSubdir && !isIgnored && path.startsWith(basePath) && path !== basePath) {
        subdirs.push({ name, fullUrl: fullUrl.endsWith('/') ? fullUrl : fullUrl + '/' });
      }
    }
  }

  pairSubtitlesWithVideos(videos, subtitles);
  return { videos, subtitles, subdirs };
}

/**
 * Backwards-compatible alias for single directory index parsing.
 */
export function parseDirectoryIndex(
  htmlOrText: string,
  baseUrl: string
): { videos: MediaItem[]; subtitles: SubtitleTrackInfo[] } {
  const res = parseDirectoryHtml(htmlOrText, baseUrl);
  return { videos: res.videos, subtitles: res.subtitles };
}

/**
 * Scans a directory and all its subdirectories recursively for video files and subtitles.
 */
export async function scanDirectoryRecursively(
  startUrl: string,
  maxDepth = 3
): Promise<{ videos: MediaItem[]; subtitles: SubtitleTrackInfo[] }> {
  const allVideos: MediaItem[] = [];
  const allSubtitles: SubtitleTrackInfo[] = [];
  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    const normalized = item.url.split('#')[0];
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    let html = '';
    try {
      html = await fetchText(item.url);
    } catch {
      continue;
    }

    const { videos, subtitles, subdirs } = parseDirectoryHtml(html, item.url);
    allVideos.push(...videos);
    allSubtitles.push(...subtitles);

    if (item.depth < maxDepth) {
      for (const subdir of subdirs) {
        if (!visited.has(subdir.fullUrl)) {
          queue.push({ url: subdir.fullUrl, depth: item.depth + 1 });
        }
      }
    }
  }

  // Deduplicate videos by ID
  const uniqueVideos: MediaItem[] = [];
  const seenIds = new Set<string>();
  for (const v of allVideos) {
    if (!seenIds.has(v.id)) {
      seenIds.add(v.id);
      uniqueVideos.push(v);
    }
  }

  pairSubtitlesWithVideos(uniqueVideos, allSubtitles);
  return { videos: uniqueVideos, subtitles: allSubtitles };
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

    const isSftp = url.protocol === 'sftp:';
    let targetUrl = rawUrl;
    if (isSftp) {
      targetUrl = `http://${url.host}${url.pathname}${url.search}`;
    }

    // Check if URL is a directory or if probe returns HTML directory index
    const isDirHint = url.pathname.endsWith('/') || !url.pathname.includes('.') || isSftp;
    if (isDirHint) {
      try {
        const { videos } = await scanDirectoryRecursively(targetUrl, 3);
        if (videos.length > 0) {
          const folderName = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
          return {
            title: decodeURIComponent(folderName),
            items: videos,
            startIndex: 0,
            sourceUrl: rawUrl,
          };
        }
      } catch (err) {
        if (isSftp) {
          throw new PlayerError(
            'network',
            'Cannot connect to SFTP directly through browser sandbox. Please ensure an HTTP/WebDAV gateway is enabled for your SFTP storage, and enter the http:// or https:// URL.'
          );
        }
      }

      // If user specifically entered a folder URL ending in / and no videos were found, do not treat folder as a video file
      if (url.pathname.endsWith('/') || isSftp) {
        throw new PlayerError(
          'notfound',
          `No video files (.ts, .mp4, .mkv, .webm) found in folder: ${decodeURIComponent(url.pathname)}`
        );
      }
    }

    // Single video file path
    const path = url.pathname;
    let name = decodeURIComponent(path.split('/').filter(Boolean).pop() || 'stream.ts');

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
