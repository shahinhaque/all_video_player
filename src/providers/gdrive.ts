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
    
    // 1. /file/d/{id} or /file/u/{user}/d/{id}
    const fileMatch = /\/file\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/.exec(path);
    if (fileMatch) return { id: fileMatch[1], isFolder: false };

    // 2. /drive/folders/{id} or /drive/u/{user}/folders/{id}
    const folderMatch = /\/(?:drive\/)?(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/.exec(path);
    if (folderMatch) return { id: folderMatch[1], isFolder: true };

    // 3. /open?id={id} or /uc?id={id}
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
    let fileName = `Drive_Video_${id}`;
    let mime = 'video/mp4';
    let size = 0;

    // 1. Probe the HTML preview page to retrieve real filename
    try {
      const viewRes = await fetch(`https://drive.google.com/file/d/${id}/view`, {
        credentials: 'include',
      });
      if (viewRes.ok) {
        const html = await viewRes.text();
        const ogMatch = /<meta\s+property="og:title"\s+content="([^"]+)"/i.exec(html);
        const titleMatch = /<title>(.*?)(?: - Google Drive)?<\/title>/i.exec(html);
        const rawName = ogMatch ? ogMatch[1] : titleMatch ? titleMatch[1] : '';
        if (rawName && !rawName.includes('Google Drive') && !rawName.includes('Sign in')) {
          fileName = rawName.trim();
        }
      }
    } catch {
      // Best-effort preview page scraping
    }

    // 2. Query Google Drive download endpoint to obtain direct stream / confirm tokens
    let downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    try {
      const ucRes = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, {
        credentials: 'include',
      });

      const contentType = ucRes.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const html = await ucRes.text();
        const confirmMatch = /name="confirm"\s+value="([^"]+)"/i.exec(html) || /confirm=([0-9a-zA-Z_-]+)/.exec(html);
        const uuidMatch = /name="uuid"\s+value="([^"]+)"/i.exec(html) || /uuid=([0-9a-zA-Z_-]+)/.exec(html);
        const confirmToken = confirmMatch ? confirmMatch[1] : 't';
        const uuid = uuidMatch ? uuidMatch[1] : '';
        downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${confirmToken}${uuid ? `&uuid=${uuid}` : ''}`;
      } else if (ucRes.url && ucRes.url !== `https://drive.google.com/uc?export=download&id=${id}`) {
        downloadUrl = ucRes.url;
      }
    } catch {
      // Fallback
    }

    mime = guessMime(fileName, 'video/mp4');

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
    try {
      const res = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
        credentials: 'include',
      });
      const html = await res.text();
      
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
            ref: { fileId: fId, downloadUrl: `https://drive.usercontent.google.com/download?id=${fId}&export=download&confirm=t` },
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
    let directUrl = item.ref.downloadUrl || `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    let knownSize = item.size;

    // Check if initial request returns virus warning confirmation page
    try {
      const checkRes = await fetch(directUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-1' },
        credentials: 'include',
        signal,
      });

      const contentType = checkRes.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const html = await checkRes.text();
        const confirmMatch = /name="confirm"\s+value="([^"]+)"/i.exec(html) || /confirm=([0-9a-zA-Z_-]+)/.exec(html);
        const uuidMatch = /name="uuid"\s+value="([^"]+)"/i.exec(html) || /uuid=([0-9a-zA-Z_-]+)/.exec(html);
        const confirmToken = confirmMatch ? confirmMatch[1] : 't';
        const uuid = uuidMatch ? uuidMatch[1] : '';
        directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirmToken}${uuid ? `&uuid=${uuid}` : ''}`;
      } else {
        const cr = checkRes.headers.get('content-range');
        if (cr) {
          const m = /\/(\d+)$/.exec(cr);
          if (m) knownSize = parseInt(m[1], 10);
        }
      }
    } catch {
      // Proceed with directUrl
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
          credentials: 'include',
          signal: reqSignal,
        });

        if (res.status === 403 || res.status === 401) {
          throw new PlayerError('auth', 'Access denied to Google Drive file. Ensure file sharing is set to "Anyone with the link can view".');
        }
        if (res.status === 429) {
          throw new PlayerError('quota', 'Google Drive download quota exceeded for this file. Try again later.');
        }
        if (!res.ok && res.status !== 206) {
          throw new PlayerError('network', `HTTP error ${res.status} reading byte range from Google Drive.`);
        }

        if (!res.body) {
          throw new PlayerError('network', 'Empty response body from Google Drive.');
        }
        return res.body;
      },
    };
  }
}
