// The answer to a wild, drawn as a card.
//
// A wild asks the one question in a shedding game that the cards themselves
// cannot answer: what does this pile become? That question used to be put as
// four word-buttons in a dialog — the only moment in Wildfire that looked like
// a form rather than a table — and in Crazy Eights it was worse, because
// "clubs" and "spades" are two words that look alike at a glance and neither
// of them is a picture of a suit.
//
// So the options are drawn in the pack's OWN hand: a colour is the card the
// discard is about to behave like, a suit is the pip you will have to follow.
// The word stays underneath, because the picture is the target and the word is
// what makes it legible to a player who cannot separate the colours.
//
// Every rule at the top of shared.js holds here too — no ids, no url(#…), no
// alpha, and every value that reaches a paint attribute is either a literal
// this file wrote or a colour that already passed the hex gate in the theme.

import {
  SUIT_GLYPH, blend, cardBase, escapeXml, num, roundedDiamond, shade, text,
} from './shared.js';

/** The same near-white every style prints its faces on. */
const PAPER = '#fdfdfa';

/** Fallback ink, for a pack whose theme has no red/black of its own. */
const RED = '#b91c1c';
const BLACK = '#141414';

/**
 * A tile's opening tag.
 *
 * Deliberately NOT shared.js's openSvg(), which gives a card `role="img"` and
 * an accessible name: this drawing sits INSIDE a button that already carries
 * the value as text, and a second name on the picture would make every option
 * read twice.
 */
function openTile(kind) {
  return `<svg viewBox="0 0 100 140" class="choice-face choice-face--${escapeXml(kind)}"`
    + ' aria-hidden="true" focusable="false">';
}

/** A glyph centred on a point rather than sitting on a baseline there. */
function centredGlyph(glyph, cx, cy, size, fill) {
  return `<text x="${num(cx)}" y="${num(cy + size * 0.33)}" font-size="${num(size)}"`
    + ` text-anchor="middle" fill="${fill}" class="cs-text">${glyph}</text>`;
}

/**
 * A colour, as the shedding style draws one: a painted body with the rounded
 * diamond standing on its corner in the middle of it.
 *
 * The wild card itself shows that diamond split four ways (the rosette in
 * shedding.js). Each option here is one of those quarters, made whole — which
 * is exactly what playing the wild does.
 */
function colorTile(body) {
  const rim = shade(body, -0.3);
  return openTile('color')
    + cardBase(rim)
    + `<rect x="6" y="6" width="88" height="128" rx="5" fill="${body}" />`
    // The panel is a hair short of white so the body bleeds through it — the
    // same blend, against the same backdrop, that shedding.js uses.
    + roundedDiamond(50, 70, 36, blend(body, PAPER, 0.95))
    + roundedDiamond(50, 70, 27, body)
    + '</svg>';
}

/** A suit, as the classic style draws its ace: the pip with the card to itself. */
function suitTile(glyph, ink) {
  return openTile('suit')
    + cardBase(PAPER)
    + `<rect x="4.5" y="4.5" width="91" height="131" rx="5.5" fill="none" stroke="${blend(PAPER, '#000000', 0.07)}" />`
    + centredGlyph(glyph, 50, 70, 62, ink)
    + '</svg>';
}

/** A rank — a wild joining a run has to say which end it is. */
function rankTile(rank, ink) {
  return openTile('rank')
    + cardBase(PAPER)
    + `<rect x="4.5" y="4.5" width="91" height="131" rx="5.5" fill="none" stroke="${blend(PAPER, '#000000', 0.07)}" />`
    + text(rank.slice(0, 3), { x: 50, y: 88, size: rank.length > 2 ? 34 : 52, fill: ink, weight: 800 })
    + '</svg>';
}

/**
 * The picture for one option of a choice, or null when the value has none.
 *
 * Null is a real answer and the caller has to handle it: "choose a player to
 * skip" offers names, and a name is not a card. Those options stay as words.
 *
 * @param attr  what is being chosen — 'color', 'suit', 'rank', or anything a
 *              template invents, which gets no art rather than a wrong one.
 * @param value the option, straight out of a pack or a deck. UNTRUSTED: it is
 *              a lookup key here and never reaches an attribute unescaped.
 */
export function chooserTile(attr, value, theme) {
  const palette = theme && theme.palette;
  if (attr === 'color') {
    // Null-prototype by construction in buildTheme, so a colour named
    // "constructor" misses rather than resolving to a function.
    const body = palette && palette[value];
    return body ? colorTile(body) : null;
  }
  if (attr === 'suit') {
    // hasOwn rather than a bare lookup: SUIT_GLYPH is a plain object, and a
    // pack is free to call a suit "toString".
    if (!Object.hasOwn(SUIT_GLYPH, value)) return null;
    const isRed = value === 'hearts' || value === 'diamonds';
    const ink = (palette && palette[isRed ? 'red' : 'black']) || (isRed ? RED : BLACK);
    return suitTile(SUIT_GLYPH[value], ink);
  }
  if (attr === 'rank') {
    const rank = value == null ? '' : String(value);
    return rank ? rankTile(rank, BLACK) : null;
  }
  return null;
}

/**
 * The colour an option should tint its panel with while it is the one under the
 * finger, or null when it has no colour of its own.
 *
 * Only a colour choice has one. A suit's ink is red or near-black, and a glow
 * in either is a glow that says nothing — black does not read as light, and red
 * would claim two of the four suits.
 */
export function chooserTint(attr, value, theme) {
  if (attr !== 'color') return null;
  const palette = theme && theme.palette;
  return (palette && palette[value]) || null;
}
