import { ext } from '../lib/browser.js';

interface UserSettings {
  defaultSpeed: number;
  autoNext: boolean;
  resumePlayback: boolean;
  chunkSize: number;
}

const DEFAULT_SETTINGS: UserSettings = {
  defaultSpeed: 1.0,
  autoNext: true,
  resumePlayback: true,
  chunkSize: 2097152, // 2MB
};

const speedEl = document.getElementById('pref-speed') as HTMLSelectElement;
const autoNextEl = document.getElementById('pref-auto-next') as HTMLInputElement;
const resumeEl = document.getElementById('pref-resume') as HTMLInputElement;
const chunkSizeEl = document.getElementById('pref-chunk-size') as HTMLSelectElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnClearAll = document.getElementById('btn-clear-all') as HTMLButtonElement;
const saveStatus = document.getElementById('save-status') as HTMLSpanElement;

async function loadSettings() {
  const data = await ext.storage.local.get('settings');
  const s: UserSettings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
  if (speedEl) speedEl.value = String(s.defaultSpeed);
  if (autoNextEl) autoNextEl.checked = s.autoNext;
  if (resumeEl) resumeEl.checked = s.resumePlayback;
  if (chunkSizeEl) chunkSizeEl.value = String(s.chunkSize);
}

async function saveSettings() {
  const s: UserSettings = {
    defaultSpeed: parseFloat(speedEl.value) || 1.0,
    autoNext: autoNextEl.checked,
    resumePlayback: resumeEl.checked,
    chunkSize: parseInt(chunkSizeEl.value, 10) || 2097152,
  };
  await ext.storage.local.set({ settings: s });
  saveStatus.textContent = 'Settings saved!';
  setTimeout(() => {
    saveStatus.textContent = '';
  }, 2000);
}

async function clearAllData() {
  if (confirm('Clear all playback history and saved positions?')) {
    const all = await ext.storage.local.get(null);
    const keysToRemove: string[] = [];
    for (const k of Object.keys(all)) {
      if (k.startsWith('resume:') || k === 'history') {
        keysToRemove.push(k);
      }
    }
    await ext.storage.local.remove(keysToRemove);
    alert('Playback history and resume positions have been cleared.');
  }
}

btnSave?.addEventListener('click', saveSettings);
btnClearAll?.addEventListener('click', clearAllData);
document.addEventListener('DOMContentLoaded', loadSettings);
