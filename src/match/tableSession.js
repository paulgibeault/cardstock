// A TABLE THAT EXISTS WHETHER OR NOT ANYBODY IS LOOKING AT IT.
//
// Until now a hosted game lived on the felt: `createTableHost` was handed
// `liveState: () => tableContext()?.state`, so the state the host arbitrated
// against was whatever src/ui/table.js happened to be drawing. That is exactly
// right while there is one table and it is on screen, and it is the single
// assumption every decision in #43 breaks — two hosted packs, a seat at
// somebody else's table while your own is mid-hand, a game that survives being
// navigated away from.
//
// A `TableSession` is the owner that was missing. It holds the things that
// belong to ONE table for as long as that table exists:
//
//   the engine state (host) or the last ViewState (joiner),
//   the seat table (src/players/seats.js),
//   the turn timer and its per-table grace (host),
//   the createTableHost / createTableClient instance,
//   the last lobby frame this table published or received,
//   the host-side bookkeeping that used to be two module-level Sets.
//
// THE FELT BECOMES A RENDERER. It binds to whichever session is open and
// unbinds without destroying it — `bind`/`unbind` are about attention, not
// lifetime, and only `stop()` ends a table. That distinction is the whole
// point: an unbound host session still owns a state, still answers proposals,
// still runs its clock.
//
// WHY THE PIECES ATTACH RATHER THAN BEING CONSTRUCTOR ARGUMENTS. A host needs
// `liveState`, and the state lives here; a timer needs `waitsOn`, and the seat
// table lives here. Both would be circular as constructor arguments, so the
// session is born first and its instruments are handed to it. `stop()` is the
// one place that knows how to take them all down, which is what stops the
// teardown list drifting out of step with the setup list — the bug that lived
// in src/ui/table.js's adoptMatch/closeTable pair for the whole of solo play.

import { isSafeId } from './protocol.js';

/**
 * Open a session for one table.
 *
 * @param tableId  the minted SAFE_ID from protocol v2 — this table's name
 *                 across time, not just among the tables live right now.
 * @param packId   which game. The registry's two invariants are both per-pack.
 * @param role     'host' when we hold the state, 'joiner' when we hold a view.
 */
export function createTableSession({ tableId, packId, role, packName = '', variants = [] }) {
  if (!isSafeId(tableId)) throw new Error('createTableSession: tableId must be a SAFE_ID');
  if (role !== 'host' && role !== 'joiner') throw new Error('createTableSession: role must be host or joiner');

  const session = {
    tableId,
    packId,
    role,
    packName,
    variants,

    // THE STATE, AND WHERE IT NOW LIVES. On a host this is the engine state
    // every move is applied to; on a joiner it is the last view the host sent.
    // The felt reads it to draw and never owns it, which is the inversion.
    state: null,
    // Who is in each chair (src/players/seats.js), and who they are (the roster
    // the host publishes). Both outlive the deal — the party builds the seating
    // in the lobby and the same object is handed to the felt.
    seats: null,
    seating: null,
    pack: null,

    host: null,
    client: null,
    timer: null,
    // The headless bot driver (src/ui/botDriver.js), host-side only. Null on a
    // joiner, which never moves a seat it was not asked to.
    bots: null,

    // The last lobby frame this table published (host) or received (joiner).
    // Per-table because a device browsing a neighbour's seats while playing its
    // own would otherwise draw their roster onto your felt.
    lobbyFrame: null,

    // Host-side seat bookkeeping, per table because a seat that dropped at
    // Hearts says nothing about the same device's seat at Crazy Eights.
    decided: new Set(),      // seats whose terminal drop the host has answered
    unreachable: new Set(),  // seats a targeted send was refused for
    paused: false,

    // IS THE FELT SHOWING THIS ONE. Not a question about whether the table is
    // running — see the header. It is read by the timer rule (a host's own seat
    // is exempt only at the table on screen) and by the bot driver (a bound
    // table's bots go through the felt's animation pipeline, an unbound one's
    // do not).
    bound: false,

    // WHAT THE BOT DRIVER KEEPS ON A TABLE, in the shape `createBotDriver`
    // already expects (src/ui/botDriver.js) — the pending turn, the
    // announcement beats, and the two persona rolls behind them. They live here
    // rather than on the felt's render session because a hosted table that
    // nobody is looking at still has bots whose turn it is; the felt's copy
    // drives the table it is bound to, and this copy drives the rest.
    //
    // The decision caches are per-vulnerability-window and must die with the
    // match — see the driver's own note on why re-rolling would make
    // `callReliability: 0.5` behave like 1.
    botTimer: null,
    announceTimers: [],
    botCallDecision: new Map(),
    botCatchDecision: new Map(),
    // The driver's staleness guard, per table. "Play again" and leaving to the
    // lobby are invisible to any clock, so a scheduled turn checks this at fire
    // time and drops itself if the match it belonged to is gone.
    epoch: 0,

    hosting() { return role === 'host'; },

    /** The engine state, or null before the deal. Live reference, on purpose. */
    liveState() { return session.state; },

    /**
     * What the felt needs to draw this table — the shape `tableContext()`
     * returned when the felt owned all of it.
     */
    context() {
      if (!session.state && !session.pack) return null;
      return { state: session.state, seats: session.seats, pack: session.pack, seating: session.seating };
    },

    attach({ host = null, client = null, timer = null, bots = null } = {}) {
      if (host) session.host = host;
      if (client) session.client = client;
      if (timer) session.timer = timer;
      if (bots) session.bots = bots;
      return session;
    },

    /**
     * End the table. The one teardown point.
     *
     * Deliberately NOT what unbinding does: a session the felt walked away from
     * keeps everything below alive. Calling this twice is safe, because the
     * registry's remove path and an explicit "stop hosting" can both reach it.
     */
    stop() {
      // The epoch moves FIRST, so a bot turn already in flight drops itself
      // when it fires rather than reaching for a state we are about to null.
      session.epoch += 1;
      session.cancelBots();
      if (session.timer) session.timer.cancelAll?.();
      if (session.host) session.host.stop?.();
      if (session.client) session.client.stop?.();
      session.timer = null;
      session.host = null;
      session.client = null;
      session.bots = null;
      session.state = null;
      session.lobbyFrame = null;
      session.decided.clear();
      session.unreachable.clear();
      session.bound = false;
    },

    /**
     * Drop every scheduled bot turn and beat, and the rolls behind them.
     *
     * Called by `stop`, and on its own whenever the felt takes this table over:
     * two drivers scheduling against one state would move the same bot twice.
     */
    cancelBots() {
      if (session.botTimer) session.botTimer.cancel?.();
      session.botTimer = null;
      for (const timer of session.announceTimers) timer.cancel?.();
      session.announceTimers = [];
      session.botCallDecision.clear();
      session.botCatchDecision.clear();
    },
  };

  return session;
}
