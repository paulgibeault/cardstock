// Trick-taking template (design doc §13.1). Validates against Hearts.
// Follow suit, resolve the trick to a winner, that winner leads next. Lead/play
// constraints relax automatically when they'd leave the actor with zero legal cards
// (design doc §5).

import { rankOrder } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { cardValue, handValue } from '../engine/scoring.js';

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

// Cards the actor may follow with, before lead/play constraints: the must-follow
// subset when they can follow suit, otherwise (void, or leading) the whole hand.
function baseLegalCards(ctx, seat, hand) {
  const isLead = ctx.countIn('trick') === 0;
  if (isLead) return hand.slice();
  const led = ctx.var('led');
  if (ctx.rules.followSuit === 'must' && led) {
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
    if (ctx.rules.followSuit === 'must' && led) {
      const matching = hand.filter((id) => ctx.cardById(id).suit === led);
      if (matching.length && !matching.includes(cardId)) {
        return ctx.fail('follow-suit', `You must follow suit (${led}).`);
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
  const peril = new Map();
  let topRank = 0;
  for (const card of ctx.pack.cardsById.values()) {
    const rank = rankOrder(card);
    if (rank > topRank) topRank = rank;
    if (!card.suit || cardValue(card, scoring) <= 0) continue;
    if (rank > (peril.get(card.suit) ?? -Infinity)) peril.set(card.suit, rank);
  }
  cached = { peril, topRank };
  packPeril.set(ctx.pack, cached);
  return cached;
}

function perilRankBySuit(ctx) {
  return perilOf(ctx).peril;
}

function isLiability(ctx, card, peril) {
  const bar = peril.get(card.suit);
  return bar !== undefined && rankOrder(card) > bar;
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
  const value = (card) => cardValue(card, scoring);

  const byRank = mostPassableFirst(ctx, hand, (card) => rankOrder(card));
  const byValue = mostPassableFirst(ctx, hand, (card) => value(card) * 100 + rankOrder(card));
  const byLiability = mostPassableFirst(ctx, hand,
    (card) => (isLiability(ctx, card, peril) ? 10000 : 0) + value(card) * 100 + rankOrder(card));

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
});

function scorePass(ctx, move, w = WEIGHTS) {
  const scoring = ctx.pack.scoring || {};
  const peril = perilRankBySuit(ctx);
  const going = new Set(move.cards);

  let score = 0;
  for (const id of move.cards) {
    const card = ctx.cardById(id);
    score += rankOrder(card);
    score += cardValue(card, scoring) * w.PASS_VALUE_WORTH;
    if (isLiability(ctx, card, peril)) score += w.PASS_LIABILITY_WORTH;
  }

  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
  const before = suitCounts(ctx, hand);
  const after = suitCounts(ctx, hand.filter((id) => !going.has(id)));
  for (const suit of before.keys()) if (!after.has(suit)) score += w.PASS_VOID_WORTH;

  return score;
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

  let winnerSeat = leader;
  let bestRank = -1;
  for (let i = 0; i < trickCards.length; i++) {
    const card = ctx.cardById(trickCards[i]);
    if (card.suit !== led) continue;
    // Within the led suit, every rank ladder agrees — see rankOrder in
    // src/engine/cards.js for why the standard-52 array is no longer the only
    // answer, and why deck order is the last of the three rather than the first.
    const rank = rankOrder(card);
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
  startPlayPhase(ctx);
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
  let seat = ctx.openingSeat();
  for (const id of ids) {
    const addr = ctx.zoneAddr('hand', seat);
    ctx.zone(addr).cards.push(id);
    ctx.state.cardLocation.set(id, addr);
    seat = ctx.nextSeat(seat, 1);
  }
}

const trickTaking = {
  id: 'trick-taking',

  // Which shared vars a peer may see (src/engine/view.js). Who leads, what was
  // led and which way the pass goes are all facts of the table.
  publicVars: (rules) => ['leader', 'led', 'trickNumber', 'passDirection',
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
    startPlayPhase(ctx);
  },

  validateMove(ctx, move) {
    if (move.type === 'playCard') {
      if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!hand.includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');

      const rejection = rejectPlayCard(ctx, move.actor, cardId, hand);
      if (rejection) return rejection;
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

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    if (move.type === 'playCard') applyPlayCard(ctx, move);
    else if (move.type === 'passCards') applyPassCards(ctx, move);
  },

  enumerateLegalMoves(ctx, seat) {
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
  actingSeats(ctx) {
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
    return ctx.turn.phase === 'pass' ? 'pass' : 'tap';
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
    return ctx.playerVar(seat, '__pendingPass') ?? null;
  },

  ruleLines(rules) {
    const out = ['Everyone plays one card; the highest card of the suit that was led takes the trick.'];
    if (rules.followSuit === 'must') out.push('Follow the suit that was led if you can.');
    if (rules.passing) {
      out.push(`Before play, pass ${rules.passing.count ?? 3} cards to another player.`);
    }
    return out;
  },

  endingLines() {
    return [];
  },

  botVerbs: { passCards: 'passed' },

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
    const card = ctx.cardById(move.cards[0]);
    // Play low, and shed anything the pack charges you for holding. The second
    // clause used to be `card.tags?.includes('penalty')` — Hearts' own tag name,
    // hardcoded into the template, and worth exactly −5 whether the card was a
    // two of hearts or the queen of spades. The pack's scoring config already
    // says what each card costs, so it says it here too.
    let score = -rankOrder(card);
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
    const { peril, topRank } = perilOf(ctx);
    const taking = trickLeaderSoFar(ctx);
    if (taking.seat === seat) {
      const trickIds = ctx.cardIdsIn('trick');
      let inTrick = 0;
      for (const id of trickIds) inTrick += cardValue(ctx.cardById(id), scoring);
      const yetToPlay = Math.max(0, ctx.seats - trickIds.length);
      const holds = topRank > 0 ? Math.max(0, taking.rank) / topRank : 1;
      score -= (inTrick * w.AT_RISK_WORTH + yetToPlay * w.LOOSE_POINT_RISK) * holds;
    }

    // What is still in hand is a bill that has not come in yet.
    for (const id of ctx.cardIdsIn(ctx.zoneAddr('hand', seat))) {
      const card = ctx.cardById(id);
      score -= cardValue(card, scoring) * w.HELD_VALUE_WORTH;
      if (isLiability(ctx, card, peril)) score -= w.HELD_LIABILITY_WORTH;
    }

    // Cheaper than the cheapest opponent is the only kind of ahead there is
    // when everybody is trying to take nothing.
    let rival = Infinity;
    for (let s = 0; s < ctx.seats; s++) {
      if (s === seat) continue;
      rival = Math.min(rival, handValue(ctx.cardsIn(ctx.zoneAddr('won', s)), scoring));
    }
    return Number.isFinite(rival) ? score + rival * w.RIVAL_SHARE : score;
  },

  /** The strategy's numbers, for a caller that wants to play with different ones. */
  weights: WEIGHTS,
};

export default trickTaking;
