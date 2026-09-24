// THE FIVE LINES EVERY TEMPLATE USED TO WRITE FOR ITSELF (#216).
//
// None of these is a fact about cards, sides, scoring or the turn, so none of
// them had a module to live in — and the result was six copies of the hand
// counter, five of the best-rival term, two k-subset enumerators, seven
// per-pack memos and one `seatsAfter` that was private to `scoring.js` while
// the felt hand-rolled the same rotation. Each copy was a place for the
// genres to drift apart on a detail nobody meant to decide per game: whether
// an empty table's rival term is `-Infinity` or nothing, whether the
// combination order is lexicographic, whether the memo is read once or twice.
//
// THIS FILE IMPORTS NOTHING, deliberately. `cards.js` and `sides.js` are
// upstream of almost everything in `src/engine`, and they both want the memo;
// a kit with no imports of its own can be taken from anywhere — engine,
// template or felt — without anybody having to think about cycles.

/**
 * The hand-count seat counter, which is the platform's own default
 * (`seatCountersFor` in src/ui/table.js) written so a template can APPEND to
 * it — see `seatCounters` in src/templates/CONTRACT.md.
 *
 * Six templates wanted the default plus something: a meld count, a stock
 * count, a bid, a board. The only way to say "the default, and also this" is
 * to write the default out again, and six hand-written copies of "1 card, 2
 * cards" is six chances to ship "1 cards".
 *
 * `suffix` is the one thing they legitimately disagree on, because the sentence
 * is said in a different place in each game: climbing's hand is what is LEFT,
 * cribbage's and sequencing's is what is IN HAND (their primary number is the
 * board or the stock), and shedding's escalates to "down to their last". It is
 * appended to the phrase, never spliced into it, so the singular stays right.
 *
 * `kind` defaults to `'hand'` — the slug every copy chose — and shedding
 * overrides it to `'lastcard'` for the same quantity drawn louder. Anything
 * else (`minimizedOnly`, `openOnly`) is spread on top.
 */
export function handCounter(ctx, seat, { suffix = '', kind = 'hand', ...rest } = {}) {
  const count = ctx.countIn(ctx.zoneAddr('hand', seat));
  return {
    text: String(count),
    aria: `${count} ${count === 1 ? 'card' : 'cards'}${suffix}`,
    label: 'Cards',
    kind,
    ...rest,
  };
}

/**
 * The best (or worst) any OTHER seat is doing by `f`, or null when there is no
 * such seat and no finite answer.
 *
 * "How am I doing" is not a quantity a bot can evaluate on its own hand: a
 * five-card hand is good against seats holding eight and terrible against one
 * holding one. So five evaluators ended up writing the same four lines — seed
 * an infinity, fold `Math.max`/`Math.min` over the seats that are not mine,
 * then `Number.isFinite` before using it.
 *
 * THE GUARD IS THE POINT, and returning null rather than an infinity is what
 * makes it unskippable. A one-seat table (a solo drill, a determinized rollout
 * with one live seat) leaves the seed untouched, and `score + (-Infinity) * w`
 * is not a bad evaluation — it is every candidate move scoring the same
 * `-Infinity`, which is a bot that plays the first move in the list. `Math.max`
 * also propagates a NaN, so an `f` that returns one poisons the fold; both
 * cases fail the same `Number.isFinite` the copies wrote by hand and come back
 * as null here.
 *
 * @param mode 'max' for "whoever is furthest ahead", 'min' for "whoever is
 *             closest to going out". Which one is right is a fact about the
 *             game, and Hearts changes its mind per pack (`prizeSign`).
 */
export function rivalExtreme(ctx, seat, f, mode = 'max') {
  const up = mode === 'max';
  let best = up ? -Infinity : Infinity;
  for (let s = 0; s < ctx.seats; s++) {
    if (s === seat) continue;
    const theirs = f(s);
    best = up ? Math.max(best, theirs) : Math.min(best, theirs);
  }
  return Number.isFinite(best) ? best : null;
}

/**
 * Every k-subset of `items`, in INDEX ORDER — `[0,1]`, `[0,2]`, `[1,2]`.
 *
 * The order is the contract, not an implementation detail. Both copies this
 * replaces feed a bot: cribbage enumerates the fifteen ways to throw two of
 * six as MOVES, and `src/engine/bot.js` breaks ties by the order moves were
 * enumerated in, so a different walk is a different (equally legal, equally
 * strong) player. Climbing builds its pairs and triples the same way.
 *
 * NOTHING IN `npm test` CATCHES A REORDER, which is why it is written down
 * here. `tests/replayIdentity.test.js` replays LOGGED moves and is silent on
 * how they were enumerated; the thing that moves is the reproducible
 * tournament — `simulate.mjs thirteen cribbage --vs=hard,hard --match
 * --budget-moves=N`, which walked from 11-9 to 8-12 at thirteen when this loop
 * was run backwards (#216).
 *
 * Each subset is its own array — the recursion pushes a copy — so a caller may
 * keep or mutate what it is handed.
 */
export function kCombinations(items, k) {
  if (k > items.length) return [];
  const out = [];
  const pick = (start, chosen) => {
    if (chosen.length === k) { out.push(chosen.slice()); return; }
    for (let i = start; i < items.length; i++) {
      chosen.push(items[i]);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
}

/**
 * Compute `fn()` once per (pack, key) and hand back the same answer after.
 *
 * SEVEN MODULES HAD THEIR OWN `WeakMap` for this, and each wrote the same five
 * lines around it. What they are all memoising is the same KIND of thing: a
 * fact derived from the deck and the manifest, both of which are fixed the
 * moment a pack is loaded, swept once and then asked on the hot path — the
 * rank ladder, the meld rank domain, the pack's suits, cribbage's per-card
 * scorers, climbing's combination vocabulary, Hearts' peril table, the sides
 * table. A pack is the natural key because it is what the answer is a fact
 * about, and a WeakMap is what keeps an abandoned pack collectable.
 *
 * `key` is a string the CALLING MODULE picks and it is namespaced by hand
 * (`'cribbage:scorers'`), because a second slot answering to the same word in
 * two modules would be the one bug this shape can have.
 *
 * `has`, not a truthiness test: the copies could all assume their answer was an
 * object, and one shared helper cannot — a memoised `0`, `''` or `null` would
 * be recomputed on every call, which is the silent kind of slow.
 */
const PACK_MEMOS = new WeakMap();

export function memoOnPack(pack, key, fn) {
  let slots = PACK_MEMOS.get(pack);
  if (!slots) {
    slots = new Map();
    PACK_MEMOS.set(pack, slots);
  }
  if (slots.has(key)) return slots.get(key);
  const value = fn();
  slots.set(key, value);
  return value;
}

/**
 * The seats in table order starting AFTER `from` and ending ON it — the order
 * a reveal reads round the table, and the order the felt seats opponents in.
 *
 * `from` that is not a seat number (null on a round nobody won) starts at 0, so
 * the answer is always every seat exactly once.
 *
 * Takes the seat COUNT rather than a ctx: the two callers are `scoring.js`,
 * which has a ctx, and `src/ui/seatRing.js`, which has a number and no match at
 * all — it draws the ring behind the lobby too.
 */
export function seatsAfter(seats, from) {
  const n = Number.isInteger(seats) && seats > 0 ? seats : 0;
  const start = Number.isInteger(from) ? from : -1;
  const out = [];
  for (let k = 1; k <= n; k++) out.push((start + k + n) % n);
  return out;
}
