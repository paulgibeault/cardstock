// Round-scoring strategies shared across templates. Effective card value precedence
// (design doc §6): scoring.cardValues match -> deck-file card.value if non-null ->
// scoring.defaultValue -> 0.

import { resolveSelectorMap, selectorMatches } from './selectors.js';
import { sidesOf, sideOfSeat, foldToSides, representativeSeat } from './sides.js';
import { seatsAfter } from './templateKit.js';

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

/* ------------------------------------------------------------------ *
 * THE REVEAL — what each seat's cards were worth, said one seat at a time
 * ------------------------------------------------------------------ *
 *
 * Cribbage's show was the only round ending the felt could hold up one count
 * at a time, because cribbage was the only template that EMITTED one: a
 * `showScored` per hand, with the cards and what they were worth. Every other
 * pack scored the cards left in a hand (or taken into a pile) in silence, and
 * the first the player saw of it was a delta on the sheet — "the last hand
 * isn't even shown" (issue #189, and Paul asking for the cribbage treatment at
 * every table, Thirteen first).
 *
 * So the three strategies that price CARDS emit the same event cribbage does,
 * one per seat whose cards cost or earned anything, in the order the table
 * would read them — round the table from the seat that ended the hand. The
 * felt already knows what to do with a `showScored`: hold it as a card with the
 * faces on it, one tap per seat at the rung that waits (src/ui/roundBeat.js),
 * and at the match end too (finalShowPlan). Nothing in the UI had to learn
 * what Thirteen is.
 *
 * WHAT THE EVENT CARRIES. `reason` says which of the three prices this is —
 * `leftover` (each seat pays for its own hand), `to-winner` (every hand pays
 * the seat that went out, named in `to`), `taken` (the cards a seat was made
 * to take) — because the sentence differs and the sheet's delta is not always
 * this seat's own number. `cards` are the ids so the felt can draw the faces;
 * `n` is their count, which survives the wire where the ids may not
 * (src/engine/view.js's eventsFor strips ids a seat cannot see). `parts` are
 * the card's rows: one per VALUE, `{ kind: 'held', n, each, points, at }`, so a
 * Thirteen hand reads "7 cards at 1" and a Crazy Eights hand "an eight at 50,
 * two at 10" rather than thirteen rows of one card each.
 *
 * EMITTED INSIDE THE STRATEGY, so it is in the same event window as the
 * `roundOver` that follows, and so a fork the bot plays forward emits it too
 * and nobody notices — an event is not a state change. `points` is the hand's
 * own value and is the AUTHORITY for the card's total, the way cribbage's is;
 * the sheet still reads the returned deltas.
 */

/** The rows of a reveal card: one per distinct value, highest first. */
function heldParts(cards, scoring) {
  const byValue = new Map();
  cards.forEach((card, at) => {
    const each = cardValue(card, scoring);
    if (!byValue.has(each)) byValue.set(each, []);
    byValue.get(each).push(at);
  });
  return [...byValue.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([each, at]) => ({ kind: 'held', n: at.length, each, points: each * at.length, at }));
}

/**
 * `ids` are the ZONE's ids and `cards` the records they resolve to, in the same
 * order — two lists because a two-deck pack's second copy is `blue-1#2` in the
 * zone and `blue-1` on the record, and the felt draws the face by the id it
 * can find on the table.
 */
function emitReveal(ctx, seat, ids, cards, { reason, to = null, sweep = null, points = null }) {
  const scoring = ctx.pack.scoring;
  ctx.emit('showScored', {
    seat,
    isCrib: false,
    reason,
    to,
    sweep,
    points: points ?? handValue(cards, scoring),
    n: ids.length,
    cards: ids.slice(),
    parts: heldParts(cards, scoring),
  });
}

/** A zone's ids and records, paired by position. */
function zoneCards(ctx, address) {
  return { ids: ctx.cardIdsIn(address).slice(), cards: ctx.cardsIn(address) };
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
    for (const s of seatsAfter(ctx.seats, winnerSeat)) {
      if (s === winnerSeat) continue;
      const { ids, cards } = zoneCards(ctx, ctx.zoneAddr('hand', s));
      total += handValue(cards, scoring);
      // Every hand pays the winner, so every hand is shown — a hand worth
      // nothing is still a hand somebody was caught with.
      if (ids.length) emitReveal(ctx, s, ids, cards, { reason: 'to-winner', to: winnerSeat });
    }
    result[winnerSeat] = total;
  }
  return result;
}

// Every seat scores the value of the cards left in their own hand (Milestones).
export function roundScoreLeftoverHandValues(ctx) {
  const scoring = ctx.pack.scoring;
  const result = {};
  for (const s of seatsAfter(ctx.seats, ctx.state.roundWinner)) {
    const { ids, cards } = zoneCards(ctx, ctx.zoneAddr('hand', s));
    result[s] = handValue(cards, scoring);
    if (ids.length) emitReveal(ctx, s, ids, cards, { reason: 'leftover' });
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
  // The cards that COST something, out of everything the seat took: a Hearts
  // won pile is thirteen tricks deep and eleven of them are worth nothing, and
  // the reveal is the hearts and the Queen, not the whole pile.
  const priced = {};
  for (let s = 0; s < ctx.seats; s++) {
    const { ids, cards } = zoneCards(ctx, ctx.zoneAddr('won', s));
    raw[s] = handValue(cards, scoring);
    const keep = cards.map((card) => cardValue(card, scoring) !== 0);
    priced[s] = { ids: ids.filter((_, i) => keep[i]), cards: cards.filter((_, i) => keep[i]) };
  }
  // Who shot the moon, if anybody — decided before anything is said, because
  // the shooter's card says something different from everybody else's.
  const sweep = ctx.rules.sweepBonus;
  const m = sweep ? /^tookAll:(.+)$/.exec(sweep.if) : null;
  const allMatching = m ? allCardsMatchingSelector(ctx, m[1]) : [];
  let shooter = null;
  if (allMatching.length) {
    for (let s = 0; s < ctx.seats; s++) {
      const won = ctx.cardIdsIn(ctx.zoneAddr('won', s));
      if (allMatching.every((id) => won.includes(id))) { shooter = s; break; }
    }
  }
  // The reveal, round the table from whoever took the last trick.
  for (const s of seatsAfter(ctx.seats, ctx.var('leader'))) {
    if (!priced[s].ids.length) continue;
    emitReveal(ctx, s, priced[s].ids, priced[s].cards, {
      reason: 'taken',
      sweep: s === shooter ? (sweep.award === 'self-lose-sum' ? 'self-lose-sum' : 'others-gain-sum') : null,
    });
  }

  if (shooter === null) return raw;
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  const result = {};
  for (let s2 = 0; s2 < ctx.seats; s2++) {
    if (sweep.award === 'self-lose-sum') {
      result[s2] = s2 === shooter ? -total : 0;
    } else {
      // 'others-gain-sum' (default)
      result[s2] = s2 === shooter ? 0 : total;
    }
  }
  return result;
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

/* ------------------------------------------------------------------ *
 * MELD AND TRICKS
 * ------------------------------------------------------------------ *
 *
 * Pinochle's, and the third currency in this file. `penalty-cards-taken`
 * scores the cards a seat was made to take; `bids-and-bags` scores a promise
 * counted in tricks and ignores the cards entirely. This scores BOTH, added
 * together, and then prices the total against a bid made in the same units:
 *
 *     side total = what its seats melded  +  the card value of what they took
 *                  (+ a bonus to whoever took the last trick)
 *
 * ONE SIDE HOLDS THE CONTRACT, not both — the difference from `bids-and-bags`,
 * where every seat's bid stands and each side owes the sum of its own two. A
 * points auction ends with exactly one number on the table, and the side that
 * said it either reaches it or loses the whole thing (`unit: 'points'`, and
 * the auction that produces it is src/templates/trick-taking.js).
 *
 * WHO HOLDS IT IS DERIVED, NOT STORED. The seat with the highest bid is the
 * seat that won the auction — every other seat passed with a 0, and the auction
 * refuses a bid that does not beat what has been said, so the maximum is unique
 * and every seat at the table watched it being made. A stored `contractSeat`
 * would be a second copy of a fact the public `bid` vars already carry, free to
 * disagree with them after a replay.
 *
 * WHAT A SET COSTS. The bid, whole and negative — the meld and the tricks the
 * side did take are worth nothing at all, which is the rule that makes bidding
 * a hand up to a number it cannot reach the expensive mistake. The side that
 * did NOT hold the contract always banks what it made, set or not: it promised
 * nothing and cannot fail.
 *
 * THE LAST TRICK IS `leader`. Resolving a trick sets that var to whoever won
 * it, so after the final trick of a hand it is the seat that took the last one
 * — no second var, and nothing for a replay to get out of step with.
 */
export function roundScoreMeldAndTricks(ctx) {
  const scoring = ctx.pack.scoring || {};
  const lastTrick = num(scoring.tricks?.lastTrick, 0);
  const sides = sidesOf(ctx.pack, ctx.seats);

  const result = {};
  for (let seat = 0; seat < ctx.seats; seat++) result[seat] = 0;

  let contractSeat = null;
  let contract = 0;
  for (let seat = 0; seat < ctx.seats; seat++) {
    const bid = ctx.playerVar(seat, 'bid');
    if (Number.isInteger(bid) && bid > contract) {
      contract = bid;
      contractSeat = seat;
    }
  }
  const contractSide = contractSeat === null ? null : sideOfSeat(ctx.pack, ctx.seats, contractSeat);
  const lastSeat = ctx.var('leader');

  sides.forEach((members, side) => {
    const banker = members[0];
    let total = 0;
    for (const seat of members) {
      total += Number(ctx.playerVar(seat, 'meld')?.points) || 0;
      total += handValue(ctx.cardsIn(ctx.zoneAddr('won', seat)), scoring);
      if (seat === lastSeat) total += lastTrick;
    }
    result[banker] += side === contractSide && total < contract ? -contract : total;
  });
  return result;
}

export const ROUND_SCORE_STRATEGIES = {
  'hand-values-to-winner': roundScoreHandValuesToWinner,
  'leftover-hand-values': roundScoreLeftoverHandValues,
  'penalty-cards-taken': roundScorePenaltyCardsTaken,
  'bids-and-bags': roundScoreBidsAndBags,
  'meld-and-tricks': roundScoreMeldAndTricks,
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
