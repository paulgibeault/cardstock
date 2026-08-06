// The action-card event vocabulary (src/templates/shedding.js).
//
// A skip, a reverse and a Draw 2 are the most consequential things anyone
// plays and were, until these events existed, the least visible: the state
// changed and the only trace on the felt was that the discard looked
// different. The table now narrates them (celebrateAction in src/ui/table.js),
// and what it narrates is this — so these tests pin the payloads the wording
// turns on, above all `seat`, which is always the seat it HAPPENED TO rather
// than the seat that played it.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

function put(state, address, cardIds) {
  const zone = state.zones.get(address);
  zone.cards.push(...cardIds);
  for (const id of cardIds) state.cardLocation.set(id, address);
}

// A three-seat Wildfire table mid-hand, with the deck left in the draw pile so
// a penalty has something real to deal.
async function wildfireTable({ hands, discard = ["red-5"], activeColor = "red", seat = 0 }) {
  const pack = await loadPackFromDisk("wildfire");
  const state = createState({ pack, seats: 3, seed: "action-events" });
  const placed = new Set([...discard, ...Object.values(hands).flat()]);
  put(state, "discard", discard);
  for (const [addr, cards] of Object.entries(hands)) put(state, addr, cards);
  put(state, "draw", [...pack.cardsById.keys()].filter((id) => !placed.has(id)));
  state.vars.activeColor = activeColor;
  state.turn.seat = seat;
  state.turn.phase = "play";
  return { pack, state };
}

function eventOf(state, type) {
  return state.events.find((e) => e.type === type);
}

test("a skip names the seat that loses its turn, not the one that played it", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-skip", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-skip"] });

  const ev = eventOf(state, "skipped");
  assert.ok(ev, "a skip emits `skipped`");
  assert.equal(ev.by, 0, "played by seat 0");
  assert.equal(ev.seat, 1, "landed on seat 1");
  assert.equal(state.turn.seat, 2, "and seat 1's turn is genuinely gone");
});

test("a reverse reports the direction now in force", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-reverse", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-reverse"] });

  const ev = eventOf(state, "reversed");
  assert.ok(ev, "a reverse emits `reversed`");
  assert.equal(ev.direction, -1, "the direction reported is the one after the flip");
  assert.equal(state.direction, -1);
});

test("a penalty reports the cards actually dealt", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-draw2", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-draw2"] });

  const ev = eventOf(state, "penalty");
  assert.ok(ev, "a Draw 2 emits `penalty`");
  assert.equal(ev.seat, 1, "it landed on seat 1");
  assert.equal(ev.drew, 2);
  assert.equal(ev.asked, 2);
  assert.equal(state.zones.count("hand.1"), 3, "one card became three");
});

test("a wild carries the value it chose, which its own face cannot show", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["wild", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["wild"], choice: { color: "blue" } });

  const ev = eventOf(state, "wildPlayed");
  assert.ok(ev, "a wild emits `wildPlayed`");
  assert.equal(ev.seat, 0);
  assert.equal(ev.chose.color, "blue", "the chosen colour rides on the event");
  assert.equal(state.vars.activeColor, "blue");
});

test("an ordinary card says nothing — the felt stays quiet", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-5#2", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-5#2"] });

  const noisy = state.events.filter((e) => e.type !== "roundOver" && e.type !== "roundStart");
  assert.deepEqual(noisy, [], `a plain play emitted ${JSON.stringify(noisy)}`);
});

test("winning on an action card does not penalise anybody", async () => {
  // applyPlayCard returns at the win before applyEffect, which is deliberate:
  // the hand is over, so there is no next player to hand two cards to. The
  // event channel has to agree, or the table narrates a penalty that the
  // engine never applied.
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-draw2"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-draw2"] });

  assert.equal(eventOf(state, "penalty"), undefined, "no penalty is announced");
  // The hand sizes cannot be read back for this: emptying a hand ends the
  // round, and the pipeline has already dealt the next one underneath this
  // move. What is observable is that the round ended, and that seat 0 was
  // scored as the winner — the losers' cards going TO them.
  const over = eventOf(state, "roundOver");
  assert.ok(over, "the hand ended");
  assert.ok(over.scores[0] > 0, `seat 0 won the round (scores: ${JSON.stringify(over.scores)})`);
});

test("the events survive a replay, because they are derived from the log", async () => {
  const { pack, state } = await wildfireTable({
    hands: { "hand.0": ["red-skip", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-skip"] });
  const first = eventOf(state, "skipped");

  // Same state, same move, applied again from scratch: the event stream is a
  // function of the move, never of anything the UI did with the last one.
  const { state: again } = await wildfireTable({
    hands: { "hand.0": ["red-skip", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(again, { actor: 0, type: "playCard", cards: ["red-skip"] });

  assert.deepEqual(eventOf(again, "skipped"), first);
  assert.ok(pack);
});

test("the event window is one move wide", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-skip", "red-3"], "hand.1": ["blue-1"], "hand.2": ["red-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-skip"] });
  assert.ok(eventOf(state, "skipped"));

  // Seat 1 was skipped, so seat 2 acts next; their plain play must clear it.
  applyMove(state, { actor: 2, type: "playCard", cards: ["red-2"] });
  assert.equal(eventOf(state, "skipped"), undefined, "last move's event did not linger");
});
