// propose -> validate -> apply -> log (design doc §5). Engine-level checks run first
// (cheapest), then the template's rules. Pack-hook validation (logic.js) is not wired
// yet — none of the five launch packs need it; see IMPLEMENTATION_NOTES.md.

import { makeCtx } from './context.js';

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
  const ctx = makeCtx(state);
  state.pack.template.applyMove(ctx, move);
  state.log.push({ seq: state.log.length + 1, ...move });
  return check;
}

export function applyAnnouncement(state, announcement) {
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
