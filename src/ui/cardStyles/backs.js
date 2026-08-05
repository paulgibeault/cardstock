// The face-down side, themed per pack.
//
// A back is one flat design repeated across a whole deck, which is exactly the
// job an SVG `<pattern>` exists for — and exactly what this must not use. See
// the id rule at the top of shared.js: a mini-hand inlines one of these per
// card, so a `<pattern id="lattice">` would be redeclared a dozen times in one
// document and every `url(#lattice)` on the page would resolve to the first
// one. Two packs on screen at once (the lobby) would share whichever back
// happened to render first.
//
// So the tiling is unrolled here, and the geometry is CLIPPED IN JS to the
// printed area — the other thing `<pattern>` would have done for free. The
// alternative, drawing past the edge and covering the overflow, does not work
// on a card with rounded corners: there is nothing to clip against but the
// shape itself.

import { blend, escapeXml, num, shade } from './shared.js';

/** The printed area inside the white margin: x, y, right, bottom. */
const AREA = { x: 5, y: 5, r: 95, b: 135 };

/**
 * Liang–Barsky: the part of a segment that lies inside `AREA`, or null.
 *
 * Every pattern below is generated as full-length lines across the card and
 * trimmed here, which keeps each pattern's own code about spacing and angle
 * rather than about where the paper ends.
 */
function clipSegment(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const edges = [[-dx, x1 - AREA.x], [dx, AREA.r - x1], [-dy, y1 - AREA.y], [dy, AREA.b - y1]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;         // parallel to this edge and outside it
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

function line(seg, attrs) {
  if (!seg) return '';
  return `<line x1="${num(seg[0])}" y1="${num(seg[1])}" x2="${num(seg[2])}" y2="${num(seg[3])}" ${attrs} />`;
}

/** Parallel lines at `angle`, `spacing` apart, swept across the whole card. */
function hatch(angle, spacing, attrs) {
  const rad = (angle * Math.PI) / 180;
  const nx = Math.cos(rad);
  const ny = Math.sin(rad);
  const out = [];
  // Sweep the perpendicular offset far enough to cover the diagonal either way.
  for (let d = -180; d <= 180; d += spacing) {
    const px = 50 + nx * d;
    const py = 70 + ny * d;
    out.push(line(clipSegment(px - ny * 200, py + nx * 200, px + ny * 200, py - nx * 200), attrs));
  }
  return out.join('');
}

const PATTERNS = {
  lattice: (ink) => hatch(45, 11, `stroke="${ink}" stroke-width="1.4"`)
    + hatch(-45, 11, `stroke="${ink}" stroke-width="1.4"`),

  pinstripe: (ink) => hatch(60, 7, `stroke="${ink}" stroke-width="2.2"`),

  weave: (ink) => hatch(0, 9, `stroke="${ink}" stroke-width="2.6" stroke-dasharray="5 5"`)
    + hatch(90, 9, `stroke="${ink}" stroke-width="2.6" stroke-dasharray="5 5" stroke-dashoffset="5"`),

  rings: (ink) => {
    const out = [];
    for (let r = 7; r <= 63; r += 8) {
      // Rings wider than the paper would need clipping this shape cannot do,
      // so they simply stop — concentric and centred, which is the look anyway.
      if (r > 42) break;
      out.push(`<circle cx="50" cy="70" r="${r}" fill="none" stroke="${ink}" stroke-width="1.6" />`);
    }
    return out.join('');
  },

  sunburst: (ink) => {
    const out = [];
    for (let i = 0; i < 24; i++) {
      const a = (i * Math.PI * 2) / 24;
      out.push(line(clipSegment(50 + Math.cos(a) * 14, 70 + Math.sin(a) * 14,
        50 + Math.cos(a) * 200, 70 + Math.sin(a) * 200), `stroke="${ink}" stroke-width="2"`));
    }
    return out.join('');
  },
};

export const BACK_PATTERNS = Object.freeze(Object.keys(PATTERNS));

/**
 * The colour of the printed panel — what a back looks like when all you can see
 * of it is a sliver.
 *
 * A mini-hand overlaps its backs so hard that every card but the last shows
 * about half a centimetre of its left edge: white margin, then this. Drawing a
 * ninety-line pattern to fill fourteen pixels is the most expensive nothing on
 * the table, so src/ui/table.js draws those slivers with this colour instead
 * and keeps the real SVG for the one card that is actually visible.
 */
export function backPanelColor(theme) {
  return shade(theme.back.color, -0.4);
}

/**
 * The whole back, from a resolved theme.
 *
 * Pure: same theme in, byte-identical markup out. The renderer memoises one
 * call per table because a face-down card is drawn once per opponent card per
 * frame, which is dozens of identical strings.
 */
export function renderBack(theme) {
  const { pattern, color, emblem } = theme.back;
  const deep = shade(color, -0.4);
  // The pattern used to be `<g opacity="0.55">` over the panel. A back is the
  // most-rasterised card on the table — every opponent's whole hand is backs,
  // and each of these patterns is fifty to ninety vector lines — so a group
  // opacity meant compositing all of it through an offscreen buffer, per card,
  // per frame. The panel underneath is a known flat colour, so the fade is
  // baked into the ink instead. Same pixels, no buffer.
  const ink = blend(deep, shade(color, 0.3), 0.55);
  const draw = PATTERNS[pattern] || PATTERNS.lattice;

  // A white margin around a printed panel: the thing that makes a rectangle
  // read as a playing card rather than as a coloured tile.
  const parts = [
    '<rect x="1" y="1" width="98" height="138" rx="8" fill="#fdfdfa" stroke="#dededa" />',
    `<rect x="${AREA.x}" y="${AREA.y}" width="${AREA.r - AREA.x}" height="${AREA.b - AREA.y}" rx="5" fill="${deep}" />`,
    draw(ink),
    `<rect x="${AREA.x}" y="${AREA.y}" width="${AREA.r - AREA.x}" height="${AREA.b - AREA.y}" rx="5" fill="none" stroke="${shade(color, -0.6)}" stroke-width="1.5" />`,
    `<circle cx="50" cy="70" r="17" fill="${deep}" stroke="#fdfdfa" stroke-width="2.5" />`,
  ];

  if (emblem) {
    parts.push(`<text x="50" y="78" font-size="20" font-weight="700" text-anchor="middle" fill="#fdfdfa" class="cs-text">${escapeXml(emblem)}</text>`);
  } else {
    parts.push(`<circle cx="50" cy="70" r="6" fill="#fdfdfa" />`);
  }

  return `<svg viewBox="0 0 100 140" class="card-face card-face--back" role="img" aria-label="Face-down card">${parts.join('')}</svg>`;
}
