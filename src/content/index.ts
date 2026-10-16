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
      } else if (isGDrive || isYouTube) {
        showInPageModal(location.href);
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
  lastTargetUrl = resolveTargetUrl(lastContextTarget);
  if (lastTargetUrl) {
    try {
      ext.runtime.sendMessage({ type: 'SET_CONTEXT_URL', url: lastTargetUrl });
    } catch {}
  }
  setTimeout(injectInPageContextMenu, 50);
  setTimeout(injectInPageContextMenu, 200);
});

function removeCompanionMenu(): void {
  const existing = document.getElementById('cloudplay-companion-menu');
  if (existing) existing.remove();
}

function injectInPageContextMenu(): void {
  // 1. Google Drive: Show docked companion bar adjacent to Google Drive's native menu
  // NEVER inject inside div[role="menu"] — Closure's internal component tree will crash on foreign nodes.
  if (location.hostname.includes('drive.google.com')) {
    const gdriveMenu = document.querySelector('div[role="menu"]');
    if (gdriveMenu && gdriveMenu instanceof HTMLElement && !document.getElementById('cloudplay-companion-menu')) {
      const rect = gdriveMenu.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const companion = document.createElement('div');
        companion.id = 'cloudplay-companion-menu';

        // Position immediately below the native menu, or above if close to viewport bottom
        const spaceBelow = window.innerHeight - rect.bottom;
        const topPos = spaceBelow > 50 ? rect.bottom + 4 : Math.max(10, rect.top - 46);

        companion.style.cssText = `
          position: fixed;
          top: ${topPos}px;
          left: ${rect.left}px;
          width: ${Math.max(rect.width, 220)}px;
          background: #ffffff;
          border-radius: 8px;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(0, 0, 0, 0.08);
          z-index: 2147483647;
          display: flex;
          align-items: center;
          padding: 10px 16px;
          cursor: pointer;
          font-family: Roboto, Arial, sans-serif;
          font-size: 13px;
          font-weight: 500;
          color: #202124;
          user-select: none;
          box-sizing: border-box;
          transition: background-color 0.12s ease;
        `;
        companion.innerHTML = `<span style="color:#6366f1; font-size:14px; font-weight:bold; margin-right:10px;">▶</span> <span>Play in CloudPlay</span>`;

        companion.addEventListener('mouseenter', () => { companion.style.backgroundColor = '#f1f3f4'; });
        companion.addEventListener('mouseleave', () => { companion.style.backgroundColor = '#ffffff'; });
        companion.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          removeCompanionMenu();
          const url = lastTargetUrl || location.href;
          showInPageModal(url);
        });

        document.body.appendChild(companion);

        const dismissListener = (e: MouseEvent) => {
          if (!companion.contains(e.target as Node)) {
            removeCompanionMenu();
            document.removeEventListener('mousedown', dismissListener, true);
          }
        };
        setTimeout(() => document.addEventListener('mousedown', dismissListener, true), 80);

        const checkInterval = setInterval(() => {
          if (!document.body.contains(gdriveMenu) || gdriveMenu.offsetParent === null) {
            removeCompanionMenu();
            clearInterval(checkInterval);
          }
        }, 150);
      }
    }
    return;
  }

  // 2. YouTube: Docked above YouTube's HTML5 player context menu popup
  if (location.hostname.includes('youtube.com')) {
    const ytPopup = document.querySelector('.ytp-popup.ytp-contextmenu');
    if (ytPopup && ytPopup instanceof HTMLElement && !document.getElementById('cloudplay-companion-menu')) {
      const rect = ytPopup.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const companion = document.createElement('div');
        companion.id = 'cloudplay-companion-menu';
        const topPos = Math.max(10, rect.top - 42);
        companion.style.cssText = `
          position: fixed;
          top: ${topPos}px;
          left: ${rect.left}px;
          min-width: ${rect.width}px;
          background: rgba(28, 28, 28, 0.95);
          backdrop-filter: blur(8px);
          border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
          z-index: 2147483647;
          display: flex;
          align-items: center;
          padding: 8px 14px;
          cursor: pointer;
          font-family: Roboto, Arial, sans-serif;
          font-size: 12px;
          font-weight: 500;
          color: #eeeeee;
          user-select: none;
          box-sizing: border-box;
          transition: background-color 0.12s ease;
        `;
        companion.innerHTML = `<span style="color:#6366f1; font-size:13px; font-weight:bold; margin-right:8px;">▶</span> <span>Play in CloudPlay</span>`;
        companion.addEventListener('mouseenter', () => { companion.style.backgroundColor = 'rgba(60, 60, 60, 0.95)'; });
        companion.addEventListener('mouseleave', () => { companion.style.backgroundColor = 'rgba(28, 28, 28, 0.95)'; });
        companion.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          removeCompanionMenu();
          const popup = document.querySelector('.ytp-popup.ytp-contextmenu') as HTMLElement;
          if (popup) popup.style.display = 'none';
          const url = lastTargetUrl || location.href;
          showInPageModal(url);
        });

        document.body.appendChild(companion);

        const dismissListener = (e: MouseEvent) => {
          if (!companion.contains(e.target as Node)) {
            removeCompanionMenu();
            document.removeEventListener('mousedown', dismissListener, true);
          }
        };
        setTimeout(() => document.addEventListener('mousedown', dismissListener, true), 80);

        const checkInterval = setInterval(() => {
          if (!document.body.contains(ytPopup) || ytPopup.offsetParent === null || (ytPopup as HTMLElement).style.display === 'none') {
            removeCompanionMenu();
            clearInterval(checkInterval);
          }
        }, 150);
      }
    }
    return;
  }

  // 3. MEGA: Attached to dropdown menu safely
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
    return;
  }

  // 4. OneDrive / SharePoint: Docked companion bar outside React tree
  if (location.hostname.includes('live.com') || location.hostname.includes('sharepoint.com') || location.hostname.includes('1drv.ms')) {
    const oneDriveMenu = document.querySelector('.ms-ContextualMenu, .ms-ContextualMenu-list');
    if (oneDriveMenu && oneDriveMenu instanceof HTMLElement && !document.getElementById('cloudplay-companion-menu')) {
      const rect = oneDriveMenu.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const companion = document.createElement('div');
        companion.id = 'cloudplay-companion-menu';
        const spaceBelow = window.innerHeight - rect.bottom;
        const topPos = spaceBelow > 50 ? rect.bottom + 4 : Math.max(10, rect.top - 46);
        companion.style.cssText = `
          position: fixed;
          top: ${topPos}px;
          left: ${rect.left}px;
          width: ${Math.max(rect.width, 200)}px;
          background: #ffffff;
          border-radius: 4px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
          z-index: 2147483647;
          display: flex;
          align-items: center;
          padding: 9px 14px;
          cursor: pointer;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          font-weight: 500;
          color: #323130;
          user-select: none;
          box-sizing: border-box;
          transition: background-color 0.12s ease;
        `;
        companion.innerHTML = `<span style="color:#6366f1; font-size:14px; font-weight:bold; margin-right:8px;">▶</span> <span>Play in CloudPlay</span>`;
        companion.addEventListener('mouseenter', () => { companion.style.backgroundColor = '#f3f2f1'; });
        companion.addEventListener('mouseleave', () => { companion.style.backgroundColor = '#ffffff'; });
        companion.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          removeCompanionMenu();
          const url = lastTargetUrl || location.href;
          ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url });
        });

        document.body.appendChild(companion);

        const dismissListener = (e: MouseEvent) => {
          if (!companion.contains(e.target as Node)) {
            removeCompanionMenu();
            document.removeEventListener('mousedown', dismissListener, true);
          }
        };
        setTimeout(() => document.addEventListener('mousedown', dismissListener, true), 80);

        const checkInterval = setInterval(() => {
          if (!document.body.contains(oneDriveMenu) || oneDriveMenu.offsetParent === null) {
            removeCompanionMenu();
            clearInterval(checkInterval);
          }
        }, 150);
      }
    }
  }
}

// --- Seamless Hybrid In-Page Modal (First-Party Cookies & Zero Cross-Origin Redirects) ---
function extractDriveFileId(url: string): string | null {
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function extractYouTubeVideoId(url: string): string | null {
  const match =
    url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/) ||
    url.match(/^[a-zA-Z0-9_-]{11}$/);
  return match ? match[1] : null;
}

function removeInPageModal(): void {
  const existing = document.getElementById('cloudplay-modal-host');
  if (existing) existing.remove();
}

function showInPageModal(targetUrl: string): void {
  removeInPageModal();

  const isGDrive = location.hostname.includes('drive.google.com') || targetUrl.includes('drive.google.com');
  const isYouTube = location.hostname.includes('youtube.com') || targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be');

  let embedUrl = targetUrl;
  let title = 'CloudPlay Player';

  if (isGDrive) {
    const fileId = extractDriveFileId(targetUrl);
    embedUrl = fileId ? `https://drive.google.com/file/d/${fileId}/preview` : targetUrl;
    title = 'Google Drive Stream';
  } else if (isYouTube) {
    const ytId = extractYouTubeVideoId(targetUrl);
    embedUrl = ytId ? `https://www.youtube.com/embed/${ytId}?autoplay=1&enablejsapi=1` : targetUrl;
    const pageTitle = document.title ? document.title.replace(/\s*-\s*YouTube.*$/, '').trim() : '';
    title = pageTitle ? `YouTube • ${pageTitle}` : 'YouTube Video';
  }

  const host = document.createElement('div');
  host.id = 'cloudplay-modal-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .backdrop {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      animation: cpFadeIn 0.18s ease-out forwards;
    }
    @keyframes cpFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .modal {
      width: 880px; max-width: 94vw;
      height: 540px; max-height: 88vh;
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 14px;
      box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(99, 102, 241, 0.3);
      display: flex; flex-direction: column; overflow: hidden;
      animation: cpPopIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      transition: width 0.2s ease, height 0.2s ease;
    }
    @keyframes cpPopIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .modal.theater {
      width: 98vw !important; height: 96vh !important;
      max-width: 98vw !important; max-height: 96vh !important;
      border-radius: 8px; left: auto !important; top: auto !important;
      position: relative !important; margin: auto !important;
    }
    .header {
      height: 44px; background: #1e293b;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 14px; user-select: none; cursor: grab;
    }
    .header:active { cursor: grabbing; }
    .brand-group { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .badge {
      background: #6366f1; color: #fff; font-size: 11px; font-weight: 700;
      padding: 2px 7px; border-radius: 4px; letter-spacing: 0.5px;
    }
    .title {
      color: #f8fafc; font-size: 13px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 480px;
    }
    .actions { display: flex; align-items: center; gap: 6px; }
    .btn {
      background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.08);
      color: #cbd5e1; border-radius: 6px; height: 28px; padding: 0 10px;
      font-size: 12px; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 5px;
      transition: all 0.15s ease;
    }
    .btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; border-color: rgba(255, 255, 255, 0.25); }
    .btn-close:hover { background: #ef4444; color: #fff; border-color: #ef4444; }
    .video-wrap { flex: 1; position: relative; background: #000; width: 100%; height: 100%; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
  `;

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const header = document.createElement('div');
  header.className = 'header';
  header.innerHTML = `
    <div class="brand-group">
      <span class="badge">CloudPlay</span>
      <span class="title" title="${title}">${title}</span>
    </div>
    <div class="actions">
      <button class="btn btn-theater" title="Toggle Theater Mode">⛶ Theater</button>
      <button class="btn btn-popout" title="Open in Full Tab / Standalone Window">↗ Full Tab</button>
      <button class="btn btn-close" title="Close (Esc)">✕</button>
    </div>
  `;

  const videoWrap = document.createElement('div');
  videoWrap.className = 'video-wrap';
  const iframe = document.createElement('iframe');
  iframe.src = embedUrl;
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
  iframe.setAttribute('allowfullscreen', 'true');
  videoWrap.appendChild(iframe);

  modal.appendChild(header);
  modal.appendChild(videoWrap);
  backdrop.appendChild(modal);

  shadow.appendChild(style);
  shadow.appendChild(backdrop);
  document.body.appendChild(host);

  // Dragging support
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    if (modal.classList.contains('theater')) return;

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = modal.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    modal.style.position = 'fixed';
    modal.style.left = `${initialLeft}px`;
    modal.style.top = `${initialTop}px`;
    modal.style.margin = '0';
    modal.style.transform = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      modal.style.left = `${Math.max(10, Math.min(window.innerWidth - 120, initialLeft + dx))}px`;
      modal.style.top = `${Math.max(10, Math.min(window.innerHeight - 50, initialTop + dy))}px`;
    };

    const onMouseUp = () => {
      isDragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });

  // Action listeners
  const theaterBtn = header.querySelector('.btn-theater') as HTMLButtonElement;
  theaterBtn.addEventListener('click', () => {
    const isTheater = modal.classList.toggle('theater');
    theaterBtn.innerHTML = isTheater ? '🗗 Restore' : '⛶ Theater';
    if (isTheater) {
      modal.style.left = '';
      modal.style.top = '';
      modal.style.margin = '';
    }
  });

  const popoutBtn = header.querySelector('.btn-popout') as HTMLButtonElement;
  popoutBtn.addEventListener('click', () => {
    removeInPageModal();
    ext.runtime.sendMessage({ type: 'OPEN_PLAYER', url: targetUrl });
  });

  const closeBtn = header.querySelector('.btn-close') as HTMLButtonElement;
  closeBtn.addEventListener('click', () => {
    removeInPageModal();
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      removeInPageModal();
    }
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      removeInPageModal();
      window.removeEventListener('keydown', onKeyDown);
    }
  };
  window.addEventListener('keydown', onKeyDown);
}

// Receive messages from background script for in-page hybrid playback
ext.runtime.onMessage?.addListener((message: any, _sender: any, sendResponse: any) => {
  if (message?.type === 'PLAY_IN_PAGE' && message?.url) {
    showInPageModal(message.url);
    try { sendResponse({ handled: true }); } catch {}
    return true;
  }
  return undefined;
});


