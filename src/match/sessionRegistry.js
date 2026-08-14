// EVERY LIVE TABLE ON THIS DEVICE, AND THE TWO RULES ABOUT WHICH MAY EXIST.
//
// The registry is a `Map<tableId, TableSession>` with a door. It is small on
// purpose — all of the policy from TABLES_PLAN.md §1 lives here and nowhere
// else, so "may I host this?" has exactly one answer rather than one per call
// site. src/ui/party.js used to answer it three ways: a truthy `host` check, a
// truthy `client` check, and a directory lookup, and the second of those was
// the bug T1 removed (being in earshot of a neighbour's table is not being at
// one).
//
// THE TWO INVARIANTS ARE BOTH PER-PACK, not per-device:
//
//   one hosted table per pack   two Hearts tables on one device would be two
//                               games with one name, and `(hostDeviceId,
//                               packId)` is the uniqueness rule the wire
//                               already assumes for LIVE tables (§2).
//   one held seat per pack      you cannot sit at two Hearts games at once.
//                               You can host Hearts and sit at Crazy Eights,
//                               and that is the case the old `if (client)`
//                               refusal got wrong. HALF OF THIS RULE IS NOT
//                               ENFORCED HERE YET: holding two seats at once
//                               needs two joiner sessions, and src/ui/party.js
//                               can hold one (`joinTable` refuses a second).
//                               The seat half arrives with T4's seat stubs,
//                               where there is something for it to refuse.
//
// Both refusals return a SENTENCE rather than false. A dead button that will
// not say why is the thing #43 called out, so the notice travels with the
// refusal and the caller has nothing to invent.
//
// BINDING IS NOT MEMBERSHIP. `bind` records which session the felt is showing;
// it adds and removes nothing. A bound session is the one whose bots animate
// and whose host player's seat the clock exempts (§3); every other session in
// here is still running.

/**
 * @param sessions  optional seed, for tests
 */
export function createSessionRegistry() {
  const sessions = new Map();
  let boundId = null;

  const all = () => [...sessions.values()];
  const get = (tableId) => sessions.get(tableId) || null;

  /** The table we are hosting on this pack, if any. */
  const hostedForPack = (packId) =>
    all().find((s) => s.hosting() && s.packId === packId) || null;

  /**
   * The table we are SITTING at on this pack — sitting, not merely a client of.
   * A speculative join that never claimed a seat is not a reason to refuse
   * anything, which is the distinction party.js spells `seatedHere()`.
   */
  const seatedForPack = (packId) =>
    all().find((s) => !s.hosting() && s.packId === packId && heldSeat(s) !== null) || null;

  function heldSeat(session) {
    const seat = session.client?.seat?.();
    return seat === undefined ? null : seat;
  }

  return {
    all,
    get,
    hostedForPack,
    seatedForPack,
    size: () => sessions.size,

    /** Every table we hold the state for. */
    hosted: () => all().filter((s) => s.hosting()),
    /** Every table we are a client of. */
    joined: () => all().filter((s) => !s.hosting()),

    add(session) {
      sessions.set(session.tableId, session);
      return session;
    },

    /**
     * Forget a table and end it. The registry is the only owner, so dropping
     * the entry without stopping it would leak a host still answering frames.
     */
    remove(tableId) {
      const session = sessions.get(tableId);
      if (!session) return null;
      sessions.delete(tableId);
      if (boundId === tableId) boundId = null;
      session.bound = false;
      session.stop();
      return session;
    },

    /** Every table, ended. The "leave the surface" path. */
    clear() {
      for (const session of all()) session.stop();
      sessions.clear();
      boundId = null;
    },

    /**
     * May we open a table on this pack? Null means yes; a string is the notice
     * to show, already written in the second person.
     *
     * @param nameOf  packId -> display name, for a notice worth reading
     */
    refusalToHost(packId, { nameOf = (id) => id } = {}) {
      if (hostedForPack(packId)) return `You are already hosting ${nameOf(packId)}.`;
      const seated = seatedForPack(packId);
      if (seated) return `You are sitting at another ${nameOf(packId)} table. Leave it to host your own.`;
      return null;
    },

    /**
     * Point the felt at a session. Everything else keeps running.
     *
     * Passing null (or an unknown id) unbinds without ending anything, which is
     * what "go back to the lobby" means now.
     */
    bind(tableId) {
      const next = tableId ? sessions.get(tableId) || null : null;
      for (const session of all()) session.bound = session === next;
      boundId = next ? next.tableId : null;
      return next;
    },

    unbind() {
      for (const session of all()) session.bound = false;
      boundId = null;
    },

    /** The session the felt is showing, or null. */
    bound: () => (boundId ? sessions.get(boundId) || null : null),
  };
}
