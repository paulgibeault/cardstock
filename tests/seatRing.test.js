// TWO SEATS, ONE SIDE (#104) — the felt, the seat table and the lobby picker.
//
// `src/ui/table.js` touches `document` at import time, so no `node --test` can
// load it. That is the standing reason `src/ui/session.js` exists and the
// reason `src/ui/seatRing.js` does: every rule about where a chair is drawn and
// whose score is on it is a function of numbers and a pack, kept out of the
// file no test can reach, and pinned here.
//
// The engine half — the fold, the standings, the bot — is
// tests/partnerships.test.js.
import { test } from "node:test";
import assert from "node:assert";
import { loadPack } from "../src/engine/packLoader.js";
import {
  opponentRing, partnerSeat, scoreBearers, defaultScoreChip, seatSideMarks, sideSeats,
} from "../src/ui/seatRing.js";
import { createSeatTable, deserializeSeatTable, soloSeatTable } from "../src/players/seats.js";
import { sidesOf } from "../src/engine/sides.js";
import { partyModel } from "../src/ui/partyModel.js";
import { createTableDirectory } from "../src/match/tableDirectory.js";
import { PARTNERS_MANIFEST, SOLO_MANIFEST } from "./fixtures/partnersPack.js";

const partners = () => loadPack(structuredClone(PARTNERS_MANIFEST));
const solo = () => loadPack(structuredClone(SOLO_MANIFEST));

/* ------------------------------------------------------------------ *
 * The seat ring
 * ------------------------------------------------------------------ */

test("the opponent row is a ring from the chair on your left, not seat order", () => {
  assert.deepStrictEqual(opponentRing(4, 0), [1, 2, 3]);
  assert.deepStrictEqual(opponentRing(4, 1), [2, 3, 0]);
  assert.deepStrictEqual(opponentRing(4, 2), [3, 0, 1]);
  assert.deepStrictEqual(opponentRing(4, 3), [0, 1, 2]);
  // A spectator, and the empty felt behind the lobby: no chair, so no left.
  assert.deepStrictEqual(opponentRing(4, null), [0, 1, 2, 3]);
  assert.deepStrictEqual(opponentRing(3, 2), [0, 1]);
});

test("a partner is drawn OPPOSITE — in the middle of the row — from every chair", () => {
  // THE BUG THIS REPLACES, stated as a fact rather than as prose: the row used
  // to be `for (seat = 0..n) if (seat !== mine)`, which from seat 1 draws
  // 0, 2, 3 — putting the chair across the table at the far right and the chair
  // on your left at the far left. Solo never noticed because solo always deals
  // the human seat 0, where the two orders agree.
  const pack = partners();
  let differsFromSeatOrder = 0;
  for (let mine = 0; mine < 4; mine++) {
    const ring = opponentRing(4, mine);
    const partner = partnerSeat(pack, 4, mine);
    assert.strictEqual(partner, (mine + 2) % 4);
    assert.strictEqual(ring.indexOf(partner), 1,
      `from seat ${mine} the partner is drawn at position ${ring.indexOf(partner)} of `
      + `[${ring}] — a partner belongs across the table, which on a row of three is the middle`);

    const oldOrder = [0, 1, 2, 3].filter((s) => s !== mine);
    if (oldOrder.indexOf(partner) !== 1) differsFromSeatOrder += 1;
  }
  // The two orders AGREE from seats 0 and 3 and disagree from 1 and 2, so a
  // test that only ever looked from seat 0 — which is the only chair solo ever
  // deals a human — would pass against the row this replaces.
  assert.strictEqual(differsFromSeatOrder, 2,
    "plain seat order already puts the partner in the middle from every chair, so this test "
    + "is passing against the row it is here to replace");
});

test("a pack with no sides has no partner to place", () => {
  assert.strictEqual(partnerSeat(solo(), 4, 0), null);
  assert.strictEqual(partnerSeat(partners(), 4, null), null);
});

/* ------------------------------------------------------------------ *
 * One score per side
 * ------------------------------------------------------------------ */

test("the felt draws one score chip per SIDE, and yours is your own", () => {
  const pack = partners();
  // From seat 0: your own chip is in the status bar and bears for side 0, so
  // your partner (2) carries none; side 1 is borne by the first of its chairs
  // the ring reaches, which is seat 1.
  assert.deepStrictEqual([...scoreBearers(pack, 4, 0)].sort((a, b) => a - b), [0, 1]);
  // From seat 1 the ring is 2, 3, 0 — so side 0 is borne by seat 2.
  assert.deepStrictEqual([...scoreBearers(pack, 4, 1)].sort((a, b) => a - b), [1, 2]);
  // A spectator holds no chair, so both sides are borne inside the row.
  assert.deepStrictEqual([...scoreBearers(pack, 4, null)].sort((a, b) => a - b), [0, 1]);
});

test("a pack with no sides draws a chip on every chair, exactly as it always did", () => {
  assert.deepStrictEqual([...scoreBearers(solo(), 4, 0)].sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.deepStrictEqual([...scoreBearers(solo(), 4, 2)].sort((a, b) => a - b), [0, 1, 2, 3]);
});

// `label` is the word a seat plate prints under the number (#133) and it is
// part of the chip's shape, so the deep-equals below carry it. It is the same
// word for every chair: which SIDE'S total this is, is the aria text's job.
test("a chip shows the SIDE's total, and says so out loud", () => {
  const pack = partners();
  const scores = [7, 5, 9, 4];
  assert.deepStrictEqual(defaultScoreChip(pack, 4, scores, 0),
    { short: "16", long: "16", label: "Score", aria: "16 points for this side" });
  assert.deepStrictEqual(defaultScoreChip(pack, 4, scores, 2),
    { short: "16", long: "16", label: "Score", aria: "16 points for this side" },
    "a partner's chair must report the same number as its partner's — one score, one side");
  assert.deepStrictEqual(defaultScoreChip(pack, 4, scores, 1),
    { short: "9", long: "9", label: "Score", aria: "9 points for this side" });

  // Unchanged for a game with no partnerships, down to the aria text: nothing
  // needs telling apart when every chair is its own side.
  assert.deepStrictEqual(defaultScoreChip(solo(), 4, scores, 0),
    { short: "7", long: "7", label: "Score", aria: "7 points" });
});

test("every chair knows which side it is on, and which one is yours", () => {
  const pack = partners();
  assert.deepStrictEqual(seatSideMarks(pack, 4, 0, 2), { side: 0, partner: true });
  assert.deepStrictEqual(seatSideMarks(pack, 4, 0, 1), { side: 1, partner: false });
  assert.deepStrictEqual(seatSideMarks(pack, 4, 0, 0), { side: 0, partner: false },
    "your own chair is not your partner");
  assert.deepStrictEqual(seatSideMarks(pack, 4, null, 2), { side: 0, partner: false },
    "a spectator has no partner");
  // The marks are what survive every SEAT_TIERS rung: at `faces` the name and
  // the score chip are gone, and `seat--partner` is the whole of what is left
  // to say whose side that chair is on.
  assert.deepStrictEqual(seatSideMarks(solo(), 4, 0, 2), { side: null, partner: false });
  assert.deepStrictEqual(sideSeats(pack, 4).map((s) => [...s]), [[0, 2], [1, 3]]);
});

/* ------------------------------------------------------------------ *
 * The seat table
 * ------------------------------------------------------------------ */

test("the seat table knows which chairs are a pair", () => {
  const pack = partners();
  const table = createSeatTable({
    seats: 4, localDeviceId: "me", sides: sidesOf(pack, 4),
  });
  table.claim(0, { deviceId: "me" });
  table.claim(2, { deviceId: "you" });
  table.seatBot(1);

  assert.ok(table.partnered());
  assert.strictEqual(table.sideOf(2), 0);
  assert.deepStrictEqual(table.partnersOf(0), [2]);
  assert.deepStrictEqual(table.sideSeats(1), [1, 3]);
  assert.ok(table.arePartners(1, 3));
  assert.ok(!table.arePartners(0, 1));
  assert.strictEqual(table.localSide(), 0);
});

test("a table with no declared sides says so rather than inventing pairs", () => {
  const table = soloSeatTable(4, { humanSeat: 0 });
  assert.ok(!table.partnered());
  assert.deepStrictEqual(table.partnersOf(0), []);
  assert.strictEqual(table.sideOf(3), 3);
  assert.strictEqual(table.localSide(), 0);
});

test("the pairing is re-derived on deserialize, never carried in the payload", () => {
  const pack = partners();
  const table = createSeatTable({ seats: 4, localDeviceId: "me", sides: sidesOf(pack, 4) });
  table.claim(1, { deviceId: "me" });
  const payload = table.serialize();
  assert.deepStrictEqual(Object.keys(payload).sort(), ["owners", "seats"],
    "the serialized seat table grew a `sides` field — the pairing belongs to the pack, and a "
    + "stored copy is a second answer that can disagree with the manifest the next build loads");

  const plain = deserializeSeatTable(payload, { localDeviceId: "me" });
  assert.ok(!plain.partnered(), "sides appeared out of a payload that does not carry them");
  const paired = deserializeSeatTable(payload, { localDeviceId: "me", sides: sidesOf(pack, 4) });
  assert.deepStrictEqual(paired.partnersOf(1), [3]);
  assert.strictEqual(paired.localSide(), 1);
});

test("a pairing that does not account for every chair is refused, not half-applied", () => {
  // A seat on two sides, or on none, would make `sideOf` answer something for a
  // chair nobody agreed on. Every-seat-for-itself is the honest fallback.
  const table = createSeatTable({ seats: 4, localDeviceId: "me", sides: [[0, 1], [2]] });
  assert.ok(!table.partnered());
  assert.strictEqual(table.sideOf(3), 3);
});

/* ------------------------------------------------------------------ *
 * The lobby's seat picker
 * ------------------------------------------------------------------ */

const ME = "device-me";
const ADA = "device-ada";

function sightingOf(frame) {
  const directory = createTableDirectory({ now: () => 1000 });
  directory.sight(frame);
  return directory.all();
}

function fourSeatFrame() {
  return {
    tableId: "t1a1a1a1a1a1a1a1a1a",
    hostDeviceId: ADA,
    packId: "fixture-partners",
    variants: [],
    graceMs: 60_000,
    started: false,
    seatCount: 4,
    seats: [
      { seat: 0, kind: "device", deviceId: ADA, name: "Ada", status: "connected" },
      { seat: 1, kind: "bot", name: "Otto", status: "bot" },
      { seat: 2, kind: "empty", status: "empty" },
      { seat: 3, kind: "bot", name: "Nell", status: "bot" },
    ],
  };
}

const lobbyBase = {
  self: ME,
  myName: "You",
  publishedName: "Me",
  packNameOf: () => "Partners",
  peers: [{ deviceId: ADA, name: "Ada", direct: true }],
};

test("the lobby's seat picker knows which chairs are a pair before anything is dealt", () => {
  const model = partyModel({
    ...lobbyBase,
    packTeamsOf: () => 2,
    sightings: sightingOf(fourSeatFrame()),
  });
  const view = model.tables[0];
  assert.strictEqual(view.teams, 2);
  assert.deepStrictEqual(view.seats.map((s) => s.side), [0, 1, 0, 1]);
  assert.deepStrictEqual(view.seats.map((s) => s.partnerSeats), [[2], [3], [0], [1]]);
  // Which is what lets the picker say whose chair you would be taking: sitting
  // in seat 2 partners you with whoever is in seat 0.
  const seatTwo = view.seats[2];
  assert.strictEqual(view.seats[seatTwo.partnerSeats[0]].name, "Ada");
});

test("a pack with no sides leaves the picker exactly as it was", () => {
  const model = partyModel({ ...lobbyBase, sightings: sightingOf(fourSeatFrame()) });
  const view = model.tables[0];
  assert.strictEqual(view.teams, null);
  assert.deepStrictEqual(view.seats.map((s) => s.side), [null, null, null, null]);
  assert.deepStrictEqual(view.seats.map((s) => s.partnerSeats), [[], [], [], []]);
});
