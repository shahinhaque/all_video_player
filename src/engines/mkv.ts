import { PlaybackEngine, RangeByteSource, EngineHost, AudioTrackInfo, SubtitleTrackInfo } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { readAll, joinChunks } from '../lib/util.js';
import { fromTimeRanges, calculateEvictionRanges } from '../lib/buffer.js';
import { findActiveCue } from '../lib/subtitles.js';
import { MkvHeaderInfo, TrackMetadata } from './ebml.js';
import type { MkvDemuxer, MkvVideoChunk, MkvAudioChunk } from './mkv-demuxer.js';
import type { Eac3AudioPlayer } from './eac3-player.js';
// @ts-expect-error mux.js doesn't bundle ts types
import muxjs from 'mux.js';

export interface MkvEngineOptions {
  chunkSize?: number;
}

interface AvcCodecConfig {
  profileIdc: number;
  profileCompatibility: number;
  levelIdc: number;
  nalLengthSize: number;
  sps: Uint8Array[];
  pps: Uint8Array[];
}

interface AacCodecConfig {
  audioobjecttype: number;
  samplingfrequencyindex: number;
  channelcount: number;
  samplerate: number;
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export function parseAvcCodecPrivate(cp?: Uint8Array): AvcCodecConfig | null {
  if (!cp || cp.length < 7 || cp[0] !== 1) return null;
  const profileIdc = cp[1];
  const profileCompatibility = cp[2];
  const levelIdc = cp[3];
  const nalLengthSize = (cp[4] & 0x03) + 1;
  const numSps = cp[5] & 0x1f;

  let off = 6;
  const sps: Uint8Array[] = [];
  for (let i = 0; i < numSps; i++) {
    if (off + 2 > cp.length) break;
    const len = (cp[off] << 8) | cp[off + 1];
    off += 2;
    if (off + len > cp.length) break;
    sps.push(cp.slice(off, off + len));
    off += len;
  }

  const pps: Uint8Array[] = [];
  if (off < cp.length) {
    const numPps = cp[off++];
    for (let i = 0; i < numPps; i++) {
      if (off + 2 > cp.length) break;
      const len = (cp[off] << 8) | cp[off + 1];
      off += 2;
      if (off + len > cp.length) break;
      pps.push(cp.slice(off, off + len));
      off += len;
    }
  }

  if (sps.length === 0 || pps.length === 0) return null;
  return { profileIdc, profileCompatibility, levelIdc, nalLengthSize, sps, pps };
}

export function parseAacCodecPrivate(
  cp?: Uint8Array,
  fallbackSampleRate = 44100,
  fallbackChannels = 2
): AacCodecConfig {
  let audioobjecttype = 2;
  let samplingfrequencyindex = AAC_SAMPLE_RATES.indexOf(fallbackSampleRate);
  if (samplingfrequencyindex < 0) samplingfrequencyindex = 4; // 44100
  let channelcount = fallbackChannels || 2;

  if (cp && cp.length >= 2) {
    const aot = (cp[0] >>> 3) & 0x1f;
    if (aot > 0) audioobjecttype = aot;
    const sfi = ((cp[0] & 0x07) << 1) | (cp[1] >>> 7);
    if (sfi >= 0 && sfi < AAC_SAMPLE_RATES.length) {
      samplingfrequencyindex = sfi;
    }
    const ch = (cp[1] >>> 3) & 0x0f;
    if (ch > 0) channelcount = ch;
  }

  const samplerate = AAC_SAMPLE_RATES[samplingfrequencyindex] || fallbackSampleRate || 44100;
  return { audioobjecttype, samplingfrequencyindex, channelcount, samplerate };
}

function normalizeAvcNalLength(data: Uint8Array, nalLengthSize: number): Uint8Array {
  if (nalLengthSize === 4) return data;
  const parts: Uint8Array[] = [];
  let off = 0;
  let total = 0;
  while (off + nalLengthSize <= data.length) {
    let nalLen = 0;
    for (let i = 0; i < nalLengthSize; i++) {
      nalLen = (nalLen << 8) | data[off + i];
    }
    off += nalLengthSize;
    if (nalLen <= 0 || off + nalLen > data.length) break;
    const out = new Uint8Array(4 + nalLen);
    out[0] = (nalLen >>> 24) & 0xff;
    out[1] = (nalLen >>> 16) & 0xff;
    out[2] = (nalLen >>> 8) & 0xff;
    out[3] = nalLen & 0xff;
    out.set(data.subarray(off, off + nalLen), 4);
    parts.push(out);
    total += out.byteLength;
    off += nalLen;
  }
  return parts.length > 0 ? joinChunks(parts, total) : data;
}

/**
 * Client-side Matroska (.mkv) Playback Engine for Chromium.
 * Demuxes EBML headers/clusters, remuxes H.264/AAC into ISO BMFF (fMP4) segments for MSE,
 * decodes E-AC-3/AC-3 via WASM Web Audio, and extracts embedded ASS/SSA/SRT subtitles.
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
  private durationSet = false;

  private headerInfo: MkvHeaderInfo | null = null;
  private currentByteOffset = 0;
  private chunkSize: number;

  private mkvDemuxer: MkvDemuxer | null = null;
  private eac3Player: Eac3AudioPlayer | null = null;
  private eac3EventsHooked = false;
  private audioTracks: AudioTrackInfo[] = [];
  private subtitleTracks: SubtitleTrackInfo[] = [];
  private activeAudioTrackId: string | null = null;
  private activeSubtitleTrackId: string | null = null;
  private subtitleCues: { start: number; end: number; text: string }[] = [];
  private streamWakeResolver: (() => void) | null = null;

  private isRemuxingToMp4 = false;
  private sourceBufferHasAudio = false;
  private avcConfig: AvcCodecConfig | null = null;
  private aacConfig: AacCodecConfig | null = null;
  private videoTrackMeta: TrackMetadata | null = null;
  private mp4SequenceNumber = 1;
  private pendingVideoFrames: MkvVideoChunk[] = [];
  private pendingAudioFrames: MkvAudioChunk[] = [];
  private waitingForKeyframe = true;

  constructor(video: HTMLVideoElement, src: RangeByteSource, host: EngineHost, options?: MkvEngineOptions) {
    this.video = video;
    this.src = src;
    this.host = host;
    this.chunkSize = options?.chunkSize ?? 1024 * 1024;
  }

  private wakeStreamLoop(): void {
    if (this.streamWakeResolver) {
      const resolve = this.streamWakeResolver;
      this.streamWakeResolver = null;
      resolve();
    }
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.streamWakeResolver === wake) {
          this.streamWakeResolver = null;
        }
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.streamWakeResolver = wake;
    });
  }

  private setCustomAudioSuppression(suppressNativeElementAudio: boolean): void {
    if (suppressNativeElementAudio) {
      if (this.video.dataset) {
        this.video.dataset.customAudioActive = 'true';
      }
      this.video.muted = true;
    } else {
      if (this.video.dataset) {
        delete this.video.dataset.customAudioActive;
      }
      const userMuted = this.video.dataset?.userMuted === 'true';
      this.video.muted = userMuted;
    }
  }

  private updateActiveSubtitleOverlay(): void {
    if (!this.activeSubtitleTrackId) return;
    if (this.subtitleCues.length > 0) {
      const ct = this.video.currentTime;
      const active = findActiveCue(this.subtitleCues, ct);
      this.host.onSubtitleText?.(active ? active.text : null);
    } else {
      this.host.onSubtitleText?.(null);
    }
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

    await this.startStreaming(startTime);
  }

  private setupRemuxCallbacks(): void {
    if (!this.mkvDemuxer) return;

    this.mkvDemuxer.onVideoFrame((chunk) => {
      if (this.waitingForKeyframe) {
        if (!chunk.isKeyframe) return;
        this.waitingForKeyframe = false;
      }
      this.pendingVideoFrames.push(chunk);
    });

    this.mkvDemuxer.onAudioFrame((chunk) => {
      if (this.eac3Player) {
        this.eac3Player.pushAudioFrame(chunk.timeSec, chunk.data);
      } else if (this.aacConfig) {
        this.pendingAudioFrames.push(chunk);
      }
    });
  }

  private async configureAudioPipeline(trackId: string): Promise<void> {
    const trackNum = parseInt(trackId, 10);
    const trackInfo = this.audioTracks.find((t) => t.id === trackId);
    const trackMeta = this.headerInfo?.tracks.find((t) => t.trackNumber === trackNum);
    if (!trackInfo || !this.mkvDemuxer) return;

    this.activeAudioTrackId = trackId;
    this.mkvDemuxer.setActiveAudioTrack(trackNum);

    const codec = (trackInfo.codec || '').toUpperCase();
    const isEac3OrAc3 = codec.includes('AC3') || codec.includes('EAC3');
    const canRemuxAacInMse =
      !isEac3OrAc3 &&
      codec.includes('AAC') &&
      !!trackMeta &&
      (!this.sourceBuffer || this.sourceBufferHasAudio);

    if (!canRemuxAacInMse) {
      this.aacConfig = null;
      this.setCustomAudioSuppression(true);
      if (!this.eac3Player) {
        const { Eac3AudioPlayer } = await import('./eac3-player.js');
        this.eac3Player = new Eac3AudioPlayer(this.video);
        await this.eac3Player.init();
      } else {
        this.eac3Player.clearQueue();
      }
      if (trackMeta) {
        await this.eac3Player.configureTrack({
          codecId: trackMeta.codecId,
          samplingRate: trackMeta.samplingRate,
          channels: trackMeta.channels,
          codecPrivate: trackMeta.codecPrivate,
        });
      }
      if (!this.eac3EventsHooked) {
        this.hookEac3PlayerEvents();
        this.eac3EventsHooked = true;
      }
      this.eac3Player.updateVolume();
      if (!this.video.paused) {
        this.eac3Player.onPlay();
      }
    } else {
      if (this.eac3Player) {
        this.eac3Player.destroy();
        this.eac3Player = null;
        this.eac3EventsHooked = false;
      }
      this.setCustomAudioSuppression(false);
      if (codec.includes('AAC') && trackMeta) {
        this.aacConfig = parseAacCodecPrivate(
          trackMeta.codecPrivate,
          trackMeta.samplingRate,
          trackMeta.channels
        );
      } else {
        this.aacConfig = null;
      }
    }
  }

  private hookEac3PlayerEvents(): void {
    if (!this.eac3Player) return;

    const onPlay = () => this.eac3Player?.onPlay();
    const onPause = () => this.eac3Player?.onPause();
    const onTimeUpdate = () => this.eac3Player?.scheduleUpcomingChunks();
    const onVolumeChange = () => this.eac3Player?.updateVolume();
    const onRateChange = () => this.eac3Player?.onRateChange();

    this.video.addEventListener('play', onPlay, { signal: this.abortCtrl.signal });
    this.video.addEventListener('pause', onPause, { signal: this.abortCtrl.signal });
    this.video.addEventListener('timeupdate', onTimeUpdate, { signal: this.abortCtrl.signal });
    this.video.addEventListener('volumechange', onVolumeChange, { signal: this.abortCtrl.signal });
    this.video.addEventListener('ratechange', onRateChange, { signal: this.abortCtrl.signal });
  }

  private initSourceBuffer(headerInfo: MkvHeaderInfo): boolean {
    if (this.sourceBuffer || !this.mediaSource || this.mediaSource.readyState !== 'open') return false;

    const videoTrk = headerInfo.tracks.find((t) => t.trackType === 'video');
    this.videoTrackMeta = videoTrk || null;

    if (videoTrk) {
      const vCodec = videoTrk.codecId.toUpperCase();
      if (vCodec.includes('AVC') || vCodec.includes('H264')) {
        this.avcConfig = parseAvcCodecPrivate(videoTrk.codecPrivate);
      }
    }

    const mimeCandidates: string[] = [];

    if (this.avcConfig) {
      this.isRemuxingToMp4 = true;
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      const avcCodecStr = `avc1.${hex(this.avcConfig.profileIdc)}${hex(this.avcConfig.profileCompatibility)}${hex(this.avcConfig.levelIdc)}`;
      if (this.aacConfig) {
        this.sourceBufferHasAudio = true;
        mimeCandidates.push(`video/mp4; codecs="${avcCodecStr}, mp4a.40.2"`);
        mimeCandidates.push('video/mp4; codecs="avc1.640028, mp4a.40.2"');
        mimeCandidates.push('video/mp4; codecs="avc1.4d4028, mp4a.40.2"');
        mimeCandidates.push('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
      } else {
        this.sourceBufferHasAudio = false;
        mimeCandidates.push(`video/mp4; codecs="${avcCodecStr}"`);
        mimeCandidates.push('video/mp4; codecs="avc1.640028"');
        mimeCandidates.push('video/mp4; codecs="avc1.4d4028"');
        mimeCandidates.push('video/mp4; codecs="avc1.42E01E"');
      }
    } else {
      let hasVp9 = false;
      let hasVp8 = false;
      let hasOpus = false;
      for (const trk of headerInfo.tracks) {
        const cid = trk.codecId.toUpperCase();
        if (cid.includes('VP9')) hasVp9 = true;
        if (cid.includes('VP8')) hasVp8 = true;
        if (cid.includes('OPUS')) hasOpus = true;
      }
      if (hasVp9) {
        mimeCandidates.push(hasOpus ? 'video/webm; codecs="vp9, opus"' : 'video/webm; codecs="vp9"');
      }
      if (hasVp8) {
        mimeCandidates.push(hasOpus ? 'video/webm; codecs="vp8, opus"' : 'video/webm; codecs="vp8"');
      }
      mimeCandidates.push('video/webm; codecs="vp9, opus"', 'video/webm', 'video/mp4');
    }

    let selectedMime = '';
    for (const cand of mimeCandidates) {
      if (typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(cand)) {
        selectedMime = cand;
        break;
      }
    }

    if (!selectedMime) {
      selectedMime = this.isRemuxingToMp4 ? 'video/mp4' : 'video/webm';
    }

    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(selectedMime);
      this.sourceBuffer.addEventListener('updateend', () => {
        this.isAppending = false;
        this.isPruning = false;
        if (!this.durationSet && this.mediaSource && this.mediaSource.readyState === 'open' && this.headerInfo && this.headerInfo.duration > 0) {
          try {
            this.mediaSource.duration = this.headerInfo.duration;
            this.durationSet = true;
          } catch {}
        }
        if (this.bufferQueue.length > 0) {
          this.drainQueue();
        } else {
          this.pruneBuffer();
        }
      });

      if (this.isRemuxingToMp4 && this.avcConfig && this.videoTrackMeta) {
        const gen = muxjs.mp4.generator;
        const mp4Tracks: any[] = [
          {
            id: 1,
            type: 'video',
            width: this.videoTrackMeta.width || 1920,
            height: this.videoTrackMeta.height || 1080,
            duration: 0xffffffff,
            profileIdc: this.avcConfig.profileIdc,
            profileCompatibility: this.avcConfig.profileCompatibility,
            levelIdc: this.avcConfig.levelIdc,
            sps: this.avcConfig.sps,
            pps: this.avcConfig.pps,
          },
        ];

        if (this.aacConfig) {
          mp4Tracks.push({
            id: 2,
            type: 'audio',
            channelcount: this.aacConfig.channelcount,
            samplesize: 16,
            samplerate: this.aacConfig.samplerate,
            duration: 0xffffffff,
            audioobjecttype: this.aacConfig.audioobjecttype,
            samplingfrequencyindex: this.aacConfig.samplingfrequencyindex,
          });
        }

        const initSeg = gen.initSegment(mp4Tracks);
        this.queueBuffer(initSeg);
      }

      return true;
    } catch (e) {
      console.warn('Failed to add SourceBuffer for MKV with mime', selectedMime, e);
      return false;
    }
  }

  private flushRemuxedSegment(): void {
    if (!this.isRemuxingToMp4 || !this.avcConfig || !this.videoTrackMeta) return;
    const gen = muxjs.mp4.generator;

    if (this.pendingVideoFrames.length > 0) {
      const frames = this.pendingVideoFrames;
      this.pendingVideoFrames = [];

      const sortedPts = frames.map((f) => f.timeSec).sort((a, b) => a - b);
      let defaultFrameDurSec = 1 / 23.976;
      if (sortedPts.length > 1) {
        const span = sortedPts[sortedPts.length - 1] - sortedPts[0];
        if (span > 0) {
          defaultFrameDurSec = span / (sortedPts.length - 1);
        }
      }

      // Compute max negative PTS - sortedPts offset so compositionTimeOffset is always >= 0
      let minOffsetSec = 0;
      for (let i = 0; i < frames.length; i++) {
        const diff = frames[i].timeSec - sortedPts[i];
        if (diff < minOffsetSec) minOffsetSec = diff;
      }
      const dtsShiftSec = minOffsetSec < 0 ? -minOffsetSec : 0;

      const baseDtsTicks = Math.max(0, Math.round((sortedPts[0] - dtsShiftSec) * 90000));
      const payloadParts: Uint8Array[] = [];
      let payloadTotal = 0;
      const samples: any[] = [];

      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const normData = normalizeAvcNalLength(f.data, this.avcConfig.nalLengthSize);
        payloadParts.push(normData);
        payloadTotal += normData.byteLength;

        const curDtsSec = sortedPts[i] - dtsShiftSec;
        const nextDtsSec = i + 1 < sortedPts.length ? sortedPts[i + 1] - dtsShiftSec : curDtsSec + defaultFrameDurSec;
        const durationTicks = Math.max(1, Math.round((nextDtsSec - curDtsSec) * 90000));
        const ctoTicks = Math.max(0, Math.round((f.timeSec - curDtsSec) * 90000));

        samples.push({
          duration: durationTicks,
          size: normData.byteLength,
          compositionTimeOffset: ctoTicks,
          flags: f.isKeyframe
            ? {
                isLeading: 0,
                dependsOn: 2,
                isDependedOn: 0,
                hasRedundancy: 0,
                paddingValue: 0,
                isNonSyncSample: 0,
                degradationPriority: 0,
              }
            : {
                isLeading: 0,
                dependsOn: 1,
                isDependedOn: 0,
                hasRedundancy: 0,
                paddingValue: 0,
                isNonSyncSample: 1,
                degradationPriority: 0,
              },
        });
      }

      const vTrackFragment = {
        id: 1,
        type: 'video',
        baseMediaDecodeTime: baseDtsTicks,
        samples,
      };

      const vMoof = gen.moof(this.mp4SequenceNumber++, [vTrackFragment]);
      const vMdat = gen.mdat(joinChunks(payloadParts, payloadTotal));
      this.queueBuffer(joinChunks([vMoof, vMdat], vMoof.byteLength + vMdat.byteLength));
    }

    if (this.aacConfig && this.pendingAudioFrames.length > 0) {
      const aFrames = this.pendingAudioFrames;
      this.pendingAudioFrames = [];

      const sr = this.aacConfig.samplerate;
      const baseAudioDtsTicks = Math.max(0, Math.round(aFrames[0].timeSec * sr));
      const aParts: Uint8Array[] = [];
      let aTotal = 0;
      const aSamples: any[] = [];

      for (let i = 0; i < aFrames.length; i++) {
        const af = aFrames[i];
        if (af.data.byteLength === 0) continue;
        aParts.push(af.data);
        aTotal += af.data.byteLength;

        let durTicks = 1024;
        if (i + 1 < aFrames.length) {
          const deltaTicks = Math.round((aFrames[i + 1].timeSec - af.timeSec) * sr);
          if (deltaTicks > 128 && deltaTicks < 8192) {
            durTicks = deltaTicks;
          }
        }
        aSamples.push({
          duration: durTicks,
          size: af.data.byteLength,
        });
      }

      if (aSamples.length > 0) {
        const aTrackFragment = {
          id: 2,
          type: 'audio',
          baseMediaDecodeTime: baseAudioDtsTicks,
          samples: aSamples,
        };
        const aMoof = gen.moof(this.mp4SequenceNumber++, [aTrackFragment]);
        const aMdat = gen.mdat(joinChunks(aParts, aTotal));
        this.queueBuffer(joinChunks([aMoof, aMdat], aMoof.byteLength + aMdat.byteLength));
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
    this.updateActiveSubtitleOverlay();
  };

  private async startStreaming(startSec: number = 0): Promise<void> {
    try {
      const { MkvDemuxer } = await import('./mkv-demuxer.js');
      this.mkvDemuxer = new MkvDemuxer(this.src);
      const headerInfo = await this.mkvDemuxer.parseHeaders();
      if (!headerInfo) {
        throw new PlayerError('codec', 'Could not parse MKV EBML tracks or video header.');
      }
      if (this.isDestroyed) return;
      this.headerInfo = headerInfo;

      const videoTrk = headerInfo.tracks.find((t) => t.trackType === 'video');
      if (videoTrk) {
        this.mkvDemuxer.setActiveVideoTrack(videoTrk.trackNumber);
      }

      const audioTrks = headerInfo.tracks.filter((t) => t.trackType === 'audio');
      const subTrks = headerInfo.tracks.filter((t) => t.trackType === 'subtitle');

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

      this.subtitleTracks = subTrks.map((t, i) => ({
        id: `mkv-sub-${t.trackNumber}`,
        name: t.name || `${t.language ? t.language.toUpperCase() + ' ' : ''}Subtitle ${i + 1}`,
        label: t.name || `${t.language ? t.language.toUpperCase() + ' ' : ''}Subtitle ${i + 1} (Embedded)`,
        srclang: t.language || 'en',
        provider: 'local' as const,
        ref: { trackNumber: String(t.trackNumber) },
        isDefault: t.isDefault,
      }));

      if (this.audioTracks.length > 0) {
        const chosen = this.audioTracks.find((a) => a.isDefault) || this.audioTracks[0];
        this.host.onAudioTracksDiscovered?.(this.audioTracks, chosen.id);
        await this.configureAudioPipeline(chosen.id);
      }

      if (this.subtitleTracks.length > 0) {
        const defSub = this.subtitleTracks.find((s) => s.isDefault) || this.subtitleTracks[0];
        this.host.onSubtitleTracksDiscovered?.(this.subtitleTracks, defSub?.id);
        if (defSub && !this.activeSubtitleTrackId) {
          await this.setSubtitleTrack(defSub.id);
        }
      }

      this.setupRemuxCallbacks();

      if (!this.initSourceBuffer(headerInfo)) {
        throw new PlayerError('codec', 'Browser MSE cannot allocate SourceBuffer for this MKV stream.');
      }

      this.currentByteOffset = this.mkvDemuxer.clusterStartOffset;

      if (startSec > 0 && headerInfo.duration > 0 && this.src.size > 0) {
        this.mkvDemuxer.seek(startSec);
        this.currentByteOffset = this.mkvDemuxer.currentOffset;
        this.video.currentTime = startSec;
      }
    } catch (err) {
      if (this.isDestroyed || this.abortCtrl.signal.aborted) return;
      this.host.fail(err);
      return;
    }

    // Stream clusters and remux to fMP4
    while (!this.isDestroyed && !this.abortCtrl.signal.aborted) {
      if (this.shouldWaitBuffer()) {
        await this.sleepInterruptible(300);
        continue;
      }

      const fileSize = this.src.size;
      if (fileSize > 0 && this.currentByteOffset >= fileSize) {
        if (this.mediaSource && this.mediaSource.readyState === 'open' && !this.sourceBuffer?.updating && this.bufferQueue.length === 0) {
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

        this.currentByteOffset += chunk.length;
        this.mkvDemuxer?.demuxBuffer(chunk);

        if (this.isRemuxingToMp4) {
          this.flushRemuxedSegment();
        } else {
          this.queueBuffer(chunk);
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
    if (this.bufferQueue.length > 8) return true;
    const ct = this.video.currentTime;
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= ct + 0.5 && ct <= ranges.end(i)) {
        return ranges.end(i) - ct > 45;
      }
    }
    return false;
  }

  private onSeeking = () => {
    if (this.isDestroyed || !this.video) return;
    const targetTime = this.video.currentTime;
    this.updateActiveSubtitleOverlay();

    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= targetTime && targetTime <= ranges.end(i)) {
        this.eac3Player?.onSeek();
        return; // Fast seek within buffered range
      }
    }

    if (this.headerInfo && this.headerInfo.duration > 0 && this.src.size > 0 && this.mkvDemuxer) {
      this.pendingVideoFrames = [];
      this.pendingAudioFrames = [];
      this.waitingForKeyframe = true;
      this.bufferQueue = [];
      this.mkvDemuxer.seek(targetTime);
      this.currentByteOffset = this.mkvDemuxer.currentOffset;
      this.eac3Player?.onSeek();
      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        try {
          this.sourceBuffer.abort();
        } catch {}
      }
      this.wakeStreamLoop();
    }
  };

  getAudioTracks(): AudioTrackInfo[] {
    return this.audioTracks;
  }

  async setAudioTrack(trackId: string): Promise<void> {
    if (trackId === this.activeAudioTrackId) return;
    const curTime = this.video.currentTime || 0;
    await this.configureAudioPipeline(trackId);

    if (this.isRemuxingToMp4 && this.avcConfig && this.videoTrackMeta && this.aacConfig && this.sourceBufferHasAudio) {
      const gen = muxjs.mp4.generator;
      const mp4Tracks: any[] = [
        {
          id: 1,
          type: 'video',
          width: this.videoTrackMeta.width || 1920,
          height: this.videoTrackMeta.height || 1080,
          duration: 0xffffffff,
          profileIdc: this.avcConfig.profileIdc,
          profileCompatibility: this.avcConfig.profileCompatibility,
          levelIdc: this.avcConfig.levelIdc,
          sps: this.avcConfig.sps,
          pps: this.avcConfig.pps,
        },
        {
          id: 2,
          type: 'audio',
          channelcount: this.aacConfig.channelcount,
          samplesize: 16,
          samplerate: this.aacConfig.samplerate,
          duration: 0xffffffff,
          audioobjecttype: this.aacConfig.audioobjecttype,
          samplingfrequencyindex: this.aacConfig.samplingfrequencyindex,
        },
      ];
      this.pendingVideoFrames = [];
      this.pendingAudioFrames = [];
      this.waitingForKeyframe = true;
      this.bufferQueue = [];
      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        try {
          this.sourceBuffer.abort();
        } catch {}
      }
      const initSeg = gen.initSegment(mp4Tracks);
      this.queueBuffer(initSeg);
    }

    if (this.mkvDemuxer) {
      this.mkvDemuxer.seek(curTime);
      this.currentByteOffset = this.mkvDemuxer.currentOffset;
      this.wakeStreamLoop();
    }
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
    const cached = this.mkvDemuxer.getCuesForTrack(trackNum);
    this.subtitleCues = cached
      .map((c) => ({
        start: c.timeSec,
        end: c.timeSec + (c.durationSec || 3.5),
        text: c.text,
      }))
      .sort((a, b) => a.start - b.start);
    this.mkvDemuxer.setActiveSubtitleTrack(trackNum);

    this.updateActiveSubtitleOverlay();

    this.mkvDemuxer.onSubtitleCue((cue) => {
      if (this.activeSubtitleTrackId !== trackId) return;
      const start = cue.timeSec;
      const end = cue.timeSec + (cue.durationSec || 3.5);
      if (!this.subtitleCues.some((c) => Math.abs(c.start - start) < 0.05 && c.text === cue.text)) {
        this.subtitleCues.push({ start, end, text: cue.text });
        if (
          this.subtitleCues.length > 1 &&
          this.subtitleCues[this.subtitleCues.length - 1].start <
            this.subtitleCues[this.subtitleCues.length - 2].start
        ) {
          this.subtitleCues.sort((a, b) => a.start - b.start);
        }
      }
      const ct = this.video.currentTime;
      if (ct >= start && ct <= end) {
        this.updateActiveSubtitleOverlay();
      }
    });
  }

  destroy(): void {
    this.isDestroyed = true;
    this.wakeStreamLoop();
    this.setCustomAudioSuppression(false);
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.abortCtrl.abort();
    this.host.onSubtitleText?.(null);
    this.subtitleCues = [];
    if (this.eac3Player) {
      this.eac3Player.destroy();
      this.eac3Player = null;
      this.eac3EventsHooked = false;
    }
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
