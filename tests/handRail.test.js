/**
 * THE RAIL'S THREE RUNGS, AND THE MARK IN THE FELT'S CORNER (#154, #155).
 *
 * The sort toggle and the action button used to share one slot: `renderRail`
 * hid `#hand-sort` whenever the UI model had an action in it, so a Spades bid,
 * a Hearts pass, a cribbage crib discard or a staged Thirteen combination took
 * the sort control off the felt for the whole phase — the phase a player
 * spends arranging their hand to decide with (#154). They have a rung each
 * now, paid for by the Hint lamp leaving the rail for the help mark in the
 * felt's corner (#155).
 *
 * There is no DOM in `npm test` (src/ui/table.js touches document at import),
 * so this is a MARKUP, STYLESHEET AND SOURCE gate. It pins the things that
 * would let the regression back in rather than the pixels, which are measured
 * with playwright and written up in IMPLEMENTATION_NOTES:
 *
 *   1. both controls are in the stack, and neither is in the markup `hidden`;
 *   2. nothing in `renderRail` writes `hidden` — every rung keeps its slot and
 *      loses `visibility`, which is what stops the column shuffling under a
 *      thumb mid-turn;
 *   3. whether the sort toggle is offered does not mention the action at all.
 *      That is the regression itself: one expression, two questions;
 *   4. each rung has its own `visibility` rule, and none of them a
 *      `display: none` — a rung that vanishes takes the rungs below it up;
 *   5. the hint offer is out of the rail, the mark is on the felt with the
 *      sheet wired to the rules panel and to `showHint`, and the sheet closes
 *      BEFORE the hint runs, because what a hint produces is a ring round
 *      cards the sheet would otherwise be standing over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const html = read("index.html");
const tableJs = read("src/ui/table.js");
const cssRaw = read("src/ui/table.css");

/** Every `@media` block, by brace matching — condition and body. */
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
    out.push({ condition: m[1].trim(), body: sheet.slice(from, i - 1), whole: sheet.slice(m.index, i) });
  }
  return out;
}

// Comments out, and the media blocks with them: the portrait phone stands the
// same rungs in a row and re-states their widths (`.hand-rail` twice over), so
// a rule looked up by selector alone would find two and mean neither. What is
// pinned here is the shape the rail has everywhere.
const commentless = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const css = mediaBlocks(commentless).reduce((sheet, block) => sheet.replace(block.whole, ""), commentless);

/** The arguments of the CALL that `head` sits inside — head to its own `)`. */
function argsAround(source, head) {
  const at = source.indexOf(head);
  assert.notStrictEqual(at, -1, `not found in source: ${head}`);
  let depth = 1;
  for (let i = at; i < source.length; i++) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i);
    }
  }
  throw new Error(`unbalanced call around ${head}`);
}

/** The body of a braced block, from the first `{` after `head`. */
function blockAfter(source, head, open = "{", close = "}") {
  const at = source.indexOf(head);
  assert.notStrictEqual(at, -1, `not found in source: ${head}`);
  let i = source.indexOf(open, at);
  assert.notStrictEqual(i, -1, `no ${open} after ${head}`);
  let depth = 0;
  const from = i + 1;
  for (; i < source.length; i++) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(from, i);
    }
  }
  throw new Error(`unbalanced ${open} after ${head}`);
}

/** Every declaration block whose selector matches, comments already stripped. */
function rulesFor(matches) {
  const out = [];
  for (const [, head, decls] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = head.split("}").pop().trim();
    if (selector && matches(selector)) out.push({ selector, decls });
  }
  return out;
}

/** The stack's markup: its opening tag to the first close after the last rung. */
const railStack = (() => {
  const from = html.indexOf('<div class="hand-rail__stack">');
  assert.notStrictEqual(from, -1, "no .hand-rail__stack in index.html");
  const last = html.indexOf('id="action-button"', from);
  assert.notStrictEqual(last, -1, "no #action-button in the stack");
  return html.slice(from, html.indexOf("</div>", last));
})();

const renderRail = blockAfter(tableJs, "function renderRail(");

/* ------------------------------------------------------------------ *
 * #154 — the shared slot
 * ------------------------------------------------------------------ */

test("the rail's stack holds both controls, and neither of them is born hidden", () => {
  assert.match(railStack, /id="hand-sort"/, "the sort toggle is in the stack");
  assert.match(railStack, /id="action-button"/, "the action button is in the stack");
  // THE ORDER IS THE THUMB'S. The action button is the last rung because it is
  // the one being reached for; the sort toggle stands above it.
  assert.ok(railStack.indexOf('id="hand-sort"') < railStack.indexOf('id="action-button"'),
    "the action button is the rung nearest the fan");
  // `hidden` is `display: none`, and a rung that stops taking up room takes
  // the rungs below it up with it — under a thumb already reaching.
  const rungs = railStack.match(/<button[^>]*id="(hand-sort|action-button)"[^>]*>/g) || [];
  assert.strictEqual(rungs.length, 2, "both rungs are plain buttons in the stack");
  for (const rung of rungs) {
    assert.doesNotMatch(rung, /\bhidden\b/, `a rung may not be hidden in the markup: ${rung}`);
  }
});

test("renderRail hides nothing: every rung keeps its slot", () => {
  assert.doesNotMatch(renderRail, /\.hidden\s*=/,
    "a rung toggled by `hidden` leaves the stack and the column shuffles (#13)");
  assert.match(renderRail, /hand-rail--committing/, "the action button is toggled by class");
  assert.match(renderRail, /hand-rail--sortable/, "the sort toggle is toggled by class");
});

test("whether the fan may be sorted is not a question about the action", () => {
  // THE REGRESSION ITSELF. `el.handSort.hidden = acting || hand < 2` answered
  // two questions in one expression, and the first of them is what took the
  // sort control off the felt for a whole bid.
  const sortable = argsAround(renderRail, "'hand-rail--sortable'");
  assert.doesNotMatch(sortable, /acting|ui\.action/,
    `the sort toggle's condition mentions the action: ${sortable.trim()}`);
  assert.match(sortable, /handAddress|cards\(/,
    "it asks about the hand, which is the only thing sorting depends on");
  // And the action button's own condition still asks only about the action.
  const committing = argsAround(renderRail, "'hand-rail--committing'");
  assert.match(committing, /acting/, "the action button follows the action");
});

test("each rung goes quiet by visibility, never by display", () => {
  const rungs = [
    [".turn-token", /\.turn-token\s*$/],
    ["#action-button", /#action-button\s*$/],
    [".hand-sort", /\.hand-sort\s*$/],
  ];
  for (const [name, tail] of rungs) {
    const quiet = rulesFor((sel) => sel.startsWith(".hand-rail:not(") && tail.test(sel));
    assert.strictEqual(quiet.length, 1, `${name} needs exactly one "goes quiet" rule`);
    assert.match(quiet[0].decls, /visibility:\s*hidden/,
      `${name} must lose visibility, not its box`);
    // Nothing anywhere may take a rung's box away.
    for (const rule of rulesFor((sel) => tail.test(sel) && !sel.includes("hand-rail__stack"))) {
      assert.doesNotMatch(rule.decls, /display:\s*none/,
        `${rule.selector} takes ${name} out of the stack`);
    }
  }
});

test("the rail is still the fixed width the fan is laid out against", () => {
  // layoutHand subtracts the RAIL, so this number is the fan's room. It is
  // pinned here because a control that outgrew it would re-fan the hand under
  // the player's finger (#13, in the inline axis).
  const rail = rulesFor((sel) => sel === ".hand-rail");
  assert.strictEqual(rail.length, 1);
  assert.match(rail[0].decls, /width:\s*5rem/, "the rail's width is its contract with the fan");
  assert.match(rail[0].decls, /height:\s*0/, "and its box owes the row no height");
});

/* ------------------------------------------------------------------ *
 * #155 — the help mark
 * ------------------------------------------------------------------ */

test("the hint offer has left the rail entirely", () => {
  for (const [name, source] of [["index.html", html], ["table.js", tableJs], ["table.css", cssRaw]]) {
    assert.doesNotMatch(source, /hint-button|hintButton/,
      `${name} still knows about the rail's hint button`);
  }
});

test("the felt carries a help mark, and it says what it opens", () => {
  const mark = html.match(/<button[^>]*id="help-button"[\s\S]*?>/);
  assert.ok(mark, "no #help-button in the markup");
  assert.match(mark[0], /aria-expanded="false"/, "a disclosure says whether it is open");
  assert.match(mark[0], /aria-controls="help-sheet"/, "and what it opens");
  assert.match(mark[0], /aria-label="Help"/, "a glyph needs a name");
  const sheet = html.slice(html.indexOf('id="help-sheet"'), html.indexOf('id="opponents-top"'));
  assert.match(sheet, /id="help-rules"/, "the sheet offers the rules");
  assert.match(sheet, /id="help-hint"/, "and the hint");
  assert.match(sheet, /id="help-hint-note"/, "with a line that says why, when there is no hint");
});

test("the mark sits on the felt, out of the way of everything that is a move", () => {
  const help = rulesFor((sel) => sel === ".table-help");
  assert.strictEqual(help.length, 1, "one rule for the mark");
  assert.match(help[0].decls, /position:\s*absolute/, "out of the felt's flow");
  // A DISC, and one that fits the band above the seats. On a phone the seat row
  // starts 14px under the felt's top edge, so the ink is the toggle's register
  // opposite it and the TARGET is grown by a pseudo-element instead.
  const size = (prop) => help[0].decls.match(new RegExp(`${prop}:\\s*([\\d.]+)rem`))?.[1];
  assert.ok(size("width") && size("width") === size("height"), "the mark is a disc");
  assert.ok(Number(size("width")) <= 1.5, `${size("width")}rem of ink lands on the first seat plate`);
  const target = rulesFor((sel) => sel === ".table-help::after");
  assert.strictEqual(target.length, 1, "the disc needs a target bigger than itself");
  assert.match(target[0].decls, /bottom:\s*0/,
    "a target that reached below the disc would take the taps that belong to a seat");
  for (const side of ["top", "left", "right"]) {
    assert.match(target[0].decls, new RegExp(`${side}:\\s*-`), `the target grows ${side}wards`);
  }
  const z = (decls) => Number(decls.match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(z(help[0].decls) < 10, "the mark stays below the dialogs at 10");
  // NOT THE CORNER THE SEAT-VIEW TOGGLE HAS. Two marks in one corner is one
  // mark nobody can hit.
  const toggle = rulesFor((sel) => sel === ".opponent-row__toggle");
  assert.strictEqual(toggle.length, 1);
  assert.match(toggle[0].decls, /right:/, "the toggle has the right corner");
  assert.match(help[0].decls, /left:/, "so the mark takes the left one");

  const sheet = rulesFor((sel) => sel === ".help-sheet");
  assert.strictEqual(sheet.length, 1);
  assert.ok(z(sheet[0].decls) < 10,
    "the sheet stays below the rules panel it opens, or it stands over it");
  assert.strictEqual(rulesFor((sel) => sel === ".help-sheet[hidden]").length, 1,
    "a flex box needs its own [hidden] rule, or a closed sheet is an open one");
});

test("the sheet's two lines reach the rules panel and the ranking", () => {
  const rules = blockAfter(tableJs, "el.helpRules.addEventListener");
  assert.match(rules, /showRules\(packRules\(livePack\(\)\)\)/,
    "How to play opens the same panel the scoreboard's does");
  assert.match(rules, /setHelpOpen\(false\)/, "and closes the sheet behind it");

  const hint = blockAfter(tableJs, "el.helpHint.addEventListener");
  assert.match(hint, /showHint\(\)/, "Hint asks for the ranking");
  // THE ORDER IS THE POINT. A hint's answer is a ring round cards on the felt,
  // and a sheet left standing over them answers the question with the answer
  // hidden behind it.
  assert.ok(hint.indexOf("setHelpOpen(false)") < hint.indexOf("showHint()"),
    "the sheet closes before the hint runs");
});

test("the hint line is offered or explained, never simply missing", () => {
  const offer = blockAfter(tableJs, "function hintOffer(");
  // The same five conditions the lamp was shown under, each with something to
  // say for itself: a disabled line teaches, an absent one does not.
  for (const condition of [/state\.isView/, /state\.gameOver/, /humanActs/, /suggestion/, /movesFor\(/]) {
    assert.match(offer, condition, `hintOffer no longer asks about ${condition}`);
  }
  const whys = offer.match(/HINT_OFFER\.\w+/g) || [];
  assert.ok(whys.length >= 5, `every branch carries a reason, found ${whys.length}`);
  const paint = blockAfter(tableJs, "function renderHelpOffer(");
  assert.match(paint, /el\.helpHint\.disabled\s*=/, "the line is disabled rather than hidden");
  assert.match(paint, /el\.helpHintNote\.textContent\s*=/, "and it says why");
  // Repainted from renderRail, which is the function BOTH render paths run —
  // a hint that only updated on a full render would still be offered after the
  // tap that answered it.
  assert.match(renderRail, /renderHelpOffer\(/, "the offer follows the position");
});
