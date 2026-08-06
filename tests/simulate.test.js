// The simulation, IN CI (design doc §11: "run in CI for every pack").
//
// It never was. `tools/simulate.mjs` is the tool that catches rule deadlocks —
// "draw pile empty and nobody can move", a turn that never advances, an
// infinite reaction cascade — and it only ran when somebody remembered to type
// it. A deadlock introduced by a refactor reached a player before it reached a
// build.
//
// TWO BARS, AND THE SECOND ONE IS THE HONEST PART. Crazy Eights, Wildfire and
// Hearts must complete 100% of rounds: those are rules-complete, and anything
// short of 100 is a bug. Milestones and Stockpile are NOT gated at 100, because
// their shortfalls are known and documented (IMPLEMENTATION_NOTES.md):
//
//   Milestones ~31-40%  a bot-quality artifact. A laid-down seat's hand only
//                       shrinks through a lucky hit, so a round can legitimately
//                       run past the move cap with entirely correct rules.
//   Stockpile  ~91-94%  a genuine manifest-level rules property: once draw and
//                       recycled are both exhausted a table can have no legal
//                       move at all. The fix is a house rule the reaction
//                       vocabulary cannot express yet, not an engine change —
//                       see the TODO in IMPLEMENTATION_NOTES.md.
//
// Gating those at 100% would mean a permanently red suite; gating them at
// nothing means a real regression in either could land unnoticed. So they get a
// FLOOR, set below where they actually sit, which catches a regression without
// pretending the bar is met.
import { test } from "node:test";
import assert from "node:assert";
import { simulatePack, availableVariantIds } from "../tools/simulate.mjs";

// Small enough to keep `npm test` quick, large enough that a deadlock in any
// ordinary line of play shows up. The full 1000-game run stays a manual tool.
const GAMES = 40;

test("the rules-complete packs complete every round", async () => {
  for (const packId of ["crazy-eights", "wildfire", "hearts"]) {
    const { completed, stalled, errored } = await simulatePack(packId, GAMES, { variants: [] });
    assert.strictEqual(stalled, 0, `${packId}: ${stalled} stalled rounds`);
    assert.strictEqual(errored, 0, `${packId}: ${errored} rounds threw`);
    assert.strictEqual(completed, GAMES, `${packId}: only ${completed}/${GAMES} rounds completed`);
  }
});

// A house rule is a RULE CHANGE — seven-zero moves whole hands between seats,
// draw-until-playable can drain the pile in one turn, no-passing deletes a
// phase — and every one of those is the shape of thing a deadlock hides in.
// None had ever been simulated.
test("every available house rule also completes every round", async () => {
  for (const packId of ["crazy-eights", "wildfire", "hearts"]) {
    for (const id of await availableVariantIds(packId)) {
      const { completed, stalled, errored } = await simulatePack(packId, GAMES, { variants: [id] });
      assert.strictEqual(stalled + errored, 0, `${packId} + ${id}: ${stalled} stalled, ${errored} threw`);
      assert.strictEqual(completed, GAMES, `${packId} + ${id}: only ${completed}/${GAMES} completed`);
    }
  }
});

test("the two documented-shortfall packs have not got worse", async () => {
  // Floors, not targets. Set below where each actually sits so ordinary
  // seed-to-seed variation does not flap the suite; a real regression halves
  // these long before it reaches either number.
  const FLOORS = { milestones: 0.25, stockpile: 0.85 };
  for (const [packId, floor] of Object.entries(FLOORS)) {
    const { completed, errored } = await simulatePack(packId, GAMES, { variants: [] });
    assert.strictEqual(errored, 0, `${packId}: ${errored} rounds threw — a stall is documented, a throw is not`);
    const rate = completed / GAMES;
    assert.ok(rate >= floor,
      `${packId}: ${(rate * 100).toFixed(0)}% of rounds completed, below the ${floor * 100}% floor`);
  }
});
