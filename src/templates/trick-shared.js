// The facts about a DECK and a TRICK that the core and every phase module read.
//
// Split out of trick-taking.js with the three phases (#224), and it is the
// module that makes that split acyclic: the auction counts a hand in tricks and
// prices the trick on the table, the meld is scored in the trump suit, the pass
// shortlist asks which cards are liabilities — so all three need the same
// handful of answers the core needs, and a phase importing them back out of the
// core would make every phase module and the core mutually dependent.
//
// WHAT BELONGS HERE is the arithmetic: which suit is trump, how high a card
// plays, who is winning what is on the table, where the deck's dangerous cards
// start, and which seat leads. WHAT DOES NOT is anything that CHANGES the
// table — resolving a trick, placing a card, deciding what is legal — which is
// the core's (src/templates/trick-taking.js), and anything that belongs to one
// phase, which is that phase's.

import { distinctValues, rankLadderOf, rankOrder } from '../engine/cards.js';
import { cardValue } from '../engine/scoring.js';
import { memoOnPack } from '../engine/templateKit.js';

export function isExactCardFirstLead(ctx) {
  const fl = ctx.rules.firstLead;
  return typeof fl === 'string' && ctx.pack.cardsById.has(fl);
}

/* ------------------------------------------------------------------ *
 * TRUMP — a suit that beats the led one, on top of the pack's ladder
 * ------------------------------------------------------------------ *
 *
 * The design doc listed `trump` as a trick-taking parameter (§13.1) and the
 * template was no-trump: the word appeared nowhere in this file. Hearts is
 * right not to declare it, which is why nothing noticed.
 *
 * TWO KEYS, NOT ONE, and they say different things. `trump` names the SUIT
 * (`none`, a suit, or `chosen` — a round that names its own, which is where
 * Pinochle's bid will put its answer); `trickWinner` says whether the trick
 * resolution reads it at all. Keeping them apart is what lets a pack declare a
 * trump suit for the bot and the felt to talk about while some other rule
 * decides the trick — and it keeps `highest-of-led`, the shape every pack
 * shipped with, the default rather than a special case.
 */
export function trumpSuitOf(ctx) {
  const declared = ctx.rules.trump;
  if (!declared || declared === 'none') return null;
  // `chosen`: the ROUND names its trump, in a var the felt publishes. The
  // auction is what fills it in (src/templates/trick-auction.js, `settleAuction`)
  // — Spades' trump is fixed and Pinochle's is bid for — so this is the
  // resolution rule written once rather than the phase that answers it.
  if (declared === 'chosen') return ctx.var('trumpSuit') ?? null;
  return declared;
}

/** The trump suit the TRICK is resolved by — null unless the pack says so. */
export function trickTrumpOf(ctx) {
  return ctx.rules.trickWinner === 'highest-trump-else-led' ? trumpSuitOf(ctx) : null;
}

/**
 * The height a trump is lifted to — one clear of the highest rank the deck
 * holds, so "any trump beats every card of the led suit" is one number line and
 * not a second comparison. See `trickLeaderSoFar`, which is where it was first
 * written and which this shares so the two can never disagree about how high a
 * trump plays.
 */
export function trumpShelf(ctx, trump) {
  return trump === null ? 0 : perilOf(ctx).topRank + 1;
}

/**
 * A suit as a label — the deck's own word, capitalised, and nothing else.
 *
 * Deliberately not a table of the four French suits: the suits are whatever the
 * deck holds (`perilOf().suits`), and a template that mapped them to symbols
 * would be a template with a deck in it.
 */
export function suitLabel(suit) {
  const name = String(suit ?? '');
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

/**
 * The rank above which a card is a LIABILITY, per suit: the rank of the
 * priciest card the pack charges for in that suit.
 *
 * This is "dump the high spades" without the template ever hearing the word
 * spades. Hearts charges 13 for the queen of spades, so the king and the ace
 * are cards whose only future is taking it; it charges 1 for every heart, so
 * the priciest heart is the ace and nothing outranks it — no heart is a
 * liability by this rule, which is right, because a low heart is a card you
 * WANT when hearts are led.
 *
 * A pack with no card values gets an empty map and the liability candidate
 * collapses into "costliest", where the dedup drops it.
 */
/**
 * Memoised on the PACK, which is what it is a fact about: the deck and its
 * scoring are both fixed once loaded, and this sweeps every card in the deck.
 * It used to be asked once per pass ranking; `evaluateState` now asks it once
 * per candidate card per turn, which is the point at which a per-pack answer
 * recomputed per call stops being free.
 */
export function perilOf(ctx) {
  return memoOnPack(ctx.pack, 'trick-taking:peril', () => buildPeril(ctx));
}

function buildPeril(ctx) {
  const scoring = ctx.pack.scoring || {};
  const ladder = rankLadderOf(ctx.pack);
  const peril = new Map();
  // The deck's suits: the bidding heuristic asks "which suits am I VOID in",
  // and the answer is a fact about the deck that a per-call sweep would
  // recompute once per candidate bid. `distinctValues` is the engine's answer
  // to "every value of one attribute this deck holds, in deck order" (#211);
  // this used to gather them by hand on the sweep below, which is the same
  // walk written twice.
  const suits = new Set(distinctValues(ctx.pack.cardsById, 'suit'));
  let topRank = 0;
  // And the priciest and the cheapest card in the deck, on the same sweep.
  // `botHeuristic` needs both to know how wide its own ranking is — see
  // `trickBand`. `lowValue` floors at zero because a deck with no values at all
  // must give the same answer as one whose values are all zero, and because
  // what the band has to clear is the SPREAD: a pack with a card worth −10
  // (Hearts' `jack-of-diamonds` variant patches exactly that) makes that card
  // the most attractive in the deck by `-rank - value`, ten clear of the top,
  // and a band that did not count the ten would not outweigh it.
  let topValue = 0;
  let lowValue = 0;
  for (const card of ctx.pack.cardsById.values()) {
    const rank = rankOrder(card, ladder);
    if (rank > topRank) topRank = rank;
    const value = cardValue(card, scoring);
    if (value > topValue) topValue = value;
    if (value < lowValue) lowValue = value;
    if (!card.suit || value <= 0) continue;
    if (rank > (peril.get(card.suit) ?? -Infinity)) peril.set(card.suit, rank);
  }
  return { peril, topRank, topValue, lowValue, suits };
}

export function perilRankBySuit(ctx) {
  return perilOf(ctx).peril;
}

export function isLiability(ctx, card, peril, ladder = rankLadderOf(ctx.pack)) {
  const bar = peril.get(card.suit);
  return bar !== undefined && rankOrder(card, ladder) > bar;
}

function seatsForTrick(ctx, leader, count) {
  const seats = [];
  let seat = leader;
  for (let i = 0; i < count; i++) {
    seats.push(seat);
    seat = ctx.nextSeat(seat);
  }
  return seats;
}

/**
 * Who is winning the cards on the table RIGHT NOW, and with what rank.
 *
 * Split out of resolveTrick because a half-played trick has an answer too, and
 * `evaluateState` needs it: the whole question a trick-taking bot is asking is
 * "am I about to be handed this pile". `{ seat: null }` for an empty trick.
 *
 * `cards` IS A PREFIX OF THE TRICK, and defaults to the whole of it. The trick
 * zone is in play order, so dropping its last card is the position one card
 * back — which is what `evaluateContract` asks for when it wants to know what
 * the move it is judging actually CHANGED (#161).
 */
export function trickLeaderSoFar(ctx, cards = null) {
  const trickCards = cards ?? ctx.cardIdsIn('trick');
  if (!trickCards.length) return { seat: null, rank: -1 };
  const leader = ctx.var('leader');
  const led = ctx.var('led');
  const seats = seatsForTrick(ctx, leader, trickCards.length);

  const ladder = rankLadderOf(ctx.pack);
  // TRUMP IS A SHELF, NOT A SECOND COMPARISON. Any trump beats every card of
  // the led suit however high, so both live on one number — the pack's own
  // ladder, offset by its whole height for a trump — and the loop below stays
  // the single "highest wins" it has always been. `topRank` is what makes the
  // offset safe: it is one clear of the highest rank the deck holds.
  const trump = trickTrumpOf(ctx);
  const shelf = trump === null ? 0 : perilOf(ctx).topRank + 1;
  let winnerSeat = leader;
  let bestRank = -1;
  for (let i = 0; i < trickCards.length; i++) {
    const card = ctx.cardById(trickCards[i]);
    const isTrump = trump !== null && card.suit === trump;
    if (!isTrump && card.suit !== led) continue;
    // The pack's own ladder decides, and it is resolved once above rather than
    // per card. The comment that used to sit here said "within the led suit,
    // every rank ladder agrees" — which was false on the very deck Hearts
    // ships: `rankOrder` put the jack on top of the nine and the ten above it,
    // so ♥10 played before ♥J took the trick. See src/engine/cards.js.
    const rank = rankOrder(card, ladder) + (isTrump ? shelf : 0);
    if (rank > bestRank) {
      bestRank = rank;
      winnerSeat = seats[i];
    }
  }
  return { seat: winnerSeat, rank: bestRank };
}

/**
 * How well the trick on the table is likely to HOLD for whoever is winning it
 * — the discount the existing evaluator applies and this one wants too. A
 * trump on the shelf is above the ladder entirely, so this clamps at certain.
 */
export function holdsUp(ctx, taking) {
  const { topRank } = perilOf(ctx);
  if (taking.seat === null) return 0;
  if (topRank <= 0) return 1;
  return Math.min(1, Math.max(0, taking.rank) / topRank);
}

export function determineFirstLeader(ctx) {
  const fl = ctx.rules.firstLead;
  if (isExactCardFirstLead(ctx)) {
    for (let s = 0; s < ctx.seats; s++) {
      if (ctx.cardIdsIn(ctx.zoneAddr('hand', s)).includes(fl)) return s;
    }
    return 0;
  }
  if (fl === 'left-of-dealer') return ctx.nextSeat(ctx.openingSeat(), 1);
  return ctx.openingSeat();
}
