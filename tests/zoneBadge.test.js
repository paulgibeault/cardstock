// WHAT IS PRINTED UNDER A PILE — the one word, or the one number.
//
// src/ui/describe.js decides this and it is the felt's most-repeated piece of
// text: every pile on the table wears one. The rule was "a pile with cards in
// it introduces itself; an empty one cannot", which is right in the middle of
// the range and wrong at the bottom of it — a badge reading "1" under a single
// card says nothing the card has not already said, and it costs the pile its
// name. Cribbage's cut card is the case that made it visible (#124, item 44):
// "Starter" became "1" the instant it was turned and stayed "1" for the hand.
//
// Asserted here rather than in a browser because `describe.js` is deliberately
// DOM-free, which is the whole reason the words live in it.
import { test } from "node:test";
import assert from "node:assert";
import { zoneBadge } from "../src/ui/describe.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

/** A dealt table, and the zone instance shape describe.js is handed. */
async function table(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  const inst = (id, address = id) => ({ def: state.zones.defs.get(id), n: null, address });
  return { pack, state, ctx: makeCtx(state), inst };
}

test("a pile holding one card wears its NAME, not the number 1", async () => {
  const { state, ctx, inst } = await table("cribbage", 2, "badge:cribbage");
  const starter = inst("starter");

  // Before the cut: empty, and the word is the only thing that could be there.
  assert.deepStrictEqual(zoneBadge(state, starter), { text: "Starter", kind: "name" });

  // The cut. One card, face up, beside a deck of 39 — and "1" under it is a
  // fact the player can already see, printed where the reason it is there
  // should be.
  ctx.moveCards([ctx.topOf("draw")], "draw", "starter");
  assert.strictEqual(state.zones.count("starter"), 1);
  assert.deepStrictEqual(zoneBadge(state, starter), { text: "Starter", kind: "name" },
    'the cut card read "1" for the whole hand');

  // Two or more is a depth you cannot see, so the number comes back.
  const deck = inst("draw");
  assert.deepStrictEqual(zoneBadge(state, deck), { text: "39", kind: "count" });
});

// THE ONE PLACE A SINGLE CARD IS STILL A NUMBER — or rather, a rule. A Crazy
// Eights discard holds exactly one card on the opening lead and what is printed
// there is the suit the whole table must play to. The name must not win over
// it, which is why the count-of-one rule sits BELOW the match check.
test("the suit in force still outranks the name on a one-card discard", async () => {
  const { state, ctx, inst } = await table("crazy-eights", 3, "badge:ce");
  const discard = inst("discard");
  assert.strictEqual(state.zones.count("discard"), 1, "the deal turns one card up");
  const badge = zoneBadge(state, discard);
  assert.strictEqual(badge.kind, "match",
    "a one-card discard prints the rule in force, not the pile's name");
  const active = state.pack.template.activeMatch(ctx);
  assert.ok(active && active.address === "discard");
});
