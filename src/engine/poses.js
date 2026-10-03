// THE POSITIONS A MOVE PASSES THROUGH — the felt's two beats, as engine facts.
//
// The engine finishes a trick, ends a round and deals the next one inside a
// single move, so the live state never holds "four cards on the table" or "the
// hand as it ended". The felt has always recovered both from a copy of the
// state taken before the move (src/ui/roundEnding.js). The host needs the same
// two positions for a different reason: a guest has no pre-move copy, only the
// views it is sent, and the only way it sees the completed trick or the ended
// hand is if the host sends it a view of each (#283).
//
// So both live here, once, and both callers use them: the felt to hold its own
// beats, and src/engine/tableRules.js to hand the host module `poses`.
//
// Everything returned is a THROWAWAY. A pose is never logged, saved or
// published as the match; it is a rendering of a moment the engine has already
// moved past.

import { makeCtx } from './context.js';
import { forkState } from './fork.js';

/**
 * The completed trick: the pre-move position with `move` posed onto it, when
 * the template says there is such a moment (`template.poseMove`).
 *
 * Null when the template has nothing to hold, or when it throws: a template
 * that cannot pose its own move is a bug worth surviving, and the caller falls
 * through to the position the move actually reached.
 */
export function poseTrick(pre, move) {
  if (!pre || !move) return null;
  try {
    const posed = forkState(pre);
    posed.events.length = 0;
    return posed.pack.template.poseMove?.(makeCtx(posed), move) ? posed : null;
  } catch {
    return null;
  }
}

/**
 * Where the round ENDED: the pre-move position with `move` applied and the round
 * boundary deliberately not run.
 *
 * `template.applyMove` rather than the pipeline's `applyMove` is the whole
 * point. What comes back is the felt as the last card left it: the card on the
 * pile it landed on, the trick still there to be gathered, cribbage's hands and
 * crib turned face up in `show`.
 */
export function poseRoundEnd(pre, move) {
  if (!pre || !move) return null;
  try {
    const fork = forkState(pre);
    fork.events.length = 0;
    fork.pack.template.applyMove(makeCtx(fork), move);
    return fork;
  } catch {
    return null;
  }
}

/**
 * Both beats a move earned, worked out from its events: `trick` when it won a
 * trick, `final` when it ended a round (the last hand of a match included).
 */
export function posesFor(pre, move, events = []) {
  const trick = events.some((e) => e.type === 'trickWon') ? poseTrick(pre, move) : null;
  const final = events.some((e) => e.type === 'roundOver') ? poseRoundEnd(pre, move) : null;
  return { trick, final };
}
