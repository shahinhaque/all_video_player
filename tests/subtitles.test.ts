import { describe, it, expect } from 'vitest';
import { srtToVtt } from '../src/lib/subtitles.js';

describe('Subtitle Conversion', () => {
  it('converts SRT format timestamps and content to valid WebVTT', () => {
    const srt = `1
00:00:01,200 --> 00:00:04,500
Hello World!

2
00:00:05,100 --> 00:00:08,900
CloudPlay Video Stream
`;

    const vtt = srtToVtt(srt);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.200 --> 00:00:04.500');
    expect(vtt).toContain('00:00:05.100 --> 00:00:08.900');
    expect(vtt).toContain('Hello World!');
    expect(vtt).toContain('CloudPlay Video Stream');
  });
});
