/**
 * Software Audio Player for E-AC-3 (Dolby Digital Plus) and AC-3 (Dolby Digital) audio tracks in Chrome.
 * Uses libavcodec-based WASM decoder (@audio/decode-eac3) and Web Audio API (AudioContext)
 * to deliver multi-channel / 5.1 surround sound in real-time synchronization with <video>.
 */

export interface DecodedAudioChunk {
  timestamp: number; // in seconds
  duration: number; // in seconds
  buffer: AudioBuffer;
}

export class Eac3AudioPlayer {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private decoder: any = null;
  private isDestroyed = false;

  private queue: DecodedAudioChunk[] = [];
  private activeSources: { source: AudioBufferSourceNode; startTime: number; endTime: number }[] = [];


  private video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async init(): Promise<void> {
    if (this.isDestroyed) return;

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    if (!this.audioCtx) {
      this.audioCtx = new AudioContextClass();
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.connect(this.audioCtx.destination);
      this.updateVolume();
    }

    if (!this.decoder) {
      const { decoder } = await import('@audio/decode-eac3');
      this.decoder = await decoder();
    }
  }

  updateVolume(): void {
    if (!this.gainNode || !this.audioCtx) return;
    const vol = this.video.muted ? 0 : this.video.volume;
    this.gainNode.gain.setValueAtTime(vol, this.audioCtx.currentTime);
  }

  pushAudioFrame(timestampSec: number, data: Uint8Array): void {
    if (this.isDestroyed || !this.decoder || !this.audioCtx) return;

    try {
      const result = this.decoder.decode(data);
      if (!result || !result.channelData || result.channelData.length === 0) return;

      const channels = result.channelData.length;
      const frameCount = result.channelData[0].length;
      if (frameCount === 0) return;

      const sampleRate = result.sampleRate || 48000;
      const duration = frameCount / sampleRate;

      const audioBuffer = this.audioCtx.createBuffer(channels, frameCount, sampleRate);
      for (let c = 0; c < channels; c++) {
        audioBuffer.copyToChannel(result.channelData[c], c);
      }

      this.queue.push({
        timestamp: timestampSec,
        duration,
        buffer: audioBuffer,
      });

      // Keep queue sorted by timestamp
      if (this.queue.length > 1 && this.queue[this.queue.length - 1].timestamp < this.queue[this.queue.length - 2].timestamp) {
        this.queue.sort((a, b) => a.timestamp - b.timestamp);
      }

      this.scheduleUpcomingChunks();
    } catch (err) {
      console.warn('Eac3AudioPlayer decode error:', err);
    }
  }

  scheduleUpcomingChunks(): void {
    if (!this.audioCtx || !this.gainNode || this.isDestroyed) return;
    if (this.video.paused || this.video.seeking) return;

    const currentVTime = this.video.currentTime;
    const LOOKAHEAD_SEC = 3.0;
    const rate = this.video.playbackRate || 1.0;

    // Prune expired queued chunks that are behind currentTime
    while (this.queue.length > 0 && this.queue[0].timestamp + this.queue[0].duration < currentVTime - 0.5) {
      this.queue.shift();
    }

    for (const chunk of this.queue) {
      if ((chunk as any)._scheduled) continue;
      if (chunk.timestamp < currentVTime - 0.08) continue;
      if (chunk.timestamp > currentVTime + LOOKAHEAD_SEC) break;

      const delaySec = (chunk.timestamp - currentVTime) / rate;
      const startTime = this.audioCtx.currentTime + Math.max(0.01, delaySec);

      const source = this.audioCtx.createBufferSource();
      source.buffer = chunk.buffer;
      source.playbackRate.value = rate;
      source.connect(this.gainNode);
      source.start(startTime);

      (chunk as any)._scheduled = true;
      const endTime = startTime + chunk.duration / rate;
      this.activeSources.push({ source, startTime, endTime });
    }

    // Clean up finished sources
    const now = this.audioCtx.currentTime;
    this.activeSources = this.activeSources.filter((s) => s.endTime > now);
  }

  onPlay(): void {
    if (!this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    this.resetScheduling();
    this.scheduleUpcomingChunks();
  }

  onPause(): void {
    this.stopActiveSources();
    if (this.audioCtx && this.audioCtx.state === 'running') {
      this.audioCtx.suspend().catch(() => {});
    }
  }

  onSeek(): void {
    this.resetScheduling();
    this.scheduleUpcomingChunks();
  }

  onRateChange(): void {
    const rate = this.video.playbackRate || 1.0;
    this.resetScheduling();
    for (const s of this.activeSources) {
      try {
        s.source.playbackRate.value = rate;
      } catch {}
    }
    this.scheduleUpcomingChunks();
  }

  private stopActiveSources(): void {
    for (const s of this.activeSources) {
      try {
        s.source.stop();
        s.source.disconnect();
      } catch {}
    }
    this.activeSources = [];
  }

  resetScheduling(): void {
    this.stopActiveSources();
  }

  clearQueue(): void {
    this.resetScheduling();
    this.queue = [];
  }

  destroy(): void {
    this.isDestroyed = true;
    this.clearQueue();
    if (this.decoder) {
      try {
        this.decoder.free();
      } catch {}
      this.decoder = null;
    }
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch {}
      this.audioCtx = null;
    }
  }
}
