// "FOR EACH ACTING SEAT, CHOOSE; STALL IF NOBODY CAN MOVE; APPLY; LOOK FOR roundOver."
//
// tools/simulate.mjs spelled that out three times — `playOne`, `playMatch` and
// `playOneOverProtocol` — and the three had already drifted: only two of them
// counted effects, only two of them wrapped applyMove, and the seat named in a
// stall message was whichever local variable the copy happened to keep. The loop
// is the measurement instrument for every completion bar in tests/simulate.test.js,
// so a silent difference between two copies of it is a difference between two
// numbers that are compared as though they came from the same run.
//
// The cap stays with the CALLER. tools/simulate.mjs's MAX_MOVES carries a long
// argument for its own value and is a deadlock detector, not a detail of the
// loop; `stepRound` takes it as a number so a caller can say what its bar is.

import { actingSeats } from '../../src/engine/context.js';
import { applyMove } from '../../src/engine/movePipeline.js';

/**
 * The first acting seat with a legal move, asked in seat order.
 *
 * @returns `{ move, seat }`, or `{ move: null, seat: null }` when nobody can act.
 *          A null seat is the honest answer — the caller's stall message falls
 *          back to `state.turn.seat`, which is what the copies did.
 */
export function pickMove(state, choose) {
  for (const seat of actingSeats(state)) {
    const move = choose(state, seat);
    if (move) return { move, seat };
  }
  return { move: null, seat: null };
}

/** The stall message the solo and protocol loops both print. */
export function noMoveReason(state, seat) {
  return `no legal move for seat ${seat ?? state.turn.seat}, phase ${state.turn.phase}`;
}

/**
 * Play from here to the end of the ROUND (or to gameOver, or to the cap).
 *
 * @param choose         `(state, seat) => move | null`, the move policy under test
 * @param opts.maxMoves  the live-lock cap; hitting it is a stall, not a completion
 * @returns `{ outcome: 'complete', moves, effectCounts, roundOver, roundScores }`
 *          or `{ outcome: 'stall'|'error', moves, stall, reason }`, where `stall`
 *          is `'noMove'` or `'cap'` so a caller can word its own reason.
 *
 * `roundOver` is read from the EVENT WINDOW rather than isRoundOver: the pipeline
 * advances rounds itself now (a finished hand is scored and the next one dealt
 * inside applyMove), so isRoundOver is already false again by the time the redeal
 * has happened. A match can also end without a roundOver event, which is why
 * `roundOver` is reported separately from the outcome.
 */
export function stepRound(state, choose, { maxMoves = Infinity } = {}) {
  let moves = 0;
  let over = null;
  const effectCounts = {};
  while (!state.gameOver && !over && moves < maxMoves) {
    const { move, seat } = pickMove(state, choose);
    if (!move) {
      return { outcome: 'stall', stall: 'noMove', moves, reason: noMoveReason(state, seat) };
    }
    effectCounts[move.type] = (effectCounts[move.type] || 0) + 1;
    try {
      applyMove(state, move);
    } catch (e) {
      return { outcome: 'error', moves, reason: e.message };
    }
    over = state.events.find((e) => e.type === 'roundOver') || null;
    moves++;
  }
  if (moves >= maxMoves) {
    return {
      outcome: 'stall', stall: 'cap', moves,
      reason: 'move cap exceeded (live-lock, or just very slow bot convergence)',
    };
  }
  return {
    outcome: 'complete', moves, effectCounts,
    roundOver: !!over, roundScores: over ? over.scores : null,
  };
}
