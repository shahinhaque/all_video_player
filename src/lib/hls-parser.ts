export interface HlsSegment {
  index: number;
  uri: string;
  duration: number;
  startTime: number;
  title?: string;
  byteRange?: { length: number; offset: number };
}

export interface HlsVariant {
  bandwidth: number;
  uri: string;
  resolution?: string;
  codecs?: string;
}

export interface HlsPlaylist {
  isMaster: boolean;
  version: number;
  targetDuration: number;
  totalDuration: number;
  segments: HlsSegment[];
  variants: HlsVariant[];
  isEndList: boolean;
}

/**
 * Parses an M3U8 playlist text into an HlsPlaylist structure.
 */
export function parseM3u8(content: string, baseUrl?: string): HlsPlaylist {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  if (!lines[0]?.trim().startsWith('#EXTM3U')) {
    throw new Error('Invalid HLS playlist: missing #EXTM3U header');
  }

  const isMaster = lines.some((l) => l.trim().startsWith('#EXT-X-STREAM-INF'));

  const result: HlsPlaylist = {
    isMaster,
    version: 3,
    targetDuration: 10,
    totalDuration: 0,
    segments: [],
    variants: [],
    isEndList: false,
  };

  if (isMaster) {
    let pendingBandwidth = 0;
    let pendingResolution: string | undefined;
    let pendingCodecs: string | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const rest = line.substring(18);
        const bwMatch = /BANDWIDTH=(\d+)/i.exec(rest);
        pendingBandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

        const resMatch = /RESOLUTION=(\d+x\d+)/i.exec(rest);
        pendingResolution = resMatch ? resMatch[1] : undefined;

        const codecsMatch = /CODECS="([^"]+)"/i.exec(rest);
        pendingCodecs = codecsMatch ? codecsMatch[1] : undefined;
      } else if (!line.startsWith('#')) {
        const uri = resolveUri(line, baseUrl);
        result.variants.push({
          bandwidth: pendingBandwidth,
          uri,
          resolution: pendingResolution,
          codecs: pendingCodecs,
        });
        pendingBandwidth = 0;
        pendingResolution = undefined;
        pendingCodecs = undefined;
      }
    }
    return result;
  }

  // Media playlist parsing
  let currentDuration = 0;
  let currentTitle: string | undefined;
  let currentByteRange: { length: number; offset: number } | undefined;
  let lastOffset = 0;
  let runningStartTime = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-VERSION:')) {
      result.version = parseInt(line.substring(15), 10) || 3;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      result.targetDuration = parseFloat(line.substring(22)) || 10;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      result.isEndList = true;
    } else if (line.startsWith('#EXTINF:')) {
      const parts = line.substring(8).split(',');
      currentDuration = parseFloat(parts[0]) || 0;
      currentTitle = parts.slice(1).join(',').trim() || undefined;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const val = line.substring(17).trim();
      const atIdx = val.indexOf('@');
      if (atIdx !== -1) {
        const len = parseInt(val.substring(0, atIdx), 10);
        const off = parseInt(val.substring(atIdx + 1), 10);
        currentByteRange = { length: len, offset: off };
        lastOffset = off + len;
      } else {
        const len = parseInt(val, 10);
        currentByteRange = { length: len, offset: lastOffset };
        lastOffset += len;
      }
    } else if (!line.startsWith('#')) {
      const uri = resolveUri(line, baseUrl);
      result.segments.push({
        index: result.segments.length,
        uri,
        duration: currentDuration,
        startTime: runningStartTime,
        title: currentTitle,
        byteRange: currentByteRange,
      });
      runningStartTime += currentDuration;
      currentDuration = 0;
      currentTitle = undefined;
      currentByteRange = undefined;
    }
  }

  result.totalDuration = runningStartTime;
  return result;
}

/**
 * Resolves a relative segment URI against a baseUrl if applicable.
 */
export function resolveUri(uri: string, baseUrl?: string): string {
  if (!baseUrl || uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('blob:') || uri.startsWith('data:')) {
    return uri;
  }
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}
