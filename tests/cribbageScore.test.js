// THE SHOW, SWEPT OVER EVERY HAND THERE IS.
//
// `scoreHand` is the one function in this repo whose answer a player will
// argue with, and it is also the one that can be checked exhaustively: there
// are 12,994,800 (four-card hand, starter) pairs on a 52-card deck and every
// one of them can be scored in eight seconds. So this does not sample.
//
// The property it checks is the famous one — every cribbage hand scores
// somewhere in 0…29, and 19, 25, 26 and 27 are unreachable — and it is a
// better test than any table of examples, because an arithmetic slip anywhere
// in fifteens, pairs or runs lands on one of those four numbers long before it
// produces something outside the range. The 29 is checked by name and by
// count: there are exactly four hands that score it, one per suit.
//
// The scorers are built from the CRIBBAGE PACK rather than from constants, so
// the sweep also proves the manifest: its `scoring.cardValues` (ace 1, faces
// 10) and its declared `rankLadder` (`A 2 … K`, #101). Get either wrong and
// the distribution stops being the cribbage one.
import { test } from "node:test";
import assert from "node:assert";
import { scoreHand, scorePlay, IMPOSSIBLE_SHOWS, MAX_SHOW } from "../src/templates/cribbage-score.js";
import { rankLadderOf, rankOrder } from "../src/engine/cards.js";
import { cardValue } from "../src/engine/scoring.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

const pack = await loadPackFromDisk("cribbage");
const ladder = rankLadderOf(pack);

// Memoised for the same reason src/templates/cribbage.js memoises them: an
// unmemoised `cardValue` walks thirteen selectors per card, which turns an
// eight-second sweep into a minute of selector matching.
const VALUES = new Map();
const ORDERS = new Map();
for (const card of pack.cardsById.values()) {
  VALUES.set(card, cardValue(card, pack.scoring));
  ORDERS.set(card, rankOrder(card, ladder));
}
const OPTS = { valueOf: (c) => VALUES.get(c), orderOf: (c) => ORDERS.get(c) };
const FAST = { ...OPTS, parts: false };

const card = (id) => {
  const found = pack.cardsById.get(id);
  assert.ok(found, `no such card: ${id}`);
  return found;
};
const show = (ids, starterId, isCrib = false) =>
  scoreHand(ids.map(card), card(starterId), { ...FAST, isCrib }).total;

test("the manifest's own values and ladder are the cribbage ones", () => {
  // The sweep below is only the cribbage distribution if these two are right,
  // so they are asserted directly rather than left implied by it.
  assert.strictEqual(VALUES.get(card("spades-A")), 1, "the ace counts one");
  assert.strictEqual(VALUES.get(card("spades-K")), 10, "the king counts ten");
  assert.strictEqual(VALUES.get(card("spades-J")), 10);
  assert.ok(ORDERS.get(card("spades-A")) < ORDERS.get(card("spades-2")),
    "the ace is LOW on the ladder — A-2-3 is a run and Q-K-A is not");
  assert.ok(ORDERS.get(card("spades-10")) < ORDERS.get(card("spades-J")),
    "the jack outranks the ten, which is the bug #101 exists to have fixed");
});

test("the twenty-nine hand, and there are exactly four of them", () => {
  // Three fives and the jack of the starter's suit, with the fourth five cut:
  // eight fifteens (16), six pairs (12), and one for his nobs.
  assert.strictEqual(show(["clubs-5", "diamonds-5", "spades-5", "hearts-J"], "hearts-5"), 29);
  // Twenty-eight is the same hand with the jack in the wrong place: four fives
  // held, a jack cut, no nobs.
  assert.strictEqual(show(["clubs-5", "diamonds-5", "spades-5", "hearts-5"], "hearts-J"), 28);
});

test("a run counts once per way of making it — double, double-double, triple", () => {
  // 4-5-5-6 with a 7 cut is 4-5-6-7 twice over (8) plus the pair (2) plus the
  // fifteens 4+5+6 twice (4): the multiplicative rule, not "one run of four".
  assert.strictEqual(show(["clubs-4", "diamonds-5", "hearts-5", "spades-6"], "clubs-7"), 14);
  // Three fives and a 4-6 around them: a run of three, three ways.
  assert.strictEqual(show(["clubs-4", "diamonds-5", "hearts-5", "spades-5"], "clubs-6"), 23);
  // Nothing consecutive at all, nothing summing to fifteen.
  assert.strictEqual(show(["clubs-2", "diamonds-4", "hearts-6", "spades-8"], "clubs-10"), 0);
});

test("a flush in the crib needs the starter; the same four in hand do not", () => {
  const four = ["hearts-2", "hearts-4", "hearts-6", "hearts-9"];
  // In hand: four of a suit is four, and the fifteens (6+9) make it eight.
  assert.strictEqual(show(four, "spades-K"), 8);
  // The identical four in the CRIB score nothing for the flush — the crib is
  // made of throwaways, so four of a suit there is an accident.
  assert.strictEqual(show(four, "spades-K", true), 4);
  // Turn the starter to the same suit and the crib flush is real: five.
  assert.strictEqual(show(four, "hearts-K", true), 9);
  // And in hand the same starter takes the four-flush to five.
  assert.strictEqual(show(four, "hearts-K"), 9);
});

test("his nobs is the jack IN HAND of the starter's suit, and only that", () => {
  assert.strictEqual(show(["hearts-J", "spades-2", "clubs-4", "diamonds-9"], "hearts-K"), 3,
    "two for the fifteen (J+K is twenty — no; 2+4+9 is fifteen) and one for his nobs");
  assert.strictEqual(show(["spades-J", "spades-2", "clubs-4", "diamonds-9"], "hearts-K"), 2,
    "a jack of the wrong suit is not nobs");
});

test("the play scores a SEQUENCE — fifteen, thirty-one, pairs backwards, run in any order", () => {
  const play = (ids) => scorePlay(ids.map(card), FAST);
  assert.deepStrictEqual(play(["clubs-7", "hearts-8"]), { total: 2, count: 15 }, "fifteen two");
  assert.deepStrictEqual(play(["clubs-10", "hearts-10", "spades-8", "diamonds-3"]),
    { total: 2, count: 31 }, "thirty-one for two");
  assert.deepStrictEqual(play(["clubs-6", "hearts-6", "spades-6"]),
    { total: 6, count: 18 }, "a pair royal is six, because it makes three pairs");
  assert.deepStrictEqual(play(["clubs-6", "hearts-5", "spades-7"]),
    { total: 3, count: 18 }, "a run made out of order still runs");
  // …and the same idea with a duplicate in between does NOT: the tail that
  // would make the run has two fours in it.
  assert.strictEqual(play(["clubs-5", "hearts-4", "diamonds-4", "spades-6"]).total, 0);
  // A run of three that also brings the count to fifteen scores both, which is
  // the case a scorer that stops at its first find gets wrong.
  assert.deepStrictEqual(play(["clubs-4", "hearts-5", "spades-6"]), { total: 5, count: 15 });
});

test("the breakdown adds up to the total it comes with", () => {
  // The narration and the number come from the same pass, so a breakdown that
  // does not sum to the total is a banner that lies about the score.
  for (const [hand, starter, isCrib] of [
    [["clubs-5", "diamonds-5", "spades-5", "hearts-J"], "hearts-5", false],
    [["hearts-2", "hearts-4", "hearts-6", "hearts-9"], "hearts-K", true],
    [["clubs-4", "diamonds-5", "hearts-5", "spades-6"], "clubs-7", false],
    [["clubs-2", "diamonds-4", "hearts-6", "spades-8"], "clubs-10", false],
  ]) {
    const scored = scoreHand(hand.map(card), card(starter), { ...OPTS, isCrib });
    const summed = scored.breakdown.reduce((n, part) => n + part.points, 0);
    assert.strictEqual(summed, scored.total, `${hand.join(" ")} + ${starter}`);
  }
});

/* ------------------------------------------------------------------ *
 * The whole distribution
 * ------------------------------------------------------------------ */

test("every hand on a 52-card deck scores 0–29, and never 19, 25, 26 or 27", () => {
  const cards = [...pack.cardsById.values()];
  const n = cards.length;
  assert.strictEqual(n, 52, "the sweep's arithmetic is a claim about a 52-card deck");

  const seen = new Uint32Array(128);
  const hand = [null, null, null, null];
  for (let a = 0; a < n; a++) {
    hand[0] = cards[a];
    for (let b = a + 1; b < n; b++) {
      hand[1] = cards[b];
      for (let c = b + 1; c < n; c++) {
        hand[2] = cards[c];
        for (let d = c + 1; d < n; d++) {
          hand[3] = cards[d];
          for (let e = 0; e < n; e++) {
            if (e === a || e === b || e === c || e === d) continue;
            seen[scoreHand(hand, cards[e], FAST).total]++;
          }
        }
      }
    }
  }

  let swept = 0;
  for (let i = 0; i < seen.length; i++) swept += seen[i];
  assert.strictEqual(swept, 12994800,
    "C(52,4) hands x 48 starters — the sweep did not cover the distribution it claims to");

  const unreachable = [];
  const reachable = [];
  for (let i = 0; i <= MAX_SHOW; i++) (seen[i] ? reachable : unreachable).push(i);
  assert.deepStrictEqual(unreachable, [...IMPOSSIBLE_SHOWS],
    "the scores no cribbage hand can make are exactly 19, 25, 26 and 27");

  for (let i = MAX_SHOW + 1; i < seen.length; i++) {
    assert.strictEqual(seen[i], 0, `${seen[i]} hands scored ${i}, above the 29 that is the maximum`);
  }
  assert.strictEqual(seen[29], 4, "there are exactly four twenty-nine hands, one per suit");
  assert.ok(reachable.length === 26, `expected 26 reachable scores, got ${reachable.length}`);
});
