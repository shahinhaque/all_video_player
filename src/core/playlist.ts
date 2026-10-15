import { MediaItem, Playlist } from './types.js';
import { naturalCompare, hashKey } from '../lib/util.js';
import { ext } from '../lib/browser.js';

export class PlaylistManager {
  private playlist: Playlist;
  private activeIndex: number = 0;
  private autoNext: boolean = true;
  private resumeEnabled: boolean = true;

  constructor(playlist: Playlist) {
    const selectedItem =
      playlist.startIndex !== undefined && playlist.items[playlist.startIndex]
        ? playlist.items[playlist.startIndex]
        : undefined;

    // Natural alphanumeric sort so "Episode 2" comes before "Episode 10"
    playlist.items.sort((a, b) => naturalCompare(a.name, b.name));
    this.playlist = playlist;

    if (selectedItem) {
      const newIdx = playlist.items.findIndex((it) => it.id === selectedItem.id);
      this.activeIndex = newIdx !== -1 ? newIdx : 0;
    } else {
      this.activeIndex = Math.max(0, Math.min(playlist.startIndex || 0, playlist.items.length - 1));
    }
  }

  get items(): MediaItem[] {
    return this.playlist.items;
  }

  get title(): string {
    return this.playlist.title;
  }

  get count(): number {
    return this.playlist.items.length;
  }

  get currentIndex(): number {
    return this.activeIndex;
  }

  get currentItem(): MediaItem | undefined {
    return this.playlist.items[this.activeIndex];
  }

  setIndex(index: number): MediaItem | undefined {
    if (index >= 0 && index < this.playlist.items.length) {
      this.activeIndex = index;
      return this.currentItem;
    }
    return undefined;
  }

  hasNext(): boolean {
    return this.activeIndex < this.playlist.items.length - 1;
  }

  hasPrev(): boolean {
    return this.activeIndex > 0;
  }

  next(): MediaItem | undefined {
    if (this.hasNext()) {
      this.activeIndex++;
      return this.currentItem;
    }
    return undefined;
  }

  prev(): MediaItem | undefined {
    if (this.hasPrev()) {
      this.activeIndex--;
      return this.currentItem;
    }
    return undefined;
  }

  setAutoNext(enabled: boolean): void {
    this.autoNext = enabled;
  }

  isAutoNext(): boolean {
    return this.autoNext;
  }

  // --- Resume Playback State Persistence ---
  private resumeKey(item: MediaItem): string {
    return `resume:${hashKey(`${item.provider}:${item.id}`)}`;
  }

  async getSavedPosition(item: MediaItem): Promise<number> {
    try {
      const key = this.resumeKey(item);
      const data = await ext.storage.local.get(key);
      const entry = data[key];
      if (entry && typeof entry.time === 'number') {
        return entry.time;
      }
    } catch {}
    return 0;
  }

  async savePosition(item: MediaItem, time: number, duration: number): Promise<void> {
    if (!this.resumeEnabled) return;
    try {
      const key = this.resumeKey(item);
      // Only save if progressed at least 5s and not at very end (last 10s)
      if (time > 5 && duration > 0 && time < duration - 10) {
        await ext.storage.local.set({
          [key]: { time, updated: Date.now() },
        });
      } else if (time >= duration - 10) {
        // Watched to completion, clear resume position
        await ext.storage.local.remove(key);
      }
    } catch {}
  }

  // --- Media Session API (Hardware Keys & OS notifications) ---
  updateMediaSession(
    onPlay: () => void,
    onPause: () => void,
    onNext: () => void,
    onPrev: () => void,
    onSeek: (to: number) => void
  ): void {
    if (!('mediaSession' in navigator)) return;
    const item = this.currentItem;
    if (!item) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.name,
      artist: item.provider.toUpperCase(),
      album: this.playlist.title,
      artwork: [
        { src: 'icons/icon128.png', sizes: '128x128', type: 'image/png' },
      ],
    });

    try {
      navigator.mediaSession.setActionHandler('play', onPlay);
      navigator.mediaSession.setActionHandler('pause', onPause);
      navigator.mediaSession.setActionHandler('nexttrack', this.hasNext() ? onNext : null);
      navigator.mediaSession.setActionHandler('previoustrack', this.hasPrev() ? onPrev : null);
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') onSeek(details.seekTime);
      });
    } catch (e) {
      console.warn('MediaSession handler error:', e);
    }
  }
}
