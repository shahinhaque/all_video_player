import { SourceProvider, MediaItem, Playlist, RangeByteSource } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { isVideoEntry, guessMime } from '../lib/media.js';
import { utf8ToBase64Url } from '../lib/util.js';

interface OneDriveItemResponse {
  id: string;
  name: string;
  size: number;
  file?: { mimeType: string };
  folder?: { childCount: number };
  '@content.downloadUrl'?: string;
}

export class OneDriveProvider implements SourceProvider {
  readonly id = 'onedrive';
  readonly label = 'OneDrive';

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return (
      host === '1drv.ms' ||
      host === 'onedrive.live.com' ||
      host.endsWith('.sharepoint.com') ||
      host === 'api.onedrive.com'
    );
  }

  private encodeShareUrl(shareUrl: string): string {
    const b64 = utf8ToBase64Url(shareUrl);
    return `u!${b64}`;
  }

  async resolve(url: URL): Promise<Playlist> {
    let resolvedUrl = url.href;

    // Follow 1drv.ms short link redirect if necessary
    if (url.hostname.toLowerCase() === '1drv.ms') {
      try {
        const head = await fetch(url.href, { method: 'HEAD', redirect: 'follow' });
        resolvedUrl = head.url;
      } catch {
        // Continue with original
      }
    }

    const shareToken = this.encodeShareUrl(resolvedUrl);
    const sharesApi = `https://api.onedrive.com/v1.0/shares/${shareToken}/root`;

    const res = await fetch(sharesApi);
    if (!res.ok) {
      if (res.status === 404) {
        throw new PlayerError('notfound', 'OneDrive share link not found or expired.');
      }
      if (res.status === 403 || res.status === 401) {
        throw new PlayerError('auth', 'Access denied to OneDrive item. It may require sign-in or specific permissions.');
      }
      throw new PlayerError('network', `OneDrive API error ${res.status}: ${res.statusText}`);
    }

    const data: OneDriveItemResponse = await res.json();

    if (data.folder) {
      // It's a folder, query children
      const childrenApi = `https://api.onedrive.com/v1.0/shares/${shareToken}/root/children`;
      const childRes = await fetch(childrenApi);
      if (!childRes.ok) {
        throw new PlayerError('network', 'Failed to retrieve OneDrive folder contents.');
      }

      const childData: { value: OneDriveItemResponse[] } = await childRes.json();
      const items: MediaItem[] = [];

      for (const c of childData.value) {
        if (!c.folder && isVideoEntry(c.name, c.file?.mimeType)) {
          items.push({
            id: c.id,
            name: c.name,
            size: c.size,
            mime: c.file?.mimeType || guessMime(c.name),
            provider: 'onedrive',
            ref: {
              shareToken,
              itemId: c.id,
              downloadUrl: c['@content.downloadUrl'] || '',
            },
          });
        }
      }

      if (items.length === 0) {
        throw new PlayerError('notfound', 'No playable video files found in this OneDrive folder.');
      }

      return {
        title: data.name || 'OneDrive Folder',
        items,
        startIndex: 0,
        sourceUrl: url.href,
      };
    }

    // Single file
    const downloadUrl = data['@content.downloadUrl'] || '';
    const item: MediaItem = {
      id: data.id,
      name: data.name,
      size: data.size,
      mime: data.file?.mimeType || guessMime(data.name),
      provider: 'onedrive',
      ref: {
        shareToken,
        itemId: data.id,
        downloadUrl,
      },
    };

    return {
      title: data.name,
      items: [item],
      startIndex: 0,
      sourceUrl: url.href,
    };
  }

  async open(item: MediaItem, signal?: AbortSignal): Promise<RangeByteSource> {
    let directUrl = item.ref.downloadUrl;

    const refreshDownloadUrl = async (): Promise<string> => {
      const shareToken = item.ref.shareToken;
      const itemId = item.ref.itemId;
      const api = itemId
        ? `https://api.onedrive.com/v1.0/shares/${shareToken}/items/${itemId}`
        : `https://api.onedrive.com/v1.0/shares/${shareToken}/root`;
      const r = await fetch(api);
      if (!r.ok) throw new PlayerError('network', 'Failed to refresh OneDrive download link.');
      const d: OneDriveItemResponse = await r.json();
      if (!d['@content.downloadUrl']) throw new PlayerError('network', 'Missing download URL from OneDrive.');
      directUrl = d['@content.downloadUrl'];
      item.ref.downloadUrl = directUrl;
      return directUrl;
    };

    if (!directUrl) {
      await refreshDownloadUrl();
    }

    return {
      name: item.name,
      size: item.size,
      mime: item.mime,
      directUrl,
      encrypted: false,
      refresh: refreshDownloadUrl,
      async read(start: number, end: number, readSignal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        const reqSignal = readSignal || signal;
        let res = await fetch(directUrl, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: reqSignal,
        });

        // If downloadUrl expired (typically returns 401/403/404 after an hour), refresh once
        if (res.status === 401 || res.status === 403 || res.status === 410) {
          const newUrl = await refreshDownloadUrl();
          res = await fetch(newUrl, {
            headers: { Range: `bytes=${start}-${end}` },
            signal: reqSignal,
          });
        }

        if (!res.ok && res.status !== 206) {
          throw new PlayerError('network', `OneDrive stream error: HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new PlayerError('network', 'Empty response body from OneDrive.');
        }
        return res.body;
      },
    };
  }
}
