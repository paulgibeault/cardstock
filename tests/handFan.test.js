/**
 * THE HAND'S DOM SIDE, DRIVEN (#223, seam 3).
 *
 * The fan's arithmetic — how far apart, how many rows, which card in which row,
 * what a sort puts first — has been pure and tested in tests/handOrder.test.js
 * for a long time. What could not be tested was the other half: which
 * MEASUREMENTS that arithmetic is handed, when a relayout is allowed to
 * re-parent cards, where a card dropped on a two-row fan lands, and what the
 * tray says when the engine will not take its contents. All of it lived in
 * src/ui/table.js, which resolves 43 element ids at import and so cannot be
 * loaded here.
 *
 * src/ui/handFan.js takes its elements in, so these stand up the few nodes each
 * function reads — a row with a width, a rail with a width, cards with a
 * computed size — and ask. The stubs answer only the questions the code asks;
 * anything else it reached for would throw, which is the point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { createHandFan, nearestRow, activateOnKey } from "../src/ui/handFan.js";
import { fanStep, reorder } from "../src/ui/handOrder.js";
import { loadHandPrefs } from "../src/arcade/storage.js";
import { installArcade } from "./fixtures/arcade.js";

/* ------------------------------------------------------------------ *
 * Stubs
 * ------------------------------------------------------------------ */

function classList() {
  const set = new Set();
  return {
    set,
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

/** Enough of an element for the fan: children, classes, attributes, a style. */
function node(className = "", extra = {}) {
  const props = {};
  return {
    className,
    classList: classList(),
    dataset: {},
    attrs: {},
    listeners: {},
    children: [],
    hidden: false,
    inert: false,
    textContent: "",
    replaced: 0,
    style: {
      props,
      setProperty(k, v) { props[k] = v; },
      removeProperty(k) { delete props[k]; },
    },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...kids) { this.children = kids; this.replaced += 1; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    ...extra,
  };
}

/** A `document` whose only job is to make the nodes the fan builds. */
function stubDocument() {
  return {
    createElement(tag) {
      if (tag === "template") return { innerHTML: "", content: { cloneNode: () => node("svg") } };
      return node();
    },
  };
}

/** Run `fn` with `globalThis[name]` set to `value`, and put it back afterwards. */
function withGlobal(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const before = globalThis[name];
  globalThis[name] = value;
  try {
    return fn();
  } finally {
    if (had) globalThis[name] = before;
    else delete globalThis[name];
  }
}

/** A card in the fan, with the computed size layoutHand reads off it. */
const fanCard = (id) => {
  const n = node("card-face-wrap");
  n.dataset.cardId = id;
  n.computed = { width: "70px", height: "98px" };
  return n;
};

/**
 * `#hand`, holding its `.hand__row`s. `querySelectorAll` answers the two
 * selectors the fan asks it, over whatever rows it is holding NOW — so a
 * re-split is visible to the next call, as it is in a browser.
 */
function stubHand(rows) {
  const hand = node("hand", {
    computed: { paddingLeft: "0", paddingRight: "0", rowGap: "8", getPropertyValue: () => "" },
    querySelectorAll(sel) {
      const kids = this.children.filter((c) => c.className === "hand__row");
      if (sel === ".hand__row") return kids;
      if (sel === ".card-face-wrap") return kids.flatMap((row) => row.children);
      throw new Error(`the stub hand was asked for ${sel}`);
    },
  });
  hand.children = rows.map((ids) => {
    const row = node("hand__row");
    row.children = ids.map(fanCard);
    Object.defineProperty(row, "childElementCount", { get() { return this.children.length; } });
    return row;
  });
  return hand;
}

/** The element table, with only what the fan reads. */
function stubEl({ hand, rowWidth = 375, railWidth = 80 } = {}) {
  return {
    hand: hand || stubHand([]),
    handRow: { clientWidth: rowWidth },
    handRail: { offsetWidth: railWidth },
    handSort: node("hand-sort"),
    stageRow: node("stage-row"),
    stageTray: node("stage-tray"),
    // A middle with no height: `handSlack` reads that as "no room to spare",
    // which pins the fan to one row unless a test says otherwise.
    feltMiddle: { clientHeight: 0, children: [] },
    screen: { scrollHeight: 0, clientHeight: 0 },
    log: node("log"),
  };
}

/** The fan, with every dependency a recorder or a fixed answer. */
function fanWith({ el = stubEl(), session = {}, state = null, pack = { id: "hearts" } } = {}) {
  const calls = { render: [], onHandCard: [] };
  const fan = createHandFan({
    el,
    session: () => session,
    drag: () => null,
    gestures: () => null,
    mySeat: () => 0,
    liveState: () => state,
    livePack: () => pack,
    render: (s) => calls.render.push(s),
    cardById: (s, id) => ({ id, rank: 7, suit: "hearts" }),
    art: () => ({ face: (card) => `<svg data-card="${card.id}"></svg>` }),
    hintedCard: () => false,
    markEntry: () => {},
    committedSelectionOf: () => null,
    onHandCard: (...args) => calls.onHandCard.push(args),
  });
  return { fan, el, session, calls };
}

const computed = (n) => n.computed;

/* ------------------------------------------------------------------ *
 * Where a dropped card lands
 * ------------------------------------------------------------------ */

const band = (top, bottom) => ({ rect: { top, bottom } });

test("a release point belongs to the row it is in, or to the nearest one", () => {
  const rows = [band(0, 100), band(110, 210)];
  assert.strictEqual(nearestRow(rows, 50), rows[0], "inside the top row");
  assert.strictEqual(nearestRow(rows, 150), rows[1], "inside the second row");
  assert.strictEqual(nearestRow(rows, -40), rows[0], "above the fan is the top row, not nothing");
  assert.strictEqual(nearestRow(rows, 400), rows[1], "below the fan is the bottom row");
  assert.strictEqual(nearestRow(rows, 107), rows[1], "in the gap, the closer row");
});

/**
 * A two-row fan with its geometry: row 0 holds a b c at y 0–100, row 1 holds
 * d e f at y 110–210, and each row's cards step 30px from x = 0.
 */
function twoRowFan() {
  const layout = [["a", "b", "c"], ["d", "e", "f"]];
  const hand = node("hand", {
    querySelectorAll(sel) {
      if (sel !== ".hand__row") throw new Error(`the stub hand was asked for ${sel}`);
      return layout.map((ids, r) => ({
        getBoundingClientRect: () => ({ top: r * 110, bottom: r * 110 + 100 }),
        querySelectorAll: () => ids.map((id, i) => ({
          dataset: { cardId: id },
          getBoundingClientRect: () => ({ left: i * 30, width: 70 }),
        })),
      }));
    },
  });
  return stubEl({ hand });
}

test("a card dropped on a two-row fan lands by ROW first, then by place in it (#134)", () => {
  installArcade({ state: true });
  const state = { id: "live" };
  const session = { displayedHand: ["a", "b", "c", "d", "e", "f"], handPrefs: { mode: "suit", order: [] } };
  const { fan, calls } = fanWith({ el: twoRowFan(), session, state });

  // x = 40 is over the second card's half in EITHER row. At y = 150 that is
  // the bottom row's `e` slot; at y = 50 it is the top row's `b` slot. x alone
  // would give both drops the same answer, which is the #134 bug.
  fan.reorderHandAt("f", 40, 150);
  assert.deepStrictEqual(session.handPrefs.order, reorder(["a", "b", "c", "d", "e", "f"], "f", 4),
    "the index must be the bottom row's offset (3) plus the place in that row (1)");
  assert.deepStrictEqual(session.handPrefs.order, ["a", "b", "c", "d", "f", "e"]);
  assert.strictEqual(session.handPrefs.mode, "manual",
    "rearranging by hand says 'my order' — the mode follows the gesture");
  assert.deepStrictEqual(loadHandPrefs("hearts"), session.handPrefs,
    "the arrangement must be saved under the pack the moment it is made");
  assert.deepStrictEqual(calls.render, [state], "and the felt redrawn from the live state");

  fan.reorderHandAt("f", 40, 50);
  assert.deepStrictEqual(session.handPrefs.order, ["a", "f", "b", "c", "d", "e"],
    "the same x in the top row is the top row's place");

  // Past the last card's middle of the bottom row is the end of the hand.
  session.displayedHand = ["a", "b", "c", "d", "e", "f"];
  fan.reorderHandAt("a", 500, 400);
  assert.deepStrictEqual(session.handPrefs.order, ["b", "c", "d", "e", "f", "a"]);
});

/**
 * #256: while a card is dragged its own node stays in the fan (hidden, holding
 * its slot), but `reorder` takes an index in the hand WITHOUT that card. So a
 * rightward drop must not count the card being carried — the leftward drops
 * above never pass it, which is why they could not see the bug.
 */
test("a card dragged RIGHT lands just before the card it is released on (#256)", () => {
  installArcade({ state: true });
  const hand = ["a", "b", "c", "d", "e", "f"];
  const session = { displayedHand: hand, handPrefs: { mode: "suit", order: [] } };
  const { fan } = fanWith({ el: twoRowFan(), session, state: { id: "live" } });

  // Same row: `a` released on the left half of `c` (c spans 60–130, middle 95).
  fan.reorderHandAt("a", 70, 50);
  assert.deepStrictEqual(session.handPrefs.order, ["b", "a", "c", "d", "e", "f"],
    "released on c's left half, a sits immediately before c — not after it");

  // Across rows: `b` carried down onto the left half of `e` (e spans 30–100).
  fan.reorderHandAt("b", 40, 150);
  assert.deepStrictEqual(session.handPrefs.order, ["a", "c", "d", "b", "e", "f"],
    "the rows above must not count the carried card either");

  // Past the last card's middle of the bottom row is still the end of the hand.
  fan.reorderHandAt("c", 500, 150);
  assert.deepStrictEqual(session.handPrefs.order, ["a", "b", "d", "e", "f", "c"]);
});

test("a drop with no live table rearranges nothing", () => {
  installArcade({ state: true });
  const session = { displayedHand: ["a", "b"], handPrefs: { mode: "auto", order: [] } };
  const { fan, calls } = fanWith({ el: twoRowFan(), session, state: null });
  fan.reorderHandAt("a", 40, 150);
  assert.deepStrictEqual(session.handPrefs, { mode: "auto", order: [] });
  assert.strictEqual(calls.render.length, 0);
});

test("cycling away from 'my order' keeps the arrangement to come back to", () => {
  installArcade({ state: true });
  const state = { id: "live" };
  const session = { displayedHand: ["c", "a", "b"], handPrefs: { mode: "manual", order: ["x"] } };
  const { fan, calls } = fanWith({ session, state });

  fan.cycleHandSort();
  assert.deepStrictEqual(session.handPrefs, { mode: "auto", order: ["c", "a", "b"] },
    "leaving manual must keep the permutation the player is LOOKING at, not a stale one");

  // A sorted view is a glance: the permutation rides through it untouched.
  session.displayedHand = ["a", "b", "c"];
  fan.cycleHandSort();
  fan.cycleHandSort();
  assert.deepStrictEqual(session.handPrefs, { mode: "rank", order: ["c", "a", "b"] },
    "a sort must not overwrite the manual order with its own");
  fan.cycleHandSort();
  assert.deepStrictEqual(session.handPrefs, { mode: "manual", order: ["c", "a", "b"] },
    "and cycling round to 'my order' brings the arrangement back");
  assert.deepStrictEqual(loadHandPrefs("hearts"), session.handPrefs);
  assert.strictEqual(calls.render.length, 4);
});

/* ------------------------------------------------------------------ *
 * What the fan is laid out against
 * ------------------------------------------------------------------ */

const tenCards = () => stubHand([["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"]]);

test("the fan leaves the rail its width when the rail stands beside it, and none when it is a band", () => {
  // The contract tests/handRail.test.js pins from the stylesheet side ("the
  // rail is still the fixed width the fan is laid out against"), from this one.
  withGlobal("getComputedStyle", computed, () => {
    const beside = fanWith({ el: stubEl({ hand: tenCards(), rowWidth: 375, railWidth: 80 }) });
    beside.fan.layoutHand();
    // 375 of row, less the rail and its 12px gutter, less the 4px of slack.
    const narrow = fanStep({ count: 10, cardWidth: 70, available: 375 - 80 - 12 - 4 });
    assert.strictEqual(beside.el.hand.style.props["--fan-step"], `${narrow.toFixed(2)}px`);

    // A rail as wide as the row has stood down into its own band above the fan
    // (the portrait phone, #134), and the fan may have all of the row.
    const banded = fanWith({ el: stubEl({ hand: tenCards(), rowWidth: 375, railWidth: 375 }) });
    banded.fan.layoutHand();
    const wide = fanStep({ count: 10, cardWidth: 70, available: 375 - 4 });
    assert.strictEqual(banded.el.hand.style.props["--fan-step"], `${wide.toFixed(2)}px`);
    assert.ok(wide > narrow, "a band leaves the fan more room than a rail beside it");
  });
});

test("a row with no width yet leaves the stylesheet's fan in place", () => {
  withGlobal("getComputedStyle", computed, () => {
    const session = {};
    const { fan, el } = fanWith({ el: stubEl({ hand: tenCards(), rowWidth: 0 }), session });
    fan.layoutHand();
    assert.deepStrictEqual(el.hand.style.props, {},
      "measuring a hidden table computes 'no room at all' and pins the fan shut");
    assert.strictEqual(session.handFit, undefined, "and nothing is cached off a zero");
  });
});

test("the row count is cached against its measurements, so a re-measure cannot flip it", () => {
  withGlobal("document", stubDocument(), () => withGlobal("getComputedStyle", computed, () => {
    const session = {};
    const { fan, el } = fanWith({ el: stubEl({ hand: tenCards() }), session });
    fan.layoutHand();
    assert.strictEqual(session.handFit.rows, 1);
    const key = session.handFit.key;
    assert.match(key, /^10:70:98:/, "the key is made of the measurements the answer depends on");

    // Same measurements, a cached answer of two rows: the fan must take the
    // cache's word for it rather than re-deciding (and flipping back to one).
    session.handFit = { key, rows: 2 };
    fan.layoutHand();
    assert.deepStrictEqual(el.hand.children.map((row) => row.children.length), [5, 5],
      "the cached row count was not consulted");
    assert.deepStrictEqual(session.handFit, { key, rows: 2 });
  }));
});

test("a relayout in the same shape touches no card", () => {
  withGlobal("document", stubDocument(), () => {
    const hand = stubHand([["a", "b", "c"], ["d", "e"]]);
    const { fan, el } = fanWith({ el: stubEl({ hand }) });
    const cards = hand.querySelectorAll(".card-face-wrap");

    // Re-parenting restarts a card's animations and drops a pointer capture on
    // it, and this runs on every render and every resize notification.
    assert.strictEqual(fan.placeHandRows(cards, 2), 3);
    assert.strictEqual(el.hand.replaced, 0, "the same shape must not rebuild the rows");

    assert.strictEqual(fan.placeHandRows(cards, 1), 5);
    assert.strictEqual(el.hand.replaced, 1);
    assert.deepStrictEqual(el.hand.children.map((row) => row.children.map((c) => c.dataset.cardId)),
      [["a", "b", "c", "d", "e"]], "a new shape deals the cards left to right, top to bottom");
  });
});

test("the felt's spare height is the union of what the middle holds, read as if the hand had one row", () => {
  const child = (offsetTop, offsetHeight, hidden = false) => ({ offsetTop, offsetHeight, hidden });
  const el = stubEl({ hand: stubHand([["a"], ["b"]]) });
  // Piles at 0–60 and a shared board wrapped under them at 70–100 (#136): the
  // content is 100 tall, not the 60 of the tallest child. The hidden one is
  // not on the felt at all.
  el.feltMiddle = { clientHeight: 180, children: [child(0, 60), child(70, 30), child(0, 900, true)] };
  const { fan } = fanWith({ el });
  // Two rows on the felt already: the second one's 90px is given back, or the
  // fan would drop to one row, find the room again, and flip on every render.
  assert.strictEqual(fan.handSlack(90), 180 - 100 + 90);

  // A felt that has already outgrown the screen has no room to give.
  el.screen = { scrollHeight: 1000, clientHeight: 900 };
  assert.strictEqual(fan.handSlack(90), 180 - 100 - 100 + 90);
});

test("the width observer watches the ROW, and re-fans only while a match is live", () => {
  const observed = [];
  const callbacks = [];
  class FakeObserver {
    constructor(cb) { callbacks.push(cb); }
    observe(target) { observed.push(target); }
  }
  withGlobal("ResizeObserver", FakeObserver, () => withGlobal("getComputedStyle", computed, () => {
    let state = null;
    const el = stubEl({ hand: tenCards() });
    const fan = createHandFan({
      el, session: () => ({}), drag: () => null, gestures: () => null, mySeat: () => 0,
      liveState: () => state, livePack: () => null, render() {}, cardById() {}, art() {},
      hintedCard() {}, markEntry() {}, committedSelectionOf() {}, onHandCard() {},
    });
    fan.watchHandWidth();
    assert.deepStrictEqual(observed, [el.handRow],
      "watching #hand would be a feedback loop — the fan changes the hand's own width");
    callbacks[0]();
    assert.deepStrictEqual(el.hand.style.props, {}, "no live match, no relayout");
    state = { id: "live" };
    callbacks[0]();
    assert.ok(el.hand.style.props["--fan-step"], "a width change re-fans the live hand");
  }));
});

test("with no ResizeObserver the fan falls back to the window's resize", () => {
  const listeners = [];
  withGlobal("ResizeObserver", undefined, () => withGlobal("window", {
    addEventListener: (type, fn) => listeners.push(type),
  }, () => {
    fanWith().fan.watchHandWidth();
  }));
  assert.deepStrictEqual(listeners, ["resize"]);
});

/* ------------------------------------------------------------------ *
 * The tray
 * ------------------------------------------------------------------ */

const gatheringState = (gathers = true) => ({ pack: { id: "hearts", template: { gathers: () => gathers } } });

test("an empty tray is inert and says what it is for", () => {
  const { fan, el } = fanWith({ session: { selection: null } });
  fan.renderStageTray(gatheringState(), { action: null });
  assert.strictEqual(el.stageRow.hidden, false, "a gathering seat keeps the slot (#13)");
  assert.strictEqual(el.stageRow.inert, true);
  assert.ok(el.stageRow.classList.contains("stage-row--empty"));
  assert.strictEqual(el.stageTray.attrs["aria-label"], "Gathered cards appear here.");

  fan.renderStageTray(gatheringState(false), { action: null });
  assert.strictEqual(el.stageRow.hidden, true, "a seat that is not gathering has no row at all");
});

test("the tray says no, once, in its own name (#122)", () => {
  withGlobal("document", stubDocument(), () => {
    const selection = { from: "hand.0", cardIds: ["hearts-7", "hearts-8"] };
    const session = { selection, lastRefusal: null };
    const { fan, el, calls } = fanWith({ session });
    const ui = { action: { disabled: true, refusal: "A run needs three cards." } };

    fan.renderStageTray(gatheringState(), ui);
    assert.strictEqual(el.stageRow.inert, false, "a tray holding cards answers taps");
    assert.ok(el.stageTray.classList.contains("stage-tray--refused"));
    assert.strictEqual(el.log.textContent, "A run needs three cards.");
    assert.strictEqual(el.stageTray.attrs["aria-label"],
      "Gathered: 2 cards. A run needs three cards. Tap one to put it back.");
    assert.deepStrictEqual(el.stageTray.children.map((c) => c.dataset.cardId), ["hearts-7", "hearts-8"],
      "in the order they were picked");

    // A repaint for some other reason must not say it again.
    el.log.textContent = "Wren played.";
    fan.renderStageTray(gatheringState(), ui);
    assert.strictEqual(el.log.textContent, "Wren played.", "the refusal was written to #log twice");

    // Tapping a gathered card runs the fan's own toggle on it.
    el.stageTray.children[1].listeners.click[0]();
    assert.strictEqual(calls.onHandCard.length, 1);
    assert.strictEqual(calls.onHandCard[0][1], "hearts-8");

    fan.renderStageTray(gatheringState(), { action: { disabled: false } });
    assert.ok(!el.stageTray.classList.contains("stage-tray--refused"));
    assert.strictEqual(session.lastRefusal, null);
  });
});

test("Enter and Space act on a focused card, and nothing else does", () => {
  const card = node();
  let acted = 0;
  activateOnKey(card, () => { acted += 1; });
  const press = (key) => {
    let prevented = false;
    card.listeners.keydown[0]({ key, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.strictEqual(press("Enter"), true);
  assert.strictEqual(press(" "), true, "Space must not scroll the felt from under the focus ring");
  assert.strictEqual(press("a"), false);
  assert.strictEqual(acted, 2);
});

/* ------------------------------------------------------------------ *
 * The wiring, which only table.js can do
 * ------------------------------------------------------------------ */

test("table.js installs the width observer and the sort toggle's listener", () => {
  // A GREP, and the only one here: `initTable` is where the fan is handed the
  // element table and its listeners are attached, and table.js still resolves
  // its ids at import. Everything the two calls DO is driven above.
  const table = fs.readFileSync(path.join(ROOT, "src/ui/table.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const init = table.slice(table.indexOf("export function initTable("));
  assert.match(init, /\n\s*handFan = createHandFan\(\{/, "initTable must construct the fan");
  assert.match(init, /\n\s*handFan\.watchHandWidth\(\);/,
    "the observer is never installed: the fan keeps whatever it guessed at boot");
  assert.match(init, /el\.handSort\.addEventListener\('click', \(\) => handFan\.cycleHandSort\(\)\)/,
    "the sort toggle does nothing when tapped");
});
