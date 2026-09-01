// The Milestones bot's meld search: can this hand satisfy a whole contract, and
// what may it add to somebody else's melds?
//
// Split out of contract-rummy.js because it is STRATEGY, not rules — nothing
// here decides what is legal (every candidate is put back through the
// template's own validateMove before it counts), and it is by a wide margin the
// most expensive code in the repo per call. Keeping it beside the rules made
// the rules file 961 lines and made it easy to mistake a search heuristic for
// a constraint.

import { cardValue } from '../engine/scoring.js';
import {
  isWildCard, isMeldable, parseItem, resolveMeld, meldKindOf, meldValue,
  getMeldGroups, pinnedAttr, wildHitValues,
} from './melds.js';

export function groupBy(items, keyFn) {
  const out = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

// Greedy search for `n` cards (from `available`, a list of {id, card}) satisfying one
// meld item, spending as few wilds as the natural cards on hand allow. Not globally
// optimal across a whole contract — good enough for a bot to make steady progress.
//
// Returns { cards: [id, ...], wilds } or null: a candidate is only an answer once
// resolveMeld has frozen a value onto every wild in it, which also means a window
// that runs off the end of the deck is rejected here rather than laid down.
export function findMeldForItem(ctx, parsed, available) {
  const meldable = available.filter((c) => isMeldable(ctx, c.card));
  const wilds = meldable.filter((c) => isWildCard(ctx, c.card));
  const naturals = meldable.filter((c) => !isWildCard(ctx, c.card));
  const minNaturals = ctx.rules.wilds?.minNaturals ?? 0;
  const maxWilds = ctx.rules.wilds?.maxPerMeld;
  const item = `${parsed.kind}(${parsed.n})`;

  function tryComplete(naturalCards, wildsNeeded) {
    if (naturalCards.length < minNaturals) return null;
    if (maxWilds != null && wildsNeeded > maxWilds) return null;
    if (wildsNeeded > wilds.length) return null;
    const cards = [...naturalCards.map((c) => c.id), ...wilds.slice(0, wildsNeeded).map((c) => c.id)];
    const resolved = resolveMeld(ctx, item, cards, {});
    return resolved.ok ? { cards, wilds: resolved.wilds } : null;
  }

  if (parsed.kind === 'set' || parsed.kind === 'colorGroup') {
    const key = parsed.kind === 'set' ? (c) => c.card.rank : (c) => c.card.color;
    for (const group of groupBy(naturals, key).values()) {
      const naturalsUsed = group.slice(0, parsed.n);
      const found = tryComplete(naturalsUsed, parsed.n - naturalsUsed.length);
      if (found) return found;
    }
    return null;
  }

  if (parsed.kind === 'run') {
    const byRank = new Map();
    for (const c of naturals) {
      const r = Number(c.card.rank);
      if (!Number.isNaN(r) && !byRank.has(r)) byRank.set(r, c);
    }
    const ranks = [...byRank.keys()];
    if (ranks.length === 0) return null;
    const minR = Math.min(...ranks);
    const maxR = Math.max(...ranks);
    for (let start = minR - parsed.n + 1; start <= maxR; start++) {
      const naturalsUsed = [];
      let wildsNeeded = 0;
      for (let r = start; r < start + parsed.n; r++) {
        if (byRank.has(r)) naturalsUsed.push(byRank.get(r));
        else wildsNeeded++;
      }
      const found = tryComplete(naturalsUsed, wildsNeeded);
      if (found) return found;
    }
    return null;
  }

  return null;
}

// Attempts to satisfy every item of the seat's current contract from their hand in one
// shot, each item drawing from whatever the previous items left behind. Returns null if
// any item can't be completed — the bot just discards that turn instead.
export function findContractLayDown(ctx, seat) {
  const contract = ctx.rules.contracts[ctx.playerVar(seat, 'phase') - 1];
  if (!contract) return null;
  let available = ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).map((id) => ({ id, card: ctx.cardById(id) }));
  const melds = [];
  for (const item of contract) {
    const parsed = parseItem(item);
    const found = parsed && findMeldForItem(ctx, parsed, available);
    if (!found) return null;
    melds.push({ item, cards: found.cards, wilds: found.wilds });
    available = available.filter((c) => !found.cards.includes(c.id));
  }
  return melds;
}

// All orderings of a contract's items. Contracts are at most a few items, so this
// is bounded and cheap; trying every order is what makes arrangeContract succeed on
// selections a single greedy pass would mis-partition (a card that fits either item).
export function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

// Every legal one-card hit across every seat's melds, via the template's own
// validateMove — handed in rather than imported, so the strategy module does not
// form a cycle with the rules module it is checked by. Passing the validator is
// also the statement that the bot cannot invent a move: everything it proposes
// has already been through the same door a human's move goes through.
//
// A wild appears once per value it could take, the same way shedding enumerates a
// wild once per colour: the value is part of the move, so two values are two moves.
// That is what lets a bot pick one and the table ask a human which they meant.
export function findHits(ctx, seat, validate) {
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const hits = [];
  for (let targetSeat = 0; targetSeat < ctx.seats; targetSeat++) {
    const groups = getMeldGroups(ctx, targetSeat);
    for (let meldIndex = 0; meldIndex < groups.length; meldIndex++) {
      const group = groups[meldIndex];
      const kind = meldKindOf(ctx, group);
      for (const cardId of hand) {
        const card = ctx.cardById(cardId);
        const attr = kind && pinnedAttr(kind);
        const values = kind && card && isWildCard(ctx, card) ? wildHitValues(ctx, group, kind, cardId) : [null];
        for (const value of values) {
          const choice = { seat: targetSeat, meld: meldIndex };
          if (value !== null) choice.wilds = { [cardId]: { [attr]: value } };
          const move = { actor: seat, type: 'hit', cards: [cardId], choice };
          if (validate(ctx, move).legal) hits.push(move);
        }
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * Which card to throw, and whose pile to take it from
 * ------------------------------------------------------------------ *
 *
 * THE DRAW WAS THE LIVE-LOCK, NOT THE DISCARD. The old heuristic scored the
 * face-up pile at +0.5 and the deck at −1, so every bot took the pile top every
 * single turn, no matter what it was. Four seats doing that never touch the
 * deck: the pile stays one card deep, the same forty dealt cards circulate
 * forever, and a seat that was not dealt its contract can never be dealt it.
 * That is what the twelve-thousand-move cap was absorbing — not slow
 * convergence, a closed system. Everything below exists so that the pile is
 * taken when it is worth taking and the deck is turned when it is not.
 *
 * The other half is what a card is worth KEEPING, and the old answer was
 * "count its rank-mates" for every contract on the ladder. Milestones asks for
 * run(7), run(8), run(9) and colorGroup(7) — four of its ten rungs — where a
 * rank-mate is a duplicate a run cannot even use. Reading the contract is the
 * difference between collecting toward it and shuffling a hand at random.
 */

/** Never the discard: a wild is the most valuable card in the deck to hold. */
const WILD_KEEP = 100;

/**
 * How far above an unknown deck card the pile top has to grade before it is
 * worth taking.
 *
 * Swept from 0 to 8 over three hundred rounds each: anything from 0 to 5 gives
 * the same answer, and 8 costs about a sixth of a round in length because the
 * bot starts refusing cards it should have taken. So this is a comfortable
 * middle of a wide flat, not a tuned edge — what matters is that a bar EXISTS,
 * not where in that range it sits. (At 0 it still works, but only because
 * `drawFrom` lists the deck first and the chooser keeps the first of equal
 * scores; that is an accident to be above, not to lean on.)
 */
const PILE_PICKUP_BAR = 1.5;

/** How many pile pickups per seat the table is assumed to remember. */
const PILE_MEMORY = 4;

/**
 * WHAT EVERY SEAT WATCHED SOMEONE TAKE — a shared, DECLARED-PUBLIC var.
 *
 * A pickup from the face-up pile is the most public event in the game: the card
 * was lying face up and the whole table saw whose hand it went into. Recording
 * it is not peeking, and the two placements that would have hidden it are both
 * wrong for a different reason. An undeclared shared var is redacted out of
 * every peer's view (src/engine/view.js fails closed), and a `__` playerVar is
 * secret by that file's own convention — either would mean the HOST's bot knew
 * something a remote seat's bot could not, which is the exact shape of the
 * "it always knew I had the queen" unfairness this whole workstream is trying
 * to avoid. Declared public, every seat reasons from the same table.
 *
 * It stores the RANK AND COLOUR that were face up, never the card id. Once the
 * card is in a hand its id is hidden, and a public var naming it would be a
 * genuine leak (tests/security.test.js and the protocol audit in
 * tools/simulate.mjs both sweep for exactly that).
 *
 * Bounded on purpose: the most recent `PILE_MEMORY` per seat, so a round that
 * runs long cannot grow the var without limit, and so the memory reads as
 * "what they have been taking lately" rather than a saturated tally.
 */
export const PILE_TAKEN_VAR = 'pileTaken';

export function rememberPileTake(ctx, seat, card) {
  const taken = (ctx.var(PILE_TAKEN_VAR) || []).map((entry) => entry.slice());
  while (taken.length < ctx.seats) taken.push([]);
  taken[seat] = [{ rank: card.rank, color: card.color ?? null }, ...taken[seat]].slice(0, PILE_MEMORY);
  ctx.setVar(PILE_TAKEN_VAR, taken);
}

export function forgetPileTakes(ctx) {
  ctx.setVar(PILE_TAKEN_VAR, Array.from({ length: ctx.seats }, () => []));
}

/**
 * The seat's contract, as an appetite: how many of the cards it still owes are
 * wanted for their rank, for their place in a sequence, and for their colour.
 * Normalised, so a two-item contract of mixed kinds splits its attention.
 */
function contractWants(ctx, seat) {
  const contract = ctx.rules.contracts[ctx.playerVar(seat, 'phase') - 1] || [];
  const wants = { set: 0, run: 0, colorGroup: 0 };
  let total = 0;
  for (const item of contract) {
    const parsed = parseItem(item);
    if (!parsed || wants[parsed.kind] === undefined) continue;
    wants[parsed.kind] += parsed.n;
    total += parsed.n;
  }
  if (!total) return { set: 1, run: 0, colorGroup: 0 };
  return { set: wants.set / total, run: wants.run / total, colorGroup: wants.colorGroup / total };
}

/** Rank/colour tallies of a hand, computed once and asked many questions. */
function handShape(ctx, handIds) {
  const ranks = new Map();
  const colors = new Map();
  for (const id of handIds) {
    const card = ctx.cardById(id);
    if (!card || isWildCard(ctx, card) || !isMeldable(ctx, card)) continue;
    ranks.set(card.rank, (ranks.get(card.rank) || 0) + 1);
    colors.set(card.color, (colors.get(card.color) || 0) + 1);
  }
  return { ranks, colors };
}

/**
 * What this card is worth KEEPING, given the contract the seat still owes.
 *
 * `self` is the card's own id when it is already counted in `shape` (scoring a
 * discard) and null when it is not (grading the pile top before taking it) —
 * one function for both questions, because "should I take this" and "should I
 * throw this" have to be answered on the same scale or the bot picks a card up
 * and puts it straight back down.
 *
 * A run wants NEIGHBOURING RANKS, not repeats: this template's runs are checked
 * on rank alone (melds.js), a repeated rank is rejected outright, and a rank one
 * or two away is the card that closes a window. A duplicate is worth nothing to
 * a run and the old rank-mate count was scoring it as the best card in the hand.
 */
function keepValue(ctx, card, shape, wants, self) {
  if (isWildCard(ctx, card)) return WILD_KEEP;
  // A skip can never enter a meld (rules.meldForbidden) and costs 15 at the
  // end, so it is always the first card out of the hand — below even a card
  // with no friends at all, which is what the negative buys.
  if (!isMeldable(ctx, card)) return -1;

  const own = self === null ? 0 : 1;
  const rankMates = Math.max(0, (shape.ranks.get(card.rank) || 0) - own);
  const colorMates = Math.max(0, (shape.colors.get(card.color) || 0) - own);
  const rank = Number(card.rank);
  let neighbours = 0;
  if (Number.isFinite(rank)) {
    for (const step of [-2, -1, 1, 2]) {
      if (shape.ranks.has(String(rank + step))) neighbours += Math.abs(step) === 1 ? 1 : 0.5;
    }
  }

  return wants.set * rankMates * 3
    + wants.run * neighbours * 2
    + wants.colorGroup * colorMates * 1.5;
}

/**
 * Every rank and colour that would LAND ON a meld already on the felt — for
 * `seat`'s own melds (cards worth holding, since the melds keep growing and a
 * card two away today is adjacent tomorrow) and for everyone else's (cards
 * worth not handing over).
 *
 * Read straight off the `melds` zone, which is `visibility: 'all'`. This is the
 * public half of card counting: at a real table you can see exactly what your
 * opponents have laid down and you do not throw them the card that finishes it.
 *
 * A run reaches one rank past each end; a set reaches its rank; a colour group
 * reaches its colour. Structural rather than a `resolveHit` call per card per
 * meld, because this runs inside the most expensive scoring loop in the repo.
 */
function meldReach(ctx, seat) {
  const mine = { ranks: new Set(), colors: new Set() };
  const theirs = { ranks: new Set(), colors: new Set() };
  for (let s = 0; s < ctx.seats; s++) {
    const into = s === seat ? mine : theirs;
    for (const group of getMeldGroups(ctx, s)) {
      const kind = meldKindOf(ctx, group);
      if (!kind) continue;
      const values = group.cards
        .map((id) => meldValue(ctx, { id, card: ctx.cardById(id) }, kind, group.wilds))
        .filter((v) => v !== undefined && v !== null);
      if (!values.length) continue;
      if (kind === 'colorGroup') into.colors.add(String(values[0]));
      else if (kind === 'set') into.ranks.add(String(values[0]));
      else {
        const ranks = values.map(Number).filter(Number.isFinite);
        if (!ranks.length) continue;
        into.ranks.add(String(Math.min(...ranks) - 1));
        into.ranks.add(String(Math.max(...ranks) + 1));
      }
    }
  }
  return { mine, theirs };
}

function reaches(scope, card) {
  return scope.ranks.has(String(card.rank)) || scope.colors.has(String(card.color));
}

/**
 * How badly this card is wanted by the seats that have been TAKING from the
 * pile — the second public signal, and the one a human reads without noticing.
 * Somebody who just picked up a green 7 is collecting sevens or greens, and the
 * next seven you throw is the one that lets them go out.
 */
function pileAppetite(ctx, seat, card) {
  const taken = ctx.var(PILE_TAKEN_VAR) || [];
  let appetite = 0;
  for (let s = 0; s < ctx.seats; s++) {
    if (s === seat) continue;
    for (const seen of taken[s] || []) {
      if (seen.rank === card.rank) appetite += 1;
      else if (seen.color !== null && seen.color === card.color) appetite += 0.34;
    }
  }
  return appetite;
}

/**
 * DECK OR PILE. Positive means the face-up card beats an unknown one.
 *
 * A seat that has laid down is asking a different question from one that has
 * not: its hand no longer shrinks by melding, only by hitting, so the only card
 * worth taking is one that hits something right now — and taking anything else
 * is worse than useless, because it spends the turn that would have turned a
 * fresh card off the deck.
 */
export function scoreDraw(ctx, move) {
  if ((move.from ?? 'draw') !== 'discard') return 0;
  const topId = ctx.topOf('discard');
  if (topId === undefined) return -1;
  const seat = move.actor;
  const card = ctx.cardById(topId);
  const reach = meldReach(ctx, seat);

  if (ctx.playerVar(seat, 'laidDown')) {
    if (isWildCard(ctx, card)) return 4;
    return reaches(reach.mine, card) || reaches(reach.theirs, card) ? 4 : -1;
  }

  const handIds = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const shape = handShape(ctx, handIds);
  return keepValue(ctx, card, shape, contractWants(ctx, seat), null) - PILE_PICKUP_BAR;
}

/**
 * WHICH CARD TO THROW — least useful to me, least useful to them.
 *
 * Returned negated, because bot.js takes the highest score and this is a cost:
 * the card that costs least to lose is the card that gets discarded.
 *
 * The opponent terms are deliberately smaller than the keep terms. Feeding a
 * meld hands one card to one opponent; throwing away the card that completes
 * your own contract costs you the round. A bot that hoards everything an
 * opponent might want stops making progress and looks paralysed, which is worse
 * to play against than one that occasionally donates a card.
 *
 * They do earn their place: a seat that scores discards on its own hand alone,
 * against three that read the felt, ends eight hundred rounds between half a
 * point and three points of leftover hand worse off — every seat, every time it
 * was the one looking away.
 */
const FEEDS_A_MELD = 2;
const APPETITE_WORTH = 0.75;
export function scoreDiscard(ctx, move) {
  const seat = move.actor;
  const cardId = move.cards[0];
  const card = ctx.cardById(cardId);
  const handIds = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const reach = meldReach(ctx, seat);

  let keep;
  if (ctx.playerVar(seat, 'laidDown')) {
    // Past the lay-down every hittable card has already been hit this turn
    // (enumeration offers hits first and they outscore any discard), so what is
    // left is judged on whether it can EVER hit: melds grow at the ends, so a
    // card that reaches one today is the card that goes out tomorrow.
    keep = isWildCard(ctx, card) ? WILD_KEEP
      : (reaches(reach.mine, card) || reaches(reach.theirs, card)) ? 3
        : isMeldable(ctx, card) ? 0 : -1;
  } else {
    keep = keepValue(ctx, card, handShape(ctx, handIds), contractWants(ctx, seat), cardId);
  }

  // A card that reaches an opponent's meld is counted twice on purpose, once as
  // worth holding and once as worth not giving away. Those pull the same way:
  // anyone's meld is a meld this seat may hit once it has laid down, so the card
  // is both a future exit and a gift, and it should be the last thing thrown.
  const feedsThem = reaches(reach.theirs, card) ? FEEDS_A_MELD : 0;
  return -(keep + feedsThem + pileAppetite(ctx, seat, card) * APPETITE_WORTH);
}

/* ------------------------------------------------------------------ *
 * How good this position is, for one seat
 * ------------------------------------------------------------------ *
 *
 * `botHeuristic` grades a MOVE and cannot say the thing that actually decides a
 * rummy turn: not "this discard is cheap to lose" but "and it leaves me one
 * card off the contract". `evaluateState` grades the POSITION instead, and
 * src/engine/bot.js gets that second sentence for free by playing each legal
 * move out on a fork and asking this.
 *
 * THE SAME VOCABULARY AS THE MOVE SCORER, deliberately. `contractWants`,
 * `handShape`, `keepValue` and `meldReach` are already this template's answer to
 * "what is a card worth to me"; a position is what those add up to. Two
 * different vocabularies would be two different opinions about the same hand,
 * and the search layer would spend its time arbitrating between them.
 *
 * WHAT IT DELIBERATELY DOES NOT READ. Nobody else's hand — not its cards, not
 * its values, not what is meldable in it. Not the draw pile's order, and not
 * the discard pile below the face-up top. All of that is sitting right there in
 * the state a bot is handed (tools/simulate.mjs says so in as many words), and
 * reading it here would be a bot that "always knew you had the queen" with no
 * test able to see it — the exact unfairness Phase 3's determinizer exists to
 * make impossible for rollouts. What an opponent contributes here is what the
 * table can see: whether they have laid down, and how many cards they are
 * holding.
 *
 * SCALE. Arbitrary, per-template, and only ever compared against itself — but
 * SEAT-SYMMETRIC, which is not arbitrary: the same expression is evaluated for
 * whichever seat is asking, so a move can never look good merely because of who
 * was asked about it.
 *
 * WHAT IT IS WORTH, and it is worth saying plainly because the honest answer is
 * "some". Over six hundred rounds with one seat on the evaluator and the other
 * three on `botHeuristic` alone, rotating which seat is which: the evaluated
 * seat leaves 17.0 points in hand against their 18.9, and goes out 26% of the
 * time against a 25% share. The round score moves; the race barely does. Every
 * weight below was swept, and each is quoted with what removing it costs.
 */

/**
 * Laying down is the round's first objective, and worth rather more than the
 * ten-card hand you were dealt: it is what turns "collecting" into "going out".
 */
const LAID_DOWN_WORTH = 40;

/** Every card still held is a turn between here and going out. */
const CARD_IN_HAND = 3;

/**
 * Leftover hand value IS the round score (Milestones: leftover-hand-values) —
 * and it is priced at a twentieth of the card holding it, because emptying the
 * hand is how the score gets to zero. Raised to 0.6 the seat hoards its cheap
 * cards and goes out 17.5% of the time instead of 26%.
 */
const DEADWOOD_WORTH = 0.15;

/**
 * How much a hand's progress toward its contract counts, and the ceiling on
 * any one card's contribution.
 *
 * Capped because `keepValue` prices a wild at WILD_KEEP (100) to keep it out of
 * every discard list — correct there, and nonsense summed over a hand, where
 * three wilds would outweigh laying down twice over.
 */
const PROGRESS_WORTH = 0.5;
const PROGRESS_CAP = 12;

/**
 * A held card that can reach SOME meld on the felt is a way out of the hand.
 *
 * Kept below CARD_IN_HAND on purpose. Price an "out" above the card itself and
 * the seat starts hoarding hittable cards rather than playing them: at 3 it
 * goes out 23.2% of the time against this term's 26%. At 1 it is a tie-breaker
 * between discards, which is all it should be.
 */
const OUT_WORTH = 1;

/**
 * THE TURN YOU HAVE NOT SPENT YET, and the term one ply of lookahead does not
 * work without.
 *
 * A hit and a discard both take exactly one card out of the hand, so a position
 * evaluator looking one move ahead rates them the same — and the bot then
 * throws a card away instead of hitting with it, because a discard usually
 * sheds the more useless card of the two. That is backwards and it is the whole
 * round: a hit is FREE, the discard still has to happen afterwards, and two
 * cards leave the hand instead of one.
 *
 * It is by a distance the most load-bearing weight here. Set it to zero and the
 * evaluated seat goes out 8.7% of the time instead of 26%, and ends the round
 * holding 26.1 points instead of 17.0 — worse, by a mile, than the heuristic it
 * replaced.
 *
 * So a position where this seat still owes a discard is worth one more card out
 * of the hand, because that is what it is.
 */
const OWED_DISCARD = CARD_IN_HAND;

/** How much the leader's position discounts your own. */
const RIVAL_SHARE = 0.6;

/**
 * What the table can see of a seat's position — asked about every seat,
 * including the one doing the asking.
 */
function publicStanding(ctx, seat) {
  const laid = ctx.playerVar(seat, 'laidDown') ? LAID_DOWN_WORTH : 0;
  return laid - ctx.countIn(ctx.zoneAddr('hand', seat)) * CARD_IN_HAND;
}

export function evaluateState(ctx, seat) {
  const handIds = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const scoring = ctx.pack.scoring || {};

  const reach = meldReach(ctx, seat);
  let score = publicStanding(ctx, seat);
  if (ctx.turn.seat === seat && ctx.turn.phase !== 'draw') score += OWED_DISCARD;
  for (const id of handIds) score -= cardValue(ctx.cardById(id), scoring) * DEADWOOD_WORTH;

  // WHAT IS LYING FACE UP, which after a discard is the card this seat just
  // handed the table. Priced exactly as scoreDiscard prices it, because it is
  // the same fact seen from the other side: a position where the pile top
  // finishes somebody's meld, or is the rank the seat opposite has been
  // collecting, is a worse position to be sitting in. Without these two lines
  // the position score is blind to everything Phase 1 taught the discard about
  // the rest of the table, and the seat goes out 20.8% of the time instead of
  // 26%.
  const topId = ctx.topOf('discard');
  if (topId !== undefined) {
    const top = ctx.cardById(topId);
    if (reaches(reach.theirs, top)) score -= FEEDS_A_MELD;
    score -= pileAppetite(ctx, seat, top) * APPETITE_WORTH;
  }

  if (ctx.playerVar(seat, 'laidDown')) {
    // Past the lay-down a hand only shrinks by hitting, so what matters is how
    // many of the cards left can land on ANY meld on the felt — including
    // somebody else's, which is a perfectly good way to go out.
    for (const id of handIds) {
      const card = ctx.cardById(id);
      if (isWildCard(ctx, card) || reaches(reach.mine, card) || reaches(reach.theirs, card)) {
        score += OUT_WORTH;
      }
    }
  } else {
    const shape = handShape(ctx, handIds);
    const wants = contractWants(ctx, seat);
    for (const id of handIds) {
      const keep = keepValue(ctx, ctx.cardById(id), shape, wants, id);
      score += Math.min(keep, PROGRESS_CAP) * PROGRESS_WORTH;
    }
  }

  // The race is against whoever is furthest along, not against the average of
  // the table: a seat about to go out is the one that decides how much time
  // this hand has left.
  let rival = -Infinity;
  for (let s = 0; s < ctx.seats; s++) {
    if (s === seat) continue;
    rival = Math.max(rival, publicStanding(ctx, s));
  }
  return Number.isFinite(rival) ? score - RIVAL_SHARE * rival : score;
}
