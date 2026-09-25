/**
 * CARDS IN FLIGHT, DRIVEN (#223, seam 6).
 *
 * Where a seat, a pile or a meld card sits on screen, and what a move flies
 * between them, lived in src/ui/table.js, which resolves 43 element ids at
 * import and so cannot be loaded here. The only test of any of it was a regex
 * over `animateMove`'s body (tests/flight.test.js), which could say which move
 * types the function NAMED and nothing about where a card went.
 *
 * src/ui/moveFlight.js takes its elements in, so these stand up a small table
 * (tests/fixtures/moveFlight.js) and play moves on it. flight.js's own `flyCard`
 * and `landOn` run for real over a stub `document`; where a copy was aimed is
 * read back out of the keyframes it was animated with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { LAYDOWN_FLIGHT_MAX, LAYDOWN_STAGGER_MS } from "../src/ui/moveFlight.js";
import { scrollCorrectedRect, cardSizedRect } from "../src/ui/flight.js";
import {
  installBrowser, flightTable, landedAt, centre, rect, box, settle,
} from "./fixtures/moveFlight.js";

/** Run `fn` with the stub browser installed, and take it off again after. */
async function withBrowser(opts, fn) {
  const browser = installBrowser(opts);
  try {
    return await fn(browser);
  } finally {
    browser.restore();
  }
}

/** The row half-way through a 140px glide that holds `inside`. */
function gliding(inside) {
  return (node) => ({ left: 200, scrollLeft: 60, elapsedMs: 120, holds: node === inside });
}

const FROM = rect(10, 400, 60);

/* ------------------------------------------------------------------ *
 * Where things are
 * ------------------------------------------------------------------ */

test("liveRect moves a node inside the gliding row to where the row is taking it", () => {
  const table = flightTable({ pending: (node) => gliding(table.nodes.fanCard)(node) });
  const { flight, nodes } = table;
  const raw = nodes.fanCard.getBoundingClientRect();
  const live = flight.liveRect(nodes.fanCard);
  assert.deepEqual(live, scrollCorrectedRect(raw, gliding(nodes.fanCard)(nodes.fanCard)));
  assert.equal(live.left, raw.left - 140, "a row scrolling right carries its seats left");
  assert.equal(table.asked.at(-1), nodes.fanCard, "the row is asked about the node measured");
  assert.deepEqual(flight.liveRect(nodes.pileTop), nodes.pileTop.getBoundingClientRect(),
    "a pile nowhere near the row is not shifted");
  assert.equal(flight.liveRect(box(null)), null, "a node with no size has no rect");
});

test("my own seat is my hand, and the row is not asked about it", () => {
  const table = flightTable({ pending: () => ({ left: 200, scrollLeft: 60, elapsedMs: 120, holds: true }) });
  assert.deepEqual(table.flight.seatRect(0), table.nodes.hand.getBoundingClientRect());
  assert.deepEqual(table.asked, []);
});

test("an opponent's seat launches from the one real card in its fan", () => {
  const table = flightTable();
  assert.deepEqual(table.flight.seatRect(1), table.nodes.fanCard.getBoundingClientRect(),
    "the fan's last child, not the squat strip of edge boxes");
  assert.equal(table.asked.at(-1), table.nodes.fanCard,
    "and the scroll correction is asked about that node");
});

test("a folded seat falls back to its face, then its plate, then nothing", () => {
  const table = flightTable();
  assert.deepEqual(table.flight.seatRect(2), table.nodes.avatar2.getBoundingClientRect(),
    "a fan put away has no rect; the face is where the player is looking");
  assert.equal(table.asked.at(-1), table.nodes.avatar2);
  assert.deepEqual(table.flight.seatRect(3), table.nodes.plate3.getBoundingClientRect());
  assert.equal(table.flight.seatRect(9), null, "no plate, no rect");
});

test("a seat mid-scroll is aimed at where it will be, through the node that won", () => {
  const table = flightTable({ pending: (node) => gliding(table.nodes.avatar2)(node) });
  const raw = table.nodes.avatar2.getBoundingClientRect();
  assert.equal(table.flight.seatRect(2).left, raw.left - 140);
});

test("a zone is its top card, else the pile, else nothing", () => {
  const blank = box(rect(700, 300, 80, 110), { select: { ".pile-stack__top": box(null) } });
  const { flight, nodes } = flightTable({ zoneNodes: { blank } });
  assert.deepEqual(flight.zoneRect("pile"), nodes.pileTop.getBoundingClientRect());
  assert.deepEqual(flight.zoneRect("blank"), blank.getBoundingClientRect(),
    "an empty pile's top has no size; the pile itself is the target");
  assert.deepEqual(flight.zoneRect("melds.1"), nodes.meldStrip.getBoundingClientRect(),
    "a meld strip has no top card and is its own rect");
  assert.equal(flight.zoneRect("nowhere"), null);
});

test("an opponent's meld strip mid-scroll is corrected like a seat", () => {
  const table = flightTable({ pending: (node) => gliding(table.nodes.meldStrip)(node) });
  assert.equal(table.flight.zoneRect("melds.1").left,
    table.nodes.meldStrip.getBoundingClientRect().left - 140);
});

/* ------------------------------------------------------------------ *
 * What flies
 * ------------------------------------------------------------------ */

test("no source rect, no flight — and nothing is hidden waiting for one", () => withBrowser({}, (browser) => {
  const { flight, state, nodes } = flightTable();
  flight.animateMove(state, { type: "playCard", actor: 1, cards: ["c7"] }, null);
  assert.equal(browser.flights.length, 0);
  assert.equal(nodes.pileTop.style.opacity, undefined);
}));

test("a played card lands on the pile's top card, held invisible until it does", () => withBrowser({}, async (browser) => {
  const { flight, state, nodes } = flightTable({ flightMs: 333 });
  flight.animateMove(state, { type: "playCard", actor: 1, cards: ["c7"] }, FROM);
  assert.equal(browser.flights.length, 1);
  const [card] = browser.flights;
  assert.match(card.node.innerHTML, /data-face="c7"/, "the card's face, not a back");
  assert.equal(card.options.duration, 333, "the player's own flight speed");
  const at = landedAt(card);
  const top = centre(nodes.pileTop.getBoundingClientRect());
  assert.deepEqual({ x: at.x, y: at.y }, top);
  assert.equal(card.keyframes.at(-1).opacity, 1, "it lands, it does not dissolve");
  assert.equal(nodes.pileTop.style.opacity, "0", "the real card waits underneath");
  await settle();
  assert.equal(nodes.pileTop.style.opacity, "", "and shows once the copy has landed");
}));

test("a discard lands on the pile that takes discards", () => withBrowser({}, (browser) => {
  const { flight, state, nodes } = flightTable();
  flight.animateMove(state, { type: "discard", actor: 2, cards: ["c3"] }, FROM);
  assert.equal(browser.flights.length, 1);
  const at = landedAt(browser.flights[0]);
  assert.deepEqual({ x: at.x, y: at.y }, centre(nodes.pileTop.getBoundingClientRect()));
}));

test("a card nobody can draw flies nowhere", () => withBrowser({}, (browser) => {
  const { flight, state } = flightTable();
  flight.animateMove(state, { type: "playCard", actor: 1, cards: ["x1"] }, FROM);
  flight.animateMove(state, { type: "pass", actor: 1 }, FROM);
  assert.equal(browser.flights.length, 0);
}));

test("my own draw flies face up to my hand, card-sized, and dissolves", () => withBrowser({}, (browser) => {
  const { flight, state, nodes } = flightTable({ handCards: ["h1", "h2", "h9"] });
  flight.animateMove(state, { type: "draw", actor: 0, from: "draw" }, FROM);
  const [card] = browser.flights;
  assert.match(card.node.innerHTML, /data-face="h9"/, "the card just drawn — the hand's last");
  assert.equal(card.keyframes.at(-1).opacity, 0, "a fanned hand has no slot to land on");
  const at = landedAt(card);
  const to = cardSizedRect(nodes.hand.getBoundingClientRect(), FROM.width);
  assert.deepEqual({ x: at.x, y: at.y, width: at.width }, { ...centre(to), width: to.width });
}));

test("a bot's draw flies face down to the card showing in its fan", () => withBrowser({}, (browser) => {
  const { flight, state, nodes } = flightTable();
  flight.animateMove(state, { type: "draw", actor: 1, from: "draw" }, FROM);
  const [card] = browser.flights;
  assert.match(card.node.innerHTML, /data-back/);
  const at = landedAt(card);
  assert.deepEqual({ x: at.x, y: at.y }, centre(nodes.fanCard.getBoundingClientRect()));
}));

test("a whole pile taken as a hand is one back, even into my own hand", () => withBrowser({}, (browser) => {
  const { flight, state } = flightTable();
  flight.animateMove(state, { type: "takeHand", actor: 0 }, FROM);
  assert.equal(browser.flights.length, 1);
  assert.match(browser.flights[0].node.innerHTML, /data-back/);
}));

test("a hit lands on the very card it joined the meld as, in reading order", () => withBrowser({}, async (browser) => {
  const { flight, state, nodes } = flightTable();
  // Stored m4 m3 x9 m2 m1; read m1 m2 m3 m4 once the unresolvable x9 is
  // skipped, so m3 is the THIRD slot and not the second or the fourth.
  flight.animateMove(state, { type: "hit", actor: 0, cards: ["m3"], choice: { seat: 1 } }, FROM);
  const at = landedAt(browser.flights[0]);
  assert.deepEqual({ x: at.x, y: at.y }, centre(nodes.meldCards[2].getBoundingClientRect()));
  assert.equal(nodes.meldCards[2].style.opacity, "0");
  await settle();
  assert.equal(nodes.meldCards[2].style.opacity, "");
}));

test("a hit with no chip drawn lands card-sized on the seat's meld strip", () => withBrowser({}, (browser) => {
  const { flight, state, nodes } = flightTable({ chips: { "1:0": null } });
  flight.animateMove(state, { type: "hit", actor: 0, cards: ["m3"], choice: { seat: 1 } }, FROM);
  const at = landedAt(browser.flights[0]);
  const to = cardSizedRect(nodes.meldStrip.getBoundingClientRect(), FROM.width);
  assert.deepEqual({ x: at.x, y: at.y, width: at.width }, { ...centre(to), width: to.width });
}));

/* ------------------------------------------------------------------ *
 * The lay-down
 * ------------------------------------------------------------------ */

const LAY_DOWN = {
  type: "layDown", actor: 1,
  choice: { melds: [{ cards: ["m4", "m3"] }, { cards: ["m2", "m1"] }] },
};

test("a lay-down flies card by card, in meld order, each onto its own slot", (t) => withBrowser({}, async (browser) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { flight, state, nodes } = flightTable({ meldGroups: { 1: [{ cards: ["m4", "m3", "m2", "m1"] }] } });
  flight.animateMove(state, LAY_DOWN, FROM);
  assert.equal(browser.flights.length, 0, "nothing leaves before the first beat");
  assert.deepEqual(nodes.meldCards.map((n) => n.style.opacity), ["0", "0", "0", "0"],
    "every card is held invisible up front, before any copy launches");
  t.mock.timers.tick(0);
  assert.equal(browser.flights.length, 1);
  t.mock.timers.tick(LAYDOWN_STAGGER_MS - 1);
  assert.equal(browser.flights.length, 1, "the second waits a full beat");
  t.mock.timers.tick(1);
  assert.equal(browser.flights.length, 2);
  t.mock.timers.tick(2 * LAYDOWN_STAGGER_MS);
  const landed = browser.flights.map((f) => landedAt(f).x);
  // m4 m3 m2 m1 in the move; the chip reads them back to front.
  const slot = (i) => centre(nodes.meldCards[i].getBoundingClientRect()).x;
  assert.deepEqual(landed, [slot(3), slot(2), slot(1), slot(0)]);
  t.mock.timers.reset();
  await settle();
  assert.deepEqual(nodes.meldCards.map((n) => n.style.opacity), ["", "", "", ""]);
}));

test("a lay-down past the cap flies only the first LAYDOWN_FLIGHT_MAX", (t) => withBrowser({}, async (browser) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ids = Array.from({ length: LAYDOWN_FLIGHT_MAX + 4 }, (_, i) => `m${i + 1}`);
  const { flight, state } = flightTable({ meldGroups: { 1: [{ cards: ids }] } });
  flight.animateMove(state, { type: "layDown", actor: 1, choice: { melds: [{ cards: ids }] } }, FROM);
  t.mock.timers.tick(LAYDOWN_STAGGER_MS * ids.length);
  assert.equal(browser.flights.length, LAYDOWN_FLIGHT_MAX);
  t.mock.timers.reset();
  await settle();
}));

test("with motion off a lay-down hides nothing — the meld is simply there", () => withBrowser({ reducedMotion: true }, async (browser) => {
  const { flight, state, nodes } = flightTable({ meldGroups: { 1: [{ cards: ["m4", "m3", "m2", "m1"] }] } });
  flight.animateMove(state, LAY_DOWN, FROM);
  await new Promise((resolve) => setTimeout(resolve, LAYDOWN_STAGGER_MS * 5));
  assert.equal(browser.flights.length, 0);
  assert.deepEqual(nodes.meldCards.map((n) => n.style.opacity), [undefined, undefined, undefined, undefined]);
}));

test("a table closed mid-lay-down flies no more cards and shows every one", (t) => withBrowser({}, async (browser) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const table = flightTable({ meldGroups: { 1: [{ cards: ["m4", "m3", "m2", "m1"] }] } });
  table.flight.animateMove(table.state, LAY_DOWN, FROM);
  t.mock.timers.tick(0);
  assert.equal(browser.flights.length, 1);
  table.bumpEpoch();
  t.mock.timers.tick(LAYDOWN_STAGGER_MS * 4);
  assert.equal(browser.flights.length, 1, "the epoch stops the stagger");
  t.mock.timers.reset();
  await settle();
  assert.deepEqual(table.nodes.meldCards.map((n) => n.style.opacity), ["", "", "", ""],
    "a stopped card is not left at opacity 0 for the rest of the round");
}));

/* ------------------------------------------------------------------ *
 * Which node a meld card is
 * ------------------------------------------------------------------ */

test("meldCardNode finds the card's slot, and nothing for what it cannot find", () => {
  const { flight, state, nodes } = flightTable();
  assert.equal(flight.meldCardNode(state, 1, "m1"), nodes.meldCards[0]);
  assert.equal(flight.meldCardNode(state, 1, "m4"), nodes.meldCards[3]);
  assert.equal(flight.meldCardNode(state, 1, "q1"), null, "a card in no meld");
  assert.equal(flight.meldCardNode(state, 2, "m1"), null, "a seat with no melds");
  assert.equal(flight.meldCardNode(state, undefined, "m1"), null);
  assert.equal(flight.meldCardNode(state, null, "m1"), null);
  const bare = flightTable({ zones: null });
  assert.equal(bare.flight.meldCardNode(bare.state, 1, "m1"), null, "no zone renderer yet");
});

/* ------------------------------------------------------------------ *
 * The wiring
 * ------------------------------------------------------------------ */

test("initTable builds the flights and hands them to everything that flies a card", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/table.js"), "utf8");
  assert.match(src, /moveFlight = createMoveFlight\(\{/);
  assert.ok(src.indexOf("moveFlight = createMoveFlight(") < src.indexOf("roundEnding = createRoundEnding("),
    "the round ending is handed animateMove by reference, so the flights come first");
  assert.match(src, /animateMove: moveFlight\.animateMove,/, "the round ending's pre-move fork");
  assert.match(src, /zoneRect: moveFlight\.zoneRect,\s*seatRect: moveFlight\.seatRect,/,
    "the celebrations aim through the same measurements");
  assert.doesNotMatch(src, /function (animateMove|animateLayDown|meldCardNode|seatRect|zoneRect|liveRect)\(/,
    "no second copy stays behind in table.js");
});
