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

// One table per template, plus a second for trick-taking — because that
// template now houses two games with different currencies, and a weight only
// speaks at a pack whose RULES reach the code that reads it. Hearts takes no
// bid, so its ranking cannot possibly move when a contract weight is perturbed;
// Team Spades is where those live (#105).
const TABLES = [["milestones", 3], ["hearts", 4], ["wildfire", 3], ["team-spades", 4], ["thirteen", 4], ["pinochle", 4],
  // Stockpile joined the list when sequencing grew an evaluator and a weights
  // bag of its own (#160). Its table is the one where the rival term is a fact
  // rather than an inference — every seat's stock top is face up — so a weight
  // that reads the opposition has somewhere to be exercised.
  ["stockpile", 4]];

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

/**
 * ASKED PER TEMPLATE, ACROSS EVERY TABLE THAT USES IT — which is a weaker claim
 * than the per-pack one this started as, and the only true one.
 *
 * The per-pack version was right while every template had one shape of game
 * under it. Trick-taking now has two: Hearts, which is scored in the points its
 * cards charge, and Team Spades, which is scored on a promise and reads a
 * different half of the same hooks (#105). A contract weight perturbed at a
 * Hearts table cannot move anything, because Hearts never bids — and asserting
 * that it does would only ever be satisfied by deleting the weight or by faking
 * a bid in a pack that has none.
 *
 * What is still asserted, and is the thing worth asserting: a weight in the
 * frozen bag must change SOME decision at SOME table. A knob no shipped pack
 * can turn is still a lie to the tuner.
 */
test("every weight a template declares is one its hooks actually read", async () => {
  const probes = new Map();   // `${templateId}.${key}` -> { moved, packs }
  for (const [packId, seats] of TABLES) {
    const template = (await dealt(packId, seats, "probe")).pack.template;
    for (const key of Object.keys(template.weights)) {
      const id = `${template.id}.${key}`;
      const probe = probes.get(id) || { moved: false, packs: [] };
      probes.set(id, probe);
      // Proven at an earlier table: nothing to learn from proving it twice, and
      // the probe is the expensive half of this file.
      if (probe.moved) continue;
      probe.packs.push(packId);
      // Perturbed hard, in both directions, because a single direction can
      // land on a value the position happens to be indifferent to.
      for (const factor of [0, 8]) {
        const weights = { ...template.weights, [key]: template.weights[key] * factor + (factor === 0 ? -5 : 0) };
        const state = await dealt(packId, seats, `weights:read:${packId}:${key}`);
        spreadContracts(state);
        // FOUR HUNDRED MOVES, NOT TWO. A weight that only speaks in a position
        // the walk has to reach is hostage to the deal, and this one is: fixing
        // Thirteen's deal to honour `state.direction` (#156) re-dealt the seeded
        // game, and the first position offering `climbing.CHOP_COST` an
        // out-of-shape bomb moved from inside 200 moves to step 229. The weight
        // is read; the walk was short. The probe stops the moment a weight
        // moves, so the longer budget is only ever spent on the ones that have
        // not been proven yet.
        walk(state, 400, (live, seat) => {
          if (probe.moved) return;
          for (const difficulty of ["easy", "medium"]) {
            if (ranking(live, seat, { difficulty, weights }) !== ranking(live, seat, { difficulty })) probe.moved = true;
          }
        });
        if (probe.moved) break;
      }
    }
  }
  for (const [id, probe] of probes) {
    assert.ok(probe.moved,
      `weights.${id} was perturbed at ${probe.packs.join(", ")} and no ranking changed — `
      + "the hooks do not read it at any table that exercises them");
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
