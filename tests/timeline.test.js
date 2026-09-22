// THE MATCH AS A MAP (REVIEW_PLAN.md phase 2, issue #190).
//
// Everything the review UI stands on is arithmetic over a log: which moves make
// a turn, which turns make a hand, and what the felt should show after N of
// them. Pinned here over real packs played by the house bot to the end, because
// a hand-built log is a second opinion about where the boundaries are.

import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { createRng } from "../src/engine/rng.js";
import { serializeMatch, rehydrateMatch } from "../src/engine/replay.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import {
  matchTimeline, positionAt, turnAt, handAt, seekTargets, positionLabel,
} from "../src/stats/timeline.js";

const label = (seat) => ["You", "Nell", "Ada", "Bo", "Cy", "Di"][seat] ?? `Seat ${seat + 1}`;

async function playedOut(packId, seats, { seed = 5, stopAt = null } = {}) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  const rng = createRng(seed);
  for (let guard = 0; guard < 6000 && !state.gameOver; guard++) {
    if (stopAt !== null && state.log.length >= stopAt) break;
    const acting = pack.template.actingSeats ? pack.template.actingSeats(makeCtx(state)) : [state.turn.seat];
    const seat = acting[0] ?? state.turn.seat;
    const move = chooseBotMove(state, seat, { difficulty: 'easy', random: rng.next });
    if (!move) break;
    applyMove(state, move);
  }
  return { pack, state, snapshot: serializeMatch(state) };
}

const PACKS = [['hearts', 4], ['crazy-eights', 4], ['thirteen', 4], ['milestones', 4], ['cribbage', 2], ['team-spades', 4]];

test("every move is in exactly one turn and one hand, and the ranges tile the log", async () => {
  for (const [id, seats] of PACKS) {
    const { pack, snapshot } = await playedOut(id, seats);
    const tl = matchTimeline(pack, snapshot, { labelOf: label });
    assert.strictEqual(tl.length, snapshot.log.length);
    assert.strictEqual(tl.moves.length, tl.length);
    // Hands tile [0, length] in order.
    let at = 0;
    for (const hand of tl.hands) { assert.strictEqual(hand.from, at, `${id}: hands are contiguous`); assert.ok(hand.to > hand.from); at = hand.to; }
    assert.strictEqual(at, tl.length, `${id}: the last hand ends where the log does`);
    // Turns tile each hand.
    let t = 0;
    for (const [h, hand] of tl.hands.entries()) {
      let pos = hand.from;
      while (pos < hand.to) {
        const turn = tl.turns[t++];
        assert.strictEqual(turn.from, pos, `${id}: turns are contiguous inside hand ${h}`);
        assert.strictEqual(turn.hand, h);
        for (let i = turn.from; i < turn.to; i++) {
          assert.strictEqual(tl.moves[i].seat, turn.seat, 'a turn is one actor');
          assert.strictEqual(tl.moves[i].turn, t - 1);
          assert.strictEqual(tl.moves[i].hand, h);
        }
        // A turn boundary is a change of actor or of hand, never a whim.
        if (turn.to < hand.to) assert.notStrictEqual(tl.moves[turn.to].seat, turn.seat, `${id}: a turn ends when the actor changes`);
        pos = turn.to;
      }
    }
    assert.strictEqual(t, tl.turns.length, `${id}: no turn outside a hand`);
    assert.ok(tl.gameOver, `${id}: the bot played it out`);
    assert.ok(tl.hands.length >= 1 && tl.hands[tl.hands.length - 1].over, 'the last hand ended the match');
    assert.ok(tl.hands.every((h) => !h.live));
  }
});

test("a live match's map ends in the hand being played", async () => {
  const { pack, snapshot } = await playedOut('hearts', 4, { stopAt: 30 });
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  assert.strictEqual(tl.gameOver, false);
  const last = tl.hands[tl.hands.length - 1];
  assert.strictEqual(last.live, true);
  assert.strictEqual(last.to, tl.length);
  assert.strictEqual(last.scores, null, 'a hand still being played has no result yet');
});

test("the position after n moves is the replayed state, and it is a fresh one", async () => {
  const { pack, snapshot } = await playedOut('thirteen', 4);
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  for (const n of [0, 1, 7, Math.floor(tl.length / 2), tl.length - 1, tl.length]) {
    const pos = positionAt(pack, snapshot, n);
    assert.strictEqual(pos.log.length, n);
    assert.notStrictEqual(pos.log, snapshot.log, 'never the payload\'s own array');
    if (n > 0) assert.deepStrictEqual(pos.scores, tl.moves[n - 1].totals, `totals at ${n}`);
    // Every card is somewhere, at every position: the deck the deal put out.
    const dealt = positionAt(pack, snapshot, 0).cardLocation.size;
    assert.ok(dealt > 0);
    assert.strictEqual(pos.cardLocation.size, dealt, 'a position is a whole deck');
  }
  const end = positionAt(pack, snapshot, tl.length);
  const whole = rehydrateMatch(pack, snapshot);
  assert.deepStrictEqual(end.scores, whole.scores);
  assert.strictEqual(end.gameOver, whole.gameOver);
  // Out of range is clamped, not thrown.
  assert.strictEqual(positionAt(pack, snapshot, -3).log.length, 0);
  assert.strictEqual(positionAt(pack, snapshot, tl.length + 99).log.length, tl.length);
});

test("the reel's four targets are the neighbouring turn and hand starts", async () => {
  const { pack, snapshot } = await playedOut('crazy-eights', 4);
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  // From the deal there is nothing before and the first turn is at 0 itself.
  assert.deepStrictEqual(seekTargets(tl, 0).prevTurn, null);
  assert.deepStrictEqual(seekTargets(tl, 0).prevHand, null);
  assert.strictEqual(seekTargets(tl, 0).nextTurn, tl.turns[1].from);
  // Walking forward by turn visits every turn start once and lands on the end.
  const visited = [];
  for (let n = 0; n !== null; n = seekTargets(tl, n).nextTurn) visited.push(n);
  assert.deepStrictEqual(visited, [...tl.turns.map((t) => t.from), tl.length]);
  // And back again.
  const back = [];
  for (let n = tl.length; n !== null; n = seekTargets(tl, n).prevTurn) back.push(n);
  assert.deepStrictEqual(back, [tl.length, ...tl.turns.map((t) => t.from).reverse()]);
  // From the middle of a turn, "previous" is that turn's own start.
  const long = tl.turns.find((t) => t.to - t.from >= 2);
  if (long) assert.strictEqual(seekTargets(tl, long.from + 1).prevTurn, long.from);
  // Hands the same way.
  const byHand = [];
  for (let n = 0; n !== null; n = seekTargets(tl, n).nextHand) byHand.push(n);
  assert.deepStrictEqual(byHand, [...tl.hands.map((h) => h.from), tl.length]);
  assert.strictEqual(turnAt(tl, tl.length), null);
  assert.strictEqual(handAt(tl, tl.length), tl.hands[tl.hands.length - 1]);
});

test("every row says who and what, and the marks say what it caused", async () => {
  const { pack, snapshot } = await playedOut('hearts', 4);
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  for (const move of tl.moves) {
    assert.ok(move.text.startsWith(label(move.seat)), `${move.text} names its actor first`);
    assert.doesNotMatch(move.text, /playCard|undefined|\[object/, 'no raw type or hole in a sentence');
  }
  const played = tl.moves.find((m) => m.type === 'playCard');
  assert.match(played.text, /played .+ of (Hearts|Spades|Clubs|Diamonds)/);
  const tricks = tl.moves.filter((m) => m.marks.some((k) => k.type === 'trickWon'));
  assert.strictEqual(tricks.length, 13 * tl.hands.length, 'every trick of every hand is marked on the card that took it');
  const ends = tl.moves.filter((m) => m.marks.some((k) => k.type === 'roundOver'));
  assert.strictEqual(ends.length, tl.hands.length);
  assert.strictEqual(positionLabel(tl, 0, label), `Hand 1 · ${label(tl.turns[0].seat)} to play`);
  assert.strictEqual(positionLabel(tl, tl.length, label), 'The end');
});

test("a whole match maps in the time a frame takes", async () => {
  for (const [id, seats] of PACKS) {
    const { pack, snapshot } = await playedOut(id, seats);
    const t0 = performance.now();
    matchTimeline(pack, snapshot, { labelOf: label });
    for (const n of [1, 50, snapshot.log.length]) positionAt(pack, snapshot, n);
    const ms = performance.now() - t0;
    // The plan measured 0.5–3.2ms for the replay alone; the narration is the
    // rest. Generous, so the test is about a regression and not a slow CI box.
    assert.ok(ms < 250, `${id}: ${ms.toFixed(1)}ms to map ${snapshot.log.length} moves and seek three positions`);
  }
});
