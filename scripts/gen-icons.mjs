#!/usr/bin/env node
// Generate token-tool's icon assets as PNGs with ZERO runtime dependencies.
//
// We hand-encode PNGs (signature + IHDR + IDAT(zlib) + IEND + CRC32) and draw
// vector-ish primitives (rounded rect, rounded bar) into an RGBA pixel buffer.
// Produces:
//   assets/icon.png            1024×1024  colored app icon (mac + win app icon)
//   assets/trayTemplate.png      16×16    macOS menubar template (monochrome)
//   assets/trayTemplate@2x.png   32×32    macOS menubar template @2x
//   assets/tray-win.png          32×32    Windows tray icon (colored, square)
//
// Run: node scripts/gen-icons.mjs

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', 'assets');

// ---- CRC32 -----------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  // Prepend a filter byte (0 = none) to each scanline.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Canvas ----------------------------------------------------------------
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 4); // transparent (alpha 0)
  }

  set(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    // Source-over compositing for clean overlaps (esp. bars on background).
    const sa = a / 255;
    const da = this.buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    this.buf[i] = Math.round((r * sa + this.buf[i] * da * (1 - sa)) / oa);
    this.buf[i + 1] = Math.round((g * sa + this.buf[i + 1] * da * (1 - sa)) / oa);
    this.buf[i + 2] = Math.round((b * sa + this.buf[i + 2] * da * (1 - sa)) / oa);
    this.buf[i + 3] = Math.round(oa * 255);
  }

  // Filled rounded rectangle spanning [x0,x1) × [y0,y1) with corner radius r.
  roundRect(x0, y0, x1, y1, r, col) {
    const radius = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
    const [R, G, B, A = 255] = col;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        if (px < x0 || px > x1 || py < y0 || py > y1) continue;
        const nx = Math.max(x0 + radius, Math.min(x1 - radius, px));
        const ny = Math.max(y0 + radius, Math.min(y1 - radius, py));
        const dx = px - nx;
        const dy = py - ny;
        if (dx * dx + dy * dy <= radius * radius) this.set(x, y, R, G, B, A);
      }
    }
  }

  toPNG() {
    return encodePNG(this.w, this.h, this.buf);
  }
}

// ---- Art -------------------------------------------------------------------
// Three ascending bars — the "usage / balance monitoring" glyph.
const INDIGO = [99, 102, 241, 255];
const WHITE = [255, 255, 255, 255];

function drawBars(c, w, h, color, pad) {
  // Three ascending bars, bottom-aligned, evenly spaced.
  const barW = w * 0.14;
  const gap = w * 0.07;
  const total = 3 * barW + 2 * gap;
  const startX = (w - total) / 2;
  const bottom = h - pad;
  const maxH = h - pad * 2;
  const heights = [0.42, 0.7, 1.0].map((f) => maxH * f);
  const radius = Math.max(2, barW * 0.28);
  for (let i = 0; i < 3; i += 1) {
    const x = startX + i * (barW + gap);
    const top = bottom - heights[i];
    c.roundRect(x, top, x + barW, bottom, radius, color);
  }
}

function makeAppIcon(size) {
  const c = new Canvas(size, size);
  const r = size * 0.2225; // ~228 at 1024
  c.roundRect(0, 0, size, size, r, INDIGO);
  drawBars(c, size, size, WHITE, size * 0.22);
  return c.toPNG();
}

function makeTemplateIcon(size) {
  // macOS menu bar template: white-ish bars on transparent. setTemplateImage
  // recolors to match the menu bar, so we just need an alpha mask of the glyph.
  const c = new Canvas(size, size);
  drawBars(c, size, size, [255, 255, 255, 255], size * 0.22);
  return c.toPNG();
}

function makeWindowsTray(size) {
  // Colored, near-square, small: indigo rounded square + white bars.
  const c = new Canvas(size, size);
  const r = size * 0.25;
  c.roundRect(0, 0, size, size, r, INDIGO);
  drawBars(c, size, size, WHITE, size * 0.22);
  return c.toPNG();
}

function writeIfChanged(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`wrote ${path.relative(process.cwd(), file)} (${buf.length} bytes)`);
}

function main() {
  writeIfChanged(path.join(ASSETS, 'icon.png'), makeAppIcon(1024));
  writeIfChanged(path.join(ASSETS, 'trayTemplate.png'), makeTemplateIcon(16));
  writeIfChanged(path.join(ASSETS, 'trayTemplate@2x.png'), makeTemplateIcon(32));
  writeIfChanged(path.join(ASSETS, 'tray-win.png'), makeWindowsTray(32));
}

main();
