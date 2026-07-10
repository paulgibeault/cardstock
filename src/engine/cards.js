// Card/deck model. Card = { id, rank, suit, color, value, sortOrder, tags, effect, face }.
// Built-in decks + pack-supplied deck-file expansion (forEach Cartesian product).

import { selectorMatches } from './selectors.js';

export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function suitColor(suit) {
  return suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black';
}

export function buildStandardDeck(id, { jokers = 0, copies = 1 } = {}) {
  const cards = [];
  let sort = 0;
  for (let c = 0; c < copies; c++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        const base = `${suit}-${rank}`;
        const cardId = c === 0 ? base : `${base}#${c + 1}`;
        cards.push({
          id: cardId,
          rank,
          suit,
          color: suitColor(suit),
          value: null,
          sortOrder: sort++,
          tags: [],
          effect: null,
          face: 'auto',
        });
      }
    }
  }
  for (let j = 0; j < jokers; j++) {
    cards.push({
      id: j === 0 ? 'joker' : `joker#${j + 1}`,
      rank: 'joker',
      suit: null,
      color: null,
      value: null,
      sortOrder: sort++,
      tags: ['joker'],
      effect: null,
      face: 'auto',
    });
  }
  return { id, cards };
}

export function builtinDeckByName(name) {
  if (name === 'standard-52') return buildStandardDeck('standard-52');
  if (name === 'standard-54') return buildStandardDeck('standard-54', { jokers: 2 });
  const m = /^standard-52x(\d+)$/.exec(name);
  if (m) return buildStandardDeck(name, { copies: Number(m[1]) });
  return null;
}

function cartesian(varsMap) {
  const keys = Object.keys(varsMap || {});
  let result = [{}];
  for (const key of keys) {
    const next = [];
    for (const partial of result) {
      for (const val of varsMap[key]) next.push({ ...partial, [key]: val });
    }
    result = next;
  }
  return result;
}

function substituteString(str, combo, isValueField) {
  let out = str;
  let substituted = false;
  for (const [varName, val] of Object.entries(combo)) {
    const token = `$${varName}`;
    if (out.includes(token)) {
      out = out.split(token).join(val);
      substituted = true;
    }
  }
  if (isValueField && substituted) {
    const n = Number(out);
    if (!Number.isNaN(n)) return n;
  }
  return out;
}

function substituteDef(def, combo) {
  const out = {};
  for (const [k, v] of Object.entries(def)) {
    out[k] = typeof v === 'string' ? substituteString(v, combo, k === 'value') : v;
  }
  return out;
}

function autoId(def) {
  return [def.color ?? def.suit, def.rank].filter((x) => x !== undefined && x !== null).join('-');
}

// Expands a deck-file JSON (schema/deck.schema.json) into a flat card list,
// applying forEach Cartesian expansion and #2/#3/... instance ids for duplicate copies.
export function expandDeckFile(deckJson) {
  const cards = [];
  let sort = 0;
  for (const entry of deckJson.cards) {
    const count = entry.count ?? 1;
    const combos = entry.forEach ? cartesian(entry.forEach) : [{}];
    for (const combo of combos) {
      const def = substituteDef(entry.def, combo);
      const base = def.id ?? autoId(def);
      for (let copy = 0; copy < count; copy++) {
        const cardId = copy === 0 ? base : `${base}#${copy + 1}`;
        cards.push({
          id: cardId,
          rank: def.rank ?? null,
          suit: def.suit ?? null,
          color: def.color ?? null,
          value: def.value === undefined ? null : def.value,
          sortOrder: def.sortOrder ?? sort,
          tags: def.tags ?? [],
          effect: def.effect ?? null,
          face: def.face ?? 'auto',
        });
        sort++;
      }
    }
  }
  return { id: deckJson.id, cards };
}

export function applyCardTags(cards, cardTagsMap) {
  if (!cardTagsMap) return cards;
  return cards.map((card) => {
    let tags = card.tags;
    for (const [selector, extra] of Object.entries(cardTagsMap)) {
      if (selectorMatches(card, selector)) {
        tags = [...new Set([...tags, ...extra])];
      }
    }
    return tags === card.tags ? card : { ...card, tags };
  });
}
