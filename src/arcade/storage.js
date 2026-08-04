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

import { serializeMatch, isReplayableMatch } from '../engine/replay.js';

// Keys, unprefixed — the SDK adds `arcade.v1.cardstock.`. Named here so the
// set is greppable and nothing invents a key inline.
export const KEYS = {
  lastPack: 'lastPack',
  settings: 'settings',
  activeMatch: 'activeMatch',
};

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

const DEFAULT_PACK = 'crazy-eights';

// §7b: this id reaches a fetch path and a DOM attribute.
const PACK_ID_RE = /^[\w-]+$/;

export function isValidPackId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && PACK_ID_RE.test(id);
}

/* ------------------------------------------------------------------ *
 * Pack selection
 * ------------------------------------------------------------------ */

/**
 * Which pack to open, in priority order: an explicit `?pack=` override, then
 * the stored last-played pack, then the default.
 *
 * Storage is the source of truth and the query param is only an override,
 * because launcher deep links are `#app=cardstock` and cannot carry a query —
 * so a relaunch from the launcher has nothing but storage to go on
 * (ARCADE_COMPLIANCE.md finding B2).
 */
export function resolvePackId(search = '') {
  const override = new URLSearchParams(search).get('pack');
  if (isValidPackId(override)) return override;
  const stored = Arcade.state.get(KEYS.lastPack);
  if (isValidPackId(stored)) return stored;
  return DEFAULT_PACK;
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
 * The resumable match
 * ------------------------------------------------------------------ */

/**
 * Persist the live match as seed + event log (src/engine/replay.js).
 *
 * Returns the SDK's write result. Framed, `true` means "accepted, pending" —
 * a launcher-side quota failure arrives later via Arcade.onStorageError (§3),
 * which is why registerStorageErrorHandler exists rather than this checking
 * being sufficient on its own.
 */
export function saveMatch(state) {
  return Arcade.state.set(KEYS.activeMatch, serializeMatch(state));
}

/** The stored match, or null when there is none this build can replay. */
export function loadMatch() {
  const stored = Arcade.state.get(KEYS.activeMatch);
  return isReplayableMatch(stored) ? stored : null;
}

/** Called on match end — a finished match is not something to resume into. */
export function clearMatch() {
  return Arcade.state.remove(KEYS.activeMatch);
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
      key === KEYS.activeMatch
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
