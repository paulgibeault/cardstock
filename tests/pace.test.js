// HOW LONG THE TABLE WAITS BETWEEN HANDS (issue #150).
//
// The complaint was that the round summary had exactly one behaviour — wait
// for a tap — and no way to say otherwise. The fix is four named rungs, and
// the thing worth pinning is the join between them and everything that reads
// them: the arithmetic (src/ui/roundBeat.js), the sheet that offers them
// (src/ui/newGame.js), the lobby that saves the answer, and the panel that
// cycles it mid-match.
//
// PART GREP, FOR THE REASON tests/difficulty.test.js GIVES. newGame.js,
// lobby.js, panels.js and table.js all touch `document` at import time, so no
// Node test can load them and ask what they render. The list and the schedule
// are the parts that CAN be imported, and they are where the decisions live.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { PACE_LEVELS, DEFAULT_PACE, paceLevel, nextSummaryPace } from "../src/ui/pace.js";
import {
  roundBeatPlan, SHOW_STEP_MS, MIN_HOLD_MS, trickRevealPlan, READ_AFTER_LANDING_MS,
} from "../src/ui/roundBeat.js";
import { SETTINGS_DEFAULTS } from "../src/arcade/storage.js";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** A hand that ended on a trick, with nothing to count. */
const plainEnd = [{ type: 'roundOver', round: 2, scores: {}, totals: [10, 12], over: false }];

/** A cribbage show: pone, dealer, crib — the one reveal a pace has to stretch. */
const showEnd = [
  { type: 'showScored', seat: 1, isCrib: false, points: 8, parts: [], cards: [] },
  { type: 'showScored', seat: 0, isCrib: false, points: 11, parts: [], cards: [] },
  { type: 'showScored', seat: 0, isCrib: true, points: 4, parts: [], cards: [] },
  { type: 'roundOver', round: 3, scores: {}, totals: [42, 51], over: false },
];

/* ------------------------------------------------------------------ *
 * The rungs themselves
 * ------------------------------------------------------------------ */

test("the four rungs are named, distinct, and ordered least automatic to most", () => {
  assert.deepStrictEqual(PACE_LEVELS.map((l) => l.id), ['manual', 'relaxed', 'quick', 'instant']);
  const labels = PACE_LEVELS.map((l) => l.label);
  assert.strictEqual(new Set(labels).size, labels.length, "two rungs share a label");
  for (const level of PACE_LEVELS) {
    assert.ok(level.label && level.label !== level.id,
      `${level.id}: needs a player-facing label, not the stored id`);
    assert.ok((level.description || "").length > 20,
      `${level.id}: needs prose saying what the table does at it`);
  }
  // The ladder is the whole of how the row explains itself: every rung after
  // Manual waits less than the one before it.
  const waits = PACE_LEVELS.map((l) => (l.autoMs == null ? Infinity : l.autoMs));
  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i] < waits[i - 1],
      `${PACE_LEVELS[i].id} waits ${waits[i]}ms, no less than ${PACE_LEVELS[i - 1].id}'s`);
  }
});

test("only Manual never advances, and only Instant skips the transition", () => {
  assert.strictEqual(paceLevel('manual').autoMs, null,
    "Manual is today's behaviour: the sheet waits, forever, for a tap");
  for (const id of ['relaxed', 'quick', 'instant']) {
    assert.strictEqual(typeof paceLevel(id).autoMs, 'number',
      `${id}: a rung that is not Manual must deal itself`);
  }
  assert.deepStrictEqual(PACE_LEVELS.filter((l) => l.instant).map((l) => l.id), ['instant']);
});

// WHAT THIS HAS ALWAYS BEEN PROTECTING is not the id `quick`. It is that a
// player who never opens the settings still gets the one surface where a
// round's damage is spelled out, and gets long enough to read it. `instant` is
// the rung that trades the sheet away, and it has to be CHOSEN rather than
// arrived at.
//
// THE ARITHMETIC HALF USED TO BE `autoMs >= 2000`, which was the only way a
// rung could be long enough while the default was `quick`. The default is
// `manual` now and its `autoMs` is null — not a shorter read but an unbounded
// one — so the property is written as the two ways a rung can satisfy it
// rather than as the one the old default happened to use.
test("the shipped default is a rung that still shows the sheet", () => {
  assert.strictEqual(SETTINGS_DEFAULTS.pace, DEFAULT_PACE);
  const level = paceLevel(DEFAULT_PACE);
  assert.strictEqual(level.instant, false,
    "the default must not be the rung that trades the score sheet away");
  assert.ok(level.autoMs === null || level.autoMs >= 2000,
    `the default deals itself after ${level.autoMs}ms, short of a four-seat score `
    + "sheet's read — a default rung either waits for the player or waits long enough");
});

// A saved setting is a string on disk and can be anything — an older build, a
// rung that was rolled back, a hand-edited save.
test("an unknown saved value falls back to the shipped default", () => {
  assert.strictEqual(paceLevel('glacial').id, SETTINGS_DEFAULTS.pace);
  assert.strictEqual(paceLevel(undefined).id, SETTINGS_DEFAULTS.pace);
  assert.strictEqual(paceLevel('manual').id, 'manual');
});

/* ------------------------------------------------------------------ *
 * The one control that changes a rung mid-match (#174)
 * ------------------------------------------------------------------ */

// THE CONTROL USED TO DELETE ITSELF IN ONE TAP, and it deleted itself for the
// whole match. The cycle walked PACE_LEVELS in order, the shipped rung is
// `quick`, so the first tap any player ever made landed on `instant` — whose
// 0ms auto-advance closed the sheet the control was sitting on, on the next
// tick. After that `plan.instant` was true forever, `runRoundBeat` took the
// `dismissRoundSummary` early return, and there was no second summary to tap.
//
// The rungs the cycle walks are the fix, so they are what these pin. The
// walk is derived from the list rather than spelled out, so a fifth rung is a
// failure here rather than a rung the control silently never offers.
const CYCLEABLE = PACE_LEVELS.filter((l) => !l.instant).map((l) => l.id);

/** Every rung one lap of the control reaches, starting from `from`. */
const lap = (from) => {
  const out = [];
  let id = from;
  for (let i = 0; i < CYCLEABLE.length; i++) {
    id = nextSummaryPace(id);
    out.push(id);
  }
  return out;
};

test("the summary's cycle offers every rung that keeps a sheet, and only those", () => {
  const reached = lap(DEFAULT_PACE);
  assert.ok(!reached.includes('instant'),
    "the summary's own control offered Instant, the rung that shows no summary — "
    + "the tap that picks it is the last tap that can ever reach this control");
  assert.deepStrictEqual([...reached].sort(), [...CYCLEABLE].sort(),
    "a rung that still shows a sheet became unreachable mid-match; the new-game "
    + "sheet is only open between matches, so this control is the only other door");
});

// #174'S GUARANTEE, RESTATED FOR A DEFAULT THAT NEVER DEALS. The principle was
// "a tap on this control always hands the player MORE time", and while the
// default was `quick` that read straight off: the first tap anybody ever made
// landed on Relaxed, and this test was called "one tap from the shipped default
// lands on Relaxed". From `manual` there is no more time to hand out — that
// rung never deals at all — so the first tap is now the cycle's single wrap,
// downward, to Quick.
//
// THAT IS NOT THE BUG #174 FIXED, and the difference is the whole point. The
// bug was a first tap landing on the rung that shows NO SHEET, which deleted
// the control along with the sheet it lives on. A first tap that lands on the
// shortest wait which STILL SHOWS ONE is the table starting to move, which is
// the only thing a tap from Manual can be asking for.
test("one tap from the shipped default is the step out of the rung with no clock", () => {
  assert.strictEqual(paceLevel(DEFAULT_PACE).autoMs, null,
    "this test is about the wrap out of a default that has no clock on it; if the "
    + "default deals itself again, #174's 'every tap hands out more time' applies "
    + "and the line below should be asserting Relaxed instead");
  assert.strictEqual(nextSummaryPace(DEFAULT_PACE), 'quick',
    "from the rung that never deals, the only move round the cycle is down — and it "
    + "has to be the shortest wait that still shows a sheet");
  assert.strictEqual(paceLevel(nextSummaryPace(DEFAULT_PACE)).instant, false,
    "the first tap any player ever makes must not land on the rung that deletes this "
    + "control by closing the sheet it sits on; that is exactly #174's bug");
});

// THE SHORTEST WAIT A RUNG THAT STILL SHOWS A SHEET MAY LEAVE. Named rather
// than derived from the list, because a floor read out of the same list it is
// checked against is a gate agreeing with itself about nothing.
const BRISKEST_SHEET_MS = 2500;

// THE PROPERTY THAT MAKES THE CONTROL NON-SELF-DELETING, stated as a property
// rather than as the four ids: a tap must never leave the player less time to
// make the next one than the briskest rung on the cycle already gives them.
//
// IT USED TO BE PINNED AGAINST THE DEFAULT'S OWN `autoMs`, which worked exactly
// as long as the default named a duration. With `manual` shipped that floor is
// null and the comparison passes for every rung without asking anything. The
// floor that was always doing the work is the shortest wait that still shows a
// sheet, so it is named directly. Changing a rung's `autoMs` is what breaks it.
test("no rung the cycle can reach waits less than the briskest sheet does", () => {
  for (const id of lap(DEFAULT_PACE)) {
    const level = paceLevel(id);
    assert.ok(level.autoMs === null || level.autoMs >= BRISKEST_SHEET_MS,
      `${id} deals itself after ${level.autoMs}ms, short of the ${BRISKEST_SHEET_MS}ms `
      + 'floor — a tap on this control must never leave less time to make the next one');
  }
  assert.ok(lap(DEFAULT_PACE).some((id) => paceLevel(id).autoMs === BRISKEST_SHEET_MS),
    `no rung on the cycle sits at ${BRISKEST_SHEET_MS}ms any more: either a rung's wait `
    + 'moved, or this floor is a number nothing is holding up and the check above is free');
});

test("the cycle wraps, and a nonsense stored id cycles on from the default", () => {
  const reached = lap(DEFAULT_PACE);
  assert.strictEqual(reached[reached.length - 1], DEFAULT_PACE,
    "one lap must come back to where it started, or the last rung is a trap");
  assert.deepStrictEqual(reached, ['quick', 'relaxed', 'manual'],
    "the walk has to run toward MORE time — Quick to Relaxed to Manual — with one "
    + "wrap out of Manual, which is where every player now starts; running it the "
    + "other way is how the first tap used to reach the rung with no sheet");
  assert.strictEqual(nextSummaryPace('glacial'), nextSummaryPace(DEFAULT_PACE),
    "a stale value cycles on from the default rather than sticking");
});

// The rung was taken off the CYCLE, not out of the list. Between matches there
// is no sheet for it to close, so the new-game sheet can still offer it.
test("Instant is still a rung, so the new-game sheet can still offer it", () => {
  assert.ok(PACE_LEVELS.some((l) => l.id === 'instant'),
    "deleting the rung instead of leaving it off the cycle takes away the one way "
    + "to play with no sheet between hands at all");
  assert.strictEqual(PACE_LEVELS.length, CYCLEABLE.length + 1,
    "exactly one rung is off the cycle; a second one would be a rung that can "
    + "only ever be chosen between matches, without anyone having decided that");
});

/* ------------------------------------------------------------------ *
 * The rung inside the schedule
 * ------------------------------------------------------------------ */

test("the plan carries its rung's wait, and Manual carries none", () => {
  assert.strictEqual(roundBeatPlan(plainEnd, { pace: 'manual' }).autoAdvanceMs, null);
  assert.strictEqual(roundBeatPlan(plainEnd, { pace: 'relaxed' }).autoAdvanceMs, 6000);
  assert.strictEqual(roundBeatPlan(plainEnd, { pace: 'quick' }).autoAdvanceMs, 2500);
  for (const id of PACE_LEVELS.map((l) => l.id)) {
    assert.strictEqual(roundBeatPlan(plainEnd, { pace: id }).pace, id,
      `${id}: the plan must name the rung it was built for, or the panel cannot label it`);
  }
});

// THE HOLD IS NOT THE PACE. It is measured against the flight so the last card
// has LANDED before anything asks to be read, and the flight is already the
// player's own speed setting. Every rung that shows a sheet keeps it.
test("a faster rung never shortens the hold that clears the card flight", () => {
  const base = roundBeatPlan(plainEnd, { flightMs: 700, pace: 'manual' }).holdMs;
  assert.strictEqual(base, 980);
  for (const id of ['relaxed', 'quick']) {
    assert.strictEqual(roundBeatPlan(plainEnd, { flightMs: 700, pace: id }).holdMs, base,
      `${id}: the pause between hands is the preference, not whether a card has arrived`);
  }
  assert.ok(base > 700, "the hold must outlast the flight at every rung that has one");
});

test("Instant has no beat at all: no hold, no steps, no sheet", () => {
  const plan = roundBeatPlan(showEnd, { flightMs: 420, pace: 'instant' });
  assert.strictEqual(plan.instant, true);
  assert.strictEqual(plan.holdMs, 0);
  assert.deepStrictEqual(plan.steps, []);
  assert.strictEqual(plan.summaryAt, 0,
    "Instant means the deal is the next thing on the felt, not a sheet raced away");
  assert.strictEqual(plan.autoAdvanceMs, 0);
});

/* ------------------------------------------------------------------ *
 * The rung inside the SHOW (issue #181)
 * ------------------------------------------------------------------ *
 *
 * The third term to say "wait for me" with an absence rather than a number. The
 * shipped rung waited at the trick and at the sheet and counted the show in
 * between on a clock — "fifteen two, fifteen four, and a pair is six" three
 * times in four and a half seconds, at the rung whose whole meaning is that
 * nothing moves without you.
 */

test("every rung says how long a count stands, and only Manual leaves it open", () => {
  for (const level of PACE_LEVELS) {
    assert.ok('stepScale' in level,
      `${level.id}: a rung with no show term is a rung the felt cannot pace a count at`);
    assert.ok(level.stepScale === null || level.stepScale >= 0,
      `${level.id}: ${level.stepScale} is neither "wait for me" nor a multiplier`);
  }
  assert.deepStrictEqual(
    PACE_LEVELS.filter((l) => l.stepScale === null).map((l) => l.id), ['manual'],
    'exactly one rung may leave a count up until a person dismisses it, and it has '
    + 'to be the one whose `autoMs` and `trickReadScale` already mean the same thing '
    + 'at the two beats on either side of it');
  // The ladder, same as `autoMs` and `trickReadScale`: every rung after Manual
  // reads for less time than the one before it.
  const reads = PACE_LEVELS.map((l) => (l.stepScale == null ? Infinity : l.stepScale));
  for (let i = 1; i < reads.length; i++) {
    assert.ok(reads[i] < reads[i - 1],
      `${PACE_LEVELS[i].id} counts at ${reads[i]}×, no less than ${PACE_LEVELS[i - 1].id}'s`);
  }
  // THE THREE TERMS READ ALIKE AT EVERY RUNG, which is the whole argument for
  // spelling this one as a null: a rung is one answer to "how much of this game
  // do I want to watch", so a rung that waits at one beat and runs itself at
  // another is a dial saying two different things at once.
  for (const level of PACE_LEVELS) {
    assert.strictEqual(level.stepScale === null, level.autoMs === null,
      `${level.id} waits at one beat and not the other; the dial has to mean one thing`);
    assert.strictEqual(level.stepScale === null, level.trickReadScale === null,
      `${level.id} waits at the trick and not at the count, or the other way round`);
  }
});

// THE SHIPPED RUNG COUNTS ONE TAP AT A TIME, and that is a decision rather than
// arithmetic: a player who has never opened the settings gets it on their first
// cribbage hand, and Paul asked for it by name — "three taps one per player and
// crib to continue".
test("the shipped default waits for a person at the count too", () => {
  assert.strictEqual(paceLevel(DEFAULT_PACE).stepScale, null,
    'no count of a show may replace itself at the shipped rung');
  const plan = roundBeatPlan(showEnd, { flightMs: 420 });
  assert.strictEqual(plan.steps.length, 3,
    'pone, the dealer and the crib — three counts, which is three taps');
  assert.strictEqual(plan.summaryAt, null,
    'and the sheet after the last of them, which is the fourth');
  // The felt promises it at exactly the rung that needs it promised, on the bar
  // and in the live region — three motionless counts read as a hang otherwise.
  assert.match(read("src/ui/table.js"), /'Round over\. Tap to go on\.'/,
    'the status bar must offer the tap whenever a count is waiting for one, which at '
    + 'the shipped rung is every count of every cribbage hand');
});

test("the show stretches and shrinks with the rung", () => {
  const quick = roundBeatPlan(showEnd, { flightMs: 420, pace: 'quick' });
  const relaxed = roundBeatPlan(showEnd, { flightMs: 420, pace: 'relaxed' });
  assert.strictEqual(quick.steps.length, 3);
  assert.strictEqual(relaxed.steps.length, 3);
  assert.strictEqual(quick.stepMs, SHOW_STEP_MS,
    "the default rung must not change a number that was chosen by reading it out loud");
  assert.ok(relaxed.stepMs > quick.stepMs,
    `Relaxed counts at ${relaxed.stepMs}ms, no slower than Quick's ${quick.stepMs}ms`);
  // The whole reveal moves with it, not just the gap between the first two.
  assert.ok(relaxed.summaryAt > quick.summaryAt);
  for (let i = 1; i < relaxed.steps.length; i++) {
    assert.strictEqual(relaxed.steps[i].at - relaxed.steps[i - 1].at, relaxed.stepMs);
  }
});

// #120's invariant, re-asserted per rung: the summary is the acknowledgement,
// so everything it covers has to have been on screen before it.
//
// ASKED ONLY OF THE RUNGS THAT COUNT ON A CLOCK. At `manual` the show is a
// sequence and there are no numbers left to compare (#181) — the same invariant
// is asserted for it in the section below, through `nextShowBeat`, which is what
// "after" means once the arithmetic is gone.
test("the summary still opens last, at every rung that opens one", () => {
  for (const id of ['relaxed', 'quick']) {
    const plan = roundBeatPlan(showEnd, { flightMs: 420, pace: id });
    assert.ok(plan.summaryAt >= MIN_HOLD_MS, `${id}: the summary opened on the move itself`);
    for (const step of plan.steps) {
      assert.ok(plan.summaryAt > step.at,
        `${id}: summary at ${plan.summaryAt} must follow a step at ${step.at}`);
    }
  }
  // And the rung with no clock still opens a sheet, which is the half of this
  // that is not about ordering: `manual` is not `instant`.
  assert.strictEqual(roundBeatPlan(showEnd, { flightMs: 420, pace: 'manual' }).instant, false);
});

/* ------------------------------------------------------------------ *
 * The rung inside the TRICK hold (issue #176)
 * ------------------------------------------------------------------ *
 *
 * One dial, two beats. The rung already said how long the table waits between
 * hands; it now also says how long a completed trick stays whole on the felt.
 * The term is a scale on the READING time only — the flight-measured floor is a
 * fact about whether the fourth card has arrived, not a taste.
 */

const trickEnd = [{ type: 'trickWon', seat: 1, points: 0, cards: ['h-2', 'h-9', 'h-K', 'h-A'] }];
const trickHold = (pace, flightMs = 420, opts = {}) =>
  trickRevealPlan(trickEnd, { flightMs, pace, ...opts }).holdMs;

test("every rung says how long a trick is read for, and only Manual leaves it open", () => {
  for (const level of PACE_LEVELS) {
    assert.ok('trickReadScale' in level,
      `${level.id}: a rung with no trick term is a rung the felt cannot pace a trick at`);
    assert.ok(level.trickReadScale === null || level.trickReadScale >= 0,
      `${level.id}: ${level.trickReadScale} is neither "wait for me" nor a multiplier`);
  }
  assert.deepStrictEqual(
    PACE_LEVELS.filter((l) => l.trickReadScale === null).map((l) => l.id), ['manual'],
    'exactly one rung may hold a trick until a person ends it, and it is the one '
    + 'whose `autoMs` already means the same thing between hands');
  // The ladder, same as `autoMs`: every rung after Manual reads for less time
  // than the one before it, which is the whole of how the row explains itself.
  const reads = PACE_LEVELS.map((l) => (l.trickReadScale == null ? Infinity : l.trickReadScale));
  for (let i = 1; i < reads.length; i++) {
    assert.ok(reads[i] < reads[i - 1],
      `${PACE_LEVELS[i].id} reads for ${reads[i]}×, no less than ${PACE_LEVELS[i - 1].id}'s`);
  }
});

// `quick` IS A SCALE OF 1 ON PURPOSE. Written as a duration it would be a second
// copy of READ_AFTER_LANDING_MS, kept in step by hand across two files; written
// as 1 it cannot drift, and "this rung's hold is the number it always was" stops
// being something to remember.
//
// AND `quick` IS NOT THE DEFAULT ANY MORE. This test said DEFAULT_PACE when it
// was written, because on 2026-09-11 the two were the same rung for a few hours;
// they are two different ideas and they are two assertions now. This one is
// about the historical number. The one below is about which rung ships.
test("the brisk rung's trick hold is today's number, structurally", () => {
  assert.strictEqual(paceLevel('quick').trickReadScale, 1);
  assert.strictEqual(trickHold('quick'), Math.max(700, 420 + READ_AFTER_LANDING_MS));
  assert.strictEqual(trickHold('quick'), 920);
});

// THE DEFAULT IS A DECISION, AND THIS IS THE WHOLE OF IT IN ONE PLACE.
//
// `quick` shipped from #150 until 2026-09-11, on a round-6 reading that was
// one-directional: nobody asked for a longer wait between hands and several
// asked for none. #176 recorded that as needing NEW EVIDENCE to reverse rather
// than symmetry with the trick beat, and the new evidence is Paul playing the
// merged build with the trick tap in it. Round 6 wanted a way OUT of a wait, not
// a clock; the tap is the way out, so the clock is no longer the price of it.
//
// SO THE SHIPPED RUNG IS THE ONE THAT WAITS FOR A PERSON AT BOTH BEATS, and the
// cost is thirteen taps a hand plus one. None of this is arithmetic that could
// drift — it is four facts about WHICH RUNG SHIPS, which is exactly why it is
// pinned: a default flipped back by a one-word edit passes every other test in
// this file about the rungs themselves.
test("the shipped default waits for a person at both beats, and one tap leaves it", () => {
  assert.strictEqual(DEFAULT_PACE, 'manual',
    'the shipped rung was flipped from `quick` to `manual` on 2026-09-11, on Paul\'s '
    + 'own playtest of the merged build; flipping it back is a decision, not an edit, '
    + 'and src/arcade/storage.js carries both sides of it');
  assert.strictEqual(SETTINGS_DEFAULTS.pace, 'manual',
    'the value on disk and the module default must be the same rung, or a fresh save '
    + 'plays at one while every unreadable value falls back to the other');
  assert.strictEqual(paceLevel(DEFAULT_PACE).autoMs, null,
    'no score sheet may deal itself at the shipped rung');
  assert.strictEqual(trickHold(DEFAULT_PACE), null,
    'no completed trick may be swept at the shipped rung: the four cards wait for a '
    + 'tap on the felt or for Enter/Space (src/ui/table.js, runTrickReveal)');
  // THE WAY OUT, which is what makes a table with no clock in it safe to ship:
  // the control #174 fixed, on the sheet the player is already looking at.
  assert.strictEqual(nextSummaryPace(DEFAULT_PACE), 'quick',
    'a default that never moves on its own needs the one mid-match door out of it to '
    + 'work on the very first tap; #174 is that door');
  // And the felt promises the tap at exactly the rung that needs it promised —
  // otherwise a first trick with no clock on it is a game that looks frozen.
  assert.match(read("src/ui/table.js"), /trickBeat\.waits \? `\$\{whose\} Tap to go on\.`/,
    'the status bar must offer the tap whenever the hold has no clock, which at the '
    + 'shipped rung is every trick of every hand');
});

// #176 records the six seconds as decided against, and the reasoning is worth
// keeping executable: a hand is READ once and thirteen tricks are WATCHED, so
// the sheet's number applied per trick is 78 seconds of pure waiting per hand.
test("no rung reads a trick for anything like the score sheet's wait", () => {
  for (const level of PACE_LEVELS) {
    if (level.autoMs == null) continue;
    const read = READ_AFTER_LANDING_MS * (level.trickReadScale ?? 0);
    assert.ok(read <= level.autoMs / 2,
      `${level.id} reads a trick for ${read}ms against ${level.autoMs}ms for a whole `
      + 'score sheet; thirteen tricks a hand is what makes that the wrong trade');
  }
  assert.ok(13 * trickHold('relaxed') < 13 * 1600,
    'the slowest rung must still keep a hand of tricks under about twenty seconds');
});

test("Instant keeps no reading time, and Manual keeps no clock", () => {
  assert.strictEqual(paceLevel('instant').trickReadScale, 0);
  assert.strictEqual(trickHold('instant', 420), 420,
    'Instant is the flight and nothing more — the card still has to land');
  assert.strictEqual(trickHold('manual', 420), null,
    'Manual means the four cards wait for a tap, the way its sheet waits for one');
});

// The tolerance `paceLevel` already has, asked about the new term: a saved rung
// from an older build has to land on a trick hold rather than on NaN.
test("an unknown saved rung paces a trick at the default", () => {
  assert.strictEqual(trickHold('glacial'), trickHold(DEFAULT_PACE));
  assert.strictEqual(trickHold(undefined), trickHold(DEFAULT_PACE));
  // BOTH OF THOSE ARE `null === null` NOW, which a function that returned
  // nothing at all would also pass. The substance is that the fallback resolves
  // to the shipped RUNG, which is what the two lines above were standing in for
  // while the default named a number.
  assert.strictEqual(paceLevel('glacial').id, DEFAULT_PACE);
  assert.strictEqual(paceLevel(undefined).id, DEFAULT_PACE);
});

// THE ONE PLACE THE FELT READS THE RUNG FOR A TRICK. table.js cannot be imported
// (it touches `document` at import time), so this is a grep: a plan built
// without a pace is a plan at the shipped rung, and the dial would silently
// govern hands only. That matters more since the shipped rung became `manual` —
// dropping the argument no longer means "everybody gets 920ms", it means
// everybody's tricks wait for a tap whatever they set the dial to.
test("the felt builds its trick plan with the player's rung and its own shared flag", () => {
  const table = read("src/ui/table.js");
  const call = table.match(/trickRevealPlan\(events, \{[\s\S]*?\}\) : null/);
  assert.ok(call, "afterMove must be the one place a trick reveal is planned");
  assert.match(call[0], /pace: currentPace\(\)\.id/,
    "without the rung the trick hold is the default for everybody, whatever dial "
    + "the player set");
  assert.match(call[0], /shared: !!session\?\.shared/,
    "without the shared flag an indefinite hold gates one device's queue while "
    + "three other players keep playing");

  // THE SAME TWO ARGUMENTS ONE BEAT LATER (#181). The round beat's plan needs
  // both for the same two reasons, and a call that dropped the shared flag here
  // would gate a shared device's queue on three taps rather than one.
  const round = table.match(/roundBeatPlan\(events, \{[\s\S]*?\}\) : null/);
  assert.ok(round, "afterMove must be the one place a round ending is planned");
  assert.match(round[0], /pace: currentPace\(\)\.id/,
    "without the rung the show is counted at the default for everybody, whatever "
    + "dial the player set");
  assert.match(round[0], /shared: !!session\?\.shared/,
    "without the shared flag a count with no clock on it stalls one device's queue "
    + "three times a hand while the other players keep playing");
});

// THE RUNG HAS TO BE READ WHERE IT IS WRITTEN, AND IT WAS NOT (#181). `settings`
// in table.js is a snapshot taken by `initTable` at boot and refreshed by
// `rerenderTable` — a resume, or an SDK settings change. The NEW-GAME SHEET is
// neither: it writes storage and deals. So picking Quick in the lobby left the
// table running at whatever rung the tab had booted on, for the whole match, and
// the only door that worked was the summary's own control, which writes the
// snapshot itself and therefore hid this everywhere anybody looked.
//
// FOUND BY TRYING TO WATCH QUICK COUNT ITSELF in a browser: a table dealt at
// Quick sat waiting for a tap, because the rung that reached the arithmetic was
// Manual. `botDriver`'s `difficulty` has read fresh since #91 for exactly this
// reason and says so in its own comment.
test("the pace is read from storage, not from a snapshot the lobby cannot refresh", () => {
  const src = read("src/ui/table.js");
  const fn = src.match(/function currentPace\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "currentPace must exist — it is the one place the felt asks for the rung");
  assert.match(fn[0], /loadSettings\(\)\.pace/,
    "the rung must be read fresh at the moment it is needed");
  assert.doesNotMatch(fn[0], /settings \?/,
    "reading the module snapshot first is the bug: the new-game sheet writes storage "
    + "and never touches that snapshot, so a rung picked in the lobby does not reach "
    + "the felt until the tab is reloaded");
});

test("an unknown rung runs the default schedule rather than no schedule", () => {
  const plan = roundBeatPlan(showEnd, { flightMs: 420, pace: 'glacial' });
  assert.strictEqual(plan.pace, DEFAULT_PACE);
  assert.strictEqual(plan.autoAdvanceMs, paceLevel(DEFAULT_PACE).autoMs);
  // "RATHER THAN NO SCHEDULE" is the half the two lines above stopped checking
  // when the default's `autoAdvanceMs` became null: a plan that had collapsed to
  // Instant also carries no wait. The beat itself has to still be there.
  assert.strictEqual(plan.instant, false,
    'an unreadable saved rung must not collapse the beat to no sheet at all');
  assert.strictEqual(plan.steps.length, 3,
    'a cribbage show still owes its three steps at the fallback rung');
});

/* ------------------------------------------------------------------ *
 * The wiring the tests above cannot import
 * ------------------------------------------------------------------ */

test("the new-game sheet builds its row from the shared list and hands it back", () => {
  const src = read("src/ui/newGame.js");
  assert.match(src, /import \{[^}]*PACE_LEVELS[^}]*\} from '\.\/pace\.js'/,
    "the sheet must render the shared list, or a fifth rung would be added to it twice");
  assert.match(src, /for \(const level of PACE_LEVELS\)/,
    "the sheet must iterate the list rather than hard-code four buttons");
  assert.match(src, /close\(\{[\s\S]*?pace,[\s\S]*?\}\)/,
    "the sheet must return the chosen rung, or the lobby has nothing to save");
});

test("the lobby saves the rung on the gesture that deals, and only then", () => {
  const src = read("src/ui/lobby.js");
  assert.match(src, /pace: pace \|\| settings\.pace/, "the lobby must persist the chosen rung");
  // Both doors into a new game, each checked BETWEEN its own askNewGame and its
  // own save — the same walk tests/difficulty.test.js does, for the same
  // reason: a guard that merely appears somewhere in the file does not bite.
  const sites = [...src.matchAll(/askNewGame\(manifest\)([\s\S]{0,240}?)rememberPreferences\(setup\)/g)];
  assert.strictEqual(sites.length, 2,
    `${sites.length} new-game path(s) save the answer; both the tile and the re-deal must`);
  for (const [, between] of sites) {
    assert.match(between, /if \(!setup\)/,
      "the save must sit AFTER that path's own backed-out check");
  }
});

// THE RULE THE BOTS DEPEND ON. `dismissRoundSummary` is the single door: it
// paints the deal and only then calls `scheduleNextTurn`. A timer that reached
// for `scheduleNextTurn` itself would let a bot play its first card into a felt
// still showing the last hand.
test("the auto-advance goes through the one door that deals", () => {
  const src = read("src/ui/table.js");
  const arm = src.match(/function armAutoAdvance\(ms\) \{[\s\S]*?\n\}/);
  assert.ok(arm, "armAutoAdvance must exist — it is the whole of the timed transition");
  assert.match(arm[0], /dismissRoundSummary\(\)/,
    "the timer must deal through dismissRoundSummary");
  assert.doesNotMatch(arm[0], /scheduleNextTurn/,
    "a timer that schedules a bot directly re-arms the table before the deal is on it");
  assert.match(arm[0], /if \(ms == null\) return/,
    "Manual must arm no timer at all, rather than one with a null delay");
  // A DELAY THAT IS NOT A WAIT CANNOT BE A COUNTDOWN (#174). `instant` never
  // opens a sheet — runRoundBeat dismisses through the door before
  // showRoundSummary is called — so a 0 arriving here can only be a bug, and
  // the bug it was is a summary that closed itself on the tick after the tap
  // that opened the pace control.
  assert.match(arm[0], /if \(!\(ms > 0\)\) return/,
    "a zero, negative or NaN delay must arm nothing; setTimeout(…, 0) here is a "
    + "sheet dismissing itself on the next tick, under the tap that just changed it");
  // The tap has to beat the clock, and the clock must not fire behind it.
  const door = src.match(/function dismissRoundSummary\(message\) \{[\s\S]*?\n\}/);
  assert.ok(door, "dismissRoundSummary is the door; it must still be here");
  assert.match(door[0], /cancelRoundBeat\(\)/,
    "dismissing the sheet must cancel the countdown that was about to dismiss it");
});

test("every round-ending timer is held on the session and cancelled with it", () => {
  const session = read("src/ui/session.js");
  for (const field of ['beatTimers', 'revealTimer', 'advanceTimer']) {
    assert.match(session, new RegExp(`${field}:`), `session must own ${field}`);
    assert.match(session.split('export function stopSession')[1], new RegExp(field),
      `stopSession must cancel ${field} — a timer left running is a table that keeps `
      + 'playing a match nobody is looking at');
  }
  const table = read("src/ui/table.js");
  assert.doesNotMatch(table, /\n  Arcade\.session\.setTimeout\(\(\) => \{\n    if \(myEpoch !== epoch \|\| !session\?\.roundBeat\)/,
    "the round beat must not schedule an unheld timer");
});

// THE BUG THIS PINS COST AN HOUR AND LOOKED LIKE NOTHING. `hidden` is an IDL
// property of HTMLElement; `#round-ring` is an `<svg>`, and SVGElement has no
// such property — so `ring.hidden = false` defines a JS expando and leaves the
// ATTRIBUTE (and `.deal-ring[hidden] { display: none }`) exactly where it was.
// The ring never drew, while `ring.hidden` read false, the dash array was
// right, the animation was running, and the computed display was `none`.
test("the ring is shown by attribute, because an <svg> has no .hidden", () => {
  const panels = read("src/ui/panels.js");
  assert.doesNotMatch(panels, /roundRing\.hidden\s*=/,
    "assigning .hidden on an SVGElement sets a JS expando and hides nothing");
  assert.match(panels, /el\.roundRing\.removeAttribute\('hidden'\)/);
  assert.match(panels, /el\.roundRing\.setAttribute\('hidden', ''\)/);
});

// THE SECOND BUG OF THE SAME FAMILY, and the same shape as the one above: the
// code that looks right measures the wrong box. `paintRoundPace` runs on the
// frame the overlay is unhidden, and the panel's entrance animation starts at
// `scale(0.96)` — a client rect read then is 96% of the button, while the svg's
// own layout box is full size. The dash array was 4% short of the real
// perimeter (327.5 against 342.3, measured), so the ring finished its countdown
// with a ~15px gap still open. `offsetWidth` is the layout border-box, which is
// the box the path is drawn in, and a transform does not touch it.
test("the ring's perimeter is measured in layout pixels, not through a transform", () => {
  const panels = read("src/ui/panels.js");
  const paint = panels.match(/export function paintRoundPace\(pace\) \{[\s\S]*?\n\}/);
  assert.ok(paint, "paintRoundPace must exist — it is what draws the countdown");
  assert.match(paint[0], /el\.roundContinue\.offsetWidth/,
    "the dash array must come from the untransformed layout box");
  assert.match(paint[0], /el\.roundContinue\.offsetHeight/);
  assert.doesNotMatch(paint[0], /roundContinue\.getBoundingClientRect\(\)/,
    "a client rect here is read mid-settle-in and comes back 4% short");
});

test("the panel offers the cycling control and refuses to swallow End match", () => {
  const panels = read("src/ui/panels.js");
  assert.match(panels, /roundPanel\.addEventListener\('click'/,
    "the whole sheet must be the deal target, not only the button");
  assert.match(panels, /closest\('#round-end-match, #round-pace, #round-continue'\)/,
    "End match and the pace control must opt out of tap-to-deal, and the Deal "
    + "button must not be handled twice");
  assert.match(panels, /el\.roundPace\.addEventListener\('click'/);
  const table = read("src/ui/table.js");
  assert.match(table, /onCyclePace: \(\) => cyclePace\(\)/,
    "the table must wire the control, or it is a button that does nothing");
  assert.match(table, /function cyclePace\(\)[\s\S]*?saveSettings\(/,
    "cycling must persist immediately — the point is changing it the moment you feel it");
  assert.match(table, /nextSummaryPace\(currentPace\(\)\.id\)/,
    "the summary's control must walk the summary's own cycle; the full list runs "
    + "through Instant, which is the rung that closes the sheet it is tapped on");
});

// No infinite animations, ever (cardstock#24). The ring is a countdown to a
// thing that happens once, so it runs once.
test("the countdown ring is one-shot and stops with the sheet", () => {
  const css = read("src/ui/table.css");
  // The SELECTOR appears twice — the animation, and the reduced-motion block's
  // override of it — so this pins the one that actually runs. The first draft
  // matched whichever came first in the file and passed on `animation: none`,
  // which is the gate agreeing with itself about nothing.
  const rule = css.match(/\.deal-ring--running \.deal-ring__fill \{\s*animation: deal-ring-fill[\s\S]*?\}/);
  assert.ok(rule, "the running ring needs a rule that actually animates");
  assert.match(rule[0], /animation-iteration-count: 1/,
    "an infinite ring is a battery leak with a progress bar on it");
  assert.doesNotMatch(rule[0], /infinite/);
  assert.match(css, /\.deal-ring--static \.deal-ring__fill \{[\s\S]*?stroke-dashoffset: 0/,
    "reduced motion needs the static ring");
  const panels = read("src/ui/panels.js");
  const hide = panels.match(/export function hideRoundSummary\(\) \{[\s\S]*?\n\}/);
  assert.match(hide[0], /deal-ring--running/,
    "the ring must stop animating when the sheet closes");
  assert.match(panels, /pace\.animate \? 'deal-ring--running' : 'deal-ring--static'/,
    "which treatment runs must be decided by the motion check, not by CSS alone");
  const table = read("src/ui/table.js");
  assert.match(table, /animate: motionAllowed\(\) && !powerSaving\(\)/,
    "reduced motion and the power saver take the animation; the timer is untouched");
  assert.match(table, /autoMs: level\.autoMs/,
    "the view handed to the panel must carry the rung's own duration");
});
