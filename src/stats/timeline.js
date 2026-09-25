// THE MATCH AS A MAP — hands, turns and moves, and the position at any of them.
//
// The review UI (src/ui/reviewController.js, REVIEW_PLAN.md phase 3) needs two
// things of a match: a LIST it can scroll — what happened, in order, grouped
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
const MARKS = new Set(['trickWon', 'roundOver', 'showScored', 'announced', 'caught', 'wildPlayed', 'instantWin', 'trickCleared', 'cardsPassed', 'go', 'passed', 'combinationPlayed']);

/**
 * The events that CLOSE a beat — the unit of contest the map is read in.
 *
 * A trick is taken (`trickWon`), a Thirteen pile is cleared by everybody
 * passing (`trickCleared`), a cribbage count is closed by a go or a 31 (`go`
 * with `closes`), the pass is complete (`cardsPassed`), the hand ends. Each is
 * an event the template already emits for the felt's own narration; the map
 * reads them rather than asking the template what a trick is.
 */
function closes(mark) {
  switch (mark.type) {
    case 'trickWon': case 'trickCleared': case 'cardsPassed': case 'roundOver': return true;
    case 'go': return !!mark.closes;
    default: return false;
  }
}

/** A move's class, for the beats a hand splits into before any card is led. */
function classOf(type) {
  if (type === 'bid') return 'bidding';
  if (type === 'passCards') return 'pass';
  if (type === 'declareMeld') return 'meld';
  return 'play';
}

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
  // Did the move before this one close a beat? The seat that takes a trick
  // leads the next, so its fourth card and its lead are consecutive moves by
  // one actor — and two turns, because "the beginning of a turn" a player
  // asks to go back to is the lead, not the gather before it.
  let closed = false;

  snapshot.log.forEach((move, i) => {
    applyMove(state, move);
    const index = i + 1;
    const hand = hands.length;
    if (!turn || turn.seat !== move.actor || turn.hand !== hand || closed) {
      turn = { hand, seat: move.actor, from: i, to: index };
      turns.push(turn);
    } else {
      turn.to = index;
    }
    closed = state.events.some((e) => closes(e));
    const marks = state.events
      .filter((e) => MARKS.has(e.type))
      .map((e) => ({
        type: e.type, seat: e.seat ?? null, points: e.points ?? null, over: e.over ?? null,
        label: e.label ?? null, closes: e.closes ?? null,
        cards: Array.isArray(e.cards) ? e.cards.slice() : null,
      }));
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

  const timeline = {
    seats: snapshot.seats,
    length: snapshot.log.length,
    hands,
    turns,
    moves,
    gameOver: state.gameOver,
    winner: state.winner,
  };
  timeline.beats = beatsOf(timeline);
  return timeline;
}

/**
 * THE BEATS: a hand read as the units a player remembers it in.
 *
 * A Thirteen hand is fifty turns and most of them are "passed"; what a player
 * remembers is a dozen tricks and who took each one with what. So the map
 * groups turns into beats — a trick where the pack has one, a count at
 * cribbage, the pass and the bidding where a hand starts with those, and a LAP
 * of the table (one turn each round) at the packs where nobody takes anything
 * (Crazy Eights, Milestones, Stockpile).
 *
 * WHAT WINS ONE. A trick is won by the seat the closing mark names — the
 * template's own verdict — and the winning cards are what that seat played in
 * the beat. A Thirteen hand that ends with somebody going out has no
 * `trickCleared` on its last pile; the seat that went out won it. A lap has no
 * winner, and the map shows every card in it instead.
 *
 * @returns Array<{ hand, kind, n, from, to, winner, winning, points, plays }>
 *   where `plays` are the turns inside it, each `{ from, to, seat, cards,
 *   passed, won }`, and `kind` is 'trick' | 'count' | 'lap' | 'pass' |
 *   'bidding' | 'meld'.
 */
export function beatsOf(timeline) {
  const beats = [];
  for (const [h, hand] of timeline.hands.entries()) {
    const turns = timeline.turns.filter((t) => t.hand === h);
    const lastMove = (turn) => timeline.moves[turn.to - 1];
    const closerOf = (turn) => lastMove(turn).marks.find((m) => closes(m) && m.type !== 'roundOver') || null;
    // Tricks and counts are cut by the closers; a hand with no closer at all is
    // a lap pack.
    const hasClosers = turns.some((t) => closerOf(t));
    let open = null;
    const counts = {};
    const start = (turn, kind) => {
      counts[kind] = (counts[kind] || 0) + 1;
      open = { hand: h, kind, n: counts[kind], from: turn.from, to: turn.to, winner: null, winning: [], points: null, plays: [] };
      beats.push(open);
    };
    const seen = new Set();
    for (const turn of turns) {
      const cls = classOf(timeline.moves[turn.from].type);
      const kind = cls !== 'play' ? cls : (hasClosers ? (closerOf(turn)?.type === 'go' || (open?.kind === 'count') ? 'count' : 'trick') : 'lap');
      // A NEW BEAT when the class changes (the pass ends, the bidding ends),
      // when a lap comes round to a seat already in it, or after a closer.
      const lapWraps = kind === 'lap' && seen.has(turn.seat);
      if (!open || open.kind !== kind || lapWraps) {
        if (kind === 'lap') seen.clear();
        start(turn, kind);
      }
      seen.add(turn.seat);
      const moves = timeline.moves.slice(turn.from, turn.to);
      const played = moves.flatMap((m) => m.cards);
      const passed = moves.every((m) => m.type === 'pass') && played.length === 0;
      open.plays.push({ from: turn.from, to: turn.to, seat: turn.seat, cards: played, passed, won: false });
      open.to = turn.to;
      const closer = closerOf(turn);
      if (closer) {
        open.winner = closer.seat ?? null;
        open.points = closer.points ?? null;
        open = null;
      }
    }
    // The pile nobody cleared because the hand ended on it: the seat that went
    // out won it, with the cards it went out on.
    const last = beats[beats.length - 1];
    if (last && last.hand === h && last.kind === 'trick' && last.winner == null) {
      const lastPlay = [...last.plays].reverse().find((p) => !p.passed);
      if (lastPlay) last.winner = lastPlay.seat;
    }
  }
  // The winning cards: what the winner played in the beat, and which play it was.
  for (const beat of beats) {
    if (beat.winner == null) continue;
    const mine = beat.plays.filter((p) => p.seat === beat.winner && !p.passed);
    const won = mine[mine.length - 1] || null;
    if (won) { won.won = true; beat.winning = won.cards.slice(); }
  }
  return beats;
}

/** The beat a position stands in; the last one at the end. */
export function beatAt(timeline, n) {
  return timeline.beats.find((b) => b.from <= n && n < b.to)
    || timeline.beats[timeline.beats.length - 1]
    || null;
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
