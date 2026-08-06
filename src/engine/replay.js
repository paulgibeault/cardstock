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
 * The seq-stripped log, built once and EXTENDED rather than rebuilt.
 *
 * `seq` is the engine's own ordering handle; the payload carries the moves in
 * order, so it is redundant on the wire. Stripping it re-allocated the entire
 * log — array and one object per entry — and the table persists after every
 * applied move AND every announcement, so the cost grew with the match and
 * added up to quadratic work over a long one.
 *
 * The log is append-only TODAY (movePipeline.js pushes and never rewrites), so
 * the entries already stripped can never go stale, and only the tail is new.
 * Keyed on the log ARRAY rather than the state: rehydrateMatch builds fresh
 * state objects around a log, and a WeakMap lets an abandoned match's cache go
 * with it.
 *
 * A LENGTH GUARD IS NOT ENOUGH, AND UNDO IS WHY. §8's promised undo is "replay
 * the log minus the last events" — truncate, then re-grow. A log that goes
 * 40 → 38 → 40 is back at a length the cache has already seen, so a guard of
 * `entry.len > log.length` never fires and the cache serves two moves that were
 * taken back. That is not a stale render; it is a CORRUPTED SAVE, written
 * silently, on the next persist.
 *
 * So the guard also checks that the last entry it cached is still the last
 * entry in the log, BY IDENTITY. Truncate-and-regrow pushes new move objects,
 * so this catches it even at an identical length. Any future truncation site
 * should still call `invalidateLogCache(log)` — belt and braces, and a name to
 * grep for. Both are pinned by tests/replay.test.js.
 */
const strippedLogs = new WeakMap();

/** Drop a log's cached serialization. Call this from any site that TRUNCATES. */
export function invalidateLogCache(log) {
  strippedLogs.delete(log);
}

function strippedLog(log) {
  let entry = strippedLogs.get(log);
  const stale = entry
    && (entry.len > log.length
      || (entry.len > 0 && log[entry.len - 1] !== entry.lastRef));
  if (!entry || stale) {
    entry = { len: 0, moves: [], lastRef: null };
    strippedLogs.set(log, entry);
  }
  for (let i = entry.len; i < log.length; i++) {
    const { seq, ...move } = log[i];
    entry.moves.push(move);
  }
  entry.len = log.length;
  entry.lastRef = log.length ? log[log.length - 1] : null;
  // A copy, because the payload is handed to storage and to the stats reader,
  // and neither should be able to see a later move appear in a log it was
  // given earlier.
  return entry.moves.slice();
}

/**
 * The persistable/​sendable form of a live match.
 *
 * `variants` is recorded because a pack loaded with different variants active
 * is a different rule set, and replaying a log against it would diverge.
 *
 * `packVersion` is recorded for a subtler version of the same thing. THE DECK'S
 * ORDER IS PART OF THE RULE SET: deck.json's entry order becomes cardsById's
 * insertion order (packLoader.js), which becomes the array the seeded shuffle
 * permutes (state.js) — so reordering two entries in a deck file, a change that
 * looks purely cosmetic, deals every stored match a different hand. The log
 * then replays into a state its own moves are illegal in and the player is told
 * nothing except that their game is gone.
 *
 * OPTIONAL BY DESIGN, so MATCH_FORMAT_VERSION does not need bumping and saves
 * written before this field survive: a payload without one is replayed as it
 * always was. `packVersionChanged` is what turns a mismatch into an honest
 * "the rules changed" rather than a bare replay throw.
 */
export function serializeMatch(state, { savedAt = Date.now() } = {}) {
  return {
    formatVersion: MATCH_FORMAT_VERSION,
    packId: state.pack.id,
    packVersion: state.pack.manifest?.version,
    variants: state.pack.activeVariants ?? [],
    seats: state.seats,
    seed: state.seed,
    log: strippedLog(state.log),
    savedAt,
  };
}

/**
 * Was this payload written against a different version of the pack?
 *
 * `false` for a payload that carries no version (written before the field
 * existed) — "unknown" is not "changed", and refusing to resume those would
 * throw away every match in flight at the moment this shipped.
 */
export function packVersionChanged(pack, snapshot) {
  const stored = snapshot?.packVersion;
  if (stored === undefined || stored === null) return false;
  return stored !== pack.manifest?.version;
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
