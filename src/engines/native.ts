import { PlaybackEngine, RangeByteSource, EngineHost, AudioTrackInfo, SubtitleTrackInfo } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { findActiveCue } from '../lib/subtitles.js';
import type { MkvDemuxer } from './mkv-demuxer.js';
import type { Eac3AudioPlayer } from './eac3-player.js';

export class NativeEngine implements PlaybackEngine {
  readonly kind = 'native';
  private video: HTMLVideoElement;
  private src: RangeByteSource;
  private host: EngineHost;
  private abortCtrl: AbortController = new AbortController();
  private isDestroyed = false;

  private mkvDemuxer: MkvDemuxer | null = null;
  private eac3Player: Eac3AudioPlayer | null = null;
  private eac3EventsHooked = false;
  private fallbackEngine: PlaybackEngine | null = null;
  private isSwitchingToFallback = false;
  private audioTracks: AudioTrackInfo[] = [];
  private subtitleTracks: SubtitleTrackInfo[] = [];
  private activeAudioTrackId: string | null = null;
  private nativeDefaultAudioTrackId: string | null = null;
  private activeSubtitleTrackId: string | null = null;
  private subtitleCues: { start: number; end: number; text: string }[] = [];
  private isDemuxingLoopRunning = false;
  private demuxWakeResolver: (() => void) | null = null;

  constructor(video: HTMLVideoElement, src: RangeByteSource, host: EngineHost) {
    this.video = video;
    this.src = src;
    this.host = host;
  }

  private wakeDemuxLoop(): void {
    if (this.demuxWakeResolver) {
      const resolve = this.demuxWakeResolver;
      this.demuxWakeResolver = null;
      resolve();
    }
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.demuxWakeResolver === wake) {
          this.demuxWakeResolver = null;
        }
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.demuxWakeResolver = wake;
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
    if (this.fallbackEngine || !this.activeSubtitleTrackId) return;
    if (this.subtitleCues.length > 0) {
      const ct = this.video.currentTime;
      const active = findActiveCue(this.subtitleCues, ct);
      this.host.onSubtitleText?.(active ? active.text : null);
    } else {
      this.host.onSubtitleText?.(null);
    }
  }

  async attach(startTime: number = 0): Promise<void> {
    const name = this.src.name?.toLowerCase() || '';
    const isMkv = name.endsWith('.mkv') || (this.src.mime || '').includes('matroska');

    if (this.src.directUrl) {
      let playUrl = this.src.directUrl;
      if (isMkv) {
        try {
          const u = new URL(playUrl);
          if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.search && u.pathname.toLowerCase().endsWith('.mkv')) {
            u.search = '?_cp=1.vtt';
            playUrl = u.href;
          }
        } catch {}
      }
      this.video.src = playUrl;
    } else {
      throw new PlayerError(
        'unsupported',
        'Direct streaming requires TS transmuxer or a direct URL source.'
      );
    }

    this.video.addEventListener('error', () => {
      const err = this.video.error;
      if (!err || this.isDestroyed || this.fallbackEngine || this.isSwitchingToFallback) return;
      if (isMkv) {
        void this.switchToMkvEngine(this.video.currentTime || startTime);
        return;
      }
      this.host.fail(
        new PlayerError('network', `Video element error code ${err.code}: ${err.message || 'Media format or codec not supported'}`)
      );
    }, { signal: this.abortCtrl.signal });

    if (startTime > 0) {
      const onLoaded = () => {
        this.video.currentTime = startTime;
        this.video.removeEventListener('loadedmetadata', onLoaded);
      };
      this.video.addEventListener('loadedmetadata', onLoaded, { signal: this.abortCtrl.signal });
    }

    this.video.addEventListener('timeupdate', () => {
      this.updateActiveSubtitleOverlay();
    }, { signal: this.abortCtrl.signal });

    this.video.addEventListener('seeked', () => {
      this.updateActiveSubtitleOverlay();
      this.wakeDemuxLoop();
    }, { signal: this.abortCtrl.signal });

    this.video.addEventListener('seeking', () => {
      if (this.fallbackEngine) return;
      this.updateActiveSubtitleOverlay();
      if (this.mkvDemuxer) {
        this.mkvDemuxer.seek(this.video.currentTime || 0);
        this.wakeDemuxLoop();
      }
    }, { signal: this.abortCtrl.signal });

    this.video.addEventListener('play', () => {
      this.wakeDemuxLoop();
    }, { signal: this.abortCtrl.signal });

    // If file is an MKV, wait until metadata is loaded so <video> gets priority on the HTTP connection
    if (isMkv) {
      const onMeta = () => {
        this.video.removeEventListener('loadedmetadata', onMeta);
        if (!this.isDestroyed && !this.fallbackEngine && !this.isSwitchingToFallback) {
          void this.initMkvDemuxing(startTime);
        }
      };
      this.video.addEventListener('loadedmetadata', onMeta, { signal: this.abortCtrl.signal });
    } else {
      const onMetaNonMkv = () => {
        this.video.removeEventListener('loadedmetadata', onMetaNonMkv);
        this.discoverBrowserAudioTracks();
      };
      this.video.addEventListener('loadedmetadata', onMetaNonMkv, { signal: this.abortCtrl.signal });
    }
  }

  private discoverBrowserAudioTracks(): void {
    const browserAudioTracks = (this.video as any).audioTracks;
    if (!browserAudioTracks || typeof browserAudioTracks.length !== 'number' || browserAudioTracks.length === 0) {
      return;
    }
    const list: AudioTrackInfo[] = [];
    let selectedId: string | undefined;
    for (let i = 0; i < browserAudioTracks.length; i++) {
      const bt = browserAudioTracks[i];
      const id = String(bt.id || i + 1);
      const lang = bt.language ? bt.language.toUpperCase() : '';
      const label = [lang, bt.label || `Track ${i + 1}`].filter(Boolean).join(' - ');
      list.push({
        id,
        label,
        language: bt.language,
        isDefault: !!bt.enabled,
      });
      if (bt.enabled) selectedId = id;
    }
    if (list.length > 0) {
      this.audioTracks = list;
      this.activeAudioTrackId = selectedId || list[0].id;
      this.nativeDefaultAudioTrackId = this.activeAudioTrackId;
      this.host.onAudioTracksDiscovered?.(this.audioTracks, this.activeAudioTrackId);
    }
  }

  private async switchToMkvEngine(startTime: number): Promise<void> {
    if (this.isDestroyed || this.fallbackEngine || this.isSwitchingToFallback) return;
    this.isSwitchingToFallback = true;

    // Clean up native MKV demuxer / audio before handing over to MkvEngine
    this.abortCtrl.abort();
    this.abortCtrl = new AbortController();
    this.wakeDemuxLoop();
    this.setCustomAudioSuppression(false);
    if (this.eac3Player) {
      this.eac3Player.destroy();
      this.eac3Player = null;
      this.eac3EventsHooked = false;
    }
    if (this.mkvDemuxer) {
      this.mkvDemuxer.destroy();
      this.mkvDemuxer = null;
    }

    try {
      const { MkvEngine } = await import('./mkv.js');
      if (this.isDestroyed) return;
      this.fallbackEngine = new MkvEngine(this.video, this.src, this.host);
      await this.fallbackEngine.attach(startTime);
      if (!this.isDestroyed) {
        this.video.play().catch(() => {});
      }
    } catch (err) {
      if (!this.isDestroyed) {
        this.host.fail(err);
      }
    } finally {
      this.isSwitchingToFallback = false;
    }
  }

  private async initMkvDemuxing(startTime: number): Promise<void> {
    try {
      const { MkvDemuxer } = await import('./mkv-demuxer.js');
      if (this.isDestroyed || this.fallbackEngine) return;
      this.mkvDemuxer = new MkvDemuxer(this.src);
      const info = await this.mkvDemuxer.parseHeaders();
      if (!info || this.isDestroyed || this.fallbackEngine) return;

      const audioTrks = info.tracks.filter((t) => t.trackType === 'audio');
      const subTrks = info.tracks.filter((t) => t.trackType === 'subtitle');

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

      // Identify which track Chromium's native <video> element decodes by default
      const nativeCompatibleTracks = this.audioTracks.filter((t) => {
        const c = (t.codec || '').toUpperCase();
        return !c.includes('AC3') && !c.includes('EAC3') && !c.includes('DTS') && !c.includes('TRUEHD');
      });
      const defaultNative =
        nativeCompatibleTracks.find((t) => t.isDefault) || nativeCompatibleTracks[0] || null;
      this.nativeDefaultAudioTrackId = defaultNative ? defaultNative.id : null;

      this.subtitleTracks = subTrks.map((t, i) => ({
        id: `mkv-sub-${t.trackNumber}`,
        name: t.name || `${t.language ? t.language.toUpperCase() + ' ' : ''}Subtitle ${i + 1}`,
        label: t.name || `${t.language ? t.language.toUpperCase() + ' ' : ''}Subtitle ${i + 1} (Embedded)`,
        srclang: t.language || 'en',
        provider: 'local',
        ref: { trackNumber: String(t.trackNumber) },
        isDefault: t.isDefault,
      }));

      // Pick default or first audio track
      const chosenAudio = this.audioTracks.find((t) => t.isDefault) || this.audioTracks[0];
      if (chosenAudio) {
        this.activeAudioTrackId = chosenAudio.id;
        this.host.onAudioTracksDiscovered?.(this.audioTracks, chosenAudio.id);
        await this.setupAudioTrack(chosenAudio.id);
      }

      if (this.subtitleTracks.length > 0) {
        const defSub = this.subtitleTracks.find((s) => s.isDefault) || this.subtitleTracks[0];
        this.host.onSubtitleTracksDiscovered?.(this.subtitleTracks, defSub?.id);
        if (defSub && !this.activeSubtitleTrackId) {
          await this.setSubtitleTrack(defSub.id);
        }
      }

      const initialSeek = Math.max(startTime, this.video.currentTime || 0);
      if (initialSeek > 0) {
        this.mkvDemuxer.seek(initialSeek);
      }
      void this.startDemuxLoop();
    } catch (e) {
      console.warn('Failed to initialize MKV demuxer:', e);
    }
  }

  private trySwitchBrowserNativeAudioTracks(trackId: string): boolean {
    const browserAudioTracks = (this.video as any).audioTracks;
    if (!browserAudioTracks || typeof browserAudioTracks.length !== 'number' || browserAudioTracks.length <= 1) {
      return false;
    }
    const targetIdx = this.audioTracks.findIndex((t) => t.id === trackId);
    let matched = false;
    for (let i = 0; i < browserAudioTracks.length; i++) {
      const bt = browserAudioTracks[i];
      const isMatch = String(bt.id) === trackId || i === targetIdx;
      if (isMatch) matched = true;
    }
    if (!matched) return false;

    for (let i = 0; i < browserAudioTracks.length; i++) {
      const bt = browserAudioTracks[i];
      bt.enabled = String(bt.id) === trackId || i === targetIdx;
    }
    return true;
  }

  private async setupAudioTrack(trackId: string): Promise<void> {
    this.activeAudioTrackId = trackId;
    const trackInfo = this.audioTracks.find((t) => t.id === trackId);

    if (!this.mkvDemuxer) {
      this.trySwitchBrowserNativeAudioTracks(trackId);
      return;
    }
    if (!trackInfo) return;

    const trackNum = parseInt(trackId, 10);
    const trackMeta = this.mkvDemuxer.tracks.find((t) => t.trackNumber === trackNum);
    const codec = (trackInfo.codec || '').toUpperCase();
    const isEac3OrAc3 = codec.includes('AC3') || codec.includes('EAC3');

    // Check if the browser natively supports switching to this track on <video>
    let useNativeVideoAudio = false;
    if (!isEac3OrAc3) {
      if (this.trySwitchBrowserNativeAudioTracks(trackId)) {
        useNativeVideoAudio = true;
      } else if (trackId === this.nativeDefaultAudioTrackId) {
        useNativeVideoAudio = true;
      }
    }

    if (useNativeVideoAudio) {
      this.mkvDemuxer.setActiveAudioTrack(null);
      if (this.eac3Player) {
        this.eac3Player.destroy();
        this.eac3Player = null;
        this.eac3EventsHooked = false;
      }
      this.setCustomAudioSuppression(false);
    } else {
      // Either E-AC-3/AC-3 or a secondary audio track (e.g. Track 2 AAC/Opus/MP3) where Chrome <video>
      // only plays Track 1 natively: silence <video>'s built-in audio and decode the selected track via Web Audio!
      this.setCustomAudioSuppression(true);
      this.mkvDemuxer.setActiveAudioTrack(trackNum);

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

      this.mkvDemuxer.onAudioFrame((chunk) => {
        if (this.activeAudioTrackId === trackId) {
          this.eac3Player?.pushAudioFrame(chunk.timeSec, chunk.data);
        }
      });

      if (!this.video.paused) {
        this.eac3Player.onPlay();
      }
    }
  }

  private hookEac3PlayerEvents(): void {
    const onPlay = () => this.eac3Player?.onPlay();
    const onPause = () => this.eac3Player?.onPause();
    const onSeeking = () => {
      if (!this.eac3Player || !this.mkvDemuxer) return;
      this.eac3Player.onSeek();
      this.mkvDemuxer.seek(this.video.currentTime);
      this.wakeDemuxLoop();
    };
    const onTimeUpdate = () => this.eac3Player?.scheduleUpcomingChunks();
    const onVolumeChange = () => this.eac3Player?.updateVolume();
    const onRateChange = () => this.eac3Player?.onRateChange();

    this.video.addEventListener('play', onPlay, { signal: this.abortCtrl.signal });
    this.video.addEventListener('pause', onPause, { signal: this.abortCtrl.signal });
    this.video.addEventListener('seeking', onSeeking, { signal: this.abortCtrl.signal });
    this.video.addEventListener('timeupdate', onTimeUpdate, { signal: this.abortCtrl.signal });
    this.video.addEventListener('volumechange', onVolumeChange, { signal: this.abortCtrl.signal });
    this.video.addEventListener('ratechange', onRateChange, { signal: this.abortCtrl.signal });
  }

  private async startDemuxLoop(): Promise<void> {
    if (this.isDemuxingLoopRunning || !this.mkvDemuxer) return;
    this.isDemuxingLoopRunning = true;

    let prebufferCount = 0;
    let needsBurst = true;
    while (!this.isDestroyed && !this.abortCtrl.signal.aborted && !this.fallbackEngine) {
      const needsAudio = !!this.eac3Player;
      const needsSubs = !!this.activeSubtitleTrackId;
      if (!needsAudio && !needsSubs) {
        await this.sleepInterruptible(300);
        continue;
      }

      const curTime = this.video.currentTime || 0;
      const demuxTime = this.mkvDemuxer.lastTimeSec;
      const isBehindOrFarAhead = demuxTime < curTime + 5 || demuxTime > curTime + 45;

      if (this.video.paused && !this.video.seeking && prebufferCount >= 4 && !isBehindOrFarAhead) {
        await this.sleepInterruptible(250);
        continue;
      }

      // Buffer in bursts (up to 35s ahead, then sleep until within 15s) to minimize network request frequency
      if (this.video.seeking || demuxTime < curTime + 15 || demuxTime > curTime + 45) {
        needsBurst = true;
      } else if (demuxTime > curTime + 35) {
        needsBurst = false;
      }

      if (!needsBurst && !this.video.seeking) {
        await this.sleepInterruptible(350);
        continue;
      }

      const hasMore = await this.mkvDemuxer.readNextChunk(1024 * 1024);
      prebufferCount++;
      if (!hasMore) {
        await this.sleepInterruptible(400);
      }
    }

    this.isDemuxingLoopRunning = false;
  }

  getAudioTracks(): AudioTrackInfo[] {
    if (this.fallbackEngine?.getAudioTracks) {
      return this.fallbackEngine.getAudioTracks();
    }
    return this.audioTracks;
  }

  async setAudioTrack(trackId: string): Promise<void> {
    if (this.fallbackEngine?.setAudioTrack) {
      await this.fallbackEngine.setAudioTrack(trackId);
      return;
    }
    await this.setupAudioTrack(trackId);
    if (this.mkvDemuxer && this.eac3Player) {
      this.mkvDemuxer.seek(this.video.currentTime || 0);
      this.wakeDemuxLoop();
    }
  }

  getActiveAudioTrack(): string | null {
    if (this.fallbackEngine?.getActiveAudioTrack) {
      return this.fallbackEngine.getActiveAudioTrack();
    }
    return this.activeAudioTrackId;
  }

  getSubtitleTracks(): SubtitleTrackInfo[] {
    if (this.fallbackEngine?.getSubtitleTracks) {
      return this.fallbackEngine.getSubtitleTracks();
    }
    return this.subtitleTracks;
  }

  async setSubtitleTrack(trackId: string | null): Promise<void> {
    if (this.fallbackEngine?.setSubtitleTrack) {
      await this.fallbackEngine.setSubtitleTrack(trackId);
      return;
    }
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

    // Update current active cue on screen immediately if matching current playback time
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

    const ct = this.video.currentTime || 0;
    if (!this.eac3Player && (this.mkvDemuxer.lastTimeSec < ct - 2 || this.mkvDemuxer.lastTimeSec > ct + 35)) {
      this.mkvDemuxer.seek(ct);
    }
    this.wakeDemuxLoop();
  }

  destroy(): void {
    this.isDestroyed = true;
    this.abortCtrl.abort();
    this.wakeDemuxLoop();
    this.setCustomAudioSuppression(false);
    this.host.onSubtitleText?.(null);
    this.subtitleCues = [];
    if (this.fallbackEngine) {
      this.fallbackEngine.destroy();
      this.fallbackEngine = null;
    }
    if (this.eac3Player) {
      this.eac3Player.destroy();
      this.eac3Player = null;
      this.eac3EventsHooked = false;
    }
    if (this.mkvDemuxer) {
      this.mkvDemuxer.destroy();
      this.mkvDemuxer = null;
    }
    this.video.removeAttribute('src');
    this.video.load();
  }
}
