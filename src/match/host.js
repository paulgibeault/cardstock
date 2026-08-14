// THE HOST: the only device that holds a state object, and therefore the only
// one allowed to move.
//
// Everything a client sends is a REQUEST. A `propose` that is structurally
// perfect and arrives from the right seat is still only a request, because
// legality is a question about the state and the client does not have one. The
// host answers with either a new view (the accept IS the new view — there is no
// separate ack frame) or a targeted reject.
//
// THE HOST NEVER TRUSTS A CLIENT ABOUT WHO IT IS. `move.actor` is a field in a
// payload; the seat a sender actually holds is looked up from the transport's
// authenticated `fromDeviceId`, which the launcher binds during its identity
// handshake and which payload content cannot forge. A proposal whose actor
// disagrees with its sender's seat is refused rather than corrected, because
// the interesting case is not a bug.
//
// EVERY MOVE GOES THROUGH THE SAME DOOR. A remote proposal, a local player's
// tap and a bot's turn all reach the engine through `applyMove` and all leave
// the same log entry. There is no privileged path, which is what keeps replay,
// resume and resync honest — and it is why a timeout is a move (src/match/turnTimer.js)
// rather than something the table does to a seat.

import { validateMove, applyMove, enumerateLegalMoves } from '../engine/movePipeline.js';
import { makeCtx } from '../engine/context.js';
import { viewFor, eventsFor } from '../engine/view.js';
import { baseId } from '../engine/selectors.js';
import {
  FRAME, PROTOCOL_VERSION, validateFrame, isSafeId, EMOTES,
} from './protocol.js';

/** How many proposals one seat may make per window before we stop reading them. */
const PROPOSE_BUDGET = 40;
const PROPOSE_WINDOW_MS = 10_000;

/**
 * WHAT THE HOST SHOULD DO ABOUT A SEAT, as a pure function of who holds it and
 * what the transport says about them.
 *
 * The three answers are not interchangeable and the middle one is the one worth
 * getting right:
 *
 *   connected    play on.
 *   interrupted  PLAY ON ANYWAY. The transport queues sends through an
 *                interruption and replays them exactly once, so a seat whose
 *                phone went through a tunnel has missed nothing. Freeing it,
 *                bot-filling it, or resetting anything here would turn a
 *                recoverable blip into a lost seat — and the player comes back
 *                to a table that gave their hand away.
 *   gone         the grace ran out. Now it is a decision, and it is the host
 *                player's to make (bot-fill / pause / end) rather than one this
 *                module takes on its own. The BINDING SURVIVES either way, so
 *                the seat is still theirs if they come back.
 */
export function seatStatus(owner, { peers = [], selfDeviceId = null } = {}) {
  if (!owner || owner.kind === 'bot') return 'bot';
  if (owner.kind === 'empty') return 'empty';
  if (owner.deviceId === selfDeviceId) return 'connected';
  const entry = peers.find((p) => p.deviceId === owner.deviceId);
  if (!entry) return 'gone';
  return entry.status === 'interrupted' ? 'interrupted' : 'connected';
}

/** Does a seat in this state still hold its place? Only `gone` is a decision. */
export function needsHostDecision(status) {
  return status === 'gone';
}

/**
 * @param peer      the peer port: send/onMessage/onReady/onPeersChange/peers/self/caps/queue
 * @param seats     the seat ownership table (src/players/seats.js)
 * @param liveState () => the engine state, or null between matches
 * @param packInfo  () => ({ packId, packVersion, variants })
 * @param nameFor   (seat) => display name for the lobby roster
 * @param deadlines () => the live turn deadlines to ship with each view
 * @param now       the clock the rate-limit window is measured against. Injected
 *                  for the same reason the peer port is: tools/simulate.mjs
 *                  plays a whole hand in a millisecond, so on the wall clock
 *                  every proposal of a long game lands inside one window and
 *                  the budget starts refusing legal moves. A simulation that
 *                  had to work around its own rate limiter would be measuring
 *                  the limiter.
 * @param hooks     { onSeatsChanged, onApplied, onEmote, onError, onBye }
 */
export function createTableHost({
  peer,
  seats,
  tableId,
  liveState,
  packInfo,
  nameFor = () => '',
  deadlines = () => [],
  // HOW LONG A SEAT GETS AT THIS TABLE, as a seam rather than a constant: it is
  // the host's choice (plan §7) and it has to travel, or a joiner's countdown
  // is a number compiled into the joiner's own build and right by coincidence.
  graceMs = () => undefined,
  now = Date.now,
  hooks = {},
}) {
  if (!isSafeId(tableId)) throw new Error('createTableHost: a table needs an id');
  const unsubscribes = [];
  const budgets = new Map(); // deviceId -> {count, until}
  let started = false;
  let seq = 0;

  const selfDeviceId = () => peer.self()?.deviceId || null;

  /* ---------------------------------------------------------------- *
   * Outbound
   * ---------------------------------------------------------------- */

  /**
   * A targeted send whose failure is SURFACED rather than swallowed.
   *
   * `send` returning false means the transport refused it outright — an unknown
   * target, a missing capability, no live party. It is emphatically NOT a
   * delivery receipt (a send it accepted can still be lost, which is what the
   * replay queue and the snapshot path are for), so the only honest thing to do
   * with `false` is tell somebody. Silently broadcasting instead would turn a
   * private frame public, which is the one failure this design cannot have.
   */
  function sendTo(deviceId, frame) {
    const delivered = peer.send(stamp(frame), { to: deviceId });
    if (!delivered) {
      hooks.onError?.({ kind: 'send-failed', deviceId, frame: frame.k });
    }
    return delivered;
  }

  function broadcast(frame) {
    return peer.send(stamp(frame));
  }

  /**
   * Every frame leaves saying which table it is from.
   *
   * ONE CHOKE POINT, so a new frame kind cannot forget. This is the outbound
   * half of protocol v2; the inbound half is the guard in `onMessage`, and the
   * two together are what let one device run two tables through one port.
   */
  function stamp(frame) {
    return { ...frame, tableId };
  }

  function seatRoster() {
    const out = [];
    for (let seat = 0; seat < seats.count; seat++) {
      const owner = seats.ownerOf(seat);
      out.push({
        seat,
        kind: owner.kind,
        deviceId: owner.deviceId ?? undefined,
        localIndex: owner.localIndex ?? undefined,
        name: nameFor(seat),
        status: statusForSeat(owner),
      });
    }
    return out;
  }

  function statusForSeat(owner) {
    return seatStatus(owner, { peers: peer.peers(), selfDeviceId: selfDeviceId() });
  }

  /**
   * The handshake, re-sent on every `onReady` and every seat change.
   *
   * IT IS BROADCAST AND IT IS IDEMPOTENT, which is what lets `onReady` be the
   * only join signal. `onReady` re-fires on reconnect and the SDK promises
   * nothing about how often, so the frame is written to be safe to receive
   * twice — a client that already knows this is a no-op, and one that just
   * arrived is now caught up.
   */
  function broadcastLobby() {
    const info = packInfo();
    return broadcast({
      k: FRAME.LOBBY,
      protocol: PROTOCOL_VERSION,
      packId: info.packId,
      packVersion: info.packVersion,
      variants: info.variants || [],
      hostDeviceId: selfDeviceId(),
      seatCount: seats.count,
      seats: seatRoster(),
      started: !!liveState(),
      graceMs: graceMs(),
    });
  }

  /**
   * The host's own announcements to the room.
   *
   * These exist so `src/ui/party.js` does not have to reach past the host and
   * call `peer.send` itself. It did, for three frames — an emote, and the two
   * `bye`s that end a table or take a seat back — each stamping `tableId` by
   * hand. They were correct, and they were three more doors that a fourth
   * could be added beside without anybody noticing it had skipped the stamp.
   * That is #56's shape, and #63's whole point: one door out.
   */
  function emote(index) {
    if (!Number.isInteger(index) || index < 0 || index >= EMOTES.length) return false;
    return broadcast({ k: FRAME.EMOTE, i: index });
  }

  /**
   * `closed` ends the table for everybody; `replaced` is aimed at one device
   * whose seat has been taken back. Same frame, two audiences, and the caller
   * says which by passing `to` or not.
   */
  function sendBye(why, { to = null } = {}) {
    const frame = { k: FRAME.BYE, why };
    return to ? sendTo(to, frame) : broadcast(frame);
  }

  /** One seat's view, addressed to the device holding it. */
  function sendViewTo(seat, deviceId, { kind = FRAME.VIEW, events = [] } = {}) {
    const state = liveState();
    if (!state) return false;
    const acting = actingSeats(state).includes(seat);
    return sendTo(deviceId, {
      k: kind,
      seq,
      view: viewFor(state, seat, {
        moves: acting ? enumerateLegalMoves(state, seat) : [],
        announcements: acting ? announcementsFor(state, seat) : [],
        // A CLIENT RENDERS A COUNTDOWN; IT NEVER OWNS ONE. These are absolute
        // host-clock instants, so a client can show the time left without ever
        // being in a position to decide that it ran out — which would be a
        // client that can time its opponents out by running its clock fast.
        deadlines: deadlines(),
        seq,
      }),
      events: eventsFor(state, seat, events),
    });
  }

  /**
   * Push a fresh view to every remote seat. Called after every applied move —
   * VIEW REPLACEMENT, not event folding (design decision D2). A few KB per move
   * on a channel that moves megabytes buys the deletion of an entire bug class:
   * a client whose animation missed a beat is still exactly correct, because
   * the last view it received is what it believes.
   */
  function fanOut(events = []) {
    const state = liveState();
    if (!state) return;
    const sent = new Set();
    for (let seat = 0; seat < seats.count; seat++) {
      const owner = seats.ownerOf(seat);
      if (owner.kind !== 'device') continue;
      if (owner.deviceId === selfDeviceId()) continue; // the host reads its own state
      if (sent.has(`${owner.deviceId}:${seat}`)) continue;
      sent.add(`${owner.deviceId}:${seat}`);
      sendViewTo(seat, owner.deviceId, { events });
    }
  }

  function actingSeats(state) {
    const template = state.pack.template;
    if (state.gameOver) return [];
    return template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
  }

  function announcementsFor(state, seat) {
    const template = state.pack.template;
    if (!template.enumerateAnnouncements) return [];
    return template.enumerateAnnouncements(makeCtx(state), seat) || [];
  }

  /* ---------------------------------------------------------------- *
   * Inbound
   * ---------------------------------------------------------------- */

  /** Rate limit per sender, so a misbehaving client cannot spin the validator. */
  function withinBudget(deviceId, at) {
    const entry = budgets.get(deviceId);
    if (!entry || at > entry.until) {
      budgets.set(deviceId, { count: 1, until: at + PROPOSE_WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= PROPOSE_BUDGET;
  }

  /**
   * Are all the card ids in this move real cards in this pack?
   *
   * The charset check in protocol.js keeps a wire id out of a selector; this
   * keeps a well-formed id that names nothing from reaching the engine, where
   * `moveCards` would throw on it from inside a message handler.
   */
  function cardsExist(state, move) {
    if (!Array.isArray(move.cards)) return true;
    return move.cards.every((id) => state.pack.cardsById.has(baseId(id)));
  }

  function handleClaim(fromDeviceId, frame) {
    if (frame.seat >= seats.count) return;
    const already = seats.seatOf(fromDeviceId, frame.localIndex);
    // A REBIND IS A RE-CLAIM. A device coming back after a drop asks for the
    // seat it already holds, and `claim` answers yes to exactly that case, so
    // recovery needs no separate verb.
    const took = already === frame.seat ? true : seats.claim(frame.seat, {
      deviceId: fromDeviceId,
      localIndex: frame.localIndex,
    });
    if (took) hooks.onSeatsChanged?.();
    broadcastLobby();
    if (took && liveState()) sendViewTo(frame.seat, fromDeviceId, { kind: FRAME.SNAPSHOT });
  }

  function handlePropose(fromDeviceId, frame, at) {
    const state = liveState();
    if (!state) return;
    if (!withinBudget(fromDeviceId, at)) {
      // SAID OUT LOUD, even though nothing is sent back. A budget that drops
      // frames in complete silence looks identical, from the client's side, to
      // a host that crashed — it proposes and waits forever — and identical,
      // from ours, to a bug. Telling the table costs one hook call and turns an
      // invisible refusal into a diagnosable one.
      hooks.onError?.({ kind: 'rate-limited', deviceId: fromDeviceId, frame: frame.k });
      return;
    }

    const move = frame.move;
    const held = seats.seatsOfDevice(fromDeviceId);
    // The authority check: the seat comes from the AUTHENTICATED sender, never
    // from the move's own `actor` field.
    if (!held.includes(move.actor)) {
      return void sendTo(fromDeviceId, {
        k: FRAME.REJECT, pid: frame.pid, rule: 'not-your-seat',
        reason: 'That is not your seat.',
      });
    }
    if (!cardsExist(state, move)) {
      return void sendTo(fromDeviceId, {
        k: FRAME.REJECT, pid: frame.pid, rule: 'unknown-card',
        reason: 'That card is not in this deck.',
      });
    }

    // THE FULL VALIDATOR, AND VALIDATE-THEN-APPLY RATHER THAN TRY/CATCH.
    // `applyMove` throws on an illegal move, and a throw from inside a message
    // handler is a table that stops. Asking first means a refused proposal
    // leaves the state bit-identical, which is the property the engine test
    // pins.
    const check = validateMove(state, move);
    if (!check.legal) {
      return void sendTo(fromDeviceId, {
        k: FRAME.REJECT, pid: frame.pid,
        rule: isSafeId(check.rule) ? check.rule : 'illegal',
        reason: check.reason || 'That move is not legal.',
      });
    }

    applyLocal(move);
  }

  function handleSnapshotReq(fromDeviceId) {
    const state = liveState();
    if (!state) return void broadcastLobby();
    for (const seat of seats.seatsOfDevice(fromDeviceId)) {
      sendViewTo(seat, fromDeviceId, { kind: FRAME.SNAPSHOT });
    }
  }

  function onMessage(payload, fromDeviceId, meta) {
    if (!fromDeviceId) return; // pre-identity frame; nothing can be attributed
    const verdict = validateFrame(payload);
    if (!verdict.ok) {
      hooks.onError?.({ kind: 'bad-frame', deviceId: fromDeviceId, reason: verdict.reason });
      return;
    }
    const frame = verdict.frame;
    // NOT OUR TABLE, NOT OUR BUSINESS. Every host on this device subscribes to
    // the same `onMessage`, so without this a `claim-seat` meant for the Hearts
    // table also seated that device at the Crazy Eights one — at a table nobody
    // asked to sit down at, holding cards nobody dealt them.
    if (frame.tableId !== tableId) return;

    switch (frame.k) {
      case FRAME.CLAIM_SEAT: return handleClaim(fromDeviceId, frame);
      case FRAME.PROPOSE: return handlePropose(fromDeviceId, frame, now());
      case FRAME.SNAPSHOT_REQ: return handleSnapshotReq(fromDeviceId);
      case FRAME.EMOTE: return void hooks.onEmote?.({
        deviceId: fromDeviceId, emote: EMOTES[frame.i], seat: seats.seatsOfDevice(fromDeviceId)[0] ?? null,
      });
      case FRAME.BYE: return handleBye(fromDeviceId, frame);
      default:
        // A host-only frame arriving from a peer is a client that thinks it is
        // the host, or somebody probing. Neither is worth acting on.
        hooks.onError?.({ kind: 'unexpected-frame', deviceId: fromDeviceId, frame: frame.k, relayed: meta?.relayed });
    }
  }

  function handleBye(fromDeviceId, frame) {
    const held = seats.seatsOfDevice(fromDeviceId);
    hooks.onBye?.({ deviceId: fromDeviceId, seats: held, why: frame.why });
    broadcastLobby();
  }

  /* ---------------------------------------------------------------- *
   * The host's own moves
   * ---------------------------------------------------------------- */

  /**
   * Apply a move the host itself decided on — its own player's tap, a bot's
   * turn, a turn that ran out — and publish the result.
   *
   * The same function serves an accepted proposal, which is the point: there is
   * exactly one place a move becomes a fact.
   */
  function applyLocal(move) {
    const state = liveState();
    if (!state) return null;
    const check = validateMove(state, move);
    if (!check.legal) return check;
    applyMove(state, move);
    const events = state.events.slice();
    publish(events);
    hooks.onApplied?.(state, move, events);
    return { legal: true };
  }

  /**
   * A move became a fact — bump the sequence and send everybody the result.
   *
   * TWO WAYS IN, ONE WAY OUT, and the second caller is why this is its own
   * function. `applyLocal` is for a move the host module decides on: an
   * accepted proposal. But the TABLE applies its own moves — a tap, a bot's
   * turn, a timeout, an announcement — through a pipeline that predates
   * multiplayer and that solo play depends on being exactly as it is. Making
   * the felt route those through `applyLocal` would mean re-validating a move
   * the table has already applied, and rewriting the one code path with no unit
   * coverage in the repo. So the table applies, then says so
   * (`setLocalMoveListener` in src/ui/table.js), and both roads arrive here.
   *
   * THE SEQ BUMP IS THE POINT. Views are whole and a client trusts `seq` to
   * tell it whether it missed one; publishing a new view under an old sequence
   * number is how a client silently keeps a stale table.
   */
  function publish(events = []) {
    seq += 1;
    fanOut(events);
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  function start() {
    if (started) return;
    started = true;
    unsubscribes.push(peer.onMessage(onMessage));
    // onReady fires when the remote has THIS GAME mounted, and re-fires on
    // reconnect — so re-broadcasting the lobby on it is the whole join
    // handshake, with no hand-rolled hello/echo to get wrong.
    unsubscribes.push(peer.onReady(() => broadcastLobby()));
    unsubscribes.push(peer.onPeersChange(() => {
      hooks.onSeatsChanged?.();
      broadcastLobby();
    }));
    broadcastLobby();
  }

  function stop() {
    for (const off of unsubscribes.splice(0)) {
      try { off?.(); } catch { /* an unsubscribe that throws must not strand the rest */ }
    }
    started = false;
  }

  return {
    start,
    stop,
    emote,
    sendBye,
    applyLocal,
    publish,
    broadcastLobby,
    fanOut,
    seatStatusFor: (seat) => statusForSeat(seats.ownerOf(seat)),
    seq: () => seq,
    /** For the table: publish a fresh view without a move (a rename, a re-seat). */
    republish: () => fanOut([]),
  };
}
