// Card selectors: an exact card id ('spades-Q'), 'rank:<r>', 'suit:<s>', 'color:<c>',
// 'tag:<t>', or '*'. Used by cardTags, cardValues, deck effects overrides, lead/play
// constraints, sweepBonus, discardPickupForbidden, buildStart. See CARD_PLATFORM_DESIGN.md §2.

export function baseId(cardId) {
  const i = cardId.indexOf('#');
  return i === -1 ? cardId : cardId.slice(0, i);
}

export function selectorMatches(card, selector) {
  if (selector === '*') return true;
  const colonIdx = selector.indexOf(':');
  if (colonIdx !== -1) {
    const kind = selector.slice(0, colonIdx);
    const val = selector.slice(colonIdx + 1);
    if (kind === 'rank') return card.rank === val;
    if (kind === 'suit') return card.suit === val;
    if (kind === 'color') return card.color === val;
    if (kind === 'tag') return Array.isArray(card.tags) && card.tags.includes(val);
    return false;
  }
  return card.id === selector || baseId(card.id) === selector;
}

export function selectorMatchesAny(card, selectors) {
  return selectors.some((s) => selectorMatches(card, s));
}

function specificity(selector) {
  if (selector === '*') return 1;
  if (selector.includes(':')) return 2;
  return 3; // exact id
}

// Most-specific-wins, last-entry-wins on ties (schema's documented tie-break).
// Returns `fallback` only when nothing matched; an explicit `null` value in the
// map is returned as null (it means "no value" / "removed", not "unset").
export function resolveSelectorMap(card, map, fallback) {
  let best = fallback;
  let bestSpec = -1;
  for (const [selector, value] of Object.entries(map || {})) {
    if (!selectorMatches(card, selector)) continue;
    const spec = specificity(selector);
    if (spec >= bestSpec) {
      bestSpec = spec;
      best = value;
    }
  }
  return best;
}
