import { RangeByteSource } from '../core/types.js';
import { readAll } from '../lib/util.js';
import { isTsName } from '../lib/media.js';

export type ContainerType = 'ts' | 'mp4' | 'mkv' | 'webm' | 'unknown';

export interface SniffResult {
  container: ContainerType;
  mime: string;
}

export async function sniffMedia(src: RangeByteSource): Promise<SniffResult> {
  // If extension is explicitly .ts/.m2ts/.mts, prefer TS
  if (isTsName(src.name)) {
    return { container: 'ts', mime: 'video/mp2t' };
  }

  try {
    // Read the first 1024 bytes to inspect magic headers
    const probeLen = Math.min(1024, src.size > 0 ? src.size - 1 : 1023);
    const stream = await src.read(0, probeLen);
    const bytes = await readAll(stream);

    // 1. MPEG-TS Check: sync byte 0x47 every 188 bytes
    if (bytes.length >= 188 && bytes[0] === 0x47) {
      if (bytes.length >= 376 && bytes[188] === 0x47) {
        return { container: 'ts', mime: 'video/mp2t' };
      }
      return { container: 'ts', mime: 'video/mp2t' };
    }

    // 2. MP4 Check: 'ftyp' box in first 32 bytes
    for (let i = 4; i < Math.min(32, bytes.length - 4); i++) {
      if (
        bytes[i] === 0x66 && // 'f'
        bytes[i + 1] === 0x74 && // 't'
        bytes[i + 2] === 0x79 && // 'y'
        bytes[i + 3] === 0x70 // 'p'
      ) {
        return { container: 'mp4', mime: 'video/mp4' };
      }
    }

    // 3. Matroska / WebM EBML header: 0x1A 0x45 0xDF 0xA3
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    ) {
      // Check for 'webm' doc type in header
      const str = new TextDecoder('latin1').decode(bytes.subarray(0, 100));
      if (str.includes('webm')) {
        return { container: 'webm', mime: 'video/webm' };
      }
      return { container: 'mkv', mime: 'video/x-matroska' };
    }
  } catch (err) {
    console.warn('Media sniffing probe failed:', err);
  }

  // Fallback to name or mime
  if (src.mime?.includes('mp4')) return { container: 'mp4', mime: 'video/mp4' };
  if (src.mime?.includes('webm')) return { container: 'webm', mime: 'video/webm' };
  return { container: 'mp4', mime: src.mime || 'video/mp4' };
}
