// Match serialization as SEED + EVENT LOG, re-hydrated by replaying the
// reducer. Not a state snapshot — deliberately.
//
// The engine is already event-sourced: every applied move is appended to
// `state.log` (src/engine/movePipeline.js), and the RNG is deterministic from
// the seed (src/engine/rng.js). Those two facts together mean the log IS the
// state — `setup()` plus the moves in order reproduce it exactly, on any
// device, with no serialization of zones, card locations or generator state.
//
// This shape is load-bearing beyond save/resume, which is why it is here and
// not inlined in the storage adapter (ARCADE_ENHANCEMENTS.md Phase 8,
// "pre-commitments owed by earlier phases"):
//
//   - a resumed solo match      → rehydrateMatch(pack, stored)
//   - a multiplayer `snapshot`  → the same payload, sent to one seat
//   - a resync after `overflowed` → replay from the log seq the peer has
//   - a future replay/review UI → step the same reducer one move at a time
//
// So do not regress this to a bare state dump to save a few bytes. A match log
// is a few KB.

import { createState } from './state.js';
import { makeCtx } from './context.js';
import { applyMove } from './movePipeline.js';

/** Bump when the payload shape changes; older payloads are discarded, not guessed at. */
export const MATCH_FORMAT_VERSION = 1;

/**
 * The persistable/​sendable form of a live match.
 * `variants` is recorded because a pack loaded with different variants active
 * is a different rule set, and replaying a log against it would diverge.
 */
export function serializeMatch(state, { savedAt = Date.now() } = {}) {
  return {
    formatVersion: MATCH_FORMAT_VERSION,
    packId: state.pack.id,
    variants: state.pack.activeVariants ?? [],
    seats: state.seats,
    seed: state.seed,
    log: state.log.map(({ seq, ...move }) => move),
    savedAt,
  };
}

/**
 * True if `snapshot` is a match payload this build can replay.
 *
 * Storage is trusted-ish (it is our own namespace) but a save file can be
 * imported by the launcher from anywhere, and Phase 8 will feed peer-supplied
 * snapshots through the same door — so the shape check is structural, not a
 * formality, and callers must treat `false` as "start a fresh match".
 */
export function isReplayableMatch(snapshot) {
  return !!snapshot
    && typeof snapshot === 'object'
    && snapshot.formatVersion === MATCH_FORMAT_VERSION
    && typeof snapshot.packId === 'string'
    && Number.isInteger(snapshot.seats) && snapshot.seats >= 2 && snapshot.seats <= 8
    && (typeof snapshot.seed === 'number' || typeof snapshot.seed === 'string')
    && Array.isArray(snapshot.log)
    && Array.isArray(snapshot.variants)
    && snapshot.log.every((m) => m && typeof m === 'object' && typeof m.type === 'string');
}

/**
 * Rebuild a live state from `snapshot` by replaying its log through the
 * ordinary move pipeline — the same validation every local move gets. A log
 * entry that no longer validates (a pack whose rules changed under a stored
 * match) throws, and the caller starts fresh rather than resuming into a state
 * the current rules could never have produced.
 *
 * `pack` must already be loaded with `snapshot.variants` active; the caller
 * owns loading because fetching is environment-specific.
 */
export function rehydrateMatch(pack, snapshot) {
  if (!isReplayableMatch(snapshot)) throw new Error('not a replayable match payload');
  if (pack.id !== snapshot.packId) {
    throw new Error(`pack mismatch: snapshot is ${snapshot.packId}, loaded ${pack.id}`);
  }
  const state = createState({ pack, seats: snapshot.seats, seed: snapshot.seed });
  pack.template.setup(makeCtx(state));
  for (const move of snapshot.log) applyMove(state, move);
  return state;
}
