// WHAT A SEAT PLATE SAYS, AND WHICH WAY THE ROW STILL GOES (#133, items 49/53).
//
// Two round-5 findings that share one file. An opponent's plate drew its score,
// hand count, bid and meld as bare digits — `Bruno 0 12 150 —` — whose only
// name was an `aria-label` nobody sighted ever hears; and the seat carousel
// scrolls at 375px with nothing on the felt saying so, the second plate simply
// cut dead at the edge.
//
// `src/ui/table.js` resolves its element table on its first line and cannot be
// loaded by `node --test`, which is the standing reason this file is half
// RUNTIME (the templates' own answers, which are pure) and half SOURCE GATES
// (the call sites that draw them). The felt itself was verified in a browser at
// 375x812 and 1280x860 — see IMPLEMENTATION_NOTES.md; these are what stop it
// regressing into a row of anonymous numbers again.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk, listPackIds } from "../tools/pack-test.mjs";
import { ROOT } from "../tools/stage.mjs";
import { defaultScoreChip } from "../src/ui/seatRing.js";

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
/** Comment lines stripped, so a gate cannot be satisfied by prose about it. */
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/* ------------------------------------------------------------------ *
 * The word under the number
 * ------------------------------------------------------------------ */

test("every counter every shipped pack declares carries a label", async () => {
  let checked = 0;
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    if (!pack.template.seatCounters) continue;
    const seats = Math.max(2, Math.min(4, pack.manifest.players.max));
    const state = createState({ pack, seats, seed: `plate:${packId}` });
    pack.template.setup(makeCtx(state));
    for (let seat = 0; seat < seats; seat++) {
      const counters = pack.template.seatCounters(makeCtx(state), seat) || [];
      for (const counter of counters) {
        checked++;
        assert.strictEqual(typeof counter.label, "string",
          `${packId} seat ${seat}: a counter reading "${counter.text}" has no label — `
          + "on an open plate that is a bare number with no word under it (#133)");
        assert.ok(counter.label.trim().length > 0,
          `${packId} seat ${seat}: a counter's label is blank`);
        // One short noun. The caption is 0.48rem under a 0.7rem number and a
        // phrase there wraps the badge into two lines and moves the row.
        assert.ok(counter.label.length <= 12,
          `${packId}: "${counter.label}" is too long for a caption under a badge`);
      }
    }
  }
  // AN EMPTY SWEEP IS A FAILURE, NOT A PASS: a renamed hook would otherwise
  // leave every `continue` above taken and this test green over nothing.
  assert.ok(checked >= 9,
    `only ${checked} counters were examined — the sweep found nothing to check`);
});

test("the platform's own fallbacks are labelled too", async () => {
  // The score chip's default is pure and importable; assert it directly.
  const pack = await loadPackFromDisk("hearts");
  const chip = defaultScoreChip(pack, 4, [0, 0, 0, 0], 1);
  assert.strictEqual(chip.label, "Score",
    "defaultScoreChip draws the plate's caption — without one the pill is a bare number");

  // The hand-count fallback lives inside the file no test can import, so this
  // half is a source gate on the literal itself.
  const table = code(read("src/ui/table.js"));
  assert.match(table,
    /\[\{ text: String\(count\), aria: cardsPhrase\(count\), label: 'Cards' \}\]/,
    "seatCountersFor's default counter has lost its label — the packs that declare "
    + "no counters are exactly the ones whose digit has least else to explain it");
});

test("a template that races something other than points names it", async () => {
  // Contract rummy's chip is a CONTRACT reached, not a score, and captioning it
  // SCORE says the wrong thing under "Ph 1".
  const pack = await loadPackFromDisk("milestones");
  const state = createState({ pack, seats: 4, seed: "plate:milestones" });
  pack.template.setup(makeCtx(state));
  const chip = pack.template.scoreChip(makeCtx(state), 1);
  assert.ok(chip, "milestones no longer declares a score chip");
  assert.strictEqual(chip.label, "Contract");
  assert.match(chip.short, /^Ph /);
});

/* ------------------------------------------------------------------ *
 * SOURCE GATES — a label nobody draws is a label nobody reads
 * ------------------------------------------------------------------ */

test("the seat row actually draws the caption it asks templates for", () => {
  const table = code(read("src/ui/table.js"));
  // The builder: value first, then the word, and ONE accessible name over the
  // pair — role="img" is what stops a reader saying "12, cards, 12 cards".
  assert.match(table, /line\('seat__count-value', text\)/,
    "the badge no longer draws its number through fillCounterBadge");
  assert.match(table, /line\('seat__count-label', label\)/,
    "the caption element is gone — the plate is back to bare numbers (#133)");
  // The CALL, not just the builder: deleting this one line left the first cut
  // of this gate green over a plate that had gone back to bare numbers.
  assert.match(table, /\n\s*if \(label\) badge\.appendChild\(counterCaption\(label\)\);/,
    "the caption is built and never appended — the plate is back to bare numbers");
  assert.match(table, /badge\.setAttribute\('role', 'img'\)/,
    "without a role the badge's aria-label is dropped by most screen readers");

  // The two call sites, whole statements: matching `fillCounterBadge(` alone
  // also matches the declaration, so deleting every CALL would leave this green.
  assert.match(table, /\n\s*fillCounterBadge\(badge, counter\.text, counter\.label, `\$\{counter\.aria\}\$\{says\}`\);/,
    "the counter loop is not passing the template's label through");
  assert.match(table, /\n\s*fillCounterBadge\(chip, short, label \|\| 'Score', aria\);/,
    "the score pill is not captioned, or has stopped honouring the chip's own word");
});

test("a minimized face keeps the bare number", () => {
  const css = read("src/ui/table.css");
  assert.match(css, /\.seat--collapsed \.seat__count-label \{\s*display: none;\s*\}/,
    "captions are showing on collapsed faces — there is no room for them there, and "
    + "the crowded-row ladder other packs rely on is measured on that width");
  assert.match(css, /\.seat__count-label \{[^}]*text-transform: uppercase;/,
    "the caption no longer matches the human's own chips (SCORE, CARDS, BID)");
});

/* ------------------------------------------------------------------ *
 * The edge that still has seats behind it
 * ------------------------------------------------------------------ */

test("the carousel says which way it still scrolls", () => {
  const table = code(read("src/ui/table.js"));
  // Both directions, and both gated on the row actually being a scroller —
  // a fade on a two-handed row would promise a player who is not there.
  assert.match(table, /row\.classList\.toggle\('opponent-row--more-left', scrolls && row\.scrollLeft > 1\)/,
    "the left edge no longer tracks the scroll position");
  assert.match(table, /row\.classList\.toggle\('opponent-row--more-right', scrolls && row\.scrollLeft < max - 1\)/,
    "the right edge no longer tracks the scroll position");
  assert.match(table, /const scrolls = row\.classList\.contains\('opponent-row--carousel'\) && max > 1;/,
    "the fade is no longer conditional on the row having somewhere to scroll to");

  // Three drivers, and each is a real hole without the others: the listener
  // follows the finger, the render catches a row that grew without being
  // scrolled, and the observer catches a resize that changed the length.
  assert.match(table, /addEventListener\('scroll', paintSeatRowEdges, \{ passive: true \}\)/,
    "nothing repaints the fade while the player scrolls");
  assert.match(table, /scrollActingSeatIntoView\(state, acting\);\n\s*paintSeatRowEdges\(\);/,
    "renderSeats no longer repaints the fade — a bot laying a meld lengthens the "
    + "row without firing a scroll event");
  assert.match(table, /\n\s*watchSeatRowEdges\(\);/,
    "the scroll listener is never installed");
});

test("the fade is a mask on the two edge classes and nothing else", () => {
  const css = read("src/ui/table.css");
  assert.match(css, /\.opponent-row--more-left,\n\.opponent-row--more-right \{[^}]*mask-image: linear-gradient\(to right,/,
    "the edge fade's mask is gone");
  assert.match(css, /\.opponent-row--more-left \{ --seat-fade-start: transparent; \}/,
    "the left edge no longer fades when there are seats behind it");
  assert.match(css, /\.opponent-row--more-right \{ --seat-fade-end: transparent; \}/,
    "the right edge no longer fades when there are seats ahead of it");
  // The mask must not be declared on the carousel itself: a row that fits would
  // then carry a paint layer and a soft edge saying it does not.
  assert.doesNotMatch(css, /\.opponent-row--carousel \{[^}]*mask-image/,
    "every carousel row is being masked, including the ones with nothing to scroll to");
  // Battery contract (cardstock#24): the fade is a state, never an animation.
  const block = /\.opponent-row--more-left,\n\.opponent-row--more-right \{([^}]*)\}/.exec(css);
  assert.ok(block, "no edge-fade block in src/ui/table.css");
  assert.doesNotMatch(block[1], /animation/,
    "the scroll affordance must not animate — no infinite animations (cardstock#24)");
});

/* ------------------------------------------------------------------ *
 * #148 — the drawn counter, and the plate that stopped claiming things
 * ------------------------------------------------------------------ *
 *
 * Both halves live in `src/ui/table.js`, which no Node test can import (it
 * resolves its element table on its first line), so both halves are source
 * gates on the call sites. The behaviour itself is pinned where it is pure:
 * tests/counterTrack.test.js for the row, tests/zoneBadge.test.js and
 * tests/spadesFelt.test.js for the chip.
 */

test("the seat row actually draws the pip row it asks templates for", () => {
  const table = code(read("src/ui/table.js"));
  // Named in the import, or the branch below is a ReferenceError at boot.
  assert.match(table, /import \{[^}]*renderCounterPips[^}]*\} from '\.\/counterTrack\.js';/,
    "the pip renderer is not imported — the counter loop cannot be drawing one");
  // The BRANCH, as a whole statement: matching `counterPips(` alone also
  // matches the import, so deleting the call would leave this green.
  assert.match(table, /\n\s*if \(counterPips\(counter\)\) \{\n\s*head\.appendChild\(renderCounterPips\(counter\)\);/,
    "the counter loop no longer draws a pip counter as pips — Spades' faces are "
    + "back to a bid digit and a trick digit (#148)");
});

test("the row honours openOnly, and the round summary asks past it", () => {
  const table = code(read("src/ui/table.js"));
  // The filter itself. Without it a minimized Spades face wears the bid digit,
  // the trick digit AND the pip row that says both of them.
  assert.match(table, /\n\s*\? list\.filter\(\(counter\) => !counter\.openOnly\)/,
    "seatCountersFor no longer drops openOnly counters from a minimized face");
  assert.match(table, /\n\s*: list\.filter\(\(counter\) => !counter\.minimizedOnly\);/,
    "seatCountersFor no longer drops minimizedOnly counters from an open seat");
  // ...and the one caller that wants neither face. `roundContractLines` reads
  // the bid and the trick count off this list to write "Bid 4, took 5"; asking
  // for the minimized face would hand it a list with both of them filtered out
  // and the sheet would lose the line without erroring.
  assert.match(table, /const counters = seatCountersFor\(finalState, seat, \{ all: true \}\);/,
    "the round summary is reading a FACE's counters — a Spades bid and its "
    + "trick count are openOnly, so its rows would quietly disappear");
  assert.match(table, /\n\s*if \(all\) return list;/,
    "`all` no longer returns the template's whole declaration");
});

test("an empty hidden pile draws no chip, and no empty strip either", () => {
  const table = code(read("src/ui/table.js"));
  assert.match(table, /\n\s*const chip = hiddenPileChip\(state, inst, pts\);\n\s*if \(!chip\) continue;/,
    "buildSeatBody is back to printing a pile's bare name on the plate — a Spades "
    + "seat that has taken nothing reads as having Won something (#148)");
  // The strip is not nothing: `.seat__zones` carries a top margin, so appending
  // an empty one makes every plate taller before the first trick than after it,
  // and the seat row's fit ladder is measured on that height.
  assert.match(table, /\n\s*if \(strip\.childElementCount\) into\.appendChild\(strip\);/,
    "an empty pile strip is still being appended");
});

test("the pip row is painted in both themes and never animates", () => {
  const css = read("src/ui/table.css");
  // Every tone, and the ring an unfilled pip is drawn as: fill is the signal,
  // colour is the reinforcement, so a row read without hue still says a number.
  for (const cls of ["taken", "bag", "broken"]) {
    assert.match(css, new RegExp(`\\.seat__pip--${cls} \\{[^}]*background:`),
      `the ${cls} pip has no fill of its own`);
  }
  assert.match(css, /\.seat__pip \{[^}]*border: 1px solid var\(--pip-edge\);/,
    "an unfilled pip has no ring, so an unmade trick is invisible rather than empty");
  // BOTH THEMES, not one plus a tint: the tokens are defined in each palette.
  const dark = /:root,\n\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(css);
  const light = /\[data-theme="light"\] \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(dark && light, "the two palettes are no longer where this gate looks");
  for (const [name, block] of [["dark", dark[1]], ["light", light[1]]]) {
    for (const token of ["--pip-edge", "--pip-bag"]) {
      assert.match(block, new RegExp(`${token}:`), `${token} is undefined in the ${name} palette`);
    }
  }
  // Battery contract (cardstock#24): a pip fills once and then sits still.
  const block = /\.seat__pip \{([^}]*)\}/.exec(css);
  assert.ok(block, "no .seat__pip block in src/ui/table.css");
  assert.doesNotMatch(block[1], /animation/,
    "a pip must not animate — no infinite animations (cardstock#24)");
  assert.match(css, /\.seat__pips\[data-dense="true"\] \{[^}]*--pip-size:/,
    "the dense row no longer shrinks its circles, so a bid of thirteen runs off the seat");
});
