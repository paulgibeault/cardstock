// A GAME WITH NO SIDES TAKES EXACTLY THE PATH IT ALWAYS DID.
//
// Partnerships (#104) rewrote the three places that ask "how is this seat
// doing" in terms of SIDES: `evaluateGameOver` compares a side's total to the
// threshold, `placements` ranks sides, and the bot's rollout grades a hand by
// the change in its SIDE's standing. Every one of those is meant to be the
// identity for a pack that declares no sides — one side per seat, a fold over a
// single term — and "meant to be" is exactly the claim a test has to make
// unfalsifiable.
//
// WHY THIS IS NOT A GOLDEN HASH, WHICH IS WHAT IT WAS FIRST. The original
// version walked the five shipped packs with the `hard` bot and pinned a digest
// of their serialized matches to a value taken from the commit before
// partnerships. It was wrong, and the way it was wrong is worth writing down
// because the instrument looked so convincing.
//
// A match payload is seed + log, and the log is the MOVES. So a digest of it is
// a freeze of WHAT THE BOT PLAYED — and the bot is the most-changed object in
// this workstream. #101 alone moved it twice, legitimately: `rankOrder` returns
// a ladder position now (the two is 0, not 2), and a latent floating-point tie
// in the sampler's `separated()` came down the other way. Both are correct
// changes to how a bot plays cards and neither has anything to do with
// partnerships — and the golden went red, with a failure message accusing the
// fold. A test that cries wolf at every honest change to a neighbouring module
// does not survive contact with #102, #103 and #105, all of which touch bots.
//
// THE FIX IS TO COMPARE THE TWO IMPLEMENTATIONS, NOT TO FREEZE THEIR INPUTS.
// The seat-keyed versions of all three functions are short, so they are
// REWRITTEN BELOW, from what the code said before #104, and the shipped
// side-aware ones are held to agreeing with them on every shipped pack. That is
// the actual claim ("for a pack with no sides, the side-aware path is the
// seat-aware path"), it is checked directly, and no bot change can move it.
//
// THE WALK IS A STATE GENERATOR, NOT A FIXTURE. It still plays the five packs,
// because real mid-match states are better material than states this file
// invented — but nothing below depends on WHICH move the bot chose, only on the
// positions it happened to produce. Perturb a bot weight and this file stays
// green; that is the property the golden lacked.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove, terminalValue } from "../src/engine/bot.js";
import { forkState } from "../src/engine/fork.js";
import { serializeMatch, MATCH_FORMAT_VERSION } from "../src/engine/replay.js";
import { evaluateGameOver } from "../src/engine/scoring.js";
import { placements } from "../src/stats/matchStats.js";
import { sidesOf } from "../src/engine/sides.js";
import { createRng } from "../src/engine/rng.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

/** Every shipped pack, at the seat count its lobby tile suggests. */
const TABLES = [
  ["crazy-eights", 4], ["milestones", 4], ["hearts", 4],
  ["wildfire", 4], ["stockpile", 4],
];

/* ------------------------------------------------------------------ *
 * The reference implementations — src/, as it read before #104
 * ------------------------------------------------------------------ */

/** `src/engine/scoring.js`'s evaluateGameOver, seat by seat. */
function gameOverBySeat(ctx) {
  const cfg = ctx.pack.scoring.gameOver;
  if (!cfg || cfg.when === "template") return null;
  const m = /^anyScore\s*>=\s*(\d+)$/.exec(cfg.when);
  if (!m) return null;
  const threshold = Number(m[1]);
  const over = Array.from({ length: ctx.seats }, (_, s) => ctx.score(s)).some((s) => s >= threshold);
  if (!over) return { over: false };
  let winner = 0;
  for (let s = 1; s < ctx.seats; s++) {
    if (cfg.winner === "lowestScore" && ctx.score(s) < ctx.score(winner)) winner = s;
    else if (cfg.winner === "highestScore" && ctx.score(s) > ctx.score(winner)) winner = s;
  }
  return { over: true, winner };
}

/** `src/stats/matchStats.js`'s placements, sorting seats. */
function placementsBySeat(pack, { totals, winner, seats }) {
  const lowWins = pack.scoring?.gameOver?.winner !== "highestScore";
  const order = Array.from({ length: seats }, (_, s) => s).sort((a, b) => {
    if (a === winner) return -1;
    if (b === winner) return 1;
    return lowWins ? totals[a] - totals[b] : totals[b] - totals[a];
  });
  const rank = new Array(seats).fill(0);
  order.forEach((seat, i) => { rank[seat] = i; });
  return rank;
}

/** `src/engine/bot.js`'s standingOf. Unchanged by #104 — the fold sits above it. */
function standingBySeat(state, seat) {
  const hook = state.pack.template.matchStanding;
  if (hook) {
    const value = hook(makeCtx(state), seat);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  const scoring = state.pack.scoring || state.pack.manifest?.scoring || {};
  const sign = scoring.gameOver?.winner === "highestScore" ? 1 : -1;
  return sign * (Number(state.scores?.[seat] ?? 0) || 0);
}

/** `src/engine/bot.js`'s terminalValue, differenced over SEATS. */
function terminalValueBySeat(before, after, seat) {
  let own = null;
  let others = 0;
  let n = 0;
  for (let s = 0; s < after.seats; s++) {
    const was = standingBySeat(before, s);
    const now = standingBySeat(after, s);
    if (was === null || now === null) return null;
    if (s === seat) own = now - was;
    else { others += now - was; n += 1; }
  }
  return own - (n ? others / n : 0);
}

/**
 * `===` rather than `assert.strictEqual`, which is SameValue and would call
 * `-0` a different number from `0`. A standing is `sign * score`, so a seat on
 * nothing in a penalty game legitimately produces `-0` down one path and `0`
 * down the other. Nobody is playing for negative zero.
 */
function same(got, want, message) {
  assert.ok(got === want, `${message} — side-aware said ${got}, seat-aware said ${want}`);
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

/**
 * Play a pack for a while, calling `visit(state)` before each move.
 *
 * `budgetMs: Infinity` and a fixed move budget, so the states are the same on
 * every machine — not because any assertion depends on the moves, but because a
 * test that visits different positions on CI than on a laptop is a test that
 * fails somewhere nobody can reproduce.
 */
async function walk(packId, seats, visit, limit = 40) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed: `identity:${packId}` });
  pack.template.setup(makeCtx(state));
  const template = pack.template;
  for (let i = 0; i < limit && !state.gameOver; i++) {
    const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    let move = null;
    for (const seat of acting) {
      move = chooseBotMove(state, seat, {
        difficulty: "hard",
        random: createRng(`identity:${packId}:${i}`).next,
        budgetMs: Infinity,
        budgetMoves: 300,
      });
      if (move) break;
    }
    if (!move) break;
    visit(state, i);
    applyMove(state, move);
  }
  return { pack, state };
}

/**
 * Score vectors to ask the two implementations about.
 *
 * A LIVE WALK IS NOT ENOUGH ON ITS OWN, and the reason is the whole shape of
 * this file's first attempt: mid-match nearly every seat is on nothing, so
 * `evaluateGameOver` answers `{over: false}` every time and two implementations
 * that both return a constant agree for free. These cross the threshold, tie on
 * it, sit either side of it, and go negative — Hearts' jack-of-diamonds variant
 * scores below zero, so that is a real position and not a hypothetical.
 */
function probeScores(seats, threshold) {
  const t = threshold ?? 100;
  return [
    Array.from({ length: seats }, () => 0),
    Array.from({ length: seats }, (_, s) => s * 3),
    Array.from({ length: seats }, (_, s) => (s === 1 ? t : t - 1)),
    Array.from({ length: seats }, () => t),                       // every seat tied on it
    Array.from({ length: seats }, (_, s) => (s === 0 ? t + 40 : 2)),
    Array.from({ length: seats }, (_, s) => (s % 2 ? -10 : t - 1)),
    Array.from({ length: seats }, (_, s) => t - 1 - s),
  ];
}

function thresholdOf(pack) {
  const m = /^anyScore\s*>=\s*(\d+)$/.exec(pack.scoring?.gameOver?.when || "");
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ *
 * The claims
 * ------------------------------------------------------------------ */

test("no shipped pack declares sides, so every seat is its own side", async () => {
  for (const [packId] of TABLES) {
    const pack = await loadPackFromDisk(packId);
    for (let seats = 2; seats <= 6; seats++) {
      assert.deepStrictEqual(
        sidesOf(pack, seats).map((side) => [...side]),
        Array.from({ length: seats }, (_, s) => [s]),
        `${packId} at ${seats} seats no longer has one side per seat — every fold below stops `
        + "being the identity, and a shipped game quietly starts scoring in pairs");
    }
  }
});

test("game over is decided on exactly the numbers it was decided on before sides", async () => {
  let decisive = 0;   // answers that were not the trivial {over: false}
  let asked = 0;
  for (const [packId, seats] of TABLES) {
    const { pack, state } = await walk(packId, seats, (live) => {
      const ctx = makeCtx(live);
      assert.deepStrictEqual(evaluateGameOver(ctx), gameOverBySeat(ctx),
        `${packId}: mid-match, the side-aware game-over disagreed with the seat-aware one`);
      asked += 1;
    });

    // And on scores a walk does not reach on its own.
    for (const scores of probeScores(seats, thresholdOf(pack))) {
      state.scores = scores.slice();
      const ctx = makeCtx(state);
      const got = evaluateGameOver(ctx);
      assert.deepStrictEqual(got, gameOverBySeat(ctx),
        `${packId}: on scores ${JSON.stringify(scores)} the side-aware game-over disagreed with `
        + "the seat-aware one — a teamless pack is being folded through something");
      asked += 1;
      if (got?.over) decisive += 1;
    }
  }
  assert.ok(asked > 100, `only ${asked} game-over questions asked`);
  assert.ok(decisive > 8,
    `only ${decisive} of ${asked} answers were an actual game over — two implementations that `
    + "both said {over: false} every time would agree for free");
});

test("placements rank the seats they always ranked", async () => {
  let reordered = 0;
  let asked = 0;
  for (const [packId, seats] of TABLES) {
    const pack = await loadPackFromDisk(packId);
    for (const totals of probeScores(seats, thresholdOf(pack))) {
      for (const winner of [null, 0, 1, seats - 1]) {
        const args = { totals, winner, seats };
        const got = placements(pack, args);
        assert.deepStrictEqual(got, placementsBySeat(pack, args),
          `${packId}: placements(${JSON.stringify(totals)}, winner ${winner}) disagreed with the `
          + "seat-sorting it replaced");
        asked += 1;
        if (got.some((rank, seat) => rank !== seat)) reordered += 1;
      }
    }
  }
  assert.ok(asked > 100, `only ${asked} placements compared`);
  assert.ok(reordered > 20,
    `only ${reordered} of ${asked} rankings actually moved a seat — a probe that only ever asks `
    + "about already-sorted totals compares two identity functions");
});

test("a finished hand grades exactly as it did when it was differenced over seats", async () => {
  let compared = 0;
  let nonzero = 0;
  for (const [packId, seats] of TABLES) {
    await walk(packId, seats, (live, step) => {
      // A synthetic round outcome. The two implementations are being compared on
      // ARITHMETIC, so what matters is that the deltas differ between seats and
      // change sign — not that this is a hand anybody played.
      const after = forkState(live);
      after.scores = live.scores.map((n, s) => n + (((s * 7 + step * 5) % 13) - 6));
      for (let seat = 0; seat < seats; seat++) {
        const got = terminalValue(live, after, seat);
        const want = terminalValueBySeat(live, after, seat);
        same(got, want, `${packId}: seat ${seat}'s terminal value at step ${step}`);
        compared += 1;
        if (got !== 0 && got !== null) nonzero += 1;
      }
    });
  }
  assert.ok(compared > 200, `only ${compared} terminal values compared`);
  assert.ok(nonzero > 100,
    `only ${nonzero} of ${compared} gradings were a number other than zero — two implementations `
    + "that both returned nothing would agree for free");
});

/* ------------------------------------------------------------------ *
 * The payload
 * ------------------------------------------------------------------ */

/** Every top-level key `serializeMatch` has ever written, in sorted order. */
const PAYLOAD_KEYS = [
  "formatVersion", "log", "packId", "packVersion", "savedAt", "seats", "seed", "variants",
];

test("a match payload carries the same eight fields it always did", async () => {
  for (const [packId, seats] of TABLES) {
    const { state } = await walk(packId, seats, () => {});
    const payload = serializeMatch(state, { savedAt: 0 });
    assert.deepStrictEqual(Object.keys(payload).sort(), PAYLOAD_KEYS,
      `${packId}: the match payload's shape changed. Partnerships deliberately added NOTHING to `
      + "it — sides are derived from the manifest (src/engine/sides.js) — so a new field here "
      + "means a stored match now needs migrating and MATCH_FORMAT_VERSION has to move with it");
    // Vacuity guard: a payload off a match nobody played would satisfy the shape
    // check and prove nothing about the walk that produced it.
    assert.ok(payload.log.length > 4,
      `${packId} played only ${payload.log.length} moves — too few for any of this to mean much`);
  }
});

test("the match format did not change, so no stored match needs migrating", () => {
  // The acceptance for #104 is "unchanged, or bumped with a migration". It is
  // unchanged, and for a reason worth pinning: partnerships added no field to a
  // match payload at all, so a pack that grows sides re-derives them on load and
  // every save written before this still replays.
  assert.strictEqual(MATCH_FORMAT_VERSION, 1);
});
