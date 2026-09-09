// THE PILE YOU ARE ANSWERING, IN WORDS (#122, round-5 items 18, 22, 24, 26).
//
// The felt reported the middle of a Thirteen table as two numbers. One pile
// wore `4` and the other wore `28`, neither wore its own name once it held a
// card, and the `4` was a count of the whole trick while the thing to beat was
// a pair. A playtester spent a match "squinting at a stack trying to work out
// whether I was answering a pair or a run".
//
// Everything pinned here is a pure read over a real state: `zoneFocus` is the
// template's answer to "which of these cards is still live", `zoneBadge` and
// `zoneAriaLabel` are what the felt and a screen reader make of it, and
// `describeEvent`'s `priority` is what stops a pass from swallowing the trick
// it ended. src/ui/celebrations.js touches the DOM at import time and cannot be
// loaded here (see tests/scoreDirection.test.js), so the last test is a source
// gate over the one line in it that reads `priority`.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { zoneBadge, zoneAriaLabel, describeZone, zoneFocusOf, cardAriaLabel } from "../src/ui/describe.js";

const seatLabel = (seat) => ["You", "Nell", "Ada", "Bo"][seat] ?? `Seat ${seat}`;

async function dealt(packId = "thirteen", seats = 4, seed = "pile-focus") {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/** The `pile` zone's instance, the shape the renderer hands the describers. */
function pileInst(state) {
  const def = state.zones.defs.get("pile");
  assert.ok(def, "the climbing table has no pile zone");
  return { def, n: null, address: "pile" };
}

/** Play `cards` from the seat on turn, straight through the engine. */
function play(state, cards) {
  applyMove(state, { actor: state.turn.seat, type: "playCard", cards });
}

/**
 * Lead the smallest combination of `size` cards this table can, then answer it
 * with the smallest legal answer, so the pile holds MORE than the standing
 * combination — which is the whole case.
 */
function trickWithHistory(state) {
  const first = enumerateLegalMoves(state, state.turn.seat)
    .filter((m) => m.type === "playCard")
    .sort((a, b) => a.cards.length - b.cards.length)[0];
  play(state, first.cards);
  const answer = enumerateLegalMoves(state, state.turn.seat).find((m) => m.type === "playCard");
  assert.ok(answer, "nobody could answer the lead, so there is no history to test");
  play(state, answer.cards);
  return answer.cards;
}

/* ------------------------------------------------------------------ *
 * The focus itself
 * ------------------------------------------------------------------ */

test("the focus is the standing combination, not the pile", async () => {
  const state = await dealt();
  assert.strictEqual(zoneFocusOf(state, "pile"), null,
    "an empty pile has nothing standing on it, so it must name nothing");

  const standing = trickWithHistory(state);
  const pile = state.zones.cards("pile");
  assert.ok(pile.length > standing.length,
    "the pile must hold more than the standing combination for this test to mean anything");

  const focus = zoneFocusOf(state, "pile");
  assert.ok(focus, "a pile with a combination standing on it named nothing");
  assert.deepStrictEqual(focus.cards, standing,
    "the focus must be the cards still in play, not the whole trick");
  assert.ok(focus.label.length, "the focus must have words");
});

test("every shape this game has says what it is", async () => {
  const pack = await loadPackFromDisk("thirteen");
  const state = createState({ pack, seats: 4, seed: "shapes" });
  const ctx = makeCtx(state);
  const name = (combo) => pack.template.zoneFocus(
    { ...ctx, var: (k) => (k === "combo" ? combo : ctx.var(k)) }, "pile").label;

  assert.strictEqual(name({ kind: "single", size: 1, cards: ["hearts-9"] }), "Single 9");
  assert.strictEqual(name({ kind: "pair", size: 2, cards: ["hearts-4", "spades-4"] }), "Pair of 4s");
  assert.strictEqual(name({ kind: "triple", size: 3, cards: ["hearts-A", "spades-A", "clubs-A"] }), "Triple As");
  assert.strictEqual(name({ kind: "quad", size: 4, cards: ["hearts-2", "spades-2", "clubs-2", "diamonds-2"] }), "Four 2s");
  assert.strictEqual(name({ kind: "run", size: 3, cards: ["hearts-3", "spades-4", "clubs-5"] }), "Run of 3");
  assert.strictEqual(name({ kind: "consecutive-pairs", size: 3, cards: [] }), "3 consecutive pairs");

  // The rank named is the TOP card's, which is the card an answer has to clear —
  // not whichever id happens to come first in the array.
  assert.strictEqual(name({ kind: "pair", size: 2, cards: ["spades-K", "hearts-K"] }), "Pair of Ks");
});

test("no other pack's pile pretends to have one", async () => {
  for (const id of ["hearts", "wildfire", "stockpile"]) {
    const state = await dealt(id, id === "stockpile" ? 2 : 4, `no-focus-${id}`);
    for (const def of [...state.zones.defs.values()].filter((d) => d.per === "shared")) {
      assert.strictEqual(zoneFocusOf(state, def.id), null,
        `${id}'s ${def.id} answered zoneFocus, and no template but climbing implements it`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * What the felt and the screen reader get
 * ------------------------------------------------------------------ */

test("a pile with cards in it still says what it is", async () => {
  const state = await dealt("hearts", 4, "badge-name");
  const trick = state.zones.defs.get("trick");
  assert.ok(trick, "hearts has no trick zone");
  const inst = { def: trick, n: null, address: "trick" };

  // Empty: the name IS the badge, as it always was.
  assert.deepStrictEqual(zoneBadge(state, inst), { text: "Trick", kind: "name" });

  state.zones.get("trick").cards.push("hearts-5");
  state.cardLocation.set("hearts-5", "trick");
  const filled = zoneBadge(state, inst);
  assert.strictEqual(filled.kind, "count");
  assert.strictEqual(filled.text, "1", "the count is still the number the badge shows");
  assert.strictEqual(filled.name, "Trick",
    "a pile that drops its own name the moment a card lands is a pile you cannot tell "
    + "from the one beside it (#122 item 18)");
});

test("the pile you must beat wears the combination, and says so out loud", async () => {
  const state = await dealt();
  const inst = pileInst(state);
  trickWithHistory(state);
  const focus = zoneFocusOf(state, "pile");

  const badge = zoneBadge(state, inst);
  assert.strictEqual(badge.kind, "focus");
  assert.strictEqual(badge.text, focus.label,
    "the badge on a pile that is asking a question must be the question");
  assert.strictEqual(badge.name, "Pile");
  assert.ok(!/^\d+$/.test(badge.text), "the badge must not be a bare count of the trick");

  const said = describeZone(state, inst);
  assert.deepStrictEqual(said.lines[0], { label: "To beat", value: focus.label },
    "the inspector must lead with the shape, not with a count of the trick");
  assert.match(zoneAriaLabel(state, inst), new RegExp(`${focus.label} is standing`),
    "a player who cannot see the ring gets nothing unless the name says it");
});

/* ------------------------------------------------------------------ *
 * The banner: a trick won is not a pass
 * ------------------------------------------------------------------ */

test("the event that ENDS the move outranks the one that was part of it", async () => {
  const pack = await loadPackFromDisk("thirteen");
  const say = (ev, viewerSeat = 0) => pack.template.describeEvent(ev, { seatLabel, viewerSeat });

  const passed = say({ type: "passed", seat: 1 });
  const cleared = say({ type: "trickCleared", seat: 0, cards: [], trickNumber: 2 });
  assert.ok(passed && cleared);
  assert.ok((cleared.priority || 0) > (passed.priority || 0),
    "the pass that ends a trick is emitted before the trick clears, so the banner "
    + "took the pass and the trick was never announced at all (#122 item 22)");

  assert.strictEqual(cleared.text, "Everybody passed — the lead is yours");
  assert.strictEqual(cleared.tone, "good");
  // Somebody else taking it is the same fact in the other direction, and must not
  // borrow the celebratory tone.
  const theirs = say({ type: "trickCleared", seat: 1, cards: [], trickNumber: 2 });
  assert.strictEqual(theirs.text, "Nell takes the trick and leads");
  assert.strictEqual(theirs.tone, "neutral");

  // A single used to say nothing, so the banner kept whatever it last had — a
  // pass from three turns ago standing over your own lead.
  const single = say({ type: "combinationPlayed", seat: 1, kind: "single", size: 1, cards: ["hearts-9"] });
  assert.ok(single && single.text.length, "a single must say something");
  assert.strictEqual(single.text, "Nell played a single");
});

test("celebrateAction picks the highest priority, not the first sentence", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/celebrations.js"), "utf8");
  const fn = src.slice(src.indexOf("function celebrateAction"));
  assert.match(fn.slice(0, fn.indexOf("\n  }")), /priority/,
    "celebrateAction must compare priority; without it climbing's trickCleared "
    + "loses to the pass emitted before it and the whole sentence is unreachable");
});

/* ------------------------------------------------------------------ *
 * A card's worth, in the pack's own direction
 * ------------------------------------------------------------------ */

test("a penalty is not a prize", async () => {
  const thirteen = await loadPackFromDisk("thirteen");
  const wildfire = await loadPackFromDisk("wildfire");
  const card = thirteen.cardsById.get("hearts-9");
  assert.ok(card);

  assert.match(cardAriaLabel(card, thirteen), /1 penalty point if you are caught with it/,
    "every card in Thirteen announced itself as 'worth 1' (#122 item 26)");
  assert.doesNotMatch(cardAriaLabel(card, thirteen), /worth/);

  // A pack where points ARE the prize keeps the old wording.
  const red5 = wildfire.cardsById.get("red-5");
  assert.ok(red5);
  assert.match(cardAriaLabel(red5, wildfire), /worth \d+/);

  // A pack whose template owns the ending is not guessed at either way.
  const cribbage = await loadPackFromDisk("cribbage");
  const any = cribbage.cardsById.values().next().value;
  assert.match(cardAriaLabel(any, cribbage), /worth \d+/);
});
