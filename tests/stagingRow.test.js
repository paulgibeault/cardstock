/**
 * YOUR PILES AND YOUR TRAY, SHARING A ROW (#137).
 *
 * At 1280x860 the felt was 931px against 860 of window for the whole of
 * Cribbage's crib discard, so the hand sat below the fold. #player-piles and
 * #stage-row say the same thing — "yours, above the hand" — and on a window
 * with width to spare they share one row instead of taking two.
 *
 * There is no DOM in `npm test` (src/ui/table.js touches document at import),
 * so this is a MARKUP AND STYLESHEET GATE. It pins the four things that make
 * the row safe rather than the numbers it produces — the geometry is measured
 * with playwright, and is in IMPLEMENTATION_NOTES:
 *
 *   1. the wrapper really wraps both halves, or there is no row to share;
 *   2. its resting state is `display: contents`, which is what makes the felt
 *      byte-identical at every size the row does not apply to — 375x812, the
 *      size this pass must not touch, included;
 *   3. the row is gated above phone widths, so no phone can reach it however
 *      short the window is;
 *   4. the piles sit in the middle column of a SYMMETRIC template, which is
 *      what keeps them on the felt's centre line while the tray beside them
 *      grows and shrinks;
 *   5. the tray in the gutter does not wrap, and its cards may shrink. This is
 *      the pair that stops the felt growing at all: allowed to wrap, the tray
 *      took a third line at the ninth staged card and the felt jumped 100px
 *      with the hand on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";

const css = fs.readFileSync(path.join(ROOT, "src/ui/table.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/** Every `@media` block's condition and body, by brace matching. */
function mediaBlocks(sheet) {
  const out = [];
  for (const m of sheet.matchAll(/@media([^{]+)\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    while (i < sheet.length && depth > 0) {
      if (sheet[i] === "{") depth += 1;
      else if (sheet[i] === "}") depth -= 1;
      i += 1;
    }
    out.push({ condition: m[1].trim(), body: sheet.slice(from, i - 1) });
  }
  return out;
}

/** The declarations of the first rule the predicate accepts. */
function declarationsFor(body, matches) {
  for (const [, head, decls] of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = head.split("}").pop().trim();
    if (selector && matches(selector, decls)) return decls;
  }
  return null;
}

/** The blocks that turn the wrapper into a row. */
function sharedRowBlocks() {
  return mediaBlocks(css).filter((b) => /#player-row[^{}]*\{[^{}]*display:\s*grid/.test(b.body));
}

test("the wrapper holds both halves, or there is no row to share", () => {
  const open = html.indexOf('id="player-row"');
  assert.notEqual(open, -1, "index.html has no #player-row wrapper");
  // Its extent: from its own <div ...> to the matching </div>.
  let i = html.indexOf(">", open) + 1;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth += 1; i = nextOpen + 4; }
    else { depth -= 1; i = nextClose + 6; }
  }
  const inside = html.slice(open, i);
  for (const id of ["player-piles", "stage-row"]) {
    assert.ok(inside.includes(`id="${id}"`), `#${id} is not inside #player-row`);
  }
});

test("the wrapper's resting state is display: contents", () => {
  // Outside every @media block: what the felt does at the sizes the row does
  // not apply to, which has to be exactly what it did before there was a
  // wrapper at all.
  let outside = css;
  for (const b of mediaBlocks(css)) outside = outside.replace(b.body, "");
  const decls = declarationsFor(outside, (s) => s === "#player-row");
  assert.ok(decls, "#player-row has no unconditional rule");
  assert.match(decls, /display:\s*contents/,
    "#player-row must be display: contents at rest, or the felt gains a box everywhere");
});

test("no phone can reach the shared row", () => {
  const blocks = sharedRowBlocks();
  assert.ok(blocks.length, "no @media block turns #player-row into a grid");
  for (const b of blocks) {
    const min = b.condition.match(/min-width:\s*(\d+)px/);
    assert.ok(min, `the shared row's block is not gated on a min-width: ${b.condition}`);
    // The sheet's own phone blocks reach up to 480px (the portrait-phone rail
    // rule); anything above that is not a phone in portrait.
    assert.ok(Number(min[1]) > 480,
      `the shared row starts at ${min[1]}px, which a phone can reach`);
  }
});

test("the piles keep the felt's centre line", () => {
  for (const b of sharedRowBlocks()) {
    const grid = declarationsFor(b.body,
      (s, d) => /^#player-row/.test(s) && /display:\s*grid/.test(d));
    assert.ok(grid, "the shared row has no grid rule");
    const template = grid.match(/grid-template-columns:\s*([^;]+);/);
    assert.ok(template, "the shared row declares no column template");
    const tracks = template[1].trim().split(/\s+/);
    assert.equal(tracks.length, 3, `expected three columns, got ${template[1]}`);
    assert.equal(tracks[0], tracks[2],
      `the gutters must be equal or the piles do not stay centred: ${template[1]}`);
    assert.equal(tracks[1], "auto", "the middle column must be sized to the piles");
    const piles = declarationsFor(b.body, (s) => /#player-row\s*>\s*#player-piles/.test(s));
    assert.ok(piles, "the piles are not placed in the shared row");
    assert.match(piles, /grid-column:\s*2\b/, "the piles must sit in the middle column");
  }
});

test("the tray narrows its cards instead of wrapping out of its gutter", () => {
  for (const b of sharedRowBlocks()) {
    const tray = declarationsFor(b.body, (s) => /#stage-tray/.test(s) && /#player-row/.test(s));
    assert.ok(tray, "the shared row does not constrain #stage-tray");
    assert.match(tray, /flex-wrap:\s*nowrap/,
      "a wrapping tray grows the row, and the felt with it");
    const card = declarationsFor(b.body, (s) => /#player-row/.test(s) && /\.stage-card\s*$/.test(s.trim()));
    assert.ok(card, "the shared row does not let .stage-card shrink");
    assert.match(card, /min-width:\s*0\b/,
      "a flex item's automatic minimum is its content, so without this the cards cannot narrow");
  }
});
