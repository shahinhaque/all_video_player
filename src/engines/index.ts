import { PlaybackEngine, RangeByteSource, EngineHost } from '../core/types.js';
import { sniffMedia } from './sniff.js';
import { NativeEngine } from './native.js';

export interface EngineOptions {
  chunkSize?: number;
}

export async function createPlaybackEngine(
  video: HTMLVideoElement,
  src: RangeByteSource,
  host: EngineHost,
  options?: EngineOptions
): Promise<{ engine: PlaybackEngine; container: string }> {
  const sniff = await sniffMedia(src);

  // If container is MPEG-TS (whether encrypted on MEGA or direct HTTP byte ranges), use TsEngine
  if (sniff.container === 'ts') {
    const { TsEngine } = await import('./ts.js');
    return {
      engine: new TsEngine(video, src, host, options),
      container: 'TS',
    };
  }

  // If container is HLS (.m3u8), use HlsEngine or native if supported
  if (sniff.container === 'hls') {
    const canPlayNativeHls = typeof video.canPlayType === 'function' && !!video.canPlayType('application/vnd.apple.mpegurl');
    if (canPlayNativeHls && src.directUrl) {
      return {
        engine: new NativeEngine(video, src, host),
        container: 'HLS',
      };
    }
    const { HlsEngine } = await import('./hls.js');
    return {
      engine: new HlsEngine(video, src, host, options),
      container: 'HLS',
    };
  }

  // Direct container (MP4, WebM, MKV, etc.) with direct HTTP/Blob URL
  // Chromium natively demuxes MP4, WebM, and Matroska (.mkv) via <video src>,
  // while NativeEngine handles multi-audio (WASM E-AC-3/AC-3 5.1) and embedded MKV subtitles.
  if (src.directUrl) {
    if (sniff.container === 'mkv') {
      src.mime = 'video/x-matroska';
    }
    return {
      engine: new NativeEngine(video, src, host),
      container: sniff.container.toUpperCase(),
    };
  }

  // If container is MKV without a direct URL and without native Matroska support
  if (sniff.container === 'mkv') {
    const canPlayMkv = typeof video.canPlayType === 'function' && !!video.canPlayType('video/x-matroska');
    if (!canPlayMkv) {
      const { MkvEngine } = await import('./mkv.js');
      return {
        engine: new MkvEngine(video, src, host, options),
        container: 'MKV',
      };
    }
  }

  // Encrypted non-TS media (e.g. MP4, WebM, MKV on MEGA)
  if (src.encrypted) {
    const { BlobEngine } = await import('./blob.js');
    return {
      engine: new BlobEngine(video, src, host),
      container: sniff.container.toUpperCase(),
    };
  }

  // Fallback direct engine
  return {
    engine: new NativeEngine(video, src, host),
    container: sniff.container.toUpperCase(),
  };
}
