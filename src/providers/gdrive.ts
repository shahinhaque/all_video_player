import { SourceProvider, MediaItem, Playlist, RangeByteSource } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { isVideoEntry, guessMime } from '../lib/media.js';
import { fetchWithRetry } from '../lib/network.js';

export class GDriveProvider implements SourceProvider {
  readonly id = 'gdrive';
  readonly label = 'Google Drive';

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host === 'drive.google.com' || host === 'docs.google.com';
  }

  extractFileId(url: URL): { id: string; isFolder: boolean } | null {
    const path = url.pathname;
    // /file/d/{id}/...
    const fileMatch = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(path);
    if (fileMatch) return { id: fileMatch[1], isFolder: false };

    // /drive/folders/{id} or /drive/u/0/folders/{id}
    const folderMatch = /\/folders\/([a-zA-Z0-9_-]+)/.exec(path);
    if (folderMatch) return { id: folderMatch[1], isFolder: true };

    // ?id={id}
    const paramId = url.searchParams.get('id');
    if (paramId) {
      const isFolder = path.includes('/folders') || url.searchParams.get('folder') === 'true';
      return { id: paramId, isFolder };
    }

    return null;
  }

  async resolve(url: URL): Promise<Playlist> {
    const extracted = this.extractFileId(url);
    if (!extracted) {
      throw new PlayerError('unsupported', 'Invalid Google Drive link format.');
    }

    const { id, isFolder } = extracted;
    if (isFolder) {
      return this.resolveFolder(id, url.href);
    }

    // Single file resolve
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&confirm=t`;
    // Probe head or range 0-0 to get file size and mime
    let size = 0;
    let fileName = `Drive_Video_${id}`;
    let mime = 'video/mp4';

    try {
      const res = await fetch(downloadUrl, {
        method: 'HEAD',
        headers: { Range: 'bytes=0-0' },
      });
      const disp = res.headers.get('content-disposition');
      if (disp) {
        const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
        if (match) fileName = decodeURIComponent(match[1]);
      }
      const range = res.headers.get('content-range');
      if (range) {
        const total = /\/(\d+)$/.exec(range);
        if (total) size = parseInt(total[1], 10);
      }
      const ct = res.headers.get('content-type');
      if (ct && ct.startsWith('video/')) mime = ct;
      else mime = guessMime(fileName);
    } catch {
      // Fallback if HEAD is blocked: will probe on open
    }

    const item: MediaItem = {
      id,
      name: fileName,
      size,
      mime,
      provider: 'gdrive',
      ref: { fileId: id, downloadUrl },
    };

    return {
      title: fileName,
      items: [item],
      startIndex: 0,
      sourceUrl: url.href,
    };
  }

  private async resolveFolder(folderId: string, sourceUrl: string): Promise<Playlist> {
    // Attempt fetching public drive folder listing
    try {
      const res = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
        credentials: 'include',
      });
      const html = await res.text();
      
      // Look for embedded file list JSON payload in Drive page (_DRIVE_IVD or similar state)
      const items: MediaItem[] = [];
      const idMatches = [...html.matchAll(/data-id="([a-zA-Z0-9_-]+)"[^>]*data-name="([^"]+)"/g)];
      
      for (const m of idMatches) {
        const fId = m[1];
        const fName = m[2];
        if (isVideoEntry(fName)) {
          items.push({
            id: fId,
            name: fName,
            size: 0,
            mime: guessMime(fName),
            provider: 'gdrive',
            ref: { fileId: fId, downloadUrl: `https://drive.usercontent.google.com/download?id=${fId}&confirm=t` },
          });
        }
      }

      if (items.length > 0) {
        return {
          title: `Drive Folder ${folderId}`,
          items,
          startIndex: 0,
          sourceUrl,
        };
      }
    } catch {
      // Fallback
    }

    throw new PlayerError('notfound', 'Could not retrieve video files from this Google Drive folder. Ensure the folder is shared as "Anyone with the link".');
  }

  async open(item: MediaItem, signal?: AbortSignal): Promise<RangeByteSource> {
    const fileId = item.ref.fileId || item.id;
    let directUrl = item.ref.downloadUrl || `https://drive.usercontent.google.com/download?id=${fileId}&confirm=t`;
    let knownSize = item.size;

    // Check if initial request returns virus warning confirmation page
    const checkRes = await fetch(directUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-1' },
      signal,
    });

    const contentType = checkRes.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      // Drive returned an interstitial warning (e.g. file too large for virus scan)
      const html = await checkRes.text();
      const formMatch = /action="([^"]+)"/i.exec(html);
      const confirmTokenMatch = /name="confirm"\s+value="([^"]+)"/i.exec(html);
      if (formMatch) {
        const confirmUrl = new URL(formMatch[1], directUrl);
        if (confirmTokenMatch) {
          confirmUrl.searchParams.set('confirm', confirmTokenMatch[1]);
        }
        directUrl = confirmUrl.href;
      }
    } else {
      const cr = checkRes.headers.get('content-range');
      if (cr) {
        const m = /\/(\d+)$/.exec(cr);
        if (m) knownSize = parseInt(m[1], 10);
      }
    }

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

        if (res.status === 403 || res.status === 401) {
          throw new PlayerError('auth', 'Access denied to Google Drive file. Please ensure permissions are granted.');
        }
        if (res.status === 429) {
          throw new PlayerError('quota', 'Google Drive download quota exceeded for this file. Try again later.');
        }
        if (!res.ok && res.status !== 206) {
          throw new PlayerError('network', `HTTP error ${res.status} reading byte range.`);
        }

        if (!res.body) {
          throw new PlayerError('network', 'Empty response body from Google Drive.');
        }
        return res.body;
      },
    };
  }
}
