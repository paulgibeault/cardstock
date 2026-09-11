// The daily run's BOOKKEEPING: its own save slot, its own record, and a streak
// that counts days rather than wins.
//
// The generator has its own suite (tests/dailyLadder.test.js). This one is
// about the two things a player would notice going wrong around it:
//
//   "Opening the daily ate my Milestones game."  — one slot per pack was the
//   bug `match.<packId>` fixed for packs, and a daily written to that key would
//   have re-made it inside one pack.
//
//   "I played every day and the streak says 1."  — a streak that counts
//   consecutive calendar days is the whole of what a daily is played for, and
//   it is arithmetic nobody sees until it is wrong a week later.
//
// src/ui/lobby.js and src/ui/table.js cannot be imported here (they touch the
// DOM at import), so what is pinned is the storage contract they both go
// through, and the felt is verified headlessly.

import { test, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { ROOT } from "../tools/stage.mjs";
import { dailyRunFor, applyDailyLadder } from "../src/engine/dailyLadder.js";
import {
  MATCH_KEY_PREFIX, DAILY_KEY_PREFIX, matchKey, dailyKey, isDailyKey, isMatchKey,
  saveMatch, loadMatch, clearMatch, listMatchSummaries,
  readDailyStats, recordDailyResult, dailyStatsCategory, dailyStatus, readStats,
} from "../src/arcade/storage.js";
import { createMatchRecord } from "../src/ui/matchRecord.js";

// The SDK's two synchronous surfaces, as the Maps storage.js actually uses.
const store = new Map();
const stats = new Map();
globalThis.Arcade = {
  state: {
    get: (k) => store.get(k),
    set: (k, v) => { store.set(k, structuredClone(v)); return true; },
    remove: (k) => store.delete(k),
    getOrInit: (k, d) => (store.has(k) ? store.get(k) : d),
  },
  stats: {
    get: (c) => stats.get(c),
    getOrInit: (c, d) => (stats.has(c) ? { ...d, ...stats.get(c) } : d),
    update: (c, fn) => { stats.set(c, structuredClone(fn(stats.get(c) || {}))); },
  },
};

beforeEach(() => { store.clear(); stats.clear(); });

function packFromDisk(packId = "milestones") {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(structuredClone(manifest), { deckJson });
}

/** A real match, some moves in — under a seed the caller chooses. */
function playedMatch(pack, seed, moves = 6) {
  const state = createState({ pack, seats: 4, seed });
  pack.template.setup(makeCtx(state));
  for (let i = 0; i < moves && !state.gameOver; i++) {
    const move = chooseBotMove(state, state.turn.seat);
    if (!move) break;
    applyMove(state, move);
  }
  return state;
}

/** Today's run of `pack`, dealt and played a few moves, exactly as the table deals it. */
function playedDaily(date, moves = 6) {
  const pack = packFromDisk();
  const run = dailyRunFor(pack, date);
  applyDailyLadder(pack, run.ladder);
  return { run, state: playedMatch(pack, run.seed, moves) };
}

/* ------------------------------------------------------------------ *
 * Two games of one pack
 * ------------------------------------------------------------------ */

test("the daily slot is a key of its own, recognisable as one", () => {
  assert.strictEqual(dailyKey("milestones"), `${DAILY_KEY_PREFIX}milestones`);
  assert.ok(isDailyKey(dailyKey("milestones")));
  assert.ok(!isMatchKey(dailyKey("milestones")));
  assert.ok(!isDailyKey(matchKey("milestones")));
  assert.notStrictEqual(DAILY_KEY_PREFIX, MATCH_KEY_PREFIX);
});

test("a daily run and a casual game of the same pack both survive", () => {
  const pack = packFromDisk();
  const casual = playedMatch(pack, "casual:milestones", 8);
  const { state: daily } = playedDaily("2026-09-10", 4);

  saveMatch(casual);
  saveMatch(daily, { slot: "daily" });

  assert.strictEqual(loadMatch("milestones").log.length, casual.log.length);
  assert.strictEqual(loadMatch("milestones", { slot: "daily" }).log.length, daily.log.length);
  assert.notStrictEqual(casual.log.length, daily.log.length,
    "the two saves have to differ or this proves nothing");
  // And they are genuinely two slots, not one read twice.
  assert.notStrictEqual(loadMatch("milestones").seed, loadMatch("milestones", { slot: "daily" }).seed);
});

test("clearing one slot leaves the other alone", () => {
  const pack = packFromDisk();
  saveMatch(playedMatch(pack, "casual:milestones", 8));
  saveMatch(playedDaily("2026-09-10", 4).state, { slot: "daily" });

  clearMatch("milestones", { slot: "daily" });
  assert.ok(loadMatch("milestones"), "the casual game went with the daily");
  assert.strictEqual(loadMatch("milestones", { slot: "daily" }), null);

  saveMatch(playedDaily("2026-09-10", 4).state, { slot: "daily" });
  clearMatch("milestones");
  assert.strictEqual(loadMatch("milestones"), null);
  assert.ok(loadMatch("milestones", { slot: "daily" }), "the daily went with the casual game");
});

test("the lobby's in-progress ribbons never show a daily", () => {
  saveMatch(playedDaily("2026-09-10", 4).state, { slot: "daily" });
  // The daily has its own control saying what it is; a "game in progress"
  // ribbon on the tile would be offering a resume the tile's own button owns.
  assert.strictEqual(listMatchSummaries(["milestones"]).size, 0);
  saveMatch(playedMatch(packFromDisk(), "casual:milestones", 8));
  assert.strictEqual(listMatchSummaries(["milestones"]).size, 1);
});

test("a daily save carries the day in its seed, and nothing about the ladder", () => {
  const { run, state } = playedDaily("2026-09-10", 4);
  saveMatch(state, { slot: "daily" });
  const stored = loadMatch("milestones", { slot: "daily" });
  assert.strictEqual(stored.seed, "milestones|2026-09-10");
  assert.strictEqual(stored.formatVersion, 1, "a daily needed no new payload shape");
  assert.ok(!("contracts" in stored), "the ladder must be re-derived, never stored");
  assert.ok(!("daily" in stored), "the key says it is a daily; the payload need not");
  assert.deepStrictEqual(run.ladder.contracts.length, 10);
});

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

test("a daily record starts empty and lives under its own category", () => {
  const record = readDailyStats("milestones");
  assert.deepStrictEqual(
    { played: record.played, won: record.won, streak: record.streak, lastDate: record.lastDate },
    { played: 0, won: 0, streak: 0, lastDate: null });
  recordDailyResult("milestones", "2026-09-10", { won: true, hands: 7 });
  assert.ok(stats.has(dailyStatsCategory("milestones")));
  assert.ok(!stats.has("milestones"), "a daily must not touch the pack's own record");
});

test("the streak counts consecutive days, and a gap starts it over", () => {
  recordDailyResult("milestones", "2026-09-08", { won: true, hands: 6 });
  assert.strictEqual(readDailyStats("milestones").streak, 1);
  recordDailyResult("milestones", "2026-09-09", { won: true, hands: 9 });
  assert.strictEqual(readDailyStats("milestones").streak, 2);
  // A day skipped entirely: the run is broken even though nothing was lost.
  recordDailyResult("milestones", "2026-09-11", { won: true, hands: 5 });
  const after = readDailyStats("milestones");
  assert.strictEqual(after.streak, 1);
  assert.strictEqual(after.bestStreak, 2);
  assert.strictEqual(after.played, 3);
  assert.strictEqual(after.won, 3);
});

test("a loss ends the streak but keeps the best", () => {
  recordDailyResult("milestones", "2026-09-08", { won: true });
  recordDailyResult("milestones", "2026-09-09", { won: true });
  recordDailyResult("milestones", "2026-09-10", { won: false });
  const record = readDailyStats("milestones");
  assert.strictEqual(record.streak, 0);
  assert.strictEqual(record.bestStreak, 2);
  assert.strictEqual(record.played, 3);
  assert.strictEqual(record.won, 2);
  // Winning the day AFTER a loss is a new run of one, not a continuation.
  recordDailyResult("milestones", "2026-09-11", { won: true });
  assert.strictEqual(readDailyStats("milestones").streak, 1);
});

test("a day can only be recorded once", () => {
  recordDailyResult("milestones", "2026-09-10", { won: true, hands: 7 });
  // The table concludes a finished match AND the "End match" door records a
  // forfeit; a player who does both must not be able to play the streak twice.
  recordDailyResult("milestones", "2026-09-10", { won: false, hands: 99 });
  const record = readDailyStats("milestones");
  assert.strictEqual(record.played, 1);
  assert.strictEqual(record.won, 1);
  assert.strictEqual(record.streak, 1);
  assert.strictEqual(record.lastHands, 7);
});

test("a record written by an older build reads as a record, not as NaN", () => {
  stats.set(dailyStatsCategory("milestones"), { played: 3, won: 2 });
  const record = readDailyStats("milestones");
  assert.strictEqual(record.streak, 0);
  assert.strictEqual(record.bestStreak, 0);
  assert.strictEqual(record.lastDate, null);
  recordDailyResult("milestones", "2026-09-10", { won: true, hands: 4 });
  assert.strictEqual(readDailyStats("milestones").played, 4);
  assert.strictEqual(readDailyStats("milestones").streak, 1);
});

test("garbage in the record and garbage dates are both refused", () => {
  stats.set(dailyStatsCategory("milestones"), { lastDate: "yesterday, probably" });
  assert.strictEqual(readDailyStats("milestones").lastDate, null);
  recordDailyResult("milestones", "not-a-date", { won: true });
  assert.strictEqual(readDailyStats("milestones").played, 0);
  recordDailyResult("../../etc", "2026-09-10", { won: true });
  assert.strictEqual(stats.size, 1, "an invalid pack id must not mint a category");
});

/* ------------------------------------------------------------------ *
 * The ending
 * ------------------------------------------------------------------ */

/** A whole daily run, bots at every seat, played to the pack's own game over. */
function finishedDaily(date) {
  const pack = packFromDisk();
  const run = dailyRunFor(pack, date);
  applyDailyLadder(pack, run.ladder);
  const state = createState({ pack, seats: 4, seed: run.seed });
  pack.template.setup(makeCtx(state));
  for (let i = 0; i < 40000 && !state.gameOver; i++) {
    const move = chooseBotMove(state, state.turn.seat);
    if (!move) break;
    applyMove(state, move);
  }
  assert.ok(state.gameOver, `the ${date} daily never ended`);
  return { run, state };
}

function recordFor(run) {
  return createMatchRecord({
    me: { seat: () => 0, holds: (s) => s === 0 },
    seating: () => [],
    art: () => ({ face: () => "" }),
    onConclude: () => {},
    daily: () => run,
  });
}

test("finishing a daily writes the daily record and leaves the pack's alone", () => {
  const { run, state } = finishedDaily("2026-09-10");
  saveMatch(state, { slot: "daily" });
  const casual = playedMatch(packFromDisk(), "casual:milestones", 8);
  saveMatch(casual);

  const ending = recordFor({ date: run.date, seed: run.seed }).concludeMatch(state, { hints: 0 });

  const record = readDailyStats("milestones");
  assert.strictEqual(record.played, 1);
  assert.strictEqual(record.lastDate, run.date);
  assert.strictEqual(record.lastHands, state.roundNumber);
  assert.strictEqual(record.won, state.winner === 0 ? 1 : 0);
  assert.strictEqual(record.streak, state.winner === 0 ? 1 : 0);
  // The pack's lifetime record is a record of the ladder the pack SHIPS.
  assert.strictEqual(readStats("milestones").played, 0);
  assert.ok(!stats.has("milestones"));
  // The finished run is not something to walk back into; the casual game is.
  assert.strictEqual(loadMatch("milestones", { slot: "daily" }), null);
  assert.strictEqual(loadMatch("milestones").log.length, casual.log.length);
  assert.deepStrictEqual(ending.daily, { date: run.date, seed: run.seed });
  assert.match(ending.recordText, /daily run/);
});

test("finishing an ordinary match still goes in the pack's own book", () => {
  const { state } = finishedDaily("2026-09-10");
  saveMatch(state);
  recordFor(null).concludeMatch(state, { hints: 2 });
  assert.strictEqual(readStats("milestones").played, 1);
  assert.strictEqual(readDailyStats("milestones").played, 0);
  assert.strictEqual(loadMatch("milestones"), null);
});

/* ------------------------------------------------------------------ *
 * What the tile reads
 * ------------------------------------------------------------------ */

test("dailyStatus says not-played, in-progress and finished, in that order", () => {
  const today = "2026-09-10";
  let status = dailyStatus("milestones", { today });
  assert.deepStrictEqual(
    { finished: status.finished, inProgress: status.inProgress, streak: status.streak },
    { finished: false, inProgress: null, streak: 0 });

  const { state } = playedDaily(today, 6);
  saveMatch(state, { slot: "daily" });
  status = dailyStatus("milestones", { today });
  assert.strictEqual(status.finished, false);
  assert.ok(status.inProgress, "a saved run for today is a run in progress");
  assert.strictEqual(status.inProgress.moves, state.log.length);

  recordDailyResult("milestones", today, { won: true, hands: 7 });
  status = dailyStatus("milestones", { today });
  assert.strictEqual(status.finished, true);
  assert.strictEqual(status.won, true);
  assert.strictEqual(status.hands, 7);
  assert.strictEqual(status.inProgress, null, "a finished day has nothing left to resume");
});

test("yesterday's unfinished run is not today's", () => {
  const { state } = playedDaily("2026-09-09", 6);
  saveMatch(state, { slot: "daily" });
  const status = dailyStatus("milestones", { today: "2026-09-10" });
  assert.strictEqual(status.inProgress, null,
    "a save from another day was offered as today's run");
  assert.strictEqual(status.finished, false);
  // And yesterday's RESULT does not read as today's either.
  recordDailyResult("milestones", "2026-09-09", { won: true, hands: 4 });
  const next = dailyStatus("milestones", { today: "2026-09-10" });
  assert.strictEqual(next.finished, false);
  assert.strictEqual(next.streak, 1, "the streak survives into the new day");
});

test("dailyStatus refuses a pack id that is not one", () => {
  assert.strictEqual(dailyStatus("../../etc"), null);
  assert.strictEqual(dailyStatus(undefined), null);
});
