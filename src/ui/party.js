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
let invitation = null;        // a lobby frame sighted while we are still idle
let sniffOff = null;
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
    } else if (client) {
      const mine = entry.kind === 'device' && entry.deviceId === me;
      if (!mine && entry.kind !== 'device') {
        actions.append(button('Take this seat', () => client.claimSeat(seat)));
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
  if (host || client) { showPartyScreen(); return false; }
  // SOMEBODY IS ALREADY PLAYING THIS ONE. The tile's button is one door with
  // two meanings, and which it means is not the player's to work out: with a
  // live party on this pack, tapping it takes you to that table rather than
  // starting a rival one nobody can see.
  if (invitation && invitation.packId === packId) { showPartyScreen(); return false; }
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
  renderScreen();
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
 * The invitation sniffer.
 *
 * A joiner cannot start a real client before it knows WHICH pack to load — the
 * client refuses a lobby whose pack is not the one this build has open, and
 * quite right too. So this listens for the one frame that answers that
 * question, applying the same two rules the client itself applies: a frame is
 * only believed from the device we hold a DIRECT link to, and never when it
 * arrives relayed (a fellow joiner can address us through the hub).
 *
 * It produces an invitation and never a scrap of state.
 */
function startSniffing() {
  if (sniffOff || !port) return;
  sniffOff = port.onMessage((payload, fromDeviceId, meta) => {
    if (client || host || !fromDeviceId) return;
    const verdict = validateFrame(payload);
    if (!verdict.ok || verdict.frame.k !== FRAME.LOBBY) return;
    const direct = port.peers().filter((p) => p.direct);
    const hostDeviceId = direct.length === 1 ? direct[0].deviceId : null;
    if (!isAuthentic(FRAME.LOBBY, { fromDeviceId, hostDeviceId, relayed: meta?.relayed })) return;
    invitation = verdict.frame;
    lobbyFrame = verdict.frame;
    rememberPackName(verdict.frame.packId);
    // BECOME A CLIENT AS SOON AS WE ARE INVITED, rather than on a button.
    // Loading the pack is the only thing "Join" ever did, and making it a
    // separate tap meant the seat buttons were dead until you found it —
    // two decisions where there is only one, and the second one is the seat.
    joinInvitation().catch(reportFailure);
    refreshEntry();
    renderScreen();
  });
}

/** Load the host's pack, then become a real client of its table. */
async function joinInvitation() {
  if (!invitation || client) return;
  const frame = invitation;
  joinedPack = await fetchPack(frame.packId, frame.variants);

  client = createTableClient({
    peer: port,
    expects: () => ({
      packId: joinedPack.id,
      packVersion: joinedPack.manifest?.version,
      variants: joinedPack.activeVariants ?? [],
    }),
    hooks: {
      onLobby: (next) => { lobbyFrame = next; renderScreen(); },
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
  refreshPartyLabel().then(renderScreen);
  renderScreen();
}

export function leaveTable() {
  if (client) {
    client.sendBye('leave');
    client.stop();
  }
  client = null;
  joinedPack = null;
  if (tick) { clearInterval(tick); tick = null; }
  lobbyFrame = invitation;
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
  // THE HEADER BUTTON IS THE JOINER'S DOOR AND ONLY THE JOINER'S. Hosting is
  // offered on the game tiles, because a host picks a game first; there is
  // nothing for this button to mean until somebody else has picked one.
  // The tiles' own doors, toggled in place: a party can form while the player
  // is sitting on the lobby, and the tiles were built before it did.
  for (const node of document.querySelectorAll('.tile__together')) node.hidden = false;
  decorateTiles();
  const invited = !!invitation || !!client || !!host;
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
  const frame = lobbyFrame;
  const mine = host ? hostPack?.packId : null;
  const theirs = frame && !host ? frame.packId : null;
  const live = mine || theirs;

  for (const tile of document.querySelectorAll('.tile[data-pack-id]')) {
    const slot = tile.querySelector('.tile__party');
    const door = tile.querySelector('.tile__together');
    const isLive = tile.dataset.packId === live;
    if (slot) {
      slot.hidden = !isLive;
      slot.textContent = isLive ? partyRibbon(frame) : '';
    }
    // The door's LABEL changes with its meaning. "Play together" starts a
    // table; on the game somebody is already at, the only useful verb is the
    // one that takes you there.
    if (door && !door.hidden) {
      door.textContent = isLive && !host ? 'Take a seat' : 'Play together';
    }
  }
}

/** "Ada's table · waiting to deal · 2 seats open" — one line, in that order. */
function partyRibbon(frame) {
  if (!frame) return 'Your party';
  const whose = host ? 'Your party' : `${partyLabel.cached?.leaderName || 'A'}'s table`;
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
    port?.onPeersChange(() => { refreshEntry(); renderStrip(); });
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
