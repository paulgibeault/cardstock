// WHERE THE PANEL LOOKS, AND EVERY REASON IT MOVES.
//
// Focus is a question about WHAT IS ON SCREEN, and deliberately not about which
// host we are exchanging frames with. Keeping those apart is what lets a device
// see three tables while playing at one, and look at a neighbour's seats
// without leaving its own — so this file knows nothing about clients, sessions
// or the felt, and takes the two or three facts it needs as arguments.
//
// THE RULES EXISTED BEFORE THIS FILE DID, as comments at six call sites in
// src/ui/party.js: each correct on its own, none of them readable beside the
// others. That is how the one with NO refocus — a table its own host replaced —
// came to look like an oversight rather than the load-bearing case it is.
//
// PURE, SO THE TRANSITIONS CAN BE TESTED (#75 stage 4). They never had coverage
// of any kind: `activeKey` is a module-scoped `let` in a file that touches
// `document` at import time, so no Node test could reach it and the browser
// suite could only ever assert where the focus ENDED UP after a whole scenario.
// A rule that returns the next key from the current one is a table of cases.

/**
 * @param change   what happened, in the shape src/ui/tableSightings.js reports:
 *                 { kind: 'sighted', entry, provenance } — a lobby frame filed
 *                 { kind: 'closed' | 'hosts-gone' | 'superseded', keys }
 *                 { kind: 'chosen', key } — a finger, not a rule
 *                 { kind: 'stopped-hosting' } — we ended our own table
 * @param focusedKey the table the panel is about now, or null
 * @param attached   are we hosting or sitting at anything?
 * @param joining    is a join in flight? (see `joinTable`'s one-at-a-time flag)
 * @param latestKey  the most recently sighted table, or null
 * @param knows      (key) => is this a table we have actually heard of? Focus
 *                   never moves to one we have not: a panel pointed at a table
 *                   with no frame draws nothing and offers nothing.
 * @returns the key the panel should be about — ALWAYS the whole answer, never
 *          a mutation. A caller that ignores it changes nothing, which is the
 *          property that makes this testable.
 */
export function nextFocus(change, { focusedKey, attached, joining, latestKey, knows }) {
  const settle = (key) => (key && knows(key) ? key : focusedKey);

  switch (change.kind) {
    /**
     * A TABLE WE HEARD ABOUT. The rule is attachment, not recency: an
     * unattached device follows the latest table it hears about — with one
     * table in earshot, exactly the single-slot behaviour this all replaced —
     * and a device already at a table, its own or somebody else's, is not
     * dragged off it by a neighbour dealing.
     *
     * A frame our own client handed over asks a narrower question, because we
     * are already sitting at that table: only whether the panel is pointed at
     * anything yet.
     */
    case 'sighted':
      if (change.provenance === 'client') {
        return focusedKey ? focusedKey : settle(change.entry.key);
      }
      if (attached || joining) return focusedKey;
      return settle(change.entry.key);

    /**
     * A TABLE THAT ENDED, or a host that left the party. The panel falls back
     * to whatever else is in the room — which, for the host who was never told
     * about the neighbours' tables, used to be nothing at all.
     */
    case 'closed':
    case 'hosts-gone':
      if (!focusedKey || !change.keys.includes(focusedKey)) return focusedKey;
      return latestKey && knows(latestKey) ? latestKey : null;

    /**
     * A TABLE ITS OWN HOST REPLACED, AND THIS IS THE ONE THAT MUST NOT REFOCUS.
     *
     * The table replacing it is being sighted in the same breath, so the latest
     * sighting IS that table — and handing it the focus would auto-join a
     * joiner who was only browsing, because the sighting rule joins the table
     * the panel is pointed at. The panel falls back to whatever we are attached
     * to instead, which `shownFrame()` answers on its own.
     */
    case 'superseded':
      return change.keys.includes(focusedKey) ? null : focusedKey;

    /**
     * THE PLAYER CHOSE. Tapping a tile, opening the panel about a table,
     * switching to a seat, hosting a game. No rule to apply: the question was
     * answered by a finger.
     */
    case 'chosen':
      return settle(change.key);

    /**
     * OUR OWN TABLE ENDED, BY US. Not the same as `closed`, which is somebody
     * else's: there is no "were we looking at it" to ask, because the table we
     * were looking at is the one we just took away.
     */
    case 'stopped-hosting':
      return latestKey && knows(latestKey) ? latestKey : null;

    default:
      throw new Error(`nextFocus: unknown change ${change?.kind}`);
  }
}
