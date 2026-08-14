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
import { createTableClient } from '../match/client.js';
import { FRAME, EMOTES, validateFrame, isAuthentic } from '../match/protocol.js';
import { botById, initialsOf, pickBotIds } from '../players/roster.js';
import { fetchPack, fetchPackManifest } from './packSource.js';
import { confirmAction } from './confirm.js';
import {
  adoptSharedView, leaveSharedTable, tableContext, setSeating, dealHostedTable,
  setLocalMoveListener, afterRemoteMove, setTablePaused, rerenderTable,
} from './table.js';
import { createSeatTable } from '../players/seats.js';
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
let host = null;              // createTableHost, when we are hosting
// THE TABLE, BEFORE THERE IS A TABLE. A host builds the seating in the lobby
// and deals once, so these two outlive the moment of dealing: the same seat
// table object is handed to `dealHostedTable`, which means the host module and
// the felt are looking at one set of chairs rather than two that agree at first.
let hostSeats = null;
let hostPack = null;          // { packId, variants, name } chosen from the tile
let turnTimer = null;         // host-side only; a client renders, never decides
let tick = null;              // the countdown's own repaint
let client = null;            // createTableClient, when we are a joiner
let joinedPack = null;        // the pack a joiner loaded to match the host's
let lobbyFrame = null;        // the roster we are drawing: ours, or the host's
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
let decided = new Set();      // seats whose terminal drop the host has answered
let unreachable = new Set();  // seats a targeted send was refused for
let notice = '';              // the one error line the screen is showing
let goToTable = () => {};
let goToLobby = () => {};

const selfId = () => port?.self()?.deviceId || null;

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
  if (host) return 'host';
  if (client) return 'joiner';
  return 'idle';
}

/* ------------------------------------------------------------------ *
 * Which table we are looking at
 * ------------------------------------------------------------------ */

/** The sighted table the panel is currently about, or null. */
function activeTable() {
  return activeKey ? tables.get(activeKey) : null;
}

/**
 * Look at a table: point the panel at it and draw its roster.
 *
 * THIS IS THE WHOLE OF "SWITCHING" IN THIS STAGE, and it is deliberately not
 * the whole of joining. Focus is a question about what is on screen; being a
 * client is a question about which host we are exchanging frames with. Keeping
 * them separate is what lets a device see three tables while playing at one.
 */
function focusTable(key) {
  if (!key || !tables.has(key)) return false;
  activeKey = key;
  if (!host) lobbyFrame = tables.get(key).frame;
  return true;
}

/** Are we actually sitting down at the table we are a client of? */
function seatedHere() {
  return client ? client.seat() !== null && client.seat() !== undefined : false;
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
  const owner = (hostSeats || tableContext()?.seats)?.ownerOf(seat);
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
  const table = hostSeats;
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
  const own = host ? tableContext()?.seating : null;

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
    const fromRoster = host ? peerName(entry.deviceId) : entry.name;
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
function seatStatuses() {
  const out = new Map();
  const frame = lobbyFrame;
  if (host) {
    // `hostSeats` rather than the felt's: the host holds a seat table from the
    // moment it opens a party, and the whole point of the lobby-first flow is
    // that people are seated BEFORE there is a table to read seats off.
    for (let seat = 0; seat < (hostSeats?.count || 0); seat++) {
      out.set(seat, host.seatStatusFor(seat));
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
  const frame = lobbyFrame;
  if (!frame) return;
  const statuses = seatStatuses();
  const seating = seatingFromRoster(frame);
  const me = selfId();

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
    if (unreachable.has(seat)) {
      const warn = document.createElement('span');
      warn.className = 'presence-chip presence-chip--unreachable';
      warn.textContent = 'unreachable';
      row.append(warn);
    }

    const actions = document.createElement('span');
    actions.className = 'party-seat__actions';
    if (host) {
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
          ? button('Open', () => { hostSeats.release(seat); afterSeatChange(); })
          : button('Bot', () => { hostSeats.seatBot(seat); afterSeatChange(); }));
      }
    } else if (client || activeTable()) {
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
  if (turnTimer) return turnTimer.deadlines();
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
 */
function renderStrip() {
  if (!el.strip) return;
  if (!lobbyFrame) {
    el.strip.hidden = true;
    el.strip.replaceChildren();
    return;
  }
  const statuses = seatStatuses();
  const seating = seatingFromRoster(lobbyFrame);
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
    if (unreachable.has(identity.seat)) pill.classList.add('party-strip__seat--unreachable');
    el.strip.append(pill);
  }
  el.strip.hidden = !el.strip.childElementCount;
}

/** packId -> the manifest's own name, fetched once per pack we are offered. */
const packNames = new Map();

function rememberPackName(packId) {
  if (!packId || packNames.has(packId)) return;
  packNames.set(packId, null); // in flight; never ask twice
  fetchPackManifest(packId)
    .then((manifest) => { packNames.set(packId, manifest?.name || packId); renderScreen(); })
    .catch(() => { packNames.set(packId, packId); });
}

function renderScreen() {
  decorateTiles();
  if (!el.screen) return;
  if (el.heading) el.heading.textContent = partyLabel();
  if (el.note) el.note.textContent = notice;
  if (el.note) el.note.hidden = !notice;

  if (el.summary) {
    const frame = lobbyFrame;
    // A JOINER HAS NOT LOADED THE PACK YET — deciding whether to join is the
    // whole point of this screen — so the slug is all the frame carries. The
    // manifest is one small JSON and the lobby reads it for every tile anyway,
    // so "crazy-eights" becomes "Crazy Eights" before anybody has to read it.
    const packName = joinedPack?.manifest?.name
      || tableContext()?.pack?.manifest?.name
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

function renderActions() {
  if (!el.actions) return;
  el.actions.replaceChildren();
  if (host) {
    // DEAL IS THE HOST'S ONE BUTTON, and it only exists before the cards are
    // out. Afterwards the table is the table; there is nothing to start.
    if (!tableContext()?.state) {
      el.actions.append(button('Deal', () => { dealParty().catch(reportFailure); },
        { className: '' }));
    }
    el.actions.append(button('Stop hosting', () => { stopHosting(); goToLobby(); }));
  } else if (client) {
    el.actions.append(button('Leave the table', () => { leaveTable(); goToLobby(); }));
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
  if (client) client.emote(index);
  else if (host) port.send({ k: FRAME.EMOTE, i: index });
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
    unreachable.add(detail.seat);
    renderScreen();
    return;
  }
  if (detail?.kind === 'send-failed' && detail.deviceId) {
    const ctx = tableContext();
    for (const seat of ctx?.seats?.seatsOfDevice(detail.deviceId) || []) unreachable.add(seat);
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
  lobbyFrame = ourLobbyFrame();
  if (lobbyFrame) setSeating(seatingFromRoster(lobbyFrame));
  rerenderTable();
  renderScreen();
}

/** A seat WE changed: refresh, then tell everybody. */
function afterSeatChange() {
  host?.broadcastLobby();
  refreshSeats();
}

/** The roster WE publish, read back so one renderer draws both roles. */
function ourLobbyFrame() {
  if (!host || !hostSeats) return null;
  const seats = [];
  for (let seat = 0; seat < hostSeats.count; seat++) {
    const owner = hostSeats.ownerOf(seat);
    seats.push({
      seat,
      kind: owner.kind,
      deviceId: owner.deviceId ?? undefined,
      name: nameForSeat(seat),
      status: host.seatStatusFor(seat),
    });
  }
  return {
    packId: hostPack.packId,
    variants: hostPack.variants,
    hostDeviceId: selfId(),
    seatCount: hostSeats.count,
    seats,
    // FALSE UNTIL THE CARDS ARE OUT, and a joiner reads it: before the deal it
    // is waiting for the host, after it there is a hand to be caught up with.
    started: !!tableContext()?.state,
  };
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
  if (host) { showPartyScreen(); return false; }
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
  // BEING IN EARSHOT OF A TABLE IS NOT BEING AT ONE — and reading it as one is
  // the bug this whole stage exists to remove. A device becomes a client the
  // moment anybody advertises a lobby, so `if (client)` here meant that one
  // neighbour hosting Hearts silently took away your ability to host anything
  // at all. Only a seat you are actually SITTING IN is a reason to refuse, and
  // then it is refused out loud rather than by a dead button.
  if (client && seatedHere()) {
    const whose = peerName(client.hostDeviceId());
    setNotice(`You are sitting at ${whose}'s table. Leave it to host your own.`);
    showPartyScreen();
    return false;
  }
  // A client we never sat down at is a pack we loaded speculatively. Nothing is
  // lost by standing up, and the table stays in the directory to go back to.
  if (client) leaveTable();
  ensurePort();
  const me = selfId();
  if (!me) return false;

  const manifest = await fetchPackManifest(packId);
  const count = Math.max(2, manifest?.players?.best ?? manifest?.players?.min ?? 2);
  packNames.set(packId, manifest?.name || packId);

  hostPack = { packId, variants: [], name: manifest?.name || packId };
  hostSeats = createSeatTable({ seats: count, localDeviceId: me });
  hostSeats.claim(0, { deviceId: me });
  // Bots in the rest, so the table is playable the moment it is dealt whether
  // or not anybody turns up. A seat is opened by tapping it, not by default.
  for (let seat = 1; seat < count; seat++) hostSeats.seatBot(seat);

  host = createTableHost({
    peer: port,
    seats: hostSeats,
    // NULL UNTIL THE DEAL, which the protocol already understands: a lobby
    // frame with `started: false` is a table being built, and the host answers
    // a claim with a roster rather than a view because there is no view yet.
    liveState: () => tableContext()?.state ?? null,
    packInfo: () => ({ packId: hostPack.packId, variants: hostPack.variants }),
    nameFor: nameForSeat,
    deadlines: () => turnTimer?.deadlines() || [],
    hooks: {
      onApplied: (_state, move) => { afterRemoteMove(move); armTimer(); },
      // A remote claim arrives here, which is also the late-joiner path: the
      // host must stop moving that seat and start calling it by its name. No
      // re-broadcast — handleClaim already sends one, and this fires inside it.
      onSeatsChanged: () => refreshSeats(),
      onEmote: ({ emote }) => burst(emote),
      onError: surfaceError,
      onBye: () => refreshSeats(),
    },
  });
  // THE CLOCK IS THE HOST'S, AND ONLY THE HOST'S. A client that could time
  // seats out would be a client that can force its opponents to pass by running
  // its clock fast, so this is armed here and the deadlines travel outward in
  // the view as absolute instants for clients to render.
  turnTimer = createTurnTimer({
    // The WALL clock, not the session one: a shared hand does not stop because
    // one tab stopped painting, and a deadline has to survive a sleeping host.
    clock: wallClock(),
    timeoutMs: TURN_TIMEOUT_MS,
    actingSeatsOf: (state) => {
      const template = state.pack.template;
      return template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    },
    // ONLY OTHER PEOPLE'S SEATS. Our own turn is nobody's business but ours —
    // a game has always waited for the player in front of it and should keep
    // doing so — and a bot needs no encouragement.
    waitsOn: (seat) => {
      const owner = hostSeats?.ownerOf(seat);
      return owner?.kind === 'device' && owner.deviceId !== selfId();
    },
    onExpire: (state, seat) => {
      // A TURN THAT RAN OUT IS A MOVE. The house plays one for them and the
      // seat stays theirs — they are back in control the moment they come
      // back, which is the same answer an interrupted link already gets.
      const move = chooseBotMove(state, seat);
      if (!move) return;
      host?.applyLocal(move);
    },
  });
  setLocalMoveListener((_state, _move, events) => { host?.publish(events); armTimer(); });
  host.start();
  port.onPeersChange(() => { refreshSeats(); checkForDrops(); });
  // The panel is about OUR table now. Everything else in earshot stays in the
  // directory and on its own tile; it simply is not what this screen is showing.
  activeKey = null;
  lobbyFrame = ourLobbyFrame();
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
  if (!host || !hostSeats || tableContext()?.state) return false;
  goToTable();
  await dealHostedTable({
    packId: hostPack.packId,
    variants: hostPack.variants,
    seats: hostSeats,
    seating: seatingFromRoster(ourLobbyFrame()),
  });
  host.broadcastLobby();
  host.publish([]);
  hidePartyScreen();
  refreshSeats();
  return true;
}

/**
 * Re-arm after every published move, and keep the countdown painting.
 *
 * `arm` is idempotent by design — a seat that has been waited on all along
 * KEEPS its deadline rather than having its clock reset by somebody else's
 * move, which is what stops a timeout being unreachable at a busy table.
 */
function armTimer() {
  const state = tableContext()?.state;
  if (!turnTimer || !state) return;
  turnTimer.arm(state);
  pulse();
  renderStrip();
}

export function stopHosting() {
  if (!host) return;
  turnTimer?.cancelAll();
  turnTimer = null;
  if (tick) { clearInterval(tick); tick = null; }
  port?.send({ k: FRAME.BYE, why: 'closed' });
  host.stop();
  host = null;
  hostSeats = null;
  hostPack = null;
  setLocalMoveListener(null);
  setTablePaused(false);
  lobbyFrame = null;
  decided = new Set();
  unreachable = new Set();
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
  const dropped = tables.retain(live);
  if (!dropped.length) return;
  if (activeKey && dropped.includes(activeKey)) {
    activeKey = null;
    if (!client && !host) lobbyFrame = null;
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
  const owner = hostSeats.ownerOf(seat);
  if (owner.kind === 'device' && owner.deviceId) {
    port.send({ k: FRAME.BYE, why: 'replaced' }, { to: owner.deviceId });
  }
  hostSeats.seatBot(seat);
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
  if (!host) return;
  const ctx = tableContext();
  if (!ctx) return;
  for (let seat = 0; seat < ctx.seats.count; seat++) {
    if (!needsHostDecision(host.seatStatusFor(seat))) { decided.delete(seat); continue; }
    if (decided.has(seat)) continue;
    decided.add(seat);
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
    // WHERE TO LOOK, and the rule is about attachment rather than recency: an
    // unattached device follows the latest table it hears about (which with one
    // table in earshot is exactly the old behaviour), and a device already at a
    // table — its own or somebody else's — is not dragged off it by a neighbour
    // dealing.
    if (!host && !client && !joining) focusTable(entry.key);
    if (!host && activeKey === entry.key) {
      lobbyFrame = frame;
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
  if (!tables.has(fromDeviceId)) return;
  tables.forget(fromDeviceId);
  if (activeKey === fromDeviceId) {
    activeKey = null;
    if (!client) lobbyFrame = null;
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
  if (!entry || client || joining) return;
  joining = true;
  const frame = entry.frame;
  try {
    joinedPack = await fetchPack(frame.packId, frame.variants);
  } catch (err) {
    joining = false;
    throw err;
  }

  client = createTableClient({
    peer: port,
    // WHICH TABLE WE SAT DOWN AT, said rather than inferred. The client can
    // work it out on its own when there is one host in the party; with two it
    // cannot, and guessing would be the wrong kind of clever about authority.
    host: entry.hostDeviceId,
    expects: () => ({
      packId: joinedPack.id,
      packVersion: joinedPack.manifest?.version,
      variants: joinedPack.activeVariants ?? [],
    }),
    hooks: {
      // OUR HOST'S FRAMES ARE SIGHTINGS TOO. The client hands them over already
      // authenticated, and filing them keeps the tile of the table we are
      // sitting at as current as the tiles of the ones we are only watching.
      onLobby: (next) => {
        const seen = tables.sight(next);
        if (seen && !activeKey) focusTable(seen.key);
        lobbyFrame = next;
        renderScreen();
      },
      onView: (view, _events, meta) => {
        adoptSharedView({
          view,
          pack: joinedPack,
          // A joiner has no seed, so who is at the table is a fact the host
          // publishes rather than one we derive.
          seating: seatingFromRoster(lobbyFrame),
          client,
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
  });
  client.start();
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
  if (client && client.hostDeviceId() === entry.hostDeviceId) return true;
  if (client) {
    if (seatedHere()) {
      setNotice(`You are sitting at ${peerName(client.hostDeviceId())}'s table. Leave it to sit here.`);
      return false;
    }
    // Never sat down at that one; it stays in the directory to go back to.
    leaveTable();
  }
  await joinTable(entry);
  return !!client;
}

/** Sit down, becoming a client of the table on screen first. */
async function claimSeat(seat) {
  if (!await attachToActive()) return;
  client?.claimSeat(seat);
}

export function leaveTable() {
  if (client) {
    client.sendBye('leave');
    client.stop();
  }
  client = null;
  joining = false;
  joinedPack = null;
  if (tick) { clearInterval(tick); tick = null; }
  // BACK TO WATCHING, NOT BACK TO NOTHING. Leaving a table does not unhear the
  // room: whatever else is out there — including the table we just left, if its
  // host is still advertising it — is still on the lobby, and the panel falls
  // back to whichever one we were looking at.
  lobbyFrame = activeTable()?.frame || null;
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
  decorateTiles();
  const invited = tables.size > 0 || !!client || !!host;
  el.entry.hidden = !invited;
  el.entry.disabled = false;
  el.entry.textContent = host ? 'Your party' : (client ? 'Your table' : 'Join the table');
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
  for (const entry of tables.all()) live.set(entry.packId, entry.frame);
  // Ours last, so it wins the tile if we are hosting a pack somebody else is
  // also hosting. "Your party" is the more useful of the two sentences to read
  // on your own screen.
  if (host && hostPack) live.set(hostPack.packId, ourLobbyFrame() || lobbyFrame);

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

export function showPartyScreen() {
  if (!el.screen) return;
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
    seq: host ? host.seq() : (client ? client.seq() : -1),
    seat: client ? client.seat() : null,
    seats: [...seatStatuses().entries()].map(([seat, status]) => ({ seat, status })),
    unreachable: [...unreachable],
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
  if (client) {
    const view = client.view();
    const move = view?.moves?.[0];
    if (!move) return null;
    client.propose(move);
    return move;
  }
  if (!host) return null;
  const ctx = tableContext();
  if (!ctx || ctx.state.isView) return null;
  const mine = ctx.seats.seatsOfDevice(selfId());
  for (const seat of mine) {
    const move = legalFor(ctx.state, seat);
    if (!move) continue;
    // `applyLocal` publishes AND fires onApplied, which is what runs the felt's
    // post-move ritual. Calling that ritual again here ran it twice per host
    // move — two renders, two saves, and two round-summary timers.
    const verdict = host.applyLocal(move);
    if (verdict?.legal) return move;
  }
  return null;
}

/** The host may enumerate, because the host has a state. A client may not. */
function legalFor(state, seat) {
  if (state.turn.seat !== seat) return null;
  return enumerateLegalMoves(state, seat)[0] || null;
}
