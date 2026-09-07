// Round-scoring strategies shared across templates. Effective card value precedence
// (design doc §6): scoring.cardValues match -> deck-file card.value if non-null ->
// scoring.defaultValue -> 0.

import { resolveSelectorMap, selectorMatches } from './selectors.js';
import { sidesOf, foldToSides, representativeSeat } from './sides.js';

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

/* ------------------------------------------------------------------ *
 * BIDS AND BAGS
 * ------------------------------------------------------------------ *
 *
 * What you said you would take, against what you took (Spades, and Pinochle
 * after it). Everything above scores CARDS; this scores a promise, so none of
 * `cardValue` appears in it and a pack using it declares no card values at all.
 *
 * THE NUMBERS ARE THE PACK'S. Ten a trick, one a bag, a hundred for a nil and
 * a hundred back at ten bags are Spades' own arithmetic and they are declared
 * (`scoring.bids`), not written here — a template that hardcoded them would be
 * the pack knowledge in the platform this repo does not allow. The defaults
 * below are what the shape means if a key is missing, not a game.
 *
 * A SIDE'S CONTRACT, A SEAT'S NIL. The contract is the side's — partners' bids
 * add up and the side's tricks pay them off, which is what makes overtaking
 * your partner pointless and is the whole reason #104 came first. A nil is the
 * opposite: one seat promised to take nothing, and only that seat's own tricks
 * can break it.
 *
 * ONE SIMPLIFICATION, NAMED. A trick a nil bidder is forced to take counts
 * toward its partner's contract here; at some tables it counts as a bag and
 * leaves the partner short. The two only differ when the partner would have
 * been set without it, and the more forgiving reading is the commoner one at a
 * kitchen table — a house rule can differ later, in a variant.
 *
 * WHERE THE POINTS LAND. The side's whole contract score goes on its canonical
 * seat and a nil's bonus on the seat that bid it. The engine folds seats into
 * sides (src/engine/sides.js), so the side's total is right either way; what
 * this must NOT do is split a contract in half and hand each partner one, which
 * would round differently and make two seats disagree with their own sum.
 */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function roundScoreBidsAndBags(ctx) {
  const cfg = ctx.pack.scoring?.bids || {};
  const perTrick = num(cfg.perTrick, 10);
  const perOvertrick = num(cfg.overtrick, 1);
  const nilValue = num(cfg.nil, 100);
  const blindValue = num(cfg.blindNil, nilValue * 2);
  const bagsAt = num(cfg.bags?.at, 10);
  const bagPenalty = num(cfg.bags?.penalty, -100);

  const sides = sidesOf(ctx.pack, ctx.seats);
  const result = {};
  for (let seat = 0; seat < ctx.seats; seat++) result[seat] = 0;

  // Every trick is one card per seat, so a won pile's height says how many
  // tricks it is without the template having to count them separately.
  const tricksOf = (seat) => Math.floor(ctx.countIn(ctx.zoneAddr('won', seat)) / ctx.seats);

  for (const members of sides) {
    const banker = members[0];
    let contract = 0;
    let tricks = 0;
    for (const seat of members) {
      const bid = ctx.playerVar(seat, 'bid');
      tricks += tricksOf(seat);
      if (Number.isInteger(bid) && bid > 0) contract += bid;
    }

    for (const seat of members) {
      if (ctx.playerVar(seat, 'bid') !== 0) continue;
      const value = ctx.playerVar(seat, 'bidSight') === 'blind' ? blindValue : nilValue;
      result[seat] += tricksOf(seat) === 0 ? value : -value;
    }

    let bags = members.reduce((sum, seat) => sum + (Number(ctx.playerVar(seat, 'bags')) || 0), 0);
    if (tricks >= contract) {
      result[banker] += contract * perTrick + (tricks - contract) * perOvertrick;
      bags += tricks - contract;
    } else {
      // SET. The contract goes negative whole — the tricks it did take are
      // worth nothing, which is what makes overbidding the expensive mistake
      // and is exactly what the bot's bidding heuristic is priced against.
      result[banker] -= contract * perTrick;
    }

    // Ten bags cost a hundred, and the eleventh starts the next ten. A `while`
    // rather than an `if` because a side that took every trick can pile up
    // more than ten in one hand.
    while (bagsAt > 0 && bags >= bagsAt) {
      result[banker] += bagPenalty;
      bags -= bagsAt;
    }
    // The side's bag count, kept on the same canonical seat the contract is —
    // it is a SIDE's number, and the template carries it across the round
    // boundary (trick-taking's `startRound`) because the default wipes it.
    for (const seat of members) ctx.setPlayerVar(seat, 'bags', seat === banker ? bags : 0);
  }
  return result;
}

export const ROUND_SCORE_STRATEGIES = {
  'hand-values-to-winner': roundScoreHandValuesToWinner,
  'leftover-hand-values': roundScoreLeftoverHandValues,
  'penalty-cards-taken': roundScorePenaltyCardsTaken,
  'bids-and-bags': roundScoreBidsAndBags,
};

/**
 * The round's per-seat deltas, from the pack's declared strategy.
 *
 * A pack that declares no scoring at all scores NOTHING — it does not throw.
 * Stockpile is that pack: a race to empty a stock has no points, and the only
 * reason its template carried a `scoreRound() { return {}; }` was to stop this
 * function throwing on the way past. A named strategy that does not exist is
 * still an error, because that is a typo rather than a decision.
 */
export function runRoundScore(ctx) {
  const strategy = ctx.pack.scoring?.roundScore;
  if (strategy === undefined || strategy === null) return {};
  if (typeof strategy === 'string' && ROUND_SCORE_STRATEGIES[strategy]) {
    return ROUND_SCORE_STRATEGIES[strategy](ctx);
  }
  throw new Error(`Unknown roundScore strategy: ${strategy}`);
}

/**
 * Handles the common "anyScore >= N" / lowestScore|highestScore gameOver shape
 * (Crazy Eights, Wildfire, Hearts). Returns null when scoring.gameOver is absent
 * or says "template" — the template owns game-over/winner logic itself in that
 * case (Milestones: "first to complete all contracts", not a score threshold).
 *
 * `anyScore` MEANS ANY SIDE'S SCORE, and for every pack that shipped before
 * partnerships that is the same sentence it always was: a teamless pack has one
 * side per seat (`src/engine/sides.js`), so the fold below is the identity and
 * the loop compares exactly the numbers it used to.
 *
 * With sides it is the only reading that is not nonsense. Spades plays to 500
 * as a PARTNERSHIP; comparing each partner's own half of the pile to the
 * threshold would run the match to roughly a thousand and call it 500. And the
 * winner is a SIDE, reported as its canonical seat — see `representativeSeat`
 * for why `state.winner` stays a seat.
 */
export function evaluateGameOver(ctx) {
  const cfg = ctx.pack.scoring.gameOver;
  if (!cfg || cfg.when === 'template') return null;
  const m = /^anyScore\s*>=\s*(\d+)$/.exec(cfg.when);
  if (!m) return null;
  const threshold = Number(m[1]);
  const sides = sidesOf(ctx.pack, ctx.seats);
  const totals = foldToSides(Array.from({ length: ctx.seats }, (_, s) => ctx.score(s)), sides);
  if (!totals.some((total) => total >= threshold)) return { over: false };
  let winner = 0;
  for (let side = 1; side < totals.length; side++) {
    if (cfg.winner === 'lowestScore' && totals[side] < totals[winner]) winner = side;
    else if (cfg.winner === 'highestScore' && totals[side] > totals[winner]) winner = side;
  }
  return { over: true, winner: representativeSeat(ctx.pack, ctx.seats, winner) };
}
