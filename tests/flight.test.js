// CARDS IN FLIGHT — the arithmetic, and the vocabulary.
//
// src/ui/flight.js had no coverage at all, for the reason every DOM module in
// this repo has none: it is `getBoundingClientRect`, `element.animate` and a
// fixed layer, and no Node test can hold any of them. That is an argument for
// extracting the parts that are NOT rectangles, not an argument for testing
// nothing — the two bugs this file was written alongside were both invisible to
// a browser and obvious to a function:
//
//   - a card flying to the neighbour's plate, because the landing rect was
//     measured off a seat row that was still smooth-scrolling under it. The
//     correction is pure arithmetic over four numbers; the DOM half is three
//     lines that read a scrollLeft and a clock.
//   - a lay-down that was not animated AT ALL, because `animateMove` handled
//     four move types by name and returned for everything else. A hardcoded
//     list is exactly what nobody re-reads, so the gate below derives the move
//     vocabulary from the source that defines it and fails on a type that is
//     neither animated nor deliberately silent.

import { test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";

import {
  flightDurationMs, scrollCorrectedRect, motionAllowed,
  FLIGHT_MS, FLIGHT_MIN_MS, FLIGHT_MAX_MS, SCROLL_SETTLE_MS,
} from "../src/ui/flight.js";
import { installBrowser, flightTable } from "./fixtures/moveFlight.js";

/* ------------------------------------------------------------------ *
 * How long a card is in the air
 * ------------------------------------------------------------------ */

test("the default flight is the one a resting bot-speed setting asks for", () => {
  assert.equal(flightDurationMs(600), FLIGHT_MS);
  assert.equal(FLIGHT_MS, 420);
});

test("slower bots mean longer flights, up to the ceiling", () => {
  assert.equal(flightDurationMs(900), 630, "1.5x the delay is 1.5x the flight");
  assert.equal(flightDurationMs(1000), FLIGHT_MAX_MS, "700 exactly, on the nose");
  assert.equal(flightDurationMs(1200), FLIGHT_MAX_MS, "clamped, not 840");
  assert.equal(flightDurationMs(1e9), FLIGHT_MAX_MS,
    "no setting may leave a card in the air for a second and a half");
});

test("faster bots mean shorter flights, down to the floor", () => {
  assert.equal(flightDurationMs(500), 350);
  // 260 was the old unconditional default. It survives as the FLOOR because at
  // the fastest setting a longer flight would still be crossing the felt when
  // the next bot moves — two cards in the air is worse than one that is quick.
  assert.equal(FLIGHT_MIN_MS, 260);
  assert.equal(flightDurationMs(300), FLIGHT_MIN_MS, "clamped, not 210");
  assert.equal(flightDurationMs(1), FLIGHT_MIN_MS);
});

test("nonsense out of storage lands on the default rather than on a broken flight", () => {
  // This value comes off a save that a hand edit, an older build, or a failed
  // migration can leave in any shape at all. A NaN duration is a card that
  // never arrives; a negative one is a card that never leaves.
  for (const nonsense of [undefined, null, NaN, "slow", "", {}, [], true, 0, -100, -1e9]) {
    const ms = flightDurationMs(nonsense);
    assert.ok(Number.isFinite(ms), `${String(nonsense)} produced ${ms}`);
    assert.ok(ms >= FLIGHT_MIN_MS && ms <= FLIGHT_MAX_MS,
      `${String(nonsense)} produced ${ms}, outside [${FLIGHT_MIN_MS}, ${FLIGHT_MAX_MS}]`);
  }
  assert.equal(flightDurationMs(undefined), FLIGHT_MS, "absent reads as the default 600");
  assert.equal(flightDurationMs(0), FLIGHT_MS, "so does zero — same rule as thinkTimeMs");
  assert.equal(flightDurationMs(-100), FLIGHT_MIN_MS, "a negative delay is not a negative flight");
});

/* ------------------------------------------------------------------ *
 * Is motion allowed? — ONE answer
 * ------------------------------------------------------------------ *
 *
 * There used to be two. flight.js asked the SDK and the OS; the party confetti
 * (src/ui/party.js) asked `<html data-reduced-motion>` and the OS. A player who
 * turned reduced motion on in the LAUNCHER but not in the OS therefore got a
 * still emote burst and full card flight in the same match — the setting half
 * obeyed, which is worse than either answer on its own. `motionAllowed()` is
 * now the only reader of all three signals and party.js imports it.
 *
 * Each signal is exercised ALONE, with the other two explicitly permissive, so
 * a case that passes does so because the signal under test was read.
 */

/**
 * Run `fn` against a stubbed browser, then put the globals back as they were.
 *
 * `Arcade` goes on BOTH `window` and the global object because in a browser
 * those are the same object, and the SDK check reads it through each of them —
 * `window.Arcade` as the existence test, bare `Arcade` for the call. Stubbing
 * only one of the two is how the first draft of this helper made the SDK case
 * pass for the wrong reason: the bare read threw and the catch swallowed it.
 */
function withEnv({ reduceQuery = false, dataset = undefined, arcade = undefined }, fn) {
  const had = (k) => k in globalThis;
  const saved = { window: globalThis.window, document: globalThis.document, Arcade: globalThis.Arcade };
  const present = { window: had('window'), document: had('document'), Arcade: had('Arcade') };
  globalThis.window = { matchMedia: () => ({ matches: reduceQuery }) };
  globalThis.document = { documentElement: { dataset: dataset ?? {} } };
  if (arcade !== undefined) {
    globalThis.window.Arcade = arcade;
    globalThis.Arcade = arcade;
  } else {
    delete globalThis.Arcade;
  }
  try {
    return fn();
  } finally {
    for (const k of ['window', 'document', 'Arcade']) {
      if (present[k]) globalThis[k] = saved[k]; else delete globalThis[k];
    }
  }
}

test("nothing asking for less motion means cards fly", () => {
  assert.equal(withEnv({}, motionAllowed), true);
});

test("the launcher setting on <html> turns motion off on its own", () => {
  // THE BUG. The OS is happy, there is no SDK object to ask — a framed visit
  // where `data-reduced-motion` is all the game gets — and the player has still
  // said no to motion. party.js honoured this and flight.js did not.
  assert.equal(
    withEnv({ reduceQuery: false, dataset: { reducedMotion: 'true' } }, motionAllowed),
    false,
  );
});

test("the <html> attribute is read as a string, not as truthiness", () => {
  // `dataset` hands back strings. `'false'` is truthy in JS, so a check written
  // as `if (dataset.reducedMotion)` would freeze the table for every player the
  // SDK publishes the setting to, whichever way they set it.
  assert.equal(withEnv({ dataset: { reducedMotion: 'false' } }, motionAllowed), true);
  assert.equal(withEnv({ dataset: {} }, motionAllowed), true, "absent is not 'on'");
});

test("the SDK setting turns motion off on its own", () => {
  assert.equal(
    withEnv({ arcade: { settings: { reducedMotion: () => true } } }, motionAllowed),
    false,
  );
  assert.equal(
    withEnv({ arcade: { settings: { reducedMotion: () => false } } }, motionAllowed),
    true,
  );
});

test("the OS preference turns motion off on its own", () => {
  // The only signal a standalone `?pack=` visit has.
  assert.equal(withEnv({ reduceQuery: true }, motionAllowed), false);
});

test("an SDK with no reducedMotion setting is not a reason to freeze the table", () => {
  // An older launcher: `Arcade` exists, `settings.reducedMotion` does not, so
  // asking throws. Answering "no motion" there would strip animation from every
  // player on that build, none of whom asked for it.
  assert.equal(withEnv({ arcade: { settings: {} } }, motionAllowed), true);
  assert.equal(
    withEnv({ arcade: { settings: { reducedMotion() { throw new Error("gone"); } } } }, motionAllowed),
    true,
  );
});

test("party.js asks flight.js rather than keeping its own answer", () => {
  // The whole point of the fix, and the thing a future edit to `burst` would
  // undo silently: src/ui/party.js is a DOM module no Node test can import, so
  // the guard is on its source.
  const party = fs.readFileSync(path.join(ROOT, "src/ui/party.js"), "utf8");
  assert.match(party, /import \{ motionAllowed \} from '\.\/flight\.js'/,
    "party.js must import the one answer");
  assert.match(party, /const reduced = !motionAllowed\(\)/,
    "the emote burst must gate on it");
  assert.doesNotMatch(party, /prefers-reduced-motion|dataset\.reducedMotion/,
    "party.js must not read a reduced-motion signal for itself again");
});

test("flight.js is the only place in src/ui that reads a reduced-motion signal", () => {
  // Derived rather than listed: a new module that grows its own third answer is
  // exactly the kind of thing nobody re-reads a list to catch. CSS is excluded
  // — the SDK's kill-switch rule covers the launcher setting there for free,
  // and the `@media` blocks in table.css are the standalone fallback.
  const files = execSync("git ls-files src/ui", { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 10, `expected src/ui modules, got ${files.length}`);
  const offenders = files.filter((f) => f !== "src/ui/flight.js"
    && /prefers-reduced-motion:\s*reduce|dataset\.reducedMotion|settings\.reducedMotion\(\)/
      .test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, [],
    "these read reduced motion directly; import motionAllowed() from src/ui/flight.js instead");
});

/* ------------------------------------------------------------------ *
 * Aiming at where the seat WILL BE
 * ------------------------------------------------------------------ */

/** A rect in the shape getBoundingClientRect hands back. */
function rect(left, top = 100, width = 60, height = 84) {
  return { left, top, width, height };
}

/** The row mid-glide: heading for `left`, currently at `scrollLeft`. */
function pending(left, scrollLeft, elapsedMs = 120, holds = true) {
  return { left, scrollLeft, elapsedMs, holds };
}

test("a rect measured mid-scroll is moved to where the row is taking it", () => {
  // The measured case, from the rig: a one-seat scroll of 140px. The seat is
  // 140px further left by the time the row comes to rest, so a card aimed at
  // the uncorrected rect lands one whole seat over — a clean translation onto
  // the neighbour's plate, which is why the playtest read it as the card
  // changing hands rather than as a near miss.
  const corrected = scrollCorrectedRect(rect(500), pending(200, 60));
  assert.equal(corrected.left, 360);
  assert.equal(corrected.top, 100, "only the scrolling axis moves");
  assert.equal(corrected.width, 60);
  assert.equal(corrected.height, 84);
});

test("a row scrolling back the other way carries the seat the other way", () => {
  assert.equal(scrollCorrectedRect(rect(200), pending(40, 180)).left, 340);
});

test("with no scroll running, the rect is the rect", () => {
  const r = rect(500);
  assert.strictEqual(scrollCorrectedRect(r, null), r, "returned untouched, not copied");
  assert.strictEqual(scrollCorrectedRect(r, undefined), r);
});

test("a node outside the scrolling row is not corrected", () => {
  // The correction is applied by a general-purpose `liveRect` in
  // src/ui/moveFlight.js, and most of what that measures — the player's own hand,
  // the draw pile, the discard — is nowhere near the seat row. Shifting those
  // would be the same bug pointed at different furniture.
  const r = rect(500);
  assert.strictEqual(scrollCorrectedRect(r, pending(200, 60, 120, false)), r);
});

test("a stale pending scroll expires rather than displacing rects forever", () => {
  // THE TIME BOX. The stored target is a promise about a scroll this module
  // cannot observe: the player can grab the row and drag it elsewhere, a resize
  // can clamp it, a suspended frame can leave it half-way. Every one of those
  // makes the target a lie, and an uncapped lie moves every rect on the table
  // for the rest of the match.
  const r = rect(500);
  assert.equal(SCROLL_SETTLE_MS, 700);
  assert.equal(scrollCorrectedRect(r, pending(200, 60, SCROLL_SETTLE_MS)).left, 360,
    "still inside the box on the last millisecond");
  assert.strictEqual(scrollCorrectedRect(r, pending(200, 60, SCROLL_SETTLE_MS + 1)), r);
  assert.strictEqual(scrollCorrectedRect(r, pending(200, 60, 60000)), r);
});

test("a clock that ran backwards is not a scroll to reason about", () => {
  const r = rect(500);
  assert.strictEqual(scrollCorrectedRect(r, pending(200, 60, -1)), r);
  assert.strictEqual(scrollCorrectedRect(r, pending(200, 60, NaN)), r);
});

test("the correction annihilates itself as the scroll finishes", () => {
  // Nothing cancels the pending target when the row arrives, and nothing needs
  // to: `left` and `scrollLeft` converge, so the shift decays to zero on its
  // own. That is what makes the time box a backstop rather than the mechanism.
  const r = rect(500);
  assert.equal(scrollCorrectedRect(r, pending(200, 60)).left, 360, "just launched");
  assert.equal(scrollCorrectedRect(r, pending(200, 130)).left, 430, "half way");
  assert.strictEqual(scrollCorrectedRect(r, pending(200, 200)), r, "arrived");
});

test("nothing measurable stays nothing measurable", () => {
  // rectOf answers null for an unlaid-out or hidden node and every caller is
  // written for that; a correction that turned null into an object would put a
  // card-sized rect at the top-left corner of the screen.
  assert.strictEqual(scrollCorrectedRect(null, pending(200, 60)), null);
});

/* ------------------------------------------------------------------ *
 * Every move that can happen is a move the felt shows
 * ------------------------------------------------------------------ */

const tracked = execSync("git ls-files -z src", { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter((f) => f.endsWith(".js"));

/**
 * Every move type anything in src/ can construct.
 *
 * DERIVED, NOT LISTED. A gate whose expected set is typed out by hand is the
 * same false green this repo keeps finding: it passes on the day it is written
 * and says nothing ever after. A move literal is unmistakable — `actor` and
 * `type` adjacent in one object — and the templates are where the vocabulary
 * is actually defined (enumerateLegalMoves), with src/ui/interaction.js
 * dressing the same moves for the human.
 */
function moveTypesInSource() {
  const found = new Map();
  for (const file of tracked) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const literal = /\bactor:\s*[^,{}]+,\s*type:\s*['"]([A-Za-z]+)['"]/g;
    let match;
    while ((match = literal.exec(source)) !== null) {
      if (!found.has(match[1])) found.set(match[1], file);
    }
  }
  return found;
}

/**
 * The move types `animateMove` actually flies a card for, found by asking it.
 *
 * IT WAS A REGEX over the function's body in src/ui/table.js, which could not be
 * loaded here — so "animated" meant "named in a `move.type ===` comparison",
 * and a branch that compared the type and then flew nothing still counted.
 * src/ui/moveFlight.js takes its elements in (#223 seam 6), so each type is now
 * played on a table where everything a card could aim at exists
 * (tests/fixtures/moveFlight.js): a hand, an opponent's fan, a pile that takes a
 * play or a discard, and a meld holding the card. A type is animated when a copy
 * really left for somewhere. The lay-down's first card flies on a timer of 0,
 * so the drive waits one macrotask before it counts.
 */
async function animatedMoveTypes(types = moveTypesInSource().keys()) {
  const animated = new Set();
  for (const type of types) {
    const browser = installBrowser();
    try {
      const { flight, state } = flightTable({ meldGroups: { 1: [{ cards: ["m1"] }] } });
      const move = {
        type, actor: 1, cards: ["m1"], choice: { seat: 1, melds: [{ cards: ["m1"] }] },
      };
      flight.animateMove(state, move, rect(10));
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (browser.flights.length > 0) animated.add(type);
    } finally {
      browser.restore();
    }
  }
  return animated;
}

/**
 * The moves that deliberately do not fly a card, and why.
 *
 * A move belongs here because somebody decided it, not because nobody noticed
 * it. That is the whole point: `layDown` sat outside both sets for as long as
 * this gate did not exist, and a bot completing its contract dropped six cards
 * onto the felt between two frames.
 */
const NOT_ANIMATED = {
  // Nothing moves. The drawn card stays in the hand and the turn passes.
  pass: "no card changes zone",
  // Not a card move at all, and it never reaches animateMove: an announcement
  // goes through performAnnouncement, which deliberately skips afterMove so
  // that speaking cannot restart a bot's think time.
  announce: "an announcement moves no cards and bypasses afterMove entirely",
  challenge: "same path as announce; the penalty it causes IS animated, by "
    + "animatePenaltyDraw in src/ui/celebrations.js",
  // A KNOWN GAP, RECORDED RATHER THAN FORGOTTEN. Hearts' pass genuinely moves
  // three cards to another seat and would be worth flying. It is left out
  // because every seat passes at once and the cards land in hands nobody can
  // see, so the honest animation is four simultaneous fans and not one flight —
  // a different piece of work from the one this gate was added for.
  passCards: "simultaneous, into hidden hands — needs its own treatment, not a "
    + "single flight",
  // There is no card in a bid at all: a seat says a number and the turn moves
  // on. What the felt shows instead is the number itself, on the seat's own
  // badge (trick-taking's seatCounters) — so the still felt here is the whole
  // of the animation, not a gap in it.
  bid: "a number, not a card — nothing leaves any zone",
  // A declaration SHOWS cards and moves none of them: the meld is scored and
  // every card stays in the hand it was dealt to. There is no zone change to
  // fly, and the four seats commit at once — what the felt shows instead is the
  // points, on each seat's own badge (trick-taking's seatCounters).
  declareMeld: "a meld is scored, not laid down — no card leaves any zone",
};

test("every move type the source can build is either animated or deliberately not", async () => {
  const animated = await animatedMoveTypes();
  const unclassified = [];
  for (const [type, file] of moveTypesInSource()) {
    if (animated.has(type) || Object.hasOwn(NOT_ANIMATED, type)) continue;
    unclassified.push(`${type} (first built in ${file})`);
  }
  assert.deepStrictEqual(unclassified, [],
    "animateMove (src/ui/moveFlight.js) neither flies these nor is on record as "
    + "declining to. Give each one a branch, or an entry in NOT_ANIMATED saying "
    + "why the felt stays still — a move that silently animates nothing is how "
    + "a laid-down contract came to appear out of thin air.");
});

test("the lay-down is animated, which is the bug this gate was written for", async () => {
  const animated = await animatedMoveTypes(["layDown", "draw", "hit", "playCard", "discard"]);
  assert.ok(animated.has("layDown"),
    "a contract going down is the single biggest event in a Milestones round");
  // The four that were already there, so a refactor cannot quietly drop one.
  for (const type of ["draw", "hit", "playCard", "discard"]) {
    assert.ok(animated.has(type), `${type} lost its flight`);
  }
});

test("nothing is on both lists", async () => {
  const animated = await animatedMoveTypes();
  const both = Object.keys(NOT_ANIMATED).filter((type) => animated.has(type));
  assert.deepStrictEqual(both, [],
    "a move cannot both fly and be on record as not flying — the list has gone "
    + "stale against the code");
});

test("the source really does define moves this gate can find", () => {
  // The gate's own load-bearing assumption. If the move literals were ever
  // reshaped — built by a helper, spread from a constant — this scan would
  // quietly find nothing and pass forever while covering nothing at all.
  const types = moveTypesInSource();
  assert.ok(types.size >= 8,
    `only ${types.size} move types found; the scan has stopped matching how `
    + "moves are written");
  for (const expected of ["playCard", "discard", "draw", "layDown", "hit"]) {
    assert.ok(types.has(expected), `the scan no longer finds ${expected}`);
  }
});
