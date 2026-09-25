// WHAT A SEAT PLATE SAYS, AND WHICH WAY THE ROW STILL GOES (#133, items 49/53).
//
// Two round-5 findings that share one file. An opponent's plate drew its score,
// hand count, bid and meld as bare digits — `Bruno 0 12 150 —` — whose only
// name was an `aria-label` nobody sighted ever hears; and the seat carousel
// scrolls at 375px with nothing on the felt saying so, the second plate simply
// cut dead at the edge.
//
// `src/ui/table.js` resolves its element table on its first line and cannot be
// loaded by `node --test`, which WAS the standing reason this file was half
// RUNTIME (the templates' own answers, which are pure) and half SOURCE GATES
// (the call sites that draw them). #223 moved the row to src/ui/seatRow.js,
// which takes its elements as parameters — so the badge builder, the score pill
// and the two edge classes are now BUILT here, through a document stub small
// enough to read (the same one tests/counterTrack.test.js uses, and for the same
// reason). What is left as a source gate is only what lives inside
// `buildSeatRow` itself, which wants a whole row of real elements to run.
//
// The felt itself was verified in a browser at 375x812 and 1280x860 — see
// docs/notes/IMPLEMENTATION_NOTES.md; these are what stop it regressing into a
// row of anonymous numbers again.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk, listPackIds } from "../tools/pack-test.mjs";
import { ROOT } from "../tools/stage.mjs";
import { defaultScoreChip } from "../src/ui/seatRing.js";
import {
  createSeatRow, fillCounterBadge, seatCountersFor, seatScoreChip, directionBadge,
} from "../src/ui/seatRow.js";
import { buildUiModel } from "../src/ui/interaction.js";
import { tableCss } from "./fixtures/tableCss.js";

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
/** Comment lines stripped, so a gate cannot be satisfied by prose about it. */
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/**
 * The smallest document the seat's own builders can draw into: a span with a
 * class, some text, a few attributes and children. src/ui/dom.js's `line` reads
 * the global at CALL time, which is what makes this enough — the module itself
 * never touches `document` at import, and that is the whole point of the carve.
 */
function stubDocument() {
  const make = (tag) => ({
    tag,
    className: "",
    textContent: "",
    dataset: {},
    style: {},
    attrs: {},
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...kids) { this.children = kids; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
  });
  return { createElement: make };
}

/** Install the stub for the body of `fn`, and put the global back afterwards. */
function withStubDocument(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "document");
  const before = globalThis.document;
  globalThis.document = stubDocument();
  try {
    return fn(globalThis.document);
  } finally {
    if (had) globalThis.document = before;
    else delete globalThis.document;
  }
}

/** A child of `node` by class name, or undefined. */
const childByClass = (node, cls) => node.children.find((c) => c.className === cls);

/**
 * A row that answers the two questions paintSeatRowEdges asks it — how long it
 * is, how far along it is — and records the classes it is given.
 */
function stubEdgeRow({ scrollWidth, clientWidth, scrollLeft, carousel = true }) {
  const classes = new Set(carousel ? ["opponent-row", "opponent-row--carousel"] : ["opponent-row"]);
  const listeners = [];
  return {
    scrollWidth,
    clientWidth,
    scrollLeft,
    listeners,
    has: (cls) => classes.has(cls),
    classList: {
      contains: (cls) => classes.has(cls),
      toggle: (cls, on) => { if (on) classes.add(cls); else classes.delete(cls); },
    },
    addEventListener(type, handler, opts) { listeners.push({ type, handler, opts }); },
  };
}

/**
 * The seam holding that row and nothing else: the two edge classes are a
 * question about one element's length and scroll position, so handing it a
 * session, a state or the card art would only hide which of them it reads.
 */
const rowSeam = (row) => createSeatRow({ el: { opponentsTop: row } });

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

  // ...and the hand-count fallback, which used to be a source gate on the
  // literal because the function it is in could not be loaded (#223). Asked of
  // `seatCountersFor` itself now: a pack that declares no counters at all, which
  // is exactly the pack whose bare digit has least else to explain it.
  const plain = { pack: { template: {} }, zones: { count: () => 1 } };
  assert.deepStrictEqual(seatCountersFor(plain, 0, { minimized: false }),
    [{ text: "1", aria: "1 card", label: "Cards" }],
    "the default counter has lost its label, its number or its sentence");
  // "1 card", not "1 cards" — a seat holding one is the moment everybody watches.
  const many = { pack: { template: {} }, zones: { count: () => 13 } };
  assert.equal(seatCountersFor(many, 0, { minimized: true })[0].aria, "13 cards");
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

test("a badge is a number, the word for it, and ONE accessible name", () => {
  withStubDocument((doc) => {
    const badge = doc.createElement("span");
    fillCounterBadge(badge, "12", "Cards", "12 cards");

    // Value FIRST, then the word — the caption sits underneath, which is the
    // +29% the measurement bought over captions beside the digits.
    assert.deepEqual(badge.children.map((c) => c.className),
      ["seat__count-value", "seat__count-label"],
      "the plate is back to bare numbers (#133)");
    assert.equal(childByClass(badge, "seat__count-value").textContent, "12");
    assert.equal(childByClass(badge, "seat__count-label").textContent, "Cards");
    // role="img" is what stops a reader saying "12, cards, 12 cards": one name
    // over the pair, and the caption hidden behind it.
    assert.equal(badge.attrs.role, "img",
      "without a role the badge's aria-label is dropped by most screen readers");
    assert.equal(badge.attrs["aria-label"], "12 cards");
    assert.equal(childByClass(badge, "seat__count-label").attrs["aria-hidden"], "true");

    // A counter with no word gets no empty caption element to space it out.
    const bare = doc.createElement("span");
    fillCounterBadge(bare, "4", "", "4 tricks");
    assert.deepEqual(bare.children.map((c) => c.className), ["seat__count-value"]);
    // ...and rebuilding a badge replaces what was in it rather than appending.
    fillCounterBadge(bare, "5", "Tricks", "5 tricks");
    assert.deepEqual(bare.children.map((c) => c.className),
      ["seat__count-value", "seat__count-label"]);
  });
});

test("the score pill is captioned, and honours the chip's own word", async () => {
  // Milestones races a CONTRACT, not points, and captioning "Ph 1" with SCORE
  // says the wrong thing — so the pill's word is the chip's when it has one.
  const milestones = await loadPackFromDisk("milestones");
  const declared = createState({ pack: milestones, seats: 4, seed: "chip:milestones" });
  milestones.template.setup(makeCtx(declared));

  // Hearts declares no scoreChip, so the platform's default word is what shows.
  const hearts = await loadPackFromDisk("hearts");
  const plain = createState({ pack: hearts, seats: 4, seed: "chip:hearts" });
  hearts.template.setup(makeCtx(plain));

  withStubDocument(() => {
    const chip = seatScoreChip(declared, 1);
    assert.equal(chip.className, "seat__score");
    assert.equal(childByClass(chip, "seat__count-label").textContent, "Contract",
      "the score pill has stopped honouring the chip's own word");
    assert.match(childByClass(chip, "seat__count-value").textContent, /^Ph /);
    assert.equal(chip.attrs.role, "img");

    const fallback = seatScoreChip(plain, 1);
    assert.equal(childByClass(fallback, "seat__count-label").textContent, "Score",
      "a pack that declares no chip has lost the platform's own caption");
  });
});

test("the direction badge appears only once play has LEFT the pack's own way round", () => {
  withStubDocument(() => {
    // A pack that deals clockwise, going clockwise: nothing to say.
    const forward = { pack: { manifest: { rules: {} } }, direction: 1 };
    assert.equal(directionBadge(forward), null,
      "a table that has never reversed is wearing a badge saying it has (#122)");
    // Thirteen deals counter-clockwise from the first card and can never
    // reverse — the bug was a permanent badge on it.
    const thirteen = { pack: { manifest: { rules: { direction: "counterclockwise" } } }, direction: -1 };
    assert.equal(directionBadge(thirteen), null,
      "the badge is comparing against a sign again rather than against the pack");

    const reversed = directionBadge({ pack: { manifest: { rules: {} } }, direction: -1 });
    assert.ok(reversed, "a reverse landed and the badge did not appear");
    assert.equal(reversed.className, "direction-badge");
    assert.equal(reversed.attrs.role, "img",
      "an aria-label on a bare div has no role to attach to and is dropped");
    assert.match(reversed.attrs["aria-label"], /^Play has reversed/);
  });
});

// THE ONE HALF A SOURCE GATE IS STILL THE HONEST ANSWER TO: the counter loop
// lives inside `buildSeatRow`, which wants a whole row of laid-out elements. The
// builder it calls is driven above; this is that it is still CALLED, as a whole
// statement — matching `fillCounterBadge(` alone also matches the declaration.
test("the counter loop passes the template's label through", () => {
  const row = code(read("src/ui/seatRow.js"));
  assert.match(row, /\n\s*fillCounterBadge\(badge, counter\.text, counter\.label, `\$\{counter\.aria\}\$\{says\}`\);/,
    "the counter loop is not passing the template's label through");
});

test("a minimized face keeps the bare number", () => {
  const css = tableCss();
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
  // Cut at the right edge, hard at the left: the row is at the start of a
  // 683px length in a 332px port, which is a 375px phone.
  const start = stubEdgeRow({ scrollWidth: 683, clientWidth: 332, scrollLeft: 0 });
  rowSeam(start).paintSeatRowEdges();
  assert.equal(start.has("opponent-row--more-left"), false,
    "the left edge is faded at scrollLeft 0 — there is nothing behind it");
  assert.equal(start.has("opponent-row--more-right"), true,
    "the right edge no longer tracks the scroll position");

  // Half way along: seats behind AND ahead.
  const middle = stubEdgeRow({ scrollWidth: 683, clientWidth: 332, scrollLeft: 175 });
  rowSeam(middle).paintSeatRowEdges();
  assert.equal(middle.has("opponent-row--more-left"), true);
  assert.equal(middle.has("opponent-row--more-right"), true);

  // At the far end: hard right again.
  const end = stubEdgeRow({ scrollWidth: 683, clientWidth: 332, scrollLeft: 351 });
  rowSeam(end).paintSeatRowEdges();
  assert.equal(end.has("opponent-row--more-left"), true);
  assert.equal(end.has("opponent-row--more-right"), false);

  // NOTHING ON A ROW THAT DOES NOT SCROLL — a fade on a two-handed row would
  // promise a player who is not there. Both halves: a carousel with nowhere to
  // go, and a fitted row that is not a carousel at all.
  const short = stubEdgeRow({ scrollWidth: 332, clientWidth: 332, scrollLeft: 0 });
  rowSeam(short).paintSeatRowEdges();
  assert.equal(short.has("opponent-row--more-right"), false,
    "a carousel with nothing to scroll to is wearing a soft edge");
  const fitted = stubEdgeRow({ scrollWidth: 683, clientWidth: 332, scrollLeft: 0, carousel: false });
  rowSeam(fitted).paintSeatRowEdges();
  assert.equal(fitted.has("opponent-row--more-right"), false,
    "the fade is no longer conditional on the row being a carousel");

  // ...and the 1px rounding slack seatRowOverflows keeps, or a row with nowhere
  // to go wears a permanent fade off fractional layout.
  const rounded = stubEdgeRow({ scrollWidth: 333, clientWidth: 332, scrollLeft: 0 });
  rowSeam(rounded).paintSeatRowEdges();
  assert.equal(rounded.has("opponent-row--more-right"), false,
    "a one-pixel overflow is being treated as a scroller");

  // The same slack on the POSITION, which is where fractional layout actually
  // shows up: a row parked within a pixel of either end is AT that end.
  const nearEnd = stubEdgeRow({ scrollWidth: 683, clientWidth: 332, scrollLeft: 350.6 });
  rowSeam(nearEnd).paintSeatRowEdges();
  assert.equal(nearEnd.has("opponent-row--more-right"), false,
    "a row parked 0.4px from the end still promises seats ahead of it");
  const nearStart = stubEdgeRow({ scrollWidth: 683, clientWidth: 332, scrollLeft: 0.6 });
  rowSeam(nearStart).paintSeatRowEdges();
  assert.equal(nearStart.has("opponent-row--more-left"), false,
    "a row parked 0.6px along still promises seats behind it");
});

test("the fade follows the finger, and is painted before anybody has scrolled", () => {
  const row = stubEdgeRow({ scrollWidth: 683, clientWidth: 332, scrollLeft: 0 });
  rowSeam(row).watchSeatRowEdges();

  assert.equal(row.listeners.length, 1, "nothing repaints the fade while the player scrolls");
  assert.equal(row.listeners[0].type, "scroll");
  // Passive: this only writes two class names, and a non-passive listener on a
  // scroller is a scroll the compositor has to wait for.
  assert.deepEqual(row.listeners[0].opts, { passive: true });
  // Painted on the way past, or the first frame of a match has no edges.
  assert.equal(row.has("opponent-row--more-right"), true);

  // The listener IS the painter: move the row and fire what was registered.
  row.scrollLeft = 351;
  row.listeners[0].handler();
  assert.equal(row.has("opponent-row--more-right"), false);
  assert.equal(row.has("opponent-row--more-left"), true);
});

test("the row's other two repaint drivers are still wired", () => {
  // The render catches a row that grew without being scrolled (a bot laying a
  // meld fires no scroll event); initTable installs the listener. Both are
  // statements inside functions that want a whole laid-out row, so both stay
  // source gates — see this file's header.
  const row = code(read("src/ui/seatRow.js"));
  assert.match(row, /scrollActingSeatIntoView\(state, acting\);\n\s*paintSeatRowEdges\(\);/,
    "renderSeats no longer repaints the fade — a bot laying a meld lengthens the "
    + "row without firing a scroll event");
  assert.match(code(read("src/ui/table.js")), /\n\s*seatRow\.watchSeatRowEdges\(\);/,
    "the scroll listener is never installed");
});

test("the fade is a mask on the two edge classes and nothing else", () => {
  const css = tableCss();
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
  assert.ok(block, "no edge-fade block in src/ui/css/seats.css");
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
  const row = code(read("src/ui/seatRow.js"));
  // Named in the import, or the branch below is a ReferenceError at boot.
  assert.match(row, /import \{[^}]*renderCounterPips[^}]*\} from '\.\/counterTrack\.js';/,
    "the pip renderer is not imported — the counter loop cannot be drawing one");
  // The BRANCH, as a whole statement: matching `counterPips(` alone also
  // matches the import, so deleting the call would leave this green.
  assert.match(row, /\n\s*if \(counterPips\(counter\)\) \{\n\s*head\.appendChild\(renderCounterPips\(counter\)\);/,
    "the counter loop no longer draws a pip counter as pips — Spades' faces are "
    + "back to a bid digit and a trick digit (#148)");
});

test("the row honours openOnly, and the round summary asks past it", () => {
  const table = code(read("src/ui/table.js"));
  // The filter itself, asked of `seatCountersFor` (#223 — it used to be a source
  // gate on the two lines). Without it a minimized Spades face wears the bid
  // digit, the trick digit AND the pip row that says both of them.
  const declaring = {
    pack: {
      template: {
        seatCounters: () => [
          { text: "4", aria: "bid 4 tricks", label: "Bid", kind: "bid", openOnly: true },
          { text: "2", aria: "2 melds", label: "Meld", kind: "meld", minimizedOnly: true },
          { text: "7", aria: "7 cards", label: "Cards", kind: "hand" },
        ],
      },
    },
    zones: { count: () => 7 },
  };
  assert.deepEqual(seatCountersFor(declaring, 1, { minimized: true }).map((c) => c.kind),
    ["meld", "hand"],
    "seatCountersFor no longer drops openOnly counters from a minimized face");
  assert.deepEqual(seatCountersFor(declaring, 1, { minimized: false }).map((c) => c.kind),
    ["bid", "hand"],
    "seatCountersFor no longer drops minimizedOnly counters from an open seat");
  // ...and the sheet's own line no longer reads this list at all (#219). It used
  // to find the counters whose `kind` is 'bid' and 'tricks' and compose "Bid 4,
  // took 5" from them, which needed a third face — `{ all: true }` — because both
  // of those are openOnly at a Spades table. The template writes the phrase now,
  // so the words cannot go missing behind a filter; what this pins is that the
  // felt asks rather than composes.
  // The sheet's line is built in src/ui/roundEnding.js since #223 (seam 2), so
  // the positive half reads there and the negative half reads both files.
  const ending = code(read("src/ui/roundEnding.js"));
  assert.match(ending, /const declared = finalState\.pack\.template\.roundLines\?\.\(makeCtx\(finalState\)\);/,
    "the round summary is building its own per-seat phrase again — the bid's "
    + "words are the template's (src/templates/CONTRACT.md, `roundLines`)");
  for (const src of [table, ending]) {
    assert.doesNotMatch(src, /kind === 'bid'|kind === 'tricks'/,
      "the felt is reading counter kinds by name to write a sentence out of them");
  }
  // ...and the human's own strip picks its counters the same way: the template
  // marks them, rather than this file keeping a list of the kinds that qualify.
  assert.match(table, /\.filter\(\(counter\) => counter\.mine\)/,
    "the own-seat strip is choosing counters by kind again (#219) — which of a "
    + "template's numbers the plateless seat needs is the template's answer");
  assert.doesNotMatch(table, /MY_SEAT_KINDS/,
    "the platform is back to keeping one template's counter slugs in a list");
});

// THE SHEET'S PHRASE ITSELF, off a real position — the half a source gate cannot
// see. "Bid 4, took 5" is the reason a delta of -30 happened, and both numbers
// have to be the seat plate's own words (a nil reads "nil" on both).
test("a bidding pack writes one round-sheet line per seat, and Hearts writes none", async () => {
  let checked = 0;
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    if (!pack.template.roundLines) continue;
    const state = createState({ pack, seats: 4, seed: `sheet:${packId}` });
    pack.template.setup(makeCtx(state));
    const lines = pack.template.roundLines(makeCtx(state));
    if (!pack.rules.bidding) {
      assert.strictEqual(lines, null, `${packId}: a pack that does not bid wrote a sheet line`);
      continue;
    }
    checked++;
    assert.strictEqual(lines.length, state.seats, `${packId}: one line per seat`);
    for (let seat = 0; seat < state.seats; seat++) {
      const badge = pack.template.seatCounters(makeCtx(state), seat).find((c) => c.kind === "bid");
      assert.strictEqual(lines[seat], `Bid ${badge.text}, took 0`,
        `${packId} seat ${seat}: the sheet's words and the plate's disagree`);
    }
  }
  assert.ok(checked >= 2, `only ${checked} bidding packs were examined — the sweep found nothing`);
});

test("an empty hidden pile draws no chip, and no empty strip either", () => {
  const table = code(read("src/ui/seatRow.js"));
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
  const css = tableCss();
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
  assert.ok(block, "no .seat__pip block in src/ui/css/seats.css");
  assert.doesNotMatch(block[1], /animation/,
    "a pip must not animate — no infinite animations (cardstock#24)");
  assert.match(css, /\.seat__pips\[data-dense="true"\] \{[^}]*--pip-size:/,
    "the dense row no longer shrinks its circles, so a bid of thirteen runs off the seat");
});

/* ------------------------------------------------------------------ *
 * The refit paints what the felt paints (#259)
 * ------------------------------------------------------------------ */

/**
 * A document the WHOLE row can be built into — every seat, its head, its
 * badges and its fan of backs — which is more than `stubDocument` above needs
 * to answer: class lists, a style that takes custom properties, a rect, and
 * the lookups the row makes on its way past (all of which find nothing, which
 * is the truth about a row nobody has laid out).
 */
function stubRowDocument() {
  const make = (tag) => {
    const node = {
      tag,
      className: "",
      textContent: "",
      innerHTML: "",
      dataset: {},
      attrs: {},
      children: [],
      clientWidth: 900,
      scrollWidth: 900,
      scrollLeft: 0,
      style: { setProperty(name, value) { this[name] = value; } },
      classList: {
        add: (cls) => { node.className = `${node.className} ${cls}`.trim(); },
        contains: (cls) => node.className.split(/\s+/).includes(cls),
        toggle: (cls, on) => {
          const list = node.className.split(/\s+/).filter((c) => c && c !== cls);
          if (on) list.push(cls);
          node.className = list.join(" ");
        },
      },
      get childElementCount() { return node.children.length; },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...kids) { node.children = kids; },
      setAttribute(name, value) { node.attrs[name] = String(value); },
      // Kept, so a test can press a control the row built (#270).
      listeners: {},
      addEventListener(type, handler) { (node.listeners[type] ||= []).push(handler); },
      click() { for (const handler of node.listeners.click || []) handler(); },
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 120, bottom: 120 }),
      cloneNode: () => make(tag),
      remove() {},
    };
    if (tag === "template") node.content = make("fragment");
    return node;
  };
  return { createElement: make, getElementById: () => null, querySelector: () => null };
}

test("the width refit repaints the felt's position, not the live one (#259)", async () => {
  // A REVIEW IS OPEN: the felt stands at a position from the middle of the
  // round while the engine already holds a fresh deal. The two are told apart
  // by the one thing a seat always draws — how many cards each opponent holds.
  const pack = await loadPackFromDisk("hearts");
  const live = createState({ pack, seats: 4, seed: "refit:259" });
  pack.template.setup(makeCtx(live));
  const reviewed = createState({ pack, seats: 4, seed: "refit:259" });
  pack.template.setup(makeCtx(reviewed));
  const held = { 1: 9, 2: 10, 3: 11 };
  for (const [seat, count] of Object.entries(held)) {
    reviewed.zones.cards(`hand.${seat}`).splice(count);
  }
  for (const seat of [1, 2, 3]) assert.equal(live.zones.count(`hand.${seat}`), 13);

  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, "document");
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const before = { document: globalThis.document, window: globalThis.window };
  const listeners = [];
  globalThis.document = stubRowDocument();
  globalThis.window = { addEventListener: (type, handler) => listeners.push({ type, handler }) };
  try {
    const row = document.createElement("div");
    const session = { review: { state: reviewed } };
    const seam = createSeatRow({
      el: { opponentsTop: row, table: document.createElement("div"), screen: document.createElement("div") },
      session: () => session,
      zones: () => null,
      liveState: () => live,
      feltState: () => reviewed,
      render: () => {},
      mySeat: () => 0,
      isMySeat: (seat) => seat === 0,
      identityOf: (seat) => ({ name: `Seat ${seat}`, color: "#345", icon: "", initials: `S${seat}` }),
      art: () => ({ backPanel: "#123", back: () => "<svg></svg>" }),
      markEntry: (node) => node,
      turnToken: () => document.createElement("span"),
      committingToken: () => document.createElement("span"),
      humanAnnouncements: () => [],
      heldValueText: () => "",
      ownZoneInstances: () => [],
      perPlayerZoneInstances: () => [],
      performAnnouncement: () => {},
      isBusy: () => false,
    });

    // No ResizeObserver under node, so the seam falls back to the window's
    // `resize` — the same refit either way, and this is the one a test can fire.
    seam.watchSeatRowWidth();
    const resize = listeners.find((l) => l.type === "resize");
    assert.ok(resize, "watchSeatRowWidth installed no refit to drive");
    resize.handler();

    const drawn = {};
    for (const wrap of row.children.filter((c) => c.dataset.seat !== undefined)) {
      const mini = childByClass(wrap, "mini-hand");
      assert.ok(mini, `seat ${wrap.dataset.seat} drew no fan`);
      drawn[wrap.dataset.seat] = Number(mini.style["--mini-count"]);
    }
    assert.deepEqual(drawn, { 1: 9, 2: 10, 3: 11 },
      "the refit repainted the seat row from the live state — under an open review "
      + "the row shows the next deal while the felt shows the reviewed position (#259)");
  } finally {
    if (hadDocument) globalThis.document = before.document;
    else delete globalThis.document;
    if (hadWindow) globalThis.window = before.window;
    else delete globalThis.window;
  }
});

/* ------------------------------------------------------------------ *
 * The row's own controls repaint what the felt paints (#270)
 * ------------------------------------------------------------------ */

/**
 * A row built under an OPEN REVIEW whose `render` is the real one's shape:
 * handed a state, it rebuilds the row from that state. The reviewed position
 * and the live one differ in the thing every seat draws — how many cards each
 * opponent holds — so the row says which of the two a control repainted.
 */
async function reviewedRow(seatView, run) {
  const pack = await loadPackFromDisk("hearts");
  const live = createState({ pack, seats: 4, seed: "controls:270" });
  pack.template.setup(makeCtx(live));
  const reviewed = createState({ pack, seats: 4, seed: "controls:270" });
  pack.template.setup(makeCtx(reviewed));
  for (const [seat, count] of Object.entries({ 1: 9, 2: 10, 3: 11 })) {
    reviewed.zones.cards(`hand.${seat}`).splice(count);
  }
  for (const seat of [1, 2, 3]) assert.equal(live.zones.count(`hand.${seat}`), 13);

  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, "document");
  const before = globalThis.document;
  globalThis.document = stubRowDocument();
  try {
    const row = document.createElement("div");
    const table = document.createElement("div");
    // The two lookups the row makes of its own children, answered for real:
    // renderSeats drops a pick whose seat it cannot find collapsed, and the
    // toggle is taken down before the next one goes up.
    row.querySelector = (selector) => {
      const m = /^(?:\.([\w-]+))?\[data-seat="(\d+)"\]$/.exec(selector);
      assert.ok(m, `the row asked for ${selector}, which this stub does not answer`);
      return row.children.find((c) => c.dataset.seat === m[2]
        && (!m[1] || c.className.split(/\s+/).includes(m[1]))) || null;
    };
    table.querySelector = (selector) => {
      const cls = selector.slice(1);
      const found = table.children.find((c) => c.className === cls) || null;
      if (found) found.remove = () => { table.children = table.children.filter((c) => c !== found); };
      return found;
    };
    const session = { review: { state: reviewed }, seatView };
    const painted = [];
    const paint = (state) => seam.renderSeats(state, false, [], buildUiModel(state, { seat: 0 }));
    const seam = createSeatRow({
      el: { opponentsTop: row, table, screen: document.createElement("div") },
      session: () => session,
      zones: () => null,
      liveState: () => live,
      feltState: () => reviewed,
      render: (state) => { painted.push(state); paint(state); },
      mySeat: () => 0,
      isMySeat: (seat) => seat === 0,
      identityOf: (seat) => ({ name: `Seat ${seat}`, color: "#345", icon: "", initials: `S${seat}` }),
      art: () => ({ backPanel: "#123", back: () => "<svg></svg>" }),
      markEntry: (node) => node,
      turnToken: () => document.createElement("span"),
      committingToken: () => document.createElement("span"),
      humanAnnouncements: () => [],
      heldValueText: () => "",
      ownZoneInstances: () => [],
      perPlayerZoneInstances: () => [],
      performAnnouncement: () => {},
      isBusy: () => false,
    });
    // The felt as table.js leaves it under the review: painted from the
    // reviewed position.
    paint(reviewed);
    await run({ row, table, session, painted, reviewed });
  } finally {
    if (hadDocument) globalThis.document = before;
    else delete globalThis.document;
  }
}

/** Each opponent's hand count as the row draws it — the fan when open, the badge when minimized. */
function drawnCounts(row) {
  const drawn = {};
  for (const wrap of row.children.filter((c) => c.dataset.seat !== undefined)) {
    const mini = childByClass(wrap, "mini-hand");
    if (mini) {
      drawn[wrap.dataset.seat] = Number(mini.style["--mini-count"]);
      continue;
    }
    const head = wrap.children.find((c) => c.className === "seat__head");
    const badge = head && head.children.find((c) => c.className === "seat__count");
    assert.ok(badge, `seat ${wrap.dataset.seat} drew neither a fan nor a count`);
    drawn[wrap.dataset.seat] = Number(childByClass(badge, "seat__count-value").textContent);
  }
  return drawn;
}

test("the Minimize player cards toggle repaints the felt's position, not the live one (#270)", async () => {
  await reviewedRow("minimized", ({ row, table, session, painted, reviewed }) => {
    assert.deepEqual(drawnCounts(row), { 1: 9, 2: 10, 3: 11 }, "the row did not start on the reviewed position");
    const toggle = table.children.find((c) => c.className === "opponent-row__toggle");
    assert.ok(toggle, "no Minimize player cards toggle was built to press");
    toggle.click();
    // It did its own job…
    assert.equal(session.seatView, "all", "the toggle did not change the seat view");
    assert.ok(row.children.some((c) => childByClass(c, "mini-hand")), "the row did not open its fans");
    // …and painted what the felt is showing.
    assert.equal(painted.length, 1, "the toggle did not repaint the felt");
    assert.ok(painted[0] === reviewed,
      "the toggle repainted the felt from the live state — under an open review it replaces "
      + "the reviewed position with the next deal (#270)");
    assert.deepEqual(drawnCounts(row), { 1: 9, 2: 10, 3: 11 },
      "after the toggle the row shows the live deal, not the reviewed position (#270)");
  });
});

test("a collapsed seat head repaints the felt's position, not the live one (#270)", async () => {
  await reviewedRow("minimized", ({ row, session, painted, reviewed }) => {
    const wrap = row.children.find((c) => c.dataset.seat === "2");
    const head = wrap && wrap.children.find((c) => c.className === "seat__head");
    assert.ok(head && head.tag === "button", "seat 2 has no collapsed head to press");
    assert.equal(head.attrs["aria-expanded"], "false", "seat 2's plate started open");
    head.click();
    // It did its own job…
    assert.equal(session.openSeat, 2, "the seat head did not open seat 2's plate");
    const again = row.children.find((c) => c.dataset.seat === "2");
    assert.equal(again.children.find((c) => c.className === "seat__head").attrs["aria-expanded"], "true",
      "the rebuilt row does not show seat 2 open");
    // …and painted what the felt is showing.
    assert.equal(painted.length, 1, "the seat head did not repaint the felt");
    assert.ok(painted[0] === reviewed,
      "the seat head repainted the felt from the live state — under an open review it replaces "
      + "the reviewed position with the next deal (#270)");
    assert.deepEqual(drawnCounts(row), { 1: 9, 2: 10, 3: 11 },
      "after the seat head the row shows the live deal, not the reviewed position (#270)");
  });
});
