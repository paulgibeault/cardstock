// WHAT A PILE OF CARDS IS, AND HOW TO MEASURE A HAND OF THEM — the layer under
// the climbing template, its bot and its offer deal.
//
// Everything here is DECLARATION-DRIVEN and stateless: it reads `ctx.rules`
// (`combinations`, `matchShape`, `bombs`, `runExcludes`, `stripExcludes`,
// `runUpgrade`) and the pack's own rank ladder, and it writes nothing. What a
// combination IS, whether one beats another, and how many cards of a rank each
// sequence shape may use are questions both the rules and the bot ask in the
// same words, so they are answered in one place rather than twice.
//
// THIS IS THE `melds.js` OF THE CLIMBING GENRE (and it exists for the same
// reason): ./climbing.js is the rules, ./climbing-bot.js is the strategy, and a
// shared bottom layer is what lets the second one import the first's vocabulary
// without the two forming a cycle. Nothing here knows about the template object,
// the turn, or a move.

import { cardOrder, groupByRank, rankIndexOf, rankLadderOf, rankWindow } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { memoOnPack } from '../engine/templateKit.js';

/* ------------------------------------------------------------------ *
 * The declared combination vocabulary
 * ------------------------------------------------------------------ */

/**
 * `"single"`, `"quad"`, `"run(3+)"`, `"consecutive-pairs(3+)"` — a kind, and
 * optionally a size which may be an exact number or a floor.
 */
function parseShape(entry) {
  const m = /^([a-z][a-z-]*)(?:\((\d+)\+?\))?$/.exec(String(entry ?? ''));
  if (!m) return null;
  return { kind: m[1], size: m[2] === undefined ? null : Number(m[2]) };
}

/**
 * How many cards each fixed-size shape is made of. A pair is two of a rank
 * whatever the pack calls the game; a run's and a strip's sizes come from the
 * declaration, because those are the ones that vary.
 */
export const FIXED_SIZE = Object.freeze({ single: 1, pair: 2, triple: 3, quad: 4 });

/**
 * The pack's `rules.combinations`, resolved to `kind -> { min }`.
 *
 * Memoised on the PACK: the declaration is fixed once loaded, and this is asked
 * once per classification, which is once per enumerated move.
 *
 * A shape the pack does not declare is NOT A PLAY. That is the whole reason the
 * vocabulary is a manifest key rather than a constant — a Big Two pack that
 * drops the triple, or a President pack that adds a quintuple, changes this
 * list and nothing else.
 */
export function vocabularyOf(ctx) {
  return memoOnPack(ctx.pack, 'climbing:vocabulary', () => {
    const vocab = new Map();
    for (const entry of ctx.rules.combinations || []) {
      const shape = parseShape(entry);
      if (!shape) continue;
      vocab.set(shape.kind, { min: FIXED_SIZE[shape.kind] ?? shape.size ?? 1 });
    }
    return vocab;
  });
}

/**
 * A card a sequence may not contain — Thirteen's 2, which sits at the TOP of
 * the ladder and so has no neighbour above it and no business inside a run
 * (`rules.runExcludes: ["rank:2"]`).
 *
 * ONE EXCLUSION PER SEQUENCE SHAPE, because the two shapes disagree at exactly
 * one table and that table is a house rule people actually play (#158). "A 2
 * can end a run" is `Q-K-A-2`; it is NOT `2-2 A-A K-K`, which would make the
 * highest pair in the game bomb-eligible, and it is not a licence to redefine
 * the dragon (see `instantWinShape`). One key could not say that: dropping the
 * 2 from `runExcludes` to buy the run silently bought the strip and the dragon
 * as well. So `rules.runExcludes` governs runs, `rules.stripExcludes` governs
 * consecutive pairs, and a pack that plays the ordinary rule declares the same
 * list in both.
 *
 * @param kind 'run', 'consecutive-pairs', or null for "excluded from ANY
 *             sequence shape", which is the conservative reading the dragon is
 *             measured against.
 */
export function outOfSequence(ctx, card, kind = null) {
  const lists = kind === 'run' ? [ctx.rules.runExcludes]
    : kind === 'consecutive-pairs' ? [ctx.rules.stripExcludes]
      : [ctx.rules.runExcludes, ctx.rules.stripExcludes];
  for (const excludes of lists) {
    if (!excludes?.length) continue;
    if (excludes.some((selector) => selectorMatches(card, selector))) return true;
  }
  return false;
}

/**
 * THE ONE SUIT A RUN IS ALL OF, or null — the suited-run upgrade
 * (`rules.runUpgrade: "same-suit"`).
 *
 * A run is ordinarily compared by its top card alone and its suits are noise.
 * Under this rule a run of ONE suit is a different animal: playing one upgrades
 * the trick, and from that point on nothing but another run of one suit — same
 * length, higher top card — is a legal answer. So the suit is carried on the
 * combination, and the upgrade needs no trick var of its own: only a suited run
 * can answer a suited run, so the answer is itself suited and the rule holds
 * itself up for the rest of the trick.
 *
 * WHY IT IS `"same-suit"` RATHER THAN A BOOLEAN. The name says which property
 * the run has to be uniform in, and a pack that upgrades on something else (a
 * colour, a pack-defined tag) is the next value rather than a second key. A
 * pack that declares nothing gets no upgrade and every run in the game is
 * compared by its top card, which is what every other climbing pack expects.
 */
function suitOf(ctx, cards) {
  if (ctx.rules.runUpgrade !== 'same-suit') return null;
  const suit = cards[0]?.suit;
  if (suit == null) return null;
  return cards.every((card) => card.suit === suit) ? suit : null;
}

/**
 * WHAT THIS PILE OF CARDS IS, or null for a pile that is not a play.
 *
 * `size` is the shape's own unit, which is what `matchShape` compares and what
 * a `bombs` entry names: cards for a run, PAIRS for a strip of consecutive
 * pairs, and the fixed count for everything else. The kind disambiguates it, so
 * `consecutive-pairs(3)` is unambiguously three pairs and never three cards.
 *
 * `top` is the position of the highest card on the pack's TOTAL order — rank
 * first, suit as the tiebreak (#101's `cardOrder`). Every comparison in the
 * game is against this one number, including for a four of a kind, where
 * comparing top cards and comparing ranks are the same answer.
 */
export function classify(ctx, cardIds) {
  if (!Array.isArray(cardIds) || !cardIds.length) return null;
  if (new Set(cardIds).size !== cardIds.length) return null;
  const cards = cardIds.map((id) => ctx.cardById(id));
  if (cards.some((card) => !card)) return null;

  const vocab = vocabularyOf(ctx);
  const ladder = rankLadderOf(ctx.pack);
  const top = Math.max(...cards.map((card) => cardOrder(card, ladder)));
  const byRank = groupByRank(cards);
  const n = cards.length;

  // One rank: a single, a pair, a triple or a four of a kind.
  if (byRank.size === 1) {
    const kind = Object.keys(FIXED_SIZE).find((k) => FIXED_SIZE[k] === n);
    if (!kind || !vocab.has(kind)) return null;
    return { kind, size: n, top, cards: cardIds.slice() };
  }

  const indices = [...byRank.keys()].map((rank) => rankIndexOf(ladder, rank));
  if (indices.some((i) => i < 0)) return null;
  const window = rankWindow(indices);
  if (!window.ok) return null;

  // Distinct consecutive ranks, one card each: a run. The exclusion is asked
  // per SHAPE, so it is asked inside each branch rather than once above them.
  if (byRank.size === n) {
    if (cards.some((card) => outOfSequence(ctx, card, 'run'))) return null;
    const run = vocab.get('run');
    if (run && n >= run.min) {
      const combo = { kind: 'run', size: n, top, cards: cardIds.slice() };
      // THE ONE PROPERTY A RUN CARRIES BEYOND ITS TOP CARD — see `suitOf`.
      const suit = suitOf(ctx, cards);
      if (suit) combo.suit = suit;
      return combo;
    }
    return null;
  }

  // Distinct consecutive ranks, exactly two cards each: consecutive pairs.
  if (byRank.size * 2 === n && [...byRank.values()].every((group) => group.length === 2)) {
    if (cards.some((card) => outOfSequence(ctx, card, 'consecutive-pairs'))) return null;
    const strip = vocab.get('consecutive-pairs');
    const pairs = byRank.size;
    if (strip && pairs >= strip.min) {
      return { kind: 'consecutive-pairs', size: pairs, top, cards: cardIds.slice() };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Beating what is on the table
 * ------------------------------------------------------------------ */

/**
 * IN SHAPE: the same kind, the same size, strictly higher.
 *
 * `rules.matchShape` is what says so. `same-type-same-size` is the only answer
 * the template knows, and a pack that names another gets no in-shape answer at
 * all rather than a silent fallback to this one — a rule nobody implements
 * should refuse moves, not accept them (D-7 is exactly this: a five-card run is
 * not a legal answer to a four-card run, it is simply not an answer).
 */
export function beatsInShape(ctx, played, current) {
  if (ctx.rules.matchShape !== 'same-type-same-size') return false;
  if (played.kind !== current.kind || played.size !== current.size) return false;
  // THE UPGRADE (`suitOf`). `current.suit` is set on runs and on nothing else,
  // so this line is a run rule without saying the word: once the trick holds a
  // run of one suit, a mixed run of the same length is no longer an answer to
  // it however high it is. It does NOT have to be the same suit — the suit
  // ladder is part of the total order, so a suited run in hearts is simply
  // higher than one in spades and "higher" needs no second rule.
  if (current.suit && !played.suit) return false;
  return played.top > current.top;
}

/**
 * Does this `bombs` token describe `combo`?
 *
 * A token is a shape (`quad`, `consecutive-pairs(3)`), optionally narrowed by a
 * card selector after a colon (`single:rank:2` — a single 2, which is the card
 * the whole mechanic exists to kill), or the bare `*` for a bomb that chops
 * anything. The selector must match EVERY card, so `pair:rank:2` is a pair of
 * pigs and not a pig with a friend.
 */
export function tokenMatches(ctx, token, combo) {
  if (token === '*') return true;
  const at = String(token).indexOf(':');
  const shape = parseShape(at === -1 ? token : String(token).slice(0, at));
  if (!shape || shape.kind !== combo.kind) return false;
  if (shape.size !== null && shape.size !== combo.size) return false;
  if (at === -1) return true;
  const selector = String(token).slice(at + 1);
  return combo.cards.every((id) => selectorMatches(ctx.cardById(id), selector));
}

/* ------------------------------------------------------------------ *
 * The declared bomb ladder, as shapes
 * ------------------------------------------------------------------ */

/** Every shape a declared bomb can take, for a seat looking to chop. */
export function bombShapes(ctx) {
  const shapes = [];
  for (const bomb of ctx.rules.bombs || []) {
    const shape = parseShape(bomb.shape);
    if (shape) shapes.push({ kind: shape.kind, size: shape.size ?? FIXED_SIZE[shape.kind] ?? null });
  }
  return shapes;
}

/**
 * Is a combination of this kind and size a bomb?
 *
 * `size >=` rather than `===` because a strip of six consecutive pairs
 * CONTAINS the five-pair bomb the pack declared, and a hand holding one holds
 * the answer to a pig whether or not the whole thing is on the ladder.
 */
export function isBombShape(ctx, kind, size) {
  return bombShapes(ctx).some((shape) => shape.kind === kind
    && (shape.size === null || size >= shape.size));
}

/* ------------------------------------------------------------------ *
 * Counting a hand by rank, which is how a hand gets measured
 * ------------------------------------------------------------------ */

/**
 * Per ladder position: how many cards the hand holds there, and how many of
 * them each SEQUENCE SHAPE may use.
 *
 *   total  every card of that rank — what a pair, a triple or a quad counts
 *   run    the ones `rules.runExcludes` lets into a run
 *   strip  the ones `rules.stripExcludes` lets into consecutive pairs
 *   seq    the ones BOTH allow, which is what the dragon is measured against
 *
 * Three counters rather than one because the two exclusions can differ (#158's
 * "a 2 can end a run"), and one number could not have told the strip walk that
 * the run walk was allowed a card it is not.
 */
export function rankCounts(ctx, cardIds) {
  const ladder = rankLadderOf(ctx.pack);
  const counts = new Map();
  for (const id of cardIds) {
    const card = ctx.cardById(id);
    if (!card) continue;
    const at = rankIndexOf(ladder, card.rank);
    if (at < 0) continue;
    if (!counts.has(at)) counts.set(at, { total: 0, run: 0, strip: 0, seq: 0 });
    const entry = counts.get(at);
    entry.total += 1;
    // A card no run may contain (Thirteen's 2) counts toward a quad and a pair
    // and toward nothing that runs.
    const inRun = !outOfSequence(ctx, card, 'run');
    const inStrip = !outOfSequence(ctx, card, 'consecutive-pairs');
    if (inRun) entry.run += 1;
    if (inStrip) entry.strip += 1;
    if (inRun && inStrip) entry.seq += 1;
  }
  return counts;
}

/**
 * Spend `k` cards of one rank, `field` being the sequence counter the shape
 * that spent them was drawing from (null for a flat pair/triple/quad).
 *
 * The other counters fall to whatever is left, which is the "spend the cards a
 * sequence could not have used first" rule: a quad of 2s costs the hand no run
 * material, because none of those four cards was ever run material.
 */
export function takeFrom(entry, k, field = null) {
  entry.total = Math.max(0, entry.total - k);
  if (field) entry[field] = Math.max(0, entry[field] - k);
  for (const name of ['run', 'strip', 'seq']) entry[name] = Math.min(entry[name], entry.total);
}

/**
 * Maximal windows of CONSECUTIVE ladder positions holding at least `each`
 * cards apiece — the same question `classify` asks, over counts rather than
 * over card ids, because a hand being measured does not need the ids back.
 *
 * "Consecutive" is `rankWindow` (src/engine/cards.js) and not a hand-written
 * `at === last + 1` beside it: each group is grown for exactly as long as it
 * stays a window, so a maximal group here is a run there, by construction
 * rather than by two pieces of arithmetic agreeing.
 */
export function windows(counts, each, pick) {
  const positions = [...counts.keys()].sort((a, b) => a - b)
    .filter((at) => pick(counts.get(at)) >= each);
  const out = [];
  let group = [];
  for (const at of positions) {
    if (group.length && !rankWindow([...group, at]).ok) {
      out.push(group);
      group = [];
    }
    group.push(at);
  }
  if (group.length) out.push(group);
  return out;
}
