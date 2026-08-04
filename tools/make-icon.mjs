#!/usr/bin/env node
// Generates icon.png — the catalog card art (GAME_INTEGRATION §1/§11: square,
// ≥ 512 px, served from THIS repo at /cardstock/icon.png).
//
// It is generated rather than drawn for the same reason the card faces are
// (design §2): the game has no art pipeline and no third-party assets, so the
// icon is code too. Zero dependencies — a PNG is a signature, three chunks and
// a CRC, and node ships zlib.
//
// Re-run after changing the palette:  node tools/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const SS = 3; // supersampling factor per axis — the only anti-aliasing here

const FELT = [27, 94, 58];
const FELT_LIT = [42, 122, 78];
const CARD = [253, 253, 250];
const CARD_EDGE = [214, 214, 205];
const BACK = [39, 75, 140];
const BACK_PATTERN = [59, 98, 173];
const PIP = [185, 28, 28];
const SHADOW = [10, 38, 24];

/** Signed distance to an axis-aligned rounded rect, in the rect's own frame. */
function roundedRectSdf(x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - (halfW - r);
  const qy = Math.abs(y) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Rotate a point into a card's local frame. */
function toLocal(x, y, cx, cy, angleDeg) {
  const a = (-angleDeg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}

// The classic implicit heart, in a unit box with +y up.
function insideHeart(x, y) {
  const t = x * x + y * y - 1;
  return t * t * t - x * x * y * y * y <= 0;
}

const CARDS = [
  { cx: 205, cy: 268, angle: -14, back: true },
  { cx: 300, cy: 250, angle: 9, back: false },
];
const HALF_W = 96;
const HALF_H = 134;
const RADIUS = 18;

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Colour of one supersample, in linear-ish 0..255 RGB. */
function sample(x, y) {
  // Felt, lit from above-centre.
  const d = Math.hypot(x - SIZE * 0.5, y - SIZE * 0.34) / (SIZE * 0.72);
  let out = mix(FELT_LIT, FELT, Math.min(1, d));

  for (const card of CARDS) {
    // A soft contact shadow, offset down-right from the card itself.
    const [sx, sy] = toLocal(x - 7, y - 11, card.cx, card.cy, card.angle);
    const sd = roundedRectSdf(sx, sy, HALF_W, HALF_H, RADIUS);
    if (sd < 10) out = mix(out, SHADOW, 0.38 * Math.min(1, (10 - sd) / 14));

    const [lx, ly] = toLocal(x, y, card.cx, card.cy, card.angle);
    const cd = roundedRectSdf(lx, ly, HALF_W, HALF_H, RADIUS);
    if (cd > 0) continue;

    if (card.back) {
      out = BACK;
      // The inset panel the vanilla card back draws (src/ui/renderCard.js).
      if (roundedRectSdf(lx, ly, HALF_W - 14, HALF_H - 14, 12) < 0) out = BACK_PATTERN;
    } else {
      out = CARD;
      if (cd > -3) out = CARD_EDGE; // a hairline edge so overlapping cards read apart
      // One pip, big enough to survive a 64 px launcher tile.
      const hx = lx / 62;
      const hy = -(ly + 8) / 62;
      if (insideHeart(hx, hy)) out = PIP;
    }
  }
  return out;
}

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 3);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const i = (y * SIZE + x) * 3;
      px[i] = Math.round(r * inv);
      px[i + 1] = Math.round(g * inv);
      px[i + 2] = Math.round(b * inv);
    }
  }
  return px;
}

/* ---- the PNG container ---- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  // 10..12 = compression, filter, interlace — all 0.

  // Filter type 0 (None) on every row. The image is smooth gradients, so
  // sub/up filters would help, but zlib on a 512² icon is already ~30 KB and
  // the simplicity is worth more here than the bytes.
  const stride = SIZE * 3;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(ROOT, 'icon.png');
fs.writeFileSync(out, png(render()));
console.log(`wrote ${path.relative(ROOT, out)} (${SIZE}×${SIZE}, ${fs.statSync(out).size} bytes)`);
