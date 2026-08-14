// The lobby's storage contract: one saved table per pack, and no game lost on
// the way there.
//
// These are the invariants a player would feel break. "Starting Hearts kept my
// Crazy Eights game" is the whole point of the per-pack keys, and the legacy
// migration only ever runs once per install — on the upgrade, in the field,
// where nobody is watching. Both are cheap to assert and expensive to discover.
import { test, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { serializeMatch } from "../src/engine/replay.js";
import { ROOT } from "../tools/stage.mjs";
import { soloSeatTable } from "../src/players/seats.js";
import {
  KEYS, MATCH_KEY_PREFIX, matchKey, isMatchKey, saveMatch, loadMatch, clearMatch,
  saveHostMatch, loadHostMatch, clearHostMatch, hostMatches,
  saveSeatStub, seatStubs, clearSeatStub, touchSeatStub, sweepStaleTables, TABLE_ROLL_OFF_MS,
  listMatchSummaries, lastPlayedPack, rememberPack,
} from "../src/arcade/storage.js";

// The SDK's synchronous state surface is a key/value store; a Map is the whole
// of what storage.js uses. Standing this up here rather than importing a stub
// from src/ keeps the production module free of a test seam.
const store = new Map();
globalThis.Arcade = {
  state: {
    get: (k) => store.get(k),
    set: (k, v) => { store.set(k, structuredClone(v)); return true; },
    remove: (k) => store.delete(k),
    getOrInit: (k, d) => (store.has(k) ? store.get(k) : d),
  },
};

beforeEach(() => store.clear());

function packFromDisk(packId) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

/** A real match, some moves in — the thing that actually gets stored. */
function playedMatch(packId, moves = 6) {
  const pack = packFromDisk(packId);
  const state = createState({ pack, seats: 3, seed: `storage:${packId}` });
  pack.template.setup(makeCtx(state));
  for (let i = 0; i < moves && !state.gameOver; i++) {
    const move = chooseBotMove(state, state.turn.seat);
    if (!move) break;
    applyMove(state, move);
  }
  return state;
}

test("keys are namespaced per pack and recognisable as match keys", () => {
  assert.strictEqual(matchKey("hearts"), `${MATCH_KEY_PREFIX}hearts`);
  assert.ok(isMatchKey(matchKey("hearts")));
  assert.ok(!isMatchKey(KEYS.settings));
  assert.ok(!isMatchKey(KEYS.lastPack));
  assert.ok(!isMatchKey(undefined));
});

test("two packs hold their own saved games at the same time", () => {
  const hearts = playedMatch("hearts");
  const eights = playedMatch("crazy-eights");
  saveMatch(hearts);
  saveMatch(eights);

  assert.strictEqual(loadMatch("hearts").log.length, hearts.log.length);
  assert.strictEqual(loadMatch("crazy-eights").log.length, eights.log.length);

  // The regression the per-pack keys exist to prevent: before them, saving the
  // second match overwrote the first and the player lost a game by opening
  // another one.
  assert.notStrictEqual(loadMatch("hearts").log.length, loadMatch("crazy-eights").log.length);
});

test("clearing one pack's match leaves the others alone", () => {
  saveMatch(playedMatch("hearts"));
  saveMatch(playedMatch("crazy-eights"));
  clearMatch("hearts");
  assert.strictEqual(loadMatch("hearts"), null);
  assert.ok(loadMatch("crazy-eights"));
});

test("a match found under the wrong pack's key is refused, not replayed", () => {
  // Only reachable through a hand-edited save bundle, but the lobby would
  // otherwise advertise a resumable game the table then refuses to open.
  store.set(matchKey("hearts"), serializeMatch(playedMatch("crazy-eights")));
  assert.strictEqual(loadMatch("hearts"), null);
});

test("junk in a match key reads as no saved game", () => {
  for (const junk of [null, 42, "a match", {}, { formatVersion: 99 }]) {
    store.set(matchKey("hearts"), junk);
    assert.strictEqual(loadMatch("hearts"), null, `accepted ${JSON.stringify(junk)}`);
  }
});

test("an invalid pack id never reaches a key", () => {
  for (const bad of ["../../etc/passwd", "a/b", "", null, undefined]) {
    assert.strictEqual(loadMatch(bad), null);
    assert.strictEqual(clearMatch(bad), false);
  }
  assert.strictEqual(store.size, 0);
});

test("summaries describe the waiting games without replaying them", () => {
  const hearts = playedMatch("hearts", 8);
  saveMatch(hearts);

  const summaries = listMatchSummaries(["crazy-eights", "hearts", "wildfire"]);
  assert.deepStrictEqual([...summaries.keys()], ["hearts"], "packs with no match must be absent");

  const s = summaries.get("hearts");
  assert.strictEqual(s.packId, "hearts");
  assert.strictEqual(s.moves, hearts.log.length);
  assert.strictEqual(s.seats, 3);
  assert.ok(typeof s.savedAt === "number");
});

test("the last pack played is a hint the lobby can trust or ignore", () => {
  assert.strictEqual(lastPlayedPack(), null);
  rememberPack("stockpile");
  assert.strictEqual(lastPlayedPack(), "stockpile");

  assert.strictEqual(rememberPack("../evil"), false);
  assert.strictEqual(lastPlayedPack(), "stockpile");
});

const TABLE_A = 't1aaaaaaaaaaaaaaaaa';
const TABLE_B = 't2bbbbbbbbbbbbbbbbb';

test('the shared table is stored under its own key, not match.<packId>', () => {
  // LOBBY_PLAN.md reserved this: a multiplayer match belongs to a party rather
  // than to a pack, and "only the open table advances" is exactly the invariant
  // a shared table inverts.
  const pack = packFromDisk('crazy-eights');
  const state = createState({ pack, seats: 3, seed: 7 });
  pack.template.setup(makeCtx(state));
  const seats = soloSeatTable(3);

  saveHostMatch(TABLE_A, state, seats);
  assert.ok(Arcade.state.get('mpMatch.' + TABLE_A), 'written under mpMatch.<tableId>');
  assert.equal(Arcade.state.get(matchKey('crazy-eights')), undefined,
    'and emphatically not over the solo save for this pack');

  const loaded = loadHostMatch(TABLE_A);
  assert.equal(loaded.packId, 'crazy-eights');
  assert.equal(loaded.seed, 7);
  assert.ok(loaded.seatBindings, 'the seat bindings ride along, so a reload re-seats everyone');

  clearHostMatch(TABLE_A);
  assert.equal(loadHostMatch(TABLE_A), null);
});

test('a malformed shared table is refused rather than half-resumed', () => {
  Arcade.state.set('mpMatch.' + TABLE_A, { formatVersion: 999, packId: 'crazy-eights' });
  assert.equal(loadHostMatch(TABLE_A), null);
});

test('two hosted tables get a slot each — the case one mpMatch key could not hold', () => {
  const pack = packFromDisk('crazy-eights');
  const one = createState({ pack, seats: 3, seed: 7 });
  pack.template.setup(makeCtx(one));
  const two = createState({ pack, seats: 3, seed: 99 });
  pack.template.setup(makeCtx(two));

  saveHostMatch(TABLE_A, one, soloSeatTable(3));
  saveHostMatch(TABLE_B, two, soloSeatTable(3));

  // A SINGLE SLOT WOULD HAVE LOST THE FIRST ONE. Same pack, same device, two
  // tables — which is exactly what #43 asks for.
  assert.equal(loadHostMatch(TABLE_A).seed, 7);
  assert.equal(loadHostMatch(TABLE_B).seed, 99);

  assert.deepEqual(hostMatches().map((e) => e.tableId).sort(), [TABLE_A, TABLE_B].sort());

  clearHostMatch(TABLE_A);
  assert.equal(loadHostMatch(TABLE_A), null);
  assert.equal(loadHostMatch(TABLE_B).seed, 99, 'clearing one leaves the other');
  assert.deepEqual(hostMatches().map((e) => e.tableId), [TABLE_B]);
});

test('the index never advertises a slot that is gone', () => {
  const pack = packFromDisk('crazy-eights');
  const state = createState({ pack, seats: 3, seed: 7 });
  pack.template.setup(makeCtx(state));
  saveHostMatch(TABLE_A, state, soloSeatTable(3));

  // The slot removed behind the index's back — a half-finished clear, or a
  // launcher pruning storage. The index is a hint, so a stale one costs a
  // lookup and nothing else.
  Arcade.state.remove('mpMatch.' + TABLE_A);
  assert.deepEqual(hostMatches(), []);
});

test('a table id that is not a SAFE_ID is refused a slot', () => {
  const pack = packFromDisk('crazy-eights');
  const state = createState({ pack, seats: 3, seed: 7 });
  pack.template.setup(makeCtx(state));

  assert.equal(saveHostMatch('../../etc/passwd', state, soloSeatTable(3)), false);
  assert.equal(loadHostMatch('../../etc/passwd'), null);
  assert.deepEqual(hostMatches(), [], 'and nothing was written to the index either');
});

/* ------------------------------------------------------------------ *
 * The joiner's seat stubs, and the weekly roll-off (T4)
 * ------------------------------------------------------------------ */

const HOST_A = 'dev-ada';
const DAY = 24 * 60 * 60 * 1000;

test('a seat stub round-trips, and holds no game state at all', () => {
  saveSeatStub({ tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 2 }, { at: 1000 });

  const [stub] = seatStubs();
  assert.equal(stub.tableId, TABLE_A);
  assert.equal(stub.seat, 2);
  assert.equal(stub.packId, 'hearts');
  // THE ASYMMETRY IS THE POINT. A host stores seed + log; a joiner stores a
  // note about a chair. Anything else here would be a client keeping cards it
  // was never shown.
  // `hostName` is here so a dormant tile can name whose table it was; see the
  // note on it in storage.js. Everything else is still about which chair —
  // this assertion is the guard against game state creeping in.
  assert.deepEqual(Object.keys(stub).sort(),
    ['hostDeviceId', 'hostName', 'lastSeenAt', 'packId', 'savedAt', 'seat', 'tableId']);

  clearSeatStub(TABLE_A);
  assert.deepEqual(seatStubs(), []);
});

test('seat zero is a seat', () => {
  saveSeatStub({ tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 0 });
  assert.equal(seatStubs()[0].seat, 0);
});

test('a malformed stub is dropped on read, not rendered', () => {
  Arcade.state.set('mpSeats', [
    { tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 1 },
    { tableId: 'not a safe id!', hostDeviceId: HOST_A, packId: 'hearts', seat: 1 },
    { tableId: TABLE_B, hostDeviceId: HOST_A, packId: 'hearts', seat: 'first' },
    null,
  ]);
  assert.deepEqual(seatStubs().map((s) => s.tableId), [TABLE_A],
    'one bad stub costs one tile, not the whole row');
});

test('re-confirming a seat refreshes the sighting but not when we sat down', () => {
  saveSeatStub({ tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 1 }, { at: 1000 });
  saveSeatStub({ tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 1 }, { at: 5000 });

  const [stub] = seatStubs();
  assert.equal(stub.savedAt, 1000, 'still when we first sat down');
  assert.equal(stub.lastSeenAt, 5000);
  assert.equal(seatStubs().length, 1, 'and there is still one of it');
});

test('touching a stub keeps it off the sweep; touching an unknown one does nothing', () => {
  saveSeatStub({ tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 1 }, { at: 1000 });

  assert.equal(touchSeatStub(TABLE_A, { at: 9000 }), true);
  assert.equal(seatStubs()[0].lastSeenAt, 9000);
  assert.equal(touchSeatStub(TABLE_B, { at: 9000 }), false);
});

test('the sweep drops what nobody has touched for a week, and keeps the rest', () => {
  const now = 100 * DAY;
  saveSeatStub({ tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 1 },
    { at: now - (8 * DAY) });
  saveSeatStub({ tableId: TABLE_B, hostDeviceId: HOST_A, packId: 'hearts', seat: 2 },
    { at: now - (6 * DAY) });

  const dropped = sweepStaleTables({ now });

  assert.deepEqual(dropped.seats, [TABLE_A]);
  assert.deepEqual(seatStubs().map((s) => s.tableId), [TABLE_B]);
});

test('the sweep is exact at the seven-day boundary', () => {
  const now = 100 * DAY;
  saveSeatStub({ tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 1 },
    { at: now - TABLE_ROLL_OFF_MS });          // exactly a week: gone
  saveSeatStub({ tableId: TABLE_B, hostDeviceId: HOST_A, packId: 'hearts', seat: 2 },
    { at: now - TABLE_ROLL_OFF_MS + 1 });      // a millisecond inside: kept

  sweepStaleTables({ now });

  assert.deepEqual(seatStubs().map((s) => s.tableId), [TABLE_B]);
});

test('the sweep ages a hosted table on its last move, and drops the slot with it', () => {
  const pack = packFromDisk('crazy-eights');
  const state = createState({ pack, seats: 3, seed: 7 });
  pack.template.setup(makeCtx(state));
  const now = 100 * DAY;

  saveHostMatch(TABLE_A, state, soloSeatTable(3));
  // Backdate the index entry the way a week of not playing would.
  Arcade.state.set('mpTables', [{ tableId: TABLE_A, packId: 'crazy-eights', savedAt: now - (8 * DAY) }]);

  const dropped = sweepStaleTables({ now });

  assert.deepEqual(dropped.tables, [TABLE_A]);
  assert.equal(loadHostMatch(TABLE_A), null, 'the slot goes, not just the index entry');
  assert.deepEqual(hostMatches(), []);
});

test('a stored host name is clamped, and a missing one is empty rather than absent', () => {
  saveSeatStub({
    tableId: TABLE_A, hostDeviceId: HOST_A, packId: 'hearts', seat: 1, hostName: 'x'.repeat(200),
  });
  assert.equal(seatStubs()[0].hostName.length, 60);

  clearSeatStub(TABLE_A);
  saveSeatStub({ tableId: TABLE_B, hostDeviceId: HOST_A, packId: 'hearts', seat: 1 });
  assert.equal(seatStubs()[0].hostName, '', 'a tile can fall back, but never reads undefined');
});
