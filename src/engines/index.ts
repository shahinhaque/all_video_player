import { PlaybackEngine, RangeByteSource, EngineHost } from '../core/types.js';
import { sniffMedia } from './sniff.js';
import { NativeEngine } from './native.js';

export async function createPlaybackEngine(
  video: HTMLVideoElement,
  src: RangeByteSource,
  host: EngineHost
): Promise<{ engine: PlaybackEngine; container: string }> {
  const sniff = await sniffMedia(src);

  // If container is MPEG-TS (whether encrypted on MEGA or direct HTTP byte ranges), use TsEngine
  if (sniff.container === 'ts') {
    const { TsEngine } = await import('./ts.js');
    return {
      engine: new TsEngine(video, src, host),
      container: 'TS',
    };
  }

  // Direct container (MP4, WebM, MKV, etc.) with direct HTTP URL
  if (src.directUrl) {
    return {
      engine: new NativeEngine(video, src, host),
      container: sniff.container.toUpperCase(),
    };
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
