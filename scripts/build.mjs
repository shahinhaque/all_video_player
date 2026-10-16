// CloudPlay build script — esbuild only, no framework.
// Usage: node scripts/build.mjs [--chrome|--firefox] [--watch]
import * as esbuild from 'esbuild';
import { mkdir, rm, readdir, copyFile, writeFile, readFile } from 'node:fs/promises';
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
  '<all_urls>',
  '*://*/*',
  'https://*/*',
  'http://*/*',
];

const CONTENT_MATCHES = [
  'https://mega.nz/*',
  'https://drive.google.com/*',
  'https://onedrive.live.com/*',
  'https://*.sharepoint.com/*',
];

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

function manifest(target) {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
  const basePermissions = [
    'storage',
    'contextMenus',
    'activeTab',
    'declarativeNetRequest',
    'declarativeNetRequestWithHostAccess',
  ];
  const permissions = target === 'firefox'
    ? [...basePermissions, 'webRequest', 'webRequestBlocking']
    : basePermissions;

  const m = {
    manifest_version: 3,
    default_locale: 'en',
    name: '__MSG_appName__',
    short_name: '__MSG_appShortName__',
    version: pkg.version,
    description: '__MSG_appDesc__',
    icons,
    action: { default_popup: 'popup.html', default_icon: icons, default_title: '__MSG_actionTitle__' },
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions,
    host_permissions: HOSTS,
    content_scripts: [{ matches: CONTENT_MATCHES, js: ['content.js'], run_at: 'document_idle' }],
  };
  if (target === 'chrome') {
    m.background = { service_worker: 'background.js' };
    m.minimum_chrome_version = '110';
  } else {
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = { gecko: { id: 'cloudplay@itmagnet.com.au', strict_min_version: '115.0' } };
    m.optional_permissions = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*'];
    m.optional_host_permissions = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*'];
  }
  return m;
}

async function buildTarget(target) {
  const outdir = path.join(root, 'dist', target);
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
    external: ['@audio/decode-eac3'],
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

  if (watch) {
    await copyDir(path.join(root, 'src', 'static'), outdir);
    await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
    for (const c of configs) {
      const ctx = await esbuild.context(c);
      await ctx.watch();
    }
    console.log(`[${target}] watching → ${path.relative(root, outdir)}`);
    return true;
  }

  const metas = [];
  for (const c of configs) metas.push((await esbuild.build(c)).metafile);

  // Copy static files and manifest AFTER esbuild completes so assets are never cleared
  await copyDir(path.join(root, 'src', 'static'), outdir);

  // Guarantee _locales/en/messages.json is always present
  const localeDir = path.join(outdir, '_locales', 'en');
  await mkdir(localeDir, { recursive: true });
  await copyFile(
    path.join(root, 'src', 'static', '_locales', 'en', 'messages.json'),
    path.join(localeDir, 'messages.json')
  );

  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest(target), null, 2));

  return report(target, outdir, metas);
}

/** Computes eager (core) vs lazy sizes from the esbuild metafile and enforces budgets. */
async function report(target, outdir, metas) {
  const outputs = Object.assign({}, ...metas.map((m) => m.outputs));
  const gz = async (rel) => gzipSync(await readFile(path.join(root, rel))).length;
  const entries = Object.keys(outputs).filter(
    (k) => outputs[k].entryPoint && !k.includes('/chunks/') && !k.includes('\\chunks\\')
  );
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
