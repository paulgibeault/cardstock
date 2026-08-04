// Round-scoring strategies shared across templates. Effective card value precedence
// (design doc §6): scoring.cardValues match -> deck-file card.value if non-null ->
// scoring.defaultValue -> 0.

import { resolveSelectorMap, selectorMatches } from './selectors.js';

export function cardValue(card, scoring) {
  const fromMap = scoring.cardValues ? resolveSelectorMap(card, scoring.cardValues, undefined) : undefined;
  if (fromMap !== undefined) return fromMap ?? 0;
  if (card.value !== null && card.value !== undefined) return card.value;
  if (scoring.defaultValue === 'faceValue') {
    const n = Number(card.rank);
    return Number.isNaN(n) ? 0 : n;
  }
  if (typeof scoring.defaultValue === 'number') return scoring.defaultValue;
  return 0;
}

export function handValue(cards, scoring) {
  return cards.reduce((sum, c) => sum + cardValue(c, scoring), 0);
}

// "First seat with an empty hand" wins the round; every other seat's hand value
// goes to them (Crazy Eights, Wildfire).
export function roundScoreHandValuesToWinner(ctx) {
  const scoring = ctx.pack.scoring;
  const result = {};
  let winnerSeat = null;
  for (let s = 0; s < ctx.seats; s++) {
    result[s] = 0;
    if (ctx.cardIdsIn(ctx.zoneAddr('hand', s)).length === 0) winnerSeat = s;
  }
  if (winnerSeat !== null) {
    let total = 0;
    for (let s = 0; s < ctx.seats; s++) {
      if (s === winnerSeat) continue;
      total += handValue(ctx.cardsIn(ctx.zoneAddr('hand', s)), scoring);
    }
    result[winnerSeat] = total;
  }
  return result;
}

// Every seat scores the value of the cards left in their own hand (Milestones).
export function roundScoreLeftoverHandValues(ctx) {
  const scoring = ctx.pack.scoring;
  const result = {};
  for (let s = 0; s < ctx.seats; s++) {
    result[s] = handValue(ctx.cardsIn(ctx.zoneAddr('hand', s)), scoring);
  }
  return result;
}

function allCardsMatchingSelector(ctx, selector) {
  const out = [];
  for (const card of ctx.pack.cardsById.values()) {
    if (selectorMatches(card, selector)) out.push(card.id);
  }
  return out;
}

// Cards taken into each seat's "won" pile score by value (Hearts), with an optional
// sweepBonus ("shoot the moon"): if one seat took every card matching a selector,
// award/penalize per the configured strategy instead of the raw totals.
export function roundScorePenaltyCardsTaken(ctx) {
  const scoring = ctx.pack.scoring;
  const raw = {};
  for (let s = 0; s < ctx.seats; s++) {
    raw[s] = handValue(ctx.cardsIn(ctx.zoneAddr('won', s)), scoring);
  }
  const sweep = ctx.rules.sweepBonus;
  if (!sweep) return raw;

  const m = /^tookAll:(.+)$/.exec(sweep.if);
  if (!m) return raw;
  const allMatching = allCardsMatchingSelector(ctx, m[1]);
  if (allMatching.length === 0) return raw;

  for (let s = 0; s < ctx.seats; s++) {
    const won = ctx.cardIdsIn(ctx.zoneAddr('won', s));
    const tookAll = allMatching.every((id) => won.includes(id));
    if (!tookAll) continue;
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    const result = {};
    for (let s2 = 0; s2 < ctx.seats; s2++) {
      if (sweep.award === 'self-lose-sum') {
        result[s2] = s2 === s ? -total : 0;
      } else {
        // 'others-gain-sum' (default)
        result[s2] = s2 === s ? 0 : total;
      }
    }
    return result;
  }
  return raw;
}

export const ROUND_SCORE_STRATEGIES = {
  'hand-values-to-winner': roundScoreHandValuesToWinner,
  'leftover-hand-values': roundScoreLeftoverHandValues,
  'penalty-cards-taken': roundScorePenaltyCardsTaken,
};

export function runRoundScore(ctx) {
  const strategy = ctx.pack.scoring.roundScore;
  if (typeof strategy === 'string' && ROUND_SCORE_STRATEGIES[strategy]) {
    return ROUND_SCORE_STRATEGIES[strategy](ctx);
  }
  throw new Error(`Unknown roundScore strategy: ${strategy}`);
}

// Handles the common "anyScore >= N" / lowestScore|highestScore gameOver shape
// (Crazy Eights, Wildfire, Hearts). Returns null when scoring.gameOver is absent or
// says "template" — the template owns game-over/winner logic itself in that case
// (Milestones: "first to complete all contracts", not a score threshold).
export function evaluateGameOver(ctx) {
  const cfg = ctx.pack.scoring.gameOver;
  if (!cfg || cfg.when === 'template') return null;
  const m = /^anyScore\s*>=\s*(\d+)$/.exec(cfg.when);
  if (!m) return null;
  const threshold = Number(m[1]);
  const over = Array.from({ length: ctx.seats }, (_, s) => ctx.score(s)).some((s) => s >= threshold);
  if (!over) return { over: false };
  let winner = 0;
  for (let s = 1; s < ctx.seats; s++) {
    if (cfg.winner === 'lowestScore' && ctx.score(s) < ctx.score(winner)) winner = s;
    else if (cfg.winner === 'highestScore' && ctx.score(s) > ctx.score(winner)) winner = s;
  }
  return { over: true, winner };
}
