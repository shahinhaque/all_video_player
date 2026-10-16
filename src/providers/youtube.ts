import { SourceProvider, MediaItem, Playlist, RangeByteSource, ProviderId } from '../core/types.js';
import { PlayerError } from '../core/errors.js';

export function extractYouTubeInfo(url: URL): { videoId: string | null; playlistId: string | null } {
  let videoId: string | null = null;
  let playlistId: string | null = url.searchParams.get('list');

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host.includes('youtu.be')) {
    const parts = path.split('/').filter(Boolean);
    if (parts[0]) videoId = parts[0];
  } else if (
    host.includes('youtube.com') ||
    host.includes('youtube-nocookie.com')
  ) {
    if (path.startsWith('/watch')) {
      videoId = url.searchParams.get('v');
    } else if (path.startsWith('/shorts/')) {
      videoId = path.replace('/shorts/', '').split('/')[0];
    } else if (path.startsWith('/embed/')) {
      videoId = path.replace('/embed/', '').split('/')[0];
    } else if (path.startsWith('/v/')) {
      videoId = path.replace('/v/', '').split('/')[0];
    }
  }

  return { videoId, playlistId };
}

export class YouTubeProvider implements SourceProvider {
  readonly id: ProviderId = 'youtube';
  readonly label = 'YouTube';

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    if (
      !host.includes('youtube.com') &&
      !host.includes('youtu.be') &&
      !host.includes('youtube-nocookie.com')
    ) {
      return false;
    }
    const info = extractYouTubeInfo(url);
    return !!info.videoId || !!info.playlistId;
  }

  async resolve(url: URL): Promise<Playlist> {
    const { videoId, playlistId } = extractYouTubeInfo(url);

    if (!videoId && !playlistId) {
      throw new PlayerError('notfound', 'Could not find a valid YouTube video or playlist ID in link.');
    }

    const rawUrl = url.href;
    const effectiveVideoId = videoId || '';

    // Fetch video metadata via public oEmbed endpoint (no API key required)
    let title = effectiveVideoId ? `YouTube Video (${effectiveVideoId})` : 'YouTube Playlist';
    let author = '';
    let thumbnail = '';

    if (effectiveVideoId) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(
          effectiveVideoId
        )}&format=json`;
        const res = await fetch(oembedUrl);
        if (res.ok) {
          const data = await res.json();
          if (data?.title) title = data.title;
          if (data?.author_name) author = data.author_name;
          if (data?.thumbnail_url) thumbnail = data.thumbnail_url;
        }
      } catch {
        // oEmbed is best-effort
      }
    }

    const embedUrl = effectiveVideoId
      ? `https://www.youtube-nocookie.com/embed/${effectiveVideoId}?autoplay=1&enablejsapi=1`
      : '';

    const item: MediaItem = {
      id: `youtube-${effectiveVideoId || playlistId}`,
      name: author ? `${title} · ${author}` : title,
      size: 0,
      mime: 'video/youtube',
      provider: 'youtube',
      ref: {
        videoId: effectiveVideoId,
        playlistId: playlistId || '',
        url: rawUrl,
        embedUrl,
        thumbnail,
      },
    };

    return {
      title: item.name,
      items: [item],
      startIndex: 0,
      sourceUrl: rawUrl,
    };
  }

  async open(item: MediaItem): Promise<RangeByteSource> {
    return {
      name: item.name,
      size: 0,
      mime: 'video/youtube',
      directUrl: item.ref?.url || '',
      encrypted: false,
      read: async () => {
        throw new PlayerError('unsupported', 'YouTube videos play in embedded player mode.');
      },
    };
  }
}
