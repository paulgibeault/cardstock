// What happened in a match, derived from its log.
//
// THE EVENT-SOURCING PAYOFF, CASHED. Nothing here is tallied during play.
// There is no counter incremented beside a move, no shadow bookkeeping to
// forget to update when a new move type lands, and therefore no way for the
// numbers to drift from the game that was actually played: the log IS the
// match (src/engine/replay.js), so replaying it through the ordinary reducer
// regenerates every event the table ever saw — tricks won, piles recycled,
// rounds scored — and the counting happens once, at the end, off the hot path.
//
// It also means stats work on any match payload, not just the live one: a
// resumed game, a finished game, and (when Phase 8 lands) a peer's snapshot
// all arrive in the same shape and all answer the same questions.
//
// NODE-CLEAN. No DOM, no Arcade, no card art — this is engine-adjacent code
// and imports like it, so `node --test` can pin it against fixture logs
// (design doc §17.10: the engine core stays browser-free).

import { createState } from '../engine/state.js';
import { makeCtx } from '../engine/context.js';
import { applyMove } from '../engine/movePipeline.js';
import { handValue } from '../engine/scoring.js';
import { baseId } from '../engine/selectors.js';

function emptySeatStats() {
  return {
    moves: 0,
    cardsPlayed: 0,
    draws: 0,
    discards: 0,
    // trick-taking
    tricksWon: 0,
    pointsTaken: 0,
    // shedding
    effectsPlayed: 0,
    // contract-rummy
    meldsLaid: 0,
    hits: 0,
    phaseReached: null,
    // sequencing
    buildPlays: 0,
    stockLeft: null,
    // announcements (§E2)
    declared: 0,
    caughtOthers: 0,
    wasCaught: 0,
  };
}

/**
 * Replay `snapshot` and count everything on the way past.
 *
 * @param pack     the loaded pack, already carrying `snapshot.variants`
 * @param snapshot a serializeMatch() payload
 * @returns { seats, rounds, perSeat, totals, winner, gameOver, moves }
 * @throws   whatever the reducer throws on a log the current rules refuse —
 *           the caller treats that the same way resuming does, by not showing
 *           stats rather than by showing wrong ones.
 */
export function computeMatchStats(pack, snapshot) {
  const state = createState({ pack, seats: snapshot.seats, seed: snapshot.seed });
  pack.template.setup(makeCtx(state));

  const perSeat = Array.from({ length: snapshot.seats }, emptySeatStats);
  const rounds = [];

  for (const move of snapshot.log) {
    applyMove(state, move);
    const seat = perSeat[move.actor];
    if (seat) {
      seat.moves += 1;
      if (move.type === 'playCard') {
        seat.cardsPlayed += 1;
        const card = pack.cardsById.get(baseId(String(move.cards?.[0] || '')));
        if (card?.effect) seat.effectsPlayed += 1;
        if (typeof move.to === 'string' && move.to.startsWith('build.')) seat.buildPlays += 1;
      } else if (move.type === 'draw') {
        seat.draws += 1;
      } else if (move.type === 'discard') {
        seat.discards += 1;
      } else if (move.type === 'layDown') {
        seat.meldsLaid += move.choice?.melds?.length || 1;
      } else if (move.type === 'hit') {
        seat.hits += 1;
      }
    }

    for (const event of state.events) {
      if (event.type === 'trickWon') {
        const winner = perSeat[event.seat];
        if (winner) {
          winner.tricksWon += 1;
          winner.pointsTaken += event.points || 0;
        }
      } else if (event.type === 'roundOver') {
        rounds.push({
          round: event.round,
          scores: { ...event.scores },
          totals: event.totals.slice(),
          over: !!event.over,
        });
      } else if (event.type === 'announced') {
        if (perSeat[event.seat]) perSeat[event.seat].declared += 1;
      } else if (event.type === 'caught') {
        if (perSeat[event.seat]) perSeat[event.seat].caughtOthers += 1;
        if (perSeat[event.target]) perSeat[event.target].wasCaught += 1;
      }
    }
  }

  // Two numbers only the FINAL state can answer, so they are read once here
  // rather than tracked move by move.
  for (let s = 0; s < snapshot.seats; s++) {
    const phase = state.playerVars[s]?.phase;
    if (typeof phase === 'number') perSeat[s].phaseReached = phase;
    const stockAddr = `stock.${s}`;
    if (state.zones.has(stockAddr)) perSeat[s].stockLeft = state.zones.count(stockAddr);
    // A hidden won-pile's cost is exactly what the round scorer will charge
    // for it, so read it the same way the table's own chip does.
    const wonAddr = `won.${s}`;
    if (state.zones.has(wonAddr) && pack.scoring?.cardValues) {
      const cards = state.zones.cards(wonAddr)
        .map((id) => pack.cardsById.get(baseId(id)))
        .filter(Boolean);
      perSeat[s].pointsHeld = handValue(cards, pack.scoring);
    }
  }

  return {
    seats: snapshot.seats,
    rounds,
    perSeat,
    totals: state.scores.slice(),
    winner: state.winner,
    gameOver: state.gameOver,
    moves: snapshot.log.length,
  };
}

/**
 * The lines a template's players actually care about, in reading order.
 *
 * Kept here beside the counting rather than in the panel: what a Hearts stat
 * line SAYS is a fact about the trick-taking template, and the panel's job is
 * only to lay rows out. A zero-valued line is dropped so a game that never
 * used a mechanic does not report on it.
 *
 * @returns Array<{ label, value }>
 */
export function statLinesFor(templateId, seat) {
  const lines = [];
  const push = (label, value, { always = false } = {}) => {
    if (always || (value !== null && value !== undefined && value !== 0)) {
      lines.push({ label, value: String(value) });
    }
  };

  if (templateId === 'trick-taking') {
    push('Tricks won', seat.tricksWon, { always: true });
    push('Points taken', seat.pointsTaken, { always: true });
  } else if (templateId === 'shedding') {
    push('Cards played', seat.cardsPlayed, { always: true });
    push('Cards drawn', seat.draws, { always: true });
    push('Action cards', seat.effectsPlayed);
    push('Declared', seat.declared);
    push('Caught someone', seat.caughtOthers);
    push('Caught out', seat.wasCaught);
  } else if (templateId === 'contract-rummy') {
    push('Contract reached', seat.phaseReached, { always: true });
    push('Melds laid', seat.meldsLaid, { always: true });
    push('Hits', seat.hits);
    push('Cards drawn', seat.draws);
  } else if (templateId === 'sequencing') {
    push('Stock left', seat.stockLeft, { always: true });
    push('Build plays', seat.buildPlays, { always: true });
    push('Discards', seat.discards);
  } else {
    push('Moves', seat.moves, { always: true });
    push('Cards played', seat.cardsPlayed, { always: true });
  }
  return lines;
}

/**
 * Who beat whom, for the head-to-head record.
 *
 * "Beat" is placement, not just victory: in a three-seat game a loss can still
 * be a win against one of the two opponents, and a record that only counted
 * outright wins would tell a player nothing about the bot they consistently
 * finish ahead of. Ranking follows the pack's own direction — lowest score
 * wins in Hearts, highest in Wildfire — with the declared winner pinned to
 * first regardless, since that is what the engine actually decided.
 */
export function placements(pack, { totals, winner, seats }) {
  const lowWins = pack.scoring?.gameOver?.winner !== 'highestScore';
  const order = Array.from({ length: seats }, (_, s) => s).sort((a, b) => {
    if (a === winner) return -1;
    if (b === winner) return 1;
    return lowWins ? totals[a] - totals[b] : totals[b] - totals[a];
  });
  const rank = new Array(seats).fill(0);
  order.forEach((seat, i) => { rank[seat] = i; });
  return rank;
}
