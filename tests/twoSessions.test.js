// TWO SESSIONS AT ONCE, HEADLESSLY — the net that goes under T3 (#48).
//
// T3 rewires session ownership in src/ui/table.js, which MULTIPLAYER_PLAN.md
// names as the one code path in this repo with no unit coverage. Everything
// here is written against the CURRENT code, so it passes before that refactor
// and keeps passing after it; the point is that a refactor which breaks one of
// these breaks it loudly rather than in somebody's evening game.
//
// THREE KINDS OF TEST LIVE HERE, and the difference matters:
//
//   1. ISOLATION — two tables that must not contaminate each other. These pass
//      today, because T1 gave the client its host by name rather than making it
//      guess from a roster that no longer has one answer.
//   2. REGRESSION — single-table behaviours T3 must preserve. They are not
//      about two tables at all; they are here because they are the properties
//      most likely to be quietly lost when the state moves house.
//   3. ROUTING — two hosts sharing one device's port. This one shipped here as
//      a `todo`, because it could not pass until every frame named its table:
//      each `createTableHost` subscribes to the same `onMessage`, and with
//      nothing to tell two tables apart a `claim-seat` meant for Hearts also
//      seated that device at Crazy Eights. Protocol v2 (#48) is what turned it
//      green, which is exactly the job it was written to define.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { enumerateLegalMoves } from '../src/engine/movePipeline.js';
import { viewFor, cardIdsIn } from '../src/engine/view.js';
import { createSeatTable } from '../src/players/seats.js';
import { createTableHost } from '../src/match/host.js';
import { createTableClient } from '../src/match/client.js';
import { createTurnTimer } from '../src/match/turnTimer.js';
import { wallClock } from '../src/match/clock.js';
import { FRAME } from '../src/match/protocol.js';
import { createPeerNetwork } from '../tools/peer-stub.mjs';
import { loadPackFromDisk } from '../tools/pack-test.mjs';

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** Controllable time plus setTimeout, in the shape src/match/clock.js wants. */
function testClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    schedule: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, delay), fn });
      return id;
    },
    unschedule: (id) => timers.delete(id),
    /** Move time and deliver, repeatedly, so a re-arming deadline converges. */
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length || guard++ > 100) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.fn();
      }
      now = target;
    },
  };
}

/**
 * One table: a real engine state, a real host, and the seat bindings.
 *
 * `seed` is a parameter because two tables running the SAME pack must deal
 * different hands — otherwise a cross-contamination test would pass by
 * coincidence, comparing two identical shuffles and calling them isolated.
 */
async function buildTable({ packId = 'crazy-eights', seed, hostDeviceId, port, joinerId, tableId }) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats: 3, seed });
  pack.template.setup(makeCtx(state));

  const seats = createSeatTable({ seats: 3, localDeviceId: hostDeviceId });
  seats.claim(0, { deviceId: hostDeviceId });
  if (joinerId) seats.claim(1, { deviceId: joinerId });
  seats.seatBot(2);

  const errors = [];
  const emotes = [];
  const host = createTableHost({
    peer: port,
    seats,
    tableId,
    liveState: () => state,
    packInfo: () => ({ packId: pack.id, packVersion: pack.manifest?.version, variants: pack.activeVariants ?? [] }),
    nameFor: (seat) => `Seat ${seat}`,
    hooks: { onError: (e) => errors.push(e), onEmote: (e) => emotes.push(e) },
  });
  return { pack, state, seats, host, errors, emotes, tableId, expects: () => ({
    packId: pack.id, packVersion: pack.manifest?.version, variants: pack.activeVariants ?? [],
  }) };
}

/** A client with everything it said recorded, so nothing has to be inferred. */
function watchedClient(port, hostDeviceId, expects, tableId) {
  const seen = { views: [], lobbies: [], ends: [], emotes: [], problems: [] };
  const client = createTableClient({
    peer: port,
    host: hostDeviceId,
    tableId,
    expects,
    hooks: {
      onLobby: (frame) => seen.lobbies.push(frame),
      onView: (view) => seen.views.push(view),
      onEnd: (why) => seen.ends.push(why),
      onEmote: (detail) => seen.emotes.push(detail),
      onIncompatible: (why) => seen.problems.push(why),
      onError: (err) => seen.problems.push(err),
    },
  });
  return { client, seen };
}

/* ------------------------------------------------------------------ *
 * 1. Isolation
 * ------------------------------------------------------------------ */

test('a device seated at two tables keeps two views, and never crosses them', async () => {
  const net = createPeerNetwork({ hostDeviceIds: ['ada', 'dana'] });
  const adaPort = net.createDevice('ada', { name: 'Ada' });
  const danaPort = net.createDevice('dana', { name: 'Dana' });
  const kitPort = net.createDevice('kit', { name: 'Kit' });

  // THE SAME PACK ON BOTH TABLES, deliberately. Different packs would make
  // every id disjoint by construction and the isolation would prove itself.
  const ada = await buildTable({ seed: 'ada-seed', hostDeviceId: 'ada', port: adaPort, joinerId: 'kit', tableId: 'tbl-ada' });
  const dana = await buildTable({ seed: 'dana-seed', hostDeviceId: 'dana', port: danaPort, joinerId: 'kit', tableId: 'tbl-dana' });

  const atAda = watchedClient(kitPort, 'ada', ada.expects, 'tbl-ada');
  const atDana = watchedClient(kitPort, 'dana', dana.expects, 'tbl-dana');
  atAda.client.start();
  atDana.client.start();

  ada.host.start();
  dana.host.start();
  // Interleaved on purpose: the order frames arrive in is not something either
  // client gets to assume.
  ada.host.publish([]);
  dana.host.publish([]);
  ada.host.publish([]);

  assert.ok(atAda.seen.views.length >= 1, 'Ada’s table reached its own client');
  assert.ok(atDana.seen.views.length >= 1, 'Dana’s table reached its own client');

  // EACH CLIENT HOLDS EXACTLY WHAT ITS OWN HOST COMPUTED FOR IT. Not "a
  // plausible view" — the same one, card for card.
  const adaOwn = viewFor(ada.state, 1, { moves: [], announcements: [], deadlines: [], seq: 0 });
  const danaOwn = viewFor(dana.state, 1, { moves: [], announcements: [], deadlines: [], seq: 0 });
  const ids = (payload) => [...cardIdsIn(payload, (id) => ada.pack.cardsById.has(id.split('#')[0]))].sort();

  assert.deepStrictEqual(ids(atAda.seen.views.at(-1).zones), ids(adaOwn.zones),
    'Kit’s view of Ada’s table is Ada’s view of Kit’s seat');
  assert.deepStrictEqual(ids(atDana.seen.views.at(-1).zones), ids(danaOwn.zones),
    'Kit’s view of Dana’s table is Dana’s view of Kit’s seat');
  assert.notDeepStrictEqual(ids(adaOwn.zones), ids(danaOwn.zones),
    'the two tables really did deal different hands — otherwise this proves nothing');

  // NEITHER CLIENT COMPLAINED ABOUT THE OTHER. Before every frame named its
  // table, the only tool for this was the authority check, so an honest frame
  // from the neighbouring host came back as `spoofed-authority` — an accusation
  // against somebody who had merely dealt a different game. Each client now
  // sees the id is not its own and ignores it without comment.
  assert.deepStrictEqual(atAda.seen.problems, [], 'Dana’s table is not an incident');
  assert.deepStrictEqual(atDana.seen.problems, [], 'nor is Ada’s');
});

test('one host closing ends one client, and leaves the other playing', async () => {
  const net = createPeerNetwork({ hostDeviceIds: ['ada', 'dana'] });
  const adaPort = net.createDevice('ada', { name: 'Ada' });
  const danaPort = net.createDevice('dana', { name: 'Dana' });
  const kitPort = net.createDevice('kit', { name: 'Kit' });

  const ada = await buildTable({ seed: 'a', hostDeviceId: 'ada', port: adaPort, joinerId: 'kit', tableId: 'tbl-ada' });
  const dana = await buildTable({ seed: 'd', hostDeviceId: 'dana', port: danaPort, joinerId: 'kit', tableId: 'tbl-dana' });
  const atAda = watchedClient(kitPort, 'ada', ada.expects, 'tbl-ada');
  const atDana = watchedClient(kitPort, 'dana', dana.expects, 'tbl-dana');
  atAda.client.start();
  atDana.client.start();
  ada.host.start();
  dana.host.start();

  adaPort.send({ k: FRAME.BYE, why: 'closed', tableId: 'tbl-ada' });

  assert.deepStrictEqual(atAda.seen.ends.map((e) => e.why), ['closed'],
    'the client of the table that closed was told');
  assert.deepStrictEqual(atDana.seen.ends, [],
    'the other table did not end because a different host went home');

  // The surviving table still delivers.
  const before = atDana.seen.views.length;
  dana.host.publish([]);
  assert.ok(atDana.seen.views.length > before, 'Dana’s table kept playing');
});

test('an emote is announced at the table it was made at, and nowhere else', async () => {
  const net = createPeerNetwork({ hostDeviceIds: ['ada', 'dana'] });
  const adaPort = net.createDevice('ada', { name: 'Ada' });
  const danaPort = net.createDevice('dana', { name: 'Dana' });
  const kitPort = net.createDevice('kit', { name: 'Kit' });

  const ada = await buildTable({ seed: 'a', hostDeviceId: 'ada', port: adaPort, joinerId: 'kit', tableId: 'tbl-ada' });
  const dana = await buildTable({ seed: 'd', hostDeviceId: 'dana', port: danaPort, joinerId: 'kit', tableId: 'tbl-dana' });
  const atAda = watchedClient(kitPort, 'ada', ada.expects, 'tbl-ada');
  const atDana = watchedClient(kitPort, 'dana', dana.expects, 'tbl-dana');
  atAda.client.start();
  atDana.client.start();
  ada.host.start();
  dana.host.start();

  atAda.client.emote(0);

  assert.deepStrictEqual(ada.emotes.map((e) => ({ deviceId: e.deviceId, seat: e.seat })),
    [{ deviceId: 'kit', seat: 1 }], 'Ada’s table heard it, from the seat Kit holds there');
  // TWO WAYS IT COULD HAVE CROSSED, AND BOTH ARE SHUT. Protocol v3 addresses a
  // joiner's emote to the one host it concerns, so Dana never sees Kit's frame
  // at all; and Ada's re-announcement goes out over every link she holds —
  // Dana's included — where the table id is what stops it being Dana's news.
  assert.deepStrictEqual(dana.emotes, [], 'Dana’s table was not told about it');
  assert.deepStrictEqual(atDana.seen.emotes, [], 'nor was the client sitting at it');
});

test('two turn timers keep their own clocks', () => {
  const clockA = testClock();
  const clockB = testClock();
  const firedA = [];
  const firedB = [];
  const stateA = { table: 'a' };
  const stateB = { table: 'b' };

  const timerA = createTurnTimer({
    clock: wallClock({ now: clockA.now, schedule: clockA.schedule, unschedule: clockA.unschedule }),
    timeoutMs: 10_000,
    actingSeatsOf: () => [1],
    waitsOn: () => true,
    onExpire: (_s, seat) => firedA.push(seat),
  });
  const timerB = createTurnTimer({
    clock: wallClock({ now: clockB.now, schedule: clockB.schedule, unschedule: clockB.unschedule }),
    timeoutMs: 10_000,
    actingSeatsOf: () => [2],
    waitsOn: () => true,
    onExpire: (_s, seat) => firedB.push(seat),
  });

  timerA.arm(stateA);
  timerB.arm(stateB);

  // ONE TABLE'S CLOCK RUNS OUT. The other's has not moved at all, which is the
  // whole property: a table nobody is looking at must not time out because a
  // different table did.
  clockA.advance(11_000);
  assert.deepStrictEqual(firedA, [1], 'the table whose clock ran fired');
  assert.deepStrictEqual(firedB, [], 'the table whose clock did not run did not');

  clockB.advance(11_000);
  assert.deepStrictEqual(firedB, [2], 'and it still fires on its own time');
  assert.deepStrictEqual(firedA, [1], 'without firing the first one twice');
});

/* ------------------------------------------------------------------ *
 * 2. Regressions T3 must preserve
 * ------------------------------------------------------------------ */

test('a re-claim is a rebind, not a refusal', async () => {
  const net = createPeerNetwork({ hostDeviceId: 'ada' });
  const adaPort = net.createDevice('ada', { name: 'Ada' });
  const kitPort = net.createDevice('kit', { name: 'Kit' });
  const ada = await buildTable({ seed: 'rebind', hostDeviceId: 'ada', port: adaPort, joinerId: 'kit', tableId: 'tbl-ada' });
  ada.host.start();

  // The whole of a returning player: ask again for the seat you already hold.
  kitPort.send({ k: FRAME.CLAIM_SEAT, seat: 1, localIndex: 0, tableId: 'tbl-ada' }, { to: 'ada' });

  assert.strictEqual(ada.seats.seatOf('kit', 0), 1, 'the seat is still theirs');
  const snapshots = net.deliveredTo('kit').filter((f) => f.k === FRAME.SNAPSHOT);
  assert.ok(snapshots.length >= 1, 'and they were caught up with a snapshot');
});

test('a gap in seq asks for a snapshot rather than guessing', async () => {
  const net = createPeerNetwork({ hostDeviceId: 'ada' });
  const adaPort = net.createDevice('ada', { name: 'Ada' });
  const kitPort = net.createDevice('kit', { name: 'Kit' });
  const ada = await buildTable({ seed: 'gap', hostDeviceId: 'ada', port: adaPort, joinerId: 'kit', tableId: 'tbl-ada' });
  const atAda = watchedClient(kitPort, 'ada', ada.expects, 'tbl-ada');
  atAda.client.start();
  ada.host.start();
  ada.host.publish([]);            // seq 1, accepted

  net.clearLog();
  // A view from the future: the client missed one and must not interpolate.
  adaPort.send({
    tableId: 'tbl-ada', k: FRAME.VIEW, seq: 99,
    view: viewFor(ada.state, 1, { moves: [], announcements: [], deadlines: [], seq: 99 }),
    events: [],
  }, { to: 'kit' });

  const asked = net.deliveredTo('ada').filter((f) => f.k === FRAME.SNAPSHOT_REQ);
  assert.strictEqual(asked.length, 1, 'exactly one snapshot request, not a guess');
});

test('the propose budget is per device, and says so when it bites', async () => {
  const net = createPeerNetwork({ hostDeviceId: 'ada' });
  const adaPort = net.createDevice('ada', { name: 'Ada' });
  const kitPort = net.createDevice('kit', { name: 'Kit' });
  const ada = await buildTable({ seed: 'budget', hostDeviceId: 'ada', port: adaPort, joinerId: 'kit', tableId: 'tbl-ada' });
  ada.host.start();

  const move = enumerateLegalMoves(ada.state, ada.state.turn.seat)[0];
  for (let i = 0; i < 60; i++) {
    kitPort.send({ k: FRAME.PROPOSE, pid: `p${i}`, move: { ...move, actor: 1 }, tableId: 'tbl-ada' }, { to: 'ada' });
  }
  assert.ok(ada.errors.some((e) => e.kind === 'rate-limited' && e.deviceId === 'kit'),
    'a refusal nobody is told about is indistinguishable from a crashed host');
});

/* ------------------------------------------------------------------ *
 * 3. Routing: what protocol v2 fixed (#48)
 * ------------------------------------------------------------------ */

/**
 * TWO HOSTS ON ONE DEVICE, sharing one port.
 *
 * Every `createTableHost` subscribes to `peer.onMessage`, so both of them see
 * every frame this device is handed. Under protocol v1 there was nothing in a
 * frame that said WHICH table it was for — `hostDeviceId` names the device, and
 * here both tables have the same one — so a `claim-seat` meant for Hearts was
 * also applied by the Crazy Eights host, seating that device at a table nobody
 * asked to sit down at, holding cards nobody dealt them.
 *
 * This test shipped `todo` for exactly one commit: it is the sentence protocol
 * v2 was written to make true, and the guard that makes it true is three lines
 * in `onMessage`. Left here as the routing regression, because a future frame
 * kind that forgets to carry its table breaks this and nothing else.
 */
test('two hosts on one device do not answer each other’s frames', async () => {
  const net = createPeerNetwork({ hostDeviceId: 'hub' });
  const hubPort = net.createDevice('hub', { name: 'Hub' });
  const kitPort = net.createDevice('kit', { name: 'Kit' });

  const eights = await buildTable({ packId: 'crazy-eights', seed: 'one', hostDeviceId: 'hub', port: hubPort, tableId: 'tbl-eights' });
  const hearts = await buildTable({ packId: 'hearts', seed: 'two', hostDeviceId: 'hub', port: hubPort, tableId: 'tbl-hearts' });
  eights.host.start();
  hearts.host.start();

  // Kit sits down at ONE table.
  kitPort.send({ k: FRAME.CLAIM_SEAT, seat: 1, localIndex: 0, tableId: 'tbl-hearts' }, { to: 'hub' });

  assert.strictEqual(hearts.seats.seatOf('kit', 0), 1, 'the table they asked for seated them');
  assert.strictEqual(eights.seats.seatOf('kit', 0), null,
    'the table they did not ask for did not');
});
