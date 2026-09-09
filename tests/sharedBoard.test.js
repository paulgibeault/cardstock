// THE SHARED BOARD, WITHOUT A BROWSER.
//
// The same split, and the same reason, as tests/counterTrack.test.js:
// src/ui/table.js touches `document` at import time so no `node --test` can
// load the felt, and a board whose geometry is only ever checked by looking at
// it is a board whose geometry is never checked. The model is pure and the
// renderer takes the document as a parameter, so both halves are assertable
// here — the numbers directly, the element through a document stub small
// enough to read.
//
// What this is protecting, beyond the arithmetic: a lane is a POSITION drawn
// as a picture, so every way of getting it wrong looks like a game rather than
// a bug. A lane measured against its own road instead of the board's is a seat
// that is drawn level with one it is nowhere near. A rebuilt board is a peg
// that teleports instead of moving, which looks like nothing at all.
import { test } from "node:test";
import assert from "node:assert";
import {
  sharedBoard, renderSharedBoard, updateSharedBoard, HOLES_PER_TICK, HOLES_PER_STREET,
} from "../src/ui/sharedBoard.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk, listPackIds } from "../tools/pack-test.mjs";

/** The smallest document that can hold what renderSharedBoard builds. */
function stubDocument() {
  const make = (tag) => ({
    tag,
    className: "",
    textContent: "",
    dataset: {},
    style: { setProperty(name, value) { this[name] = String(value); } },
    attrs: {},
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
  });
  return { createElement: make };
}

const findAll = (node, className) => {
  const out = node.className?.split(" ").includes(className) ? [node] : [];
  for (const child of node.children) out.push(...findAll(child, className));
  return out;
};
const find = (node, className) => findAll(node, className)[0] || null;
/** The element a `left: n%` on `node` is actually a percentage OF. */
const parentOf = (root, node) => {
  if (root.children.includes(node)) return root;
  for (const child of root.children) {
    const hit = parentOf(child, node);
    if (hit) return hit;
  }
  return null;
};

/** A seat entry of the shape src/ui/table.js's `sharedBoardFor` hands over. */
const seat = (n, value, from, extra = {}) => ({
  seat: n,
  name: extra.name ?? `Seat ${n}`,
  mark: extra.mark ?? "S",
  color: extra.color ?? "#336699",
  mine: !!extra.mine,
  partner: !!extra.partner,
  side: extra.side ?? null,
  counter: {
    text: String(value),
    aria: `${value} of ${extra.of ?? 121}${value > from ? `, up ${value - from}` : ""}`,
    label: extra.label ?? "Pegs",
    kind: extra.kind ?? "peg",
    value,
    from,
    of: extra.of ?? 121,
  },
});

test("a table whose counters are quantities has no board at all", () => {
  assert.strictEqual(sharedBoard(null), null);
  assert.strictEqual(sharedBoard([]), null, "no seats is no board");
  assert.strictEqual(
    sharedBoard([seat(0, 5, 0, { kind: "hand" }), seat(1, 5, 0, { kind: "hand" })]),
    null,
    "a kind this build does not draw as a road gets no lane, and no lanes is no board");
  assert.strictEqual(sharedBoard([{ seat: 0, counter: { text: "5", kind: "peg" } }]), null,
    "the kind alone is not enough — a lane needs where it is and how long the road is");
  assert.strictEqual(sharedBoard([seat(0, 5, 0, { of: 0 })]), null,
    "a road of length zero has no positions on it");
});

test("one lane per seat that has one, in the order they were handed over", () => {
  // The caller owns ring order (src/ui/seatRing.js) and this component owns
  // nothing about seating — so the assertion is that it does NOT reorder.
  const board = sharedBoard([
    seat(2, 30, 20, { name: "Nell" }),
    seat(1, 44, 44, { name: "Wren" }),
    seat(0, 61, 55, { name: "You", mine: true }),
  ]);
  assert.deepStrictEqual(board.lanes.map((l) => l.seat), [2, 1, 0]);
  assert.deepStrictEqual(board.lanes.map((l) => l.name), ["Nell", "Wren", "You"]);
  assert.strictEqual(board.lanes[2].mine, true);
  assert.strictEqual(board.key, "peg:121:2,1,0",
    "the key is what tells `the same board, repainted` from `a different board`");

  // A seat whose counter is not a road is simply not on it, and the rest are.
  const mixed = sharedBoard([seat(0, 10, 0), seat(1, 4, 0, { kind: "hand" }), seat(2, 20, 0)]);
  assert.deepStrictEqual(mixed.lanes.map((l) => l.seat), [0, 2]);
});

test("every lane is a percentage of the SAME road, and the road is the longest one", () => {
  // Two seats playing to different targets is not a table this build ships,
  // and drawing each against its own `of` is exactly how it would go wrong
  // silently: 60 of 61 and 60 of 121 would be drawn at the same place, which
  // says the two seats are level when one of them has nearly won.
  const board = sharedBoard([seat(0, 60, 0, { of: 61 }), seat(1, 60, 0, { of: 121 })]);
  assert.strictEqual(board.of, 121);
  assert.ok(Math.abs(board.lanes[0].frontPct - (60 / 121) * 100) < 1e-9);
  assert.ok(Math.abs(board.lanes[1].frontPct - (60 / 121) * 100) < 1e-9);

  const plain = sharedBoard([seat(0, 60, 48)]);
  assert.ok(Math.abs(plain.lanes[0].frontPct - (60 / 121) * 100) < 1e-9);
  assert.ok(Math.abs(plain.lanes[0].backPct - (48 / 121) * 100) < 1e-9);
  assert.strictEqual(plain.lanes[0].together, false);
});

test("a peg is clamped onto the road, and the back one never passes the front", () => {
  const start = sharedBoard([seat(0, 0, 0)]).lanes[0];
  assert.deepStrictEqual([start.frontPct, start.backPct, start.together], [0, 0, true],
    "both pegs start in the same hole");

  // Cribbage's `peg` adds the whole score and then asks whether the seat is
  // out, so a match can genuinely finish 130 against a target of 121 (#124's
  // closing note). Drawn at the end of the road rather than past it.
  assert.strictEqual(sharedBoard([seat(0, 121, 118)]).lanes[0].frontPct, 100);
  assert.strictEqual(sharedBoard([seat(0, 130, 118)]).lanes[0].frontPct, 100);

  const backwards = sharedBoard([seat(0, 30, 44)]).lanes[0];
  assert.strictEqual(backwards.backPct, backwards.frontPct,
    "a score that went backwards is not a thing in this genre; clamped, not drawn");
  assert.strictEqual(backwards.together, true);
});

test("the ruler is in holes: a tick every five, a number every thirty", () => {
  const board = sharedBoard([seat(0, 0, 0)]);
  assert.ok(Math.abs(board.tickPct - (HOLES_PER_TICK / 121) * 100) < 1e-9,
    "the tick spacing is a percentage of the ROAD, so a mark is a hole at every width");
  assert.ok(Math.abs(board.streetPct - (HOLES_PER_STREET / 121) * 100) < 1e-9);

  // 30, 60, 90 — and NOT 120. The end of the road already carries a number and
  // "120 121" five pixels apart is two numbers where the player wanted one.
  assert.deepStrictEqual(board.streets.map((s) => s.hole), [30, 60, 90]);
  for (const street of board.streets) {
    assert.ok(Math.abs(street.pct - (street.hole / 121) * 100) < 1e-9,
      `street ${street.hole} is not at ${street.hole}/121 of the road`);
  }

  // A road long enough for its last street to stand clear of the end keeps it.
  assert.deepStrictEqual(sharedBoard([seat(0, 0, 0, { of: 180 })]).streets.map((s) => s.hole),
    [30, 60, 90, 120, 150]);
  // A road shorter than two streets is not numbered at all rather than
  // numbered once in the middle.
  assert.deepStrictEqual(sharedBoard([seat(0, 0, 0, { of: 40 })]).streets, []);
  // And a road so long that its fives would be a grey bar gets no ruler at all
  // — a scale nobody can count by is not orientation, it is texture pretending.
  assert.strictEqual(sharedBoard([seat(0, 0, 0, { of: 400 })]).tickPct, null);
});

test("the rendered board is one lane per seat, each one image with one name", () => {
  const doc = stubDocument();
  const model = sharedBoard([
    seat(1, 52, 44, { name: "Nell", mark: "N", color: "#c05" }),
    seat(0, 45, 39, { name: "You", mine: true, color: "#05c" }),
  ]);
  const handle = renderSharedBoard(model, doc);
  assert.ok(handle, "a well-formed board rendered nothing");
  const { node } = handle;

  assert.strictEqual(node.dataset.board, "peg");
  assert.strictEqual(node.attrs.role, "group");
  assert.strictEqual(node.attrs["aria-label"], "Pegs");
  assert.strictEqual(node.style["--board-tick"], `${((5 / 121) * 100).toFixed(2)}%`);
  assert.strictEqual(node.style["--board-street"], `${((30 / 121) * 100).toFixed(2)}%`);

  const lanes = findAll(node, "board__lane");
  assert.strictEqual(lanes.length, 2);
  assert.strictEqual(lanes[0].attrs.role, "img");
  assert.strictEqual(lanes[0].attrs["aria-label"], "Nell: 52 of 121, up 8");
  assert.strictEqual(lanes[1].attrs["aria-label"], "You: 45 of 121, up 6");
  assert.ok(lanes[1].className.includes("board__lane--mine"));
  assert.ok(!lanes[0].className.includes("board__lane--mine"));

  // ONE NAME FOR THE WHOLE LANE. Two pegs, a rail, a mark and a number
  // announced individually would be worse than the bare score they replace.
  for (const cls of ["board__mark", "board__name", "board__rail", "board__peg", "board__value",
    "board__scale"]) {
    for (const part of findAll(node, cls)) {
      assert.strictEqual(part.attrs["aria-hidden"], "true", `${cls} is announced`);
    }
  }

  // A PERCENTAGE IS ONLY A NUMBER UNTIL YOU SAY OF WHAT (#124, and the reason
  // that issue's peg walked off the board): `left` in percent is a percentage
  // of the containing block, so a peg parented to the lane would be measured
  // against the rail PLUS the mark, the name and the printed score beside it.
  const railOf = (lane) => find(lane, "board__rail");
  for (const lane of lanes) {
    for (const peg of findAll(lane, "board__peg")) {
      assert.strictEqual(parentOf(node, peg), railOf(lane),
        "a peg's `left` is a percentage of its containing block — parent it to anything "
        + "but the rail and the percentage is of the rail plus whatever sits beside it");
    }
    assert.ok(!railOf(lane).children.includes(find(lane, "board__value")),
      "the printed number must stay OUT of the rail, or it becomes part of the road");
  }

  const front = (lane) => findAll(lane, "board__peg").find((p) => p.className.includes("--front"));
  const back = (lane) => findAll(lane, "board__peg").find((p) => p.className.includes("--back"));
  assert.strictEqual(front(lanes[0]).style.left, `${((52 / 121) * 100).toFixed(2)}%`);
  assert.strictEqual(back(lanes[0]).style.left, `${((44 / 121) * 100).toFixed(2)}%`);
  assert.strictEqual(front(lanes[0]).style.background, "#c05",
    "a peg is the seat's own colour, so which lane is whose survives a glance");
  assert.strictEqual(find(lanes[1], "board__value").textContent, "45",
    "the number is still printed — the road is a picture of it, not a replacement");
  assert.strictEqual(find(lanes[1], "board__mark").textContent, "S");

  // The streets, printed once under both lanes, and the road's own length
  // closing the line: "45" is not a position until you know what it is out of.
  assert.deepStrictEqual(findAll(node, "board__scale-num").map((n) => n.textContent),
    ["30", "60", "90"]);
  assert.strictEqual(find(node, "board__target").textContent, "121");
});

test("a score REPAINTS the board it is already on, and never a different one", () => {
  // This is the whole reason `updateSharedBoard` exists. An element created
  // fresh at 37% has never been anywhere else, so its one-shot transition on
  // `left` has no old value to run from: rebuild the board on every render and
  // the pegs teleport, which is the one piece of motion this component is
  // allowed never happening at all.
  const doc = stubDocument();
  const before = sharedBoard([seat(1, 52, 44, { name: "Nell" }), seat(0, 45, 39, { name: "You" })]);
  const handle = renderSharedBoard(before, doc);
  const myFront = handle.lanes.get(0).front;
  const myValue = handle.lanes.get(0).value;

  const after = sharedBoard([seat(1, 52, 44, { name: "Nell" }), seat(0, 53, 45, { name: "You" })]);
  assert.strictEqual(updateSharedBoard(handle, after), true);
  assert.strictEqual(handle.lanes.get(0).front, myFront, "the peg was replaced, not moved");
  assert.strictEqual(myFront.style.left, `${((53 / 121) * 100).toFixed(2)}%`);
  assert.strictEqual(handle.lanes.get(0).back.style.left, `${((45 / 121) * 100).toFixed(2)}%`);
  assert.strictEqual(myValue.textContent, "53");
  assert.strictEqual(handle.lanes.get(0).row.attrs["aria-label"], "You: 53 of 121, up 8");

  // `data-together` has to come OFF again, or a seat that has scored keeps the
  // rule that fans its two pegs apart and reads as never having moved.
  const level = sharedBoard([seat(1, 52, 52, { name: "Nell" }), seat(0, 53, 53, { name: "You" })]);
  assert.strictEqual(updateSharedBoard(handle, level), true);
  assert.strictEqual(handle.lanes.get(0).row.dataset.together, "true");
  assert.strictEqual(updateSharedBoard(handle, after), true);
  assert.strictEqual(handle.lanes.get(0).row.dataset.together, undefined);

  // A DIFFERENT BOARD IS A DIFFERENT BOARD. New seats, or a new road, and the
  // handle says so rather than painting one game's numbers onto another's
  // lanes.
  assert.strictEqual(updateSharedBoard(handle, sharedBoard([seat(0, 5, 0)])), false);
  assert.strictEqual(updateSharedBoard(handle, sharedBoard([
    seat(1, 52, 44, { of: 61 }), seat(0, 45, 39, { of: 61 })])), false);
  assert.strictEqual(updateSharedBoard(null, after), false);
});

test("cribbage's own seats make a board, and every other pack's make none", async () => {
  // The end-to-end claim, asserted through the template registry rather than a
  // pack id: the board on the felt comes from `seatCounters` and nothing else,
  // and a pack that has never heard of it gets no row on the table.
  let boarded = 0;
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    const seats = Math.max(2, Math.min(4, pack.manifest.players.max));
    const state = createState({ pack, seats, seed: `board:${packId}` });
    pack.template.setup(makeCtx(state));

    const board = sharedBoard(Array.from({ length: seats }, (_, s) => ({
      seat: s,
      name: `Seat ${s}`,
      counter: pack.template.seatCounters?.(makeCtx(state), s)?.[0],
    })));
    if (!board) continue;
    boarded++;
    assert.strictEqual(board.lanes.length, seats, "every seat at a boarded table gets a lane");
    assert.strictEqual(board.of, pack.rules.target, "the road is as long as the pack says");
    for (const lane of board.lanes) {
      assert.strictEqual(lane.value, state.scores[lane.seat], "a front peg is the seat's score");
      assert.strictEqual(lane.frontPct, 0, "a fresh deal has pegged nothing");
    }
  }
  assert.strictEqual(boarded, 1,
    "exactly one shipped pack draws a board — if that changed, say so here");
});
