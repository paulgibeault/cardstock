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
import { enumerateLegalMoves } from '../engine/movePipeline.js';
import { createTableClient } from '../match/client.js';
import { FRAME, EMOTES, validateFrame, isAuthentic } from '../match/protocol.js';
import { botById, initialsOf, pickBotIds } from '../players/roster.js';
import { fetchPack } from './packSource.js';
import {
  adoptSharedView, leaveSharedTable, tableContext, rebaseSeats,
  setLocalMoveListener, afterRemoteMove, setTablePaused, rerenderTable,
} from './table.js';

const el = {
  entry: document.getElementById('party-button'),
  screen: document.getElementById('party-screen'),
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

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let port = null;              // the peer port, or null when there is no surface
let host = null;              // createTableHost, when we are hosting
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
const myName = () => {
  try { return Arcade.player.name() || 'You'; } catch { return 'You'; }
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
  if (deviceId === selfId()) return myName();
  const entry = (port?.peers() || []).find((p) => p.deviceId === deviceId);
  const name = entry?.name || '';
  return String(name).slice(0, 60) || 'Someone';
}

/** The name the HOST publishes for a seat — read by the lobby roster it sends. */
function nameForSeat(seat) {
  const ctx = tableContext();
  const owner = ctx?.seats?.ownerOf(seat);
  if (!owner || owner.kind === 'empty') return '';
  if (owner.kind === 'bot') return botById(owner.botId).name;
  return peerName(owner.deviceId);
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

  const out = [];
  for (let seat = 0; seat < seatCount; seat++) {
    const entry = roster.find((s) => s.seat === seat) || { seat, kind: 'empty' };
    if (entry.kind === 'bot') {
      const bot = botById(botIds[botSeats.indexOf(seat)]);
      out.push(Object.freeze({
        seat, name: bot.name, shortName: bot.name, icon: bot.icon,
        initials: initialsOf(bot.name), color: bot.color,
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
    const ctx = tableContext();
    for (let seat = 0; seat < (ctx?.seats?.count || 0); seat++) {
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
      const ctx = tableContext();
      if (entry.kind !== 'device' || entry.deviceId !== me) {
        actions.append(entry.kind === 'bot'
          ? button('Open', () => { ctx.seats.release(seat); afterSeatChange(); })
          : button('Bot', () => { ctx.seats.seatBot(seat); afterSeatChange(); }));
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
 * The strip above the felt: presence while a party is live, and before that,
 * the host's own door into one.
 *
 * THE HOST STARTS HOSTING FROM THE TABLE, because that is the only place a
 * table exists. Going back to the lobby closes the match (src/main.js), so a
 * "host this game" control on the lobby screen would have nothing to host. It
 * lives here rather than in the status bar because that bar is three items on
 * one line and a fourth would push the felt down under the player's hand.
 */
function renderStrip() {
  if (!el.strip) return;
  if (partyRole() === 'idle') {
    el.strip.replaceChildren();
    const ctx = tableContext();
    const gate = availability();
    if (!ctx || ctx.state.isView || !gate.available) { el.strip.hidden = true; return; }
    el.strip.append(button('Play together', () => {
      if (startHosting()) showPartyScreen();
    }));
    el.strip.hidden = false;
    return;
  }
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
    if (unreachable.has(identity.seat)) pill.classList.add('party-strip__seat--unreachable');
    el.strip.append(pill);
  }
  el.strip.hidden = !el.strip.childElementCount;
}

function renderScreen() {
  if (!el.screen) return;
  if (el.heading) el.heading.textContent = partyLabel();
  if (el.note) el.note.textContent = notice;
  if (el.note) el.note.hidden = !notice;

  if (el.summary) {
    const frame = lobbyFrame;
    const packName = joinedPack?.manifest?.name || tableContext()?.pack?.manifest?.name || frame?.packId || '';
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
    el.actions.append(button('Stop hosting', () => { stopHosting(); goToTable(); }));
  } else if (client) {
    el.actions.append(button('Leave the table', () => { leaveTable(); goToLobby(); }));
  } else if (invitation) {
    el.actions.append(button('Join', () => { joinInvitation().catch(reportFailure); },
      { className: 'primary-button' }));
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

function afterSeatChange() {
  host?.broadcastLobby();
  lobbyFrame = ourLobbyFrame();
  rerenderTable();
  renderScreen();
}

/** The roster WE publish, read back so one renderer draws both roles. */
function ourLobbyFrame() {
  const ctx = tableContext();
  if (!ctx || !host) return null;
  const seats = [];
  for (let seat = 0; seat < ctx.seats.count; seat++) {
    const owner = ctx.seats.ownerOf(seat);
    seats.push({
      seat,
      kind: owner.kind,
      deviceId: owner.deviceId ?? undefined,
      name: nameForSeat(seat),
      status: host.seatStatusFor(seat),
    });
  }
  return {
    packId: ctx.pack.id,
    variants: ctx.pack.activeVariants ?? [],
    hostDeviceId: selfId(),
    seatCount: ctx.seats.count,
    seats,
    started: true,
  };
}

/**
 * Start publishing this table.
 *
 * The table itself does not change: the host plays exactly as a solo player
 * does, through the same pipeline, and hosting is a listener on it rather than
 * an interception (see `setLocalMoveListener` in src/ui/table.js).
 */
export function startHosting() {
  const gate = availability();
  if (!gate.available) { announceGate(gate); return false; }
  const ctx = tableContext();
  if (!ctx || ctx.state.isView) return false;
  if (host) return true;

  ensurePort();
  const me = selfId();
  if (!me) return false;
  // The seat table has been calling us `@local`; the wire needs the name the
  // transport knows.
  rebaseSeats(me);

  host = createTableHost({
    peer: port,
    seats: tableContext().seats,
    liveState: () => tableContext()?.state ?? null,
    packInfo: () => {
      const live = tableContext();
      return {
        packId: live.pack.id,
        packVersion: live.pack.manifest?.version,
        variants: live.pack.activeVariants ?? [],
      };
    },
    nameFor: nameForSeat,
    hooks: {
      onApplied: (_state, move) => afterRemoteMove(move),
      onSeatsChanged: () => { lobbyFrame = ourLobbyFrame(); rerenderTable(); renderScreen(); },
      onEmote: ({ emote }) => burst(emote),
      onError: surfaceError,
      onBye: () => { lobbyFrame = ourLobbyFrame(); renderScreen(); },
    },
  });
  setLocalMoveListener((_state, _move, events) => host?.publish(events));
  host.start();
  lobbyFrame = ourLobbyFrame();
  port.onPeersChange(() => { lobbyFrame = ourLobbyFrame(); checkForDrops(); renderScreen(); });
  refreshPartyLabel().then(renderScreen);
  renderScreen();
  return true;
}

export function stopHosting() {
  if (!host) return;
  port?.send({ k: FRAME.BYE, why: 'closed' });
  host.stop();
  host = null;
  setLocalMoveListener(null);
  setTablePaused(false);
  lobbyFrame = null;
  decided = new Set();
  unreachable = new Set();
  renderScreen();
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
        renderStrip();
      },
      onReject: (frame2) => Arcade.ui.toast(frame2.reason || 'That move is not legal.',
        { kind: 'error', duration: 2500 }),
      onEmote: ({ emote }) => burst(emote),
      onIncompatible: surfaceIncompatible,
      onError: surfaceError,
      onEnd: () => { setNotice('The host closed the table.'); leaveTable(); goToLobby(); },
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
  el.entry.disabled = false;
  el.entry.hidden = false;
  el.entry.textContent = invitation && !client && !host ? 'Join the table' : 'Play together';
  renderStrip();
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

export function initParty({ onShowTable, onShowLobby }) {
  goToTable = onShowTable || (() => {});
  goToLobby = onShowLobby || (() => {});
  ensurePort();

  el.entry?.addEventListener('click', () => {
    const gate = availability();
    if (!gate.available) { announceGate(gate); return; }
    showPartyScreen();
  });
  el.back?.addEventListener('click', () => { hidePartyScreen(); goToLobby(); });

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
    const verdict = host.applyLocal(move);
    if (verdict?.legal) { afterRemoteMove(move); return move; }
  }
  return null;
}

/** The host may enumerate, because the host has a state. A client may not. */
function legalFor(state, seat) {
  if (state.turn.seat !== seat) return null;
  return enumerateLegalMoves(state, seat)[0] || null;
}
