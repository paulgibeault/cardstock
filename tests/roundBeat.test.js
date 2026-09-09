// WHEN THE FELT SHOWS A ROUND ENDING (issue #120).
//
// The bug this covers was a timing one and therefore invisible to every test in
// the repo: the round summary opened over a hand that had already been dealt,
// because the engine deals the next round inside the move that ends the old one
// and the felt took that move as its cue to repaint. A burst-screenshot at
// 140ms of a cribbage show found the pegging still live at 0ms and six new
// cards already in the air.
//
// The half of the fix that CAN be tested without a browser is the schedule, so
// the schedule is a pure function over a move's event window
// (src/ui/roundBeat.js) and this is it. What it pins:
//
//   - a plan exists only for a round that ended with the match still running;
//   - the felt is held before anything opens over it, measured against the
//     flight the way `offerFinalLook` measures its own beat;
//   - a cribbage show is three steps IN EMISSION ORDER — pone, dealer, crib —
//     each legible before the next, which is the acceptance criterion;
//   - the summary is always last.

import { test } from "node:test";
import assert from "node:assert";

import {
  roundBeatPlan, showSteps, MIN_HOLD_MS, MIN_TRICK_HOLD_MS, SHOW_STEP_MS,
  trickRevealPlan, MIN_TRICK_REVEAL_MS, READ_AFTER_LANDING_MS,
} from "../src/ui/roundBeat.js";

/** A cribbage show as `theShow` emits it: pone, dealer, then the crib. */
const cribbageShow = [
  { type: 'pegPlay', seat: 0, points: 1, count: 26 },
  { type: 'showScored', seat: 1, isCrib: false, points: 8, parts: [], cards: ['h-5', 'd-5', 's-J', 'c-4'] },
  { type: 'pegged', seat: 1, points: 8, reason: 'show' },
  { type: 'showScored', seat: 0, isCrib: false, points: 11, parts: [], cards: ['h-6', 'd-9', 's-6', 'c-9'] },
  { type: 'pegged', seat: 0, points: 11, reason: 'show' },
  { type: 'showScored', seat: 0, isCrib: true, points: 4, parts: [], cards: ['h-2', 'd-3', 's-10', 'c-K'] },
  { type: 'pegged', seat: 0, points: 4, reason: 'crib' },
  { type: 'roundOver', round: 3, scores: {}, totals: [42, 51], over: false },
];

/* ------------------------------------------------------------------ *
 * Whose ending is it
 * ------------------------------------------------------------------ */

test("an ordinary move gets no plan", () => {
  assert.equal(roundBeatPlan([{ type: 'trickWon', seat: 2, points: 0, cards: [] }]), null);
  assert.equal(roundBeatPlan([]), null);
  assert.equal(roundBeatPlan(undefined), null);
});

// THE MATCH ENDING IS NOT THIS BEAT'S BUSINESS. `offerFinalLook` already holds
// it correctly and #120 is explicit that it is reused as a pattern, not
// changed — and there is no redeal under a finished match to hide.
test("the round that ends the match belongs to offerFinalLook, not here", () => {
  const plan = roundBeatPlan([
    { type: 'trickWon', seat: 0, points: 13, cards: [] },
    { type: 'roundOver', round: 7, scores: {}, totals: [104, 61], over: true },
  ]);
  assert.equal(plan, null);
});

// A show cut short by a peg-out never reaches `ctx.endRound`, so no roundOver is
// emitted at all — the match-end path takes over mid-show, which is the rule
// (cribbage.js's `peg` returns false and every caller checks).
test("a show that ends the match mid-count yields no round plan", () => {
  const cutShort = [
    { type: 'showScored', seat: 1, isCrib: false, points: 12, parts: [], cards: [] },
    { type: 'pegged', seat: 1, points: 12, reason: 'show' },
  ];
  assert.equal(roundBeatPlan(cutShort), null);
});

/* ------------------------------------------------------------------ *
 * The hold
 * ------------------------------------------------------------------ */

test("the felt is held before anything opens over it", () => {
  const plan = roundBeatPlan([{ type: 'roundOver', round: 2, scores: {}, totals: [0, 0], over: false }]);
  assert.equal(plan.holdMs, MIN_HOLD_MS);
  assert.equal(plan.summaryAt, MIN_HOLD_MS);
  assert.ok(plan.summaryAt > 0, 'the summary never opens on the move itself');
});

// The old numbers were 250ms (or 900 after a trick) flat. 250 was less than a
// single card flight at any setting, which is the whole complaint.
test("the hold clears the card flight, at any pace setting", () => {
  const slow = roundBeatPlan(
    [{ type: 'roundOver', round: 2, scores: {}, totals: [0, 0], over: false }],
    { flightMs: 700 },
  );
  assert.ok(slow.holdMs > 700, `${slow.holdMs} must outlast a 700ms flight`);
  assert.equal(slow.holdMs, 980);
});

test("a closing trick is given time to be gathered first", () => {
  const events = [
    { type: 'trickWon', seat: 3, points: 0, cards: ['a', 'b', 'c', 'd'] },
    { type: 'roundOver', round: 4, scores: {}, totals: [0, 0], over: false },
  ];
  const plan = roundBeatPlan(events, { flightMs: 420 });
  assert.equal(plan.gathered, true);
  assert.equal(plan.holdMs, 1060);
  // A gather is longer than a flight, so the trick hold is longer than the
  // plain one at the same setting — and never shorter than the 900ms the felt
  // has always used, which is the floor a fast table falls back to.
  assert.ok(plan.holdMs > roundBeatPlan(events.slice(1), { flightMs: 420 }).holdMs);
  assert.equal(roundBeatPlan(events, { flightMs: 200 }).holdMs, MIN_TRICK_HOLD_MS);
  const slow = roundBeatPlan(events, { flightMs: 700 });
  assert.equal(slow.holdMs, 1340);
  assert.ok(slow.holdMs > plan.holdMs);
});

/* ------------------------------------------------------------------ *
 * The show — three steps, in the order the rules put them in
 * ------------------------------------------------------------------ */

test("a cribbage show is three steps: pone, dealer, crib", () => {
  const steps = showSteps(cribbageShow);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.seat), [1, 0, 0]);
  assert.deepEqual(steps.map((s) => s.isCrib), [false, false, true]);
  assert.deepEqual(steps.map((s) => s.points), [8, 11, 4]);
  // The cards are what the spotlight lights; a local table has them.
  assert.deepEqual(steps[0].cards, ['h-5', 'd-5', 's-J', 'c-4']);
});

test("each step is legible before the next replaces it", () => {
  const plan = roundBeatPlan(cribbageShow, { flightMs: 420 });
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((s) => s.at), [
    plan.holdMs, plan.holdMs + SHOW_STEP_MS, plan.holdMs + 2 * SHOW_STEP_MS,
  ]);
  for (let i = 1; i < plan.steps.length; i++) {
    assert.ok(plan.steps[i].at - plan.steps[i - 1].at >= SHOW_STEP_MS,
      'a step must stay up long enough to read');
  }
});

// THE ONE ORDERING THAT WAS THE BUG. Everything the summary covers has to have
// been on screen first, and the summary's own Continue is what deals the next
// hand (src/ui/table.js's dismissRoundSummary) — so "after the last step" is
// also "after the ending has been seen, before the deal is".
test("the summary opens after everything it covers", () => {
  const plan = roundBeatPlan(cribbageShow, { flightMs: 420 });
  assert.ok(plan.summaryAt > plan.holdMs);
  for (const step of plan.steps) {
    assert.ok(plan.summaryAt > step.at, `summary at ${plan.summaryAt} must follow step at ${step.at}`);
  }
  assert.equal(plan.summaryAt, plan.steps[plan.steps.length - 1].at + SHOW_STEP_MS);
});

// The wire form of `showScored` carries counts rather than card ids, and the
// remote path has no pre-move snapshot to pose the crib from either — so the
// felt cannot walk the reveal there and says so by asking for no steps. The
// hold still applies.
test("without a snapshot the reveal degrades to the plain hold", () => {
  const plan = roundBeatPlan(cribbageShow, { flightMs: 420, narrate: false });
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.summaryAt, plan.holdMs);
});

test("a show step survives an event with no card ids", () => {
  const steps = showSteps([{ type: 'showScored', seat: 1, isCrib: false, points: 6, parts: [{ kind: 'fifteen', points: 2, n: 2 }] }]);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].cards, []);
  assert.equal(steps[0].points, 6);
});

/* ------------------------------------------------------------------ *
 * THE TRICK REVEAL (issue #123)
 * ------------------------------------------------------------------ *
 *
 * The same bug one move smaller, and found the same way: driven frame by frame
 * on unmodified main, the trick pile went 1 → 2 → 3 → 0 across six consecutive
 * tricks, because the fourth card is played and all four are swept into the
 * winner's pile inside one `applyMove`. The deciding card — usually the one
 * that settles who wins — was never on the felt as a rendered card.
 *
 * What is testable without a browser is again the arithmetic: how long the four
 * cards stay whole, measured so that the beat begins when the LAST OF THEM
 * LANDS rather than when the move returned.
 */

test("an ordinary play gets no reveal", () => {
  assert.equal(trickRevealPlan([{ type: 'bidMade', seat: 1, bid: 3 }]), null);
  assert.equal(trickRevealPlan([]), null);
  assert.equal(trickRevealPlan(undefined), null);
});

test("a gathered trick is held, and the plan names the seat taking it", () => {
  const plan = trickRevealPlan([{ type: 'trickWon', seat: 2, points: 0, cards: ['h-2', 'h-9', 'h-K', 'h-A'] }],
    { flightMs: 0 });
  assert.equal(plan.trick.seat, 2);
  assert.equal(plan.holdMs, MIN_TRICK_REVEAL_MS);
});

// THE FLIGHT IS INSIDE THE HOLD, and this is the assertion that says so. A flat
// hold spent itself watching the fourth card arrive: measured on the felt at
// the default 420ms flight, the first cut of this fix showed four cards for
// 283ms of its 700. Every flight has to leave the whole reading time behind it.
test("the reading time survives a slow flight", () => {
  const trick = [{ type: 'trickWon', seat: 0, points: 3, cards: [] }];
  for (const flightMs of [0, 260, 420, 700, 1200]) {
    const plan = trickRevealPlan(trick, { flightMs });
    assert.ok(plan.holdMs - flightMs >= READ_AFTER_LANDING_MS,
      `at a ${flightMs}ms flight the hold leaves only ${plan.holdMs - flightMs}ms to read four cards`);
  }
});

// No pre-move snapshot means no position with four cards on it to pose — the
// multiplayer path, where the host applied the move before this device heard
// about it. The gather then happens exactly as it always did.
test("without a pose there is nothing to hold", () => {
  const trick = [{ type: 'trickWon', seat: 1, points: 0, cards: [] }];
  assert.equal(trickRevealPlan(trick, { flightMs: 420, posed: false }), null);
  assert.ok(trickRevealPlan(trick, { flightMs: 420, posed: true }));
});

// The round beat's own arithmetic is unchanged by any of this: a reveal is a
// DELAY IN FRONT of it (src/ui/table.js runs one and then the other), not a
// term inside it, so the hand that ends on a trick is still held for the gather
// and its summary still opens last.
test("the round beat's schedule is untouched by the trick reveal", () => {
  const events = [
    { type: 'trickWon', seat: 3, points: 0, cards: [] },
    { type: 'roundOver', round: 4, scores: {}, totals: [90, 120], over: false },
  ];
  const plan = roundBeatPlan(events, { flightMs: 420 });
  // The gather's own allowance, exactly as #120 set it: the last of four
  // staggered copies is in the air until flight + 640.
  assert.equal(plan.holdMs, Math.max(MIN_TRICK_HOLD_MS, 420 + 640));
  assert.equal(roundBeatPlan(events, { flightMs: 200 }).holdMs, MIN_TRICK_HOLD_MS);
  assert.equal(plan.summaryAt, plan.holdMs);
  assert.ok(plan.gathered);
});
