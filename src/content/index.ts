// Content Script for CloudPlay: injected on MEGA, Google Drive, and OneDrive
import { ext } from '../lib/browser.js';

interface DetectedVideo {
  id: string;
  name: string;
  url: string;
  format: string;
}

const VIDEO_EXTENSIONS = ['.ts', '.m2ts', '.mts', '.mp4', '.mkv', '.webm', '.mov', '.avi'];

function isCloudVideoPage(): boolean {
  const host = location.hostname.toLowerCase();
  const href = location.href;
  return (
    host.includes('mega.nz') ||
    host.includes('mega.io') ||
    href.includes('drive.google.com') ||
    href.includes('onedrive.live.com') ||
    href.includes('1drv.ms')
  );
}

function getMegaFolderInfo(): { folderId: string; folderKey: string } | null {
  const match = location.href.match(/folder\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)/);
  if (match) {
    return { folderId: match[1], folderKey: match[2] };
  }
  return null;
}

function detectMegaVideosOnPage(): DetectedVideo[] {
  const videos: DetectedVideo[] = [];
  const seenNames = new Set<string>();
  const folderInfo = getMegaFolderInfo();

  // Search DOM elements across MEGA list/grid views
  const selectors = [
    '.transfer-file-row',
    '.grid-url-item',
    '[data-node-id]',
    '.files-grid-view .grid-table-row',
    '.file-block',
    'tr[data-id]',
    '.file-name',
    '.filename',
    '.tranfer-file-name',
  ];

  const elements = document.querySelectorAll(selectors.join(', '));
  elements.forEach((el) => {
    const text = el.textContent || '';
    const extMatch = VIDEO_EXTENSIONS.find((ext) => text.toLowerCase().includes(ext));
    if (extMatch) {
      const nameMatch = text.match(/([^\n\r\t/\\:*?"<>|]+\.(?:ts|m2ts|mts|mp4|mkv|webm|mov|avi))/i);
      const name = nameMatch ? nameMatch[1].trim() : text.trim().slice(0, 50);

      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        const htmlEl = el as HTMLElement;
        const nodeId =
          htmlEl.dataset.nodeId ||
          htmlEl.dataset.id ||
          htmlEl.getAttribute('data-id') ||
          htmlEl.closest('[data-node-id]')?.getAttribute('data-node-id') ||
          '';

        let playUrl = location.href;
        if (folderInfo && nodeId) {
          playUrl = `https://mega.nz/folder/${folderInfo.folderId}#${folderInfo.folderKey}/file/${nodeId}`;
        }

        const format = extMatch.replace('.', '').toUpperCase();
        videos.push({ id: nodeId, name, url: playUrl, format });
      }
    }
  });

  return videos;
}

// Injects inline "▶ Play" buttons next to video items in MEGA's file browser
function injectMegaInlineButtons(): void {
  if (!location.hostname.includes('mega')) return;
  const folderInfo = getMegaFolderInfo();

  const candidates = document.querySelectorAll(
    '.transfer-file-row, .grid-url-item, .files-grid-view .grid-table-row, [data-node-id]'
  );

  candidates.forEach((row) => {
    if (row.classList.contains('cloudplay-row-injected')) return;
    const text = row.textContent || '';
    const hasVideo = VIDEO_EXTENSIONS.some((ext) => text.toLowerCase().includes(ext));
    if (!hasVideo) return;

    row.classList.add('cloudplay-row-injected');
    const htmlRow = row as HTMLElement;
    const nodeId =
      htmlRow.dataset.nodeId ||
      htmlRow.dataset.id ||
      htmlRow.getAttribute('data-id') ||
      '';

    const playBtn = document.createElement('button');
    playBtn.className = 'cloudplay-inline-btn';
    playBtn.textContent = '▶ Play';
    playBtn.title = 'Play in CloudPlay';
    playBtn.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 600;
      color: #ffffff;
      background: #6366f1;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      z-index: 100;
      transition: background 0.15s ease;
    `;

    playBtn.addEventListener('mouseenter', () => (playBtn.style.background = '#4f46e5'));
    playBtn.addEventListener('mouseleave', () => (playBtn.style.background = '#6366f1'));

    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      let targetUrl = location.href;
      if (folderInfo && nodeId) {
        targetUrl = `https://mega.nz/folder/${folderInfo.folderId}#${folderInfo.folderKey}/file/${nodeId}`;
      }
      ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url: targetUrl });
    });

    const targetContainer =
      row.querySelector('.file-block-title, .filename, .tranfer-file-name, .file-name') ||
      row;
    targetContainer.appendChild(playBtn);
  });
}

// Side drawer listing all videos detected on the MEGA page
function toggleMegaVideoDrawer(videos: DetectedVideo[]): void {
  let drawer = document.getElementById('cloudplay-video-drawer');
  if (drawer) {
    drawer.remove();
    return;
  }

  drawer = document.createElement('div');
  drawer.id = 'cloudplay-video-drawer';
  drawer.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 360px;
    max-width: 90vw;
    background: #111827;
    color: #f3f4f6;
    z-index: 1000000;
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    font-family: system-ui, -apple-system, sans-serif;
    animation: cloudplay-slide-in 0.2s ease-out;
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    align-items: center;
    justify-content: space-between;
  `;
  header.innerHTML = `
    <div>
      <div style="font-weight: 700; font-size: 15px; color: #fff;">CloudPlay • Video List</div>
      <div style="font-size: 12px; color: #9ca3af;">${videos.length} video(s) found on page</div>
    </div>
    <button id="cloudplay-drawer-close" style="background:transparent; border:none; color:#9ca3af; font-size:20px; cursor:pointer;">&times;</button>
  `;

  const playAllBar = document.createElement('div');
  playAllBar.style.cssText = `padding: 12px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.05);`;
  const playAllBtn = document.createElement('button');
  playAllBtn.textContent = '▶ Play All in Full Player';
  playAllBtn.style.cssText = `
    width: 100%;
    padding: 10px;
    background: #6366f1;
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease;
  `;
  playAllBtn.addEventListener('mouseenter', () => (playAllBtn.style.background = '#4f46e5'));
  playAllBtn.addEventListener('mouseleave', () => (playAllBtn.style.background = '#6366f1'));
  playAllBtn.addEventListener('click', () => {
    ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url: location.href });
  });
  playAllBar.appendChild(playAllBtn);

  const listContainer = document.createElement('div');
  listContainer.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  `;

  if (videos.length === 0) {
    listContainer.innerHTML = `
      <div style="text-align: center; padding: 40px 10px; color: #6b7280; font-size: 13px;">
        No video files detected on screen yet.<br>Click "Play All" or scroll the list.
      </div>
    `;
  } else {
    videos.forEach((vid, idx) => {
      const itemEl = document.createElement('div');
      itemEl.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 8px;
        gap: 10px;
      `;

      itemEl.innerHTML = `
        <div style="overflow: hidden; flex: 1;">
          <div style="font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f3f4f6;" title="${vid.name}">
            ${idx + 1}. ${vid.name}
          </div>
          <span style="font-size: 10px; font-weight: 700; color: #06b6d4; text-transform: uppercase;">${vid.format}</span>
        </div>
        <button class="cloudplay-item-play-btn" style="
          padding: 6px 12px;
          background: #374151;
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s ease;
        ">▶ Play</button>
      `;

      const itemBtn = itemEl.querySelector('.cloudplay-item-play-btn') as HTMLElement;
      itemBtn.addEventListener('mouseenter', () => (itemBtn.style.background = '#6366f1'));
      itemBtn.addEventListener('mouseleave', () => (itemBtn.style.background = '#374151'));
      itemBtn.addEventListener('click', () => {
        ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url: vid.url });
      });

      listContainer.appendChild(itemEl);
    });
  }

  drawer.appendChild(header);
  drawer.appendChild(playAllBar);
  drawer.appendChild(listContainer);
  document.body.appendChild(drawer);

  document.getElementById('cloudplay-drawer-close')?.addEventListener('click', () => {
    drawer?.remove();
  });
}

function injectFloatingButton(): void {
  if (!isCloudVideoPage()) return;
  let btn = document.getElementById('cloudplay-floating-btn') as HTMLButtonElement;

  const isMega = location.hostname.includes('mega');
  const videos = isMega ? detectMegaVideosOnPage() : [];
  const label = isMega && videos.length > 0
    ? `▶ Play in CloudPlay (${videos.length} videos)`
    : '▶ Play in CloudPlay';

  if (!btn) {
    btn = document.createElement('button') as HTMLButtonElement;
    btn.id = 'cloudplay-floating-btn';
    btn.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: #6366f1;
      color: #ffffff;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 18px;
      border-radius: 20px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.45);
      display: flex;
      align-items: center;
      gap: 6px;
      transition: transform 0.15s ease, background 0.15s ease;
    `;

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.05)';
      btn.style.background = '#4f46e5';
    });

    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.background = '#6366f1';
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (isMega) {
        const currentVids = detectMegaVideosOnPage();
        toggleMegaVideoDrawer(currentVids);
      } else {
        ext.runtime.sendMessage({
          type: 'OPEN_PLAYER',
          url: location.href,
        });
      }
    });

    document.body.appendChild(btn);
  }

  btn.textContent = label;

  if (isMega) {
    injectMegaInlineButtons();
  }
}

// Observe URL and DOM changes on single-page applications
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
  }
  injectFloatingButton();
});

observer.observe(document.body || document.documentElement, {
  subtree: true,
  childList: true,
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectFloatingButton);
} else {
  injectFloatingButton();
}
