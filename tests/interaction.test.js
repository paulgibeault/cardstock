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
  orderHand, applyManual, reorder, nextMode, fanStep, fanWidth, SORT_MODES,
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

const PACKS = ["crazy-eights", "wildfire", "hearts", "milestones", "stockpile"];

test("every pack's interaction mode is one the table knows how to render", () => {
  const known = new Set(["tap", "play-drawn", "pass", "rummy-draw", "rummy-meld", "place"]);
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
  // Roomy: nothing to solve, so the fan sits at its natural spacing.
  const roomy = fanStep({ count: 5, cardWidth, available: 2000 });
  assert.strictEqual(roomy, cardWidth * 0.69);

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

test("a single card has nothing to overlap", () => {
  assert.strictEqual(fanStep({ count: 1, cardWidth: 70, available: 10 }), 70 * 0.69);
  assert.strictEqual(fanWidth({ count: 1, cardWidth: 70, step: 20 }), 70);
  assert.strictEqual(fanWidth({ count: 0, cardWidth: 70, step: 20 }), 0);
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
