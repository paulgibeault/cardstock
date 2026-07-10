// Generic bot: enumerate legal moves via the template, score each with the template's
// heuristic (or a flat fallback), play the best. Also the basis for hints and the
// headless simulation harness (design doc §10).

import { enumerateLegalMoves } from './movePipeline.js';
import { makeCtx } from './context.js';

function defaultHeuristic(ctx, move) {
  return move.type === 'draw' ? -1 : 1;
}

export function chooseBotMove(state, seat) {
  const moves = enumerateLegalMoves(state, seat);
  if (moves.length === 0) return null;
  const ctx = makeCtx(state);
  const heuristic = state.pack.template.botHeuristic || defaultHeuristic;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    const score = heuristic(ctx, move);
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}
