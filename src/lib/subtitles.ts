import { MediaItem, SubtitleTrackInfo } from '../core/types.js';

/**
 * Subtitles helper: converts SRT format to WebVTT format and creates object URLs for <track>.
 */

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export function parseTimestampToSeconds(ts: string): number {
  const clean = ts.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    const h = parseFloat(parts[0]) || 0;
    const m = parseFloat(parts[1]) || 0;
    const s = parseFloat(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const m = parseFloat(parts[0]) || 0;
    const s = parseFloat(parts[1]) || 0;
    return m * 60 + s;
  }
  return parseFloat(clean) || 0;
}

export function srtToVtt(srtContent: string): string {
  // Normalize line endings and strip UTF-8 BOM
  let text = srtContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  // Replace comma decimal separators in timestamps with period: 00:01:20,500 --> 00:01:20.500
  text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

  return `WEBVTT\n\n${text}\n`;
}

/**
 * Converts an ASS/SSA timestamp (e.g. "0:01:20.50") to WebVTT timestamp ("00:01:20.500").
 */
export function formatAssTimestamp(ts: string): string {
  const parts = ts.trim().split(':');
  if (parts.length < 2) return ts;
  let hours = '00';
  let minutes = '00';
  let seconds = '00';
  let millis = '000';

  if (parts.length === 3) {
    hours = parts[0].padStart(2, '0');
    minutes = parts[1].padStart(2, '0');
    const secParts = parts[2].split('.');
    seconds = secParts[0].padStart(2, '0');
    millis = (secParts[1] || '0').padEnd(3, '0').slice(0, 3);
  } else if (parts.length === 2) {
    minutes = parts[0].padStart(2, '0');
    const secParts = parts[1].split('.');
    seconds = secParts[0].padStart(2, '0');
    millis = (secParts[1] || '0').padEnd(3, '0').slice(0, 3);
  }

  return `${hours}:${minutes}:${seconds}.${millis}`;
}

/**
 * Converts Advanced SubStation Alpha (.ass / .ssa) subtitle text to valid WebVTT format.
 */
export function assToVtt(assContent: string): string {
  const lines = assContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const cues: string[] = [];

  let inEvents = false;
  let startIndex = 1;
  let endIndex = 2;
  let textIndex = 9;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inEvents = trimmed.toLowerCase() === '[events]';
      continue;
    }

    if (!inEvents) continue;

    if (trimmed.startsWith('Format:')) {
      const formatHeaders = trimmed.substring(7).split(',').map((h) => h.trim().toLowerCase());
      startIndex = formatHeaders.indexOf('start');
      endIndex = formatHeaders.indexOf('end');
      textIndex = formatHeaders.indexOf('text');
      if (startIndex === -1) startIndex = 1;
      if (endIndex === -1) endIndex = 2;
      if (textIndex === -1) textIndex = formatHeaders.length - 1;
      continue;
    }

    if (trimmed.startsWith('Dialogue:')) {
      const rest = trimmed.substring(9).trim();
      const parts: string[] = [];
      let cur = 0;
      for (let i = 0; i < textIndex; i++) {
        const nextComma = rest.indexOf(',', cur);
        if (nextComma === -1) break;
        parts.push(rest.substring(cur, nextComma));
        cur = nextComma + 1;
      }
      parts.push(rest.substring(cur));

      if (parts.length > textIndex) {
        const rawStart = parts[startIndex]?.trim() || '';
        const rawEnd = parts[endIndex]?.trim() || '';
        let rawText = parts[textIndex] || '';

        // Strip ASS style override tags: {\...}
        rawText = rawText.replace(/\{[^}]*\}/g, '');
        // Replace ASS line breaks: \N, \n with \n
        rawText = rawText.replace(/\\N/g, '\n').replace(/\\n/g, '\n');
        // Replace non-breaking spaces \h with space
        rawText = rawText.replace(/\\h/g, ' ');

        const cleanText = rawText.trim();
        if (rawStart && rawEnd && cleanText) {
          const vttStart = formatAssTimestamp(rawStart);
          const vttEnd = formatAssTimestamp(rawEnd);
          cues.push(`${vttStart} --> ${vttEnd}\n${cleanText}`);
        }
      }
    }
  }

  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function createSubtitleTrackUrl(subContent: string, formatOrIsSrt: string | boolean = 'srt'): string {
  let vtt = subContent;
  let fmt = typeof formatOrIsSrt === 'string' ? formatOrIsSrt.toLowerCase() : formatOrIsSrt ? 'srt' : 'vtt';

  if (fmt === 'srt') {
    vtt = srtToVtt(subContent);
  } else if (fmt === 'ass' || fmt === 'ssa') {
    vtt = assToVtt(subContent);
  }
  const blob = new Blob([vtt], { type: 'text/vtt' });
  return URL.createObjectURL(blob);
}

/**
 * Parses subtitle text (SRT, WebVTT, ASS/SSA) into an array of timed cues.
 */
export function parseSubtitlesToCues(content: string, format?: string): SubtitleCue[] {
  if (!content) return [];
  const clean = content.replace(/^\uFEFF/, '').trim();
  const lowerFmt = (format || '').toLowerCase();

  const isAss =
    lowerFmt === 'ass' ||
    lowerFmt === 'ssa' ||
    clean.toLowerCase().includes('[events]') ||
    clean.toLowerCase().includes('[script info]');

  if (isAss) {
    return parseAssToCues(clean);
  }

  return parseSrtOrVttToCues(clean);
}

function parseAssToCues(assContent: string): SubtitleCue[] {
  const lines = assContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let startIndex = 1;
  let endIndex = 2;
  let textIndex = 9;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inEvents = trimmed.toLowerCase() === '[events]';
      continue;
    }
    if (!inEvents) continue;

    if (trimmed.startsWith('Format:')) {
      const headers = trimmed.substring(7).split(',').map((h) => h.trim().toLowerCase());
      startIndex = headers.indexOf('start');
      endIndex = headers.indexOf('end');
      textIndex = headers.indexOf('text');
      if (startIndex === -1) startIndex = 1;
      if (endIndex === -1) endIndex = 2;
      if (textIndex === -1) textIndex = headers.length - 1;
      continue;
    }

    if (trimmed.startsWith('Dialogue:')) {
      const rest = trimmed.substring(9).trim();
      const parts: string[] = [];
      let cur = 0;
      for (let i = 0; i < textIndex; i++) {
        const nextComma = rest.indexOf(',', cur);
        if (nextComma === -1) break;
        parts.push(rest.substring(cur, nextComma));
        cur = nextComma + 1;
      }
      parts.push(rest.substring(cur));

      if (parts.length > textIndex) {
        const rawStart = parts[startIndex]?.trim() || '';
        const rawEnd = parts[endIndex]?.trim() || '';
        let rawText = parts[textIndex] || '';

        rawText = rawText.replace(/\{[^}]*\}/g, '');
        rawText = rawText.replace(/\\N/g, '\n').replace(/\\n/g, '\n');
        rawText = rawText.replace(/\\h/g, ' ');

        const cleanText = rawText.trim();
        if (rawStart && rawEnd && cleanText) {
          const start = parseTimestampToSeconds(rawStart);
          const end = parseTimestampToSeconds(rawEnd);
          if (end > start) {
            cues.push({ start, end, text: cleanText });
          }
        }
      }
    }
  }

  return cues.sort((a, b) => a.start - b.start);
}

function parseSrtOrVttToCues(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n\s*\n+/);

  const timestampRegex = /(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{2,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{2,3})/;

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let timeLineIdx = -1;
    let match: RegExpMatchArray | null = null;

    for (let i = 0; i < lines.length; i++) {
      match = lines[i].match(timestampRegex);
      if (match) {
        timeLineIdx = i;
        break;
      }
    }

    if (timeLineIdx !== -1 && match) {
      const start = parseTimestampToSeconds(match[1]);
      const end = parseTimestampToSeconds(match[2]);
      const textLines = lines.slice(timeLineIdx + 1);
      const text = textLines
        .join('\n')
        .replace(/<[^>]*>/g, '')
        .trim();

      if (text && end > start) {
        cues.push({ start, end, text });
      }
    }
  }

  return cues.sort((a, b) => a.start - b.start);
}

/**
 * Fast binary search to find the active subtitle cue for a given playback time.
 */
export function findActiveCue(cues: SubtitleCue[], time: number): SubtitleCue | null {
  if (!cues || cues.length === 0) return null;

  let low = 0;
  let high = cues.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const cue = cues[mid];
    if (time >= cue.start && time <= cue.end) {
      return cue;
    }
    if (time < cue.start) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  // Check boundary neighbors in case of slight overlap or float precision
  const candidateIdx = Math.max(0, Math.min(cues.length - 1, low));
  if (cues[candidateIdx] && time >= cues[candidateIdx].start && time <= cues[candidateIdx].end) {
    return cues[candidateIdx];
  }
  if (candidateIdx > 0 && cues[candidateIdx - 1] && time >= cues[candidateIdx - 1].start && time <= cues[candidateIdx - 1].end) {
    return cues[candidateIdx - 1];
  }

  return null;
}

/**
 * Checks if a filename has a subtitle extension (.srt, .vtt, .ass, or .ssa).
 */
export function isSubtitleName(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.srt') || lower.endsWith('.vtt') || lower.endsWith('.ass') || lower.endsWith('.ssa');
}

/**
 * Strips the extension from a filename.
 */
export function getBaseFileName(filename: string): string {
  return filename.replace(/\.[a-zA-Z0-9]+$/, '');
}

const COMMON_LANGUAGES: Record<string, { lang: string; label: string }> = {
  en: { lang: 'en', label: 'English' },
  eng: { lang: 'en', label: 'English' },
  es: { lang: 'es', label: 'Spanish' },
  spa: { lang: 'es', label: 'Spanish' },
  fr: { lang: 'fr', label: 'French' },
  fra: { lang: 'fr', label: 'French' },
  fre: { lang: 'fr', label: 'French' },
  de: { lang: 'de', label: 'German' },
  ger: { lang: 'de', label: 'German' },
  deu: { lang: 'de', label: 'German' },
  it: { lang: 'it', label: 'Italian' },
  ita: { lang: 'it', label: 'Italian' },
  ja: { lang: 'ja', label: 'Japanese' },
  jpn: { lang: 'ja', label: 'Japanese' },
  zh: { lang: 'zh', label: 'Chinese' },
  chi: { lang: 'zh', label: 'Chinese' },
  zho: { lang: 'zh', label: 'Chinese' },
  pt: { lang: 'pt', label: 'Portuguese' },
  por: { lang: 'pt', label: 'Portuguese' },
  ru: { lang: 'ru', label: 'Russian' },
  rus: { lang: 'ru', label: 'Russian' },
  ko: { lang: 'ko', label: 'Korean' },
  kor: { lang: 'ko', label: 'Korean' },
  ar: { lang: 'ar', label: 'Arabic' },
  ara: { lang: 'ar', label: 'Arabic' },
  hi: { lang: 'hi', label: 'Hindi' },
  hin: { lang: 'hi', label: 'Hindi' },
};

/**
 * Parses language code and display label from subtitle filename suffix.
 * e.g. "movie.en.srt" -> { lang: 'en', label: 'English' }
 *      "movie_spa.vtt" -> { lang: 'es', label: 'Spanish' }
 */
export function parseSubtitleLanguage(subName: string, videoBaseName?: string): { lang: string; label: string } {
  const subBase = getBaseFileName(subName);
  let suffix = '';

  if (videoBaseName) {
    const vBase = getBaseFileName(videoBaseName);
    if (subBase.toLowerCase().startsWith(vBase.toLowerCase())) {
      suffix = subBase.slice(vBase.length).replace(/^[._\s-]+/, '').trim().toLowerCase();
    }
  }

  if (!suffix) {
    const lastDot = subBase.lastIndexOf('.');
    if (lastDot !== -1) {
      suffix = subBase.slice(lastDot + 1).toLowerCase();
    }
  }

  // Handle multi-part suffixes like "en.forced" or "eng.cc"
  const primaryTag = suffix.split(/[._\s-]/)[0];
  if (primaryTag && COMMON_LANGUAGES[primaryTag]) {
    const info = COMMON_LANGUAGES[primaryTag];
    const isForced = suffix.includes('forced');
    return {
      lang: info.lang,
      label: isForced ? `${info.label} (Forced)` : info.label,
    };
  }

  if (primaryTag && primaryTag.length >= 2 && primaryTag.length <= 3) {
    return {
      lang: primaryTag,
      label: primaryTag.toUpperCase(),
    };
  }

  return { lang: 'en', label: 'Subtitles' };
}

/**
 * Determines whether a subtitle filename is a companion of the given video filename.
 */
export function isCompanionSubtitle(videoName: string, subName: string): boolean {
  if (!isSubtitleName(subName)) return false;

  const vBase = getBaseFileName(videoName).toLowerCase().trim();
  const sBase = getBaseFileName(subName).toLowerCase().trim();

  if (sBase === vBase) return true;

  if (sBase.startsWith(vBase)) {
    const remainder = sBase.slice(vBase.length);
    // Remainder must start with a delimiter like '.', '_', '-', or ' '
    if (/^[._\s-]/.test(remainder)) {
      const rest = remainder.replace(/^[._\s-]+/, '').trim();
      return /^[a-z0-9._-]+$/i.test(rest);
    }
  }

  return false;
}

/**
 * Pairs subtitle tracks with corresponding video MediaItems based on filename matching.
 */
export function pairSubtitlesWithVideos(videos: MediaItem[], subtitles: SubtitleTrackInfo[]): void {
  for (const video of videos) {
    for (const sub of subtitles) {
      if (isCompanionSubtitle(video.name, sub.name)) {
        if (!video.subtitles) video.subtitles = [];
        if (!video.subtitles.some((s) => s.id === sub.id)) {
          const { lang, label } = parseSubtitleLanguage(sub.name, video.name);
          video.subtitles.push({
            ...sub,
            label: sub.label || label,
            srclang: sub.srclang || lang,
            isDefault: video.subtitles.length === 0,
          });
        }
      }
    }
  }
}
