// Generates the PWA icons (web/public/icons/app-192.png, app-512.png).
// Pure-node PNG writer (zlib + manual chunks) — the motif mirrors the
// terminal-empty brand mark: dark navy tile, lighter rounded square, two orbit dots.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Rounded-rect SDF: 1 inside, 0 outside (with 2px anti-alias band).
function roundedRect(x, y, cx, cy, hw, hh, radius) {
  const dx = Math.abs(x - cx) - (hw - radius), dy = Math.abs(y - cy) - (hh - radius);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  const d = Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius;
  return d < -1 ? 1 : d > 1 ? 0 : 0.5 - d / 2;
}
function circle(x, y, cx, cy, r) {
  const d = Math.hypot(x - cx, y - cy) - r;
  return d < -1 ? 1 : d > 1 ? 0 : 0.5 - d / 2;
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const NAVY = [24, 37, 54], TILE = [42, 67, 99], DOT_BLUE = [102, 132, 208], DOT_TEAL = [92, 159, 155];

function icon(size) {
  const u = size / 512; // design at 512 space
  return png(size, (x, y) => {
    const px = x / u, py = y / u;
    const bg = roundedRect(px, py, 256, 256, 256, 256, 112);
    const tile = roundedRect(px, py, 240, 248, 168, 148, 44);
    const dotB = circle(px, py, 368, 336, 26);
    const dotT = circle(px, py, 128, 152, 18);
    let color = NAVY, alpha = bg;
    color = mix(color, TILE, tile);
    color = mix(color, DOT_BLUE, dotB);
    color = mix(color, DOT_TEAL, dotT);
    return [color[0], color[1], color[2], Math.round(255 * alpha)];
  });
}
const out = path.resolve('web/public/icons');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'app-192.png'), icon(192));
writeFileSync(path.join(out, 'app-512.png'), icon(512));
console.log('icons written to', out);
