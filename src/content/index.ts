// Content Script for CloudPlay: injected on MEGA, Google Drive, and OneDrive
import { ext } from '../lib/browser.js';

interface DetectedVideo {
  id: string;
  name: string;
  url: string;
  format: string;
}

const VIDEO_EXTENSIONS = ['.ts', '.m2ts', '.mts', '.mp4', '.mkv', '.webm', '.mov', '.avi'];

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
  const isMega = location.hostname.includes('mega');
  const isGDrive = location.hostname.includes('drive.google.com');
  const isYouTube = location.hostname.includes('youtube.com');

  if (!isMega && !isGDrive && !isYouTube) return;
  if (isYouTube && !location.pathname.startsWith('/watch') && !location.pathname.startsWith('/shorts/')) {
    const existing = document.getElementById('cloudplay-floating-btn');
    if (existing) existing.remove();
    return;
  }

  let btn = document.getElementById('cloudplay-floating-btn') as HTMLButtonElement;
  const videos = isMega ? detectMegaVideosOnPage() : [];
  let label = '▶ Play in CloudPlay';
  if (isMega && videos.length > 0) {
    label = `▶ Play in CloudPlay (${videos.length} videos)`;
  } else if (isYouTube) {
    label = '▶ Open in CloudPlay';
  }

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

  if (btn.textContent !== label) {
    btn.textContent = label;
  }

  if (isMega) {
    injectMegaInlineButtons();
  }
}

// Initialize helper buttons across supported media platforms
if (
  location.hostname.includes('mega') ||
  location.hostname.includes('drive.google.com') ||
  location.hostname.includes('youtube.com')
) {
  window.addEventListener('popstate', () => setTimeout(injectFloatingButton, 500));
  window.addEventListener('hashchange', () => setTimeout(injectFloatingButton, 500));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(injectFloatingButton, 500));
  } else {
    setTimeout(injectFloatingButton, 500);
  }
}

// --- Ultra-Fast Event-Driven Context Menu Hook (Zero polling, Zero DOM observers) ---
let lastContextTarget: HTMLElement | null = null;
let lastTargetUrl: string | null = null;
let lastContextPos = { x: 0, y: 0 };

function resolveTargetUrl(el: HTMLElement | null): string {
  if (!el) return location.href;

  // 1. MEGA
  if (location.hostname.includes('mega')) {
    const row = el.closest('[data-node-id], .transfer-file-row, .grid-url-item, .files-grid-view .grid-table-row') as HTMLElement;
    const nodeId = row?.dataset.nodeId || row?.dataset.id || row?.getAttribute('data-id') || row?.getAttribute('data-node-id');
    const folderInfo = getMegaFolderInfo();
    if (folderInfo && nodeId) {
      return `https://mega.nz/folder/${folderInfo.folderId}#${folderInfo.folderKey}/file/${nodeId}`;
    }
  }

  // 2. Google Drive
  if (location.hostname.includes('drive.google.com')) {
    const item = el.closest('[data-id], [data-target="doc"], [data-target="file"], [role="row"], [role="gridcell"]') as HTMLElement;
    const fileId = item?.dataset.id || item?.getAttribute('data-id');
    if (fileId) {
      return `https://drive.google.com/file/d/${fileId}/view`;
    }
  }

  // 3. YouTube
  if (location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be')) {
    const videoLink = el.closest('a[href*="/watch"], a[href*="/shorts/"], a#thumbnail') as HTMLAnchorElement;
    if (videoLink?.href) {
      return videoLink.href;
    }
    if (location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts/')) {
      return location.href;
    }
  }

  // 4. OneDrive / SharePoint
  if (location.hostname.includes('live.com') || location.hostname.includes('sharepoint.com') || location.hostname.includes('1drv.ms')) {
    const link = el.closest('a[href]') as HTMLAnchorElement;
    if (link?.href && (link.href.includes('id=') || link.href.includes(':v:') || link.href.includes('onedrive'))) {
      return link.href;
    }
  }

  // Check any enclosing anchor tag
  const anchor = el.closest('a[href]') as HTMLAnchorElement;
  if (anchor?.href) return anchor.href;

  return location.href;
}

document.addEventListener('contextmenu', (e) => {
  lastContextTarget = e.target as HTMLElement;
  lastContextPos = { x: e.clientX, y: e.clientY };
  lastTargetUrl = resolveTargetUrl(lastContextTarget);
  if (lastTargetUrl) {
    try {
      ext.runtime.sendMessage({ type: 'SET_CONTEXT_URL', url: lastTargetUrl });
    } catch {}
  }
  setTimeout(injectInPageContextMenu, 50);
  setTimeout(injectInPageContextMenu, 200);
});

function removeGoogleDrivePill(): void {
  document.getElementById('cloudplay-gdrive-pill')?.remove();
}

function showGoogleDrivePill(x: number, y: number, targetUrl: string): void {
  removeGoogleDrivePill();
  const pill = document.createElement('div');
  pill.id = 'cloudplay-gdrive-pill';
  pill.style.cssText = `
    position: fixed;
    top: ${Math.max(12, Math.min(window.innerHeight - 50, y - 48))}px;
    left: ${Math.max(12, Math.min(window.innerWidth - 210, x + 8))}px;
    z-index: 2147483647;
    background: #6366f1;
    color: #ffffff;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    user-select: none;
    transition: transform 0.15s ease, background 0.15s ease;
  `;
  pill.innerHTML = `<span style="font-size: 13px;">▶</span> Play in CloudPlay`;
  pill.addEventListener('mouseenter', () => { pill.style.background = '#4f46e5'; });
  pill.addEventListener('mouseleave', () => { pill.style.background = '#6366f1'; });
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    removeGoogleDrivePill();
    ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url: targetUrl });
  });

  document.body.appendChild(pill);

  const dismiss = () => {
    removeGoogleDrivePill();
    document.removeEventListener('click', dismiss);
  };
  setTimeout(() => document.addEventListener('click', dismiss), 150);
}

function injectInPageContextMenu(): void {
  // 1. Google Drive custom context action:
  // We NEVER inject into Google Drive's Closure div[role="menu"] because modifying Closure's component
  // hierarchy causes unhandled TypeErrors that freeze Drive's right-click menu and browsing.
  if (location.hostname.includes('drive.google.com')) {
    const isFileTarget = lastTargetUrl && lastTargetUrl.includes('/file/d/');
    if (isFileTarget) {
      showGoogleDrivePill(lastContextPos.x, lastContextPos.y, lastTargetUrl!);
    }
  }

  // 2. YouTube custom HTML5 video player context menu
  if (location.hostname.includes('youtube.com')) {
    const ytMenu = document.querySelector('.ytp-popup.ytp-contextmenu .ytp-panel-menu');
    if (ytMenu && !ytMenu.querySelector('.cloudplay-yt-menuitem')) {
      const item = document.createElement('div');
      item.className = 'ytp-menuitem cloudplay-yt-menuitem';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '0');
      item.style.cssText = `
        display: flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
        color: #eee;
        padding: 0 15px;
        height: 40px;
        font-size: 12px;
        user-select: none;
      `;
      item.innerHTML = `<span style="color:#6366f1; font-size:14px; font-weight:bold;">▶</span> <span class="ytp-menuitem-label">Play in CloudPlay</span>`;
      item.addEventListener('mouseenter', () => { item.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'; });
      item.addEventListener('mouseleave', () => { item.style.backgroundColor = 'transparent'; });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const popup = document.querySelector('.ytp-popup.ytp-contextmenu') as HTMLElement;
        if (popup) popup.style.display = 'none';
        const url = lastTargetUrl || location.href;
        ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url });
      });
      ytMenu.prepend(item);
    }
  }

  // 3. MEGA custom context menu
  const megaMenu = document.querySelector('.dropdown-content, .body-dropdown, .context-menu');
  if (megaMenu && !megaMenu.querySelector('.cloudplay-context-item')) {
    const item = document.createElement('a');
    item.className = 'dropdown-item cloudplay-context-item';
    item.href = 'javascript:void(0);';
    item.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      color: #fff;
    `;
    item.innerHTML = `<span style="color:#6366f1; font-weight:bold;">▶</span> <span>Play in CloudPlay</span>`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const url = lastTargetUrl || location.href;
      ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url });
    });
    megaMenu.prepend(item);
  }

  // 4. OneDrive custom context menu
  const oneDriveMenu = document.querySelector('.ms-ContextualMenu');
  if (oneDriveMenu && !oneDriveMenu.querySelector('.cloudplay-context-item')) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ms-ContextualMenu-link cloudplay-context-item';
    item.setAttribute('role', 'menuitem');
    item.style.cssText = `
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      background: transparent;
      border: none;
      text-align: left;
    `;
    item.innerHTML = `<span style="color:#6366f1; font-weight:bold;">▶</span> <span>Play in CloudPlay</span>`;
    item.addEventListener('mouseenter', () => { item.style.background = 'rgba(0,0,0,0.05)'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const url = lastTargetUrl || location.href;
      ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url });
    });
    oneDriveMenu.prepend(item);
  }
}


