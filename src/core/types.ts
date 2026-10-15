/** Shared domain types. Every provider and engine is written against these contracts. */

export type ProviderId = 'gdrive' | 'onedrive' | 'mega' | 'http' | 'local';

export interface SubtitleTrackInfo {
  id: string;
  name: string;
  label: string;
  srclang?: string;
  provider: ProviderId;
  ref: Record<string, string>;
  isDefault?: boolean;
}

/** A playable file. Must stay JSON-serialisable (it is passed to the background stream proxy). */
export interface MediaItem {
  /** Provider-scoped stable id (used for resume keys). */
  id: string;
  name: string;
  /** Size in bytes, 0 when unknown until opened. */
  size: number;
  mime?: string;
  provider: ProviderId;
  /** Provider-specific data needed to re-open the item (ids, keys, urls). */
  ref: Record<string, string>;
  /** Optional companion subtitle tracks detected in the same folder or drop batch. */
  subtitles?: SubtitleTrackInfo[];
}

export interface Playlist {
  title: string;
  items: MediaItem[];
  startIndex: number;
  /** Original link the user opened. */
  sourceUrl: string;
}

/** Random-access byte stream over a remote (or local) file. */
export interface RangeByteSource {
  readonly size: number;
  readonly name: string;
  readonly mime?: string;
  /** URL that a <video> element can load directly (unencrypted sources only). */
  readonly directUrl?: string;
  readonly encrypted: boolean;
  /** Reads bytes [start, end] inclusive. */
  read(start: number, end: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  /** Re-resolves an expiring download URL; returns the new direct URL. */
  refresh?(): Promise<string>;
}

export interface SourceProvider {
  readonly id: ProviderId;
  readonly label: string;
  canHandle(url: URL): boolean;
  /** Resolves a share link (file or folder) to a playlist. */
  resolve(url: URL): Promise<Playlist>;
  open(item: MediaItem, signal?: AbortSignal): Promise<RangeByteSource>;
}

export interface AudioTrackInfo {
  id: string;
  label: string;
  language?: string;
  codec?: string;
  channels?: number;
  isDefault?: boolean;
}

export interface EngineHost {
  warn(message: string): void;
  fail(error: unknown): void;
  onAudioTracksDiscovered?(tracks: AudioTrackInfo[], selectedId?: string): void;
  onSubtitleTracksDiscovered?(tracks: SubtitleTrackInfo[]): void;
}

export interface PlaybackEngine {
  readonly kind: 'native' | 'ts' | 'mkv' | 'blob' | 'hls';
  attach(startTime: number): Promise<void>;
  destroy(): void;
  getAudioTracks?(): AudioTrackInfo[];
  setAudioTrack?(trackId: string): Promise<void>;
  getActiveAudioTrack?(): string | null;
  getSubtitleTracks?(): SubtitleTrackInfo[];
  setSubtitleTrack?(trackId: string | null): Promise<void>;
}
