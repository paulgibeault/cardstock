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
// short of 100 is a bug. Stockpile is NOT gated at 100:
//
//   Stockpile  ~91-95%  a genuine manifest-level rules property: once draw and
//                       recycled are both exhausted a table can have no legal
//                       move at all. The fix is a house rule the reaction
//                       vocabulary cannot express yet, not an engine change —
//                       see the TODO in IMPLEMENTATION_NOTES.md.
//
// Gating that at 100% would mean a permanently red suite; gating it at nothing
// means a real regression could land unnoticed. So it gets a FLOOR, set below
// where it actually sits, which catches a regression without pretending the bar
// is met.
//
// MILESTONES USED TO BE ON THAT LIST AT ~31-40%, and it is worth saying why it
// is not any more, because the diagnosis in this comment was wrong. It was
// written up as slow bot convergence — a laid-down seat's hand only shrinks
// through a lucky hit — but the rounds were not converging slowly, they were
// not converging at all. The contract-rummy heuristic scored the face-up
// discard above the deck unconditionally, so every seat took the pile top every
// turn, the deck was never touched, and the same forty dealt cards circulated
// until the move cap. Teaching the bot when to turn the deck instead
// (src/templates/contract-rummy-bot.js) took Milestones from 16/40 rounds and
// 7,227 moves a round to 1000/1000 and 53. Its floor below is a floor on real
// completion now, not an allowance for a live-lock.
import { test } from "node:test";
import assert from "node:assert";
import {
  simulatePack, simulateMatches, simulateProtocolPack, availableVariantIds,
} from "../tools/simulate.mjs";

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
// Milestones used to get four games instead of twelve, because its stalled
// rounds ran to a 12,000-move cap and every move costs a per-seat view. Its
// rounds are fifty-odd moves now, so it pays the same twelve as everyone else.
const PROTOCOL_GAMES_DEFAULT = 12;

for (const packId of ["crazy-eights", "hearts", "wildfire", "stockpile", "milestones"]) {
  test(`${packId} plays the same over the protocol as it does in one process`, async () => {
    const games = PROTOCOL_GAMES_DEFAULT;
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

test("the two floored packs have not got worse", async () => {
  // Floors, not targets. Set below where each actually sits so ordinary
  // seed-to-seed variation does not flap the suite; a real regression halves
  // these long before it reaches either number.
  //
  // Milestones' floor was 0.25 against a measured 31-40%. It now measures
  // 1000/1000 at four seats and 100/100 at every seat count from two to six, so
  // 0.9 is the same kind of number the old one was: a long way below the truth,
  // and a long way ABOVE the 40% the old heuristic managed. Reverting either
  // half of the contract-rummy draw/discard scoring drops this straight through
  // 0.9, which is the regression this line is here to catch.
  const FLOORS = { milestones: 0.9, stockpile: 0.85 };
  for (const [packId, floor] of Object.entries(FLOORS)) {
    const { completed, errored } = await simulatePack(packId, GAMES, { variants: [] });
    assert.strictEqual(errored, 0, `${packId}: ${errored} rounds threw — a stall is documented, a throw is not`);
    const rate = completed / GAMES;
    assert.ok(rate >= floor,
      `${packId}: ${(rate * 100).toFixed(0)}% of rounds completed, below the ${floor * 100}% floor`);
  }
});

/* ------------------------------------------------------------------ *
 * Past round one
 * ------------------------------------------------------------------ */

// EVERY BAR ABOVE PLAYS ROUND ONE AND STOPS, and for Milestones that is the
// round whose contract is two sets. The runs and the colour group are rungs
// four to eight, and that is where a second live-lock sat for as long as the
// harness only ever dealt round one: with a run(8) owed nearly every pile top
// has a neighbour in hand, so two seats took each other's discards every turn
// and the deck never turned. Round one measured 1000/1000 the whole time;
// more than half of two-seat matches never finished (#92).
//
// TWO SEATS, because that is the table where it binds — at four the pile
// changes hands often enough to break the cycle by accident — and because the
// contract-rummy heuristic's whole draw/discard vocabulary was measured at
// four. Gated at 100%: the fix is a potential the round cannot raise forever
// (src/templates/contract-rummy-bot.js, pileGain), not a tuning that happens
// to work, and a stall here is that argument broken.
test("Milestones matches finish at two seats, contract ladder and all", async () => {
  const MATCHES = 12;
  const { completed, stalled, errored } = await simulateMatches("milestones", MATCHES, { seats: 2, variants: [] });
  assert.strictEqual(errored, 0, `milestones: ${errored} matches threw`);
  assert.strictEqual(stalled, 0, `milestones: ${stalled} matches live-locked past round one`);
  assert.strictEqual(completed, MATCHES, `milestones: only ${completed}/${MATCHES} matches finished`);
});
