// propose -> validate -> apply -> [round boundary] -> log (design doc §5). Engine-level
// checks run first (cheapest), then the template's rules. Pack-hook validation
// (logic.js) is not wired yet — none of the five launch packs need it; see
// IMPLEMENTATION_NOTES.md.

import { makeCtx } from './context.js';
import { emitEvent, clearAllZones } from './state.js';
import { evaluateGameOver } from './scoring.js';

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
 * Templates keep their existing signals: shedding/contract-rummy/sequencing set
 * state.gameOver when a hand or stock empties (their isRoundOver reads it back);
 * trick-taking's isRoundOver is "all hands empty". Whether that signal means
 * "round over" or "match over" is decided HERE, from scoring.gameOver /
 * template.isGameOver — a Crazy Eights hand ending at 40 points now deals the
 * next round instead of ending the match, which is what its manifest
 * (`accumulate: true`, `anyScore >= 100`) always declared.
 */
function maybeFinishRound(state) {
  const template = state.pack.template;
  let ctx = makeCtx(state);
  if (!template.isRoundOver(ctx)) return;

  const roundScores = template.scoreRound(ctx) || {};
  for (const [seat, delta] of Object.entries(roundScores)) {
    state.scores[Number(seat)] += delta;
  }
  state.roundScores = roundScores;

  // scoring.gameOver ("anyScore >= N") when the pack declares it; otherwise the
  // template owns the call (Milestones: final contract; Stockpile: empty stock).
  const evaluated = evaluateGameOver(ctx);
  const over = evaluated ? evaluated.over : template.isGameOver(ctx);
  const winner = evaluated?.over ? evaluated.winner : state.winner;

  emitEvent(state, 'roundOver', {
    round: state.roundNumber,
    scores: roundScores,
    totals: state.scores.slice(),
    over,
  });

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

export function enumerateLegalMoves(state, seat) {
  const ctx = makeCtx(state);
  return state.pack.template.enumerateLegalMoves(ctx, seat);
}

export function runScoreRound(state) {
  const ctx = makeCtx(state);
  return state.pack.template.scoreRound(ctx);
}

export function isRoundOver(state) {
  const ctx = makeCtx(state);
  return state.pack.template.isRoundOver(ctx);
}
