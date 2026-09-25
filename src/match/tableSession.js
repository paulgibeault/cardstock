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
//
// SOLO PLAY IS A TABLE TOO (#225). A match nobody else is at used to live on the
// felt's own render session (src/ui/session.js), which therefore carried a second
// copy of `pack/state/seats/seating` for every hosted table it showed, a second
// set of bot-driver slots, and a second persist path with the same policy
// written twice. Now every match the felt draws is one of these: role `'solo'`
// for a table only this screen holds — no host, no client, no lobby frame, no
// table id — and the felt's render session points at it rather than copying it.
// The felt owns a solo table outright (it ends when the felt lets go of it); a
// hosted or joined one belongs to the registry, and the felt only borrows it.
//
// WHAT IS NOT HERE: `bound`. Which table the felt is showing is the registry's
// answer (src/match/sessionRegistry.js `isBound`), and nowhere else's — it was
// stored here as well, derived a third time by the party model, and three
// copies of one pointer are three chances to disagree.

import { isSafeId } from './protocol.js';

const ROLES = new Set(['host', 'joiner', 'solo']);

/**
 * Open a session for one table.
 *
 * @param tableId  the minted SAFE_ID from protocol v2 — this table's name
 *                 across time, not just among the tables live right now. A solo
 *                 table has none: nothing on the wire ever names it.
 * @param packId   which game. The registry's two invariants are both per-pack.
 * @param role     'host' when we hold the state and publish it, 'joiner' when we
 *                 hold a view, 'solo' when we hold the state and nobody else is
 *                 at the table.
 */
export function createTableSession({ tableId = null, packId, role, packName = '', variants = [] }) {
  if (!ROLES.has(role)) throw new Error('createTableSession: role must be host, joiner or solo');
  if (role !== 'solo' && !isSafeId(tableId)) throw new Error('createTableSession: tableId must be a SAFE_ID');
  if (role === 'solo' && tableId !== null) throw new Error('createTableSession: a solo table has no tableId');

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
    // THE LOADED PACK (manifest, rules, template, cards), or null until one has
    // been fetched. Never a descriptor: `packId`, `packName` and `variants`
    // above are what a table is called before its pack has arrived, and a
    // host's table spends its whole lobby phase in exactly that state.
    pack: null,

    // IS THIS TODAY'S DAILY RUN? `{ date, seed }`, or null for an ordinary game.
    // Solo only. It decides which storage slot the match is written to
    // (src/arcade/persist.js) and which record its ending goes into.
    daily: null,
    // How many hints this match has handed out. Not in the log — a hint is not
    // a move — so it rides beside the saved match and is counted into the
    // pack's record when the match concludes.
    hintsTaken: 0,
    // THE PLAYER ENDED IT (#166). A match walked out of from the round summary
    // is over whatever its state says — `gameOver` is the engine's answer, and
    // the engine was not asked — so this is the other half of "a finished
    // match is not resumable", and persisting reads both.
    concluded: false,

    host: null,
    client: null,
    timer: null,
    // The roster subscription this table holds for itself, so its drops are
    // noticed whether or not it is the one on screen.
    unsubscribePeers: null,
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
    // NO `paused` HERE (#203). There was one, and nothing ever wrote it: the
    // pause a host can ask for is the felt's (`setTablePaused` in src/ui/table.js),
    // held by the felt's own scheduler, and the headless driver read this field
    // as though it were a second copy of that answer. A table-level pause is a
    // real thing to want — see the note in `askAboutSeat` — but it has to be
    // written before it is read.
    // HOW LONG A SEAT GETS AT THIS TABLE (plan §7). Per-table because the right
    // answer differs between a game played in one room and one played across a
    // week, and the host is the only one who knows which this is. Null until
    // they choose; the caller falls back to the default.
    graceMs: null,

    // WHAT THE BOT DRIVER KEEPS ON A TABLE, in the shape `createBotDriver`
    // already expects (src/ui/botDriver.js) — the pending turn, the
    // announcement beats, and the two persona rolls behind them. ONE SET PER
    // TABLE, whichever driver is moving it (#225): the felt's driver while the
    // felt is showing this table, the headless one (src/ui/party.js) while it
    // is not. There used to be a second set on the felt's render session, so a
    // hand-over was two drivers each holding half the answer; now whoever
    // schedules first cancels what is in the slot, and a hand-over is the
    // outgoing driver letting go (`cancelBots`) before the incoming one starts.
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
    /** A table only this screen holds — solo play. It ends when the felt lets go. */
    local() { return role === 'solo'; },

    /** The engine state, or null before the deal. Live reference, on purpose. */
    liveState() { return session.state; },

    /**
     * WHICH SEAT WE HOLD AT THIS TABLE, or null for none.
     *
     * "Am I sitting here" was answered twice — `heldSeat` in
     * src/match/sessionRegistry.js and a `session?.client?.seat?.() != null` in
     * src/ui/partyModel.js — and both had to know that the answer lives on the
     * client rather than on the session. That is the session's own business, so
     * it is the session that says it.
     *
     * UNDEFINED BECOMES NULL, AND SEAT 0 STAYS 0. A joiner that never claimed
     * gets `undefined` from a client with no seat and a host gets `undefined`
     * from no client at all; both mean "no chair". Seat zero is a chair like
     * any other, which is why this compares against undefined rather than
     * testing truthiness — see tests/tableSession.test.js.
     */
    seatedAt() {
      const seat = session.client?.seat?.();
      return seat === undefined ? null : seat;
    },

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
      session.unsubscribePeers?.();
      session.unsubscribePeers = null;
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
    },

    /**
     * Drop every scheduled bot turn and beat, and the rolls behind them.
     *
     * Called by `stop`, and on its own at every hand-over between the two
     * drivers: when the felt takes this table over (src/ui/party.js
     * `bindFelt`) and when it lets go (src/ui/session.js `stopSession`). Two
     * drivers scheduling against one state would move the same bot twice.
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
