// Lightweight Content Script injected on MEGA, Google Drive, and OneDrive pages (< 3 KB)
import { ext } from '../lib/browser.js';

function isCloudVideoPage(): boolean {
  const href = location.href;
  return (
    href.includes('mega.nz/file') ||
    href.includes('mega.nz/folder') ||
    href.includes('drive.google.com/file') ||
    href.includes('onedrive.live.com') ||
    href.includes('1drv.ms')
  );
}

function injectFloatingButton(): void {
  if (document.getElementById('cloudplay-floating-btn')) return;
  if (!isCloudVideoPage()) return;

  const btn = document.createElement('button');
  btn.id = 'cloudplay-floating-btn';
  btn.textContent = '▶ Play in CloudPlay';
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
    padding: 10px 16px;
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
    ext.runtime.sendMessage({
      type: 'OPEN_PLAYER',
      url: location.href,
    });
  });

  document.body.appendChild(btn);
}

// Observe URL changes on single-page applications
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    injectFloatingButton();
  }
});

observer.observe(document, { subtree: true, childList: true });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectFloatingButton);
} else {
  injectFloatingButton();
}
