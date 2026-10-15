import { PlaybackEngine, RangeByteSource, EngineHost } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { readAll } from '../lib/util.js';
// Import mux.js mp4 transmuxer
// @ts-expect-error mux.js doesn't bundle ts types
import muxjs from 'mux.js';

interface TransmuxData {
  initSegment: Uint8Array;
  data: Uint8Array;
  type: string;
}

export class TsEngine implements PlaybackEngine {
  readonly kind = 'ts';
  private video: HTMLVideoElement;
  private src: RangeByteSource;
  private host: EngineHost;

  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private transmuxer: any = null;

  private objectUrl: string = '';
  private abortCtrl: AbortController = new AbortController();
  private isDestroyed = false;

  private currentByteOffset = 0;
  private chunkSize = 2 * 1024 * 1024; // 2MB
  private bufferQueue: Uint8Array[] = [];
  private isAppending = false;
  private initSegmentAppended = false;

  private estimatedDuration = 0;
  private estimatedBitrate = 0; // bytes per second

  constructor(video: HTMLVideoElement, src: RangeByteSource, host: EngineHost) {
    this.video = video;
    this.src = src;
    this.host = host;
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

    // Codec string for standard H.264 High Profile + AAC
    const mime = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
    } catch {
      // Fallback to Main profile
      this.sourceBuffer = this.mediaSource.addSourceBuffer('video/mp4; codecs="avc1.4d401f, mp4a.40.2"');
    }

    this.sourceBuffer.addEventListener('updateend', () => {
      this.isAppending = false;
      this.drainQueue();
      this.pruneBuffer();
    });

    this.setupTransmuxer();

    // Hook video seeking event
    this.video.addEventListener('seeking', this.onSeeking);

    // Initial feed loop
    this.startStreaming(startTime);
  }

  private setupTransmuxer(): void {
    // Instantiating mux.js Transmuxer
    this.transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: false,
    });

    this.transmuxer.on('data', (segment: TransmuxData) => {
      if (!this.initSegmentAppended && segment.initSegment) {
        this.queueBuffer(segment.initSegment);
        this.initSegmentAppended = true;
      }
      if (segment.data && segment.data.byteLength > 0) {
        this.queueBuffer(segment.data);
      }
    });

    this.transmuxer.on('log', (event: any) => {
      if (event?.message?.includes('unsupported')) {
        this.host.warn(event.message);
      }
    });
  }

  private queueBuffer(data: Uint8Array): void {
    this.bufferQueue.push(data);
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.isAppending || !this.sourceBuffer || this.sourceBuffer.updating || this.bufferQueue.length === 0) {
      return;
    }
    const next = this.bufferQueue.shift();
    if (next) {
      this.isAppending = true;
      try {
        this.sourceBuffer.appendBuffer(next as any);
      } catch (e) {
        this.isAppending = false;
        console.warn('SourceBuffer append error:', e);
      }
    }
  }

  private pruneBuffer(): void {
    // Memory capping: keep 30 seconds behind currentTime and 90 seconds ahead
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.isDestroyed) return;
    const ct = this.video.currentTime;
    if (ct > 35) {
      try {
        this.sourceBuffer.remove(0, ct - 30);
      } catch {
        // Ignored if buffer is busy
      }
    }
  }

  private async startStreaming(startSec: number = 0): Promise<void> {
    if (startSec > 0 && this.estimatedBitrate > 0) {
      this.currentByteOffset = Math.floor((startSec * this.estimatedBitrate) / 188) * 188;
    } else {
      this.currentByteOffset = 0;
    }

    const fileSize = this.src.size;

    while (!this.isDestroyed && !this.abortCtrl.signal.aborted) {
      // Check if we have buffered enough ahead (buffer backpressure)
      if (this.shouldWaitBuffer()) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }

      const reqEnd = fileSize > 0
        ? Math.min(this.currentByteOffset + this.chunkSize - 1, fileSize - 1)
        : this.currentByteOffset + this.chunkSize - 1;

      if (fileSize > 0 && this.currentByteOffset >= fileSize) {
        // Reached end of file
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.endOfStream();
          } catch {}
        }
        break;
      }

      try {
        const stream = await this.src.read(this.currentByteOffset, reqEnd, this.abortCtrl.signal);
        const chunk = await readAll(stream, this.abortCtrl.signal);

        if (chunk.length === 0) break;

        // Push TS packet chunk to mux.js
        this.transmuxer.push(chunk);
        this.transmuxer.flush();

        this.currentByteOffset += chunk.length;

        // Calculate bitrate estimate once video has duration
        if (!this.estimatedBitrate && this.video.duration > 0 && fileSize > 0) {
          this.estimatedDuration = this.video.duration;
          this.estimatedBitrate = fileSize / this.estimatedDuration;
        }
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
        // If we have more than 60 seconds of future video buffered, pause fetching
        return ranges.end(i) - ct > 60;
      }
    }
    return false;
  }

  private onSeeking = async () => {
    if (this.isDestroyed || !this.video) return;
    const targetTime = this.video.currentTime;

    // Check if target is already in buffered ranges
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= targetTime && targetTime <= ranges.end(i)) {
        return; // Fast seek within buffer!
      }
    }

    // Seek outside buffer: reset and calculate new byte offset
    if (this.estimatedBitrate > 0) {
      const targetByte = Math.floor((targetTime * this.estimatedBitrate) / 188) * 188;
      this.currentByteOffset = Math.min(targetByte, this.src.size > 0 ? this.src.size - 1 : targetByte);

      this.bufferQueue = [];
      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        try {
          this.sourceBuffer.abort();
        } catch {}
      }
      this.transmuxer.reset();
    }
  };

  destroy(): void {
    this.isDestroyed = true;
    this.abortCtrl.abort();
    this.video.removeEventListener('seeking', this.onSeeking);

    if (this.transmuxer) {
      try {
        this.transmuxer.dispose();
      } catch {}
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.video.removeAttribute('src');
    this.video.load();
  }
}
