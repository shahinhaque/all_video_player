import { PlaybackEngine, RangeByteSource, EngineHost } from '../core/types.js';
import { PlayerError } from '../core/errors.js';

export class NativeEngine implements PlaybackEngine {
  readonly kind = 'native';
  private video: HTMLVideoElement;
  private src: RangeByteSource;
  private host: EngineHost;
  private abortCtrl: AbortController = new AbortController();

  constructor(video: HTMLVideoElement, src: RangeByteSource, host: EngineHost) {
    this.video = video;
    this.src = src;
    this.host = host;
  }

  async attach(startTime: number = 0): Promise<void> {
    if (this.src.directUrl) {
      this.video.src = this.src.directUrl;
    } else {
      // If encrypted and not direct (e.g. MEGA MP4), generate a blob URL or stream proxy URL
      throw new PlayerError(
        'unsupported',
        'Direct streaming requires TS transmuxer or a direct URL source.'
      );
    }

    this.video.addEventListener('error', () => {
      const err = this.video.error;
      if (!err) return;
      const name = this.src.name?.toLowerCase() || '';
      const isMkv = name.endsWith('.mkv') || this.src.mime?.includes('matroska');
      if (err.code === 4 && isMkv) {
        this.host.fail(
          new PlayerError(
            'codec',
            'Chromium does not support native Matroska (.mkv) container decoding. Open in Firefox (native MKV support) or stream MP4/TS.'
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
  }

  destroy(): void {
    this.abortCtrl.abort();
    this.video.removeAttribute('src');
    this.video.load();
  }
}
