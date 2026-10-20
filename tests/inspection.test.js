// THE HAND, OPENED (src/ui/inspection.js) and THE LAST TRICK (src/ui/lastTrick.js)
// — the two pure halves of the end-of-hand and end-of-trick inspection.
//
// Played through real packs to a real round boundary where the question is about
// what the engine leaves behind (which hand a seat was caught with, which cards
// a Hearts pile priced), and hand-built where it is about positions and ids.

import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { createRng } from "../src/engine/rng.js";
import { forkState } from "../src/engine/fork.js";
import { poseTrick } from "../src/engine/poses.js";
import { viewFor } from "../src/engine/view.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { modelFromView } from "../src/ui/tableModel.js";
import { inspectionOf, plateReveal, countCardIds, partCardIds } from "../src/ui/inspection.js";
import { lastTrickOf, lastTrickOffered, lastTrickSentence } from "../src/ui/lastTrick.js";
import { actingSeats } from "./fixtures/engine.js";

/** Play `packId` with the house bot to its first round boundary. */
async function firstRoundEnd(packId, seats, seed = 3) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  const rng = createRng(seed);
  for (let guard = 0; guard < 3000; guard++) {
    const seat = actingSeats(state)[0] ?? state.turn.seat;
    const move = chooseBotMove(state, seat, { difficulty: "easy", random: rng.next });
    const ending = forkState(state);
    pack.template.applyMove(makeCtx(ending), move);
    applyMove(state, move);
    if (state.events.some((e) => e.type === "roundOver")) return { pack, state, ending, events: state.events.slice() };
  }
  assert.fail(`${packId}: no round ended`);
}

test("a Thirteen plate turns over the hand its seat was caught with, and wears its cost", async () => {
  const { ending, events } = await firstRoundEnd("thirteen", 4);
  const inspection = inspectionOf(events);
  let caught = 0;
  for (let seat = 0; seat < 4; seat++) {
    const hand = ending.zones.cards(`hand.${seat}`);
    const reveal = plateReveal(ending, inspection, seat);
    if (!hand.length) continue;
    caught += 1;
    assert.deepStrictEqual(reveal.cards, hand, "the plate shows the hand as the hand ended");
    assert.strictEqual(reveal.kind, "hand");
    const priced = inspection.counts.filter((c) => c.seat === seat).reduce((n, c) => n + c.points, 0);
    assert.strictEqual(reveal.points, priced, "the chip is what the round charged the seat");
  }
  assert.ok(caught > 0, "nobody was caught with cards, which makes this test blind");
});

test("a Hearts plate turns over what its seat TOOK, since its hand is played out", async () => {
  const { ending, events } = await firstRoundEnd("hearts", 4);
  const inspection = inspectionOf(events);
  const taken = inspection.counts.filter((c) => c.reason === "taken");
  assert.ok(taken.length, "nobody took a penalty card, which makes this test blind");
  for (const count of taken) {
    const reveal = plateReveal(ending, inspection, count.seat);
    assert.strictEqual(reveal.kind, "taken");
    assert.deepStrictEqual(reveal.cards, count.cards);
  }
});

test("a seat with nothing to show keeps its plate, and nothing turns over without an inspection", async () => {
  const { ending, events } = await firstRoundEnd("team-spades", 4);
  const inspection = inspectionOf(events);
  for (let seat = 0; seat < 4; seat++) {
    assert.strictEqual(plateReveal(ending, inspection, seat), null,
      "Team Spades prices tricks against bids — there is no hand left to show");
  }
  assert.strictEqual(plateReveal(ending, null, 0), null);
});

test("a guest's open ending turns over the same hands the host's does", async () => {
  const { pack, ending, events } = await firstRoundEnd("thirteen", 4);
  const inspection = inspectionOf(events);
  const closed = modelFromView(viewFor(ending, 1), pack);
  const open = modelFromView(viewFor(ending, 1, { open: true }), pack);
  for (let seat = 0; seat < 4; seat++) {
    if (seat === 1 || !ending.zones.cards(`hand.${seat}`).length) continue;
    assert.deepStrictEqual(plateReveal(open, inspection, seat).cards, ending.zones.cards(`hand.${seat}`),
      "the open pose carries every hand, so a guest's plate shows the real cards");
    const peek = plateReveal(closed, { counts: [] }, seat);
    assert.strictEqual(peek, null, "a closed view's placeholders are never drawn as a hand");
  }
  // The undealt stock is nobody's, and stays shut even in the open ending.
  for (const [address, zone] of Object.entries(viewFor(ending, 1, { open: true }).zones)) {
    const instance = ending.zones.get(address);
    if (instance.seat == null && instance.def.visibility === "none") {
      assert.ok(!zone.cards, `${address} is a shared hidden pile and was opened`);
    }
  }
});

test("a part points at its cards by position, with the cut appended and a hidden card held in place", () => {
  const count = { cards: ["a", "~h3", "c", "d"], parts: [] };
  assert.deepStrictEqual(countCardIds(count, "cut"), ["a", "c", "d", "cut"]);
  assert.deepStrictEqual(partCardIds(count, { at: [2, 4] }, "cut"), ["c", "cut"],
    "a hidden card keeps its position, or every part after it points one card along");
  assert.deepStrictEqual(partCardIds(count, { at: [1] }, "cut"), []);
});

/* ------------------------------------------------------------------ *
 * The last trick
 * ------------------------------------------------------------------ */

/** Play Hearts until a trick is about to complete; the pre-move state and the move. */
async function aboutToCompleteATrick() {
  const pack = await loadPackFromDisk("hearts");
  const state = createState({ pack, seats: 4, seed: 7 });
  pack.template.setup(makeCtx(state));
  const rng = createRng(7);
  for (let guard = 0; guard < 400; guard++) {
    const seat = actingSeats(state)[0] ?? state.turn.seat;
    const move = chooseBotMove(state, seat, { difficulty: "easy", random: rng.next });
    const pre = forkState(state);
    applyMove(state, move);
    const trick = state.events.find((e) => e.type === "trickWon");
    if (trick) return { pre, move, trick, state };
  }
  assert.fail("no trick completed");
}

test("the last trick names who played each card, in play order, and who took it", async () => {
  const { pre, move, trick } = await aboutToCompleteATrick();
  const pose = poseTrick(pre, move);
  const record = lastTrickOf(pose, trick, pre.roundNumber);
  assert.deepStrictEqual(record.cards.map((c) => c.id), trick.cards);
  const leader = pose.vars.leader;
  assert.strictEqual(record.cards[0].seat, leader, "the first card is the leader's");
  assert.ok(record.cards.every((c) => Number.isInteger(c.seat)), "every card has its player");
  assert.strictEqual(new Set(record.cards.map((c) => c.seat)).size, 4);
  assert.strictEqual(record.winner, trick.seat);
  // Without a pose the cards are still there; the seats are not guessed.
  const bare = lastTrickOf(null, trick, 1);
  assert.ok(bare.cards.every((c) => c.seat === null));
  assert.strictEqual(lastTrickOf(pose, { seat: 0, cards: [] }, 1), null);
});

test("the peek is offered only in its own hand, and only while play is live", async () => {
  const { pre, move, trick, state } = await aboutToCompleteATrick();
  const record = lastTrickOf(poseTrick(pre, move), trick, pre.roundNumber);
  assert.ok(lastTrickOffered(record, state));
  assert.ok(!lastTrickOffered(record, state, { held: true }), "not while a trick or a hand is held");
  assert.ok(!lastTrickOffered(record, { ...state, roundNumber: state.roundNumber + 1 }),
    "a trick from a hand that is over is not this hand's last trick");
  assert.ok(!lastTrickOffered(null, state));
  const said = lastTrickSentence(record, {
    label: (s) => `Seat ${s}`, cardOf: (id) => ({ id }), nameOf: (c) => c.id,
  });
  assert.match(said, new RegExp(`Seat ${trick.seat} took it`));
  for (const id of trick.cards) assert.ok(said.includes(id), "the chip's name reads every card out");
});
