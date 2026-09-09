// ONE HOOK FOR EVERY SIMULTANEOUS COMMIT, and the two shapes it has to carry.
//
// #106 and #107 were built in parallel and each invented `commitPrompt` for the
// `pass` gesture: Cribbage's crib wanted a COUNT and the two status sentences,
// Pinochle's meld wanted a MOVE TYPE and a min/max — because a meld is
// committed at any size, nothing at all included, and a commit of zero cards
// has no card-carrying move for the platform to read the type off. Hearts'
// pass, which the hook was carved out of, wants the count and reads its move
// off the enumeration. This file is where the three agree.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { enumerateLegalMoves, applyMove } from "../src/engine/movePipeline.js";
import { buildUiModel, commitPromptFor, handAddress } from "../src/ui/interaction.js";
import { ROOT } from "../tools/stage.mjs";

function packFromDisk(packId) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

function dealt(packId, seats, seed) {
  const pack = packFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

const handOf = (state, seat) => makeCtx(state).cardIdsIn(makeCtx(state).zoneAddr("hand", seat));
const picked = (seat, cardIds) => ({ from: handAddress(seat), cardIds });
const model = (state, seat, selection) =>
  buildUiModel(state, { seat, moves: enumerateLegalMoves(state, seat), acts: true, selection });

test("Hearts' pass: an exact count, and the move read off the enumeration", () => {
  const state = dealt("hearts", 4, "commit:hearts");
  assert.strictEqual(state.turn.phase, "pass", "hand one opens with a pass");
  const prompt = commitPromptFor(state, 0, enumerateLegalMoves(state, 0));
  assert.deepStrictEqual(
    [prompt.count, prompt.min, prompt.max, prompt.moveType],
    [3, 3, 3, "passCards"],
    "the count is the template's, the move type the enumeration's");
  assert.match(prompt.action, /^Pass/);
  assert.strictEqual(prompt.staging, "Passing — pick 3");

  const hand = handOf(state, 0);
  assert.strictEqual(model(state, 0, null).action, null, "nothing staged, no button");
  assert.strictEqual(model(state, 0, picked(0, hand.slice(0, 2))).action, null, "two is not three");
  const armed = model(state, 0, picked(0, hand.slice(0, 3)));
  assert.strictEqual(armed.action?.label, prompt.action);
  assert.deepStrictEqual(armed.action.makeMove(), { actor: 0, type: "passCards", cards: hand.slice(0, 3) });
});

test("Cribbage's crib: the count is the pack's, the words are the template's", () => {
  const state = dealt("cribbage", 2, "commit:cribbage");
  assert.strictEqual(state.turn.phase, "discard");
  const prompt = commitPromptFor(state, 0, enumerateLegalMoves(state, 0));
  assert.strictEqual(prompt.count, state.pack.rules.crib);
  assert.strictEqual(prompt.min, prompt.max);
  assert.match(prompt.action, /crib$/i, "whose crib it is, on the button");
  // WHOSE CRIB, BEFORE THE COMMIT AND NOT ONLY ON IT (#124, item 42). The
  // button does not appear until both cards are staged, so a staging sentence
  // that says only "Crib — pick 2" withholds the one fact the choice turns on
  // until after the choice is made. `dealer` is public from the deal.
  assert.strictEqual(prompt.staging, `${prompt.action} — pick ${state.pack.rules.crib}`);
  assert.match(prompt.staging, /^(Your|Their) crib —/,
    "the staging sentence names whose crib it is");
  const hand = handOf(state, 0);
  assert.strictEqual(model(state, 0, picked(0, hand.slice(0, 1))).action, null);
  assert.strictEqual(model(state, 0, picked(0, hand.slice(0, prompt.count))).action?.label, prompt.action);
});

test("Pinochle's meld: a ranged commit that names its move, armed on nothing at all", () => {
  const state = dealt("pinochle", 4, "commit:pinochle");
  // The rule tests' meld-phase setup: the auction is over, hearts are trump.
  state.turn = { ...state.turn, seat: 1, phase: "meld" };
  state.vars.trumpSuit = "hearts";
  for (let s = 0; s < 4; s++) state.playerVars[s].bid = s === 1 ? 150 : 0;

  const prompt = commitPromptFor(state, 0, enumerateLegalMoves(state, 0));
  assert.strictEqual(prompt.moveType, "declareMeld", "named by the template — a zero-card commit has no card to read it off");
  assert.deepStrictEqual([prompt.min, prompt.max], [0, handOf(state, 0).length]);
  assert.strictEqual(prompt.action, "Declare");
  assert.strictEqual(prompt.staging, "Declare your meld");
  assert.strictEqual(prompt.waiting, "Waiting for melds…");

  const empty = model(state, 0, null);
  assert.strictEqual(empty.action?.label, "Declare", "an empty selection is a real declaration");
  assert.deepStrictEqual(empty.action.makeMove(), { actor: 0, type: "declareMeld", cards: [] });
  const some = model(state, 0, picked(0, handOf(state, 0).slice(0, 5)));
  assert.strictEqual(some.action?.label, "Declare", "and so is any number of cards");

  applyMove(state, { actor: 0, type: "declareMeld", cards: [] });
  const after = commitPromptFor(state, 0, enumerateLegalMoves(state, 0));
  assert.strictEqual(after.moveType, null, "a seat that has declared is offered nothing");
  assert.strictEqual(model(state, 0, picked(0, handOf(state, 0).slice(0, 2))).action, null,
    "so there is no button, however many cards are selected");
});
