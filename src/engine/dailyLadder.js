// THE DAILY RUN'S LADDER: ten contracts derived from a date, not authored.
//
// Milestones ships one fixed ladder (packs/milestones/manifest.json
// `rules.contracts`). This module generates a DIFFERENT one for every calendar
// day, out of the same grammar — `set(n)`, `run(n)`, `colorGroup(n)` — so the
// puzzle changes daily while every rule that judges a lay-down stays exactly
// the one the pack already declared.
//
// PURE, AND DERIVED RATHER THAN STORED. The whole day is a function of the seed
// string (`milestones|2026-09-10`): the ladder AND the deal. Nothing about the
// generated ladder is persisted with the match — a resume re-derives it from
// the seed the save already carries (src/engine/replay.js serializeMatch keeps
// `{seed, variants, …}` untouched, so no format bump was needed). Two devices
// on the same date therefore see the same ten rungs and the same hands, and a
// save written this morning still replays this evening.
//
// WHY IT IMPORTS ../templates/melds.js. The grammar a generated rung is written
// in has to be the grammar the table enforces, or the generator is free to emit
// a contract no hand can satisfy. `parseItem`, `rankDomain`, `isWildCard` and
// `isMeldable` are therefore the template's own, not a second copy that could
// drift; src/engine/packLoader.js already reaches into src/templates for
// `getTemplate`, so the direction is established. Nothing in src/templates
// imports this file, so there is no cycle.
//
// FEASIBILITY IS PROVEN, NOT ASSUMED. Every rung this module returns has had a
// concrete lay-down found for it in the pack's actual deck (`findDeckLayDown`),
// which is what stops a day from shipping a `run(11)` on a ten-card deal or a
// `set(9)` on a deck with eight copies of a rank. The test suite takes the
// lay-down one step further and pushes it through `resolveMeld` — the same door
// a human's cards go through.

import { makeRng, dailyDateStr } from './arcade-rng.js';
import { rankLadderOf, rankIndexOf } from './cards.js';
import { isWildCard, isMeldable, rankDomain, parseItem } from '../templates/melds.js';

/** How many rungs a generated ladder has — the shipped ladder's count. */
export const DAILY_RUNGS = 10;

/**
 * How many distinct rung SHAPES a day must offer.
 *
 * A ladder of ten near-identical rungs is a worse puzzle than the fixed one it
 * replaces, and the seeded stream will produce one eventually. Four is the bar
 * the issue set; the relaxation ladder in `dailyLadder` only drops below it
 * after the generator has failed to reach it many times over, which no date in
 * the three years the tests sweep ever does.
 */
export const MIN_DISTINCT_SHAPES = 4;

/**
 * The size range each shape is written in, before the deck and the deal narrow
 * it further.
 *
 *   set          2 is in the shipped ladder (`set(5) set(2)`) and is the one
 *                genuinely small meld worth asking for; above 6 a set is
 *                asking for most of the copies of one rank AND most of the
 *                hand, which is a rung nobody finishes.
 *   run          3 up. A run of 2 is a pair of neighbours, which is not a
 *                shape a player would call a run.
 *   colorGroup   4 up. A colour group is the loosest shape in the grammar —
 *                any cards of one colour — so a small one is free, and free is
 *                not a contract.
 */
const ITEM_RANGE = {
  set: { min: 2, max: 6 },
  run: { min: 3, max: 9 },
  colorGroup: { min: 4, max: 8 },
};

/** The order two items of the same size are written in, so a rung prints canonically. */
const KIND_ORDER = ['set', 'run', 'colorGroup'];

/** The smallest and largest a whole rung may be, before the deal caps it. */
const TOTAL_FLOOR = 5;
const TOTAL_CEILING = 9;

/**
 * One day in four asks every meld for a second natural card.
 *
 * The only rule knob the generator turns, and it is turned because the template
 * already enforces it (`checkMeldQuota`) — extending the grammar to something
 * the template cannot police would be inventing a rule, not a puzzle. It
 * changes lay-downs and hits alike, which is the point: a two-naturals day is
 * a day the eight wilds stop being a substitute for having the cards.
 */
const TWO_NATURALS_ODDS = 0.25;

/* ------------------------------------------------------------------ *
 * The seed
 * ------------------------------------------------------------------ */

/** A YYYY-MM-DD string, or null. Structural: this reaches a storage key. */
export function isDailyDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The day's seed: `<packId>|<YYYY-MM-DD>`, on the player's own calendar.
 *
 * DEVICE-LOCAL, which is the platform rule (`dailyDateStr` says why): a daily
 * rolls at the player's midnight, not at UTC's. It seeds the ladder AND the
 * deal, so "the same puzzle everywhere" is one string rather than two
 * agreements.
 *
 * @param date a Date, a YYYY-MM-DD string, or nothing for today.
 */
export function dailySeedFor(packId, date) {
  const day = isDailyDate(date) ? date : dailyDateStr(date);
  return `${packId}|${day}`;
}

/** The calendar day a `dailySeedFor` string names, or null for anything else. */
export function dateOfDailySeed(seed) {
  if (typeof seed !== 'string') return null;
  const day = seed.slice(seed.indexOf('|') + 1);
  return isDailyDate(day) ? day : null;
}

/** The calendar day before `dateStr`. Date-only arithmetic, so UTC is safe here. */
export function previousDate(dateStr) {
  if (!isDailyDate(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() - 1);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}`;
}

/* ------------------------------------------------------------------ *
 * What the deck can actually supply
 * ------------------------------------------------------------------ */

/**
 * The pack's deck, reduced to the three questions a contract asks of it: which
 * rank positions a run may sit on, how many copies of a rank a set can draw
 * from, and how many cards of a colour a colour group can.
 *
 * Built through the TEMPLATE's own predicates (`rankDomain`, `isWildCard`,
 * `isMeldable`), which take a `{ pack, rules }` shim and nothing else — so what
 * this believes about the deck is what `resolveMeld` believes about it. Wilds
 * are excluded on purpose: a wild can stand in for a missing card at the table,
 * but a rung whose feasibility DEPENDS on one is a rung that becomes impossible
 * the moment the eight of them are elsewhere.
 */
export function deckProfile(pack) {
  const ctx = { pack, rules: pack.rules || {} };
  const ladder = rankLadderOf(pack);
  const domain = rankDomain(ctx);

  const byPosition = new Map();   // ladder index -> [cardId, ...]
  const byRank = new Map();       // rank string  -> [cardId, ...]
  const byColor = new Map();      // colour       -> [cardId, ...]
  let wilds = 0;

  for (const card of pack.cardsById.values()) {
    if (isWildCard(ctx, card)) { wilds++; continue; }
    if (!isMeldable(ctx, card)) continue;
    const at = rankIndexOf(ladder, card.rank);
    if (at < domain.min || at > domain.max) continue;
    if (!byPosition.has(at)) byPosition.set(at, []);
    byPosition.get(at).push(card.id);
    const rank = String(card.rank);
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(card.id);
    if (card.color === null || card.color === undefined) continue;
    if (!byColor.has(card.color)) byColor.set(card.color, []);
    byColor.get(card.color).push(card.id);
  }

  // The longest window every one of whose positions holds at least one card.
  // Derived rather than assumed: a deck missing a rank in the middle of its own
  // ladder would otherwise be told it can run straight through the hole.
  let longestWindow = 0;
  let window = 0;
  for (let at = domain.min; at <= domain.max; at++) {
    window = byPosition.has(at) ? window + 1 : 0;
    if (window > longestWindow) longestWindow = window;
  }

  const maxOfARank = Math.max(0, ...[...byRank.values()].map((ids) => ids.length));
  const maxOfAColor = Math.max(0, ...[...byColor.values()].map((ids) => ids.length));

  return {
    domain,
    byPosition,
    byRank,
    byColor,
    wilds,
    limits: {
      set: maxOfARank,
      run: longestWindow,
      colorGroup: maxOfAColor,
    },
  };
}

/**
 * A CONCRETE LAY-DOWN for `items` in this deck, or null if there is none.
 *
 * The proof behind every rung the generator emits. Ordered run-first because a
 * run is the only shape that needs a particular rank rather than merely enough
 * of something, then backtracking over the choice each item has (which window,
 * which rank, which colour) with the cards already spoken for held out.
 *
 * The cards inside one choice are taken greedily, which is exact here and is
 * worth saying why: a whole contract is at most the deal, and every bucket this
 * draws from is far deeper than that (Milestones has eight copies of each rank
 * and twenty-four cards of each colour against a nine-card ceiling), so a
 * greedy take can never exhaust a bucket another item needed. The test pushes
 * every returned lay-down through `resolveMeld` rather than taking this on
 * trust.
 *
 * @returns [{ item, kind, n, cards: [cardId, ...] }, ...] | null
 */
export function findDeckLayDown(profile, items) {
  const parsed = [];
  for (const item of items) {
    const p = parseItem(item);
    if (!p || !(p.n > 0)) return null;
    parsed.push({ item, kind: p.kind, n: p.n });
  }
  // Most constrained first — a run wants a particular rank at every slot, a set
  // wants enough of one rank, a colour group will take anything of a colour.
  // Decorated with the original index so the order is stable and the returned
  // lay-down still lines up with the items it was asked for.
  const CONSTRAINT = { run: 0, set: 1, colorGroup: 2 };
  const order = parsed
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (CONSTRAINT[a.p.kind] ?? 3) - (CONSTRAINT[b.p.kind] ?? 3) || a.i - b.i);

  const taken = new Set();
  const solved = new Array(parsed.length).fill(null);

  const freeFrom = (ids, n) => {
    const out = [];
    for (const id of ids) {
      if (taken.has(id)) continue;
      out.push(id);
      if (out.length === n) return out;
    }
    return null;
  };

  const choicesFor = ({ kind, n }) => {
    if (kind === 'set') {
      return [...profile.byRank.values()].map((ids) => freeFrom(ids, n)).filter(Boolean);
    }
    if (kind === 'colorGroup') {
      return [...profile.byColor.values()].map((ids) => freeFrom(ids, n)).filter(Boolean);
    }
    if (kind === 'run') {
      const out = [];
      for (let start = profile.domain.min; start + n - 1 <= profile.domain.max; start++) {
        const cards = [];
        for (let at = start; at < start + n; at++) {
          const one = freeFrom(profile.byPosition.get(at) || [], 1);
          if (!one) { cards.length = 0; break; }
          cards.push(one[0]);
        }
        if (cards.length === n) out.push(cards);
      }
      return out;
    }
    return [];
  };

  const place = (k) => {
    if (k === order.length) return true;
    const { p, i } = order[k];
    for (const cards of choicesFor(p)) {
      for (const id of cards) taken.add(id);
      solved[i] = { item: p.item, kind: p.kind, n: p.n, cards };
      if (place(k + 1)) return true;
      for (const id of cards) taken.delete(id);
      solved[i] = null;
    }
    return false;
  };

  return place(0) ? solved : null;
}

/* ------------------------------------------------------------------ *
 * How hard a rung is
 * ------------------------------------------------------------------ */

/**
 * THE DIFFICULTY MEASURE, stated once so the ladder can be asserted against it:
 * `[total cards, longest run, longest set]`, compared lexicographically.
 *
 * Total cards first because that is what a rung costs out of a ten-card hand,
 * and it is the number a player feels. Run length is the tiebreak because a run
 * is the shape the deck makes scarce — it wants a particular rank at every slot,
 * where a colour group of the same size will take anything of one colour — so
 * `run(7)` sits above `colorGroup(7)` at equal cost. Set length breaks what is
 * left, which separates `set(4) set(3)` from `colorGroup(4) run(3)`.
 *
 * It is a ranking, not a win probability. What it has to be is TOTAL, cheap and
 * defensible, so "the ladder gets harder" is a property a test can hold the
 * generator to instead of a claim in a comment.
 */
export function contractCost(items) {
  let cards = 0;
  let longestRun = 0;
  let longestSet = 0;
  for (const item of items) {
    const p = parseItem(item);
    if (!p) continue;
    cards += p.n;
    if (p.kind === 'run') longestRun = Math.max(longestRun, p.n);
    if (p.kind === 'set') longestSet = Math.max(longestSet, p.n);
  }
  return [cards, longestRun, longestSet];
}

/** Lexicographic over `contractCost`. Negative when `a` is the easier rung. */
export function compareContracts(a, b) {
  const ca = contractCost(a);
  const cb = contractCost(b);
  for (let i = 0; i < ca.length; i++) {
    if (ca[i] !== cb[i]) return ca[i] - cb[i];
  }
  return 0;
}

/** The canonical spelling of a rung, which is also its identity for distinctness. */
export function rungSignature(items) {
  return items.join(' ');
}

/**
 * CAN A HAND EVER BE TALKED INTO THIS RUNG — which is not the question
 * `findDeckLayDown` answers.
 *
 * Feasibility says the deck HOLDS a lay-down. It says nothing about whether
 * eleven cards ever become one, and a rung nobody lays down is a hand that never
 * ends: four seats draw and discard until the move cap, with no lay-down and no
 * one going out. That was the one failure mode the generated ladders had and the
 * shipped ladder does not, and it comes in exactly two shapes.
 *
 * MEASURED, not guessed. All 79 rung shapes the generator emits over a year were
 * played as a hand EVERY SEAT IS ON — four seats, the same 4000-move-per-round
 * cap tools/simulate.mjs uses — 50 hands each, and the twenty-three shapes that
 * looked marginal again at 300. Only these ever failed to finish:
 *
 *     run(6) set(3)        25/50      run(5) set(3)        46/50
 *     run(5) set(4)        42/50      run(4) set(3)        48/50
 *     run(5) set(2) set(2) 48/50      set(5)              297/300
 *                                     set(6)              299/300
 *
 * Everything else — including `set(6) set(3)`, `run(4) run(4)`, `colorGroup(8)`
 * and `run(9)` — finished every hand of 300.
 *
 * ONE: A LONG RUN AND A REAL SET PULL OPPOSITE WAYS. A run wants a different rank
 * at every slot and a set wants the same rank over and over, so a seat owing
 * `run(6) set(3)` must hold nine of its eleven cards in two shapes that disagree
 * about what a good card is. `run(7) set(2)`, `run(5) run(4)` and `run(3) set(6)`
 * are all still on the table — a colour group asks about colour and says nothing
 * about ranks, so it conflicts with neither.
 *
 * TWO: A RUNG THAT IS ONE SET AND NOTHING ELSE. Laying down is only half of a
 * hand; somebody has to GO OUT, and going out means shedding the rest of the
 * hand onto what is on the felt. A run takes cards at both ends and a colour
 * group takes anything of its colour, but a set of sixes only ever takes another
 * six — and there are eight in the deck, five or six of which are already in the
 * meld. A lone `set(5)` is therefore the least absorbent felt in the game AND
 * the one that leaves the most cards to get rid of, which is why it is the only
 * single-meld rung that ever stalls. Two sets are fine: `set(6) set(3)` puts two
 * targets down and leaves two cards to shed.
 *
 * WHAT ONE IS REALLY A STATEMENT ABOUT is the table's bot: `keepValue` in
 * src/templates/contract-rummy-bot.js grades a card by a contract's appetites
 * BLENDED in proportion to the cards they owe, so a mixed run/set rung has it
 * half-collecting two things and finishing neither. Teaching it to commit is a
 * change to that file, which #160 owns; until then the generator does not write
 * a rung the table cannot play. The pack's own ladder still ships `set(3) run(4)`
 * and `set(4) run(4)` and is untouched — a fixed ladder is ten rungs a human
 * read, and seats spread across it long before they reach those.
 */
export function isPlayableRung(items) {
  let longestRun = 0;
  let setCards = 0;
  let melds = 0;
  let sets = 0;
  for (const item of items) {
    const p = parseItem(item);
    // `parseItem` parses the SPELLING, not the vocabulary — `nonsense(3)` comes
    // back as a kind like any other. A rung is only playable if every meld in it
    // is a shape the grammar has.
    if (!p || !KIND_ORDER.includes(p.kind) || !(p.n > 0)) return false;
    melds++;
    if (p.kind === 'run') longestRun = Math.max(longestRun, p.n);
    if (p.kind === 'set') { setCards += p.n; sets++; }
  }
  if (!melds) return false;
  if (longestRun >= 4 && setCards >= 3) return false;
  if (melds === 1 && sets === 1) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * The generator
 * ------------------------------------------------------------------ */

function sortItems(items) {
  return items.slice().sort((a, b) => {
    const pa = parseItem(a);
    const pb = parseItem(b);
    return pb.n - pa.n || KIND_ORDER.indexOf(pa.kind) - KIND_ORDER.indexOf(pb.kind);
  });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** The shapes a meld of exactly `size` cards could be, given what the deck holds. */
function kindsForSize(size, limits) {
  return KIND_ORDER.filter((kind) => {
    const range = ITEM_RANGE[kind];
    return size >= range.min && size <= Math.min(range.max, limits[kind] ?? 0);
  });
}

/**
 * A partition of `total` into `parts` pieces, from the stream.
 *
 * The floor is normally 3 and only sometimes 2, which is a correction rather
 * than a preference: `set` is the ONLY shape that accepts two cards, so every
 * size-2 piece becomes a `set(2)` — and a uniform partition made two thirds of
 * the ladder read "something, plus a pair". A `set(2)` is still in the grammar
 * (the shipped ladder has one) and still turns up; it is no longer the default
 * way a rung ends.
 */
function partition(rng, total, parts) {
  const floor = (total >= 3 * parts && rng() < 0.65) ? 3 : 2;
  const sizes = [];
  let left = total;
  for (let i = 0; i < parts - 1; i++) {
    const remaining = parts - 1 - i;
    const size = rng.int(floor, left - floor * remaining);
    sizes.push(size);
    left -= size;
  }
  sizes.push(left);
  return sizes;
}

/**
 * One rung of exactly `total` cards that the deck can actually supply, or null
 * after `tries` goes from the stream.
 *
 * Item count is weighted rather than uniform: two melds is the shape the fixed
 * ladder is mostly written in and the one that reads best on the contract strip,
 * one meld is where the long runs and the big colour groups live, and three is
 * the occasional busy day.
 */
function rollRung(rng, total, profile, tries = 24) {
  const limits = profile.limits;
  for (let attempt = 0; attempt < tries; attempt++) {
    const roll = rng();
    const wanted = roll < 0.30 ? 1 : (roll < 0.88 ? 2 : 3);
    // THREE MELDS ONLY ON A BIG RUNG. Below eight cards the only partition into
    // three is pairs, and `set` is the only shape that takes a pair — so every
    // small three-part rung came out as `set(2) set(2) set(2)`, which then
    // turned up on most days. Held to eight and up, a three-meld rung is the
    // busy day it was meant to be (`run(3) run(3) set(2)`, `set(4) set(2) set(2)`).
    const cap = total >= 8 ? 3 : (total >= 4 ? 2 : 1);
    const parts = Math.max(1, Math.min(wanted, cap));
    const sizes = partition(rng, total, parts);
    const items = [];
    let ok = true;
    for (const size of sizes) {
      const kinds = kindsForSize(size, limits);
      if (!kinds.length) { ok = false; break; }
      items.push(`${rng.pick(kinds)}(${size})`);
    }
    if (!ok) continue;
    const sorted = sortItems(items);
    // Two doors, and they answer different questions: can the DECK supply this,
    // and can a HAND ever be talked into it. See isPlayableRung.
    if (!isPlayableRung(sorted)) continue;
    if (!findDeckLayDown(profile, sorted)) continue;
    return sorted;
  }
  return null;
}

/**
 * The day's ladder: ten rungs, rising, drawn from `seed`.
 *
 * @param seed  any string — `dailySeedFor(packId, date)` in the game.
 * @param deck  a `deckProfile(pack)`.
 * @param deal  how many cards a hand is dealt.
 * @param wilds the pack's `rules.wilds`, whose `minNaturals` this may raise.
 * @returns { date?: never, contracts: string[][], wilds: { minNaturals } }
 *
 * THE LADDER IS SORTED BEFORE IT IS RETURNED, not generated in order. Rung sizes
 * come out of the stream as a rising-but-wobbly sequence and are sorted, so the
 * only thing the final sort can reorder is rungs of equal size — which is
 * exactly where the run/set tiebreaks belong.
 *
 * NOTHING IN A RUNG MAY COST THE WHOLE DEAL. A contract summing to `deal` is one
 * a player lays down and goes out on the same turn (lay down ten of eleven,
 * discard the eleventh), which is not a rung so much as a coin flip on who drew
 * it first. The ceiling is `deal - 1`.
 */
export function dailyLadder(seed, { deck, deal, wilds } = {}) {
  if (!deck || !deck.limits) throw new Error('dailyLadder: a deckProfile is required');
  const rng = makeRng(seed);
  const ceiling = Math.min(TOTAL_CEILING, Math.max(2, (Number(deal) || TOTAL_CEILING + 1) - 1));
  const floor = Math.min(TOTAL_FLOOR, ceiling);

  const minNaturals = rng() < TWO_NATURALS_ODDS ? 2 : 1;

  // Read once, before the rungs, so the wild rule and the sizes always take the
  // same two draws from the stream whatever the retry loop below does.
  const lo = clamp(rng.int(floor, floor + 1), floor, ceiling);
  const hi = clamp(rng.int(Math.max(lo, ceiling - 1), ceiling), lo, ceiling);

  // AT MOST FOUR RUNGS MAY COST THE SAME. The jitter above will happily put five
  // or six rungs on one size, and the smallest size is the one with the least to
  // say: at five cards the whole grammar offers four rungs — `run(5)`,
  // `colorGroup(5)`, `set(3) set(2)`, `run(3) set(2)` — so a day that spends six
  // of its ten there cannot avoid printing the same contract twice in a row, and
  // the retry loop below would grind through every attempt it has discovering
  // that. Four fits what the narrowest size can supply and still leaves the
  // ladder its shape. `hi` is always at least two above `lo`, so three sizes at
  // four apiece is more room than ten rungs need.
  const MAX_PER_TOTAL = 4;
  const totals = [];
  const perTotal = new Map();
  for (let i = 0; i < DAILY_RUNGS; i++) {
    const base = lo + (hi - lo) * (i / (DAILY_RUNGS - 1));
    let total = clamp(Math.round(base) + rng.int(-1, 1), lo, hi);
    // Full: step outward from the size the jitter wanted, nearest first, so a
    // displaced rung lands beside where it belonged rather than at an end.
    for (let step = 1; (perTotal.get(total) || 0) >= MAX_PER_TOTAL && step <= hi - lo; step++) {
      for (const candidate of [total + step, total - step]) {
        if (candidate < lo || candidate > hi) continue;
        if ((perTotal.get(candidate) || 0) < MAX_PER_TOTAL) { total = candidate; break; }
      }
    }
    perTotal.set(total, (perTotal.get(total) || 0) + 1);
    totals.push(total);
  }
  totals.sort((a, b) => a - b);

  // GRADUATED RELAXATION rather than a throw the first time a day is dull. The
  // bar is four distinct shapes and no two identical rungs side by side; if the
  // stream will not produce that, the requirement is stepped down before the
  // day is abandoned. Almost every date is done on the first attempt, but a
  // generator that can refuse to produce a day is a generator that takes the
  // daily down on a date nobody chose.
  //
  // THE BUDGET IS LARGE BECAUSE A CHEAP DAY IS A NARROW DAY. A ladder whose
  // rungs all cost five cards has four shapes to draw from — `run(5)`,
  // `colorGroup(5)`, `set(3) set(2)`, `run(3) set(2)` — and once four rungs of
  // that size land in one ladder, the chance that no two of them come out the
  // same is about one in fifteen. At eighty attempts that left roughly one date
  // a year (2026-01-20 was the one) relaxing all the way to "repeats allowed";
  // the number below costs nothing on an ordinary day, because the loop stops
  // the moment a ladder passes.
  const MAX_ATTEMPTS = 240;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wantDistinct = attempt < 120 ? MIN_DISTINCT_SHAPES
      : (attempt < 180 ? 3 : (attempt < 210 ? 2 : 1));
    const contracts = [];
    for (const total of totals) {
      const rung = rollRung(rng, total, deck);
      if (!rung) break;
      contracts.push(rung);
    }
    if (contracts.length !== DAILY_RUNGS) continue;

    contracts.sort(compareContracts);
    const signatures = contracts.map(rungSignature);
    if (new Set(signatures).size < wantDistinct) continue;
    if (attempt < 210 && signatures.some((sig, i) => i > 0 && sig === signatures[i - 1])) continue;

    return {
      contracts,
      wilds: { ...(wilds || {}), minNaturals },
    };
  }

  throw new Error(`dailyLadder: no ladder for seed "${seed}"`);
}

/**
 * The pack, rewritten to play today's ladder.
 *
 * MUTATES, and the pack it is handed is always a private one — `fetchPack`
 * clones the cached manifest for every caller (src/ui/packSource.js) and
 * tools/simulate.mjs clones before `loadPack`. `pack.rules` IS
 * `pack.manifest.rules`, so one write moves both, which is what keeps the rules
 * panel and the contract strip saying the same thing as the validator.
 */
export function applyDailyLadder(pack, ladder) {
  pack.rules.contracts = ladder.contracts;
  pack.rules.wilds = ladder.wilds;
  return pack;
}

/**
 * Everything a caller needs to open `packId`'s run for a date: the seed the deal
 * and the ladder both come from, and the ladder itself.
 *
 * One function so the table, the simulator and the tests cannot derive a day
 * three slightly different ways.
 */
export function dailyRunFor(pack, date) {
  const day = isDailyDate(date) ? date : dailyDateStr(date);
  const seed = dailySeedFor(pack.id, day);
  const deck = deckProfile(pack);
  const deal = Number(pack.rules?.deal) || 10;
  return { date: day, seed, ladder: dailyLadder(seed, { deck, deal, wilds: pack.rules?.wilds }) };
}
