import { SourceProvider, MediaItem, Playlist, RangeByteSource, ProviderId, SubtitleTrackInfo } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { isVideoName, guessMime } from '../lib/media.js';
import { isSubtitleName, pairSubtitlesWithVideos } from '../lib/subtitles.js';
import { fetchWithRetry } from '../lib/network.js';
import { sendExtensionMessage } from '../lib/browser.js';
import { decodeHtmlEntities, limitStream } from '../lib/util.js';

/**
 * Fetches text content from a URL, with automatic fallback to extension background worker
 * if direct browser fetch encounters CORS or network restrictions.
 */
export async function fetchText(url: string): Promise<string> {
  // Prefer background worker fetch (tabId === -1) to bypass CORS and prevent download manager interception
  const resp = await sendExtensionMessage<{ ok: boolean; text?: string; error?: string }>({
    type: 'FETCH_TEXT',
    url,
  });

  if (resp?.ok && typeof resp.text === 'string') {
    return resp.text;
  }

  try {
    const res = await fetch(url);
    if (res.ok) {
      return await res.text();
    }
  } catch {}

  if (resp?.error) {
    const hint = ' If using Firefox, please ensure host permissions are granted in about:addons -> CloudPlay -> Permissions, or allow access when prompted.';
    throw new PlayerError('network', `Background fetch failed: ${resp.error}.${hint}`);
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
  baseObj.pathname = basePath;
  const normalizedBaseUrl = baseObj.href;

  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  const seenUrls = new Set<string>();

  while ((match = hrefRegex.exec(htmlOrText)) !== null) {
    const rawHref = decodeHtmlEntities(match[1].trim());
    if (!rawHref || rawHref.startsWith('?') || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) {
      continue;
    }
    // Filter out parent directory links
    if (rawHref === '../' || rawHref === './' || rawHref === '..') continue;

    let fullUrl: string;
    try {
      fullUrl = new URL(rawHref, normalizedBaseUrl).href;
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
    } catch (err) {
      if (item.depth === 0) {
        throw err;
      }
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
    const host = url.hostname.toLowerCase();
    if (
      host.includes('youtube.com') ||
      host.includes('youtu.be') ||
      host.includes('youtube-nocookie.com') ||
      host.includes('mega.nz') ||
      host.includes('mega.co.nz') ||
      host.includes('drive.google.com') ||
      host.includes('live.com') ||
      host.includes('sharepoint.com') ||
      host.includes('1drv.ms')
    ) {
      return false;
    }
    const path = url.pathname.toLowerCase();
    return (
      isVideoName(path) ||
      path.endsWith('/') ||
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

    if (!isVideoName(name)) {
      try {
        const probeResp = await sendExtensionMessage<{
          ok: boolean;
          totalSize?: number;
          contentType?: string;
        }>({
          type: 'FETCH_RANGE',
          url: rawUrl,
          range: 'bytes=0-0',
        });

        if (probeResp?.ok) {
          if (typeof probeResp.totalSize === 'number' && probeResp.totalSize > 0) {
            size = probeResp.totalSize;
          }
          if (probeResp.contentType && probeResp.contentType.startsWith('video/')) {
            mime = probeResp.contentType;
          }
        }
      } catch {
        // Probing is best-effort; fallback to default metadata
      }
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
    let resolvedSize = item.size;

    return {
      name: item.name,
      get size(): number {
        return resolvedSize;
      },
      mime: item.mime,
      directUrl,
      encrypted: false,
      async read(start: number, end: number, readSignal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        const reqSignal = readSignal || signal;

        // 1. Primary path in extension: fetch via background service worker (details.tabId === -1)
        // so browser download managers (IDM, etc.) never intercept active player tab requests.
        const rangeResp = await sendExtensionMessage<{
          ok: boolean;
          b64?: string;
          bytes?: Uint8Array | number[];
          totalSize?: number;
          error?: string;
        }>({
          type: 'FETCH_RANGE',
          url: directUrl,
          range: `bytes=${start}-${end}`,
        });

        if (rangeResp?.ok && (typeof rangeResp.b64 === 'string' || rangeResp.bytes)) {
          if (typeof rangeResp.totalSize === 'number' && rangeResp.totalSize > 0) {
            resolvedSize = rangeResp.totalSize;
          }
          let bytesArray: Uint8Array;
          if (typeof rangeResp.b64 === 'string' && rangeResp.b64.length > 0 && typeof atob === 'function') {
            const binStr = atob(rangeResp.b64);
            bytesArray = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) {
              bytesArray[i] = binStr.charCodeAt(i);
            }
          } else if (rangeResp.bytes instanceof Uint8Array) {
            bytesArray = rangeResp.bytes;
          } else if (Array.isArray(rangeResp.bytes)) {
            bytesArray = new Uint8Array(rangeResp.bytes);
          } else if (rangeResp.bytes && typeof rangeResp.bytes === 'object') {
            bytesArray = new Uint8Array(Object.values(rangeResp.bytes));
          } else {
            bytesArray = new Uint8Array(0);
          }

          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytesArray);
              controller.close();
            },
          });
        }

        // 2. Fallback path (e.g. non-extension test environment or if background worker unavailable)
        const res = await fetchWithRetry(directUrl, {
          headers: {
            Range: `bytes=${start}-${end}`,
            'X-Requested-With': 'XMLHttpRequest',
          },
          signal: reqSignal,
        });

        if (!res.ok && res.status !== 206) {
          throw new PlayerError('network', `HTTP ${res.status} error reading range.`);
        }

        const cr = res.headers.get('content-range');
        if (cr) {
          const m = /\/(\d+)$/.exec(cr);
          if (m) {
            const total = parseInt(m[1], 10);
            if (total > 0) resolvedSize = total;
          }
        } else if (res.status === 200 && resolvedSize === 0) {
          const cl = res.headers.get('content-length');
          if (cl) {
            const total = parseInt(cl, 10);
            if (total > 0) resolvedSize = total;
          }
        }

        if (!res.body) {
          throw new PlayerError('network', 'Empty response body from direct stream.');
        }

        if (res.status === 200 && start === 0) {
          return limitStream(res.body, end - start + 1);
        }

        return res.body;
      },
    };
  }
}
