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
  shortContract, shortContractItem, describeContract, describeContractItem,
  ladderRungs,
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
