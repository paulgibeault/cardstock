/**
 * Z-ORDER FOLLOWS LIFT HEIGHT, IN THE HAND.
 *
 * The fan overlaps by a negative margin (src/ui/table.css), so a later sibling
 * paints over an earlier one and every z-index tie is settled by DOM order.
 * `:hover` and `--selected` shared rung 2, which meant hovering the card
 * immediately to the RIGHT of your selection painted over the selected card's
 * raised edge — the playtest's "selected card pops up behind the other cards".
 * `--hinted` lifts 8px and had no rung at all, so it lost to everything.
 *
 * There is no DOM here, so this is a STYLESHEET GATE, and it deliberately does
 * NOT hardcode the rungs: it reads each lift state's translateY out of the CSS
 * and asserts the rungs climb in the same order. A new lift state added without
 * a rung falls to z-index 0, which is already taken by the shallowest lift, so
 * the ladder stops climbing and this goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";

const CSS_PATH = path.join(ROOT, "src/ui/table.css");

// Selectors that name a card but are not a card in the hand — the staged card
// a template shows mid-turn, an opponent's mini fan, the drag ghost. Their
// lifts are not part of the fan's ladder.
const NOT_IN_HAND = /\.stage-card|\.mini-hand|\.drag-ghost|\.game-over/;

/** Rules, flattened: @media/@keyframes wrappers are stepped over, not parsed. */
function rules(css) {
  const out = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, head, body] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // A wrapper's closing brace lands at the head of the next rule.
    const selector = head.split("}").pop().trim();
    if (selector) out.push({ selector, body });
  }
  return out;
}

/** The lift states a selector names: `--peek`, `--selected`, ... and `hover`. */
function statesIn(selector) {
  const found = new Set(
    [...selector.matchAll(/card-face-wrap--([a-z]+)/g)].map((m) => m[1]));
  if (/:hover\b/.test(selector)) found.add("hover");
  return found;
}

/**
 * The hand's lift ladder, read out of the stylesheet.
 *
 * A state's own lift is the one declared by a selector that names that state
 * ALONE — `.hand .card-face-wrap--peek .card-face`. Compound selectors
 * (`--peek.--selected`) describe a card in two states at once and have no
 * single owner, so they contribute their state names but no depth.
 */
function readLadder(css) {
  const lifts = new Map();   // state -> px lifted (positive = higher)
  const rungs = new Map();   // state -> z-index
  const seen = new Set();    // every state named by any hand lift rule

  for (const { selector, body } of rules(css)) {
    for (const part of selector.split(",")) {
      if (!part.includes("card-face") || NOT_IN_HAND.test(part)) continue;
      const states = statesIn(part);

      const lift = body.match(/transform:[^;]*translateY\(\s*-([\d.]+)px/);
      if (lift) {
        for (const s of states) seen.add(s);
        if (states.size === 1) {
          const [state] = states;
          lifts.set(state, Math.max(lifts.get(state) ?? 0, Number(lift[1])));
        }
      }

      const z = body.match(/z-index:\s*(-?\d+)/);
      if (z && states.size === 1) rungs.set([...states][0], Number(z[1]));
    }
  }
  return { lifts, rungs, seen };
}

/** Sorted shallowest-first, with the rung each state actually gets. */
function ladderSteps(css) {
  const { lifts, rungs, seen } = readLadder(css);
  for (const state of seen) {
    if (!lifts.has(state)) lifts.set(state, 0); // named, but never lifts alone
  }
  return [...lifts.entries()]
    .map(([state, lift]) => ({ state, lift, rung: rungs.get(state) ?? 0 }))
    .sort((a, b) => a.lift - b.lift || a.state.localeCompare(b.state));
}

function checkLadder(css) {
  const steps = ladderSteps(css);
  const show = (s) => `${s.state} (lift ${s.lift}px, z-index ${s.rung})`;

  // Ordering by lift and ordering by rung have to be the SAME ordering.
  const byLift = steps.map((s) => s.state);
  const byRung = [...steps].sort((a, b) => a.rung - b.rung || a.lift - b.lift)
    .map((s) => s.state);
  assert.deepEqual(byRung, byLift,
    "z-order must follow lift height. Shallowest-to-deepest is "
    + `[${byLift.join(", ")}] but back-to-front is [${byRung.join(", ")}]:\n  `
    + steps.map(show).join("\n  "));

  // deepEqual above cannot see a TIE — two states on one rung sort by whatever
  // the comparator falls back on, and a tie is exactly the bug: DOM order
  // decides, so the neighbour to the right of the selection wins.
  for (let i = 1; i < steps.length; i++) {
    const [under, over] = [steps[i - 1], steps[i]];
    assert.ok(over.rung > under.rung,
      `${show(over)} lifts higher than ${show(under)} but does not out-rank it. `
      + "Every lift state needs a rung of its own; a state with no z-index at "
      + "all sits on 0, which the shallowest lift already holds. Give it one in "
      + "the hand's z-order ladder in src/ui/table.css.");
  }
  return steps;
}

test("the hand's z-order ladder climbs with its lifts", () => {
  const steps = checkLadder(fs.readFileSync(CSS_PATH, "utf8"));

  // A parser that quietly stops matching passes an empty ladder. These are the
  // states the fan has today; finding fewer means the reading broke, not that
  // the stylesheet got simpler.
  assert.deepEqual(steps.map((s) => s.state).sort(),
    ["hinted", "hover", "peek", "playable", "selected"],
    "the hand lift states could not be read out of src/ui/table.css");
});

// PROVE THE GATE BITES (TABLES_PLAN.md §11) — a green run on a stylesheet that
// is already correct says nothing about whether the check can fail.
test("the ladder check refuses a shared rung and an unranked lift", () => {
  const good = `
    .hand .card-face-wrap--hinted { z-index: 1; }
    .hand .card-face-wrap:hover { z-index: 2; }
    .hand .card-face-wrap--selected { z-index: 3; }
    .hand .card-face-wrap--peek { z-index: 4; }
    .card-face-wrap--playable .card-face { transform: translateY(-4px); }
    .hand .card-face-wrap--hinted .card-face { transform: translateY(-8px); }
    .hand .card-face:hover { transform: translateY(-10px); }
    .card-face-wrap--selected .card-face { transform: translateY(-14px); }
    .hand .card-face-wrap--peek .card-face { transform: translateY(-20px); }
  `;
  assert.deepEqual(checkLadder(good).map((s) => s.rung), [0, 1, 2, 3, 4]);

  // The reported bug: hover and selected sharing rung 2.
  assert.throws(() => checkLadder(good.replace(
    ".hand .card-face-wrap--selected { z-index: 3; }",
    ".hand .card-face-wrap--selected { z-index: 2; }")),
    /does not out-rank/);

  // Two rungs swapped: a hovered card would paint over a selected one.
  assert.throws(() => checkLadder(good
    .replace("--selected { z-index: 3; }", "--selected { z-index: 2; }")
    .replace(":hover { z-index: 2; }", ":hover { z-index: 3; }")),
    /z-order must follow lift height/);

  // A new lift state that nobody gave a rung.
  assert.throws(() => checkLadder(good
    + ".hand .card-face-wrap--nudged .card-face { transform: translateY(-6px); }"),
    /does not out-rank/);
});
