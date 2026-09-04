// The draw turn: `playAfterDraw` and `mustPlayIfAble` (src/templates/shedding.js).
//
// The pack rule tests (packs/*/tests/rules.test.json) pin the RULES — what is
// legal after a draw, and what the turn does next. What they cannot reach is
// the two places the rule has to hold for it to be real at a table: the move
// LIST, which is what a bot chooses from and what every tap target on the felt
// is derived from, and the UI MODEL, which has to offer exactly two exits and
// never a dead end. Both are pinned here, along with the flag gating — a pack
// that does not ask for this must play exactly as it did before.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, validateMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { interactionMode, buildUiModel, handAddress } from "../src/ui/interaction.js";

function put(state, address, cardIds) {
  const zone = state.zones.get(address);
  zone.cards.push(...cardIds);
  for (const id of cardIds) state.cardLocation.set(id, address);
}

/**
 * A three-seat shedding table with the draw pile STACKED: `deck` is bottom-
 * first, so its last id is the card the next draw turns up. Everything
 * unmentioned goes underneath, so the pile is still a real pile.
 */
async function table({
  packId = "wildfire", hands, deck = [], discard = ["red-7"], active = { activeColor: "red" },
} = {}) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats: 3, seed: "play-after-draw" });
  const placed = new Set([...discard, ...deck, ...Object.values(hands).flat()]);
  put(state, "discard", discard);
  for (const [address, cards] of Object.entries(hands)) put(state, address, cards);
  put(state, "draw", [...pack.cardsById.keys()].filter((id) => !placed.has(id)));
  put(state, "draw", deck);
  Object.assign(state.vars, active);
  state.turn.seat = 0;
  state.turn.phase = "play";
  return { pack, state };
}

// red-3 matches the discard's colour and green-7 its rank, so seat 0 always
// opens with something perfectly playable in hand.
const HANDS = { "hand.0": ["red-3", "green-7", "blue-2"], "hand.1": ["blue-1"], "hand.2": ["blue-9"] };

/* ------------------------------------------------------------------ *
 * What is on offer
 * ------------------------------------------------------------------ */

test("after a draw the enumerated turn is the drawn card and a pass, nothing else", async () => {
  const { state } = await table({ hands: HANDS, deck: ["red-5"] });
  // Two cards are playable BEFORE the draw — that is the point of the test.
  const before = enumerateLegalMoves(state, 0);
  assert.deepStrictEqual(
    before.filter((m) => m.type === "playCard").map((m) => m.cards[0]).sort(),
    ["green-7", "red-3"]);

  applyMove(state, { actor: 0, type: "draw" });
  assert.equal(state.turn.phase, "playDrawn");

  const moves = enumerateLegalMoves(state, 0);
  assert.deepStrictEqual(moves.map((m) => m.type), ["playCard", "pass"]);
  assert.deepStrictEqual(moves[0].cards, ["red-5"]);
  // The hand still HOLDS the cards it held; they are simply not this turn's.
  assert.equal(state.zones.cards(handAddress(0)).length, 4);
});

test("a drawn wild is playable at once, and still enumerates one move per colour", async () => {
  const { state } = await table({ hands: HANDS, deck: ["wild"] });
  applyMove(state, { actor: 0, type: "draw" });

  const moves = enumerateLegalMoves(state, 0);
  const plays = moves.filter((m) => m.type === "playCard");
  assert.ok(plays.length > 1, "a wild that enumerates once has lost its colour choice");
  assert.deepStrictEqual([...new Set(plays.map((m) => m.cards[0]))], ["wild"]);
  assert.deepStrictEqual(
    plays.map((m) => m.choice.color).sort(), ["blue", "green", "red", "yellow"]);
  for (const move of plays) assert.ok(validateMove(state, move).legal);
  assert.ok(moves.some((m) => m.type === "pass"), "and keeping it is still an option");
});

test("the drew-playable event says who, and deliberately not what", async () => {
  const { state } = await table({ hands: HANDS, deck: ["red-5"] });
  applyMove(state, { actor: 0, type: "draw" });
  const ev = state.events.find((e) => e.type === "drewPlayable");
  // Every seat's view reads this stream, so the card must not travel on it.
  assert.deepStrictEqual(ev, { type: "drewPlayable", seat: 0 });
});

test("a drawn card that fits nothing never enters the phase at all", async () => {
  const { state } = await table({ hands: HANDS, deck: ["blue-9#2"] });
  applyMove(state, { actor: 0, type: "draw" });
  assert.equal(state.turn.phase, "play");
  assert.equal(state.turn.seat, 1);
  assert.equal(state.vars.drawnCardId, null);
});

/* ------------------------------------------------------------------ *
 * Bots
 * ------------------------------------------------------------------ */

test("a bot is never stranded in the phase — both exits are moves it can pick", async () => {
  const { state } = await table({ hands: HANDS, deck: ["red-5"] });
  applyMove(state, { actor: 0, type: "draw" });

  const chosen = chooseBotMove(state, 0);
  assert.equal(chosen.type, "playCard", "a playable draw is worth more than keeping it");
  assert.deepStrictEqual(chosen.cards, ["red-5"]);

  // And the road not taken hands the turn on rather than looping.
  applyMove(state, { actor: 0, type: "pass" });
  assert.equal(state.turn.seat, 1);
  assert.equal(state.turn.phase, "play");
  assert.equal(state.vars.drawnCardId, null);
});

/* ------------------------------------------------------------------ *
 * The flags are the whole switch
 * ------------------------------------------------------------------ */

test("a pack that does not ask for play-after-draw plays exactly as it did", async () => {
  const { pack, state } = await table({ hands: HANDS, deck: ["red-5"] });
  pack.rules.playAfterDraw = false;

  applyMove(state, { actor: 0, type: "draw" });
  assert.equal(state.turn.phase, "play", "no detour");
  assert.equal(state.turn.seat, 1, "the draw ends the turn, as it always did");
  assert.equal(validateMove(state, { actor: 1, type: "pass" }).rule, "phase",
    "and there is no pass to make");
});

/* ------------------------------------------------------------------ *
 * What the felt offers
 * ------------------------------------------------------------------ */

function uiFor(state) {
  return buildUiModel(state, {
    seat: 0, moves: enumerateLegalMoves(state, 0), acts: true, selection: null,
  });
}

test("the draw pile is offered while you are holding a card that fits", async () => {
  const { state } = await table({ hands: HANDS, deck: ["red-5"] });
  const ui = uiFor(state);
  assert.equal(ui.mode, "tap");
  assert.ok(ui.handSelectable.size > 0, "the setup is only interesting with a playable hand");
  assert.ok(ui.readyTargets.has("draw"), "saving a wild is a legal turn, so the pile must be live");
});

test("a pack that compels a play still only lights the pile when you are stuck", async () => {
  const { pack, state } = await table({ hands: HANDS, deck: ["red-5"] });
  pack.rules.mustPlayIfAble = true;
  assert.ok(!uiFor(state).readyTargets.has("draw"));

  // Nothing playable: the pile lighting up is itself the news.
  state.zones.get(handAddress(0)).cards.length = 0;
  put(state, handAddress(0), ["blue-9#2"]);
  assert.ok(uiFor(state).readyTargets.has("draw"));
});

test("the drawn-card turn has exactly two exits, and both are one tap", async () => {
  const { state } = await table({ hands: HANDS, deck: ["red-5"] });
  applyMove(state, { actor: 0, type: "draw" });

  assert.equal(interactionMode(state), "play-drawn");
  const ui = uiFor(state);
  assert.deepStrictEqual([...ui.handSelectable], ["red-5"],
    "the hand held before the draw is not tappable");
  assert.equal(ui.readyTargets.size, 0, "and there is no second draw to take");

  // The two exits ARE the two assertions around this line: the drawn card is
  // the only tappable thing in hand, and the button is the other way out. What
  // used to sit here was a check that a sentence in the bar above the hand
  // said so in words; there is no bar and no sentence now, and the button's
  // own label is the whole of what the felt says about the choice.
  assert.equal(ui.action.label, "Keep it");
  const move = ui.action.makeMove();
  assert.ok(validateMove(state, move).legal, "the button must never offer an illegal move");
  applyMove(state, move);
  assert.equal(state.turn.seat, 1);
});
