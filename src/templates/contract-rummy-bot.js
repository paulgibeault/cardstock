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
  getMeldGroups, pinnedAttr, wildHitValues, rankDomain,
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
 * How much the pile top has to IMPROVE THE HAND before it is worth taking
 * over an unknown card off the deck.
 *
 * Measured against the hand's total keep value after the swap — the top card
 * in, the card it makes least wanted out — rather than against the top card's
 * value on its own, and the difference is the second live-lock this bot had.
 * The first cut graded the top card in isolation: "does it have a friend in
 * my hand". With a run(8) or colorGroup(7) owed, nearly every card has one, so
 * two seats took each other's discards every turn, the deck never turned, and
 * the same twenty cards went round until the move cap — exactly the closed
 * system phase 1 had fixed for round one, come back in round six. It never
 * showed because tools/simulate.mjs played round one only, where the contract
 * is two sets and a friend is a genuine duplicate (#92).
 *
 * The swap gain is what actually breaks the cycle: taking a card and throwing
 * one of equal worth is a turn that turned nothing over, and grading it as a
 * gain of nothing sends the seat to the deck, where a card it has not seen can
 * arrive. A seat's total keep value can only rise by a take, and it is
 * bounded, so a round cannot circulate the pile indefinitely.
 *
 * Swept from 0 to 5 at two seats over three hundred whole matches each, and
 * again over three hundred four-seat rounds: every setting finishes every
 * match, at the same 11.6 rounds and the same 53 moves a round. The bar is
 * flat because the potential above is doing the work now — it is the swap
 * gain being measured on the final hand that stops the cycle, not the height
 * of the bar. So this stays where the original sweep put it, a comfortable
 * middle, kept because a bar that EXISTS is what stops a swap worth exactly
 * nothing from being decided by enumeration order.
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
function contractWants(ctx, seat, w) {
  const contract = ctx.rules.contracts[ctx.playerVar(seat, 'phase') - 1] || [];
  const wants = { set: 0, run: 0, colorGroup: 0 };
  let total = 0;
  let runLength = 0;
  for (const item of contract) {
    const parsed = parseItem(item);
    if (!parsed || wants[parsed.kind] === undefined) continue;
    wants[parsed.kind] += parsed.n;
    total += parsed.n;
    if (parsed.kind === 'run') runLength = Math.max(runLength, parsed.n);
  }
  const domain = rankDomain(ctx);
  if (!total) return { set: 1, run: 0, colorGroup: 0, runLength, domain, w };
  return {
    set: wants.set / total, run: wants.run / total, colorGroup: wants.colorGroup / total,
    runLength, domain, w,
  };
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
 * A run wants DISTINCT RANKS IN ONE WINDOW, not repeats and not only
 * neighbours. This template's runs are checked on rank alone (melds.js) and a
 * repeated rank is rejected outright, so under a run contract a second copy of
 * a rank is dead weight — priced below a card with no friends at all, because
 * a friendless card can still seed a run and a duplicate never can. The first
 * cut of this counted neighbours one and two ranks away, and two-seat matches
 * found both ways that is too near-sighted (#92): a seat holding eight tens
 * under run(9) valued every ten at nothing and every fresh card at nothing,
 * and threw the fresh card each turn because a ten would feed the opponent's
 * run — and a seat holding five wilds with a 4 and a 5 threw away every 8, 9
 * and 11 it drew, each of which the wilds could have bridged to. Grading a
 * card by the fullest run-length window it sits in, rather than by what is
 * adjacent to it, is what lets a hand START a run and finish one.
 */
function keepValue(ctx, card, shape, wants, self) {
  const w = wants.w;
  if (isWildCard(ctx, card)) return w.WILD_KEEP;
  // A skip can never enter a meld (rules.meldForbidden) and costs 15 at the
  // end, so it is always the first card out of the hand — below even a card
  // with no friends at all, which is what the negative buys.
  if (!isMeldable(ctx, card)) return -1;

  const own = self === null ? 0 : 1;
  const rankMates = Math.max(0, (shape.ranks.get(card.rank) || 0) - own);
  const colorMates = Math.max(0, (shape.colors.get(card.color) || 0) - own);

  return wants.set * rankMates * w.SET_MATE_WORTH
    + wants.run * runWorth(card, shape, wants, rankMates, own) * w.RUN_WINDOW_WORTH
    + wants.colorGroup * colorMates * w.COLOUR_MATE_WORTH;
}

/**
 * What one friend is worth, per kind of contract: a rank-mate toward a set, a
 * distinct rank in the same window toward a run, a colour-mate toward a colour
 * group. Sets pay most because a rank-mate is the rarest kind of friend — two
 * copies of each rank per colour — and a run's window fills from twelve ranks.
 */
const SET_MATE_WORTH = 3;
const RUN_WINDOW_WORTH = 2;
const COLOUR_MATE_WORTH = 1.5;

/** A duplicate rank under a run contract: below a card with no friends. */
const RUN_DUPLICATE = -0.5;

/**
 * How many OTHER distinct ranks share the fullest run-length window this card
 * can sit in, clipped to the ranks the deck actually holds — so a 12 is not
 * credited with a window running up to 20. On the same scale the old
 * neighbour count was: a card with one adjacent rank is still worth 1 here,
 * and a card between two of them still 2.
 */
function runWorth(card, shape, wants, rankMates, own) {
  if (wants.run <= 0) return 0;
  const rank = Number(card.rank);
  if (!Number.isFinite(rank)) return 0;
  if (rankMates > 0) return wants.w.RUN_DUPLICATE;
  const n = wants.runLength;
  const { min, max } = wants.domain;
  let best = 0;
  for (let start = Math.max(min, rank - n + 1); start <= Math.min(rank, max - n + 1); start++) {
    let others = 0;
    for (let r = start; r < start + n; r++) {
      if (r !== rank && shape.ranks.has(String(r))) others++;
    }
    if (others > best) best = others;
  }
  return best;
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
export function scoreDraw(ctx, move, w = WEIGHTS) {
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

  return pileGain(ctx, seat, topId, w) - w.PILE_PICKUP_BAR;
}

/**
 * What taking the pile top does to the hand: the total keep value of the hand
 * with the card in and the card the seat would then throw out, minus the total
 * as it stands. Zero for a swap that changes nothing; see PILE_PICKUP_BAR for
 * why that is the number that matters.
 *
 * TOTALS, AND THE REAL DISCARD. Totals rather than "the top card's value minus
 * the worst card's", because keepValue is relational — a 7 is worth more for
 * the 6 and 8 beside it, and they are worth more for the 7 — so the honest
 * gain of a swap is measured on the whole hand. And the card that leaves is
 * the one `scoreDiscard` would actually choose, opponent terms included,
 * rather than the least valuable one: a seat that will not feed the pile the
 * card its opponent is collecting throws a better card instead, and a gain
 * computed as if it had thrown the worst one is a gain it never gets. That
 * gap was the last two-seat live-lock — a swap graded as progress that left
 * the hand worse, over and over, with the deck untouched.
 */
function pileGain(ctx, seat, topId, w) {
  const handIds = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const wants = contractWants(ctx, seat, w);
  const reach = meldReach(ctx, seat);
  const before = handShape(ctx, handIds);
  let total = 0;
  for (const id of handIds) total += keepValue(ctx, ctx.cardById(id), before, wants, id);

  const taken = [...handIds, topId];
  const after = handShape(ctx, taken);
  let leaving = null;
  let cheapest = Infinity;
  for (const id of taken) {
    const card = ctx.cardById(id);
    const cost = discardCost(ctx, seat, card, keepValue(ctx, card, after, wants, id), reach, w);
    if (cost < cheapest) {
      cheapest = cost;
      leaving = id;
    }
  }

  // RE-SHAPED WITHOUT THE CARD THAT LEFT, not the after-shape minus one value.
  // The card thrown was worth something to its neighbours too, and a gain that
  // counted what the new card gives the hand but not what the old one takes
  // with it rated BOTH halves of a two-card swap as progress — take the 3 for
  // what it does for the 4s, throw the 7 the 6s were counting on, take the 7
  // back next turn for the 6s, throw the 3 — forever. Valuing the hand it
  // actually ends up holding is what makes this a quantity a round cannot
  // raise indefinitely.
  const kept = taken.filter((id) => id !== leaving);
  const final = handShape(ctx, kept);
  let sum = 0;
  for (const id of kept) sum += keepValue(ctx, ctx.cardById(id), final, wants, id);
  return sum - total;
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
export function scoreDiscard(ctx, move, w = WEIGHTS) {
  const seat = move.actor;
  const cardId = move.cards[0];
  const card = ctx.cardById(cardId);
  const reach = meldReach(ctx, seat);

  let keep;
  if (ctx.playerVar(seat, 'laidDown')) {
    // Past the lay-down every hittable card has already been hit this turn
    // (enumeration offers hits first and they outscore any discard), so what is
    // left is judged on whether it can EVER hit: melds grow at the ends, so a
    // card that reaches one today is the card that goes out tomorrow.
    keep = isWildCard(ctx, card) ? w.WILD_KEEP
      : (reaches(reach.mine, card) || reaches(reach.theirs, card)) ? 3
        : isMeldable(ctx, card) ? 0 : -1;
  } else {
    const handIds = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    keep = keepValue(ctx, card, handShape(ctx, handIds), contractWants(ctx, seat, w), cardId);
  }
  return -discardCost(ctx, seat, card, keep, reach, w);
}

/**
 * What throwing this card costs: what it was worth keeping, plus what it hands
 * the table. Shared by the discard scorer and by `pileGain`, which has to know
 * which card WOULD leave after a pickup — and it has to be this answer, not
 * "the least valuable card", or the two disagree and the bot picks a card up
 * that it then throws a better one to keep.
 *
 * A card that reaches an opponent's meld is counted twice on purpose, once as
 * worth holding (in `keep`) and once as worth not giving away. Those pull the
 * same way: anyone's meld is a meld this seat may hit once it has laid down,
 * so the card is both a future exit and a gift, and it should be the last
 * thing thrown.
 */
function discardCost(ctx, seat, card, keep, reach, w) {
  const feedsThem = reaches(reach.theirs, card) ? w.FEEDS_A_MELD : 0;
  return keep + feedsThem + pileAppetite(ctx, seat, card) * w.APPETITE_WORTH;
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
 * of the hand, because that is what it is — priced at CARD_IN_HAND where it is
 * read, not as a weight of its own.
 */

/** How much the leader's position discounts your own. */
const RIVAL_SHARE = 0.6;

/**
 * What the table can see of a seat's position — asked about every seat,
 * including the one doing the asking.
 */
function publicStanding(ctx, seat, w) {
  const laid = ctx.playerVar(seat, 'laidDown') ? w.LAID_DOWN_WORTH : 0;
  return laid - ctx.countIn(ctx.zoneAddr('hand', seat)) * w.CARD_IN_HAND;
}

export function evaluateState(ctx, seat, w = WEIGHTS) {
  const handIds = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const scoring = ctx.pack.scoring || {};

  const reach = meldReach(ctx, seat);
  let score = publicStanding(ctx, seat, w);
  if (ctx.turn.seat === seat && ctx.turn.phase !== 'draw') score += w.CARD_IN_HAND;
  for (const id of handIds) score -= cardValue(ctx.cardById(id), scoring) * w.DEADWOOD_WORTH;

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
    if (reaches(reach.theirs, top)) score -= w.FEEDS_A_MELD;
    score -= pileAppetite(ctx, seat, top) * w.APPETITE_WORTH;
  }

  if (ctx.playerVar(seat, 'laidDown')) {
    // Past the lay-down a hand only shrinks by hitting, so what matters is how
    // many of the cards left can land on ANY meld on the felt — including
    // somebody else's, which is a perfectly good way to go out.
    for (const id of handIds) {
      const card = ctx.cardById(id);
      if (isWildCard(ctx, card) || reaches(reach.mine, card) || reaches(reach.theirs, card)) {
        score += w.OUT_WORTH;
      }
    }
  } else {
    const shape = handShape(ctx, handIds);
    const wants = contractWants(ctx, seat, w);
    for (const id of handIds) {
      const keep = keepValue(ctx, ctx.cardById(id), shape, wants, id);
      score += Math.min(keep, w.PROGRESS_CAP) * w.PROGRESS_WORTH;
    }
  }

  // The race is against whoever is furthest along, not against the average of
  // the table: a seat about to go out is the one that decides how much time
  // this hand has left.
  let rival = -Infinity;
  for (let s = 0; s < ctx.seats; s++) {
    if (s === seat) continue;
    rival = Math.max(rival, publicStanding(ctx, s, w));
  }
  return Number.isFinite(rival) ? score - w.RIVAL_SHARE * rival : score;
}

/**
 * EVERY NUMBER THE STRATEGY IS MADE OF, in one object, with the shipped value
 * of each — the constants above, gathered.
 *
 * The constants stay where they are because each one's comment is the record
 * of how it was chosen, and this object exists so a caller can hand the hooks
 * a DIFFERENT set: `botHeuristic(ctx, move, w)` and `evaluateState(ctx, seat,
 * w)` read every weight through `w`, defaulting to this. That is what lets two
 * seats in one simulated game play the same template with different opinions,
 * which is what tools/tune.mjs seats against each other — and what keeps the
 * hooks pure, so a tuning run cannot leave a weight changed behind it.
 *
 * Frozen: the shipped values are read, never written. A candidate is a copy.
 */
export const WEIGHTS = Object.freeze({
  WILD_KEEP,
  PILE_PICKUP_BAR,
  SET_MATE_WORTH,
  RUN_WINDOW_WORTH,
  COLOUR_MATE_WORTH,
  RUN_DUPLICATE,
  FEEDS_A_MELD,
  APPETITE_WORTH,
  LAID_DOWN_WORTH,
  CARD_IN_HAND,
  DEADWOOD_WORTH,
  PROGRESS_WORTH,
  PROGRESS_CAP,
  OUT_WORTH,
  RIVAL_SHARE,
});
