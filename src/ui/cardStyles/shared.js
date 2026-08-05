// Primitives every card style draws with.
//
// TWO RULES HOLD FOR EVERY SHAPE IN THIS DIRECTORY, and both are load-bearing:
//
//  1. NO SVG `id`, `<defs>`, `<pattern>`, `<clipPath>` or `url(#…)` — ever.
//     Card SVGs are inlined into the page by the dozen (a mini-hand is one per
//     card, the lobby shows five packs at once), and ids are DOCUMENT-scoped.
//     Two inlined SVGs declaring the same id make every `url(#x)` in the page
//     resolve to whichever came first, so one pack silently paints another
//     pack's cards. Everything here is explicit geometry instead, which also
//     makes each face a pure function of its card and theme.
//
//  2. Every card-derived string is escaped, and every colour that reaches an
//     attribute was either written in this repo or passed the hex gate in
//     src/ui/css.js (§7b). A pack is untrusted input the moment sharing ships.
//
// AND ONE RENDERING RULE: NO ALPHA. Not `opacity`, not an eight-digit fill.
// Every colour in a card is an opaque hex literal.
//
// This is a performance rule, not a taste one. A card is an inline SVG that a
// phone rasterises dozens of times over — a full hand, three opponents' backs,
// the piles — and any partially-transparent element forces the renderer to
// composite that element (and, for a `<g opacity>`, the whole group) through
// its own offscreen buffer instead of painting it straight into the layer.
// Every one of these was a flat colour over a KNOWN flat colour, so the blend
// is computed here once with blend() and the card ships the resulting solid.
// Identical pixels, none of the compositing.

export const SUIT_GLYPH = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };

export function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Returns RAW pack values (rank/suit/color/id). Every caller must escape.
 * Card fields are pack-supplied, and a pack can arrive from another device
 * (design §7d config exchange), so they are untrusted input the moment
 * sharing ships. §7b calls this exact shape out as a class that has shipped
 * twice in this fleet.
 */
export function cardAriaLabel(card) {
  if (card.rank && card.suit) return `${card.rank} of ${card.suit}`;
  if (card.rank && card.color) return `${card.color} ${card.rank}`;
  return card.rank || card.id;
}

export function effectType(effect) {
  if (!effect) return null;
  return typeof effect === 'string' ? effect : effect.type;
}

export function isWildRank(card) {
  return card.rank === 'wild' || card.rank === 'wild-draw4';
}

/**
 * What KIND of card this is, for styles that draw an icon rather than a word.
 *
 * Read from the effect first and the rank second, because the same idea is
 * carried both ways across the packs: Wildfire's skip is an effect, Milestones'
 * is a tag with a matching rank. A style that only looked at one of them drew a
 * blank card for the other pack.
 */
export function cardKind(card) {
  const type = effectType(card.effect);
  if (type === 'wildDrawN') return 'wildDrawN';
  if (type === 'wild') return 'wild';
  if (type === 'drawN') return 'drawN';
  if (type === 'reverse') return 'reverse';
  if (type === 'skip' || type === 'skipTarget') return 'skip';
  if (card.rank === 'wild-draw4') return 'wildDrawN';
  if (card.rank === 'wild' || (card.tags || []).includes('wild')) return 'wild';
  if (card.rank === 'skip' || (card.tags || []).includes('skip')) return 'skip';
  if (card.rank === 'reverse') return 'reverse';
  return 'number';
}

/** How many cards a draw-N card makes you take, when it says so. */
export function drawCount(card) {
  const n = card.effect && typeof card.effect === 'object' ? card.effect.n : null;
  return Number.isInteger(n) && n > 0 && n < 100 ? n : 2;
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

/** Round to 2dp: shorter markup, and identical output for identical input. */
export function num(n) {
  return String(Math.round(n * 100) / 100);
}

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function channels(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Lighten (`amount` > 0) or darken (< 0) a validated `#rrggbb`.
 *
 * Done in JS rather than with `color-mix()` because these land in SVG
 * presentation attributes, and the output is a plain hex literal this module
 * generated — never a pack string that merely looked like one.
 */
export function shade(hex, amount) {
  const out = channels(hex).map((c) => (amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)));
  return `#${out.map((c) => clampByte(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `over` painted at `alpha` on top of `under`, as one opaque hex.
 *
 * The whole no-alpha rule at the top of this file rests on this: everything a
 * card used to fade sat on a flat colour this module already knew, so the blend
 * that the compositor would have done per frame is done here once instead.
 * Callers must pass the colour that is ACTUALLY underneath — blending against
 * the wrong backdrop is the one way to get this visibly wrong.
 */
export function blend(under, over, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const u = channels(under);
  const o = channels(over);
  return `#${u.map((c, i) => clampByte(c + (o[i] - c) * a).toString(16).padStart(2, '0')).join('')}`;
}

/** A guard for the few places a colour reaches shade()/blend() from a caller. */
function isHex(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/* ------------------------------------------------------------------ *
 * Muting — what a card you cannot play looks like
 * ------------------------------------------------------------------ */

/**
 * A CARD YOU CANNOT PLAY IS PRINTED ON GREY STOCK IN DEEPER INK.
 *
 * It used to be the live card at `opacity: 0.78`, which said the right thing
 * and cost the wrong price: alpha below 1 puts an element on its own composited
 * layer, and on a typical hand most cards are unplayable, so that was a layer
 * per card per frame on a phone (see the no-alpha rule at the top of this file).
 *
 * Baking it into the art instead is not just cheaper, it is BETTER, and for a
 * reason worth stating: a fade takes the ink down with the paper, so it dimmed
 * the rank you are squinting at in the very moment you are working out why the
 * card is unplayable. Greying the stock and DEEPENING the ink pulls the two
 * apart — the card recedes, the value stays readable. The tightest case in the
 * five packs (Milestones' yellow, which lives at 4.85:1 on white and could not
 * afford to lose any of it) comes out at 5.27:1 muted, better than it is live.
 *
 * Two functions rather than one because a card has two kinds of colour and they
 * must move in OPPOSITE directions. Every style routes its fields through
 * dullPaper() and everything else through dullInk(); the split is per-style
 * because only the style knows which of its rectangles is the paper.
 */

/** Which way is "up" for the paper: a neutral the stock is pulled toward. */
const STOCK = '#8a928a';

/**
 * Near-white paper -> grey stock. Desaturated most of the way (so a warm white
 * does not stay warm) and then pulled toward STOCK, which is what supplies the
 * visible step: #fdfdfa lands on #daddd9, a 1.34:1 move.
 */
export function dullPaper(hex) {
  if (!isHex(hex)) return '#daddd9';
  const c = channels(hex);
  const grey = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const flat = c.map((v) => v + (grey - v) * 0.55);
  const stock = channels(STOCK);
  return `#${flat.map((v, i) => clampByte(v + (stock[i] - v) * 0.3).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Everything that is not paper, one step deeper — ink, pips, a pack's colour
 * bands, a shedding card's whole painted body.
 *
 * DARKER, NOT DESATURATED, and that is the load-bearing choice. Desaturating
 * read better in isolation but destroys the thing the colour is FOR: in
 * Wildfire the colour is the rule, and a hand of greyed-out cards you can no
 * longer sort by colour is worse than no cue at all. It also drove white-on-
 * yellow to 2.37:1. Darkening keeps every hue and every ratio.
 *
 * -0.22 is the smallest step that pays back the contrast the grey stock costs,
 * across all five packs.
 */
export function dullInk(hex) {
  return isHex(hex) ? shade(hex, -0.22) : hex;
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/**
 * The card blank every style starts from.
 *
 * The edge used to be `#00000022` — black at 13%, which made the outline of
 * every single card on the table an alpha-composited element. It is now the
 * card's own fill stepped down, which is what that black-over-fill actually
 * resolved to and is opaque. A fill that is not a hex literal (no style ships
 * one, but the guard is free) falls back to a fixed paper-grey.
 */
export function cardBase(fill, stroke = null) {
  const edge = stroke || (isHex(fill) ? shade(fill, -0.13) : '#d5d5d0');
  return `<rect x="1" y="1" width="98" height="138" rx="8" fill="${fill}" stroke="${edge}" />`;
}

/**
 * A group repeated at 180°, which is how a real card carries its index twice.
 *
 * The rotation is about the card's centre, so the second copy lands in the
 * opposite corner reading the right way up when the card is turned around.
 */
export function mirrored(markup) {
  return `${markup}<g transform="rotate(180 50 70)">${markup}</g>`;
}

/** A pie split evenly between `colors` — the "this card is every colour" mark. */
export function wedgeDisc(cx, cy, r, colors) {
  if (colors.length === 0) return '';
  if (colors.length === 1) return `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${colors[0]}" />`;
  const step = (Math.PI * 2) / colors.length;
  return colors.map((fill, i) => {
    const a0 = -Math.PI / 2 + i * step;
    const a1 = a0 + step;
    const x0 = num(cx + r * Math.cos(a0));
    const y0 = num(cy + r * Math.sin(a0));
    const x1 = num(cx + r * Math.cos(a1));
    const y1 = num(cy + r * Math.sin(a1));
    return `<path d="M${num(cx)} ${num(cy)}L${x0} ${y0}A${num(r)} ${num(r)} 0 ${step > Math.PI ? 1 : 0} 1 ${x1} ${y1}Z" fill="${fill}" />`;
  }).join('');
}

/** The same idea as a diamond: four triangles filling a square stood on a corner. */
export function diamondRosette(cx, cy, h, colors) {
  const pts = [[cx, cy - h], [cx + h, cy], [cx, cy + h], [cx - h, cy]];
  return colors.slice(0, 4).map((fill, i) => {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    return `<path d="M${num(cx)} ${num(cy)}L${num(a[0])} ${num(a[1])}L${num(b[0])} ${num(b[1])}Z" fill="${fill}" />`;
  }).join('');
}

/** The corner-sized version of a rosette: one dot per colour, in a square. */
export function colorDots(cx, cy, spread, r, colors) {
  const at = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  return colors.slice(0, 4).map((fill, i) =>
    `<circle cx="${num(cx + at[i][0] * spread)}" cy="${num(cy + at[i][1] * spread)}" r="${num(r)}" fill="${fill}" />`).join('');
}

/**
 * The action icons, drawn at any size so the corner index and the centre mark
 * are the SAME symbol rather than a picture and a word that have to agree.
 *
 * `r` is the radius of the circle the icon fits inside.
 */
export function actionIcon(kind, cx, cy, r, color) {
  const w = num(r * 0.3);
  if (kind === 'skip') {
    return `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r * 0.78)}" fill="none" stroke="${color}" stroke-width="${w}" />`
      + `<line x1="${num(cx - r * 0.55)}" y1="${num(cy + r * 0.55)}" x2="${num(cx + r * 0.55)}" y2="${num(cy - r * 0.55)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" />`;
  }
  if (kind === 'reverse') {
    // One arrow, then the same arrow turned around — a shape that is its own
    // opposite is what "reverse" has to look like at 8px as well as at 40px.
    //
    // Each arrow is confined to its OWN half (|x| between 0.15r and 0.85r).
    // A first pass had them overlapping through the middle, on the theory that
    // interlocking arrows read as circulation; at 40px they merged into one
    // unreadable blob and at 8px into a dot. Two separated arrows pointing
    // opposite ways survive both sizes.
    const arrow = `<path d="M${num(cx - r * 0.48)} ${num(cy + r * 0.82)}L${num(cx - r * 0.48)} ${num(cy + r * 0.05)}`
      + `L${num(cx - r * 0.25)} ${num(cy + r * 0.05)}L${num(cx - r * 0.6)} ${num(cy - r * 0.82)}`
      + `L${num(cx - r * 0.95)} ${num(cy + r * 0.05)}L${num(cx - r * 0.72)} ${num(cy + r * 0.05)}`
      + `L${num(cx - r * 0.72)} ${num(cy + r * 0.82)}Z" fill="${color}" />`;
    return `${arrow}<g transform="rotate(180 ${num(cx)} ${num(cy)})">${arrow}</g>`;
  }
  if (kind === 'draw') {
    // Two cards, one already on top of the other: the thing that is about to
    // happen to your hand.
    const cw = r * 0.86;
    const chh = r * 1.16;
    const card = (dx, dy, fill) =>
      `<rect x="${num(cx - cw / 2 + dx)}" y="${num(cy - chh / 2 + dy)}" width="${num(cw)}" height="${num(chh)}"`
      + ` rx="${num(r * 0.16)}" fill="${fill}" stroke="${color}" stroke-width="${num(r * 0.14)}" />`;
    return card(-r * 0.3, -r * 0.22, '#ffffff') + card(r * 0.3, r * 0.22, color);
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/**
 * A text run. `size`/`weight`/`anchor` are presentation ATTRIBUTES rather than
 * classes because they vary per style and per rank — a stylesheet would need a
 * class per size, and the sizes are geometry, not theme (see the note on px
 * units in table.css).
 *
 * `outline` is what makes a numeral survive being printed straight onto a
 * saturated colour; `paint-order: stroke` comes from the stylesheet so the
 * stroke sits behind the fill instead of eating into the letterform.
 *
 * There is no `opacity` option, by the no-alpha rule at the top of this file.
 * A faded run of text is a `fill` blended against its own backdrop instead —
 * see sequencing.js, which is the one style that draws one.
 */
export function text(str, { x, y, size, fill, weight = 700, anchor = 'middle', outline = null, outlineWidth = 3, cls = 'cs-text' }) {
  // `cls` is a literal at every call site today. Escaped anyway: it costs
  // nothing, and the next style to want a modifier per card is one refactor
  // away from routing a pack value through it.
  const parts = [
    `<text x="${num(x)}" y="${num(y)}" font-size="${num(size)}" font-weight="${weight}"`,
    ` text-anchor="${anchor}" fill="${fill}" class="${escapeXml(cls)}"`,
  ];
  if (outline) parts.push(` stroke="${outline}" stroke-width="${num(outlineWidth)}"`);
  parts.push(`>${escapeXml(str)}</text>`);
  return parts.join('');
}

/**
 * The opening `<svg>` for a card, with the classes the stylesheet sizes and
 * shadows off, and the label a screen reader actually reads.
 */
export function openSvg(classes, label) {
  return `<svg viewBox="0 0 100 140" class="${escapeXml(classes)}" role="img" aria-label="${escapeXml(label)}">`;
}
