// Where the play narration pill goes, and how long it stands (#149).
//
// The banner sat at `top: 34%` of the WINDOW with `white-space: nowrap`, which
// is a number about the phone rather than about the table: on Thirteen at
// 375x812 that is 276px and the combination pile begins at 277px, so a sentence
// about four consecutive pairs was drawn across the four consecutive pairs.
//
// `bannerBand` is the arithmetic, pulled out of the DOM so it can be argued
// with here — src/ui/celebrations.js measures the three boxes and hands them
// over. THE FELTS BELOW ARE MEASURED, not invented: every number came off a
// headless Chrome probe of the real table (see IMPLEMENTATION_NOTES). The file
// ends with source gates, because a placement function nothing calls is a
// placement function that is green forever and moves nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bannerBand, createCelebrations, heldBeatLine,
  BANNER_HOLD_MS, BANNER_FADE_MS, TAP_TO_GO_ON, TRICK_BANNER_PRIORITY,
} from "../src/ui/celebrations.js";
import { ROOT } from "../tools/stage.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Declarations only. These rules carry long comments that quote the old ones. */
const declarations = (block) => block.replace(/\/\*[\s\S]*?\*\//g, "");

/** Real felts, measured at 375x812 and 1280x860 on the packs the issue names. */
const FELTS = {
  "thirteen@375": {
    seats: { top: 78, bottom: 186, height: 108 },
    middle: { top: 197, bottom: 480, height: 283 },
    piles: { top: 277, bottom: 401, height: 123 },
    hand: { top: 580, bottom: 769, height: 188 },
  },
  "thirteen@1280": {
    seats: { top: 84, bottom: 192, height: 108 },
    middle: { top: 208, bottom: 540, height: 332 },
    piles: { top: 294, bottom: 454, height: 160 },
    hand: { top: 689, bottom: 811, height: 123 },
  },
  // The tight one: 37px of felt between the opponent row and the trick.
  "hearts@375": {
    seats: { top: 78, bottom: 208, height: 130 },
    middle: { top: 219, bottom: 370, height: 150 },
    piles: { top: 245, bottom: 344, height: 99 },
    hand: { top: 580, bottom: 769, height: 188 },
  },
  "hearts@1280": {
    seats: { top: 84, bottom: 214, height: 130 },
    middle: { top: 230, bottom: 496, height: 267 },
    piles: { top: 283, bottom: 443, height: 160 },
    hand: { top: 689, bottom: 811, height: 123 },
  },
};

/** Pill heights as the stylesheet draws them: one line, two lines, and tight. */
const ONE_LINE = 38;
const TWO_LINES = 58;
const TIGHT = 27;

/** showBanner's two passes: measure as it wrapped, shrink to one line if asked. */
function place(felt, natural) {
  let band = bannerBand(felt, natural);
  let height = natural;
  if (!band.fits) {
    height = TIGHT;
    band = bannerBand(felt, height);
  }
  return { top: band.top - height / 2, bottom: band.top + height / 2, tight: height === TIGHT };
}

test("the pill never covers a rank corner in the centre piles", () => {
  // The acceptance criterion, as arithmetic: the banner's rect and the piles'
  // rect do not intersect, at either viewport, for a sentence of either length.
  for (const [what, felt] of Object.entries(FELTS)) {
    for (const natural of [ONE_LINE, TWO_LINES]) {
      const box = place(felt, natural);
      assert.ok(box.bottom <= felt.piles.top,
        `${what} (${natural}px pill): the banner ends at ${box.bottom} and the piles `
        + `start at ${felt.piles.top}`);
    }
  }
});

test("the hand is sacred: the pill only ever looks up", () => {
  for (const [what, felt] of Object.entries(FELTS)) {
    for (const natural of [ONE_LINE, TWO_LINES]) {
      const box = place(felt, natural);
      assert.ok(box.bottom < felt.hand.top, `${what}: the banner reached the fan`);
      assert.ok(box.top >= 0, `${what}: the banner went off the top of the window`);
    }
  }
});

test("a band with room centres the pill in it, clear of both edges", () => {
  // Thirteen has 91px between the row and the pile on a phone and 102px on a
  // desktop — room for two lines, which is what the wrap is for.
  for (const what of ["thirteen@375", "thirteen@1280"]) {
    const felt = FELTS[what];
    const box = place(felt, TWO_LINES);
    assert.strictEqual(box.tight, false, `${what} shrank a sentence that fitted`);
    assert.ok(box.top > felt.seats.bottom, `${what}: the banner overlapped the seat row`);
    const above = box.top - felt.seats.bottom;
    const below = felt.piles.top - box.bottom;
    assert.ok(Math.abs(above - below) < 1, `${what}: centred badly (${above} vs ${below})`);
  }
});

test("a band too small for the sentence shrinks it rather than overlapping", () => {
  // Hearts at 375x812 is the case the fallback exists for: 37px of band, and a
  // two-line pill is 58. It comes down to one line and still clears the trick.
  const felt = FELTS["hearts@375"];
  const box = place(felt, TWO_LINES);
  assert.strictEqual(box.tight, true, "the pill stayed at full height in a 37px band");
  assert.strictEqual(bannerBand(felt, TWO_LINES).fits, false,
    "a 58px pill was reported as fitting a 37px band");
  // 37px is not quite 27 plus clearance on both sides, so this one is placed by
  // the fallback rather than centred — and it still lands inside the band.
  assert.ok(box.bottom <= felt.piles.top, `the tight pill ended at ${box.bottom}`);
  assert.ok(box.top >= felt.seats.bottom, `the tight pill started at ${box.top}`);
});

test("a felt with no opponent row or no piles still gets a placement", () => {
  // Every box is optional: a hidden row measures 0x0, and a two-player felt or
  // a pack with an empty middle must not land the pill at NaN.
  const felt = FELTS["thirteen@375"];
  for (const missing of ["seats", "middle", "piles", "hand"]) {
    const band = bannerBand({ ...felt, [missing]: null }, ONE_LINE);
    assert.ok(Number.isFinite(band.top), `no ${missing} produced ${band.top}`);
    assert.ok(band.top > 0, `no ${missing} put the banner at ${band.top}`);
  }
  const bare = bannerBand({ seats: null, middle: null, piles: null, hand: null }, ONE_LINE);
  assert.ok(Number.isFinite(bare.top), "an empty felt produced no placement");
  // A zero-height box is a box that is not on this felt (#table-contract when
  // the pack declares no contract), not a box at y=0.
  const hidden = bannerBand({ ...felt, seats: { top: 0, bottom: 0, height: 0 } }, ONE_LINE);
  assert.strictEqual(hidden.top, bannerBand({ ...felt, seats: null }, ONE_LINE).top);
});

/* ------------------------------------------------------------------ *
 * Source gates: the placement is wired, and the hold is one number
 * ------------------------------------------------------------------ */

/**
 * One banner keyframe set's transform frames, read in units of the pill's own
 * height with `--banner-top` as the origin.
 *
 * `translate(-50%, ty)` puts the box at [ty, ty + 1] and `scale(s)` then works
 * about that box's centre. Resting is ty = -0.5, s = 1 — the rect [-0.5, +0.5]
 * that `bannerBand` actually placed.
 */
function transformFrames(css, name) {
  const block = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css);
  assert.ok(block, `no ${name} keyframes in src/ui/table.css`);
  const seen = [];
  const re = /(\d+)% \{[^}]*?transform: translate\(-50%,\s*(-?[\d.]+)%\)\s*scale\(([\d.]+)\)/g;
  for (let m; (m = re.exec(block[1])); ) {
    const [, at, yPct, scale] = m;
    const ty = Number(yPct) / 100;
    const s = Number(scale);
    const centre = ty + 0.5;
    seen.push({ at: Number(at), ty, top: centre - 0.5 * s, bottom: centre + 0.5 * s });
  }
  return seen;
}

/** A measured band is only worth having if every frame of every pill stays in it. */
function assertInsideBand(seen, name) {
  // A little overshoot below the resting bottom is fine and a translation
  // downward is not. The pop to scale(1.05) reaches 0.025h under it: 1.5px on
  // the tallest pill the felt draws (68px, cribbage's hand score at 1280)
  // against BANNER_CLEARANCE's 6px.
  const MAX_OVERSHOOT = 0.03;
  for (const f of seen) {
    assert.ok(f.ty <= -0.5 + 1e-9,
      `${name} at ${f.at}% translates the pill to ${(f.ty * 100).toFixed(0)}%, below where it `
      + "was placed — that is the rise-off-the-table entrance that put it back on the cards");
    assert.ok(f.bottom <= 0.5 + MAX_OVERSHOOT + 1e-9,
      `${name} at ${f.at}% reaches ${f.bottom.toFixed(4)}h, past the resting 0.5h by more `
      + `than the ${MAX_OVERSHOOT}h of pop the clearance can absorb`);
  }
  // Upward is allowed — the gap under the seat row is chrome, not a card — but
  // only as far as bannerBand's clearance keeps free above a tight pill.
  const highest = Math.min(...seen.map((f) => f.top));
  assert.ok(highest >= -0.65,
    `${name} reaches ${highest.toFixed(4)}h above its resting top, more than the band keeps free`);
}

test("the entrance animation stays inside the band the placement reserved", () => {
  // A measured band is only worth having if the pill stays in it for every
  // frame it is on screen, and for a while it did not: `banner-in` opened on
  // `translate(-50%, -30%)`, a rise off the table that put the pill 0.125 of
  // its own height BELOW its resting bottom — 6px for a two-line sentence, 8.5
  // for cribbage's longest — and the felt probe caught three cribbage samples
  // grazing a rank corner by 1.4-3.4px after the placement itself came back
  // clean on all five packs.
  //
  // Read in units of the pill's own height, with --banner-top as the origin:
  // `translate(-50%, ty)` puts the box at [ty, ty + 1] and `scale(s)` then
  // works about that box's centre. Resting is ty = -0.5, s = 1 — the rect
  // [-0.5, +0.5] that bannerBand actually placed.
  //
  // A little overshoot below that is fine and a translation downward is not.
  // The 12% frame pops to scale(1.05), which reaches 0.025h under the resting
  // bottom: 1.5px on the tallest pill the felt draws (68px, cribbage's hand
  // score at 1280) against BANNER_CLEARANCE's 6px. The old 0% frame was a
  // different animal — 0.125h, and it grew with the sentence.
  const seen = transformFrames(read("src/ui/table.css"), "banner-in");
  assert.ok(seen.length >= 4, `only ${seen.length} transform frames parsed out of banner-in`);
  assertInsideBand(seen, "banner-in");
});

test("the held pill's own entrance and exit stay in the band too", () => {
  // `banner-enter` and `banner-leave` (#180) are the two ends of `banner-in`
  // cut out and given their own durations, so the pill can stand still in the
  // middle while a person takes as long as they like. Cut-and-renormalised is
  // exactly the edit that loses a constraint quietly, so they are held to the
  // same rule the entrance above is: every frame inside the rect bannerBand
  // reserved, with only the exit's drift up into the chrome under the seat row.
  const css = read("src/ui/table.css");
  const enter = transformFrames(css, "banner-enter");
  assert.strictEqual(enter.length, 3, `banner-enter parsed as ${enter.length} frames, not 3`);
  assertInsideBand(enter, "banner-enter");
  // It is an ARRIVAL and it ends arrived: the last frame is the resting rect,
  // because nothing runs after it and that frame is what the pill then holds.
  const rest = enter[enter.length - 1];
  assert.ok(Math.abs(rest.top + 0.5) < 1e-9 && Math.abs(rest.bottom - 0.5) < 1e-9,
    `banner-enter comes to rest at [${rest.top}, ${rest.bottom}]h rather than the placed rect — `
    + "the held pill would sit wherever the entrance happened to stop");
  const leave = transformFrames(css, "banner-leave");
  assert.strictEqual(leave.length, 2, `banner-leave parsed as ${leave.length} frames, not 2`);
  assertInsideBand(leave, "banner-leave");
});

test("the stylesheet takes its position from the measurement, not from 34%", () => {
  const css = read("src/ui/table.css");
  const block = /\n#event-banner \{([^}]*)\}/.exec(css);
  assert.ok(block, "no #event-banner block in src/ui/table.css");
  const rules = declarations(block[1]);
  assert.match(rules, /top:\s*var\(--banner-top/,
    "#event-banner is back on a fixed percentage of the window");
  assert.doesNotMatch(rules, /white-space:\s*nowrap/,
    "#event-banner cannot wrap again — a long sentence grows across the felt");
  assert.match(rules, /max-width:/, "#event-banner lost its width cap");
  const source = read("src/ui/celebrations.js");
  assert.match(source, /setProperty\('--banner-top'/,
    "nothing sets --banner-top, so the pill is wherever CSS last left it");
  assert.match(source, /bannerBand\(rects,/, "showBanner no longer measures the felt");
  // The floor is the highest CARD in the middle, not the box nominally holding
  // it: a trick is a fan of rotated copies and cribbage's sequence lives in
  // #table-zones, so both stick out above #center-piles' own rect.
  assert.match(source, /feltMiddle\.querySelectorAll\('\.card-face'\)/,
    "the banner's floor is back to a container's rect rather than the cards in it");
});

test("the hold is one number, spent by both the timer and the animation", () => {
  const css = read("src/ui/table.css");
  const rule = /\n\.event-banner--in \{([^}]*)\}/.exec(css);
  assert.ok(rule, "no .event-banner--in rule");
  const fallback = /var\(--banner-hold,\s*(\d+)ms\)/.exec(rule[1]);
  assert.ok(fallback, ".event-banner--in does not read --banner-hold");
  assert.strictEqual(Number(fallback[1]), BANNER_HOLD_MS,
    "the stylesheet's fallback hold and BANNER_HOLD_MS have drifted apart");
  assert.doesNotMatch(css, /animation:\s*banner-in\s+[\d.]/,
    "a literal duration is back on the banner's entrance");
  const source = read("src/ui/celebrations.js");
  assert.strictEqual((source.match(/\b2200\b/g) || []).length, 1,
    "the hold is written more than once in src/ui/celebrations.js");
  assert.match(source, /setProperty\('--banner-hold', `\$\{BANNER_HOLD_MS\}ms`\)/,
    "the stylesheet is no longer told what the hold is");
});

test("a move that says nothing takes the last sentence down", () => {
  // Inbox item 22: "on turns where I was leading a brand-new trick it still
  // read 'Fig passed' from three plays ago". celebrateAction returning null
  // used to leave the banner standing for the rest of its hold.
  const source = read("src/ui/celebrations.js");
  const body = /function celebrateAction\([\s\S]*?\n  \}/.exec(source);
  assert.ok(body, "celebrateAction is not where this test thinks it is");
  assert.match(body[0], /if \(!said\) \{\s*if \(floor < 0\) hideBanner\(session\);\s*return null;\s*\}/,
    "a silent move leaves the previous banner on the felt again");
  // ...unless the caller has just raised a trick's own pill for this move
  // (#151's floor): clearing then would wipe the trick banner, not a stale one.
  assert.doesNotMatch(body[0], /if \(!said\) \{ hideBanner\(session\); return null; \}/,
    "the stale-pill clear no longer spares a trick banner raised for the same move");
});

/* ------------------------------------------------------------------ *
 * A trick is two moments, not one (#180)
 * ------------------------------------------------------------------ *
 *
 * The banner naming the winner used to run with the gather, behind the hold's
 * `resume`. That was defensible while the hold was a fixed ~920ms and became
 * the main thing wrong with the beat as soon as the hold waited for a tap: the
 * player sat in front of four whole cards with nothing saying who had won them,
 * tapped, and the answer flashed past as the cards flew away.
 *
 * `createCelebrations` takes every node and every measurement as a parameter,
 * so the split itself can be driven from Node with a stubbed felt. WHEN each
 * half runs is src/ui/table.js's decision and table.js cannot be imported, so
 * that part is a source gate at the foot of this file.
 */

/** Every timer the celebrations buy, so a held banner's lack of one is visible. */
const timers = [];

globalThis.Arcade = {
  session: {
    setTimeout(fn, ms) {
      const t = { fn, ms, cancelled: false, cancel() { this.cancelled = true; } };
      timers.push(t);
      return t;
    },
  },
};

// `motionAllowed()` (src/ui/flight.js) reads `window`, and reduced motion is
// deliberately ON here so the gather stops at its measurement rather than
// reaching for a document this process does not have. Measuring the trick zone
// is the gather's first act and the one act of it a Node test can see.
globalThis.window = { matchMedia: () => ({ matches: true }) };

const NAMES = ["You", "Nell", "Ada", "Fig"];
/** Hearts' reading: points are the bill, so somebody else's trick is neutral. */
const STATE = { pack: { template: {}, scoring: { gameOver: { winner: "lowestScore" } } } };
const TRICK = { type: "trickWon", seat: 1, points: 3, cards: ["c1", "c2", "c3", "c4"] };
const TRICK_SAID = "Nell takes the trick (+3)";

class FakeEl {
  constructor(rect) {
    this._classes = new Set();
    this.hidden = true;
    this.textContent = "";
    this._rect = rect;
    this.style = {
      props: new Map(),
      setProperty(k, v) { this.props.set(k, v); },
      removeProperty(k) { this.props.delete(k); },
    };
  }
  get className() { return [...this._classes].join(" "); }
  // Assigning the whole string replaces the list, exactly as the DOM does —
  // which is what clears `--held` and `--out` off the pill a banner replaces.
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._classes;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      contains: (c) => s.has(c),
    };
  }
  getBoundingClientRect() { return this._rect; }
}

function stubFelt() {
  timers.length = 0;
  const calls = { pulses: [], zones: [] };
  const banner = new FakeEl({ top: 0, bottom: ONE_LINE, height: ONE_LINE });
  const log = new FakeEl({ top: 0, bottom: 0, height: 0 });
  const session = { bannerTimer: null, bannerHeld: false };
  const moments = createCelebrations({
    me: { holds: (seat) => seat === 0, seat: () => 0 },
    seatLabel: (seat) => NAMES[seat],
    seatPossessive: (seat) => (seat === 0 ? "Your" : `${NAMES[seat]}'s`),
    currentEpoch: () => 1,
    // Every box null: a felt with no measurable row or pile still places a
    // pill (the test above says so), and the placement is not what is on trial.
    el: {
      eventBanner: banner, log, table: null,
      opponentsTop: null, feltMiddle: null, centerPiles: null, handRow: null,
    },
    art: () => ({ face: () => ({}), back: () => ({}), theme: { palette: {} } }),
    zoneRect: (name) => { calls.zones.push(name); return { left: 0, top: 0, width: 60, height: 90 }; },
    seatRect: () => ({ left: 200, top: 0, width: 60, height: 90 }),
    pulseSeat: (seat, tone) => calls.pulses.push({ seat, tone }),
    cardById: (_state, id) => ({ id }),
  });
  return { moments, session, banner, log, calls };
}

test("the announcement is the whole statement, and the gather is none of it", () => {
  const { moments, session, banner, log, calls } = stubFelt();
  moments.announceTrick(session, STATE, TRICK, { held: true });
  assert.strictEqual(banner.hidden, false, "the hold opened with no banner on it");
  assert.strictEqual(banner.textContent, TRICK_SAID,
    "the banner does not name the winner at the moment the hold begins");
  assert.deepStrictEqual(calls.pulses, [{ seat: 1, tone: "good" }],
    "the winner's seat did not pulse with the announcement");
  assert.deepStrictEqual(calls.zones, [],
    "the announcement measured the trick zone — the sweep is running before the hold ends");

  moments.gatherTrick(STATE, TRICK);
  assert.deepStrictEqual(calls.zones, ["trick"],
    "the gather did not fly anything when the hold ended");
  assert.strictEqual(log.textContent, "",
    "gatherTrick writes the live region; the sentence belongs to the announcement");
});

test("the paths with no hold still announce and gather in the same breath", () => {
  // The multiplayer path, where the felt could not pose the trick, and the
  // Instant rung, whose hold is the fourth card's flight. Neither has a beat to
  // split over and neither may change: celebrateTrick is still both halves.
  const { moments, session, banner, log, calls } = stubFelt();
  moments.celebrateTrick(session, STATE, TRICK);
  assert.strictEqual(banner.textContent, TRICK_SAID);
  assert.strictEqual(log.textContent, TRICK_SAID, "the live region lost the trick's sentence");
  assert.deepStrictEqual(calls.zones, ["trick"], "the gather did not run with the announcement");
  assert.deepStrictEqual(calls.pulses, [{ seat: 1, tone: "good" }]);
  assert.strictEqual(session.bannerHeld, false,
    "a banner with no open-ended hold behind it was held open anyway");
  assert.strictEqual(session.bannerTimer.ms, BANNER_HOLD_MS,
    "the ordinary banner no longer dismisses itself on its own clock");
});

test("a held banner stands with no clock, and comes down with the cards", () => {
  const { moments, session, banner } = stubFelt();
  moments.announceTrick(session, STATE, TRICK, { held: true });
  assert.strictEqual(session.bannerHeld, true);
  assert.strictEqual(banner.hidden, false);
  assert.strictEqual(session.bannerTimer, null,
    "a banner held for a person armed a clock anyway — it would vanish mid-pause");
  assert.strictEqual(timers.length, 0,
    `${timers.length} timers were bought by a hold whose only end is a tap`);
  // A HELD STATE, NOT A LOOP (cardstock#24): the arrival, and then nothing.
  assert.ok(banner.classList.contains("event-banner--held"), "the held pill has no entrance");
  assert.ok(!banner.classList.contains("event-banner--in"),
    "the held pill is still on the self-dismissing entrance, which fades it out mid-hold");

  moments.releaseBanner(session);
  assert.strictEqual(banner.hidden, false,
    "the pill blinked out at the instant of the tap rather than leaving with the cards");
  assert.ok(banner.classList.contains("event-banner--out"), "the released pill has no exit");
  assert.ok(!banner.classList.contains("event-banner--held"));
  assert.ok(session.bannerTimer, "the exit has no clock, so the pill never comes down at all");
  assert.strictEqual(session.bannerTimer.ms, BANNER_FADE_MS);
  session.bannerTimer.fn();
  assert.strictEqual(banner.hidden, true, "the released pill stayed on the felt");
  assert.strictEqual(session.bannerHeld, false);
});

test("a release only ever takes down the banner it was given", () => {
  // The rungs that name a duration are untouched: their banner keeps its own
  // lifetime, and the tap or timer that ends the hold must not reach round and
  // cut it short.
  const { moments, session, banner } = stubFelt();
  moments.announceTrick(session, STATE, TRICK);
  assert.ok(banner.classList.contains("event-banner--in"));
  assert.strictEqual(session.bannerTimer.ms, BANNER_HOLD_MS);
  moments.releaseBanner(session);
  assert.strictEqual(session.bannerTimer.ms, BANNER_HOLD_MS,
    "ending a timed hold re-armed the banner's clock");
  assert.ok(!banner.classList.contains("event-banner--out"),
    "a timed rung's banner is now dismissed by the end of the hold instead of by its own clock");
  // And a felt with nothing held is a felt a stray release cannot touch.
  moments.hideBanner(session);
  moments.showBanner(session, "Spades are broken", "neutral");
  moments.releaseBanner(session);
  assert.strictEqual(banner.textContent, "Spades are broken");
  assert.ok(!banner.classList.contains("event-banner--out"));
});

test("a louder event still outranks a trick banner raised at the top of the hold", () => {
  // #151: the card that breaks a suit is very often the fourth card of a trick,
  // so the one banner that mattered was the one guaranteed to be suppressed.
  // Raising the trick's pill EARLIER in the same move must not change that —
  // and the louder pill must arrive with its own ordinary lifetime rather than
  // inheriting the indefinite one it replaced.
  const { moments, session, banner } = stubFelt();
  moments.announceTrick(session, STATE, TRICK, { held: true });
  const louder = [{
    type: "suitBroken",
    say: { text: "Spades are broken", tone: "neutral", priority: TRICK_BANNER_PRIORITY + 1 },
  }];
  const said = moments.celebrateAction(session, STATE, louder, { floor: TRICK_BANNER_PRIORITY });
  assert.strictEqual(said?.text, "Spades are broken", "the louder event was suppressed by the trick");
  assert.strictEqual(banner.textContent, "Spades are broken");
  assert.strictEqual(session.bannerHeld, false,
    "the louder banner inherited the trick pill's indefinite life");
  assert.strictEqual(session.bannerTimer.ms, BANNER_HOLD_MS);
  moments.releaseBanner(session);
  assert.strictEqual(banner.textContent, "Spades are broken",
    "the end of the hold took down a banner that was not the trick's");
});

test("everything at or below the trick's rung is still suppressed by it", () => {
  const { moments, session, banner } = stubFelt();
  moments.announceTrick(session, STATE, TRICK, { held: true });
  const quiet = [{ type: "reversed", say: { text: "Direction reversed", tone: "neutral" } }];
  assert.strictEqual(
    moments.celebrateAction(session, STATE, quiet, { floor: TRICK_BANNER_PRIORITY }), null,
    "an ordinary event overwrote the trick's banner",
  );
  assert.strictEqual(banner.textContent, TRICK_SAID);
  assert.strictEqual(session.bannerHeld, true,
    "a suppressed event took the hold down with it — the pill would now have no clock at all");
  // A move that narrates nothing still clears a STALE pill, which is the same
  // rule read from the other end (#149, inbox item 22).
  const fresh = stubFelt();
  fresh.moments.showBanner(fresh.session, "Fig passed", "neutral");
  assert.strictEqual(fresh.moments.celebrateAction(fresh.session, STATE, [], { floor: -1 }), null);
  assert.strictEqual(fresh.banner.hidden, true, "a silent move left a stale sentence standing");
});

test("the live region carries the winner and the way out in one write", () => {
  // #log is `role="status"` and both halves of an open-ended beat want it: the
  // hold has to say how to end a pause with no clock on it, and the
  // announcement wants to name the winner. Two writes in a frame is one
  // sentence announced and one lost, and the one at risk carries the way out.
  assert.strictEqual(heldBeatLine(TRICK_SAID), `${TRICK_SAID}. ${TAP_TO_GO_ON}`);
  assert.match(heldBeatLine(TRICK_SAID), /Nell/, "the live region does not name the winner");
  assert.match(heldBeatLine(TRICK_SAID), /Tap the table|press Enter/,
    "the live region does not say how to end the hold");
  // Half the narrations already carry an em dash, so the join is a full stop:
  // a sentence with two dashes in it parses as neither.
  assert.strictEqual(heldBeatLine("Trick is yours — 3 of your 5"),
    `Trick is yours — 3 of your 5. ${TAP_TO_GO_ON}`);
  // And it never doubles a stop the narration already ended with.
  assert.strictEqual(heldBeatLine("Trick is yours."), `Trick is yours. ${TAP_TO_GO_ON}`);
  // The bare possessive is the fallback the hold used before it had a narration
  // to fold in, and it still reads as the sentence that shipped.
  assert.strictEqual(heldBeatLine("Nell's trick"), `Nell's trick. ${TAP_TO_GO_ON}`);
  assert.strictEqual(heldBeatLine(""), TAP_TO_GO_ON);
  assert.strictEqual(heldBeatLine(null), TAP_TO_GO_ON);
});

test("the fade is one number too, and neither end of a held pill loops", () => {
  const css = read("src/ui/table.css");
  const held = /\n\.event-banner--held \{([^}]*)\}/.exec(css);
  const out = /\n\.event-banner--out \{([^}]*)\}/.exec(css);
  assert.ok(held, "no .event-banner--held rule — nothing holds a banner open for a person");
  assert.ok(out, "no .event-banner--out rule — nothing takes a held banner down");
  for (const [what, rules] of [["--held", held[1]], ["--out", out[1]]]) {
    const fallback = /var\(--banner-fade,\s*(\d+)ms\)/.exec(rules);
    assert.ok(fallback, `${what} does not read --banner-fade`);
    assert.strictEqual(Number(fallback[1]), BANNER_FADE_MS,
      `${what}'s fallback and BANNER_FADE_MS have drifted apart`);
    // cardstock#24: a held state is a static box, never a running loop.
    assert.doesNotMatch(rules, /infinite/,
      `${what} is an animation that never ends (cardstock#24 — use --arcade-pulse-count)`);
  }
  assert.doesNotMatch(css, /animation:\s*banner-(enter|leave)\s+[\d.]/,
    "a literal duration is on the held pill's entrance or exit");
  const source = read("src/ui/celebrations.js");
  assert.match(source, /setProperty\('--banner-fade', `\$\{BANNER_FADE_MS\}ms`\)/,
    "the stylesheet is never told what the fade is");
  assert.match(source, /BANNER_FADE_MS = Math\.round\(BANNER_HOLD_MS \*/,
    "the fade is a number of its own again rather than the hold's own end frames");
});

/* ------------------------------------------------------------------ *
 * Source gates: WHEN each half runs, which is table.js's decision
 * ------------------------------------------------------------------ */

/** runTrickReveal's body — table.js cannot be imported (see repo-gates.test.js). */
function trickReveal() {
  const body = /function runTrickReveal\([\s\S]*?\n\}/.exec(read("src/ui/table.js"));
  assert.ok(body, "runTrickReveal is not where this test thinks it is");
  return body[0];
}

test("the announcement runs as the hold opens, and nothing sweeps until it ends", () => {
  const body = trickReveal();
  const announced = body.indexOf("announce ? announce()");
  assert.ok(announced > 0, "runTrickReveal no longer makes the announcement at all");
  const openEnded = body.indexOf("if (reveal.holdMs == null)");
  const armed = body.indexOf("session.revealTimer = Arcade.session.setTimeout");
  assert.ok(announced < openEnded && announced < armed,
    "the announcement happens after the hold is set up rather than at the top of it — at a rung "
    + "that waits for a tap that is the whole bug: four cards and nothing saying who won them");
  assert.match(body, /releaseBanner\(\);\s*\n\s*resume\(\);/,
    "the held banner is not taken down when the hold ends, so it outlives the cards or never goes");
  assert.doesNotMatch(body, /gatherTrick|celebrateTrick/,
    "the sweep moved inside the hold — the gather is what the tap is asking for");
});

test("an open-ended hold writes the live region once, with both facts in it", () => {
  const open = /if \(reveal\.holdMs == null\) \{([\s\S]*?)\n  \}/.exec(trickReveal());
  assert.ok(open, "the open-ended branch is not where this test thinks it is");
  assert.strictEqual((open[1].match(/el\.log\.textContent =/g) || []).length, 1,
    "the open-ended hold writes #log more than once in a frame — one of the two sentences is "
    + "lost, and the one that carries the way out is the net for a pause with no clock on it");
  assert.match(open[1], /heldBeatLine\(/,
    "the live region's sentence is built somewhere other than heldBeatLine");
  assert.match(open[1], /said \? said\.text/,
    "the winner is not in the sentence the live region gets");
});

test("only a hold with reading time in it announces early", () => {
  const source = read("src/ui/table.js");
  assert.match(source, /const announce = \(trick && reveal\?\.reads\)/,
    "the announcement is no longer gated on the hold having reading time — Instant would name "
    + "the winner, and sound the cue, with the deciding card still in the air");
  assert.match(source, /if \(announce\) gatherTrick\(st, trick\);\s*\n\s*else celebrateTrick\(st, trick\);/,
    "a path with no early announcement no longer celebrates the whole trick at its resume");
  assert.strictEqual((source.match(/closeTrick\(/g) || []).length, 2,
    "the two resumes no longer both go through closeTrick");
  assert.doesNotMatch(source, /if \(trick\) celebrateTrick\(/,
    "a resume celebrates the whole trick itself again, so a held announcement is said twice");
  assert.strictEqual(
    (source.match(/runTrickReveal\(trickPose, move, from, reveal, \w+, announce\)/g) || []).length, 2,
    "the match-over resume and the ordinary one no longer both hand the reveal its announcement",
  );
});

test("the priority gate the settle passes is unchanged", () => {
  // #151's floor keys off a trick banner having fired for this move. It fires
  // EARLIER now; it is still the same move, so the same number goes in.
  assert.match(read("src/ui/table.js"),
    /celebrateAction\(shown, events, \{ floor: trick \? TRICK_BANNER_PRIORITY : -1 \}\)/,
    "the floor the settle passes celebrateAction has moved");
});

test("Instant's hold is the flight alone, and says so", () => {
  // `reads` is what keeps the announcement off the rung with no reading time.
  const source = read("src/ui/roundBeat.js");
  assert.match(source, /const reads = read == null \|\| read > 0;/,
    "trickRevealPlan no longer says whether its hold has reading time in it");
});
