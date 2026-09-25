// THE AUCTION, as one of the trick-taking template's optional phases (#224).
//
// A phase module: the core (src/templates/trick-taking.js) holds the phase list
// and composes these slices onto its hooks — see the PHASE MODULE comment there
// for what each member means. It is the biggest of the three because it houses
// TWO auctions (`bidding.unit`) and the two evaluators they are scored by.
//
// Everything below was lifted out of trick-taking.js unchanged.

import { rankLadderOf, rankOrder } from '../engine/cards.js';
import { cardValue } from '../engine/scoring.js';
import {
  tricksOf, contractSeatOf, sideContract, bagsOf, bankedOf, prizeSign,
} from '../engine/contracts.js';
import { sidesOf, sideOfSeat } from '../engine/sides.js';
import { detectDeclaredMelds } from './melds.js';
import {
  determineFirstLeader, holdsUp, perilOf, suitLabel, trickLeaderSoFar, trumpSuitOf,
} from './trick-shared.js';

/* ------------------------------------------------------------------ *
 * THE BID — a sequential phase before the first lead
 * ------------------------------------------------------------------ *
 *
 * The design doc promised this and called it the template's first planned
 * extension: "trump + bidding needs a `sequential` round phase" (§13.1). The
 * pass is the template's other extra phase and it is the opposite shape —
 * everybody commits at once, nobody may see anybody else's choice — so almost
 * none of its machinery is reusable here and none of it is reused.
 *
 * SEQUENTIAL MEANS `turn.seat` ALREADY SAYS IT. One seat bids, the turn moves
 * on, the next seat bids knowing what was said before it; `actingSeats` is the
 * platform default (`[turn.seat]`) rather than the pass phase's every-seat
 * answer, and that difference IS the word "sequential" in the design doc — so
 * this module, alone of the three, declares no `actingSeats` at all.
 *
 * A BID IS PUBLIC THE MOMENT IT IS MADE. It lives in a per-seat var with no
 * `__` prefix, which is exactly what the view layer's rule (src/engine/view.js)
 * means by table knowledge — the pass hides behind `__pendingPass` because a
 * commit anybody can read is not a commit, and a bid is the reverse: a promise
 * made out loud, which the seats after you are entitled to hear before they
 * make their own.
 *
 * NOT `enumerateAnnouncements`. Announcements are out-of-turn interjections
 * with a window; this is a turn, in a phase, in the order the table sits.
 */

/** The bid this seat has made, or null while it still owes one. */
function bidOf(ctx, seat) {
  const value = ctx.playerVar(seat, 'bid');
  return Number.isInteger(value) ? value : null;
}

/**
 * WHAT A SEAT SAID, in the two characters a badge has and the sentence a
 * screen reader gets.
 *
 * A ZERO MEANS TWO OPPOSITE THINGS. At a trick auction it is a nil — the
 * boldest promise on the table. At a points auction it is a pass: this seat
 * said nothing at all. Printing "nil" for the second would tell the felt the
 * exact reverse of what happened.
 *
 * One reading, three places: the seat plates, the human's own strip and the
 * bid dialog's list of what everybody has promised so far (#123).
 */
function bidBadge(ctx, seat) {
  const bid = bidOf(ctx, seat);
  const blind = bidIsBlind(ctx, seat);
  const points = bidUnitOf(ctx) === 'points';
  return {
    text: bid === null ? '—' : bid === 0 ? (points ? '—' : blind ? 'BN' : 'nil') : String(bid),
    aria: bid === null ? 'has not bid yet'
      : bid === 0 ? (points ? 'passed' : `bid ${blind ? 'blind ' : ''}nil`)
        : points ? `bid ${bid} points` : `bid ${bid} ${bid === 1 ? 'trick' : 'tricks'}`,
  };
}

/**
 * THE SAME PROMISE, DRAWN RATHER THAN SPELLED — the pip row (#148).
 *
 * Round 6's finding on Team Spades: the two numbers a partner actually needs,
 * what they bid and how many they have taken, were both on the felt and
 * neither was readable at a glance. They were 0.7rem digits with 0.48rem words
 * under them, in a row with Cards and Bags, and the question a partnership is
 * played on — are we going to make it — was four badges and some arithmetic.
 * `kind: 'pips'` hands the platform the two numbers and it draws one circle per
 * trick promised, filling them left to right as the tricks come in
 * (src/ui/counterTrack.js).
 *
 * A TRICK AUCTION ONLY, and that is not a pack check but the genre's own
 * distinction: at a POINTS auction a bid is 250 and a circle apiece is not a
 * picture of anything, so Pinochle keeps its digits and its meld chips (#125).
 * `bidUnitOf` is the same question `bidBadge` asks to decide whether a zero is
 * a nil or a pass.
 *
 * It is the MINIMIZED face's counter. An open plate has room for the words, so
 * it keeps the captioned Bid and Tricks digits and their spoken sentences —
 * which is also what the round summary reads (`roundLines`).
 */
function pipsBadge(ctx, seat) {
  if (!ctx.rules.bidding || bidUnitOf(ctx) !== 'tricks') return null;
  const badge = bidBadge(ctx, seat);
  const bid = bidOf(ctx, seat);
  const taken = tricksOf(ctx, seat);
  const over = bid !== null && bid > 0 ? Math.max(0, taken - bid) : 0;
  // The picture is the pips; this is the whole of it in words, because the
  // circles are `aria-hidden` and the badge they replace said both numbers.
  const aria = bid === null ? badge.aria
    : bid === 0
      ? (taken
        ? `${badge.aria}, and has taken ${taken} — the nil is broken`
        : `${badge.aria}, none taken`)
      : `${badge.aria}, ${taken} taken${over ? `, ${over} over` : ''}`;
  return {
    // Still printed if this build ever stops knowing the kind: the bid, in the
    // template's own vocabulary. The fail-soft is the badge, not a blank.
    text: badge.text,
    aria,
    label: 'Tricks',
    kind: 'pips',
    bid,
    taken,
    nil: bid === 0,
    minimizedOnly: true,
  };
}

/** Was it declared blind — without looking? (`bidSight`, a public per-seat var.) */
function bidIsBlind(ctx, seat) {
  return ctx.playerVar(seat, 'bidSight') === 'blind';
}

/* ------------------------------------------------------------------ *
 * TWO AUCTIONS UNDER ONE PHASE — `bidding.unit`
 * ------------------------------------------------------------------ *
 *
 * Spades' auction and Pinochle's are the same PHASE — one seat at a time, in
 * seat order, each hearing what was said before it — and two different games.
 *
 *   tricks   every seat's bid stands, and a side's contract is its partners'
 *            bids added up. Nobody outbids anybody; four promises are made and
 *            all four are kept or paid for.
 *   points   one contract, and the seats compete for it. A bid is a SCORE the
 *            side will reach, it has to beat whatever has already been said,
 *            and a seat with nothing to say passes (a bid of 0). Exactly one
 *            side ends up holding it, and it names the trump suit.
 *
 * Everything that is genuinely shared stays shared: the per-seat `bid` var, its
 * publicness, the turn order, the "nothing is led until every seat has spoken"
 * check. What differs is what a candidate bid IS, and what happens when the
 * last seat has spoken — which is the whole of the two functions below.
 */
function bidUnitOf(ctx) {
  return ctx.rules.bidding?.unit === 'points' ? 'points' : 'tricks';
}

function bidIncrementOf(ctx) {
  const step = ctx.rules.bidding?.increment;
  return Number.isInteger(step) && step > 0 ? step : 1;
}

/** The suit a bid names, at an auction where a bid names one (`namesTrump`). */
function bidTrumpOf(move) {
  const suit = move?.choice?.trump;
  return typeof suit === 'string' && suit ? suit : null;
}

/** The best bid anybody has made so far this auction, or 0 if nobody has. */
function highestBidSoFar(ctx) {
  let best = 0;
  for (let seat = 0; seat < ctx.seats; seat++) best = Math.max(best, bidOf(ctx, seat) ?? 0);
  return best;
}

function everySeatHasBid(ctx) {
  for (let seat = 0; seat < ctx.seats; seat++) {
    if (bidOf(ctx, seat) === null) return false;
  }
  return true;
}

/** The bid a move carries, or null for a move that has not answered yet. */
function bidValueOf(move) {
  const value = move?.choice?.bid;
  return Number.isInteger(value) ? value : null;
}

function bidIsBlindMove(move) {
  return move?.choice?.sight === 'blind';
}

function minBidOf(ctx) {
  const min = ctx.rules.bidding?.min;
  return Number.isInteger(min) ? min : 0;
}

/**
 * The most a seat may promise: `bidding.max`, or — the useful answer, and the
 * one Spades wants — its whole hand, because a seat cannot take more tricks
 * than it holds cards.
 */
function maxBidOf(ctx, seat) {
  const max = ctx.rules.bidding?.max;
  if (Number.isInteger(max)) return max;
  return ctx.countIn(ctx.zoneAddr('hand', seat));
}

/**
 * MAY THIS SEAT GO BLIND? Only a side far enough behind, which is the whole
 * reason the bid exists at a real table: it is the shot you take when the
 * ordinary game can no longer catch up.
 *
 * The platform cannot enforce the "without looking" part — the cards are dealt
 * and the seat's own hand is in its view before any bid is possible — so what
 * is modelled is the WAGER (twice the stakes) and its entry condition. A felt
 * that wanted the ritual would have to deal the bid before the hand, which is
 * a change to the deal and not to this rule. Said plainly here so nobody
 * mistakes the omission for an oversight.
 */
function mayBidBlind(ctx, seat) {
  const behind = ctx.rules.bidding?.blindNil?.behind;
  if (!Number.isInteger(behind)) return false;
  const sides = sidesOf(ctx.pack, ctx.seats);
  const totals = sides.map((members) => members.reduce((sum, s) => sum + (Number(ctx.score(s)) || 0), 0));
  const mine = sideOfSeat(ctx.pack, ctx.seats, seat);
  return totals.some((total, side) => side !== mine && total - totals[mine] >= behind);
}

/**
 * The numbers this seat may say right now, low to high.
 *
 * At a trick auction that is every bid from the floor to the whole hand, which
 * is what it has always been. At a points auction it is the pass (0) and then
 * every rung of the ladder that would OUTBID what has been said — the floor for
 * the first speaker, one increment above the standing bid for everybody after.
 */
function bidLevels(ctx, seat) {
  const min = minBidOf(ctx);
  const max = maxBidOf(ctx, seat);
  const levels = [];
  if (bidUnitOf(ctx) !== 'points') {
    for (let bid = min; bid <= max; bid++) levels.push(bid);
    return levels;
  }
  const step = bidIncrementOf(ctx);
  const standing = highestBidSoFar(ctx);
  // THE LAST SEAT MAY NOT PASS OUT AN EMPTY AUCTION. Every table has this rule
  // and it is not a nicety: a hand where nobody holds the contract has no
  // number to be scored against and — where the bid names the trump suit —
  // nobody to name one, so the whole hand would be melded and played in no
  // trump. That was not hypothetical: the first cut let the seat pass, and one
  // deal in twenty reached the first lead with `trumpSuit` still null.
  if (!isStuckWithTheBid(ctx, seat, standing)) levels.push(0);
  for (let bid = Math.max(min, standing + step); bid <= max; bid += step) levels.push(bid);
  return levels;
}

/** Nobody has opened, and this seat is the last one who could. */
function isStuckWithTheBid(ctx, seat, standing = highestBidSoFar(ctx)) {
  if (bidUnitOf(ctx) !== 'points' || standing > 0) return false;
  for (let s = 0; s < ctx.seats; s++) {
    if (s !== seat && bidOf(ctx, s) === null) return false;
  }
  return true;
}

/** The suits a bid may name, for a pack whose bid names the trump suit. */
function bidSuits(ctx) {
  return ctx.rules.bidding?.namesTrump === true ? [...perilOf(ctx).suits] : [];
}

/** Every bid this seat may make right now, cheapest shape first, blind last. */
function bidCandidates(ctx, seat) {
  const moves = [];
  const suits = bidSuits(ctx);
  for (const bid of bidLevels(ctx, seat)) {
    // A PASS NAMES NO SUIT. It is not a contract, so there is nothing for it to
    // be trump in, and offering four indistinguishable passes would put three
    // duplicate moves in front of every bot and on every joiner's wire.
    if (!suits.length || bid === 0) moves.push({ actor: seat, type: 'bid', choice: { bid } });
    else for (const trump of suits) moves.push({ actor: seat, type: 'bid', choice: { bid, trump } });
  }
  if (mayBidBlind(ctx, seat)) {
    moves.push({ actor: seat, type: 'bid', choice: { bid: 0, sight: 'blind' } });
  }
  return moves;
}

/**
 * WHAT A HAND IS WORTH IN TRICKS — the whole of the bidding heuristic, and the
 * one judgement a trick-taking bot makes before it has seen a single card
 * played.
 *
 * It is the count every human makes and none of it is Spades-specific: the top
 * card of a suit takes a trick, the second one usually does if something is
 * standing behind it, length in the TRUMP suit turns small cards into winners
 * once the others have run out, and a short side suit is a trick you take by
 * ruffing — which is only true if you have trumps to ruff with, so both of
 * those terms ask the trump holding first.
 *
 * The distances are measured from the top of the PACK's ladder (#101), so a
 * deck whose ace is not the highest card is counted correctly without this
 * function knowing which rank is which.
 */
function expectedTricks(ctx, seat, trumpOverride) {
  const ladder = rankLadderOf(ctx.pack);
  const { topRank, suits } = perilOf(ctx);
  // A BID THAT NAMES ITS OWN TRUMP HAS TO BE COUNTED IN THAT TRUMP. During a
  // Pinochle auction `trumpSuit` is still unset — the suit is part of the move
  // being scored, not a fact about the table yet — so the caller passes it in.
  // Spades passes nothing and reads the fixed suit exactly as before.
  const trump = trumpOverride === undefined ? trumpSuitOf(ctx) : trumpOverride;

  const bySuit = new Map();
  for (const id of ctx.cardIdsIn(ctx.zoneAddr('hand', seat))) {
    const card = ctx.cardById(id);
    if (!card || card.suit === undefined || card.suit === null) continue;
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, []);
    bySuit.get(card.suit).push(rankOrder(card, ladder));
  }
  const trumps = trump === null ? [] : (bySuit.get(trump) || []);

  let tricks = 0;
  for (const [suit, ranks] of bySuit) {
    const isTrump = suit === trump;
    for (const rank of ranks) {
      const down = topRank - rank;
      if (isTrump) {
        // A high trump is a trick outright — nothing can be played over it and
        // it cannot be ducked past.
        if (down === 0) tricks += 1;
        else if (down === 1) tricks += ranks.length > 1 ? 0.9 : 0.5;
        else if (down === 2) tricks += ranks.length > 2 ? 0.7 : 0.3;
      } else if (down === 0) tricks += 0.95;
      else if (down === 1) tricks += ranks.length > 1 ? 0.7 : 0.35;
      else if (down === 2) tricks += ranks.length > 2 ? 0.4 : 0.15;
    }
    if (isTrump) {
      // Past the second trump the small ones stop being spare cards: the table
      // runs out of trumps before you do, and then yours take tricks on their
      // own — by ruffing a suit you are out of, or simply by being last. This
      // is the term that separates a hand of four low spades, worth well over a
      // trick, from the same hand with none, and it is the one that had to
      // MOVE: without it the table bid ten of the thirteen tricks between them
      // and paid for the other three in bags.
      tricks += Math.max(0, ranks.length - 2) * 0.6;
    } else if (trumps.length >= 2 && ranks.length === 1) {
      tricks += 0.35;
    }
  }
  if (trumps.length >= 2) {
    for (const suit of suits) {
      if (suit === trump || bySuit.has(suit)) continue;
      // A void is a trick every time that suit is led, for as long as the
      // trumps to ruff it with last.
      tricks += Math.min(trumps.length, 2) * 0.45;
    }
  }
  return tricks;
}

/**
 * HOW HARD THIS HAND WOULD BE TO DUCK WITH — nil's own count, and deliberately
 * not "expected tricks near zero".
 *
 * They are different questions. A hand of middling cards expects one trick and
 * would break a nil half the time; a hand of five low trumps and a void expects
 * two and cannot avoid winning one. What a nil needs is that EVERY card can be
 * got rid of under somebody else's, so this counts the cards that cannot, and a
 * long suit is what makes a king duckable — there are enough cards under it to
 * throw away first.
 */
function nilRisk(ctx, seat) {
  const ladder = rankLadderOf(ctx.pack);
  const { topRank } = perilOf(ctx);
  const trump = trumpSuitOf(ctx);

  const bySuit = new Map();
  for (const id of ctx.cardIdsIn(ctx.zoneAddr('hand', seat))) {
    const card = ctx.cardById(id);
    if (!card || card.suit === undefined || card.suit === null) continue;
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, []);
    bySuit.get(card.suit).push(rankOrder(card, ladder));
  }

  let risk = 0;
  for (const [suit, ranks] of bySuit) {
    const isTrump = suit === trump;
    for (const rank of ranks) {
      const down = topRank - rank;
      if (isTrump) {
        // A high trump has nowhere to hide: it wins whatever is led.
        if (down <= 3) risk += 1;
      } else if (down === 0) risk += 1;
      else if (down === 1) risk += ranks.length >= 4 ? 0.4 : 1;
      else if (down === 2) risk += ranks.length >= 4 ? 0.2 : 0.6;
    }
    // And too MANY trumps is its own danger: the hand runs out of side cards
    // and has to start winning with them.
    if (isTrump) risk += Math.max(0, ranks.length - 3);
  }
  return risk;
}

/** A hand this safe may say nil — see `nilRisk`. */
const NIL_RISK_BAR = 0.75;

/** How much a bid over the count costs against one under it. */
const BID_OVER_COST = 1.6;
const BID_UNDER_COST = 1;

/**
 * WHAT A BID IS WORTH, SCORED AS ONE MOVE (`botHeuristic`).
 *
 * Overbidding costs more than underbidding and that asymmetry is the whole
 * policy: a contract missed by one is the hand's entire score turned negative,
 * while a trick over it is a point now and a tenth of a bag penalty later. So
 * the bot bids its count, rounded DOWN when the count sits between two.
 */
/* ------------------------------------------------------------------ *
 * WHAT A HAND IS WORTH IN POINTS — the other half of the bidding heuristic
 * ------------------------------------------------------------------ *
 *
 * `expectedTricks` counts a hand in TRICKS, which is the currency Spades bids
 * in. A points auction is bid in the number the SIDE will score, and the number
 * is made of two things a seat can actually see:
 *
 *   the meld it is holding      exact, once a trump suit is named — the pack's
 *                               own table, run over its own hand.
 *   the tricks it expects       times what a trick is worth, which is the deck
 *                               divided by the number of tricks in a hand.
 *
 * And one it cannot: THE PARTNER'S HALF. A side's contract is paid by two
 * hands, and a seat that bid only what it could see itself would never open at
 * all — the floor at a real table is above what one hand can make. So a partner
 * is credited with an average share of what is left on the table, which is what
 * a human means by "I can see half of this".
 */

/** What one trick is worth, on average, in a deck whose cards carry points. */
function pointsPerTrick(ctx) {
  const scoring = ctx.pack.scoring || {};
  if (!scoring.cardValues) return 0;
  let deck = 0;
  for (const card of ctx.pack.cardsById.values()) deck += cardValue(card, scoring);
  deck += num(scoring.tricks?.lastTrick, 0);
  const tricks = Math.max(1, Math.floor(ctx.pack.cardsById.size / Math.max(1, ctx.seats)));
  return deck / tricks;
}

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A partner's share of a contract, as a fraction of what this seat can see.
 *
 * MEASURED, and the reason it is not 1. At 1 the table opens on every hand and
 * two thirds of the contracts are set; at 0 nobody opens at all and the seat
 * that is stuck with the floor holds every contract in the match. Two thirds
 * sits where the bid is made about half the time, which is roughly what a real
 * auction settles at.
 */
const PARTNER_SHARE = 0.66;

/**
 * HOW MUCH OF `expectedTricks` TO BELIEVE, when it is being spent rather than
 * merely compared — and the honest part of this heuristic.
 *
 * `expectedTricks` counts the way a Spades player counts: the top card of a
 * suit takes a trick, the second usually does, length in trump turns small
 * cards into winners. It is measured, it works, and its scale is only ever
 * compared against ANOTHER bid in the same units, so a systematic bias in it
 * costs Spades nothing.
 *
 * A points bid spends it, and then the scale matters. It also over-counts on a
 * DOUBLED deck, for a reason the function cannot see: it prices a card by its
 * distance from the top of the ladder, and on a deck with two of everything a
 * rank step is eight cards rather than four — so "I hold an ace, that is a
 * trick" is wrong twice over when there are eight aces and somebody else has
 * one. Left at face value the four seats between them counted about twice the
 * twelve tricks that exist, bid 228 into a 250-point deck and were set on 98%
 * of hands.
 *
 * So it is damped, and the damping is MEASURED rather than reasoned: at 0.75
 * the table bids 170 and makes it 18% of the time; at 0.45 nobody opens at all
 * and three quarters of hands fall to the seat that is stuck with the floor. At
 * 0.55 the winning bid averages 129 against a side that scores about 132, the
 * contract is made 72% of the time, and somebody volunteers for it on four
 * hands in five — which is what an auction is supposed to look like.
 *
 * The right fix one day is a trick count that reads the deck's own copy count
 * instead of a constant here. That is a change to a function Spades depends on
 * and was measured against, so it is not this issue's to make.
 */
const TRICK_CONFIDENCE = 0.55;

function expectedPoints(ctx, seat, trump, w) {
  const meld = ctx.rules.melds
    ? detectDeclaredMelds(ctx, ctx.cardIdsIn(ctx.zoneAddr('hand', seat)), trump).points
    : 0;
  const mine = meld + expectedTricks(ctx, seat, trump) * pointsPerTrick(ctx) * w.TRICK_CONFIDENCE;
  return mine * (1 + w.PARTNER_SHARE);
}

/** How far a points bid may sit above the count before the bot will not say it. */
const POINTS_OVER_COST = 1.6;
const POINTS_UNDER_COST = 1;

function scorePointsBid(ctx, move, w) {
  const seat = move.actor;
  const bid = bidValueOf(move);
  const step = bidIncrementOf(ctx);
  const worth = expectedPoints(ctx, seat, bidTrumpOf(move), w);

  // A PASS IS PRICED AGAINST THE CHEAPEST BID THAT IS STILL AVAILABLE, not
  // against zero. Passing is right exactly when the hand cannot afford the
  // floor, and saying so in the same units as every other candidate is what
  // stops the pass being either free (bid nothing, ever) or unaffordable (bid
  // the maximum on a bare hand).
  if (bid === 0) {
    const levels = bidLevels(ctx, seat).filter((n) => n > 0);
    if (!levels.length) return 0;
    // Worth what declining the cheapest contract is worth: nothing when the
    // hand could have made it, and the shortfall when it could not.
    return Math.max(0, levels[0] - worth) * w.POINTS_UNDER_COST / step - 0.5;
  }
  const gap = (bid - worth) / step;
  return -(gap > 0 ? gap * w.POINTS_OVER_COST : -gap * w.POINTS_UNDER_COST);
}

function scoreBid(ctx, move, w) {
  const seat = move.actor;
  const bid = bidValueOf(move);
  if (bid === null) return -Infinity;
  if (bidUnitOf(ctx) === 'points') return scorePointsBid(ctx, move, w);

  if (bid === 0) {
    // A NIL IS A GATE, NOT A CANDIDATE. Priced on the same scale as the gaps
    // below it, a nil that is merely nearly-safe scores a small negative and
    // beats an ordinary bid that is half a trick out — which is how the first
    // cut of this came to bid nil on three hands in ten and lose a hundred on
    // most of them. So the two sides of the bar are separated: a hand that can
    // duck is worth more than any bid, and one that cannot is worth less.
    const margin = w.NIL_RISK_BAR - nilRisk(ctx, seat);
    const worth = margin >= 0 ? w.NIL_WORTH * (1 + margin) : -w.NIL_WORTH * (1 - margin);
    // A BLIND nil is the same judgement at twice the stakes, which is why it is
    // only ever offered to a side that needs the swing (`mayBidBlind`).
    return bidIsBlindMove(move) ? worth * 2 : worth;
  }
  const gap = bid - expectedTricks(ctx, seat);
  return -(gap > 0 ? gap * w.BID_OVER_COST : -gap * w.BID_UNDER_COST);
}

function startBiddingPhase(ctx) {
  if (!ctx.rules.bidding) return false;
  for (let seat = 0; seat < ctx.seats; seat++) {
    ctx.setPlayerVar(seat, 'bid', undefined);
    ctx.setPlayerVar(seat, 'bidSight', undefined);
    ctx.setPlayerVar(seat, 'bidTrump', undefined);
    ctx.setPlayerVar(seat, 'bidForced', undefined);
    ctx.setPlayerVar(seat, 'meld', undefined);
  }
  // A CHOSEN TRUMP BELONGS TO ONE HAND. `startRound` carries bags across the
  // round boundary and would happily carry a stale suit with them, which would
  // let hand two be melded and played in hand one's trump before its own
  // auction had finished.
  if (ctx.rules.trump === 'chosen') ctx.setVar('trumpSuit', null);
  // The seat that bids first is the seat that leads first — one rule, read
  // twice, so a pack cannot end up bidding round the table in one direction
  // and playing in the other.
  ctx.setTurnSeat(determineFirstLeader(ctx));
  ctx.setPhase('bid');
  return true;
}

/**
 * THE AUCTION IS OVER — settle it, and name what it settled.
 *
 * Only a points auction has anything to settle: at a trick auction every bid
 * stands as made and there is nothing to decide. Here the highest bid becomes
 * one side's contract, and two things follow from it.
 *
 * SOMEBODY IS ALWAYS STUCK WITH IT — but that is enforced one step earlier, by
 * `bidLevels` refusing the last seat a pass into an empty auction, so that the
 * seat which ends up holding the contract has NAMED A SUIT like any other
 * bidder. Settling it here instead would have to invent a trump suit on a seat
 * that never chose one. The fallback below therefore only fires for a state
 * built by hand (a rule test), and it is kept as a belt: a hand with no
 * contract has no number to be scored against.
 *
 * AND THE WINNING BID NAMES TRUMP. `trump: 'chosen'` has been the resolution
 * rule since #105 with nothing to fill it in; this is what fills it in. The var
 * is public (`publicVars`) because a trump suit is the most public fact at a
 * trick table.
 */
function settleAuction(ctx) {
  if (bidUnitOf(ctx) !== 'points') return;
  let seat = contractSeatOf(ctx);
  if (seat === null) {
    seat = ctx.turn.seat;
    ctx.setPlayerVar(seat, 'bid', minBidOf(ctx));
    ctx.setPlayerVar(seat, 'bidForced', true);
  }
  if (ctx.rules.bidding?.namesTrump === true) {
    ctx.setVar('trumpSuit', ctx.playerVar(seat, 'bidTrump') ?? null);
  }
  ctx.emit('contractSet', {
    seat,
    bid: bidOf(ctx, seat),
    trump: ctx.var('trumpSuit') ?? null,
    forced: ctx.playerVar(seat, 'bidForced') === true,
  });
}

/* ------------------------------------------------------------------ *
 * What a CONTRACT is worth — the numbers a bidding game is scored by
 * ------------------------------------------------------------------ *
 *
 * A different currency from the core's evaluator. That one prices a hand in the
 * points the pack CHARGES; a side that has promised four tricks is playing for
 * a number the cards do not carry, and the only quantities that matter are how
 * many tricks it has, how many it said, and how many are left. These are the
 * exchange rates between those, in "one trick of the contract" units, and they
 * are read by `evaluateContract` below.
 */
/** A trick the side still owed and has now taken. The unit. */
const CONTRACT_TRICK_WORTH = 1;

/**
 * A trick taken PAST the contract — a bag. Worth a point now and a tenth of a
 * hundred-point penalty later, which nets out at about minus nine: within a
 * rounding error of the ten a contract trick is worth, and that is why this is
 * a whole unit rather than the third of one it started as.
 *
 * MEASURED, and the measurement is the reason to trust the arithmetic over the
 * instinct. A third of a trick makes a bot that ducks a bag only when nothing
 * else is going on, and against opponents who take fewer tricks than they
 * should — an `easy` side, or a bad partner — the winning side is HANDED tricks
 * it never bid: four or five bags a hand, a hundred-point penalty every second
 * hand, and a score that oscillates in a band instead of climbing. A
 * medium-against-easy table sat between 370 and 450 for a dozen hands at 0.35
 * and reached 527 by the tenth hand at 1. A table where everybody plays the
 * same way barely notices (13.6 rounds a match against 13.4): there, nobody is
 * handing anybody tricks.
 */
const BAG_COST = 1;

/** A trick the side promised and can no longer reach: the contract is set. */
const SHORTFALL_COST = 2;

/**
 * A NIL, kept or broken, against a trick of the contract.
 *
 * Ten to one is the manifest's own arithmetic (100 against 10 a trick) and it
 * is deliberately NOT used here: an evaluator that priced a nil at ten tricks
 * would spend the whole hand ducking with a seat that has already been set, and
 * the partner's contract is still live. Four is enough to make ducking the
 * first thing a nil bidder does and small enough that a broken nil does not
 * flatten every later decision.
 */
const NIL_WORTH = 4;

/**
 * ONE RUNG OF THE LADDER, STILL IN HAND, against one trick of the contract.
 *
 * The term it scales is `evaluateContract`'s held-card term, and it is small
 * on purpose: a full hand of thirteen cards is some eighty rungs, so anything
 * near a whole trick would drown every other term in the evaluator and make a
 * bot that never plays a card it does not have to. What it has to be big enough
 * to do is separate two cards that take the SAME trick — the ace and the ten
 * that both beat a king — which is twelve rungs at the widest, so a fortieth of
 * a trick puts a third of a trick between them and leaves winning the trick
 * comfortably worth more than the card it costs. See the term's own comment.
 */
const CONTRACT_HELD_WORTH = 0.025;

/** How much the best opposing side's contract discounts your own. */
const CONTRACT_RIVAL_SHARE = 0.5;

/**
 * How much a point still in hand is worth against a point already taken, and
 * how much of a point one rung of the ladder is worth. Both measured — see the
 * `held` term inside `evaluatePointsContract`.
 */
const HELD_PRIZE_WORTH = 1;
const HELD_RANK_WORTH = 4;

/**
 * This phase's share of `template.weights`, merged onto the bag by the core.
 *
 * THE AUCTION'S NUMBERS AND THE POINTS EVALUATOR'S JOINED THE BAG IN #206, and
 * before that they were nine literals `tools/tune.mjs` had no way to reach —
 * so the trick-taking half of Pinochle's and Team Spades' strategy was
 * untunable and, worse, invisible to tests/weights.test.js, which only ever
 * checks what is IN the bag.
 *
 * WHAT IS STILL DELIBERATELY OUT: the shapes inside `nilRisk` and
 * `expectedTricks` — "a trump within three of the top wins whatever is led",
 * "four or more of a suit makes the second card a winner". Those are not
 * opinions about how much something is worth, they are a model of how a trick
 * is taken, and a tuner that moved them would be rewriting the count rather
 * than the policy that spends it. The evaluators and the bid scorers are the
 * policy, and the policy is here.
 */
export const AUCTION_WEIGHTS = {
  CONTRACT_TRICK_WORTH, BAG_COST, SHORTFALL_COST, NIL_WORTH, CONTRACT_HELD_WORTH,
  CONTRACT_RIVAL_SHARE,
  // The auction (#206): what a nil demands of a hand, and what the two
  // directions of missing the count are worth against each other.
  NIL_RISK_BAR, BID_OVER_COST, BID_UNDER_COST, POINTS_OVER_COST, POINTS_UNDER_COST,
  TRICK_CONFIDENCE, PARTNER_SHARE,
  // The points evaluator's held-card term (#206).
  HELD_PRIZE_WORTH, HELD_RANK_WORTH,
};

/**
 * HOW THE CONTRACT IS GOING when the contract is a NUMBER OF POINTS.
 *
 * `evaluateContract` below is in tricks, because that is what a Spades side
 * promised. A Pinochle side promised a score, and the two are not convertible:
 * a trick worth 34 points and a trick worth nothing count the same toward a
 * Spades contract and are the difference between making and missing this one.
 * So this reads the same thing the round scorer will
 * (src/engine/scoring.js, `meld-and-tricks`) — meld banked plus card values
 * taken — and prices the distance to the bid.
 *
 * ONE SIDE OWES SOMETHING AND THE OTHER DOES NOT, which is the asymmetry that
 * makes this different from a game where everybody has a contract. The side
 * holding the bid is playing against a number; the other side is simply
 * collecting, and its only interest in the bid is that setting the bidders
 * costs them the lot.
 *
 * WHAT IT DELIBERATELY DOES NOT READ: any hand but this seat's, and no card in
 * a won pile beyond its point TOTAL — which the felt has always shown
 * (`showsHeldValue`) because everybody watched those tricks being taken. The
 * bids and the melds are public by construction.
 */
function evaluatePointsContract(ctx, seat, w) {
  if (ctx.turn.phase === 'bid' || ctx.turn.phase === 'meld') return null;
  if (ctx.var('trickNumber') === 1 && ctx.countIn('trick') === 0) return null;

  const scoring = ctx.pack.scoring || {};
  const sides = sidesOf(ctx.pack, ctx.seats);
  const mine = sideOfSeat(ctx.pack, ctx.seats, seat);
  const contractSeat = contractSeatOf(ctx);
  const contractSide = contractSeat === null ? null : sideOfSeat(ctx.pack, ctx.seats, contractSeat);
  const contract = contractSeat === null ? 0 : (bidOf(ctx, contractSeat) ?? 0);

  const taking = trickLeaderSoFar(ctx);
  const takingSide = taking.seat === null ? null : sideOfSeat(ctx.pack, ctx.seats, taking.seat);
  const trickIds = ctx.cardIdsIn('trick');
  let onTable = 0;
  for (const id of trickIds) onTable += cardValue(ctx.cardById(id), scoring);

  const holds = holdsUp(ctx, taking);

  // What a side has already put away — the same sum src/engine/scoring.js
  // finally prices the round with (`bankedOf`), folded to the side.
  const bankedBy = (side) => sides[side].reduce((sum, s) => sum + bankedOf(ctx, s), 0);

  /**
   * WHAT IS STILL IN THIS SEAT'S OWN HAND, AND WHY THE EVALUATOR IS WRONG
   * WITHOUT IT.
   *
   * Every other term here is about points that have already moved. Within one
   * trick that makes the evaluator blind in a very specific way: whichever card
   * I win with, the trick lands in the same pile, and the only difference the
   * banked total sees is the value of the card I spent — so an ace scores
   * ELEVEN BETTER than a ten for taking the identical trick. The bot cashed its
   * aces at the first opportunity and had nothing left to win the counters at
   * the end of the hand with, which is the classic beginner's mistake and it
   * lost to the cheap heuristic because of it (`medium` took 41% of decisive
   * rounds against `easy` before this term existed).
   *
   * A card kept is a card that can still take a trick, and a high card can take
   * a trick full of somebody else's counters — so what is held is worth its
   * face value PLUS its rank, which is what makes "win with the cheapest card
   * that wins" fall out rather than being written as a rule.
   *
   * ONLY THIS SEAT'S HAND, never the partner's: `evaluateState` is asked of one
   * seat and may read nothing it could not see.
   */
  const ladder = rankLadderOf(ctx.pack);
  let held = 0;
  for (const id of ctx.cardIdsIn(ctx.zoneAddr('hand', seat))) {
    const card = ctx.cardById(id);
    held += cardValue(card, scoring) + rankOrder(card, ladder) * w.HELD_RANK_WORTH;
  }

  const valueOfSide = (side) => {
    let value = bankedBy(side);
    if (side === mine) value += held * w.HELD_PRIZE_WORTH;
    // The pile on the table, discounted by how well the winning card holds —
    // the term the no-trump evaluator's own comment calls "the whole signal".
    if (takingSide === side) value += onTable * holds;
    if (side !== contractSide) return value;
    // AND THE CLIFF. Everything a bidding side has banked is worth nothing at
    // all if it finishes short, so the distance to the contract is priced on
    // its own and not folded into the total: a side one trick from making it
    // should play very differently from one that has already made it.
    const owed = Math.max(0, contract - value);
    return owed > 0 ? value - owed * w.SHORTFALL_COST : value + contract * 0.5;
  };

  let rival = -Infinity;
  for (let side = 0; side < sides.length; side++) {
    if (side === mine) continue;
    rival = Math.max(rival, valueOfSide(side));
  }
  const value = valueOfSide(mine) - (Number.isFinite(rival) ? rival * w.CONTRACT_RIVAL_SHARE : 0);
  return prizeSign(ctx.pack) * value;
}

/**
 * HOW THE CONTRACT IS GOING FOR `seat`'S SIDE — the evaluator a bidding game
 * needs, and a different currency from the core's.
 *
 * The core's evaluator prices a position in the points the pack CHARGES for
 * cards. Here the cards are worth nothing at all: a side that said four takes
 * forty for its fourth trick and one point for its fifth, so what a position is
 * worth is the distance between what was promised and what has been taken, and
 * every term is in tricks.
 *
 * IT IS THE SIDE'S QUESTION, NOT THE SEAT'S, and that is the whole reason #104
 * came first. A seat that maximises its own trick count overtakes the partner
 * who had the trick won — the classic bad partner — and would do it while
 * looking like it was playing well.
 *
 * WHAT IT DELIBERATELY DOES NOT READ: anybody's hand but this seat's (only the
 * COUNTS, which are on the felt), and no card in a won pile — only how many
 * tricks each pile is, which everyone at the table watched being taken. The
 * bids are public by construction.
 */
function evaluateContract(ctx, seat, w) {
  // A BID IS NOT A POSITION. Every candidate bid leaves the identical table —
  // no card has moved — so the only thing separating them is the promise
  // itself, which is `scoreBid`'s judgement and not a position's. Returning
  // null hands the whole turn back to `botHeuristic` (CONTRACT.md).
  //
  // BOTH LINES ARE LOAD-BEARING, and the second one was found by measurement.
  // The LAST seat to bid leaves a position in the PLAY phase — the bidding
  // finished inside its move — so the phase check alone let the lookahead judge
  // it, and what it judged was the contract the bid had just created. Nothing
  // has been taken yet, so promising nothing scored best every single time: the
  // seat that spoke last bid nil on three hands in ten, whatever it held.
  // Nothing has been PLAYED is the honest test, and it is true exactly once a
  // hand.
  if (ctx.turn.phase === 'bid') return null;
  if (ctx.var('trickNumber') === 1 && ctx.countIn('trick') === 0) return null;

  const sides = sidesOf(ctx.pack, ctx.seats);
  const mine = sideOfSeat(ctx.pack, ctx.seats, seat);
  const trickIds = ctx.cardIdsIn('trick');
  const taking = trickLeaderSoFar(ctx);
  const holds = holdsUp(ctx, taking);
  const takingSide = taking.seat === null ? null : sideOfSeat(ctx.pack, ctx.seats, taking.seat);

  /**
   * WHO HELD THE TRICK ONE CARD AGO, and why an evaluator that does not ask is
   * a bad partner however side-aware the rest of it is.
   *
   * The hold term below is what makes a bot want the trick, and it was reading
   * the WHOLE of it every time — so a seat that overtook the partner who
   * already held it was paid for the trick a second time, and paid MORE,
   * because a higher winning card raises `holdsUp`. Taking the trick off your
   * own partner scored better than ducking under them, which is #161's bug
   * stated in the evaluator rather than in the heuristic.
   *
   * It is one card back, not the move that was played: a position evaluator is
   * not told what produced it, and the trick zone being in play order is what
   * makes "one card ago" a fact about the position rather than about the move.
   */
  const before = trickIds.length > 1
    ? trickLeaderSoFar(ctx, trickIds.slice(0, -1))
    : { seat: null, rank: -1 };
  const beforeSide = before.seat === null ? null : sideOfSeat(ctx.pack, ctx.seats, before.seat);
  const beforeHolds = holdsUp(ctx, before);

  // How many tricks are left to be taken by anybody: every trick costs the
  // table one card per seat, so the cards still out say it exactly.
  let outstanding = trickIds.length;
  for (let s = 0; s < ctx.seats; s++) outstanding += ctx.countIn(ctx.zoneAddr('hand', s));
  const remaining = Math.floor(outstanding / ctx.seats);

  /**
   * WHAT IS STILL IN THIS SEAT'S OWN HAND, in the only currency a trick
   * contract has: tricks it can still take.
   *
   * `evaluatePointsContract` grew the same term first and its comment says why
   * (an evaluator blind to the card it spent cashes its aces on trick one and
   * has nothing left to win the end of the hand with). Here the cards carry no
   * points at all, so what a held card is worth is its RANK and nothing else —
   * an ace is a trick you have not taken yet, a two is not. That is what makes
   * "win with the cheapest card that wins" and "do not overtake your partner"
   * fall out of the arithmetic instead of being written twice.
   *
   * ONLY THIS SEAT'S HAND, never the partner's: `evaluateState` is asked of one
   * seat and may read nothing it could not see.
   */
  const ladder = rankLadderOf(ctx.pack);
  let held = 0;
  for (const id of ctx.cardIdsIn(ctx.zoneAddr('hand', seat))) {
    held += rankOrder(ctx.cardById(id), ladder);
  }

  const valueOfSide = (side) => {
    const members = sides[side];
    let contract = 0;
    let tricks = 0;
    let value = 0;
    for (const s of members) {
      const bid = bidOf(ctx, s);
      tricks += tricksOf(ctx, s);
      if (bid !== null && bid > 0) contract += bid;
    }

    // A NIL IS ITS OWN PROMISE, kept or broken by the seat that made it and by
    // nobody else — which is why it is scored per seat inside a side total.
    for (const s of members) {
      if (bidOf(ctx, s) !== 0) continue;
      const worth = bidIsBlind(ctx, s) ? w.NIL_WORTH * 2 : w.NIL_WORTH;
      const clean = tricksOf(ctx, s) === 0;
      value += clean ? worth : -worth;
      // The trick on the table is how a live nil dies. This is the term that
      // makes a nil bidder duck rather than follow high.
      if (clean && taking.seat === s) value -= worth * holds;
    }

    value += Math.min(tricks, contract) * w.CONTRACT_TRICK_WORTH;
    value -= Math.max(0, tricks - contract) * w.BAG_COST;

    // What it still owes, against what is left to take. At `owed === remaining`
    // the side must win every remaining trick, and past that the contract is
    // already set — the term keeps rising, so a bot cannot be indifferent to a
    // hand it has lost.
    const owed = Math.max(0, contract - tricks);
    if (owed > 0) value -= w.SHORTFALL_COST * (owed / Math.max(1, remaining));

    if (takingSide === side) {
      // A SIDE THAT ALREADY HELD THE TRICK IS CREDITED WITH THE HOLD IT HAD,
      // not with the better one its own partner's overtake just bought it. That
      // one substitution is #161's bug in the evaluator: the trick is the
      // side's either way, so the ace that took it off the partner's king
      // bought the side nothing — and the old term paid for it anyway, because
      // a higher winning card raises `holdsUp`, and rated overtaking your own
      // partner above ducking under them. Taking a trick off an OPPONENT is
      // untouched: their hold was not this side's, so there is nothing to
      // carry over and the whole of it is new.
      const hold = beforeSide === side ? beforeHolds : holds;
      value += (owed > 0 ? w.CONTRACT_TRICK_WORTH : -w.BAG_COST) * hold;
    }
    if (side === mine) value += held * w.CONTRACT_HELD_WORTH;
    return value;
  };

  let rival = -Infinity;
  for (let side = 0; side < sides.length; side++) {
    if (side === mine) continue;
    rival = Math.max(rival, valueOfSide(side));
  }
  const value = valueOfSide(mine) - (Number.isFinite(rival) ? rival * w.CONTRACT_RIVAL_SHARE : 0);
  return prizeSign(ctx.pack) * value;
}

/**
 * A seat that promised NOTHING and has not broken it yet.
 *
 * `bidOf` is null at a pack that takes no bid, so this is false all game at
 * Hearts and every clause built on it is dead code there rather than a branch
 * Hearts has to be reasoned about. Read by the core's card scorer, which is the
 * one place the play phase has to know what the auction said.
 */
export function isLiveNil(ctx, seat) {
  return seat !== null && bidOf(ctx, seat) === 0 && tricksOf(ctx, seat) === 0;
}

export const auctionPhase = {
  id: 'bid',
  moveType: 'bid',
  botVerbs: { bid: 'bid' },
  /** What is trump is a fact of the table, and the auction is what names it. */
  publicVars: ['trumpSuit'],
  // THE BID (#219): not a commit of cards at all — one button and one dialog.
  interactionMode: 'bid',
  /**
   * NOTHING IS LED UNTIL EVERY SEAT HAS SPOKEN. The turn seat during the bid is
   * a real seat with a real hand, so without this the first bidder could simply
   * lead instead of bidding and the phase would be advisory.
   */
  playBlocked: 'The bidding is not finished.',
  weights: AUCTION_WEIGHTS,

  start: startBiddingPhase,

  validate(ctx, move) {
    if (!ctx.rules.bidding) return ctx.fail('no-bidding', 'This game has no bidding phase.');
    if (ctx.turn.phase !== 'bid') return ctx.fail('phase', 'Not in the bidding phase.');
    if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn to bid.");
    if (bidOf(ctx, move.actor) !== null) return ctx.fail('already-bid', 'You have already bid.');
    const bid = bidValueOf(move);
    const min = minBidOf(ctx);
    const max = maxBidOf(ctx, move.actor);
    if (bidUnitOf(ctx) === 'points') {
      // The LADDER is the range at a points auction, not an interval: a bid
      // has to be a rung, and it has to be above whatever has been said.
      if (bid === null || !bidLevels(ctx, move.actor).includes(bid)) {
        const standing = highestBidSoFar(ctx);
        return ctx.fail('bid-range', standing
          ? `Pass, or bid more than ${standing}, in steps of ${bidIncrementOf(ctx)}.`
          : `Pass, or bid from ${min} to ${max} in steps of ${bidIncrementOf(ctx)}.`);
      }
      if (bid > 0 && ctx.rules.bidding.namesTrump === true) {
        const suit = bidTrumpOf(move);
        if (!suit || !perilOf(ctx).suits.has(suit)) {
          return ctx.fail('bid-trump', 'A bid has to name the suit it would play in.');
        }
      }
      return ctx.ok();
    }
    if (bid === null || bid < min || bid > max) {
      return ctx.fail('bid-range', `Bid between ${min} and ${max} tricks.`);
    }
    if (bidIsBlindMove(move)) {
      if (bid !== 0) return ctx.fail('blind-nil', 'A blind bid is a bid of nothing.');
      if (!mayBidBlind(ctx, move.actor)) {
        return ctx.fail('blind-nil', 'Only a side far enough behind may bid blind.');
      }
    }
    return ctx.ok();
  },

  apply(ctx, move, advance) {
    const seat = move.actor;
    const bid = bidValueOf(move);
    const blind = bidIsBlindMove(move);
    const trump = bidTrumpOf(move);
    // Asked BEFORE the bid lands, because it is a question about the auction as
    // this seat found it: was passing even on the table?
    const stuck = isStuckWithTheBid(ctx, seat);
    if (stuck) ctx.setPlayerVar(seat, 'bidForced', true);
    ctx.setPlayerVar(seat, 'bid', bid);
    if (blind) ctx.setPlayerVar(seat, 'bidSight', 'blind');
    // A suit said out loud, in a public per-seat var beside the number — the
    // seats bidding after you are entitled to hear which suit you fancied as much
    // as they are entitled to hear how much you said.
    if (trump) ctx.setPlayerVar(seat, 'bidTrump', trump);
    ctx.emit('bidMade', { seat, bid, blind, trump });

    if (!everySeatHasBid(ctx)) {
      ctx.setTurnSeat(ctx.nextSeat(seat));
      return;
    }
    settleAuction(ctx);
    advance();
  },

  // THE BID SPACE IS SMALL AND IT IS ENUMERATED WHOLE — fourteen moves at a
  // thirteen-card table, against the 286 the pass shortlist exists to avoid.
  // Nothing has to be guessed at or narrowed: every number from nothing to
  // the whole hand is a bid somebody makes, and a bot that only saw a
  // shortlist could never bid the one the hand actually wants.
  enumerate(ctx, seat) {
    return seat === ctx.turn.seat ? bidCandidates(ctx, seat) : [];
  },

  /**
   * WHAT THE COMMIT BUTTON SAYS (#219). `'Bid'` was the button's label written
   * into src/ui/interaction.js and `{type: 'bid'}` was built there out of a
   * literal, while the status bar in src/ui/table.js branched on
   * `turn.phase === 'bid'`, this template's own word for its own phase, seven
   * lines below the comment saying a phase name may not appear in that file.
   *
   * WHOSE TURN IT IS HAS TO BE SAID BY THE TABLE. `seatLabel` arrives from the
   * status bar and nowhere else (it is the roster's answer, and "You" for the
   * seat reading it — src/templates/CONTRACT.md's *Naming a seat in a sentence*),
   * so the waiting line says nothing at all rather than a name of its own when a
   * caller that has no roster — `buildUiModel`, which only wants the button —
   * asks. The platform's generic "Waiting…" stands in, and no surface shows it.
   */
  commitPrompt(ctx, seat, { seatLabel } = {}) {
    return {
      action: 'Bid',
      moveType: 'bid',
      staging: 'Your bid',
      waiting: seatLabel ? `${seatLabel(ctx.turn.seat)} is bidding…` : undefined,
    };
  },

  /**
   * The question a bid still owes: HOW MANY.
   *
   * The felt's affordance for a bid is one button and this Ask — no new dialog,
   * no per-genre panel. That is the whole reason the platform's chooser takes
   * `kind: 'value'` with the template's own options: a bid is "choose a number
   * from this list", which is the same shape as a wild choosing its colour, and
   * the loop in src/ui/table.js renders it without knowing what a trick is.
   *
   * A bare `{type: 'bid'}` is what the action button makes; the enumerated
   * moves arrive with their answer already on them and are not asked again.
   */
  pendingChoice(ctx, move) {
    if (move?.type !== 'bid' || ctx.turn.phase !== 'bid') return null;
    const seat = move.actor;
    const points = bidUnitOf(ctx) === 'points';
    const bid = bidValueOf(move);

    // TWO QUESTIONS, ASKED IN TURN — the platform's chooser loops until this
    // answers null (src/templates/CONTRACT.md), so a bid that names a suit as
    // well as a number is two ordinary Asks and not a bespoke dialog. The
    // second only exists once the first has been answered with a real bid: a
    // pass is not a contract, so there is no suit for it to be played in.
    if (points && bid !== null) {
      if (bid === 0 || ctx.rules.bidding.namesTrump !== true || bidTrumpOf(move)) return null;
      return {
        attr: 'trump',
        // WHAT IS BEING NAMED IS NOT WHAT IS BEING DRAWN, and conflating the
        // two is what left this step as four word buttons. `attr` is the
        // template's word for the question; `art` is the platform's word for
        // the picture (src/ui/cardStyles/chooser.js knows 'suit', 'color' and
        // 'rank' and nothing else), and 'trump' is not one of them — so the
        // chooser asked for a tile called "trump", got null, and fell back to
        // text in the one pack whose whole vocabulary is pips.
        art: 'suit',
        // A COMPLETE SENTENCE, because this one is not "choose a <noun>".
        // `prompt` completes "Choose a …" and read as "Choose a suit to play it
        // in" — which names no referent for "it" and describes choosing a suit
        // to play SOMETHING in rather than naming trump for the whole hand.
        // The bid is in it because that is the fact the answer turns on: you
        // are picking the suit you have to make 140 in.
        question: `You won the auction at ${bid}. Name the trump suit.`,
        // The bar behind the dialog said "Your bid" throughout, which is the
        // previous step. Its own sentence, so the felt agrees with the modal.
        status: 'Naming trump',
        kind: 'value',
        options: [...perilOf(ctx).suits].map((suit) => ({ value: suit, label: suitLabel(suit) })),
        apply: (m, value) => ({ ...m, choice: { ...(m.choice || {}), trump: value } }),
      };
    }
    if (bid !== null) return null;

    const options = points
      ? bidLevels(ctx, seat).map((n) => ({ value: n, label: n === 0 ? 'Pass' : String(n) }))
      : [];
    if (!points) {
      for (let n = minBidOf(ctx); n <= maxBidOf(ctx, seat); n++) {
        options.push({ value: n, label: n === 0 ? 'Nil' : String(n) });
      }
      if (mayBidBlind(ctx, seat)) options.push({ value: 'blind', label: 'Blind nil' });
    }
    return {
      attr: 'bid',
      // Completes "Choose a …", so it is a noun phrase and not a sentence.
      prompt: points ? 'number of points to bid' : 'number of tricks to bid',
      kind: 'value',
      // WHAT THE TABLE HAS ALREADY SAID, brought into the dialog (#123, item
      // 33). A bid is made against the bids before it, and on a 375px screen
      // the seats carrying them are a carousel: the playtest found the
      // partner's plate clipped mid-word and the third opponent entirely off
      // the screen, so a Spades bid — where the contract is your number plus
      // your partner's — was made without being able to check either. On the
      // desktop the same information was two seat plates away behind the
      // dialog. The compact form is the one the issue asks for.
      //
      // Seats are NUMBERS here. The template does not know what anybody is
      // called or who is partnered with whom; the platform dresses these rows
      // from its roster, exactly as it dresses a `kind: 'seat'` option.
      context: [
        ...Array.from({ length: ctx.seats }, (unused, s) => ({ seat: s, value: bidBadge(ctx, s).text })),
        points
          // One contract, competed for: what a bid has to beat.
          ? { label: 'To beat', value: String(highestBidSoFar(ctx)) }
          // Four promises that all stand, added up two by two — the number the
          // hand is then played against, and the reason overtaking your own
          // partner is pointless.
          : { label: 'Your side', value: `${sideContract(ctx, seat) ?? 0} so far` },
      ],
      options,
      apply: (m, value) => (value === 'blind'
        ? { ...m, choice: { ...(m.choice || {}), bid: 0, sight: 'blind' } }
        : { ...m, choice: { ...(m.choice || {}), bid: value } }),
    };
  },

  // WHAT A SEAT PROMISED, AND WHAT IT HAS. A bid is public the moment it is
  // made and there is nowhere else on a minimized face to read it; the two
  // numbers apart rather than as "2/4" is what keeps each inside the couple
  // of characters a badge has (a made thirteen would be five).
  counters(ctx, seat) {
    if (!ctx.rules.bidding) return [];
    const counters = [];
    const pips = pipsBadge(ctx, seat);
    // A DASH THAT MEANS TWO OPPOSITE THINGS IS NOT A COUNTER (#148). At a
    // POINTS auction `bidBadge` prints `—` both for a seat that has not
    // spoken and for one that has passed, so three of Pinochle's four faces
    // wore the same mark for the whole hand and only one of them meant "this
    // seat is out of it". A pass has nothing left to report, so it keeps its
    // captioned, spoken badge on the open plate and gives the face back to
    // the meld — which is the number a Pinochle seat is actually read for.
    const passed = bidUnitOf(ctx) === 'points' && bidOf(ctx, seat) === 0;
    counters.push({
      ...bidBadge(ctx, seat),
      label: 'Bid',
      kind: 'bid',
      // AND ON THE HUMAN'S OWN STRIP (#219). The seat with no plate is the one
      // whose bid was nowhere on the felt (#123, item 28), and `mine` is how
      // this template says so — src/ui/table.js used to keep the list of kinds
      // that earn a chip there, which made two of these slugs platform
      // vocabulary. What you promised is the number the whole hand is played
      // against, so it is the first thing on that strip.
      mine: true,
      // Replaced on the face by the pip row, which says this number and the
      // trick count in one mark.
      ...(pips || passed ? { openOnly: true } : {}),
    });
    const tricks = tricksOf(ctx, seat);
    counters.push({
      text: String(tricks),
      aria: `${tricks} ${tricks === 1 ? 'trick' : 'tricks'} taken`,
      label: 'Tricks',
      kind: 'tricks',
      // The won pile is right there on an open seat, and its badge is this
      // number in as many words (`zoneReading`) — which it was NOT before
      // #123: the pile counted cards, so it climbed in fours beside a bid
      // counted in tricks and every comparison needed dividing by four.
      //
      // ...EXCEPT WHERE THE PIPS TAKE THE FACE. Then the digits are what the
      // OPEN plate has that the face does not, and they have to be on it: an
      // empty won pile no longer draws a chip at all (#148), so a seat that
      // has taken nothing would otherwise have nowhere the zero is written.
      ...(pips ? { openOnly: true } : { minimizedOnly: true }),
    });
    if (pips) counters.push(pips);

    // WHAT THE OVERTRICKS HAVE TURNED INTO. Bags accumulated correctly and
    // the word never appeared on the felt (#123, item 31): the only
    // explanation of them was two clicks behind the score chip, in the
    // how-to-play text. A SIDE's number, so it says the same thing on both
    // its seats, and null for a pack that does not bag.
    const bags = bagsOf(ctx, seat);
    if (bags !== null) {
      counters.push({
        text: String(bags),
        aria: `${bags} bag${bags === 1 ? '' : 's'}`,
        label: 'Bags',
        kind: 'bags',
        // On your own strip beside the bid, for the same reason: the bags are
        // what the overtricks have turned into, and a hundred of them arriving
        // as a penalty three hands later is the thing nobody could see coming.
        mine: true,
      });
    }
    return counters;
  },

  /**
   * THE CONTRACT, KEPT ON SCREEN — what was promised, by whom, and in what suit.
   *
   * Everything here was already in the state and nowhere on the felt (#125).
   * The auction ran with no visible high bid, so once two seats had both bid
   * their chips read the same gold and the leader could not be told from the
   * seat that had just been outbid. Then the suit was named and the table said
   * nothing at all about it — no text, no badge, no attribute — in a game whose
   * every play is governed by must-follow-and-beat and mandatory over-trump.
   *
   * WHILE THE AUCTION IS OPEN THESE ARE THE ONLY CHIPS, which used to be an
   * early return in the core and is now a fact about the other phases: the meld
   * has not been declared yet (`startBiddingPhase` clears it), so it has
   * nothing to add of its own, and no contract is settled until the last seat
   * has spoken.
   */
  chips(ctx) {
    const holder = contractSeatOf(ctx);
    if (ctx.turn.phase === 'bid') {
      const standing = highestBidSoFar(ctx);
      return [{
        key: 'bid',
        label: 'High bid',
        value: standing > 0 ? String(standing) : '—',
        // Whose it is, said with the mark that seat wears everywhere else. A
        // number with nobody's name on it is the half of this that was missing.
        seat: standing > 0 ? holder : null,
        // What they fancied playing it in — public the moment it is said
        // (`bidTrump`), and the thing the seats bidding after them are reading.
        suit: holder === null ? null : (ctx.playerVar(holder, 'bidTrump') ?? null),
        aria: standing > 0 ? `High bid ${standing}` : 'No bid yet',
      }];
    }

    const chips = [];
    const trump = trumpSuitOf(ctx);
    if (trump) {
      chips.push({
        key: 'trump',
        label: 'Trump',
        value: suitLabel(trump),
        suit: trump,
        aria: `${suitLabel(trump)} are trump`,
      });
    }
    if (holder !== null) {
      const bid = bidOf(ctx, holder) ?? 0;
      chips.push({
        key: 'contract', label: 'Contract', value: String(bid), seat: holder, aria: `Contract ${bid}`,
      });
    }
    return chips;
  },

  /**
   * WHAT THE ROUND SHEET SAYS ABOUT EACH SEAT — "Bid 4, took 5" (#219).
   *
   * A delta of `-30` is the arithmetic and this is the reason, and the reason was
   * nowhere on that sheet (#123, item 28) least of all for the human, whose own
   * bid was not shown anywhere at all. src/ui/table.js built the phrase itself,
   * out of the counters whose `kind` is `'bid'` and `'tricks'`: two of this
   * template's slugs and two of its words, in the file that is not supposed to
   * know a bid exists. The platform keeps what is genuinely its own — WHICH
   * position the phrase is true of (the round ending's fork, because the live
   * state has already wiped every bid) and which row it is drawn in.
   *
   * ONE ENTRY PER SEAT, and the same words the seat plates wear, because they
   * come from the same place: `bidBadge` is the one reading of a bid in this
   * template (a nil reads "nil" here too), and the trick count is the same
   * integer the plate's Tricks digit is. Null for a pack that does not bid —
   * Hearts has nothing to promise, so its sheet keeps the plain rows it had.
   */
  roundLines(ctx) {
    if (!ctx.rules.bidding) return null;
    return Array.from({ length: ctx.seats }, (_, seat) => (
      `Bid ${bidBadge(ctx, seat).text}, took ${tricksOf(ctx, seat)}`
    ));
  },

  /**
   * WHAT THE AUCTION SAYS OUT LOUD.
   *
   * It used to be silent on the felt: the log read "Pip bid. Bruno bid. Sable
   * bid." — the bot verbs and nothing else — so on any hand the player did not
   * win, the trump suit was never announced at all and had to be inferred from
   * watching what beat what.
   */
  describe(ev, { seatLabel, viewerSeat } = {}) {
    if (ev.type !== 'contractSet') return null;
    if (!ev.trump) return null;
    // `seatLabel` already answers "You" for the reader's own seat, so the
    // `seat === viewerSeat ? 'You' : …` that used to be here was the platform's
    // rule written out a second time. `viewerSeat` is still read below, for the
    // clauses that change wholesale in the second person ("are stuck with").
    const name = (seat) => seatLabel?.(seat) ?? `Seat ${seat}`;
    const suit = suitLabel(ev.trump);
    const won = ev.seat === viewerSeat;
    // "Stuck with it" is a different sentence from "won it", and the auction
    // already knows which happened (`forced`).
    const how = ev.forced ? 'is stuck with the bid at' : 'won the auction at';
    const mine = ev.forced ? 'are stuck with the bid at' : 'won the auction at';
    return {
      text: `${name(ev.seat)} ${won ? mine : how} ${ev.bid} — ${suit} are trump.`,
      tone: won ? 'good' : 'neutral',
    };
  },

  /**
   * A BID IS THE ONE MOVE WITH NO CARD IN IT, and the one the lookahead
   * cannot help with: every bid leaves a position where nothing has been
   * played, so `evaluate` declines the whole phase and this is the entire
   * judgement.
   */
  score(ctx, move, w) {
    return scoreBid(ctx, move, w);
  },

  /**
   * TWO GENRES UNDER ONE TEMPLATE, and they are not scored in the same
   * currency. A pack that bids is playing for a number the cards do not carry;
   * `undefined` — not null — is how this says the pack does not bid at all, so
   * that an evaluator DECLINING a position it understands (a bid, a first lead)
   * stays distinguishable from a phase with no opinion.
   */
  evaluate(ctx, seat, w) {
    if (!ctx.rules.bidding) return undefined;
    return bidUnitOf(ctx) === 'points'
      ? evaluatePointsContract(ctx, seat, w)
      : evaluateContract(ctx, seat, w);
  },

  ruleLines(rules) {
    if (rules.bidding?.unit === 'points') {
      return ['Before the first card, each player in turn names a score their side will reach, or passes. '
        + 'Every bid has to beat the one before it, the highest bidder names the trump suit, and if everybody '
        + 'passes the last to speak is stuck with the smallest bid. Reach it and your side banks everything it '
        + 'made; fall short and you lose the whole bid instead.'];
    }
    if (rules.bidding) {
      return ['Before the first card, each player in turn says how many tricks they will take. '
        + 'Take what you said and your side scores it; fall short and it costs you the same. '
        + 'A bid of nothing — nil — pays a bonus for taking no trick at all, and costs the same for taking one.'];
    }
    return [];
  },
};
