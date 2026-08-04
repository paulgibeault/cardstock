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
