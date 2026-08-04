// The zero-configuration style: draws any card from its rank/suit/colour alone.
//
// This is what lets a manifest-only pack look clean with no art and no
// declaration (design §2), and it is the fallback for every pack that names no
// style and matches no default. It is deliberately UNCHANGED from the renderer
// that shipped before the style registry existed — tests/cardStyles.test.js
// pins its exact output — so adopting a richer style is always a decision a
// pack makes, never something that happens to it.

import { escapeXml, cardAriaLabel, effectType, isWildRank, SUIT_GLYPH } from './shared.js';

const EFFECT_GLYPH = { skip: '⛔', reverse: '⇄', drawN: '+', wildDrawN: '+', wild: '✱' };

function effectLabel(card) {
  const type = effectType(card.effect);
  if (!type) return '';
  if (type === 'drawN' || type === 'wildDrawN') return `${EFFECT_GLYPH[type]}${card.effect.n}`;
  return EFFECT_GLYPH[type] || '';
}

export function cardFaceColor(card) {
  if (card.color) return card.color;
  if (card.suit) return card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black';
  return 'neutral';
}

// Rank names are pack-authored words, not single characters — Wildfire has
// "reverse" and "draw2" — and a 16px corner fits about two of them. The size
// steps down rather than the text being clipped by the card edge, which is
// what used to happen.
function cornerSizeClass(label) {
  if (label.length >= 5) return ' card-face__corner--xs';
  if (label.length >= 3) return ' card-face__corner--sm';
  return '';
}

export function face(card) {
  const color = cardFaceColor(card);
  const glyph = card.suit ? SUIT_GLYPH[card.suit] : '';
  const rankLabel = isWildRank(card) ? '' : card.rank ?? '';
  const corner = `${rankLabel}${glyph ? ` ${glyph}` : ''}`;
  const sizeClass = cornerSizeClass(corner);

  // A card whose only identity is "wild" has no rank to print and, in packs
  // that carry the wild as a TAG rather than an effect (Milestones, Stockpile),
  // no effect glyph either — so it used to render as a blank white rectangle.
  // The rank is the honest fallback badge.
  const badge = effectLabel(card) || (isWildRank(card) ? EFFECT_GLYPH.wild : '');

  // `card-face--painted` marks a card whose COLOUR is its face — a suitless
  // Wildfire or Milestones card, painted edge to edge. Suited cards carry a
  // colour too (a diamond is red), and without this distinction the stylesheet
  // painted every heart and diamond in a standard deck solid red.
  const painted = !card.suit && !!card.color ? ' card-face--painted' : '';

  return `
    <svg viewBox="0 0 100 140" class="card-face card-face--${escapeXml(color)}${painted}" role="img" aria-label="${escapeXml(cardAriaLabel(card))}">
      <rect x="1" y="1" width="98" height="138" rx="8" class="card-face__bg" />
      <text x="8" y="22" class="card-face__corner${sizeClass}">${escapeXml(corner)}</text>
      <text x="92" y="128" class="card-face__corner card-face__corner--br${sizeClass}">${escapeXml(corner)}</text>
      ${glyph ? `<text x="50" y="80" class="card-face__pip">${glyph}</text>` : ''}
      ${badge ? `<text x="50" y="80" class="card-face__badge">${escapeXml(badge)}</text>` : ''}
    </svg>`;
}

export const defaults = {
  accent: '#274b8c',
  order: ['red', 'yellow', 'green', 'blue'],
  palette: { red: '#c0392b', yellow: '#e1b12c', green: '#27ae60', blue: '#2f6fb0' },
  back: { pattern: 'lattice' },
};
