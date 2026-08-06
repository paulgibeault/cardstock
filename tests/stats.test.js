// Match stats and the record they feed.
//
// The claim under test is the one that made this feature cheap: STATS ARE
// DERIVED, NOT TALLIED. Nothing counts anything while a game is played — the
// log is replayed at the end and counted once (src/stats/matchStats.js). The
// payoff is that the numbers cannot drift from the game; the risk is that a
// replay that diverges would report a match nobody played. So these tests
// replay real bot-vs-bot games and check the counters against the state the
// same log produces.
import { test, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { serializeMatch, rehydrateMatch } from "../src/engine/replay.js";
import { computeMatchStats, statLinesFor, placements } from "../src/stats/matchStats.js";
import { ROOT } from "../tools/stage.mjs";

// storage.js talks to the SDK's synchronous key/value surface and nothing else;
// a Map is the whole of what it needs. Stood up here rather than as a seam in
// the production module.
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
    getOrInit: (k, d) => (stats.has(k) ? stats.get(k) : d),
    update: (k, fn) => { stats.set(k, structuredClone(fn(stats.get(k)))); },
  },
};

const { recordResult, readStats, readHeadToHead, loadHandPrefs, saveHandPrefs } =
  await import("../src/arcade/storage.js");

beforeEach(() => { store.clear(); stats.clear(); });

function packFromDisk(packId) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

/** A real game, bot against bot, to the end or to a move cap. */
function playOut(packId, { seed = `stats:${packId}`, maxMoves = 600 } = {}) {
  const pack = packFromDisk(packId);
  const state = createState({ pack, seats: 3, seed });
  pack.template.setup(makeCtx(state));
  for (let i = 0; i < maxMoves && !state.gameOver; i++) {
    const template = pack.template;
    const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    const seat = acting[0];
    if (seat === undefined) break;
    const move = chooseBotMove(state, seat);
    if (!move) break;
    applyMove(state, move);
  }
  return { pack, state };
}

const PACKS = ["crazy-eights", "wildfire", "hearts", "milestones", "stockpile"];

test("stats replay to the same scores the live match ended on", () => {
  for (const packId of PACKS) {
    const { pack, state } = playOut(packId);
    const computed = computeMatchStats(pack, serializeMatch(state));
    assert.deepStrictEqual(computed.totals, state.scores,
      `${packId}: replayed scores diverged from the played match`);
    assert.strictEqual(computed.gameOver, state.gameOver, `${packId}: game-over diverged`);
    assert.strictEqual(computed.winner, state.winner, `${packId}: winner diverged`);
    assert.strictEqual(computed.moves, state.log.length);
  }
});

test("per-seat move counts add up to the whole log", () => {
  for (const packId of PACKS) {
    const { pack, state } = playOut(packId);
    const computed = computeMatchStats(pack, serializeMatch(state));
    const counted = computed.perSeat.reduce((sum, s) => sum + s.moves, 0);
    assert.strictEqual(counted, state.log.length, `${packId}: moves lost in the count`);
  }
});

test("every trick in a Hearts match is counted exactly once", () => {
  const { pack, state } = playOut("hearts");
  const computed = computeMatchStats(pack, serializeMatch(state));
  const tricks = computed.perSeat.reduce((sum, s) => sum + s.tricksWon, 0);
  const played = computed.perSeat.reduce((sum, s) => sum + s.cardsPlayed, 0);
  // Passing moves are not card plays, so every played card belongs to a trick.
  assert.strictEqual(tricks * state.seats, played,
    "tricks won should account for every card played");
  assert.ok(tricks > 0, "a played-out Hearts match must contain tricks");
});

test("an in-progress match reports stats too — the same function, mid-game", () => {
  const { pack, state } = playOut("crazy-eights", { maxMoves: 15 });
  const computed = computeMatchStats(pack, serializeMatch(state));
  assert.strictEqual(computed.moves, state.log.length);
  assert.strictEqual(computed.gameOver, false);
});

test("stat lines are non-empty and template-appropriate for every pack", () => {
  for (const packId of PACKS) {
    const { pack, state } = playOut(packId);
    const computed = computeMatchStats(pack, serializeMatch(state));
    const lines = statLinesFor(pack.template, computed.perSeat[0]);
    assert.ok(lines.length > 0, `${packId}: no stat lines at all`);
    for (const l of lines) {
      assert.ok(typeof l.label === "string" && l.label, `${packId}: unlabelled stat`);
      assert.ok(typeof l.value === "string", `${packId}: stat value must render as text`);
    }
  }
});

test("a log the current rules refuse throws, rather than reporting a fiction", () => {
  const { pack, state } = playOut("crazy-eights", { maxMoves: 10 });
  const snapshot = serializeMatch(state);
  snapshot.log.push({ actor: 0, type: "playCard", cards: ["not-a-card"] });
  assert.throws(() => computeMatchStats(pack, snapshot));
});

test("placements rank by the pack's own direction, with the winner pinned first", () => {
  const hearts = packFromDisk("hearts");        // lowestScore wins
  const wildfire = packFromDisk("wildfire");    // highestScore wins

  assert.deepStrictEqual(
    placements(hearts, { totals: [5, 1, 9], winner: 1, seats: 3 }),
    [1, 0, 2], "Hearts: fewest points finishes highest");

  assert.deepStrictEqual(
    placements(wildfire, { totals: [5, 1, 9], winner: 2, seats: 3 }),
    [1, 2, 0], "Wildfire: most points finishes highest");

  // The engine's declared winner outranks the raw totals, whatever they say.
  assert.strictEqual(placements(hearts, { totals: [9, 1, 5], winner: 0, seats: 3 })[0], 0);
});

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

test("a win, a loss and a forfeit are counted as three different things", () => {
  recordResult("hearts", { won: true, opponents: [] });
  recordResult("hearts", { won: false, opponents: [] });
  recordResult("hearts", { won: false, forfeit: true, opponents: [] });

  const record = readStats("hearts");
  assert.strictEqual(record.played, 3);
  assert.strictEqual(record.won, 1);
  assert.strictEqual(record.forfeits, 1, "walking away must be visible in the record");
});

test("streaks build and break", () => {
  for (let i = 0; i < 3; i++) recordResult("hearts", { won: true, opponents: [] });
  assert.strictEqual(readStats("hearts").streak, 3);
  assert.strictEqual(readStats("hearts").bestStreak, 3);

  recordResult("hearts", { won: false, opponents: [] });
  assert.strictEqual(readStats("hearts").streak, 0, "a loss ends the run");
  assert.strictEqual(readStats("hearts").bestStreak, 3, "but not the best one");
});

test("head-to-head records who you finished ahead of, not just who you beat outright", () => {
  // The three-seat case the feature exists for: a loss overall can still be a
  // win against one of the two opponents.
  recordResult("hearts", {
    won: false,
    opponents: [
      { key: "bot:juniper", beaten: true },
      { key: "bot:otto", beaten: false },
    ],
  });
  assert.deepStrictEqual(readHeadToHead("hearts", "bot:juniper"), { played: 1, won: 1 });
  assert.deepStrictEqual(readHeadToHead("hearts", "bot:otto"), { played: 1, won: 0 });
  assert.strictEqual(readHeadToHead("hearts", "bot:never-met"), null);
});

test("a peer key files alongside a bot key without colliding with it", () => {
  recordResult("hearts", {
    won: true,
    opponents: [{ key: "bot:juniper", beaten: true }, { key: "peer:device-abc", beaten: true }],
  });
  const record = readStats("hearts");
  assert.deepStrictEqual(Object.keys(record.opponents).sort(),
    ["bot:juniper", "peer:device-abc"]);
});

test("a malformed opponent key never reaches the record", () => {
  recordResult("hearts", {
    won: true,
    opponents: [
      { key: "juniper", beaten: true },              // no namespace
      { key: "bot:../../etc", beaten: true },        // path-ish
      { key: "", beaten: true },
      { key: undefined, beaten: true },
      { key: "bot:juniper", beaten: true },          // the only good one
    ],
  });
  assert.deepStrictEqual(Object.keys(readStats("hearts").opponents), ["bot:juniper"]);
});

test("a record written before these fields existed still reads", () => {
  // The migration IS the merge over the defaults; there is no upgrade step to
  // forget to run.
  stats.set("hearts", { played: 4, won: 2 });
  const record = readStats("hearts");
  assert.strictEqual(record.played, 4);
  assert.strictEqual(record.forfeits, 0);
  assert.deepStrictEqual(record.opponents, {});

  recordResult("hearts", { won: true, opponents: [{ key: "bot:pip", beaten: true }] });
  assert.strictEqual(readStats("hearts").played, 5);
  assert.deepStrictEqual(readHeadToHead("hearts", "bot:pip"), { played: 1, won: 1 });
});

test("hand preferences are per pack and survive a round trip", () => {
  assert.deepStrictEqual(loadHandPrefs("hearts"), { mode: "auto", order: [] });

  saveHandPrefs("hearts", { mode: "manual", order: ["spades-A", "hearts-2"] });
  saveHandPrefs("wildfire", { mode: "suit", order: [] });

  assert.deepStrictEqual(loadHandPrefs("hearts"),
    { mode: "manual", order: ["spades-A", "hearts-2"] });
  assert.strictEqual(loadHandPrefs("wildfire").mode, "suit");
  assert.strictEqual(saveHandPrefs("../evil", { mode: "manual", order: [] }), false);
});

test("a stats replay is the same replay resuming uses", () => {
  // Both go through the reducer, so a divergence here would mean a resumed
  // game and its own stats disagreed about what had happened.
  const { pack, state } = playOut("milestones", { maxMoves: 60 });
  const snapshot = serializeMatch(state);
  const resumed = rehydrateMatch(pack, snapshot);
  const computed = computeMatchStats(pack, snapshot);
  assert.deepStrictEqual(computed.totals, resumed.scores);
});
