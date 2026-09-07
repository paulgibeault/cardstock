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

/* ------------------------------------------------------------------ *
 * The rank ladder
 * ------------------------------------------------------------------ *
 *
 * ONE DECLARED ORDER PER PACK, RESOLVED ONCE.
 *
 * "What outranks what" used to be guessed twice, in two different places, and
 * both guesses were wrong on the deck four of the five packs ship. `rankOrder`
 * tried `Number(card.rank)` and the position in RANKS on ONE number line, so
 * the jack (RANKS index 9) tied the nine and the ten strictly outranked it —
 * in Hearts, ♥10 played before ♥J took the trick. `rankDomain`
 * (src/templates/melds.js) scanned `Number(card.rank)` alone, so no run window
 * on a standard 52 could contain a face card at all.
 *
 * Neither is a patch job, because the planned packs each want a DIFFERENT
 * order over the same 52 cards: Thirteen `3…A 2`, Pinochle `9 J Q K 10 A`,
 * Cribbage `A 2…K`, Poker with the ace low again in a wheel. By the extension
 * policy (CARD_PLATFORM_DESIGN.md §13), a thing several templates need is an
 * engine primitive — so the pack declares the order and the engine resolves it
 * here, once, memoised on the pack.
 *
 * WHERE IT IS DECLARED: at the ROOT of the manifest, beside `deck`, not inside
 * `rules`. `rules` is refined per template by four closed `$defs.rules-*`
 * blocks, and a key every template shares would have to be repeated in all
 * four. It is also not a template parameter: it is a fact about the deck, in
 * the same class as `deck` itself, and it is read by the engine rather than by
 * any one template. See the `rankLadder` description in
 * schema/manifest.schema.json.
 *
 * WHAT A PACK THAT DECLARES NOTHING GETS: an order derived from its deck, in
 * three tiers — numeric ranks ascending, then the ranks named in the standard
 * RANKS ladder, then everything else in deck (`sortOrder`) order. The tiers are
 * stacked rather than merged onto one number line, which is precisely the bug:
 * the jack now sits above the ten instead of on top of the nine.
 *
 * `sortOrder` is deliberately the LAST of the three rather than the first: it
 * is deck order, which for a standard 52 is suit-major, so preferring it would
 * make the ace of clubs a lower card than the two of diamonds everywhere the
 * comparison crosses suits (pass selection, the bot's "play low").
 *
 * Every current pack keeps the order it had: Milestones and Stockpile are
 * ranked 1–12 and stay in tier one, their `skip`/`wild` cards stay above the
 * numbers in tier three, and Wildfire's 0–9 plus action cards do the same. The
 * only movement anywhere is the one this exists to fix — J and Q climbing above
 * the 10 on `standard-52`.
 */

/** A rank the ladder does not name. Below every card that has a place on it. */
const OFF_LADDER = -1;

const RANK_LADDERS = new WeakMap();

const EMPTY_LADDER = Object.freeze({
  ranks: Object.freeze([]),
  rankIndex: new Map(),
  suits: null,
  suitIndex: null,
});

function ladderTier(rank) {
  if (rank === '' || rank === null || rank === undefined) return null;
  if (Number.isFinite(Number(rank))) return 0;
  return RANKS.indexOf(String(rank)) !== -1 ? 1 : 2;
}

/** Distinct ranks of a deck, ordered by the three-tier default above. */
function deckDerivedRanks(cards) {
  const seen = new Map(); // String(rank) -> { rank, tier, within }
  let n = 0;
  for (const card of cards) {
    const rank = card?.rank;
    const tier = ladderTier(rank);
    if (tier === null) continue;
    const key = String(rank);
    if (seen.has(key)) continue;
    const within = tier === 0 ? Number(rank)
      : tier === 1 ? RANKS.indexOf(key)
        : (typeof card.sortOrder === 'number' ? card.sortOrder : n);
    seen.set(key, { rank, tier, within });
    n++;
  }
  return [...seen.values()]
    .sort((a, b) => a.tier - b.tier || a.within - b.within)
    .map((e) => e.rank);
}

function indexOfEach(values) {
  const index = new Map();
  values.forEach((value, i) => {
    if (!index.has(value)) index.set(value, i);
    // Ranks reach this map from two directions — a card's own `rank` and a
    // wild's frozen `{ rank }`, which is always written as a string. Both
    // spellings are registered so the hot path is one lookup and never a
    // String() allocation.
    const asString = String(value);
    if (!index.has(asString)) index.set(asString, i);
  });
  return index;
}

/**
 * The pack's ladder: `{ ranks, rankIndex, suits, suitIndex }`, low to high.
 *
 * Memoised on the PACK, which is what it is a fact about — the deck and its
 * declaration are both fixed once loaded, and this sweeps every card.
 *
 * A declared `rankLadder` names the ranks that are ORDERED. Any rank the deck
 * holds that the declaration does not name is placed BELOW the whole ladder (in
 * default order among themselves) rather than above it: a card nobody gave a
 * place to should not win a trick. Nothing is dropped, so the order stays
 * injective over the deck.
 *
 * `suitLadder` is the optional tiebreak that makes the order over the deck
 * TOTAL — Thirteen's "play higher or pass" has no answer for a tie. No template
 * consumes it yet (that is #102); `cardOrder` below is where it is read.
 */
export function rankLadderOf(pack) {
  if (!pack || typeof pack !== 'object') return EMPTY_LADDER;
  let ladder = RANK_LADDERS.get(pack);
  if (ladder) return ladder;

  const cards = pack.cardsById ? [...pack.cardsById.values()] : [];
  const declaredRanks = pack.rankLadder ?? pack.manifest?.rankLadder ?? null;
  const declaredSuits = pack.suitLadder ?? pack.manifest?.suitLadder ?? null;

  let ranks;
  if (Array.isArray(declaredRanks) && declaredRanks.length) {
    const named = new Set(declaredRanks.map((r) => String(r)));
    const unnamed = deckDerivedRanks(cards).filter((r) => !named.has(String(r)));
    ranks = [...unnamed, ...declaredRanks];
  } else {
    ranks = deckDerivedRanks(cards);
  }

  const suits = Array.isArray(declaredSuits) && declaredSuits.length ? declaredSuits.slice() : null;
  ladder = Object.freeze({
    ranks: Object.freeze(ranks),
    rankIndex: indexOfEach(ranks),
    suits: suits && Object.freeze(suits),
    suitIndex: suits ? indexOfEach(suits) : null,
  });
  RANK_LADDERS.set(pack, ladder);
  return ladder;
}

/** Where `rank` sits on `ladder`, or −1 for a rank it does not name. */
export function rankIndexOf(ladder, rank) {
  const i = ladder?.rankIndex.get(rank);
  return i === undefined ? OFF_LADDER : i;
}

/** The rank at position `i`, for turning a derived run slot back into a card. */
export function rankAt(ladder, i) {
  return ladder?.ranks[i];
}

/**
 * Where a card sits on its pack's ladder, for "who wins the trick" and "what
 * are my highest cards". One Map lookup: this is on the trick-resolution and
 * bot paths, and `ladder` is resolved once per caller, not once per card.
 *
 * Called WITHOUT a ladder it answers from the card alone, because there is no
 * pack to ask: numeric rank, then the standard ladder offset above every
 * plausible numeric rank, then `sortOrder` offset above that. Same three tiers
 * as the deck-derived default and stacked the same way, so the standalone
 * helper is monotonic too — it just cannot know a pack's declared order.
 */
export function rankOrder(card, ladder) {
  if (!card) return OFF_LADDER;
  if (ladder) return rankIndexOf(ladder, card.rank);
  const n = Number(card.rank);
  if (card.rank !== '' && card.rank !== null && card.rank !== undefined && Number.isFinite(n)) return n;
  const i = RANKS.indexOf(card.rank);
  if (i !== -1) return 100 + i;
  return typeof card.sortOrder === 'number' ? 200 + card.sortOrder : OFF_LADDER;
}

/**
 * A TOTAL order over the deck: rank first, the declared suit ladder as the
 * tiebreak. Without a `suitLadder` this is `rankOrder` — a pack that does not
 * rank its suits has ties, and pretending otherwise would invent an order the
 * pack never declared.
 */
export function cardOrder(card, ladder) {
  const rank = rankOrder(card, ladder);
  const suits = ladder?.suits;
  if (!suits) return rank;
  const suit = ladder.suitIndex.get(card?.suit);
  return rank * suits.length + (suit === undefined ? OFF_LADDER : suit);
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
