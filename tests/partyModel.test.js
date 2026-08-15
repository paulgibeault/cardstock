// THE FIRST UNIT COVERAGE ANY PARTY-SIDE CODE HAS EVER HAD.
//
// TABLES_PLAN §11 records the gap and what it cost: "src/ui/party.js, table.js
// and lobby.js still have no unit coverage. Every bug listed above was found by
// driving the real thing" — three browsers, a real transport, and a scenario
// written after each bug rather than before it.
//
// src/ui/partyModel.js is pure (#75), so the cases that used to need three
// launchers are ordinary tests: a table superseded while the panel is looking
// at it, a host rehydrating while a joiner holds a stub, a seat replaced
// mid-hand, the presence asymmetry between our own table and a neighbour's.
//
// NOTHING HERE STUBS THE MODEL'S OWN LOGIC. The sessions are real
// `createTableSession` objects and the directory entries are the shape
// `createTableDirectory` produces, because a test that invents its own inputs
// proves the test's idea of the shape, not the program's.

import { test } from 'node:test';
import assert from 'node:assert';

import {
  partyModel, tableOf, focusedTable, boundTable, packState,
} from '../src/ui/partyModel.js';
import { createTableSession } from '../src/match/tableSession.js';
import { createTableDirectory } from '../src/match/tableDirectory.js';
import { createSeatTable } from '../src/players/seats.js';

const ME = 'device-me';
const ADA = 'device-ada';
const BO = 'device-bo';

/** A lobby frame in the shape src/match/host.js publishes one. */
function lobbyFrame({
  tableId = 't1a1a1a1a1a1a1a1a1a', hostDeviceId = ADA, packId = 'hearts',
  seats = null, started = false, graceMs = 60_000, variants = [],
} = {}) {
  return {
    tableId, hostDeviceId, packId, variants, graceMs, started,
    seatCount: (seats || defaultSeats(hostDeviceId)).length,
    seats: seats || defaultSeats(hostDeviceId),
  };
}

const defaultSeats = (hostDeviceId) => [
  { seat: 0, kind: 'device', deviceId: hostDeviceId, name: 'Ada', status: 'connected' },
  { seat: 1, kind: 'bot', name: 'Otto', status: 'bot' },
  { seat: 2, kind: 'empty', status: 'empty' },
];

/** The directory's own entry shape, built by the directory itself. */
function sightingsOf(...frames) {
  const directory = createTableDirectory({ now: () => 1000 });
  for (const frame of frames) directory.sight(frame);
  return directory.all();
}

function joinerSession(tableId, packId, { seat = null } = {}) {
  const session = createTableSession({ tableId, packId, role: 'joiner' });
  session.client = { seat: () => seat, hostDeviceId: () => ADA };
  return session;
}

function hostSession(tableId, packId, { seats = 3, state = null } = {}) {
  const session = createTableSession({ tableId, packId, role: 'host' });
  session.seats = createSeatTable({ seats, localDeviceId: ME });
  session.seats.claim(0, { deviceId: ME });
  session.seats.seatBot(1);
  session.state = state;
  return session;
}

const base = { self: ME, myName: 'You', publishedName: 'Me', packNameOf: () => null };

/* ------------------------------------------------------------------ *
 * The merge: live sightings and dormant stubs are one list
 * ------------------------------------------------------------------ */

test('a sighted table and a seat stub for it are one entry, not two', () => {
  const frame = lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a' });
  const model = partyModel({
    ...base,
    sightings: sightingsOf(frame),
    stubs: [{ tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ADA, packId: 'hearts', seat: 2, hostName: 'Ada', lastSeenAt: 500 }],
  });
  assert.strictEqual(model.tables.length, 1);
  assert.strictEqual(model.tables[0].liveness, 'live');
});

test('a seat stub nobody is advertising is a dormant entry, and says offline', () => {
  const model = partyModel({
    ...base,
    sightings: [],
    stubs: [{ tableId: 't2b2b2b2b2b2b2b2b2b', hostDeviceId: ADA, packId: 'hearts', seat: 1, hostName: 'Ada', lastSeenAt: 500 }],
  });
  assert.strictEqual(model.tables.length, 1);
  const view = model.tables[0];
  assert.strictEqual(view.liveness, 'offline');
  assert.strictEqual(view.relation, 'seated');
  assert.strictEqual(view.mySeat, 1);
  // The name was captured while the host was still on the roster; `peers` is
  // empty here, which is exactly the state a dormant tile is drawn in.
  assert.strictEqual(view.hostName, 'Ada');
});

test('live tables keep directory order, and dormant ones come after', () => {
  const first = lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a', packId: 'hearts' });
  const second = lobbyFrame({ tableId: 't2b2b2b2b2b2b2b2b2b', hostDeviceId: BO, packId: 'crazy-eights' });
  const model = partyModel({
    ...base,
    sightings: sightingsOf(first, second),
    stubs: [{ tableId: 't3c3c3c3c3c3c3c3c3c', hostDeviceId: BO, packId: 'gin', seat: 0, hostName: 'Bo', lastSeenAt: 1 }],
  });
  assert.deepStrictEqual(model.tables.map((v) => [v.tableId, v.liveness]), [
    ['t1a1a1a1a1a1a1a1a1a', 'live'],
    ['t2b2b2b2b2b2b2b2b2b', 'live'],
    ['t3c3c3c3c3c3c3c3c3c', 'offline'],
  ]);
});

/* ------------------------------------------------------------------ *
 * Relation — what we are to a table
 * ------------------------------------------------------------------ */

test('hosting, seated, watching and none are four different answers', () => {
  const mine = lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts' });
  const sat = lobbyFrame({
    tableId: 't2b2b2b2b2b2b2b2b2b',
    packId: 'crazy-eights',
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada' },
      { seat: 1, kind: 'device', deviceId: ME, name: 'Me' }],
  });
  const watched = lobbyFrame({ tableId: 't3c3c3c3c3c3c3c3c3c', hostDeviceId: BO, packId: 'gin' });
  const stranger = lobbyFrame({ tableId: 't4d4d4d4d4d4d4d4d4d', hostDeviceId: BO, packId: 'rummy' });

  const model = partyModel({
    ...base,
    sightings: sightingsOf(mine, sat, watched, stranger),
    sessions: [
      hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts'),
      joinerSession('t2b2b2b2b2b2b2b2b2b', 'crazy-eights', { seat: 1 }),
      joinerSession('t3c3c3c3c3c3c3c3c3c', 'gin', { seat: null }),
    ],
  });
  assert.deepStrictEqual(model.tables.map((v) => v.relation),
    ['hosting', 'seated', 'watching', 'none']);
});

/* ------------------------------------------------------------------ *
 * Presence — the asymmetry is the rule, not a detail
 * ------------------------------------------------------------------ */

test('our own table reads presence from the transport, so a peer off the roster is gone', () => {
  const session = hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts');
  session.seats.claim(2, { deviceId: BO });
  const frame = lobbyFrame({
    tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts',
    seats: [{ seat: 0, kind: 'device', deviceId: ME, name: 'Me', status: 'connected' },
      { seat: 1, kind: 'bot', name: 'Otto' },
      // The FRAME still says connected — it is the roster below that is the
      // authority for our own table, and the whole point of this test.
      { seat: 2, kind: 'device', deviceId: BO, name: 'Bo', status: 'connected' }],
  });
  const model = partyModel({
    ...base, sightings: sightingsOf(frame), sessions: [session], peers: [],
  });
  const seats = model.tables[0].seats;
  assert.strictEqual(seats[2].presence, 'gone', 'Bo is not on the transport roster');
  assert.strictEqual(seats[0].presence, 'connected', 'our own seat is always connected');
  assert.strictEqual(seats[1].presence, 'bot');
});

test("a neighbour's table reads presence from the frame, because our roster cannot see fellow joiners", () => {
  const frame = lobbyFrame({
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada', status: 'connected' },
      { seat: 1, kind: 'device', deviceId: BO, name: 'Bo', status: 'interrupted' }],
  });
  const model = partyModel({
    ...base,
    sightings: sightingsOf(frame),
    // Bo is NOT in our peers — a joiner's roster holds only its host. Reading
    // that silence as absence would show every other player as having left.
    peers: [{ deviceId: ADA, name: 'Ada', direct: true }],
  });
  const seats = model.tables[0].seats;
  assert.strictEqual(seats[1].presence, 'interrupted', "the host's word, not our silence");
});

test('the presence cap overrides a frame when the launcher has it', () => {
  const frame = lobbyFrame({
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada', status: 'connected' },
      { seat: 1, kind: 'device', deviceId: BO, name: 'Bo', status: 'connected' }],
  });
  const model = partyModel({
    ...base,
    sightings: sightingsOf(frame),
    presence: [{ deviceId: BO, status: 'gone' }],
  });
  assert.strictEqual(model.tables[0].seats[1].presence, 'gone');
});

/* ------------------------------------------------------------------ *
 * Names — the two strings for ourselves, and the two authorities
 * ------------------------------------------------------------------ */

test('we are "You" on our own screen and our published name in the roster we send', () => {
  const frame = lobbyFrame({
    tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts',
    seats: [{ seat: 0, kind: 'device', deviceId: ME, name: 'Me' },
      { seat: 1, kind: 'device', deviceId: ADA, name: 'Ada' }],
  });
  const dealt = hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts');
  // SEATING PRESENT means the table has been through a seat change or a deal,
  // which is also — see the note in seatingFromRoster — what currently decides
  // whether a host trusts its live roster over the frame. The next test pins
  // the other side of that conflation so it cannot drift unnoticed.
  dealt.seating = [];

  const model = partyModel({
    ...base,
    myName: 'You',
    publishedName: 'Paul',
    sightings: sightingsOf(frame),
    sessions: [dealt],
    peers: [{ deviceId: ADA, name: 'Ada Live', direct: true }],
  });
  const seats = model.tables[0].seats;
  assert.strictEqual(seats[0].name, 'You');
  assert.strictEqual(seats[0].shortName, 'You');
  // A HOST TRUSTS ITS OWN ROSTER over the frame it published a moment ago, so a
  // peer who renames themselves is current on the host's screen.
  assert.strictEqual(seats[1].name, 'Ada Live');
});

test('CURRENT BEHAVIOUR: before the deal, a host reads names off its own frame', () => {
  // NOT AN ENDORSEMENT — this pins what ships today so the conflation named in
  // seatingFromRoster cannot be changed by accident. A host whose table has no
  // `seating` yet (between `hostGame` and the first seat change) shows the name
  // its own frame carries rather than the live one. Cosmetic, narrow, real.
  const frame = lobbyFrame({
    tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts',
    seats: [{ seat: 0, kind: 'device', deviceId: ME, name: 'Me' },
      { seat: 1, kind: 'device', deviceId: ADA, name: 'Ada' }],
  });
  const model = partyModel({
    ...base,
    sightings: sightingsOf(frame),
    sessions: [hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts')], // seating still null
    peers: [{ deviceId: ADA, name: 'Ada Live', direct: true }],
  });
  assert.strictEqual(model.tables[0].seats[1].name, 'Ada',
    'the frame, not the roster — #79 fixes this and rewrites this test with it');
});

test('a joiner takes a fellow joiner\'s name from the frame, since its roster holds only the host', () => {
  const frame = lobbyFrame({
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada' },
      { seat: 1, kind: 'device', deviceId: BO, name: 'Bo From The Frame' }],
  });
  const model = partyModel({
    ...base,
    sightings: sightingsOf(frame),
    peers: [{ deviceId: ADA, name: 'Ada', direct: true }],
  });
  assert.strictEqual(model.tables[0].seats[1].name, 'Bo From The Frame');
});

test('a peer name is clamped and never becomes markup', () => {
  const hostile = '<img src=x onerror="alert(1)">'.repeat(4);
  const frame = lobbyFrame({
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: hostile }],
  });
  const model = partyModel({ ...base, sightings: sightingsOf(frame) });
  const name = model.tables[0].seats[0].name;
  assert.strictEqual(name.length, 60, 'clamped to 60');
  assert.strictEqual(name, hostile.slice(0, 60), 'verbatim — escaping is the DOM layer\'s job, via textContent');
});

test('a host keeps its own bot faces; a joiner derives them from the host device id', () => {
  const frame = lobbyFrame({
    tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts',
    seats: [{ seat: 0, kind: 'device', deviceId: ME, name: 'Me' },
      { seat: 1, kind: 'bot', name: 'Otto' }],
  });
  const session = hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts');
  session.seating = [null, Object.freeze({ seat: 1, name: 'Bruno', isBot: true, icon: '🐻', color: '#fff', initials: 'BR' })];

  const asHost = partyModel({ ...base, sightings: sightingsOf(frame), sessions: [session] });
  assert.strictEqual(asHost.tables[0].seats[1].name, 'Bruno', "the felt's own bot, not a second derivation");

  // The same frame seen by a device that is NOT its host takes the published
  // name — borrowing our own felt's seating would put our bots on their chairs.
  const asStranger = partyModel({ ...base, self: BO, sightings: sightingsOf(frame) });
  assert.strictEqual(asStranger.tables[0].seats[1].name, 'Otto');
});

/* ------------------------------------------------------------------ *
 * The cases that used to need three browsers
 * ------------------------------------------------------------------ */

test('a seat replaced mid-hand stops being ours the moment the roster says so', () => {
  const held = lobbyFrame({
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada' },
      { seat: 1, kind: 'device', deviceId: ME, name: 'Me' }],
  });
  const replaced = lobbyFrame({
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada' },
      { seat: 1, kind: 'bot', name: 'Otto' }],
  });
  const before = partyModel({ ...base, sightings: sightingsOf(held) });
  assert.strictEqual(before.tables[0].mySeat, 1);
  const after = partyModel({ ...base, sightings: sightingsOf(replaced) });
  assert.strictEqual(after.tables[0].mySeat, null, 'the host gave it away; the promise is void');
});

test('a host rehydrating while we hold a stub returns one live entry, seat intact', () => {
  const stub = { tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ADA, packId: 'hearts', seat: 1, hostName: 'Ada', lastSeenAt: 10 };
  const asleep = partyModel({ ...base, sightings: [], stubs: [stub] });
  assert.strictEqual(asleep.tables[0].liveness, 'offline');
  assert.strictEqual(asleep.tables[0].mySeat, 1);

  const woken = lobbyFrame({
    tableId: 't1a1a1a1a1a1a1a1a1a',
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada' },
      { seat: 1, kind: 'device', deviceId: ME, name: 'Me' }],
  });
  const back = partyModel({ ...base, sightings: sightingsOf(woken), stubs: [stub] });
  assert.strictEqual(back.tables.length, 1, 'one table, not a live one beside a dormant one');
  assert.strictEqual(back.tables[0].liveness, 'live');
  assert.strictEqual(back.tables[0].mySeat, 1);
});

test('a table superseded while focused leaves the focus pointing at nothing', () => {
  // The directory has already forgotten the old table (tableSightings.js does
  // that); the panel is still pointed at its key. The model must not invent it.
  const fresh = lobbyFrame({ tableId: 't9z9z9z9z9z9z9z9z9z' });
  const model = partyModel({
    ...base, sightings: sightingsOf(fresh), focusedKey: 't1a1a1a1a1a1a1a1a1a',
  });
  assert.strictEqual(focusedTable(model), null);
  assert.strictEqual(tableOf(model, 't1a1a1a1a1a1a1a1a1a'), null);
});

test('a device hosting two packs answers about each table separately', () => {
  const hearts = lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts', started: true });
  const eights = lobbyFrame({ tableId: 't2b2b2b2b2b2b2b2b2b', hostDeviceId: ME, packId: 'crazy-eights', started: false });
  const dealt = hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts', { state: { isView: false } });
  dealt.bound = true;
  const model = partyModel({
    ...base,
    sightings: sightingsOf(hearts, eights),
    sessions: [dealt, hostSession('t2b2b2b2b2b2b2b2b2b', 'crazy-eights')],
    focusedKey: 't2b2b2b2b2b2b2b2b2b',
  });
  assert.strictEqual(boundTable(model).tableId, 't1a1a1a1a1a1a1a1a1a');
  assert.strictEqual(focusedTable(model).tableId, 't2b2b2b2b2b2b2b2b2b');
  assert.strictEqual(tableOf(model, 't1a1a1a1a1a1a1a1a1a').hasState, true);
  assert.strictEqual(tableOf(model, 't2b2b2b2b2b2b2b2b2b').hasState, false);
  assert.strictEqual(tableOf(model, 't1a1a1a1a1a1a1a1a1a').stage, 'in progress');
  assert.strictEqual(tableOf(model, 't2b2b2b2b2b2b2b2b2b').stage, 'waiting to deal');
});

test('unreachable is per table, so a failed send at one says nothing about the other', () => {
  const mine = lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts' });
  const other = lobbyFrame({ tableId: 't2b2b2b2b2b2b2b2b2b', hostDeviceId: ME, packId: 'crazy-eights' });
  const first = hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts');
  first.unreachable.add(1);
  const model = partyModel({
    ...base,
    sightings: sightingsOf(mine, other),
    sessions: [first, hostSession('t2b2b2b2b2b2b2b2b2b', 'crazy-eights')],
  });
  assert.strictEqual(tableOf(model, 't1a1a1a1a1a1a1a1a1a').seats[1].unreachable, true);
  assert.strictEqual(tableOf(model, 't2b2b2b2b2b2b2b2b2b').seats[1].unreachable, false);
});

/* ------------------------------------------------------------------ *
 * What the lobby tile says about a pack
 * ------------------------------------------------------------------ */

test('a dealt hosted table takes over its pack tile; an undealt one does not', () => {
  const frame = lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts' });
  const undealt = partyModel({
    ...base, sightings: sightingsOf(frame), sessions: [hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts')],
  });
  assert.strictEqual(packState(undealt, 'hearts'), null);

  const dealt = partyModel({
    ...base,
    sightings: sightingsOf(frame),
    sessions: [hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts', { state: { isView: false } })],
  });
  assert.deepStrictEqual(packState(dealt, 'hearts'),
    { kind: 'hosting', tableId: 't1a1a1a1a1a1a1a1a1a', seatsOpen: 2 });
});

test('a seat at a table nobody is advertising is dormant, and belongs to the Tables row', () => {
  const stub = { tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ADA, packId: 'hearts', seat: 1, hostName: 'Ada', lastSeenAt: 10 };
  const session = joinerSession('t1a1a1a1a1a1a1a1a1a', 'hearts', { seat: 1 });

  const offline = partyModel({ ...base, sightings: [], stubs: [stub], sessions: [session] });
  assert.strictEqual(packState(offline, 'hearts'), null, 'no live table: the tile stays a game tile');

  const frame = lobbyFrame({
    tableId: 't1a1a1a1a1a1a1a1a1a',
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada' },
      { seat: 1, kind: 'device', deviceId: ME, name: 'Me' }],
  });
  const live = partyModel({
    ...base,
    sightings: sightingsOf(frame),
    stubs: [stub],
    sessions: [session],
    // A LIVE SIGHTING MEANS THE HOST IS A DIRECT PEER — that is what
    // tableSightings.js authenticates before filing one, so this is the roster
    // a live table is always drawn against. With the host absent from `peers`
    // the name falls to "Someone" rather than to the stub's captured `hostName`;
    // that fallback would be an improvement and is deliberately not made here
    // (#78 is the aging/flicker work #75 deferred).
    peers: [{ deviceId: ADA, name: 'Ada', direct: true }],
  });
  assert.deepStrictEqual(packState(live, 'hearts'),
    { kind: 'seated', tableId: 't1a1a1a1a1a1a1a1a1a', seat: 1, hostName: 'Ada' });
});

/* ------------------------------------------------------------------ *
 * Deadlines, grace, and the empty room
 * ------------------------------------------------------------------ */

test('deadlines come from our own timer when we host and from the view when we do not', () => {
  const mine = lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts' });
  const theirs = lobbyFrame({ tableId: 't2b2b2b2b2b2b2b2b2b', packId: 'crazy-eights' });
  const hosted = hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts');
  hosted.timer = { deadlines: () => [{ seat: 1, expiresAt: 5000 }] };
  const joined = joinerSession('t2b2b2b2b2b2b2b2b2b', 'crazy-eights', { seat: 1 });
  joined.state = { deadlines: [{ seat: 0, expiresAt: 7000 }] };

  const model = partyModel({
    ...base, sightings: sightingsOf(mine, theirs), sessions: [hosted, joined],
  });
  assert.strictEqual(tableOf(model, 't1a1a1a1a1a1a1a1a1a').seats[1].deadlineAt, 5000);
  assert.strictEqual(tableOf(model, 't2b2b2b2b2b2b2b2b2b').seats[0].deadlineAt, 7000);
});

test("a table's grace is the host's rule, not a constant compiled into our build", () => {
  const frame = lobbyFrame({ graceMs: 300_000 });
  const model = partyModel({ ...base, sightings: sightingsOf(frame) });
  assert.strictEqual(model.tables[0].graceMs, 300_000);

  const silent = partyModel({ ...base, sightings: sightingsOf(lobbyFrame({ graceMs: 0 })) });
  assert.strictEqual(silent.tables[0].graceMs, 60_000, 'a host who never chose gets the default');
});

test('an empty room is an empty model, not a crash', () => {
  const model = partyModel();
  assert.deepStrictEqual(model.tables, []);
  assert.strictEqual(focusedTable(model), null);
  assert.strictEqual(boundTable(model), null);
  assert.strictEqual(packState(model, 'hearts'), null);
});
