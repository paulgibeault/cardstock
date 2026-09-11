// WHAT IS PRINTED UNDER A PILE — the one word, or the one number.
//
// src/ui/describe.js decides this and it is the felt's most-repeated piece of
// text: every pile on the table wears one. The rule was "a pile with cards in
// it introduces itself; an empty one cannot", and it cost the pile its name
// the instant a card landed. Cribbage's cut card is the case that made it
// visible (#124, item 44): "Starter" became "1" the instant it was turned and
// stayed "1" for the hand. #122 hit the same seam from Thirteen's side and the
// rule they settled on together is that the NAME RIDES BESIDE THE COUNT — the
// badge returns both, and the renderer prints "Starter / 1".
//
// Asserted here rather than in a browser because `describe.js` is deliberately
// DOM-free, which is the whole reason the words live in it.
import { test } from "node:test";
import assert from "node:assert";
import { zoneBadge, hiddenPileChip } from "../src/ui/describe.js";
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

test("a pile holding one card keeps its NAME beside the number", async () => {
  const { state, ctx, inst } = await table("cribbage", 2, "badge:cribbage");
  const starter = inst("starter");

  // Before the cut: empty, and the word is the only thing that could be there.
  assert.deepStrictEqual(zoneBadge(state, starter), { text: "Starter", kind: "name" });

  // The cut. One card, face up, beside a deck of 39 — the reason it is there
  // must stay printed under it, whatever the count says.
  ctx.moveCards([ctx.topOf("draw")], "draw", "starter");
  assert.strictEqual(state.zones.count("starter"), 1);
  assert.deepStrictEqual(zoneBadge(state, starter), { text: "1", kind: "count", name: "Starter" },
    'the cut card read "1" for the whole hand');

  // A depth you cannot see is a number worth printing — and still named.
  const deck = inst("draw");
  assert.deepStrictEqual(zoneBadge(state, deck), { text: "39", kind: "count", name: "Deck" });
});

// THE ONE PLACE THE NAME DOES NOT RIDE ALONG. A Crazy Eights discard holds
// exactly one card on the opening lead and what is printed there is the suit
// the whole table must play to; the rule in force is the badge, alone.
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

/* ------------------------------------------------------------------ *
 * ...AND THE ONE SURFACE WHERE AN EMPTY PILE SAYS NOTHING (#148)
 * ------------------------------------------------------------------ *
 *
 * A seat plate has no dashed rectangle on it. The pile is a chip of WORDS, so
 * the name the rule above keeps arrives on its own with nothing under it — and
 * "Won" on a seat that has taken no tricks reads as a claim that they won
 * something, on all four plates, every hand, before a card is played.
 */

test("an empty hidden pile draws no chip on a plate, and a full one still does", async () => {
  const { state, ctx, inst } = await table("team-spades", 4, "chip:spades");
  const won = inst("won", "won.0");

  // The felt is unchanged: on a dashed rectangle the word is the missing half.
  assert.deepStrictEqual(zoneBadge(state, won), { text: "Won", kind: "name" });
  // The plate is not: there is no rectangle, so there is nothing to be half of.
  assert.strictEqual(hiddenPileChip(state, won), null,
    'a seat that has taken nothing wore the bare word "Won"');

  // Four cards is one trick, and the template is what knows that (#123). Once
  // there IS something to report, the chip comes back, named and counted.
  // Two tricks' worth, taken off the seats that are holding them.
  for (let seat = 0; seat < 4; seat++) {
    const hand = ctx.zoneAddr("hand", seat);
    ctx.moveCards(ctx.cardIdsIn(hand).slice(0, 2), hand, "won.0");
  }
  assert.strictEqual(state.zones.count("won.0"), 8, "the fixture did not move two tricks");
  assert.deepStrictEqual(hiddenPileChip(state, won), { text: "Won 2 tricks" });
  // And the points ride along where the pile publishes them, unchanged.
  assert.deepStrictEqual(hiddenPileChip(state, won, "4 pts"), { text: "Won 2 tricks · 4 pts" });
});

// EVERY pack, not just the one the finding came from: the empty-pile rule is
// the platform's, and "same shape on every pack with a hidden won pile" was
// half of what #148 asked for.
test("no pack's plate prints a bare pile name at a fresh deal", async () => {
  const { listPackIds } = await import("../tools/pack-test.mjs");
  let checked = 0;
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    const seats = Math.max(2, Math.min(4, pack.manifest.players.max));
    const state = createState({ pack, seats, seed: `chip:${packId}` });
    pack.template.setup(makeCtx(state));
    for (const [id, def] of state.zones.defs) {
      if (def.per !== "player" || def.visibility !== "none") continue;
      for (let seat = 0; seat < seats; seat++) {
        const address = `${id}.${seat}`;
        if (!state.zones.has(address)) continue;
        checked++;
        const chip = hiddenPileChip(state, { def, n: null, address });
        const name = def.label || id;
        if (state.zones.count(address) === 0) {
          assert.strictEqual(chip, null,
            `${packId}: an empty hidden ${id} still draws a chip on the plate`);
        } else {
          assert.notStrictEqual(chip?.text, name,
            `${packId}: the ${id} chip is the bare word "${name}" with no number beside it`);
        }
      }
    }
  }
  // AN EMPTY SWEEP IS A FAILURE: a renamed visibility value would otherwise
  // leave every `continue` taken and this green over nothing.
  assert.ok(checked >= 12, `only ${checked} hidden per-seat piles were examined`);
});
