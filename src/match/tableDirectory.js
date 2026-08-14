// EVERY TABLE THIS DEVICE KNOWS ABOUT — which is not the same set as the tables
// it is sitting at, and conflating the two is what limited this game to one.
//
// src/ui/party.js kept a single `invitation`: the last lobby frame it had seen.
// One slot for a fact that is plural. A second host's frame overwrote the
// first, and from that moment one of the two tables simply did not exist as far
// as this device was concerned — you could not see it, join it, or be told it
// had closed. Worse, holding that one slot was also how the module decided
// whether hosting was allowed, so somebody else's table blocked yours.
//
// A DIRECTORY IS A SIGHTING LOG, NOT A CONNECTION. Nothing here talks to a
// peer, loads a pack, or holds a scrap of game state. It answers exactly one
// question — what tables are out there, and when did we last hear from each —
// which is what the tile row draws from and what the host gate consults.
//
// KEYED BY `hostDeviceId`, FOR NOW. A device hosts at most one table today, so
// the host's identity IS the table's, and that is the whole reason this stage
// needs no protocol change (TABLES_PLAN.md §5). When a real `tableId` goes on
// the wire the key changes and nothing else here does — which is the reason the
// key is read from a frame in one place rather than by every caller.
//
// NO DOM, NO ENGINE, NO SDK. Same discipline as src/players/seats.js: this runs
// under `node --test` with no globals, and it is one of the pieces a second
// game inherits whole (TABLES_PLAN.md §10).

/**
 * The key a frame files under.
 *
 * ONE FUNCTION, SO THERE IS ONE PLACE TO CHANGE — and this is the change it was
 * written for. Protocol v2 puts a minted `tableId` on every frame, so a table
 * is now named by itself rather than by the device running it, which is what
 * lets one device run two. `hostDeviceId` remains the fallback so a directory
 * built from something that predates the id still keys on something stable.
 */
export function tableKeyOf(frame) {
  const key = frame?.tableId || frame?.hostDeviceId;
  return typeof key === 'string' && key ? key : null;
}

/**
 * @param now  the clock sightings are stamped with. Injected for the same
 *             reason src/match/host.js injects one: a test that has to sleep
 *             to make an assertion true is a test that is slow AND flaky.
 */
export function createTableDirectory({ now = Date.now } = {}) {
  // INSERTION ORDER IS TILE ORDER, and re-sighting an existing table must not
  // reshuffle it. A Map re-`set` on a key it already holds keeps its position,
  // which is exactly the behaviour a row of tiles wants: tables appear in the
  // order they were first heard from and stay put while they are talked about.
  const entries = new Map();

  function upsert(frame, at) {
    const key = tableKeyOf(frame);
    // A frame with no host is not a table. The caller has already run
    // `validateFrame`; this is the one field this module cannot do without.
    if (!key) return null;
    const existing = entries.get(key);
    const entry = {
      key,
      hostDeviceId: frame.hostDeviceId,
      packId: frame.packId,
      frame,
      firstSeenAt: existing?.firstSeenAt ?? at,
      lastSeenAt: at,
    };
    entries.set(key, entry);
    return entry;
  }

  return {
    /**
     * Record a lobby frame. Returns the entry, or null for a frame that names
     * no host.
     *
     * IDEMPOTENT, BECAUSE THE WIRE IS. A host re-broadcasts its lobby on every
     * `onReady` and every seat change, so this is called far more often than
     * anything changes, and it has to be as cheap and as harmless the tenth
     * time as the first.
     */
    sight(frame, { at = now() } = {}) {
      return upsert(frame, at);
    },

    get(key) {
      return entries.get(key) || null;
    },

    has(key) {
      return entries.has(key);
    },

    /** Every table, in the order they were first heard from. */
    all() {
      return [...entries.values()];
    },

    /**
     * The tables playing one pack.
     *
     * PLURAL ON PURPOSE even though today's rules allow only one per pack per
     * host: two different hosts may each be running Hearts, and a caller that
     * assumed one would show the wrong table's seats to whoever tapped.
     */
    forPack(packId) {
      return [...entries.values()].filter((entry) => entry.packId === packId);
    },

    /**
     * The most recently sighted table.
     *
     * The idle device's default focus, and the one place the old single-slot
     * behaviour survives deliberately: with exactly one table out there, "the
     * latest sighting" and "the invitation" are the same thing, so a party of
     * two behaves precisely as it did before this module existed.
     */
    latest() {
      let best = null;
      for (const entry of entries.values()) {
        if (!best || entry.lastSeenAt >= best.lastSeenAt) best = entry;
      }
      return best;
    },

    /** Drop one table. Returns whether there was one to drop. */
    forget(key) {
      return entries.delete(key);
    },

    /**
     * Keep only the tables whose hosts are still reachable, and say which ones
     * went.
     *
     * THE ROSTER IS THE ONLY HONEST SOURCE for this. A host that closed its
     * table says `bye` and is forgotten by name; a host that walked out of the
     * building says nothing at all, and the only evidence is its absence from
     * `peers()`. Without this a table would sit on the lobby advertising open
     * seats at a felt nobody is at.
     */
    retain(hostDeviceIds) {
      const live = new Set(hostDeviceIds || []);
      const dropped = [];
      for (const [key, entry] of entries) {
        if (live.has(entry.hostDeviceId)) continue;
        entries.delete(key);
        dropped.push(key);
      }
      return dropped;
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
