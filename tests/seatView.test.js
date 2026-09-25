// THE OPPONENT ROW'S DECISIONS, ASKED DIRECTLY.
//
// src/ui/table.js touches `document` at import time and no Node test can load
// it, which is why every rule here lives in src/ui/session.js instead. That is
// not tidiness: the bug this file exists for — the row not scrolling on the
// human's own turn — survived because the rule was three lines inside a
// function made of scroll offsets, and nothing could ask it a question. So the
// questions get asked of a pure function, and the renderer is left holding only
// rectangles.
//
// ...AND SINCE #223 THE RECTANGLES CAN BE ASKED TOO. The row moved to
// src/ui/seatRow.js, which takes the elements it draws on as parameters, so the
// reserve at the foot of this file is now driven rather than grepped — a stub
// row is enough, and the two things that were ever wrong with it (skipping the
// carousel, measuring through the outgoing view's floor) are both visible in
// one number.

import { test } from "node:test";
import assert from "node:assert";

import { createSeatRow } from "../src/ui/seatRow.js";
import {
  SEAT_VIEWS,
  DEFAULT_SEAT_VIEW,
  normalizeSeatView,
  nextSeatView,
  seatToggleOffered,
  seatToShow,
  createSession,
} from "../src/ui/session.js";

/**
 * The least state seatToShow reads: a seat count and a direction. `pack` is
 * there only because makeCtx dereferences it on the way past — nothing below
 * touches a card, which is the point of the seam.
 */
function table(seats, direction = 1) {
  return { pack: {}, seats, direction };
}

/* ------------------------------------------------------------------ *
 * Which seat the row should follow
 * ------------------------------------------------------------------ */

test("an opponent acting alone is the seat to show", () => {
  assert.equal(seatToShow(table(5), 0, [3]), 3);
  assert.equal(seatToShow(table(5), 2, [0]), 0);
});

test("ON THE HUMAN'S TURN IT IS THE SEAT AFTER THEM — the whole bug", () => {
  // The old rule looked for the acting seat in the opponent row. On your turn
  // the acting seat is YOURS and is not in that row at all, so the lookup found
  // nothing and the row stayed wherever the last bot had left it.
  assert.equal(seatToShow(table(5), 0, [0]), 1, "seat 0 acting -> show seat 1");
  assert.equal(seatToShow(table(5), 3, [3]), 4);
});

test("the seat after the human wraps round the table", () => {
  assert.equal(seatToShow(table(4), 3, [3]), 0);
});

test("a reversed table shows the other neighbour", () => {
  assert.equal(seatToShow(table(5, -1), 2, [2]), 1);
  // ...including backwards over the wrap, which is the case a hand-written
  // `(seat + 1) % seats` gets wrong twice: once for the direction and once for
  // the negative modulo.
  assert.equal(seatToShow(table(5, -1), 0, [0]), 4);
});

test("a two-hander shows the only opponent there is", () => {
  assert.equal(seatToShow(table(2), 0, [0]), 1, "my turn");
  assert.equal(seatToShow(table(2), 0, [1]), 1, "their turn");
  assert.equal(seatToShow(table(2), 1, [1]), 0);
});

test("a simultaneous phase names nobody — the row stays out of it", () => {
  // Hearts' pass has every seat acting until it commits. There is no single
  // player to follow, and renderSeats already refuses to open a plate for the
  // same reason; the row must not disagree with the plate.
  assert.equal(seatToShow(table(4), 0, [0, 1, 2, 3]), null);
  assert.equal(seatToShow(table(4), 0, [1, 2]), null);
});

test("nothing acting is nothing to scroll to", () => {
  // actingSeatsOf hands back an empty list once the game is over.
  assert.equal(seatToShow(table(4), 0, []), null);
});

/* ------------------------------------------------------------------ *
 * The two views
 * ------------------------------------------------------------------ */

test("there are two rungs, ordered least to most, and no middle one", () => {
  assert.deepStrictEqual(SEAT_VIEWS, ["minimized", "all"]);
  assert.ok(!SEAT_VIEWS.includes("auto"),
    "'auto' was removed on purpose — playtest asked for two states, not three");
});

test("the default is the maximized row", () => {
  assert.equal(DEFAULT_SEAT_VIEW, "all");
  const session = createSession({
    pack: { id: "crazy-eights" },
    state: { seats: 4 },
    seating: [{ seat: 0 }],
    cardArt: {},
    handPrefs: { mode: "auto", order: [] },
  });
  assert.equal(session.seatView, "all",
    "a fresh match opens with every player's cards showing");
});

test("the cycle is all -> minimized -> all", () => {
  assert.equal(nextSeatView("all"), "minimized");
  assert.equal(nextSeatView("minimized"), "all");
});

test("a stale or unknown view falls back to the default rather than reaching the row", () => {
  // 'auto' was a legitimate value one commit ago, and a session that still
  // carries it must draw as the default rather than as a view with no branch.
  assert.equal(normalizeSeatView("auto"), "all");
  assert.equal(normalizeSeatView(undefined), "all");
  assert.equal(normalizeSeatView(null), "all");
  assert.equal(normalizeSeatView("nonsense"), "all");
  assert.equal(normalizeSeatView("minimized"), "minimized");
  assert.equal(normalizeSeatView("all"), "all");
  // ...and the cycle has to survive one too, or a stale value is a dead button.
  assert.equal(nextSeatView("auto"), "minimized");
});

/* ------------------------------------------------------------------ *
 * Whether the control is on the felt at all
 * ------------------------------------------------------------------ */

test("the toggle is offered by seat count, not by whether the row scrolls", () => {
  // The old predicate was `carousel || opponents >= 3`, and with 'all' the
  // default the first half is true everywhere — it would have put the control
  // on a two-hander where both rungs draw the same fully-open row.
  assert.equal(seatToggleOffered(1, "all"), false, "two-hander: nothing to do");
  assert.equal(seatToggleOffered(2, "all"), false);
  assert.equal(seatToggleOffered(3, "all"), true, "a crowd");
  assert.equal(seatToggleOffered(5, "all"), true);
});

test("a minimized player always keeps the way back out", () => {
  // The latch. Unreachable today — seat count is fixed for a match and
  // seatView is reset with the session — and the failure it guards against
  // (faces on screen with no control to undo them) cannot report itself.
  assert.equal(seatToggleOffered(1, "minimized"), true);
  assert.equal(seatToggleOffered(2, "minimized"), true);
});

/* ------------------------------------------------------------------ *
 * The reserve, asked of the row itself
 * ------------------------------------------------------------------ */

/**
 * A ROW THAT BEHAVES LIKE ONE, AND NOTHING ELSE.
 *
 * `reserveSeatRowSpace` reads exactly two things off the element it was handed:
 * how wide it is, and how tall its rect says it is. The rect is the part that
 * carries the bug — `getBoundingClientRect().height` ALREADY INCLUDES whatever
 * `min-height` is currently applied — so the stub models that and nothing more:
 * the natural height of the content, floored by whatever is on `style`.
 *
 * `natural` is writable so a test can do what a player does: minimize the row
 * and leave it holding less.
 */
function stubRow(natural) {
  return {
    natural,
    clientWidth: 332,
    style: { minHeight: "" },
    getBoundingClientRect() {
      const floor = parseInt(this.style.minHeight, 10) || 0;
      return { height: Math.max(this.natural, floor) };
    },
  };
}

/**
 * The seam holding that row and a session, and no other dependency: the reserve
 * touches neither the state's cards, the card art, nor the zone renderer, so
 * handing it any of them would only hide which ones it reads.
 */
function rowSeam(row, session) {
  return createSeatRow({ el: { opponentsTop: row }, session: () => session });
}

/**
 * It matters because 'all' is the default view. An early return on carousel
 * mode switches #13's protection off at nearly every table, and it would do so
 * silently — the symptom is the felt below the row stepping down a few pixels
 * when a bot lays a meld, which reads as clumsiness rather than as a bug.
 */
test("the seat-row reserve is not switched off in carousel mode", () => {
  const session = {};
  const row = stubRow(145);
  const seam = rowSeam(row, session);

  seam.reserveSeatRowSpace({ seats: 6 }, "all");
  assert.equal(row.style.minHeight, "145px",
    "the carousel reserved nothing. Every seat is open in that view, so every "
    + "seat shows its melds, and a seat holding melds is taller than one holding "
    + "none — the row's HEIGHT still moves turn to turn.");
  assert.equal(session.seatRowReserve.key, "332:6:all",
    "the reserve is per configuration — a width, a seat count and a view");

  // A HIGH-WATER MARK, so the row does not step back down when the melds that
  // made it tall are on somebody else's turn.
  row.natural = 43;
  seam.reserveSeatRowSpace({ seats: 6 }, "all");
  assert.equal(row.style.minHeight, "145px",
    "the reserve shrank to the shorter row — the felt below it moves again");
});

/**
 * The other half of the same change, and it was measured on a real felt rather
 * than reasoned about: with both views reserving, a fresh reserve that does not
 * clear the floor first measures a rect that still has the OUTGOING view's
 * min-height baked into it, and adopts it. Milestones, six seats, a phone-width
 * window: tapping down to faces kept the 163px the open row needed and left an
 * empty band under a row of avatars, where the honest height is 41px.
 *
 * The floor used to be scrubbed by the carousel's own early return on the way
 * past, which is why nobody saw it. Taking that return out takes the scrubbing
 * with it, so the clear has to be explicit.
 */
test("a change of view measures the row without the last view's floor on it", () => {
  const session = {};
  const row = stubRow(163);
  const seam = rowSeam(row, session);

  seam.reserveSeatRowSpace({ seats: 6 }, "all");
  assert.equal(row.style.minHeight, "163px", "the open row's own height");

  // Tap down to faces: a row of avatars holding no melds is 41px, and the 163
  // is the previous view's floor, still sitting on the very rect this is about
  // to read.
  row.natural = 41;
  seam.reserveSeatRowSpace({ seats: 6 }, "minimized");
  assert.equal(row.style.minHeight, "41px",
    "the new view inherited the floor of the one it just left — three-quarters "
    + "of an inch of empty felt under a row of avatars");
  assert.equal(session.seatRowReserve.key, "332:6:minimized",
    "a change of view has to start a fresh reserve, not extend the old one");

  // ...and the fresh reserve is still a floor of its own for that view.
  row.natural = 30;
  seam.reserveSeatRowSpace({ seats: 6 }, "minimized");
  assert.equal(row.style.minHeight, "41px",
    "clearing the floor for a NEW configuration must not clear it for the same one");
});
