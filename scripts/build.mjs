// CloudPlay build script — esbuild only, no framework.
// Usage: node scripts/build.mjs [--chrome|--firefox] [--watch]
import * as esbuild from 'esbuild';
import { mkdir, rm, cp, writeFile, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const targets = args.has('--chrome') ? ['chrome'] : args.has('--firefox') ? ['firefox'] : ['chrome', 'firefox'];
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/** Size budgets (gzipped). Core = everything loaded eagerly by any entry point. */
const BUDGET = { core: 150 * 1024, content: 5 * 1024 };

const HOSTS = [
  'https://mega.nz/*',
  'https://*.mega.nz/*',
  'https://*.mega.co.nz/*',
  'https://mega.io/*',
  'https://drive.google.com/*',
  'https://drive.usercontent.google.com/*',
  'https://*.googleusercontent.com/*',
  'https://www.googleapis.com/*',
  'https://onedrive.live.com/*',
  'https://1drv.ms/*',
  'https://api.onedrive.com/*',
  'https://*.1drv.com/*',
  'https://*.livefilestore.com/*',
  'https://*.microsoftpersonalcontent.com/*',
  'https://*.sharepoint.com/*',
];

const CONTENT_MATCHES = [
  'https://mega.nz/*',
  'https://drive.google.com/*',
  'https://onedrive.live.com/*',
  'https://*.sharepoint.com/*',
];

function manifest(target) {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
  const m = {
    manifest_version: 3,
    name: 'CloudPlay – Cloud Video Player',
    short_name: 'CloudPlay',
    version: pkg.version,
    description:
      'Stream TS, MP4, MKV & WebM videos straight from MEGA, Google Drive and OneDrive — playlists, next/previous, resume.',
    icons,
    action: { default_popup: 'popup.html', default_icon: icons, default_title: 'CloudPlay' },
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: ['storage', 'contextMenus', 'activeTab', 'declarativeNetRequest'],
    host_permissions: HOSTS,
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    content_scripts: [{ matches: CONTENT_MATCHES, js: ['content.js'], run_at: 'document_idle' }],
  };
  if (target === 'chrome') {
    m.background = { service_worker: 'background.js' };
    m.minimum_chrome_version = '110';
  } else {
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = { gecko: { id: 'cloudplay@itmagnet.com.au', strict_min_version: '128.0' } };
  }
  return m;
}

async function buildTarget(target) {
  const outdir = path.join(root, 'dist', target);
  try {
    await rm(outdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    // On Windows with OneDrive sync active, directory deletion may be locked; continue to overwrite
  }
  await mkdir(outdir, { recursive: true });

  const common = {
    absWorkingDir: root,
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    target: ['chrome110', 'firefox128'],
    define: { __TARGET__: JSON.stringify(target), __DEV__: String(watch) },
    logLevel: 'warning',
    legalComments: 'none',
    metafile: true,
  };
  const configs = [
    // Classic scripts: SW / event page and content script must not be ES modules.
    {
      ...common,
      entryPoints: { background: 'src/background/index.ts', content: 'src/content/index.ts' },
      format: 'iife',
      outdir,
    },
    // Extension pages: ESM + code splitting so heavy engines load lazily.
    {
      ...common,
      entryPoints: { player: 'src/player/main.ts', popup: 'src/popup/main.ts', options: 'src/options/main.ts' },
      format: 'esm',
      splitting: true,
      chunkNames: 'chunks/[name]-[hash]',
      outdir,
    },
  ];

  await cp(path.join(root, 'src', 'static'), outdir, { recursive: true });
  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest(target), null, 2));

  if (watch) {
    for (const c of configs) {
      const ctx = await esbuild.context(c);
      await ctx.watch();
    }
    console.log(`[${target}] watching → ${path.relative(root, outdir)}`);
    return true;
  }

  const metas = [];
  for (const c of configs) metas.push((await esbuild.build(c)).metafile);
  return report(target, outdir, metas);
}

/** Computes eager (core) vs lazy sizes from the esbuild metafile and enforces budgets. */
async function report(target, outdir, metas) {
  const outputs = Object.assign({}, ...metas.map((m) => m.outputs));
  const gz = async (rel) => gzipSync(await readFile(path.join(root, rel))).length;
  const entries = Object.keys(outputs).filter((k) => outputs[k].entryPoint);
  const eager = new Set();
  const visit = (k) => {
    if (eager.has(k)) return;
    eager.add(k);
    for (const imp of outputs[k]?.imports ?? []) if (imp.kind === 'import-statement') visit(imp.path);
  };
  entries.forEach(visit);

  let core = 0;
  let lazy = 0;
  let content = 0;
  const rows = [];
  for (const k of Object.keys(outputs)) {
    if (!k.endsWith('.js')) continue;
    const size = await gz(k);
    const isEager = eager.has(k);
    if (isEager) core += size;
    else lazy += size;
    if (k.endsWith('/content.js')) content = size;
    rows.push(`  ${isEager ? 'core' : 'lazy'}  ${(size / 1024).toFixed(1).padStart(7)} KB  ${path.relative(outdir, k)}`);
  }
  console.log(`\n[${target}] bundle (gzipped)\n${rows.sort().join('\n')}`);
  console.log(`  total core ${(core / 1024).toFixed(1)} KB · lazy ${(lazy / 1024).toFixed(1)} KB`);

  let ok = true;
  if (core > BUDGET.core) {
    console.error(`  ✖ core budget exceeded (${(BUDGET.core / 1024).toFixed(0)} KB)`);
    ok = false;
  }
  if (content > BUDGET.content) {
    console.error(`  ✖ content script budget exceeded (${(BUDGET.content / 1024).toFixed(0)} KB)`);
    ok = false;
  }
  return ok;
}

let allOk = true;
for (const t of targets) allOk = (await buildTarget(t)) && allOk;
if (!allOk) process.exit(1);
