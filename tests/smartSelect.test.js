// Holding a card gathers the meld it belongs to.
//
// The claim this file exists to pin is the same one the drag layer rests on,
// one level up:
//
//   a suggestion can never gather a group the player could not have tapped.
//
// smartSelection returns a SELECTION, never a move. arrangeContract stays the
// only thing that decides a lay-down is legal, so the worst a bad suggestion
// can do is leave the button unarmed. That makes the interesting questions
// "does it find the group a player would have picked?" and "does it decline
// cleanly when there is no group?" — both below, against the real pack.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState, moveCards } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { validateMove } from "../src/engine/movePipeline.js";
import { ROOT } from "../tools/stage.mjs";
import { smartSelection, buildUiModel, handAddress } from "../src/ui/interaction.js";

function packFromDisk(packId) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

/**
 * A Milestones table with seat 0 holding exactly `wanted`, in the meld phase
 * of contract `phase`. Cards are moved out of the deck by id so a test can
 * name the hand it means instead of hunting for a seed that deals it.
 */
function tableHolding(wanted, { phase = 1, seats = 3 } = {}) {
  const pack = packFromDisk("milestones");
  const state = createState({ pack, seats, seed: "smart-select" });
  pack.template.setup(makeCtx(state));

  const hand = handAddress(0);
  // Empty the seat, then deal it the named cards from wherever they sit.
  const held = state.zones.cards(hand).slice();
  if (held.length) moveCards(state, held, hand, "draw");
  for (const id of wanted) {
    const from = state.zones.allAddresses().find((a) => state.zones.cards(a).includes(id));
    assert.ok(from, `no such card in this pack: ${id}`);
    moveCards(state, [id], from, hand);
  }
  state.playerVars[0].phase = phase;
  state.turn = { ...state.turn, seat: 0, phase: "meld" };
  return state;
}

/** Every id the pack has for a given rank, so a test can pick three 7s. */
function idsOfRank(state, rank, howMany) {
  const out = [];
  for (const [id, card] of state.pack.cardsById) {
    if (String(card.rank) === String(rank)) out.push(id);
    if (out.length === howMany) break;
  }
  return out;
}

/** Wild ids, found the way the engine finds them: by the pack's wild tag. */
function wildIds(state, howMany) {
  const tag = state.pack.rules.wilds?.tag;
  const out = [];
  for (const [id, card] of state.pack.cardsById) {
    if (tag && card.tags?.includes(tag)) out.push(id);
    if (out.length === howMany) break;
  }
  return out;
}

function anyPack(packId) {
  const pack = packFromDisk(packId);
  const state = createState({ pack, seats: 3, seed: "other-pack" });
  pack.template.setup(makeCtx(state));
  return state;
}

/* ------------------------------------------------------------------ *
 * Finding the group
 * ------------------------------------------------------------------ */

test("holding one of three matching cards gathers the set", () => {
  const probe = anyPack("milestones");
  const sevens = idsOfRank(probe, 7, 3);
  assert.strictEqual(sevens.length, 3, "milestones should have at least three 7s");

  // Contract 1 is set(3) + set(3); the three 7s satisfy one of its items.
  const state = tableHolding([...sevens, "red-2", "blue-9"], { phase: 1 });
  const next = smartSelection(state, 0, sevens[0], null);

  assert.ok(next, "expected a suggestion");
  assert.strictEqual(next.from, handAddress(0));
  assert.deepStrictEqual([...next.cardIds].sort(), [...sevens].sort());
});

test("the held card is always in what comes back", () => {
  const probe = anyPack("milestones");
  const sevens = idsOfRank(probe, 7, 3);
  const state = tableHolding([...sevens, "red-2"], { phase: 1 });
  // Every one of the three, not just the first — the search picks candidates
  // in list order, and the held card is the one that must survive that.
  for (const id of sevens) {
    const next = smartSelection(state, 0, id, null);
    assert.ok(next, `no suggestion for ${id}`);
    assert.ok(next.cardIds.includes(id), `${id} was not in its own suggestion`);
  }
});

test("wilds fill a set the hand cannot complete on its own", () => {
  const probe = anyPack("milestones");
  const sevens = idsOfRank(probe, 7, 2);
  const wilds = wildIds(probe, 2);
  assert.ok(wilds.length >= 1, "milestones should have wilds");

  const state = tableHolding([...sevens, ...wilds, "red-2"], { phase: 1 });
  const next = smartSelection(state, 0, sevens[0], null);
  assert.ok(next, "expected a wild to complete the set");
  assert.strictEqual(next.cardIds.length, 3);
  assert.ok(next.cardIds.includes(sevens[0]) && next.cardIds.includes(sevens[1]));
  assert.ok(next.cardIds.some((id) => wilds.includes(id)), "expected a wild in the group");
});

/* ------------------------------------------------------------------ *
 * Declining cleanly
 * ------------------------------------------------------------------ */

test("a card with nothing to go with returns null rather than a guess", () => {
  // Five different ranks, no wilds: no set of three exists.
  const state = tableHolding(["red-2", "blue-4", "green-6", "yellow-9", "red-11"], { phase: 1 });
  assert.strictEqual(smartSelection(state, 0, "red-2", null), null);
});

test("holding a wild returns null — a wild has no meld of its own", () => {
  const probe = anyPack("milestones");
  const sevens = idsOfRank(probe, 7, 2);
  const [wild] = wildIds(probe, 1);
  const state = tableHolding([...sevens, wild, "red-2"], { phase: 1 });
  assert.strictEqual(smartSelection(state, 0, wild, null), null,
    "a wild belongs to whichever meld you spend it on");
});

test("a seat that has already laid down gets no suggestions", () => {
  const probe = anyPack("milestones");
  const sevens = idsOfRank(probe, 7, 3);
  const state = tableHolding([...sevens, "red-2"], { phase: 1 });
  state.playerVars[0].laidDown = true;
  assert.strictEqual(smartSelection(state, 0, sevens[0], null), null);
});

test("packs whose template has no opinion are left alone", () => {
  // The hook is optional; every non-rummy template omits it, and asking must
  // be a no-op rather than a crash.
  for (const packId of ["crazy-eights", "hearts", "stockpile", "wildfire"]) {
    const state = anyPack(packId);
    const held = state.zones.cards(handAddress(0))[0];
    assert.strictEqual(smartSelection(state, 0, held, null), null, packId);
  }
});

/* ------------------------------------------------------------------ *
 * Building a contract a group at a time
 * ------------------------------------------------------------------ */

test("a second hold adds to the first rather than replacing it", () => {
  const probe = anyPack("milestones");
  const sevens = idsOfRank(probe, 7, 3);
  const fours = idsOfRank(probe, 4, 3);
  const state = tableHolding([...sevens, ...fours], { phase: 1 });

  const first = smartSelection(state, 0, sevens[0], null);
  const second = smartSelection(state, 0, fours[0], first);

  assert.ok(second, "expected the second group");
  assert.deepStrictEqual([...second.cardIds].sort(), [...sevens, ...fours].sort());
  // Order matters to the tray: the first group keeps its place at the front.
  assert.deepStrictEqual(second.cardIds.slice(0, 3).sort(), [...sevens].sort());
});

test("holding a card already gathered changes nothing", () => {
  const probe = anyPack("milestones");
  const sevens = idsOfRank(probe, 7, 3);
  const state = tableHolding([...sevens, "red-2"], { phase: 1 });
  const first = smartSelection(state, 0, sevens[0], null);
  assert.strictEqual(smartSelection(state, 0, sevens[1], first), null,
    "nothing new to gather should be a no-op, not a redundant re-render");
});

/* ------------------------------------------------------------------ *
 * The invariant
 * ------------------------------------------------------------------ */

test("two gathered groups make a lay-down the engine accepts", () => {
  // The whole point: what a hold gathers must be something the ordinary
  // selection path could have produced and the engine will take.
  const probe = anyPack("milestones");
  const sevens = idsOfRank(probe, 7, 3);
  const fours = idsOfRank(probe, 4, 3);
  const state = tableHolding([...sevens, ...fours, "red-2"], { phase: 1 });

  let selection = smartSelection(state, 0, sevens[0], null);
  selection = smartSelection(state, 0, fours[0], selection);
  assert.ok(selection, "expected both groups");

  const ui = buildUiModel(state, { seat: 0, moves: [], acts: true, selection });
  assert.ok(ui.action, "the action button should have armed");
  assert.strictEqual(ui.action.label, "Lay down");
  assert.ok(validateMove(state, ui.action.makeMove()).legal,
    "the gathered lay-down was refused by the engine");
});

test("a second group is built from what the first left, not from all of it", () => {
  // Caught in the browser: holding two cards in a row reached for the SAME
  // wild twice, because the second suggestion searched the whole hand rather
  // than the ungathered part. The union then held five cards for a six-card
  // contract, and Lay down never armed — a suggestion that quietly wasted the
  // player's turn, which is worse than no suggestion at all.
  const probe = anyPack("milestones");
  const [one] = idsOfRank(probe, 1, 1);
  const [four] = idsOfRank(probe, 4, 1);
  const oneMore = idsOfRank(probe, 1, 2)[1];
  const wilds = wildIds(probe, 3);
  assert.strictEqual(wilds.length, 3, "this case needs three wilds");

  // Two 1s and a lone 4: the 1s want one wild, the 4 wants two.
  const state = tableHolding([one, oneMore, four, ...wilds], { phase: 1 });

  const first = smartSelection(state, 0, one, null);
  assert.ok(first, "expected the set of 1s");
  const second = smartSelection(state, 0, four, first);
  assert.ok(second, "expected the set of 4s");

  assert.strictEqual(new Set(second.cardIds).size, second.cardIds.length, "a card was gathered twice");
  assert.strictEqual(second.cardIds.length, 6, "a two-item contract needs six cards");

  const ui = buildUiModel(state, { seat: 0, moves: [], acts: true, selection: second });
  assert.ok(ui.action, "Lay down should have armed");
  assert.ok(validateMove(state, ui.action.makeMove()).legal);
});
