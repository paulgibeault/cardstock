// Which drop target a dragged card is over.
//
// The pointer half of dragController.js needs hands on a device. This half —
// "given where the ghost is and where the targets are, which one wins" — is
// arithmetic, and it is the arithmetic that decides whether a released card
// commits a move or snaps home. It is also the piece that changed when the
// rects stopped being re-measured on every pointermove (issue #6), so it is
// worth pinning independently of the DOM it usually reads them from.
import { test } from "node:test";
import assert from "node:assert";
import { pickTarget } from "../src/ui/dragController.js";

/** A rect in the shape getBoundingClientRect returns. */
function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const ghost = rect(100, 100, 60, 90);

test("no overlap means no target — the card snaps home", () => {
  const targets = [{ id: "far", rect: rect(400, 400, 90, 126) }];
  assert.strictEqual(pickTarget(ghost, targets), null);
});

test("an empty target list is an ordinary answer, not a crash", () => {
  assert.strictEqual(pickTarget(ghost, []), null);
});

test("touching edges do not count as overlap", () => {
  // The ghost's right edge is exactly the target's left edge: zero area.
  const targets = [{ id: "abutting", rect: rect(160, 100, 90, 90) }];
  assert.strictEqual(pickTarget(ghost, targets), null);
});

test("the target the ghost covers most wins", () => {
  const small = { id: "small", rect: rect(150, 150, 20, 20) };   // 10x20 = 200
  const big = { id: "big", rect: rect(90, 90, 60, 60) };          // 50x50 = 2500
  assert.strictEqual(pickTarget(ghost, [small, big]).id, "big");
  // Order must not decide it.
  assert.strictEqual(pickTarget(ghost, [big, small]).id, "big");
});

test("a target that never measured is skipped, not dereferenced", () => {
  const unmeasured = { id: "unmeasured", rect: null };
  const real = { id: "real", rect: rect(90, 90, 60, 60) };
  assert.strictEqual(pickTarget(ghost, [unmeasured, real]).id, "real");
  assert.strictEqual(pickTarget(ghost, [unmeasured]), null);
});

test("a tie keeps the first target rather than flickering between them", () => {
  // Two identical rects overlap identically; `area > bestArea` is strict, so
  // the first stays hovered. Hover paint is a class toggle, and a hover that
  // alternated every frame between equal candidates would strobe.
  const a = { id: "a", rect: rect(90, 90, 60, 60) };
  const b = { id: "b", rect: rect(90, 90, 60, 60) };
  assert.strictEqual(pickTarget(ghost, [a, b]).id, "a");
});

test("a target fully containing the ghost is overlapped by the ghost's own area", () => {
  const whole = { id: "whole", rect: rect(0, 0, 400, 400) };
  const sliver = { id: "sliver", rect: rect(155, 100, 90, 90) };  // 5x90 = 450
  assert.strictEqual(pickTarget(ghost, [whole, sliver]).id, "whole");
});
