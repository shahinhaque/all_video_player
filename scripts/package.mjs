// Pure Node.js ZIP Packager for Chrome and Firefox Extension Releases
import { deflateRawSync } from 'node:zlib';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function getFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await getFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function createZip(sourceDir, zipFilePath) {
  const files = await getFiles(sourceDir);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const relName = path.relative(sourceDir, file).replace(/\\/g, '/');
    const data = await readFile(file);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const nameBuf = Buffer.from(relName, 'utf8');

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // min version
    local.writeUInt16LE(0, 6); // general flags
    local.writeUInt16LE(8, 8); // compression: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14); // crc32
    local.writeUInt32LE(compressed.length, 18); // comp size
    local.writeUInt32LE(data.length, 22); // uncomp size
    local.writeUInt16LE(nameBuf.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length

    localChunks.push(local, nameBuf, compressed);

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // min version
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method: deflate
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(crc, 16); // crc32
    central.writeUInt32LE(compressed.length, 20); // comp size
    central.writeUInt32LE(data.length, 24); // uncomp size
    central.writeUInt16LE(nameBuf.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralChunks.reduce((acc, c) => acc + c.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12); // central dir size
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  const fullZip = Buffer.concat([...localChunks, ...centralChunks, eocd]);
  await writeFile(zipFilePath, fullZip);
  const st = await stat(zipFilePath);
  console.log(`Packaged ${path.basename(zipFilePath)}: ${(st.size / 1024).toFixed(1)} KB`);
}

for (const target of ['chrome', 'firefox']) {
  const sourceDir = path.join(root, 'dist', target);
  const zipFile = path.join(root, 'dist', `cloudplay-${target}.zip`);
  await createZip(sourceDir, zipFile);
}
console.log('Packaging complete!');
