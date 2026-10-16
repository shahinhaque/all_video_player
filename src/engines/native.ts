import { PlaybackEngine, RangeByteSource, EngineHost, AudioTrackInfo, SubtitleTrackInfo } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
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
  private audioTracks: AudioTrackInfo[] = [];
  private subtitleTracks: SubtitleTrackInfo[] = [];
  private activeAudioTrackId: string | null = null;
  private activeSubtitleTrackId: string | null = null;
  private subtitleTextTrack: TextTrack | null = null;
  private subtitleCues: { start: number; end: number; text: string }[] = [];
  private isDemuxingLoopRunning = false;

  constructor(video: HTMLVideoElement, src: RangeByteSource, host: EngineHost) {
    this.video = video;
    this.src = src;
    this.host = host;
  }

  async attach(startTime: number = 0): Promise<void> {
    if (this.src.directUrl) {
      this.video.src = this.src.directUrl;
    } else {
      throw new PlayerError(
        'unsupported',
        'Direct streaming requires TS transmuxer or a direct URL source.'
      );
    }

    this.video.addEventListener('error', () => {
      const err = this.video.error;
      if (!err || this.isDestroyed) return;
      const name = this.src.name?.toLowerCase() || '';
      const isMkv = name.endsWith('.mkv') || this.src.mime?.includes('matroska');
      if (err.code === 4 && isMkv) {
        this.host.fail(
          new PlayerError(
            'codec',
            'Chromium does not support native Matroska (.mkv) container decoding. Open in Firefox or stream MP4/TS.'
          )
        );
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
      this.video.addEventListener('loadedmetadata', onLoaded);
    }

    this.video.load();

    this.video.addEventListener('timeupdate', () => {
      if (this.activeSubtitleTrackId) {
        if (this.subtitleCues.length > 0) {
          const ct = this.video.currentTime;
          const active = this.subtitleCues.find((c) => ct >= c.start && ct <= c.end);
          this.host.onSubtitleText?.(active ? active.text : null);
        } else {
          this.host.onSubtitleText?.(null);
        }
      }
    }, { signal: this.abortCtrl.signal });

    // If file is an MKV, initialize MkvDemuxer to inspect and handle multi-audio and subtitles
    const isMkv = (this.src.name || '').toLowerCase().endsWith('.mkv') || (this.src.mime || '').includes('matroska');
    if (isMkv) {
      this.initMkvDemuxing(startTime);
    }
  }

  private async initMkvDemuxing(startTime: number): Promise<void> {
    try {
      const { MkvDemuxer } = await import('./mkv-demuxer.js');
      this.mkvDemuxer = new MkvDemuxer(this.src);
      const info = await this.mkvDemuxer.parseHeaders();
      if (!info || this.isDestroyed) return;

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
      let chosenAudio = this.audioTracks.find((t) => t.isDefault) || this.audioTracks[0];
      if (chosenAudio) {
        this.activeAudioTrackId = chosenAudio.id;
        this.host.onAudioTracksDiscovered?.(this.audioTracks, chosenAudio.id);
        await this.setupAudioTrack(chosenAudio.id);
      }

      if (this.subtitleTracks.length > 0) {
        const defSub = this.subtitleTracks.find((s) => s.isDefault) || this.subtitleTracks[0];
        this.host.onSubtitleTracksDiscovered?.(this.subtitleTracks, defSub?.id);
        if (defSub) {
          this.setSubtitleTrack(defSub.id);
        }
      }

      // Start background reading loop
      if (startTime > 0) {
        this.mkvDemuxer.seek(startTime);
      }
      this.startDemuxLoop();
    } catch (e) {
      console.warn('Failed to initialize MKV demuxer:', e);
    }
  }

  private async setupAudioTrack(trackId: string): Promise<void> {
    const trackNum = parseInt(trackId, 10);
    const trackInfo = this.audioTracks.find((t) => t.id === trackId);
    if (!trackInfo || !this.mkvDemuxer) return;

    this.activeAudioTrackId = trackId;
    this.mkvDemuxer.setActiveAudioTrack(trackNum);

    const codec = (trackInfo.codec || '').toUpperCase();
    const isEac3OrAc3 = codec.includes('AC3') || codec.includes('EAC3');

    if (isEac3OrAc3) {
      // Chrome cannot decode E-AC-3/AC-3 natively; use software Web Audio player
      if (!this.eac3Player) {
        const { Eac3AudioPlayer } = await import('./eac3-player.js');
        this.eac3Player = new Eac3AudioPlayer(this.video);
        await this.eac3Player.init();
        this.hookEac3PlayerEvents();
      } else {
        this.eac3Player.clearQueue();
      }

      this.mkvDemuxer.onAudioFrame((chunk) => {
        this.eac3Player?.pushAudioFrame(chunk.timeSec, chunk.data);
      });
    } else {
      // Standard codec (e.g. AAC, Opus) that Chrome plays natively
      if (this.eac3Player) {
        this.eac3Player.destroy();
        this.eac3Player = null;
      }
    }
  }

  private hookEac3PlayerEvents(): void {
    if (!this.eac3Player) return;

    const onPlay = () => this.eac3Player?.onPlay();
    const onPause = () => this.eac3Player?.onPause();
    const onSeeking = () => {
      if (!this.eac3Player || !this.mkvDemuxer) return;
      this.eac3Player.onSeek();
      this.mkvDemuxer.seek(this.video.currentTime);
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
    while (!this.isDestroyed && !this.abortCtrl.signal.aborted) {
      if (this.video.paused && !this.video.seeking && prebufferCount >= 6) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      const hasMore = await this.mkvDemuxer.readNextChunk(512 * 1024);
      prebufferCount++;
      if (!hasMore) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    this.isDemuxingLoopRunning = false;
  }

  getAudioTracks(): AudioTrackInfo[] {
    return this.audioTracks;
  }

  async setAudioTrack(trackId: string): Promise<void> {
    await this.setupAudioTrack(trackId);
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
      if (this.subtitleTextTrack) {
        this.subtitleTextTrack.mode = 'disabled';
      }
      return;
    }

    const match = trackId.match(/^mkv-sub-(\d+)$/);
    if (!match) return;
    const trackNum = parseInt(match[1], 10);
    this.subtitleCues = [];
    this.mkvDemuxer.setActiveSubtitleTrack(trackNum);

    if (!this.subtitleTextTrack) {
      this.subtitleTextTrack = this.video.addTextTrack('subtitles', 'Embedded Subtitles', 'en');
    }
    this.subtitleTextTrack.mode = 'showing';

    this.mkvDemuxer.onSubtitleCue((cue) => {
      if (this.activeSubtitleTrackId !== trackId) return;
      const start = cue.timeSec;
      const end = cue.timeSec + (cue.durationSec || 3.0);
      this.subtitleCues.push({ start, end, text: cue.text });
      if (this.subtitleTextTrack) {
        try {
          const vttCue = new VTTCue(start, end, cue.text);
          this.subtitleTextTrack.addCue(vttCue);
        } catch {}
      }
    });
  }

  destroy(): void {
    this.isDestroyed = true;
    this.abortCtrl.abort();
    this.host.onSubtitleText?.(null);
    this.subtitleCues = [];
    if (this.eac3Player) {
      this.eac3Player.destroy();
      this.eac3Player = null;
    }
    if (this.mkvDemuxer) {
      this.mkvDemuxer.destroy();
      this.mkvDemuxer = null;
    }
    if (this.subtitleTextTrack) {
      this.subtitleTextTrack.mode = 'disabled';
      this.subtitleTextTrack = null;
    }
    this.video.removeAttribute('src');
    this.video.load();
  }
}
