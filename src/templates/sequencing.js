// Sequencing template (design doc §13.4). Validates against Stockpile.
// Shared build piles fill 1..buildRule.to in order (wilds fill any slot); each player
// races to empty their stock pile through hand/stock/discard plays, ending their turn
// by discarding one card to an own numbered discard pile.

import { selectorMatchesAny } from '../engine/selectors.js';
import { initializeDeckInto } from '../engine/state.js';
import { resolveByPlayers } from '../engine/deal.js';
import { isWild } from '../engine/cards.js';

// Zone addresses this template cares about are always `<kind>[.n].<seat>` for
// per-player zones (hand/stock/discard) — the seat is always the last segment.
function zoneKindAndSeat(address) {
  const parts = address.split('.');
  return { kind: parts[0], seat: Number(parts[parts.length - 1]) };
}

function isWildCard(ctx, card) {
  return isWild(card, ctx.rules.wilds);
}

// The rank a build pile needs next is just its current length offset from buildRule.from
// — using pile position instead of parsing the top card's rank is what makes this work
// when the top card is a wild (which has no numeric rank of its own).
function requiredRank(ctx, buildAddr) {
  return ctx.countIn(buildAddr) + ctx.rules.buildRule.from;
}

function cardPlayableOn(ctx, card, buildAddr) {
  if (ctx.countIn(buildAddr) === 0) return selectorMatchesAny(card, ctx.rules.buildStart);
  return isWildCard(ctx, card) || Number(card.rank) === requiredRank(ctx, buildAddr);
}

/* ------------------------------------------------------------------ *
 * What a bot can read off this table
 * ------------------------------------------------------------------ *
 *
 * All of it is face up. A build pile's next rank is its height; a stock's top
 * card is dealt face up (`visibility: 'top'`) and is the single most useful
 * fact at the table, because it says the rank every other seat is waiting for;
 * and the personal discard piles are `visibility: 'all'` — everybody may read
 * every card in them, and only the top one is playable.
 *
 * Nothing below reads a hand but the asking seat's own, and nothing below reads
 * a stock past its face-up top. See the note on `evaluateState`.
 */

/** The rank a build pile will be waiting for AFTER one more card lands on it. */
function rankAfterPlay(ctx, buildAddr) {
  const next = requiredRank(ctx, buildAddr) + 1;
  // The twelfth card fills the pile and `zoneFull:build.*` sweeps it away on
  // the spot, so what it wants next is the start of the count again.
  return next > ctx.rules.buildRule.to ? ctx.rules.buildRule.from : next;
}

/**
 * The rank on top of a seat's stock — the one card of it anybody may see.
 *
 * `null` when the pile is empty (the round is over) or when its top is a wild,
 * which is not waiting for a rank at all: it plays on any pile, so there is no
 * rank to set up and none to deny.
 */
function stockTopRank(ctx, seat) {
  const top = ctx.topOf(ctx.zoneAddr('stock', seat));
  if (top === undefined) return null;
  const card = ctx.cardById(top);
  if (isWildCard(ctx, card)) return null;
  const rank = Number(card.rank);
  return Number.isFinite(rank) ? rank : null;
}

/** Every rank somebody ELSE's stock is waiting for. */
function rivalStockRanks(ctx, seat) {
  const ranks = new Set();
  for (let s = 0; s < ctx.seats; s++) {
    if (s === seat) continue;
    const rank = stockTopRank(ctx, s);
    if (rank !== null) ranks.add(rank);
  }
  return ranks;
}

function topUpHand(ctx, seat) {
  const to = ctx.rules.handRefill?.to ?? 5;
  const handAddr = ctx.zoneAddr('hand', seat);
  // ctx.deal stops on its own when draw AND its recycled backlog are exhausted.
  ctx.deal(handAddr, Math.max(0, to - ctx.countIn(handAddr)));
}

function applyPlayCard(ctx, move) {
  const seat = move.actor;
  const from = move.from;

  ctx.moveCards([move.cards[0]], from, move.to);

  const { kind } = zoneKindAndSeat(from);
  if (kind === 'stock' && ctx.countIn(from) === 0) {
    // An emptied stock ends the round — and, for this template, the match:
    // see isGameOver below.
    ctx.endRound(seat);
    return;
  }
  if (kind === 'hand' && ctx.countIn(from) === 0 && ctx.rules.handRefill?.onEmptyMidTurn) {
    topUpHand(ctx, seat);
  }
}

function applyDiscard(ctx, move) {
  const seat = move.actor;
  ctx.moveCards([move.cards[0]], move.from, move.to);
  ctx.setTurnSeat(ctx.nextSeat(seat));
  ctx.setPhase('play');
  if (ctx.rules.handRefill?.atTurnStart) topUpHand(ctx, ctx.turn.seat);
}

/* ------------------------------------------------------------------ *
 * Ranking one move (see `botHeuristic` at the foot of this file)
 * ------------------------------------------------------------------ *
 *
 * THESE ARE AN ORDER, NOT A TUNING. They are not in `weights` because what
 * they encode is a structure the bot must not be allowed to break: every play
 * above every discard, a stock play above every other play, and adjustments
 * small enough that they only ever settle ties inside a tier. A tuner handed
 * these would eventually find a set where the bot declines to play, and a
 * table of four seats that would all rather discard is a table that never
 * finishes. The opinions that ARE opinions live in `WEIGHTS` below, where
 * tools/tune.mjs can reach them.
 *
 * The arithmetic that has to hold: the worst play is 2 − 0.8 − 0.5 = 0.7 and
 * the best discard is −1 + 1 = 0.
 */
const PASS_SCORE = -10;
const PLAY_FROM = { stock: 6, discard: 3, hand: 2 };
/** Leaving a pile on the rank an opponent's stock is waiting for. */
const FEEDS_RIVAL_PLAY = 0.8;
/** Leaving a pile on the rank MY stock is waiting for. */
const SETS_UP_OWN_PLAY = 0.6;
/** Spending a wild on a pile that was not going to be my stock's way out. */
const SPENDS_WILD_PLAY = 0.5;
const DISCARD_BASE = -1;
/** Laid one rank below the card it covers: two plays stacked in playing order. */
const DISCARD_SEQUENCE = 1;
/** Laid on top of a card it has nothing to do with. */
const DISCARD_BURIES = 1;
/** Laid on its own rank, which kills the card underneath: a pile wants each rank once. */
const DISCARD_DUPLICATE = 1.5;
/** Enough that it loses to every natural discard, and is only ever forced. */
const DISCARD_WILD = 5;
/**
 * A hand card spent on a pile that is going nowhere this seat needs.
 *
 * Priced at exactly what burying a card costs (DISCARD_BASE − DISCARD_BURIES),
 * because it is the same event: a card leaves circulation and does nothing on
 * its way out. The two tie and the tie breaks on enumeration order, which is
 * fine — what the number has to do is lose to the discards that are worth
 * something (a pile this card continues, a pile that is empty) and beat the
 * two that are worse than doing nothing (covering a rank the pile already
 * holds, and throwing the wild). The full order, worst first:
 *
 *   pass −10 · wild discard −6 · duplicate −2.5 · {wasted play, burying} −2
 *   · open pile −1 · sequence 0 · every play 0.7 … 6.6
 */
const WASTED_HAND_PLAY = -2;

/** Would one more card fill this pile and sweep it back into circulation? */
function completesPile(ctx, buildAddr) {
  return requiredRank(ctx, buildAddr) === ctx.rules.buildRule.to;
}

function scorePlayMove(ctx, move) {
  const { kind } = zoneKindAndSeat(move.from);
  const wants = rankAfterPlay(ctx, move.to);
  const mine = stockTopRank(ctx, move.actor);
  // A HAND CARD PLAYED PAST YOUR OWN STOCK IS A CARD THROWN AWAY, and four
  // seats doing it is how this table dies. The circulating pool is small — 162
  // cards, 120 of them dealt into the four stocks, so about forty are ever in
  // play at once — and a bot that plays every card it legally can feeds all
  // forty onto the build piles. Probed at the move cap, that is exactly what a
  // Stockpile stall looks like: build piles at 7/11/11/11 holding forty cards,
  // every hand empty, the draw and the recycle pile both empty, four stocks
  // barely touched, and nothing left that can move. The card that would
  // complete a pile and send twelve back to the draw is buried in somebody's
  // discard pile, and the game passes until the harness stops it.
  //
  // So a hand card is spent only when it is going somewhere: onto a pile still
  // BELOW my own stock top (every rank between here and there is a rank I have
  // to put down anyway), or onto the last slot of a pile, which sweeps twelve
  // cards back into the draw and is how the deck keeps breathing. Anything
  // else drops below the discards worth making, and the turn ends with the
  // card kept instead.
  // Stock and discard-pile plays are never withheld: one is the race and the
  // other frees a card that was already out of circulation.
  if (kind === 'hand' && !completesPile(ctx, move.to) && mine !== null && wants > mine) {
    return WASTED_HAND_PLAY;
  }
  let score = PLAY_FROM[kind] ?? PLAY_FROM.hand;
  if (mine !== null && wants === mine) return score + SETS_UP_OWN_PLAY;
  if (rivalStockRanks(ctx, move.actor).has(wants)) score -= FEEDS_RIVAL_PLAY;
  // A wild is the one card that can play onto ANY pile, so it is how a stock
  // top gets its pile when nothing natural will do it. Burning one to advance
  // a pile toward nothing in particular is spending the key to open a door
  // that was not locked.
  if (kind !== 'stock' && isWildCard(ctx, ctx.cardById(move.cards[0]))) score -= SPENDS_WILD_PLAY;
  return score;
}

function scoreDiscardMove(ctx, move) {
  const card = ctx.cardById(move.cards[0]);
  // NEVER THE WILD while anything natural is in hand. A discard pile is the
  // one place a wild cannot be spent from until it comes back to the top, and
  // it is the card that plays your stock onto any pile at all. When the hand
  // is nothing but wilds every discard takes this and the penalty cancels,
  // which is the only case where one of them is right.
  if (isWildCard(ctx, card)) return DISCARD_BASE - DISCARD_WILD;

  const topId = ctx.topOf(move.to);
  // An empty pile costs nothing and buries nothing; it is only ever beaten by
  // a pile this card continues.
  if (topId === undefined) return DISCARD_BASE;

  const under = Number(ctx.cardById(topId).rank);
  const rank = Number(card.rank);
  if (Number.isFinite(under) && Number.isFinite(rank)) {
    if (rank === under - 1) return DISCARD_BASE + DISCARD_SEQUENCE;
    if (rank === under) return DISCARD_BASE - DISCARD_DUPLICATE;
  }
  return DISCARD_BASE - DISCARD_BURIES;
}

/* ------------------------------------------------------------------ *
 * What a position is worth (see `evaluateState` at the foot of this file)
 * ------------------------------------------------------------------ *
 *
 * The scale is arbitrary and per-template — the lookahead only ever compares
 * it against itself — but the RATIOS are the opinion. A card already off the
 * stock beats a way to get one off it, which beats anything to do with the
 * shape of a discard pile, because the stock is the only thing the game is
 * won by.
 */
/** Every card still in the stock is a turn between here and winning. */
const STOCK_CARD = 30;
/**
 * Every card of mine that is NOT yet on a build pile — hand and discard piles
 * together — and the term that keeps this evaluator from talking a bot out of
 * playing at all.
 *
 * A discard moves a card from the hand onto a pile of my own; a build play
 * takes it off the table. This is the only term that tells those two apart,
 * and the story of the number is the story of the two ways it goes wrong.
 * WITHOUT IT every candidate a turn offers leaves the same position bar the
 * pile shape, so the rival and stock-out terms make a play look positively
 * expensive and the seat ends its turn rather than spending it: at four seats,
 * thirty of fifty games stalled at the move cap against `easy`'s one in a
 * hundred, 2547 moves a game against 446. AT THREE it was still 8 in 60,
 * because the other terms can reach 9.5 between them and a play that loses a
 * held wild, gives up a pile that was going to take my stock and hands a rank
 * to somebody else is still, in this game, a play worth making — there is
 * nothing else to do with a hand card, and a hand that empties is a hand of
 * five fresh ones.
 *
 * SO IT DOMINATES THE REST, deliberately and by arithmetic: 12 against the
 * 9.5 the worst case of STOCK_OUT + FEEDS_RIVAL + WILD_IN_HAND can cost, so
 * every play outranks every discard and the other terms decide WHICH play and
 * WHICH discard — which is the whole of what this evaluator is for, and the
 * same structure `botHeuristic` above is built on. Below STOCK_CARD by a wide
 * margin, because a card off the stock is the game and a card off the hand is
 * only tidying.
 */
const HELD_CARD = 12;
/** A build pile that would take my stock's top card this moment. */
const STOCK_OUT = 4;
/** A held card one rank below my stock top: it builds the pile I need. */
const BRIDGE_WORTH = 2;
/** A held wild: a stock play on whichever pile I like, whenever I like. */
const WILD_IN_HAND = 3;
/** An empty discard pile is somewhere to put anything. */
const OPEN_PILE = 1;
/**
 * Every card of mine lying UNDER the top of one of my discard piles.
 *
 * Only the top card of a personal pile is playable, so a card under one is out
 * of the game until the ones above it come off — and a table whose four seats
 * have buried forty cards between them is a table where the draw pile is thin,
 * the build piles stop completing and nothing recycles, which is what a
 * Stockpile live-lock actually is. Without this term the evaluator rates
 * burying a card at zero and opening a fresh pile at −OPEN_PILE, so it buries
 * by preference: `medium` stalled 6 games in 100 against `easy`'s 1.
 */
const BURY_COST = 1.5;
/**
 * A discard pile whose top card is one rank below the card under it.
 *
 * Above BURY_COST, because a card laid one below the card it covers is not
 * buried at all — it is two plays stacked in the order the build piles will
 * want them, which is the one shape a discard pile can have that helps.
 */
const SEQUENCE_WORTH = 2.5;
/** A build pile left on a rank an opponent's stock is waiting for. */
const FEEDS_RIVAL = 2.5;
/** How much the nearest opponent's stock discounts your own position. */
const RIVAL_SHARE = 9;

/**
 * The eight numbers above, gathered, so a caller can hand `evaluateState` a
 * different set (src/templates/CONTRACT.md, `weights`). The constants keep
 * their comments; this is the shipped value of each, frozen.
 */
export const WEIGHTS = Object.freeze({
  STOCK_CARD, HELD_CARD, STOCK_OUT, BRIDGE_WORTH, WILD_IN_HAND,
  OPEN_PILE, BURY_COST, SEQUENCE_WORTH, FEEDS_RIVAL, RIVAL_SHARE,
});

const sequencing = {
  id: 'sequencing',

  // Which shared vars a peer may see (src/engine/view.js). Everything at this
  // table is a pile somebody can point at.
  publicVars: [],

  defaultZones(rules, seats) {   // eslint-disable-line no-unused-vars
    const buildCapacity = rules.buildRule.to - rules.buildRule.from + 1;
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'free', facing: 'up' },
      // `top` is the honest model for a stock: the card on top is face up and
      // everything under it is face down and genuinely secret.
      { id: 'stock', per: 'player', visibility: 'top', layout: 'stack', order: 'stack', facing: 'up', label: 'Stock' },
      // A personal discard pile is NOT secret, and calling it `top` was a
      // modelling slip rather than a rule. At a real table these piles are
      // face up and fanned — everybody can read every card in them, and only
      // the TOP one is playable. Playability is enforced by validateMove
      // ("Only the top card of that pile is playable"), which is where it
      // belongs; visibility is about who may SEE, and the answer here is
      // everyone. The distinction started mattering when piles learned to fan
      // (`ui.zoneOverlap`): under `top` the fan drew card backs, hiding
      // information the game has never hidden. It will matter more when Phase
      // 8 filters per-seat views off this same field.
      { id: 'discard', per: 'player', count: rules.discardPiles, visibility: 'all', layout: 'stack', order: 'stack', facing: 'up', label: 'Discard' },
      { id: 'build', per: 'shared', count: rules.buildPiles, visibility: 'top', layout: 'stack', order: 'stack', facing: 'up', capacity: buildCapacity, label: 'Build' },
      { id: 'recycled', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down' },
      // `interactive`: hidden, but it is the draw control, so it stays on the felt.
      { id: 'draw', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Draw', interactive: true },
    ];
  },

  defaultReactions() {
    return [
      { when: 'zoneFull:build.*', do: 'moveAll', to: 'recycled' },
      { when: 'zoneEmpty:draw', do: 'recycle', from: 'recycled', shuffle: true },
    ];
  },

  setup(ctx) {
    initializeDeckInto(ctx.state, 'draw');
    ctx.dealEach(resolveByPlayers(ctx.rules.stockSize, ctx.seats), { to: 'stock' });
    for (let s = 0; s < ctx.seats; s++) topUpHand(ctx, s);
    ctx.setPhase('play');
  },

  validateMove(ctx, move) {
    if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");

    if (move.type === 'playCard') {
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const { from, to } = move;
      if (!from || !ctx.hasZone(from)) return ctx.fail('bad-zone', 'Unknown source zone.');
      if (!to || !ctx.hasZone(to)) return ctx.fail('bad-zone', 'Unknown target zone.');

      const { kind, seat } = zoneKindAndSeat(from);
      if (!ctx.rules.playableFrom.includes(kind)) return ctx.fail('not-playable-from', `Cannot play from ${kind}.`);
      if (seat !== move.actor) return ctx.fail('not-your-zone', 'That is not your pile.');

      // Stock and discard are physical piles — only the top card is playable. Hand
      // cards can be played in any order.
      if (kind === 'stock' || kind === 'discard') {
        if (ctx.topOf(from) !== cardId) return ctx.fail('not-top', 'Only the top card of that pile is playable.');
      } else if (!ctx.cardIdsIn(from).includes(cardId)) {
        return ctx.fail('not-in-hand', 'That card is not in your hand.');
      }

      if (!to.startsWith('build.')) return ctx.fail('bad-target', 'Cards are played onto a build pile.');

      const card = ctx.cardById(cardId);
      if (!cardPlayableOn(ctx, card, to)) {
        return ctx.fail('build-rule', 'That card cannot be played on that build pile right now.');
      }
      return ctx.ok();
    }

    if (move.type === 'discard') {
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const { from, to } = move;
      if (!from || !ctx.hasZone(from)) return ctx.fail('bad-zone', 'Unknown source zone.');
      if (!to || !ctx.hasZone(to)) return ctx.fail('bad-zone', 'Unknown target zone.');

      const src = zoneKindAndSeat(from);
      if (src.kind !== 'hand' || src.seat !== move.actor) return ctx.fail('not-your-hand', 'You can only discard from your own hand.');
      if (!ctx.cardIdsIn(from).includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');

      const dst = zoneKindAndSeat(to);
      if (dst.kind !== 'discard' || dst.seat !== move.actor) return ctx.fail('not-your-pile', 'You can only discard to your own pile.');
      return ctx.ok();
    }

    // A player with an empty hand and no legal stock/discard play (only reachable
    // once the shared draw pile — and its recycled backlog — are both exhausted)
    // has nothing to end their turn with; the turn just passes.
    if (move.type === 'pass') return ctx.ok();

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    if (move.type === 'playCard') applyPlayCard(ctx, move);
    else if (move.type === 'discard') applyDiscard(ctx, move);
    else if (move.type === 'pass') ctx.setTurnSeat(ctx.nextSeat(move.actor));
  },

  enumerateLegalMoves(ctx, seat) {
    const moves = [];
    const sources = [];
    if (ctx.rules.playableFrom.includes('stock')) {
      const from = ctx.zoneAddr('stock', seat);
      const top = ctx.topOf(from);
      if (top !== undefined) sources.push({ cardId: top, from });
    }
    if (ctx.rules.playableFrom.includes('hand')) {
      const from = ctx.zoneAddr('hand', seat);
      for (const cardId of ctx.cardIdsIn(from)) sources.push({ cardId, from });
    }
    if (ctx.rules.playableFrom.includes('discard')) {
      for (let n = 1; n <= ctx.rules.discardPiles; n++) {
        const from = `discard.${n}.${seat}`;
        const top = ctx.topOf(from);
        if (top !== undefined) sources.push({ cardId: top, from });
      }
    }

    for (const { cardId, from } of sources) {
      const card = ctx.cardById(cardId);
      for (let n = 1; n <= ctx.rules.buildPiles; n++) {
        const to = `build.${n}`;
        if (cardPlayableOn(ctx, card, to)) moves.push({ actor: seat, type: 'playCard', cards: [cardId], from, to });
      }
    }

    const handAddr = ctx.zoneAddr('hand', seat);
    for (const cardId of ctx.cardIdsIn(handAddr)) {
      for (let n = 1; n <= ctx.rules.discardPiles; n++) {
        moves.push({ actor: seat, type: 'discard', cards: [cardId], from: handAddr, to: `discard.${n}.${seat}` });
      }
    }

    if (moves.length === 0) moves.push({ actor: seat, type: 'pass' });
    return moves;
  },

  isRoundOver(ctx) {
    return ctx.state.roundEnded;
  },

  // ONE ROUND, AND IT IS THE MATCH. Stockpile's own declaration is
  // `winner: "first-empty-stock"` and its manifest names no scoring at all, so
  // the pipeline asks the template — and the honest answer is that a race to
  // empty a stock has nothing to play a second round FOR.
  isGameOver() {
    return true;
  },

  /* ---------------------------------------------------------------- *
   * What the platform asks this template about itself (src/templates/CONTRACT.md)
   * ---------------------------------------------------------------- */

  interactionMode() {
    return 'place';
  },

  /**
   * THE STOCK IS THE RACE, so the stock is what a minimized seat shows.
   *
   * The platform's default is the hand count, and in this genre that is the
   * one number on the table that never means anything: a turn ends by topping
   * the hand back up, so every seat sits at the same full hand almost always.
   * A crowded row said "5 cards" once per opponent — the same digit, five
   * times — while the number the entire game is a race on was the one it had
   * put away behind a tap.
   *
   * The hand is not offered as a second counter for the same reason it is not
   * the first: it is a constant. What is worth the space beside the stock is
   * nothing at all.
   */
  seatCounters(ctx, seat) {
    const stock = ctx.countIn(`stock.${seat}`);
    return [{
      text: String(stock),
      // Said in full, because the printed form is a bare digit that could be
      // read as a hand, a score or a pile.
      aria: `${stock} left in stock`,
      label: 'Stock',
      kind: 'stock',
    }];
  },

  ruleLines() {
    return [
      'Play cards up the build piles in the middle, one rank at a time.',
      'Cards come from your stock pile, your hand, or your own discard piles.',
      'End your turn by discarding to one of your own piles.',
    ];
  },

  endingLines(pack) {
    return pack.rules?.winner === 'first-empty-stock'
      ? ['The first player to empty their stock pile wins immediately.']
      : [];
  },

  botVerbs: {},

  statLines(seat) {
    return [
      { label: 'Stock left', value: seat.stockLeft, always: true },
      { label: 'Build plays', value: seat.buildPlays, always: true },
      { label: 'Discards', value: seat.discards },
    ];
  },

  /**
   * WHICH MOVE, AND — the half this never used to answer — ONTO WHICH PILE.
   *
   * The whole bot was five flat numbers: pass −2, discard −1, stock 3, discard
   * pile 2, hand 1. Every discard scored the same, so the first card in hand
   * order went onto pile 1 whatever it was, wilds included; every build play
   * scored the same, so the pile was whichever the enumerator offered first.
   * That is how a seat ends up laying the eleven that brings a pile to exactly
   * the twelve sitting face up on the human's stock.
   *
   * THE ORDER IS STILL AN ORDER, and deliberately: every play outranks every
   * discard, so a turn still spends itself before it ends. What is new is the
   * tie-breaking WITHIN each tier, and the tiers are spaced (6 / 3 / 2 against
   * adjustments that never total 2) so a tie-break can never promote a hand
   * play over a stock play — the stock is the race, and no amount of reading
   * the table is worth not running it.
   */
  botHeuristic(ctx, move) {
    if (move.type === 'pass') return PASS_SCORE;
    if (move.type === 'discard') return scoreDiscardMove(ctx, move);
    return scorePlayMove(ctx, move);
  },

  /**
   * HOW GOOD THIS POSITION IS FOR `seat` — the lookahead's scorer
   * (src/engine/bot.js), higher is better. There was none at all before, which
   * is why `medium` played exactly as `easy` did.
   *
   * THE RACE IS THE STOCK and everything else is how fast you can run it: how
   * many build piles will take your stock's top card right now, what you are
   * holding that could bring one to it, and what your four discard piles look
   * like — an empty pile is somewhere to put anything, and a pile whose top
   * card is one rank BELOW the card under it is two plays stacked in the order
   * you will want them.
   *
   * IT DELIBERATELY DOES NOT READ anybody's hand but this seat's, nor any stock
   * below its face-up top card, nor the draw pile. Everything it does read is
   * on the table face up for all four seats, which is what makes the rival term
   * honest: the ranks the opponents are waiting for are printed on their stocks.
   *
   * The one-ply search will not use this on a turn where a stock play is legal
   * — playing off the stock turns the next stock card face up, which is a card
   * this seat could not see beforehand, and `src/engine/bot.js` refuses to
   * judge a move whose fork reveals one. That is the right answer twice over:
   * the stock play is the move anyway, and the turns this hook is left to
   * decide are exactly the ones that were being decided by hand order.
   */
  evaluateState(ctx, seat, w = WEIGHTS) {
    let score = -ctx.countIn(ctx.zoneAddr('stock', seat)) * w.STOCK_CARD;

    const mine = stockTopRank(ctx, seat);
    const rivals = rivalStockRanks(ctx, seat);
    for (let n = 1; n <= ctx.rules.buildPiles; n++) {
      const need = requiredRank(ctx, `build.${n}`);
      if (mine !== null && need === mine) score += w.STOCK_OUT;
      // A pile left sitting on the rank somebody's stock is waiting for is a
      // turn handed to them, and it is the same fact from either side of the
      // table — which is what makes this seat-symmetric.
      if (rivals.has(need)) score -= w.FEEDS_RIVAL;
    }

    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    score -= hand.length * w.HELD_CARD;
    for (const id of hand) {
      const card = ctx.cardById(id);
      if (isWildCard(ctx, card)) score += w.WILD_IN_HAND;
      else if (mine !== null && Number(card.rank) === mine - 1) score += w.BRIDGE_WORTH;
    }

    for (let n = 1; n <= ctx.rules.discardPiles; n++) {
      const ids = ctx.cardIdsIn(`discard.${n}.${seat}`);
      score -= ids.length * w.HELD_CARD;
      if (ids.length === 0) { score += w.OPEN_PILE; continue; }
      // Everything but the top card of the pile is out of the game until the
      // cards above it come off.
      score -= (ids.length - 1) * w.BURY_COST;
      if (ids.length < 2) continue;
      const top = Number(ctx.cardById(ids[ids.length - 1]).rank);
      const under = Number(ctx.cardById(ids[ids.length - 2]).rank);
      if (Number.isFinite(top) && Number.isFinite(under) && top === under - 1) score += w.SEQUENCE_WORTH;
    }

    let rivalStock = Infinity;
    for (let s = 0; s < ctx.seats; s++) {
      if (s === seat) continue;
      rivalStock = Math.min(rivalStock, ctx.countIn(ctx.zoneAddr('stock', s)));
    }
    return Number.isFinite(rivalStock) ? score + rivalStock * w.RIVAL_SHARE : score;
  },

  /**
   * HOW FAR ALONG THE MATCH A SEAT IS — and here the match is one race, so it
   * is the stock and nothing else.
   *
   * Without this hook `src/engine/bot.js` falls back to the accumulated score,
   * and Stockpile's manifest names no scoring at all: every rollout of every
   * candidate came back worth exactly zero, the chooser saw no spread, and
   * `hard` dropped to one ply — which, with no `evaluateState` either, was
   * enumeration order. A whole difficulty tier that did nothing.
   *
   * Differenced across the round by `terminalValue`, so what a rollout is
   * graded on is how many cards came off this seat's stock against how many
   * came off everyone else's, and a rollout that ENDS is a seat at zero. Public
   * to the last digit: a stock's height is a thing you can see across a table.
   */
  matchStanding(ctx, seat) {
    return -ctx.countIn(ctx.zoneAddr('stock', seat));
  },

  /** The evaluator's numbers, for a caller that wants to play with different ones. */
  weights: WEIGHTS,
};

export default sequencing;
