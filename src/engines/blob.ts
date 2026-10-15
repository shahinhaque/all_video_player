import { PlaybackEngine, RangeByteSource, EngineHost } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { readAll } from '../lib/util.js';

export class BlobEngine implements PlaybackEngine {
  readonly kind = 'native';
  private video: HTMLVideoElement;
  private src: RangeByteSource;
  private host: EngineHost;
  private objectUrl: string = '';
  private abortCtrl: AbortController = new AbortController();

  constructor(video: HTMLVideoElement, src: RangeByteSource, host: EngineHost) {
    this.video = video;
    this.src = src;
    this.host = host;
  }

  async attach(startTime: number = 0): Promise<void> {
    try {
      const fileSize = this.src.size;
      const endByte = fileSize > 0 ? fileSize - 1 : 100 * 1024 * 1024;
      
      const stream = await this.src.read(0, endByte, this.abortCtrl.signal);
      const bytes = await readAll(stream, this.abortCtrl.signal);

      if (this.abortCtrl.signal.aborted) return;

      const blob = new Blob([bytes as any], { type: this.src.mime || 'video/mp4' });
      this.objectUrl = URL.createObjectURL(blob);
      this.video.src = this.objectUrl;

      this.video.addEventListener('error', () => {
        const err = this.video.error;
        if (!err || this.abortCtrl.signal.aborted) return;
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
    } catch (err) {
      if (this.abortCtrl.signal.aborted) return;
      this.host.fail(err);
    }
  }

  destroy(): void {
    this.abortCtrl.abort();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }
    this.video.removeAttribute('src');
    this.video.load();
  }
}
