import { PlaybackEngine, RangeByteSource, EngineHost } from '../core/types.js';
import { sniffMedia } from './sniff.js';
import { NativeEngine } from './native.js';

export async function createPlaybackEngine(
  video: HTMLVideoElement,
  src: RangeByteSource,
  host: EngineHost
): Promise<{ engine: PlaybackEngine; container: string }> {
  const sniff = await sniffMedia(src);

  // If container is TS or if the file is encrypted (MEGA needs transmuxing or proxying), use TsEngine
  if (sniff.container === 'ts' || (src.encrypted && sniff.container !== 'webm')) {
    // Lazy load TsEngine to keep initial bundle tiny
    const { TsEngine } = await import('./ts.js');
    return {
      engine: new TsEngine(video, src, host),
      container: 'TS',
    };
  }

  // Direct container (MP4, WebM, etc.) with direct URL
  if (src.directUrl) {
    return {
      engine: new NativeEngine(video, src, host),
      container: sniff.container.toUpperCase(),
    };
  }

  // Fallback for encrypted MP4 on MEGA: use TS/fMP4 transmuxer
  const { TsEngine } = await import('./ts.js');
  return {
    engine: new TsEngine(video, src, host),
    container: 'STREAM',
  };
}
