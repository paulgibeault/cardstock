// THE SHOW CARD (#152) — src/ui/showCard.js.
//
// Cribbage's show is the scoring moment of the game and the felt spent one
// sentence on it. The card that replaced that sentence is arithmetic drawn on
// the screen, and arithmetic on a screen is the kind that nobody checks, so
// the model is pure and this is where it is checked.
//
// TWO HALVES, BOTH HERE. The first is the model on its own: what it does with
// a breakdown, a zero hand, a crib, a remote step with no card ids on it. The
// second drives a REAL cribbage hand through `theShow` and feeds the events it
// actually emits to the model — because the interesting failure is not a bad
// sum, it is the model and the template disagreeing about the shape of a
// `showScored` payload, which no amount of hand-written fixtures would catch.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { applyMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { showCardModel, NINETEEN } from "../src/ui/showCard.js";

const card = (id, rank, suit) => ({ id, rank, suit });

/* ------------------------------------------------------------------ *
 * The model on its own
 * ------------------------------------------------------------------ */

test("a scoring hand lists every part with its points, and the event's total", () => {
  const model = showCardModel({
    whose: "Nell's",
    points: 8,
    parts: [
      { kind: "fifteen", points: 2, n: 2, at: [0, 4] },
      { kind: "fifteen", points: 2, n: 2, at: [1, 4] },
      { kind: "pair", points: 2, n: 2, at: [0, 1] },
      { kind: "run", points: 3, n: 3, at: [1, 2, 3] },
    ],
    cards: [card("h-5", "5", "hearts"), card("d-5", "5", "diamonds"),
      card("s-6", "6", "spades"), card("c-7", "7", "clubs"),
      card("h-10", "10", "hearts")],
    starterAt: 4,
  });

  assert.equal(model.title, "Nell's hand");
  assert.deepEqual(model.rows.map((r) => r.label),
    ["fifteen", "fifteen", "a pair", "a run of 3"]);
  assert.deepEqual(model.rows.map((r) => r.points), [2, 2, 2, 3]);
  assert.equal(model.total, 8, "the total is the event's, never the sum of the rows");
  assert.equal(model.zero, false);
  assert.equal(model.faces.length, 5, "four cards and the cut");
  assert.equal(model.faces.filter((f) => f.starter).length, 1);
  assert.equal(model.faces[4].starter, true, "and the cut is the last of them");
});

// The one word this card exists to be able to say. "0" beside a list of
// combinations reads as a bug; nineteen is what a cribbage player calls it,
// because nineteen is the lowest score five cards cannot make.
test("a hand worth nothing is a nineteen, with no parts at all", () => {
  const model = showCardModel({
    whose: "Your",
    points: 0,
    parts: [],
    cards: [card("h-2", "2", "hearts"), card("d-6", "6", "diamonds"),
      card("s-9", "9", "spades"), card("c-K", "K", "clubs"),
      card("h-4", "4", "hearts")],
    starterAt: 4,
  });
  assert.equal(model.zero, true);
  assert.deepEqual(model.rows, []);
  assert.equal(model.total, 0);
  assert.equal(NINETEEN, "nineteen");
  assert.match(model.aria, /nineteen/);
});

test("the crib is the dealer's and says so", () => {
  const model = showCardModel({ whose: "Marlow's", isCrib: true, points: 4, parts: [], cards: [] });
  assert.equal(model.title, "Marlow's crib");
  // "Your" is the one possessive in the vocabulary with no apostrophe-s, and
  // the table hands it in already inflected rather than building it here.
  assert.equal(showCardModel({ whose: "Your", isCrib: true }).title, "Your crib");
});

// A REMOTE STEP HAS NO CARDS. `partsOf` in src/templates/cribbage.js strips the
// ids deliberately, so a joiner's step carries counts and positions and nothing
// to draw. The card degrades to no faces and no highlights rather than to a row
// pointing at the wrong picture — the table falls back to the banner.
test("a part whose cards are not on the card highlights nothing", () => {
  const model = showCardModel({
    whose: "Nell's",
    points: 2,
    parts: [{ kind: "pair", points: 2, n: 2, at: [0, 9] }],
    cards: [card("h-5", "5", "hearts")],
  });
  assert.deepEqual(model.rows[0].at, [0], "position 9 is not on a one-card card");
  assert.equal(model.faces.length, 1);

  const remote = showCardModel({ whose: "Nell's", points: 2, parts: [{ kind: "pair", points: 2, n: 2 }], cards: [] });
  assert.deepEqual(remote.rows[0].at, []);
  assert.deepEqual(remote.faces, []);
});

test("a kind nobody has a word for is left off rather than printed raw", () => {
  const model = showCardModel({
    whose: "Nell's",
    points: 5,
    parts: [{ kind: "fifteen", points: 2, n: 2 }, { kind: "moon-shot", points: 3, n: 1 }],
    cards: [card("h-5", "5", "hearts")],
  });
  assert.deepEqual(model.rows.map((r) => r.label), ["fifteen"]);
  assert.equal(model.total, 5, "and the total is still what the engine scored");
});

/* ------------------------------------------------------------------ *
 * Against a real hand
 * ------------------------------------------------------------------ */

/**
 * Play a whole cribbage hand out with the first legal move every time.
 *
 * "Whoever can move" rather than `state.turn.seat`, because the discard is a
 * SIMULTANEOUS phase: both seats throw to the crib and the turn seat does not
 * advance between them. A loop that asked only the turn seat threw two cards
 * and then stalled forever one move into the hand.
 */
async function playToTheShow() {
  const pack = await loadPackFromDisk("cribbage");
  const state = createState({ pack, seats: 2, seed: "show-card" });
  pack.template.setup(makeCtx(state));
  const shows = [];
  for (let guard = 0; guard < 400 && !state.gameOver; guard++) {
    const seats = [state.turn.seat, ...Array.from({ length: state.seats }, (u, s) => s)];
    const seat = seats.find((s) => enumerateLegalMoves(state, s).length);
    if (seat === undefined) break;
    // The pre-move starter, because the round boundary runs inside the move
    // that ends the hand and re-cuts for the next one.
    const starter = state.zones.has("starter") ? state.zones.cards("starter")[0] : null;
    applyMove(state, enumerateLegalMoves(state, seat)[0]);
    const scored = state.events.filter((e) => e.type === "showScored");
    if (scored.length) {
      shows.push(...scored.map((ev) => ({ ev, starter })));
      break;
    }
  }
  return { pack, state, shows };
}

test("a real show produces three cards, in the order the rules score them", async () => {
  const { shows } = await playToTheShow();
  assert.equal(shows.length, 3, `pone, dealer, crib — got ${shows.length}`);
  assert.deepEqual(shows.map((s) => s.ev.isCrib), [false, false, true],
    "the crib is last, and it is the one thing about this order that is not presentation");
});

test("every part of a real show is a row, with its points and the right total", async () => {
  const { pack, shows } = await playToTheShow();
  for (const { ev, starter } of shows) {
    const ids = starter ? [...ev.cards, starter] : ev.cards.slice();
    const model = showCardModel({
      whose: "Nell's",
      isCrib: ev.isCrib,
      points: ev.points,
      parts: ev.parts,
      cards: ids.map((id) => pack.cardsById.get(id) ?? null),
      starterAt: starter ? ids.length - 1 : null,
    });

    assert.equal(model.total, ev.points, "the card's total is the event's");
    if (ev.points) {
      assert.equal(model.rows.length, ev.parts.length,
        `every part of ${JSON.stringify(ev.parts)} must be a row`);
      assert.equal(model.rows.reduce((sum, r) => sum + r.points, 0), ev.points,
        "and the rows must add up to what the seat was actually pegged");
      // THE POSITIONS MUST NAME CARDS THAT ARE ON THE CARD. This is the half
      // that `partsOf` computes and the felt lights up; a part pointing at
      // position 7 of a five-card card would highlight nothing and nobody
      // would ever see the mistake.
      for (const row of model.rows) {
        assert.ok(row.at.length > 0, `"${row.label}" points at no card`);
        for (const at of row.at) {
          assert.ok(model.faces.some((f) => f.at === at), `position ${at} is not drawn`);
        }
      }
    } else {
      assert.equal(model.zero, true, "a hand worth nothing is a nineteen");
    }
    assert.equal(model.faces.length, ids.length, "four cards (or the crib) and the cut");
  }
});

// The positions are the whole reason `partsOf` takes a card list. A pair points
// at two cards and a run of three at three — if they ever stopped agreeing with
// `n`, the highlight would be lighting up an arbitrary subset.
test("each part's positions are as many cards as the part is made of", async () => {
  const { shows } = await playToTheShow();
  for (const { ev } of shows) {
    for (const part of ev.parts) {
      assert.equal(part.at.length, part.n,
        `${part.kind} says ${part.n} cards and points at ${part.at.length}`);
    }
  }
});

test("the positions are positions, not card ids", async () => {
  const { shows } = await playToTheShow();
  const at = shows.flatMap((s) => s.ev.parts).flatMap((p) => p.at);
  assert.ok(at.length, "a whole hand scored nothing at all, which makes this test blind");
  for (const i of at) {
    assert.ok(Number.isInteger(i) && i >= 0 && i <= 5,
      `${JSON.stringify(i)} is not a position into five cards — and an id here would `
      + "sail past the view filter (src/engine/view.js)");
  }
  assert.ok(makeCtx);
});
