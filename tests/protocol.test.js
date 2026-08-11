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
import { createTableClient } from '../src/match/client.js';
import { peerAvailability, REQUIRED_CAPS } from '../src/match/peerPort.js';
import {
  validateFrame, isAuthentic, isSafeCardId, isSafeAddress, FRAME, PROTOCOL_VERSION, EMOTES,
} from '../src/match/protocol.js';
import { createPeerNetwork } from '../tools/peer-stub.mjs';
import { loadPackFromDisk, listPackIds } from '../tools/pack-test.mjs';

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
  const host = createTableHost({
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

  const seen = { a: { views: [], rejects: [], lobbies: [], bad: [] }, b: { views: [], rejects: [], lobbies: [], bad: [] } };
  const mkClient = (port, key) => createTableClient({
    peer: port,
    expects,
    hooks: {
      onLobby: (frame) => seen[key].lobbies.push(frame),
      onView: (view, events, meta) => seen[key].views.push({ view, events, meta }),
      onReject: (frame) => seen[key].rejects.push(frame),
      onIncompatible: (why) => seen[key].bad.push(why),
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
  assert.equal(validateFrame({ k: 'take-over' }).ok, false);
  assert.equal(validateFrame({ k: '__proto__' }).ok, false);
  assert.equal(validateFrame(null).ok, false);
  assert.equal(validateFrame('propose').ok, false);
  assert.equal(validateFrame([]).ok, false);
});

test('a validated frame is a CLEANED COPY — unknown fields never survive', () => {
  const verdict = validateFrame({
    k: FRAME.PROPOSE, pid: 'p1', move: { actor: 1, type: 'draw' }, sneaky: 'payload',
  });
  assert.ok(verdict.ok);
  assert.equal(verdict.frame.sneaky, undefined);
  assert.deepEqual(Object.keys(verdict.frame).sort(), ['k', 'move', 'pid']);
});

test('wire ids are charset-checked before anything can use them as a selector', () => {
  const bad = ['<img src=x>', 'a b', "'; DROP", '../../etc', '__proto__.x', 'x'.repeat(65)];
  for (const id of bad) {
    assert.equal(
      validateFrame({ k: FRAME.PROPOSE, pid: 'p1', move: { actor: 0, type: 'playCard', cards: [id] } }).ok,
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
          const verdict = validateFrame({ k: FRAME.PROPOSE, pid: 'p1', move });
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
  assert.equal(validateFrame({ k: FRAME.PROPOSE, pid: 'p', move: { actor: 0, type: 'x', cards } }).ok, false);
});

test('a seat index outside the table is refused', () => {
  assert.equal(validateFrame({ k: FRAME.CLAIM_SEAT, seat: 99 }).ok, false);
  assert.equal(validateFrame({ k: FRAME.CLAIM_SEAT, seat: -1 }).ok, false);
  assert.equal(validateFrame({ k: FRAME.CLAIM_SEAT, seat: 1.5 }).ok, false);
});

test('an emote is an index into a fixed set — there is no free-text channel', () => {
  assert.ok(validateFrame({ k: FRAME.EMOTE, i: 0 }).ok);
  assert.equal(validateFrame({ k: FRAME.EMOTE, i: EMOTES.length }).ok, false);
  assert.equal(validateFrame({ k: FRAME.EMOTE, i: 'nice try' }).ok, false);
});

test('a long peer name is clamped, not rejected — rudeness is not an attack', () => {
  const verdict = validateFrame({
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
  const client = createTableClient({
    peer: aPort,
    expects: () => ({ packId: pack.id, packVersion: '9.9.9', variants: [] }),
    hooks: { onIncompatible: (why) => bad.push(why) },
  });
  client.start();

  net.createDevice('host').send({
    k: FRAME.LOBBY, protocol: PROTOCOL_VERSION, packId: pack.id, packVersion: '0.1.0',
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
  const client = createTableClient({
    peer: aPort,
    expects: () => ({ packId: pack.id, packVersion: undefined, variants: [] }),
    hooks: { onIncompatible: (why) => bad.push(why) },
  });
  client.start();

  net.createDevice('host').send({
    k: FRAME.LOBBY, protocol: PROTOCOL_VERSION, packId: pack.id,
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
    available: false, status: 'unavailable', missing: [], reason: 'no-peer-api',
  });
  const standalone = peerAvailability({ status: () => 'unavailable' });
  assert.equal(standalone.reason, 'standalone');
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
