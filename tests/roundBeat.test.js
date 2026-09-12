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
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";

import {
  roundBeatPlan, showSteps, MIN_HOLD_MS, MIN_TRICK_HOLD_MS, SHOW_STEP_MS,
  trickRevealPlan, MIN_TRICK_REVEAL_MS, READ_AFTER_LANDING_MS, SHARED_TRICK_HOLD_MS,
  nextShowBeat, SHARED_SHOW_STEP_MS,
} from "../src/ui/roundBeat.js";
import { PACE_LEVELS, DEFAULT_PACE } from "../src/ui/pace.js";
import { FLIGHT_MIN_MS, FLIGHT_MS, FLIGHT_MAX_MS } from "../src/ui/flight.js";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** A cribbage show as `theShow` emits it: pone, dealer, then the crib. */
const cribbageShow = [
  { type: 'pegPlay', seat: 0, points: 1, count: 26 },
  { type: 'showScored', seat: 1, isCrib: false, points: 8, cards: ['h-5', 'd-5', 's-J', 'c-4'],
    parts: [{ kind: 'fifteen', points: 2, n: 2 }, { kind: 'fifteen', points: 2, n: 2 },
      { kind: 'pair', points: 2, n: 2 }, { kind: 'nobs', points: 1, n: 1 }] },
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
  // ...and `parts` is what the SENTENCE is built from. The step is the only
  // thing playShowStep has when it asks the template to narrate, so a step
  // that drops the breakdown can only say a number — which is how "his nobs"
  // stayed invisible for a whole playtest (#124).
  assert.ok(steps.some((s) => s.parts.length),
    'a show step must carry the breakdown it was scored from');
});

// THE RUNG IS NAMED HERE FOR THE REASON THE TRICK SECTION NAMES IT. These two
// tests predate the pace term and were written against a bare call, which read
// as "the arithmetic" while the shipped rung's `stepScale` happened to be 1. It
// is null now (#181) — the count waits for a person — so a timeline has to be
// asked of a rung that names a step. What they were protecting is untouched:
// a step is legible before the next replaces it, and the summary is last. The
// sequence's own version of both is in the #181 section below.
test("each step is legible before the next replaces it", () => {
  const plan = roundBeatPlan(cribbageShow, { flightMs: 420, pace: 'quick' });
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
  const plan = roundBeatPlan(cribbageShow, { flightMs: 420, pace: 'quick' });
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
 * THE SHOW AS A SEQUENCE (issue #181)
 * ------------------------------------------------------------------ *
 *
 * At the rung that waits, a count is not given a length — it is given a person.
 * "Fifteen two, fifteen four, and a pair is six" is a sentence somebody says out
 * loud at a table and then waits to be believed, and the rung whose whole
 * meaning is that nothing moves without you was counting it three times in four
 * and a half seconds while the beats on either side of it waited.
 *
 * What a plan with no timeline in it still has to be is a PLAN: the steps in the
 * order the rules put them in, and the summary after all of them. The first half
 * survives unchanged; the second is `nextShowBeat`, because there is nothing
 * left to subtract.
 */

/** The shipped rung counts a show one tap at a time. */
const waiting = () => roundBeatPlan(cribbageShow, { flightMs: 420, pace: 'manual' });

test("at the rung that waits, the show is a sequence and not a timeline", () => {
  const plan = waiting();
  // THE FIRST COUNT STILL OPENS ON THE HOLD, because there is nothing on the
  // felt to dismiss until one of them is on it. Everything after it is a person.
  assert.strictEqual(plan.steps[0].at, plan.holdMs,
    'the first count must still open on the hold, or the show never starts at all');
  assert.deepStrictEqual(plan.steps.slice(1).map((s) => s.at), [null, null],
    'a count with a number on it runs on a clock, which is the thing this rung '
    + 'is not allowed to do');
  assert.strictEqual(plan.stepMs, null,
    'stepMs is how the renderer tells the two kinds of show apart, the way holdMs '
    + 'tells it the two kinds of trick hold apart');
  assert.strictEqual(plan.summaryAt, null,
    'a sheet with a time on it would open over a count the player has not dismissed');
  // AND IT IS THE SHIPPED RUNG, which is not arithmetic and cannot be derived:
  // a player who has never opened the settings counts this way on their first
  // cribbage hand.
  assert.strictEqual(roundBeatPlan(cribbageShow, { flightMs: 420 }).summaryAt, null,
    'a plan built with no rung is a plan at the shipped rung, and the shipped rung '
    + 'is the one that waits (#176, and src/arcade/storage.js for the evidence)');
});

// THE ORDERING, ASKED IN THE UNITS THAT ARE LEFT. While the show runs on a clock
// this is a comparison of two numbers ("the summary opens after everything it
// covers", above). With the numbers gone it is a walk, and the renderer walks
// the same function — a rule with a test on it and nothing reading it is the
// same as no rule.
test("the summary is still after every count when there are no numbers left", () => {
  const plan = waiting();
  const walked = [];
  for (let dismissed = 0; ; dismissed++) {
    const step = nextShowBeat(plan, dismissed);
    if (!step) break;
    walked.push(step);
    assert.ok(dismissed < 4, 'the walk never reaches the sheet; the hand cannot end');
  }
  assert.deepStrictEqual(walked, plan.steps,
    'the sequence must visit every count exactly once, in the plan\'s own order');
  assert.strictEqual(nextShowBeat(plan, plan.steps.length), null,
    'the sheet is what follows the LAST count and nothing else follows it');
  for (let i = 0; i < plan.steps.length; i++) {
    assert.ok(nextShowBeat(plan, i), `the sheet opened with ${3 - i} count(s) still unread`);
  }
  // The three counts are pone, the dealer, then the crib, and that order is the
  // rule rather than a presentation choice — a pone sitting on 118 wins before
  // the dealer ever turns a card over.
  assert.deepStrictEqual(walked.map((s) => s.seat), [1, 0, 0]);
  assert.deepStrictEqual(walked.map((s) => s.isCrib), [false, false, true]);
});

test("a walk from nowhere in particular still lands on the sheet rather than nothing", () => {
  const plan = waiting();
  // Defensive at both ends, because the cursor is a number the renderer keeps:
  // a negative one is a bug and must not index backwards into the array, and one
  // past the end is the ordinary way the sheet is reached.
  assert.strictEqual(nextShowBeat(plan, -1), null);
  assert.strictEqual(nextShowBeat(plan, 99), null);
  assert.strictEqual(nextShowBeat(null, 0), null);
  assert.strictEqual(nextShowBeat({}, 0), null);
});

// THE TIMED RUNGS ARE UNTOUCHED, TO THE MILLISECOND. #181 is a change to one
// rung, and the whole risk of expressing it as an absence in `stepScale` is that
// the arithmetic around the absence quietly moves for everybody else. These are
// the numbers the felt ran before it: a 700ms hold at the default flight, then
// one step per count, then the sheet.
test("a rung that names a step counts exactly as it did before the sequence existed", () => {
  const quick = roundBeatPlan(cribbageShow, { flightMs: 420, pace: 'quick' });
  assert.strictEqual(quick.stepMs, SHOW_STEP_MS);
  assert.deepStrictEqual(quick.steps.map((s) => s.at), [700, 2200, 3700]);
  assert.strictEqual(quick.summaryAt, 5200);

  const relaxed = roundBeatPlan(cribbageShow, { flightMs: 420, pace: 'relaxed' });
  assert.strictEqual(relaxed.stepMs, 2100);
  assert.deepStrictEqual(relaxed.steps.map((s) => s.at), [700, 2800, 4900]);
  assert.strictEqual(relaxed.summaryAt, 7000);
});

test("Instant still has no show to sequence", () => {
  const plan = roundBeatPlan(cribbageShow, { flightMs: 420, pace: 'instant' });
  assert.deepStrictEqual(plan.steps, [],
    'there is no such thing as a step you are given no time to read, and no such '
    + 'thing as one you are asked to dismiss at the rung that never stops');
  assert.strictEqual(plan.summaryAt, 0);
  assert.strictEqual(plan.stepMs, 0,
    'Instant scales the step to nothing, which is a number; null would mean it '
    + 'waits, and it is the one rung that never does');
});

// THE PACK THAT COUNTS NOTHING MUST NOT GAIN A TAP. Every trick-taking round
// ending has no `showScored` at all, and its sheet has always opened on the hold
// — a sequence with nothing in it to sequence would have put a gate on the felt
// with no count behind it and left the table waiting for a tap that opens the
// sheet the player is already waiting for.
test("a round with no show opens its sheet on the hold, at every rung", () => {
  const plain = [{ type: 'roundOver', round: 2, scores: {}, totals: [10, 12], over: false }];
  for (const pace of ['manual', 'relaxed', 'quick']) {
    const plan = roundBeatPlan(plain, { flightMs: 420, pace });
    assert.deepStrictEqual(plan.steps, []);
    assert.strictEqual(plan.summaryAt, plan.holdMs,
      `${pace}: a hand with nothing to count must open its sheet on the hold`);
  }
  // And the same for a show the felt cannot walk — the remote path, where the
  // wire form carries no card ids and there is no snapshot to pose the crib from.
  const remote = roundBeatPlan(cribbageShow, { flightMs: 420, pace: 'manual', narrate: false });
  assert.deepStrictEqual(remote.steps, []);
  assert.strictEqual(remote.summaryAt, remote.holdMs);
});

/* ------------------------------------------------------------------ *
 * A SHARED TABLE NEVER COUNTS INDEFINITELY EITHER (issue #181)
 * ------------------------------------------------------------------ */

// SHARED_TRICK_HOLD_MS's argument, one beat later. `narrate: false` already
// covers the REMOTE path — a client that could not pose the ending walks no
// steps — but a LOCAL move at a shared table counts its show like any other, and
// a count with no clock on it gates this device's queue on a tap while three
// other players keep playing.
test("a shared table's show is finite at every rung, Manual included", () => {
  for (const level of PACE_LEVELS) {
    const plan = roundBeatPlan(cribbageShow, { flightMs: 420, pace: level.id, shared: true });
    for (const step of plan.steps) {
      assert.ok(Number.isFinite(step.at),
        `${level.id}: a shared table left a count up for ${step.at} — one device's `
        + 'local queue would stall while the other three players kept playing');
    }
    assert.ok(Number.isFinite(plan.summaryAt),
      `${level.id}: a shared table's sheet waits for a tap that gates the queue`);
  }
  const shared = roundBeatPlan(cribbageShow, { flightMs: 420, pace: 'manual', shared: true });
  assert.strictEqual(shared.stepMs, SHARED_SHOW_STEP_MS,
    "Manual's open gate becomes the slowest rung's count, not a shorter rung's number");
  assert.deepStrictEqual(shared.steps.map((s) => s.at),
    [shared.holdMs, shared.holdMs + SHARED_SHOW_STEP_MS, shared.holdMs + 2 * SHARED_SHOW_STEP_MS]);
  assert.strictEqual(shared.summaryAt, shared.steps[2].at + SHARED_SHOW_STEP_MS);
});

// THE CAP REPLACES A NULL; IT IS NOT A CEILING OVER EVERY RUNG. A `min` here
// would re-pace Relaxed's count for everybody at the table, which is not what it
// is for — the only thing a shared table takes away is the indefinite gate.
test("the shared cap takes nothing away from a rung that named a step", () => {
  for (const level of PACE_LEVELS) {
    const solo = roundBeatPlan(cribbageShow, { flightMs: 420, pace: level.id });
    if (solo.stepMs == null) continue;
    const shared = roundBeatPlan(cribbageShow, { flightMs: 420, pace: level.id, shared: true });
    assert.strictEqual(shared.stepMs, solo.stepMs,
      `${level.id} counts differently at a shared table; the cap is meant to convert `
      + 'Manual, not to re-pace every other rung');
    assert.deepStrictEqual(shared.steps.map((s) => s.at), solo.steps.map((s) => s.at));
  }
  // And it is the most generous thing any rung already asks for, so converting
  // Manual never hands a shared table LESS time than the dial could have.
  for (const level of PACE_LEVELS) {
    const named = roundBeatPlan(cribbageShow, { flightMs: 420, pace: level.id }).stepMs;
    if (named == null) continue;
    assert.ok(SHARED_SHOW_STEP_MS >= named,
      `${level.id} counts at ${named}ms, longer than the ${SHARED_SHOW_STEP_MS}ms a shared `
      + "table converts Manual to — the cap has to be the slowest rung's own step");
  }
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

// THE RUNG IS NAMED HERE BECAUSE THE NUMBER BELONGS TO A RUNG. These two tests
// predate the pace term (#176) and left the argument off, which read as "the
// arithmetic" while the shipped rung happened to be `quick`. It is `manual`
// now, whose hold is null — the four cards wait for a person — so the formula's
// two halves have to be asked of a rung that names a duration. What each test
// was protecting is untouched: the floor, and the reading time behind the
// flight. That a bare call means the SHIPPED rung is its own test further down.
test("a gathered trick is held, and the plan names the seat taking it", () => {
  const won = [{ type: 'trickWon', seat: 2, points: 0, cards: ['h-2', 'h-9', 'h-K', 'h-A'] }];
  const plan = trickRevealPlan(won, { flightMs: 0, pace: 'quick' });
  assert.equal(plan.trick.seat, 2);
  assert.equal(plan.holdMs, MIN_TRICK_REVEAL_MS);
  // The seat half is rung-independent, and has to be: every rung poses, so
  // every rung has a winner to name in the bar.
  for (const pace of ['manual', 'relaxed', 'quick', 'instant']) {
    assert.equal(trickRevealPlan(won, { flightMs: 0, pace }).trick.seat, 2);
  }
});

// THE FLIGHT IS INSIDE THE HOLD, and this is the assertion that says so. A flat
// hold spent itself watching the fourth card arrive: measured on the felt at
// the default 420ms flight, the first cut of this fix showed four cards for
// 283ms of its 700. Every flight has to leave the whole reading time behind it.
test("the reading time survives a slow flight", () => {
  const trick = [{ type: 'trickWon', seat: 0, points: 3, cards: [] }];
  for (const flightMs of [0, 260, 420, 700, 1200]) {
    const plan = trickRevealPlan(trick, { flightMs, pace: 'quick' });
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

/* ------------------------------------------------------------------ *
 * THE HOLD TRACKS THE PACE RUNG (issue #176)
 * ------------------------------------------------------------------ *
 *
 * The rung scales the READING time and leaves the flight-measured floor alone,
 * which is the distinction the module's own prose is about: "has the fourth card
 * arrived yet" is a fact, "how long do I want to look at it" is a preference.
 *
 * Every number below is checked at the two ends of the flight scale as well as
 * at the default, because the floor and the read swap which of them is binding
 * somewhere in between — a test written only at 420ms would pass on arithmetic
 * that ignored one of them entirely.
 */

/** One completed trick's event window. */
const gathered = [{ type: 'trickWon', seat: 2, points: 0, cards: ['h-2', 'h-9', 'h-K', 'h-A'] }];

/** The hold this repo shipped before the rung was a term in it. */
const shippedHold = (flightMs) => Math.max(MIN_TRICK_REVEAL_MS, flightMs + READ_AFTER_LANDING_MS);

const holdAt = (pace, flightMs, opts = {}) =>
  trickRevealPlan(gathered, { flightMs, pace, ...opts }).holdMs;

// THE RUNG THAT REPRODUCES THE HISTORICAL NUMBER IS `quick`, AND IT IS NOT THE
// DEFAULT. It was for a few hours on 2026-09-11, which is why this test was
// written against DEFAULT_PACE; "today's 920ms" and "the rung this repo ships"
// are two ideas and this file now keeps them apart. Adding a rung term was only
// safe if the rung the acceptance criterion was written about is arithmetically
// where it was, so this pins the number rather than the formula: 920ms at the
// default flight, which is what the felt was measured doing for #123.
test("the brisk rung holds a trick for exactly the number it always has", () => {
  for (const flightMs of [FLIGHT_MIN_MS, 300, FLIGHT_MS, 520, FLIGHT_MAX_MS]) {
    assert.strictEqual(holdAt('quick', flightMs), shippedHold(flightMs),
      `at a ${flightMs}ms flight the Quick rung changed the hold`);
  }
  assert.strictEqual(holdAt('quick', 420), 920);
  assert.strictEqual(holdAt('quick', 700), 1200);
});

// AND A CALL WITH NO RUNG AT ALL IS THE SHIPPED RUNG, which is a different
// promise and now a louder one. It used to mean "a caller that has not learned
// to pass a pace still gets 920ms"; the shipped rung is `manual`, so it now
// means such a caller gets a hold with no clock on it. That is the right
// default for the same reason it is the right default anywhere — the argument
// is in src/arcade/storage.js — but it is worth its own line, because the cost
// of forgetting the argument at a call site went from invisible to a felt that
// stops until it is tapped.
test("a trick plan built with no rung is a plan at the shipped rung", () => {
  assert.strictEqual(
    trickRevealPlan(gathered, { flightMs: 420 }).holdMs, holdAt(DEFAULT_PACE, 420));
  assert.strictEqual(trickRevealPlan(gathered, { flightMs: 420 }).holdMs, null,
    'the shipped rung holds a completed trick until a person ends it; a number here '
    + 'means the default moved and every caller that omits a pace moved with it');
});

// THE FLOOR IS NOT A PREFERENCE. It exists so the fourth card has LANDED before
// the winner gathers, and a rung that shortened it would be a preference for
// reading a card that is still in the air.
test("the floor and the reading time both survive at every rung that reads", () => {
  for (const level of PACE_LEVELS) {
    if (level.trickReadScale == null || level.trickReadScale === 0) continue;
    const wants = READ_AFTER_LANDING_MS * level.trickReadScale;
    // 0 AND 120 ARE WHERE THE FLOOR IS LOAD-BEARING, and they are below what
    // `flightDurationMs` can produce today — it clamps at FLIGHT_MIN_MS, so at
    // every flight a player can actually set, the reading time alone already
    // clears 700ms. The floor is the arithmetic's OWN guarantee rather than a
    // side effect of that clamp, which is why it is checked where it bites: a
    // rung that quietly replaced it would otherwise only surface the day
    // somebody widened the flight range or turned the animation off.
    for (const flightMs of [0, 120, FLIGHT_MIN_MS, FLIGHT_MS, FLIGHT_MAX_MS]) {
      const holdMs = holdAt(level.id, flightMs);
      assert.ok(holdMs >= MIN_TRICK_REVEAL_MS,
        `${level.id} at ${flightMs}ms holds ${holdMs}ms, below the ${MIN_TRICK_REVEAL_MS}ms floor`);
      assert.ok(holdMs - flightMs >= wants,
        `${level.id} at a ${flightMs}ms flight leaves ${holdMs - flightMs}ms to read, `
        + `short of the ${wants}ms the rung asked for`);
    }
  }
  // Quick IS the floor at a flight of nothing, which is the one place the two
  // halves of the formula can be told apart. (Asked of Quick rather than of
  // DEFAULT_PACE: the default is `manual`, whose hold is null, and null tells
  // the floor and the read apart by removing both.)
  assert.strictEqual(holdAt('quick', 0), MIN_TRICK_REVEAL_MS);
});

// A LONGER LOOK, NOT THE SHEET'S SIX SECONDS. #176 records the six as decided
// against: thirteen tricks of it is 78 seconds per hand of pure waiting.
test("Relaxed lengthens the trick without reaching for the score sheet's number", () => {
  const relaxed = holdAt('relaxed', 420);
  assert.ok(relaxed > holdAt('quick', 420),
    'Relaxed must actually be longer than Quick, or the rung says nothing here');
  assert.strictEqual(relaxed, 1420);
  assert.ok(relaxed * 13 < 30_000,
    `thirteen tricks at Relaxed costs ${relaxed * 13}ms; a rung a player might ` +
    'sit on all match cannot turn a hand into a minute of waiting');
});

// THE ONE RUNG THAT WAITS FOR A PERSON. `holdMs: null` is how the renderer is
// told to arm no timer at all — the same shape `autoMs: null` has between hands.
test("Manual is the only rung whose trick hold has no end of its own", () => {
  const open = PACE_LEVELS.filter((l) => trickRevealPlan(gathered, { flightMs: 420, pace: l.id }).holdMs == null);
  assert.deepStrictEqual(open.map((l) => l.id), ['manual'],
    'exactly one rung may hold a trick indefinitely, and it has to be the one '
    + 'whose whole meaning everywhere else in this module is "waits for you"');
  // AND IT IS THE RUNG THIS REPO SHIPS, since 2026-09-11. That is not an
  // arithmetic fact and it cannot be derived from anything above it, which is
  // why it is asserted: the indefinite hold is what a player who has never
  // opened the settings gets on their very first trick.
  assert.strictEqual(open[0].id, DEFAULT_PACE,
    'the shipped rung is the one that waits for a person at both beats (#176, and '
    + "src/arcade/storage.js's `pace` for the evidence that moved it)");
  // A plan is still returned: there IS a beat, it simply has no clock on it.
  const plan = trickRevealPlan(gathered, { flightMs: 420, pace: 'manual' });
  assert.ok(plan, 'Manual must still pose the trick; a null plan is no hold at all');
  assert.strictEqual(plan.trick.seat, 2);
});

// INSTANT SKIPS THE READING, NOT THE ARRIVAL. Returning no plan would be less
// code and would put the gather flight on the felt at 140ms while the played
// card is still 280ms from landing — the pre-#123 felt, where the deciding card
// was never once a rendered card.
test("Instant never leaves a card in the air when the gather starts", () => {
  for (const flightMs of [FLIGHT_MIN_MS, FLIGHT_MS, FLIGHT_MAX_MS]) {
    const plan = trickRevealPlan(gathered, { flightMs, pace: 'instant' });
    assert.ok(plan, 'Instant must still hold the pose, or the sweep starts mid-flight');
    assert.strictEqual(plan.holdMs, flightMs,
      'Instant is the flight and nothing more: no reading time, and no floor to hold it up');
  }
  assert.ok(holdAt('instant', 420) < MIN_TRICK_REVEAL_MS,
    'Instant is the one rung the floor does not apply to; it asked for no reading time');
});

// THE ACCEPTANCE CRITERION, STATED AS THE THING A PLAYER FEELS. A hand is
// thirteen of these, so a millisecond added to a rung is thirteen.
//
// ASKED OF `quick` RATHER THAN OF THE DEFAULT, and the swap is the honest
// reading of the criterion rather than a dodge around it. #176 wrote it as "a
// thirteen-trick hand at the default rung takes no longer than it does today",
// which was a promise about ARITHMETIC drifting under a player who never
// touched anything. The default moving to `manual` is not arithmetic drifting —
// it is a decision, taken on Paul's own playtest and recorded in
// src/arcade/storage.js — so the criterion follows the rung it was about. What
// it protects is that the rung a player reaches for when they want the table to
// run itself still runs it at exactly the old speed.
test("thirteen tricks at the brisk rung is no more waiting than it was", () => {
  const before = 13 * shippedHold(FLIGHT_MS);
  const after = 13 * holdAt('quick', FLIGHT_MS);
  assert.ok(after <= before, `a hand went from ${before}ms of holds to ${after}ms`);
  assert.strictEqual(after, 11_960);
  // AND WHAT THE DEFAULT COSTS INSTEAD, which is not milliseconds: thirteen
  // holds with no clock on them is thirteen taps, plus the one on the sheet.
  // Nobody has to be told what a default that never moves costs in time; they
  // do have to be told how many times it asks.
  assert.strictEqual(holdAt(DEFAULT_PACE, FLIGHT_MS), null,
    'the shipped rung asks for an input per trick rather than a duration per trick');
});

/* ------------------------------------------------------------------ *
 * A SHARED TABLE NEVER HOLDS INDEFINITELY (issue #176)
 * ------------------------------------------------------------------ */

// `posed: false` already covers the REMOTE path — the host applied the move
// before this device heard about it, so there is no pose and no hold. The case
// the cap exists for is a LOCAL move at a shared table, which poses like any
// other and would otherwise gate this device's queue on a tap while three other
// players keep going.
test("a shared table's trick hold is finite at every rung, Manual included", () => {
  for (const level of PACE_LEVELS) {
    for (const flightMs of [FLIGHT_MIN_MS, FLIGHT_MS, FLIGHT_MAX_MS]) {
      const holdMs = trickRevealPlan(gathered, { flightMs, pace: level.id, shared: true }).holdMs;
      assert.ok(typeof holdMs === 'number' && Number.isFinite(holdMs),
        `${level.id}: a shared table held a trick for ${holdMs} — one device's local `
        + 'queue would stall while the other three players kept playing');
      assert.ok(holdMs <= SHARED_TRICK_HOLD_MS,
        `${level.id} at ${flightMs}ms holds ${holdMs}ms, past the ${SHARED_TRICK_HOLD_MS}ms cap`);
    }
  }
  assert.strictEqual(
    trickRevealPlan(gathered, { flightMs: 420, pace: 'manual', shared: true }).holdMs,
    SHARED_TRICK_HOLD_MS, "Manual's open gate becomes the cap, not a shorter rung's number");
});

// THE CAP IS A CEILING, NOT A SECOND RUNG. It was chosen above the longest hold
// any rung asks for, so a shared table plays at the pace the player picked —
// the only thing it takes away is the indefinite gate.
test("the cap takes nothing away from a rung that named a duration", () => {
  for (const level of PACE_LEVELS) {
    for (const flightMs of [FLIGHT_MIN_MS, FLIGHT_MS, FLIGHT_MAX_MS]) {
      const solo = trickRevealPlan(gathered, { flightMs, pace: level.id }).holdMs;
      if (solo == null) continue;
      assert.strictEqual(trickRevealPlan(gathered, { flightMs, pace: level.id, shared: true }).holdMs, solo,
        `${level.id} at ${flightMs}ms plays differently at a shared table; the cap is `
        + 'meant to convert Manual, not to re-pace every other rung');
    }
  }
  // And it can never cut into the floor: the slowest flight plus the longest
  // reading time any rung asks for still fits underneath it.
  assert.ok(SHARED_TRICK_HOLD_MS >= FLIGHT_MAX_MS + READ_AFTER_LANDING_MS,
    'a cap below flight + read would sweep a card the player has not seen land');
});

// A remote move has no pose, so it has no hold — with or without the cap.
test("the cap does not invent a hold on the path that never had one", () => {
  assert.strictEqual(trickRevealPlan(gathered, { flightMs: 420, posed: false, shared: true }), null);
  assert.strictEqual(trickRevealPlan([], { flightMs: 420, shared: true }), null);
});

/* ------------------------------------------------------------------ *
 * The felt's half, which no Node test can call
 * ------------------------------------------------------------------ */

// PART GREP, FOR THE REASON tests/pace.test.js GIVES: src/ui/table.js touches
// `document` at import time, so the wiring that makes an indefinite hold safe
// cannot be imported and called. It can be read.
//
// The three things that make the tap correct rather than merely present: the
// felt carries it, it cancels the clock it is beating, and it runs the held
// resume EXACTLY ONCE — the same resume the timer would have run, which is the
// whole reason it is held on the session at all (both call sites of
// runTrickReveal pass a different function).
test("the felt ends a trick hold on a tap: once, through the held resume", () => {
  const table = read("src/ui/table.js");
  const reveal = table.match(/function runTrickReveal\([\s\S]*?\n\}/);
  assert.ok(reveal, "runTrickReveal must exist — it is the whole of the trick beat");

  assert.match(reveal[0], /session\.beatResume = release/,
    "the resume must be held where the tap handler can reach it: runTrickReveal "
    + "is handed a different `resume` by each of its two call sites, so a handler "
    + "cannot close over the right one");
  assert.match(reveal[0], /session\.beatResume !== release/,
    "the hold must be released exactly once — a tap landing on the frame the "
    + "timer fires would otherwise resume the move twice");
  assert.match(reveal[0], /session\.beatResume = null/,
    "and cleared the moment it runs, or a later tap fires into the position after it");
  assert.match(reveal[0], /session\.revealTimer\.cancel\(\)/,
    "a tap must cancel the clock it is beating; a timer left armed fires into "
    + "the next position");
  assert.match(reveal[0], /myEpoch !== epoch/,
    "and the epoch guard stays: a hold whose table has been closed or re-dealt "
    + "must not resume into it");
  assert.match(reveal[0], /reveal\.holdMs == null/,
    "the indefinite rung must arm no timer at all, rather than one with a null delay");

  const end = table.match(/function endHeldBeat\(\w*\) \{[\s\S]*?\n\}/);
  assert.ok(end, "one function for what ends a held beat, so the tap and the key cannot drift");
  assert.match(end[0], /session\?\.beatResume/);

  // ON THE FELT, NOT ON THE SCREEN: #status-bar is outside #table, so Lobby and
  // the score chip are exempt by construction, and the chrome standing on the
  // felt opts out by name the way the round panel's controls do.
  assert.match(table, /el\.table\.addEventListener\('click'/,
    "the felt itself must carry the tap, or it swallows the whole screen's controls");
  assert.match(table, /closest\?\.\(\s*\n?\s*'#help-button[^']*'/,
    "the controls standing on the felt must opt out of tap-to-advance");
  assert.match(table, /event\.key === 'Enter' \|\| event\.key === ' '/,
    "an indefinite hold that only a pointer can end strands anyone playing this "
    + "from a keyboard or a screen reader");
  assert.match(table, /waits: reveal\.holdMs == null/,
    "the felt has to SAY that a tap is what continues, or a hold with no clock "
    + "on it reads as a frozen table");

  const session = read("src/ui/session.js");
  assert.match(session, /beatResume:/, "the session must own the handle");
  assert.match(session.split('export function stopSession')[1], /beatResume = null/,
    "stopSession must drop it too — cancelling the timer is only half of stopping "
    + "a hold that a tap can also end, and a resume left on a stopped session is a "
    + "closure over a finished match waiting for a finger");
});

// THE OTHER END OF THE SAME TAP (#176), reported as: "this works when I am not
// the last to lay down a card. When I am the last one to lay the card play
// immediately resumes to the next hand."
//
// `#hand` is inside `#table`, so the tap that plays the fourth card is also a
// tap on the felt, and `runTrickReveal` has already opened the hold by the time
// that click reaches the felt's listener — the gesture opened the hold and then
// closed it. Enter on a hand card does the same: the card is a `role="button"`
// div, which the window listener's `button, a[href], ...` opt-out does not
// match. The rule that tells the two apart is a comparison of two numbers and
// lives in src/ui/session.js, where tests/session.test.js calls it directly.
// What can only be grepped is that the felt actually ASKS.
test("neither input path can end the hold its own gesture opened", () => {
  const table = read("src/ui/table.js");

  // IMPORTED, not re-derived. A `>` written inline here is the same rule with
  // no test on it, and this is a rule whose two failure modes are "the beat
  // never happens" and "the table never moves again".
  const imported = table.match(/import \{[\s\S]*?\} from '\.\/session\.js';/);
  assert.ok(imported, "table.js must still take its Node-clean decisions from session.js");
  assert.match(imported[0], /\binputEndsHeldBeat\b/,
    "the decision must come from src/ui/session.js, where a Node test can reach "
    + "it — a copy of it inlined here is a rule with no test on it");

  const reveal = table.match(/function runTrickReveal\([\s\S]*?\n\}/);
  assert.match(reveal[0], /session\.beatOpenedAt = performance\.now\(\)/,
    "the hold must stamp WHEN it opened, on performance.now() — that is the time "
    + "origin Event.timeStamp is measured against, and a stamp from any other "
    + "clock makes the comparison meaningless");

  const end = table.match(/function endHeldBeat\(event\) \{[\s\S]*?\n\}/);
  assert.ok(end, "endHeldBeat must take the input, or it cannot ask about it");
  assert.match(end[0], /inputEndsHeldBeat\(session\.beatOpenedAt, event\?\.timeStamp\)/,
    "one place asks, so the tap and the key cannot disagree about it");

  // BOTH DOORS, because a fix applied to only one of them leaves the other
  // sweeping the trick the player just completed.
  const felt = table.match(/el\.table\.addEventListener\('click',[\s\S]*?\n  \}\);/);
  assert.ok(felt, "the felt's tap listener is not where this test thinks it is");
  assert.match(felt[0], /endHeldBeat\(event\)/,
    "the felt's tap must hand its event over: the tap that plays the fourth card "
    + "arrives here in the same dispatch that opened the hold");

  const keys = table.match(/event\.key === 'Enter' \|\| event\.key === ' '[\s\S]*?preventDefault\(\);/);
  assert.ok(keys, "the keyboard door is not where this test thinks it is");
  assert.match(keys[0], /endHeldBeat\(event\)/,
    "and so must the key: Enter on a hand card plays it and then reaches the "
    + "window listener, because a card is a role=button div and not a <button>");
});

// THE SHOW'S OWN WIRING (#181), and the part of it that a plan cannot state.
//
// The plan says WHAT follows what; only the renderer can say that one gesture
// advances one beat of it. That is the sharp edge here: a round-ending trick's
// hold is ended by a tap whose `resume` runs `runRoundBeat` inside the very same
// dispatch, and each count then opens inside the dispatch of the tap that
// dismissed the one before it — so a missing stamp is a single tap sweeping the
// trick, all three counts and the sheet, and a hand ending in one gesture.
test("the show is walked one input at a time, and one input advances one beat", () => {
  const table = read("src/ui/table.js");
  const run = table.match(/function runShowSequence\([\s\S]*?\n\}/);
  assert.ok(run, "runShowSequence must exist — it is the whole of a show that waits");

  assert.match(run[0], /nextShowBeat\(plan, dismissed\)/,
    "the renderer must walk the plan's own statement of what follows what, or the "
    + "ordering is asserted in one file and implemented in another");
  assert.match(run[0], /session\.beatOpenedAt = performance\.now\(\)/,
    "every beat that opens must stamp WHEN it opened, on the clock Event.timeStamp "
    + "is measured against — without it the tap that dismissed the last count is "
    + "still in flight and dismisses this one too");
  assert.match(run[0], /session\.beatResume !== advance/,
    "a count must be dismissed exactly once: a stale closure from a beat that is "
    + "already over would fire into the middle of the next one");
  assert.match(run[0], /session\.beatResume = null;\s*\n\s*session\.beatOpenedAt = null;/,
    "and the gate must be cleared before the next beat opens, or two of them are "
    + "standing at once");
  assert.match(run[0], /myEpoch !== epoch/,
    "a show whose table has been closed or re-dealt must not keep counting into it");
  // THE STAMP GOES UP BEFORE THE COUNT DOES. The crib's step renders, and
  // `statusTextFor` reads the gate to decide whether to promise the tap — a gate
  // armed after the paint is one count of every hand with the bar saying nothing
  // continues it, and a window for an input to land inside the beat's own opening.
  assert.ok(run[0].indexOf("session.beatOpenedAt = performance.now()")
    < run[0].indexOf("playShowStep("),
    "the gate must be armed before the count is painted");
  assert.match(run[0], /if \(!step\) \{\s*\n\s*openSummary\(\);/,
    "the sheet must be what the cursor runs off the end INTO — reached by there "
    + "being no count left rather than armed alongside the counts");

  // THE SHEET IS NOT ON A TIMER ON THIS PATH. `beatTimer` is armed exactly once
  // — for the first count, which opens on the hold — and the summary is reached
  // only through the walk.
  assert.strictEqual((run[0].match(/beatTimer\(/g) || []).length, 1,
    "a show that waits arms one timer: the first count, on the hold. A second one "
    + "is a beat that happens without the player");
  assert.match(run[0], /beatTimer\(open, plan\.steps\[0\]\.at\)/,
    "the first count must open on the `at` the plan gave it");

  // AND runRoundBeat HAS TO CHOOSE BETWEEN THE TWO KINDS, off the plan rather
  // than off the rung — the rung is the plan's business and the felt reads
  // numbers.
  const beat = table.match(/function runRoundBeat\([\s\S]*?\n\}\n/);
  assert.ok(beat, "runRoundBeat is not where this test thinks it is");
  assert.match(beat[0], /plan\.stepMs == null && plan\.steps\.length/,
    "the renderer must pick the sequence off the plan's own `stepMs`, and only "
    + "when there are counts to wait on — a round with no show must not gate the "
    + "sheet behind a tap that dismisses nothing");

  // THE FELT SAYS A TAP CONTINUES, on both surfaces, or three motionless counts
  // read as a hang. #status-text is a label that changes; #log is the announced
  // one, and it carries the whole sentence.
  assert.match(table, /session\.beatResume \? 'Round over\. Tap to go on\.' : 'Round over\.'/,
    "the status bar must promise the tap for exactly as long as a count is waiting "
    + "for one");
  assert.match(table, /el\.log\.textContent = waits \? heldBeatLine\(text\) : text/,
    "the live region must carry both the count and the way out of it in one write; "
    + "two writes in a frame is one sentence announced and one lost");
  assert.match(run[0], /renderStatusBar\(/,
    "only the crib's count repaints the felt, so the other two would leave the bar "
    + "saying nothing continues them");

  // AND BOTH DOORS HAVE TO BE OPEN TO A COUNT AT ALL. They asked about
  // `session.trickBeat` while a completed trick was the only thing on this felt
  // that ever waited for a person. A count is not a trick, and a door that still
  // asks which KIND of beat is standing is a show that can never be advanced —
  // which at the shipped rung is a cribbage hand that never ends. The gate is
  // the question now, because what a tap means during a held beat does not
  // depend on what is being held.
  const felt = table.match(/el\.table\.addEventListener\('click',[\s\S]*?\n  \}\);/);
  assert.ok(felt, "the felt's tap listener is not where this test thinks it is");
  assert.match(felt[0], /if \(!session\?\.beatResume\) return;/,
    "the felt's tap must be offered to whatever beat is being held, not to one kind "
    + "of beat — a count of a show is not a trick");
  assert.match(table, /if \(session\.beatResume && \(event\.key === 'Enter' \|\| event\.key === ' '\)/,
    "and so must the key, or a show that waits is a table anyone playing from a "
    + "keyboard or a screen reader can never get out of");

  // AND AN ENDING THAT IS CANCELLED TAKES ITS GATE WITH IT. A count's resume is
  // the one thing in a round beat with no timer to cancel, so the sweep that
  // stops everything else would have left it standing.
  const cancel = table.match(/function cancelRoundBeat\(\) \{[\s\S]*?\n\}/);
  assert.ok(cancel, "cancelRoundBeat is not where this test thinks it is");
  assert.match(cancel[0], /session\.beatResume = null/,
    "a gate left open outlives the ending it belongs to: the sheet's own tap would "
    + "find a count's resume still standing and advance a beat of the hand before it");
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
