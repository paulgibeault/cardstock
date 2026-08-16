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
import { EMOTES, mintTableId } from '../match/protocol.js';
import { botById, initialsOf, pickBotIds } from '../players/roster.js';
import { createBotDriver } from './botDriver.js';
import {
  loadSettings, saveHostMatch, clearHostMatch, hostMatches, loadHostMatch,
  clearSeatStub, sweepStaleTables, seatStubs,
} from '../arcade/storage.js';
import { fetchPack, fetchPackManifest } from './packSource.js';
import { confirmAction } from './confirm.js';
import {
  adoptSharedView, leaveSharedTable, tableContext, setSeating, dealHostedTable, resumeHostedTable,
  setLocalMoveListener, afterRemoteMove, setTablePaused, rerenderTable,
} from './table.js';
import { createSeatTable, createSeatLens, deserializeSeatTable } from '../players/seats.js';
import { createTableSightings } from './tableSightings.js';
import { nextFocus } from './partyFocus.js';
import {
  partyModel, tableOf, packState, seatingFromRoster as seatingOf, emptyBeliefs,
} from './partyModel.js';

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

/**
 * What a host may choose instead (plan §7).
 *
 * A SHORT LIST, NOT A FIELD. "How many seconds should a turn get" is a question
 * with no good answer typed into a box: too small a number breaks the table for
 * everyone and too large one turns the timer off without saying so. Three
 * choices cover the three real situations — people in a room together, people
 * across an evening, people across a week — and the default is unchanged, so a
 * host who never opens this gets exactly what they got before.
 */
const GRACE_CHOICES = Object.freeze([
  { ms: 30_000, label: '30 seconds', hint: 'everyone here, playing fast' },
  { ms: TURN_TIMEOUT_MS, label: '1 minute', hint: 'the usual' },
  { ms: 300_000, label: '5 minutes', hint: 'a game across the evening' },
]);

/** The grace a table runs on, falling back for a host who never chose. */
function graceOf(session) {
  return session?.graceMs || TURN_TIMEOUT_MS;
}

/** "1 minute", for a grace that may not be one of the three we offer. */
function graceLabel(ms) {
  const known = GRACE_CHOICES.find((choice) => choice.ms === ms);
  if (known) return known.label;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

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
// Which sighted table the panel is about. Null when we are hosting or idle with
// nothing in earshot. It moves on its own only while we are unattached — once
// we are a client of a table, a new sighting elsewhere is news, not a summons.
let activeKey = null;
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

/**
 * The hosted table this screen is ABOUT, or null.
 *
 * Resolved the same three ways as `theirTable()` below, and for the same
 * reason: with a table per pack, "the table we host" needs a subject. The
 * panel's table, else the one the felt is bound to, else the only one — and
 * that last fallback is what keeps every single-table path answering exactly
 * as it did.
 *
 * PANEL-FACING QUESTIONS ONLY. Anything a specific host asks about ITS OWN
 * table — its roster, its drops, its seat names — takes the session, because
 * the answer must not depend on what the player happens to be looking at.
 */
const ourTable = () => {
  const hosted = sessions.hosted();
  if (!hosted.length) return null;
  if (activeKey) {
    const shown = hosted.find((session) => session.tableId === activeKey);
    if (shown) return shown;
  }
  const bound = hosted.find((session) => session.bound);
  return bound || hosted[0];
};
/**
 * The joined table this screen is ABOUT, or null.
 *
 * ONE SEAT USED TO MEAN ONE ANSWER. Now that a device can sit at Dana's Hearts
 * and Bo's Crazy Eights at once, "the table we joined" is a question that needs
 * a subject, and the three ways of asking it resolve in this order:
 *
 *   the table the PANEL is showing   — tapping a tile is asking about that one
 *   the table the FELT is bound to   — what we are actually playing
 *   the only one there is            — which is every case before this stage,
 *                                      so single-seat behaviour is unchanged
 *
 * The fallbacks matter as much as the first answer: `partyRole`, `sendEmote`
 * and `leaveTable` are asked while the panel is closed, and must still find the
 * table in front of the player.
 */
const theirTable = () => {
  const joined = sessions.joined();
  if (!joined.length) return null;
  if (activeKey) {
    const shown = joined.find((session) => session.tableId === activeKey);
    if (shown) return shown;
  }
  const bound = joined.find((session) => session.bound);
  return bound || joined[0];
};

/** Every seat we hold, live — the sessions behind the "switch tables" path. */
const seatedTables = () => sessions.joined().filter((session) => session.client?.seat?.() != null);
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

/* ------------------------------------------------------------------ *
 * The tables we are NOT part of
 *
 * Everything in earshot, and the layer that decides what "in earshot" even
 * means — the subscription, the two authenticity rules, the directory, and the
 * seat stubs that outlive a host going quiet. All of it lives in
 * src/ui/tableSightings.js now (#73) — the first piece of this file to leave,
 * chosen because it had the fewest tendrils.
 *
 * WHAT CAME BACK ARE THE DECISIONS. A sighting is news; what to do about it —
 * where to point the panel, whether to load a pack, what to repaint — needs the
 * felt and the registry in view, so it is here and the module calls out to it.
 * ------------------------------------------------------------------ */

const sightings = createTableSightings({
  port: () => port,
  selfId: () => selfId(),
  peerName: (deviceId) => peerName(deviceId),
  hosting: () => !!host(),

  /**
   * A FRESH INVITATION CLEARS THE LAST ONE'S EPITAPH. "The host closed the
   * table" is true and worth saying — right up until the host opens another
   * one, at which point it is a sign on an open door saying CLOSED. The
   * comparison is against THIS table's last frame rather than against the one
   * slot everything used to share.
   */
  clearStaleNotice: (frame, known) => {
    if (notice && (!known || known.frame.packId !== frame.packId
      || !known.frame.started !== !frame.started)) {
      notice = '';
    }
  },
  setNotice: (text) => setNotice(text),

  /**
   * WHAT IS IN EARSHOT CHANGED. One callback, because after `moveFocus` there
   * is almost nothing left for the four this replaced to do differently — the
   * thing that made them four was that each carried its own copy of "and where
   * should the panel look now".
   */
  onChange: (change) => {
    moveFocus(change);
    if (change.kind !== 'sighted') {
      // A TABLE THAT WENT AWAY. `closed` arrives on its own and has to repaint;
      // `hosts-gone` and `superseded` arrive inside something that is about to
      // — `pruneDead`'s caller and the sighting being filed in the same breath —
      // and repainting here would be one wasted pass per lobby frame.
      if (change.kind === 'closed') refreshEntry();
      return;
    }
    rememberPackName(change.frame.packId);
    // BECOME A CLIENT AS SOON AS WE ARE INVITED, rather than on a button.
    // Loading the pack is the only thing "Join" ever did, and making it a
    // separate tap meant the seat buttons were dead until you found it — two
    // decisions where there is only one, and the second one is the seat. Only
    // for the table we are looking at: auto-loading a pack for every table in
    // earshot would be a fetch per host, for felts nobody asked to see.
    //
    // NOT FOR A FRAME OUR OWN CLIENT HANDED OVER: being a client is what
    // brought that one here, so there is nothing to join.
    if (change.provenance === 'wire' && !host() && activeKey === change.entry.key) {
      joinTable(change.entry).catch(reportFailure);
    }
    refreshEntry();
  },
});

// The directory, read wherever a table has to be counted, named or drawn. Every
// WRITE to it is in tableSightings.js — bar our own table's, which goes through
// `publishOwnTable` below and is a sighting like any other.
const tables = sightings.tables;

/**
 * Point the panel wherever `nextFocus` says (src/ui/partyFocus.js).
 *
 * THE RULE IS PURE AND LIVES THERE; this is the two lines that read the state
 * it needs and write the one variable it answers about. Splitting it that way
 * is what finally let the transitions be tested: `activeKey` is a module-scoped
 * `let` in a file no Node test can import.
 */
function moveFocus(change) {
  activeKey = nextFocus(change, {
    focusedKey: activeKey,
    // ATTACHED, not "have we a session": hosting our own table and sitting at
    // somebody else's are the same answer to "is this device already at a
    // table it should not be dragged off".
    attached: !!host() || !!client(),
    joining,
    latestKey: tables.latest()?.key ?? null,
    knows: (key) => tables.has(key),
  });
}

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
 * What we believe, in one answer
 *
 * `partyModel()` (src/ui/partyModel.js) merges the five stores this module used
 * to join at render time — the sighting directory, the session registry, the
 * seat stubs, the per-session `unreachable` sets, and the transport roster —
 * into one ordered account of every table. Surfaces render what it says.
 *
 * ASSEMBLED FRESH PER READ, not cached, and for the same reason `ourTable()` is
 * a function rather than a binding: a cached belief is exactly how this file
 * came to hold five of them. It is a walk over a handful of tables and at most
 * six seats each — the cost of being certain is nothing here, and the cost of
 * being stale has a bug list.
 * ------------------------------------------------------------------ */

// WHAT WE LAST THOUGHT, so a downgrade has to hold before it is repeated
// (#78, src/ui/partyModel.js). Threaded through the model rather than kept by
// it: the model is pure, and a cache in there would be the fifth store #75
// spent four stages removing. This is the one variable that half of one.
let beliefs = emptyBeliefs();
/** The pending downgrade's own timer — see `armBeliefs`. */
let settling = null;

function model() {
  const built = partyModel({
    self: selfId(),
    myName: myName(),
    publishedName: publishedName(),
    peers: port?.peers() || [],
    // The cap, asked fresh — a launcher can gain it between two reads, and a
    // joiner seeing fellow members directly is the upgrade this branch waits
    // for (src/ui/partyModel.js).
    presence: (port?.caps() || []).includes('peer.presence') && Arcade.peer?.presence
      ? (Arcade.peer.presence() || [])
      : null,
    sightings: tables.all(),
    sessions: sessions.all(),
    stubs: seatStubs(),
    packNameOf: (packId) => packNames.get(packId) || null,
    focusedKey: activeKey,
    now: Date.now(),
    beliefs,
  });
  beliefs = built.beliefs;
  return built;
}

/**
 * ONE TIMER, FOR THE ONE MOMENT A HELD-BACK READING COMES DUE.
 *
 * A repaint is not a clock: nothing else would happen when a seat's four
 * seconds of probation elapse, so the chip would sit on its old value until
 * some unrelated event repainted. This arms exactly one wake-up for the
 * earliest pending change — and nothing at all when nothing is pending, which
 * is nearly always.
 *
 * THE SESSION CLOCK ON PURPOSE, unlike the shared table's bots (#71): this is
 * about what a screen is showing, and a screen nobody is looking at has nothing
 * to correct. It resumes with the remaining time when the frame does.
 */
function armBeliefs(at) {
  if (settling) { settling.cancel(); settling = null; }
  if (at === null || at === undefined) return;
  settling = Arcade.session.setTimeout(() => { settling = null; repaint(); },
    Math.max(0, at - Date.now()));
}

/** The pending prune's own timer — see `prune`. */
let pruning = null;

/**
 * Drop the tables whose hosts have gone, and come back for the ones still in
 * their grace.
 *
 * THE SAME SHAPE AS `armBeliefs`, and for the same reason: pruning runs on
 * roster changes, and a host going quiet produces exactly one of those. Without
 * a wake-up, a table spared through its grace would sit there until something
 * unrelated happened to ask again (#78).
 */
function prune() {
  const dueAt = sightings.pruneDead();
  if (pruning) { pruning.cancel(); pruning = null; }
  if (dueAt === null) return;
  pruning = Arcade.session.setTimeout(() => { pruning = null; prune(); repaint(); },
    Math.max(0, dueAt - Date.now()));
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

/**
 * The model's account of the table the PANEL is about, and of the one the FELT
 * is playing at.
 *
 * THE SUBJECT IS STILL CHOSEN THE OLD WAY — `shownFrame()` and `attached()` —
 * and only the ANSWER comes from the model. Collapsing the two focus pointers
 * is #75's stage 4; doing it here would have changed behaviour in the same
 * commit that changed where the facts come from, and then a regression would
 * have had two suspects.
 */
function shownView(views) {
  const frame = shownFrame();
  return frame ? views.find((view) => view.tableId === frame.tableId) || null : null;
}

function attachedView(views = model().tables) {
  const session = attached();
  // The lobby-frame guard is the strip's own: a session exists from the moment
  // it is opened, and there is nothing to draw until its host has published.
  if (!session?.lobbyFrame) return null;
  return views.find((view) => view.tableId === session.tableId) || null;
}

/** Is the panel looking at the table this device is hosting? */
function shownIsOurs() {
  const frame = shownFrame();
  return !!host() && !!frame && frame.hostDeviceId === selfId();
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
 *
 * WHICH TABLE, SAID OUT LOUD. There is no default here — see the note on
 * `ourLobbyFrame` for why the panel-facing callers write `ourTable()` at the
 * call site rather than letting this reach for it.
 */
function publishOwnTable(session) {
  if (!session?.host || !session.seats || !session.pack) return;
  const frame = ourLobbyFrame(session);
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
function nameForSeat(seat, session) {
  // THE SESSION IS PASSED IN because this is a host's `nameFor` seam: with two
  // hosted tables it is asked by both, and answering about whichever one the
  // panel happens to be showing would publish one table's names in the other's
  // roster.
  //
  // The felt is still the right answer for the second half: the fallback is a
  // JOINER, whose only seat table is the one the felt built from the view it is
  // showing. Deliberate, and one of the three reads left after the #64 sweep.
  //
  // WHICH IS WHY THIS ONE ASKS OUT LOUD, and it is the only function in the
  // sweep that does. Everywhere else a forgotten session is now inert — the
  // function no-ops on a table nobody named, which is wrong but harmless.
  // Here the fallback would quietly catch it and answer off the FELT, so the
  // mistake would look exactly like the joiner path working. `null` is the
  // joiner saying "I have no session"; `undefined` is a caller who forgot.
  if (session === undefined) {
    throw new TypeError('nameForSeat needs the session whose seat this is — '
      + 'pass null only for the joiner path that reads the felt (#73)');
  }
  const owner = (session?.seats || tableContext()?.seats)?.ownerOf(seat);
  if (!owner || owner.kind === 'empty') return '';
  // The felt's own name for this bot when there is a felt, so the roster a
  // joiner receives says what the host is actually looking at. Before the deal
  // there is no felt and the shared derivation is the only answer either of us
  // has — which is fine, because it is the answer we will both keep.
  // THE SESSION'S SEATING, NOT THE FELT'S. This name goes out in the roster
  // every joiner draws from, so reading it off the felt meant a host who
  // navigated to the lobby republished DIFFERENT bot names — the felt's while
  // it was on screen, the shared derivation once it was not.
  if (owner.kind === 'bot') return session?.seating?.[seat]?.name || derivedBotName(seat, session);
  return peerName(owner.deviceId);
}

/** The bot a seat gets before anybody has dealt — same input on every device. */
function derivedBotName(seat, session) {
  // `hostSeats()` only for the sessionless call — `nameForSeat`'s joiner path,
  // which has no seat table of its own. Left exactly as it was rather than
  // swept with the defaults above: it is reached with `session` null, where
  // there is no other table to be confused with.
  const table = session?.seats || hostSeats();
  if (!table) return botById(null).name;
  const botSeats = [];
  for (let s = 0; s < table.count; s++) if (table.isBot(s) || table.isEmpty(s)) botSeats.push(s);
  const ids = pickBotIds(selfId() || 'party', botSeats.length);
  return botById(ids[botSeats.indexOf(seat)]).name;
}

/**
 * Everybody at a SHARED table, indexed by seat.
 *
 * THE MODEL'S DERIVATION, reused rather than repeated (#75). This is the shape
 * the FELT wants — `adoptSharedView` and `setSeating` take it — so it stays
 * callable here, but the rules behind it (a joiner has no seed; bot faces come
 * from the host device id; a host defers to its own seating) live in one place
 * and the seat grid and this path cannot drift apart.
 */
function seatingFromRoster(frame) {
  return seatingOf(frame, {
    self: selfId(),
    myName: myName(),
    publishedName: publishedName(),
    peers: port?.peers() || [],
    // ONLY FOR OUR OWN TABLE — a host looking at a neighbour's roster derives
    // like any other joiner, or our own bots' faces land on their chairs. The
    // bot faces and the roster authority are two answers now (#79): the felt's
    // seating may not exist yet, and the direct links do not wait for it.
    ownSeating: host() && frame?.hostDeviceId === selfId() ? ourTable()?.seating : null,
    trustOurRoster: !!host() && frame?.hostDeviceId === selfId(),
  });
}

/* ------------------------------------------------------------------ *
 * Presence
 *
 * The chips' vocabulary. HOW a seat's presence is decided — the asymmetry
 * between our own table and somebody else's — moved to src/ui/partyModel.js
 * with its reasoning (#75); this is only what the words are.
 * ------------------------------------------------------------------ */

const CHIP_TEXT = {
  connected: '',
  interrupted: 'reconnecting…',
  gone: 'left',
  bot: 'bot',
  empty: 'open',
};

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
function renderSeats(view) {
  if (!el.seats) return;
  el.seats.replaceChildren();
  if (!view) return;
  const me = selfId();
  // WHOSE SEATS THESE ARE decides what may be done to them, and it is no longer
  // answerable from `host` alone: a host looking at a neighbour's table is
  // still a host, and offering it the bot/open toggles would have applied our
  // own seat table to their chairs.
  const ours = view.relation === 'hosting';
  // RESOLVED ONCE, HERE, and handed to every button this row grows. The panel's
  // subject is a moving target — a sighting can land, and `removeSeat` awaits a
  // confirm dialog — so a button that asked "which table?" when it was tapped
  // could act on a different one than the seats it was drawn beside.
  const session = ours ? sessions.get(view.tableId) : null;

  for (const identity of view.seats) {
    const seat = identity.seat;
    const entry = identity;
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

    row.append(chip(identity.presence));
    // THIS TABLE'S FAILED SENDS. It read `ourTable()`'s set, so a host browsing
    // a neighbour's seats saw its OWN unreachable marks on their chairs.
    if (identity.unreachable) {
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
        actions.append(button('Remove', () => { removeSeat(seat, session).catch(reportFailure); }));
      } else if (entry.kind !== 'device') {
        actions.append(entry.kind === 'bot'
          ? button('Open', () => { session.seats.release(seat); afterSeatChange(session); })
          : button('Bot', () => { session.seats.seatBot(seat); afterSeatChange(session); }));
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
function secondsLeft(expiresAt) {
  if (expiresAt === null || expiresAt === undefined) return null;
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
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
  // THE TABLE WE ARE PLAYING AT, whose deadlines the model reads from our own
  // timer when we host and from the view our host sent when we do not.
  const live = (attachedView()?.seats || []).some((seat) => seat.deadlineAt !== null);
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
function renderStrip(view = attachedView()) {
  if (!el.strip) return;
  if (!view) {
    el.strip.hidden = true;
    el.strip.replaceChildren();
    return;
  }
  el.strip.replaceChildren();
  for (const identity of view.seats) {
    if (identity.presence === 'bot' || identity.presence === 'empty') continue;
    const pill = document.createElement('span');
    pill.className = 'party-strip__seat';
    const name = document.createElement('span');
    name.textContent = identity.shortName;
    pill.append(name, chip(identity.presence));
    // Only on the seat actually being waited on, and only once it is worth
    // saying: a number that is always there is furniture, and a table where
    // everybody is always on a visible clock feels like an exam.
    const left = secondsLeft(identity.deadlineAt);
    if (left !== null && left <= 20) {
      const clock = document.createElement('span');
      clock.className = 'party-strip__clock';
      clock.textContent = `0:${String(left).padStart(2, '0')}`;
      pill.append(clock);
    }
    if (identity.unreachable) pill.classList.add('party-strip__seat--unreachable');
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
    .then((manifest) => { packNames.set(packId, manifest?.name || packId); repaint(); })
    .catch(() => { packNames.set(packId, packId); });
}

/**
 * THE TWO THINGS THIS MODULE DRAWS ON THE LOBBY, always together.
 *
 * They are one fact — what tables exist — shown twice: as a row of their own,
 * and as a ribbon on the game each is playing. Drawing them from separate call
 * sites is how the row kept a tile for a host who had left the party while the
 * ribbon for the same table had already, correctly, gone.
 *
 * ONE MODEL, PASSED TO BOTH (#75), which is what makes "always together" a
 * property of the code rather than a promise in a comment: the two surfaces
 * cannot disagree about a table because they are handed the same account of it.
 */
function renderLobby(views = model().tables) {
  decorateTiles(views);
  renderTablesRow(views);
}

/**
 * THE HEADER DOOR, AND THE TILES' OWN DOORS.
 *
 * Three reasons it can be closed and only one is worth a sentence: standalone
 * play offers nothing (there is no party to join and saying so would be noise),
 * an old launcher gets one specific notice, and a live party gets the button.
 *
 * DRAWING ONLY. Starting the sniffer, pruning dead tables and asking about
 * drops used to happen in the middle of this — three side effects wearing a
 * renderer's name, which is why "just repaint" was never a thing this file
 * could do. They live in `refreshEntry` below now.
 */
function renderEntry(views) {
  const gate = availability();
  if (gate.reason === 'standalone' || gate.reason === 'no-peer-api') {
    if (el.entry) el.entry.hidden = true;
    for (const node of document.querySelectorAll('.tile__together')) node.hidden = true;
    // A LAUNCHER CAN GO AWAY. Leaving the row up after the party surface has
    // gone would leave tiles pointing at tables nothing can reach.
    if (el.tablesRow) el.tablesRow.hidden = true;
    return;
  }
  if (!gate.available) {
    if (!el.entry) return;
    el.entry.hidden = false;
    el.entry.textContent = 'Launcher update required';
    el.entry.disabled = true;
    return;
  }
  // THE HEADER BUTTON IS THE JOINER'S DOOR AND ONLY THE JOINER'S. Hosting is
  // offered on the game tiles, because a host picks a game first; there is
  // nothing for this button to mean until somebody else has picked one.
  // The tiles' own doors, toggled in place: a party can form while the player
  // is sitting on the lobby, and the tiles were built before it did.
  for (const node of document.querySelectorAll('.tile__together')) node.hidden = false;
  if (!el.entry) return;
  const invited = views.some((view) => view.liveness === 'live') || !!client() || !!host();
  el.entry.hidden = !invited;
  el.entry.disabled = false;
  el.entry.textContent = host() ? 'Your party' : (client() ? 'Your table' : 'Join the table');
}

/**
 * EVERY PARTY SURFACE, FROM ONE MODEL, ONCE (#75 stage 2).
 *
 * This file used to ask each caller to remember which renderers its change
 * touched, and there were about twenty of them holding four in varying
 * combinations — `renderScreen`, `refreshEntry`, `renderStrip`, `rerenderTable`.
 * Whether a changed fact reached the surface that draws it depended on the
 * discipline of one handler, and the ones that got it wrong are in this file's
 * history: a tile reading "waiting to deal" over a hand mid-trick, "Deal"
 * offered at a table dealt an hour ago.
 *
 * So handlers mutate and then say `repaint()`. There is nothing to remember.
 *
 * NO DISPATCH FRAMEWORK, deliberately. This is vanilla DOM over a handful of
 * tables and at most six seats each; `replaceChildren` on that is cheaper than
 * the bookkeeping any framework would want in exchange.
 *
 * ONE DELIBERATE EXCEPTION, AND IT IS NAMED: `renderStrip` on its own. The
 * countdown ticks once a second and a published move re-arms it, and the strip
 * is the only surface either touches. Repainting the tile row and the seat grid
 * at 1 Hz to move a clock would be a real cost for no change — so the deadline
 * path calls the one renderer it needs, and every belief change calls this.
 */
function repaint() {
  const built = model();
  const views = built.tables;
  renderEntry(views);
  renderLobby(views);
  renderPanel(views);
  renderStrip(attachedView(views));
  armBeliefs(built.beliefs.nextChangeAt);
}

function renderPanel(views) {
  if (!el.screen) return;
  const shown = shownView(views);
  if (el.heading) el.heading.textContent = panelHeading(shown);
  if (el.note) el.note.textContent = notice;
  if (el.note) el.note.hidden = !notice;

  if (el.summary) {
    // A JOINER HAS NOT LOADED THE PACK YET — deciding whether to join is the
    // whole point of this screen — so the slug is all the frame carries. The
    // manifest is one small JSON and the lobby reads it for every tile anyway,
    // so "crazy-eights" becomes "Crazy Eights" before anybody has to read it.
    // The model already prefers the cached manifest name and falls back to the
    // slug, so this is one field now rather than a chain of four.
    //
    // ONLY THE TABLE ON SCREEN gets to name itself. The loaded packs — ours and
    // the one we joined — answer for their own table and nobody else's, so a
    // neighbour's tile no longer inherits our game's name.
    const isOurs = !activeTable() || shownIsOurs()
      || shown?.hostDeviceId === client()?.hostDeviceId();
    // The felt on purpose: this names the pack the SCREEN is showing, which is
    // the question being asked. Left as-is by the #64 sweep.
    const packName = (isOurs && (joinedPack()?.manifest?.name || tableContext()?.pack?.manifest?.name))
      || shown?.packName || '';
    const variants = shown?.variants || [];
    // THE HOST'S RULE, NOT OURS. A joiner used to have no way of knowing how
    // long a turn was until one ran out — the number was a constant in its own
    // build, which was only ever right by coincidence. Now the frame says, and
    // the model carries it per table.
    const turn = `${graceLabel(shown?.ours === false ? shown.graceMs : graceOf(ourTable()))} a turn`;
    const parts = [packName, variants.length ? variants.join(', ') : '', turn].filter(Boolean);
    el.summary.textContent = packName ? parts.join(' · ') : '';
  }

  renderSeats(shown);
  renderActions();
  renderEmotes();
}


/**
 * How long a seat gets, chosen before the cards are out.
 *
 * BEFORE THE DEAL ONLY. Changing the grace mid-hand would move a deadline
 * somebody is already playing against — the honest version of that is a
 * different feature, and this one is about setting the table.
 *
 * The choice is published in the lobby frame the moment it changes, so a joiner
 * looking at the seats sees the new answer without being dealt into anything.
 */
function graceChooser() {
  const session = ourTable();
  const wrap = document.createElement('div');
  wrap.className = 'party-grace';

  const label = document.createElement('span');
  label.className = 'party-grace__label';
  label.textContent = 'Give each turn';
  wrap.append(label);

  const current = graceOf(session);
  for (const choice of GRACE_CHOICES) {
    const picked = choice.ms === current;
    const option = button(choice.label, () => {
      if (!session) return;
      session.graceMs = choice.ms;
      // Everybody who can see this table is told at once; the timer reads it at
      // arm time, so nothing has to be rebuilt.
      session.lobbyFrame = ourLobbyFrame(session);
      publishOwnTable(session);
      session.host?.broadcastLobby();
      repaint();
    }, { className: `party-grace__option${picked ? ' party-grace__option--on' : ''}` });
    option.setAttribute('aria-pressed', picked ? 'true' : 'false');
    option.title = choice.hint;
    wrap.append(option);
  }
  return wrap;
}


/**
 * Go back to our own table.
 *
 * THE DOOR THAT WAS MISSING. Before the session inversion, leaving the felt
 * ended the party, so "return to it" was not a thing that could be asked. Since
 * #48 a hosted game keeps running while the player is elsewhere — and until
 * now the only button the panel offered them was "Stop hosting", which is the
 * one thing they did not want. A table you cannot get back into is not much
 * better than one that ended.
 *
 * A rebind, like `switchToSeat`: the state has been on the session the whole
 * time, so nothing is dealt and nothing is fetched but the pack.
 */
async function returnToOurTable() {
  const session = ourTable();
  if (!session?.state) return false;
  await resumeHostedTable({
    packId: session.pack.packId,
    variants: session.pack.variants,
    state: session.state,
    seats: session.seats,
    seating: session.seating || seatingFromRoster(ourLobbyFrame(session)),
  });
  bindFelt(session.tableId);
  // The felt drives the bots again, so the headless driver must let go.
  session.cancelBots();
  goToTable();
  hidePartyScreen();
  repaint();
  return true;
}

/**
 * What the panel calls itself.
 *
 * The party label was the whole answer when the panel could only ever be about
 * one table. It still names the ROOM, which is worth saying — but with a tile
 * row it is possible to be looking at a table that is not ours, and "Your
 * party" over somebody else's seats is simply wrong.
 */
function panelHeading(view) {
  if (!view) return partyLabel();
  return view.ours ? 'Your party' : `${view.hostName}'s table`;
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
    //
    // ASKED OF THE SESSION, not the felt. `tableContext()` is null whenever the
    // felt is showing something else, so this offered "Deal" at a table that
    // had been dealt an hour ago and was still running in the background.
    if (!ourTable()?.state) {
      el.actions.append(graceChooser());
      el.actions.append(button('Deal', () => { dealParty().catch(reportFailure); },
        { className: '' }));
    } else if (!ourTable().bound) {
      // OUR OWN GAME, RUNNING, AND NOT ON SCREEN. Without this the panel's only
      // offer was "Stop hosting" — which ends the very thing the player came
      // here to get back to.
      el.actions.append(button('Back to the table',
        () => { returnToOurTable().catch(reportFailure); }, { className: '' }));
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
 *
 * ONE LIST NOW (#75). This drew from a hand-rolled union of `tables.all()` and
 * the seat stubs — the join that let the row keep a tile for a host the ribbon
 * had already, correctly, dropped. The model does the merge, so a dormant table
 * is not a second code path here; it is a `liveness` of 'offline'.
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
function dormantTile(view) {
  const tile = document.createElement('div');
  tile.className = 'table-tile table-tile--dormant';
  tile.dataset.tableKey = view.tableId;

  const who = document.createElement('span');
  who.className = 'table-tile__who';
  // textContent, always — a name somebody else typed, read back from storage,
  // which is if anything a better reason to be careful rather than a worse one.
  who.textContent = view.hostName ? `Your seat at ${view.hostName}'s table` : 'Your seat';
  tile.append(who);

  const game = document.createElement('span');
  game.className = 'table-tile__game';
  game.textContent = view.packName;
  tile.append(game);

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

/** "waiting to deal · 2 seats open", or "in progress · table full". */
function tableState(view) {
  const open = view.openSeats;
  return `${view.stage} · ${open === 0 ? 'table full' : `${open} ${open === 1 ? 'seat' : 'seats'} open`}`;
}

function liveTile(view) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = `table-tile${view.ours ? ' table-tile--mine' : ''}`;
  tile.dataset.tableKey = view.tableId;

  const who = document.createElement('span');
  who.className = 'table-tile__who';
  // textContent, always — this is a name somebody else typed. The file
  // header's rule is not relaxed because the element is new.
  who.textContent = view.ours ? 'Your party' : `${view.hostName}'s table`;
  tile.append(who);

  const game = document.createElement('span');
  game.className = 'table-tile__game';
  game.textContent = view.packName;
  tile.append(game);

  const state = document.createElement('span');
  state.className = 'table-tile__state';
  state.textContent = tableState(view);
  tile.append(state);

  // YOUR SEAT, AT SOMEBODY ELSE'S TABLE. On your own it says nothing — of
  // course you have a seat at the table you dealt — and a badge that is
  // always there stops being read at all, including on the tile where it is
  // the entire reason to come back.
  const seat = view.ours ? null : view.mySeat;
  if (seat !== null) {
    const badge = document.createElement('span');
    badge.className = 'table-tile__seat';
    badge.textContent = 'Your seat';
    tile.append(badge);
  }

  // A SEAT WE ALREADY HOLD IS A GAME, NOT A LOBBY. Tapping it takes us to the
  // felt rather than to the panel — the panel is for deciding where to sit,
  // and that decision was made. Any other tile still opens the seats.
  const held = seat !== null && view.seatedHere;
  // OUR OWN RUNNING TABLE IS ALSO A GAME TO GO BACK TO, not a lobby to open.
  // A host's session has no client, so the `held` test above cannot see it.
  const oursAndRunning = view.ours && view.hasState && !view.bound;
  tile.setAttribute('aria-label',
    `${who.textContent}, ${game.textContent}. ${state.textContent}.${seat !== null ? ' You hold a seat.' : ''}`);
  tile.addEventListener('click', () => {
    if (held && switchToSeat(view.tableId)) return;
    if (oursAndRunning) { returnToOurTable().catch(reportFailure); return; }
    showPartyScreen(view.tableId);
  });
  return tile;
}

function renderTablesRow(views) {
  if (!el.tablesRow || !el.tablesGrid) return;
  el.tablesRow.hidden = views.length === 0;
  el.tablesGrid.replaceChildren();
  if (!views.length) return;
  for (const view of views) {
    rememberPackName(view.packId);
    el.tablesGrid.append(view.liveness === 'offline' ? dormantTile(view) : liveTile(view));
  }
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
  else if (host()) host().emote(index);
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
  repaint();
}

function reportFailure(err) {
  console.error(err);
  setNotice(`Could not join that table: ${err.message}`);
}

/**
 * The three error surfaces §10 asks for, each said in its own words.
 *
 * THE SESSION THE ERROR CAME FROM, passed by both roles' hooks. A send that
 * failed at one table says nothing about the seats at another, and defaulting
 * to the focused one meant a joiner's failure marked a HOSTED seat unreachable.
 */
function surfaceError(detail, session) {
  if (!session) return;
  if (detail?.kind === 'send-failed' && Number.isInteger(detail.seat)) {
    session.unreachable.add(detail.seat);
    repaint();
    return;
  }
  if (detail?.kind === 'send-failed' && detail.deviceId) {
    // The seat table of the host this error came FROM — it arrives whether or
    // not the felt is showing that table, and with two of them the focused one
    // is not necessarily the one that failed to send.
    for (const seat of session?.seats?.seatsOfDevice(detail.deviceId) || []) {
      session?.unreachable?.add(seat);
    }
    repaint();
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
function refreshSeats(session) {
  // THE SESSION IS PASSED IN by every caller, because each host must refresh
  // ITS OWN roster: with two hosted tables, answering about whichever one the
  // panel is showing would republish one table's seats as the other's.
  if (session) session.lobbyFrame = ourLobbyFrame(session);
  if (lobbyFrame()) {
    const seating = seatingFromRoster(lobbyFrame());
    if (session) session.seating = seating;
    setSeating(seating);
  }
  // Our own tile says what our own roster says, and it changed.
  publishOwnTable(session);
  rerenderTable();
  repaint();
}

/** A seat WE changed: refresh, then tell everybody. */
function afterSeatChange(session) {
  session?.host?.broadcastLobby();
  refreshSeats(session);
}

/**
 * The roster WE publish, read back so one renderer draws both roles.
 *
 * NO IMPLICIT SUBJECT — and this is the shape the whole file follows now. A
 * `session = ourTable()` default compiles at every call site, including the
 * ones that meant a specific table, and answers about whichever table the
 * panel happens to be pointed at. That is the bug the two-table work shipped
 * three times (#64, #69, `takeTurn` in #58): a question about one table
 * answered about another. A caller that genuinely means "the table on screen"
 * writes `ourTable()` here, where the choice is visible.
 */
function ourLobbyFrame(session) {
  if (!session?.host || !session.seats) return null;
  const seats = [];
  for (let seat = 0; seat < session.seats.count; seat++) {
    const owner = session.seats.ownerOf(seat);
    seats.push({
      seat,
      kind: owner.kind,
      deviceId: owner.deviceId ?? undefined,
      name: nameForSeat(seat, session),
      status: session.host.seatStatusFor(seat),
    });
  }
  return {
    // The same id the host module stamps on the frames it publishes, so the
    // tile we draw from this and the tile a joiner draws from the wire are the
    // same table rather than two that merely look alike.
    tableId: session.tableId,
    packId: session.pack.packId,
    variants: session.pack.variants,
    hostDeviceId: selfId(),
    seatCount: session.seats.count,
    seats,
    // The grace travels so a joiner's countdown is honest — see plan §7.
    graceMs: graceOf(session),
    // FALSE UNTIL THE CARDS ARE OUT, and a joiner reads it: before the deal it
    // is waiting for the host, after it there is a hand to be caught up with.
    //
    // ASKED OF THE SESSION. `tableContext()` is null whenever the felt shows
    // something else, so a host who backgrounded a live game had their own tile
    // reading "waiting to deal" while the hand was mid-trick. The frame that
    // goes on the WIRE was always right — `host.js` asks `liveState()` — so
    // this was the local copy and the published one disagreeing.
    started: !!session.state,
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
    // BOUND TO THIS SESSION. `host.js` calls `nameFor(seat)` with a seat and
    // nothing else, so handing it the bare function was the implicit default at
    // its most expensive: two hosted tables, and each published the other's
    // names whenever the panel was pointed at the other one.
    nameFor: (seat) => nameForSeat(seat, session),
    deadlines: () => session.timer?.deadlines() || [],
    graceMs: () => graceOf(session),
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
      onSeatsChanged: () => refreshSeats(session),
      onEmote: ({ emote }) => burst(emote),
      onError: (detail) => surfaceError(detail, session),
      onBye: () => refreshSeats(session),
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
    // Resolved at arm time, so changing it before the deal takes effect
    // without rebuilding the timer.
    timeoutMs: () => graceOf(session),
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
  // EACH TABLE WATCHES THE ROSTER FOR ITSELF. This lived in `hostGame`, so a
  // table restored at boot never subscribed at all — its drops went unnoticed
  // until something else happened to ask. Here, both doors get it.
  session.unsubscribePeers = port.onPeersChange(() => {
    refreshSeats(session);
    checkForDrops(session);
  });
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
  // OUR OWN TABLE OF THIS GAME is already open; this is the door back to it.
  // It used to be `if (host())` — any hosted table at all — which was the one
  // thing actually stopping a second pack being hosted. The registry's rule was
  // already per-pack underneath it; this guard was answering a broader question
  // than the model ever asked.
  const ours = sessions.hostedForPack(packId);
  if (ours) {
    moveFocus({ kind: 'chosen', key: ours.tableId });
    showPartyScreen();
    return false;
  }
  // SOMEBODY IS ALREADY PLAYING THIS ONE. The tile's button is one door with
  // two meanings, and which it means is not the player's to work out: with a
  // live table on this pack, tapping it takes you to that table rather than
  // starting a rival one nobody can see.
  const existing = tables.forPack(packId)[0];
  if (existing) {
    moveFocus({ kind: 'chosen', key: existing.key });
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
  session.lobbyFrame = ourLobbyFrame(session);
  // Our table takes its place among the others, and the panel points at it —
  // by its own name now, not by the device's.
  publishOwnTable(session);
  moveFocus({ kind: 'chosen', key: session.tableId });
  refreshPartyLabel().then(repaint);
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
  // KEPT HERE TOO, not only handed to the felt. Who is in each chair is a fact
  // about the table, and reading it back off `tableContext()` meant it vanished
  // the moment the felt showed something else — see the notes at each of the
  // sites this fixes.
  session.seating = seatingFromRoster(ourLobbyFrame(session));
  session.state = await dealHostedTable({
    packId: session.pack.packId,
    variants: session.pack.variants,
    seats: session.seats,
    seating: session.seating,
  });
  // THE FELT IS NOW SHOWING THIS ONE. Binding is about attention, not lifetime
  // — see src/match/tableSession.js. It is what tells a later background table
  // apart from the one in front of the player.
  bindFelt(session.tableId);
  session.host.broadcastLobby();
  session.host.publish([]);
  hidePartyScreen();
  refreshSeats(session);
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
    else saveHostMatch(session.tableId, session.state, session.seats, { graceMs: session.graceMs });
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
  if (restored) refreshEntry();
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
  // Restored before the first lobby frame goes out, so the grace the party
  // reconvenes on is the one they were playing with.
  if (Number.isInteger(snapshot.graceMs)) session.graceMs = snapshot.graceMs;
  session.seating = seatingFromRoster(ourLobbyFrame(session));
  session.lobbyFrame = ourLobbyFrame(session);
  publishOwnTable(session);
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
      || { seat, name: nameForSeat(seat, session) || `Seat ${seat}`, icon: '', color: '#6b7280', isBot: true },
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
function armTimer(session) {
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
  session.host.sendBye('closed');
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
  // Closing our table puts us back in the room, looking at whatever else is in
  // it — which for the host who was never told about the neighbours' tables
  // used to be nothing at all.
  moveFocus({ kind: 'stopped-hosting' });
  repaint();
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
async function removeSeat(seat, session) {
  // THE TABLE THE SEAT WAS DRAWN FOR, held across the await. This asks a
  // question and waits for an answer, and the panel can be pointed somewhere
  // else by the time one comes back — re-reading the subject afterwards would
  // bot a seat at whichever table the player had wandered to.
  if (!session?.host || !session.seats) return;
  const who = nameForSeat(seat, session) || `Seat ${seat + 1}`;
  const ok = await confirmAction(`Remove ${who} from the table? A bot takes over their hand.`,
    { okLabel: 'Remove them', cancelLabel: 'Keep them' });
  if (!ok) return;
  const owner = session.seats.ownerOf(seat);
  if (owner.kind === 'device' && owner.deviceId) {
    session.host.sendBye('replaced', { to: owner.deviceId });
  }
  session.seats.seatBot(seat);
  afterSeatChange(session);
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
function checkForDrops(session) {
  if (!session?.host || !session.seats) return;
  // OUR TABLE, NOT THE ONE ON SCREEN. Read from the felt, this returned early
  // for a backgrounded hosted table — so a player dropping out of a game the
  // host was not looking at was never noticed, and the seat was never offered
  // to a bot.
  for (let seat = 0; seat < session.seats.count; seat++) {
    if (!needsHostDecision(session.host.seatStatusFor(seat))) { session.decided.delete(seat); continue; }
    if (session.decided.has(seat)) continue;
    session.decided.add(seat);
    askAboutSeat(seat, session);
    return; // one at a time; the next is asked after this is answered
  }
}

function askAboutSeat(seat, session) {
  if (!el.decision) return;
  const who = nameForSeat(seat, session) || `Seat ${seat + 1}`;
  el.decisionText.textContent = `${who} has left the table.`;
  el.decision.hidden = false;

  const answer = (choice) => {
    el.decision.hidden = true;
    if (choice === 'bot') {
      // THE BINDING IS REPLACED, not merely covered: the seat is a bot now, and
      // the departed player rejoining takes a free seat rather than this one.
      session?.seats?.seatBot(seat);
      setTablePaused(false);
      afterSeatChange(session);
    } else if (choice === 'pause') {
      setTablePaused(true);
      setNotice(`Paused — waiting for ${who}.`);
      afterSeatChange(session);
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
  if (!entry || joining) return;
  // ALREADY AT THIS ONE. The guard used to be `client()` — any client at all —
  // which was right while there could be one and is now the thing that stopped
  // a second seat existing.
  if (sessions.get(entry.key)) return;
  // THE DOOR, per pack (plan §1). Sitting at Dana's Hearts is a reason to
  // refuse Bo's Hearts and no reason at all to refuse Bo's Crazy Eights.
  const refusal = sessions.refusalToSit(entry.packId, { nameOf: packName });
  if (refusal) { setNotice(refusal); return; }
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
        // OUR HOST'S FRAMES ARE SIGHTINGS TOO, and they go through the same
        // intake as the ones off the wire (#75 stage 3). This used to file the
        // sighting and write the seat stub and stop there — no stub ageing, no
        // superseded table retired — which was invisible only because the
        // sniffer usually saw the same frame and did the rest.
        session.lobbyFrame = next;
        sightings.noteLobby(next, { provenance: 'client' });
        repaint();
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
      // OUR SEAT'S TABLE, not the panel's. Handed the bare function, this
      // marked a seat unreachable on whatever table `ourTable()` answered with
      // — which on a device that also hosts is somebody else's game entirely.
      onError: (detail) => surfaceError(detail, session),
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
  refreshPartyLabel().then(repaint);
  repaint();
}


/**
 * Show a table we already hold a seat at.
 *
 * A REBIND, NOT A REJOIN — which is the dividend of T3's inversion. The session
 * never stopped existing while we were looking elsewhere: it kept its client,
 * its lobby frame and the last ViewState the host sent. So this draws that view
 * immediately, with no round trip and no blank felt, and only then asks for a
 * fresh one.
 *
 * `snapshot-req` rather than trusting what we have: the view is as old as the
 * last frame that reached us, and everything after it happened while we were
 * not watching. The stale view is what the player sees for the ~one frame it
 * takes to be replaced, and seeing the hand they left is much better than
 * seeing nothing.
 */
function switchToSeat(tableId) {
  const session = sessions.get(tableId);
  if (!session || session.hosting() || !session.client) return false;

  moveFocus({ kind: 'chosen', key: tableId });
  bindFelt(tableId);

  if (session.state && session.pack) {
    adoptSharedView({
      view: session.state,
      pack: session.pack,
      seating: seatingFromRoster(session.lobbyFrame),
      client: session.client,
      message: '',
    });
    goToTable();
  }
  // Freshen. The answer arrives through the ordinary onView path, which
  // re-adopts and repaints — the same door a late joiner's snapshot comes in.
  session.client.requestSnapshot();
  hidePartyScreen();
  repaint();
  return true;
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
  // BY TABLE, NOT BY HOST. This compared `hostDeviceId`, which was the same
  // question while one device could run one table and is the wrong one now:
  // Bo's Hearts and Bo's Crazy Eights are two tables and a client of the first
  // is not a client of the second.
  const existing = sessions.get(entry.key);
  if (existing && !existing.hosting()) return true;
  // The per-pack door does the refusing now, out loud and with a sentence.
  // A speculative client at ANOTHER pack is left exactly where it is — one
  // felt was never a reason to give up a chair.
  await joinTable(entry);
  return !!sessions.get(entry.key);
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
  repaint();
}

/* ------------------------------------------------------------------ *
 * What the LOBBY TILE should say about a pack
 *
 * A game tile answers "what is happening in Hearts", and for a while it
 * answered it from the solo save alone — which was wrong twice over once a
 * party table could outlive the felt: it said "not played yet" for a hand three
 * people were sitting at, and its Resume/Start over acted on a private copy.
 *
 * ONLY A LIVE TABLE TAKES THE TILE OVER. A seat whose host has gone quiet stays
 * in the Tables row, where "offline" is already said properly and where a
 * control that cannot work is already drawn as not a control.
 * ------------------------------------------------------------------ */

export function partyStateForPack(packId) {
  // THE MODEL ANSWERS IT, including the "is anybody there" test that used to be
  // a `tables.has` beside a registry lookup — two stores consulted to decide one
  // thing. `liveness` is that test, derived once (src/ui/partyModel.js).
  return packState(model(), packId);
}

/** The door the tile opens: back to our table, or across to our seat. */
export function enterPartyTable(tableId) {
  const session = sessions.get(tableId);
  if (!session) return false;
  if (session.hosting()) {
    returnToOurTable().catch(reportFailure);
    return true;
  }
  return switchToSeat(tableId);
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
  ensurePort();
  if (availability().available) {
    sightings.start();
    // Re-ask about the seats too. `onPeersChange` is the usual trigger, but a
    // player coming back to this screen deserves an answer that is current
    // rather than one that is waiting for the next transport event.
    //
    // THE TABLE ON SCREEN, deliberately and out loud. One at a time is the rule
    // `checkForDrops` itself keeps — the decision dialog is a single element and
    // asking about two tables at once would have the second overwrite the first
    // — and each hosted table's own `onPeersChange` covers the rest.
    checkForDrops(ourTable());
    prune();
  }
  repaint();
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
function decorateTiles(views) {
  // EVERY PACK WITH A TABLE ON IT, not the one pack the single slot happened to
  // hold. Two hosts in a party means two ribboned tiles, and the old code could
  // only ever draw one of them — the other game looked idle while somebody was
  // sitting at it.
  //
  // LIVE ONLY. A dormant seat belongs to the Tables row, where "offline" is
  // already said properly — a ribbon reading "waiting to deal" over a host who
  // is asleep would be the tile making a promise nothing can keep.
  const live = new Map();
  for (const view of views) {
    if (view.liveness !== 'live') continue;
    // OURS WINS THE TILE when two hosts happen to run the same pack: "Your
    // party" is the more useful of the two sentences to read on your own
    // screen, whichever of them we heard about first.
    if (live.has(view.packId) && !view.ours) continue;
    live.set(view.packId, view);
  }

  for (const tile of document.querySelectorAll('.tile[data-pack-id]')) {
    const slot = tile.querySelector('.tile__party');
    const door = tile.querySelector('.tile__together');
    const view = live.get(tile.dataset.packId) || null;
    if (slot) {
      slot.hidden = !view;
      slot.textContent = view ? partyRibbon(view) : '';
    }
    // The door's LABEL changes with its meaning. "Play together" starts a
    // table; on the game somebody is already at, the only useful verb is the
    // one that takes you there.
    if (door && !door.hidden) {
      door.textContent = view && !view.ours ? 'Take a seat' : 'Play together';
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
function partyRibbon(view) {
  if (!view) return 'Your party';
  const whose = view.ours ? 'Your party' : `${view.hostName}'s table`;
  // The same sentence the tile row says, from the same two fields — which is
  // the point of them being fields rather than two derivations.
  return `${whose} · ${tableState(view)}`;
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
  if (key) moveFocus({ kind: 'chosen', key });
  el.screen.hidden = false;
  refreshPartyLabel().then(repaint);
  repaint();
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
    port?.onStatus(() => refreshEntry());
    // `refreshEntry` prunes and repaints; it was three calls that had to agree.
    port?.onPeersChange(() => refreshEntry());
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
  const snapshot = model();
  return {
    role: partyRole(),
    notice,
    seq: host() ? host().seq() : (client() ? client().seq() : -1),
    seat: client() ? client().seat() : null,
    seats: (shownView(snapshot.tables)?.seats || [])
      .map((seat) => ({ seat: seat.seat, status: seat.presence })),
    unreachable: [...unreachable()],
    paused: notice.startsWith('Paused'),
    required: REQUIRED_CAPS,
    // WHAT ELSE IS IN THE ROOM. Every one of these is already drawn on a lobby
    // tile, so this stays inside the rule the rest of this snapshot follows —
    // it reports the visible truth and hands out no capability. It is also the
    // only way the three-launcher suite can assert that a second table exists
    // rather than inferring it from a button being enabled.
    tables: snapshot.tables
      // LIVE ONLY, as this always reported: a dormant seat is not a table in
      // earshot, and the suite reads this to count what is out there.
      .filter((view) => view.liveness === 'live')
      .map((view) => ({
        key: view.tableId, hostDeviceId: view.hostDeviceId, packId: view.packId,
        started: view.started, active: view.focused,
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
    const verdict = session.host.applyLocal(move);
    if (verdict?.legal) return move;
  }
  return null;
}

/** The host may enumerate, because the host has a state. A client may not. */
function legalFor(state, seat) {
  if (state.turn.seat !== seat) return null;
  return enumerateLegalMoves(state, seat)[0] || null;
}
