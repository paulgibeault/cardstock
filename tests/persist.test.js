// ONE WAY A TABLE IS WRITTEN DOWN (#225, src/arcade/persist.js).
//
// There were two persist paths with one policy written twice: the felt's
// `persistMatch` for solo and daily play, and the party's `persist` for a hosted
// table. Each had its own "a view is not a match" guard, the felt needed a third
// to keep a hosted table out of the solo slot, and only the party's knew that a
// finished match is not a resumable one. #166 is what that split cost: "End
// match" cleared the save, and the flush on the way out of the table wrote it
// straight back. Both callers now hand `persistTable` the table, and these ask
// it what each role writes, where, and when it writes nothing at all.

import { test } from "node:test";
import assert from "node:assert";
import { persistTable, concludeTable } from "../src/arcade/persist.js";
import { createTableSession } from "../src/match/tableSession.js";
import { createSeatTable } from "../src/players/seats.js";
import {
  loadMatch, loadHostMatch, hostMatches, listMatchSummaries, readStats, saveMatch,
} from "../src/arcade/storage.js";
import { createState } from "../src/engine/state.js";
import { makeCtx, actingSeats } from "../src/engine/context.js";
import { applyMove, legalMovesFor } from "../src/engine/movePipeline.js";
import { viewFor } from "../src/engine/view.js";
import { loadPackFromDiskSync } from "../tools/lib/packs.mjs";
import { installArcade } from "./fixtures/arcade.js";
import { doorsHarness } from "./fixtures/matchDoors.js";
import { roundEndingHarness } from "./fixtures/roundEnding.js";
import { modelFromView } from "../src/ui/tableModel.js";

const TABLE_ID = "t1a1a1a1a1a1a1a1a1a";

function dealt(packId = "hearts", seats = 4, seed = 7) {
  const pack = loadPackFromDiskSync(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

function playSome(state, n) {
  for (let i = 0; i < n; i++) {
    const seat = actingSeats(state)[0];
    applyMove(state, legalMovesFor(state, seat)[0]);
  }
  return state;
}

function soloTable(state, extra = {}) {
  const table = createTableSession({ packId: state.pack.id, role: "solo" });
  table.pack = state.pack;
  table.state = state;
  return Object.assign(table, extra);
}

function hostTable(state) {
  const table = createTableSession({ tableId: TABLE_ID, packId: state.pack.id, role: "host" });
  table.pack = state.pack;
  table.state = state;
  table.seats = createSeatTable({ seats: state.seats, localDeviceId: "me" });
  table.graceMs = 30000;
  return table;
}

/* ------------------------------------------------------------------ *
 * Which slot, by role
 * ------------------------------------------------------------------ */

test("a solo table goes to its pack's slot, a daily to the daily slot, with its hints", () => {
  installArcade({ state: true });
  const casual = playSome(dealt(), 3);
  assert.notStrictEqual(persistTable(soloTable(casual, { hintsTaken: 2 })), false);
  assert.strictEqual(loadMatch("hearts")?.log.length, 3, "the casual game is in its pack's slot");
  assert.strictEqual(loadMatch("hearts")?.hints, 2, "the hints taken ride beside the save");

  const daily = playSome(dealt("hearts", 4, 11), 1);
  persistTable(soloTable(daily, { daily: { date: "2026-09-25", seed: "hearts|2026-09-25" } }));
  assert.strictEqual(loadMatch("hearts", { slot: "daily" })?.log.length, 1, "the daily is in the daily slot");
  assert.strictEqual(loadMatch("hearts")?.log.length, 3,
    "a daily must never overwrite the casual game waiting on the same tile");
});

test("a hosted table goes to mpMatch.<tableId> and never to the solo slot", () => {
  // THE SHARED GUARD THE FELT USED TO NEED. Writing the solo slot as well made a
  // second, diverging copy of one shared game, and put "Start over" on the lobby
  // tile for a hand other people were sitting at. The role picks the slot now,
  // so the felt and the party can both hand this the same table.
  installArcade({ state: true });
  const state = playSome(dealt(), 2);
  persistTable(hostTable(state));
  assert.strictEqual(loadHostMatch(TABLE_ID)?.log.length, 2, "a hosted table is saved under mpMatch.<tableId>");
  assert.strictEqual(loadHostMatch(TABLE_ID)?.graceMs, 30000, "the host's grace survives the reload");
  assert.ok(loadHostMatch(TABLE_ID)?.seatBindings, "with its seat bindings beside the log");
  assert.strictEqual(loadMatch("hearts"), null, "a hosted table wrote the solo slot");
});

test("a joiner's table, and any view, writes nothing", () => {
  const { store } = installArcade({ state: true });
  const host = dealt();
  const joiner = createTableSession({ tableId: TABLE_ID, packId: "hearts", role: "joiner" });
  joiner.pack = host.pack;
  joiner.state = modelFromView({ ...viewFor(host, 1), seat: 1 }, host.pack);
  assert.strictEqual(persistTable(joiner), null);
  // A VIEW IS NOT A MATCH whatever table it is found on: the state knows what
  // it is, and it is asked as well as the role.
  const hosted = hostTable(host);
  hosted.state = joiner.state;
  assert.strictEqual(persistTable(hosted), null);
  assert.strictEqual(store.size, 0, "a client wrote a match it was only ever shown part of");
  assert.strictEqual(persistTable(null), null);
  assert.strictEqual(persistTable(createTableSession({ packId: "hearts", role: "solo" })), null,
    "a table with nothing dealt has nothing to write");
});

/* ------------------------------------------------------------------ *
 * A finished match is not a resumable one — for every role
 * ------------------------------------------------------------------ */

test("a finished match clears its slot instead of being written back, solo or hosted", () => {
  installArcade({ state: true });
  const solo = playSome(dealt(), 2);
  const table = soloTable(solo);
  persistTable(table);
  assert.ok(loadMatch("hearts"));
  solo.gameOver = true;
  assert.strictEqual(persistTable(table), true);
  assert.strictEqual(loadMatch("hearts"), null,
    "a finished solo match went back into the slot a lobby tile resumes from");

  const shared = playSome(dealt(), 2);
  const hosted = hostTable(shared);
  persistTable(hosted);
  assert.strictEqual(hostMatches().length, 1);
  shared.gameOver = true;
  persistTable(hosted);
  assert.strictEqual(loadHostMatch(TABLE_ID), null,
    "a host who closes the tab on a finished game must not come back to it");
  assert.deepStrictEqual(hostMatches(), [], "and its index entry goes with it");
});

test("a match the player concluded is finished whatever the engine says", () => {
  installArcade({ state: true });
  const state = playSome(dealt(), 4);
  const table = soloTable(state);
  persistTable(table);
  assert.strictEqual(concludeTable(table), true);
  assert.strictEqual(table.concluded, true);
  assert.strictEqual(state.gameOver, false, "a walked-out match was never ended by the engine");
  assert.strictEqual(loadMatch("hearts"), null);
  // THE FLUSH THAT FOLLOWS. Every later write — the close, a suspend — reads the
  // mark, so the slot stays empty.
  persistTable(table);
  assert.strictEqual(loadMatch("hearts"), null, "a concluded match was written back by a later flush");
});

/* ------------------------------------------------------------------ *
 * #166, driven: End match from the round summary, then leave the table
 * ------------------------------------------------------------------ */

/**
 * A real match opened through the doors, with table.js's real save
 * (`persistMatch`/`flushTable` are `persistTable` of the felt's table), and the
 * round ending's own "End match" door walking it out — `exitToLobby` is the
 * felt's, which closes the table and so flushes it.
 *
 * @param open   what to open: `(doors) => doors.openTable(...)`
 * @param before a hook with the doors' store installed, to seed it
 */
async function endFromSummary(open, { before = () => {} } = {}) {
  const h = doorsHarness({ persist: true });
  before(h);
  await open(h.doors);
  const session = h.slots.session;
  playSome(session.table.state, 3);
  // The move path saves after every move; stand in for it once.
  persistTable(session.table);

  // roundEndingHarness installs an Arcade of its own; the doors' store is the
  // one this match lives in, so it goes back once the ending is built.
  const arcade = globalThis.Arcade;
  let exited = 0;
  const ending = roundEndingHarness({
    session,
    state: session.table.state,
    exitToLobby: () => { exited += 1; h.doors.closeTable(); },
  });
  globalThis.Arcade = arcade;
  await ending.ending.endMatchFromSummary();
  return { h, session, exited };
}

test("End match leaves nothing to resume once the table has closed (#166)", async () => {
  const { h, exited } = await endFromSummary((doors) => doors.openTable("hearts"));
  assert.strictEqual(exited, 1, "the walk-out must actually leave the table");
  assert.strictEqual(h.slots.session, null, "and leaving is closeTable, which flushes on the way out");
  assert.ok(h.calls.includes("flushTable"));
  assert.strictEqual(loadMatch("hearts"), null,
    "the forfeit was recorded and then the close's flush wrote the match back — the lobby tile "
    + "would offer to resume a game the player ended");
  assert.strictEqual(listMatchSummaries(["hearts"]).size, 0, "no in-progress ribbon on the tile");
  assert.strictEqual(readStats("hearts").played, 1, "walking out is recorded, once");
});

test("ending the day's run from the summary drops the daily and leaves the casual game (#166)", async () => {
  const casual = playSome(dealt("milestones", 3, 5), 2);
  const { h, session, exited } = await endFromSummary(
    (doors) => doors.openTable("milestones", { daily: true }),
    { before: () => saveMatch(casual) },
  );
  assert.ok(session.table.daily, "the daily door must have opened the day's run");
  assert.strictEqual(exited, 1);
  assert.strictEqual(h.slots.session, null);
  assert.strictEqual(loadMatch("milestones", { slot: "daily" }), null,
    "the day's run came back after it was ended");
  assert.strictEqual(loadMatch("milestones")?.log.length, 2, "the casual game went with the daily");
});

test("End match at a table we host walks the host out and leaves the shared game saved", async () => {
  // THE GAME GOES ON FOR THE PEOPLE STILL AT IT, so its save does too; ending
  // it for everybody is "Stop hosting". And the host's own solo game of the
  // same pack is nobody's business here — this path used to clear
  // `match.<packId>`, which at a hosted table is exactly that game.
  const solo = playSome(dealt("hearts", 4, 3), 2);
  const shared = dealt("hearts", 4, 9);
  let host = null;
  const { h, exited } = await endFromSummary(async (doors) => {
    host = hostTable(shared);
    host.seating = [];
    await doors.resumeHostedTable({ table: host });
  }, { before: () => saveMatch(solo) });
  assert.strictEqual(exited, 1);
  assert.strictEqual(h.slots.session, null);
  assert.strictEqual(host.concluded, false, "a shared game was marked over by one player leaving it");
  assert.strictEqual(loadHostMatch(TABLE_ID)?.log.length, shared.log.length,
    "the hosted table's save was dropped while it plays on for everybody else");
  assert.strictEqual(loadMatch("hearts")?.log.length, 2, "the host's unrelated solo game was cleared");
});
