// Trick-taking template (design doc §13.1). Validates against Hearts.
// Follow suit, resolve the trick to a winner, that winner leads next. Lead/play
// constraints relax automatically when they'd leave the actor with zero legal cards
// (design doc §5).
//
/* ------------------------------------------------------------------ *
 * THE CORE, AND THREE PHASE MODULES (#224)
 * ------------------------------------------------------------------ *
 *
 * This file used to be three thousand lines because three games live under it —
 * Hearts, Team Spades, Pinochle — and every phase one of them has and the
 * others do not was interleaved through one object. `rules.bidding` was read at
 * sixteen places, `bidUnitOf` at eleven, `rules.melds` at five, `rules.passing`
 * at seven. None of that was a pack check (the contract holds: every branch is
 * keyed on a rule, never on a pack id), but the COUNT of them was the problem —
 * the next trick game was a three-thousand-line edit.
 *
 * The seam was already here. `beginHand` ran `startBiddingPhase → startMeldPhase
 * → startPlayPhase`, each one returning false when its rule was absent, so a
 * dealt hand already walked a list of optional phases in order. `PHASES` below is
 * that list, made explicit, and each phase is a module:
 *
 *   src/templates/trick-pass.js      the pass      (Hearts)
 *   src/templates/trick-auction.js   the auction   (Team Spades, Pinochle)
 *   src/templates/trick-meld.js      the meld      (Pinochle)
 *   src/templates/trick-shared.js    the deck and trick facts all of them read
 *
 * A PHASE MODULE, member by member — every one optional but `id`:
 *
 *   id             its `turn.phase` word, which is how the core finds the phase
 *                  a position is in.
 *   moveType       the move it owns. `validateMove`, `applyMove` and
 *                  `botHeuristic` dispatch on it.
 *   start(ctx)     put the table into this phase and return true, or return
 *                  false because this pack does not have it. The pipeline.
 *   validate       its move's own rules. Returns a ctx.ok()/ctx.fail().
 *   apply(ctx, move, advance)   `advance()` continues the pipeline PAST this
 *                  phase, and a phase that is not finished yet simply does not
 *                  call it.
 *   enumerate      the moves a seat may make while the phase is open.
 *   actingSeats    only for a simultaneous-commit phase; absent means the
 *                  platform default, `[turn.seat]`, which IS the design doc's
 *                  word "sequential".
 *   playBlocked    the refusal a `playCard` gets while this phase is open.
 *   interactionMode, commitPrompt, pendingChoice, committed   the felt's
 *                  affordances for it (src/ui/interaction.js).
 *   counters, chips, describe, roundLines, ruleLines, publicVars, botVerbs
 *                  what it contributes to the hooks the platform asks the
 *                  TEMPLATE, composed below in the order the felt reads them.
 *   score(ctx, move, w)        what its move is worth (`botHeuristic`).
 *   evaluate(ctx, seat, w)     what a POSITION is worth in its currency, or
 *                  `undefined` for a pack this phase has no opinion about —
 *                  which is not the same as the `null` an evaluator returns to
 *                  decline a position it understands.
 *   weights        its share of `template.weights`, merged onto the one frozen
 *                  bag below (tests/weights.test.js, tools/tune.mjs).
 *
 * WHAT STAYED HERE is what every trick game does: follow suit, resolve the
 * trick, sweep it to a winner, deal, and price a card played into a trick.
 */

import { rankLadderOf, rankOrder } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { cardValue, handValue } from '../engine/scoring.js';
import { prizeSign } from '../engine/contracts.js';
import { arePartners } from '../engine/sides.js';
import { handCounter, rivalExtreme } from '../engine/templateKit.js';
import {
  determineFirstLeader, holdsUp, isExactCardFirstLead, isLiability, perilOf,
  suitLabel, trickLeaderSoFar, trickTrumpOf, trumpShelf,
} from './trick-shared.js';
import { passPhase } from './trick-pass.js';
import { auctionPhase, isLiveNil } from './trick-auction.js';
import { meldPhase } from './trick-meld.js';

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

/** The core's own share of `template.weights` — see `WEIGHTS` below. */
const CORE_WEIGHTS = {
  TAKEN_WORTH, AT_RISK_WORTH, HELD_VALUE_WORTH, LOOSE_POINT_RISK, HELD_LIABILITY_WORTH,
  RIVAL_SHARE,
};

/**
 * A card named the short way — "7♠" — for a banner that must not wrap.
 *
 * Four characters rather than an import: `SUIT_GLYPH` also exists in
 * src/ui/cardStyles/shared.js and this file must not reach into src/ui. A
 * template is loaded by tools/simulate.mjs and tools/pack-test.mjs with no
 * document in the room, and the day somebody puts a DOM read behind that import
 * the whole headless toolchain goes with it. Null for a deck whose cards have no
 * suit, which is every shedding pack and no trick-taking one.
 */
const SUIT_GLYPH = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };

/**
 * The break outranks the trick it arrived inside.
 *
 * Above `TRICK_BANNER_PRIORITY` (src/ui/celebrations.js), which is the rung the
 * table gives a trick's own celebration — the two numbers have to be read
 * together and tests/actionEvents.test.js pins the comparison rather than
 * either value. See `describeEvent` for why the break is the bigger moment.
 */
const BROKEN_PRIORITY = 2;

/**
 * THE BANNER IS GONE IN TWO SECONDS AND THE RULE LASTS THE HAND.
 *
 * A sentence that has already scrolled away is no help to a player deciding, on
 * trick nine, whether they may lead a spade — so the break also leaves a mark
 * (#151). It goes on the contract strip rather than in a new widget because that
 * strip is already the felt's answer to "what is in force right now", it is
 * already styled for both themes, and a second row of chrome saying one word
 * would cost every trick pack the height.
 *
 * READ OFF THE VAR, not off the event, which is what makes it persistent for
 * free: the var is set by `placeCard`, cleared by `setup` at the next deal, and
 * public (`publicVars`), so the mark survives a reload, a rejoin and a replay
 * without anything remembering that a banner once fired. There is nothing here
 * to clear at the round boundary because there is nothing here that is state.
 *
 * Appended to whatever the auction already put on the strip: no pack today both
 * bids for trump and breaks a suit, but "one chip or the other" would be a rule
 * with no reason behind it.
 */
function brokenChips(ctx, chips) {
  const breaking = breakingSelectorAndVar(ctx);
  const suit = breaking ? brokenLeadSuit(ctx.rules) : null;
  if (suit && ctx.var(breaking.varName)) {
    chips.push({
      key: 'broken',
      label: suitLabel(suit),
      value: 'Broken',
      suit,
      aria: `${suitLabel(suit)} are broken — they may be led`,
    });
  }
  return chips.length ? chips : null;
}

function shortCardName(rank, suit) {
  const glyph = SUIT_GLYPH[suit];
  if (rank == null || !glyph) return null;
  return `${rank}${glyph}`;
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
 * (the trump shelf in src/templates/trick-shared.js), so a card that would win
 * the trick is exactly the card this says you must play. That equivalence is the
 * point: the rule is "you may not duck", and a second notion of higher would
 * make it "you may not duck, except sometimes".
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

/**
 * The breaking rule read off `rules` alone.
 *
 * Split out of `breakingSelectorAndVar` because `publicVars` is handed the
 * rules and never a ctx — and because it was reading `rules.broken?.varName`,
 * a shape no manifest has ever declared (the schema's key is `breaking.var`).
 * That silent `undefined` meant `spadesBroken` and `heartsBroken` were never in
 * the public set, so a joiner at a shared table held a view in which the suit
 * had never been broken: their own lead constraint stayed on for the whole hand
 * and the host's legal-move list disagreed with it. Pinned by
 * tests/actionEvents.test.js.
 */
function breakingRule(rules) {
  const breaking = rules?.breaking;
  if (!breaking) return null;
  const m = /^(.+)\s+played$/.exec(breaking.when);
  if (!m) return null;
  return { selector: m[1].trim(), varName: breaking.var };
}

function breakingSelectorAndVar(ctx) {
  return breakingRule(ctx.rules);
}

/**
 * WHICH SUIT THE BREAK SETS FREE — the lead constraint's suit, not the
 * breaking selector's.
 *
 * They are the same thing in Spades and deliberately different in Hearts, where
 * the queen of spades breaks hearts: `breaking.when` is `tag:penalty played` and
 * what it unlocks is `suit:hearts`. The felt is announcing what may now be LED,
 * so it asks the lead constraint.
 */
function brokenLeadSuit(rules) {
  for (const [selector, rule] of Object.entries(rules?.leadConstraints || {})) {
    if (rule !== 'untilBroken') continue;
    const m = /^suit:(.+)$/.exec(selector);
    if (m) return m[1];
  }
  return null;
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
 * WHAT A CARD IS WORTH, PLAYED INTO THIS TRICK (`botHeuristic`, #161)
 * ------------------------------------------------------------------ *
 *
 * The cheap ranking used to be `-rank - value` and nothing else: play low, shed
 * what the pack charges for. That is the right instinct for a seat sitting
 * alone in a game about avoiding points, and it is the wrong one twice over at
 * a partnership game about keeping a promise.
 *
 *   1. IT NEVER LOOKED AT THE TRICK, so it beat its own partner. `followSuit:
 *      'must'` offers a void hand every card it holds, and the lowest card in a
 *      Spades hand is very often a low spade — a ruff, on top of the partner
 *      who had the trick won. The engine's side plumbing was partner-aware from
 *      #104 and this, the function that actually chose the card, was not.
 *   2. IT IS ALSO THE `hard` BOT'S ROLLOUT POLICY (src/engine/bot.js plays
 *      every chair at `easy`), so the same blindness is in every sampled world
 *      the Monte Carlo layer grades — which is the unfixed core of #114.
 *
 * THREE CLASSES, AND WITHIN A CLASS THE OLD ORDER. This is a sort, not a
 * quantity: "any card that wins beats every card that does not" is not a number
 * anybody can hold an opinion about, so the class step is derived from the deck
 * (`trickBand` — one clear of the widest `-rank - value` can be) rather than
 * being a weight for tools/tune.mjs to take a fraction of. A fraction of it
 * would not be a different strategy, it would be a broken sort. What is left
 * inside a class is exactly the old ranking, which is what makes "the cheapest
 * card that wins" fall out rather than being written as a second rule.
 */

/**
 * One clear of the widest the `-rank - value` ranking below can be.
 *
 * The SPREAD, not the top: the cheapest card the deck can offer is
 * `-topRank - topValue` and the dearest is `-0 - lowValue`, so a negative card
 * value widens the ranking at the attractive end and the band has to cover it
 * (see `perilOf`). The lowest rank is taken as zero rather than swept for,
 * because `rankOrder` is an index into the pack's own ladder and starts there.
 */
function trickBand(ctx) {
  const { topRank, topValue, lowValue } = perilOf(ctx);
  return topRank + topValue - lowValue + 1;
}

function scorePlayCard(ctx, move) {
  const ladder = rankLadderOf(ctx.pack);
  const card = ctx.cardById(move.cards[0]);
  // Play low, and shed anything the pack charges you for holding. The second
  // clause used to be `card.tags?.includes('penalty')` — Hearts' own tag name,
  // hardcoded into the template, and worth exactly −5 whether the card was a
  // two of hearts or the queen of spades. The pack's scoring config already
  // says what each card costs, so it says it here too.
  const base = -rankOrder(card, ladder) - cardValue(card, ctx.pack.scoring || {});

  // LEADING IS A DIFFERENT QUESTION and this deliberately does not answer it.
  // There is no trick to read, and what to open with is a judgement about the
  // whole hand — the evaluator's job at `medium`, and out of scope here.
  if (ctx.countIn('trick') === 0) return base;

  const taking = trickLeaderSoFar(ctx);
  const actor = move.actor ?? ctx.turn.seat;
  // Nobody is winning an empty trick, and a seat plays into a trick once, so
  // the second clause is a guard rather than a case.
  if (taking.seat === null || taking.seat === actor) return base;

  const trump = trickTrumpOf(ctx);
  const shelf = trumpShelf(ctx, trump);
  const isTrump = trump !== null && card.suit === trump;
  // The SAME number line trick resolution uses (`trickLeaderSoFar`), so "this
  // card wins" here and "this card won" there can never disagree.
  const wins = rankOrder(card, ladder) + (isTrump ? shelf : 0) > taking.rank;
  // A ruff is a trump spent on a trick that was NOT led in trumps. Following a
  // trump lead with a trump is not a ruff and is not what the rules below mean.
  const ruffs = isTrump && ctx.var('led') !== trump;
  const band = trickBand(ctx);

  // A SEAT THAT PROMISED NOTHING MAY NOT TAKE THIS TRICK, whatever else is
  // true. Playing low was already most of a nil's game; what it missed is the
  // void hand, where the lowest card left is a trump and wins. `isLiveNil` is
  // the auction's own reading of its own promise (src/templates/trick-auction.js)
  // and is false all game at a pack that takes no bid.
  if (isLiveNil(ctx, actor)) return base - (wins ? band : 0);

  const partnerWinning = arePartners(ctx.pack, ctx.seats, actor, taking.seat);
  // A NIL PARTNER WINNING IS A NIL DYING. The trick is the partner's promise
  // being broken in front of you, so the duck rule below is suspended: take it
  // off them if the hand allows — but never with a trump. Ruffing a partner's
  // trick to save a nil spends a trump and a bag on a trick nobody wanted, and
  // the seats still to play may yet take it off them for nothing (#161).
  const savingNil = partnerWinning && isLiveNil(ctx, taking.seat);

  if (partnerWinning && !savingNil) {
    // THE TRICK IS ALREADY YOURS. The side is credited with it either way, so
    // every card that takes it back off your own partner spends a winner to buy
    // nothing — and a trump spends one that could have taken a trick the side
    // has no other way of reaching.
    return base - (wins ? band : 0) - (ruffs ? band : 0);
  }
  if (savingNil && ruffs) return base - band;

  // WINNING IS ONLY WORTH SOMETHING WHERE THE TRICKS ARE THE PRIZE, and that
  // is the one line that keeps this out of Hearts. A pack whose points are the
  // PENALTY (`scoring.gameOver.winner`, read once by `prizeSign`) wants the
  // exact opposite of "take it if you can", and the old ranking — lowest card,
  // cheapest card — is already the right answer there.
  if (prizeSign(ctx.pack) !== 1) return base;
  return base + (wins ? band : 0);
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

/**
 * THE CARD ON THE TABLE, and nothing that follows from it.
 *
 * Split out of applyPlayCard because the felt needs this half on its own: the
 * fourth card of a trick is played and the trick is swept in the same move, so
 * the only position in which four cards are on the table is the one BETWEEN
 * these two statements, and before this split there was no way to ask for it
 * (see `poseMove` below and issue #123). Everything here is the placement — the
 * card, what it led, what it broke — and everything the placement CAUSES stays
 * with the caller.
 */
function placeCard(ctx, move) {
  const seat = move.actor;
  const cardId = move.cards[0];
  const card = ctx.cardById(cardId);
  const wasLead = ctx.countIn('trick') === 0;

  ctx.moveCards([cardId], ctx.zoneAddr('hand', seat), 'trick');

  if (wasLead) {
    ctx.setVar('led', card.suit);
    ctx.setVar('leader', seat);
  }

  // THE MOMENT THE HAND CHANGES SHAPE, said out loud.
  //
  // This used to be the bare `setVar` and nothing else, which made breaking the
  // one rule in the genre that the felt never mentioned: a player discovered it
  // by noticing that leading a spade was suddenly allowed (#151). Emitted on the
  // false->true transition only — the tenth spade of a hand breaks nothing — so
  // the event is genuinely "once per hand" and the banner it wins is the banner
  // for the thing that actually happened.
  //
  // `cards`, not a bare `cardId`: the top-level `cards` array is the only shape
  // the view filter knows how to strip (src/engine/view.js's `eventsFor`), and
  // the card that breaks a suit is sometimes the fourth card of a trick — by the
  // time a joiner is handed the event, it has been swept into a `won` pile they
  // may not see. An id parked anywhere else would sail past the filter and out
  // to a seat that is not allowed to have it.
  //
  // `rank`/`suit` ride alongside it because `describeEvent` is handed the event
  // and a voice, never a card lookup, and "Spades are broken" without the card
  // that broke them is half a sentence. They are safe to send where the id is
  // not, and provably so rather than by judgement: the card was moved into
  // `trick` — `visibility: 'all'` — four lines above this, so at the instant
  // this fires every seat can already see it. The id is filtered anyway, on the
  // principle that the filter is the thing that should be deciding.
  const broken = breakingSelectorAndVar(ctx);
  if (broken && selectorMatches(card, broken.selector) && !ctx.var(broken.varName)) {
    ctx.setVar(broken.varName, true);
    ctx.emit('broken', {
      seat,
      cards: [cardId],
      // WHAT MAY NOW BE LED, which is not always the suit of the card that did
      // it: in Hearts the queen of spades breaks hearts. This is the fact the
      // sentence and the marker are both about, so it is the one on the event.
      suit: brokenLeadSuit(ctx.rules) || card.suit || null,
      // And what broke it, for the second half of the sentence. `describeEvent`
      // is handed the event and a voice, never a card lookup.
      card: { rank: card.rank ?? null, suit: card.suit ?? null },
      selector: broken.selector,
      varName: broken.varName,
    });
  }
}

function applyPlayCard(ctx, move) {
  placeCard(ctx, move);

  if (ctx.countIn('trick') === ctx.seats) resolveTrick(ctx);
  else ctx.setTurnSeat(ctx.nextSeat(move.actor));
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
 * The phases a dealt hand goes through before a card is led, IN ORDER. Every
 * one is optional and a pack may declare any of them or none — Hearts passes
 * and does not bid, Spades bids and does not meld, Pinochle bids and melds — so
 * this list and `beginPhases` are the one place the order is written down.
 *
 * THE MELD COMES AFTER THE BID because it cannot be scored before it: a royal
 * marriage is a marriage in the trump suit, and until the auction settles there
 * is no trump suit for it to be in.
 *
 * READ IN THIS ORDER BY EVERY HOOK the phases contribute to, which is why the
 * order is stated once here rather than per hook: the seat plates read bid then
 * meld, the contract strip reads the auction's chips then the meld's, and the
 * pipeline runs pass, bid, meld, play.
 */
const PHASES = [passPhase, auctionPhase, meldPhase];

/**
 * Put the table into the first phase from `from` onwards that this pack has,
 * and fall through to the play when it has none left.
 *
 * This is `beginHand`/`beginPlay` generalised (#224): a phase that finishes
 * inside a move continues the hand by asking for the phases PAST its own, which
 * is what the `advance` argument handed to `apply` does.
 */
function beginPhases(ctx, from = 0) {
  for (let i = from; i < PHASES.length; i++) {
    if (PHASES[i].start(ctx)) return;
  }
  startPlayPhase(ctx);
}

/** The phase a position is in, or null during the play. */
function currentPhase(ctx) {
  return PHASES.find((phase) => phase.id === ctx.turn.phase) || null;
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
    ctx.placeDeck(ctx.zoneAddr('hand', seat), [ids[i]]);
    seat = ctx.nextSeat(seat, 1);
  }
}

/**
 * EVERY NUMBER THE HOOKS ARE MADE OF, gathered, so a caller can hand them a
 * different set (src/templates/CONTRACT.md, `weights`). The constants keep
 * their comments; this is the shipped value of each, frozen.
 *
 * ONE BAG, ASSEMBLED FROM THE PHASES (#224). `tests/weights.test.js` probes
 * `template.weights` per template and `tools/tune.mjs` hands the hooks copies of
 * it, so a per-module bag the core did not merge would be a knob the tuner could
 * not reach — which is exactly the failure #206 fixed by gathering them in the
 * first place. The core's own six come first and each phase's follow in
 * `PHASES` order, which is the order they were declared in when this was one
 * file.
 *
 * WHAT IS STILL DELIBERATELY OUT is written up beside each phase's own bag: the
 * shapes inside `nilRisk` and `expectedTricks` are a model of how a trick is
 * taken rather than an opinion about what something is worth, and `trickBand` is
 * a sort step rather than a quantity.
 */
export const WEIGHTS = Object.freeze(
  Object.assign({ ...CORE_WEIGHTS }, ...PHASES.map((phase) => phase.weights || {})),
);

const trickTaking = {
  id: 'trick-taking',

  // Which shared vars a peer may see (src/engine/view.js). Who leads, what was
  // led, which way the pass goes and what is trump are all facts of the table —
  // the last two from the phases that own them (`publicVars` on each module).
  //
  // The BIDS are not here because they are not shared vars: a bid is a per-seat
  // var without the `__` prefix, which is the view layer's way of saying "this
  // one is everybody's" — and it has to be, because the seats bidding after you
  // are entitled to hear what you said.
  //
  // WHETHER THE SUIT IS BROKEN is one of those facts, and for a year it was not
  // here: this line read `rules.broken?.varName`, and no manifest has a
  // `rules.broken` — the declaration is `rules.breaking.var` (schema/), which is
  // what `breakingRule` reads. The optional chaining made the mistake silent.
  publicVars: (rules) => ['leader', 'led', 'trickNumber',
    ...PHASES.flatMap((phase) => phase.publicVars || []),
    ...(breakingRule(rules)?.varName ? [breakingRule(rules).varName] : [])],

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

    beginPhases(ctx);
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
   *
   * A BANKED ZERO NOW SURVIVES THE BOUNDARY, where the four lines this replaced
   * dropped it (`if (carried[seat])`). `roundScoreBidsAndBags` writes a literal
   * 0 to every non-banker seat, so those seats used to arrive at the next hand
   * with no `bags` key rather than with a zero one. Every reader coerces
   * (`Number(...) || 0`, `bagsOf`), so the count a seat plays and the badge it
   * draws are identical either way; the sheet simply says "none" instead of
   * saying nothing.
   */
  startRound(ctx) {
    ctx.resetPlayerVars({ keep: ['bags'] });
    trickTaking.setup(ctx);
  },

  validateMove(ctx, move) {
    if (move.type === 'playCard') {
      // NOTHING IS LED UNTIL THE PHASE THAT OWES AN ANSWER HAS ONE. The turn
      // seat during the bid is a real seat with a real hand, so without this the
      // first bidder could simply lead instead of bidding and the phase would be
      // advisory. Each phase supplies its own refusal (`playBlocked`).
      const open = currentPhase(ctx);
      if (open?.playBlocked) return ctx.fail('phase', open.playBlocked);
      if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!hand.includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');

      const rejection = rejectPlayCard(ctx, move.actor, cardId, hand);
      if (rejection) return rejection;
      return ctx.ok();
    }

    const phase = PHASES.find((p) => p.moveType === move.type);
    if (phase) return phase.validate(ctx, move);

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    if (move.type === 'playCard') {
      applyPlayCard(ctx, move);
      return;
    }
    const at = PHASES.findIndex((p) => p.moveType === move.type);
    // A phase that has finished continues the hand by asking for the phases
    // PAST its own — which is the whole of what `beginHand` and `beginPlay` were.
    if (at >= 0) PHASES[at].apply(ctx, move, () => beginPhases(ctx, at + 1));
  },

  /**
   * THE POSITION THIS MOVE PASSES THROUGH: four cards on the table, before the
   * hand that won them takes them away.
   *
   * A trick is completed and gathered inside one move — `applyPlayCard` plays
   * the fourth card and `resolveTrick` sweeps all four into the winner's pile
   * before `applyMove` returns — which is correct and is not negotiable: a
   * replay has to reach the same position at the same move. What was wrong was
   * that the FELT had nothing else to paint, so the deciding card, usually the
   * one that settles who wins, was never once on screen as a rendered card
   * (issue #123: the pile went 1, 2, 3, then 0).
   *
   * So the felt asks for the half-move. Called by src/ui/table.js on a
   * THROWAWAY fork of the pre-move state — never on the live state, never
   * logged, saved or published, exactly as `takeRoundFinal` uses
   * `applyMove` — and answering true means "this fork is a position worth
   * holding for a beat before the real one". Answering false leaves the fork to
   * be discarded, so a partially-applied move can never be mistaken for a
   * played one.
   *
   * ONLY A COMPLETED TRICK. A first, second or third card lands on a trick that
   * stays on the table anyway; there is nothing to hold, and posing every play
   * would put a beat between every card and the next.
   */
  poseMove(ctx, move) {
    if (move?.type !== 'playCard' || ctx.turn.phase !== 'play') return false;
    if (ctx.countIn('trick') + 1 !== ctx.seats) return false;
    placeCard(ctx, move);
    return true;
  },

  enumerateLegalMoves(ctx, seat) {
    const phase = currentPhase(ctx);
    if (phase) return phase.enumerate(ctx, seat);
    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    return legalCards(ctx, seat, hand).map((cardId) => ({ actor: seat, type: 'playCard', cards: [cardId] }));
  },

  // Simultaneous-commit phase (design doc §4): turn.seat doesn't advance until every
  // seat has committed, so any seat that hasn't yet may act — not just turn.seat.
  //
  // THE BID IS THE OTHER SHAPE and takes the default: one seat at a time, in
  // seat order, each hearing what was said before it. That is the difference
  // the design doc meant by a `sequential` phase, and it is expressed by that
  // module declaring no `actingSeats` at all.
  actingSeats(ctx) {
    const phase = currentPhase(ctx);
    if (phase?.actingSeats) return phase.actingSeats(ctx);
    return [ctx.turn.seat];
  },

  isRoundOver(ctx) {
    return Array.from({ length: ctx.seats }, (_, s) => ctx.countIn(ctx.zoneAddr('hand', s))).every((n) => n === 0);
  },


  /* ---------------------------------------------------------------- *
   * What the platform asks this template about itself (src/templates/CONTRACT.md)
   * ---------------------------------------------------------------- */

  interactionMode(ctx) {
    return currentPhase(ctx)?.interactionMode ?? 'tap';
  },

  pendingChoice(ctx, move) {
    for (const phase of PHASES) {
      const ask = phase.pendingChoice?.(ctx, move);
      if (ask) return ask;
    }
    return null;
  },

  /**
   * WHAT THE COMMIT BUTTON SAYS, AND WHEN IT IS ARMED — asked of the phase the
   * table is in, and null (the platform's default, which is what every other
   * template takes by not implementing this at all) during the play.
   */
  commitPrompt(ctx, seat, opts = {}) {
    return currentPhase(ctx)?.commitPrompt?.(ctx, seat, opts) ?? null;
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
    const counters = [handCounter(ctx, seat)];

    // WHAT EACH PHASE THIS PACK HAS SAYS ABOUT THE SEAT, in pipeline order: the
    // bid and its tricks, then the meld. A phase the pack does not declare
    // contributes nothing.
    for (const phase of PHASES) counters.push(...(phase.counters?.(ctx, seat) || []));

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

  /** What the round sheet says about each seat — the auction's phrase (#219). */
  roundLines(ctx) {
    for (const phase of PHASES) {
      const lines = phase.roundLines?.(ctx);
      if (lines) return lines;
    }
    return null;
  },

  /**
   * WHAT A WON PILE'S NUMBER MEANS, which is not how many cards are in it.
   *
   * Tricks are taken four cards at a time and bid for one at a time, so the
   * badge climbed 0, 4, 8, 12 beside a bid of 3 and every comparison a player
   * wanted to make needed dividing by four first (#123, item 29). The pile is
   * still a pile of cards — `describeZone` still says how many — but the number
   * ON it is the number the game is played in, and it carries its unit, because
   * a bare 3 under a stack of twelve cards is the same ambiguity the other way
   * round.
   *
   * Every trick-taking pack counts its tricks this way, so this is not gated on
   * bidding: Hearts' pile is three tricks deep for the same reason Spades' is.
   */
  zoneReading(ctx, { def, address }) {
    if (def.id !== 'won') return null;
    const cards = ctx.countIn(address);
    // An empty pile keeps its NAME (describe.js): "0 tricks" on a dashed
    // rectangle says less than "Won" does.
    if (!cards) return null;
    const tricks = Math.floor(cards / ctx.seats);
    const text = `${tricks} ${tricks === 1 ? 'trick' : 'tricks'}`;
    return { badge: text, line: { label: 'Tricks', value: String(tricks) } };
  },

  /**
   * The cards this seat has committed to a simultaneous phase but not yet
   * played — drawn as chosen, and NOT re-choosable. Each phase keeps its own
   * pending var (`__pendingPass`, `__pendingMeld`); the table was reading them
   * directly in three places, double underscore and all.
   */
  committedSelection(ctx, seat) {
    for (const phase of PHASES) {
      const committed = phase.committed?.(ctx, seat);
      if (committed != null) return committed;
    }
    return null;
  },

  /**
   * WHO PLAYED WHICH CARD IN THE TRICK — the one fact the trick fan could not
   * say for itself.
   *
   * Four cards face up in the middle and no way to tell whose is whose: with a
   * partner at the table, "is my side winning this?" was a question you
   * answered by remembering the play order, and the felt had the answer the
   * whole time. It is not in the zone — a zone holds card ids — and the felt
   * may not derive it, because "the leader played the first one and the rest
   * follow round" is a RULE (which way round, and from whom), and the platform
   * is the one file in the stack that must not know it.
   *
   * DERIVED, NOT STORED, the same judgement `contractSeatOf` makes: `leader`
   * is already public (`publicVars`) because who led is the most-watched fact
   * at a trick table, and the seat order is the table's. A second var recording
   * "seat per card" would be a copy free to disagree with it after a replay.
   *
   * Only the trick. A won pile is `visibility: 'none'` and nobody may leaf back
   * through it; a hand is its owner's.
   */
  zoneCardOwners(ctx, address) {
    if (address !== 'trick') return null;
    const ids = ctx.cardIdsIn('trick');
    const leader = ctx.var('leader');
    if (!ids.length || !Number.isInteger(leader)) return null;
    const owners = [];
    let seat = leader;
    for (let i = 0; i < ids.length; i++) {
      owners.push(seat);
      seat = ctx.nextSeat(seat);
    }
    return owners;
  },

  /**
   * THE CONTRACT, KEPT ON SCREEN — the phases' own chips, then the break.
   *
   * ONLY WHERE THE TRUMP SUIT IS A ROUND'S ANSWER (`trump: 'chosen'`). Spades'
   * trump is in the pack's name and never changes, and a strip that says the
   * same word on every hand of every match is the "play goes left" arrow
   * src/ui/table.js's `directionBadge` refuses to draw. At Pinochle it changes
   * hand to hand and half the time somebody else chose it.
   *
   * The break is appended whatever the phases said, and is the one chip a pack
   * with no contract at all can still draw (`brokenChips`).
   *
   * @returns chips the felt draws in order, or null for a pack with no contract
   */
  contractChips(ctx, seat) {
    const chips = [];
    if (ctx.rules.trump !== 'chosen') return brokenChips(ctx, chips);
    for (const phase of PHASES) chips.push(...(phase.chips?.(ctx, seat) || []));
    return brokenChips(ctx, chips);
  },

  /**
   * WHAT JUST HAPPENED, IN A SENTENCE. The phases answer for their own events
   * (the auction's contract, the meld's declaration) and the break is the core's,
   * because breaking a suit is a fact about the PLAY.
   */
  describeEvent(ev, opts = {}) {
    for (const phase of PHASES) {
      const said = phase.describe?.(ev, opts);
      if (said) return said;
    }
    /**
     * THE ONE RULE THE FELT NEVER MENTIONED (#151).
     *
     * `priority: BROKEN_PRIORITY` because the card that breaks a suit is very
     * often the fourth card of a trick, and the trick has its own celebration
     * — see `TRICK_BANNER_PRIORITY` in src/ui/celebrations.js. "Fig takes the
     * trick" is the smaller of the two things that just happened: the trick is
     * one of thirteen and the break governs every lead for the rest of the hand.
     *
     * The suit named is the one that may now be LED (`brokenLeadSuit`), which is
     * not always the suit of the card: in Hearts the queen of spades breaks
     * hearts. Neutral in tone on purpose — breaking is a change in the shape of
     * the hand rather than a gain or a loss, and it is as often the player's own
     * doing as anyone's.
     */
    if (ev.type === 'broken') {
      if (!ev.suit) return null;
      const { seatLabel, viewerSeat } = opts;
      const who = ev.seat === viewerSeat ? 'you' : (seatLabel?.(ev.seat) ?? `Seat ${ev.seat}`);
      const card = shortCardName(ev.card?.rank, ev.card?.suit);
      return {
        text: `${suitLabel(ev.suit)} are broken${card ? ` — ${who} played the ${card}` : ''}`,
        tone: 'neutral',
        priority: BROKEN_PRIORITY,
      };
    }
    return null;
  },

  /**
   * HOW THE GAME IS PLAYED, on the page that explains it: the trick itself,
   * then each optional phase in the order the felt meets it.
   *
   * THE PASS COMES LAST and the pipeline runs it first, which is not a
   * contradiction but the difference between a sentence and a phase: the reader
   * needs to know what a trick is and what is being bid for before "pass three
   * cards" means anything, and the auction's paragraph is the one that explains
   * what the hand is being played FOR.
   */
  ruleLines(rules) {
    const trump = rules.trickWinner === 'highest-trump-else-led' && rules.trump && rules.trump !== 'none'
      ? rules.trump : null;
    const out = [trump && trump !== 'chosen'
      ? `Everyone plays one card; the highest ${trump.replace(/s$/, '')} takes the trick, or the highest card of the suit that was led if no ${trump.replace(/s$/, '')} was played.`
      : 'Everyone plays one card; the highest card of the suit that was led takes the trick.'];
    if (rules.followSuit === 'must') out.push('Follow the suit that was led if you can.');
    // BREAKING, on the page that is supposed to explain the game. The rule was
    // enforced from the day the template shipped and written down nowhere: a
    // player who tried to lead a spade was refused, and the rules page had no
    // sentence to send them to (#151).
    const unlocked = brokenLeadSuit(rules);
    if (unlocked && breakingRule(rules)) {
      out.push(`You may not LEAD ${unlocked} until the suit is broken — until somebody, unable to `
        + 'follow what was led, has had to throw one in. After that anybody may lead it, and the '
        + 'felt says so the moment it happens.');
    }
    if (rules.followSuit === 'must-beat') {
      out.push('Follow the suit that was led, and play higher than the card that is winning if you hold one. '
        + 'If you are out of that suit you must trump instead — and over-trump if somebody already has.');
    }
    for (const phase of [auctionPhase, meldPhase, passPhase]) {
      out.push(...(phase.ruleLines?.(rules) || []));
    }
    return out;
  },

  endingLines() {
    return [];
  },

  botVerbs: Object.assign({}, ...PHASES.map((phase) => phase.botVerbs || {})),

  statLines(seat) {
    return [
      { label: 'Tricks won', value: seat.tricksWon, always: true },
      { label: 'Points taken', value: seat.pointsTaken, always: true },
    ];
  },

  botHeuristic(ctx, move, w = WEIGHTS) {
    // EVERY MOVE BUT THE CARD BELONGS TO A PHASE, and each scores its own: a
    // pass is N cards weighed together, a bid is a promise with no card in it,
    // a declaration is worth exactly what it scores.
    const phase = PHASES.find((p) => p.moveType === move.type);
    if (phase) return phase.score(ctx, move, w);
    // A CARD IS WORTH WHAT THE TRICK ON THE TABLE MAKES IT WORTH — see
    // `scorePlayCard`, which is where the partner, the trump and the nil live
    // (#161). It used to be two lines here and they read nothing but the card.
    return scorePlayCard(ctx, move);
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
    // carry, so the auction is asked FIRST and its answer — including the null
    // that declines a bid or a first lead — stands. `undefined` is the phase
    // saying the pack does not have it at all.
    const contract = auctionPhase.evaluate(ctx, seat, w);
    if (contract !== undefined) return contract;
    const committed = passPhase.evaluate(ctx, seat, w);
    if (committed !== undefined) return committed;

    const scoring = ctx.pack.scoring || {};

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
    const prize = prizeSign(ctx.pack);
    const rival = rivalExtreme(ctx, seat,
      (s) => handValue(ctx.cardsIn(ctx.zoneAddr('won', s)), scoring),
      prize === 1 ? 'max' : 'min');
    const total = rival === null ? score : score + rival * w.RIVAL_SHARE;
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
