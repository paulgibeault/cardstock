// The drag layer's brain, tested without a pointer.
//
// Pointer choreography needs hands on a device; WHERE A CARD MAY LAND does
// not, and that is the part with a correctness claim attached:
//
//   a dragged card can never construct a move a tap could not.
//
// That is the invariant the whole drag feature rests on. If dropCandidates
// ever returns a move that is not in enumerateLegalMoves, the UI has grown a
// second rules path and the engine's validator becomes the only thing standing
// between a mis-drop and a corrupt match. So every test below ends up
// comparing what a drop offers against what the engine actually allows.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { rankLadderOf } from "../src/engine/cards.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { validateMove, enumerateLegalMoves, applyMove } from "../src/engine/movePipeline.js";
import { ROOT } from "../tools/stage.mjs";
import {
  interactionMode, stagingPhase, gathers, buildUiModel, dropCandidates, draggableSources,
  pruneSelection, toggleHandSelection, stagedSelection, smartSelection,
  isSelected, handAddress, implicitLandingZone,
  shortContract, shortContractItem, describeContract, describeContractItem,
  ladderRungs, ACTION_LABEL_MAX_CHARS,
} from "../src/ui/interaction.js";
import {
  orderHand, applyManual, reorder, nextMode, fanStep, fanWidth, liftGap, resolveCardWidth, SORT_MODES,
  fanLayout, handRows,
  classifyHandGesture,
} from "../src/ui/handOrder.js";

function packFromDisk(packId) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

/** A dealt match with the turn handed to seat 0, so "the human" can act. */
function tableFor(packId, seed = "interaction") {
  const pack = packFromDisk(packId);
  const state = createState({ pack, seats: 3, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/** Advance until seat 0 may act, so the model has something to answer. */
function untilHumansTurn(state, limit = 200) {
  for (let i = 0; i < limit && !state.gameOver; i++) {
    const template = state.pack.template;
    const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    if (acting.includes(0)) return true;
    const moves = enumerateLegalMoves(state, acting[0]);
    if (!moves.length) return false;
    applyMove(state, moves[0]);
  }
  return !state.gameOver;
}

const PACKS = ["crazy-eights", "wildfire", "hearts", "milestones", "stockpile",
  "thirteen", "cribbage"];

test("every pack's interaction mode is one the table knows how to render", () => {
  const known = new Set(["tap", "play-drawn", "pass", "rummy-draw", "rummy-meld", "place", "combination"]);
  for (const packId of PACKS) {
    assert.ok(known.has(interactionMode(tableFor(packId))), `${packId} has an unknown mode`);
    // Every phase a template can reach, not only the one a fresh deal opens on:
    // a phase with no mode renders as 'tap' by accident, which is how a table
    // ends up offering the whole hand in a state that allows one card.
    for (const phase of ["play", "pass", "draw", "meld", "discard", "playDrawn"]) {
      const state = tableFor(packId, `phases:${packId}`);
      state.turn.phase = phase;
      assert.ok(known.has(interactionMode(state)),
        `${packId} in phase ${phase} has an unknown mode`);
    }
  }
});

test("no drop is ever offered that the engine would refuse", () => {
  for (const packId of PACKS) {
    const state = tableFor(packId, `drops:${packId}`);
    if (!untilHumansTurn(state)) continue;
    const moves = enumerateLegalMoves(state, 0);
    const { hand, piles } = draggableSources(state, { seat: 0, acts: true });

    const sources = [
      ...[...hand].map((cardId) => ({ from: handAddress(0), cardId })),
      ...[...piles].map(([from, cardId]) => ({ from, cardId })),
    ];
    let offered = 0;
    for (const source of sources) {
      for (const candidate of dropCandidates(state, { seat: 0, moves, source })) {
        offered++;
        assert.strictEqual(candidate.move.actor, 0, `${packId}: a drop acted for another seat`);
        const check = validateMove(state, candidate.move);
        if (check.legal) continue;

        // The ONE permitted incompleteness: a card that owes a question the
        // table is about to ask (a wild's colour). Anything else means the drop
        // layer offered something the engine would throw out.
        assert.strictEqual(check.rule, "choice-required",
          `${packId}: offered an illegal drop for ${source.cardId} `
          + `(${check.rule}: ${check.reason})`);
        // ...and answering it must actually make the move legal, so the prompt
        // is a completion rather than a detour into a different move.
        const answered = moves.find((m) =>
          m.type === candidate.move.type && m.cards?.[0] === candidate.move.cards[0] && m.choice);
        assert.ok(answered && validateMove(state, answered).legal,
          `${packId}: no answer to the required choice makes ${source.cardId} playable`);
      }
    }
    // A pack where nothing is ever droppable would pass the assertion above
    // vacuously, which is the failure mode this guards. Two modes legitimately
    // have nowhere to drop: drawing is a pile TAP, and passing is committed by
    // a button — in both, dragging a hand card can only ever be rearranging.
    const dropless = new Set(["rummy-draw", "pass"]);
    if (!dropless.has(interactionMode(state))) {
      assert.ok(offered > 0, `${packId}: no drop target at all on the human's turn`);
    }
  }
});

test("a card with nothing legal to do still lifts — it simply has nowhere to land", () => {
  const state = tableFor("crazy-eights", "nolegal");
  untilHumansTurn(state);
  const { hand } = draggableSources(state, { seat: 0, acts: true });
  const moves = enumerateLegalMoves(state, 0);
  const playable = new Set(moves.filter((m) => m.type === "playCard").map((m) => m.cards[0]));
  const dead = [...hand].find((id) => !playable.has(id));
  if (!dead) return;

  assert.ok(hand.has(dead), "an unplayable card must still be draggable");
  assert.deepStrictEqual(
    dropCandidates(state, { seat: 0, moves, source: { from: handAddress(0), cardId: dead } }),
    [], "an unplayable card must be offered no destination");
});

test("every hand card is draggable, playable or not", () => {
  const state = tableFor("hearts", "alldrag");
  untilHumansTurn(state);
  const { hand } = draggableSources(state, { seat: 0, acts: true });
  assert.strictEqual(hand.size, state.zones.cards(handAddress(0)).length);
});

test("an opponent's turn leaves the human's own cards liftable but inert", () => {
  const state = tableFor("crazy-eights", "notmyturn");
  const { hand, piles } = draggableSources(state, { seat: 0, acts: false });
  assert.strictEqual(hand.size, state.zones.cards(handAddress(0)).length,
    "tidying your hand is not a turn action");
  assert.strictEqual(piles.size, 0, "no pile top is pickable when it is not your turn");
});

test("a dropped wild carries no colour, so the same prompt a tap gets still fires", () => {
  const state = tableFor("wildfire", "wilddrop");
  untilHumansTurn(state);
  const moves = enumerateLegalMoves(state, 0);
  const wild = moves.find((m) => m.type === "playCard" && m.choice);
  if (!wild) return;

  const [candidate] = dropCandidates(state, {
    seat: 0, moves, source: { from: handAddress(0), cardId: wild.cards[0] },
  });
  assert.ok(candidate, "a wild must still be droppable");
  assert.strictEqual(candidate.move.choice, undefined,
    "a drop must not silently inherit one of the enumerated colours");
});

test("Stockpile's own pile tops are pickable, and nobody else's are", () => {
  const state = tableFor("stockpile", "piles");
  untilHumansTurn(state);
  const { piles } = draggableSources(state, { seat: 0, acts: true });
  assert.ok(piles.size > 0, "the stock top should be pickable");
  for (const address of piles.keys()) {
    assert.ok(address.endsWith(".0"), `${address} is not seat 0's pile`);
  }
});

test("a selection the state has moved out from under is dropped", () => {
  const state = tableFor("crazy-eights", "prune");
  const handAddr = handAddress(0);
  const [first] = state.zones.cards(handAddr);

  const live = { from: handAddr, cardIds: [first] };
  assert.strictEqual(pruneSelection(state, live), live);
  assert.strictEqual(pruneSelection(state, { from: handAddr, cardIds: ["not-a-card"] }), null);
  assert.strictEqual(pruneSelection(state, { from: "no.such.zone", cardIds: [first] }), null);
  assert.strictEqual(pruneSelection(state, null), null);
  assert.ok(isSelected(live, handAddr, first));
  assert.ok(!isSelected(live, "discard", first));
});

test("pruning keeps the staged cards a move did not consume", () => {
  // The reason a Milestones meld can be built across turns: every turn ends in
  // a discard, and dropping the whole selection because ONE card left the hand
  // meant the tray never survived one.
  const state = tableFor("milestones", "prune-partial");
  const handAddr = handAddress(0);
  const [a, b, c] = state.zones.cards(handAddr);

  const staged = { from: handAddr, cardIds: [a, b, c] };
  // `c` is discarded out from under the selection; `a` and `b` are still held.
  state.zones.cards(handAddr).splice(state.zones.cards(handAddr).indexOf(c), 1);

  const kept = pruneSelection(state, staged);
  assert.deepStrictEqual(kept.cardIds, [a, b], "the unspent cards stay staged");
  assert.strictEqual(kept.from, handAddr);

  // And a selection with nothing left really is gone, so callers can keep
  // treating a spent one as absent.
  assert.strictEqual(pruneSelection(state, { from: handAddr, cardIds: [c] }), null);
});

test("the UI model offers nothing at all when the human may not act", () => {
  const state = tableFor("hearts", "inert");
  const ui = buildUiModel(state, { seat: 0, moves: [], acts: false, selection: null });
  assert.strictEqual(ui.handSelectable.size, 0);
  assert.strictEqual(ui.readyTargets.size, 0);
  assert.strictEqual(ui.action, null);
});

/* ------------------------------------------------------------------ *
 * Off-turn gathering — and the phase that must not be able to stop it
 * ------------------------------------------------------------------ *
 *
 * `turn.phase` is ONE value for the whole table, so the interaction mode a
 * template derives from it says what the TABLE is doing, never what this seat
 * may do. Every test below therefore runs in BOTH phases: the previous version
 * of this file set `turn.phase = "meld"` by hand and so pinned the single value
 * where the affordance happened to work, while the reported bug — the tray
 * going dead for the first half of every opponent's turn — lived entirely in
 * the other one.
 */
for (const phase of ["draw", "meld"]) {
  test(`off-turn in the ${phase} phase, a contract meld can still be arranged — and only that`, () => {
    // The one affordance that survives losing the turn: staging commits nothing
    // and touches no zone, and it is the job a rummy player actually wants to do
    // while the bots think. Laying down stays a turn-only move.
    const state = tableFor("milestones", "off-turn-stage");
    state.turn.phase = phase;
    state.turn.seat = 1;
    state.playerVars[0].laidDown = false;
    const ui = buildUiModel(state, { seat: 0, moves: [], acts: false, selection: null });

    assert.ok(ui.handSelectable.size > 0, "cards can still be gathered");
    assert.strictEqual(ui.handMulti, true, "the tray stays open");
    assert.strictEqual(ui.action, null, "but Lay down is not offered off-turn");
    assert.strictEqual(ui.readyTargets.size, 0, "and no pile is a target");
  });

  test(`off-turn staging stops once the contract is down (${phase} phase)`, () => {
    const state = tableFor("milestones", "off-turn-laid");
    state.turn.phase = phase;
    state.turn.seat = 1;
    state.playerVars[0].laidDown = true;
    const ui = buildUiModel(state, { seat: 0, moves: [], acts: false, selection: null });
    assert.strictEqual(ui.handSelectable.size, 0, "there is no meld left to arrange");
    assert.strictEqual(ui.handMulti, false);
    assert.strictEqual(ui.gathering, false, "and a hold gathers nothing either");
  });

  test(`hold-to-gather is armed off-turn in the ${phase} phase`, () => {
    // What `smartSelectArmed` reads (src/ui/handGestures.js). Keyed on the mode
    // string it disarmed the moment an opponent started their turn, so the
    // fastest way to build a meld stopped working for half of every bot turn.
    const state = tableFor("milestones", `off-turn-hold-${phase}`);
    state.turn.phase = phase;
    state.turn.seat = 1;
    state.playerVars[0].laidDown = false;
    const ui = buildUiModel(state, { seat: 0, moves: [], acts: false, selection: null });
    assert.strictEqual(ui.gathering, true, "the hold has to survive the turn passing");

    // And the gesture behind the flag answers off-turn too: the suggestion is a
    // selection, never a move, so there is nothing about it to hold for a turn.
    const held = state.zones.cards(handAddress(0));
    const suggested = held.map((id) => smartSelection(state, 0, id, null)).filter(Boolean);
    assert.ok(suggested.length > 0, "a ten-card Milestones hand has some group in it");
  });
}

test("gathering is a fact about the seat's round, not about the table's phase", () => {
  const state = tableFor("milestones", "gathers-hook");
  state.turn.seat = 1;
  for (const phase of ["draw", "meld"]) {
    state.turn.phase = phase;
    state.playerVars[0].laidDown = false;
    assert.strictEqual(gathers(state, 0), true, `${phase}: still assembling a contract`);
    state.playerVars[0].laidDown = true;
    // The phase still stages — somebody at this table may be gathering — and
    // this seat is nonetheless finished. That gap is the whole point of the
    // hook, and it is what lets the tray hand its slot back (renderStageTray).
    assert.strictEqual(stagingPhase(state), true, `${phase}: the mode still stages`);
    assert.strictEqual(gathers(state, 0), false, `${phase}: but this seat is done`);
    // A seat that is done gathering keeps a live hand — it can hit and discard.
    assert.strictEqual(smartSelection(state, 0, state.zones.cards(handAddress(0))[0], null), null,
      `${phase}: nothing left to gather, so a hold suggests nothing`);
  }
});

test("a tap never throws away a gathered meld", () => {
  // THE SHARP ONE. A staged card keeps its click listener whatever the model
  // says (src/ui/table.js), and the single-select branch used to answer a tap
  // on an already-selected card with `null` — so one tap on the tray during an
  // opponent's DRAW phase, when the mode had gone single-select under the
  // player's feet, threw the entire gathered meld away.
  const state = tableFor("milestones", "tray-clobber");
  state.turn.phase = "draw";
  state.turn.seat = 1;
  state.playerVars[0].laidDown = false;
  const handAddr = handAddress(0);
  const [a, b, c] = state.zones.cards(handAddr);
  const staged = { from: handAddr, cardIds: [a, b, c] };

  // The model must not go single-select off-turn in the first place...
  const ui = buildUiModel(state, { seat: 0, moves: [], acts: false, selection: staged });
  assert.strictEqual(ui.handMulti, true, "the draw phase belongs to the table, not to this seat");

  const multi = toggleHandSelection(staged, { from: handAddr, cardId: b, multi: ui.handMulti });
  assert.deepStrictEqual(multi.cardIds, [a, c], "toggling one card out leaves the other two");

  // ...and if it ever does again, one card is all a tap may cost.
  const single = toggleHandSelection(staged, { from: handAddr, cardId: b, multi: false });
  assert.ok(single, "a single-select tap must not throw the whole tray away");
  assert.deepStrictEqual(single.cardIds, [a, c], "a single-select tap clears only the card it hit");
  assert.strictEqual(toggleHandSelection({ from: handAddr, cardIds: [a] },
    { from: handAddr, cardId: a, multi: false }), null, "the last card still deselects to nothing");
  assert.deepStrictEqual(
    toggleHandSelection(staged, { from: handAddr, cardId: b, multi: true }).cardIds, [a, c]);
  assert.deepStrictEqual(
    toggleHandSelection(null, { from: handAddr, cardId: b }), { from: handAddr, cardIds: [b] });
});

test("a pack with no gathers hook answers exactly as the mode does", () => {
  // What the default is for. Hearts stages a pass and the other three never
  // stage at all; none of them can finish gathering before the phase does, so
  // none of them implements the hook, and none of them may notice it exists.
  for (const packId of ["hearts", "crazy-eights", "wildfire", "stockpile"]) {
    const state = tableFor(packId, `no-hook:${packId}`);
    assert.strictEqual(state.pack.template.gathers, undefined,
      `${packId} does not implement the hook — this test is about the default`);
    for (let seat = 0; seat < 3; seat++) {
      assert.strictEqual(gathers(state, seat), stagingPhase(state),
        `${packId}: the default has to be today's answer, seat ${seat}`);
    }
  }
});

test("the tray hands its space back the moment the contract is down", () => {
  // Two bugs in one gate. The tray's slot was reserved on the PHASE, so after a
  // lay-down it went on holding a card's height of invisible, inert felt between
  // the meld chips and the hand for the rest of the round. And its CONTENTS
  // came from the same gate, so a post-lay-down single selection was drawn in
  // the tray by a full render while the fast path lifted the same card in the
  // fan — tap a card, watch a bot move, and the card had teleported.
  const state = tableFor("milestones", "tray-yields");
  const handAddr = handAddress(0);
  const [a, b] = state.zones.cards(handAddr);
  const gathered = { from: handAddr, cardIds: [a, b] };
  const one = { from: handAddr, cardIds: [a] };

  state.playerVars[0].laidDown = false;
  assert.deepStrictEqual(stagedSelection(state, 0, gathered), [a, b], "a gathered meld waits in the tray");

  state.playerVars[0].laidDown = true;
  assert.deepStrictEqual(stagedSelection(state, 0, one), [],
    "a card picked to hit with stays in the fan, where the gesture expects it");
  assert.deepStrictEqual(stagedSelection(state, 0, gathered), []);
  // Hearts is the pack the default is for: its tray still follows the phase.
  const hearts = tableFor("hearts", "tray-hearts");
  const heartsHand = handAddress(hearts.turn.seat);
  const [x, y] = hearts.zones.cards(heartsHand);
  assert.deepStrictEqual(
    stagedSelection(hearts, hearts.turn.seat, { from: heartsHand, cardIds: [x, y] }), [x, y]);
});

test("the off-turn tray is offered only to a template that answers per seat", () => {
  // Hearts is why the DEFAULT cannot open a tray off-turn: everyone commits
  // their pass at once, so a seat that has passed sits off-turn while the pass
  // phase — and with it the staging mode — is still open. The default answers
  // about the TABLE, and off-turn the difference between that and "I am still
  // assembling something" is the entire question.
  const state = tableFor("hearts", "committed-pass");
  const passer = state.turn.seat;
  const cards = state.zones.cards(handAddress(passer)).slice(0, 3);
  applyMove(state, { actor: passer, type: "passCards", cards });
  assert.strictEqual(interactionMode(state), "pass", "still the passing phase");
  assert.strictEqual(gathers(state, passer), true, "the phase still stages, for somebody");

  const ui = buildUiModel(state, { seat: passer, moves: [], acts: false, selection: null });
  assert.strictEqual(ui.handSelectable.size, 0, "a committed pass is not re-arrangeable");
  assert.strictEqual(ui.handMulti, false);
  assert.strictEqual(ui.gathering, false);
});

test("a played card's implicit landing zone is one the pack actually has", () => {
  for (const packId of ["crazy-eights", "wildfire", "hearts"]) {
    const state = tableFor(packId, `landing:${packId}`);
    untilHumansTurn(state);
    const move = enumerateLegalMoves(state, 0).find((m) => m.type === "playCard");
    if (!move) continue;
    const address = implicitLandingZone(state, move);
    assert.ok(address && state.zones.has(address), `${packId}: bad landing zone ${address}`);
  }
});

/* ------------------------------------------------------------------ *
 * Playing a wild onto someone's meld
 * ------------------------------------------------------------------ *
 *
 * A wild becomes a specific card the moment it lands, so the value is part of
 * the move — and where a meld leaves two honest answers, the value is the
 * PLAYER'S to give. These tests hold the seam between the two halves of that:
 * the engine enumerates one move per value, and the UI model must not quietly
 * keep whichever came last.
 */

/** Seat 1 sitting behind a laid-down run of 3-4-5-6, two of it wild. */
function meldTable({ hand, cards, wilds, item }) {
  const state = createState({ pack: packFromDisk("milestones"), seats: 3, seed: "wilds" });
  for (const id of hand) {
    state.zones.get("hand.0").cards.push(id);
    state.cardLocation.set(id, "hand.0");
  }
  for (const id of cards) {
    state.zones.get("melds.1").cards.push(id);
    state.cardLocation.set(id, "melds.1");
  }
  state.turn = { seat: 0, phase: "meld" };
  state.playerVars[0] = { phase: 3, laidDown: true };
  state.playerVars[1] = { phase: 2, laidDown: true, melds: [{ item, cards: cards.slice(), wilds }] };
  return state;
}

const RUN_3456 = {
  item: "run(4)",
  cards: ["green-3", "wild", "wild#2", "blue-6"],
  wilds: { wild: { rank: "4" }, "wild#2": { rank: "5" } },
};

test("a wild offers one move per value it could take, and neither end is assumed", () => {
  const state = meldTable({ ...RUN_3456, hand: ["wild#3", "red-4"] });
  const moves = enumerateLegalMoves(state, 0);

  const hits = moves.filter((m) => m.type === "hit" && m.cards[0] === "wild#3");
  const values = hits.map((m) => m.choice.wilds["wild#3"].rank).sort();
  // The run is frozen at 3-4-5-6, so a wild joining it is either the 2 below
  // or the 7 above — and every offer names which.
  assert.deepStrictEqual(values, ["2", "7"]);

  // The 4 is spent. Nothing may offer a second one.
  assert.ok(!moves.some((m) => m.type === "hit" && m.cards[0] === "red-4"),
    "a rank a wild already stands for was offered again");
});

test("tapping a meld with a wild hands the table the question, not an answer", () => {
  const state = meldTable({ ...RUN_3456, hand: ["wild#3", "red-4"] });
  const moves = enumerateLegalMoves(state, 0);
  const ui = buildUiModel(state, {
    seat: 0,
    moves,
    acts: true,
    selection: { from: handAddress(0), cardIds: ["wild#3"] },
  });

  const ready = ui.readyMelds.get("1:0");
  assert.ok(ready, "the run should accept a wild");
  assert.strictEqual(ready.choice.wilds, undefined,
    "the tap inherited a value the player never chose");

  // The question is asked through the generic hook the platform drives — one
  // `pendingChoice` loop for every move that still owes an answer.
  const ask = state.pack.template.pendingChoice(makeCtx(state), ready);
  assert.strictEqual(ask.cardId, "wild#3");
  assert.strictEqual(ask.attr, "rank");
  assert.deepStrictEqual(ask.options.map((o) => o.value), ["2", "7"]);
  // And every answer it offers has to be one the engine takes — applied the way
  // the platform applies it, through the hook's own `apply`.
  for (const option of ask.options) {
    const answered = ask.apply(ready, option.value);
    assert.ok(validateMove(state, answered).legal, `answering ${option.value} left an illegal move`);
  }
});

test("a meld with only one value on offer is never asked about", () => {
  const state = meldTable({
    item: "set(3)",
    cards: ["red-5", "green-5", "yellow-5"],
    wilds: {},
    hand: ["wild#3"],
  });
  const moves = enumerateLegalMoves(state, 0);
  const ui = buildUiModel(state, {
    seat: 0,
    moves,
    acts: true,
    selection: { from: handAddress(0), cardIds: ["wild#3"] },
  });

  const ready = ui.readyMelds.get("1:0");
  // A wild in a set of fives is a five; there is nothing to ask, so the value
  // rides along with the move instead of stopping the player for a modal.
  assert.deepStrictEqual(ready.choice.wilds, { "wild#3": { rank: "5" } });
  assert.strictEqual(state.pack.template.pendingChoice(makeCtx(state), ready), null);
});

/* ------------------------------------------------------------------ *
 * Hand order — presentation only
 * ------------------------------------------------------------------ */

test("sorting the hand never changes the engine's own zone order", () => {
  const state = tableFor("hearts", "handorder");
  const handAddr = handAddress(0);
  const before = state.zones.cards(handAddr).slice();
  for (const mode of SORT_MODES) {
    orderHand(state.zones.cards(handAddr), (id) => state.pack.cardsById.get(id), mode, []);
  }
  assert.deepStrictEqual(state.zones.cards(handAddr), before,
    "hand order is presentation and must never reach the engine");
});

test("every sort mode returns exactly the cards it was given", () => {
  const state = tableFor("hearts", "handorder2");
  const ids = state.zones.cards(handAddress(0));
  const cardOf = (id) => state.pack.cardsById.get(id);
  for (const mode of SORT_MODES) {
    const out = orderHand(ids, cardOf, mode, ids.slice().reverse());
    assert.strictEqual(out.length, ids.length, `${mode} changed the hand size`);
    assert.deepStrictEqual(new Set(out), new Set(ids), `${mode} lost or invented a card`);
  }
});

/* ------------------------------------------------------------------ *
 * Sort by rank is the PACK'S rank (#159)
 * ------------------------------------------------------------------ *
 *
 * `rankIndex` read `Number(card.rank)` and then `RANKS`, both of which start at
 * the 2, so "sort by rank" put Thirteen's 2 first and its ace last — the exact
 * inverse of the ladder the whole game is played on. Pinochle's 10-above-king
 * and Cribbage's low ace were wrong the same way. Three packs, three different
 * declared orders, one assertion each: a fix that only knew about Thirteen
 * would pass one of these and fail the other two.
 *
 * Hands are written out rather than dealt, so what is being pinned is the ORDER
 * and not a seed.
 */
function sortedRanks(packId, cardIds, mode = "rank") {
  const pack = packFromDisk(packId);
  const ladder = rankLadderOf(pack);
  const shuffled = cardIds.slice().reverse();
  return orderHand(shuffled, (id) => pack.cardsById.get(id), mode, [], ladder)
    .map((id) => pack.cardsById.get(id).rank);
}

test("sort by rank follows the pack's own ladder, not the deck's", () => {
  const ladder = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
  assert.deepStrictEqual(
    sortedRanks("thirteen", ladder.map((r) => `spades-${r}`)), ladder,
    "Thirteen's hand sorted the 2 low and the ace high — the inverse of its ladder");

  assert.deepStrictEqual(
    sortedRanks("pinochle", ["9", "J", "Q", "K", "10", "A"].map((r) => `spades-${r}`)),
    ["9", "J", "Q", "K", "10", "A"],
    "Pinochle's ten did not sort between the king and the ace");

  const cribbage = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  assert.deepStrictEqual(
    sortedRanks("cribbage", cribbage.map((r) => `spades-${r}`)), cribbage,
    "Cribbage's ace did not sort low");

  // UNCHANGED WHERE NOTHING WAS DECLARED. Hearts names no `rankLadder`, so the
  // ladder is derived from the deck and comes out as the order this always
  // used — the fix must not move a pack that was already right.
  const hearts = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  assert.deepStrictEqual(
    sortedRanks("hearts", hearts.map((r) => `spades-${r}`)), hearts,
    "Hearts' rank order moved");
});

test("sort by rank breaks ties with the pack's suit ladder", () => {
  // Thirteen ranks its suits spades-clubs-diamonds-hearts, which is a real fact
  // about the game (`9♥9♦` beats `9♣9♠`) and is NOT alphabetical — so the four
  // 9s were being fanned in an order the table itself contradicts.
  const pack = packFromDisk("thirteen");
  const ids = ["hearts-9", "spades-9", "diamonds-9", "clubs-9"];
  const out = orderHand(ids, (id) => pack.cardsById.get(id), "rank", [], rankLadderOf(pack));
  assert.deepStrictEqual(out, ["spades-9", "clubs-9", "diamonds-9", "hearts-9"],
    "the four 9s did not fan in the suit ladder's order");

  // And a pack that ranks no suits keeps the alphabetical answer, which is
  // stable rather than meaningful and is all there is to say.
  const hearts = packFromDisk("hearts");
  const sameRank = ["spades-9", "hearts-9", "diamonds-9", "clubs-9"];
  assert.deepStrictEqual(
    orderHand(sameRank, (id) => hearts.cardsById.get(id), "rank", [], rankLadderOf(hearts)),
    ["clubs-9", "diamonds-9", "hearts-9", "spades-9"],
    "a pack with no suit ladder stopped falling back to the suit name");
});

test("sort by suit keeps its suit groups and orders inside them by the ladder", () => {
  // The groups are by suit NAME on purpose: a player learns where their spades
  // live, and the four blocks rearranging themselves under them would be a
  // worse bug than the one being fixed. What the ladder fixes is INSIDE a group.
  const pack = packFromDisk("thirteen");
  const ids = ["spades-2", "spades-3", "spades-A", "clubs-2", "clubs-3", "clubs-A"];
  const out = orderHand(ids, (id) => pack.cardsById.get(id), "suit", [], rankLadderOf(pack));
  assert.deepStrictEqual(out,
    ["clubs-3", "clubs-A", "clubs-2", "spades-3", "spades-A", "spades-2"],
    "the suit sort's within-suit order is not the pack's ladder");
});

test("orderHand with no ladder still sorts, for a caller that has no pack", () => {
  // The parameter is optional and the old tiers are the fallback, so the
  // signature change cannot break a caller that has nothing to pass.
  const pack = packFromDisk("hearts");
  const ids = ["spades-A", "spades-10", "spades-2"];
  assert.deepStrictEqual(
    orderHand(ids, (id) => pack.cardsById.get(id), "rank", []),
    ["spades-2", "spades-10", "spades-A"],
    "the no-ladder fallback stopped working");
});

test("a manual order keeps newly drawn cards instead of dropping them", () => {
  // The stored permutation is always stale by one draw. Cards it has never
  // heard of go on the end; ids the hand no longer holds are ignored.
  assert.deepStrictEqual(applyManual(["a", "b", "c"], ["c", "a"]), ["c", "a", "b"]);
  assert.deepStrictEqual(applyManual(["a", "b"], ["gone", "b", "gone", "a"]), ["b", "a"]);
  assert.deepStrictEqual(applyManual(["a", "b"], []), ["a", "b"]);
  assert.deepStrictEqual(applyManual([], ["a"]), []);
});

test("dragging a card within the hand puts it exactly where it was dropped", () => {
  assert.deepStrictEqual(reorder(["a", "b", "c"], "a", 2), ["b", "c", "a"]);
  assert.deepStrictEqual(reorder(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  // Past either end clamps rather than losing the card.
  assert.deepStrictEqual(reorder(["a", "b", "c"], "b", 99), ["a", "c", "b"]);
  assert.deepStrictEqual(reorder(["a", "b", "c"], "b", -5), ["b", "a", "c"]);
});

test("the sort toggle cycles through every mode and back", () => {
  let mode = SORT_MODES[0];
  const seen = new Set([mode]);
  for (let i = 0; i < SORT_MODES.length; i++) {
    mode = nextMode(mode);
    seen.add(mode);
  }
  assert.deepStrictEqual(seen, new Set(SORT_MODES));
  assert.strictEqual(mode, SORT_MODES[0], "the cycle must return to where it started");
});

/* ------------------------------------------------------------------ *
 * The fan
 * ------------------------------------------------------------------ */

test("the fan closes until the hand fits, and never past readability", () => {
  const cardWidth = 70;
  // Roomy: the fan OPENS rather than keeping the thirteen-card overlap on an
  // empty table. It used to stop at the natural 0.69, which is how a five-card
  // hand kept a third of every card buried with a thousand pixels going spare
  // (#122, round-5 item 23).
  const roomy = fanStep({ count: 5, cardWidth, available: 2000 });
  assert.strictEqual(roomy, cardWidth * 0.94);
  assert.ok(roomy > cardWidth * 0.69, "a hand with room to spare must open past natural");
  // Never past touching: a hand with gaps in it is a hand somebody has already
  // played out of.
  assert.ok(fanStep({ count: 2, cardWidth, available: 99999 }) <= cardWidth);

  // In between, the room decides and `natural` is what it lands on.
  const middling = fanStep({ count: 13, cardWidth, available: cardWidth + 12 * cardWidth * 0.69 });
  assert.ok(Math.abs(middling - cardWidth * 0.69) < 0.01, "natural is what the middle case gives");

  // Cramped: the fan closes to fit rather than overflowing.
  const cramped = fanStep({ count: 13, cardWidth, available: 400 });
  assert.ok(cramped < roomy, "a big hand in a small space must tighten");
  assert.ok(fanWidth({ count: 13, cardWidth, step: cramped }) <= 400 + 0.5,
    "a tightened fan must actually fit the space it was given");

  // Impossible: it stops at the readable floor instead of vanishing.
  const absurd = fanStep({ count: 40, cardWidth, available: 120 });
  assert.ok(absurd >= cardWidth * 0.17, "the fan must never close past the rank corner");
});

test("the fan never overflows for any hand a launch pack can deal", () => {
  // Every pack's deal size against the narrowest supported screen.
  const cases = [
    { count: 10, cardWidth: 46, available: 260 },   // Milestones on a phone
    { count: 17, cardWidth: 46, available: 260 },   // Hearts, 3 seats, on a phone
    { count: 7, cardWidth: 46, available: 260 },    // Wildfire on a phone
    { count: 17, cardWidth: 70, available: 900 },   // Hearts on a desktop
  ];
  for (const c of cases) {
    const step = fanStep(c);
    const width = fanWidth({ count: c.count, cardWidth: c.cardWidth, step });
    // Only the floor may exceed the budget, and then only because closing
    // further would hide the ranks — the honest trade, and it is bounded.
    const floored = step <= Math.max(10, c.cardWidth * 0.17) + 0.001;
    assert.ok(width <= c.available + 0.5 || floored,
      `${c.count} cards overflowed: ${Math.round(width)} > ${c.available}`);
  }
});

test("the gap a lifted card opens is exactly the overlap it would bury", () => {
  // A LIFTED CARD LANDS ON THE ONE STRIP ITS NEIGHBOUR IS READ BY. The fan
  // overlaps leftward, so the neighbour's visible strip IS the step, and the
  // part the lifted card covers is everything past it — `cardWidth - step`
  // (#122, round-5 item 23). Anything less leaves the neighbour's rank corner
  // buried; anything more is motion for its own sake.
  const cases = [
    { cardWidth: 70, available: 500, count: 13 },   // desktop, tight
    { cardWidth: 46, available: 220, count: 13 },   // 375px, tighter
    { cardWidth: 70, available: 2000, count: 5 },   // desktop, open
  ];
  for (const c of cases) {
    const step = fanStep(c);
    const gap = liftGap({ cardWidth: c.cardWidth, step });
    assert.ok(gap >= 0, "a gap is never negative");
    assert.ok(Math.abs(gap - Math.max(0, c.cardWidth - step)) < 0.05,
      `${c.count} cards at ${c.cardWidth}px: the gap must uncover the whole overlap`);
    assert.ok(step + gap >= c.cardWidth - 0.05,
      "after the shift the neighbour must be clear of the lifted card entirely");
  }

  // A fan with room to spare barely overlaps, so barely anything has to move.
  assert.ok(liftGap({ cardWidth: 70, step: fanStep({ count: 5, cardWidth: 70, available: 2000 }) })
    < liftGap({ cardWidth: 70, step: fanStep({ count: 13, cardWidth: 70, available: 500 }) }),
    "an open fan must not shove cards around for a lift that hides nothing");
});

test("the fan is sized by a measured card, not by the declaration", () => {
  // THE DECLARATION IS NOT ALWAYS A NUMBER. `--hand-card-w` is
  // `clamp(70px, 8.6vh, 104px)` on a desktop window, and a custom property
  // comes back from getComputedStyle exactly as it was written — so parsing it
  // gave NaN, the fallback put 70px in, and every desktop fan was spaced for a
  // phone's cards (#135, round-5 item 44c).
  assert.strictEqual(
    resolveCardWidth({ rendered: 103, declared: 'clamp(70px, 8.6vh, 104px)', fallback: 70 }),
    103, "a measured card must win over a declaration that cannot be parsed");
  // And over one that CAN be: a length that parses is not thereby the length
  // on screen — `70px` is the desktop clamp's floor, not its value — so the
  // measurement is preferred outright rather than only when parsing fails.
  assert.strictEqual(
    resolveCardWidth({ rendered: 103, declared: '70px', fallback: 70 }),
    103, "a measured card must win over a parseable declaration too");
  // The declaration is a fallback, not a discard: at 375px it is a plain length
  // and it is all there is before the hand has been laid out.
  assert.strictEqual(
    resolveCardWidth({ rendered: NaN, declared: '46px', fallback: 70 }),
    46, "an unmeasurable hand still gets the declared width");
  // A zero measurement is a hand that has not been laid out, not a zero-width
  // card — taking it literally would collapse the fan onto one point.
  assert.strictEqual(
    resolveCardWidth({ rendered: 0, declared: 'clamp(70px, 8.6vh, 104px)', fallback: 70 }),
    70, "neither a usable measurement nor a usable declaration falls through");
  assert.strictEqual(resolveCardWidth({ rendered: undefined, declared: '' }), 70,
    "the fallback defaults rather than returning NaN");

  // And the width it resolves is what opens the fan: the desktop bug was
  // 65.8px of step under 103px cards, a 36% overlap on a roomy window.
  const real = resolveCardWidth({ rendered: 103, declared: 'clamp(70px, 8.6vh, 104px)' });
  assert.ok(fanStep({ count: 6, cardWidth: real, available: 900 }) >= 0.9 * real,
    "six cards with 900px of room must fan at nearly their full width");
});

test("a single card has nothing to overlap", () => {
  assert.strictEqual(fanStep({ count: 1, cardWidth: 70, available: 10 }), 70 * 0.69);
  assert.strictEqual(fanWidth({ count: 1, cardWidth: 70, step: 20 }), 70);
  assert.strictEqual(fanWidth({ count: 0, cardWidth: 70, step: 20 }), 0);
});

/* ------------------------------------------------------------------ *
 * The fan's second row
 * ------------------------------------------------------------------ */

// A 375px phone: 46px cards, 67px tall with the line box under the svg, a 5px
// gap between rows. 220px is what the fan gets with the rail beside it and
// 312px is what it gets once the rail stands above (#134). These are the
// numbers the issue measured, so they are the numbers pinned here.
const PHONE = { cardWidth: 46, cardHeight: 67, rowGap: 5 };
const ROOMY = 400;   // more than three extra rows' worth of felt

test("the fan takes a second row when one row would close past reading", () => {
  // WITH THE RAIL STILL IN THE ROW: 13 cards over 220px is 14.5px a card, the
  // strip the playtest could not read. Split in two it is 29px.
  const beside = fanLayout({ ...PHONE, count: 13, available: 220, slack: ROOMY });
  assert.strictEqual(beside.rows, 2);
  assert.ok(Math.abs(beside.step - 29) < 0.05, `expected ~29px a card, got ${beside.step}`);

  // WITH THE RAIL ABOVE: 312px. One row would be 22.2px, which is still under
  // half a card and is the reason the floor sits where it does — two rows open
  // the fan the whole way instead.
  const above = fanLayout({ ...PHONE, count: 13, available: 312, slack: ROOMY });
  assert.strictEqual(above.rows, 2);
  assert.ok(Math.abs(above.step - 46 * 0.94) < 0.05,
    `a two-row fan with room to spare must open to OPEN, got ${above.step}`);
  assert.ok(above.step >= 40, "the issue's bar is a strip of 40px a card at 375x812");

  // FEWEST ROWS THAT CLEAR IT. Height is not free, and a third row buys nothing
  // once the fan is already open.
  assert.strictEqual(fanLayout({ ...PHONE, count: 13, available: 312, slack: 4000 }).rows, 2);
});

test("a hand that already reads stays on one row", () => {
  // Five cards on a phone are fanned wide open — nothing to fix.
  const few = fanLayout({ ...PHONE, count: 5, available: 312, slack: ROOMY });
  assert.strictEqual(few.rows, 1);
  assert.strictEqual(few.step, fanStep({ count: 5, cardWidth: 46, available: 312 }));

  // And a desktop hand: thirteen cards at 74px over 1109px is 69.5px a card,
  // most of a whole card each. This issue must not touch the one-row case.
  const desktop = fanLayout({ count: 13, cardWidth: 73.95, cardHeight: 106, rowGap: 5, available: 1109, slack: 160 });
  assert.strictEqual(desktop.rows, 1);
  assert.strictEqual(desktop.step, fanStep({ count: 13, cardWidth: 73.95, available: 1109 }));
});

test("a felt with no room to spare keeps the fan on one row", () => {
  // THE GATE IS THE MEASURED SLACK, NOT THE VIEWPORT. Pinochle's meld
  // declaration and Cribbage's crib discard have already spent the felt's
  // middle; a second row bought there would push the hand off the screen.
  const cramped = fanLayout({ ...PHONE, count: 13, available: 220, slack: 0 });
  assert.strictEqual(cramped.rows, 1);
  assert.strictEqual(cramped.step, fanStep({ count: 13, cardWidth: 46, available: 220 }));

  // Not quite one row's worth is not one row's worth.
  assert.strictEqual(fanLayout({ ...PHONE, count: 13, available: 220, slack: 71 }).rows, 1);
  assert.strictEqual(fanLayout({ ...PHONE, count: 13, available: 220, slack: 72 }).rows, 2);

  // Room for three rows, but a hand that only needs two takes two.
  assert.strictEqual(fanLayout({ ...PHONE, count: 17, available: 312, slack: 300 }).rows, 2);
});

test("a split fan comes back together later than it split", () => {
  // A HAND SHRINKS A CARD AT A TIME, and what it is judged on is the ONE-ROW
  // step — which crosses the floor while the fan is still drawn in two. Without
  // hysteresis, staging one card out of thirteen would re-join the fan and take
  // it from 43px a card to 24px, jumping the whole hand 70px up the felt, as a
  // reward for playing.
  const at = (count, current) => fanLayout({ ...PHONE, count, available: 312, slack: ROOMY, current });

  assert.strictEqual(at(13, 1).rows, 2, "thirteen cards split");
  for (const count of [12, 11, 10]) {
    assert.strictEqual(at(count, 2).rows, 2, `${count} cards must keep the two rows they are drawn in`);
    assert.ok(at(count, 2).step >= 40, "and keep the open fan that made them worth splitting");
    // The same hand arrived at fresh is a one-row hand: the difference IS the
    // hysteresis, not a different answer to the same question.
    assert.strictEqual(at(count, 1).rows, 1);
  }
  // Far enough down and one row is the natural spacing again, so it re-joins.
  assert.strictEqual(at(9, 2).rows, 1, "a nine-card hand fits one row at its natural spacing");
  assert.strictEqual(at(9, 1).rows, 1);

  // It cannot flap: the count that splits and the count that re-joins are far
  // apart, so no single card played can send the fan back and forth.
  let rows = 1;
  const seen = [];
  for (const count of [13, 12, 11, 10, 9, 10, 11, 12, 13, 12]) {
    rows = at(count, rows).rows;
    seen.push(rows);
  }
  assert.deepEqual(seen, [2, 2, 2, 2, 1, 1, 1, 1, 2, 2],
    "the fan must not flip rows as a hand is played down and drawn back up");
});

test("a row is never left holding one card, however much felt there is", () => {
  // Rows are a way of fanning a hand, not a way of spending height: splitting
  // past pairs would draw a "fan" of singletons.
  const rows = fanLayout({ ...PHONE, count: 4, available: 50, slack: 100000 }).rows;
  assert.ok(rows <= 2, `4 cards must not split past 2 rows, got ${rows}`);
  const layout = fanLayout({ ...PHONE, count: 3, available: 50, slack: 100000 });
  assert.strictEqual(layout.rows, 1, "3 cards cannot be split into rows of at least 2");
});

test("every card lands in a row, in reading order", () => {
  // Left to right, top to bottom — so the fan reads as one hand and handOrder
  // is untouched by the split.
  assert.deepEqual(handRows({ count: 13, rows: 2 }), [7, 6]);
  assert.deepEqual(handRows({ count: 12, rows: 2 }), [6, 6]);
  assert.deepEqual(handRows({ count: 13, rows: 3 }), [5, 5, 3]);
  assert.deepEqual(handRows({ count: 1, rows: 1 }), [1]);
  for (const count of [2, 5, 7, 10, 13, 17, 26]) {
    for (const rows of [1, 2, 3]) {
      const plan = handRows({ count, rows });
      assert.strictEqual(plan.reduce((a, b) => a + b, 0), count,
        `${count} cards in ${rows} rows lost or gained a card`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Contract notation
 * ------------------------------------------------------------------ */

test("a contract reads both short enough for a rung and long enough to mean something", () => {
  assert.strictEqual(shortContractItem("set(3)"), "S3");
  assert.strictEqual(shortContractItem("run(7)"), "R7");
  assert.strictEqual(shortContractItem("colorGroup(7)"), "C7");
  assert.strictEqual(shortContract(["set(3)", "run(4)"]), "S3+R4");
  assert.strictEqual(describeContract(["set(3)", "run(4)"]), "set of 3 + run of 4");
  assert.strictEqual(describeContractItem("colorGroup(7)"), "7 of one color");
});

test("every contract Milestones ships abbreviates without collapsing into ambiguity", () => {
  const pack = packFromDisk("milestones");
  const shorts = pack.rules.contracts.map(shortContract);
  assert.strictEqual(shorts.length, 10);
  for (const s of shorts) {
    assert.match(s, /^[SRC]\d+(\+[SRC]\d+)*$/, `unreadable rung: ${s}`);
  }
  // Two rungs that abbreviate the same way would make the ladder lie.
  assert.strictEqual(new Set(shorts).size, shorts.length, `duplicate rungs: ${shorts}`);
});

/* ------------------------------------------------------------------ *
 * The rail's thumb slot
 * ------------------------------------------------------------------ */

// WHY A CHARACTER COUNT IS A LAYOUT TEST.
//
// This used to guard a sentence. The bar that held it reserved two lines of
// the felt's height and a hint that wrapped to three grew the bar, sliding the
// deck, the discard and the hand down the screen (#13, arriving through the
// words rather than the box — #17). The sentence is gone and the bar with it;
// what is left is the action button, standing in a rail slot that is a FIXED
// 5rem so the fan is never re-measured by a control appearing.
//
// The failure mode moved but did not change: a label too long for the slot
// makes the rail taller than the fan, #hand-row grows, and the felt shifts
// again. Nothing in this process can lay out text, so the budget is
// measured in a browser and pinned in src/ui/interaction.js; what this test
// enforces is that no label has grown past it since.
//
// ONE LINE IS THE RULE, and the number came out of a browser rather than a
// head: budgeted at two lines, "Pass 3 across" wrapped, took the rail from
// 74px to 89px against a fan 84px tall, and pushed the row out by 14px.
//
// The label that matters most is the passing one, because it is the only one
// that interpolates PACK DATA: `passing.count` and the direction the pack
// rotates. A pack can lengthen it without anyone touching the UI, and there is
// no browser in the loop to notice.

/** Every action label a pack can put in the slot, from a real deal. */
function actionLabels(packId) {
  const state = tableFor(packId, `labels:${packId}`);
  if (!untilHumansTurn(state)) return [];
  const moves = enumerateLegalMoves(state, 0);
  const handAddr = handAddress(0);
  const hand = state.zones.cards(handAddr);

  // Bare, and then holding cards — a selection is what summons the button at
  // all, and how many are held is what decides whether a pack offers one.
  const selections = [null];
  for (const size of [1, 3, state.pack.rules.passing?.count ?? 3]) {
    if (hand.length >= size) selections.push({ from: handAddr, cardIds: hand.slice(0, size) });
  }

  // EVERY DIRECTION THE PACK ROTATES THROUGH, not just the one round 1 deals
  // into. Hearts' schedule is ["left", "right", "across", "none"] and only the
  // first of those is on the table at move zero — which is how the first cut of
  // this test passed while "Pass 3 across" was overrunning the slot by two
  // characters. It is the same trap the contract-ladder test was written for:
  // the value that breaks the layout is pack data from a LATER round.
  const directions = state.pack.rules.passing?.schedule || [null];

  const labels = [];
  for (const direction of directions) {
    if (direction) state.vars.passDirection = direction;
    for (const selection of selections) {
      const ui = buildUiModel(state, { seat: 0, moves, acts: true, selection });
      if (ui.action) labels.push(ui.action.label);
    }
  }
  return labels;
}

test("no action label a real deal produces overruns the rail's one-line slot", () => {
  let checked = 0;
  for (const packId of PACKS) {
    for (const label of actionLabels(packId)) {
      assert.ok(label.length <= ACTION_LABEL_MAX_CHARS,
        `${packId}: "${label}" is ${label.length} chars against a budget of `
        + `${ACTION_LABEL_MAX_CHARS} — it overruns the slot's single line`);
      checked++;
    }
  }
  assert.ok(checked > 0, "no action labels were exercised at all");
});

test("the passing label carries the direction, which nothing else on the felt says", () => {
  // The seats are drawn as a row, not a circle, so "left" is not something a
  // player can read off the table. It rode the phase sentence until that was
  // dropped; the button is where it lives now, and this is the test that says
  // so out loud.
  let checked = 0;
  for (const packId of PACKS) {
    const state = tableFor(packId, `pass-direction:${packId}`);
    if (interactionMode(state) !== "pass") continue;
    const direction = state.vars.passDirection;
    if (!direction) continue;
    const handAddr = handAddress(0);
    const hand = state.zones.cards(handAddr);
    const count = state.pack.rules.passing?.count ?? 3;
    if (hand.length < count) continue;
    const ui = buildUiModel(state, {
      seat: 0,
      moves: enumerateLegalMoves(state, 0),
      acts: true,
      selection: { from: handAddr, cardIds: hand.slice(0, count) },
    });
    assert.ok(ui.action, `${packId}: a full selection produced no pass button`);
    assert.ok(ui.action.label.includes(direction),
      `${packId}: "${ui.action.label}" does not say which way (${direction})`);
    checked++;
  }
  assert.ok(checked > 0, "no passing pack was exercised");
});

test("an unrecognised contract item degrades to its own text rather than vanishing", () => {
  assert.strictEqual(shortContractItem("mystery(2)"), "mystery(2)");
  assert.strictEqual(shortContractItem(""), "");
  assert.strictEqual(shortContract([]), "");
  assert.strictEqual(describeContract(undefined), "");
});

/* ------------------------------------------------------------------ *
 * Reading the fan with a finger
 * ------------------------------------------------------------------ */

// A press on a hand card can become two different things, and the fan is the
// only place in the game where that is true. Getting it wrong in one direction
// costs a snap-back; in the other it drops a card the player was carrying.

test("sliding along the fan reads it; lifting off it drags", () => {
  // Straight along the row, either way.
  assert.strictEqual(classifyHandGesture({ dx: 40, dy: 0 }), "scrub");
  assert.strictEqual(classifyHandGesture({ dx: -40, dy: 0 }), "scrub");
  // Straight up or down, off the row.
  assert.strictEqual(classifyHandGesture({ dx: 0, dy: -40 }), "drag");
  assert.strictEqual(classifyHandGesture({ dx: 0, dy: 40 }), "drag");
});

test("a diagonal lift stays a drag — a wrist pivots", () => {
  // 45 degrees is NOT enough to mean "reading": a finger pulling a card up and
  // out arrives with real sideways travel, and misreading that as a scrub would
  // drop the card the player meant to play.
  assert.strictEqual(classifyHandGesture({ dx: 30, dy: -30 }), "drag");
  assert.strictEqual(classifyHandGesture({ dx: -30, dy: -30 }), "drag");
  // Horizontal has to clearly dominate before it counts.
  assert.strictEqual(classifyHandGesture({ dx: 30, dy: -20 }), "drag");   // ratio 1.5, not >
  assert.strictEqual(classifyHandGesture({ dx: 31, dy: -20 }), "scrub");  // just over
});

test("a gesture with no vertical component at all is a scrub, not a divide by zero", () => {
  assert.strictEqual(classifyHandGesture({ dx: 7, dy: 0 }), "scrub");
  // And no movement at all is a drag, so a press that somehow reports zero
  // travel cannot silently swallow the card.
  assert.strictEqual(classifyHandGesture({ dx: 0, dy: 0 }), "drag");
});

/* ------------------------------------------------------------------ *
 * Fitting the contract ladder on one line
 * ------------------------------------------------------------------ */

// Ten rungs do not fit across a phone, and wrapping cost the felt the row the
// hand needs. Truncation is only acceptable if the four things a player reads
// the ladder FOR always survive it, so that is what these pin.

/** The phases a rendered ladder actually shows. */
function shown(entries) {
  return entries.filter((e) => e.kind === "rung").map((e) => e.phase);
}

test("the ladder always shows where you are and what is next", () => {
  const entries = ladderRungs(10, { minePhase: 4, occupied: [4] });
  assert.ok(shown(entries).includes(4), "your own contract went missing");
  assert.ok(shown(entries).includes(5), "the contract you are racing toward went missing");
});

test("the ladder shows every rung somebody is standing on while there is room", () => {
  const occupied = [2, 6, 9];
  const entries = ladderRungs(10, { minePhase: 2, occupied });
  for (const phase of occupied) {
    assert.ok(shown(entries).includes(phase), `lost the player on contract ${phase}`);
  }
});

test("a player squeezed off the ladder is inside a marker, never nowhere", () => {
  // Six seats can stand on six different rungs and no arrangement of ten fits
  // a phone, so the budget is a hard cap. It is only safe because the renderer
  // draws the hidden players' pips on the marker covering them — which means
  // every occupied rung must be either shown or inside some gap's range.
  const occupied = [1, 2, 4, 6, 8, 10];
  for (let mine = 1; mine <= 10; mine++) {
    const entries = ladderRungs(10, { minePhase: mine, occupied: [...occupied, mine] });
    const visible = new Set(shown(entries));
    const gaps = entries.filter((e) => e.kind === "gap");
    for (const phase of [...occupied, mine]) {
      const covered = visible.has(phase)
        || gaps.some((g) => phase >= g.from && phase <= g.to);
      assert.ok(covered, `player on ${phase} is unreachable at mine=${mine}`);
    }
    assert.ok(visible.has(mine), `your own contract was squeezed out at mine=${mine}`);
  }
});

test("the rung budget is never exceeded, however crowded the ladder", () => {
  for (let mine = 1; mine <= 10; mine++) {
    for (const budget of [1, 3, 6]) {
      const entries = ladderRungs(10, {
        minePhase: mine, occupied: [1,2,3,4,5,6,7,8,9,10], maxRungs: budget,
      });
      assert.ok(shown(entries).length <= budget,
        `mine=${mine} budget=${budget} kept ${shown(entries).length}`);
      assert.ok(shown(entries).includes(mine), "your own contract must survive any budget");
    }
  }
});

test("the ladder always shows how long the course is", () => {
  const entries = ladderRungs(10, { minePhase: 5, occupied: [5] });
  assert.ok(shown(entries).includes(1), "lost the first rung");
  assert.ok(shown(entries).includes(10), "lost the last rung");
});

test("empty stretches collapse into one marker that says what it covers", () => {
  // Everyone on contract 1 of ten: 3..9 is the compressible part.
  const entries = ladderRungs(10, { minePhase: 1, occupied: [1] });
  assert.deepStrictEqual(entries, [
    { kind: "rung", phase: 1 },
    { kind: "rung", phase: 2 },
    { kind: "gap", from: 3, to: 9 },
    { kind: "rung", phase: 10 },
  ]);
});

test("the nearest rival is the one that keeps its rung", () => {
  // Racing is local: the player one ahead of you matters more than the one
  // five behind, so a tight budget spends its last rung on the former.
  const entries = ladderRungs(10, { minePhase: 5, occupied: [5, 6, 1], maxRungs: 3 });
  const visible = shown(entries);
  assert.ok(visible.includes(5), "your own rung");
  assert.ok(visible.includes(10), "the finish line");
  assert.ok(visible.includes(6), "the rival one rung ahead");
  assert.ok(!visible.includes(1), "the distant rival should have been collapsed first");
});

test("a collapsed run never swallows a rung that is being shown", () => {
  // Every gap must sit strictly between two shown rungs and cover only phases
  // that are not shown — otherwise the marker is lying about what it hides.
  for (let mine = 1; mine <= 10; mine++) {
    const entries = ladderRungs(10, { minePhase: mine, occupied: [mine, 3, 8] });
    const visible = new Set(shown(entries));
    for (const e of entries) {
      if (e.kind !== "gap") continue;
      assert.ok(e.from <= e.to, `empty gap at mine=${mine}`);
      for (let p = e.from; p <= e.to; p++) {
        assert.ok(!visible.has(p), `gap ${e.from}-${e.to} covers visible rung ${p}`);
      }
    }
  }
});

test("every contract is accounted for exactly once, shown or collapsed", () => {
  // The ladder may compress the course but must never lose a rung off it.
  for (let mine = 1; mine <= 10; mine++) {
    const entries = ladderRungs(10, { minePhase: mine, occupied: [mine, 5] });
    const seen = [];
    for (const e of entries) {
      if (e.kind === "rung") seen.push(e.phase);
      else for (let p = e.from; p <= e.to; p++) seen.push(p);
    }
    seen.sort((a, b) => a - b);
    assert.deepStrictEqual(seen, [1,2,3,4,5,6,7,8,9,10], `mine=${mine}`);
  }
});

test("a ladder that already fits is left alone", () => {
  const entries = ladderRungs(4, { minePhase: 2, occupied: [1, 2, 3, 4] });
  assert.deepStrictEqual(shown(entries), [1, 2, 3, 4]);
  assert.ok(!entries.some((e) => e.kind === "gap"));
});

test("a ladder with no deal yet still draws its ends", () => {
  const entries = ladderRungs(10, {});
  assert.deepStrictEqual(entries, [
    { kind: "rung", phase: 1 },
    { kind: "gap", from: 2, to: 9 },
    { kind: "rung", phase: 10 },
  ]);
});

test("degenerate ladders do not produce stray markers", () => {
  assert.deepStrictEqual(ladderRungs(0, {}), []);
  assert.deepStrictEqual(ladderRungs(1, { minePhase: 1, occupied: [1] }),
    [{ kind: "rung", phase: 1 }]);
  assert.deepStrictEqual(ladderRungs(2, { minePhase: 1, occupied: [1] }),
    [{ kind: "rung", phase: 1 }, { kind: "rung", phase: 2 }]);
});

test("the real packs' ladders truncate to something that fits a phone", () => {
  // The whole point is a single row. Six items is what the 375px felt holds at
  // the phone breakpoint; more than that and nowrap starts clipping.
  for (const packId of PACKS) {
    const state = tableFor(packId);
    const contracts = state.pack.rules.contracts;
    if (!Array.isArray(contracts) || !contracts.length) continue;
    for (let mine = 1; mine <= contracts.length; mine++) {
      const entries = ladderRungs(contracts.length, {
        minePhase: mine,
        // Worst case: every other seat on a different rung of its own.
        occupied: [mine, ((mine + 2) % contracts.length) + 1, ((mine + 5) % contracts.length) + 1],
      });
      // The widest the ladder can get is every kept rung separated by a
      // marker. Pinned as a SHAPE rather than a pixel model, because the
      // pixels live in table.css and the fit is verified on the real felt —
      // this is here to catch the rule quietly deciding to keep more.
      const rungs = entries.filter((e) => e.kind === "rung").length;
      assert.ok(rungs <= 5, `${packId} at phase ${mine} kept ${rungs} rungs`);
      assert.ok(entries.length <= 2 * rungs,
        `${packId} at phase ${mine} produced ${entries.length} items for ${rungs} rungs`);
    }
  }
});
