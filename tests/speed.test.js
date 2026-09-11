// HOW FAST A CARD CROSSES THE FELT (issue #175).
//
// The complaint was that cards flash past too fast to follow, and the setting
// that answers it — `botDelayMs` — existed the whole time with no control
// anywhere in the app. So the thing worth pinning is not the arithmetic, which
// did not change: it is the JOIN between the ladder and everything that has to
// be able to reach a rung. The number (src/ui/flight.js, untouched), the sheet
// that offers the rungs (src/ui/newGame.js), the lobby that saves the answer,
// the status bar that carries the in-match chip.
//
// AND THE LABELS, which is the one gate here that is not about wiring. Three
// segmented rows sit on one sheet — Opponents, Between hands, Card speed — and
// a rung called "Quick" in two of them is a row a player cannot read. That is a
// collision a future rename reintroduces silently, so it is asserted rather
// than remembered.
//
// PART GREP, FOR THE REASON tests/pace.test.js GIVES. newGame.js, lobby.js and
// table.js all touch `document` at import time, so no Node test can load them
// and ask what they render. The list and the arithmetic are the parts that CAN
// be imported, and what cannot is asserted the cheapest honest way instead.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import {
  SPEED_LEVELS, DEFAULT_SPEED, speedLevel, speedForDelay, nextSpeed, flightMsFor,
} from "../src/ui/speed.js";
import { flightDurationMs, FLIGHT_MS, FLIGHT_MIN_MS, FLIGHT_MAX_MS } from "../src/ui/flight.js";
import { SKILL_LEVELS } from "../src/ui/difficulty.js";
import { PACE_LEVELS } from "../src/ui/pace.js";
import { SETTINGS_DEFAULTS } from "../src/arcade/storage.js";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ------------------------------------------------------------------ *
 * The rungs themselves
 * ------------------------------------------------------------------ */

test("the four rungs are named, distinct, and ordered fastest to slowest", () => {
  assert.deepStrictEqual(SPEED_LEVELS.map((l) => l.id), ['snappy', 'brisk', 'gentle', 'slow']);
  const labels = SPEED_LEVELS.map((l) => l.label);
  assert.strictEqual(new Set(labels).size, labels.length, "two rungs share a label");
  for (const level of SPEED_LEVELS) {
    assert.ok(level.label && level.label !== level.id,
      `${level.id}: needs a player-facing label, not the stored id`);
    assert.ok((level.description || "").length > 20,
      `${level.id}: needs prose saying what a card does at it`);
  }
  // FASTEST FIRST IS LOAD-BEARING, not a presentation choice: the status bar's
  // chip cycles forward, and the player who taps it has just watched a card
  // they could not follow. Reverse this list and the first tap speeds the
  // table up, which is the complaint answered backwards.
  const delays = SPEED_LEVELS.map((l) => l.delayMs);
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] > delays[i - 1],
      `${SPEED_LEVELS[i].id} waits ${delays[i]}ms, no more than ${SPEED_LEVELS[i - 1].id}'s`);
  }
});

// THE WHOLE POINT OF THE DEFAULT: a player who never finds this control must
// not be able to tell it was added. 600 is SETTINGS_DEFAULTS.botDelayMs, it is
// a tread on the ladder rather than a value between two of them, and the
// flight it produces is flight.js's own unscaled FLIGHT_MS.
test("the shipped default rung is exactly today's 600ms, and changes nothing", () => {
  assert.strictEqual(speedLevel(DEFAULT_SPEED).delayMs, SETTINGS_DEFAULTS.botDelayMs);
  assert.strictEqual(speedLevel(DEFAULT_SPEED).delayMs, 600);
  assert.strictEqual(speedForDelay(SETTINGS_DEFAULTS.botDelayMs).id, DEFAULT_SPEED,
    "the stored default must read back as the default rung, or the chip opens lying");
  assert.strictEqual(flightMsFor(speedLevel(DEFAULT_SPEED)), FLIGHT_MS,
    "the default rung must be the unscaled flight — anything else is a silent retune");
});

// THE NUMBERS THE ISSUE PROMISED, against the REAL function rather than a copy
// of its arithmetic. src/ui/speed.js deliberately stores no durations, so this
// is the only place the four are written down.
test("each rung flies for the duration it claims, end to end of the scale", () => {
  assert.deepStrictEqual(
    SPEED_LEVELS.map((l) => [l.delayMs, flightDurationMs(l.delayMs)]),
    [[350, 260], [600, 420], [850, 595], [1100, 700]],
  );
  assert.strictEqual(flightMsFor(SPEED_LEVELS[0]), FLIGHT_MIN_MS,
    "the fastest rung should land ON the floor the playtest set, not short of it");
  assert.strictEqual(flightMsFor(SPEED_LEVELS.at(-1)), FLIGHT_MAX_MS,
    "the slowest rung should land ON the ceiling, or the ladder stops short of the scale");
});

// THE ACCEPTANCE CRITERION, as arithmetic: "pick a slower rung and see the next
// bot card take visibly longer to cross the felt". Every step has to be a step,
// and the two either side of the default have to be steps a player can see.
test("a slower rung is always a longer flight, and the steps are visible ones", () => {
  const flights = SPEED_LEVELS.map(flightMsFor);
  for (let i = 1; i < flights.length; i++) {
    assert.ok(flights[i] > flights[i - 1],
      `${SPEED_LEVELS[i].id} flies for ${flights[i]}ms, no longer than `
      + `${SPEED_LEVELS[i - 1].id}'s ${flights[i - 1]}ms — a rung you cannot feel is not a rung`);
  }
  const at = (id) => flightMsFor(speedLevel(id));
  const home = at(DEFAULT_SPEED);
  for (const id of ['snappy', 'gentle']) {
    const step = Math.abs(at(id) - home);
    assert.ok(step >= 100,
      `${id} is ${step}ms from the default's ${home}ms; the step either side of home `
      + "has to be one you can watch happen, or the first tap looks broken");
  }
});

// A saved setting is a number on disk and can be anything — an older build, a
// hand-edited save, a value typed into devtools. The three that `flightDurationMs`
// and `thinkTimeMs` both defend against have to land on the same rung they do.
test("nonsense out of storage lands on the shipped rung", () => {
  for (const value of [0, -5, NaN, Infinity, 'fast', null, undefined, {}]) {
    assert.strictEqual(speedForDelay(value).id, DEFAULT_SPEED,
      `${String(value)} is not a speed; it must read as the default, not as a rung`);
  }
  assert.strictEqual(speedLevel('glacial').id, DEFAULT_SPEED);
  assert.strictEqual(speedLevel(undefined).id, DEFAULT_SPEED);
  assert.strictEqual(speedLevel('slow').id, 'slow');
});

// A NUMBER OFF THE LADDER IS NOT NONSENSE. It is what storing milliseconds
// buys: a hand-edited 700 keeps playing at 700 and still lights a button.
test("an off-ladder value reads as the rung it is nearest", () => {
  assert.strictEqual(speedForDelay(700).id, 'brisk');
  assert.strictEqual(speedForDelay(900).id, 'gentle');
  assert.strictEqual(speedForDelay(1000).id, 'slow');
  assert.strictEqual(speedForDelay(9999).id, 'slow');
  assert.strictEqual(speedForDelay(1).id, 'snappy');
  assert.strictEqual(speedForDelay(475).id, 'snappy', "a tie goes to the faster rung");
});

test("the chip's tap cycles every rung and comes back round", () => {
  const seen = [];
  let id = SPEED_LEVELS[0].id;
  for (let i = 0; i < SPEED_LEVELS.length; i++) {
    seen.push(id);
    id = nextSpeed(id);
  }
  assert.deepStrictEqual(seen, SPEED_LEVELS.map((l) => l.id));
  assert.strictEqual(id, SPEED_LEVELS[0].id, "the cycle must wrap, or the last rung is a trap");
  // THE FIRST TAP FROM HOME MUST BE SLOWER. This is the acceptance criterion in
  // one line: a player on the default who taps the chip is asking for more time.
  assert.ok(flightMsFor(speedLevel(nextSpeed(DEFAULT_SPEED))) > flightMsFor(speedLevel(DEFAULT_SPEED)),
    "tapping the chip from the default speeds the table UP — the ladder is the wrong way round");
  assert.strictEqual(nextSpeed('glacial'), nextSpeed(DEFAULT_SPEED),
    "a stale value cycles on from the default rather than sticking");
});

/* ------------------------------------------------------------------ *
 * Three segmented rows on one sheet
 * ------------------------------------------------------------------ */

// A player reading the new-game sheet sees Opponents, Between hands and Card
// speed one under the other. Two rows offering a button with the same word on
// it is a sheet that cannot be read, and the way that happens is a rename
// nobody cross-checked — so it is checked here rather than remembered.
test("no rung label collides with the difficulty or pace row beside it", () => {
  const rows = [
    ['Opponents (src/ui/difficulty.js)', SKILL_LEVELS],
    ['Between hands (src/ui/pace.js)', PACE_LEVELS],
  ];
  const mine = new Map(SPEED_LEVELS.map((l) => [l.label.toLowerCase(), l.label]));
  for (const [name, levels] of rows) {
    for (const level of levels) {
      assert.ok(!mine.has(level.label.toLowerCase()),
        `"${level.label}" is a rung in ${name} AND in Card speed — one sheet, two rows, `
        + "one word, and no way for a player to tell which is which");
    }
  }
});

/* ------------------------------------------------------------------ *
 * The wiring the tests above cannot import
 * ------------------------------------------------------------------ */

test("the new-game sheet builds its row from the shared list and hands it back", () => {
  const src = read("src/ui/newGame.js");
  assert.match(src, /import \{[^}]*SPEED_LEVELS[^}]*\} from '\.\/speed\.js'/,
    "the sheet must render the shared list, or a fifth rung would be added to it twice");
  assert.match(src, /for \(const level of SPEED_LEVELS\)/,
    "the sheet must iterate the list rather than hard-code four buttons");
  assert.match(src, /speedForDelay\(loadSettings\(\)\.botDelayMs\)/,
    "the row must open showing the rung the game is actually playing at");
  assert.match(src, /close\(\{[\s\S]*?speed,[\s\S]*?\}\)/,
    "the sheet must return the chosen rung, or the lobby has nothing to save");
});

test("the lobby turns the rung into the number, on the gesture that deals", () => {
  const src = read("src/ui/lobby.js");
  assert.match(src, /botDelayMs: speed \? speedLevel\(speed\)\.delayMs : settings\.botDelayMs/,
    "the lobby must persist the rung's own millisecond value — the setting is a number, "
    + "and a rung id written to botDelayMs is a NaN in three pieces of arithmetic");
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

// THE SURFACE THE ISSUE IS ABOUT. #174 is the pace control that cannot be
// reached to change anything mid-match, because the sheet it lives on is
// counting down while you read it. This control's whole claim is that it is
// not on a timed surface, and the status bar is the only persistent in-match
// strip that qualifies.
test("index.html carries the chip, in the bar, with its own label element", () => {
  const html = read("index.html");
  const bar = html.match(/<div id="status-bar">[\s\S]*?\n    <\/div>/);
  assert.ok(bar, "#status-bar must still be one block — it is the only untimed in-match strip");
  assert.match(bar[0], /id="speed-chip"/,
    "the speed control must live IN the status bar, not merely somewhere in the page");
  assert.match(bar[0], /id="speed-chip-label"/,
    "the rung's word needs its own node, or painting it would wipe the glyph beside it");
  // The bar may never wrap (its own comment), and #status-text is the item that
  // gives. A fourth flexible item would let the bar choose which one ellipsises.
  const css = read("src/ui/table.css");
  const rule = css.match(/\n\.speed-chip \{[\s\S]*?\n\}/);
  assert.ok(rule, ".speed-chip must style itself — there is no #status-bar button rule to inherit");
  assert.match(rule[0], /flex: 0 0 auto/,
    "the chip must not flex; #status-text is the only item in this bar allowed to give");
  assert.match(rule[0], /white-space: nowrap/,
    "a chip that wraps pushes the felt down under the player's hand mid-turn");
  assert.doesNotMatch(css, /#status-bar button \{/,
    "see the NOTE in table.css: a blanket rule here repaints the score chip as a white box");
});

test("the chip cycles the rung, and the very next flight uses it", () => {
  const src = read("src/ui/table.js");
  assert.match(src, /el\.speedChip\.addEventListener\('click', \(\) => cycleSpeed\(\)\)/,
    "the chip must be wired, or it is a pill that does nothing");
  const cycle = src.match(/function cycleSpeed\(\) \{[\s\S]*?\n\}/);
  assert.ok(cycle, "cycleSpeed must exist — it is the whole of the in-match control");
  assert.match(cycle[0], /saveSettings\(/,
    "cycling must persist immediately — the setting outlives the match, like pace and difficulty");
  assert.match(cycle[0], /settings\.botDelayMs = level\.delayMs/,
    "the SNAPSHOT too (the precedent is cyclePace): every reader of this number reads "
    + "`settings`, so storage alone leaves the next flight at the old speed");
  assert.match(cycle[0], /el\.log\.textContent/,
    "the change must be announced — #log is the live region, and a chip's word changing "
    + "is nothing at all to a screen reader");
  // The chip has to agree with the felt it sits above, including after the
  // new-game sheet has changed the setting between two hands.
  assert.match(src, /function renderStatusBar\(state, acting\) \{[\s\S]*?paintSpeedChip\(\)/,
    "renderStatusBar must repaint the chip, or the sheet can leave it showing a stale rung");
  assert.match(src, /speedForDelay\(settings \? settings\.botDelayMs : loadSettings\(\)\.botDelayMs\)/,
    "the chip must read the same snapshot the flights do, with a fresh read as the fallback "
    + "for the first paint of a session");
});

// ONE SETTING, and the decision that says so (#175, decided rather than found).
// Splitting watching speed from thinking speed would mean a second key, and the
// argument against it is already written in src/ui/flight.js.
test("there is still exactly one stored number behind card speed", () => {
  const storage = read("src/arcade/storage.js");
  assert.match(storage, /botDelayMs: 600,/, "the key and its default must not have moved");
  assert.match(storage, /src\/ui\/speed\.js/,
    "the setting's comment must point at the module that now gives it a control — it "
    + "spent its whole life documented as having none");
  for (const key of ['flightMs', 'cardSpeed', 'flightDelayMs', 'watchMs']) {
    assert.ok(!new RegExp(`\\b${key}\\b`).test(storage),
      `${key}: card speed is ONE setting. A second key would let think time and flight `
      + "drift apart, which is exactly what flight.js argues against");
  }
  // And the arithmetic itself is untouched: the rungs are inputs to it.
  const flight = read("src/ui/flight.js");
  assert.match(flight, /const scale = \(Number\(botDelayMs\) \|\| 600\) \/ 600;/,
    "the flight arithmetic is not this issue's to change — the rungs feed it");
  assert.ok(!/speed\.js/.test(flight),
    "flight.js must not learn the ladder exists; speed.js imports IT, not the other way round");
});
