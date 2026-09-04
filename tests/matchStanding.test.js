// THE TERMINAL SIGNAL, AND WHAT IT IS ALLOWED TO BE.
//
// A `hard` rollout that reaches the end of a hand is graded by how far along
// the MATCH it left the seat (src/engine/bot.js, `terminalValue`). Two claims
// are pinned here, in opposite directions:
//
//   1. A template WITHOUT `matchStanding` is scored exactly as it always was:
//      the difference in accumulated score across the hand, signed by the
//      manifest. That is the round score, so nothing about Hearts or Crazy
//      Eights moved when the hook was added — and it has to be shown rather
//      than assumed, because an equivalence nobody tested is the kind that
//      drifts.
//   2. A template WITH it is scored by it. Contract-rummy says a rung outranks
//      any number of points (#92), and ripping the hook out has to change what
//      the hard bot plays; if it does not, the hook is decoration.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { createRng } from "../src/engine/rng.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/**
 * Reproducible `hard`, with every rollout played to the END of the hand.
 *
 * `depth: Infinity` is the point: at the shipped depth a rollout is cut off
 * and graded by `evaluateState`, and the terminal signal under test is only
 * read from rollouts that finish. The budget is small so the suite stays
 * quick, and `budgetMs: Infinity` makes the sample count depend on nothing but
 * the seed — the same decision has to be asked twice below.
 */
function hardOptions(seed) {
  return {
    difficulty: "hard",
    random: createRng(seed).next,
    budgetMs: Infinity,
    budgetMoves: 900,
    depth: Infinity,
  };
}

const key = (move) => JSON.stringify(move);

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

/** Run `body` with `template.matchStanding` replaced (or removed, for undefined). */
function withStanding(template, hook, body) {
  const had = Object.prototype.hasOwnProperty.call(template, "matchStanding");
  const real = template.matchStanding;
  if (hook === undefined) delete template.matchStanding;
  else template.matchStanding = hook;
  try {
    return body();
  } finally {
    if (had) template.matchStanding = real;
    else delete template.matchStanding;
  }
}

test("a template with no matchStanding is graded by its round score, as before", async () => {
  // The default standing is the accumulated score signed by the manifest.
  // Installing a hook that says exactly that must change nothing, and
  // installing one that says the opposite must change something — otherwise
  // the equivalence is vacuous because the hook is never consulted.
  for (const [packId, seats, sign] of [["hearts", 4, -1], ["crazy-eights", 2, +1]]) {
    const state = await dealt(packId, seats, `standing:${packId}`);
    const template = state.pack.template;
    assert.strictEqual(template.matchStanding, undefined,
      `${packId} has grown a matchStanding — pick another pack for the default's proof`);
    let decisions = 0;
    let flipped = 0;
    walk(state, 70, (live, seat) => {
      const plain = key(chooseBotMove(live, seat, hardOptions("plain")));
      const same = withStanding(template, (ctx, s) => sign * ctx.score(s),
        () => key(chooseBotMove(live, seat, hardOptions("plain"))));
      assert.strictEqual(same, plain,
        `${packId}: a matchStanding equal to the default changed the hard bot's decision`);
      const opposite = withStanding(template, (ctx, s) => -sign * ctx.score(s),
        () => key(chooseBotMove(live, seat, hardOptions("plain"))));
      decisions++;
      if (opposite !== plain) flipped++;
    });
    assert.ok(decisions > 20, `${packId}: only ${decisions} decisions seen`);
    assert.ok(flipped > 0,
      `${packId}: a matchStanding that plays to LOSE changed none of ${decisions} hard decisions — `
      + "the hook is never reached, so the equivalence above proves nothing");
  }
});

test("contract-rummy's standing counts rungs above any number of points", async () => {
  const state = await dealt("milestones", 2, "standing:rungs");
  const ctx = makeCtx(state);
  const standing = state.pack.template.matchStanding;
  ctx.setPlayerVar(0, "phase", 3);
  ctx.setPlayerVar(1, "phase", 2);
  state.scores[0] = 250; // ten wilds, the worst a hand can be caught holding
  state.scores[1] = 0;
  assert.ok(standing(ctx, 0) > standing(ctx, 1),
    "a seat one rung ahead is behind a seat with 250 fewer points");
  // …and on the same rung, the points do decide.
  ctx.setPlayerVar(1, "phase", 3);
  assert.ok(standing(ctx, 1) > standing(ctx, 0),
    "on the same rung, the seat holding fewer points is not ahead");
});

test("the hard bot steers Milestones by the ladder, not the round score", async () => {
  // The proof that the hook is REACHED: the same positions, ranked with the
  // standing removed, must come out differently somewhere. Late in a hand is
  // where a finished rollout's grade decides the move, so the walk runs deep.
  const template = (await dealt("milestones", 2, "probe")).pack.template;
  let decisions = 0;
  let differed = 0;
  for (let game = 0; game < 4 && differed === 0; game++) {
    const state = await dealt("milestones", 2, `standing:ladder:${game}`);
    walk(state, 160, (live, seat) => {
      if (live.turn.phase === "draw") return; // the draw is the heuristic's call either way
      const byLadder = key(chooseBotMove(live, seat, hardOptions("ladder")));
      const byPoints = withStanding(template, undefined,
        () => key(chooseBotMove(live, seat, hardOptions("ladder"))));
      decisions++;
      if (byLadder !== byPoints) differed++;
    });
  }
  assert.ok(decisions > 40, `only ${decisions} decisions seen`);
  assert.ok(differed > 0,
    `the hard bot played the same ${decisions} moves with and without matchStanding — `
    + "the ladder is not reaching the rollout's terminal value");
});
