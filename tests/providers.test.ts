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

    const folderSubFileUrl = new URL('https://mega.nz/folder/folderId123#folderKeyABC/file/subFile456');
    expect(mega.canHandle(folderSubFileUrl)).toBe(true);
    expect(mega.parseUrl(folderSubFileUrl)).toEqual({
      id: 'folderId123',
      key: 'folderKeyABC',
      isFolder: true,
      subFileId: 'subFile456',
    });

    const dirtyKeyUrl = new URL('https://mega.nz/file/xyz123#cleanKey999?param=1&foo=bar');
    expect(mega.parseUrl(dirtyKeyUrl)).toEqual({
      id: 'xyz123',
      key: 'cleanKey999',
      isFolder: false,
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

  it('parses HTTP/SFTP directory index HTML and extracts video files and subtitles', async () => {
    const { parseDirectoryIndex } = await import('../src/providers/direct.js');
    const html = `<!DOCTYPE html>
<html>
<head><title>Index of /media/videos/</title></head>
<body>
<h1>Index of /media/videos/</h1>
<hr><pre><a href="../">../</a>
<a href="Episode%2001.mp4">Episode 01.mp4</a>    15-Oct-2026 12:00  524288000
<a href="Episode%2001.en.srt">Episode 01.en.srt</a> 15-Oct-2026 12:01  1024
<a href="Episode%2002.mkv">Episode 02.mkv</a>    15-Oct-2026 12:02  624288000
<a href="Episode%2003.ts">Episode 03.ts</a>     15-Oct-2026 12:03  724288000
<a href="notes.txt">notes.txt</a>          15-Oct-2026 12:04  512
</pre><hr></body>
</html>`;

    const { videos, subtitles } = parseDirectoryIndex(html, 'https://my-nas.local/media/videos/');
    expect(videos).toHaveLength(3);
    expect(videos[0].name).toBe('Episode 01.mp4');
    expect(videos[0].id).toBe('https://my-nas.local/media/videos/Episode%2001.mp4');
    expect(videos[1].name).toBe('Episode 02.mkv');
    expect(videos[2].name).toBe('Episode 03.ts');

    // Subtitle should be paired with Episode 01.mp4 and parsed
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0].name).toBe('Episode 01.en.srt');
    expect(videos[0].subtitles).toHaveLength(1);
    expect(videos[0].subtitles?.[0].name).toBe('Episode 01.en.srt');
  });
});

