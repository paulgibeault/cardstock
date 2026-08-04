// Which art a pack gets, and the resolved theme every style draws with.
//
// The renderer used to be two free functions with no idea which pack they were
// drawing for, which is why every pack looked the same. It is now a FACTORY:
// the caller builds one renderer per open table (or per lobby tile) from that
// pack's manifest and deck, and the theme is resolved once instead of being
// re-derived per card per frame.
//
// UNTRUSTED INPUT (§7b). Everything read out of a manifest here is gated, and
// the gates are allow-lists:
//
//   - the style name must be a key this file wrote;
//   - every colour goes through safeAccent, so it is six hex digits or it is
//     the default — no url(), no var(), no stray semicolon;
//   - the back pattern must be one of the five backs.js draws;
//   - the palette is a NULL-PROTOTYPE object, because it is looked up by a
//     card's own `color` field. On a plain object, a card claiming
//     `"color": "constructor"` would resolve to Object.prototype.constructor
//     and stringify a whole function into a fill attribute.

import { safeAccent } from '../css.js';
import { BACK_PATTERNS, renderBack } from './backs.js';
import * as vanilla from './vanilla.js';
import * as classic from './classic.js';
import * as shedding from './shedding.js';
import * as sequencing from './sequencing.js';
import * as rankrun from './rankrun.js';

const STYLES = { vanilla, classic, shedding, sequencing, rankrun };

export const STYLE_IDS = Object.freeze(Object.keys(STYLES));

/** Colour names are lookup keys, never markup — but keep them boring anyway. */
const PALETTE_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,23}$/;

/** Enough colours for any wild rosette, and a ceiling a pack cannot blow past. */
const MAX_COLORS = 8;

/**
 * Which style draws this pack.
 *
 * The manifest's own declaration wins. After that the fallbacks are the two
 * facts that are actually reliable:
 *
 *  - a standard deck gets the standard treatment, checked BEFORE the template,
 *    because Crazy Eights is a shedding game played with a 52-card deck and
 *    wants pips rather than Wildfire's paint; and
 *  - a shedding pack with a deck of its own is the Wildfire shape.
 *
 * Nothing else is inferred. The template alone does not say what a deck looks
 * like — Milestones is `contract-rummy` and Stockpile is `sequencing`, which is
 * the opposite of what their card art wants — so those packs name their style
 * outright instead of the registry guessing from a field that does not know.
 */
export function resolveStyleId(manifest) {
  const declared = manifest.ui && manifest.ui.cardStyle;
  if (typeof declared === 'string' && Object.hasOwn(STYLES, declared)) return declared;
  if (typeof manifest.deck === 'string' && /^standard-5[24]/.test(manifest.deck)) return 'classic';
  if (manifest.template === 'shedding') return 'shedding';
  return 'vanilla';
}

/** The deck's own colours, in deck order. Null when the deck has none (or is absent). */
function deckColors(cardsById) {
  if (!cardsById || typeof cardsById.values !== 'function') return null;
  const seen = [];
  for (const card of cardsById.values()) {
    if (typeof card?.color === 'string' && PALETTE_KEY_RE.test(card.color) && !seen.includes(card.color)) {
      seen.push(card.color);
      if (seen.length >= MAX_COLORS) break;
    }
  }
  return seen.length ? seen : null;
}

/** The top of the run, which is what rankrun's colour bands are thirds of. */
function highestRank(cardsById, fallback) {
  if (!cardsById || typeof cardsById.values !== 'function') return fallback;
  let high = 0;
  for (const card of cardsById.values()) {
    const n = Number(card?.rank);
    if (Number.isFinite(n) && n > high) high = n;
  }
  return high > 0 ? high : fallback;
}

function buildBack(declared, accent, styleDefault) {
  const d = declared && typeof declared === 'object' ? declared : {};
  return Object.freeze({
    pattern: BACK_PATTERNS.includes(d.pattern) ? d.pattern : styleDefault.pattern,
    color: safeAccent(d.color, accent),
    // Sliced by CODE POINT, so a two-character emblem stays two characters and
    // an astral glyph is not cut in half into a lone surrogate.
    emblem: typeof d.emblem === 'string' ? [...d.emblem].slice(0, 2).join('') : '',
  });
}

/**
 * Everything a style needs, resolved once.
 *
 * `cardsById` is optional: the lobby draws hero cards from a manifest alone,
 * with no deck loaded, and gets the style's default palette instead of the
 * pack's real colours. A pack that cares declares `ui.cardPalette`, which is
 * read on both paths and makes the tile match the table.
 */
export function buildTheme(manifest, cardsById = null) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const style = resolveStyleId(m);
  const d = STYLES[style].defaults;
  const ui = m.ui && typeof m.ui === 'object' ? m.ui : {};

  const palette = Object.assign(Object.create(null), d.palette);
  const declaredOrder = [];
  if (ui.cardPalette && typeof ui.cardPalette === 'object') {
    for (const [name, hex] of Object.entries(ui.cardPalette)) {
      if (!PALETTE_KEY_RE.test(name) || declaredOrder.length >= MAX_COLORS) continue;
      const safe = safeAccent(hex, null);
      if (!safe) continue;
      palette[name] = safe;
      declaredOrder.push(name);
    }
  }

  const order = declaredOrder.length ? declaredOrder : (deckColors(cardsById) || d.order);
  // A deck colour the palette has never heard of still has to be drawn as
  // SOMETHING distinct, so it borrows the style's nth default rather than
  // collapsing onto whatever the first colour happens to be.
  const spares = d.order.map((name) => d.palette[name]).filter(Boolean);
  order.forEach((name, i) => {
    if (!palette[name]) palette[name] = spares[i % spares.length] || '#4b5563';
  });

  const accent = safeAccent(m.accent, d.accent);
  return Object.freeze({
    style,
    accent,
    palette: Object.freeze(palette),
    order: Object.freeze(order.slice(0, MAX_COLORS)),
    rankHigh: highestRank(cardsById, d.rankHigh ?? 12),
    back: buildBack(ui.cardBack, accent, d.back),
  });
}

/**
 * One renderer for one pack.
 *
 * `back()` is memoised because a face-down card is the most-drawn thing on the
 * table — every opponent's whole hand, redrawn every frame — and it is the same
 * string every time by construction.
 */
export function makeCardRenderer(manifest, cardsById = null) {
  const theme = buildTheme(manifest, cardsById);
  const style = STYLES[theme.style];
  let back = null;
  return {
    theme,
    face: (card) => style.face(card && typeof card === 'object' ? card : {}, theme),
    back: () => (back ??= renderBack(theme)),
  };
}
