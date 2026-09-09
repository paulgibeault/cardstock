// Cribbage — A TEMPLATE OF ONE (issue #107, THIRTEEN_RULES.md §5.6).
//
// The §13 extension policy prefers a parameter to a template and a template to
// a special case, and it has nothing to say when there is no template to
// parameterise. Nothing else on the roadmap is cribbage-like: no other game
// counts to thirty-one out loud, gives a hand away to its opponent, scores the
// same four cards twice, or keeps its score on a board rather than a sheet. So
// this is priced as its own genre, and the honest cost of that is written down
// in src/templates/CONTRACT.md.
//
// THE FOUR PHASES, AND WHICH OF THEM ARE REALLY PHASES:
//
//   discard   Both seats give two cards to the crib, at the same time and
//             without seeing each other's. `turn.phase === 'discard'`, the
//             `pass` interaction mode, `actingSeats` naming everyone who still
//             holds six.
//   cut       A STEP, NOT A PHASE — see `cutStarter` below.
//   play      Alternating, to thirty-one, over and over until all eight cards
//             are down. `turn.phase === 'play'`, the `tap` mode.
//   show      Also a step: the pone's hand, then the dealer's, then the crib,
//             in that order, resolved inside the move that lays the last card.
//
// THE BOARD IS NOT A ZONE. 121 holes and two pegs a side is a score, drawn
// long, and the platform draws it from `seatCounters` — one counter of
// `kind: 'peg'`, which src/ui/counterTrack.js knows how to render as a track.
// Nothing about the board is in this file except the two numbers it needs.

import { rankLadderOf, rankOrder } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { cardValue } from '../engine/scoring.js';
import { scoreHand, scorePlay } from './cribbage-score.js';

/* ------------------------------------------------------------------ *
 * What a position is worth (see `evaluateState` at the foot of this file)
 * ------------------------------------------------------------------ *
 *
 * A HOLE IS THE UNIT, because it is the only currency in the game. Everything
 * below is priced in holes, which is what makes the numbers arguable rather
 * than arbitrary: "the crib is worth about four and a half to whoever owns it"
 * is a claim a cribbage player will recognise and can be wrong about.
 */

/** The average crib, in holes. Yours to gain, or theirs — the sign follows ownership. */
const CRIB_WORTH = 4.5;

/**
 * How much of the crib's value a discard is judged to carry.
 *
 * The two cards thrown are not the whole crib — the opponent throws two more
 * and the starter is turned — so a pair of fives thrown into your own crib is
 * worth a fraction of what the same two would score in hand. Sized so that
 * keeping a five outranks feeding one to your own crib, which is the discard
 * decision players get wrong most often.
 */
const CRIB_THROW_SHARE = 0.45;

/** A hole still on the table, discounted for not being pegged yet. */
const PEGGED_WORTH = 1;

/** What the cards still in hand promise at the show, per hole. */
const PROMISE_WORTH = 0.6;

/**
 * How much being AHEAD is worth beyond the holes themselves.
 *
 * Cribbage is a race with a finish line, so the same two holes matter more at
 * 118 than at 20. This is the multiplier on the gap, and it is deliberately
 * small: the gap is already counted once in the holes.
 */
const LEAD_WORTH = 0.25;

/** A card left in hand during the play is an option; an empty hand is not. */
const OPTION_WORTH = 0.15;

export const WEIGHTS = Object.freeze({
  CRIB_WORTH, CRIB_THROW_SHARE, PEGGED_WORTH, PROMISE_WORTH, LEAD_WORTH, OPTION_WORTH,
});

/* ------------------------------------------------------------------ *
 * Reading the pack
 * ------------------------------------------------------------------ */

/**
 * The two functions `cribbage-score.js` is handed, memoised on the PACK.
 *
 * `valueOf` is the pack's `scoring.cardValues` (ace 1, face cards 10) and
 * `orderOf` is its declared `rankLadder` (#101: `A 2 … K`, ace LOW, which is
 * the whole reason the ladder had to become a declaration). They are different
 * numbers for six of the thirteen ranks and the game turns on the difference —
 * J-Q-K is a run and 10-J-Q-K-K is not a fifteen.
 */
const packScorers = new WeakMap();

/**
 * RESOLVED PER CARD, ONCE, not per question.
 *
 * `cardValue` walks the pack's whole `cardValues` map through `selectorMatches`
 * on every call, and this pack declares one entry per rank — so an unmemoised
 * `valueOf` is thirteen selector matches per card, five cards per scored hand,
 * and the bot scores fifteen candidate throws per discard. It is the difference
 * between a distribution sweep that takes a minute and one that takes seconds,
 * and between a `hard` rollout that fits its clock budget and one that does not.
 *
 * A plain Map over the deck's 52 cards, built eagerly: every card in the pack
 * gets asked eventually, and a Map that never grows is one less thing to reason
 * about on the hot path.
 */
function scorersFor(ctx) {
  let cached = packScorers.get(ctx.pack);
  if (cached) return cached;
  const scoring = ctx.pack.scoring || {};
  const ladder = rankLadderOf(ctx.pack);
  const nobs = ctx.rules.nobs;
  const values = new Map();
  const orders = new Map();
  const nobsCards = new Set();
  for (const card of ctx.pack.cardsById.values()) {
    values.set(card, cardValue(card, scoring));
    orders.set(card, rankOrder(card, ladder));
    if (nobs && selectorMatches(card, nobs)) nobsCards.add(card);
  }
  cached = {
    valueOf: (card) => values.get(card) ?? 0,
    orderOf: (card) => orders.get(card) ?? -1,
    isNobs: (card) => nobsCards.has(card),
  };
  packScorers.set(ctx.pack, cached);
  return cached;
}

/** The seat whose crib it is this hand. Rotates with the deal, like everything else. */
function dealerOf(ctx) {
  return ctx.var('dealer') ?? ctx.openingSeat();
}

function handAddr(ctx, seat) {
  return ctx.zoneAddr('hand', seat);
}

function playAddr(ctx, seat) {
  return ctx.zoneAddr('play', seat);
}

/* ------------------------------------------------------------------ *
 * Pegging — the one way a score changes
 * ------------------------------------------------------------------ */

/**
 * A SCORE BREAKDOWN WITH THE CARD IDS TAKEN OUT, for emitting.
 *
 * `src/engine/view.js`'s `eventsFor` filters an event's TOP-LEVEL `cards`
 * array against what the seat may see, and nothing deeper — which the protocol
 * audit found the moment this template started shipping a breakdown: each part
 * carries the cards that made it, one level down, and those sailed past the
 * filter. Worse, the round boundary runs inside the same move as the show, so
 * by the time the payload is delivered those cards have been reshuffled into
 * the next deal and the ids name somebody's fresh hand.
 *
 * Two ways to fix that; this is the smaller one. Teaching the filter to walk
 * nested structures is a change to the piece of the platform that exists to
 * fail closed, made for one caller's convenience, and it would not help
 * anyway — post-redeal, every id in a show is invisible and would be stripped
 * regardless. So what goes on the wire is WHAT scored and HOW MUCH, with a
 * count where the cards were. `scoreHand`'s full breakdown, cards and all, is
 * still there for anything in-process that wants it.
 *
 * The cost, said plainly: a remote client narrates "the crib is worth eight"
 * and cannot light up the eight cards that made it. A local table can — it
 * reads `state.events` directly — and the honest fix for the remote case is a
 * show that is its own move rather than the tail of the last card, which is a
 * bigger change than this issue is buying.
 */
function partsOf(breakdown) {
  return (breakdown || []).map((part) => ({
    kind: part.kind,
    points: part.points,
    n: part.cards.length,
  }));
}

/* ------------------------------------------------------------------ *
 * Saying what scored
 * ------------------------------------------------------------------ */

/**
 * WHAT ONE PART OF A SCORE IS CALLED OUT LOUD.
 *
 * Every scoring event in this template carried its breakdown from the day it
 * shipped and the felt said only the total, so a fifteen, a pair and a run all
 * read "Nell pegs 2" — three completely different things to have happen to you
 * (#124, item 41). These are the words a cribbage player uses; they are the
 * whole reason the game has a vocabulary at all.
 *
 * `n` is the number of CARDS in the part (`partsOf`), which is what separates a
 * pair from a pair royal and sizes a run.
 */
function partPhrase(part) {
  const n = part?.n ?? 0;
  switch (part?.kind) {
    case 'fifteen': return 'fifteen';
    case 'thirty-one': return 'thirty-one';
    // Three of a kind is a pair royal and four is a double pair royal — six and
    // twelve holes. Calling either of them "a pair" undersells the hand badly.
    case 'pair': return n >= 4 ? 'double pair royal' : n === 3 ? 'pair royal' : 'a pair';
    case 'run': return `a run of ${n}`;
    case 'flush': return `a flush of ${n}`;
    // The one this pack puts in its own tagline and had never once printed.
    case 'nobs': return 'his nobs';
    default: return null;
  }
}

/** The breakdown as one clause: "fifteen, fifteen and a pair". */
function namedParts(parts) {
  const words = (parts || []).map(partPhrase).filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * MOVE A PEG, AND STOP THE GAME IF IT WENT OUT.
 *
 * Every hole in cribbage is pegged the instant it is earned, and the game ends
 * the instant somebody passes the target — mid-play, mid-show, mid-crib. That
 * "instant" is the rule the whole scoring order exists to serve: the pone
 * counts first precisely so that a pone sitting on 118 wins before the dealer
 * ever turns their hand over.
 *
 * So this is the ONLY place `addScore` is called, it moves the back peg to
 * where the front one was, and it answers false once the game is decided —
 * every caller checks, and that check is what implements "the show stops".
 */
function peg(ctx, seat, points, reason) {
  if (ctx.state.roundEnded || ctx.state.gameOver) return false;
  if (points <= 0) return true;
  ctx.setPlayerVar(seat, 'backPeg', ctx.score(seat));
  ctx.addScore(seat, points);
  ctx.emit('pegged', { seat, points, reason, total: ctx.score(seat) });
  if (ctx.score(seat) >= ctx.rules.target) {
    ctx.endRound(seat);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * The cut
 * ------------------------------------------------------------------ */

/**
 * THE CUT IS A STEP, NOT A PHASE — a deliberate, reversible narrowing.
 *
 * The issue lists `cut` beside `discard`, `play` and `show` as a phase, and it
 * is not one here: a phase in this engine is a state in which somebody has a
 * DECISION, and cutting has none. The pone cuts, the dealer turns whatever came
 * up. Modelling it as a phase would mean a `cut` move type, an interaction mode
 * with no card to tap, and one mandatory click per hand that can only be
 * answered one way — thirty of them in a match to 121.
 *
 * What it costs to be wrong about this is one phase name and a move type, so it
 * is the smaller of the two choices. What it BUYS is that the cut is
 * replayable for free: the starter is the top of the pile the seeded shuffle
 * already built, taken inside the move that completed the discard, so
 * `rehydrateMatch` turns up the same card without the log carrying a thing.
 *
 * His heels (his nibs, two for his heels — the names are all the same rule):
 * a jack turned scores the DEALER two, immediately, and can win the game before
 * a card is played.
 */
function cutStarter(ctx) {
  const top = ctx.topOf('draw');
  if (top === undefined) return;
  ctx.moveCards([top], 'draw', 'starter');
  const card = ctx.cardById(top);
  const { isNobs } = scorersFor(ctx);
  ctx.emit('starterCut', { cards: [top] });
  if (isNobs(card)) {
    const dealer = dealerOf(ctx);
    ctx.emit('hisHeels', { seat: dealer });
    peg(ctx, dealer, ctx.rules.heels, 'heels');
  }
}

function startPlay(ctx) {
  ctx.setVar('count', 0);
  ctx.setVar('run', []);
  ctx.setVar('lastPlayer', null);
  // The pone leads. In two-handed cribbage that is the whole compensation for
  // not owning the crib, and it is why the dealer is the seat the round opens
  // on rather than the seat that moves first.
  ctx.setTurnSeat(ctx.nextSeat(dealerOf(ctx), 1));
  ctx.setPhase('play');
}

/* ------------------------------------------------------------------ *
 * The play
 * ------------------------------------------------------------------ */

/** Cards in `seat`'s hand that still fit under thirty-one. */
function playableFor(ctx, seat) {
  const { valueOf } = scorersFor(ctx);
  const count = ctx.var('count') ?? 0;
  const limit = ctx.rules.countTo;
  return ctx.cardIdsIn(handAddr(ctx, seat)).filter((id) => count + valueOf(ctx.cardById(id)) <= limit);
}

function anyoneCanPlay(ctx) {
  for (let s = 0; s < ctx.seats; s++) if (playableFor(ctx, s).length) return true;
  return false;
}

function handsEmpty(ctx) {
  for (let s = 0; s < ctx.seats; s++) if (ctx.countIn(handAddr(ctx, s))) return false;
  return true;
}

/**
 * "GO" WITHOUT A MOVE FOR IT.
 *
 * Saying go is a required utterance with no decision in it — you say it exactly
 * when you cannot play, and you have no choice about whether. So it is resolved
 * here rather than enumerated: after every card, the turn walks forward to the
 * next seat that CAN play, and if nobody can, the last player takes the point
 * (one for the go, or one for the last card if the count also happens to be
 * short of thirty-one) and a fresh count opens on the seat after them.
 *
 * The invariant this preserves matters more than the tidiness: WHOEVER'S TURN
 * IT IS ALWAYS HAS A LEGAL MOVE. A turn that can only pass is a stall as far as
 * tools/simulate.mjs and the bot driver are concerned, and every completion bar
 * in the repo is built on "the acting seat can act".
 */
/**
 * A FRESH COUNT, OPENED ON SOMEBODY WHO CAN ACTUALLY LAY A CARD.
 *
 * Thirty-one and a go both close the count and start a new one, and the seat it
 * opens on is the one after whoever closed it — UNLESS that seat has run out of
 * cards, in which case play carries on round to whoever still has some. Getting
 * that wrong is not a scoring error, it is a DEADLOCK: the turn lands on a seat
 * with an empty hand, `enumerateLegalMoves` returns nothing, and the table
 * stops. It cost 23 stalls in a thousand simulated games — roughly one hand in
 * forty-three ends with one player holding two cards while the other has none,
 * which is common enough to meet in an evening and rare enough to ship.
 *
 * With the count back at zero every card a seat holds is playable, so "can act"
 * here is just "still holds something".
 *
 * @returns false when nobody does — the hand is over and the show is due.
 */
function openNextCount(ctx, from) {
  ctx.setVar('count', 0);
  ctx.setVar('run', []);
  let seat = ctx.nextSeat(from, 1);
  for (let step = 0; step < ctx.seats; step++) {
    if (playableFor(ctx, seat).length) {
      ctx.setTurnSeat(seat);
      return true;
    }
    seat = ctx.nextSeat(seat, 1);
  }
  return false;
}

function advancePlay(ctx, from) {
  const limit = ctx.rules.countTo;

  if (handsEmpty(ctx)) {
    // The last card down is worth a point unless it made thirty-one, which was
    // already worth two and must not be paid for twice.
    if ((ctx.var('count') ?? 0) < limit) peg(ctx, from, ctx.rules.lastCard, 'last-card');
    if (ctx.state.roundEnded) return;
    theShow(ctx);
    return;
  }

  let seat = ctx.nextSeat(from, 1);
  for (let step = 1; step < ctx.seats; step++) {
    if (playableFor(ctx, seat).length) {
      ctx.setTurnSeat(seat);
      return;
    }
    seat = ctx.nextSeat(seat, 1);
  }

  if (playableFor(ctx, from).length) {
    // Everybody else said go and the player still holds something under the
    // limit: they keep laying cards until they cannot either.
    ctx.emit('go', { seat: from });
    ctx.setTurnSeat(from);
    return;
  }

  // Nobody can play. One for the go to whoever laid last, and a new count.
  ctx.emit('go', { seat: from, closes: true });
  if (!peg(ctx, from, ctx.rules.go, 'go')) return;
  if (!openNextCount(ctx, from)) theShow(ctx);
}

function applyPlayCard(ctx, move) {
  const seat = move.actor;
  const cardId = move.cards[0];
  ctx.moveCards([cardId], handAddr(ctx, seat), playAddr(ctx, seat));

  const run = [...(ctx.var('run') || []), cardId];
  ctx.setVar('run', run);
  ctx.setVar('lastPlayer', seat);

  const { valueOf, orderOf } = scorersFor(ctx);
  const played = run.map((id) => ctx.cardById(id));
  const { total, count, breakdown } = scorePlay(played, { valueOf, orderOf });
  ctx.setVar('count', count);
  ctx.emit('pegPlay', { seat, count, points: total, parts: partsOf(breakdown) });

  if (total && !peg(ctx, seat, total, 'play')) return;

  if (count >= ctx.rules.countTo) {
    // Thirty-one closes the count where it stands; the two points for reaching
    // it were already scored by scorePlay above, which is why no `lastCard`
    // point is paid here — that would be the same card paid for twice.
    if (handsEmpty(ctx) || !openNextCount(ctx, seat)) theShow(ctx);
    return;
  }

  advancePlay(ctx, seat);
}

/* ------------------------------------------------------------------ *
 * The show
 * ------------------------------------------------------------------ */

/**
 * PONE, DEALER, CRIB — AND THE ORDER IS THE RULE.
 *
 * Every one of these can take a seat past 121 and end the match on the spot, so
 * the sequence is not presentation: it is who wins a close game. The dealer's
 * compensation for showing second is owning the crib, and the pone's for having
 * no crib is counting before it exists. `peg` returning false is what stops the
 * rest of the show happening.
 *
 * The cards scored are the ones already face up in each seat's `play` pile —
 * they were laid there during the play and nothing needs turning over. The crib
 * is the only thing that was hidden, and the event that scores it is what
 * reveals it.
 */
function theShow(ctx) {
  const dealer = dealerOf(ctx);
  const starter = ctx.cardIdsIn('starter')[0];
  const starterCard = starter ? ctx.cardById(starter) : null;
  const { valueOf, orderOf, isNobs } = scorersFor(ctx);
  ctx.setPhase('show');

  const order = [];
  for (let step = 1; step <= ctx.seats; step++) order.push(ctx.nextSeat(dealer, step));

  for (const seat of order) {
    const cards = ctx.cardsIn(playAddr(ctx, seat));
    const { total, breakdown } = scoreHand(cards, starterCard, { valueOf, orderOf, isNobs });
    ctx.emit('showScored', {
      seat, isCrib: false, points: total, parts: partsOf(breakdown),
      cards: ctx.cardIdsIn(playAddr(ctx, seat)),
    });
    if (!peg(ctx, seat, total, 'show')) return;
  }

  // TURNED BEFORE IT IS COUNTED. The move is the reveal; everything after it
  // may name these cards because everybody can now see them.
  ctx.moveCards(ctx.cardIdsIn('crib').slice(), 'crib', 'show');
  const cribCards = ctx.cardsIn('show');
  const crib = scoreHand(cribCards, starterCard, { valueOf, orderOf, isNobs, isCrib: true });
  ctx.emit('showScored', {
    seat: dealer, isCrib: true, points: crib.total, parts: partsOf(crib.breakdown),
    cards: ctx.cardIdsIn('show'),
  });
  if (!peg(ctx, dealer, crib.total, 'crib')) return;

  ctx.endRound(null);
}

/* ------------------------------------------------------------------ *
 * The bot
 * ------------------------------------------------------------------ */

/**
 * WHAT TO THROW, priced in holes.
 *
 * The full answer is an expected value over the 46 possible starters and the
 * 1,081 hands the opponent might throw, which is a table people publish and
 * nobody computes at the table. This is the cheap version and it is the one a
 * decent club player actually uses: score the four you would keep as if the
 * starter were nothing, add what the two you are throwing are worth to whoever
 * owns the crib, and prefer keeping cards that can still make something.
 *
 * `scoreHand` with a null starter is exactly "what these four are worth on
 * their own", which is why that case exists in the scorer.
 */
function scoreDiscard(ctx, move, w = WEIGHTS) {
  const seat = move.actor;
  const going = new Set(move.cards);
  const hand = ctx.cardIdsIn(handAddr(ctx, seat));
  const keeping = hand.filter((id) => !going.has(id)).map((id) => ctx.cardById(id));
  const thrown = move.cards.map((id) => ctx.cardById(id));
  const { valueOf, orderOf, isNobs } = scorersFor(ctx);

  const kept = scoreHand(keeping, null, { valueOf, orderOf, isNobs, parts: false }).total;
  const given = scoreHand(thrown, null, { valueOf, orderOf, isNobs, parts: false }).total;

  // Two cards that score together are worth throwing into YOUR crib and worth
  // avoiding in theirs — same number, opposite sign, which is the whole of what
  // owning the crib means. `CRIB_WORTH` is not added here: it is the same
  // constant for every candidate throw and would only shift the whole ranking,
  // which is why it belongs in `evaluateState` (where the crib's owner is a
  // fact about the POSITION) and not in this comparison.
  const mine = dealerOf(ctx) === seat ? 1 : -1;
  return kept + mine * given * w.CRIB_THROW_SHARE;
}

/* ------------------------------------------------------------------ *
 * The template
 * ------------------------------------------------------------------ */

const cribbage = {
  id: 'cribbage',

  // Who deals, what the count stands at, and which cards are on the table in
  // front of everybody. All four are facts anybody sitting at the table can
  // see; `run` holds card IDS, which is the one thing this repo is careful
  // about (src/engine/view.js) — they are published because these cards were
  // laid face up, and the pile they are in is `visibility: 'all'` for the same
  // reason.
  publicVars: () => ['dealer', 'count', 'run', 'lastPlayer'],

  defaultZones(rules, seats) {   // eslint-disable-line no-unused-vars
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'sorted', facing: 'up' },
      // The pack the cut comes off. `none` for the reason every draw pile in
      // this repo is `none`: this pile IS the remaining shuffle, and publishing
      // its order publishes the starter before it is turned.
      { id: 'draw', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Deck', interactive: true },
      // THE CRIB IS THE ONLY HIDDEN THING IN THE GAME. `none` means a count, to
      // everybody, INCLUDING the dealer who owns it — which is right: the crib
      // is turned over at the show and not before, and its owner may not leaf
      // through it in the meantime. The `showScored` event is what reveals it.
      //
      // `onFelt` because a hidden pile is not the same as an absent one, and
      // the felt was drawing this one as absent (#124, item 37). Four cards go
      // into the crib in front of both players, everybody can count them in,
      // and the whole discard decision is about what is in there — so the pile
      // is furniture: face-down backs with its count, exactly what a real table
      // shows. The visibility is untouched; `onFelt` says where it is drawn,
      // never what may be seen in it.
      { id: 'crib', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Crib', onFelt: true },
      // WHERE THE CRIB IS TURNED OVER, and the reason it is a zone rather than
      // an event payload. The first cut of the show emitted the crib's card ids
      // in `showScored` and left them sitting in a `visibility: 'none'` pile —
      // which the protocol harness caught immediately and correctly ("seat 1
      // was sent clubs-8, which it may not see"): a card is revealed by MOVING
      // it somewhere everyone can see, not by mentioning it. Turning the crib
      // face up is also exactly what the dealer does with their hands.
      //
      // `hideWhenEmpty` because this pile does not exist yet for most of the
      // hand and an empty box captioned "The crib" is a lie told beside the
      // real one: through the deal, the cut and the whole play, the felt read
      // "The crib, 0 cards" while four cards sat in `crib` (#124, item 37).
      // It appears at the moment the dealer turns the crib over, which is
      // exactly when a real one appears.
      { id: 'show', per: 'shared', visibility: 'all', layout: 'spread', order: 'sequence', facing: 'up', label: 'The crib', hideWhenEmpty: true },
      // Each seat lays in front of themselves and takes their own four back at
      // the show — which is what a real table does, and what saves this
      // template from having to remember who played what.
      { id: 'play', per: 'player', visibility: 'all', layout: 'spread', order: 'sequence', facing: 'up', label: 'Played', landing: 'play' },
      { id: 'starter', per: 'shared', visibility: 'all', layout: 'stack', order: 'stack', facing: 'up', label: 'Starter' },
    ];
  },

  defaultReactions() {
    return [];
  },

  setup(ctx) {
    const ids = ctx.rng.shuffle([...ctx.pack.cardsById.keys()]);
    for (const id of ids) {
      ctx.zone('draw').cards.push(id);
      ctx.state.cardLocation.set(id, 'draw');
    }
    ctx.setVar('dealer', ctx.openingSeat());
    ctx.dealEach(ctx.rules.deal);
    ctx.setVar('count', 0);
    ctx.setVar('run', []);
    ctx.setPhase('discard');
    // The pone is who the table is waiting on first, even though both may act.
    ctx.setTurnSeat(ctx.nextSeat(ctx.openingSeat(), 1));
  },

  /**
   * The back peg SURVIVES THE DEAL, which is the whole reason this exists.
   *
   * The default round boundary wipes every playerVars entry before re-running
   * setup (src/templates/CONTRACT.md, the `startRound` trap), and the back peg
   * is per-seat state that outlives a hand by definition — it is where you were
   * before your last score, and a hand boundary is not a score.
   */
  startRound(ctx) {
    const back = Array.from({ length: ctx.seats }, (_, s) => ctx.playerVar(s, 'backPeg') ?? 0);
    ctx.state.playerVars = ctx.state.playerVars.map(() => ({}));
    for (let s = 0; s < ctx.seats; s++) ctx.setPlayerVar(s, 'backPeg', back[s]);
    cribbage.setup(ctx);
  },

  validateMove(ctx, move) {
    if (move.type === 'discard') {
      if (ctx.turn.phase !== 'discard') return ctx.fail('phase', 'The crib is already laid.');
      const need = ctx.rules.crib;
      const cards = move.cards || [];
      if (cards.length !== need) return ctx.fail('crib-count', `Give exactly ${need} cards to the crib.`);
      if (new Set(cards).size !== cards.length) return ctx.fail('crib-count', 'The same card twice.');
      const hand = ctx.cardIdsIn(handAddr(ctx, move.actor));
      if (hand.length <= ctx.rules.deal - need) return ctx.fail('already-discarded', 'You have already laid to the crib.');
      if (!cards.every((id) => hand.includes(id))) return ctx.fail('not-in-hand', 'That card is not in your hand.');
      return ctx.ok();
    }

    if (move.type === 'playCard') {
      if (ctx.turn.phase !== 'play') return ctx.fail('phase', 'Not in the play.');
      if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const hand = ctx.cardIdsIn(handAddr(ctx, move.actor));
      if (!hand.includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');
      const { valueOf } = scorersFor(ctx);
      const would = (ctx.var('count') ?? 0) + valueOf(ctx.cardById(cardId));
      if (would > ctx.rules.countTo) {
        return ctx.fail('over-count', `That would take the count past ${ctx.rules.countTo}.`);
      }
      return ctx.ok();
    }

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    if (move.type === 'discard') {
      ctx.moveCards(move.cards.slice(), handAddr(ctx, move.actor), 'crib');
      ctx.emit('laidToCrib', { seat: move.actor, count: move.cards.length });
      const kept = ctx.rules.deal - ctx.rules.crib;
      for (let s = 0; s < ctx.seats; s++) {
        if (ctx.countIn(handAddr(ctx, s)) > kept) return;
      }
      cutStarter(ctx);
      if (ctx.state.roundEnded) return;
      startPlay(ctx);
      return;
    }
    if (move.type === 'playCard') applyPlayCard(ctx, move);
  },

  /**
   * A SHORTLIST FOR THE THROW, not the fifteen ways to pick two of six.
   *
   * Fifteen is small enough to enumerate whole, and here that is the right
   * call rather than a shortlist: this is the most consequential decision in
   * the hand, the enumerator runs twice per deal rather than once per trick,
   * and `scoreDiscard` is a few microseconds. Hearts shortlists its pass
   * because thirteen-choose-three is 286 and goes over the wire; six-choose-two
   * is fifteen and does not.
   */
  enumerateLegalMoves(ctx, seat) {
    if (ctx.turn.phase === 'discard') {
      const hand = ctx.cardIdsIn(handAddr(ctx, seat));
      const need = ctx.rules.crib;
      if (hand.length <= ctx.rules.deal - need) return [];
      const out = [];
      const choose = (start, picked) => {
        if (picked.length === need) {
          out.push({ actor: seat, type: 'discard', cards: picked.slice() });
          return;
        }
        for (let i = start; i < hand.length; i++) {
          picked.push(hand[i]);
          choose(i + 1, picked);
          picked.pop();
        }
      };
      choose(0, []);
      return out;
    }
    if (ctx.turn.phase !== 'play') return [];
    if (seat !== ctx.turn.seat) return [];
    return playableFor(ctx, seat).map((cardId) => ({ actor: seat, type: 'playCard', cards: [cardId] }));
  },

  // The discard is a simultaneous commit (design doc §4): turn.seat does not
  // advance until both seats have laid to the crib, so anybody still holding a
  // full hand may act — not just turn.seat.
  actingSeats(ctx) {
    if (ctx.turn.phase !== 'discard') return [ctx.turn.seat];
    const kept = ctx.rules.deal - ctx.rules.crib;
    const seats = [];
    for (let s = 0; s < ctx.seats; s++) {
      if (ctx.countIn(handAddr(ctx, s)) > kept) seats.push(s);
    }
    return seats.length ? seats : [ctx.turn.seat];
  },

  isRoundOver(ctx) {
    return ctx.state.roundEnded;
  },

  /**
   * The match is decided by the BOARD, not by a round score.
   *
   * Nothing here has a `scoreRound`: holes are pegged the moment they are
   * earned (`peg` above), so `state.scores` is already the board and a round
   * delta would double every point. That is also why the manifest's
   * `scoring.gameOver` says `template` — "anyScore >= 121" evaluated at the
   * round boundary would be the right answer at the wrong moment, and the
   * moment is the rule.
   */
  isGameOver(ctx) {
    for (let s = 0; s < ctx.seats; s++) if (ctx.score(s) >= ctx.rules.target) return true;
    return false;
  },

  /**
   * HOW FAR ALONG THE MATCH A SEAT IS — the rollout's terminal signal
   * (src/engine/CONTRACT.md, "what the `hard` bot asks of you").
   *
   * It has to be exported rather than left to the default for one reason: the
   * default is the accumulated score SIGNED BY `scoring.gameOver.winner`, and
   * this pack's winner is `template`, which the default reads as "points are
   * the penalty". A bot that pegs backwards would be the result, and nothing
   * else in the codebase would notice.
   *
   * Holes ahead of the best opponent: seat-symmetric, public, and the same
   * quantity before and after a deal, which is what lets it be differenced
   * across the round boundary.
   */
  matchStanding(ctx, seat) {
    let best = -Infinity;
    for (let s = 0; s < ctx.seats; s++) {
      if (s === seat) continue;
      best = Math.max(best, ctx.score(s));
    }
    return ctx.score(seat) - (Number.isFinite(best) ? best : 0);
  },

  /* ---------------------------------------------------------------- *
   * What the platform asks this template about itself
   * ---------------------------------------------------------------- */

  interactionMode(ctx) {
    return ctx.turn.phase === 'discard' ? 'pass' : 'tap';
  },

  /**
   * WHAT THE COMMIT BUTTON SAYS, AND HOW MANY CARDS IT WANTS.
   *
   * The `pass` mode used to answer both of those out of `rules.passing` and
   * `vars.passDirection` inside src/ui/interaction.js — trick-taking's own two
   * parameters, read by name in a platform file, which is exactly the shape the
   * contract exists to stop. It only ever looked harmless because trick-taking
   * was the only template using the mode; the second one wants two cards and a
   * crib, not three and a direction.
   */
  commitPrompt(ctx, seat) {
    if (ctx.turn.phase !== 'discard') return null;
    // WHOSE crib, on the button, because it is the entire decision: two cards
    // into your own crib is a gift to yourself and the same two into theirs is
    // a gift to them, and nothing else on the felt says which this is. Kept
    // under ACTION_LABEL_MAX_CHARS (11) — "To their crib" is thirteen and wraps
    // the rail past the fan, which is #13 arriving through the words.
    const owner = dealerOf(ctx) === seat ? 'Your crib' : 'Their crib';
    return {
      count: ctx.rules.crib,
      action: owner,
      // WHOSE CRIB, BEFORE THE DECISION AND NOT AFTER IT (#124, item 42). The
      // button already said it, and the button does not appear until both cards
      // are staged — which is after the only choice in the hand has been made.
      // `dealer` is a public var from the deal onward, so the bar can say it
      // from the first card the player touches. Same two words as the button,
      // so the sentence and the commit agree.
      staging: `${owner} — pick ${ctx.rules.crib}`,
      waiting: 'Waiting for the crib…',
    };
  },

  /**
   * WHAT THE TABLE IS COUNTING — the running total in the play.
   *
   * `count` has been a public var since this template shipped and was drawn
   * nowhere: a player reaching thirty found three of their four cards greyed
   * out with nothing on the felt explaining why, and had to add two spread
   * piles up by eye to get the number every real player says out loud after
   * every card (#124, item 38).
   *
   * Only during the play. In the discard there is no count yet, and at the show
   * the number is a leftover from the last card laid — a stale 24 sitting
   * beside a hand being counted for something else entirely.
   */
  tableCounters(ctx) {
    if (ctx.turn.phase !== 'play') return [];
    const count = ctx.var('count') ?? 0;
    return [{
      label: 'Count',
      text: String(count),
      aria: `The count is ${count}, of ${ctx.rules.countTo}.`,
    }];
  },

  /**
   * THE BOARD, AS A COUNTER.
   *
   * A cribbage board is 121 holes and two pegs a side, and the one thing a
   * player looks at all game. It is not a zone — no card is ever in it — so
   * there was nothing on the felt that could draw it, and inventing a
   * `boardRenderer` hook for one game would have been the `template.id ===`
   * switch the contract exists to prevent.
   *
   * `seatCounters` already asks a template "what is this seat's number", and a
   * board is that number drawn long. `kind: 'peg'` is the platform's own
   * vocabulary (src/ui/counterTrack.js, the same closed-set idea as
   * INTERACTION_MODES) and the felt renders a track from `value`, `from` and
   * `of`. `from` is the back peg: where this seat was before its last score,
   * which is how a cribbage board tells you at a glance how the last hand went.
   */
  seatCounters(ctx, seat) {
    const value = ctx.score(seat);
    const from = ctx.playerVar(seat, 'backPeg') ?? 0;
    const of = ctx.rules.target;
    const hand = ctx.countIn(handAddr(ctx, seat));
    return [
      {
        text: String(value),
        aria: `${value} of ${of}${value > from ? `, up ${value - from}` : ''}`,
        label: 'Pegs',
        kind: 'peg',
        value,
        from,
        of,
      },
      {
        text: String(hand),
        aria: `${hand} ${hand === 1 ? 'card' : 'cards'} in hand`,
        label: 'Cards',
        kind: 'hand',
        minimizedOnly: true,
      },
    ];
  },

  ruleLines(rules) {
    return [
      `Each player throws ${rules.crib} cards to the crib, which belongs to the dealer.`,
      `In the play, cards go down one at a time and the count runs to ${rules.countTo}: `
      + 'fifteen scores 2, thirty-one scores 2, and pairs and runs score as they are made.',
      'At the show the non-dealer counts first, then the dealer, then the crib — '
      + 'which is who wins a close game.',
    ];
  },

  endingLines(pack) {
    const target = pack?.rules?.target ?? 121;
    return [`First player to peg ${target} holes wins — the moment they get there, not at the end of the hand.`];
  },

  botVerbs: { discard: 'threw to the crib' },

  /**
   * THE NARRATION. Every one of these is a moment a player at a real table
   * would say something out loud, which is the test for whether it earns a
   * banner: "fifteen two", "go", "two for his heels".
   */
  describeEvent(ev, { seatLabel, seatPossessive, seatVerb }) {
    if (ev.type === 'pegPlay' && ev.points) {
      // WHAT SCORED, not just how much (#124, item 41). "Nell pegs 2" is the
      // same sentence for a fifteen, a pair and a run, and at a real table
      // those are three completely different things to have happened to you —
      // a pair says she is holding another one, a run says the sequence is
      // live. `parts` has been on the event since the template shipped.
      //
      // `seatVerb`, not `${seatLabel(seat)} pegs`: "You" takes the bare verb.
      // Same irregularity as `seatPossessive` below, one part of speech over.
      const what = namedParts(ev.parts);
      return {
        text: `${seatLabel(ev.seat)} ${seatVerb(ev.seat, 'peg')} ${ev.points}`
          + `${what ? ` — ${what}` : ''} — the count is ${ev.count}.`,
        tone: 'good',
      };
    }
    if (ev.type === 'go' && ev.closes) return { text: `Go — one for ${seatLabel(ev.seat)}.`, tone: 'neutral' };
    if (ev.type === 'hisHeels') return { text: `Two for his heels — ${seatLabel(ev.seat)}.`, tone: 'good' };
    // The last card is a hole nobody was told about: it is pegged inside
    // `advancePlay` with no event of its own beyond `pegged`, so the only
    // narration was a score silently changing.
    if (ev.type === 'pegged' && ev.reason === 'last-card') {
      return { text: `One for the last card — ${seatLabel(ev.seat)}.`, tone: 'neutral' };
    }
    if (ev.type === 'showScored') {
      // `seatPossessive`, not `${seatLabel(seat)}'s`. This table calls the local
      // player "You", and "You" is the one label in the vocabulary that does not
      // take an apostrophe-s — so the hand-built possessive said "You's hand is
      // worth 2." on the felt, in this issue's own screenshot. Whose name it is
      // and how to inflect it are both the table's business (src/ui/table.js).
      const whose = ev.isCrib ? `${seatPossessive(ev.seat)} crib` : `${seatPossessive(ev.seat)} hand`;
      // The breakdown, in the same voice. "His nobs" is in this pack's own
      // tagline and its manifest and had never once appeared on the felt: it
      // only ever comes out of `scoreHand`, and the show said a number.
      const what = namedParts(ev.parts);
      return {
        text: `${whose} is worth ${ev.points}${what ? ` — ${what}` : ''}.`,
        tone: ev.points ? 'good' : 'neutral',
      };
    }
    return null;
  },

  botHeuristic(ctx, move, w = WEIGHTS) {
    if (move.type === 'discard') return scoreDiscard(ctx, move, w);

    // IMMEDIATE PEGGING, which is most of what pegging is. What the card scores
    // as it lands, less what it hands the opponent: leaving the count on
    // twenty-one is the classic gift, because any ten-card makes thirty-one.
    const { valueOf, orderOf } = scorersFor(ctx);
    const run = [...(ctx.var('run') || []), move.cards[0]].map((id) => ctx.cardById(id));
    const { total, count } = scorePlay(run, { valueOf, orderOf, parts: false });

    let score = total * w.PEGGED_WORTH;
    // A count the opponent can reach fifteen or thirty-one from is a count you
    // paid for. Priced off the pack's own values rather than a table of tens.
    const limit = ctx.rules.countTo;
    let exposure = 0;
    for (const card of ctx.pack.cardsById.values()) {
      const after = count + valueOf(card);
      if (after === 15 || after === limit) exposure++;
    }
    score -= (exposure / ctx.pack.cardsById.size) * w.PEGGED_WORTH * 2;
    score += ctx.countIn(handAddr(ctx, move.actor)) * w.OPTION_WORTH;
    return score;
  },

  /**
   * HOW GOOD THIS POSITION IS FOR `seat`, in holes — higher is better.
   *
   * WHAT `botHeuristic` CANNOT SAY. It grades a card by what it pegs and what
   * it exposes, and it has no idea whose crib this is, how many holes are left,
   * or what the four cards still in hand are going to be worth when they are
   * counted a second time at the show. Those are the three things that decide a
   * cribbage hand, and they are all properties of the POSITION.
   *
   * WHAT IT DELIBERATELY DOES NOT READ: the opponent's hand, the crib (which is
   * `visibility: 'none'` and hidden from its owner too until the show), and the
   * order of the deck the starter has yet to come off. It reads its own hand,
   * its own played cards, the starter once turned, and both boards — which is
   * everything a player can see from their chair.
   */
  evaluateState(ctx, seat, w = WEIGHTS) {
    const { valueOf, orderOf, isNobs } = scorersFor(ctx);
    const starterId = ctx.cardIdsIn('starter')[0];
    const starter = starterId ? ctx.cardById(starterId) : null;

    let score = ctx.score(seat) * w.PEGGED_WORTH;
    let best = -Infinity;
    for (let s = 0; s < ctx.seats; s++) {
      if (s === seat) continue;
      score -= ctx.score(s) * w.PEGGED_WORTH / Math.max(1, ctx.seats - 1);
      best = Math.max(best, ctx.score(s));
    }
    if (Number.isFinite(best)) score += (ctx.score(seat) - best) * w.LEAD_WORTH;

    // What is still to come at the show. During the play the four cards are
    // split between hand and the seat's own played pile, and both halves count
    // — they are the same four cards and they will be scored together.
    const mine = [
      ...ctx.cardsIn(handAddr(ctx, seat)),
      ...ctx.cardsIn(playAddr(ctx, seat)),
    ];
    if (mine.length) {
      const promise = scoreHand(mine, starter, { valueOf, orderOf, isNobs, parts: false }).total;
      score += promise * w.PROMISE_WORTH;
    }

    // Owning the crib is worth about four and a half holes to whoever owns it,
    // and it is only still to come while the show has not happened.
    if (ctx.turn.phase !== 'show') {
      score += (dealerOf(ctx) === seat ? 1 : -1) * w.CRIB_WORTH * w.PROMISE_WORTH;
    }

    score += ctx.countIn(handAddr(ctx, seat)) * w.OPTION_WORTH;
    return score;
  },

  /** The strategy's numbers, for a caller that wants to play with different ones. */
  weights: WEIGHTS,
};

export default cribbage;
