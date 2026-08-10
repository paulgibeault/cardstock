// The seat OWNERSHIP table (src/players/seats.js).
//
// What these pin is the pair of facts the shared table needs and the solo one
// never had to state: a seat index is not a player, and "mine" is a question
// about a device rather than about the number zero. The solo shape is asserted
// first and hardest, because every existing match is that shape and this
// package must not have changed one of them.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_DEVICE, createSeatTable, deserializeSeatTable, soloSeatTable,
} from '../src/players/seats.js';

test('the solo table is one local human at seat 0 and bots elsewhere', () => {
  const seats = soloSeatTable(4);
  assert.equal(seats.count, 4);
  assert.equal(seats.primaryLocalSeat(), 0);
  assert.deepEqual(seats.localSeats(), [0]);
  assert.ok(seats.isLocal(0));
  for (const seat of [1, 2, 3]) {
    assert.ok(seats.isBot(seat), `seat ${seat} is a bot`);
    assert.ok(!seats.isLocal(seat));
    assert.ok(!seats.isRemote(seat));
  }
});

test('a solo table can put the human somewhere other than seat 0', () => {
  const seats = soloSeatTable(3, { humanSeat: 2 });
  assert.equal(seats.primaryLocalSeat(), 2);
  assert.ok(seats.isBot(0));
  assert.ok(seats.isBot(1));
});

test('a fresh table owns nothing — an unseated joiner is a real state', () => {
  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  assert.equal(seats.primaryLocalSeat(), null);
  assert.deepEqual(seats.localSeats(), []);
  for (const seat of [0, 1, 2]) assert.ok(seats.isEmpty(seat));
});

test('local and remote are answered against THIS device, not the seat number', () => {
  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(0, { deviceId: 'them' });
  seats.claim(1, { deviceId: 'me' });
  seats.seatBot(2, 'juniper');

  assert.ok(seats.isRemote(0));
  assert.ok(!seats.isLocal(0));
  assert.ok(seats.isLocal(1));
  assert.equal(seats.primaryLocalSeat(), 1);
  assert.equal(seats.ownerOf(2).botId, 'juniper');
});

test('hotseat: one device holding two seats is distinguished by localIndex', () => {
  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  assert.ok(seats.claim(0, { deviceId: 'me', localIndex: 0 }));
  assert.ok(seats.claim(1, { deviceId: 'me', localIndex: 1 }));

  assert.deepEqual(seats.localSeats(), [0, 1]);
  assert.equal(seats.primaryLocalSeat(), 0);
  assert.equal(seats.seatOf('me', 0), 0);
  assert.equal(seats.seatOf('me', 1), 1);
  assert.deepEqual(seats.seatsOfDevice('me'), [0, 1]);
});

test('a claim on an occupied seat is refused, never stolen', () => {
  const seats = createSeatTable({ seats: 2, localDeviceId: 'me' });
  assert.ok(seats.claim(0, { deviceId: 'them' }));
  assert.ok(!seats.claim(0, { deviceId: 'me' }));
  assert.equal(seats.ownerOf(0).deviceId, 'them');
});

test('re-claiming your own seat succeeds — this is how a rebind lands', () => {
  const seats = createSeatTable({ seats: 2, localDeviceId: 'me' });
  seats.claim(1, { deviceId: 'them' });
  assert.ok(seats.claim(1, { deviceId: 'them' }));
  assert.equal(seats.seatOf('them'), 1);
});

test('one player cannot hold two seats at the same local index', () => {
  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(0, { deviceId: 'them' });
  assert.ok(!seats.claim(1, { deviceId: 'them' }));
  assert.ok(seats.isEmpty(1));
});

test('a bot may take over an occupied seat — the host fills for a drop', () => {
  const seats = createSeatTable({ seats: 2, localDeviceId: 'me' });
  seats.claim(0, { deviceId: 'them' });
  assert.ok(seats.seatBot(0, 'juniper'));
  assert.ok(seats.isBot(0));
  assert.equal(seats.seatOf('them'), null);
});

test('out-of-range seats answer safely instead of throwing', () => {
  const seats = createSeatTable({ seats: 2, localDeviceId: 'me' });
  assert.equal(seats.ownerOf(9).kind, 'empty');
  assert.equal(seats.ownerOf(-1).kind, 'empty');
  assert.ok(!seats.isLocal(9));
  assert.ok(!seats.claim(9, { deviceId: 'me' }));
  assert.ok(!seats.seatBot(9));
});

test('a seat count that is not a positive integer is refused loudly', () => {
  assert.throws(() => createSeatTable({ seats: 0 }), /positive integer/);
  assert.throws(() => createSeatTable({ seats: 2.5 }), /positive integer/);
});

test('serialize round-trips through JSON and carries no device opinion', () => {
  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(0, { deviceId: 'me', localIndex: 0 });
  seats.claim(1, { deviceId: 'them', localIndex: 0 });
  seats.seatBot(2, 'juniper');

  const wire = JSON.parse(JSON.stringify(seats.serialize()));

  // The SAME payload read by the other device makes THEIR seat the local one.
  const mine = deserializeSeatTable(wire, { localDeviceId: 'me' });
  const theirs = deserializeSeatTable(wire, { localDeviceId: 'them' });
  assert.equal(mine.primaryLocalSeat(), 0);
  assert.equal(theirs.primaryLocalSeat(), 1);
  assert.ok(mine.isRemote(1));
  assert.ok(theirs.isRemote(0));
  assert.equal(mine.ownerOf(2).botId, 'juniper');
});

test('deserialize refuses a malformed payload rather than guessing', () => {
  assert.equal(deserializeSeatTable(null), null);
  assert.equal(deserializeSeatTable({ seats: 3, owners: [] }), null);
  assert.equal(deserializeSeatTable({ seats: 0, owners: [] }), null);
  assert.equal(deserializeSeatTable({ owners: [{ kind: 'empty' }] }), null);
});

test('owner records are frozen, so a caller cannot edit the table through one', () => {
  const seats = soloSeatTable(2);
  const owner = seats.ownerOf(0);
  assert.throws(() => { owner.deviceId = 'someone-else'; }, TypeError);
});

test('LOCAL_DEVICE is what solo binds to, so solo and shared ask one question', () => {
  const seats = soloSeatTable(2);
  assert.equal(seats.ownerOf(0).deviceId, LOCAL_DEVICE);
  assert.equal(seats.ownerOf(0).localIndex, 0);
});
