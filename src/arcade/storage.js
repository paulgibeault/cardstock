// The ONLY module that touches Arcade.state. Everything else asks this.
//
// One door means one place to audit the namespace (§3: every key must match
// `arcade.v1.cardstock.*` or the launcher's save bundle silently drops it), one
// place that knows which keys are player-facing enough to sync, and one place
// to change when a key's shape moves.
//
// Storage posture (ARCADE_ENHANCEMENTS.md Decision 3): `Arcade.state` only.
// The `Arcade.store` surface is STUBBED below rather than absent, so the
// replay work can swap implementations without touching a single call site.
//
// The lobby's several-tables-at-once did NOT change that posture, and the
// reasoning is worth keeping: `Arcade.state` is synchronous, which the
// onSuspend flush contract (§6b) effectively requires, and five packs' worth
// of match logs is a few KB against the quota. What WOULD need the async
// store is many tables of the SAME pack, or a browsable replay archive —
// which is exactly what the stub below is reserved for.

import { serializeMatch, isReplayableMatch } from '../engine/replay.js';

// Keys, unprefixed — the SDK adds `arcade.v1.cardstock.`. Named here so the
// set is greppable and nothing invents a key inline.
export const KEYS = {
  lastPack: 'lastPack',
  settings: 'settings',
  // The pre-lobby single-match key. Read exactly once, by migrateLegacyMatch()
  // at boot, and removed; see LOBBY_PLAN.md "storage model". Delete this entry
  // and its migration one release after the lobby ships.
  legacyActiveMatch: 'activeMatch',
};

// One saved table PER PACK — `match.<packId>` — which is what lets a Hearts
// game and a Crazy Eights game both sit waiting. The single `activeMatch` key
// it replaces made starting any other pack silently discard the one before it.
export const MATCH_KEY_PREFIX = 'match.';

export function matchKey(packId) {
  return `${MATCH_KEY_PREFIX}${packId}`;
}

export function isMatchKey(key) {
  return typeof key === 'string' && key.startsWith(MATCH_KEY_PREFIX);
}

// Fully-qualified names for the async surfaces, pinned now so the replay work
// inherits them instead of choosing again. See storeStub below.
export const STORE_NAMES = {
  matches: 'arcade.v1.cardstock.store.matches',
  replays: 'arcade.v1.cardstock.store.replays',
};

export const SETTINGS_DEFAULTS = {
  // Cardstock's own preferences. Launcher-owned settings (theme, fontScale,
  // reducedMotion, handedness) are NOT mirrored here — they live in
  // Arcade.settings and copying them would immediately go stale.
  botDelayMs: 600,
  showLegalHints: true,
};

// §7b: this id reaches a fetch path and a DOM attribute.
const PACK_ID_RE = /^[\w-]+$/;

export function isValidPackId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && PACK_ID_RE.test(id);
}

/* ------------------------------------------------------------------ *
 * Pack selection
 * ------------------------------------------------------------------ */

/**
 * The `?pack=` deep-link override, or null when there isn't a valid one.
 *
 * This is the ONLY thing that still sends a boot straight to a table, and it
 * exists for the dev server, the §13 acceptance run, and hand-shared links.
 * A plain visit — including every launcher deep link, which is `#app=cardstock`
 * and cannot carry a query (ARCADE_COMPLIANCE.md finding B2) — lands on the
 * lobby and lets the player choose.
 */
export function packOverride(search = '') {
  const override = new URLSearchParams(search).get('pack');
  return isValidPackId(override) ? override : null;
}

/**
 * The last pack opened, or null.
 *
 * Before the lobby this decided what to auto-launch. It is now only a hint:
 * the lobby uses it to decide which tile to feature, so "I came back to keep
 * playing" is one tap on the biggest target.
 */
export function lastPlayedPack() {
  const stored = Arcade.state.get(KEYS.lastPack);
  return isValidPackId(stored) ? stored : null;
}

export function rememberPack(packId) {
  if (!isValidPackId(packId)) return false;
  // Player-facing: which game they were playing should follow them across
  // their own devices.
  return Arcade.state.set(KEYS.lastPack, packId, { sync: true });
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function loadSettings() {
  return Arcade.state.getOrInit(KEYS.settings, SETTINGS_DEFAULTS);
}

export function saveSettings(next) {
  return Arcade.state.set(KEYS.settings, next, { sync: true });
}

/* ------------------------------------------------------------------ *
 * The resumable matches — one per pack
 * ------------------------------------------------------------------ */

/**
 * Persist the live match as seed + event log (src/engine/replay.js), under its
 * own pack's key.
 *
 * Returns the SDK's write result. Framed, `true` means "accepted, pending" —
 * a launcher-side quota failure arrives later via Arcade.onStorageError (§3),
 * which is why registerStorageErrorHandler exists rather than this checking
 * being sufficient on its own.
 */
export function saveMatch(state) {
  return Arcade.state.set(matchKey(state.pack.id), serializeMatch(state));
}

/**
 * The stored match for `packId`, or null when there is none this build can
 * replay.
 *
 * The payload's own `packId` is re-checked against the key it was found under.
 * They can only disagree if a save bundle was hand-edited or written by a
 * build with a different key scheme, and rehydrateMatch would throw on the
 * mismatch anyway — catching it here means the lobby never advertises a
 * resumable game that the table would then refuse to open.
 */
export function loadMatch(packId) {
  if (!isValidPackId(packId)) return null;
  const stored = Arcade.state.get(matchKey(packId));
  if (!isReplayableMatch(stored) || stored.packId !== packId) return null;
  return stored;
}

/**
 * Drop one pack's saved match. Called on match end (a finished match is not
 * something to resume into), on an unreplayable log, and when the player
 * abandons a game from the lobby.
 */
export function clearMatch(packId) {
  if (!isValidPackId(packId)) return false;
  return Arcade.state.remove(matchKey(packId));
}

/**
 * What the lobby shows on each tile, for the packs it was given.
 *
 * Deliberately cheap: it reads and shape-checks the stored payloads but does
 * NOT replay them. Rehydration is a table-entry cost — paying it five times to
 * draw a grid would make opening the lobby scale with how much has been played.
 * `moves` therefore comes from the log length, which is exactly the number the
 * ribbon wants anyway.
 *
 * @returns {Map<string, {packId, savedAt, moves, seats, variants}>} — packs
 *   with no resumable match are absent, not present-with-null.
 */
export function listMatchSummaries(packIds) {
  const summaries = new Map();
  for (const packId of packIds) {
    const stored = loadMatch(packId);
    if (!stored) continue;
    summaries.set(packId, {
      packId,
      savedAt: typeof stored.savedAt === 'number' ? stored.savedAt : null,
      moves: stored.log.length,
      seats: stored.seats,
      variants: stored.variants,
    });
  }
  return summaries;
}

/**
 * Move a pre-lobby `activeMatch` payload to its per-pack key. Idempotent, and
 * called once at boot before anything reads a match.
 *
 * The legacy key is removed whether or not the payload survived the move: a
 * value this build cannot replay is not going to become replayable later, and
 * leaving it costs quota in the launcher's save bundle forever.
 *
 * @returns {string|null} the pack id that was migrated, for logging.
 */
export function migrateLegacyMatch() {
  const legacy = Arcade.state.get(KEYS.legacyActiveMatch);
  if (legacy === undefined || legacy === null) return null;
  Arcade.state.remove(KEYS.legacyActiveMatch);

  if (!isReplayableMatch(legacy) || !isValidPackId(legacy.packId)) return null;
  // A per-pack match already present is newer by construction — this key has
  // not been written since the lobby shipped — so it wins.
  if (loadMatch(legacy.packId)) return null;

  Arcade.state.set(matchKey(legacy.packId), legacy);
  return legacy.packId;
}

/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

const STATS_DEFAULTS = { played: 0, won: 0 };

/** Per-pack counters, so each pack's record reads on its own (§4). */
export function recordResult(packId, { won }) {
  if (!isValidPackId(packId)) return;
  Arcade.stats.update(packId, (prev) => {
    const base = { ...STATS_DEFAULTS, ...(prev || {}) };
    return { played: base.played + 1, won: base.won + (won ? 1 : 0) };
  });
}

export function readStats(packId) {
  return Arcade.stats.getOrInit(packId, STATS_DEFAULTS);
}

/* ------------------------------------------------------------------ *
 * Quota
 * ------------------------------------------------------------------ */

/**
 * Register once, at boot. Since SDK 3.12.0 the SDK toasts a default message
 * when no listener is registered — registering REPLACES that default, so this
 * has to say something at least as useful.
 */
export function registerStorageErrorHandler() {
  Arcade.onStorageError(({ key }) => {
    Arcade.ui.toast(
      isMatchKey(key)
        ? 'Storage full — this match will not be saved.'
        : 'Storage full — settings could not be saved.',
      { kind: 'error', duration: 4000 });
  });
}

/* ------------------------------------------------------------------ *
 * Arcade.store — the seam, not the implementation
 * ------------------------------------------------------------------ */

const NOT_YET =
  'cardstock: Arcade.store not yet adopted — see ARCADE_ENHANCEMENTS.md Decision 3';

/**
 * The replay-oriented surface, stubbed.
 *
 * Decision 3 chose `Arcade.state` only for this pass: it is synchronous, it is
 * enough for one active match, and §3a warns that no catalog app has yet
 * exercised `Arcade.store` end-to-end — the first consumer should budget real
 * verification time, which the compliance pass does not have.
 *
 * These throw rather than being absent so the seam is a fact in the codebase
 * instead of a note in a document: the names, the key namespace (STORE_NAMES)
 * and the async signatures are all pinned, so the replay work swaps the bodies
 * for `Arcade.store.open(...)` calls and every caller keeps compiling. There
 * are no callers yet — that is the point; the first one arrives with the
 * implementation.
 */
export const matchArchive = {
  /** @returns {Promise<{get,set,keys,del,each}>} an Arcade.store handle. */
  async openMatchArchive() {
    throw new Error(NOT_YET);
  },
  /** @param {object} _log a serializeMatch() payload. @returns {Promise<string>} its id. */
  async saveReplay(_log) {
    throw new Error(NOT_YET);
  },
  /** @returns {Promise<Array<{id, packId, savedAt}>>} newest first. */
  async listReplays() {
    throw new Error(NOT_YET);
  },
};

export const { openMatchArchive, saveReplay, listReplays } = matchArchive;
