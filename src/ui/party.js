// THE MULTIPLAYER SCREEN, AND THE ONLY PLACE THE PROTOCOL MEETS THE FELT.
//
// src/match/ is a complete, headless implementation of a host-authoritative
// card table — and until this file existed, nothing in the game ever called it.
// Everything here is plumbing between two things that were each finished on
// their own: the protocol below, and a table (src/ui/table.js) that already
// knows how to draw a hand it was merely told about (WP-C5a, src/ui/tableModel.js).
//
// THREE ROLES, ONE MODULE, and the reason they share a file is that the state
// machine between them is the whole feature:
//
//   idle      a party may exist; nothing has been offered or accepted.
//   host      this device holds the state. It publishes a lobby, arbitrates
//             seats, and turns every move it applies into a view for everybody
//             else. Its own play does not change in any way.
//   joiner    this device holds a view. It proposes and it is told.
//
// A DEVICE IS NEVER BOTH, and the guard is the state itself: `state.isView` is
// what every branch in table.js consults, because a state knows what it is and
// one test for it beats two that can disagree.
//
// NOTHING HERE CACHES `peer.status()`. A game can be mounted before a party
// exists and paired afterwards, so a status read once at init is a multiplayer
// button that never appears (src/match/peerPort.js says the same, at length).
//
// TEXT FROM A PEER NEVER TOUCHES innerHTML. Peer names are the fleet's
// shipped-twice XSS shape, and the rule this module follows is stricter than
// escaping: every peer-supplied string reaches the DOM through `textContent`,
// which cannot be forgotten the way an escape call can. If a future change here
// genuinely needs markup, `Arcade.html.escape` is the required tool — but the
// honest advice is not to need it.

import {
  peerAvailability, arcadePeerPort, REQUIRED_CAPS,
} from '../match/peerPort.js';
import { createTableHost, needsHostDecision } from '../match/host.js';
import { createTurnTimer } from '../match/turnTimer.js';
import { wallClock } from '../match/clock.js';
import { makeCtx } from '../engine/context.js';
import { chooseBotMove } from '../engine/bot.js';
import { enumerateLegalMoves } from '../engine/movePipeline.js';
import { rehydrateMatch } from '../engine/replay.js';
import { createTableClient } from '../match/client.js';
import { createTableSession } from '../match/tableSession.js';
import { createSessionRegistry } from '../match/sessionRegistry.js';
import { FRAME, EMOTES, validateFrame, isAuthentic, mintTableId } from '../match/protocol.js';
import { botById, initialsOf, pickBotIds } from '../players/roster.js';
import { createBotDriver } from './botDriver.js';
import {
  loadSettings, saveHostMatch, clearHostMatch, hostMatches, loadHostMatch,
  saveSeatStub, clearSeatStub, touchSeatStub, sweepStaleTables, seatStubs,
} from '../arcade/storage.js';
import { fetchPack, fetchPackManifest } from './packSource.js';
import { confirmAction } from './confirm.js';
import {
  adoptSharedView, leaveSharedTable, tableContext, setSeating, dealHostedTable,
  setLocalMoveListener, afterRemoteMove, setTablePaused, rerenderTable,
} from './table.js';
import { createSeatTable, createSeatLens, deserializeSeatTable } from '../players/seats.js';
import { createTableDirectory, tableKeyOf } from '../match/tableDirectory.js';

const el = {
  entry: document.getElementById('party-button'),
  screen: document.getElementById('party-overlay'),
  back: document.getElementById('party-back'),
  heading: document.getElementById('party-heading'),
  note: document.getElementById('party-note'),
  summary: document.getElementById('party-summary'),
  seats: document.getElementById('party-seats'),
  actions: document.getElementById('party-actions'),
  strip: document.getElementById('party-strip'),
  emotes: document.getElementById('emote-bar'),
  burst: document.getElementById('emote-layer'),
  decision: document.getElementById('party-decision'),
  decisionText: document.getElementById('party-decision-text'),
  tablesRow: document.getElementById('tables-row'),
  tablesGrid: document.getElementById('tables-grid'),
};

/** One emote per this many ms, per device. A burst is a wave, not a channel. */
const EMOTE_COOLDOWN_MS = 1500;

/**
 * How long a remote seat may sit there before the house takes one turn for it.
 *
 * GENEROUS ON PURPOSE. This is not a chess clock; it exists so that one person
 * putting their phone down does not stop the game for everybody else. A minute
 * is long enough that nobody thinking about a real decision ever meets it, and
 * short enough that a table does not die of one distraction.
 */
const TURN_TIMEOUT_MS = 60_000;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let port = null;              // the peer port, or null when there is no surface
// EVERY LIVE TABLE ON THIS DEVICE. What used to be eight module-level slots —
// `host`, `hostSeats`, `hostPack`, `hostTableId`, `turnTimer`, `client`,
// `joinedPack`, and two bookkeeping Sets — is now the contents of a
// TableSession (src/match/tableSession.js), one per table, held here.
//
// The slots were not merely repetitive: being module state, they were also the
// reason a hosted game could not outlive the felt showing it. A session owns
// its own state, so `ourTable()` below is still "the one table we host" only
// because the registry's door says so, not because there is nowhere to put a
// second one.
const sessions = createSessionRegistry();
let tick = null;              // the countdown's own repaint
// EVERY TABLE IN EARSHOT, which used to be a single `invitation` slot — see the
// header of src/match/tableDirectory.js for what that one slot cost. `host` is
// still at most one (ours) and `client` still at most one (the table we are
// sitting at), because there is still exactly one felt; what is plural now is
// what this device KNOWS, which is the half that was never a limit worth having.
const tables = createTableDirectory();
// Which sighted table the panel is about. Null when we are hosting or idle with
// nothing in earshot. It moves on its own only while we are unattached — once
// we are a client of a table, a new sighting elsewhere is news, not a summons.
let activeKey = null;
let sniffOff = null;
let joining = false;          // one join at a time; see joinTable
let lastEmoteAt = 0;
let notice = '';              // the one error line the screen is showing
let goToTable = () => {};
let goToLobby = () => {};

const selfId = () => port?.self()?.deviceId || null;

/* ------------------------------------------------------------------ *
 * The tables we are part of
 *
 * Three questions that used to be three truthy checks on three module
 * variables, and are now three lookups against one registry. Written as
 * functions rather than cached bindings on purpose: a cached `host` is exactly
 * how the old code came to believe there could only ever be one.
 * ------------------------------------------------------------------ */

/** The table we host, or null. The registry's door keeps this at most one. */
const ourTable = () => sessions.hosted()[0] || null;
/** The table we joined, or null. */
const theirTable = () => sessions.joined()[0] || null;
/**
 * THE TABLE WE ARE ATTACHED TO — ours when hosting, our host's when joined,
 * null when neither. NOT the same question as "what is the panel showing",
 * which is `activeKey` below, and keeping them apart is the whole of this
 * stage: browsing a neighbour's seats while playing at your own is ordinary
 * now, and one lobby frame served to both would have drawn their roster onto
 * your felt. That frame is per-session now, which is what makes it impossible.
 */
const attached = () => ourTable() || theirTable();

const host = () => ourTable()?.host || null;
const hostSeats = () => ourTable()?.seats || null;
const hostPack = () => ourTable()?.pack || null;
const hostTableId = () => ourTable()?.tableId || null;
const turnTimer = () => ourTable()?.timer || null;
const client = () => theirTable()?.client || null;
const joinedPack = () => theirTable()?.pack || null;
const lobbyFrame = () => attached()?.lobbyFrame || null;
const decided = () => ourTable()?.decided || new Set();
const unreachable = () => ourTable()?.unreachable || new Set();

/**
 * What to call ourselves ON THIS SCREEN. Second person, because at our own
 * table we are "You" — the same voice the status bar has always used.
 */
const myName = () => {
  try { return Arcade.player.name() || 'You'; } catch { return 'You'; }
};

/**
 * What to call ourselves TO EVERYBODY ELSE, which is emphatically not the same
 * string — and publishing the display name is how a joiner ended up looking at
 * a seat grid whose host was called "You". Second person only works about the
 * person reading it. With no name set, the device's own name is the next
 * honest answer ("Paul's iPhone"), and a bare fallback after that.
 */
const publishedName = () => {
  let chosen = '';
  try { chosen = Arcade.player.name() || ''; } catch { chosen = ''; }
  return String(chosen || port?.self()?.name || 'Host').slice(0, 60);
};

export function partyRole() {
  if (host()) return 'host';
  if (client()) return 'joiner';
  return 'idle';
}

/* ------------------------------------------------------------------ *
 * Which table we are looking at
 * ------------------------------------------------------------------ */

/** The table the panel is currently about, or null. */
function activeTable() {
  return activeKey ? tables.get(activeKey) : null;
}

/**
 * The roster the PANEL is drawing.
 *
 * Falls back to the table we are attached to, which is what an idle panel and
 * a freshly-hosted one both want. Every seat grid, summary line and heading
 * reads this; the strip above the FELT does not, because the felt is always
 * about the table we are playing at whatever the panel happens to be showing.
 */
function shownFrame() {
  return activeTable()?.frame || lobbyFrame();
}

/** Is the panel looking at the table this device is hosting? */
function shownIsOurs() {
  const frame = shownFrame();
  return !!host() && !!frame && frame.hostDeviceId === selfId();
}

/**
 * Look at a table: point the panel at it.
 *
 * THIS IS THE WHOLE OF "SWITCHING", and it is deliberately not the whole of
 * joining. Focus is a question about what is on screen; being a client is a
 * question about which host we are exchanging frames with. Keeping them apart
 * is what lets a device see three tables while playing at one — and, since
 * this stage, look at a neighbour's seats without leaving its own.
 */
function focusTable(key) {
  if (!key || !tables.has(key)) return false;
  activeKey = key;
  return true;
}

/**
 * File our own table alongside everybody else's.
 *
 * OUR TABLE IS A TABLE. Keeping it outside the directory meant every surface
 * that draws tables needed a special case for the one we are hosting — the
 * tile row, the panel's subject, the focus pointer — and three special cases
 * for one fact is how the single-slot design got where it did. The directory
 * is "every table this device knows about", and we know about ours best.
 *
 * The sniffer still ignores our own frames off the wire; this is the deliberate
 * way in, called wherever the roster changes.
 */
function publishOwnTable() {
  if (!host() || !hostSeats() || !hostPack()) return;
  const frame = ourLobbyFrame();
  if (frame) tables.sight(frame);
}

/** Are we actually sitting down at the table we are a client of? */
function seatedHere() {
  return client() ? client().seat() !== null && client().seat() !== undefined : false;
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/**
 * What this launcher will let us do, asked fresh every time.
 *
 * The three answers are different sentences, and collapsing them is how a
 * standalone player gets told to update a launcher they are not running:
 *   standalone        no peer surface at all — say nothing, offer nothing.
 *   launcher-too-old  a surface, missing a capability we cannot work without.
 *   available         go.
 */
function availability() {
  return peerAvailability();
}

function ensurePort() {
  if (!port) port = arcadePeerPort();
  return port;
}

/* ------------------------------------------------------------------ *
 * Names and faces
 * ------------------------------------------------------------------ */

/** A peer's display name, from the roster, clamped and never trusted. */
function peerName(deviceId) {
  if (!deviceId) return 'Someone';
  // Our own seat, seen from outside: this feeds the roster we PUBLISH, and the
  // local screen re-answers with `myName()` when it draws our own row.
  if (deviceId === selfId()) return publishedName();
  const entry = (port?.peers() || []).find((p) => p.deviceId === deviceId);
  const name = entry?.name || '';
  return String(name).slice(0, 60) || 'Someone';
}

/** The name the HOST publishes for a seat — read by the lobby roster it sends. */
function nameForSeat(seat) {
  const owner = (hostSeats() || tableContext()?.seats)?.ownerOf(seat);
  if (!owner || owner.kind === 'empty') return '';
  // The felt's own name for this bot when there is a felt, so the roster a
  // joiner receives says what the host is actually looking at. Before the deal
  // there is no felt and the shared derivation is the only answer either of us
  // has — which is fine, because it is the answer we will both keep.
  if (owner.kind === 'bot') return tableContext()?.seating?.[seat]?.name || derivedBotName(seat);
  return peerName(owner.deviceId);
}

/** The bot a seat gets before anybody has dealt — same input on every device. */
function derivedBotName(seat) {
  const table = hostSeats();
  if (!table) return botById(null).name;
  const botSeats = [];
  for (let s = 0; s < table.count; s++) if (table.isBot(s) || table.isEmpty(s)) botSeats.push(s);
  const ids = pickBotIds(selfId() || 'party', botSeats.length);
  return botById(ids[botSeats.indexOf(seat)]).name;
}

/**
 * Everybody at a SHARED table, indexed by seat.
 *
 * `buildSeating` (src/players/roster.js) cannot serve here: it derives the
 * opponents from the match SEED, and a joiner has no seed and must never be
 * given one — the seed reconstructs the whole shuffle. So the identities come
 * from the roster the host publishes, and the bot faces are drawn from a seed
 * every device already agrees on: the HOST'S DEVICE ID. Same input, same faces,
 * no secret shared.
 */
function seatingFromRoster(frame) {
  const roster = frame?.seats || [];
  const seatCount = frame?.seatCount || roster.length;
  const botSeats = roster.filter((s) => s.kind === 'bot').map((s) => s.seat);
  const botIds = pickBotIds(frame?.hostDeviceId || 'party', botSeats.length);
  // THE HOST ALREADY HAS AN ANSWER, and it is the one on the felt. Deriving a
  // second set of bot faces here put Cass and Nell in the seat grid while Otto
  // and Bruno sat at the same two seats on the table behind it — the panel and
  // the game disagreeing about who is playing. The derivation below is for a
  // JOINER, which has no seed and no seating; the host defers to its own.
  //
  // ONLY FOR OUR OWN TABLE, though. A host looking at a NEIGHBOUR'S roster must
  // derive like any other joiner: our felt's seating describes our game, and
  // borrowing it would put our own bots' faces on their chairs.
  const own = host() && frame?.hostDeviceId === selfId() ? tableContext()?.seating : null;

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
    const mine = entry.deviceId === selfId();
    // WHOSE ANSWER TO TRUST DEPENDS ON WHICH SEAT WE ARE IN. The host holds a
    // direct link to every player and can read the live roster, so it uses that
    // and stays current when somebody renames themselves. A joiner cannot: its
    // `peers()` contains only the host, so a fellow joiner's name exists
    // nowhere but the frame the host published.
    const fromRoster = own ? peerName(entry.deviceId) : entry.name;
    const name = mine ? myName() : String(fromRoster || peerName(entry.deviceId)).slice(0, 60);
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

/* ------------------------------------------------------------------ *
 * Presence
 * ------------------------------------------------------------------ */

const CHIP_TEXT = {
  connected: '',
  interrupted: 'reconnecting…',
  gone: 'left',
  bot: 'bot',
  empty: 'open',
};

/**
 * Every seat's presence, as this device can honestly know it.
 *
 * ON THE HOST this is computed from the transport roster (`seatStatus`, a pure
 * function in src/match/host.js). ON A JOINER it comes from the host's lobby
 * frame, and it has to: a member's `peers()` contains ONLY the host, so a
 * joiner asking the transport about a FELLOW joiner gets silence, not absence.
 * Reading that silence as "gone" would show every other player as having left.
 *
 * `peer.presence` (launcher WP-L1) would let a joiner see fellow members
 * directly. It is not shipped, so this is a cap check that currently never
 * fires — deliberately written now so the upgrade is a one-line change rather
 * than a redesign.
 */
function seatStatuses(frame = shownFrame()) {
  const out = new Map();
  // OUR OWN TABLE IS THE ONLY ONE WE CAN ANSWER FROM THE TRANSPORT. Asking the
  // host module about a seat at a NEIGHBOUR'S table would answer about our own
  // seat of that index — a roster that looks plausible and belongs to a
  // different felt. For anybody else's table the published frame is not merely
  // the best source, it is the only honest one.
  if (host() && frame && frame.hostDeviceId === selfId()) {
    // `hostSeats` rather than the felt's: the host holds a seat table from the
    // moment it opens a party, and the whole point of the lobby-first flow is
    // that people are seated BEFORE there is a table to read seats off.
    for (let seat = 0; seat < (hostSeats()?.count || 0); seat++) {
      out.set(seat, host().seatStatusFor(seat));
    }
    return out;
  }
  const better = (port?.caps() || []).includes('peer.presence') && Arcade.peer?.presence;
  const live = better ? (Arcade.peer.presence() || []) : null;
  for (const entry of frame?.seats || []) {
    let status = entry.status || (entry.kind === 'bot' ? 'bot' : entry.kind === 'empty' ? 'empty' : 'connected');
    if (live && entry.kind === 'device') {
      const seen = live.find((p) => p.deviceId === entry.deviceId);
      if (seen) status = seen.status === 'interrupted' ? 'interrupted' : seen.status === 'gone' ? 'gone' : 'connected';
    }
    out.set(entry.seat, status);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function partyLabel() {
  const party = partyLabel.cached;
  if (!party) return 'Playing together';
  return party.role === 'leader' ? 'Your party' : `Playing with ${party.leaderName}'s party`;
}
partyLabel.cached = null;

/** `Arcade.peer.party()` answers with a PROMISE — so the label arrives late. */
async function refreshPartyLabel() {
  try {
    const party = await port?.party?.();
    partyLabel.cached = party && typeof party === 'object' ? party : null;
  } catch { partyLabel.cached = null; }
}

function chip(status) {
  const node = document.createElement('span');
  node.className = `presence-chip presence-chip--${status}`;
  node.textContent = CHIP_TEXT[status] ?? status;
  if (!node.textContent) node.setAttribute('aria-label', 'connected');
  return node;
}

function button(label, onClick, { className = 'ghost-button' } = {}) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

/**
 * The seat grid: one row per seat, with whatever this device is allowed to do
 * to it. The host may seat a bot or open a seat; a joiner may claim one.
 */
function renderSeats() {
  if (!el.seats) return;
  el.seats.replaceChildren();
  const frame = shownFrame();
  if (!frame) return;
  const statuses = seatStatuses(frame);
  const seating = seatingFromRoster(frame);
  const me = selfId();
  // WHOSE SEATS THESE ARE decides what may be done to them, and it is no longer
  // answerable from `host` alone: a host looking at a neighbour's table is
  // still a host, and offering it the bot/open toggles would have applied our
  // own seat table to their chairs.
  const ours = shownIsOurs();

  for (const identity of seating) {
    const seat = identity.seat;
    const entry = (frame.seats || []).find((s) => s.seat === seat) || { kind: 'empty' };
    const row = document.createElement('div');
    row.className = 'party-seat';
    row.dataset.seat = String(seat);

    const face = document.createElement('span');
    face.className = 'party-seat__face';
    face.textContent = identity.icon;
    face.style.setProperty('--seat-color', identity.color);
    row.append(face);

    // textContent, not innerHTML — see the header. A peer's name is the one
    // string at this table that somebody else chose.
    const name = document.createElement('span');
    name.className = 'party-seat__name';
    name.textContent = identity.name;
    row.append(name);

    row.append(chip(statuses.get(seat) || 'connected'));
    if (unreachable().has(seat)) {
      const warn = document.createElement('span');
      warn.className = 'presence-chip presence-chip--unreachable';
      warn.textContent = 'unreachable';
      row.append(warn);
    }

    const actions = document.createElement('span');
    actions.className = 'party-seat__actions';
    if (ours) {
      const held = entry.kind === 'device' && entry.deviceId !== me;
      if (held) {
        // REMOVING SOMEBODY IS ITS OWN VERB. The seat toggles used to apply to
        // a person's chair too, so "Bot" quietly evicted them — and their table
        // did not stop, or say anything; it simply stopped answering. If the
        // host may do this at all it has to be named, confirmed, and TOLD to
        // the person it happens to.
        actions.append(button('Remove', () => { removeSeat(seat).catch(reportFailure); }));
      } else if (entry.kind !== 'device') {
        actions.append(entry.kind === 'bot'
          ? button('Open', () => { hostSeats().release(seat); afterSeatChange(); })
          : button('Bot', () => { hostSeats().seatBot(seat); afterSeatChange(); }));
      }
    } else if (!host() && (client() || activeTable())) {
      const mine = entry.kind === 'device' && entry.deviceId === me;
      if (!mine && entry.kind !== 'device') {
        // AN INVITATION IS ENOUGH TO TAP. Being a client is an implementation
        // detail of having been invited, and it is one that can lapse — a host
        // that closed and reopened, a frame that arrived in the wrong order.
        // Making the button depend on it turned every one of those into a
        // table you could see, could count the free chairs of, and could not
        // sit down at. Claiming re-establishes the client if it has to.
        actions.append(button('Take this seat', () => claimSeat(seat).catch(reportFailure)));
      }
    }
    row.append(actions);
    el.seats.append(row);
  }
}

/**
 * Seconds left on a seat's turn, from whichever end of the wire we are on.
 *
 * The host reads its own timer; a client reads the deadlines the host SHIPPED
 * with the view. Both are the same absolute instant, which is the entire point
 * of sending an instant rather than a duration — a countdown drawn from
 * "60 seconds from when this arrived" drifts by however long it took to arrive.
 */
function liveDeadlines() {
  if (turnTimer()) return turnTimer().deadlines();
  // `modelFromView` copies them straight onto the model (src/ui/tableModel.js).
  return tableContext()?.state?.deadlines || [];
}

function secondsLeft(seat) {
  const entry = liveDeadlines().find((d) => d.seat === seat);
  if (!entry) return null;
  return Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
}

/**
 * Keep the countdown counting.
 *
 * A view arrives per MOVE and a countdown ticks per SECOND, so without this a
 * client would show whatever number happened to be true when the last card was
 * played. Runs only while there is a deadline to draw, and stops itself the
 * moment there is not — a permanent one-second interval on a card table is a
 * permanent one-second wakeup.
 */
function pulse() {
  const live = liveDeadlines().length > 0;
  if (live && !tick) tick = setInterval(renderStrip, 1000);
  if (!live && tick) { clearInterval(tick); tick = null; }
}

/** The compact presence strip
/**
 * The strip above the felt: who is at this table and how they are doing.
 *
 * PRESENCE ONLY. It briefly carried the host's "Play together" button, back
 * when hosting started from the felt — that door is on the lobby tile now,
 * because choosing the game is the first decision and the lobby is where games
 * are chosen.
 *
 * THE TABLE WE ARE PLAYING AT, never the one the panel happens to be showing.
 * It sits above the FELT, and the felt is our own game — reading the panel's
 * subject here would put a neighbour's names over our own cards the moment
 * somebody tapped their tile.
 */
function renderStrip() {
  if (!el.strip) return;
  if (!lobbyFrame()) {
    el.strip.hidden = true;
    el.strip.replaceChildren();
    return;
  }
  const statuses = seatStatuses(lobbyFrame());
  const seating = seatingFromRoster(lobbyFrame());
  el.strip.replaceChildren();
  for (const identity of seating) {
    const status = statuses.get(identity.seat) || 'connected';
    if (status === 'bot' || status === 'empty') continue;
    const pill = document.createElement('span');
    pill.className = 'party-strip__seat';
    const name = document.createElement('span');
    name.textContent = identity.shortName;
    pill.append(name, chip(status));
    // Only on the seat actually being waited on, and only once it is worth
    // saying: a number that is always there is furniture, and a table where
    // everybody is always on a visible clock feels like an exam.
    const left = secondsLeft(identity.seat);
    if (left !== null && left <= 20) {
      const clock = document.createElement('span');
      clock.className = 'party-strip__clock';
      clock.textContent = `0:${String(left).padStart(2, '0')}`;
      pill.append(clock);
    }
    if (unreachable().has(identity.seat)) pill.classList.add('party-strip__seat--unreachable');
    el.strip.append(pill);
  }
  el.strip.hidden = !el.strip.childElementCount;
}

/** packId -> the manifest's own name, fetched once per pack we are offered. */
const packNames = new Map();

/** What to call a game in a sentence, before its manifest has landed. */
const packName = (packId) => packNames.get(packId) || packId;

function rememberPackName(packId) {
  if (!packId || packNames.has(packId)) return;
  packNames.set(packId, null); // in flight; never ask twice
  fetchPackManifest(packId)
    .then((manifest) => { packNames.set(packId, manifest?.name || packId); renderScreen(); })
    .catch(() => { packNames.set(packId, packId); });
}

/**
 * THE TWO THINGS THIS MODULE DRAWS ON THE LOBBY, always together.
 *
 * They are one fact — what tables exist — shown twice: as a row of their own,
 * and as a ribbon on the game each is playing. Drawing them from separate call
 * sites is how the row kept a tile for a host who had left the party while the
 * ribbon for the same table had already, correctly, gone.
 */
function renderLobby() {
  decorateTiles();
  renderTablesRow();
}

function renderScreen() {
  renderLobby();
  if (!el.screen) return;
  if (el.heading) el.heading.textContent = panelHeading();
  if (el.note) el.note.textContent = notice;
  if (el.note) el.note.hidden = !notice;

  if (el.summary) {
    const frame = shownFrame();
    // A JOINER HAS NOT LOADED THE PACK YET — deciding whether to join is the
    // whole point of this screen — so the slug is all the frame carries. The
    // manifest is one small JSON and the lobby reads it for every tile anyway,
    // so "crazy-eights" becomes "Crazy Eights" before anybody has to read it.
    //
    // ONLY THE TABLE ON SCREEN gets to name itself. The loaded packs — ours and
    // the one we joined — answer for their own table and nobody else's, so a
    // neighbour's tile no longer inherits our game's name.
    const isOurs = !activeTable() || shownIsOurs()
      || frame?.hostDeviceId === client()?.hostDeviceId();
    const packName = (isOurs && (joinedPack()?.manifest?.name || tableContext()?.pack?.manifest?.name))
      || packNames.get(frame?.packId)
      || frame?.packId || '';
    const variants = frame?.variants || [];
    el.summary.textContent = packName
      ? (variants.length ? `${packName} · ${variants.join(', ')}` : packName)
      : '';
  }

  renderSeats();
  renderActions();
  renderStrip();
  renderEmotes();
}

/**
 * What the panel calls itself.
 *
 * The party label was the whole answer when the panel could only ever be about
 * one table. It still names the ROOM, which is worth saying — but with a tile
 * row it is possible to be looking at a table that is not ours, and "Your
 * party" over somebody else's seats is simply wrong.
 */
function panelHeading() {
  const frame = shownFrame();
  if (!frame) return partyLabel();
  if (frame.hostDeviceId === selfId()) return 'Your party';
  return `${peerName(frame.hostDeviceId)}'s table`;
}

function renderActions() {
  if (!el.actions) return;
  el.actions.replaceChildren();
  // THE BUTTONS BELONG TO THE TABLE ON SCREEN, not to whatever role this device
  // happens to hold. "Stop hosting" under a neighbour's roster would be a
  // button that ends a different game than the one you are looking at.
  if (shownIsOurs()) {
    // DEAL IS THE HOST'S ONE BUTTON, and it only exists before the cards are
    // out. Afterwards the table is the table; there is nothing to start.
    if (!tableContext()?.state) {
      el.actions.append(button('Deal', () => { dealParty().catch(reportFailure); },
        { className: '' }));
    }
    el.actions.append(button('Stop hosting', () => { stopHosting(); goToLobby(); }));
  } else if (client() && shownFrame()?.hostDeviceId === client().hostDeviceId()) {
    el.actions.append(button('Leave the table', () => { leaveTable(); goToLobby(); }));
  }
}

/* ------------------------------------------------------------------ *
 * The tables row
 * ------------------------------------------------------------------ */

/**
 * A TABLE IS A DIFFERENT KIND OF THING FROM A GAME, and this is where that
 * becomes visible. A game tile is a thing you could start; a table tile is a
 * thing already happening, with people at it — so it says who is at it, what
 * they are playing, how far along they are, and the one fact that is about you
 * rather than about them: whether you hold a seat.
 *
 * NO PACK IS LOADED HERE. Everything comes from lobby frames already in memory
 * plus the manifest names the panel caches anyway, which is what keeps the
 * lobby's cost ceiling — manifests only, and opening it must not get slower as
 * packs ship — exactly where it was.
 */
/**
 * A seat at a table whose host is not here.
 *
 * NOT A BUTTON, because there is nobody to talk to: tapping would open a panel
 * whose every action would fail, and a control that does nothing teaches the
 * player to distrust the ones that work. It is a promise the tile keeps until
 * the host reappears, at which point the ordinary live tile takes over and is
 * tappable again — nothing here has to handle the waking, because waking is
 * just the directory learning about the table again.
 */
function dormantTile(stub) {
  const tile = document.createElement('div');
  tile.className = 'table-tile table-tile--dormant';
  tile.dataset.tableKey = stub.tableId;

  const who = document.createElement('span');
  who.className = 'table-tile__who';
  // textContent, always — a name somebody else typed, read back from storage,
  // which is if anything a better reason to be careful rather than a worse one.
  who.textContent = stub.hostName ? `Your seat at ${stub.hostName}'s table` : 'Your seat';
  tile.append(who);

  const game = document.createElement('span');
  game.className = 'table-tile__game';
  game.textContent = packName(stub.packId);
  tile.append(game);
  rememberPackName(stub.packId);

  const state = document.createElement('span');
  state.className = 'table-tile__state';
  // ONE WORD, and it is about the HOST rather than the game. "Paused" or
  // "waiting" would be claims about a table we cannot see; offline is the only
  // thing this device actually knows.
  state.textContent = 'offline';
  tile.append(state);

  tile.setAttribute('aria-label',
    `${who.textContent}, ${game.textContent}. Offline — waiting for the host to come back.`);
  return tile;
}

/**
 * The tables worth drawing: everything in earshot, plus the seats we hold at
 * tables that are not.
 *
 * A DORMANT TABLE IS NOT IN THE DIRECTORY, and cannot be — the directory is
 * built from frames, and a host that is asleep sends none. So the row is the
 * union: live entries first, then a stub for every seat whose table nobody has
 * advertised. Without this half, the promise T4a stores is one no screen ever
 * makes, and a player who closes the tab has no way to know their seat is
 * waiting.
 */
function tablesToDraw() {
  const live = tables.all().map((entry) => ({ entry, stub: null }));
  const known = new Set(live.map((row) => row.entry.key));
  const dormant = seatStubs()
    .filter((stub) => !known.has(stub.tableId))
    .map((stub) => ({ entry: null, stub }));
  return [...live, ...dormant];
}

function renderTablesRow() {
  if (!el.tablesRow || !el.tablesGrid) return;
  const all = tablesToDraw();
  el.tablesRow.hidden = all.length === 0;
  el.tablesGrid.replaceChildren();
  if (!all.length) return;

  const me = selfId();
  for (const row of all) {
    if (!row.entry) { el.tablesGrid.append(dormantTile(row.stub)); continue; }
    const entry = row.entry;
    const frame = entry.frame;
    const mine = frame.hostDeviceId === me;
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `table-tile${mine ? ' table-tile--mine' : ''}`;
    tile.dataset.tableKey = entry.key;

    const who = document.createElement('span');
    who.className = 'table-tile__who';
    // textContent, always — this is a name somebody else typed. The file
    // header's rule is not relaxed because the element is new.
    who.textContent = mine ? 'Your party' : `${peerName(frame.hostDeviceId)}'s table`;
    tile.append(who);

    const game = document.createElement('span');
    game.className = 'table-tile__game';
    game.textContent = packNames.get(frame.packId) || frame.packId || '';
    tile.append(game);
    rememberPackName(frame.packId);

    const state = document.createElement('span');
    state.className = 'table-tile__state';
    state.textContent = tableState(frame);
    tile.append(state);

    // YOUR SEAT, AT SOMEBODY ELSE'S TABLE. On your own it says nothing — of
    // course you have a seat at the table you dealt — and a badge that is
    // always there stops being read at all, including on the tile where it is
    // the entire reason to come back.
    const seat = mine ? null : seatOfSelf(frame);
    if (seat !== null) {
      const badge = document.createElement('span');
      badge.className = 'table-tile__seat';
      badge.textContent = 'Your seat';
      tile.append(badge);
    }

    tile.setAttribute('aria-label',
      `${who.textContent}, ${game.textContent}. ${state.textContent}.${seat !== null ? ' You hold a seat.' : ''}`);
    tile.addEventListener('click', () => showPartyScreen(entry.key));
    el.tablesGrid.append(tile);
  }
}

/** "waiting to deal · 2 seats open", or "in progress · table full". */
function tableState(frame) {
  const stage = frame.started ? 'in progress' : 'waiting to deal';
  const open = (frame.seats || []).filter((s) => s.kind !== 'device').length;
  return `${stage} · ${open === 0 ? 'table full' : `${open} ${open === 1 ? 'seat' : 'seats'} open`}`;
}

/** Which seat this device holds at a table, or null. */
function seatOfSelf(frame) {
  const me = selfId();
  const mine = (frame?.seats || []).find((s) => s.kind === 'device' && s.deviceId === me);
  return mine ? mine.seat : null;
}

/* ------------------------------------------------------------------ *
 * Emotes
 * ------------------------------------------------------------------ */

function renderEmotes() {
  if (!el.emotes) return;
  if (partyRole() === 'idle') { el.emotes.hidden = true; return; }
  if (el.emotes.childElementCount === EMOTES.length) { el.emotes.hidden = false; return; }
  el.emotes.replaceChildren();
  EMOTES.forEach((glyph, index) => {
    const node = button(glyph, () => sendEmote(index), { className: 'emote-button' });
    node.setAttribute('aria-label', `Send ${glyph}`);
    el.emotes.append(node);
  });
  el.emotes.hidden = false;
}

/**
 * An emote is an INDEX on the wire (src/match/protocol.js) and a glyph only
 * here. There is no free-text channel at this table by design, and the index is
 * also why nothing about an emote is ever logged: there is no content to log.
 */
function sendEmote(index) {
  const now = Date.now();
  if (now - lastEmoteAt < EMOTE_COOLDOWN_MS) return;
  lastEmoteAt = now;
  if (client()) client().emote(index);
  else if (host()) port.send({ k: FRAME.EMOTE, i: index, tableId: hostTableId() });
  burst(EMOTES[index]);
}

/** A small wave, and nothing that outlives its own animation. */
function burst(glyph) {
  if (!el.burst || !glyph) return;
  const node = document.createElement('span');
  node.className = 'emote-burst';
  node.textContent = glyph;
  el.burst.append(node);
  // reducedMotion is a promise the whole table keeps (Phase 3): the emote still
  // arrives, it simply does not fly.
  const reduced = document.documentElement.dataset.reducedMotion === 'true'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) node.classList.add('emote-burst--still');
  Arcade.session.setTimeout(() => node.remove(), reduced ? 1200 : 1600);
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

function setNotice(text) {
  notice = text || '';
  renderScreen();
}

function reportFailure(err) {
  console.error(err);
  setNotice(`Could not join that table: ${err.message}`);
}

/** The three error surfaces §10 asks for, each said in its own words. */
function surfaceError(detail) {
  if (detail?.kind === 'send-failed' && Number.isInteger(detail.seat)) {
    unreachable().add(detail.seat);
    renderScreen();
    return;
  }
  if (detail?.kind === 'send-failed' && detail.deviceId) {
    const ctx = tableContext();
    for (const seat of ctx?.seats?.seatsOfDevice(detail.deviceId) || []) unreachable().add(seat);
    renderScreen();
  }
}

function surfaceIncompatible(why) {
  if (why?.why === 'protocol' || why?.why === 'view') {
    setNotice('This table is running a different version of the game. Reload to catch up.');
    Arcade.ui.toast('Reload to join — the table is on a newer version.', { kind: 'error', duration: 6000 });
    return;
  }
  setNotice(`That table is playing something else (${why?.why || 'mismatch'}).`);
}

/* ------------------------------------------------------------------ *
 * Hosting
 * ------------------------------------------------------------------ */

/**
 * A seat changed hands. Tell everybody, and re-answer who is sitting there.
 *
 * THE SEATING IS THE HALF THAT IS EASY TO FORGET, and forgetting it is what
 * left a bot's name and face on a chair a person had just taken. `rerenderTable`
 * alone redraws the same stale identities.
 */
/**
 * Re-answer who is sitting where, everywhere it is drawn.
 *
 * THE SEATING IS THE HALF THAT IS EASY TO FORGET, and forgetting it is what
 * left a bot's name and face on a chair a person had just taken. `rerenderTable`
 * alone redraws the same stale identities.
 */
function refreshSeats() {
  // Host-side only, as it has always been: the one caller that is not a host
  // hook is `port.onPeersChange`, which is subscribed in hostGame.
  const session = ourTable();
  if (session) session.lobbyFrame = ourLobbyFrame();
  if (lobbyFrame()) setSeating(seatingFromRoster(lobbyFrame()));
  // Our own tile says what our own roster says, and it changed.
  publishOwnTable();
  rerenderTable();
  renderScreen();
}

/** A seat WE changed: refresh, then tell everybody. */
function afterSeatChange() {
  host()?.broadcastLobby();
  refreshSeats();
}

/** The roster WE publish, read back so one renderer draws both roles. */
function ourLobbyFrame() {
  if (!host() || !hostSeats()) return null;
  const seats = [];
  for (let seat = 0; seat < hostSeats().count; seat++) {
    const owner = hostSeats().ownerOf(seat);
    seats.push({
      seat,
      kind: owner.kind,
      deviceId: owner.deviceId ?? undefined,
      name: nameForSeat(seat),
      status: host().seatStatusFor(seat),
    });
  }
  return {
    // The same id the host module stamps on the frames it publishes, so the
    // tile we draw from this and the tile a joiner draws from the wire are the
    // same table rather than two that merely look alike.
    tableId: hostTableId(),
    packId: hostPack().packId,
    variants: hostPack().variants,
    hostDeviceId: selfId(),
    seatCount: hostSeats().count,
    seats,
    // FALSE UNTIL THE CARDS ARE OUT, and a joiner reads it: before the deal it
    // is waiting for the host, after it there is a hand to be caught up with.
    started: !!tableContext()?.state,
  };
}

/**
 * The chairs a brand-new party starts with: us in seat 0, bots in the rest.
 *
 * Bots by default so the table is playable the moment it is dealt whether or
 * not anybody turns up. A seat is opened by tapping it, not by default.
 */
function buildSeatTable(count, me) {
  const seats = createSeatTable({ seats: count, localDeviceId: me });
  seats.claim(0, { deviceId: me });
  for (let seat = 1; seat < count; seat++) seats.seatBot(seat);
  return seats;
}

/**
 * Build a live hosted table around a seat table, and register it.
 *
 * THE ONLY PLACE A HOST SESSION IS BORN — both doors come through here. A fresh
 * deal arrives from `hostGame` with chairs it just built; a table coming back
 * from storage arrives from `rehydrateOne` with chairs it just deserialized.
 * Everything after that point is identical, and having written it twice for
 * five minutes was enough to see why it should not be: the second copy is where
 * a hook quietly goes missing and a restored table stops saving itself.
 */
function openHostSession({ tableId, packId, packName: name, variants, seats }) {
  const session = createTableSession({ tableId, packId, role: 'host', packName: name });
  session.pack = { packId, variants, name };
  session.seats = seats;
  sessions.add(session);

  session.attach({ host: createTableHost({
    peer: port,
    seats: session.seats,
    tableId: session.tableId,
    // NULL UNTIL THE DEAL, which the protocol already understands: a lobby
    // frame with `started: false` is a table being built, and the host answers
    // a claim with a roster rather than a view because there is no view yet.
    //
    // READ FROM THE SESSION, NOT THE FELT. This one line is the inversion: it
    // used to be `tableContext()?.state`, which meant the game the host
    // arbitrated against was whichever one was on screen — and therefore that
    // navigating away from a hosted table stopped it being a table at all.
    liveState: () => session.state,
    packInfo: () => ({ packId: session.pack.packId, variants: session.pack.variants }),
    nameFor: nameForSeat,
    deadlines: () => session.timer?.deadlines() || [],
    hooks: {
      // THE FELT ONLY ANIMATES THE TABLE IT IS SHOWING. `afterRemoteMove` draws
      // on whatever `tableContext()` currently holds, so calling it for a
      // backgrounded table would play another game's card onto the open one.
      // Unbound, the move is applied and published and nothing is drawn — which
      // is the whole of what "headless" means here.
      onApplied: (_state, move) => {
        if (session.bound) afterRemoteMove(move);
        armTimer(session);
        driveBots(session);
        persist(session);
      },
      // A remote claim arrives here, which is also the late-joiner path: the
      // host must stop moving that seat and start calling it by its name. No
      // re-broadcast — handleClaim already sends one, and this fires inside it.
      onSeatsChanged: () => refreshSeats(),
      onEmote: ({ emote }) => burst(emote),
      onError: surfaceError,
      onBye: () => refreshSeats(),
    },
  }) });
  // THE CLOCK IS THE HOST'S, AND ONLY THE HOST'S. A client that could time
  // seats out would be a client that can force its opponents to pass by running
  // its clock fast, so this is armed here and the deadlines travel outward in
  // the view as absolute instants for clients to render.
  session.attach({ timer: createTurnTimer({
    // The WALL clock, not the session one: a shared hand does not stop because
    // one tab stopped painting, and a deadline has to survive a sleeping host.
    clock: wallClock(),
    timeoutMs: TURN_TIMEOUT_MS,
    actingSeatsOf: (state) => {
      const template = state.pack.template;
      return template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    },
    // ANY DEVICE-HELD SEAT WHOSE DEVICE IS NOT WATCHING THIS TABLE (plan §3).
    //
    // It used to be "every seat but our own", which is right for the table in
    // front of the player — a game has always waited for the person looking at
    // it, and a bot needs no encouragement — and wrong the moment this device
    // is playing a DIFFERENT table. There, our own seat is exactly as unwatched
    // as an absent joiner's, and exempting it would stall the hand for everyone
    // else until we happened to come back.
    //
    // So the exemption is about attention rather than identity: our seat is
    // exempt only at the table the felt is bound to.
    waitsOn: (seat) => {
      const owner = session.seats?.ownerOf(seat);
      if (owner?.kind !== 'device') return false;
      const isOurs = owner.deviceId === selfId();
      return !(isOurs && session.bound);
    },
    onExpire: (state, seat) => {
      // A TURN THAT RAN OUT IS A MOVE. The house plays one for them and the
      // seat stays theirs — they are back in control the moment they come
      // back, which is the same answer an interrupted link already gets.
      const move = chooseBotMove(state, seat);
      if (!move) return;
      session.host?.applyLocal(move);
    },
  }) });
  session.attach({ bots: headlessBotsFor(session) });
  setLocalMoveListener((_state, _move, events) => {
    session.host?.publish(events);
    armTimer(session);
    persist(session);
  });
  return session;
}

/**
 * HOST A GAME FROM THE LOBBY, before a single card is dealt.
 *
 * This used to start from the felt: you dealt a solo hand and then invited
 * people into it, which meant a joiner's only way in was to take a chair off a
 * bot that was already holding cards — and "what happens to that hand" has no
 * good answer. Building the table first makes seating a decision people make
 * together, and dealing a thing that happens once, to everybody.
 *
 * THE SEAT TABLE OUTLIVES THIS FUNCTION and is handed to `dealHostedTable`
 * unchanged, so the host module and the felt share one set of chairs. Two
 * tables that agree at the moment of dealing would drift the first time
 * somebody claimed a seat.
 */
export async function hostGame(packId) {
  const gate = availability();
  if (!gate.available) { announceGate(gate); showPartyScreen(); return false; }
  // Our own table is already open; this is the door back to it.
  if (host()) { showPartyScreen(); return false; }
  // SOMEBODY IS ALREADY PLAYING THIS ONE. The tile's button is one door with
  // two meanings, and which it means is not the player's to work out: with a
  // live table on this pack, tapping it takes you to that table rather than
  // starting a rival one nobody can see.
  const existing = tables.forPack(packId)[0];
  if (existing) {
    focusTable(existing.key);
    attachToActive().catch(reportFailure);
    showPartyScreen();
    return false;
  }
  // THE DOOR, AND IT IS THE REGISTRY'S TO ANSWER (plan §1). This used to be a
  // truthy `client` check here and a different check in two other places; now
  // there is one rule and it is per-PACK. Being in earshot of a table is not
  // being at one, and being sat at somebody's Crazy Eights is not a reason you
  // cannot deal Hearts — only another table of THIS game is, and it is refused
  // out loud rather than by a dead button.
  const refusal = sessions.refusalToHost(packId, { nameOf: packName });
  if (refusal) {
    setNotice(refusal);
    showPartyScreen();
    return false;
  }
  // A client we never sat down at is a pack we loaded speculatively. Nothing is
  // lost by standing up, and the table stays in the directory to go back to. A
  // seat we ARE sitting in stays exactly where it is: the registry just said
  // this is a different game, and one felt is not a reason to give up a chair.
  if (client() && !seatedHere()) leaveTable();
  ensurePort();
  const me = selfId();
  if (!me) return false;

  const manifest = await fetchPackManifest(packId);
  const count = Math.max(2, manifest?.players?.best ?? manifest?.players?.min ?? 2);
  packNames.set(packId, manifest?.name || packId);

  // THE TABLE IS BORN HERE, and everything it owns is born with it. The seat
  // table, the pack, the minted id and (after the deal) the state all belong to
  // this object for as long as the table exists — not to this module, and not
  // to whatever the felt happens to be showing.
  const session = openHostSession({
    tableId: mintTableId(),
    packId,
    packName: manifest?.name || packId,
    variants: [],
    seats: buildSeatTable(count, me),
  });
  session.host.start();
  port.onPeersChange(() => { refreshSeats(); checkForDrops(); });
  session.lobbyFrame = ourLobbyFrame();
  // Our table takes its place among the others, and the panel points at it —
  // by its own name now, not by the device's.
  publishOwnTable();
  activeKey = session.tableId;
  refreshPartyLabel().then(renderScreen);
  showPartyScreen();
  return true;
}

/**
 * Deal the table the party built.
 *
 * One publish afterwards and everybody is playing: `publish` bumps the sequence
 * and fans a fresh view out to every seated device, which is the same path a
 * move takes. There is no separate "the game started" frame to get wrong.
 */
export async function dealParty() {
  const session = ourTable();
  if (!session?.host || !session.seats || session.state) return false;
  goToTable();
  // THE STATE COMES BACK AND STAYS HERE. The felt builds it — dealing is a
  // render as much as it is a shuffle — but the session is what holds it
  // afterwards, so closing the felt no longer closes the game.
  session.state = await dealHostedTable({
    packId: session.pack.packId,
    variants: session.pack.variants,
    seats: session.seats,
    seating: seatingFromRoster(ourLobbyFrame()),
  });
  // THE FELT IS NOW SHOWING THIS ONE. Binding is about attention, not lifetime
  // — see src/match/tableSession.js. It is what tells a later background table
  // apart from the one in front of the player.
  bindFelt(session.tableId);
  session.host.broadcastLobby();
  session.host.publish([]);
  hidePartyScreen();
  refreshSeats();
  return true;
}

/* ------------------------------------------------------------------ *
 * The seat we keep when we are not the host
 *
 * Plan §6. A host stores seed + log; a joiner stores a note saying which chair
 * was theirs, so a tile can promise it back. Nothing about the game persists
 * here — coming back re-claims and asks for a snapshot, which is the path a
 * late joiner already takes.
 * ------------------------------------------------------------------ */

/**
 * The same host, the same game, a DIFFERENT table.
 *
 * `(hostDeviceId, packId)` is the uniqueness rule for tables that are live, and
 * the minted id is what tells two apart across time (plan §2) — so this pairing
 * means exactly one thing: they ended the game we had a seat at and dealt
 * another. The seat is not coming back, and a tile that went on promising it
 * would be the "sign on an open door saying CLOSED" the sniffer already worries
 * about elsewhere.
 *
 * Said ONCE without needing a flag to remember: clearing the stub removes the
 * only thing that makes this true, so the next frame finds nothing to announce.
 */
function noteSupersededSeat(frame) {
  if (!frame || frame.hostDeviceId === selfId()) return;

  // THE OLD TILE GOES TOO, and this half is not about our seat at all. A host
  // that ends a table politely sends `bye 'closed'` and the directory forgets
  // it; one whose battery died and who came back to deal again sends nothing,
  // and `pruneDeadTables` will not help because that host is plainly alive. The
  // pair being unique among LIVE tables is what makes the older entry provably
  // dead, so it is dropped here rather than left advertising open seats.
  for (const entry of tables.all()) {
    if (entry.hostDeviceId !== frame.hostDeviceId) continue;
    if (entry.packId !== frame.packId) continue;
    if (entry.key === frame.tableId) continue;
    tables.forget(entry.key);
    if (activeKey === entry.key) activeKey = null;
  }

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
 * THE HOST'S ROSTER IS WHAT MAKES IT TRUE. We write the stub when the host says
 * we are in the chair, never when we ask for it: a claim that was refused, or
 * one still in flight, would otherwise leave a tile promising a seat nobody
 * gave us. It is read off the LOBBY rather than a view because a seat is real
 * before the deal, and a table waiting to start is exactly one worth coming
 * back to.
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
      // `peerName` can only answer "Someone", and that is the exact moment the
      // tile needs to say whose table it was.
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

/* ------------------------------------------------------------------ *
 * A table that survives the tab
 *
 * Plan §6. `saveHostMatch`/`loadHostMatch`/`clearHostMatch` were built and
 * tested a long way back and never called once — there was no point while a
 * hosted table died with the felt anyway. Now that it does not, a reload is the
 * only thing left that can lose one.
 *
 * SEED + LOG, which is the same payload solo play stores, plus the seat
 * bindings alongside it. The bindings are NOT part of the match: replaying the
 * log reproduces the cards whoever is holding them, and a seat changing hands
 * mid-match must not make the log unreplayable.
 *
 * DEADLINES ARE NEVER PERSISTED. A stored deadline is a promise about a clock
 * that stopped existing when the tab closed; whoever rehydrates arms a fresh
 * one, which is also the answer that is fair to a player whose host crashed.
 * ------------------------------------------------------------------ */

function persist(session) {
  if (!session?.hosting() || !session.state || !session.seats) return;
  // A VIEW IS NOT A MATCH. Only a host holds seed + log; a joiner keeps nothing
  // across a reload and re-asks for a snapshot, which is what stops a client
  // writing full information about hands it was never shown.
  if (session.state.isView) return;
  try {
    // A FINISHED MATCH IS NOT A RESUMABLE ONE. Clearing on the last move rather
    // than waiting for "Stop hosting" means a host who closes the tab on a
    // finished game does not come back to it — the same rule solo play follows
    // when a match ends.
    if (session.state.gameOver) clearHostMatch(session.tableId);
    else saveHostMatch(session.tableId, session.state, session.seats);
  } catch (err) {
    // A save that fails is not a reason to stop the game. The launcher's own
    // quota handler (registerStorageErrorHandler) is what tells the player.
    console.error('[cardstock] could not save the hosted table', err);
  }
}

/**
 * Put back every table this device was hosting when it closed.
 *
 * Called once at boot, after the port exists. Each stored table becomes a live
 * session again — replayed through the full validator rather than trusted,
 * seats rebuilt from their bindings — and then publishes a lobby, which is the
 * whole of the reconvening: a joiner hears it, re-claims, and gets a snapshot
 * by the path it already uses.
 */
export async function rehydrateHostedTables() {
  // THE SWEEP RUNS FIRST, so a table a week past caring about is dropped rather
  // than restored and then swept. Silent by design — see storage.js.
  const swept = sweepStaleTables();
  if (swept.tables.length || swept.seats.length) {
    console.info(`[cardstock] rolled off ${swept.tables.length} table(s) and ${swept.seats.length} seat(s)`);
  }
  const stored = hostMatches();
  if (!stored.length) return 0;
  ensurePort();
  const me = selfId();
  if (!me) return 0;

  let restored = 0;
  for (const entry of stored) {
    try {
      if (await rehydrateOne(entry.tableId)) restored += 1;
    } catch (err) {
      // ONE UNREADABLE TABLE IS NOT ALL OF THEM. A pack that no longer parses,
      // or a log the current rules refuse, drops that table and leaves the
      // others alone — and drops it for good rather than retrying every boot.
      console.error('[cardstock] could not restore a hosted table', err);
      clearHostMatch(entry.tableId);
    }
  }
  if (restored) { refreshEntry(); renderScreen(); }
  return restored;
}

async function rehydrateOne(tableId) {
  const snapshot = loadHostMatch(tableId);
  if (!snapshot) { clearHostMatch(tableId); return false; }

  const pack = await fetchPack(snapshot.packId, snapshot.variants);
  // THE FULL VALIDATOR, not a shortcut. `rehydrateMatch` replays every move
  // through `applyMove`, so a log that the current rules would refuse throws
  // here rather than producing a table in a state those rules could never have
  // reached. That is the same door the payload went out of.
  const state = rehydrateMatch(pack, snapshot);
  const seats = deserializeSeatTable(snapshot.seatBindings, { localDeviceId: selfId() })
    || createSeatTable({ seats: snapshot.seats, localDeviceId: selfId() });

  const session = openHostSession({
    tableId,
    packId: snapshot.packId,
    packName: packName(snapshot.packId),
    variants: snapshot.variants || [],
    seats,
  });
  session.state = state;
  session.seating = seatingFromRoster(ourLobbyFrame());
  session.lobbyFrame = ourLobbyFrame();
  publishOwnTable();
  // THE PARTY RECONVENES ON A LOBBY FRAME. Nothing else is needed: a joiner
  // that hears it re-claims its seat and the host answers with a snapshot,
  // which is exactly the path a late joiner already takes.
  session.host.broadcastLobby();
  // Armed fresh, never restored — see this section's header.
  armTimer(session);
  driveBots(session);
  return true;
}

/* ------------------------------------------------------------------ *
 * Bots at a table nobody is looking at
 *
 * The felt drives the session it is bound to, exactly as it always has —
 * `scheduleNextTurn` in src/ui/table.js, through the animation pipeline. What
 * is new is that an UNBOUND hosted table has bots too, and they have to keep
 * playing while a different table is on screen.
 *
 * `createBotDriver` was built to be driven from anywhere: it takes its clock,
 * its seat lens and its "how a move lands" seam by injection and never touches
 * the DOM. So the headless driver is the same module with `playMove` pointed at
 * `host.applyLocal` instead of at the felt — no second implementation of whose
 * turn it is, which is what keeps the two from drifting.
 * ------------------------------------------------------------------ */

function headlessBotsFor(session) {
  const seatLens = createSeatLens(() => session.seats);
  return createBotDriver({
    // The WALL clock, for the same reason the turn timer takes it: a shared
    // hand does not stop because this tab stopped painting. The felt's driver
    // takes the SESSION clock, which freezes with a suspended frame — right for
    // solo, wrong for a table other people are sitting at.
    clock: wallClock(),
    currentEpoch: () => session.epoch,
    botDelayMs: () => loadSettings().botDelayMs,
    me: seatLens,
    identityOf: (seat) => session.seating?.[seat]
      || { seat, name: nameForSeat(seat) || `Seat ${seat}`, icon: '', color: '#6b7280', isBot: true },
    actingSeatsOf: (state) => {
      if (state.gameOver) return [];
      const template = state.pack.template;
      return template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    },
    announcementsFor: (state, seat) => {
      const template = state.pack.template;
      if (!template.enumerateAnnouncements) return [];
      return template.enumerateAnnouncements(makeCtx(state), seat) || [];
    },
    // THE ONLY REAL DIFFERENCE FROM THE FELT'S DRIVER. No animation, no log
    // line, no sound — `applyLocal` applies the move and publishes it, which is
    // the same door every other move at this table goes through.
    playMove: (_state, move) => { session.host?.applyLocal(move); },
    playAnnouncement: (_state, move) => { session.host?.applyLocal(move); },
    onError: (message) => setNotice(message),
  });
}

/**
 * Keep an unbound hosted table playing itself.
 *
 * A no-op while the felt is bound, because then the felt is already doing it
 * and two drivers scheduling against one state would move the same bot twice.
 */
function driveBots(session) {
  if (!session?.hosting() || !session.bots || !session.state) return;
  if (session.bound || session.paused) return;
  session.bots.scheduleNextTurn(session, session.epoch);
  session.bots.scheduleAnnouncementBeats(session, session.epoch);
}

/**
 * Hand the table over between the felt and the headless driver.
 *
 * Binding cancels the headless timers first: the felt picks the turn up through
 * its own scheduler, and a pending headless turn would otherwise fire into an
 * animation pipeline that had just taken responsibility for the same seat.
 */
function bindFelt(tableId) {
  for (const other of sessions.hosted()) other.cancelBots();
  const bound = sessions.bind(tableId);
  for (const other of sessions.hosted()) if (other !== bound) driveBots(other);
  return bound;
}

/**
 * The felt stopped showing whatever it was showing.
 *
 * EXPORTED, because the felt's own "Lobby" button does not come through this
 * module — src/main.js wires it straight to `initTable({ onExit })`. That path
 * used to call `stopHosting()`, on the reasoning that leaving the table ended
 * the party because the table WAS what was being hosted. After the session
 * inversion that reasoning no longer holds: the match outlives the felt, so
 * leaving is a change of attention and nothing more.
 */
export function leaveFelt() {
  sessions.unbind();
  for (const session of sessions.hosted()) driveBots(session);
}


/**
 * Re-arm after every published move, and keep the countdown painting.
 *
 * `arm` is idempotent by design — a seat that has been waited on all along
 * KEEPS its deadline rather than having its clock reset by somebody else's
 * move, which is what stops a timeout being unreachable at a busy table.
 */
function armTimer(session = ourTable()) {
  const state = session?.state;
  if (!session?.timer || !state) return;
  session.timer.arm(state);
  pulse();
  renderStrip();
}

export function stopHosting() {
  const session = ourTable();
  if (!session?.host) return;
  const tableId = session.tableId;
  if (tick) { clearInterval(tick); tick = null; }
  port?.send({ k: FRAME.BYE, why: 'closed', tableId });
  setLocalMoveListener(null);
  setTablePaused(false);
  // ONE TEARDOWN POINT NOW. The timer, the host, the seat table, the two
  // bookkeeping Sets and the state all go with the session, which is what stops
  // this list drifting out of step with the one in hostGame.
  sessions.remove(tableId);
  // AND ITS SLOT. Stopping is the deliberate end of a table, so leaving the
  // save behind would resurrect it on the next boot — a game the player closed
  // on purpose, back on the lobby with everybody re-invited to it.
  clearHostMatch(tableId);
  // Our table stops being a table the moment we stop hosting it, and its tile
  // has to go with it — we already told everybody else the same thing by `bye`.
  tables.forget(tableId);
  activeKey = null;
  // Closing our table puts us back in the room, looking at whatever else is in
  // it — which for the host who was never told about the neighbours' tables
  // used to be nothing at all.
  focusTable(tables.latest()?.key);
  renderScreen();
}

/**
 * A host that stopped answering.
 *
 * A table whose host has left the party is not a table any more, and nothing
 * says so on the wire: a host that closes politely broadcasts `bye`, but one
 * whose battery died says nothing, and the only evidence is the roster. Without
 * this, that table would sit on the lobby forever advertising open seats.
 */
function pruneDeadTables() {
  const live = (port?.peers() || []).map((p) => p.deviceId);
  // OURSELVES, EXPLICITLY. A device is never in its own `peers()`, so a host
  // that filed its own table would prune it on the next roster change and its
  // tile would blink out while the game was still running.
  if (host()) live.push(selfId());
  const dropped = tables.retain(live);
  if (!dropped.length) return;
  if (activeKey && dropped.includes(activeKey)) {
    activeKey = null;
    focusTable(tables.latest()?.key);
  }
}

/** Can this device offer a party at all? The lobby tile asks before drawing. */
export function canHost() {
  return availability().available;
}

/**
 * Take a seat back off the person in it.
 *
 * The seat becomes a bot rather than opening, because this happens mid-hand as
 * often as not and an empty chair with cards in it is a table that stops. The
 * `bye` is the half that matters: a client whose seat vanished with no word
 * cannot tell being removed from the host crashing, and would sit there
 * proposing into nothing.
 */
async function removeSeat(seat) {
  const who = nameForSeat(seat) || `Seat ${seat + 1}`;
  const ok = await confirmAction(`Remove ${who} from the table? A bot takes over their hand.`,
    { okLabel: 'Remove them', cancelLabel: 'Keep them' });
  if (!ok) return;
  const owner = hostSeats().ownerOf(seat);
  if (owner.kind === 'device' && owner.deviceId) {
    port.send({ k: FRAME.BYE, why: 'replaced', tableId: hostTableId() }, { to: owner.deviceId });
  }
  hostSeats().seatBot(seat);
  afterSeatChange();
}

/* ------------------------------------------------------------------ *
 * The host's decision on a terminal drop
 * ------------------------------------------------------------------ */

/**
 * A seat whose device is GONE is a decision, and it is the host player's.
 *
 * Not `interrupted` — an interrupted seat KEEPS PLAYING. The transport queues
 * sends through the gap and replays them exactly once, so a phone in a tunnel
 * has missed nothing, and bot-filling it would turn a recoverable blip into a
 * lost seat. Only when the grace has run out is there anything to ask.
 */
function checkForDrops() {
  if (!host()) return;
  const ctx = tableContext();
  if (!ctx) return;
  for (let seat = 0; seat < ctx.seats.count; seat++) {
    if (!needsHostDecision(host().seatStatusFor(seat))) { decided().delete(seat); continue; }
    if (decided().has(seat)) continue;
    decided().add(seat);
    askAboutSeat(seat);
    return; // one at a time; the next is asked after this is answered
  }
}

function askAboutSeat(seat) {
  if (!el.decision) return;
  const who = nameForSeat(seat) || `Seat ${seat + 1}`;
  el.decisionText.textContent = `${who} has left the table.`;
  el.decision.hidden = false;

  const answer = (choice) => {
    el.decision.hidden = true;
    const ctx = tableContext();
    if (choice === 'bot') {
      // THE BINDING IS REPLACED, not merely covered: the seat is a bot now, and
      // the departed player rejoining takes a free seat rather than this one.
      ctx?.seats.seatBot(seat);
      setTablePaused(false);
      afterSeatChange();
    } else if (choice === 'pause') {
      setTablePaused(true);
      setNotice(`Paused — waiting for ${who}.`);
      afterSeatChange();
    } else {
      stopHosting();
      goToLobby();
    }
  };

  el.decision.querySelectorAll('[data-choice]').forEach((node) => {
    node.onclick = () => answer(node.dataset.choice);
  });
}

/* ------------------------------------------------------------------ *
 * Joining
 * ------------------------------------------------------------------ */

/**
 * The table sniffer.
 *
 * A joiner cannot start a real client before it knows WHICH pack to load — the
 * client refuses a lobby whose pack is not the one this build has open, and
 * quite right too. So this listens for the one frame that answers that
 * question, applying the same two rules the client itself applies: a frame is
 * only believed from the device we hold a DIRECT link to, and never when it
 * arrives relayed (a fellow joiner can address us through the hub).
 *
 * It fills the directory and never holds a scrap of state.
 */
function startSniffing() {
  if (sniffOff || !port) return;
  sniffOff = port.onMessage((payload, fromDeviceId, meta) => {
    // EVERYBODY HEARS THE ROOM, whatever they are doing in it. This used to
    // give up the moment we became a client — `if (client || host)` — which
    // meant the second table in a party was unknowable to anybody already
    // sitting at the first, and a host was deaf to every table but its own.
    // Hearing is not joining: what a host or a seated joiner does with a
    // sighting is put it on a tile, and the guards below are what keep it from
    // becoming anything more.
    if (!fromDeviceId) return;
    const verdict = validateFrame(payload);
    if (!verdict.ok) return;
    const frame = verdict.frame;
    if (frame.k === FRAME.BYE) return void noteBye(fromDeviceId, frame, meta);
    if (frame.k !== FRAME.LOBBY) return;
    // Our own broadcast, come back to us. Not a table we discovered.
    if (frame.hostDeviceId === selfId()) return;
    // AUTHENTIC MEANS "FROM A DEVICE WE HOLD A DIRECT LINK TO", which is not the
    // same test as "from the single device we hold a direct link to" — and the
    // difference is the whole of two tables. With two hosts in the party there
    // are two direct peers, the old `direct.length === 1` answered null, and
    // every lobby frame from BOTH of them was dropped as unauthenticated: not
    // one table too few, but nothing at all. The security property is the one
    // that mattered and it is unchanged — the sender must be direct and the
    // frame must not be relayed, so a fellow joiner cannot advertise a table
    // through the hub.
    const direct = port.peers().filter((p) => p.direct).map((p) => p.deviceId);
    const hostDeviceId = direct.includes(fromDeviceId) ? fromDeviceId : null;
    if (!isAuthentic(FRAME.LOBBY, { fromDeviceId, hostDeviceId, relayed: meta?.relayed })) return;

    const known = tables.get(tableKeyOf(frame));
    // A FRESH INVITATION CLEARS THE LAST ONE'S EPITAPH. "The host closed the
    // table" is true and worth saying — right up until the host opens another
    // one, at which point it is a sign on an open door saying CLOSED. Now that
    // several tables are known, the comparison is against THIS table's last
    // frame rather than against the one slot everything used to share.
    if (notice && (!known || known.frame.packId !== frame.packId
      || !known.frame.started !== !frame.started)) {
      notice = '';
    }
    const entry = tables.sight(frame);
    if (!entry) return;
    rememberPackName(frame.packId);
    // HEARING THE HOST IS ENOUGH TO KEEP THE PROMISE ALIVE. A seat we hold at a
    // table we are not currently a client of still ages on this, which is what
    // stops a week of watching from someone else's felt rolling it off.
    touchSeatStub(entry.key);
    noteSupersededSeat(frame);
    noteSeatFrom(frame);
    // WHERE TO LOOK, and the rule is about attachment rather than recency: an
    // unattached device follows the latest table it hears about (which with one
    // table in earshot is exactly the old behaviour), and a device already at a
    // table — its own or somebody else's — is not dragged off it by a neighbour
    // dealing.
    if (!host() && !client() && !joining) focusTable(entry.key);
    if (!host() && activeKey === entry.key) {
      // No `lobbyFrame` to stash any more: `shownFrame()` already prefers the
      // directory's copy of this very frame, which `tables.sight` just filed.
      // BECOME A CLIENT AS SOON AS WE ARE INVITED, rather than on a button.
      // Loading the pack is the only thing "Join" ever did, and making it a
      // separate tap meant the seat buttons were dead until you found it —
      // two decisions where there is only one, and the second one is the seat.
      // Only for the table we are looking at: auto-loading a pack for every
      // table in earshot would be a fetch per host, for felts nobody asked
      // to see.
      joinTable(entry).catch(reportFailure);
    }
    refreshEntry();
    renderScreen();
  });
}

/**
 * A `bye` from a host we know about.
 *
 * ONLY 'closed' RETIRES A TABLE, and the precision matters because three
 * different partings share this frame kind. A joiner leaving says 'leave' and
 * reaches us relayed through the hub — that is somebody standing up, not a
 * table ending. A removed player is told 'replaced', privately, about their own
 * seat. Only the host broadcasting 'closed' means the felt is gone, and only
 * the host's own direct frame is believed for it: a relayed 'closed' is a
 * fellow joiner claiming an authority it does not have.
 */
function noteBye(fromDeviceId, frame, meta) {
  if (meta?.relayed) return;
  if (frame.why !== 'closed') return;
  // WHICH TABLE CLOSED, said by the frame itself. Under v1 this had to be
  // inferred from the sender, which was right only because a device could host
  // just one — the assumption this whole stage exists to remove.
  const key = frame.tableId;
  const entry = tables.get(key);
  if (!entry || entry.hostDeviceId !== fromDeviceId) return;
  tables.forget(key);
  if (activeKey === key) {
    activeKey = null;
    // The frame this clears belongs to whichever table closed, and a table's
    // frame now goes with its session. Clearing it here used to reach across
    // and blank the HOST's own roster when a neighbour's table ended.
    focusTable(tables.latest()?.key);
  }
  refreshEntry();
  renderScreen();
}

/**
 * Load the host's pack, then become a real client of its table.
 *
 * ONE AT A TIME, AND THE GUARD IS NOT PARANOIA. A host broadcasts its lobby on
 * start, on every seat change and on every `onReady` — several frames inside a
 * few milliseconds is ordinary — and this function AWAITS a pack fetch in the
 * middle. Without the flag, every one of those frames sees `client` still null,
 * and each starts a client of its own. Only the last is kept in the variable;
 * the rest stay subscribed to the transport, invisible and still live. One of
 * those ghosts receiving a `bye` calls `leaveTable`, which nulls the client the
 * UI is actually using — and the seat grid stops offering seats at a table that
 * is plainly advertising three of them.
 */
async function joinTable(entry) {
  if (!entry || client() || joining) return;
  joining = true;
  const frame = entry.frame;
  let pack;
  try {
    pack = await fetchPack(frame.packId, frame.variants);
  } catch (err) {
    joining = false;
    throw err;
  }

  // A JOINER'S TABLE IS A SESSION TOO. It holds a view rather than a state, but
  // everything else about it is the same question — which pack, which chairs,
  // whose roster — and answering it per table is what stops a second table's
  // lobby frame redrawing this one's seats.
  const session = createTableSession({
    tableId: entry.key,
    packId: frame.packId,
    role: 'joiner',
    packName: packNames.get(frame.packId) || frame.packId,
  });
  session.pack = pack;
  session.lobbyFrame = frame;
  sessions.add(session);

  session.attach({ client: createTableClient({
    peer: port,
    // WHICH TABLE WE SAT DOWN AT, said rather than inferred — the device to
    // trust, and now the table on that device to listen for. The client can
    // work the host out on its own when there is one in the party; with two it
    // cannot, and guessing would be the wrong kind of clever about authority.
    host: entry.hostDeviceId,
    tableId: entry.key,
    expects: () => ({
      packId: session.pack.id,
      packVersion: session.pack.manifest?.version,
      variants: session.pack.activeVariants ?? [],
    }),
    hooks: {
      // OUR HOST'S FRAMES ARE SIGHTINGS TOO. The client hands them over already
      // authenticated, and filing them keeps the tile of the table we are
      // sitting at as current as the tiles of the ones we are only watching.
      onLobby: (next) => {
        const seen = tables.sight(next);
        if (seen && !activeKey) focusTable(seen.key);
        session.lobbyFrame = next;
        noteSeatFrom(next);
        renderScreen();
      },
      onView: (view, _events, meta) => {
        // THE VIEW IS THIS TABLE'S, and it is kept on this table's session — so
        // a second table's view can arrive without overwriting it.
        session.state = view;
        bindFelt(session.tableId);
        adoptSharedView({
          view,
          pack: session.pack,
          // A joiner has no seed, so who is at the table is a fact the host
          // publishes rather than one we derive.
          seating: seatingFromRoster(session.lobbyFrame),
          client: session.client,
          message: meta?.snapshot ? 'Caught up.' : '',
        });
        goToTable();
        pulse();
        renderStrip();
      },
      onReject: (frame2) => Arcade.ui.toast(frame2.reason || 'That move is not legal.',
        { kind: 'error', duration: 2500 }),
      onEmote: ({ emote }) => burst(emote),
      onIncompatible: surfaceIncompatible,
      onError: surfaceError,
      // 'replaced' is the host taking this seat back; 'closed' is the whole
      // table ending. Same exit, two different sentences, because "your game
      // vanished" is not a thing to leave somebody guessing about.
      onEnd: ({ why }) => {
        setNotice(why === 'replaced'
          ? 'The host gave your seat to a bot.'
          : 'The host closed the table.');
        leaveTable();
        goToLobby();
      },
    },
  }) });
  session.client.start();
  joining = false;
  // The last table's parting words are not this table's news.
  if (notice) setNotice('');
  refreshPartyLabel().then(renderScreen);
  renderScreen();
}

/**
 * Make our client the client OF THE TABLE ON SCREEN.
 *
 * THE PANEL AND THE WIRE CAN NOW DISAGREE, which they could not when there was
 * one of each. Looking at Dana's seats while our client is still bound to Ada's
 * table is a perfectly ordinary thing to do — and tapping a chair in that state
 * would have sent a claim for Dana's seat index to ADA, which is either a
 * refusal or, worse, the wrong seat at the wrong table.
 *
 * Returns false when it could not, which is only ever because we are already
 * SITTING somewhere. Looking is free; standing up is a decision, and it is the
 * player's.
 */
async function attachToActive() {
  const entry = activeTable();
  if (!entry) return false;
  // Our own table needs no client; we are already as attached as it gets.
  if (entry.hostDeviceId === selfId()) return !!host();
  if (client() && client().hostDeviceId() === entry.hostDeviceId) return true;
  if (client()) {
    if (seatedHere()) {
      setNotice(`You are sitting at ${peerName(client().hostDeviceId())}'s table. Leave it to sit here.`);
      return false;
    }
    // Never sat down at that one; it stays in the directory to go back to.
    leaveTable();
  }
  await joinTable(entry);
  return !!client();
}

/** Sit down, becoming a client of the table on screen first. */
async function claimSeat(seat) {
  if (!await attachToActive()) return;
  client()?.claimSeat(seat);
}

export function leaveTable() {
  const session = theirTable();
  if (session?.client) session.client.sendBye('leave');
  joining = false;
  if (tick) { clearInterval(tick); tick = null; }
  // `remove` stops the client for us — the one teardown point, as in stopHosting.
  if (session) {
    // STANDING UP IS GIVING THE SEAT BACK. The stub is a promise that a chair
    // is still ours; leaving is the one move that says it is not, so the tile
    // must stop offering it. A host that goes quiet is the opposite case — the
    // promise holds, and the tile says "offline" instead.
    clearSeatStub(session.tableId);
    sessions.remove(session.tableId);
  }
  // BACK TO WATCHING, NOT BACK TO NOTHING. Leaving a table does not unhear the
  // room: whatever else is out there — including the table we just left, if its
  // host is still advertising it — is still on the lobby, and the panel falls
  // back to whichever one we were looking at. `shownFrame()` does that on its
  // own now that the session carrying the old frame is gone.
  leaveSharedTable();
  renderScreen();
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

function announceGate(gate) {
  if (gate.reason === 'launcher-too-old') {
    setNotice(`Your launcher needs updating to play together — it is missing ${gate.missing.join(', ')}.`);
    Arcade.ui.toast('Launcher update required for multiplayer.', { kind: 'error', duration: 5000 });
  }
}

/**
 * Show or hide the "Play together" door, from scratch, every time.
 *
 * There are three reasons it can be closed and only one of them is worth a
 * sentence: standalone play offers nothing (there is no party to join and
 * saying so would be noise), an old launcher gets one specific notice, and a
 * live party gets the button.
 */
export function refreshEntry() {
  if (!el.entry) return;
  const gate = availability();
  ensurePort();
  if (gate.reason === 'standalone' || gate.reason === 'no-peer-api') {
    el.entry.hidden = true;
    for (const node of document.querySelectorAll('.tile__together')) node.hidden = true;
    // A LAUNCHER CAN GO AWAY. Leaving the row up after the party surface has
    // gone would leave tiles pointing at tables nothing can reach.
    if (el.tablesRow) el.tablesRow.hidden = true;
    return;
  }
  if (!gate.available) {
    el.entry.hidden = false;
    el.entry.textContent = 'Launcher update required';
    el.entry.disabled = true;
    return;
  }
  startSniffing();
  // Re-ask about the seats too. `onPeersChange` is the usual trigger, but a
  // player coming back to this screen deserves an answer that is current rather
  // than one that is waiting for the next transport event.
  checkForDrops();
  pruneDeadTables();
  // THE HEADER BUTTON IS THE JOINER'S DOOR AND ONLY THE JOINER'S. Hosting is
  // offered on the game tiles, because a host picks a game first; there is
  // nothing for this button to mean until somebody else has picked one.
  // The tiles' own doors, toggled in place: a party can form while the player
  // is sitting on the lobby, and the tiles were built before it did.
  for (const node of document.querySelectorAll('.tile__together')) node.hidden = false;
  renderLobby();
  const invited = tables.size > 0 || !!client() || !!host();
  el.entry.hidden = !invited;
  el.entry.disabled = false;
  el.entry.textContent = host() ? 'Your party' : (client() ? 'Your table' : 'Join the table');
  renderStrip();
}

/**
 * Open the party panel OVER whatever is on screen.
 *
 * Over, not instead of, and that is the whole correction: this used to be a
 * third screen, which the two-screen router in src/main.js does not know about
 * — so it unhid itself underneath the lobby grid and could only be found by
 * scrolling past every game tile. An overlay is also the right shape. What is
 * underneath is the context (a joiner is deciding whether to join THAT game),
 * and a host must be able to look at the seats without its table being torn
 * down to do it.
 */
/**
 * Say, on the tile, that this game has a table on it.
 *
 * WHICH GAME IS THE MISSING FACT. A party announces itself in the header, and
 * the header cannot say what is being played — so a joiner was told a table
 * existed and left to guess where. The lobby already has a vocabulary for
 * "there is something here": the in-progress ribbon. This is the same sentence
 * about somebody else's table, on the tile that game lives on.
 */
function decorateTiles() {
  // EVERY PACK WITH A TABLE ON IT, not the one pack the single slot happened to
  // hold. Two hosts in a party means two ribboned tiles, and the old code could
  // only ever draw one of them — the other game looked idle while somebody was
  // sitting at it.
  const live = new Map();
  for (const entry of tables.all()) {
    // OURS WINS THE TILE when two hosts happen to run the same pack: "Your
    // party" is the more useful of the two sentences to read on your own
    // screen, whichever of them we heard about first.
    if (live.has(entry.packId) && entry.hostDeviceId !== selfId()) continue;
    live.set(entry.packId, entry.frame);
  }

  for (const tile of document.querySelectorAll('.tile[data-pack-id]')) {
    const slot = tile.querySelector('.tile__party');
    const door = tile.querySelector('.tile__together');
    const frame = live.get(tile.dataset.packId) || null;
    if (slot) {
      slot.hidden = !frame;
      slot.textContent = frame ? partyRibbon(frame) : '';
    }
    // The door's LABEL changes with its meaning. "Play together" starts a
    // table; on the game somebody is already at, the only useful verb is the
    // one that takes you there.
    if (door && !door.hidden) {
      const someone = frame && frame.hostDeviceId !== selfId();
      door.textContent = someone ? 'Take a seat' : 'Play together';
    }
  }
}

/**
 * "Ada's table · waiting to deal · 2 seats open" — one line, in that order.
 *
 * WHOSE TABLE IT IS COMES FROM THE FRAME, not from the module's role flags and
 * not from the party leader. Neither of those survives a second table: the
 * `host` flag says what we are doing at OUR table and answers for somebody
 * else's, and a party leader is not necessarily the person who dealt — with two
 * tables in one party, at most one of them belongs to the leader.
 */
function partyRibbon(frame) {
  if (!frame) return 'Your party';
  const whose = frame.hostDeviceId === selfId()
    ? 'Your party'
    : `${peerName(frame.hostDeviceId)}'s table`;
  const stage = frame.started ? 'in progress' : 'waiting to deal';
  const open = (frame.seats || []).filter((s) => s.kind !== 'device').length;
  const seats = open === 0 ? 'table full' : `${open} ${open === 1 ? 'seat' : 'seats'} open`;
  return `${whose} · ${stage} · ${seats}`;
}

/**
 * Open the panel, optionally ABOUT A PARTICULAR TABLE.
 *
 * The argument is the whole of this stage's change to the panel: it used to be
 * a window onto the one table this module could hold, and it is now a window
 * onto whichever one you tapped. With no argument it shows what it was already
 * showing, which is what the header button and every internal caller want.
 */
export function showPartyScreen(key = null) {
  if (!el.screen) return;
  if (key) focusTable(key);
  el.screen.hidden = false;
  refreshPartyLabel().then(renderScreen);
  renderScreen();
}

export function hidePartyScreen() {
  if (el.screen) el.screen.hidden = true;
}

export function isPartyScreenOpen() {
  return !!el.screen && !el.screen.hidden;
}

export function initParty({ onShowTable, onShowLobby }) {
  goToTable = onShowTable || (() => {});
  // NOT WRAPPED TO UNBIND ANY MORE. `leaveFelt` is exported and src/main.js's
  // `goToLobby` calls it directly, which is the only way the felt's own Lobby
  // button — wired straight to initTable, never through this module — can
  // unbind too. Doing it in both places would just unbind twice.
  goToLobby = onShowLobby || (() => {});
  ensurePort();

  el.entry?.addEventListener('click', () => {
    const gate = availability();
    if (!gate.available) { announceGate(gate); return; }
    showPartyScreen();
  });
  // CLOSING IS NOT LEAVING. The panel is a look at the seats; dismissing it
  // returns to whatever it was covering. Actually leaving a table is one of the
  // buttons inside it, and says so.
  el.back?.addEventListener('click', () => hidePartyScreen());
  // The two dismissals every other overlay on this game already answers to.
  el.screen?.addEventListener('click', (event) => {
    if (event.target === el.screen) hidePartyScreen();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isPartyScreenOpen()) hidePartyScreen();
  });

  // The party surface can appear at any moment: a game is often mounted before
  // anybody has paired. Both of these re-ask rather than remembering.
  try {
    port?.onStatus(() => { refreshEntry(); renderScreen(); });
    port?.onPeersChange(() => { pruneDeadTables(); refreshEntry(); renderStrip(); });
  } catch { /* an older surface without the hooks is simply quieter */ }

  refreshEntry();
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

/**
 * What this device believes about the party, as plain data.
 *
 * A DELIBERATE, NARROW SURFACE — and the one thing in this file that exists
 * partly for the test suite (tools/mp-acceptance.mjs, which drives three real
 * launchers and cannot reach a module-scoped `let`). It is read-only and it
 * carries nothing a player cannot already see on this screen, which is the line:
 * a diagnostic that reports the visible truth is fine, and one that hands out a
 * capability the UI does not offer is a back door.
 */
export function partySnapshot() {
  return {
    role: partyRole(),
    notice,
    seq: host() ? host().seq() : (client() ? client().seq() : -1),
    seat: client() ? client().seat() : null,
    seats: [...seatStatuses().entries()].map(([seat, status]) => ({ seat, status })),
    unreachable: [...unreachable()],
    paused: notice.startsWith('Paused'),
    required: REQUIRED_CAPS,
    // WHAT ELSE IS IN THE ROOM. Every one of these is already drawn on a lobby
    // tile, so this stays inside the rule the rest of this snapshot follows —
    // it reports the visible truth and hands out no capability. It is also the
    // only way the three-launcher suite can assert that a second table exists
    // rather than inferring it from a button being enabled.
    tables: tables.all().map((entry) => ({
      key: entry.key, hostDeviceId: entry.hostDeviceId, packId: entry.packId,
      started: !!entry.frame.started, active: entry.key === activeKey,
    })),
  };
}

/**
 * Take the turn this device has been offered, exactly as tapping the felt would.
 *
 * A JOINER PROPOSES AND A HOST APPLIES, which is the asymmetry the whole design
 * rests on, and both roads here are the ones a finger takes: the joiner's move
 * comes from the list the HOST shipped with its view (design decision D3 — a
 * client never enumerates), and the host's goes through the same `applyLocal`
 * an accepted proposal does.
 *
 * Returns the move it made, or null when this seat has nothing to do. Exposed
 * for the same reason as `partySnapshot`: a scripted hand across three real
 * browsers has no other way to say "your turn".
 */
export function takeTurn() {
  if (client()) {
    const view = client().view();
    const move = view?.moves?.[0];
    if (!move) return null;
    client().propose(move);
    return move;
  }
  const session = ourTable();
  if (!session?.host) return null;
  // THE SESSION'S STATE, NOT THE FELT'S. This read `tableContext()`, which is
  // null the moment the felt is showing something else — so the one call that
  // plays this device's seat stopped working at exactly the table that needs it
  // most, a hosted game running in the background.
  if (!session.state || session.state.isView || !session.seats) return null;
  const mine = session.seats.seatsOfDevice(selfId());
  for (const seat of mine) {
    const move = legalFor(session.state, seat);
    if (!move) continue;
    // `applyLocal` publishes AND fires onApplied, which is what runs the felt's
    // post-move ritual. Calling that ritual again here ran it twice per host
    // move — two renders, two saves, and two round-summary timers.
    const verdict = host().applyLocal(move);
    if (verdict?.legal) return move;
  }
  return null;
}

/** The host may enumerate, because the host has a state. A client may not. */
function legalFor(state, seat) {
  if (state.turn.seat !== seat) return null;
  return enumerateLegalMoves(state, seat)[0] || null;
}
