// Generic bot: enumerate legal moves via the template, score each with the template's
// heuristic (or a flat fallback), play the best. Also the basis for hints and the
// headless simulation harness (design doc §10).
//
// PERSONALITY IS A LENS, NOT A SECOND BRAIN. The template's `botHeuristic` still
// decides what a good move IS — it is the only thing that knows a Hearts lead
// from a Skip-Bo build — and a persona (src/players/roster.js) only shapes how
// that ranking is consumed: a tilt toward committing or holding, and a chance
// of settling for the runner-up. A personality therefore cannot invent a move,
// skip validation, or prefer something illegal; the worst it can do is play
// second-best, which is exactly what a distractible opponent does.
//
// SCALE-FREE BY CONSTRUCTION. Heuristics have wildly different ranges —
// shedding scores 1.0–1.5, trick-taking −17–0 — so the tilt is expressed as a
// fraction of the SPREAD of this turn's own scores rather than as a fixed
// number of points. A tilt worth "a quarter of the gap between the best and
// worst move here" means the same thing in both games; +0.3 does not.
//
// AND IT IS A TIE-BREAKER, NOT AN OVERRIDE — deliberately, and worth saying
// plainly because the numbers look timid otherwise. A tilt big enough to make
// a "patient" bot draw while holding an obviously good card would not read as
// patient; it would read as broken, and an opponent who throws games is not
// one worth beating. So the tilt decides between moves the heuristic already
// rates as close, and `mistakeRate` is where visible fallibility actually
// comes from. The tests pin exactly this, in both directions.
//
// DETERMINISM. `chooseBotMove(state, seat)` with no options is exactly what it
// always was: no randomness, first-best wins ties. That is what keeps
// tools/simulate.mjs and the rule tests reproducible. Randomness only enters
// when a caller passes a persona, and it lives OUTSIDE the reducer — replay
// re-applies the logged move and never re-runs this function, so a bot's coin
// flips can never desync a resumed match.

import { enumerateLegalMoves } from './movePipeline.js';
import { makeCtx } from './context.js';

function defaultHeuristic(ctx, move) {
  return move.type === 'draw' ? -1 : 1;
}

/** Moves that decline to commit a card. Persona `patience` speaks to these. */
const HOLDING_MOVES = new Set(['draw', 'pass']);

/** How much of the score spread a full point of aggression/patience is worth. */
const TILT_SHARE = 0.25;

/**
 * Rank every legal move for `seat`, best first.
 *
 * Exported because the ranking is useful on its own: the hint system wants the
 * top entry, and the tests want to assert that a persona reordered the list
 * without having to run the chooser's coin flips.
 *
 * @returns Array<{ move, score }> — a fresh array, safe to mutate.
 */
export function rankMoves(state, seat, { persona = null } = {}) {
  const moves = enumerateLegalMoves(state, seat);
  if (moves.length === 0) return [];
  const ctx = makeCtx(state);
  const heuristic = state.pack.template.botHeuristic || defaultHeuristic;

  const scored = moves.map((move) => ({ move, score: heuristic(ctx, move) }));
  if (persona) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const entry of scored) {
      if (entry.score < lo) lo = entry.score;
      if (entry.score > hi) hi = entry.score;
    }
    const spread = hi - lo;
    // Every move scored the same: there is nothing for a tilt to reorder, and
    // scaling by a zero spread would be a no-op anyway.
    if (spread > 0) {
      const unit = spread * TILT_SHARE;
      for (const entry of scored) {
        const bias = HOLDING_MOVES.has(entry.move.type)
          ? (persona.patience ?? 1) - 1
          : (persona.aggression ?? 1) - 1;
        entry.score += bias * unit;
      }
    }
  }

  // Stable sort (V8's is): equal scores keep enumeration order, which is what
  // preserves the no-persona path's exact historical behaviour.
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * The move this seat plays.
 *
 * @param opts.persona a src/players/roster.js persona, or null for the plain
 *                     deterministic chooser
 * @param opts.random  injectable for tests; only consulted with a persona
 */
export function chooseBotMove(state, seat, { persona = null, random = Math.random } = {}) {
  const ranked = rankMoves(state, seat, { persona });
  if (ranked.length === 0) return null;
  if (!persona || ranked.length === 1) return ranked[0].move;

  // A mistake is a NEAR-miss, not a random flail: the runner-up, or the one
  // after it. A bot that occasionally plays the third-best card reads as
  // distracted; one that plays the worst card available reads as broken.
  const mistakeRate = persona.mistakeRate ?? 0;
  if (mistakeRate > 0 && random() < mistakeRate) {
    const alternatives = ranked.slice(1, 3);
    return alternatives[Math.floor(random() * alternatives.length)].move;
  }
  return ranked[0].move;
}
