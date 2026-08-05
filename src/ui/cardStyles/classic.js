// Standard 52/54: the deck everyone already knows, drawn the way they know it.
//
// The vanilla renderer prints one big suit glyph in the middle of every card,
// so a 7♥ and a 3♥ differ only by two small corner characters. That is the
// single biggest legibility gap in the game: real players read a hand by PIP
// COUNT, not by reading the index on every card. So this style lays the pips
// out properly, in the arrangement a physical deck uses, with the lower half
// turned around like the real thing.
//
// Court cards are geometry, not portraits. A drawn J/Q/K is a substantial art
// commission and every recognisable one is somebody's copyright, so these are
// original ornaments — crown, diadem, pennant — over a bordered panel that is
// rotationally symmetric like a real court card. They read as "this is a face
// card" instantly, which is the whole job.

import {
  SUIT_GLYPH, blend, cardAriaLabel, cardBase, mirrored, num, openSvg, shade, text,
} from './shared.js';

const PAPER = '#fdfdfa';

const RED = '#b91c1c';
const BLACK = '#141414';

const L = 32;
const C = 50;
const R = 68;

/**
 * Where the pips go, per rank.
 *
 * These are the arrangements on a physical deck, not an even grid: 7 is two
 * columns of three with one pip pushed up between them, 10 is two columns of
 * four with two between. Getting them wrong is the kind of thing nobody can
 * name but everybody notices.
 */
const PIP_LAYOUT = {
  2: [[C, 38], [C, 102]],
  3: [[C, 38], [C, 70], [C, 102]],
  4: [[L, 38], [R, 38], [L, 102], [R, 102]],
  5: [[L, 38], [R, 38], [C, 70], [L, 102], [R, 102]],
  6: [[L, 38], [R, 38], [L, 70], [R, 70], [L, 102], [R, 102]],
  7: [[L, 38], [R, 38], [C, 54], [L, 70], [R, 70], [L, 102], [R, 102]],
  8: [[L, 38], [R, 38], [C, 54], [L, 70], [R, 70], [C, 86], [L, 102], [R, 102]],
  9: [[L, 38], [R, 38], [L, 55], [R, 55], [C, 70], [L, 85], [R, 85], [L, 102], [R, 102]],
  10: [[L, 38], [R, 38], [C, 46], [L, 55], [R, 55], [L, 85], [R, 85], [C, 94], [L, 102], [R, 102]],
};

const COURT = new Set(['J', 'Q', 'K']);

/**
 * A glyph centred on (cx, cy) rather than sitting on a baseline there.
 *
 * `glyph` is never escaped and never needs to be: it only ever arrives from a
 * SUIT_GLYPH lookup, so it is one of four characters this repo wrote or the
 * empty string. Callers check for the empty string before drawing.
 */
function glyphAt(glyph, cx, cy, size, fill, { flip = false } = {}) {
  const body = `<text x="${num(cx)}" y="${num(cy + size * 0.33)}" font-size="${num(size)}"`
    + ` text-anchor="middle" fill="${fill}" class="cs-text">${glyph}</text>`;
  // Rotated about its own centre, so a pip in the lower half turns in place —
  // which is what a real card does, and why one held upside down still reads.
  return flip ? `<g transform="rotate(180 ${num(cx)} ${num(cy)})">${body}</g>` : body;
}

function cornerIndex(rank, glyph, fill) {
  return `<g>${text(rank, { x: 13, y: 25, size: rank.length > 1 ? 14 : 16, fill, cls: 'cs-text' })}`
    + glyphAt(glyph, 13, 34, 13, fill)
    + '</g>';
}

/** Crown, diadem, pennant — one half of a court card's rotationally-paired art. */
function courtMotif(rank, glyph, fill, soft) {
  const band = `<rect x="35" y="52" width="30" height="4.5" rx="1.5" fill="${fill}" />`;
  let crest = '';
  if (rank === 'K') {
    crest = `<polygon points="36,52 38.5,35 44,45 50,31 56,45 61.5,35 64,52" fill="${fill}" />`;
  } else if (rank === 'Q') {
    crest = `<path d="M37 52Q50 30 63 52Z" fill="${fill}" />`
      + `<circle cx="43" cy="41" r="2.4" fill="${soft}" /><circle cx="50" cy="37" r="2.8" fill="${soft}" />`
      + `<circle cx="57" cy="41" r="2.4" fill="${soft}" />`;
  } else {
    crest = `<polygon points="50,31 61,38.5 57.5,52 50,48 42.5,52 39,38.5" fill="${fill}" />`;
  }
  return crest + band + glyphAt(glyph, 50, 63, 15, fill);
}

export function face(card) {
  const suit = card.suit;
  const glyph = (suit && SUIT_GLYPH[suit]) || '';
  const isRed = suit === 'hearts' || suit === 'diamonds';
  const ink = suit ? (isRed ? RED : BLACK) : '#3f3f46';
  const rank = card.rank == null ? '' : String(card.rank);

  // The inner rule and the ace's ellipses are drawn straight onto PAPER, so
  // both are blended against it here rather than shipped as alpha (see the
  // no-alpha rule at the top of shared.js).
  const parts = [cardBase(PAPER), `<rect x="4.5" y="4.5" width="91" height="131" rx="5.5" fill="none" stroke="${blend(PAPER, '#000000', 0.07)}" />`];

  if (glyph) parts.push(mirrored(cornerIndex(rank, glyph, ink)));
  else parts.push(mirrored(text(rank.slice(0, 5), { x: 15, y: 25, size: 13, fill: ink, anchor: 'start' })));

  const pips = PIP_LAYOUT[Number(rank)];
  if (COURT.has(rank) && glyph) {
    parts.push(`<rect x="21" y="27" width="58" height="86" rx="4" fill="${shade(ink, 0.92)}" stroke="${ink}" stroke-width="1.6" />`);
    parts.push(mirrored(courtMotif(rank, glyph, ink, PAPER)));
  } else if (rank === 'A' && glyph) {
    // The one flourish a plain deck always has. No trade dress involved — the
    // ornamented ace is older than any of the companies that print one.
    if (suit === 'spades') {
      const faded = blend(PAPER, ink, 0.5);
      parts.push(`<ellipse cx="50" cy="70" rx="27" ry="34" fill="none" stroke="${faded}" stroke-width="1.2" />`);
      parts.push(`<ellipse cx="50" cy="70" rx="24" ry="31" fill="none" stroke="${faded}" stroke-width="0.8" />`);
    }
    parts.push(glyphAt(glyph, 50, 70, 46, ink));
  } else if (pips && glyph) {
    for (const [x, y] of pips) parts.push(glyphAt(glyph, x, y, 17, ink, { flip: y > 70 }));
  } else {
    // A joker, or any rank a standard layout has no arrangement for. Saying
    // the rank large is better than an empty card.
    parts.push(text(rank.slice(0, 6), { x: 50, y: 80, size: rank.length > 2 ? 20 : 40, fill: ink }));
  }

  const tone = suit ? (isRed ? ' card-face--red' : ' card-face--black') : '';
  return openSvg(`card-face card-face--classic${tone}`, cardAriaLabel(card))
    + parts.join('') + '</svg>';
}

export const defaults = {
  accent: '#274b8c',
  order: ['red', 'black'],
  palette: { red: RED, black: BLACK },
  back: { pattern: 'lattice' },
};
