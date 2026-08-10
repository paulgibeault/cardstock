// Trick-taking template (design doc §13.1). Validates against Hearts.
// Follow suit, resolve the trick to a winner, that winner leads next. Lead/play
// constraints relax automatically when they'd leave the actor with zero legal cards
// (design doc §5).

import { rankOrder } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { cardValue } from '../engine/scoring.js';

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

function seatsForTrick(ctx, leader, count) {
  const seats = [];
  let seat = leader;
  for (let i = 0; i < count; i++) {
    seats.push(seat);
    seat = ctx.nextSeat(seat);
  }
  return seats;
}

function resolveTrick(ctx) {
  const trickCards = ctx.cardIdsIn('trick').slice();
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
      // The full combinatorial pass-choice space is a client/bot-strategy concern, not
      // an engine one — offer the single "pass your N highest cards" move so a bot (or
      // a headless simulation) always has a legal action here.
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
      const count = ctx.rules.passing.count;
      const cards = hand
        .slice()
        .sort((a, b) => rankOrder(ctx.cardById(b)) - rankOrder(ctx.cardById(a)))
        .slice(0, count);
      return [{ actor: seat, type: 'passCards', cards }];
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

  botHeuristic(ctx, move) {
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
};

export default trickTaking;
