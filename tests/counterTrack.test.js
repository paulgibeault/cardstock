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
import { counterTrack, renderCounterTrack, COUNTER_TRACK_KINDS } from "../src/ui/counterTrack.js";
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
