const VIDEO_EXT = new Set([
  'ts', 'm2ts', 'mts', 'mp4', 'm4v', 'mkv', 'webm', 'mov', 'ogv', 'ogg', 'm3u8', 'flv', 'avi', 'wmv', 'mpg', 'mpeg', '3gp',
]);

const MIME: Record<string, string> = {
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  flv: 'video/x-flv',
  avi: 'video/x-msvideo',
};

export function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.has(extOf(name));
}

export function isVideoEntry(name: string, mime?: string): boolean {
  return isVideoName(name) || !!mime?.startsWith('video/');
}

export function guessMime(name: string, fallback = 'application/octet-stream'): string {
  return MIME[extOf(name)] ?? fallback;
}

export function isTsName(name: string): boolean {
  return ['ts', 'm2ts', 'mts'].includes(extOf(name));
}
