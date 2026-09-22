// THE MATCH AS A MAP — hands, turns and moves, and the position at any of them.
//
// The review UI (src/ui/table.js's review mode, REVIEW_PLAN.md phase 3) needs
// two things of a match: a LIST it can scroll — what happened, in order, grouped
// the way a player thinks about a game — and a way to stand the felt at the
// start of any turn in it. Both come out of the log alone.
//
// NOTHING IS STORED PER POSITION, and that is the design rather than a
// shortcut. A whole match replays through `rehydrateMatch` in single-digit
// milliseconds (REVIEW_PLAN.md measured five packs: 0.5–3.2ms for 80–757
// moves), so "the position after N moves" is `replay the first N moves`, every
// time, with no checkpoints, no cache and nothing that can go stale. The log is
// the match (src/engine/replay.js) and this file is a reading of it.
//
// THE VOCABULARY. A MOVE is one log entry. A TURN is a maximal run of
// consecutive moves by one actor inside one hand — a rummy turn is draw then
// discard, a Hearts pass is three turns of one commit each, a trick-taking turn
// is one card. "The beginning of a turn" is the position before its first move,
// which is what a player asks to go back to. A HAND is the moves between two
// `roundOver` events (the engine's round). A POSITION is a count of moves
// applied: 0 is the deal, `length` is the end.
//
// NODE-CLEAN, like src/stats/matchStats.js and for the same reason: everything
// here is arithmetic over a log, and arithmetic is what a test can pin.

import { createState } from '../engine/state.js';
import { makeCtx } from '../engine/context.js';
import { applyMove } from '../engine/movePipeline.js';
import { rehydrateMatch } from '../engine/replay.js';
import { baseId } from '../engine/selectors.js';
import { cardName } from '../ui/describe.js';

/** The events worth a glyph on the map, and what the map shows of each. */
const MARKS = new Set(['trickWon', 'roundOver', 'showScored', 'announced', 'caught', 'wildPlayed', 'instantWin', 'trickCleared']);

/** The same table src/ui/botDriver.js reads for the bar, for a move's verb. */
const VERBS = {
  playCard: 'played', draw: 'drew', discard: 'discarded', pass: 'passed', layDown: 'laid down',
  hit: 'hit', commit: 'committed', bid: 'bid', announce: 'announced', challenge: 'challenged', keep: 'kept',
};

function verbOf(pack, type) {
  return pack.template?.botVerbs?.[type] || VERBS[type] || type;
}

function namesOf(pack, ids) {
  return (ids || []).map((id) => cardName(pack.cardsById.get(baseId(String(id))))).join(', ');
}

/**
 * One move as one short sentence: who, what, which cards.
 *
 * Deliberately plain. The felt's own narration (`describeEvent`, the banners)
 * is written for the moment a thing happens; a map row is read out of context
 * and in a column of forty others, so it says the fact and leaves the drama to
 * the marks beside it.
 */
function narrate(pack, move, labelOf) {
  const who = labelOf(move.actor);
  const names = namesOf(pack, move.cards);
  switch (move.type) {
    case 'draw': {
      const from = typeof move.from === 'string' && move.from.startsWith('discard') ? 'the discard pile' : 'the deck';
      return `${who} drew from ${from}`;
    }
    case 'pass': return `${who} passed`;
    case 'bid': return `${who} bid ${move.bid === 0 ? 'nil' : (move.bid ?? move.value ?? '')}`.trim();
    case 'playCard': {
      const suit = move.choice?.suit ? `, calling ${move.choice.suit}` : '';
      return `${who} played ${names}${suit}`;
    }
    default: return `${who} ${verbOf(pack, move.type)}${names ? ` ${names}` : ''}`;
  }
}

/**
 * The map of a match.
 *
 * @param pack     the loaded pack, carrying `snapshot.variants`
 * @param snapshot a serializeMatch() payload
 * @param labelOf  (seat) => the name the map prints — the table's own
 *                 `seatLabel`, so "You" is you
 * @returns {{ seats, length, hands, turns, moves, gameOver, winner }} where
 *   `hands[k]` is `{ round, from, to, scores, totals, over, live }` (move index
 *   ranges: the hand is moves `from..to-1`), `turns[t]` is `{ hand, seat, from,
 *   to }`, and `moves[i]` is `{ index, seat, type, cards, hand, turn, text,
 *   marks, totals }` with `index = i + 1`, the position AFTER it.
 */
export function matchTimeline(pack, snapshot, { labelOf = (seat) => `Seat ${seat + 1}` } = {}) {
  const state = createState({ pack, seats: snapshot.seats, seed: snapshot.seed });
  pack.template.setup(makeCtx(state));

  const moves = [];
  const hands = [];
  const turns = [];
  let handFrom = 0;
  let turn = null;

  snapshot.log.forEach((move, i) => {
    applyMove(state, move);
    const index = i + 1;
    const hand = hands.length;
    if (!turn || turn.seat !== move.actor || turn.hand !== hand) {
      turn = { hand, seat: move.actor, from: i, to: index };
      turns.push(turn);
    } else {
      turn.to = index;
    }
    const marks = state.events
      .filter((e) => MARKS.has(e.type))
      .map((e) => ({ type: e.type, seat: e.seat ?? null, points: e.points ?? null, over: e.over ?? null, label: e.label ?? null }));
    moves.push({
      index,
      seat: move.actor,
      type: move.type,
      cards: Array.isArray(move.cards) ? move.cards.slice() : [],
      hand,
      turn: turns.length - 1,
      text: narrate(pack, move, labelOf),
      marks,
      totals: state.scores.slice(),
    });
    const over = state.events.find((e) => e.type === 'roundOver');
    if (over) {
      hands.push({
        round: over.round, from: handFrom, to: index,
        scores: { ...over.scores }, totals: over.totals.slice(), over: !!over.over, live: false,
      });
      handFrom = index;
      turn = null;
    }
  });
  // The hand still being played, when the match is not over: a map of a live
  // game ends at the position the table is standing at.
  if (!state.gameOver && (handFrom < snapshot.log.length || hands.length === 0)) {
    hands.push({
      round: state.roundNumber, from: handFrom, to: snapshot.log.length,
      scores: null, totals: state.scores.slice(), over: false, live: true,
    });
  }

  return {
    seats: snapshot.seats,
    length: snapshot.log.length,
    hands,
    turns,
    moves,
    gameOver: state.gameOver,
    winner: state.winner,
  };
}

/** The state after the first `n` moves — a fresh state with a fresh log. */
export function positionAt(pack, snapshot, n) {
  const count = Math.max(0, Math.min(snapshot.log.length, n | 0));
  return rehydrateMatch(pack, { ...snapshot, log: snapshot.log.slice(0, count) });
}

/** The turn a position stands at the start of or inside, or null at the end. */
export function turnAt(timeline, n) {
  return timeline.turns.find((t) => t.from <= n && n < t.to) || null;
}

/** The hand a position is in; the last hand at the end. */
export function handAt(timeline, n) {
  return timeline.hands.find((h) => h.from <= n && n < h.to)
    || timeline.hands[timeline.hands.length - 1]
    || null;
}

/**
 * Where the reel's four buttons go from `n`: the start of the previous and next
 * turn and hand, or null where there is nothing that way.
 *
 * "Previous turn" from the middle of a turn is that turn's own start, which is
 * the answer a player wants from a scrub that landed mid-turn; from a turn's
 * start it is the one before.
 */
export function seekTargets(timeline, n) {
  const turnStarts = timeline.turns.map((t) => t.from);
  const handStarts = timeline.hands.map((h) => h.from);
  const before = (starts) => { let best = null; for (const s of starts) { if (s < n) best = s; } return best; };
  const after = (starts) => starts.find((s) => s > n) ?? (n < timeline.length ? timeline.length : null);
  return {
    prevTurn: before(turnStarts),
    nextTurn: after(turnStarts),
    prevHand: before(handStarts),
    nextHand: after(handStarts),
  };
}

/** "Hand 3 · Nell to play", or "The end" — the reel's own caption. */
export function positionLabel(timeline, n, labelOf) {
  if (n >= timeline.length && (timeline.gameOver || !timeline.turns.length)) return 'The end';
  const hand = handAt(timeline, n);
  const turn = turnAt(timeline, n);
  const handWord = hand ? `Hand ${hand.round}` : 'Hand 1';
  if (!turn) return `${handWord} · now`;
  return `${handWord} · ${labelOf(turn.seat)} to play`;
}
