// THE SHARED HOOK-DEFAULT KIT (#216) — the five lines every template used to
// write for itself, pinned once now that there is only one copy of each.
//
// The point of pinning them here rather than only through the packs is that
// what each helper replaced was SIX, FIVE, TWO, SEVEN copies of itself, and the
// details that differed between copies are exactly the details nothing else
// asserts: the singular in "1 card", the direction of the rival fold, the
// ENUMERATION ORDER of a k-subset (a bot's tie-break reads it, so a different
// walk is a different player — tests/replayIdentity.test.js), and whether a
// memo slot is read by `has` or by truthiness.
//
// `ctx` here is the smallest stub each helper actually asks of one, not a real
// match: `handCounter` wants `countIn` and `zoneAddr`, `rivalExtreme` wants
// `seats`. Building a table to assert a string would hide which of the two the
// helper was reading.
import { test } from "node:test";
import assert from "node:assert";
import {
  handCounter, rivalExtreme, kCombinations, memoOnPack, seatsAfter,
} from "../src/engine/templateKit.js";

/** A ctx with nothing on it but per-seat hand counts. */
function ctxWithHands(counts) {
  return {
    seats: counts.length,
    zoneAddr: (name, seat) => `${name}.${seat}`,
    countIn: (address) => counts[Number(address.split(".")[1])],
  };
}

/* ------------------------------------------------------------------ *
 * handCounter
 * ------------------------------------------------------------------ */

test("the hand counter says one card in the singular, and the suffix does not break it", () => {
  const ctx = ctxWithHands([1, 2, 0]);
  assert.deepStrictEqual(handCounter(ctx, 0), {
    text: "1", aria: "1 card", label: "Cards", kind: "hand",
  });
  assert.strictEqual(handCounter(ctx, 1).aria, "2 cards");
  // Zero is plural, which is what every copy said and what English wants.
  assert.strictEqual(handCounter(ctx, 2).aria, "0 cards");
  // APPENDED, never spliced: the four shipped suffixes all sit after the noun,
  // so the singular survives them.
  assert.strictEqual(handCounter(ctx, 0, { suffix: " left" }).aria, "1 card left");
  assert.strictEqual(handCounter(ctx, 0, { suffix: " in hand" }).aria, "1 card in hand");
});

test("the hand counter carries the kind and the flags a template hands it", () => {
  const ctx = ctxWithHands([5, 5]);
  const counter = handCounter(ctx, 0, { kind: "lastcard", minimizedOnly: true });
  assert.strictEqual(counter.kind, "lastcard");
  assert.strictEqual(counter.minimizedOnly, true);
  // The label is the platform's and is not a template's to vary — every copy
  // said `Cards`, and `tests/seatPlate.test.js` draws it.
  assert.strictEqual(counter.label, "Cards");
});

/* ------------------------------------------------------------------ *
 * rivalExtreme
 * ------------------------------------------------------------------ */

test("the rival term takes the best or the worst of the OTHER seats", () => {
  const ctx = { seats: 4 };
  const value = (s) => [10, 30, 20, 40][s];
  assert.strictEqual(rivalExtreme(ctx, 0, value, "max"), 40);
  assert.strictEqual(rivalExtreme(ctx, 0, value, "min"), 20);
  // The seat asking is skipped, and it is the only one skipped: seat 3 holds
  // the maximum, so a fold that forgot to skip would answer 40 for it too.
  assert.strictEqual(rivalExtreme(ctx, 3, value, "max"), 30);
  assert.strictEqual(rivalExtreme(ctx, 1, value, "min"), 10);
  // 'max' is the default, because four of the five sites it replaced wanted it.
  assert.strictEqual(rivalExtreme(ctx, 0, value), 40);
});

test("the rival term is null when there is nobody to be measured against", () => {
  // A one-seat table: the seed is untouched, and −Infinity is not an answer —
  // `score + (-Infinity) * w` is every candidate move scoring the same, which
  // is a bot that plays the first move in the list.
  assert.strictEqual(rivalExtreme({ seats: 1 }, 0, () => 5, "max"), null);
  assert.strictEqual(rivalExtreme({ seats: 1 }, 0, () => 5, "min"), null);
  assert.strictEqual(rivalExtreme({ seats: 0 }, 0, () => 5), null);
  // ...and null for a poisoned fold, which is the `Number.isFinite` guard every
  // copy wrote by hand: Math.max propagates a NaN.
  assert.strictEqual(rivalExtreme({ seats: 3 }, 0, (s) => (s === 2 ? NaN : 1), "max"), null);
});

/* ------------------------------------------------------------------ *
 * kCombinations
 * ------------------------------------------------------------------ */

test("k-subsets come out in index order, which is what a bot's tie-break reads", () => {
  assert.deepStrictEqual(kCombinations(["a", "b", "c"], 2),
    [["a", "b"], ["a", "c"], ["b", "c"]]);
  assert.deepStrictEqual(kCombinations(["a", "b", "c", "d"], 3),
    [["a", "b", "c"], ["a", "b", "d"], ["a", "c", "d"], ["b", "c", "d"]]);
  // Cribbage's throw: six choose two is fifteen, enumerated whole (#107).
  assert.strictEqual(kCombinations([0, 1, 2, 3, 4, 5], 2).length, 15);
});

test("k-subsets handle the edges the two copies handled between them", () => {
  assert.deepStrictEqual(kCombinations(["a"], 2), []);
  assert.deepStrictEqual(kCombinations([], 1), []);
  assert.deepStrictEqual(kCombinations(["a", "b"], 2), [["a", "b"]]);
  // Each subset is its own array, so a caller may keep or map over it — climbing
  // maps them to card ids and holds onto the result.
  const out = kCombinations(["a", "b", "c"], 2);
  out[0].push("x");
  assert.deepStrictEqual(out[1], ["a", "c"]);
});

/* ------------------------------------------------------------------ *
 * memoOnPack
 * ------------------------------------------------------------------ */

test("a pack memo computes once per key and never crosses between keys", () => {
  const pack = {};
  let runs = 0;
  const compute = (answer) => () => { runs++; return answer; };

  assert.strictEqual(memoOnPack(pack, "a:one", compute("first")), "first");
  assert.strictEqual(memoOnPack(pack, "a:one", compute("second")), "first");
  assert.strictEqual(runs, 1);
  // A SECOND KEY IS A SECOND ANSWER. Seven modules share this WeakMap now, so a
  // memo that ignored its key would hand climbing's vocabulary to cribbage.
  assert.strictEqual(memoOnPack(pack, "b:one", compute("other")), "other");
  assert.strictEqual(memoOnPack(pack, "a:one", compute("third")), "first");
  assert.strictEqual(runs, 2);
});

test("a pack memo is per pack, and keeps an answer that is falsy", () => {
  const one = {};
  const two = {};
  assert.strictEqual(memoOnPack(one, "k", () => "one's"), "one's");
  assert.strictEqual(memoOnPack(two, "k", () => "two's"), "two's");
  assert.strictEqual(memoOnPack(one, "k", () => "changed"), "one's");

  // `has`, not truthiness: the hand-written copies could all assume an object,
  // and a shared helper cannot.
  let runs = 0;
  const zero = () => { runs++; return 0; };
  assert.strictEqual(memoOnPack(one, "zero", zero), 0);
  assert.strictEqual(memoOnPack(one, "zero", zero), 0);
  assert.strictEqual(runs, 1);
});

/* ------------------------------------------------------------------ *
 * seatsAfter
 * ------------------------------------------------------------------ */

test("seatsAfter reads round the table and ends on the seat it started from", () => {
  assert.deepStrictEqual(seatsAfter(4, 0), [1, 2, 3, 0]);
  assert.deepStrictEqual(seatsAfter(4, 2), [3, 0, 1, 2]);
  assert.deepStrictEqual(seatsAfter(4, 3), [0, 1, 2, 3]);
  assert.deepStrictEqual(seatsAfter(2, 1), [0, 1]);
});

test("seatsAfter answers every seat exactly once, whatever it is started from", () => {
  // A round nobody won: `ctx.state.roundWinner` is null and the reveal still
  // has to name every seat (src/engine/scoring.js).
  assert.deepStrictEqual(seatsAfter(4, null), [0, 1, 2, 3]);
  assert.deepStrictEqual(seatsAfter(4, undefined), [0, 1, 2, 3]);
  // A table with no chairs is an empty reading rather than a throw — the felt
  // asks this behind the lobby (src/ui/seatRing.js).
  assert.deepStrictEqual(seatsAfter(0, 0), []);
  for (const from of [0, 1, 2, 3, null]) {
    assert.deepStrictEqual([...seatsAfter(4, from)].sort(), [0, 1, 2, 3]);
  }
});
