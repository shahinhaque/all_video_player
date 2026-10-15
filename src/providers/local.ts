import { SourceProvider, MediaItem, Playlist, RangeByteSource, SubtitleTrackInfo } from '../core/types.js';
import { guessMime, isVideoName } from '../lib/media.js';
import { naturalCompare } from '../lib/util.js';
import { isSubtitleName, pairSubtitlesWithVideos } from '../lib/subtitles.js';

// Cache for active local file handles
const localFilesMap = new Map<string, File>();

export function registerLocalFile(file: File): MediaItem {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  localFilesMap.set(id, file);

  return {
    id,
    name: file.name,
    size: file.size,
    mime: file.type || guessMime(file.name),
    provider: 'local',
    ref: { localId: id },
  };
}

export function createLocalPlaylist(files: File[]): Playlist {
  const videoFiles = files.filter((f) => isVideoName(f.name) || f.type.startsWith('video/'));
  const subFiles = files.filter((f) => isSubtitleName(f.name));
  const items = videoFiles.map(registerLocalFile);

  const subTracks: SubtitleTrackInfo[] = subFiles.map((sub) => {
    const registered = registerLocalFile(sub);
    return {
      id: registered.id,
      name: sub.name,
      label: '',
      provider: 'local',
      ref: registered.ref,
    };
  });

  pairSubtitlesWithVideos(items, subTracks);
  items.sort((a, b) => naturalCompare(a.name, b.name));

  return {
    title: items.length === 1 ? items[0].name : `Local Files (${items.length})`,
    items,
    startIndex: 0,
    sourceUrl: 'local://files',
  };
}

export class LocalProvider implements SourceProvider {
  readonly id = 'local';
  readonly label = 'Local File';

  canHandle(url: URL): boolean {
    return url.protocol === 'local:';
  }

  async resolve(): Promise<Playlist> {
    return {
      title: 'Local',
      items: [],
      startIndex: 0,
      sourceUrl: 'local://',
    };
  }

  async open(item: MediaItem): Promise<RangeByteSource> {
    const file = localFilesMap.get(item.ref.localId || item.id);
    if (!file) {
      throw new Error('Local file reference expired or was removed.');
    }

    return {
      name: file.name,
      size: file.size,
      mime: file.type || guessMime(file.name),
      encrypted: false,
      async read(start: number, end: number): Promise<ReadableStream<Uint8Array>> {
        const slice = file.slice(start, end + 1);
        return slice.stream();
      },
    };
  }
}
