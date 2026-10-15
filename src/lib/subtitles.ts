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
