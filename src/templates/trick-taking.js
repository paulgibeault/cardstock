// Trick-taking template (design doc §13.1). Validates against Hearts.
// Follow suit, resolve the trick to a winner, that winner leads next. Lead/play
// constraints relax automatically when they'd leave the actor with zero legal cards
// (design doc §5).

import { rankLadderOf, rankOrder } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { cardValue, handValue } from '../engine/scoring.js';
import { sidesOf, sideOfSeat } from '../engine/sides.js';
import { detectDeclaredMelds } from './melds.js';

/* ------------------------------------------------------------------ *
 * What a position is worth (see `evaluateState` at the foot of this file)
 * ------------------------------------------------------------------ *
 *
 * A point already taken is the unit, and everything else is priced against it.
 * A point sitting in a trick you are provisionally winning is worth the same,
 * discounted by how likely you are to still be winning when it closes; a point
 * still in your own hand is worth rather less, because you will usually find
 * somewhere safe to put it.
 */
const TAKEN_WORTH = 1;
const AT_RISK_WORTH = 1;
const HELD_VALUE_WORTH = 0.35;

/** Per seat still to play behind you, while you are the one winning the trick. */
const LOOSE_POINT_RISK = 0.6;

/** A card whose only future is taking a charged one — see perilRankBySuit. */
const HELD_LIABILITY_WORTH = 1.2;

/** How much the cheapest opponent's total discounts your own. */
const RIVAL_SHARE = 0.5;

function isExactCardFirstLead(ctx) {
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
function trumpSuitOf(ctx) {
  const declared = ctx.rules.trump;
  if (!declared || declared === 'none') return null;
  // `chosen`: the ROUND names its trump, in a var the felt publishes. Nothing
  // sets it today — Spades' trump is fixed and Pinochle (#106) is where a bid
  // that names a suit lands — so this is the resolution rule written once
  // rather than the phase that would fill it in.
  if (declared === 'chosen') return ctx.var('trumpSuit') ?? null;
  return declared;
}

/** The trump suit the TRICK is resolved by — null unless the pack says so. */
function trickTrumpOf(ctx) {
  return ctx.rules.trickWinner === 'highest-trump-else-led' ? trumpSuitOf(ctx) : null;
}

/**
 * The height a trump is lifted to — one clear of the highest rank the deck
 * holds, so "any trump beats every card of the led suit" is one number line and
 * not a second comparison. See `trickLeaderSoFar`, which is where it was first
 * written and which this shares so the two can never disagree about how high a
 * trump plays.
 */
function trumpShelf(ctx, trump) {
  return trump === null ? 0 : perilOf(ctx).topRank + 1;
}

/**
 * A suit as a label — the deck's own word, capitalised, and nothing else.
 *
 * Deliberately not a table of the four French suits: the suits are whatever the
 * deck holds (`perilOf().suits`), and a template that mapped them to symbols
 * would be a template with a deck in it.
 */
function suitLabel(suit) {
  const name = String(suit ?? '');
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

/* ------------------------------------------------------------------ *
 * FOLLOW, AND BEAT IF YOU CAN — `followSuit: 'must-beat'`
 * ------------------------------------------------------------------ *
 *
 * Pinochle's rule, and a third value beside `must` and `free` rather than a
 * flag on either: it is the same question ("which of my cards may I play")
 * answered with one more clause, and splitting it into two booleans would let a
 * pack declare `free` and `mustBeat` together, which is not a rule.
 *
 * THREE OBLIGATIONS, IN ORDER, each one falling through to the next only when
 * the hand cannot meet it:
 *
 *   1. follow the suit that was led;
 *   2. among the cards that follow it, play one that BEATS whatever is
 *      currently winning, if you hold one;
 *   3. void in the led suit — trump, and if somebody has already trumped,
 *      over-trump if you hold one that does.
 *
 * All three read the same "how high does this card play" as trick resolution
 * (the trump shelf above), so a card that would win the trick is exactly the
 * card this says you must play. That equivalence is the point: the rule is
 * "you may not duck", and a second notion of higher would make it "you may not
 * duck, except sometimes".
 *
 * EVERY NARROWING RELAXES WHEN IT WOULD EMPTY THE POOL, which is the design
 * doc's §5 rule and the reason each step returns the wider set rather than
 * nothing. A hand of four low trumps facing a trumped trick has no over-trump
 * and must still play something.
 */
function mustBeatPool(ctx, hand, led) {
  const ladder = rankLadderOf(ctx.pack);
  const trump = trickTrumpOf(ctx);
  const shelf = trumpShelf(ctx, trump);
  const best = trickLeaderSoFar(ctx).rank;
  const heightOf = (id) => {
    const card = ctx.cardById(id);
    return rankOrder(card, ladder) + (trump !== null && card.suit === trump ? shelf : 0);
  };
  const beating = (pool) => {
    const over = pool.filter((id) => heightOf(id) > best);
    return over.length ? over : pool;
  };

  const following = hand.filter((id) => ctx.cardById(id).suit === led);
  if (following.length) return { pool: beating(following), rule: 'must-beat' };

  if (trump !== null) {
    const trumps = hand.filter((id) => ctx.cardById(id).suit === trump);
    // Void, holding trumps: you must ruff, and over-ruff if you can. The two
    // are one filter because a trick nobody has trumped yet is won by a card
    // below the shelf, so EVERY trump beats it.
    if (trumps.length) return { pool: beating(trumps), rule: 'must-trump' };
  }
  return { pool: hand.slice(), rule: null };
}

// Cards the actor may follow with, before lead/play constraints: the must-follow
// subset when they can follow suit, otherwise (void, or leading) the whole hand.
function baseLegalCards(ctx, seat, hand) {
  const isLead = ctx.countIn('trick') === 0;
  if (isLead) return hand.slice();
  const led = ctx.var('led');
  const follow = ctx.rules.followSuit;
  if (follow === 'must-beat' && led) return mustBeatPool(ctx, hand, led).pool;
  if (follow === 'must' && led) {
    const matching = hand.filter((id) => ctx.cardById(id).suit === led);
    if (matching.length) return matching;
  }
  return hand.slice();
}

// Relax selector: id -> rule ("untilBroken" / "notTrick1" / null-disabled) constraint
// against `pool`, returning the (possibly relaxed) pool with matches to `id` filtered
// unless doing so would empty the pool.
function applyConstraint(ctx, pool, selector, active) {
  if (!active) return pool;
  const filtered = pool.filter((cardId) => !selectorMatches(ctx.cardById(cardId), selector));
  return filtered.length ? filtered : pool;
}

function breakingSelectorAndVar(ctx) {
  const breaking = ctx.rules.breaking;
  if (!breaking) return null;
  const m = /^(.+)\s+played$/.exec(breaking.when);
  if (!m) return null;
  return { selector: m[1].trim(), varName: breaking.var };
}

// Returns the ids in `hand` that are legal to play right now, applying first-lead,
// lead-constraint and play-constraint relaxation. Shared by validateMove and
// enumerateLegalMoves so the two never disagree.
function legalCards(ctx, seat, hand) {
  const isLead = ctx.countIn('trick') === 0;
  let pool = baseLegalCards(ctx, seat, hand);

  if (isLead && ctx.var('trickNumber') === 1 && isExactCardFirstLead(ctx)) {
    const required = ctx.rules.firstLead;
    if (hand.includes(required)) pool = pool.filter((id) => id === required);
  }

  if (isLead) {
    for (const [selector, rule] of Object.entries(ctx.rules.leadConstraints || {})) {
      if (rule !== 'untilBroken') continue;
      const broken = breakingSelectorAndVar(ctx);
      const isBroken = broken ? ctx.var(broken.varName) : true;
      pool = applyConstraint(ctx, pool, selector, !isBroken);
    }
  }

  for (const [selector, rule] of Object.entries(ctx.rules.playConstraints || {})) {
    if (rule !== 'notTrick1') continue;
    pool = applyConstraint(ctx, pool, selector, ctx.var('trickNumber') === 1);
  }

  return pool;
}

function rejectPlayCard(ctx, seat, cardId, hand) {
  const isLead = ctx.countIn('trick') === 0;

  if (isLead && ctx.var('trickNumber') === 1 && isExactCardFirstLead(ctx)) {
    const required = ctx.rules.firstLead;
    if (hand.includes(required) && cardId !== required) {
      return ctx.fail('first-lead', `The first trick must be led with ${required}.`);
    }
  }

  if (!isLead) {
    const led = ctx.var('led');
    const follow = ctx.rules.followSuit;
    if ((follow === 'must' || follow === 'must-beat') && led) {
      const matching = hand.filter((id) => ctx.cardById(id).suit === led);
      if (matching.length && !matching.includes(cardId)) {
        return ctx.fail('follow-suit', `You must follow suit (${led}).`);
      }
    }
    // THE REFUSAL IS THE ENUMERATOR'S OWN ANSWER, asked again. `mustBeatPool`
    // is what `enumerateLegalMoves` filters with, so a card outside it is a
    // card the felt never offered and a joiner was never sent — and the two
    // cannot drift apart, because there is one function.
    if (follow === 'must-beat' && led) {
      const { pool, rule } = mustBeatPool(ctx, hand, led);
      if (!pool.includes(cardId)) {
        // Two different mistakes wear the same narrowing when you are void:
        // playing off-suit at all, and trumping too low. The card says which.
        const trumped = ctx.cardById(cardId).suit === trickTrumpOf(ctx);
        return rule === 'must-trump' && !trumped
          ? ctx.fail('must-trump', 'You are out of the suit that was led, so you must trump.')
          : ctx.fail('must-beat', 'You have to beat the card that is winning the trick if you can.');
      }
    }
  }

  const narrowed = baseLegalCards(ctx, seat, hand);

  if (isLead) {
    for (const [selector, rule] of Object.entries(ctx.rules.leadConstraints || {})) {
      if (rule !== 'untilBroken') continue;
      const broken = breakingSelectorAndVar(ctx);
      const isBroken = broken ? ctx.var(broken.varName) : true;
      if (isBroken) continue;
      if (!selectorMatches(ctx.cardById(cardId), selector)) continue;
      const alt = narrowed.filter((id) => !selectorMatches(ctx.cardById(id), selector));
      if (alt.length) return ctx.fail('lead-constraint', `${selector} may not be led until broken.`);
    }
  }

  for (const [selector, rule] of Object.entries(ctx.rules.playConstraints || {})) {
    if (rule !== 'notTrick1') continue;
    if (ctx.var('trickNumber') !== 1) continue;
    if (!selectorMatches(ctx.cardById(cardId), selector)) continue;
    const alt = narrowed.filter((id) => !selectorMatches(ctx.cardById(id), selector));
    if (alt.length) return ctx.fail('play-constraint', `${selector} cannot be played on the first trick.`);
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * The pass, as a handful of choices
 * ------------------------------------------------------------------ *
 *
 * A PASS USED TO BE ONE CANNED MOVE — "your N highest" — and that is a decision
 * taken away from every layer above this one. `enumerateLegalMoves` is what a
 * bot chooses from and what the host ships a joiner as the moves it may make, so
 * collapsing the pass space to a single entry meant no heuristic, no persona and
 * no future search could ever affect the most consequential three cards a Hearts
 * player commits all round. It always passed the same way, badly.
 *
 * The answer is not the full space — thirteen-choose-three is 286 moves per
 * seat, shipped over the wire, in the enumerator this repo already calls its
 * costliest. It is a SHORTLIST of the passes a human would recognise as
 * different ideas, each one derived from the pack rather than from Hearts:
 *
 *   highest      shed rank. The old behaviour, kept FIRST because the timeout
 *                takeover (src/ui/party.js) plays the head of this list for an
 *                absent human and should keep playing the unremarkable move.
 *   costliest    shed what the pack CHARGES for (scoring.cardValues).
 *   liabilities  shed the cards whose only job is to take a charged card — see
 *                perilRankBySuit.
 *   void x2      empty a short suit, so you can throw danger away later.
 *
 * Deduplicated, because on most hands two of these are the same three cards.
 */

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
const packPeril = new WeakMap();

function perilOf(ctx) {
  let cached = packPeril.get(ctx.pack);
  if (cached) return cached;
  const scoring = ctx.pack.scoring || {};
  const ladder = rankLadderOf(ctx.pack);
  const peril = new Map();
  // The deck's suits, gathered on the same sweep: the bidding heuristic asks
  // "which suits am I VOID in", and the answer is a fact about the deck that a
  // per-call sweep would recompute once per candidate bid.
  const suits = new Set();
  let topRank = 0;
  for (const card of ctx.pack.cardsById.values()) {
    const rank = rankOrder(card, ladder);
    if (rank > topRank) topRank = rank;
    if (card.suit !== undefined && card.suit !== null) suits.add(card.suit);
    if (!card.suit || cardValue(card, scoring) <= 0) continue;
    if (rank > (peril.get(card.suit) ?? -Infinity)) peril.set(card.suit, rank);
  }
  cached = { peril, topRank, suits };
  packPeril.set(ctx.pack, cached);
  return cached;
}

function perilRankBySuit(ctx) {
  return perilOf(ctx).peril;
}

function isLiability(ctx, card, peril, ladder = rankLadderOf(ctx.pack)) {
  const bar = peril.get(card.suit);
  return bar !== undefined && rankOrder(card, ladder) > bar;
}

/**
 * `ids` ordered most-worth-passing first by `cost`, ties left in hand order — a
 * stable sort, so a hand that cannot tell two cards apart passes the same two
 * every time and the no-persona chooser stays reproducible (src/engine/bot.js).
 */
function mostPassableFirst(ctx, ids, cost) {
  return ids.slice().sort((a, b) => cost(ctx.cardById(b)) - cost(ctx.cardById(a)));
}

function suitCounts(ctx, ids) {
  const counts = new Map();
  for (const id of ids) {
    const suit = ctx.cardById(id).suit;
    if (suit === undefined) continue;
    counts.set(suit, (counts.get(suit) || 0) + 1);
  }
  return counts;
}

function passCandidates(ctx, seat) {
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const count = ctx.rules.passing.count;
  if (hand.length <= count) return [hand.slice()];

  const scoring = ctx.pack.scoring || {};
  const peril = perilRankBySuit(ctx);
  const ladder = rankLadderOf(ctx.pack);
  const value = (card) => cardValue(card, scoring);

  const byRank = mostPassableFirst(ctx, hand, (card) => rankOrder(card, ladder));
  const byValue = mostPassableFirst(ctx, hand, (card) => value(card) * 100 + rankOrder(card, ladder));
  const byLiability = mostPassableFirst(ctx, hand,
    (card) => (isLiability(ctx, card, peril, ladder) ? 10000 : 0) + value(card) * 100 + rankOrder(card, ladder));

  const candidates = [byRank.slice(0, count), byValue.slice(0, count), byLiability.slice(0, count)];

  // A suit you can empty entirely is worth emptying: once void you may throw
  // the pack's expensive cards away on somebody else's trick. Only the two
  // shortest qualify — a third is either the same cards again or a suit long
  // enough that voiding it costs more than it saves.
  const counts = [...suitCounts(ctx, hand).entries()]
    .filter(([, n]) => n > 0 && n <= count)
    .sort((a, b) => a[1] - b[1]);
  for (const [suit] of counts.slice(0, 2)) {
    const going = hand.filter((id) => ctx.cardById(id).suit === suit);
    const filler = byLiability.filter((id) => ctx.cardById(id).suit !== suit);
    candidates.push([...going, ...filler].slice(0, count));
  }

  const seen = new Set();
  const out = [];
  for (const cards of candidates) {
    if (cards.length !== count) continue;
    const key = cards.slice().sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cards);
  }
  return out;
}

/**
 * WHAT A PASS IS WORTH, SCORED AS ONE MOVE.
 *
 * This is the half that had to change with the enumerator. `botHeuristic` used
 * to read `move.cards[0]` and nothing else, which was harmless while a pass was
 * a single canned move and is a bug the moment there are five: the bot would
 * have ranked whole passes by whichever card the sort happened to put first.
 *
 * RANK IS THE CURRENCY, and that is a measured result rather than a taste. The
 * obvious weighting — points first, so Hearts passes the queen of spades and
 * its high hearts — was tried and it LOSES, by more than a full penalty point
 * per round against seats still passing their three highest. The reason is
 * plain once seen: what costs you points in this genre is winning tricks, and
 * what wins tricks is rank. A pass that keeps an ace to shed a queen buys one
 * card's worth of safety and pays for it in tricks all round. So value,
 * liability and voiding are TIE-BREAKERS between passes of similar rank, sized
 * (against a four-seat Hearts round, averaged over every seat) to be worth a
 * few points of rank each and no more. They are worth roughly a tenth of a
 * penalty point per round — small, honestly, and the enumeration above is the
 * part of this that a search layer will actually get value out of.
 */
const PASS_VALUE_WORTH = 0.25;
const PASS_LIABILITY_WORTH = 3;
const PASS_VOID_WORTH = 1;

/* ------------------------------------------------------------------ *
 * What a CONTRACT is worth — the numbers a bidding game is scored by
 * ------------------------------------------------------------------ *
 *
 * A different currency from everything above it. The evaluator above prices a
 * hand in the points the pack CHARGES; a side that has promised four tricks is
 * playing for a number the cards do not carry, and the only quantities that
 * matter are how many tricks it has, how many it said, and how many are left.
 * These are the exchange rates between those, in "one trick of the contract"
 * units, and they are read by `evaluateContract` at the foot of this file.
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

/** How much the best opposing side's contract discounts your own. */
const CONTRACT_RIVAL_SHARE = 0.5;

/**
 * Every number the evaluator and the pass scorer are made of, gathered, so a
 * caller can hand the hooks a different set (src/templates/CONTRACT.md,
 * `weights`). The constants keep their comments; this is the shipped value of
 * each, frozen. It sits here because this is the first line after the last of
 * them is declared.
 */
export const WEIGHTS = Object.freeze({
  TAKEN_WORTH, AT_RISK_WORTH, HELD_VALUE_WORTH, LOOSE_POINT_RISK, HELD_LIABILITY_WORTH,
  RIVAL_SHARE, PASS_VALUE_WORTH, PASS_LIABILITY_WORTH, PASS_VOID_WORTH,
  CONTRACT_TRICK_WORTH, BAG_COST, SHORTFALL_COST, NIL_WORTH, CONTRACT_RIVAL_SHARE,
});

function scorePass(ctx, move, w = WEIGHTS) {
  const scoring = ctx.pack.scoring || {};
  const peril = perilRankBySuit(ctx);
  const ladder = rankLadderOf(ctx.pack);
  const going = new Set(move.cards);

  let score = 0;
  for (const id of move.cards) {
    const card = ctx.cardById(id);
    score += rankOrder(card, ladder);
    score += cardValue(card, scoring) * w.PASS_VALUE_WORTH;
    if (isLiability(ctx, card, peril, ladder)) score += w.PASS_LIABILITY_WORTH;
  }

  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
  const before = suitCounts(ctx, hand);
  const after = suitCounts(ctx, hand.filter((id) => !going.has(id)));
  for (const suit of before.keys()) if (!after.has(suit)) score += w.PASS_VOID_WORTH;

  return score;
}

/* ------------------------------------------------------------------ *
 * THE BID — a sequential phase before the first lead
 * ------------------------------------------------------------------ *
 *
 * The design doc promised this and called it the template's first planned
 * extension: "trump + bidding needs a `sequential` round phase" (§13.1). The
 * pass above is the template's other extra phase and it is the opposite shape —
 * everybody commits at once, nobody may see anybody else's choice — so almost
 * none of its machinery is reusable here and none of it is reused.
 *
 * SEQUENTIAL MEANS `turn.seat` ALREADY SAYS IT. One seat bids, the turn moves
 * on, the next seat bids knowing what was said before it; `actingSeats` is the
 * platform default (`[turn.seat]`) rather than the pass phase's every-seat
 * answer, and that difference IS the word "sequential" in the design doc.
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

/**
 * The seat holding the contract at a points auction — the highest bidder.
 *
 * DERIVED RATHER THAN STORED, for the reason src/engine/scoring.js gives about
 * the same question: every other seat passed with a 0, a bid has to beat what
 * came before it, so the maximum is unique and every seat watched it being
 * made. A stored copy is a second version of a public fact, free to disagree
 * with it after a replay.
 */
function contractSeatOf(ctx) {
  let seat = null;
  let best = 0;
  for (let s = 0; s < ctx.seats; s++) {
    const bid = bidOf(ctx, s) ?? 0;
    if (bid > best) {
      best = bid;
      seat = s;
    }
  }
  return seat;
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

/** How many tricks this seat has taken: its won pile, a trick at a time. */
function tricksTakenBy(ctx, seat) {
  return Math.floor(ctx.countIn(ctx.zoneAddr('won', seat)) / ctx.seats);
}

function sideMembers(ctx, seat) {
  return sidesOf(ctx.pack, ctx.seats)[sideOfSeat(ctx.pack, ctx.seats, seat)];
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
  levels.push(0);
  for (let bid = Math.max(min, standing + step); bid <= max; bid += step) levels.push(bid);
  return levels;
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

function expectedPoints(ctx, seat, trump) {
  const meld = ctx.rules.melds
    ? detectDeclaredMelds(ctx, ctx.cardIdsIn(ctx.zoneAddr('hand', seat)), trump).points
    : 0;
  const mine = meld + expectedTricks(ctx, seat, trump) * pointsPerTrick(ctx) * TRICK_CONFIDENCE;
  return mine * (1 + PARTNER_SHARE);
}

/** How far a points bid may sit above the count before the bot will not say it. */
const POINTS_OVER_COST = 1.6;
const POINTS_UNDER_COST = 1;

function scorePointsBid(ctx, move) {
  const seat = move.actor;
  const bid = bidValueOf(move);
  const step = bidIncrementOf(ctx);
  const worth = expectedPoints(ctx, seat, bidTrumpOf(move));

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
    return Math.max(0, levels[0] - worth) * POINTS_UNDER_COST / step - 0.5;
  }
  const gap = (bid - worth) / step;
  return -(gap > 0 ? gap * POINTS_OVER_COST : -gap * POINTS_UNDER_COST);
}

function scoreBid(ctx, move, w = WEIGHTS) {
  const seat = move.actor;
  const bid = bidValueOf(move);
  if (bid === null) return -Infinity;
  if (bidUnitOf(ctx) === 'points') return scorePointsBid(ctx, move);

  if (bid === 0) {
    // A NIL IS A GATE, NOT A CANDIDATE. Priced on the same scale as the gaps
    // below it, a nil that is merely nearly-safe scores a small negative and
    // beats an ordinary bid that is half a trick out — which is how the first
    // cut of this came to bid nil on three hands in ten and lose a hundred on
    // most of them. So the two sides of the bar are separated: a hand that can
    // duck is worth more than any bid, and one that cannot is worth less.
    const margin = NIL_RISK_BAR - nilRisk(ctx, seat);
    const worth = margin >= 0 ? w.NIL_WORTH * (1 + margin) : -w.NIL_WORTH * (1 - margin);
    // A BLIND nil is the same judgement at twice the stakes, which is why it is
    // only ever offered to a side that needs the swing (`mayBidBlind`).
    return bidIsBlindMove(move) ? worth * 2 : worth;
  }
  const gap = bid - expectedTricks(ctx, seat);
  return -(gap > 0 ? gap * BID_OVER_COST : -gap * BID_UNDER_COST);
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
 * SOMEBODY IS ALWAYS STUCK WITH IT. If every seat passed, the LAST seat to
 * speak takes the floor whether it wants it or not — the rule every Pinochle
 * table has, and the reason this cannot just leave the hand contract-less: a
 * hand with no contract has nothing to be scored against, and four seats that
 * all pass every hand is a match that never ends.
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

function applyBid(ctx, move) {
  const seat = move.actor;
  const bid = bidValueOf(move);
  const blind = bidIsBlindMove(move);
  const trump = bidTrumpOf(move);
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
  beginPlay(ctx);
}

/* ------------------------------------------------------------------ *
 * THE MELD — a phase that SCORES a selection and moves nothing
 * ------------------------------------------------------------------ *
 *
 * The third optional phase, and its shape is the pass's rather than the bid's:
 * every seat commits at once, nobody may read anybody else's choice until they
 * all have, and `turn.seat` does not move while it is open (`actingSeats`).
 *
 * WHAT MAKES IT A DIFFERENT PHASE FROM THE PASS, and the reason it is not one
 * with a flag on it: a pass MOVES the cards it commits, into somebody else's
 * hand, and it is exactly N of them. A meld moves nothing at all — the cards
 * you show the table are the cards you then have to win tricks with — and its
 * size is whatever the hand happens to hold, from nothing to the lot.
 *
 * WHAT IS PUBLISHED, AND WHAT IS NOT. `meld` is a per-seat var with no `__`
 * prefix, so every seat is told what every other seat melded and for how much;
 * that is what a player calls out at a table and the seats after them write
 * down. It carries NO CARD IDS (see `detectDeclaredMelds`) — the hand is still
 * `visibility: 'owner'` and stays that way, partner's included. The selection
 * on its way to being committed hides behind `__pendingMeld` for the same
 * reason the pass does: a commit anybody can read is not a commit.
 */
function pendingMeldOf(ctx, seat) {
  return ctx.playerVar(seat, '__pendingMeld');
}

function everySeatHasMelded(ctx) {
  for (let seat = 0; seat < ctx.seats; seat++) {
    if (pendingMeldOf(ctx, seat) === undefined) return false;
  }
  return true;
}

function startMeldPhase(ctx) {
  if (!Array.isArray(ctx.rules.melds) || !ctx.rules.melds.length) return false;
  for (let seat = 0; seat < ctx.seats; seat++) ctx.setPlayerVar(seat, '__pendingMeld', undefined);
  ctx.setPhase('meld');
  return true;
}

/**
 * The declaration this seat's hand is worth, whole — what a bot commits and
 * what the felt would suggest.
 *
 * Every card the detector could use, and no others: a declaration is scored
 * over what it contains, so there is nothing to gain from showing a card that
 * is in no meld and nothing to lose by showing every card that is in one.
 */
function bestMeldSelection(ctx, seat) {
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  return detectDeclaredMelds(ctx, hand, trumpSuitOf(ctx)).used;
}

function applyDeclareMeld(ctx, move) {
  ctx.setPlayerVar(move.actor, '__pendingMeld', (move.cards || []).slice());
  if (!everySeatHasMelded(ctx)) return;

  const trump = trumpSuitOf(ctx);
  for (let seat = 0; seat < ctx.seats; seat++) {
    const declared = detectDeclaredMelds(ctx, pendingMeldOf(ctx, seat), trump);
    ctx.setPlayerVar(seat, '__pendingMeld', undefined);
    ctx.setPlayerVar(seat, 'meld', { points: declared.points, melds: declared.melds });
    ctx.emit('meldDeclared', { seat, points: declared.points, melds: declared.melds });
  }
  startPlayPhase(ctx);
}

/**
 * WHICH WAY IS UP, from the one manifest field that says so.
 *
 * `scoring.gameOver.winner: 'highestScore'` means points are the PRIZE;
 * anything else means they are the penalty. The bot layer already reads this
 * for its match standing (src/engine/bot.js) and the tournament reads it again
 * independently — and an evaluator that ignored it is the failure that hook's
 * comment warns about: a pack that gets it wrong "gets a bot that plays to
 * lose, and nothing else in the codebase would notice".
 *
 * Both evaluators below are written in the direction the SCORE moves and
 * turned round here, once. Hearts is `lowestScore`, so its sign is −1 and its
 * evaluator is arithmetic for arithmetic the one that was measured (see
 * `evaluateState`).
 */
function prizeSign(ctx) {
  return ctx.pack.scoring?.gameOver?.winner === 'highestScore' ? 1 : -1;
}

/**
 * How well the trick on the table is likely to HOLD for whoever is winning it
 * — the discount the existing evaluator applies and this one wants too. A
 * trump on the shelf is above the ladder entirely, so this clamps at certain.
 */
function holdsUp(ctx, taking) {
  const { topRank } = perilOf(ctx);
  if (taking.seat === null) return 0;
  if (topRank <= 0) return 1;
  return Math.min(1, Math.max(0, taking.rank) / topRank);
}

/**
 * HOW THE CONTRACT IS GOING FOR `seat`'S SIDE — the evaluator a bidding game
 * needs, and a different currency from the one above it.
 *
 * The evaluator below this one prices a position in the points the pack CHARGES
 * for cards. Here the cards are worth nothing at all: a side that said four
 * takes forty for its fourth trick and one point for its fifth, so what a
 * position is worth is the distance between what was promised and what has been
 * taken, and every term is in tricks.
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
/**
 * HOW THE CONTRACT IS GOING when the contract is a NUMBER OF POINTS.
 *
 * The evaluator below this one is in tricks, because that is what a Spades side
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
function evaluatePointsContract(ctx, seat, w = WEIGHTS) {
  if (ctx.turn.phase === 'bid' || ctx.turn.phase === 'meld') return null;
  if (ctx.var('trickNumber') === 1 && ctx.countIn('trick') === 0) return null;

  const scoring = ctx.pack.scoring || {};
  const sides = sidesOf(ctx.pack, ctx.seats);
  const mine = sideOfSeat(ctx.pack, ctx.seats, seat);
  const contractSeat = contractSeatOf(ctx);
  const contractSide = contractSeat === null ? null : sideOfSeat(ctx.pack, ctx.seats, contractSeat);
  const contract = contractSeat === null ? 0 : (bidOf(ctx, contractSeat) ?? 0);

  const taking = trickLeaderSoFar(ctx);
  const holds = holdsUp(ctx, taking);
  const takingSide = taking.seat === null ? null : sideOfSeat(ctx.pack, ctx.seats, taking.seat);
  let onTable = 0;
  for (const id of ctx.cardIdsIn('trick')) onTable += cardValue(ctx.cardById(id), scoring);

  const bankedBy = (side) => sides[side].reduce((sum, s) => sum
    + (Number(ctx.playerVar(s, 'meld')?.points) || 0)
    + handValue(ctx.cardsIn(ctx.zoneAddr('won', s)), scoring), 0);

  const valueOfSide = (side) => {
    let value = bankedBy(side);
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
  return prizeSign(ctx) * value;
}

function evaluateContract(ctx, seat, w = WEIGHTS) {
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
  const taking = trickLeaderSoFar(ctx);
  const holds = holdsUp(ctx, taking);
  const takingSide = taking.seat === null ? null : sideOfSeat(ctx.pack, ctx.seats, taking.seat);

  // How many tricks are left to be taken by anybody: every trick costs the
  // table one card per seat, so the cards still out say it exactly.
  let outstanding = ctx.countIn('trick');
  for (let s = 0; s < ctx.seats; s++) outstanding += ctx.countIn(ctx.zoneAddr('hand', s));
  const remaining = Math.floor(outstanding / ctx.seats);

  const valueOfSide = (side) => {
    const members = sides[side];
    let contract = 0;
    let tricks = 0;
    let value = 0;
    for (const s of members) {
      const bid = bidOf(ctx, s);
      tricks += tricksTakenBy(ctx, s);
      if (bid !== null && bid > 0) contract += bid;
    }

    // A NIL IS ITS OWN PROMISE, kept or broken by the seat that made it and by
    // nobody else — which is why it is scored per seat inside a side total.
    for (const s of members) {
      if (bidOf(ctx, s) !== 0) continue;
      const worth = bidIsBlind(ctx, s) ? w.NIL_WORTH * 2 : w.NIL_WORTH;
      const clean = tricksTakenBy(ctx, s) === 0;
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
      value += (owed > 0 ? w.CONTRACT_TRICK_WORTH : -w.BAG_COST) * holds;
    }
    return value;
  };

  let rival = -Infinity;
  for (let side = 0; side < sides.length; side++) {
    if (side === mine) continue;
    rival = Math.max(rival, valueOfSide(side));
  }
  const value = valueOfSide(mine) - (Number.isFinite(rival) ? rival * w.CONTRACT_RIVAL_SHARE : 0);
  return prizeSign(ctx) * value;
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
 */
function trickLeaderSoFar(ctx) {
  const trickCards = ctx.cardIdsIn('trick');
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

function resolveTrick(ctx) {
  const trickCards = ctx.cardIdsIn('trick').slice();
  const winnerSeat = trickLeaderSoFar(ctx).seat;

  ctx.moveCards(trickCards, 'trick', ctx.zoneAddr('won', winnerSeat));

  // What the trick was WORTH is part of the event: the UI celebrates a clean
  // trick and winces at a pointed one without re-deriving pack scoring.
  const scoring = ctx.pack.scoring || {};
  const points = trickCards.reduce((sum, id) => sum + cardValue(ctx.cardById(id), scoring), 0);
  const number = ctx.var('trickNumber') ?? 1;
  ctx.emit('trickWon', { seat: winnerSeat, cards: trickCards.slice(), points, trickNumber: number });

  ctx.setVar('led', null);
  ctx.setVar('leader', winnerSeat);
  ctx.setVar('trickNumber', number + 1);
  ctx.setTurnSeat(winnerSeat);
}

function applyPlayCard(ctx, move) {
  const seat = move.actor;
  const cardId = move.cards[0];
  const card = ctx.cardById(cardId);
  const wasLead = ctx.countIn('trick') === 0;

  ctx.moveCards([cardId], ctx.zoneAddr('hand', seat), 'trick');

  if (wasLead) {
    ctx.setVar('led', card.suit);
    ctx.setVar('leader', seat);
  }

  const broken = breakingSelectorAndVar(ctx);
  if (broken && selectorMatches(card, broken.selector)) ctx.setVar(broken.varName, true);

  if (ctx.countIn('trick') === ctx.seats) resolveTrick(ctx);
  else ctx.setTurnSeat(ctx.nextSeat(seat));
}

function passTarget(ctx, seat, direction) {
  if (direction === 'left') return ctx.nextSeat(seat, 1);
  if (direction === 'right') return ctx.nextSeat(seat, -1);
  if (direction === 'across') return (seat + Math.floor(ctx.seats / 2)) % ctx.seats;
  return seat;
}

function passDirectionForRound(ctx) {
  const passing = ctx.rules.passing;
  if (!passing) return null;
  const idx = (ctx.state.roundNumber - 1) % passing.schedule.length;
  return passing.schedule[idx];
}

function startPlayPhase(ctx) {
  const leader = determineFirstLeader(ctx);
  ctx.setVar('leader', leader);
  ctx.setVar('led', null);
  ctx.setVar('trickNumber', 1);
  ctx.setTurnSeat(leader);
  ctx.setPhase('play');
}

/**
 * The phases a dealt hand goes through before a card is led, in order: the
 * pass, then the bid, then the meld, then play. Every middle phase is optional
 * and a pack may declare any of them or none — Hearts passes and does not bid,
 * Spades bids and does not meld, Pinochle bids and melds — so this and
 * `beginPlay` are the one place the order is written down.
 *
 * THE MELD COMES AFTER THE BID because it cannot be scored before it: a royal
 * marriage is a marriage in the trump suit, and until the auction settles there
 * is no trump suit for it to be in.
 */
function beginPlay(ctx) {
  if (!startMeldPhase(ctx)) startPlayPhase(ctx);
}

function beginHand(ctx) {
  if (!startBiddingPhase(ctx)) beginPlay(ctx);
}

function applyPassCards(ctx, move) {
  const seat = move.actor;
  ctx.setPlayerVar(seat, '__pendingPass', move.cards.slice());

  const allCommitted = Array.from({ length: ctx.seats }, (_, s) => ctx.playerVar(s, '__pendingPass')).every(
    (p) => p !== undefined,
  );
  if (!allCommitted) return;

  const direction = ctx.var('passDirection');
  const outgoing = Array.from({ length: ctx.seats }, (_, s) => ctx.playerVar(s, '__pendingPass'));
  for (let s = 0; s < ctx.seats; s++) {
    const target = passTarget(ctx, s, direction);
    if (target === s) continue;
    ctx.moveCards(outgoing[s], ctx.zoneAddr('hand', s), ctx.zoneAddr('hand', target));
  }
  for (let s = 0; s < ctx.seats; s++) ctx.setPlayerVar(s, '__pendingPass', undefined);

  ctx.emit('cardsPassed', { direction });
  beginHand(ctx);
}

function determineFirstLeader(ctx) {
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

/**
 * The whole deck, round-robin, starting at whoever this round opens on.
 *
 * THE DEALER ROTATES. It did not: this started at seat 0 every round, which
 * contradicts the design doc's `"dealer": "rotate"` and the two templates that
 * already rotate. Writing the zones directly rather than going through
 * ctx.moveCards is sanctioned for the initial deal only — see
 * src/templates/CONTRACT.md — because there is nothing for a zoneEmpty reaction
 * to respond to while the deck is being handed out.
 */
function dealAll(ctx) {
  const removeIds = new Set(ctx.rules.dealAdjust?.[String(ctx.seats)] || []);
  const ids = ctx.rng.shuffle([...ctx.pack.cardsById.keys()].filter((id) => !removeIds.has(id)));
  // `dealAll: true` — EVERY card goes out, and the pack is promising the deck
  // divides. Hearts keeps its hands equal by removing cards instead
  // (`dealAdjust`) and says nothing here, so a deck that does not divide leaves
  // its remainder in the box rather than dealing one seat a longer hand: at a
  // trick game an extra card is an extra trick, and the seat that got it plays
  // a different game from the rest of the table.
  const count = ctx.rules.dealAll === true ? ids.length : ids.length - (ids.length % ctx.seats);
  let seat = ctx.openingSeat();
  for (let i = 0; i < count; i++) {
    const id = ids[i];
    const addr = ctx.zoneAddr('hand', seat);
    ctx.zone(addr).cards.push(id);
    ctx.state.cardLocation.set(id, addr);
    seat = ctx.nextSeat(seat, 1);
  }
}

const trickTaking = {
  id: 'trick-taking',

  // Which shared vars a peer may see (src/engine/view.js). Who leads, what was
  // led, which way the pass goes and what is trump are all facts of the table.
  //
  // The BIDS are not here because they are not shared vars: a bid is a per-seat
  // var without the `__` prefix, which is the view layer's way of saying "this
  // one is everybody's" — and it has to be, because the seats bidding after you
  // are entitled to hear what you said.
  publicVars: (rules) => ['leader', 'led', 'trickNumber', 'passDirection', 'trumpSuit',
    ...(rules.broken?.varName ? [rules.broken.varName] : [])],

  defaultZones(rules, seats) {   // eslint-disable-line no-unused-vars
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'sorted', facing: 'up' },
      // `landing: 'play'`: where a played card goes when the move names no
      // destination. The table used to probe zone ids by name.
      { id: 'trick', per: 'shared', visibility: 'all', layout: 'spread', order: 'sequence', facing: 'up', label: 'Trick', landing: 'play' },
      // `showsHeldValue`: this pile's contents are worth points, so the felt
      // shows what it has cost so far. Hearts is why, but the flag is the fact
      // rather than the game.
      { id: 'won', per: 'player', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Won', showsHeldValue: true },
    ];
  },

  defaultReactions() {
    return [];
  },

  setup(ctx) {
    dealAll(ctx);
    const broken = breakingSelectorAndVar(ctx);
    if (broken) ctx.setVar(broken.varName, false);

    const direction = passDirectionForRound(ctx);
    if (direction && direction !== 'none') {
      ctx.setVar('passDirection', direction);
      ctx.setPhase('pass');
      return;
    }
    beginHand(ctx);
  },

  /**
   * BAGS OUTLIVE THE HAND, and they are the only thing here that does.
   *
   * The default round boundary wipes every `playerVars` entry before re-running
   * `setup` (src/engine/movePipeline.js, and the trap is written up in
   * CONTRACT.md) — which is right for a bid, right for a pass, and wrong for a
   * bag: the whole point of a bag is that it sits on the side's sheet until
   * ten of them have piled up and cost a hundred points, several hands later.
   *
   * Everything else is cleared exactly as the default would clear it, so a pack
   * that does not bid gets the round boundary it always had. Hearts' seats end
   * a round with no `bags` at all, so this carries nothing and its serialised
   * bytes are unchanged (tests/replayIdentity.test.js).
   */
  startRound(ctx) {
    const carried = Array.from({ length: ctx.seats }, (unused, seat) => ctx.playerVar(seat, 'bags'));
    ctx.state.playerVars = ctx.state.playerVars.map(() => ({}));
    for (let seat = 0; seat < ctx.seats; seat++) {
      if (carried[seat]) ctx.setPlayerVar(seat, 'bags', carried[seat]);
    }
    trickTaking.setup(ctx);
  },

  validateMove(ctx, move) {
    if (move.type === 'playCard') {
      // NOTHING IS LED UNTIL EVERY SEAT HAS SPOKEN. The turn seat during the
      // bid is a real seat with a real hand, so without this the first bidder
      // could simply lead instead of bidding and the phase would be advisory.
      if (ctx.turn.phase === 'bid') return ctx.fail('phase', 'The bidding is not finished.');
      if (ctx.turn.phase === 'meld') return ctx.fail('phase', 'The melds have not all been declared.');
      if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!hand.includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');

      const rejection = rejectPlayCard(ctx, move.actor, cardId, hand);
      if (rejection) return rejection;
      return ctx.ok();
    }

    if (move.type === 'bid') {
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
    }

    if (move.type === 'passCards') {
      const passing = ctx.rules.passing;
      if (!passing) return ctx.fail('no-passing', 'This game has no passing phase.');
      if (ctx.turn.phase !== 'pass') return ctx.fail('phase', 'Not in the passing phase.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      const cards = move.cards || [];
      if (cards.length !== passing.count) return ctx.fail('pass-count', `Pass exactly ${passing.count} cards.`);
      if (!cards.every((id) => hand.includes(id))) return ctx.fail('not-in-hand', 'That card is not in your hand.');
      if (ctx.playerVar(move.actor, '__pendingPass') !== undefined) {
        return ctx.fail('already-passed', 'You have already committed a pass.');
      }
      return ctx.ok();
    }

    if (move.type === 'declareMeld') {
      if (!Array.isArray(ctx.rules.melds) || !ctx.rules.melds.length) {
        return ctx.fail('no-melding', 'This game has no melding phase.');
      }
      if (ctx.turn.phase !== 'meld') return ctx.fail('phase', 'Not in the melding phase.');
      if (pendingMeldOf(ctx, move.actor) !== undefined) {
        return ctx.fail('already-melded', 'You have already declared your meld.');
      }
      const cards = move.cards || [];
      if (new Set(cards).size !== cards.length) {
        return ctx.fail('duplicate-card', 'A card can only be declared once.');
      }
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!cards.every((id) => hand.includes(id))) {
        return ctx.fail('not-in-hand', 'That card is not in your hand.');
      }
      // ANY SELECTION IS A LEGAL DECLARATION, including none of it. Showing a
      // card that is in no meld is worth nothing and costs nothing, and
      // under-declaring is a player's own business — there is no rule at a
      // table that makes you claim everything you hold.
      return ctx.ok();
    }

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    if (move.type === 'playCard') applyPlayCard(ctx, move);
    else if (move.type === 'passCards') applyPassCards(ctx, move);
    else if (move.type === 'bid') applyBid(ctx, move);
    else if (move.type === 'declareMeld') applyDeclareMeld(ctx, move);
  },

  enumerateLegalMoves(ctx, seat) {
    // THE BID SPACE IS SMALL AND IT IS ENUMERATED WHOLE — fourteen moves at a
    // thirteen-card table, against the 286 the pass shortlist exists to avoid.
    // Nothing has to be guessed at or narrowed: every number from nothing to
    // the whole hand is a bid somebody makes, and a bot that only saw a
    // shortlist could never bid the one the hand actually wants.
    if (ctx.turn.phase === 'bid') {
      return seat === ctx.turn.seat ? bidCandidates(ctx, seat) : [];
    }
    // ONE CANDIDATE, AND IT IS THE WHOLE ANSWER. Unlike a pass, a declaration
    // has no trade-off in it: every meld the hand holds is worth its points and
    // showing one costs nothing, so "declare everything that counts" is not a
    // shortlist of a space — it is the space, with the dominated members left
    // out. A human is not restricted to it; the felt builds the move from
    // whatever was staged (src/ui/interaction.js).
    if (ctx.turn.phase === 'meld') {
      if (pendingMeldOf(ctx, seat) !== undefined) return [];
      return [{ actor: seat, type: 'declareMeld', cards: bestMeldSelection(ctx, seat) }];
    }

    if (ctx.turn.phase === 'pass') {
      if (ctx.playerVar(seat, '__pendingPass') !== undefined) return [];
      // A SHORTLIST, NOT THE SPACE — see passCandidates for what is on it and
      // why the full thirteen-choose-three is not. A human is not restricted to
      // it: the pass is a commit-by-button phase and the table builds the move
      // from whatever N cards were tapped (src/ui/interaction.js), which
      // validateMove judges on its own terms.
      return passCandidates(ctx, seat).map((cards) => ({ actor: seat, type: 'passCards', cards }));
    }
    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    return legalCards(ctx, seat, hand).map((cardId) => ({ actor: seat, type: 'playCard', cards: [cardId] }));
  },

  // Simultaneous-commit phase (design doc §4): turn.seat doesn't advance until every
  // seat has passed, so any seat that hasn't committed yet may act — not just turn.seat.
  //
  // THE BID IS THE OTHER SHAPE and takes the default: one seat at a time, in
  // seat order, each hearing what was said before it. That is the difference
  // the design doc meant by a `sequential` phase, and it is expressed by NOT
  // appearing here.
  actingSeats(ctx) {
    if (ctx.turn.phase === 'meld') {
      const seats = [];
      for (let s = 0; s < ctx.seats; s++) if (pendingMeldOf(ctx, s) === undefined) seats.push(s);
      return seats;
    }
    if (ctx.turn.phase !== 'pass') return [ctx.turn.seat];
    const seats = [];
    for (let s = 0; s < ctx.seats; s++) {
      if (ctx.playerVar(s, '__pendingPass') === undefined) seats.push(s);
    }
    return seats;
  },

  isRoundOver(ctx) {
    return Array.from({ length: ctx.seats }, (_, s) => ctx.countIn(ctx.zoneAddr('hand', s))).every((n) => n === 0);
  },


  /* ---------------------------------------------------------------- *
   * What the platform asks this template about itself (src/templates/CONTRACT.md)
   * ---------------------------------------------------------------- */

  interactionMode(ctx) {
    if (ctx.turn.phase === 'bid') return 'bid';
    // THE MELD IS THE PASS'S GESTURE, and reusing the mode rather than adding a
    // sixth is the whole reason `commitPrompt` exists: pick cards out of the
    // fan, watch them stage, commit with the action button. Everything that
    // differs — what the button says, what move it makes, how many cards arm it
    // — is answered below rather than by a new string that six downstream
    // surfaces would each have to learn (src/ui/interaction.js).
    return ctx.turn.phase === 'pass' || ctx.turn.phase === 'meld' ? 'pass' : 'tap';
  },

  /**
   * WHAT THE COMMIT BUTTON SAYS, AND WHEN IT IS ARMED.
   *
   * The platform's default for the `pass` mode is Hearts' — "Pass left", armed
   * at exactly `passing.count` staged cards — and it is a default rather than
   * the rule because a second commit phase wants neither half of it. A meld
   * declaration is committed at ANY size, nothing at all included: a hand with
   * no meld in it still has to say so before the table can move on.
   *
   * Returning null takes the platform's default, which is what the pass phase
   * does and what every other template does by not implementing this at all.
   */
  commitPrompt(ctx, seat) {
    if (ctx.turn.phase !== 'meld') return null;
    return {
      label: 'Declare',
      moveType: 'declareMeld',
      min: 0,
      max: ctx.countIn(ctx.zoneAddr('hand', seat)),
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
        prompt: 'suit to play it in',
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
      options,
      apply: (m, value) => (value === 'blind'
        ? { ...m, choice: { ...(m.choice || {}), bid: 0, sight: 'blind' } }
        : { ...m, choice: { ...(m.choice || {}), bid: value } }),
    };
  },

  /**
   * The hand still counts down honestly here — thirteen cards to nothing, one
   * per trick — so the default primary counter stands. What minimizing hides
   * is the WON PILE, and in a game whose whole object is what you have been
   * made to take, that is the number the table is watched for.
   *
   * Only for a pack that actually scores its cards (`scoring.cardValues`).
   * Hearts does; a plain trick race does not, and there the pile is a count of
   * tricks the seat's own score chip already reports.
   */
  seatCounters(ctx, seat) {
    const hand = ctx.countIn(`hand.${seat}`);
    const counters = [{
      text: String(hand),
      aria: `${hand} ${hand === 1 ? 'card' : 'cards'}`,
      label: 'Cards',
      kind: 'hand',
    }];

    // WHAT A SEAT PROMISED, AND WHAT IT HAS. A bid is public the moment it is
    // made and there is nowhere else on a minimized face to read it; the two
    // numbers apart rather than as "2/4" is what keeps each inside the couple
    // of characters a badge has (a made thirteen would be five).
    if (ctx.rules.bidding) {
      const bid = bidOf(ctx, seat);
      const blind = bidIsBlind(ctx, seat);
      // A ZERO MEANS TWO OPPOSITE THINGS. At a trick auction it is a nil — the
      // boldest promise on the table. At a points auction it is a pass: this
      // seat said nothing at all. Printing "nil" for the second would tell the
      // felt the exact reverse of what happened.
      const points = bidUnitOf(ctx) === 'points';
      counters.push({
        text: bid === null ? '—' : bid === 0 ? (points ? '—' : blind ? 'BN' : 'nil') : String(bid),
        aria: bid === null ? 'has not bid yet'
          : bid === 0 ? (points ? 'passed' : `bid ${blind ? 'blind ' : ''}nil`)
            : points ? `bid ${bid} points` : `bid ${bid} ${bid === 1 ? 'trick' : 'tricks'}`,
        label: 'Bid',
        kind: 'bid',
      });
      const tricks = tricksTakenBy(ctx, seat);
      counters.push({
        text: String(tricks),
        aria: `${tricks} ${tricks === 1 ? 'trick' : 'tricks'} taken`,
        label: 'Tricks',
        kind: 'tricks',
        // The won pile is right there on an open seat, and it is a pile whose
        // height IS this number.
        minimizedOnly: true,
      });
    }

    // WHAT THIS SEAT DECLARED, ON EVERY SEAT'S FELT. A meld is called out at a
    // table and written down by everybody, and the cards it was made of stay in
    // a hand nobody else may look at — so the number and the names are the
    // whole of what there is to show, and they are shown for every seat rather
    // than only for the one looking.
    if (Array.isArray(ctx.rules.melds) && ctx.rules.melds.length) {
      const meld = ctx.playerVar(seat, 'meld');
      const named = meld?.melds?.map((m) => (m.suit ? `${m.label} in ${m.suit}` : m.label)).join(', ');
      counters.push({
        text: meld ? String(meld.points) : '—',
        aria: !meld ? 'has not declared a meld yet'
          : named ? `melded ${meld.points}: ${named}` : 'declared no meld',
        label: 'Meld',
        kind: 'meld',
      });
    }

    const scoring = ctx.pack.scoring || {};
    if (!scoring.cardValues) return counters;
    const points = ctx.cardsIn(ctx.zoneAddr('won', seat))
      .reduce((sum, card) => sum + cardValue(card, scoring), 0);
    if (points) {
      counters.push({
        text: `♥${points}`,
        aria: `${points} points taken`,
        label: 'Taken',
        kind: 'taken',
        // The won pile carries this number on its own chip when the seat is
        // open (`showsHeldValue`), so this is only earning its space once that
        // pile has been put away.
        minimizedOnly: true,
      });
    }
    return counters;
  },

  /**
   * The cards this seat has committed to a simultaneous phase but not yet
   * played — drawn as chosen, and NOT re-choosable.
   *
   * The private `__pendingPass` var is this template's bookkeeping; the table
   * was reading it directly in three places, double underscore and all.
   */
  committedSelection(ctx, seat) {
    return ctx.playerVar(seat, '__pendingPass') ?? pendingMeldOf(ctx, seat) ?? null;
  },

  ruleLines(rules) {
    const trump = rules.trickWinner === 'highest-trump-else-led' && rules.trump && rules.trump !== 'none'
      ? rules.trump : null;
    const out = [trump && trump !== 'chosen'
      ? `Everyone plays one card; the highest ${trump.replace(/s$/, '')} takes the trick, or the highest card of the suit that was led if no ${trump.replace(/s$/, '')} was played.`
      : 'Everyone plays one card; the highest card of the suit that was led takes the trick.'];
    if (rules.followSuit === 'must') out.push('Follow the suit that was led if you can.');
    if (rules.followSuit === 'must-beat') {
      out.push('Follow the suit that was led, and play higher than the card that is winning if you hold one. '
        + 'If you are out of that suit you must trump instead — and over-trump if somebody already has.');
    }
    if (rules.bidding?.unit === 'points') {
      out.push('Before the first card, each player in turn names a score their side will reach, or passes. '
        + 'Every bid has to beat the one before it, the highest bidder names the trump suit, and if everybody '
        + 'passes the last to speak is stuck with the smallest bid. Reach it and your side banks everything it '
        + 'made; fall short and you lose the whole bid instead.');
    } else if (rules.bidding) {
      out.push('Before the first card, each player in turn says how many tricks they will take. '
        + 'Take what you said and your side scores it; fall short and it costs you the same. '
        + 'A bid of nothing — nil — pays a bonus for taking no trick at all, and costs the same for taking one.');
    }
    if (Array.isArray(rules.melds) && rules.melds.length) {
      out.push('Then everybody declares their meld — the scoring combinations they were dealt. '
        + 'The points go on the sheet and the cards stay in your hand, so what you have just shown the '
        + 'table is what you still have to win tricks with.');
    }
    if (rules.passing) {
      out.push(`Before play, pass ${rules.passing.count ?? 3} cards to another player.`);
    }
    return out;
  },

  endingLines() {
    return [];
  },

  botVerbs: { passCards: 'passed', bid: 'bid', declareMeld: 'melded' },

  statLines(seat) {
    return [
      { label: 'Tricks won', value: seat.tricksWon, always: true },
      { label: 'Points taken', value: seat.pointsTaken, always: true },
    ];
  },

  botHeuristic(ctx, move, w = WEIGHTS) {
    // A pass is N cards or it is nothing: scoring it by `cards[0]` was correct
    // only while the enumerator offered exactly one pass, and would now rank
    // five whole passes by an accident of sort order. playCard is untouched.
    if (move.type === 'passCards') return scorePass(ctx, move, w);
    // A DECLARATION IS WORTH EXACTLY WHAT IT SCORES. No lookahead, no
    // trade-off: the cards do not move, so the position after it is the
    // position before it with a number added.
    if (move.type === 'declareMeld') {
      return detectDeclaredMelds(ctx, move.cards || [], trumpSuitOf(ctx)).points;
    }
    // A BID IS THE ONE MOVE WITH NO CARD IN IT, and the one the lookahead
    // cannot help with: every bid leaves a position where nothing has been
    // played, so `evaluateState` declines the whole phase (see below) and this
    // is the entire judgement.
    if (move.type === 'bid') return scoreBid(ctx, move, w);
    const card = ctx.cardById(move.cards[0]);
    // Play low, and shed anything the pack charges you for holding. The second
    // clause used to be `card.tags?.includes('penalty')` — Hearts' own tag name,
    // hardcoded into the template, and worth exactly −5 whether the card was a
    // two of hearts or the queen of spades. The pack's scoring config already
    // says what each card costs, so it says it here too.
    let score = -rankOrder(card, rankLadderOf(ctx.pack));
    score -= cardValue(card, ctx.pack.scoring || {});
    return score;
  },

  /**
   * HOW GOOD THIS POSITION IS FOR `seat` — the lookahead's scorer
   * (src/engine/bot.js), higher is better. In this genre that means "how little
   * this hand has cost me so far, and how little it is still going to".
   *
   * WHAT `botHeuristic` CANNOT SAY. "Play low, shed what the pack charges for"
   * is the right instinct and it has no idea what is on the table. The two
   * cases it gets backwards are the two that decide a Hearts hand: dumping the
   * queen of spades onto somebody else's trick is the best move in the game and
   * scores −13 there, while playing your king of hearts into a trick you are
   * already winning is a disaster that scores the same as playing it safely.
   * The difference between them is not the card, it is who is holding the pile
   * — so that is what this reads.
   *
   * WHAT IT DELIBERATELY DOES NOT READ. Nobody else's hand, and nobody else's
   * won pile card by card — only its point TOTAL, which the felt has always
   * shown (`showsHeldValue`, defaultZones above) because everyone at the table
   * watched those tricks being taken. The cards themselves are `visibility:
   * 'none'` and stay that way.
   *
   * WHAT IT IS WORTH, and this is the biggest measured gain of the three
   * templates that offer the hook. Six hundred rounds with one seat on the
   * evaluator and the other three on `botHeuristic`, rotating which is which:
   * the evaluated seat takes 4.3 points a round against their 7.5. Take the
   * at-risk term out — leave it reading only the banked totals and the hand —
   * and it takes 7.2 against their 6.4, i.e. WORSE than the heuristic it
   * replaced. The pile on the table is the whole signal; the rest is bookkeeping.
   */
  evaluateState(ctx, seat, w = WEIGHTS) {
    // TWO GENRES UNDER ONE TEMPLATE, and they are not scored in the same
    // currency. A pack that bids is playing for a number the cards do not
    // carry — see `evaluateContract`, which is the whole of that judgement.
    if (ctx.rules.bidding) {
      return bidUnitOf(ctx) === 'points'
        ? evaluatePointsContract(ctx, seat, w)
        : evaluateContract(ctx, seat, w);
    }

    const scoring = ctx.pack.scoring || {};

    // THE PASS IS A COMMIT, NOT A POSITION. Nothing has moved; the only thing
    // that changed is the cards this seat has promised away, so score exactly
    // those — with the pass scorer above, which is a Phase 1 measurement and
    // has nothing to gain from one ply of lookahead. (The commit that COMPLETES
    // the swap never arrives here: it turns up three cards out of other
    // people's hands, and the lookahead refuses to judge a position that
    // revealed cards this seat could not see.)
    const pending = ctx.playerVar(seat, '__pendingPass');
    if (pending) return scorePass(ctx, { actor: seat, cards: pending }, w);

    let score = -handValue(ctx.cardsIn(ctx.zoneAddr('won', seat)), scoring) * w.TAKEN_WORTH;

    // The pile on the table, and whether it is heading your way. A provisional
    // win is not a certainty — the rest of the seats have yet to play — so it
    // is discounted by how well the winning card is likely to hold up.
    const { peril } = perilOf(ctx);
    const taking = trickLeaderSoFar(ctx);
    if (taking.seat === seat) {
      const trickIds = ctx.cardIdsIn('trick');
      let inTrick = 0;
      for (const id of trickIds) inTrick += cardValue(ctx.cardById(id), scoring);
      const yetToPlay = Math.max(0, ctx.seats - trickIds.length);
      score -= (inTrick * w.AT_RISK_WORTH + yetToPlay * w.LOOSE_POINT_RISK) * holdsUp(ctx, taking);
    }

    // What is still in hand is a bill that has not come in yet.
    const ladder = rankLadderOf(ctx.pack);
    for (const id of ctx.cardIdsIn(ctx.zoneAddr('hand', seat))) {
      const card = ctx.cardById(id);
      score -= cardValue(card, scoring) * w.HELD_VALUE_WORTH;
      if (isLiability(ctx, card, peril, ladder)) score -= w.HELD_LIABILITY_WORTH;
    }

    // Cheaper than the cheapest opponent is the only kind of ahead there is
    // when everybody is trying to take nothing — and DEARER THAN THE DEAREST
    // is the same sentence at a pack where the points are the prize, which is
    // why the rival is picked by the same sign the whole answer is turned by.
    const prize = prizeSign(ctx);
    let rival = prize === 1 ? -Infinity : Infinity;
    for (let s = 0; s < ctx.seats; s++) {
      if (s === seat) continue;
      const theirs = handValue(ctx.cardsIn(ctx.zoneAddr('won', s)), scoring);
      rival = prize === 1 ? Math.max(rival, theirs) : Math.min(rival, theirs);
    }
    const total = Number.isFinite(rival) ? score + rival * w.RIVAL_SHARE : score;
    // Written in the direction the SCORE moves — every term above is a bill —
    // and turned round for a pack whose points are the prize. Hearts is
    // `lowestScore`, so this is the identity there and the measured behaviour
    // in the comment above is unchanged.
    return prize === 1 ? -total : total;
  },

  /** The strategy's numbers, for a caller that wants to play with different ones. */
  weights: WEIGHTS,
};

export default trickTaking;
