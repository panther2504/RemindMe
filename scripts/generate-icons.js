#!/usr/bin/env node
'use strict';

// Generates the extension and tray PNG icons (an alarm-clock glyph) without
// any image dependencies. Run: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
          r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / 16) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PURPLE = [109, 40, 217, 1];
const AMBER = [245, 158, 11, 1];
const WHITE = [255, 255, 255, 1];
const NONE = [0, 0, 0, 0];

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Alarm clock: amber bells, purple face ring, white face, purple hands.
function clock(x, y) {
  const cx = 0.5, cy = 0.54;
  const d = Math.hypot(x - cx, y - cy);
  if (d <= 0.3) {
    if (distToSegment(x, y, cx, cy, cx, cy - 0.19) < 0.045) return PURPLE;
    if (distToSegment(x, y, cx, cy, cx + 0.13, cy + 0.06) < 0.045) return PURPLE;
    return WHITE;
  }
  if (d <= 0.42) return PURPLE;
  if (Math.hypot(x - 0.2, y - 0.17) < 0.15 || Math.hypot(x - 0.8, y - 0.17) < 0.15) return AMBER;
  if (distToSegment(x, y, 0.3, 0.9, 0.24, 0.98) < 0.05 || distToSegment(x, y, 0.7, 0.9, 0.76, 0.98) < 0.05) return PURPLE;
  return NONE;
}

const root = path.join(__dirname, '..');
const outputs = [
  ...[16, 32, 48, 128].map((s) => [path.join(root, 'extension', 'icons', 'icon-' + s + '.png'), s]),
  [path.join(root, 'companion', 'assets', 'tray-16.png'), 16],
  [path.join(root, 'companion', 'assets', 'tray-32.png'), 32],
  [path.join(root, 'companion', 'assets', 'icon.png'), 256],
];

for (const [file, size] of outputs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(size, clock));
  console.log('wrote', path.relative(root, file));
}
