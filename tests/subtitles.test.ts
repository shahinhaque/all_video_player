import { describe, it, expect } from 'vitest';
import {
  srtToVtt,
  assToVtt,
  formatAssTimestamp,
  isSubtitleName,
  isCompanionSubtitle,
  parseSubtitleLanguage,
  pairSubtitlesWithVideos,
} from '../src/lib/subtitles.js';
import { MediaItem, SubtitleTrackInfo } from '../src/core/types.js';

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

  it('formats ASS timestamps to WebVTT timestamp format', () => {
    expect(formatAssTimestamp('0:01:20.50')).toBe('00:01:20.500');
    expect(formatAssTimestamp('1:23:45.67')).toBe('01:23:45.670');
    expect(formatAssTimestamp('00:05.12')).toBe('00:00:05.120');
  });

  it('converts ASS / SSA format content to valid WebVTT, stripping style tags', () => {
    const ass = `[Script Info]
Title: Sample ASS
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour
Style: Default,Arial,20,&H00FFFFFF,&H000000FF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:03.50,Default,,0,0,0,,{\\b1}Welcome{\\b0} to {\\i1}CloudPlay{\\i0}!
Dialogue: 0,0:00:05.00,0:00:08.75,Default,,0,0,0,,Line 1\\NLine 2 with comma, and more!
`;

    const vtt = assToVtt(ass);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.200 --> 00:00:03.500');
    expect(vtt).toContain('Welcome to CloudPlay!');
    expect(vtt).not.toContain('{\\b1}');
    expect(vtt).toContain('00:00:05.000 --> 00:00:08.750');
    expect(vtt).toContain('Line 1\nLine 2 with comma, and more!');
  });
});

describe('Companion Subtitle Detection & Matching', () => {
  it('identifies subtitle extensions correctly', () => {
    expect(isSubtitleName('movie.srt')).toBe(true);
    expect(isSubtitleName('movie.vtt')).toBe(true);
    expect(isSubtitleName('movie.ass')).toBe(true);
    expect(isSubtitleName('movie.ssa')).toBe(true);
    expect(isSubtitleName('movie.ASS')).toBe(true);
    expect(isSubtitleName('movie.SRT')).toBe(true);
    expect(isSubtitleName('movie.mp4')).toBe(false);
    expect(isSubtitleName('movie.mkv')).toBe(false);
  });

  it('matches exact name subtitles and language-tagged subtitles', () => {
    // Exact match
    expect(isCompanionSubtitle('Interstellar.2014.mp4', 'Interstellar.2014.srt')).toBe(true);
    expect(isCompanionSubtitle('Interstellar.2014.mkv', 'interstellar.2014.vtt')).toBe(true);

    // Language tagged suffixes
    expect(isCompanionSubtitle('Interstellar.2014.mp4', 'Interstellar.2014.en.srt')).toBe(true);
    expect(isCompanionSubtitle('Interstellar.2014.mp4', 'Interstellar.2014_es.vtt')).toBe(true);
    expect(isCompanionSubtitle('Interstellar.2014.mp4', 'Interstellar.2014-fr.srt')).toBe(true);
    expect(isCompanionSubtitle('Interstellar.2014.mp4', 'Interstellar.2014.eng.forced.srt')).toBe(true);

    // Non matching videos
    expect(isCompanionSubtitle('Interstellar.2014.mp4', 'Inception.2010.srt')).toBe(false);
    expect(isCompanionSubtitle('Episode 1.mp4', 'Episode 10.srt')).toBe(false);
    expect(isCompanionSubtitle('Episode 01.mkv', 'Episode 02.srt')).toBe(false);
  });

  it('parses subtitle language tags and descriptions', () => {
    expect(parseSubtitleLanguage('movie.en.srt', 'movie.mp4')).toEqual({
      lang: 'en',
      label: 'English',
    });
    expect(parseSubtitleLanguage('movie.spa.vtt', 'movie.mp4')).toEqual({
      lang: 'es',
      label: 'Spanish',
    });
    expect(parseSubtitleLanguage('movie.ger.forced.srt', 'movie.mp4')).toEqual({
      lang: 'de',
      label: 'German (Forced)',
    });
    expect(parseSubtitleLanguage('movie.srt', 'movie.mp4')).toEqual({
      lang: 'en',
      label: 'Subtitles',
    });
  });

  it('pairs subtitle tracks with corresponding videos in folder playlists', () => {
    const videos: MediaItem[] = [
      { id: 'v1', name: 'Episode 01.mp4', size: 100, provider: 'onedrive', ref: {} },
      { id: 'v2', name: 'Episode 02.mp4', size: 200, provider: 'onedrive', ref: {} },
    ];

    const subtitles: SubtitleTrackInfo[] = [
      { id: 's1', name: 'Episode 01.en.srt', label: '', srclang: '', provider: 'onedrive', ref: {} },
      { id: 's2', name: 'Episode 01.es.vtt', label: '', srclang: '', provider: 'onedrive', ref: {} },
      { id: 's3', name: 'Episode 02.srt', label: '', srclang: '', provider: 'onedrive', ref: {} },
      { id: 's4', name: 'Unrelated.srt', label: '', srclang: '', provider: 'onedrive', ref: {} },
    ];

    pairSubtitlesWithVideos(videos, subtitles);

    expect(videos[0].subtitles).toHaveLength(2);
    expect(videos[0].subtitles?.[0].name).toBe('Episode 01.en.srt');
    expect(videos[0].subtitles?.[0].label).toBe('English');
    expect(videos[0].subtitles?.[0].srclang).toBe('en');
    expect(videos[0].subtitles?.[0].isDefault).toBe(true);

    expect(videos[0].subtitles?.[1].name).toBe('Episode 01.es.vtt');
    expect(videos[0].subtitles?.[1].label).toBe('Spanish');
    expect(videos[0].subtitles?.[1].srclang).toBe('es');
    expect(videos[0].subtitles?.[1].isDefault).toBe(false);

    expect(videos[1].subtitles).toHaveLength(1);
    expect(videos[1].subtitles?.[0].name).toBe('Episode 02.srt');
  });
});
