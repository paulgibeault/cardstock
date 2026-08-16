// WHAT IS IN EARSHOT — and nothing about what to do with it.
//
// A lobby frame arriving from a peer answers one question: there is a table
// over there. Everything a device might do about that — point the panel at it,
// load its pack, draw a tile, sit down — is a decision made somewhere else,
// with the felt and the registry in view. This module is the layer underneath
// those decisions: it listens, it refuses what it cannot authenticate, and it
// keeps the directory and the seat stubs honest.
//
// EXTRACTED FROM src/ui/party.js (#73), which had grown to 2,584 lines and was
// the whole of the multiplayer screen. This is the first bite, chosen because
// it has the fewest tendrils: nothing here touches the DOM, the engine, the
// felt or a session, so the only thing that had to be negotiated on the way out
// was which callbacks the screen wanted back.
//
// THE ARROW POINTS ONE WAY. This module imports nothing from party.js — every
// seam it needs is injected, in the style of src/ui/botDriver.js. That is what
// makes it possible to read this file and know that the "is that table real"
// rules are all of them, rather than most of them.
//
// TWO RULES ABOUT TRUST, and they are the reason the sniffing is worth its own
// module rather than being inlined at the subscription:
//
//   a frame is believed only from a device we hold a DIRECT link to, and
//   never when it arrives RELAYED.
//
// Together they say a fellow joiner cannot advertise a table through the hub,
// or announce that somebody else's table has closed. Both tests live here, in
// one place, applied to every frame before anything downstream sees it.

import { FRAME, validateFrame, isAuthentic } from '../match/protocol.js';
import { createTableDirectory, tableKeyOf } from '../match/tableDirectory.js';
import {
  saveSeatStub, clearSeatStub, touchSeatStub, seatStubs,
} from '../arcade/storage.js';

/**
 * @param port        () => the peer port, or null when there is no surface.
 *                    A THUNK, because the port is built lazily and can arrive
 *                    long after this module does — a party surface appears
 *                    whenever the launcher says so.
 * @param selfId      () => this device's id, or null
 * @param peerName    (deviceId) => a display name, clamped and never trusted
 * @param hosting     () => are we hosting anything? `pruneDead` needs it: a
 *                    device is never in its own `peers()`.
 * @param now         () => the clock `pruneDead`'s grace is measured against.
 *                    Injected for the reason src/match/tableDirectory.js
 *                    injects one: a test that has to sleep to make an
 *                    assertion true is slow AND flaky.
 * @param clearStaleNotice (frame, known) => void, called BEFORE the sighting is
 *                    filed, while the previous frame for that table is still
 *                    the one on record. The panel's own rule about when an
 *                    epitaph has stopped being true; this module only knows
 *                    when to ask.
 * @param setNotice   (text) => void, for the one thing a sighting says out loud
 * NO DEFAULTS ON ANY OF THESE, which is the same rule #73 applied to party.js
 * itself: a seam that quietly defaults to a no-op is a callback you can forget
 * to wire and never find out about. There is one caller; it passes all of them.
 *
 * @param onChange   (change) => void — what is in earshot changed. One of:
 *
 *     { kind: 'sighted',     entry, frame, provenance }
 *     { kind: 'closed',      keys }   a host broadcast `bye 'closed'`
 *     { kind: 'hosts-gone',  keys }   hosts that left the party entirely
 *     { kind: 'superseded',  keys }   tables their own host has replaced
 *
 * FOUR KINDS, ONE CALLBACK, and the kinds are the load-bearing part: what the
 * panel should do afterwards differs in each — a table that closed hands the
 * focus on to whatever else is in the room, whereas one that was superseded
 * must NOT, because the table replacing it is being sighted in the same breath
 * and inheriting the focus would auto-join a browsing joiner into it. This
 * module reports WHAT HAPPENED and never what to do about it; the screen reads
 * the kind and decides (`moveFocus` in src/ui/party.js).
 *
 * It was four callbacks until the screen had one place to answer them from
 * (#75 stage 4). Four seams for four one-line handlers that differed only in
 * where they pointed the panel is a boundary describing the caller's old
 * structure rather than this module's job.
 */
/**
 * How long a table outlives its host falling off the roster.
 *
 * LONGER THAN THE MODEL'S PROBATION ON PURPOSE (`SETTLE_MS`, four seconds): the
 * tile has to finish becoming "offline" and be readable as such before it is
 * taken away, or the fade is just a slower vanish. Fifteen seconds also covers
 * an ordinary reconnect, so the common case is a tile that dims and recovers
 * without the player ever losing their place — while a lobby still does not
 * accumulate ghosts of tables nobody is at.
 */
export const PRUNE_GRACE_MS = 15_000;

export function createTableSightings({
  port,
  selfId,
  peerName,
  hosting,
  now = () => Date.now(),
  clearStaleNotice,
  setNotice,
  onChange,
}) {
  // EVERY TABLE IN EARSHOT, which used to be a single `invitation` slot — see
  // the header of src/match/tableDirectory.js for what that one slot cost. It
  // is owned here because this is the only code that WRITES to it from the
  // wire; the screen reads it, and files its own table through `sight`.
  // THE SAME CLOCK THE GRACE IS MEASURED AGAINST. `pruneDead` compares an
  // entry's `lastSeenAt` to now, so the hand that stamps a sighting and the
  // hand that reads it must be the same one — two clocks here would be a grace
  // that is right only when both happen to agree.
  const tables = createTableDirectory({ now });
  let off = null;

  /**
   * The same host, the same game, a DIFFERENT table.
   *
   * `(hostDeviceId, packId)` is the uniqueness rule for tables that are live,
   * and the minted id is what tells two apart across time (plan §2) — so this
   * pairing means exactly one thing: they ended the game we had a seat at and
   * dealt another. The seat is not coming back, and a tile that went on
   * promising it would be the "sign on an open door saying CLOSED" the sniffer
   * already worries about elsewhere.
   *
   * Said ONCE without needing a flag to remember: clearing the stub removes the
   * only thing that makes this true, so the next frame finds nothing to
   * announce.
   */
  function noteSupersededSeat(frame) {
    if (!frame || frame.hostDeviceId === selfId()) return;

    // THE OLD TILE GOES TOO, and this half is not about our seat at all. A host
    // that ends a table politely sends `bye 'closed'` and the directory forgets
    // it; one whose battery died and who came back to deal again sends nothing,
    // and `pruneDead` will not help because that host is plainly alive. The
    // pair being unique among LIVE tables is what makes the older entry
    // provably dead, so it is dropped here rather than left advertising open
    // seats.
    const stale = [];
    for (const entry of tables.all()) {
      if (entry.hostDeviceId !== frame.hostDeviceId) continue;
      if (entry.packId !== frame.packId) continue;
      if (entry.key === frame.tableId) continue;
      tables.forget(entry.key);
      stale.push(entry.key);
    }
    if (stale.length) onChange({ kind: 'superseded', keys: stale });

    const superseded = seatStubs().find((stub) => stub.hostDeviceId === frame.hostDeviceId
      && stub.packId === frame.packId
      && stub.tableId !== frame.tableId);
    if (!superseded) return;
    clearSeatStub(superseded.tableId);
    setNotice(`${peerName(frame.hostDeviceId)} started a new game — your old seat is gone.`);
  }

  /**
   * Record — or forget — our seat at the table this frame describes.
   *
   * THE HOST'S ROSTER IS WHAT MAKES IT TRUE. We write the stub when the host
   * says we are in the chair, never when we ask for it: a claim that was
   * refused, or one still in flight, would otherwise leave a tile promising a
   * seat nobody gave us. It is read off the LOBBY rather than a view because a
   * seat is real before the deal, and a table waiting to start is exactly one
   * worth coming back to.
   *
   * EXPORTED, because our own host's frames reach us through the client rather
   * than through the subscription below — already authenticated, and just as
   * much a statement about which chair is ours.
   */
  function noteSeatFrom(frame) {
    if (!frame || frame.hostDeviceId === selfId()) return;
    const me = selfId();
    const mine = (frame.seats || []).find((s) => s.kind === 'device' && s.deviceId === me);
    if (mine) {
      saveSeatStub({
        tableId: frame.tableId,
        hostDeviceId: frame.hostDeviceId,
        packId: frame.packId,
        seat: mine.seat,
        // Captured NOW, while they are still on the roster. Once they go quiet
        // `peerName` can only answer "Someone", and that is the exact moment
        // the tile needs to say whose table it was.
        hostName: peerName(frame.hostDeviceId),
      });
      return;
    }
    // NOT IN THE ROSTER ANY MORE. The host gave the seat to a bot, or somebody
    // else took it — either way the promise is void and the tile must stop
    // making it. `bye 'replaced'` says the same thing; this catches the case
    // where we simply were not listening when it did.
    clearSeatStub(frame.tableId);
  }

  /**
   * A `bye` from a host we know about.
   *
   * ONLY 'closed' RETIRES A TABLE, and the precision matters because three
   * different partings share this frame kind. A joiner leaving says 'leave' and
   * reaches us relayed through the hub — that is somebody standing up, not a
   * table ending. A removed player is told 'replaced', privately, about their
   * own seat. Only the host broadcasting 'closed' means the felt is gone, and
   * only the host's own direct frame is believed for it: a relayed 'closed' is
   * a fellow joiner claiming an authority it does not have.
   */
  function noteBye(fromDeviceId, frame, meta) {
    if (meta?.relayed) return;
    if (frame.why !== 'closed') return;
    // WHICH TABLE CLOSED, said by the frame itself. Under v1 this had to be
    // inferred from the sender, which was right only because a device could
    // host just one — the assumption the tables work exists to remove.
    const key = frame.tableId;
    const entry = tables.get(key);
    if (!entry || entry.hostDeviceId !== fromDeviceId) return;
    tables.forget(key);
    onChange({ kind: 'closed', keys: [key] });
  }

  /**
   * A host that stopped answering.
   *
   * A table whose host has left the party is not a table any more, and nothing
   * says so on the wire: a host that closes politely broadcasts `bye`, but one
   * whose battery died says nothing, and the only evidence is the roster.
   * Without this, that table would sit on the lobby forever advertising open
   * seats.
   *
   * BUT NOT ON THE FIRST GLANCE (#78). Dropping the entry the instant a host
   * falls off `peers()` meant a tile that vanished mid-glance and came back a
   * second later — and once the entry is gone the model cannot age it, because
   * the table is no longer among its inputs at all. So a host we have heard
   * from recently keeps its table through the gap; the screen says "offline"
   * over it (the model's `liveness`, which now asks whether the host is
   * reachable as well as whether a frame exists) and the entry is dropped for
   * real once the grace is up.
   *
   * @returns the earliest moment a spared table becomes prunable, or null when
   *          none is waiting. NOTHING ELSE WOULD RE-ASK: pruning runs on roster
   *          changes, and a host going quiet produces exactly one. The caller
   *          arms a single timer off this — same shape as the model's
   *          `nextChangeAt` (src/ui/party.js).
   */
  function pruneDead() {
    const live = (port()?.peers() || []).map((p) => p.deviceId);
    // OURSELVES, EXPLICITLY. A device is never in its own `peers()`, so a host
    // that filed its own table would prune it on the next roster change and its
    // tile would blink out while the game was still running.
    if (hosting()) live.push(selfId());

    const at = now();
    let dueAt = null;
    // SPARED BY THEIR HOST, because that is what `retain` keys on. A host with
    // two tables keeps both, which is the honest reading: it is the DEVICE we
    // have not heard from, not one of its tables.
    const spared = [];
    for (const entry of tables.all()) {
      if (live.includes(entry.hostDeviceId)) continue;
      const prunableAt = entry.lastSeenAt + PRUNE_GRACE_MS;
      if (at >= prunableAt) continue;
      spared.push(entry.hostDeviceId);
      dueAt = dueAt === null ? prunableAt : Math.min(dueAt, prunableAt);
    }

    const dropped = tables.retain([...live, ...spared]);
    if (dropped.length) onChange({ kind: 'hosts-gone', keys: dropped });
    return dueAt;
  }

  /**
   * A LOBBY FRAME WE BELIEVE, FROM WHICHEVER DOOR IT CAME THROUGH (#75 stage 3).
   *
   * There are two, and there have to be. The subscription below authenticates
   * with this file's rules — direct sender, not relayed. Our own client
   * authenticates with `src/match/client.js`'s, which are about the one host it
   * sat down with. Neither subsumes the other, and the client is the only path
   * that can vouch for a frame from a host whose link has degraded.
   *
   * WHAT MUST NOT BE TWO IS WHAT HAPPENS NEXT. Each door used to carry its own
   * partial copy: the subscription filed the sighting, aged the seat stub,
   * retired a superseded table and cleared a stale notice; the client's
   * `onLobby` filed the sighting and wrote the seat stub, and did none of the
   * rest. Since both doors receive the same broadcast — two separate
   * `peer.onMessage` subscriptions — most frames went through the full path and
   * then a partial one, and a frame that reached ONLY the client got the
   * partial path alone: no stub ageing, no superseded table retired.
   *
   * So the doors decide whether to believe a frame. This decides what believing
   * one means, once.
   *
   * IDEMPOTENT, BECAUSE THE WIRE IS AND BECAUSE BOTH DOORS FIRE. A host
   * re-broadcasts its lobby on every `onReady` and every seat change; running
   * this twice for one frame has to be exactly as harmless as running it once.
   * Every step below is: `sight` upserts, `touchSeatStub` restamps,
   * `noteSupersededSeat` finds nothing the second time, and `clearStaleNotice`
   * compares against a `known` that is now the frame itself.
   *
   * @param provenance 'wire' from the subscription, 'client' from our own
   *                   client handing over a frame it authenticated. Passed
   *                   through on the change because the screen focuses
   *                   differently for each: a frame our own client handed over
   *                   is from the table we are already sitting at, so it raises
   *                   no auto-join question and only asks whether the panel is
   *                   pointed at anything yet.
   */
  function noteLobby(frame, { provenance }) {
    // A FRESH INVITATION CLEARS THE LAST ONE'S EPITAPH. Asked while `known` is
    // still the previous frame for this table, and before the superseded check
    // has anything to say — a sighting that cleared the notice after that would
    // wipe the one sentence that path exists to print.
    const known = tables.get(tableKeyOf(frame));
    clearStaleNotice(frame, known);

    const entry = tables.sight(frame);
    if (!entry) return null;
    // HEARING THE HOST IS ENOUGH TO KEEP THE PROMISE ALIVE. A seat we hold at a
    // table we are not currently a client of still ages on this, which is what
    // stops a week of watching from someone else's felt rolling it off.
    touchSeatStub(entry.key);
    noteSupersededSeat(frame);
    noteSeatFrom(frame);
    onChange({ kind: 'sighted', entry, frame, provenance });
    return entry;
  }

  /**
   * The table sniffer.
   *
   * A joiner cannot start a real client before it knows WHICH pack to load —
   * the client refuses a lobby whose pack is not the one this build has open,
   * and quite right too. So this listens for the one frame that answers that
   * question, applying the two rules in this file's header.
   *
   * It fills the directory and never holds a scrap of state.
   */
  function start() {
    if (off || !port()) return;
    off = port().onMessage((payload, fromDeviceId, meta) => {
      // EVERYBODY HEARS THE ROOM, whatever they are doing in it. This used to
      // give up the moment we became a client — `if (client || host)` — which
      // meant the second table in a party was unknowable to anybody already
      // sitting at the first, and a host was deaf to every table but its own.
      // Hearing is not joining: what a host or a seated joiner does with a
      // sighting is put it on a tile, and the guards below are what keep it
      // from becoming anything more.
      if (!fromDeviceId) return;
      const verdict = validateFrame(payload);
      if (!verdict.ok) return;
      const frame = verdict.frame;
      if (frame.k === FRAME.BYE) return void noteBye(fromDeviceId, frame, meta);
      if (frame.k !== FRAME.LOBBY) return;
      // Our own broadcast, come back to us. Not a table we discovered.
      if (frame.hostDeviceId === selfId()) return;
      // AUTHENTIC MEANS "FROM A DEVICE WE HOLD A DIRECT LINK TO", which is not
      // the same test as "from the single device we hold a direct link to" —
      // and the difference is the whole of two tables. With two hosts in the
      // party there are two direct peers, the old `direct.length === 1`
      // answered null, and every lobby frame from BOTH of them was dropped as
      // unauthenticated: not one table too few, but nothing at all. The
      // security property is the one that mattered and it is unchanged — the
      // sender must be direct and the frame must not be relayed, so a fellow
      // joiner cannot advertise a table through the hub.
      const direct = port().peers().filter((p) => p.direct).map((p) => p.deviceId);
      const hostDeviceId = direct.includes(fromDeviceId) ? fromDeviceId : null;
      if (!isAuthentic(FRAME.LOBBY, { fromDeviceId, hostDeviceId, relayed: meta?.relayed })) return;

      noteLobby(frame, { provenance: 'wire' });
    });
  }

  return {
    // THE DIRECTORY ITSELF, read-only by convention. Handing back narrow
    // accessors was the first draft and it was twelve one-line methods for
    // twenty-six reads that already say what they mean — `tables.forPack`,
    // `tables.latest`, `tables.all` — none of which can lie about a table. The
    // WRITES are what needed an owner, and every one of them is above.
    tables,
    start,
    pruneDead,
    // THE OTHER DOOR'S WAY IN. Our own client authenticates a frame its own
    // way and then hands it here, so both doors mean the same thing by
    // believing one.
    noteLobby,
  };
}
