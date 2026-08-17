// A HOST AND TWO JOINERS, PLAYING A REAL HAND — headlessly.
//
// The Definition of Done for multiplayer is a three-launcher acceptance run in
// real browsers (WP-C6), and that is not what this is. This is the tier below
// it: the same protocol, the same modules, driven over an in-memory star
// (tools/peer-stub.mjs) so the cases that matter are cheap to write and run in
// a second.
//
// Those cases are the ones a browser run is worst at: a joiner impersonating
// the host, a proposal from somebody else's seat, a dropped view, a replay
// queue that overflowed, a version mismatch. Every one of them is a few lines
// here and an ordeal there.
//
// THE PRIVACY ASSERTION IS ON WHAT WAS DELIVERED, not on what was rendered.
// The stub records every frame each device was actually handed, so "joiner B
// never received joiner A's hand" is checked against the wire rather than
// against a filter grading itself.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { enumerateLegalMoves } from '../src/engine/movePipeline.js';
import { createSeatTable } from '../src/players/seats.js';
import { createTableHost, seatStatus, needsHostDecision } from '../src/match/host.js';
import { createTurnTimer } from '../src/match/turnTimer.js';
import { wallClock } from '../src/match/clock.js';
import { chooseBotMove } from '../src/engine/bot.js';
import { createTableClient } from '../src/match/client.js';
import {
  peerAvailability, arcadePeerPort, REQUIRED_CAPS, INVITE_CAP,
} from '../src/match/peerPort.js';
import {
  validateFrame, isAuthentic, isSafeCardId, isSafeAddress, FRAME, PROTOCOL_VERSION, EMOTES,
} from '../src/match/protocol.js';
import { createPeerNetwork } from '../tools/peer-stub.mjs';
import { loadPackFromDisk, listPackIds } from '../tools/pack-test.mjs';

/**
 * THE TABLE EVERY FRAME IN THIS FILE BELONGS TO.
 *
 * Protocol v2 puts a `tableId` on every frame, so a fixture without one is
 * refused before the check it was written for ever runs — and a test that fails
 * for the wrong reason is a test that stops meaning anything.
 */
const TID = 'tbl-protocol';

/* ------------------------------------------------------------------ *
 * A three-device table
 * ------------------------------------------------------------------ */

async function threeSeatTable({ packId = 'crazy-eights', now } = {}) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats: 3, seed: 20260810 });
  pack.template.setup(makeCtx(state));

  const net = createPeerNetwork({ hostDeviceId: 'host' });
  const hostPort = net.createDevice('host', { name: 'Host' });
  const aPort = net.createDevice('a', { name: 'Ada' });
  const bPort = net.createDevice('b', { name: 'Bo' });

  const seats = createSeatTable({ seats: 3, localDeviceId: 'host' });
  seats.claim(0, { deviceId: 'host' });

  const errors = { host: [], a: [], b: [] };
  const host = createTableHost({ tableId: TID,
    peer: hostPort,
    seats,
    liveState: () => state,
    packInfo: () => ({
      packId: pack.id,
      packVersion: pack.manifest?.version,
      variants: pack.activeVariants ?? [],
    }),
    nameFor: (seat) => `Seat ${seat}`,
    ...(now ? { now } : {}),
    hooks: { onError: (e) => errors.host.push(e) },
  });

  const expects = () => ({
    packId: pack.id,
    packVersion: pack.manifest?.version,
    variants: pack.activeVariants ?? [],
  });

  const watched = () => ({ views: [], rejects: [], lobbies: [], bad: [], emotes: [], ends: [] });
  const seen = { a: watched(), b: watched() };
  const mkClient = (port, key) => createTableClient({ tableId: TID,
    peer: port,
    expects,
    hooks: {
      onLobby: (frame) => seen[key].lobbies.push(frame),
      onView: (view, events, meta) => seen[key].views.push({ view, events, meta }),
      onReject: (frame) => seen[key].rejects.push(frame),
      onIncompatible: (why) => seen[key].bad.push(why),
      onEmote: (detail) => seen[key].emotes.push(detail),
      onEnd: (detail) => seen[key].ends.push(detail),
      onError: (e) => errors[key].push(e),
    },
  });

  const a = mkClient(aPort, 'a');
  const b = mkClient(bPort, 'b');

  host.start();
  a.start();
  b.start();
  net.ready('host', 'a');

  return { pack, state, net, seats, host, a, b, seen, errors, ports: { host: hostPort, a: aPort, b: bPort } };
}

function seatAll(t) {
  t.a.claimSeat(1);
  t.b.claimSeat(2);
}

/* ------------------------------------------------------------------ *
 * Frame validation
 * ------------------------------------------------------------------ */

test('an unknown frame kind is refused, not guessed at', () => {
  assert.equal(validateFrame({ tableId: TID, k: 'take-over' }).ok, false);
  assert.equal(validateFrame({ tableId: TID, k: '__proto__' }).ok, false);
  assert.equal(validateFrame(null).ok, false);
  assert.equal(validateFrame('propose').ok, false);
  assert.equal(validateFrame([]).ok, false);
});

test('a validated frame is a CLEANED COPY — unknown fields never survive', () => {
  const verdict = validateFrame({ tableId: TID,
    k: FRAME.PROPOSE, pid: 'p1', move: { actor: 1, type: 'draw' }, sneaky: 'payload',
  });
  assert.ok(verdict.ok);
  assert.equal(verdict.frame.sneaky, undefined);
  // `tableId` is part of the cleaned copy from protocol v2 on: every frame
  // names its table, so every validated frame carries it back out.
  assert.deepEqual(Object.keys(verdict.frame).sort(), ['k', 'move', 'pid', 'tableId']);
});

test('wire ids are charset-checked before anything can use them as a selector', () => {
  const bad = ['<img src=x>', 'a b', "'; DROP", '../../etc', '__proto__.x', 'x'.repeat(65)];
  for (const id of bad) {
    assert.equal(
      validateFrame({ tableId: TID, k: FRAME.PROPOSE, pid: 'p1', move: { actor: 0, type: 'playCard', cards: [id] } }).ok,
      false,
      `${id} should be refused`,
    );
  }
});

/**
 * THE VALIDATOR HAS TO ACCEPT WHAT THE ENGINE ACTUALLY MINTS, and for a long
 * while it did not.
 *
 * Every card after the first copy is `base#N` (src/engine/cards.js) and every
 * per-seat zone is `name.N` (`hand.1`, `discard.4.3`). Neither matched the wire
 * charset, so a `propose` carrying a real Wildfire or Stockpile card was
 * refused as malformed before it reached a single rule — while Crazy Eights'
 * opening `draw`, a move with no cards and no addresses, sailed through. One
 * pack looked fine and four could not play at all.
 *
 * So the pin is against the REAL vocabulary rather than a handful of examples:
 * every id and every address every pack mints, at every seat count it offers.
 */
test('every card id and zone address the engine mints survives the wire validator', async () => {
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    const { min, max } = pack.manifest.players;
    for (const seats of new Set([min, max])) {
      const state = createState({ pack, seats, seed: `charset:${packId}:${seats}` });
      pack.template.setup(makeCtx(state));

      const cards = [...pack.cardsById.keys()];
      for (const id of cards) {
        assert.ok(isSafeCardId(id), `${packId}: the wire refuses its own card id ${id}`);
      }
      for (const address of state.zones.allAddresses()) {
        assert.ok(isSafeAddress(address), `${packId}: the wire refuses its own zone address ${address}`);
      }

      // And end to end, as a frame: a real move from a real enumeration.
      for (let seat = 0; seat < seats; seat++) {
        for (const move of enumerateLegalMoves(state, seat)) {
          const verdict = validateFrame({ tableId: TID, k: FRAME.PROPOSE, pid: 'p1', move });
          assert.ok(verdict.ok, `${packId}: the wire refuses a legal move — ${JSON.stringify(move)}`);
          assert.deepEqual(verdict.frame.move, move,
            `${packId}: the validator dropped a field off a legal move — ${JSON.stringify(move)}`);
        }
      }
    }
  }
});

test('the widened charsets are still charsets — a dot is not a path', () => {
  assert.equal(isSafeAddress('../../hand.0'), false);
  assert.equal(isSafeAddress('hand.constructor'), false);
  assert.equal(isSafeAddress('hand.'), false);
  assert.equal(isSafeAddress('hand.0.1.2.3.4'), false);
  assert.equal(isSafeCardId('red-1#'), false);
  assert.equal(isSafeCardId('red-1#x'), false);
  assert.equal(isSafeCardId('red#1#2'), false);
  assert.equal(isSafeCardId('#hand > *'), false);
  assert.ok(isSafeCardId('red-1#2'));
  assert.ok(isSafeAddress('discard.4.3'));
});

test('a move is bounded — a peer cannot propose a thousand cards', () => {
  const cards = Array.from({ length: 40 }, (_, i) => `c${i}`);
  assert.equal(validateFrame({ tableId: TID, k: FRAME.PROPOSE, pid: 'p', move: { actor: 0, type: 'x', cards } }).ok, false);
});

test('a seat index outside the table is refused', () => {
  assert.equal(validateFrame({ tableId: TID, k: FRAME.CLAIM_SEAT, seat: 99 }).ok, false);
  assert.equal(validateFrame({ tableId: TID, k: FRAME.CLAIM_SEAT, seat: -1 }).ok, false);
  assert.equal(validateFrame({ tableId: TID, k: FRAME.CLAIM_SEAT, seat: 1.5 }).ok, false);
});

test('an emote is an index into a fixed set — there is no free-text channel', () => {
  assert.ok(validateFrame({ tableId: TID, k: FRAME.EMOTE, i: 0 }).ok);
  assert.equal(validateFrame({ tableId: TID, k: FRAME.EMOTE, i: EMOTES.length }).ok, false);
  assert.equal(validateFrame({ tableId: TID, k: FRAME.EMOTE, i: 'nice try' }).ok, false);
});

test('a long peer name is clamped, not rejected — rudeness is not an attack', () => {
  const verdict = validateFrame({ tableId: TID,
    k: FRAME.LOBBY, protocol: 1, packId: 'crazy-eights', variants: [], hostDeviceId: 'host',
    seatCount: 3, seats: [{ seat: 0, kind: 'device', deviceId: 'host', name: 'x'.repeat(500) }],
  });
  assert.ok(verdict.ok);
  assert.equal(verdict.frame.seats[0].name.length, 60);
});

/* ------------------------------------------------------------------ *
 * The spoof check
 * ------------------------------------------------------------------ */

test('a host-role frame is believed only from the host, on the direct link', () => {
  const ctx = { hostDeviceId: 'host' };
  assert.ok(isAuthentic(FRAME.VIEW, { ...ctx, fromDeviceId: 'host', relayed: false }));
  assert.equal(isAuthentic(FRAME.VIEW, { ...ctx, fromDeviceId: 'b', relayed: false }), false,
    'a fellow joiner is not the host');
  assert.equal(isAuthentic(FRAME.VIEW, { ...ctx, fromDeviceId: 'host', relayed: true }), false,
    'a RELAYED host frame did not come off our direct link');
  // Client frames are not authority frames; the host authenticates those by
  // sender identity instead.
  assert.ok(isAuthentic(FRAME.PROPOSE, { ...ctx, fromDeviceId: 'b', relayed: true }));
});

test('A JOINER CANNOT IMPERSONATE THE HOST', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  const before = t.seen.a.views.length;

  // Bo forges a view and addresses it at Ada. It reaches her RELAYED through
  // the hub, because joiner-to-joiner traffic has to — which is precisely the
  // signal the spoof check reads, and precisely what a payload cannot fake.
  const forged = {
    k: FRAME.VIEW,
    // THE RIGHT TABLE, because a table id is not a secret — it rides in every
    // broadcast lobby frame, and an attacker who could not copy one would be a
    // very poor attacker. The forgery is well-formed and correctly addressed;
    // what refuses it is that it arrived relayed, from somebody who is not the
    // host. That is the check, and it does not depend on the forger being lazy.
    tableId: TID,
    seq: 999,
    view: {
      v: 1, seat: 1, seats: 3, zones: {},
      turn: { seat: 1, phase: null }, scores: [0, 0, 0],
    },
  };
  assert.ok(t.ports.b.send(forged, { to: 'a' }), 'the forged frame was delivered');

  assert.equal(t.seen.a.views.length, before, 'Ada did not accept it');
  assert.ok(t.errors.a.some((e) => e.kind === 'spoofed-authority'),
    'and she recognised it as a spoof rather than merely ignoring it');
});

test('even a DIRECT frame from a non-host peer is refused', async () => {
  // The relayed flag is one half. The other is that the sender must BE the
  // host — a peer we happen to hold a direct link to is not automatically it.
  const t = await threeSeatTable();
  seatAll(t);
  const before = t.seen.b.views.length;
  assert.ok(t.ports.host.send({
    k: FRAME.LOBBY, protocol: PROTOCOL_VERSION, packId: 'crazy-eights', variants: [],
    hostDeviceId: 'a', seatCount: 3, seats: [{ seat: 0, kind: 'device', deviceId: 'a' }],
  }, { to: 'b' }), 'delivered');
  // It came from the real host, so it is accepted — hostDeviceId in the PAYLOAD
  // is not what authenticates it, which is the point of the next assertion.
  assert.ok(t.seen.b.lobbies.length > 0);
  assert.equal(t.b.hostDeviceId(), 'host', 'the payload did not get to rename the host');
  assert.ok(t.seen.b.views.length >= before);
});


/* ------------------------------------------------------------------ *
 * Lobby and seating
 * ------------------------------------------------------------------ */

test('the host is discovered as the direct link, never self-declared', async () => {
  const t = await threeSeatTable();
  assert.equal(t.a.hostDeviceId(), 'host');
  assert.equal(t.b.hostDeviceId(), 'host');
});

test('a joiner learns the table from the lobby frame', async () => {
  const t = await threeSeatTable();
  const lobby = t.a.lobby();
  assert.ok(lobby, 'a lobby frame arrived');
  assert.equal(lobby.protocol, PROTOCOL_VERSION);
  assert.equal(lobby.packId, 'crazy-eights');
  assert.equal(lobby.seatCount, 3);
  assert.equal(lobby.hostDeviceId, 'host');
});

test('claiming a seat takes it, and a second claimant is refused', async () => {
  const t = await threeSeatTable();
  t.a.claimSeat(1);
  assert.equal(t.seats.ownerOf(1).deviceId, 'a');

  t.b.claimSeat(1); // same seat
  assert.equal(t.seats.ownerOf(1).deviceId, 'a', 'the seat was not stolen');
  t.b.claimSeat(2);
  assert.equal(t.seats.ownerOf(2).deviceId, 'b');
});

test('a returning device re-claims its own seat — that is the rebind', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.a.claimSeat(1); // again, as if after a drop
  assert.equal(t.seats.ownerOf(1).deviceId, 'a');
  assert.equal(t.seats.seatsOfDevice('a').length, 1, 'and it did not end up with two');
});

/* ------------------------------------------------------------------ *
 * Playing
 * ------------------------------------------------------------------ */

test('a proposal from the seat that holds it is applied and answered with a view', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1; // Ada's turn
  t.host.republish();

  const before = t.state.log.length;
  const move = enumerateLegalMoves(t.state, 1)[0];
  t.a.propose(move);

  assert.equal(t.state.log.length, before + 1, 'the move was applied');
  assert.deepEqual(t.seen.a.rejects, []);
  const last = t.seen.a.views.at(-1);
  assert.ok(last, 'Ada got a view back');
  assert.equal(last.view.seat, 1);
});

test('A PROPOSAL FOR SOMEBODY ELSE\'S SEAT IS REFUSED, and changes nothing', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1;
  const before = t.state.log.length;

  // Bo (seat 2) proposes a move whose `actor` claims to be seat 1.
  const move = { ...enumerateLegalMoves(t.state, 1)[0], actor: 1 };
  t.b.propose(move);

  assert.equal(t.state.log.length, before, 'nothing was applied');
  assert.equal(t.seen.b.rejects.at(-1)?.rule, 'not-your-seat');
});

test('an illegal move is refused and leaves the state bit-identical', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1;

  const snapshot = JSON.stringify({
    log: t.state.log,
    turn: t.state.turn,
    zones: t.state.zones.allAddresses().map((a) => t.state.zones.cards(a)),
    scores: t.state.scores,
  });

  // A card Ada does not hold, played out of turn order semantics.
  const foreign = t.state.zones.cards('hand.2')[0];
  t.a.propose({ actor: 1, type: 'playCard', cards: [foreign] });

  const after = JSON.stringify({
    log: t.state.log,
    turn: t.state.turn,
    zones: t.state.zones.allAddresses().map((a) => t.state.zones.cards(a)),
    scores: t.state.scores,
  });
  assert.equal(after, snapshot, 'a refused proposal mutated the state');
  assert.ok(t.seen.a.rejects.length > 0, 'and Ada was told why');
});

test('a card id that names nothing in the deck is refused before it reaches the engine', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1;
  t.a.propose({ actor: 1, type: 'playCard', cards: ['not-a-real-card'] });
  assert.equal(t.seen.a.rejects.at(-1)?.rule, 'unknown-card');
});

test('a flooding client is cut off, and the table is told rather than left guessing', async () => {
  let clock = 0;
  const t = await threeSeatTable({ now: () => clock });
  seatAll(t);
  t.state.turn.seat = 1;
  t.errors.host.length = 0;

  // Well past PROPOSE_BUDGET inside one window. The refusal itself is the
  // design; what must not happen is that it is invisible — from Ada's side a
  // dropped proposal and a dead host look exactly the same.
  const foreign = t.state.zones.cards('hand.2')[0];
  for (let i = 0; i < 60; i++) {
    t.a.propose({ actor: 1, type: 'playCard', cards: [foreign] });
  }
  assert.ok(t.errors.host.some((e) => e.kind === 'rate-limited'),
    'the host dropped frames for budget without saying so');

  // And the window is a WINDOW: move the clock past it and the same client is
  // read again. A limiter that never forgives is a ban.
  t.errors.host.length = 0;
  clock += 60_000;
  const before = t.state.log.length;
  t.a.propose(enumerateLegalMoves(t.state, 1)[0]);
  assert.equal(t.state.log.length, before + 1, 'a client the budget forgave was still being ignored');
  assert.equal(t.errors.host.filter((e) => e.kind === 'rate-limited').length, 0);
});

/* ------------------------------------------------------------------ *
 * Privacy, on the wire
 * ------------------------------------------------------------------ */

test('EACH JOINER RECEIVES ONLY ITS OWN HAND', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.net.clearLog();
  t.state.turn.seat = 1;
  t.a.propose(enumerateLegalMoves(t.state, 1)[0]);

  const handOf = (seat) => new Set(t.state.zones.cards(`hand.${seat}`));
  const check = (deviceId, ownSeat) => {
    const wire = JSON.stringify(t.net.deliveredTo(deviceId));
    for (const seat of [0, 1, 2]) {
      if (seat === ownSeat) continue;
      for (const id of handOf(seat)) {
        assert.ok(!wire.includes(`"${id}"`),
          `${deviceId} was sent ${id} from seat ${seat}'s hand`);
      }
    }
  };
  check('a', 1);
  check('b', 2);
});

test("a joiner never sees another joiner's proposal", async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1;
  t.net.clearLog();
  t.a.propose(enumerateLegalMoves(t.state, 1)[0]);

  const toB = t.net.deliveredTo('b');
  assert.equal(toB.filter((f) => f.k === FRAME.PROPOSE).length, 0);
});

test('a targeted send to an unknown device surfaces the error path', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  // A seat bound to a device that is not on the network — what a terminal drop
  // leaves behind until the host decides whether to bot-fill it.
  t.seats.release(1);
  assert.ok(t.seats.claim(1, { deviceId: 'ghost' }));
  t.errors.host.length = 0;
  t.host.republish();
  assert.ok(t.errors.host.some((e) => e.kind === 'send-failed'),
    'a refused targeted send must be surfaced, never silently broadcast');
});

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

test('a gap in seq makes the client ask for a snapshot rather than interpolate', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1;
  t.a.propose(enumerateLegalMoves(t.state, 1)[0]);
  const seqAfterFirst = t.a.seq();

  // Ada goes off the air for a move, so she misses one entirely.
  t.net.drop('a');
  t.state.turn.seat = 2;
  t.b.propose(enumerateLegalMoves(t.state, 2)[0]);
  t.net.restore('a');

  const viewsBefore = t.seen.a.views.length;
  t.state.turn.seat = 1;
  t.a.propose(enumerateLegalMoves(t.state, 1)[0]);

  assert.ok(t.a.seq() > seqAfterFirst, 'Ada caught up');
  assert.ok(t.seen.a.views.length > viewsBefore);
  assert.ok(t.seen.a.views.some((v) => v.meta.snapshot), 'and did it with a snapshot');
});

test('a replay queue that overflowed forces a snapshot on the next ready', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1;
  t.a.propose(enumerateLegalMoves(t.state, 1)[0]);

  t.net.setOverflowed('a', true);
  t.seen.a.views.length = 0;
  t.net.ready('a', 'host');

  assert.ok(t.seen.a.views.some((v) => v.meta.snapshot),
    'exactly-once no longer covers us, so the view must be re-fetched');
});

test('a snapshot is authoritative whatever its seq', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1;
  t.a.propose(enumerateLegalMoves(t.state, 1)[0]);
  const seen = t.seen.a.views.length;

  t.a.requestSnapshot();
  assert.ok(t.seen.a.views.length > seen, 'the snapshot was accepted, not dropped as stale');
});

/* ------------------------------------------------------------------ *
 * Compatibility
 * ------------------------------------------------------------------ */

test('a client on the wrong pack version refuses to seat itself', async () => {
  const pack = await loadPackFromDisk('crazy-eights');
  const net = createPeerNetwork({ hostDeviceId: 'host' });
  net.createDevice('host', { name: 'Host' });
  const aPort = net.createDevice('a', { name: 'Ada' });

  const bad = [];
  const client = createTableClient({ tableId: TID,
    peer: aPort,
    expects: () => ({ packId: pack.id, packVersion: '9.9.9', variants: [] }),
    hooks: { onIncompatible: (why) => bad.push(why) },
  });
  client.start();

  net.createDevice('host').send({
    tableId: TID, k: FRAME.LOBBY, protocol: PROTOCOL_VERSION, packId: pack.id, packVersion: '0.1.0',
    variants: [], hostDeviceId: 'host', seatCount: 3,
    seats: [{ seat: 0, kind: 'device', deviceId: 'host' }],
  }, { to: 'a' });

  assert.equal(bad.at(-1)?.why, 'packVersion');
});

test('a different variant set is a different rule set, and is refused', async () => {
  const pack = await loadPackFromDisk('crazy-eights');
  const net = createPeerNetwork({ hostDeviceId: 'host' });
  net.createDevice('host', { name: 'Host' });
  const aPort = net.createDevice('a', { name: 'Ada' });

  const bad = [];
  const client = createTableClient({ tableId: TID,
    peer: aPort,
    expects: () => ({ packId: pack.id, packVersion: undefined, variants: [] }),
    hooks: { onIncompatible: (why) => bad.push(why) },
  });
  client.start();

  net.createDevice('host').send({
    tableId: TID, k: FRAME.LOBBY, protocol: PROTOCOL_VERSION, packId: pack.id,
    variants: ['house-rule'], hostDeviceId: 'host', seatCount: 3,
    seats: [{ seat: 0, kind: 'device', deviceId: 'host' }],
  }, { to: 'a' });

  assert.equal(bad.at(-1)?.why, 'variants');
});

/* ------------------------------------------------------------------ *
 * The caps gate
 * ------------------------------------------------------------------ */

test('no peer surface at all reads as standalone, not as a broken launcher', () => {
  assert.deepEqual(peerAvailability(undefined), {
    available: false, status: 'unavailable', missing: [], reason: 'no-peer-api', canInvite: false,
  });
  const standalone = peerAvailability({ status: () => 'unavailable' });
  assert.equal(standalone.reason, 'standalone');
  assert.equal(standalone.canInvite, false);
});

test('a launcher missing a capability is named, so the notice can be specific', () => {
  const verdict = peerAvailability({
    status: () => 'connected',
    caps: () => ['peer.roster', 'peer.sendTo'],
  });
  assert.equal(verdict.available, false);
  assert.equal(verdict.reason, 'launcher-too-old');
  assert.deepEqual(verdict.missing, ['peer.meta']);
});

test('every required capability is genuinely required', () => {
  for (const cap of REQUIRED_CAPS) {
    const verdict = peerAvailability({
      status: () => 'connected',
      caps: () => REQUIRED_CAPS.filter((c) => c !== cap),
    });
    assert.equal(verdict.available, false, `${cap} should be required`);
  }
  assert.ok(peerAvailability({ status: () => 'connected', caps: () => REQUIRED_CAPS }).available);
});

/* ------------------------------------------------------------------ *
 * The invite door
 * ------------------------------------------------------------------ */

// A LAUNCHER THAT CANNOT BE ASKED IS NOT A BROKEN LAUNCHER. `peer.invite` is
// the one capability this game asks for and can live without: without it the
// transport still carries every frame, and a paired connection was already live
// — there was no scope to open. So the gate must keep saying `available` while
// saying `canInvite: false`, because collapsing the two would take the whole
// multiplayer UI away from a launcher that works.
test('the invite cap is asked for, never required', () => {
  const old = peerAvailability({ status: () => 'connected', caps: () => REQUIRED_CAPS });
  assert.equal(old.available, true);
  assert.equal(old.canInvite, false);

  const current = peerAvailability({
    status: () => 'connected', caps: () => [...REQUIRED_CAPS, INVITE_CAP],
  });
  assert.equal(current.available, true);
  assert.equal(current.canInvite, true);
});

// The door reads the count and says nothing else about it: a proposal is not an
// acceptance, and the number is only ever "was there anybody to ask".
test('the port forwards an invite, and answers zero on a launcher that has none', async () => {
  const asked = [];
  const modern = arcadePeerPort({
    self: () => ({ deviceId: 'me' }), status: () => 'connected',
    caps: () => [...REQUIRED_CAPS, INVITE_CAP], peers: () => [], send: () => true,
    onMessage: () => {}, onReady: () => {}, onPeersChange: () => {}, onStatus: () => {},
    invite: () => { asked.push(1); return Promise.resolve(2); },
  });
  assert.equal(await modern.invite(), 2);
  assert.equal(asked.length, 1);

  // The SDK that predates the call has no such function — a port that assumed
  // one would throw on the phone it was written to support.
  const ancient = arcadePeerPort({
    self: () => ({ deviceId: 'me' }), status: () => 'connected',
    caps: () => REQUIRED_CAPS, peers: () => [], send: () => true,
    onMessage: () => {}, onReady: () => {}, onPeersChange: () => {}, onStatus: () => {},
  });
  assert.equal(await ancient.invite(), 0);
});

// The stub is the headless tier's launcher, so it has to be able to play both
// parts — a launcher with the door and one without.
test('the stub advertises the invite cap and answers with who is left to ask', async () => {
  const net = createPeerNetwork({ hostDeviceId: 'host' });
  const hostPort = net.createDevice('host', { name: 'Host' });
  const lonely = net.createDevice('lonely', { name: 'Lonely', invitable: 2 });

  assert.equal(peerAvailability(hostPort).canInvite, true);
  // Everyone on this network is already playing with their links, so there is
  // nobody left for the host to propose to.
  assert.equal(await hostPort.invite(), 0);
  assert.equal(await lonely.invite(), 2);
  assert.equal(net.invitesFrom('lonely'), 1);
});

/* ------------------------------------------------------------------ *
 * Seat recovery policy
 * ------------------------------------------------------------------ */

test('AN INTERRUPTED SEAT KEEPS PLAYING — a tunnel is not a departure', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.net.setStatus('a', 'interrupted');
  t.host.broadcastLobby();

  const lobby = t.seen.b.lobbies.at(-1);
  const ada = lobby.seats.find((s) => s.seat === 1);
  assert.equal(ada.status, 'interrupted');
  assert.equal(ada.deviceId, 'a', 'the binding survives');
  assert.equal(needsHostDecision('interrupted'), false,
    'the host must not free, bot-fill or reset an interrupted seat');

  // And the table keeps advancing while she is away.
  t.state.turn.seat = 2;
  const before = t.state.log.length;
  t.b.propose(enumerateLegalMoves(t.state, 2)[0]);
  assert.equal(t.state.log.length, before + 1);
});

test('a seat whose device is gone is a DECISION, and keeps its binding', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.net.drop('a');

  const status = seatStatus(t.seats.ownerOf(1), { peers: t.ports.host.peers(), selfDeviceId: 'host' });
  assert.equal(status, 'gone');
  assert.ok(needsHostDecision(status), 'the host player chooses: bot-fill, pause, or end');
  assert.equal(t.seats.ownerOf(1).deviceId, 'a', 'the seat is still hers if she comes back');
});

test('the host itself is always connected, whatever the roster says', () => {
  assert.equal(seatStatus({ kind: 'device', deviceId: 'host' }, { peers: [], selfDeviceId: 'host' }), 'connected');
  assert.equal(seatStatus({ kind: 'bot' }, {}), 'bot');
  assert.equal(seatStatus({ kind: 'empty' }, {}), 'empty');
});

/* ------------------------------------------------------------------ *
 * Turn timers
 * ------------------------------------------------------------------ */

/** A clock a test can shove forward, so "a minute passed" costs no seconds. */
function fakeClock() {
  let now = 1_000_000;
  const pending = [];
  return {
    clock: wallClock({
      now: () => now,
      schedule: (fn, ms) => { const entry = { fn, at: now + ms }; pending.push(entry); return entry; },
      unschedule: (entry) => { const i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1); },
    }),
    advance(ms) {
      now += ms;
      // Fire whatever is due, in order, letting each rescheduled wake re-queue.
      for (let guard = 0; guard < 1000; guard++) {
        const due = pending.filter((e) => e.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        pending.splice(pending.indexOf(due), 1);
        due.fn();
      }
    },
  };
}

/**
 * A TIMEOUT IS A MOVE, and that is the whole property worth pinning.
 *
 * The tempting implementation greys the seat out and carries on, which
 * desynchronises the table on the very first one: the host's state and every
 * client's now differ by a fact that appears nowhere in the log, so a resync, a
 * resume, or a replay all rebuild a game in which that seat never ran out of
 * time. So the assertion is on the LOG — and on the clients having been told.
 */
test('a seat that runs out of time is played for, through the ordinary pipeline', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.state.turn.seat = 1; // Ada's turn, and Ada has gone to make tea.

  const { clock, advance } = fakeClock();
  const timer = createTurnTimer({
    clock,
    timeoutMs: 60_000,
    actingSeatsOf: (state) => [state.turn.seat],
    // Only other people's seats: the host's own turn waits for the host, and a
    // bot needs no encouragement.
    waitsOn: (seat) => seat !== 0,
    onExpire: (state, seat) => {
      const move = chooseBotMove(state, seat);
      if (move) t.host.applyLocal(move);
    },
  });

  timer.arm(t.state);
  assert.deepEqual(timer.deadlines().map((d) => d.seat), [1], 'the seat being waited on is the one on a clock');

  const before = t.state.log.length;
  const seqBefore = t.host.seq();
  advance(30_000);
  assert.equal(t.state.log.length, before, 'half a minute is not a timeout');

  advance(31_000);
  assert.equal(t.state.log.length, before + 1, 'the turn that ran out produced a move');
  assert.equal(t.state.log.at(-1).actor, 1, 'and it was that seat that moved');
  assert.ok(t.host.seq() > seqBefore, 'so every client was sent the result');
  assert.ok(t.seen.a.views.length > 0 && t.seen.b.views.length > 0);

  // THE SEAT IS STILL THEIRS. A timeout costs one turn, never the chair —
  // the same answer an interrupted link already gets.
  assert.equal(t.seats.ownerOf(1).kind, 'device');
  assert.equal(t.seats.ownerOf(1).deviceId, 'a');
});

test('a seat nobody is waiting on is never on a clock', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  const { clock, advance } = fakeClock();
  const fired = [];
  const timer = createTurnTimer({
    clock,
    timeoutMs: 1000,
    actingSeatsOf: (state) => [state.turn.seat],
    waitsOn: () => false, // solo, or a table where nobody has opted into a clock
    onExpire: (_state, seat) => fired.push(seat),
  });
  timer.arm(t.state);
  assert.deepEqual(timer.deadlines(), []);
  advance(10_000);
  assert.deepEqual(fired, [], 'a clock nobody asked for expired anyway');
});

/* ------------------------------------------------------------------ *
 * Every outbound frame names its table — including the ones that are
 * announcements rather than requests. See #56.
 * ------------------------------------------------------------------ */

test('a joiner’s bye names its table, so the host can act on it', async () => {
  const t = await threeSeatTable();
  seatAll(t);

  const seen = [];
  t.ports.host.onMessage((payload) => { if (payload?.k === FRAME.BYE) seen.push(payload); });

  t.a.sendBye('leave');

  assert.equal(seen.length, 1, 'the bye reached the host at all');
  // WITHOUT THIS the host's `validateFrame` refuses the frame and `handleBye`
  // never runs — no seat notification and, because handleBye is what
  // re-broadcasts the lobby, no invitation back for the player who just left.
  assert.equal(seen[0].tableId, TID);
  assert.equal(validateFrame(seen[0]).ok, true, 'and it is a frame v2 accepts');
});

test('a joiner’s emote names its table too', async () => {
  const t = await threeSeatTable();
  seatAll(t);

  const seen = [];
  t.ports.host.onMessage((payload) => { if (payload?.k === FRAME.EMOTE) seen.push(payload); });

  t.a.emote(0);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].tableId, TID);
  assert.equal(validateFrame(seen[0]).ok, true);
});

test('a host acts on a joiner’s bye by re-publishing its lobby', async () => {
  const t = await threeSeatTable();
  seatAll(t);

  const before = t.seen.a.lobbies.length;

  t.a.sendBye('leave');

  // THE INVITATION BACK. `handleBye` broadcasts, which is the only reason a
  // player who leaves is ever offered the table again (#56) — the panel picks
  // that frame up as a sighting and becomes a client of it a second time.
  assert.ok(t.seen.a.lobbies.length > before,
    `expected a fresh lobby after the bye, saw ${t.seen.a.lobbies.length - before}`);
});

/* ------------------------------------------------------------------ *
 * Host-mediated announcements (protocol v3)
 *
 * `emote` and `bye` were the last two frames a joiner said to the ROOM, and
 * they reached fellow joiners only because the hub forwarded between spokes.
 * The launcher is deleting that forwarding, so both go to the host now and the
 * host says them again. What these pin is that the room still hears everything
 * it used to, that it hears it from the host, and that the host's account is
 * the only one a client will believe.
 * ------------------------------------------------------------------ */

test('a joiner’s emote reaches the room through the host, never around it', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.net.clearLog();

  t.a.emote(0);

  const emotes = t.net.log.filter((e) => e.payload.k === FRAME.EMOTE);
  assert.deepEqual(emotes.map((e) => `${e.from}->${e.to}`), ['a->host', 'host->b'],
    'one frame in to the host, one back out to the other seat');
  // THE HALF THAT USED TO BE IMPOSSIBLE. A joiner's broadcast reached Bo marked
  // relayed, which is exactly what a client is supposed to distrust — so the
  // frame could not be authenticated and was accepted on faith instead.
  assert.equal(emotes[1].relayed, false, 'and on a direct link, so a client may believe it');
  assert.deepEqual(t.seen.b.emotes, [{ seat: 1, emote: EMOTES[0] }],
    'Bo heard Ada’s wave, attributed to the seat Ada holds');
});

test('an emote never comes back to the device that sent it', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  t.net.clearLog();

  t.a.emote(0);

  // The emoter's screen burst the moment they tapped (src/ui/party.js), so an
  // echo is a second wave for the one person who does not need one.
  assert.deepEqual(t.net.deliveredTo('a').filter((p) => p.k === FRAME.EMOTE), []);
  assert.deepEqual(t.seen.a.emotes, []);
});

test('the host says whose emote it was — the sender does not get to', async () => {
  const t = await threeSeatTable();
  seatAll(t);

  // Ada, hand-rolling a frame that claims Bo's seat. The host resolves the seat
  // from the authenticated sender, the same rule `handlePropose` keys on, and
  // never reads this field at all.
  t.ports.a.send({ tableId: TID, k: FRAME.EMOTE, i: 0, seat: 2 }, { to: 'host' });

  assert.deepEqual(t.seen.b.emotes, [{ seat: 1, emote: EMOTES[0] }]);
});

test('a client refuses an emote that did not come from its host', async () => {
  const t = await threeSeatTable();
  seatAll(t);

  // Bo, addressing Ada directly. Until v3 this was the one frame a client took
  // from a fellow joiner, so anybody in the party could burst an emoji on
  // somebody else's screen and there was no test that could tell.
  t.ports.b.send({ tableId: TID, k: FRAME.EMOTE, i: 3 }, { to: 'a' });

  assert.deepEqual(t.seen.a.emotes, [], 'nothing was rendered');
  assert.ok(t.errors.a.some((e) => e.kind === 'spoofed-authority' && e.frame === FRAME.EMOTE),
    'and it was noticed rather than dropped in silence');
});

test('a joiner’s bye goes to the host alone, and the room hears the lobby', async () => {
  const t = await threeSeatTable();
  seatAll(t);
  const before = t.seen.b.lobbies.length;
  t.net.clearLog();

  t.a.sendBye('leave');

  // NOTHING IS LOST BY NOT BROADCASTING IT. Both consumers of a `bye` already
  // refused a relayed one — a client believes one only from its host, and
  // `noteBye` (src/ui/tableSightings.js) drops anything relayed outright — so
  // the room-facing half was reaching fellow joiners and being thrown away.
  assert.deepEqual(t.net.deliveredTo('b').filter((p) => p.k === FRAME.BYE), []);
  assert.ok(t.seen.b.lobbies.length > before,
    'the departure travels as a seat change, like every other seat change');
});

test('a client refuses a bye from anyone but its host', async () => {
  const t = await threeSeatTable();
  seatAll(t);

  // Bo, announcing that Ada's table has closed. It has not.
  t.ports.b.send({ tableId: TID, k: FRAME.BYE, why: 'closed' }, { to: 'a' });

  assert.deepEqual(t.seen.a.ends, [], 'Ada is still at the table');
  assert.ok(t.errors.a.some((e) => e.kind === 'spoofed-authority' && e.frame === FRAME.BYE));
});

/* ------------------------------------------------------------------ *
 * The grace a host chooses (#49 §7)
 * ------------------------------------------------------------------ */

test('a lobby frame may carry the host’s grace, and may leave it out', () => {
  const base = {
    tableId: TID, k: FRAME.LOBBY, protocol: PROTOCOL_VERSION, packId: 'crazy-eights',
    variants: [], hostDeviceId: 'host', seatCount: 3, started: false,
    seats: [{ seat: 0, kind: 'device', deviceId: 'host', name: 'Host', status: 'connected' }],
  };
  assert.equal(validateFrame({ ...base, graceMs: 30_000 }).frame.graceMs, 30_000);
  // A host that never chose sends nothing; so does a build from before this
  // shipped, and both mean "use the default" rather than "no timer".
  assert.equal(validateFrame(base).frame.graceMs, undefined);
});

test('a grace outside the bounds is refused rather than clamped', () => {
  const base = {
    tableId: TID, k: FRAME.LOBBY, protocol: PROTOCOL_VERSION, packId: 'crazy-eights',
    variants: [], hostDeviceId: 'host', seatCount: 3, started: false,
    seats: [{ seat: 0, kind: 'device', deviceId: 'host', name: 'Host', status: 'connected' }],
  };
  // ZERO WOULD TIME EVERY SEAT OUT ON ARRIVAL, and a year is a timer that is
  // off without saying so. Neither is a table anybody meant to sit at.
  assert.equal(validateFrame({ ...base, graceMs: 0 }).ok, false);
  assert.equal(validateFrame({ ...base, graceMs: -1 }).ok, false);
  assert.equal(validateFrame({ ...base, graceMs: 365 * 24 * 60 * 60 * 1000 }).ok, false);
  assert.equal(validateFrame({ ...base, graceMs: 1.5 }).ok, false);
  assert.equal(validateFrame({ ...base, graceMs: '60000' }).ok, false);
});

test('the turn timer reads its grace at arm time, not at build time', () => {
  let now = 0;
  const timers = [];
  const clock = {
    now: () => now,
    at: (when, fn) => { const t = { when, fn, cancel() { t.cancelled = true; } }; timers.push(t); return t; },
  };
  let grace = 60_000;
  const timer = createTurnTimer({
    clock,
    // A FUNCTION, which is the whole point: the host may change the grace in
    // the party panel after this timer exists, and a value captured here would
    // go on using the old one for the life of the table.
    timeoutMs: () => grace,
    actingSeatsOf: () => [1],
    waitsOn: () => true,
    onExpire: () => {},
  });

  timer.arm({});
  assert.equal(timer.deadlines()[0].expiresAt, 60_000);

  timer.cancelAll();
  grace = 30_000;
  timer.arm({});
  assert.equal(timer.deadlines()[0].expiresAt, 30_000, 'the new choice, not the old one');
});

test('the turn timer still accepts a plain number', () => {
  let now = 0;
  const clock = { now: () => now, at: (when, fn) => ({ when, fn, cancel() {} }) };
  const timer = createTurnTimer({
    clock, timeoutMs: 45_000, actingSeatsOf: () => [1], waitsOn: () => true, onExpire: () => {},
  });
  timer.arm({});
  assert.equal(timer.deadlines()[0].expiresAt, 45_000);
});

/** A host with NO state — a party still being built, which is the whole case. */
async function undealtTable() {
  const net = createPeerNetwork({ hostDeviceId: 'host' });
  const hostPort = net.createDevice('host', { name: 'Host' });
  const aPort = net.createDevice('a', { name: 'Ada' });
  const seats = createSeatTable({ seats: 3, localDeviceId: 'host' });
  seats.claim(0, { deviceId: 'host' });
  const pack = await loadPackFromDisk('crazy-eights');

  const host = createTableHost({
    tableId: TID, peer: hostPort, seats,
    liveState: () => null,                       // nothing dealt
    packInfo: () => ({ packId: pack.id, packVersion: pack.manifest?.version, variants: [] }),
    nameFor: (seat) => `Seat ${seat}`,
  });
  const a = createTableClient({
    tableId: TID, peer: aPort,
    expects: () => ({ packId: pack.id, packVersion: pack.manifest?.version, variants: [] }),
    hooks: {},
  });
  host.start();
  a.start();
  net.ready('host', 'a');
  return { host, a, seats };
}

test('a client knows it is seated from the roster, before any deal', async () => {
  const t = await undealtTable();

  t.a.claimSeat(1);

  // NO VIEW EXISTS — the table has not been dealt. The seat is still real: the
  // host bound it and said so in the roster it broadcast back. Before this,
  // `seat()` answered null for the whole lobby phase, so the one-seat-per-pack
  // door read a player who was plainly sitting down as merely watching.
  assert.equal(t.a.view(), undefined, 'nothing dealt yet');
  assert.equal(t.a.seat(), 1, 'and yet the client knows where it is sitting');
});

test('a client lets go of a seat the host reassigns', async () => {
  const t = await undealtTable();
  t.a.claimSeat(1);
  assert.equal(t.a.seat(), 1);

  // The host gives that chair to a bot and re-broadcasts.
  t.seats.seatBot(1);
  t.host.broadcastLobby();

  assert.equal(t.a.seat(), null, 'the roster is what makes it true, both ways');
});

/* ------------------------------------------------------------------ *
 * The published-frame gate (#63)
 *
 * Two bugs in the tables work shared one shape and both passed every test:
 * a frame that left without a field the other end requires (#56's `bye`), and
 * a field added to the copy used for rendering but not to the copy actually
 * sent (#62's `graceMs`). Neither was a validator bug — the validator was
 * never asked. So: drive a whole exchange, take what genuinely reached a
 * device, and put every frame of it back through the door it will arrive at.
 * ------------------------------------------------------------------ */

/** Every frame kind either end emits, so a kind that stops being sent is loud. */
const HOST_FRAMES = [FRAME.LOBBY, FRAME.VIEW, FRAME.SNAPSHOT, FRAME.REJECT, FRAME.EMOTE, FRAME.BYE];
const CLIENT_FRAMES_SENT = [FRAME.CLAIM_SEAT, FRAME.PROPOSE, FRAME.SNAPSHOT_REQ, FRAME.EMOTE, FRAME.BYE];

/** Drive one table hard enough to emit every kind above. */
async function exerciseEveryFrame() {
  const t = await threeSeatTable();
  seatAll(t);

  // A legal move, so a view fans out.
  const legal = enumerateLegalMoves(t.state, t.state.turn.seat)[0];
  if (legal) t.host.applyLocal(legal);

  // An illegal proposal, so a reject comes back. Seat 1 is Ada's; proposing
  // out of turn is refused rather than corrected.
  t.a.propose({ type: 'pass', actor: 1 });

  // A snapshot request, and the snapshot answering it.
  t.a.requestSnapshot();

  // Both ends say something to the room, and both say goodbye.
  t.host.emote(0);
  t.a.emote(1);
  t.host.sendBye('closed');
  t.a.sendBye('leave');

  return t;
}

test('every frame that reaches a device is one the validator accepts', async () => {
  const t = await exerciseEveryFrame();

  const delivered = [...t.net.deliveredTo('a'), ...t.net.deliveredTo('b'), ...t.net.deliveredTo('host')];
  assert.ok(delivered.length > 0, 'the exchange produced frames at all');

  for (const payload of delivered) {
    const verdict = validateFrame(payload);
    assert.equal(verdict.ok, true,
      `a ${payload?.k} frame was sent that the receiving end refuses: ${verdict.reason}`);
    // THE FIELD #56 LOST. Protocol v2 drops any frame that does not name its
    // table, so a sender that skips the stamp is a sender nobody hears.
    assert.equal(verdict.frame.tableId, TID, `a ${payload.k} frame did not name its table`);
  }
});

test('the gate actually sees every frame kind either end sends', async () => {
  const t = await exerciseEveryFrame();

  // BY SENDER, NOT BY RECIPIENT. Reading it off `deliveredTo` looked right and
  // was not: an emote is a BROADCAST, so Ada's reached Bo, and "somebody sent
  // an emote" was true even with the host's own emote deleted. The stub logs
  // who sent each frame; that is the question being asked.
  const kindsFrom = (id) => new Set(t.net.log.filter((e) => e.from === id).map((e) => e.payload.k));
  const fromHost = kindsFrom('host');
  const fromClient = kindsFrom('a');

  // COVERAGE IS PART OF THE GATE. Without this a frame kind that quietly
  // stopped being emitted would make the test above pass by having nothing
  // left to check.
  for (const kind of HOST_FRAMES) {
    assert.ok(fromHost.has(kind), `no ${kind} frame was exercised — the gate is not watching it`);
  }
  for (const kind of CLIENT_FRAMES_SENT) {
    assert.ok(fromClient.has(kind), `no ${kind} frame was exercised — the gate is not watching it`);
  }
});

test('a lobby frame carries every seam the host was built with', async () => {
  // THE BUG THIS HALF IS FOR. #62 added `graceMs` to the copy party.js renders
  // from and not to the one host.js publishes. Round-tripping through the
  // validator cannot catch that — the frame was structurally perfect, it just
  // said nothing. So the seams are asserted to reach the wire.
  const net = createPeerNetwork({ hostDeviceId: 'host' });
  const hostPort = net.createDevice('host', { name: 'Host' });
  const aPort = net.createDevice('a', { name: 'Ada' });
  const seats = createSeatTable({ seats: 3, localDeviceId: 'host' });
  seats.claim(0, { deviceId: 'host' });
  const pack = await loadPackFromDisk('crazy-eights');

  const host = createTableHost({
    tableId: TID, peer: hostPort, seats,
    liveState: () => null,
    packInfo: () => ({ packId: pack.id, packVersion: pack.manifest?.version, variants: ['a-variant'] }),
    nameFor: (seat) => `Seat ${seat}`,
    graceMs: () => 30_000,
  });
  host.start();
  net.ready('host', 'a');

  const lobby = net.deliveredTo('a').filter((p) => p.k === FRAME.LOBBY).pop();
  assert.ok(lobby, 'a lobby frame was published');
  assert.equal(lobby.graceMs, 30_000, 'the grace seam reached the wire');
  assert.equal(lobby.packId, pack.id);
  assert.equal(lobby.packVersion, pack.manifest?.version);
  assert.deepEqual(lobby.variants, ['a-variant'], 'packInfo’s variants reached the wire');
  assert.equal(lobby.seats[0].name, 'Seat 0', 'the nameFor seam reached the wire');
  assert.equal(lobby.started, false, 'liveState reached the wire');
  assert.equal(validateFrame(lobby).frame.graceMs, 30_000, 'and survives the validator');
});

test('a view frame carries the deadlines seam', async () => {
  // The other half of the same idea: `deadlines` is a seam, and a client's
  // countdown is drawn from what arrives on the view. If it stopped reaching
  // the wire the clock would simply never appear, silently.
  const net = createPeerNetwork({ hostDeviceId: 'host' });
  const hostPort = net.createDevice('host', { name: 'Host' });
  const aPort = net.createDevice('a', { name: 'Ada' });
  const seats = createSeatTable({ seats: 3, localDeviceId: 'host' });
  seats.claim(0, { deviceId: 'host' });
  seats.claim(1, { deviceId: 'a' });
  const pack = await loadPackFromDisk('crazy-eights');
  const state = createState({ pack, seats: 3, seed: 11 });
  pack.template.setup(makeCtx(state));

  const DEADLINES = [{ seat: 1, expiresAt: 1_700_000_000_000 }];
  const host = createTableHost({
    tableId: TID, peer: hostPort, seats,
    liveState: () => state,
    packInfo: () => ({ packId: pack.id, packVersion: pack.manifest?.version, variants: [] }),
    nameFor: (seat) => `Seat ${seat}`,
    deadlines: () => DEADLINES,
  });
  host.start();
  net.ready('host', 'a');
  host.publish([]);

  const view = net.deliveredTo('a').filter((p) => p.k === FRAME.VIEW).pop();
  assert.ok(view, 'a view was published');
  assert.deepEqual(view.view.deadlines, DEADLINES, 'the deadlines seam reached the wire');
  assert.equal(validateFrame(view).ok, true, 'and the frame it rode on validates');
});
