// THE RULES A TABLE IS HANDED — the engine's half of the src/match/ boundary.
//
// src/match/ is a game-agnostic kit (#50): identity, seats, sessions, the
// directory, the wire protocol, timers. It does not import the engine; the
// construction site hands it this object, and a second game would hand it its
// own with the same shape. Every member is an existing engine export passed
// through unchanged — this is parameter-passing, not adaptation, so the host
// and client behave exactly as they did when they imported these directly.
//
//   validate(state, move)          -> { legal: true } | { legal: false, rule, reason }
//   apply(state, move)             mutates state; throws on an illegal move
//   enumerateMoves(state, seat)    the moves a seat may make, shipped with its view
//   actingSeats(state)             seats that may move right now
//   announcementsFor(state, seat)  what a seat may say out of turn
//   viewFor(state, seat, opts)     the redacted, JSON-safe payload one seat sees
//   eventsFor(state, seat, events) the move's events, redacted for that seat
//   cardExists(state, id)          does this wire id name a real card in this pack?
//   viewVersion                    the shape version of viewFor's payload; a
//                                  client refuses a view of any other version

import { validateMove, applyMove, enumerateLegalMoves } from './movePipeline.js';
import { actingSeats, announcementsFor } from './context.js';
import { viewFor, eventsFor, VIEW_VERSION } from './view.js';
import { baseId } from './selectors.js';

export const tableRules = Object.freeze({
  validate: validateMove,
  apply: applyMove,
  enumerateMoves: enumerateLegalMoves,
  actingSeats,
  announcementsFor,
  viewFor,
  eventsFor,
  // The charset check in src/match/protocol.js keeps a wire id out of a
  // selector; this keeps a well-formed id that names nothing from reaching the
  // engine, where `moveCards` would throw on it from inside a message handler.
  cardExists: (state, id) => state.pack.cardsById.has(baseId(id)),
  viewVersion: VIEW_VERSION,
});
