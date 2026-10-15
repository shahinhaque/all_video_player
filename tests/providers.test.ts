import { describe, it, expect } from 'vitest';
import { GDriveProvider } from '../src/providers/gdrive.js';
import { OneDriveProvider } from '../src/providers/onedrive.js';
import { MegaProvider } from '../src/providers/mega.js';

describe('Provider URL Matchers & Parsers', () => {
  const gdrive = new GDriveProvider();
  const onedrive = new OneDriveProvider();
  const mega = new MegaProvider();

  it('correctly identifies and parses Google Drive URLs', () => {
    const fileUrl = new URL('https://drive.google.com/file/d/1a2b3c4d5e6f/view?usp=sharing');
    expect(gdrive.canHandle(fileUrl)).toBe(true);
    expect(gdrive.extractFileId(fileUrl)).toEqual({ id: '1a2b3c4d5e6f', isFolder: false });

    const multiAccountUrl = new URL('https://drive.google.com/file/u/0/d/1a2b3c4d5e6f/view');
    expect(gdrive.canHandle(multiAccountUrl)).toBe(true);
    expect(gdrive.extractFileId(multiAccountUrl)).toEqual({ id: '1a2b3c4d5e6f', isFolder: false });

    const openIdUrl = new URL('https://drive.google.com/open?id=1a2b3c4d5e6f');
    expect(gdrive.canHandle(openIdUrl)).toBe(true);
    expect(gdrive.extractFileId(openIdUrl)).toEqual({ id: '1a2b3c4d5e6f', isFolder: false });

    const folderUrl = new URL('https://drive.google.com/drive/folders/9z8y7x6w5v4u');
    expect(gdrive.canHandle(folderUrl)).toBe(true);
    expect(gdrive.extractFileId(folderUrl)).toEqual({ id: '9z8y7x6w5v4u', isFolder: true });
  });

  it('correctly identifies OneDrive URLs', () => {
    const shortUrl = new URL('https://1drv.ms/v/c/12345/abcde');
    expect(onedrive.canHandle(shortUrl)).toBe(true);

    const liveUrl = new URL('https://onedrive.live.com/?id=root&cid=1234');
    expect(onedrive.canHandle(liveUrl)).toBe(true);
  });

  it('correctly identifies and parses MEGA URLs', () => {
    const fileUrl = new URL('https://mega.nz/file/xyz123#secret_key_here');
    expect(mega.canHandle(fileUrl)).toBe(true);
    expect(mega.parseUrl(fileUrl)).toEqual({
      id: 'xyz123',
      key: 'secret_key_here',
      isFolder: false,
    });

    const folderUrl = new URL('https://mega.nz/folder/folderId123#folderKeyABC');
    expect(mega.canHandle(folderUrl)).toBe(true);
    expect(mega.parseUrl(folderUrl)).toEqual({
      id: 'folderId123',
      key: 'folderKeyABC',
      isFolder: true,
      subFileId: undefined,
    });
  });

  it('correctly identifies and resolves direct video URLs', async () => {
    const { DirectProvider } = await import('../src/providers/direct.js');
    const direct = new DirectProvider();

    const tsUrl = new URL('https://test-streams.mux.dev/test_001/stream.ts');
    expect(direct.canHandle(tsUrl)).toBe(true);

    const mp4Url = new URL('https://cdn.example.com/videos/movie.mp4');
    expect(direct.canHandle(mp4Url)).toBe(true);

    const nonVideoUrl = new URL('https://example.com/document.pdf');
    expect(direct.canHandle(nonVideoUrl)).toBe(false);

    const playlist = await direct.resolve(tsUrl);
    expect(playlist.items.length).toBe(1);
    expect(playlist.items[0].name).toBe('stream.ts');
    expect(playlist.items[0].provider).toBe('http');
  });
});
