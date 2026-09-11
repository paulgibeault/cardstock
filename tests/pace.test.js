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
import { PACE_LEVELS, DEFAULT_PACE, paceLevel, nextPace } from "../src/ui/pace.js";
import { roundBeatPlan, SHOW_STEP_MS, MIN_HOLD_MS } from "../src/ui/roundBeat.js";
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

test("the shipped default is a rung that still shows the sheet", () => {
  assert.strictEqual(SETTINGS_DEFAULTS.pace, DEFAULT_PACE);
  assert.strictEqual(paceLevel(DEFAULT_PACE).id, 'quick');
  assert.strictEqual(paceLevel(DEFAULT_PACE).instant, false,
    "the default must not be the rung that trades the score sheet away");
  assert.ok(paceLevel(DEFAULT_PACE).autoMs >= 2000,
    "the default has to be long enough to read a four-seat score sheet");
});

// A saved setting is a string on disk and can be anything — an older build, a
// rung that was rolled back, a hand-edited save.
test("an unknown saved value falls back to the shipped default", () => {
  assert.strictEqual(paceLevel('glacial').id, SETTINGS_DEFAULTS.pace);
  assert.strictEqual(paceLevel(undefined).id, SETTINGS_DEFAULTS.pace);
  assert.strictEqual(paceLevel('manual').id, 'manual');
});

test("the summary's control cycles every rung and comes back round", () => {
  const seen = [];
  let id = 'manual';
  for (let i = 0; i < PACE_LEVELS.length; i++) {
    seen.push(id);
    id = nextPace(id);
  }
  assert.deepStrictEqual(seen, PACE_LEVELS.map((l) => l.id));
  assert.strictEqual(id, 'manual', "the cycle must wrap, or the last rung is a trap");
  assert.strictEqual(nextPace('nonsense'), 'instant',
    "a stale value cycles on from the default rather than sticking");
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
test("the summary still opens last, at every rung that opens one", () => {
  for (const id of ['manual', 'relaxed', 'quick']) {
    const plan = roundBeatPlan(showEnd, { flightMs: 420, pace: id });
    assert.ok(plan.summaryAt >= MIN_HOLD_MS, `${id}: the summary opened on the move itself`);
    for (const step of plan.steps) {
      assert.ok(plan.summaryAt > step.at,
        `${id}: summary at ${plan.summaryAt} must follow a step at ${step.at}`);
    }
  }
});

test("an unknown rung runs the default schedule rather than no schedule", () => {
  const plan = roundBeatPlan(showEnd, { flightMs: 420, pace: 'glacial' });
  assert.strictEqual(plan.pace, DEFAULT_PACE);
  assert.strictEqual(plan.autoAdvanceMs, paceLevel(DEFAULT_PACE).autoMs);
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
  const sites = [...src.matchAll(/askNewGame\(manifest\)([\s\S]{0,240}?)rememberDifficulty\(setup\)/g)];
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
