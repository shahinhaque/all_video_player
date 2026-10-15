import { PlaybackEngine, RangeByteSource, EngineHost } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { readAll, sleep } from '../lib/util.js';
import { fromTimeRanges, calculateEvictionRanges } from '../lib/buffer.js';
import { fetchWithRetry } from '../lib/network.js';
import { parseM3u8, HlsPlaylist } from '../lib/hls-parser.js';
// @ts-expect-error mux.js doesn't bundle ts types
import muxjs from 'mux.js';

interface TransmuxData {
  initSegment: Uint8Array;
  data: Uint8Array;
  type: string;
}

export interface HlsEngineOptions {
  chunkSize?: number;
}

export class HlsEngine implements PlaybackEngine {
  readonly kind = 'hls';
  private video: HTMLVideoElement;
  private src: RangeByteSource;
  private host: EngineHost;

  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private transmuxer: any = null;

  private objectUrl = '';
  private abortCtrl = new AbortController();
  private isDestroyed = false;

  private playlist: HlsPlaylist | null = null;
  private currentSegmentIndex = 0;
  private bufferQueue: Uint8Array[] = [];
  private isAppending = false;
  private isPruning = false;
  private initSegmentAppended = false;
  private audioWarned = false;
  private isFeeding = false;

  constructor(video: HTMLVideoElement, src: RangeByteSource, host: EngineHost, _options?: HlsEngineOptions) {
    this.video = video;
    this.src = src;
    this.host = host;
  }

  async attach(startTime = 0): Promise<void> {
    if (this.isDestroyed) return;

    try {
      // 1. Read playlist content from byte source
      const probeLen = Math.min(256 * 1024, this.src.size > 0 ? this.src.size - 1 : 256 * 1024 - 1);
      const stream = await this.src.read(0, probeLen);
      const bytes = await readAll(stream);
      const text = new TextDecoder('utf-8').decode(bytes);

      let parsed = parseM3u8(text, this.src.directUrl);

      // 2. If it's a master playlist, resolve the first variant stream
      if (parsed.isMaster && parsed.variants.length > 0) {
        const variantUrl = parsed.variants[0].uri;
        const res = await fetchWithRetry(variantUrl, undefined, { signal: this.abortCtrl.signal });
        const variantText = await res.text();
        parsed = parseM3u8(variantText, variantUrl);
      }

      this.playlist = parsed;

      // 3. Set up MSE
      this.mediaSource = new MediaSource();
      this.objectUrl = URL.createObjectURL(this.mediaSource);
      this.video.src = this.objectUrl;

      await new Promise<void>((resolve, reject) => {
        if (!this.mediaSource) return reject(new Error('MediaSource is null'));

        const onOpen = () => {
          this.mediaSource?.removeEventListener('sourceopen', onOpen);
          resolve();
        };

        this.mediaSource.addEventListener('sourceopen', onOpen);
        this.video.addEventListener(
          'error',
          () => reject(new PlayerError('codec', 'HTMLVideoElement failed to load HLS MediaSource.')),
          { once: true }
        );
      });

      if (this.playlist.totalDuration > 0 && this.mediaSource.readyState === 'open') {
        this.mediaSource.duration = this.playlist.totalDuration;
      }

      this.setupTransmuxer();

      // Find initial segment index for startTime
      this.currentSegmentIndex = this.findSegmentIndexForTime(startTime);

      // Start loading segments
      this.feedSegments();

      if (startTime > 0) {
        this.video.currentTime = startTime;
      }
    } catch (err) {
      if (!this.isDestroyed) {
        this.host.fail(err);
      }
    }
  }

  private findSegmentIndexForTime(time: number): number {
    if (!this.playlist || this.playlist.segments.length === 0) return 0;
    for (let i = 0; i < this.playlist.segments.length; i++) {
      const seg = this.playlist.segments[i];
      if (time >= seg.startTime && time < seg.startTime + seg.duration) {
        return i;
      }
    }
    return 0;
  }

  private setupTransmuxer(): void {
    this.transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: false,
    });

    this.transmuxer.on('data', (segment: TransmuxData) => {
      if (!this.sourceBuffer) {
        this.initSourceBuffer(segment.type);
      }
      if (!this.initSegmentAppended && segment.initSegment) {
        this.queueBuffer(segment.initSegment);
        this.initSegmentAppended = true;
      }
      if (segment.data && segment.data.byteLength > 0) {
        this.queueBuffer(segment.data);
      }
    });

    this.transmuxer.on('log', (event: any) => {
      const msg = typeof event === 'string' ? event : event?.message || '';
      const lower = msg.toLowerCase();
      if (
        lower.includes('unsupported') ||
        lower.includes('dropping audio') ||
        lower.includes('ac3') ||
        lower.includes('mp2')
      ) {
        if (!this.audioWarned && !this.isDestroyed) {
          this.audioWarned = true;
          this.host.warn('Audio format in HLS stream not natively supported in browser MSE; playing video only.');
        }
      }
    });
  }

  private initSourceBuffer(type: string): void {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;
    const mime = type === 'audio' ? 'audio/mp4; codecs="mp4a.40.2"' : 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      this.sourceBuffer.addEventListener('updateend', () => {
        this.isAppending = false;
        this.isPruning = false;
        this.drainQueue();
        this.pruneBuffer();
      });
      this.sourceBuffer.addEventListener('error', (e) => {
        console.warn('HLS SourceBuffer error:', e);
      });
    } catch {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer('video/mp4');
      } catch (err) {
        this.host.fail(new PlayerError('codec', 'Failed to allocate MSE SourceBuffer for HLS stream.'));
      }
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
        console.warn('SourceBuffer append error in HlsEngine:', e);
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
    } catch {}
  }

  private async feedSegments(): Promise<void> {
    if (this.isFeeding || this.isDestroyed || !this.playlist) return;
    this.isFeeding = true;

    try {
      while (!this.isDestroyed && this.playlist && this.currentSegmentIndex < this.playlist.segments.length) {
        // Check buffer ahead
        const curTime = this.video.currentTime;
        let bufferedEnd = curTime;
        const ranges = this.video.buffered;
        for (let i = 0; i < ranges.length; i++) {
          if (ranges.start(i) <= curTime + 0.5 && ranges.end(i) >= curTime) {
            bufferedEnd = Math.max(bufferedEnd, ranges.end(i));
          }
        }

        // If buffered more than 30s ahead, pause and sleep briefly
        if (bufferedEnd - curTime > 30) {
          await sleep(500, this.abortCtrl.signal);
          continue;
        }

        const seg = this.playlist.segments[this.currentSegmentIndex];
        let segmentBytes: Uint8Array;

        if (seg.byteRange) {
          const stream = await this.src.read(
            seg.byteRange.offset,
            seg.byteRange.offset + seg.byteRange.length - 1,
            this.abortCtrl.signal
          );
          segmentBytes = await readAll(stream);
        } else {
          const res = await fetchWithRetry(seg.uri, undefined, { signal: this.abortCtrl.signal });
          segmentBytes = new Uint8Array(await res.arrayBuffer());
        }

        if (this.isDestroyed) break;

        // Push segment TS packets to transmuxer
        this.transmuxer.push(segmentBytes);
        this.transmuxer.flush();

        this.currentSegmentIndex++;
      }

      // End of playlist
      if (this.playlist?.isEndList && this.mediaSource?.readyState === 'open') {
        try {
          this.mediaSource.endOfStream();
        } catch {}
      }
    } catch (e: any) {
      if (!this.isDestroyed && e?.name !== 'AbortError') {
        console.warn('Error fetching HLS segment:', e);
      }
    } finally {
      this.isFeeding = false;
    }
  }

  async seek(time: number): Promise<void> {
    if (this.isDestroyed) return;

    // Abort current fetch
    this.abortCtrl.abort();
    this.abortCtrl = new AbortController();

    this.bufferQueue = [];
    this.isAppending = false;
    this.isPruning = false;

    // Reset transmuxer
    if (this.transmuxer) {
      try {
        this.transmuxer.reset();
      } catch {}
    }

    this.currentSegmentIndex = this.findSegmentIndexForTime(time);
    this.video.currentTime = time;

    // Resume feeding
    this.feedSegments();
  }

  destroy(): void {
    this.isDestroyed = true;
    this.abortCtrl.abort();

    if (this.sourceBuffer && this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.removeSourceBuffer(this.sourceBuffer);
      } catch {}
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }

    this.sourceBuffer = null;
    this.mediaSource = null;
    this.transmuxer = null;
    this.playlist = null;
  }
}
