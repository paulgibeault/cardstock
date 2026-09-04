// What a laid-down meld READS like, and the promise that reading it never
// costs a card.
//
// The playtest complaint was small and exact: a run laid `6 3 W 5` is four
// cards you have to sort in your head before you can see the hole. The fix is
// a pure function over the group rather than a sorted `group.cards`, because
// that array is match state — a replay rebuilds it, the wire ships it, and
// `move.choice.meld` indexes the groups array — so these tests never assert on
// what the engine stored, only on what the felt is told to draw.
//
// The second half of the file is the harsher claim. meldDisplayOrder is what
// buildMeldStrip loops over, so if it ever throws or returns a short list, a
// chip renders three cards of a four-card meld and nothing in the UI can tell.
// Every degenerate group below therefore asserts a PERMUTATION — same ids,
// same length — and not merely "did not crash".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { ROOT } from "../tools/stage.mjs";
import { meldDisplayOrder, resolveHit } from "../src/templates/melds.js";

/** Milestones is the pack with melds AND wilds, which is the whole subject. */
function ctxFor(packId = "milestones", seed = "meld-order") {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  const pack = loadPack(manifest, { deckJson });
  const state = createState({ pack, seats: 3, seed });
  pack.template.setup(makeCtx(state));
  return makeCtx(state);
}

/**
 * The property that matters more than the order: the same cards came back.
 *
 * Compared as multisets, so a sort that quietly deduplicated or dropped one is
 * caught even when the remaining ids happen to be in a plausible order.
 */
function assertPermutation(out, cards, what) {
  assert.ok(Array.isArray(out), `${what}: not an array`);
  assert.equal(out.length, cards.length, `${what}: lost or gained a card`);
  assert.deepEqual([...out].sort(), [...cards].sort(), `${what}: not the same cards`);
}

test("a run reads in rank order, with the wild in the slot it was frozen to", () => {
  const ctx = ctxFor();
  // Laid the way the bot's search happened to assemble it — the reported bug.
  const group = {
    item: "run(4)",
    cards: ["red-6", "red-3", "wild", "red-5"],
    wilds: { wild: { rank: "4" } },
  };
  const out = meldDisplayOrder(ctx, group, "run");
  assert.deepEqual(out, ["red-3", "wild", "red-5", "red-6"]);
  assertPermutation(out, group.cards, "sorted run");
  // Stored state is untouched: the protocol and the meld index depend on it.
  assert.deepEqual(group.cards, ["red-6", "red-3", "wild", "red-5"]);
});

test("a run with no wilds still sorts, and colour is not an ordering", () => {
  const ctx = ctxFor();
  // Runs in this template are checked on rank alone, so a mixed-colour run is
  // legal and must not be grouped by colour on the way to the felt.
  const group = { item: "run(4)", cards: ["blue-9", "red-7", "green-8", "red-6"], wilds: {} };
  assert.deepEqual(meldDisplayOrder(ctx, group, "run"),
    ["red-6", "red-7", "green-8", "blue-9"]);
});

test("a hit sorts into its rank slot instead of staying where it was appended", () => {
  const ctx = ctxFor();
  const group = { item: "run(3)", cards: ["red-3", "wild", "red-5"], wilds: { wild: { rank: "4" } } };
  // Through resolveHit, not a hand-built array: appending is the engine's real
  // behaviour and the thing this feature has to survive, so the test has to
  // start from it rather than from a shape the engine never produces.
  const hit = resolveHit(ctx, group, "run", ["red-2"], {});
  assert.ok(hit.ok, hit.reason);
  assert.deepEqual(hit.cards, ["red-3", "wild", "red-5", "red-2"], "the engine appends");
  const after = { item: hit.item, cards: hit.cards, wilds: hit.wilds };
  assert.deepEqual(meldDisplayOrder(ctx, after, "run"),
    ["red-2", "red-3", "wild", "red-5"]);
  assertPermutation(meldDisplayOrder(ctx, after, "run"), hit.cards, "hit run");
});

test("a set keeps its order, with the wilds pushed to the end", () => {
  const ctx = ctxFor();
  // Rank is shared, so there is nothing to sort ON — the only true statement
  // the order can make is which cards are really 7s.
  const group = {
    item: "set(4)",
    cards: ["red-7", "wild", "blue-7", "wild#2"],
    wilds: { wild: { rank: "7" }, "wild#2": { rank: "7" } },
  };
  const out = meldDisplayOrder(ctx, group, "set");
  assert.deepEqual(out, ["red-7", "blue-7", "wild", "wild#2"]);
  assertPermutation(out, group.cards, "set");

  // Naturals among themselves are left exactly as laid.
  const naturalsOnly = { item: "set(3)", cards: ["green-7", "red-7", "blue-7"], wilds: {} };
  assert.deepEqual(meldDisplayOrder(ctx, naturalsOnly, "set"), naturalsOnly.cards);
});

test("a colour group also puts naturals first and wilds last", () => {
  const ctx = ctxFor();
  const group = {
    item: "colorGroup(4)",
    cards: ["red-9", "wild", "red-2", "red-5"],
    wilds: { wild: { color: "red" } },
  };
  assert.deepEqual(meldDisplayOrder(ctx, group, "colorGroup"),
    ["red-9", "red-2", "red-5", "wild"]);
});

test("a group that never went through applyMove is pinned on the way past", () => {
  const ctx = ctxFor();
  // No `wilds` map at all — a rule test poking the melds zone, or the
  // one-group fallback in getMeldGroups. pinnedWildsOf freezes it late, and the
  // run still reads in order rather than falling back to laid order.
  const group = { item: "run(4)", cards: ["red-6", "red-3", "wild", "red-5"] };
  assert.deepEqual(meldDisplayOrder(ctx, group, "run"),
    ["red-3", "wild", "red-5", "red-6"]);
});

test("every degenerate group comes back whole, in the order it went in", () => {
  const ctx = ctxFor();
  const cases = [
    ["unknown kind", { item: "spiral(3)", cards: ["red-3", "red-9", "red-5"] }, "spiral"],
    ["no kind resolvable", { item: null, cards: ["red-3", "red-9", "wild"] }, undefined],
    // Ranks that cannot fit a run(3) window: assignWilds refuses, so the wild
    // has no value and there is no slot to put it in. Better an unsorted meld
    // than one implying the wild belongs at an end.
    ["unvalued wild", { item: "run(3)", cards: ["red-3", "red-9", "wild"] }, "run"],
    ["card not in the pack", { item: "run(3)", cards: ["red-3", "not-a-card", "red-5"] }, "run"],
    ["empty", { item: "run(3)", cards: [] }, "run"],
    ["single card", { item: "run(1)", cards: ["red-3"] }, "run"],
    ["missing cards array", { item: "run(3)" }, "run"],
    ["all wilds", { item: "set(3)", cards: ["wild", "wild#2", "wild#3"] }, "set"],
  ];
  for (const [what, group, kind] of cases) {
    let out;
    assert.doesNotThrow(() => { out = meldDisplayOrder(ctx, group, kind); }, `${what} threw`);
    const cards = group.cards || [];
    assertPermutation(out, cards, what);
    assert.deepEqual(out, cards, `${what}: should have been left alone`);
  }
});

test("no group of real cards ever loses one, whatever kind it is asked for", () => {
  const ctx = ctxFor();
  const ids = [...ctx.pack.cardsById.keys()];
  const kinds = ["run", "set", "colorGroup", "nonsense", undefined];
  // A blunt sweep over real deck slices: the ordering claim is per-kind and
  // argued above, but "same cards out" has to hold for every shape the felt
  // can hand this function, including the illegal ones a hit is mid-way to.
  for (let start = 0; start < ids.length - 5; start += 7) {
    const cards = ids.slice(start, start + 5);
    for (const kind of kinds) {
      const group = { item: kind ? `${kind}(5)` : null, cards };
      let out;
      assert.doesNotThrow(() => { out = meldDisplayOrder(ctx, group, kind); },
        `${cards.join(",")} as ${kind} threw`);
      assertPermutation(out, cards, `${cards.join(",")} as ${kind}`);
    }
  }
});
