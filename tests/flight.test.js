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
  flightDurationMs, scrollCorrectedRect,
  FLIGHT_MS, FLIGHT_MIN_MS, FLIGHT_MAX_MS, SCROLL_SETTLE_MS,
} from "../src/ui/flight.js";

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
  // src/ui/table.js, and most of what that measures — the player's own hand,
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

/** What `animateMove` actually branches on, read out of the function itself. */
function animatedMoveTypes() {
  const source = fs.readFileSync(path.join(ROOT, "src/ui/table.js"), "utf8");
  const body = source.match(/function animateMove\([\s\S]*?\n}/);
  assert.ok(body, "animateMove has been renamed or removed");
  return new Set([...body[0].matchAll(/move\.type\s*[!=]==\s*['"]([A-Za-z]+)['"]/g)]
    .map((m) => m[1]));
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
};

test("every move type the source can build is either animated or deliberately not", () => {
  const animated = animatedMoveTypes();
  const unclassified = [];
  for (const [type, file] of moveTypesInSource()) {
    if (animated.has(type) || Object.hasOwn(NOT_ANIMATED, type)) continue;
    unclassified.push(`${type} (first built in ${file})`);
  }
  assert.deepStrictEqual(unclassified, [],
    "animateMove (src/ui/table.js) neither flies these nor is on record as "
    + "declining to. Give each one a branch, or an entry in NOT_ANIMATED saying "
    + "why the felt stays still — a move that silently animates nothing is how "
    + "a laid-down contract came to appear out of thin air.");
});

test("the lay-down is animated, which is the bug this gate was written for", () => {
  const animated = animatedMoveTypes();
  assert.ok(animated.has("layDown"),
    "a contract going down is the single biggest event in a Milestones round");
  // The four that were already there, so a refactor cannot quietly drop one.
  for (const type of ["draw", "hit", "playCard", "discard"]) {
    assert.ok(animated.has(type), `${type} lost its flight`);
  }
});

test("nothing is on both lists", () => {
  const animated = animatedMoveTypes();
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
