// WHAT THIS DEVICE BELIEVES ABOUT EVERY TABLE, AS ONE ANSWER.
//
// src/ui/party.js kept its beliefs in five places — the sighting directory, the
// session registry, the seat stubs in storage, the per-session `unreachable`
// and `decided` sets, and a `notice` string — and every surface it drew ran its
// own little join across some subset of them at render time. The tile row, the
// lobby ribbon, the seat grid, the presence strip and `partySnapshot` each
// answered "what tables are there, and what is happening at them" separately.
//
// FIVE JOINS OF THE SAME FACTS DISAGREE, and the file's own comments record it
// happening: the tile row kept a tile for a host who had left the party while
// the ribbon for that same table had already, correctly, gone. `tablesToDraw`
// is the tell — it hand-merges live sightings with dormant seat stubs because
// no single store could answer "what tables exist for this player".
//
// So: one derivation, here, and every surface renders what it says.
//
// PURE, AND THAT IS THE POINT (#75). No DOM, no `Arcade`, no module state, no
// clock of its own — every input arrives as data or as a narrow reader, in the
// style of src/ui/botDriver.js. TABLES_PLAN §11 records that party.js, table.js
// and lobby.js have no unit coverage and that every bug in them was found by
// driving three real browsers. This file is the first party-side code that runs
// under `node --test`, which is what lets the roster-churn cases — a seat
// replaced mid-hand, a host rehydrating while a joiner holds a stub, a table
// superseded while the panel is looking at it — be written down as tests
// instead of as comments.
//
// IT DERIVES; IT DOES NOT DECIDE. Nothing here focuses a table, joins one,
// repaints anything or sends a frame. Those need the felt and the registry in
// view and stay in party.js. This answers what is true, once, so that the code
// which acts has one account to act on.

import { botById, initialsOf, pickBotIds } from '../players/roster.js';
import { seatStatus } from '../match/host.js';

/** The grace a table falls back to when its host never chose (party.js §7). */
const DEFAULT_GRACE_MS = 60_000;

/**
 * A peer's display name, from the roster, clamped and never trusted.
 *
 * TEXT FROM A PEER IS DATA. This module produces strings for `textContent` and
 * never for markup — the rule party.js's header sets out, kept here because
 * this is now where the strings are made.
 */
function nameOfPeer(deviceId, { peers, self, publishedName }) {
  if (!deviceId) return 'Someone';
  // Our own seat, seen from outside: this is what goes in the roster we
  // PUBLISH. The screen re-answers with `myName` when it draws our own row.
  if (deviceId === self) return publishedName;
  const entry = (peers || []).find((p) => p.deviceId === deviceId);
  return String(entry?.name || '').slice(0, 60) || 'Someone';
}

/**
 * Everybody at a table, indexed by seat.
 *
 * `buildSeating` (src/players/roster.js) cannot serve here: it derives the
 * opponents from the match SEED, and a joiner has no seed and must never be
 * given one — the seed reconstructs the whole shuffle. So the identities come
 * from the roster the host publishes, and the bot faces are drawn from a seed
 * every device already agrees on: the HOST'S DEVICE ID. Same input, same faces,
 * no secret shared.
 */
export function seatingFromRoster(frame, ctx) {
  const { self, myName } = ctx;
  const roster = frame?.seats || [];
  const seatCount = frame?.seatCount || roster.length;
  const botSeats = roster.filter((s) => s.kind === 'bot').map((s) => s.seat);
  const botIds = pickBotIds(frame?.hostDeviceId || 'party', botSeats.length);
  // THE HOST ALREADY HAS AN ANSWER, and it is the one on the felt. Deriving a
  // second set of bot faces here put Cass and Nell in the seat grid while Otto
  // and Bruno sat at the same two seats on the table behind it. The derivation
  // is for a JOINER, which has no seed and no seating; the host defers to its
  // own — but ONLY for its own table. A host looking at a NEIGHBOUR'S roster
  // derives like any other joiner, or our bots' faces land on their chairs.
  //
  // ONE FLAG, TWO QUESTIONS, and they are not the same one — carried over
  // verbatim from party.js because #75 stage 1 changes no behaviour, but worth
  // naming now that it is written down once instead of inline. "Do we hold bot
  // faces of our own" and "may we trust our live roster over the frame we
  // published" both read off `own`, so a host BEFORE THE DEAL — when
  // `session.seating` is still null — falls back to frame names and does not
  // pick up a peer who renames themselves until the first seat change. A narrow
  // window, a cosmetic symptom, and a real conflation. Filed rather than fixed
  // here; splitting it is a behaviour change and belongs in its own commit.
  const own = ctx.ownSeating || null;

  const out = [];
  for (let seat = 0; seat < seatCount; seat++) {
    const entry = roster.find((s) => s.seat === seat) || { seat, kind: 'empty' };
    if (entry.kind === 'bot') {
      if (own?.[seat]?.isBot) { out.push(own[seat]); continue; }
      const bot = botById(botIds[botSeats.indexOf(seat)]);
      // A joiner takes the NAME the host published when there is one — the host
      // is looking at the real bot — and falls back to the shared derivation
      // only for a roster that predates it.
      const name = String(entry.name || bot.name).slice(0, 60);
      out.push(Object.freeze({
        seat, name, shortName: name, icon: bot.icon,
        initials: initialsOf(name), color: bot.color,
        isBot: true, botId: bot.id, persona: null, tagline: '', opponentKey: `bot:${bot.id}`,
      }));
      continue;
    }
    if (entry.kind === 'empty') {
      out.push(Object.freeze({
        seat, name: 'Open seat', shortName: 'Open', icon: '·', initials: '··',
        color: '#6b7280', isBot: false, botId: null, persona: null, tagline: '', opponentKey: null,
      }));
      continue;
    }
    const mine = entry.deviceId === self;
    // WHOSE ANSWER TO TRUST DEPENDS ON WHICH SEAT WE ARE IN. The host holds a
    // direct link to every player and can read the live roster, so it uses that
    // and stays current when somebody renames themselves. A joiner cannot: its
    // `peers()` contains only the host, so a fellow joiner's name exists
    // nowhere but the frame the host published.
    const fromRoster = own ? nameOfPeer(entry.deviceId, ctx) : entry.name;
    const name = mine
      ? myName
      : String(fromRoster || nameOfPeer(entry.deviceId, ctx)).slice(0, 60);
    out.push(Object.freeze({
      seat,
      name,
      // The status line stays second-person whatever the name is.
      shortName: mine ? 'You' : name,
      icon: mine ? '★' : '●',
      initials: initialsOf(name),
      color: mine ? '#f6c453' : '#5b8def',
      isBot: false,
      botId: null,
      persona: null,
      tagline: '',
      // A peer's head-to-head record files under its device, never its name —
      // a name is a thing anybody can type.
      opponentKey: entry.deviceId ? `peer:${entry.deviceId}` : null,
    }));
  }
  return out;
}

/**
 * Every seat's presence, as this device can honestly know it.
 *
 * THE ASYMMETRY IS THE WHOLE FUNCTION, and it is a rule about honesty rather
 * than a rendering detail. ON OUR OWN TABLE presence is computed from the
 * transport roster, through the same pure `seatStatus` the host itself uses —
 * one function, so the roster we publish and the grid we draw cannot disagree.
 * ON ANYBODY ELSE'S it comes from the host's lobby frame, and it has to: a
 * member's `peers()` contains ONLY the host, so a joiner asking the transport
 * about a FELLOW joiner gets silence, not absence. Reading that silence as
 * "gone" would show every other player as having left.
 *
 * Asking the host module about a seat at a NEIGHBOUR'S table would answer about
 * our own seat of that index — a roster that looks plausible and belongs to a
 * different felt.
 *
 * `peer.presence` (launcher WP-L1) would let a joiner see fellow members
 * directly. It is not shipped, so that branch currently never fires —
 * deliberately written now so the upgrade is a one-line change.
 */
function presenceBySeat(frame, session, ctx) {
  const out = new Map();
  const ours = ctx.self && frame?.hostDeviceId === ctx.self;
  if (ours && session?.hosting() && session.seats) {
    for (let seat = 0; seat < session.seats.count; seat++) {
      out.set(seat, seatStatus(session.seats.ownerOf(seat),
        { peers: ctx.peers, selfDeviceId: ctx.self }));
    }
    return out;
  }
  const live = ctx.presence || null;
  for (const entry of frame?.seats || []) {
    let status = entry.status
      || (entry.kind === 'bot' ? 'bot' : entry.kind === 'empty' ? 'empty' : 'connected');
    if (live && entry.kind === 'device') {
      const seen = live.find((p) => p.deviceId === entry.deviceId);
      if (seen) {
        status = seen.status === 'interrupted' ? 'interrupted'
          : seen.status === 'gone' ? 'gone' : 'connected';
      }
    }
    out.set(entry.seat, status);
  }
  return out;
}

/**
 * The deadlines this table is running, from whichever end of the wire we are on.
 *
 * The host reads its own timer; a client reads the deadlines its host SHIPPED
 * with the view. Both are the same absolute instant, which is the entire point
 * of sending an instant rather than a duration — a countdown drawn from
 * "60 seconds from when this arrived" drifts by however long it took to arrive.
 *
 * PER SESSION, so a seat at two tables gets two answers rather than the felt's.
 */
function deadlinesOf(session) {
  if (!session) return [];
  if (session.hosting()) return session.timer?.deadlines() || [];
  return session.state?.deadlines || [];
}

/** The seats a lobby frame says nobody has taken. */
function openSeatsOf(frame) {
  return (frame?.seats || []).filter((s) => s.kind !== 'device').length;
}

/** Which seat this device holds at a table, per the host's own roster. */
function seatOfSelf(frame, self) {
  const mine = (frame?.seats || []).find((s) => s.kind === 'device' && s.deviceId === self);
  return mine ? mine.seat : null;
}

/**
 * What we are to a table, in one word.
 *
 * FOUR ANSWERS, AND THEY ARE NOT THE SAME QUESTION AS "is it live". A seat we
 * hold at a table whose host is asleep is still `seated`; it is `offline` that
 * says nobody is there. Keeping them apart is what lets the dormant tile make
 * its promise ("your seat, waiting") without a control that cannot work.
 */
function relationTo({ hosted, joined, seat }) {
  if (hosted) return 'hosting';
  if (seat !== null) return 'seated';
  if (joined) return 'watching';
  return 'none';
}

/**
 * ONE VIEW OF ONE TABLE, live or dormant.
 *
 * `frame` is null for a dormant entry — a seat stub whose host is advertising
 * nothing — which is why every frame-derived field below has an answer for
 * "there is no frame". That case is not an edge: it is what a player sees after
 * closing the tab on a game somebody else is hosting.
 */
function viewOf({ tableId, frame, stub, session, lastSeenAt }, ctx) {
  const hostDeviceId = frame?.hostDeviceId || stub?.hostDeviceId || null;
  const packId = frame?.packId || stub?.packId || null;
  const ours = !!ctx.self && hostDeviceId === ctx.self;
  const hosted = !!session?.hosting();
  const joined = !!session && !hosted;
  // THE HOST'S ROSTER IS THE AUTHORITY while there is one; the stub is what the
  // promise falls back to. A stub's `seat` is what the host last confirmed, so
  // it is the honest answer for a table nobody is advertising.
  const seat = frame ? seatOfSelf(frame, ctx.self) : (stub ? stub.seat : null);
  // OUR OWN SEATING, ONLY FOR OUR OWN TABLE — see seatingFromRoster.
  const ownSeating = ours && hosted ? session.seating || null : null;
  const seating = frame ? seatingFromRoster(frame, { ...ctx, ownSeating }) : [];
  const presence = frame ? presenceBySeat(frame, session, ctx) : new Map();
  const unreachable = session?.unreachable || new Set();
  const deadlines = deadlinesOf(session);

  return {
    tableId,
    hostDeviceId,
    packId,
    packName: ctx.packNameOf(packId) || packId || '',
    // Captured while they were still on the roster, for a stub — once a host
    // goes quiet `nameOfPeer` can only answer "Someone", and that is the exact
    // moment the tile needs to say whose table it was.
    hostName: frame
      ? nameOfPeer(hostDeviceId, ctx)
      : (stub?.hostName || nameOfPeer(hostDeviceId, ctx)),
    ours,
    // ONE WORD, and it is about the HOST rather than the game. "Paused" or
    // "waiting" would be claims about a table we cannot see; offline is the
    // only thing this device actually knows.
    liveness: frame ? 'live' : 'offline',
    lastSeenAt: lastSeenAt ?? stub?.lastSeenAt ?? null,
    relation: relationTo({ hosted, joined, seat }),
    bound: !!session?.bound,
    focused: tableId === ctx.focusedKey,
    started: frame ? !!frame.started : false,
    stage: frame?.started ? 'in progress' : 'waiting to deal',
    graceMs: frame?.graceMs || (hosted ? session.graceMs : null) || DEFAULT_GRACE_MS,
    variants: frame?.variants || [],
    seatCount: frame?.seatCount || seating.length,
    openSeats: openSeatsOf(frame),
    mySeat: seat,
    // A SEAT WE HOLD IS NOT THE SAME AS A CLIENT THAT HOLDS IT. The tile asks
    // the second question — tapping a seat we are really sitting at goes to the
    // felt rather than to the panel — and only a live client can answer it.
    seatedHere: session?.client?.seat?.() != null,
    // A hosted table that has been dealt and is running behind the felt: the
    // "Back to the table" door, which is a different offer from "Deal".
    hasState: hosted ? !!session.state : false,
    seats: seating.map((identity) => Object.freeze({
      ...identity,
      kind: (frame?.seats || []).find((s) => s.seat === identity.seat)?.kind || 'empty',
      deviceId: (frame?.seats || []).find((s) => s.seat === identity.seat)?.deviceId || null,
      presence: presence.get(identity.seat) || 'connected',
      unreachable: unreachable.has(identity.seat),
      deadlineAt: deadlines.find((d) => d.seat === identity.seat)?.expiresAt ?? null,
    })),
  };
}

/**
 * Every table this device knows about, merged into one ordered account.
 *
 * ORDER IS TILE ORDER: live sightings in the order they were first heard from
 * (the directory's own guarantee — a re-sighting must not reshuffle the row),
 * then a dormant entry for every seat whose table nobody is advertising. That
 * second half is not a special case bolted on; without it the promise the seat
 * stub stores is one no screen ever makes, and a player who closes the tab has
 * no way to know their seat is waiting.
 *
 * @param self         this device's id, or null before the port exists
 * @param myName       what to call ourselves ON SCREEN — second person, "You"
 * @param publishedName what to call ourselves TO EVERYBODY ELSE. Emphatically
 *                     not the same string: publishing the display name is how a
 *                     joiner ended up looking at a seat grid whose host was
 *                     called "You".
 * @param peers        the transport roster: [{ deviceId, name, direct, status }]
 * @param presence     `peer.presence` output when the launcher has the cap, else
 *                     null — see presenceBySeat
 * @param sightings    the table directory's entries (`directory.all()`)
 * @param sessions     the session registry's sessions (`registry.all()`)
 * @param stubs        the stored seat stubs (`seatStubs()`)
 * @param packNameOf   (packId) => display name, or null while the manifest is
 *                     in flight. NOT a fetch: the model never causes IO.
 * @param focusedKey   the table the panel is about, or null
 */
export function partyModel({
  self = null,
  myName = 'You',
  publishedName = 'Host',
  peers = [],
  presence = null,
  sightings = [],
  sessions = [],
  stubs = [],
  packNameOf = () => null,
  focusedKey = null,
} = {}) {
  const ctx = { self, myName, publishedName, peers, presence, packNameOf, focusedKey };
  const sessionFor = (tableId) => sessions.find((s) => s.tableId === tableId) || null;

  const live = sightings.map((entry) => viewOf({
    tableId: entry.key,
    frame: entry.frame,
    stub: stubs.find((s) => s.tableId === entry.key) || null,
    session: sessionFor(entry.key),
    lastSeenAt: entry.lastSeenAt,
  }, ctx));

  const known = new Set(live.map((view) => view.tableId));
  const dormant = stubs
    .filter((stub) => !known.has(stub.tableId))
    .map((stub) => viewOf({
      tableId: stub.tableId,
      frame: null,
      stub,
      session: sessionFor(stub.tableId),
      lastSeenAt: stub.lastSeenAt,
    }, ctx));

  return { self, focusedKey, tables: [...live, ...dormant] };
}

/* ------------------------------------------------------------------ *
 * Reading the model
 *
 * Small pure lookups rather than methods on the result, so the model stays
 * plain data — which is what lets `partySnapshot` report it verbatim and a test
 * assert against it with `deepStrictEqual`.
 * ------------------------------------------------------------------ */

export const tableOf = (model, tableId) =>
  model.tables.find((view) => view.tableId === tableId) || null;

/** The table the panel is about, or null. */
export const focusedTable = (model) =>
  model.tables.find((view) => view.focused) || null;

/** The table the felt is showing, or null. */
export const boundTable = (model) =>
  model.tables.find((view) => view.bound) || null;

export const hostedTables = (model) =>
  model.tables.filter((view) => view.relation === 'hosting');

/**
 * What the LOBBY TILE for a pack should say, or null for a pack with nothing
 * happening on it.
 *
 * ONLY A LIVE TABLE TAKES THE TILE OVER. A seat whose host has gone quiet stays
 * in the Tables row, where "offline" is already said properly and where a
 * control that cannot work is already drawn as not a control.
 */
export function packState(model, packId) {
  const hosting = model.tables.find((view) =>
    view.packId === packId && view.relation === 'hosting' && view.hasState);
  if (hosting) {
    return { kind: 'hosting', tableId: hosting.tableId, seatsOpen: hosting.openSeats };
  }
  const seated = model.tables.find((view) =>
    view.packId === packId && view.seatedHere && view.liveness === 'live');
  if (seated) {
    return {
      kind: 'seated', tableId: seated.tableId, seat: seated.mySeat, hostName: seated.hostName,
    };
  }
  return null;
}
