// WHAT A SPADES TABLE SAYS ABOUT ITSELF (issue #123, items 28, 29, 31, 33).
//
// Four things were true of the shipped felt at once, and all four were about
// numbers that existed and were not shown:
//
//   * the human's own bid was displayed NOWHERE — not the status bar, not a
//     seat plate, not the round summary. The other three seats' bids were bare
//     chips. In a partnership the contract is your bid plus your partner's, so
//     half of your own contract was unreadable;
//   * the won pile counted CARDS, so the chip climbed in fours beside a bid
//     counted in tricks;
//   * bags accumulated correctly and the word "bag" never appeared on the
//     table — searching the rendered page text for /bag/i found nothing;
//   * the bid dialog showed no bid but the one you were making, on a screen
//     where the partner's plate was clipped mid-word.
//
// Every one of those is a number the TEMPLATE owns and the platform draws, so
// this file tests the template's side of each: the counters, the pile's
// reading, and the dialog's context rows. What the platform does with them is
// DOM (src/ui/table.js's `MY_SEAT_KINDS` strip, src/ui/choiceDialog.js's
// context row) and is verified on the felt.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { zoneBadge, describeZone, zoneAriaLabel } from "../src/ui/describe.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

function put(state, address, cardIds) {
  const zone = state.zones.get(address);
  zone.cards.push(...cardIds);
  for (const id of cardIds) state.cardLocation.set(id, address);
}

/** A hand in progress: bids in, some tricks taken, some bags already banked. */
async function table({ bids = [3, 4, 2, 2], tricks = [0, 0, 0, 0], banked = {} } = {}) {
  const pack = await loadPackFromDisk("team-spades");
  const state = createState({ pack, seats: 4, seed: "spades-felt" });
  const deck = [...pack.cardsById.keys()];
  let next = 0;
  for (let seat = 0; seat < 4; seat++) {
    state.playerVars[seat].bid = bids[seat];
    // A trick is four cards, and `tricksTakenBy` is the pile divided by seats.
    put(state, `won.${seat}`, deck.slice(next, next + tricks[seat] * 4));
    next += tricks[seat] * 4;
  }
  for (const [seat, n] of Object.entries(banked)) state.playerVars[seat].bags = n;
  state.turn.phase = "play";
  return { pack, state };
}

const counterOf = (pack, state, seat, kind) => pack.template
  .seatCounters(makeCtx(state), seat).find((c) => c.kind === kind);

/* ------------------------------------------------------------------ *
 * Item 31 — bags, counted where they can be seen
 * ------------------------------------------------------------------ */

test("a side's bags are the ones it has banked plus the ones it is taking now", async () => {
  // Seats 0 and 2 are one side: they promised 3 + 2 = 5 and have taken 7.
  const { pack, state } = await table({ tricks: [4, 1, 3, 1], banked: { 0: 2 } });
  const bags = counterOf(pack, state, 0, "bags");
  assert.equal(bags.text, "4", "two banked, and two tricks past a contract of five");
  assert.equal(bags.aria, "4 bags");
  // A SIDE'S NUMBER SAYS THE SAME THING ON BOTH ITS SEATS, wherever the scorer
  // happens to keep it (it banks on the side's first seat).
  assert.equal(counterOf(pack, state, 2, "bags").text, "4");
});

test("a side short of its contract is carrying no bags at all", async () => {
  const { pack, state } = await table({ tricks: [1, 4, 1, 4] });
  assert.equal(counterOf(pack, state, 0, "bags").text, "0");
  assert.equal(counterOf(pack, state, 0, "bags").aria, "0 bags");
  // ...and its opponents, who promised 4 + 2 and took 8, are carrying two.
  assert.equal(counterOf(pack, state, 1, "bags").text, "2");
});

test("one bag reads as one bag", async () => {
  const { pack, state } = await table({ tricks: [4, 0, 2, 0] });
  assert.equal(counterOf(pack, state, 0, "bags").aria, "1 bag");
});

// Bags are Spades' own arithmetic and they are DECLARED (`scoring.bids.bags`).
// A pack without them must not grow a counter that is always zero.
test("a pack that does not bag has no bag counter", async () => {
  for (const id of ["hearts", "pinochle"]) {
    const pack = await loadPackFromDisk(id);
    const state = createState({ pack, seats: 4, seed: `nobags-${id}` });
    for (let seat = 0; seat < 4; seat++) {
      assert.equal(pack.template.seatCounters(makeCtx(state), seat).find((c) => c.kind === "bags"),
        undefined, `${id} grew a bag counter`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Item 29 — a won pile counted in the unit the game is played in
 * ------------------------------------------------------------------ */

const wonInst = (state) => ({
  def: state.zones.defs.get("won"),
  n: null,
  address: "won.0",
});

test("the won pile's badge counts tricks, and says so", async () => {
  const { state } = await table({ tricks: [3, 0, 0, 0] });
  // `name` rides beside the count on every pile since #122/#124 ("Won / 3 tricks").
  assert.deepEqual(zoneBadge(state, wonInst(state)), { text: "3 tricks", kind: "count", name: "Won" });
  assert.equal(zoneAriaLabel(state, wonInst(state)), "Won, 3 tricks. Face down.");
});

test("one trick is a trick, not 1 tricks", async () => {
  const { state } = await table({ tricks: [1, 0, 0, 0] });
  assert.equal(zoneBadge(state, wonInst(state)).text, "1 trick");
});

// A PILE WITH CARDS IN IT INTRODUCES ITSELF; AN EMPTY ONE CANNOT (describe.js).
// "0 tricks" on a dashed rectangle says less than the word does.
test("an empty won pile keeps its name", async () => {
  const { state } = await table();
  assert.deepEqual(zoneBadge(state, wonInst(state)), { text: "Won", kind: "name" });
});

// The pile is still a pile of cards and the inspector still says how many —
// what changed is the number ON the felt, not the truth behind it.
test("the inspector keeps both numbers", async () => {
  const { state } = await table({ tricks: [3, 0, 0, 0] });
  const { lines } = describeZone(state, wonInst(state));
  assert.deepEqual(lines.find((l) => l.label === "Cards"), { label: "Cards", value: "12" });
  assert.deepEqual(lines.find((l) => l.label === "Tricks"), { label: "Tricks", value: "3" });
});

// Every trick-taking pack counts its tricks four cards at a time, so this is
// not gated on bidding: Hearts' pile is three tricks deep for the same reason.
test("the trick reading is the genre's, not the pack's", async () => {
  const pack = await loadPackFromDisk("hearts");
  const state = createState({ pack, seats: 4, seed: "hearts-won" });
  put(state, "won.0", [...pack.cardsById.keys()].slice(0, 8));
  const inst = { def: state.zones.defs.get("won"), n: null, address: "won.0" };
  assert.equal(zoneBadge(state, inst).text, "2 tricks");
});

// Nothing else on any felt changes: a pile whose number IS its card count must
// keep answering with its card count.
test("a pile with no reading of its own is untouched", async () => {
  const pack = await loadPackFromDisk("crazy-eights");
  const state = createState({ pack, seats: 4, seed: "eights" });
  put(state, "draw", [...pack.cardsById.keys()].slice(0, 30));
  const inst = { def: state.zones.defs.get("draw"), n: null, address: "draw" };
  const plain = zoneBadge(state, inst);
  assert.equal(plain.text, "30");
  assert.equal(plain.kind, "count");
});

/* ------------------------------------------------------------------ *
 * Item 33 — the bid dialog knows what the table has already said
 * ------------------------------------------------------------------ */

function bidAsk(pack, state, seat) {
  return pack.template.pendingChoice(makeCtx(state), { actor: seat, type: "bid" });
}

test("the bid dialog carries every seat's bid, and the side's running promise", async () => {
  const { pack, state } = await table({ bids: [3, 4, undefined, undefined] });
  state.turn.phase = "bid";
  state.turn.seat = 2;
  const ask = bidAsk(pack, state, 2);

  // SEATS ARE NUMBERS HERE. The template names nobody: the platform dresses
  // these rows from its roster, the same way it dresses a `kind: 'seat'`
  // option (src/ui/table.js `dressedContext`).
  assert.deepEqual(ask.context.slice(0, 4), [
    { seat: 0, value: "3" },
    { seat: 1, value: "4" },
    { seat: 2, value: "—" },
    { seat: 3, value: "—" },
  ]);
  // Seat 2's side is seats 0 and 2, and seat 0 has promised three.
  assert.deepEqual(ask.context[4], { label: "Your side", value: "3 so far" });
});

test("a nil in the dialog reads as a nil and adds nothing to the promise", async () => {
  const { pack, state } = await table({ bids: [0, 4, undefined, undefined] });
  state.turn.phase = "bid";
  state.turn.seat = 2;
  const ask = bidAsk(pack, state, 2);
  assert.equal(ask.context[0].value, "nil");
  assert.deepEqual(ask.context[4], { label: "Your side", value: "0 so far" });
});

// The same dialog serves Pinochle's auction, where the seats compete for ONE
// contract instead of each keeping their own — so the useful summary is the
// number a bid has to beat, not a partnership's total.
test("a points auction is told what it has to beat", async () => {
  const pack = await loadPackFromDisk("pinochle");
  const state = createState({ pack, seats: 4, seed: "pinochle-bid" });
  state.playerVars[0].bid = 250;
  state.playerVars[1].bid = 0;
  state.turn.phase = "bid";
  state.turn.seat = 2;
  const ask = pack.template.pendingChoice(makeCtx(state), { actor: 2, type: "bid" });
  assert.deepEqual(ask.context[0], { seat: 0, value: "250" });
  assert.deepEqual(ask.context[1], { seat: 1, value: "—" }, "a pass is not a nil");
  assert.deepEqual(ask.context.at(-1), { label: "To beat", value: "250" });
});
