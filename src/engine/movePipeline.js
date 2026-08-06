// propose -> validate -> apply -> [round boundary] -> log (design doc §5). Engine-level
// checks run first (cheapest), then the template's rules. Pack-hook validation
// (logic.js) is not wired yet — none of the five launch packs need it; see
// IMPLEMENTATION_NOTES.md.

import { makeCtx } from './context.js';
import { emitEvent, clearAllZones } from './state.js';
import { evaluateGameOver, runRoundScore } from './scoring.js';

export function validateMove(state, move) {
  if (state.gameOver) return { legal: false, rule: 'game-over', reason: 'The game is over.' };
  const ctx = makeCtx(state);
  const result = state.pack.template.validateMove(ctx, move);
  return result === true ? { legal: true } : result;
}

export function applyMove(state, move) {
  const check = validateMove(state, move);
  if (!check.legal) {
    throw new Error(`Illegal move ${move.type} by seat ${move.actor}: [${check.rule}] ${check.reason || ''}`);
  }
  // One move, one event window: everything the template and its reactions emit
  // during THIS move (trickWon, recycled, roundOver, ...) is what the UI reads
  // after. Cleared here, not in the UI, so replay regenerates the same stream.
  state.events.length = 0;
  const ctx = makeCtx(state);
  state.pack.template.applyMove(ctx, move);
  state.log.push({ seq: state.log.length + 1, ...move });
  maybeFinishRound(state);
  return check;
}

/**
 * The round boundary, run after every applied move — the layer that turns "a
 * hand ended" into "scores moved, and either the match is over or a new round
 * was dealt". It lives INSIDE the pipeline, not the UI, because it consumes
 * seeded RNG (the redeal): replaying the log must cross the boundary at exactly
 * the same move or every card after it diverges.
 *
 * Templates say "this hand is finished" with ctx.endRound(winner)
 * (src/engine/context.js); trick-taking's isRoundOver is "all hands empty"
 * instead, and names no winner. Whether that signal means "match over" is
 * decided HERE, from scoring.gameOver / template.isGameOver — a Crazy Eights
 * hand ending at 40 points deals the next round instead of ending the match,
 * which is what its manifest (`accumulate: true`, `anyScore >= 100`) always
 * declared.
 */
function maybeFinishRound(state) {
  const template = state.pack.template;
  let ctx = makeCtx(state);
  if (!template.isRoundOver(ctx)) return;

  const roundScores = (template.scoreRound ? template.scoreRound(ctx) : runRoundScore(ctx)) || {};
  for (const [seat, delta] of Object.entries(roundScores)) {
    state.scores[Number(seat)] += delta;
  }
  state.roundScores = roundScores;

  // The seat that finished the hand, published BEFORE the game-over question is
  // asked: contract-rummy's isGameOver is "did the seat that went out complete
  // the final contract", which is a question about this seat.
  if (state.roundEnded) state.winner = state.roundWinner;

  // scoring.gameOver ("anyScore >= N") when the pack declares it; otherwise the
  // template owns the call (Milestones: final contract; Stockpile: empty stock).
  const evaluated = evaluateGameOver(ctx);
  const over = evaluated ? evaluated.over : (template.isGameOver ? template.isGameOver(ctx) : false);
  const winner = evaluated?.over ? evaluated.winner : state.winner;

  emitEvent(state, 'roundOver', {
    round: state.roundNumber,
    scores: roundScores,
    totals: state.scores.slice(),
    over,
  });

  state.roundEnded = false;
  state.roundWinner = null;

  if (over) {
    state.gameOver = true;
    state.winner = winner;
    return;
  }

  state.gameOver = false;
  state.winner = null;
  state.roundNumber += 1;
  clearAllZones(state);
  state.vars = {};
  ctx = makeCtx(state);
  if (template.startRound) {
    template.startRound(ctx);
  } else {
    // Default: a fresh deal with nothing carried over. Templates with meta-state
    // that outlives a round (contract progression) implement startRound.
    state.playerVars = state.playerVars.map(() => ({}));
    template.setup(makeCtx(state));
  }
  emitEvent(state, 'roundStart', { round: state.roundNumber });
}

/**
 * A SIDE DOOR, AND THE NAME SAYS SO. No validation, no log append — the
 * announcement lands on the state and leaves no trace a replay could reproduce.
 *
 * A LIVE TABLE MUST NEVER CALL THIS. The UI routes announcements as ordinary
 * logged moves (`announce` / `challenge` through applyMove), which is what lets
 * a resumed match remember who had declared. This exists for exactly one
 * caller — the rule-test harness's `announce` assertion (tools/pack-test.mjs),
 * which constructs a state directly and has no log to be consistent with.
 * Anything else calling it forks replay from live play silently.
 */
export function applyAnnouncementUnlogged(state, announcement) {
  const ctx = makeCtx(state);
  const template = state.pack.template;
  if (!template.applyAnnouncement) return;
  template.applyAnnouncement(ctx, announcement);
}

/** The exact answer, computed every time. Always correct; never cached. */
export function enumerateLegalMoves(state, seat) {
  const ctx = makeCtx(state);
  return state.pack.template.enumerateLegalMoves(ctx, seat);
}

/**
 * A ONE-ENTRY MEMO OVER THE COSTLIEST CALL IN THE CODEBASE, for the callers
 * that ask the same question several times about one unchanged state.
 *
 * Contract-rummy's enumeration is expensive in a way no other template's is:
 * once seats have laid down, `findContractLayDown` runs a permutation search
 * over the contract and `findHits` pushes every
 * (seat × meld × hand-card × wild-value) candidate through a full validateMove.
 * Late in a four-handed Milestones game that is hundreds of validations. The
 * table asked for it THREE TIMES PER GESTURE — `render`, `renderSelection`, and
 * again on every drag lift, moments after a render had computed the identical
 * list — and the bot driver asks once more on its own timer.
 *
 * The key is (log length, round, whose turn, which phase, which seat).
 * Selection deliberately does not appear: picking a card up changes
 * buildUiModel, never what is legal. Invalidation is implicit — the key
 * changes — so there is no hook to forget to call.
 *
 * A SEPARATE FUNCTION RATHER THAN CACHING enumerateLegalMoves ITSELF, because
 * the key is only sound while state changes ONLY through applyMove. That holds
 * for every live path and for the bot, which is who this is for. It does not
 * hold for a harness that constructs a state and edits zones in place —
 * tools/pack-test.mjs and several tests do exactly that — and a memo that is
 * quietly wrong there is worse than no memo at all. Those callers use the exact
 * function above.
 *
 * The returned array is the CACHED one. Callers read it; nobody may sort or
 * splice it in place (src/engine/bot.js maps to a fresh array for that reason).
 */
const enumerationMemo = new WeakMap();

export function legalMovesFor(state, seat) {
  const key = `${state.log.length}:${state.roundNumber}:${state.turn.seat}:${state.turn.phase}:${seat}`;
  const cached = enumerationMemo.get(state);
  if (cached && cached.key === key) return cached.moves;
  const moves = state.pack.template.enumerateLegalMoves(makeCtx(state), seat);
  enumerationMemo.set(state, { key, moves });
  return moves;
}

export function runScoreRound(state) {
  const ctx = makeCtx(state);
  return state.pack.template.scoreRound ? state.pack.template.scoreRound(ctx) : runRoundScore(ctx);
}

export function isRoundOver(state) {
  const ctx = makeCtx(state);
  return state.pack.template.isRoundOver(ctx);
}
