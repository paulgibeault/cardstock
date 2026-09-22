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
  matchTimeline, positionAt, turnAt, handAt, seekTargets, positionLabel, beatAt,
} from "../src/stats/timeline.js";
import { reviewMapModel, beatMoment } from "../src/ui/review.js";

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
        // A turn boundary is a change of actor, a change of hand, or a beat
        // closing under the same actor — the seat that takes a trick leads the
        // next, and the gather and the lead are two turns.
        if (turn.to < hand.to) {
          const closedIt = tl.moves[turn.to - 1].marks.some((m) => ['trickWon', 'trickCleared', 'cardsPassed'].includes(m.type) || (m.type === 'go' && m.closes));
          assert.ok(tl.moves[turn.to].seat !== turn.seat || closedIt, `${id}: a turn ends when the actor changes or a beat closes`);
        }
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

/* ------------------------------------------------------------------ *
 * Beats: the map read trick by trick
 * ------------------------------------------------------------------ */

test("beats tile every hand, and every turn is in exactly one", async () => {
  for (const [id, seats] of PACKS) {
    const { pack, snapshot } = await playedOut(id, seats);
    const tl = matchTimeline(pack, snapshot, { labelOf: label });
    let t = 0;
    for (const [h, hand] of tl.hands.entries()) {
      const beats = tl.beats.filter((b) => b.hand === h);
      let pos = hand.from;
      for (const beat of beats) {
        assert.strictEqual(beat.from, pos, `${id}: beats are contiguous in hand ${h}`);
        for (const play of beat.plays) {
          const turn = tl.turns[t++];
          assert.deepStrictEqual([play.from, play.to, play.seat], [turn.from, turn.to, turn.seat], `${id}: a play is a turn`);
        }
        pos = beat.to;
      }
      assert.strictEqual(pos, hand.to, `${id}: the last beat ends with the hand`);
    }
    assert.strictEqual(t, tl.turns.length);
  }
});

test("Hearts: a pass, then thirteen tricks a hand, each four plays with a winner and its card", async () => {
  const { pack, snapshot } = await playedOut('hearts', 4);
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  for (const [h] of tl.hands.entries()) {
    const beats = tl.beats.filter((b) => b.hand === h);
    const tricks = beats.filter((b) => b.kind === 'trick');
    assert.strictEqual(tricks.length, 13, `hand ${h}`);
    tricks.forEach((trick, i) => {
      assert.strictEqual(trick.n, i + 1);
      assert.strictEqual(trick.plays.length, 4, 'four cards to a trick');
      assert.ok(Number.isInteger(trick.winner));
      const won = trick.plays.filter((p) => p.won);
      assert.strictEqual(won.length, 1, 'exactly one winning play');
      assert.strictEqual(won[0].seat, trick.winner);
      assert.deepStrictEqual(trick.winning, won[0].cards);
      assert.strictEqual(trick.winning.length, 1);
    });
    const passes = beats.filter((b) => b.kind === 'pass');
    // Hearts passes on three hands in four (left, right, across, hold).
    if (passes.length) {
      assert.strictEqual(passes[0].from, tl.hands[h].from, 'the pass opens the hand');
      assert.strictEqual(passes[0].plays.length, 4, 'everybody passes');
      assert.strictEqual(passes[0].winner, null);
    }
  }
});

test("Thirteen: a trick is won by whoever played last before everybody passed", async () => {
  const { pack, snapshot } = await playedOut('thirteen', 4);
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  const tricks = tl.beats.filter((b) => b.kind === 'trick');
  assert.ok(tricks.length > 0);
  assert.ok(tl.beats.every((b) => b.kind === 'trick'), 'Thirteen is tricks and nothing else');
  for (const trick of tricks) {
    const lastPlay = [...trick.plays].reverse().find((p) => !p.passed);
    assert.ok(lastPlay, 'a trick has at least one play');
    assert.strictEqual(trick.winner, lastPlay.seat, 'the last combination standing wins');
    assert.deepStrictEqual(trick.winning, lastPlay.cards);
    assert.ok(lastPlay.won);
    // A pass is a play with no cards.
    for (const play of trick.plays) assert.strictEqual(play.passed, play.cards.length === 0);
  }
  // The beats are far fewer than the turns: that is the whole point.
  assert.ok(tl.beats.length * 2 < tl.turns.length, `${tl.beats.length} beats for ${tl.turns.length} turns`);
});

test("Crazy Eights: laps of the table, no winner, every card on the head", async () => {
  const { pack, snapshot } = await playedOut('crazy-eights', 4);
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  assert.ok(tl.beats.every((b) => b.kind === 'lap' && b.winner === null && b.winning.length === 0));
  for (const lap of tl.beats) {
    const seatsIn = lap.plays.map((p) => p.seat);
    assert.strictEqual(new Set(seatsIn).size, seatsIn.length, 'a lap visits a seat at most once');
  }
  const model = reviewMapModel(tl, { index: 0, labelOf: label });
  const head = model.hands[0].beats[0];
  assert.strictEqual(head.title, 'Round 1 of the table');
  assert.deepStrictEqual(head.cards, head.plays.flatMap((p) => p.cards), 'a lap shows every card it played');
});

test("cribbage: the play is counts closed by a go, and a count has a winner", async () => {
  const { pack, snapshot } = await playedOut('cribbage', 2);
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  const counts = tl.beats.filter((b) => b.kind === 'count');
  assert.ok(counts.length > 0, 'the play is counted');
  assert.ok(counts.some((b) => b.winner !== null), 'a go is one for somebody');
});

test("the map opens on the beat the felt stands in, and a beat's moment shows the winning play landed", async () => {
  const { pack, snapshot } = await playedOut('hearts', 4);
  const tl = matchTimeline(pack, snapshot, { labelOf: label });
  const trick = tl.beats.find((b) => b.kind === 'trick' && b.n === 5);
  const inside = trick.plays[1].from;
  const model = reviewMapModel(tl, { index: inside, labelOf: label });
  const current = model.hands.flatMap((h) => h.beats).filter((b) => b.current);
  assert.strictEqual(current.length, 1);
  assert.strictEqual(current[0].from, trick.from);
  assert.ok(current[0].open, 'the current beat starts open');
  assert.strictEqual(current[0].plays.filter((p) => p.current).length, 1);
  assert.strictEqual(beatAt(tl, inside), trick);
  // The moment: after the winning play unless it closed the trick itself.
  const won = trick.plays.find((p) => p.won);
  const after = trick.plays[trick.plays.indexOf(won) + 1];
  assert.strictEqual(beatMoment(trick), after ? after.from : won.from);
  // The end of the match maps to the last beat.
  const last = tl.beats[tl.beats.length - 1];
  assert.strictEqual(beatAt(tl, tl.length), last);
  assert.ok(reviewMapModel(tl, { index: tl.length, labelOf: label }).hands.flatMap((h) => h.beats).find((b) => b.from === last.from).current);
});
