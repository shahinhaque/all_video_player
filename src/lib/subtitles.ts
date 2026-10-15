import { MediaItem, SubtitleTrackInfo } from '../core/types.js';

/**
 * Subtitles helper: converts SRT format to WebVTT format and creates object URLs for <track>.
 */

export function srtToVtt(srtContent: string): string {
  // Normalize line endings
  let text = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  // Replace comma decimal separators in timestamps with period: 00:01:20,500 --> 00:01:20.500
  text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

  return `WEBVTT\n\n${text}\n`;
}

export function createSubtitleTrackUrl(subContent: string, isSrt: boolean = true): string {
  const vtt = isSrt ? srtToVtt(subContent) : subContent;
  const blob = new Blob([vtt], { type: 'text/vtt' });
  return URL.createObjectURL(blob);
}

/**
 * Checks if a filename has a subtitle extension (.srt or .vtt).
 */
export function isSubtitleName(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.srt') || lower.endsWith('.vtt');
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
