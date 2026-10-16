import { ext } from '../lib/browser.js';

interface HistoryEntry {
  url: string;
  title: string;
  timestamp: number;
}

const urlInput = document.getElementById('url-input') as HTMLInputElement;
const btnPaste = document.getElementById('btn-paste') as HTMLButtonElement;
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
const btnDemoStream = document.getElementById('btn-demo-stream') as HTMLButtonElement;
const btnOpenOptions = document.getElementById('btn-open-options') as HTMLButtonElement;
const btnClearHistory = document.getElementById('btn-clear-history') as HTMLButtonElement;
const historyList = document.getElementById('history-list') as HTMLElement;

const SAMPLE_TS_URL = 'https://test-streams.mux.dev/x36xhzz/url_0/url_462/193039199_mp4_h264_aac_hd_7.ts';

async function init() {
  btnPaste?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) urlInput.value = text.trim();
    } catch {
      urlInput.focus();
    }
  });

  btnPlay?.addEventListener('click', () => {
    launchStream(urlInput.value);
  });

  btnDemoStream?.addEventListener('click', () => {
    urlInput.value = SAMPLE_TS_URL;
    launchStream(SAMPLE_TS_URL);
  });

  urlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') launchStream(urlInput.value);
  });

  btnOpenOptions?.addEventListener('click', () => {
    ext.runtime.openOptionsPage();
  });

  btnClearHistory?.addEventListener('click', async () => {
    await ext.storage.local.set({ history: [] });
    renderHistory([]);
  });

  loadHistory();
}

async function launchStream(rawUrl: string) {
  const url = rawUrl.trim();
  if (!url) return;

  // Add to history
  try {
    const data = await ext.storage.local.get('history');
    const history: HistoryEntry[] = data.history || [];
    const updated = [
      { url, title: url, timestamp: Date.now() },
      ...history.filter((h) => h.url !== url),
    ].slice(0, 10);
    await ext.storage.local.set({ history: updated });
  } catch {}

  const playerUrl = ext.runtime.getURL(`player.html?url=${encodeURIComponent(url)}`);
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    const currentTab = tabs && tabs[0];
    if (currentTab?.windowId !== undefined) {
      await ext.tabs.create({
        url: playerUrl,
        windowId: currentTab.windowId,
        index: (currentTab.index ?? 0) + 1,
      });
    } else {
      await ext.tabs.create({ url: playerUrl });
    }
  } catch {
    await ext.tabs.create({ url: playerUrl });
  }
  window.close();
}

async function loadHistory() {
  try {
    const data = await ext.storage.local.get('history');
    renderHistory(data.history || []);
  } catch {
    renderHistory([]);
  }
}

function renderHistory(items: HistoryEntry[]) {
  if (!historyList) return;
  if (items.length === 0) {
    historyList.innerHTML = '<div class="empty-state">No recent streams yet</div>';
    return;
  }

  historyList.innerHTML = '';
  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.title = item.url;

    // Display simplified URL or hostname
    let label = item.url;
    try {
      const u = new URL(item.url);
      label = `${u.hostname}${u.pathname}`;
    } catch {}

    el.innerHTML = `
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:270px;">${label}</span>
      <span style="opacity:0.6; font-size:11px;">▶</span>
    `;
    el.addEventListener('click', () => launchStream(item.url));
    historyList.appendChild(el);
  });
}

document.addEventListener('DOMContentLoaded', init);
