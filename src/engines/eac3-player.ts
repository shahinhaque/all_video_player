/**
 * Multi-Codec Software & WebCodecs Audio Player for MKV multi-audio tracks in Chrome.
 * Decodes E-AC-3 / AC-3 via WASM (@audio/decode-eac3) and AAC, Opus, Vorbis, FLAC, MP3
 * via WebCodecs AudioDecoder (with ADTS decodeAudioData fallback) in real-time sync with <video>.
 */

export interface DecodedAudioChunk {
  timestamp: number; // in seconds
  duration: number; // in seconds
  buffer: AudioBuffer;
}

export interface AudioTrackConfig {
  codecId: string;
  samplingRate?: number;
  channels?: number;
  codecPrivate?: Uint8Array;
}

const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function buildAdtsFrame(
  rawAac: Uint8Array,
  audioObjectType: number,
  samplingFreqIndex: number,
  channelConfig: number
): Uint8Array {
  const frameLen = rawAac.byteLength + 7;
  const profile = Math.max(0, Math.min(3, (audioObjectType || 2) - 1));
  const sfi = samplingFreqIndex >= 0 && samplingFreqIndex < 13 ? samplingFreqIndex : 4;
  const ch = Math.max(1, Math.min(7, channelConfig || 2));

  const adts = new Uint8Array(frameLen);
  adts[0] = 0xff;
  adts[1] = 0xf1;
  adts[2] = ((profile & 0x03) << 6) | ((sfi & 0x0f) << 2) | ((ch >>> 2) & 0x01);
  adts[3] = ((ch & 0x03) << 6) | ((frameLen >>> 11) & 0x03);
  adts[4] = (frameLen >>> 3) & 0xff;
  adts[5] = ((frameLen & 0x07) << 5) | 0x1f;
  adts[6] = 0xfc;
  adts.set(rawAac, 7);
  return adts;
}

export class Eac3AudioPlayer {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private decoder: any = null;
  private webCodecsDecoder: any = null;
  private isDestroyed = false;

  private trackConfig: AudioTrackConfig | null = null;
  private aacProfile = 2;
  private aacSfi = 4;
  private aacChannels = 2;

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
      try {
        // @ts-ignore
        const mod = await import('@audio/decode-eac3').catch(() => null);
        if (mod && mod.decoder) {
          this.decoder = await mod.decoder();
        }
      } catch {
        // Optional decoder not present
      }
    }
  }

  async configureTrack(config: AudioTrackConfig): Promise<void> {
    this.trackConfig = config;
    this.clearQueue();

    if (this.webCodecsDecoder) {
      try {
        if (this.webCodecsDecoder.state !== 'closed') {
          this.webCodecsDecoder.close();
        }
      } catch {}
      this.webCodecsDecoder = null;
    }

    const codecUpper = (config.codecId || '').toUpperCase();
    const sr = config.samplingRate || 48000;
    const ch = config.channels || 2;

    if (codecUpper.includes('AAC')) {
      this.aacProfile = 2;
      this.aacSfi = ADTS_SAMPLE_RATES.indexOf(sr);
      if (this.aacSfi < 0) this.aacSfi = 3; // 48000
      this.aacChannels = ch;
      if (config.codecPrivate && config.codecPrivate.length >= 2) {
        const aot = (config.codecPrivate[0] >>> 3) & 0x1f;
        if (aot > 0) this.aacProfile = aot;
        const sfi = ((config.codecPrivate[0] & 0x07) << 1) | (config.codecPrivate[1] >>> 7);
        if (sfi >= 0 && sfi < ADTS_SAMPLE_RATES.length) this.aacSfi = sfi;
        const cpCh = (config.codecPrivate[1] >>> 3) & 0x0f;
        if (cpCh > 0) this.aacChannels = cpCh;
      }
    }

    const AudioDecoderClass = (window as any).AudioDecoder;
    if (typeof AudioDecoderClass === 'function') {
      let wcCodec = '';
      if (codecUpper.includes('AAC')) wcCodec = 'mp4a.40.2';
      else if (codecUpper.includes('OPUS')) wcCodec = 'opus';
      else if (codecUpper.includes('VORBIS')) wcCodec = 'vorbis';
      else if (codecUpper.includes('FLAC')) wcCodec = 'flac';
      else if (codecUpper.includes('MPEG/L3') || codecUpper.includes('MP3')) wcCodec = 'mp3';
      else if (codecUpper.includes('EAC3') && !this.decoder) wcCodec = 'ec-3';
      else if (codecUpper.includes('AC3') && !this.decoder) wcCodec = 'ac-3';

      if (wcCodec) {
        try {
          const wcConfig: any = {
            codec: wcCodec,
            sampleRate: codecUpper.includes('OPUS') ? 48000 : sr,
            numberOfChannels: ch,
          };
          if (config.codecPrivate && config.codecPrivate.byteLength > 0 && wcCodec !== 'mp3') {
            wcConfig.description = config.codecPrivate;
          }
          const supported =
            typeof AudioDecoderClass.isConfigSupported === 'function'
              ? await AudioDecoderClass.isConfigSupported(wcConfig).catch(() => ({ supported: true }))
              : { supported: true };

          if (supported?.supported !== false) {
            this.webCodecsDecoder = new AudioDecoderClass({
              output: (audioData: any) => this.onWebCodecsOutput(audioData),
              error: () => {
                // Fallback to ADTS / software decoder if WebCodecs rejects frames
                try {
                  this.webCodecsDecoder?.close();
                } catch {}
                this.webCodecsDecoder = null;
              },
            });
            this.webCodecsDecoder.configure(wcConfig);
          }
        } catch {
          this.webCodecsDecoder = null;
        }
      }
    }
  }

  private onWebCodecsOutput(audioData: any): void {
    if (this.isDestroyed || !this.audioCtx) {
      try {
        audioData.close();
      } catch {}
      return;
    }

    try {
      const channels = audioData.numberOfChannels || 2;
      const frameCount = audioData.numberOfFrames || 0;
      const sampleRate = audioData.sampleRate || 48000;
      const timestampSec = (audioData.timestamp || 0) / 1e6;

      if (frameCount > 0) {
        const audioBuffer = this.audioCtx.createBuffer(channels, frameCount, sampleRate);
        for (let c = 0; c < channels; c++) {
          const plane = new Float32Array(frameCount);
          try {
            audioData.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          } catch {
            audioData.copyTo(plane, { planeIndex: c });
          }
          audioBuffer.copyToChannel(plane, c);
        }

        this.enqueueDecodedBuffer(timestampSec, frameCount / sampleRate, audioBuffer);
      }
    } catch {
      // Ignore malformed frame
    } finally {
      try {
        audioData.close();
      } catch {}
    }
  }

  private enqueueDecodedBuffer(timestampSec: number, duration: number, audioBuffer: AudioBuffer): void {
    this.queue.push({
      timestamp: timestampSec,
      duration,
      buffer: audioBuffer,
    });

    if (this.queue.length > 1 && this.queue[this.queue.length - 1].timestamp < this.queue[this.queue.length - 2].timestamp) {
      this.queue.sort((a, b) => a.timestamp - b.timestamp);
    }

    this.scheduleUpcomingChunks();
  }

  updateVolume(): void {
    if (!this.gainNode || !this.audioCtx) return;
    let vol: number;
    if (this.video.dataset?.userMuted !== undefined) {
      const userMuted = this.video.dataset.userMuted === 'true';
      const userVol = parseFloat(this.video.dataset.userVolume ?? String(this.video.volume ?? 1));
      vol = userMuted ? 0 : (Number.isFinite(userVol) ? userVol : 1.0);
    } else {
      vol = this.video.muted ? 0 : (this.video.volume !== undefined ? this.video.volume : 1.0);
    }
    try {
      this.gainNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
      this.gainNode.gain.value = vol;
      this.gainNode.gain.setValueAtTime(vol, this.audioCtx.currentTime);
    } catch {
      this.gainNode.gain.value = vol;
    }
  }

  pushAudioFrame(timestampSec: number, data: Uint8Array): void {
    if (this.isDestroyed || !this.audioCtx || data.byteLength === 0) return;
    if (this.audioCtx.state === 'suspended' && !this.video.paused) {
      this.audioCtx.resume().catch(() => {});
    }

    // 1. WebCodecs AudioDecoder path (AAC, Opus, Vorbis, FLAC, MP3)
    if (this.webCodecsDecoder && this.webCodecsDecoder.state === 'configured') {
      try {
        const EncodedAudioChunkClass = (window as any).EncodedAudioChunk;
        if (typeof EncodedAudioChunkClass === 'function') {
          const chunk = new EncodedAudioChunkClass({
            type: 'key',
            timestamp: Math.max(0, Math.round(timestampSec * 1e6)),
            data,
          });
          this.webCodecsDecoder.decode(chunk);
          return;
        }
      } catch {
        // Fall through to fallback decoders
      }
    }

    // 2. WASM E-AC-3 / AC-3 decoder path
    if (this.decoder) {
      try {
        const result = this.decoder.decode(data);
        if (result && result.channelData && result.channelData.length > 0) {
          const channels = result.channelData.length;
          const frameCount = result.channelData[0].length;
          if (frameCount > 0) {
            const sampleRate = result.sampleRate || 48000;
            const duration = frameCount / sampleRate;
            const audioBuffer = this.audioCtx.createBuffer(channels, frameCount, sampleRate);
            for (let c = 0; c < channels; c++) {
              audioBuffer.copyToChannel(result.channelData[c], c);
            }
            this.enqueueDecodedBuffer(timestampSec, duration, audioBuffer);
            return;
          }
        }
      } catch (err) {
        console.warn('Eac3AudioPlayer decode error:', err);
      }
    }

    // 3. Fallback ADTS Web Audio decodeAudioData path for AAC
    const codecUpper = (this.trackConfig?.codecId || '').toUpperCase();
    if (codecUpper.includes('AAC') && typeof this.audioCtx.decodeAudioData === 'function') {
      try {
        const isAlreadyAdts = data.byteLength >= 7 && data[0] === 0xff && (data[1] & 0xf0) === 0xf0;
        const adtsBytes = isAlreadyAdts
          ? data.slice()
          : buildAdtsFrame(data, this.aacProfile, this.aacSfi, this.aacChannels);
        const ab = adtsBytes.buffer.slice(
          adtsBytes.byteOffset,
          adtsBytes.byteOffset + adtsBytes.byteLength
        ) as ArrayBuffer;
        this.audioCtx
          .decodeAudioData(ab)
          .then((audioBuffer) => {
            if (!this.isDestroyed && audioBuffer.length > 0) {
              this.enqueueDecodedBuffer(timestampSec, audioBuffer.duration, audioBuffer);
            }
          })
          .catch(() => {});
      } catch {}
    }
  }

  scheduleUpcomingChunks(): void {
    if (!this.audioCtx || !this.gainNode || this.isDestroyed) return;
    this.updateVolume();
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
    this.updateVolume();
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
    for (const chunk of this.queue) {
      (chunk as any)._scheduled = false;
    }
  }

  clearQueue(): void {
    this.resetScheduling();
    this.queue = [];
    if (this.webCodecsDecoder && this.webCodecsDecoder.state === 'configured') {
      try {
        this.webCodecsDecoder.flush().catch(() => {});
      } catch {}
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    this.clearQueue();
    if (this.webCodecsDecoder) {
      try {
        if (this.webCodecsDecoder.state !== 'closed') {
          this.webCodecsDecoder.close();
        }
      } catch {}
      this.webCodecsDecoder = null;
    }
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
