// The round boundary and the event window (src/engine/movePipeline.js).
//
// A hand ending is no longer a match ending: the pipeline scores the round,
// applies the totals, and either declares the match over (scoring.gameOver /
// the template's own call) or deals the next round — all inside applyMove, so
// a replayed log crosses the boundary at exactly the same move. These tests
// pin the boundary's observable effects: the scores moving, the redeal, the
// meta-state that must survive it (Milestones' contract progression), and the
// events (trickWon, roundOver, roundStart, pileCleared) the table UI narrates
// and celebrates from.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

function put(state, address, cardIds) {
  const zone = state.zones.get(address);
  zone.cards.push(...cardIds);
  for (const id of cardIds) state.cardLocation.set(id, address);
}

function eventTypes(state) {
  return state.events.map((e) => e.type);
}

/* ------------------------------------------------------------------ *
 * Hearts (trick-taking): the last trick of a hand
 * ------------------------------------------------------------------ */

async function heartsLastTrick({ scores, wonBySeat = {} } = {}) {
  const pack = await loadPackFromDisk("hearts");
  const state = createState({ pack, seats: 4, seed: "rounds-test" });
  put(state, "trick", ["hearts-4", "hearts-J", "hearts-9"]);
  put(state, "hand.3", ["hearts-2"]);
  for (const [seat, cards] of Object.entries(wonBySeat)) put(state, `won.${seat}`, cards);
  if (scores) scores.forEach((v, s) => { state.scores[s] = v; });
  Object.assign(state.vars, { led: "hearts", leader: 0, heartsBroken: true, trickNumber: 13 });
  state.turn.seat = 3;
  state.turn.phase = "play";
  applyMove(state, { actor: 3, type: "playCard", cards: ["hearts-2"] });
  return state;
}

test("a finished trick emits trickWon with its winner and its cost", async () => {
  const state = await heartsLastTrick();
  const trick = state.events.find((e) => e.type === "trickWon");
  assert.ok(trick, "trickWon event emitted");
  assert.equal(trick.seat, 1, "hearts-J is the highest of the led suit");
  assert.equal(trick.points, 4, "four hearts at a point each");
  assert.equal(trick.cards.length, 4);
});

test("the last trick of a hand scores the round and deals the next one", async () => {
  const state = await heartsLastTrick({ wonBySeat: { 2: ["hearts-3", "hearts-5"] } });
  assert.deepEqual(
    eventTypes(state).filter((t) => t !== "trickWon"),
    ["roundOver", "roundStart"],
  );
  const over = state.events.find((e) => e.type === "roundOver");
  assert.equal(over.over, false);
  assert.equal(over.scores[1], 4, "the final trick's hearts land on its winner");
  assert.equal(over.scores[2], 2, "hearts already taken keep their owner");
  assert.equal(state.scores[1], 4);
  assert.equal(state.scores[2], 2);
  assert.equal(state.roundNumber, 2);
  assert.equal(state.gameOver, false);
  // The new hand is dealt and the pass schedule has moved on: left, then right.
  for (let s = 0; s < 4; s++) assert.equal(state.zones.count(`hand.${s}`), 13);
  assert.equal(state.turn.phase, "pass");
  assert.equal(state.vars.passDirection, "right");
});

test("crossing the score threshold ends the match with the lowest score winning", async () => {
  const state = await heartsLastTrick({ scores: [5, 97, 40, 60] });
  // Seat 1 takes 4 points: 101 >= 100, and seat 0's 5 is the lowest total.
  assert.equal(state.gameOver, true);
  assert.equal(state.winner, 0);
  assert.equal(state.roundNumber, 1, "no next round is dealt after game over");
  const over = state.events.find((e) => e.type === "roundOver");
  assert.equal(over.over, true);
});

/* ------------------------------------------------------------------ *
 * Crazy Eights (shedding): going out is a round, not the match
 * ------------------------------------------------------------------ */

test("a shedding hand going out deals the next round until the threshold", async () => {
  const pack = await loadPackFromDisk("crazy-eights");
  const state = createState({ pack, seats: 3, seed: "rounds-test" });
  put(state, "discard", ["hearts-7"]);
  put(state, "hand.0", ["hearts-K"]);
  put(state, "hand.1", ["clubs-5", "clubs-9"]);
  put(state, "hand.2", ["diamonds-4"]);
  state.turn.seat = 0;
  state.turn.phase = "play";
  applyMove(state, { actor: 0, type: "playCard", cards: ["hearts-K"] });

  // 5 + 9 + 4 = 18 leftover points to the winner; nowhere near 100.
  assert.equal(state.scores[0], 18);
  assert.equal(state.gameOver, false);
  assert.equal(state.roundNumber, 2);
  for (let s = 0; s < 3; s++) assert.equal(state.zones.count(`hand.${s}`), 5, "fresh 3-player deal");
  assert.ok(state.zones.count("discard") >= 1, "a starter is flipped");
});

test("a shedding hand going out past the threshold ends the match", async () => {
  const pack = await loadPackFromDisk("crazy-eights");
  const state = createState({ pack, seats: 3, seed: "rounds-test" });
  put(state, "discard", ["hearts-7"]);
  put(state, "hand.0", ["hearts-K"]);
  put(state, "hand.1", ["clubs-5", "clubs-9"]);
  put(state, "hand.2", ["diamonds-4"]);
  state.scores[0] = 90;
  state.turn.seat = 0;
  state.turn.phase = "play";
  applyMove(state, { actor: 0, type: "playCard", cards: ["hearts-K"] });
  assert.equal(state.gameOver, true);
  assert.equal(state.winner, 0, "highestScore wins Crazy Eights");
  assert.equal(state.scores[0], 108);
});

/* ------------------------------------------------------------------ *
 * Milestones (contract-rummy): contracts survive the round boundary
 * ------------------------------------------------------------------ */

test("a contract-rummy round resets the deal but never the contract progression", async () => {
  const pack = await loadPackFromDisk("milestones");
  const state = createState({ pack, seats: 3, seed: "rounds-test" });
  put(state, "hand.0", ["red-3"]);
  put(state, "hand.1", ["blue-5"]);
  put(state, "hand.2", ["green-9"]);
  state.playerVars[0] = { phase: 3, laidDown: true, melds: [{ item: "set(3)", cards: [] }] };
  state.playerVars[1] = { phase: 1, laidDown: false };
  state.playerVars[2] = { phase: 2, laidDown: false };
  state.turn.seat = 0;
  state.turn.phase = "meld";
  applyMove(state, { actor: 0, type: "discard", cards: ["red-3"] });

  assert.equal(state.gameOver, false, "phase 3 is not the final contract");
  assert.equal(state.roundNumber, 2);
  assert.equal(state.playerVars[0].phase, 3, "contract progression survives");
  assert.equal(state.playerVars[2].phase, 2);
  assert.equal(state.playerVars[0].laidDown, false, "lay-down state is round-scoped");
  assert.equal(state.playerVars[0].melds, undefined, "meld bookkeeping is round-scoped");
  for (let s = 0; s < 3; s++) assert.equal(state.zones.count(`hand.${s}`), 10, "fresh deal of 10");
  assert.equal(state.turn.seat, 1, "the opening turn rotates with the round");
  assert.equal(state.turn.phase, "draw");
});

/* ------------------------------------------------------------------ *
 * Stockpile (sequencing): reactions announce themselves
 * ------------------------------------------------------------------ */

test("completing a build pile emits pileCleared for the UI", async () => {
  const pack = await loadPackFromDisk("stockpile");
  const state = createState({ pack, seats: 2, seed: "rounds-test" });
  put(state, "build.3", ["sb-1", "sb-2", "sb-3", "sb-4", "sb-5", "sb-6", "sb-7", "sb-8", "sb-9", "sb-10", "sb-11"]);
  put(state, "hand.0", ["sb-wild", "sb-20"]);
  put(state, "stock.0", ["sb-30"]);
  state.turn.seat = 0;
  state.turn.phase = "play";
  applyMove(state, { actor: 0, type: "playCard", cards: ["sb-wild"], from: "hand.0", to: "build.3" });

  const cleared = state.events.find((e) => e.type === "pileCleared");
  assert.ok(cleared, "pileCleared emitted");
  assert.equal(cleared.zone, "build.3");
  assert.equal(cleared.count, 12);
  // The synthetic draw pile is empty, so the documented cascade fires in the
  // same move: recycled dumps straight into draw — and says so on the wire.
  assert.ok(state.events.some((e) => e.type === "recycled"), "cascade recycle emitted");
  assert.equal(state.zones.count("draw"), 12);
  assert.equal(state.gameOver, false);
});
