// Builds the `ctx` object every template's validateMove/applyMove/enumerateLegalMoves/
// scoreRound function receives. Read helpers are plain functions; mutation helpers
// (moveCards, setVar, advanceTurn, ...) are the only way templates touch state, so all
// state changes funnel through one place.

import { baseId } from './selectors.js';
import { moveCards as moveCardsInState, emitEvent } from './state.js';

export function zoneAddr(id, seat) {
  return seat === undefined || seat === null ? id : `${id}.${seat}`;
}

export function makeCtx(state) {
  const pack = state.pack;
  return {
    state,
    pack,
    rules: pack.rules,
    seats: state.seats,
    turn: state.turn,
    direction: state.direction,
    rng: state.rng,

    zoneAddr,
    zone: (address) => state.zones.get(address),
    hasZone: (address) => state.zones.has(address),
    cardIdsIn: (address) => state.zones.cards(address),
    cardsIn: (address) => state.zones.cards(address).map((id) => pack.cardsById.get(baseId(id))),
    topOf: (address) => state.zones.top(address),
    countIn: (address) => state.zones.count(address),
    cardById: (id) => pack.cardsById.get(baseId(id)),
    locationOf: (cardId) => state.cardLocation.get(cardId),

    var: (name) => state.vars[name],
    setVar: (name, value) => {
      state.vars[name] = value;
    },
    playerVar: (seat, name) => state.playerVars[seat]?.[name],
    setPlayerVar: (seat, name, value) => {
      state.playerVars[seat][name] = value;
    },

    score: (seat) => state.scores[seat],
    addScore: (seat, amount) => {
      state.scores[seat] += amount;
    },

    moveCards: (cardIds, from, to, opts) => moveCardsInState(state, cardIds, from, to, opts),

    /**
     * Move `n` cards off the top of `from` into `to`, stopping early when the
     * source runs dry. Returns how many actually moved, which is not always
     * what was asked for — an exhausted pile that could not be recycled hands
     * over fewer, and the table should say what really happened.
     *
     * This loop existed five times over: shedding's drawCards and its deal,
     * contract-rummy's deal, and sequencing's stock deal and hand top-up.
     */
    deal: (to, n, { from = 'draw' } = {}) => {
      let dealt = 0;
      for (let i = 0; i < n; i++) {
        const top = state.zones.top(from);
        if (top === undefined) break;
        moveCardsInState(state, [top], from, to);
        dealt++;
      }
      return dealt;
    },

    /** `n` cards to every seat's `to` zone, seat 0 first — the opening deal. */
    dealEach: (n, { to = 'hand', from = 'draw' } = {}) => {
      for (let seat = 0; seat < state.seats; seat++) {
        for (let i = 0; i < n; i++) {
          const top = state.zones.top(from);
          if (top === undefined) return;
          moveCardsInState(state, [top], from, zoneAddr(to, seat));
        }
      }
    },

    /**
     * Who this round opens on. The deal rotates a seat per round, as it would
     * at a table — without it a new round opens on whoever just won, because
     * the winning play returns before advancing the turn.
     *
     * `(roundNumber - 1) % seats` was written out in shedding and
     * contract-rummy and simply missing from trick-taking, whose dealer was
     * permanently seat 0 in contradiction of the design doc's `dealer: rotate`.
     */
    openingSeat: () => (state.roundNumber - 1) % state.seats,

    nextSeat: (from = state.turn.seat, dir = state.direction) => (((from + dir) % state.seats) + state.seats) % state.seats,
    setTurnSeat: (seat) => {
      state.turn.seat = seat;
    },
    setPhase: (phase) => {
      state.turn.phase = phase;
    },
    setDirection: (d) => {
      state.direction = d;
    },
    reverseDirection: () => {
      state.direction *= -1;
    },

    /**
     * THIS HAND IS FINISHED, and `winner` is whoever finished it.
     *
     * Whether the MATCH is over is not this template's call: it is the pack's
     * scoring.gameOver ("anyScore >= 100"), or template.isGameOver where the
     * pack says the template decides. The pipeline consumes this flag in
     * maybeFinishRound, scores the round, and then either ends the match or
     * deals the next one.
     *
     * Templates used to say this with setGameOver() and read it back out of
     * state.gameOver in their own isRoundOver — a wart the pipeline documented
     * and worked around by resetting the flag. A round ending is not a match
     * ending, and now it does not have to pretend to be.
     */
    endRound: (winner = null) => {
      state.roundEnded = true;
      state.roundWinner = winner;
    },

    /** The MATCH is over. Distinct from endRound above, deliberately. */
    setGameOver: (winner) => {
      state.gameOver = true;
      state.winner = winner;
    },

    // Derived events for the UI (state.events) — a trick resolving, a lay-down
    // landing. Never part of the persisted log; see state.js.
    emit: (type, payload = {}) => emitEvent(state, type, payload),

    fail: (rule, reason) => ({ legal: false, rule, reason }),
    ok: () => ({ legal: true }),
  };
}
