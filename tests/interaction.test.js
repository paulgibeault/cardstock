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
  interactionMode, buildUiModel, dropCandidates, draggableSources,
  pruneSelection, isSelected, handAddress, implicitLandingZone,
} from "../src/ui/interaction.js";
import { orderHand, applyManual, reorder, nextMode, SORT_MODES } from "../src/ui/handOrder.js";

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
  const known = new Set(["tap", "pass", "rummy-draw", "rummy-meld", "place"]);
  for (const packId of PACKS) {
    assert.ok(known.has(interactionMode(tableFor(packId))), `${packId} has an unknown mode`);
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

test("the UI model offers nothing at all when the human may not act", () => {
  const state = tableFor("hearts", "inert");
  const ui = buildUiModel(state, { seat: 0, moves: [], acts: false, selection: null });
  assert.strictEqual(ui.handSelectable.size, 0);
  assert.strictEqual(ui.readyTargets.size, 0);
  assert.strictEqual(ui.action, null);
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
