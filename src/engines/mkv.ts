import { PlaybackEngine, RangeByteSource, EngineHost, AudioTrackInfo, SubtitleTrackInfo } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { readAll } from '../lib/util.js';
import { fromTimeRanges, calculateEvictionRanges } from '../lib/buffer.js';
import { parseMkvHeaders, MkvHeaderInfo } from './ebml.js';
import type { MkvDemuxer } from './mkv-demuxer.js';

export interface MkvEngineOptions {
  chunkSize?: number;
}

/**
 * Client-side Matroska (.mkv) Playback Engine for browsers lacking native Matroska container support (Chromium).
 * Demuxes EBML headers/clusters and streams compatible codecs to MediaSource MSE SourceBuffers.
 */
export class MkvEngine implements PlaybackEngine {
  readonly kind = 'mkv';
  private video: HTMLVideoElement;
  private src: RangeByteSource;
  private host: EngineHost;

  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string = '';
  private abortCtrl: AbortController = new AbortController();
  private isDestroyed = false;

  private bufferQueue: Uint8Array[] = [];
  private isAppending = false;
  private isPruning = false;
  private pruneTimer: any = null;

  private headerInfo: MkvHeaderInfo | null = null;
  private currentByteOffset = 0;
  private chunkSize: number;

  private mkvDemuxer: MkvDemuxer | null = null;
  private audioTracks: AudioTrackInfo[] = [];
  private subtitleTracks: SubtitleTrackInfo[] = [];
  private activeAudioTrackId: string | null = null;
  private activeSubtitleTrackId: string | null = null;
  private subtitleCues: { start: number; end: number; text: string }[] = [];

  constructor(video: HTMLVideoElement, src: RangeByteSource, host: EngineHost, options?: MkvEngineOptions) {
    this.video = video;
    this.src = src;
    this.host = host;
    this.chunkSize = options?.chunkSize ?? 2 * 1024 * 1024;
  }

  async attach(startTime: number = 0): Promise<void> {
    if (!('MediaSource' in window)) {
      throw new PlayerError('codec', 'MediaSource Extensions (MSE) is not supported in this browser.');
    }

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.mediaSource?.removeEventListener('sourceopen', onOpen);
        resolve();
      };
      this.mediaSource?.addEventListener('sourceopen', onOpen);
      this.abortCtrl.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });

    // Hook video element errors
    this.video.addEventListener('error', () => {
      const err = this.video.error;
      if (err && !this.isDestroyed) {
        this.host.fail(
          new PlayerError(
            'codec',
            `MKV playback error (code ${err.code}): ${err.message || 'Chromium cannot decode this MKV video/audio stream.'}`
          )
        );
      }
    }, { signal: this.abortCtrl.signal });

    this.video.addEventListener('seeking', this.onSeeking);
    this.video.addEventListener('timeupdate', this.onTimeUpdate, { signal: this.abortCtrl.signal });
    this.pruneTimer = setInterval(() => this.pruneBuffer(), 3000);

    // Initialize MkvDemuxer to discover tracks (audio and embedded subtitles)
    try {
      const { MkvDemuxer } = await import('./mkv-demuxer.js');
      this.mkvDemuxer = new MkvDemuxer(this.src);
      const info = await this.mkvDemuxer.parseHeaders();
      if (info && !this.isDestroyed) {
        const subTrks = info.tracks.filter((t) => t.trackType === 'subtitle');
        const audioTrks = info.tracks.filter((t) => t.trackType === 'audio');

        this.subtitleTracks = subTrks.map((t, i) => ({
          id: `mkv-sub-${t.trackNumber}`,
          name: t.name || `${t.language ? t.language.toUpperCase() + ' ' : ''}Subtitle ${i + 1}`,
          label: t.name || `${t.language ? t.language.toUpperCase() + ' ' : ''}Subtitle ${i + 1} (Embedded)`,
          srclang: t.language || 'en',
          provider: 'local',
          ref: { trackNumber: String(t.trackNumber) },
          isDefault: t.isDefault,
        }));

        this.audioTracks = audioTrks.map((t, i) => {
          const langStr = t.language ? t.language.toUpperCase() : '';
          const codecStr = t.codecId.replace(/^A_/, '');
          const chStr = t.channels === 6 ? '5.1' : t.channels === 2 ? 'Stereo' : t.channels ? `${t.channels}ch` : '';
          const descParts = [langStr, t.name, codecStr, chStr].filter(Boolean);
          return {
            id: String(t.trackNumber),
            label: descParts.length > 0 ? descParts.join(' - ') : `Track ${i + 1}`,
            language: t.language,
            codec: t.codecId,
            channels: t.channels,
            isDefault: t.isDefault,
          };
        });

        if (this.audioTracks.length > 0) {
          const defAudio = this.audioTracks.find((t) => t.isDefault) || this.audioTracks[0];
          this.activeAudioTrackId = defAudio.id;
          this.host.onAudioTracksDiscovered?.(this.audioTracks, defAudio.id);
        }

        if (this.subtitleTracks.length > 0) {
          const defSub = this.subtitleTracks.find((s) => s.isDefault) || this.subtitleTracks[0];
          this.host.onSubtitleTracksDiscovered?.(this.subtitleTracks, defSub?.id);
          if (defSub) {
            this.setSubtitleTrack(defSub.id);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to initialize MKV demuxer in MkvEngine:', e);
    }

    // Initial stream loop
    this.startStreaming(startTime);
  }

  private initSourceBuffer(headerInfo: MkvHeaderInfo): boolean {
    if (this.sourceBuffer || !this.mediaSource || this.mediaSource.readyState !== 'open') return false;

    // Detect codecs in tracks
    let hasVp9 = false;
    let hasVp8 = false;
    let hasAvc = false;
    let hasOpus = false;
    let hasAac = false;

    for (const trk of headerInfo.tracks) {
      const cid = trk.codecId.toUpperCase();
      if (cid.includes('VP9')) hasVp9 = true;
      if (cid.includes('VP8')) hasVp8 = true;
      if (cid.includes('AVC') || cid.includes('H264')) hasAvc = true;
      if (cid.includes('OPUS')) hasOpus = true;
      if (cid.includes('AAC')) hasAac = true;
    }

    const mimeCandidates: string[] = [];

    if (hasVp9) {
      mimeCandidates.push(hasOpus ? 'video/webm; codecs="vp9, opus"' : 'video/webm; codecs="vp9"');
    }
    if (hasVp8) {
      mimeCandidates.push(hasOpus ? 'video/webm; codecs="vp8, opus"' : 'video/webm; codecs="vp8"');
    }
    if (hasAvc) {
      mimeCandidates.push(hasAac ? 'video/mp4; codecs="avc1.4d401f, mp4a.40.2"' : 'video/mp4; codecs="avc1.4d401f"');
      mimeCandidates.push('video/mp4; codecs="avc1.640028"');
    }

    // Default WebM / MP4 fallbacks
    mimeCandidates.push('video/webm; codecs="vp9, opus"', 'video/webm', 'video/mp4');

    let selectedMime = '';
    for (const cand of mimeCandidates) {
      if (typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(cand)) {
        selectedMime = cand;
        break;
      }
    }

    if (!selectedMime) {
      selectedMime = 'video/webm';
    }

    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(selectedMime);
      this.sourceBuffer.addEventListener('updateend', () => {
        this.isAppending = false;
        this.isPruning = false;
        if (this.bufferQueue.length > 0) {
          this.drainQueue();
        } else {
          this.pruneBuffer();
        }
      });
      return true;
    } catch (e) {
      console.warn('Failed to add SourceBuffer for MKV with mime', selectedMime, e);
      return false;
    }
  }

  private queueBuffer(data: Uint8Array): void {
    this.bufferQueue.push(data);
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.isAppending || this.isPruning || !this.sourceBuffer || this.sourceBuffer.updating || this.bufferQueue.length === 0) {
      return;
    }
    const next = this.bufferQueue.shift();
    if (next) {
      this.isAppending = true;
      try {
        this.sourceBuffer.appendBuffer(next as any);
      } catch (e) {
        this.isAppending = false;
        console.warn('SourceBuffer append error in MkvEngine:', e);
      }
    }
  }

  private pruneBuffer(): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.isAppending || this.isPruning || this.isDestroyed) {
      return;
    }
    if (this.bufferQueue.length > 0) {
      this.drainQueue();
      return;
    }

    try {
      const ranges = fromTimeRanges(this.sourceBuffer.buffered);
      const evictions = calculateEvictionRanges(this.video.currentTime, ranges, 30, 90, 2);
      if (evictions.length > 0) {
        const [start, end] = evictions[0];
        if (Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0) {
          this.isPruning = true;
          this.sourceBuffer.remove(start, end);
        }
      }
    } catch {
      this.isPruning = false;
    }
  }

  private onTimeUpdate = () => {
    this.pruneBuffer();
    if (this.activeSubtitleTrackId && this.subtitleCues.length > 0) {
      const ct = this.video.currentTime;
      const active = this.subtitleCues.find((c) => ct >= c.start && ct <= c.end);
      this.host.onSubtitleText?.(active ? active.text : null);
    }
  };

  private async startStreaming(startSec: number = 0): Promise<void> {
    const fileSize = this.src.size;
    this.currentByteOffset = 0;

    // 1. Fetch initial header block to parse tracks
    const headerProbeLen = Math.min(256 * 1024, fileSize > 0 ? fileSize - 1 : 256 * 1024);
    try {
      const stream = await this.src.read(0, headerProbeLen, this.abortCtrl.signal);
      const initialChunk = await readAll(stream, this.abortCtrl.signal);

      const headerInfo = parseMkvHeaders(initialChunk);
      if (!headerInfo) {
        throw new PlayerError('codec', 'Could not parse MKV EBML tracks or video header.');
      }
      this.headerInfo = headerInfo;

      const audioTrks = headerInfo.tracks.filter((t) => t.trackType === 'audio');
      const subTrks = headerInfo.tracks.filter((t) => t.trackType === 'subtitle');

      const formattedAudio = audioTrks.map((t, i) => {
        const langStr = t.language ? t.language.toUpperCase() : '';
        const codecStr = t.codecId.replace(/^A_/, '');
        const chStr = t.channels === 6 ? '5.1' : t.channels === 2 ? 'Stereo' : t.channels ? `${t.channels}ch` : '';
        const descParts = [langStr, t.name, codecStr, chStr].filter(Boolean);
        return {
          id: String(t.trackNumber),
          label: descParts.length > 0 ? descParts.join(' - ') : `Track ${i + 1}`,
          language: t.language,
          codec: t.codecId,
          channels: t.channels,
          isDefault: t.isDefault,
        };
      });

      const formattedSubs = subTrks.map((t, i) => ({
        id: `mkv-sub-${t.trackNumber}`,
        name: t.name || `${t.language ? t.language.toUpperCase() + ' ' : ''}Subtitle ${i + 1}`,
        label: t.name || `${t.language ? t.language.toUpperCase() + ' ' : ''}Subtitle ${i + 1} (Embedded)`,
        srclang: t.language || 'en',
        provider: 'local' as const,
        ref: { trackNumber: String(t.trackNumber) },
        isDefault: t.isDefault,
      }));

      if (formattedAudio.length > 0) {
        const chosen = formattedAudio.find((a) => a.isDefault) || formattedAudio[0];
        this.host.onAudioTracksDiscovered?.(formattedAudio, chosen.id);
      }
      if (formattedSubs.length > 0) {
        this.host.onSubtitleTracksDiscovered?.(formattedSubs);
      }

      if (!this.initSourceBuffer(headerInfo)) {
        throw new PlayerError('codec', 'Browser MSE cannot allocate SourceBuffer for this MKV stream.');
      }

      // Feed initial cluster/header data to SourceBuffer and demuxer
      this.mkvDemuxer?.demuxBuffer(initialChunk);
      this.queueBuffer(initialChunk);
      this.currentByteOffset = initialChunk.length;

      if (startSec > 0 && headerInfo.duration > 0 && fileSize > 0) {
        const estByte = Math.floor((startSec / headerInfo.duration) * fileSize);
        this.currentByteOffset = Math.min(estByte, fileSize - 1);
        this.mkvDemuxer?.seek(startSec);
      }
    } catch (err) {
      if (this.isDestroyed || this.abortCtrl.signal.aborted) return;
      this.host.fail(err);
      return;
    }

    // 2. Stream subsequent clusters
    while (!this.isDestroyed && !this.abortCtrl.signal.aborted) {
      if (this.shouldWaitBuffer()) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }

      if (fileSize > 0 && this.currentByteOffset >= fileSize) {
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.endOfStream();
          } catch {}
        }
        break;
      }

      const reqEnd = fileSize > 0
        ? Math.min(this.currentByteOffset + this.chunkSize - 1, fileSize - 1)
        : this.currentByteOffset + this.chunkSize - 1;

      try {
        const stream = await this.src.read(this.currentByteOffset, reqEnd, this.abortCtrl.signal);
        const chunk = await readAll(stream, this.abortCtrl.signal);

        if (chunk.length === 0) break;

        this.mkvDemuxer?.demuxBuffer(chunk);
        this.queueBuffer(chunk);
        this.currentByteOffset += chunk.length;
      } catch (err) {
        if (this.isDestroyed || this.abortCtrl.signal.aborted) break;
        this.host.fail(err);
        break;
      }
    }
  }

  private shouldWaitBuffer(): boolean {
    if (!this.video || !this.sourceBuffer) return false;
    const ct = this.video.currentTime;
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= ct && ct <= ranges.end(i)) {
        return ranges.end(i) - ct > 60;
      }
    }
    return false;
  }

  private onSeeking = () => {
    if (this.isDestroyed || !this.video) return;
    const targetTime = this.video.currentTime;
    this.mkvDemuxer?.seek(targetTime);

    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= targetTime && targetTime <= ranges.end(i)) {
        return; // Fast seek within buffered range
      }
    }

    if (this.headerInfo && this.headerInfo.duration > 0 && this.src.size > 0) {
      const targetByte = Math.floor((targetTime / this.headerInfo.duration) * this.src.size);
      this.currentByteOffset = Math.min(targetByte, this.src.size - 1);
      this.bufferQueue = [];
      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        try {
          this.sourceBuffer.abort();
        } catch {}
      }
    }
  };

  getAudioTracks(): AudioTrackInfo[] {
    return this.audioTracks;
  }

  async setAudioTrack(trackId: string): Promise<void> {
    this.activeAudioTrackId = trackId;
    const trackNum = parseInt(trackId, 10);
    this.mkvDemuxer?.setActiveAudioTrack(trackNum);
  }

  getActiveAudioTrack(): string | null {
    return this.activeAudioTrackId;
  }

  getSubtitleTracks(): SubtitleTrackInfo[] {
    return this.subtitleTracks;
  }

  async setSubtitleTrack(trackId: string | null): Promise<void> {
    this.activeSubtitleTrackId = trackId;
    if (!this.mkvDemuxer) return;

    if (!trackId) {
      this.mkvDemuxer.setActiveSubtitleTrack(null);
      this.subtitleCues = [];
      this.host.onSubtitleText?.(null);
      return;
    }

    const match = trackId.match(/^mkv-sub-(\d+)$/);
    if (!match) return;
    const trackNum = parseInt(match[1], 10);
    this.subtitleCues = [];
    this.mkvDemuxer.setActiveSubtitleTrack(trackNum);

    this.mkvDemuxer.onSubtitleCue((cue) => {
      if (this.activeSubtitleTrackId !== trackId) return;
      const start = cue.timeSec;
      const end = cue.timeSec + (cue.durationSec || 3.5);
      this.subtitleCues.push({ start, end, text: cue.text });
    });
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.abortCtrl.abort();
    this.mkvDemuxer?.destroy();
    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeEventListener('timeupdate', this.onTimeUpdate);

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.video.removeAttribute('src');
    this.video.load();
  }
}
