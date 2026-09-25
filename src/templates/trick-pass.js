// THE PASS, as one of the trick-taking template's optional phases (#224).
//
// A phase module: the core (src/templates/trick-taking.js) holds the phase list
// and composes these slices onto its hooks — see the PHASE MODULE comment there
// for what each member means. Nothing outside this file knows the pass exists,
// and nothing in here knows what any other phase does.
//
// Everything below was lifted out of trick-taking.js unchanged.

import { rankLadderOf, rankOrder } from '../engine/cards.js';
import { cardValue } from '../engine/scoring.js';
import { isLiability, perilRankBySuit } from './trick-shared.js';

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

/** This phase's share of `template.weights`, merged onto the bag by the core. */
export const PASS_WEIGHTS = { PASS_VALUE_WORTH, PASS_LIABILITY_WORTH, PASS_VOID_WORTH };

function scorePass(ctx, move, w) {
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

function passTarget(ctx, seat, direction) {
  if (direction === 'left') return ctx.nextSeat(seat, 1);
  if (direction === 'right') return ctx.nextSeat(seat, -1);
  if (direction === 'across') return (seat + Math.floor(ctx.seats / 2)) % ctx.seats;
  return seat;
}

function passDirectionForRound(ctx) {
  const passing = ctx.rules.passing;
  if (!passing) return null;
  const idx = (ctx.roundNumber() - 1) % passing.schedule.length;
  return passing.schedule[idx];
}

export const passPhase = {
  id: 'pass',
  moveType: 'passCards',
  botVerbs: { passCards: 'passed' },
  /** Which way the pass goes is a fact of the table (src/engine/view.js). */
  publicVars: ['passDirection'],
  // A commit-by-button phase: pick cards out of the fan, watch them stage,
  // commit with the action button (src/ui/interaction.js).
  interactionMode: 'pass',
  weights: PASS_WEIGHTS,

  /**
   * A SCHEDULE, NOT A FLAG. A pack passes left this round and across the next,
   * and a round whose direction is `none` has no phase at all — which is why
   * this asks the schedule rather than `rules.passing` and is the one `start`
   * that can be absent on a pack that declares the rule.
   */
  start(ctx) {
    const direction = passDirectionForRound(ctx);
    if (!direction || direction === 'none') return false;
    ctx.setVar('passDirection', direction);
    ctx.setPhase('pass');
    return true;
  },

  validate(ctx, move) {
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
  },

  apply(ctx, move, advance) {
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
    advance();
  },

  enumerate(ctx, seat) {
    if (ctx.playerVar(seat, '__pendingPass') !== undefined) return [];
    // A SHORTLIST, NOT THE SPACE — see passCandidates for what is on it and
    // why the full thirteen-choose-three is not. A human is not restricted to
    // it: the pass is a commit-by-button phase and the table builds the move
    // from whatever N cards were tapped (src/ui/interaction.js), which
    // validateMove judges on its own terms.
    return passCandidates(ctx, seat).map((cards) => ({ actor: seat, type: 'passCards', cards }));
  },

  // Simultaneous-commit phase (design doc §4): turn.seat doesn't advance until every
  // seat has passed, so any seat that hasn't committed yet may act — not just turn.seat.
  actingSeats(ctx) {
    const seats = [];
    for (let s = 0; s < ctx.seats; s++) {
      if (ctx.playerVar(s, '__pendingPass') === undefined) seats.push(s);
    }
    return seats;
  },

  /**
   * THE PASS (#107): how many cards it wants and which way it goes were being
   * read by name out of `rules.passing` and `vars.passDirection` inside
   * src/ui/interaction.js and src/ui/table.js. Nothing changes on the felt: the
   * button still says "Pass left" and the status bar still says "Passing —
   * pick 3". What changes is that a second template using the same mode no
   * longer inherits a count of three and a direction it does not have. The
   * label stays under ACTION_LABEL_MAX_CHARS — "Pass across" is eleven — which
   * is why the count is in the status line and not on the button.
   */
  commitPrompt(ctx) {
    const count = ctx.rules.passing?.count ?? 3;
    const direction = { left: 'left', right: 'right', across: 'across' }[ctx.var('passDirection')] || '';
    return {
      count,
      action: `Pass ${direction}`.trim(),
      staging: `Passing — pick ${count}`,
      waiting: 'Waiting for passes…',
    };
  },

  /**
   * The cards this seat has committed but not yet played — drawn as chosen, and
   * NOT re-choosable. The private `__pendingPass` var is this phase's
   * bookkeeping; the table was reading it directly in three places, double
   * underscore and all.
   */
  committed(ctx, seat) {
    return ctx.playerVar(seat, '__pendingPass');
  },

  /**
   * A pass is N cards or it is nothing: scoring it by `cards[0]` was correct
   * only while the enumerator offered exactly one pass, and would now rank
   * five whole passes by an accident of sort order.
   */
  score(ctx, move, w) {
    return scorePass(ctx, move, w);
  },

  /**
   * THE PASS IS A COMMIT, NOT A POSITION. Nothing has moved; the only thing
   * that changed is the cards this seat has promised away, so score exactly
   * those — with the pass scorer above, which is a Phase 1 measurement and
   * has nothing to gain from one ply of lookahead. (The commit that COMPLETES
   * the swap never arrives here: it turns up three cards out of other
   * people's hands, and the lookahead refuses to judge a position that
   * revealed cards this seat could not see.)
   *
   * `undefined` — not null — for a position this phase has nothing to say
   * about: null is an evaluator DECLINING a position it understands, and the
   * core has to be able to tell the two apart.
   */
  evaluate(ctx, seat, w) {
    const pending = ctx.playerVar(seat, '__pendingPass');
    return pending ? scorePass(ctx, { actor: seat, cards: pending }, w) : undefined;
  },

  ruleLines(rules) {
    if (!rules.passing) return [];
    return [`Before play, pass ${rules.passing.count ?? 3} cards to another player.`];
  },
};
