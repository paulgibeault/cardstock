// THE BOARD, WITHOUT A BROWSER.
//
// src/ui/table.js touches `document` at import time, so no Node test can load
// the seat renderer — which is exactly why the track was built as its own
// module with the DOM passed in rather than reached for. This asserts the two
// halves separately: the geometry, which is pure, and the element it builds,
// through a document stub small enough to read.
//
// What it is protecting: a track is the only counter whose VALUE is a position
// rather than a quantity, so the failure mode is silent. A peg drawn at 0%
// because the numbers were named differently looks like a game that has not
// started, not like a bug.
import { test } from "node:test";
import assert from "node:assert";
import {
  counterTrack, renderCounterTrack, COUNTER_TRACK_KINDS,
  counterPips, renderCounterPips, COUNTER_PIP_KINDS, MAX_PIPS,
} from "../src/ui/counterTrack.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk, listPackIds } from "../tools/pack-test.mjs";

/** The smallest document that can hold what renderCounterTrack builds. */
function stubDocument() {
  const make = (tag) => {
    const node = {
      tag,
      className: "",
      textContent: "",
      dataset: {},
      style: {},
      attrs: {},
      children: [],
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
    };
    return node;
  };
  return { createElement: make };
}

const find = (node, className) => {
  if (node.className?.split(" ").includes(className)) return node;
  for (const child of node.children) {
    const hit = find(child, className);
    if (hit) return hit;
  }
  return null;
};
const findAll = (node, className) => {
  const out = node.className?.split(" ").includes(className) ? [node] : [];
  for (const child of node.children) out.push(...findAll(child, className));
  return out;
};
/** The element a `left: n%` on `node` is actually a percentage OF. */
const parentOf = (root, node) => {
  if (root.children.includes(node)) return root;
  for (const child of root.children) {
    const hit = parentOf(child, node);
    if (hit) return hit;
  }
  return null;
};

test("a counter with no track kind, or no numbers, is not a track", () => {
  assert.strictEqual(counterTrack(null), null);
  assert.strictEqual(counterTrack({ text: "5", aria: "5 cards" }), null,
    "a counter with no kind at all takes the plain badge");
  assert.strictEqual(counterTrack({ text: "5", kind: "hand", value: 5, of: 13 }), null,
    "a kind this build does not draw as a track takes the plain badge");
  assert.strictEqual(counterTrack({ text: "5", kind: "peg" }), null,
    "the kind alone is not enough — a track needs where it is and how long it is");
  assert.strictEqual(counterTrack({ text: "5", kind: "peg", value: 5, of: 0 }), null,
    "a road of length zero has no positions on it");
});

test("the pegs sit where the numbers say, and the back one never passes the front", () => {
  const at = (value, from, of = 121) => counterTrack({ text: String(value), kind: "peg", value, from, of });

  assert.deepStrictEqual(
    { front: at(0, 0).frontPct, back: at(0, 0).backPct, together: at(0, 0).together },
    { front: 0, back: 0, together: true },
    "both pegs start in the same hole");

  const mid = at(60, 48);
  assert.ok(Math.abs(mid.frontPct - (60 / 121) * 100) < 1e-9);
  assert.ok(Math.abs(mid.backPct - (48 / 121) * 100) < 1e-9);
  assert.strictEqual(mid.together, false);

  // Out at 121 is the end of the road and not past it; a peg that overshot
  // would be drawn off the rail.
  assert.strictEqual(at(121, 118).frontPct, 100);
  assert.strictEqual(at(130, 118).frontPct, 100, "a score past the target still draws on the board");

  // A back peg ahead of the front is not a thing in this genre. Clamped rather
  // than drawn, because drawing it reads as a bug in the game rather than in
  // the caller.
  const backwards = at(30, 44);
  assert.strictEqual(backwards.from, 30);
  assert.strictEqual(backwards.backPct, backwards.frontPct);
});

test("the rendered track is one labelled group, two pegs, and a number", () => {
  const doc = stubDocument();
  const counter = { text: "78", aria: "78 of 121, up 12", label: "Pegs", kind: "peg", value: 78, from: 66, of: 121 };
  const node = renderCounterTrack(counter, doc);
  assert.ok(node, "a well-formed peg counter rendered nothing");

  // ONE accessible name for the whole thing. Two pegs and a rail announced
  // individually would be worse than the bare number they replace.
  assert.strictEqual(node.attrs.role, "img");
  assert.strictEqual(node.attrs["aria-label"], "78 of 121, up 12");
  assert.strictEqual(node.dataset.track, "peg");
  for (const part of [...findAll(node, "seat__track-peg"), find(node, "seat__track-rail"),
    find(node, "seat__track-value")]) {
    assert.strictEqual(part.attrs["aria-hidden"], "true", "a decorative part is announced");
  }

  const pegs = findAll(node, "seat__track-peg");
  assert.strictEqual(pegs.length, 2, "a cribbage board has two pegs a side");
  const back = pegs.find((p) => p.className.includes("--back"));
  const front = pegs.find((p) => p.className.includes("--front"));
  assert.strictEqual(front.style.left, `${((78 / 121) * 100).toFixed(2)}%`);
  assert.strictEqual(back.style.left, `${((66 / 121) * 100).toFixed(2)}%`);

  // A PERCENTAGE IS ONLY A NUMBER UNTIL YOU SAY OF WHAT (issue #124). Both pegs
  // above carry the right fraction of 121, and for the first sixty holes of
  // every match they still drew in the right place while being a percentage of
  // the WRONG BOX — the wrap, which is the rail plus the printed number after
  // it. `left: 97.52%` of an 88px wrap put the peg at x=86 on a rail that ended
  // at 57: past every hole, on top of the score it was meant to be pointing at.
  // The geometry assertions above cannot see that, because the bug is not in
  // the geometry; it is in which element the geometry is measured against. So
  // the parent is the assertion.
  const rail = find(node, "seat__track-rail");
  for (const peg of pegs) {
    assert.strictEqual(parentOf(node, peg), rail,
      "a peg's `left` is a percentage of its containing block — parent it to anything "
      + "but the rail and the percentage is of the rail plus whatever sits beside it");
  }
  assert.ok(!rail.children.includes(find(node, "seat__track-value")),
    "the printed number must stay OUT of the rail, or it becomes part of the road");

  assert.strictEqual(find(node, "seat__track-value").textContent, "78",
    "the number is still printed — the track is a picture of it, not a replacement");

  assert.strictEqual(renderCounterTrack({ text: "5", kind: "hand" }, doc), null,
    "a counter that is not a track renders nothing, so the caller falls back to the badge");
});

test("cribbage's own counter is a track, and every other pack's primary is not", async () => {
  // The end-to-end claim, asserted through the template registry rather than a
  // pack id: the board on the felt comes from `seatCounters` and nothing else.
  let tracked = 0;
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    if (!pack.template.seatCounters) continue;
    const seats = Math.max(2, Math.min(4, pack.manifest.players.max));
    const state = createState({ pack, seats, seed: `track:${packId}` });
    pack.template.setup(makeCtx(state));

    const primary = pack.template.seatCounters(makeCtx(state), 1)[0];
    const track = counterTrack(primary);
    if (!track) continue;
    tracked++;
    assert.ok(COUNTER_TRACK_KINDS.includes(track.kind));
    assert.strictEqual(track.value, state.scores[1], "the front peg is the seat's score");
    assert.strictEqual(track.of, pack.rules.target, "the road is as long as the pack says");
    assert.strictEqual(track.frontPct, 0, "a fresh deal has pegged nothing");
  }
  assert.strictEqual(tracked, 1,
    "exactly one shipped pack draws its primary counter as a track — if that changed, say so here");
});

/* ------------------------------------------------------------------ *
 * THE PIP ROW (#148) — a promise, and how much of it is kept
 * ------------------------------------------------------------------ *
 *
 * The other drawn counter, and its failure modes are quieter than the track's.
 * A row that filled from the wrong end, or counted a bag as a trick, would look
 * like a plausible hand rather than like a bug — and it is the number a partner
 * decides their own play on.
 */

test("a counter with no pip kind, or no numbers, is not a pip row", () => {
  assert.strictEqual(counterPips(null), null);
  assert.strictEqual(counterPips({ text: "5", aria: "5 cards" }), null,
    "a counter with no kind at all takes the plain badge");
  assert.strictEqual(counterPips({ text: "4", kind: "bid", bid: 4, taken: 2 }), null,
    "a kind this build does not draw as pips takes the plain badge");
  // The track kinds and the pip kinds are two closed sets and neither answers
  // for the other — a counter must not come out as both.
  assert.strictEqual(counterPips({ text: "78", kind: "peg", value: 78, of: 121 }), null);
  assert.strictEqual(counterTrack({ text: "4", kind: "pips", bid: 4, taken: 2 }), null);
});

test("the row is the bid, filled left to right by the tricks taken", () => {
  const row = (bid, taken, nil = false) => counterPips({ text: String(bid), kind: "pips", bid, taken, nil });

  assert.deepStrictEqual(row(4, 0).pips, ["open", "open", "open", "open"],
    "a bid nobody has started on is four empty rings");
  assert.deepStrictEqual(row(4, 2).pips, ["taken", "taken", "open", "open"],
    "the fill goes LEFT TO RIGHT — a row that filled from the right reads as a different bid");
  assert.deepStrictEqual(row(4, 4).pips, ["taken", "taken", "taken", "taken"],
    "a contract exactly made has no empty ring left");

  // PAST THE PROMISE IS NOT MORE OF THE PROMISE. The extras append in the bag
  // tone, so "made it" and "made it and is two bags up" are not the same
  // picture — which is the whole reason the bid is drawn rather than printed.
  assert.deepStrictEqual(row(3, 5).pips, ["taken", "taken", "taken", "bag", "bag"]);
  assert.strictEqual(row(3, 5).pips.filter((p) => p === "bag").length, 2);
});

test("the two readings that are not circles are the template's own word", () => {
  // A seat that has not spoken. There is no promise to draw a picture of, so
  // the badge text — which trick-taking.js makes "—" — is the whole reading.
  const unbid = counterPips({ text: "—", kind: "pips", bid: null, taken: 0 });
  assert.deepStrictEqual(unbid.pips, [], "an unbid seat drew circles for a bid it has not made");
  assert.strictEqual(unbid.word, "—");

  // A nil promises NO circles, so a row of them would say the opposite of what
  // was promised. What it can collect is the tricks that broke it.
  const nil = counterPips({ text: "nil", kind: "pips", bid: 0, taken: 0, nil: true });
  assert.deepStrictEqual(nil.pips, []);
  assert.strictEqual(nil.word, "nil");
  const broken = counterPips({ text: "nil", kind: "pips", bid: 0, taken: 2, nil: true });
  assert.deepStrictEqual(broken.pips, ["broken", "broken"],
    "a broken nil must not draw its tricks as kept promises");
  // Blind nil is the same shape and a different word, and the word is the
  // template's: nothing in this module invents vocabulary for a bid.
  assert.strictEqual(counterPips({ text: "BN", kind: "pips", bid: 0, taken: 0, nil: true }).word, "BN");

  // An ordinary bid has no word at all — the circles are the reading.
  assert.strictEqual(counterPips({ text: "4", kind: "pips", bid: 4, taken: 1 }).word, null);
});

test("a big bid goes dense rather than wide, and never past MAX_PIPS", () => {
  const at = (bid, taken = 0) => counterPips({ text: String(bid), kind: "pips", bid, taken });
  assert.strictEqual(at(7).dense, false, "seven still fits at full size");
  assert.strictEqual(at(8).dense, true, "eight is where the row starts drawing small");
  assert.strictEqual(at(13).pips.length, MAX_PIPS);
  // The ceiling is a ceiling. A hand cannot take more tricks than it holds
  // cards, but a counter is data and the row must not be able to run off a
  // seat because a template said something impossible.
  assert.strictEqual(at(40, 40).pips.length, MAX_PIPS);
  assert.strictEqual(at(2, 40).pips.length, MAX_PIPS);
});

test("the rendered row is one labelled group of aria-hidden circles", () => {
  const doc = stubDocument();
  const counter = {
    text: "4", aria: "bid 4 tricks, 5 taken, 1 over", label: "Tricks",
    kind: "pips", bid: 4, taken: 5, nil: false,
  };
  const node = renderCounterPips(counter, doc);
  assert.ok(node, "a well-formed pip counter rendered nothing");

  // ONE accessible name, like the track. Five circles announced one at a time
  // would be far worse than the two digits they replace.
  assert.strictEqual(node.attrs.role, "img");
  assert.strictEqual(node.attrs["aria-label"], "bid 4 tricks, 5 taken, 1 over");
  assert.strictEqual(node.dataset.pips, "pips");
  const pips = findAll(node, "seat__pip");
  assert.strictEqual(pips.length, 5, "four promised and one over is five circles");
  for (const pip of pips) {
    assert.strictEqual(pip.attrs["aria-hidden"], "true", "a decorative circle is announced");
    assert.strictEqual(parentOf(node, pip), node, "the circles are the row's own children");
  }
  assert.ok(pips[4].className.includes("seat__pip--bag"), "the overtrick is not drawn as a bag");
  assert.strictEqual(node.dataset.dense, undefined, "five circles must not be drawn small");

  // The word, where there is one, and it is aria-hidden for the same reason.
  const nil = renderCounterPips({ text: "nil", aria: "bid nil, none taken", kind: "pips", bid: 0, taken: 0, nil: true }, doc);
  const word = find(nil, "seat__pips-word");
  assert.ok(word, "a nil rendered no word at all — the row would be empty");
  assert.strictEqual(word.textContent, "nil");
  assert.strictEqual(word.attrs["aria-hidden"], "true");

  assert.strictEqual(renderCounterPips({ text: "5", kind: "hand" }, doc), null,
    "a counter that is not a pip row renders nothing, so the caller falls back to the badge");
});

test("exactly one shipped pack draws a pip row, and it is a TRICK auction", async () => {
  // The end-to-end claim through the template registry rather than a pack id:
  // the row on the felt comes from `seatCounters` and nothing else, and a
  // points auction (Pinochle bids 250) must never reach for it.
  let rows = 0;
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    if (!pack.template.seatCounters) continue;
    const seats = Math.max(2, Math.min(4, pack.manifest.players.max));
    const state = createState({ pack, seats, seed: `pips:${packId}` });
    pack.template.setup(makeCtx(state));

    const counters = pack.template.seatCounters(makeCtx(state), 1);
    const pip = counters.find((c) => counterPips(c));
    if (!pip) continue;
    rows++;
    assert.ok(COUNTER_PIP_KINDS.includes(pip.kind));
    assert.notStrictEqual(pack.rules.bidding?.unit, "points",
      `${packId}: a points auction cannot be a row of circles — 250 of them is not a picture`);
    assert.ok(pip.minimizedOnly,
      `${packId}: the pip row is the MINIMIZED face's counter; an open plate keeps the digits`);
    // ...and the digits it replaces are still declared, still spoken, and
    // marked as the open plate's (the round summary reads them).
    for (const kind of ["bid", "tricks"]) {
      const digits = counters.find((c) => c.kind === kind);
      assert.ok(digits && digits.openOnly,
        `${packId}: the ${kind} digits are gone or still drawn on the face beside the pips`);
    }
  }
  assert.strictEqual(rows, 1,
    "exactly one shipped pack draws a pip row — if that changed, say so here");
});
