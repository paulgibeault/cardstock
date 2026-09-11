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
import { bannerBand, BANNER_HOLD_MS } from "../src/ui/celebrations.js";
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
  const MAX_OVERSHOOT = 0.03;
  const css = read("src/ui/table.css");
  const frames = /@keyframes banner-in \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(frames, "no banner-in keyframes in src/ui/table.css");
  const seen = [];
  const re = /(\d+)% \{[^}]*?transform: translate\(-50%,\s*(-?[\d.]+)%\)\s*scale\(([\d.]+)\)/g;
  for (let m; (m = re.exec(frames[1])); ) {
    const [, at, yPct, scale] = m;
    const ty = Number(yPct) / 100;
    const s = Number(scale);
    const centre = ty + 0.5;
    seen.push({ at: Number(at), ty, top: centre - 0.5 * s, bottom: centre + 0.5 * s });
  }
  assert.ok(seen.length >= 4, `only ${seen.length} transform frames parsed out of banner-in`);
  for (const f of seen) {
    assert.ok(f.ty <= -0.5 + 1e-9,
      `banner-in at ${f.at}% translates the pill to ${(f.ty * 100).toFixed(0)}%, below where it `
      + "was placed — that is the rise-off-the-table entrance that put it back on the cards");
    assert.ok(f.bottom <= 0.5 + MAX_OVERSHOOT + 1e-9,
      `banner-in at ${f.at}% reaches ${f.bottom.toFixed(4)}h, past the resting 0.5h by more `
      + `than the ${MAX_OVERSHOOT}h of pop the clearance can absorb`);
  }
  // Upward is allowed — the gap under the seat row is chrome, not a card — but
  // only as far as bannerBand's clearance keeps free above a tight pill.
  const highest = Math.min(...seen.map((f) => f.top));
  assert.ok(highest >= -0.65,
    `banner-in reaches ${highest.toFixed(4)}h above its resting top, more than the band keeps free`);
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
  assert.match(body[0], /if \(!said\) \{ hideBanner\(session\); return null; \}/,
    "a silent move leaves the previous banner on the felt again");
});
