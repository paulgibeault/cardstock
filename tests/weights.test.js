// THE WEIGHTS ARE A PARAMETER, NOT A MOOD.
//
// A template's strategy numbers reach its hooks through `w` (CONTRACT.md,
// `weights`), so that two seats in one simulated game can hold two different
// opinions — the whole basis of tools/tune.mjs. Three things have to be true
// for that to mean anything, and each is the kind that silently stops being
// true when somebody adds a constant and reads it directly:
//
//   1. THE DEFAULT IS THE TEMPLATE. Passing `template.weights` explicitly
//      ranks exactly as passing nothing does.
//   2. EVERY WEIGHT IS READ THROUGH `w`. A weight the hooks ignore is a knob
//      the tuner turns to no effect, so each one, perturbed hard, has to change
//      some decision somewhere — or it does not belong in the object.
//   3. NOTHING LEAKS BETWEEN SEATS. A seat ranked with the shipped weights
//      gets the same answer whether or not another seat was just ranked with
//      strange ones. Module-level "current weights" state would fail this.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove, rankMoves } from "../src/engine/bot.js";
import { createRng } from "../src/engine/rng.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

const TABLES = [["milestones", 3], ["hearts", 4], ["wildfire", 3]];

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/** Walk a bot-vs-bot game, calling `visit(state, seat)` before each move. */
function walk(state, limit, visit) {
  const template = state.pack.template;
  for (let i = 0; i < limit && !state.gameOver; i++) {
    const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    let move = null;
    let actor = null;
    for (const seat of acting) {
      move = chooseBotMove(state, seat);
      if (move) { actor = seat; break; }
    }
    if (!move) return;
    visit(state, actor);
    applyMove(state, move);
  }
}

const ranking = (state, seat, opts) => JSON.stringify(rankMoves(state, seat, opts).map((r) => [r.move, r.score]));

test("passing the template's own weights ranks exactly as passing none", async () => {
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `weights:default:${packId}`);
    const weights = state.pack.template.weights;
    assert.ok(weights, `${packId}: no weights to test`);
    let checked = 0;
    walk(state, 120, (live, seat) => {
      for (const difficulty of ["easy", "medium"]) {
        assert.strictEqual(ranking(live, seat, { difficulty, weights }), ranking(live, seat, { difficulty }),
          `${packId} at ${difficulty}: the template's own weights ranked differently from the default`);
      }
      // `hard` samples, so it is compared under a seeded, move-capped budget.
      const hard = (extra) => ranking(live, seat, {
        difficulty: "hard", random: createRng("w").next, budgetMs: Infinity, budgetMoves: 600, ...extra,
      });
      assert.strictEqual(hard({ weights }), hard({}), `${packId} at hard: weights changed the sampling`);
      checked++;
    });
    assert.ok(checked > 30, `${packId}: only ${checked} positions checked`);
  }
});

/**
 * A contract-rummy table with every kind of contract on it at once.
 *
 * A walk from a fresh deal spends its first fifty moves on round one, which is
 * two sets, and never reaches the colour group at rung eight — so a weight
 * that only speaks under a colour-group contract looks unread. Rungs are
 * per-seat state, so three seats can owe a colour group, a run and two sets
 * in the same hand, and then every term has a seat that exercises it.
 */
function spreadContracts(state) {
  if (!state.pack.rules.contracts) return;
  const ctx = makeCtx(state);
  const rungs = [8, 4, 1];
  for (let s = 0; s < state.seats; s++) ctx.setPlayerVar(s, "phase", rungs[s % rungs.length]);
}

test("every weight a template declares is one its hooks actually read", async () => {
  for (const [packId, seats] of TABLES) {
    const template = (await dealt(packId, seats, "probe")).pack.template;
    for (const key of Object.keys(template.weights)) {
      // Perturbed hard, in both directions, because a single direction can
      // land on a value the position happens to be indifferent to.
      let moved = false;
      for (const factor of [0, 8]) {
        const weights = { ...template.weights, [key]: template.weights[key] * factor + (factor === 0 ? -5 : 0) };
        const state = await dealt(packId, seats, `weights:read:${packId}:${key}`);
        spreadContracts(state);
        walk(state, 200, (live, seat) => {
          if (moved) return;
          for (const difficulty of ["easy", "medium"]) {
            if (ranking(live, seat, { difficulty, weights }) !== ranking(live, seat, { difficulty })) moved = true;
          }
        });
        if (moved) break;
      }
      assert.ok(moved, `${packId}: weights.${key} was perturbed and no ranking changed — the hooks do not read it`);
    }
  }
});

test("one seat's weights do not leak into the next seat's ranking", async () => {
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `weights:leak:${packId}`);
    const template = state.pack.template;
    const strange = Object.fromEntries(Object.keys(template.weights).map((k) => [k, -template.weights[k] * 3 - 1]));
    walk(state, 120, (live, seat) => {
      const before = ranking(live, seat, { difficulty: "medium" });
      const other = (seat + 1) % live.seats;
      rankMoves(live, other, { difficulty: "medium", weights: strange });
      rankMoves(live, seat, { difficulty: "medium", weights: strange });
      assert.strictEqual(ranking(live, seat, { difficulty: "medium" }), before,
        `${packId}: ranking seat ${seat} with strange weights changed its ranking with the shipped ones`);
    });
  }
});
