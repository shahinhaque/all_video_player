import { SourceProvider, Playlist } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { GDriveProvider } from './gdrive.js';
import { OneDriveProvider } from './onedrive.js';
import { MegaProvider } from './mega.js';
import { LocalProvider } from './local.js';
import { DirectProvider } from './direct.js';
import { YouTubeProvider } from './youtube.js';

export const PROVIDERS: SourceProvider[] = [
  new MegaProvider(),
  new GDriveProvider(),
  new OneDriveProvider(),
  new YouTubeProvider(),
  new LocalProvider(),
  new DirectProvider(),
];

export function findProvider(url: URL): SourceProvider | undefined {
  return PROVIDERS.find((p) => p.canHandle(url));
}

export async function resolveUrl(inputUrl: string): Promise<Playlist> {
  let url: URL;
  try {
    url = new URL(inputUrl.trim());
  } catch {
    throw new PlayerError('unsupported', 'Invalid URL provided.');
  }

  const provider = findProvider(url);
  if (!provider) {
    throw new PlayerError(
      'unsupported',
      'Unsupported link provider. CloudPlay currently supports MEGA, Google Drive, and OneDrive.'
    );
  }

  return provider.resolve(url);
}
