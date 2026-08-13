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
import { simulatePack, simulateProtocolPack, availableVariantIds } from "../tools/simulate.mjs";

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

/* ------------------------------------------------------------------ *
 * The same games, over the wire
 * ------------------------------------------------------------------ */

// THE BAR IS EQUALITY, NOT A FLOOR — which is a stronger gate than anything
// above and cannot flap.
//
// Protocol mode replays the SAME seeds with the SAME bot, and hands every
// non-host seat's move to a client that must propose it over the stub
// transport. Move selection is therefore bit-identical to the solo run, so the
// two must agree game for game. A percentage bar would have let a whole class
// of failure through: "97% instead of 100%" reads like variance, and there is
// no variance here — one refused frame is one lost game and the numbers say so.
//
// It is also how the gap that made this mode worth building shows up. Four of
// the five packs could not send a card at all (`base#N` ids and `hand.N`
// addresses failed the wire charset) and Milestones could not lay down or hit
// (a meld's `{item, cards, wilds}` was refused as a malformed choice). Every
// one of those is invisible to the solo run and none of them is subtle here:
// the pack simply stops completing rounds.
//
// Milestones gets fewer games because its stalled rounds run to a 12,000-move
// cap and every move costs a per-seat view. Four rounds of that is still tens
// of thousands of proposals through the full validator.
const PROTOCOL_GAMES = { milestones: 4 };
const PROTOCOL_GAMES_DEFAULT = 12;

for (const packId of ["crazy-eights", "hearts", "wildfire", "stockpile", "milestones"]) {
  test(`${packId} plays the same over the protocol as it does in one process`, async () => {
    const games = PROTOCOL_GAMES[packId] ?? PROTOCOL_GAMES_DEFAULT;
    const solo = await simulatePack(packId, games, { variants: [] });
    const wire = await simulateProtocolPack(packId, games, { variants: [] });

    assert.strictEqual(wire.errored, 0,
      `${packId}: ${wire.errored} rounds hit a protocol fault — a stall is a rules question, an error is ours`);
    assert.deepStrictEqual(wire, solo,
      `${packId}: the protocol changed the outcome of a game the rules already decided`);
  });
}

test("the rules-complete packs are rules-complete over the wire too", async () => {
  for (const packId of ["crazy-eights", "wildfire", "hearts"]) {
    const { completed, stalled, errored } =
      await simulateProtocolPack(packId, PROTOCOL_GAMES_DEFAULT, { variants: [] });
    assert.strictEqual(stalled + errored, 0, `${packId}: ${stalled} stalled, ${errored} errored over the protocol`);
    assert.strictEqual(completed, PROTOCOL_GAMES_DEFAULT,
      `${packId}: only ${completed}/${PROTOCOL_GAMES_DEFAULT} rounds completed over the protocol`);
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
