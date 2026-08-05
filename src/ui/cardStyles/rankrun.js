// Stockpile and its genre: one long ascending run, 1 through 12.
//
// This deck has NO colour of its own — every card is a bare rank (see
// packs/stockpile/deck.json), which is why the vanilla renderer drew 144
// identical white rectangles distinguishable only by a corner digit. The game
// is "is this the next number I need", played against four build piles at once,
// so the thing worth adding is a way to judge a card's rough position in the
// run without reading it.
//
// Hence bands: 1–4, 5–8, 9–12, each its own colour, printed as caps on the
// short edges. A hand sorts itself visually into low/middle/high before you
// read a single digit, and the exact number is still the biggest thing on the
// card. The band is DERIVED from the rank, so the pack needs no per-card art
// and a deck of a different length still lands somewhere sensible.

import {
  cardAriaLabel, cardBase, cardKind, dullInk, dullPaper, mirrored, num, openSvg,
  shade, text, wedgeDisc,
} from './shared.js';

const PAPER = '#fdfdfa';
const BAND_KEYS = ['band1', 'band2', 'band3'];

/** Which third of the run this rank falls in. Non-numeric ranks get the middle. */
function bandFor(rank, high) {
  const n = Number(rank);
  if (!Number.isFinite(n)) return 1;
  const span = Math.max(1, high) / BAND_KEYS.length;
  return Math.min(BAND_KEYS.length - 1, Math.max(0, Math.ceil(n / span) - 1));
}

/**
 * A coloured cap hugging one short edge, following the card's own rounding.
 *
 * Drawn as a path rather than a rect because a rect with two rounded corners
 * needs either a clip path or four separate shapes, and the id rule in
 * shared.js rules the first one out.
 */
function cap(depth) {
  return `<path d="M1 ${num(depth)}L1 9A8 8 0 0 1 9 1L91 1A8 8 0 0 1 99 9L99 ${num(depth)}Z"`;
}

export function face(card, theme, muted = false) {
  const kind = cardKind(card);
  const wild = kind === 'wild' || kind === 'wildDrawN';
  // Grey stock, deeper bands — see the muting note in shared.js. The caps are
  // this deck's only colour and the only thing that says roughly where in the
  // run a card sits, so they DARKEN rather than wash out.
  const paper = muted ? dullPaper(PAPER) : PAPER;
  const ink = (hex) => (muted ? dullInk(hex) : hex);
  const bands = BAND_KEYS.map((k) => theme.palette[k]).filter(Boolean).map(ink);
  const rank = card.rank == null ? '' : String(card.rank).slice(0, 3);
  const band = wild ? bands[1] : bands[bandFor(rank, theme.rankHigh)];
  const top = wild ? bands[0] : band;
  const bottom = wild ? bands[2] : band;

  const parts = [
    cardBase(paper),
    `${cap(30)} fill="${top || band}" />`,
    `<g transform="rotate(180 50 70)">${cap(30)} fill="${bottom || band}" /></g>`,
  ];

  if (wild) {
    // Every band at once: a wild is playable onto any pile, and this is that
    // sentence as a picture.
    parts.push(`<circle cx="50" cy="70" r="30" fill="${shade(band, -0.25)}" />`);
    parts.push(wedgeDisc(50, 70, 27, bands.length >= 2 ? bands : [band]));
    parts.push(`<circle cx="50" cy="70" r="27" fill="none" stroke="${paper}" stroke-width="2" />`);
    parts.push(text('★', { x: 50, y: 81, size: 30, fill: paper, outline: shade(band, -0.5), outlineWidth: 3 }));
    parts.push(mirrored(text('★', { x: 15, y: 24, size: 15, fill: paper })));
  } else {
    parts.push(text(rank, {
      x: 50, y: 89, size: rank.length > 1 ? 50 : 58, weight: 800,
      fill: band, outline: shade(band, -0.45), outlineWidth: 2.4,
    }));
    parts.push(mirrored(text(rank, { x: 16, y: 23, size: 17, fill: paper })));
  }

  return openSvg(`card-face card-face--rankrun${muted ? ' card-face--muted' : ''}`, cardAriaLabel(card)) + parts.join('') + '</svg>';
}

export const defaults = {
  accent: '#6b4fa8',
  order: BAND_KEYS,
  // Dark enough for the white corner numeral printed ON the cap: the middle
  // band started at #2f9e63, which is 2.9:1 against white.
  palette: { band1: '#2f6fb0', band2: '#1b7d4d', band3: '#c0392b' },
  back: { pattern: 'weave' },
  rankHigh: 12,
};
