// Generate crisp play-button extension icons in pure Node (zlib + raw PNG chunking)
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'static', 'icons');
await mkdir(outDir, { recursive: true });

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  const scanlines = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = 1 + x * 4;
      row[dstIdx] = rgba[srcIdx];
      row[dstIdx + 1] = rgba[srcIdx + 1];
      row[dstIdx + 2] = rgba[srcIdx + 2];
      row[dstIdx + 3] = rgba[srcIdx + 3];
    }
    scanlines.push(row);
  }
  const idatData = deflateSync(Buffer.concat(scanlines));

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);
}

function renderIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const r = size / 2;
  const cx = r;
  const cy = r;
  const cornerR = size * 0.22;

  // Render rounded rectangle background with violet-to-cyan gradient + white play triangle
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Distance from rounded box
      const dx = Math.max(0, Math.abs(x + 0.5 - cx) - (r - cornerR));
      const dy = Math.max(0, Math.abs(y + 0.5 - cy) - (r - cornerR));
      const dist = Math.hypot(dx, dy);

      if (dist <= cornerR) {
        const t = (x + y) / (size * 2);
        // Gradient: Indigo #6366F1 to Cyan #06B6D4
        const cr = Math.round(99 + (6 - 99) * t);
        const cg = Math.round(102 + (182 - 102) * t);
        const cb = Math.round(241 + (212 - 241) * t);

        // Check inside play triangle: vertices (0.38, 0.30), (0.38, 0.70), (0.72, 0.50)
        const px = (x + 0.5) / size;
        const py = (y + 0.5) / size;
        const inTriangle = px >= 0.38 && px <= 0.72 && py >= 0.5 - (px - 0.38) * 0.59 && py <= 0.5 + (px - 0.38) * 0.59;

        if (inTriangle) {
          rgba[idx] = 255;
          rgba[idx + 1] = 255;
          rgba[idx + 2] = 255;
          rgba[idx + 3] = 255;
        } else {
          rgba[idx] = cr;
          rgba[idx + 1] = cg;
          rgba[idx + 2] = cb;
          rgba[idx + 3] = 255;
        }
      }
    }
  }
  return makePng(size, size, rgba);
}

for (const s of [16, 32, 48, 128]) {
  const buf = renderIcon(s);
  await writeFile(path.join(outDir, `icon${s}.png`), buf);
  console.log(`Generated icon${s}.png`);
}
