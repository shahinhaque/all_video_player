import { describe, it, expect } from 'vitest';
import { parseM3u8, resolveUri } from '../src/lib/hls-parser.js';

describe('HLS M3U8 Parser', () => {
  it('parses standard media playlist with segments and durations', () => {
    const m3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,Intro
segment0.ts
#EXTINF:9.009,Part 1
segment1.ts
#EXTINF:4.500,Outro
segment2.ts
#EXT-X-ENDLIST
`;

    const playlist = parseM3u8(m3u8, 'https://example.com/media/playlist.m3u8');
    expect(playlist.isMaster).toBe(false);
    expect(playlist.version).toBe(3);
    expect(playlist.targetDuration).toBe(10);
    expect(playlist.isEndList).toBe(true);
    expect(playlist.segments).toHaveLength(3);

    expect(playlist.segments[0].index).toBe(0);
    expect(playlist.segments[0].uri).toBe('https://example.com/media/segment0.ts');
    expect(playlist.segments[0].duration).toBeCloseTo(9.009);
    expect(playlist.segments[0].startTime).toBe(0);
    expect(playlist.segments[0].title).toBe('Intro');

    expect(playlist.segments[1].index).toBe(1);
    expect(playlist.segments[1].uri).toBe('https://example.com/media/segment1.ts');
    expect(playlist.segments[1].startTime).toBeCloseTo(9.009);

    expect(playlist.segments[2].index).toBe(2);
    expect(playlist.segments[2].startTime).toBeCloseTo(18.018);

    expect(playlist.totalDuration).toBeCloseTo(22.518);
  });

  it('parses master playlist with variant streams', () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480,CODECS="avc1.4d401f,mp4a.40.2"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
mid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7680000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
high.m3u8
`;

    const playlist = parseM3u8(master, 'https://cdn.example.com/stream/index.m3u8');
    expect(playlist.isMaster).toBe(true);
    expect(playlist.variants).toHaveLength(3);

    expect(playlist.variants[0].bandwidth).toBe(1280000);
    expect(playlist.variants[0].resolution).toBe('720x480');
    expect(playlist.variants[0].uri).toBe('https://cdn.example.com/stream/low.m3u8');

    expect(playlist.variants[2].bandwidth).toBe(7680000);
    expect(playlist.variants[2].resolution).toBe('1920x1080');
    expect(playlist.variants[2].uri).toBe('https://cdn.example.com/stream/high.m3u8');
  });

  it('parses byte range tags in media playlists', () => {
    const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
#EXT-X-BYTERANGE:100000@0
main.ts
#EXTINF:6.0,
#EXT-X-BYTERANGE:100000
main.ts
`;

    const playlist = parseM3u8(m3u8);
    expect(playlist.segments).toHaveLength(2);
    expect(playlist.segments[0].byteRange).toEqual({ length: 100000, offset: 0 });
    expect(playlist.segments[1].byteRange).toEqual({ length: 100000, offset: 100000 });
  });

  it('resolves relative URIs against base URL correctly', () => {
    expect(resolveUri('seg1.ts', 'https://video.org/folder/file.m3u8')).toBe('https://video.org/folder/seg1.ts');
    expect(resolveUri('/root/seg1.ts', 'https://video.org/folder/file.m3u8')).toBe('https://video.org/root/seg1.ts');
    expect(resolveUri('https://other.com/seg1.ts', 'https://video.org/folder/file.m3u8')).toBe('https://other.com/seg1.ts');
  });

  it('throws on invalid header', () => {
    expect(() => parseM3u8('NOT AN M3U8')).toThrow('Invalid HLS playlist: missing #EXTM3U header');
  });
});
