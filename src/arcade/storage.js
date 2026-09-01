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
// A table id is a SAFE_ID and the key it becomes goes to the launcher, so it is
// held to the same rule as everything else on the wire — a key is not a place
// to relax a validator.
import { isSafeId } from '../match/protocol.js';

// Keys, unprefixed — the SDK adds `arcade.v1.cardstock.`. Named here so the
// set is greppable and nothing invents a key inline.
export const KEYS = {
  lastPack: 'lastPack',
  settings: 'settings',
  // THE SHARED TABLE DOES NOT LIVE UNDER `match.<packId>`, and LOBBY_PLAN.md
  // reserved this the day the per-pack keys shipped. Two reasons, and the
  // second is the load-bearing one: a multiplayer match belongs to a PARTY
  // rather than to a pack, so two of them are not two saved games the lobby
  // should offer side by side; and "only the open table advances" is exactly
  // the invariant a shared table inverts — the host must keep advancing a
  // table its own player is not looking at.
  //
  // HOST-ONLY. This is seed + log, which is full information: it replays every
  // hand at the table. A joiner never writes it and is never sent it (see
  // src/engine/view.js) — a client keeps nothing across a reload and re-asks
  // for a snapshot instead.
  //
  // ONE SLOT PER TABLE, keyed by the minted `tableId` — `mpMatch.<tableId>`.
  // A single `mpMatch` slot was right while a device could host one table and
  // is wrong the moment it can host two: the second deal would silently
  // overwrite the first, which is the same mistake `activeMatch` made about
  // packs and which `match.<packId>` fixed.
  //
  // THE INDEX EXISTS BECAUSE THERE IS NO WAY TO LIST KEYS. `Arcade.state` has
  // get/set/remove and nothing that enumerates, so a boot with no index would
  // have no way to discover which tables it had saved. It stays deliberately
  // small — enough to find and name a slot, never a copy of what is in one.
  mpTables: 'mpTables',
  // WHERE A JOINER SITS, AND NOTHING ELSE ABOUT THE GAME. The asymmetry with
  // `mpMatch.<tableId>` above is the point: a host stores seed + log, which is
  // full information; a joiner stores a note saying which chair was theirs.
  // Restoring it re-claims and asks for a snapshot, so a client still keeps no
  // game state across a reload and still cannot see a hand it was not shown.
  //
  // One slot holding an array rather than a key each: these are small, always
  // read together (the Tables row merges all of them against the directory),
  // and there are at most a handful.
  mpSeats: 'mpSeats',
};

/**
 * How long a table nobody has touched stays worth keeping (plan §1, §6).
 *
 * ONE CONSTANT, read by both sweeps. A host slot ages on `savedAt` — the last
 * move anybody made — and a joiner stub on `lastSeenAt`, the last time we heard
 * its host at all, because a joiner has no moves of its own to date.
 */
export const TABLE_ROLL_OFF_MS = 7 * 24 * 60 * 60 * 1000;

// See KEYS.mpTables. `match.` and `mpMatch.` are kept distinct on purpose: a
// solo save and a hosted table are not the same kind of thing, and the lobby
// offers only the first.
export const MP_MATCH_KEY_PREFIX = 'mpMatch.';

export function mpMatchKey(tableId) {
  return `${MP_MATCH_KEY_PREFIX}${tableId}`;
}

export function isMpMatchKey(key) {
  return typeof key === 'string' && key.startsWith(MP_MATCH_KEY_PREFIX);
}
// The pre-lobby single-match key (`activeMatch`) and its boot-time migration
// are GONE. They said "delete one release after the lobby ships"; the lobby
// shipped in v0.1.2 and this is v0.1.15, so the migration had been running at
// every boot for thirteen releases to move a payload nobody can still have.

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
  // How far ahead the house thinks: 'easy' | 'medium' | 'hard'
  // (src/engine/bot.js). A PREFERENCE, beside the bot speed, rather than
  // something stored with a match — a player who likes a hard table likes it in
  // every game, and a difficulty saved into a match would be a rule the replay
  // has to reproduce when the chooser is never re-run at all.
  //
  // Like `botDelayMs`, this has no settings UI yet; `medium` is what the bots
  // already played at when Phase 2 landed, so the default changes nothing for
  // anyone who never touches it. An unknown value is read as the default by
  // `chooseBotMove` itself, which is what makes a hand-edited save harmless.
  botDifficulty: 'medium',
  showLegalHints: true,
  // How each pack's hand is arranged, per pack: { mode, order: [cardId, ...] }.
  // PRESENTATION ONLY (src/ui/handOrder.js) — it never reaches the engine, and
  // it lives in settings rather than beside the match because a preference
  // outlives the game it was formed in.
  hands: {},
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

/**
 * One pack's hand-arrangement preference: `{ mode, order }`.
 *
 * Read/written through the settings blob rather than a key of its own — it is
 * a preference, it is tiny, and giving every pack its own key would spread the
 * namespace this module exists to keep auditable (§3).
 */
export function loadHandPrefs(packId) {
  if (!isValidPackId(packId)) return { mode: 'auto', order: [] };
  const hands = loadSettings().hands || {};
  const stored = hands[packId];
  return {
    mode: typeof stored?.mode === 'string' ? stored.mode : 'auto',
    order: Array.isArray(stored?.order) ? stored.order.filter((id) => typeof id === 'string') : [],
  };
}

export function saveHandPrefs(packId, prefs) {
  if (!isValidPackId(packId)) return false;
  const settings = loadSettings();
  const hands = { ...(settings.hands || {}) };
  hands[packId] = { mode: prefs.mode, order: prefs.order.slice(0, 200) };
  return saveSettings({ ...settings, hands });
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
/**
 * The host's copy of a shared table: the ordinary seed + log payload plus the
 * seat bindings, so a host that reloads can put everybody back in the chair
 * they were in rather than re-running the lobby.
 *
 * The bindings are stored SEPARATELY from the match rather than inside
 * serializeMatch, because they are not part of the game: replaying the log
 * reproduces the cards whoever is holding them, and a seat changing hands
 * mid-match (a drop, a bot filling in) must not make the log unreplayable.
 */
export function saveHostMatch(tableId, state, seatTable, { graceMs = null } = {}) {
  if (!isSafeId(tableId)) return false;
  const written = Arcade.state.set(mpMatchKey(tableId), {
    ...serializeMatch(state),
    tableId,
    seatBindings: seatTable.serialize(),
    // THE HOST'S RULE SURVIVES THE RELOAD, but the deadlines it produced do
    // not — a stored deadline is a promise about a clock that stopped existing.
    // Restoring the grace and arming fresh is what gives every seat a full
    // window on resume (plan §7).
    graceMs: Number.isInteger(graceMs) ? graceMs : undefined,
  });
  rememberHostTable(tableId, state.pack.id);
  return written;
}

/** The stored shared table, or null when there is none this build can replay. */
export function loadHostMatch(tableId) {
  if (!isSafeId(tableId)) return null;
  const stored = Arcade.state.get(mpMatchKey(tableId));
  if (!isReplayableMatch(stored)) return null;
  // The slot's own id re-checked against the key it was found under, for the
  // same reason `loadMatch` re-checks packId: they can only disagree if a save
  // bundle was hand-edited, and rehydrating into the wrong table is worse than
  // not rehydrating at all.
  if (stored.tableId && stored.tableId !== tableId) return null;
  return stored;
}

export function clearHostMatch(tableId) {
  if (!isSafeId(tableId)) return false;
  forgetHostTable(tableId);
  return Arcade.state.remove(mpMatchKey(tableId));
}

/**
 * Every hosted table this device has saved — `[{ tableId, packId, savedAt }]`,
 * newest first.
 *
 * Entries whose slot has gone are dropped on the way out rather than returned
 * for a caller to trip over: an index is a hint about where to look, and a
 * stale hint should cost nothing more than a lookup that finds nothing.
 */
export function hostMatches() {
  const index = Arcade.state.get(KEYS.mpTables);
  if (!Array.isArray(index)) return [];
  return index
    .filter((entry) => entry && isSafeId(entry.tableId) && Arcade.state.get(mpMatchKey(entry.tableId)))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

function rememberHostTable(tableId, packId, { at = Date.now() } = {}) {
  const index = Arcade.state.get(KEYS.mpTables);
  const rest = (Array.isArray(index) ? index : []).filter((e) => e?.tableId !== tableId);
  return Arcade.state.set(KEYS.mpTables, [...rest, { tableId, packId, savedAt: at }]);
}

function forgetHostTable(tableId) {
  const index = Arcade.state.get(KEYS.mpTables);
  if (!Array.isArray(index)) return false;
  return Arcade.state.set(KEYS.mpTables, index.filter((e) => e?.tableId !== tableId));
}

/* ------------------------------------------------------------------ *
 * The joiner's half: which chair was mine
 * ------------------------------------------------------------------ */

/** A stored seat, or null. Structural, because storage can be imported. */
function cleanSeatStub(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isSafeId(raw.tableId)) return null;
  if (!isSafeId(raw.hostDeviceId)) return null;
  if (!isValidPackId(raw.packId)) return null;
  if (!Number.isInteger(raw.seat) || raw.seat < 0) return null;
  return {
    tableId: raw.tableId,
    hostDeviceId: raw.hostDeviceId,
    packId: raw.packId,
    seat: raw.seat,
    // WHOSE TABLE IT WAS, learned while the host was still on the roster.
    // A dormant tile has to name somebody — `peerName` answers "Someone" for a
    // device that has gone, and "Your seat at Someone's Hearts" is a worse
    // promise than none. Clamped and rendered as text like every other name
    // somebody else typed. This is the only thing here that is not strictly
    // about which chair: still no cards, no log, no sequence.
    hostName: typeof raw.hostName === 'string' ? raw.hostName.slice(0, 60) : '',
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    lastSeenAt: Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : 0,
  };
}

/**
 * Every seat this device holds somewhere, newest sighting first.
 *
 * Validated on the way out like every other slot — a save bundle can be
 * imported from anywhere, and a malformed stub should cost one dropped tile
 * rather than a Tables row that throws while rendering.
 */
export function seatStubs() {
  const stored = Arcade.state.get(KEYS.mpSeats);
  if (!Array.isArray(stored)) return [];
  return stored
    .map(cleanSeatStub)
    .filter(Boolean)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Remember that we are sitting at `seat`. Written when the HOST CONFIRMS it —
 * its lobby roster naming our device in that chair — never when we ask.
 */
export function saveSeatStub({ tableId, hostDeviceId, packId, seat, hostName = '' }, { at = Date.now() } = {}) {
  const stub = cleanSeatStub({ tableId, hostDeviceId, packId, seat, hostName, savedAt: at, lastSeenAt: at });
  if (!stub) return false;
  const rest = seatStubs().filter((s) => s.tableId !== tableId);
  // `savedAt` is when we FIRST sat down, so re-confirming the same seat must
  // not reset it — it is what a "you have been here a while" reading would use.
  const previous = seatStubs().find((s) => s.tableId === tableId);
  if (previous) stub.savedAt = previous.savedAt || at;
  return Arcade.state.set(KEYS.mpSeats, [...rest, stub]);
}

/** We heard this table's host just now. Keeps the stub off the roll-off sweep. */
export function touchSeatStub(tableId, { at = Date.now() } = {}) {
  const stubs = seatStubs();
  const found = stubs.find((s) => s.tableId === tableId);
  if (!found) return false;
  found.lastSeenAt = at;
  return Arcade.state.set(KEYS.mpSeats, stubs);
}

export function clearSeatStub(tableId) {
  const stubs = seatStubs();
  if (!stubs.some((s) => s.tableId === tableId)) return false;
  return Arcade.state.set(KEYS.mpSeats, stubs.filter((s) => s.tableId !== tableId));
}

/**
 * Drop everything nobody has touched for a week (plan §1, §6).
 *
 * SILENT BY DESIGN. A table a week old is not news; announcing it would mean
 * explaining, at boot, a game the player has already stopped thinking about.
 * Returns what it dropped so a caller can log it, not so it can say it.
 */
export function sweepStaleTables({ now = Date.now(), maxAgeMs = TABLE_ROLL_OFF_MS } = {}) {
  const dropped = { tables: [], seats: [] };

  for (const entry of hostMatches()) {
    if (now - (entry.savedAt || 0) < maxAgeMs) continue;
    clearHostMatch(entry.tableId);
    dropped.tables.push(entry.tableId);
  }

  const stubs = seatStubs();
  const live = stubs.filter((s) => now - s.lastSeenAt < maxAgeMs);
  if (live.length !== stubs.length) {
    dropped.seats = stubs.filter((s) => now - s.lastSeenAt >= maxAgeMs).map((s) => s.tableId);
    Arcade.state.set(KEYS.mpSeats, live);
  }
  return dropped;
}

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
 * `seed` rides along because the SEATING is derived from it
 * (src/players/roster.js) — which is how the lobby can name the opponents in a
 * game it abandons without loading the pack or replaying a single move.
 *
 * @returns {Map<string, {packId, savedAt, moves, seats, seed, variants}>} —
 *   packs with no resumable match are absent, not present-with-null.
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
      seed: stored.seed,
      variants: stored.variants,
    });
  }
  return summaries;
}


/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

const STATS_DEFAULTS = {
  played: 0,
  won: 0,
  forfeits: 0,
  streak: 0,
  bestStreak: 0,
  // opponentKey -> { played, won }. The KEY IS NAMESPACED FROM THE FIRST WRITE
  // (`bot:juniper` today, `peer:<deviceId>` when Phase 8 lands) so a record
  // spanning both never needs a migration to tell them apart — see
  // src/players/roster.js opponentKey().
  opponents: {},
};

/** An id that will be used as an object key and rendered. §7b. */
const OPPONENT_KEY_RE = /^(bot|peer):[\w-]{1,64}$/;

/** Older records predate the newer fields; merging over the defaults is the migration. */
function normalizeStats(prev) {
  const base = { ...STATS_DEFAULTS, ...(prev || {}) };
  base.opponents = { ...(prev?.opponents || {}) };
  return base;
}

/**
 * Record a finished match against `packId`.
 *
 * @param won        did the player win outright
 * @param forfeit    did they abandon it (counted as a loss, and said so)
 * @param opponents  [{ key, beaten }] — per-opponent placement, so a
 *                   three-seat loss still records that you finished ahead of
 *                   one of them. See src/stats/matchStats.js placements().
 */
export function recordResult(packId, { won, forfeit = false, opponents = [] }) {
  if (!isValidPackId(packId)) return;
  Arcade.stats.update(packId, (prev) => {
    const base = normalizeStats(prev);
    const streak = won ? base.streak + 1 : 0;
    const next = {
      ...base,
      played: base.played + 1,
      won: base.won + (won ? 1 : 0),
      forfeits: base.forfeits + (forfeit ? 1 : 0),
      streak,
      bestStreak: Math.max(base.bestStreak, streak),
      opponents: { ...base.opponents },
    };
    for (const { key, beaten } of opponents) {
      if (!OPPONENT_KEY_RE.test(key || '')) continue;
      const record = next.opponents[key] || { played: 0, won: 0 };
      next.opponents[key] = { played: record.played + 1, won: record.won + (beaten ? 1 : 0) };
    }
    return next;
  });
}

/**
 * WALKING AWAY FROM A MATCH WITH MOVES IN IT IS A FORFEIT, and there are two
 * doors out: the table's own "End match" and the lobby's "Start over". Both
 * wrote this block by hand, and both carried a comment insisting "the two doors
 * must not disagree about what a loss is" — which is a comment doing a
 * function's job. Now it is a function.
 *
 * @param seating the match's seating (src/players/roster.js); every bot in it
 *                records a loss against the human.
 */
export function recordForfeit(packId, seating) {
  recordResult(packId, {
    won: false,
    forfeit: true,
    opponents: (seating || [])
      .filter((identity) => identity.isBot)
      .map((identity) => ({ key: identity.opponentKey, beaten: false })),
  });
}

export function readStats(packId) {
  return normalizeStats(Arcade.stats.getOrInit(packId, STATS_DEFAULTS));
}

/** This player's record against one opponent, or null when they have never met. */
export function readHeadToHead(packId, opponentKey) {
  if (!OPPONENT_KEY_RE.test(opponentKey || '')) return null;
  return readStats(packId).opponents[opponentKey] || null;
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
