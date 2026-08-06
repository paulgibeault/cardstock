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

/**
 * ONE NOTION OF "WILD", for the three that had grown apart.
 *
 * shedding asked the EFFECT (`type === 'wild' || 'wildDrawN'`), contract-rummy
 * asked a TAG (`rules.wilds.tag`), and sequencing asked the same tag through a
 * selector. Three predicates, three spellings, and no way for a pack to be wild
 * in a template that happened to ask the other question.
 *
 * Both questions are now asked, in that order, so every existing pack answers
 * exactly as it did: a card is wild if the pack's `wilds` spec tags it, or if
 * it carries a wild effect.
 *
 * @param wilds the template's `rules.wilds` spec ({ tag }), or undefined.
 */
export function isWild(card, wilds) {
  if (!card) return false;
  const tag = wilds?.tag;
  if (tag && Array.isArray(card.tags) && card.tags.includes(tag)) return true;
  const type = typeof card.effect === 'string' ? card.effect : card.effect?.type;
  return type === 'wild' || type === 'wildDrawN';
}

/**
 * Every distinct non-null value of one attribute across a deck, in deck order.
 *
 * "The colours this deck actually has" was enumerated in this exact shape in
 * three places — shedding's colour chooser, contract-rummy's wild-hit values,
 * and (as a hardcoded list of four French suits) the platform's chooser.
 */
export function distinctValues(cardsById, attr) {
  const seen = [];
  for (const card of cardsById.values()) {
    const value = card?.[attr];
    if (value === null || value === undefined || seen.includes(value)) continue;
    seen.push(value);
  }
  return seen;
}

/**
 * Where a card sits on its deck's ladder, for "who wins the trick" and "what
 * are my highest cards".
 *
 * Standard-52's RANKS array was the ONLY answer, hardcoded into trick
 * resolution, pass selection and the bot — which is a claim about the deck that
 * two of the five packs cannot make.
 *
 * The order tried is numeric rank, then the standard ladder, then `sortOrder`.
 * `sortOrder` is deliberately LAST rather than first: it is deck order, which
 * for a standard 52 is suit-major, so preferring it would make the ace of clubs
 * a lower card than the two of diamonds everywhere the comparison crosses
 * suits (pass selection, the bot's "play low"). Within one suit — which is the
 * only comparison trick resolution makes — all three agree.
 */
export function rankOrder(card) {
  if (!card) return -1;
  const n = Number(card.rank);
  if (Number.isFinite(n)) return n;
  const i = RANKS.indexOf(card.rank);
  if (i !== -1) return i;
  return typeof card.sortOrder === 'number' ? card.sortOrder : -1;
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
