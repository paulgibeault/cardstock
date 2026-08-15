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
  partyModel, tableOf, focusedTable, boundTable, packState, emptyBeliefs, SETTLE_MS,
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

/**
 * A LIVE SIGHTING MEANS ITS HOST IS A DIRECT PEER, so the default roster says
 * so. src/ui/tableSightings.js will not file a frame from anyone else — the two
 * authenticity rules are exactly that — and since #78 the model reads the
 * roster to decide `liveness`, so a fixture without the host in `peers` is a
 * table that could not exist. A test that wants an absent host overrides
 * `peers` deliberately, which is the interesting case rather than the default.
 */
const base = {
  self: ME,
  myName: 'You',
  publishedName: 'Me',
  packNameOf: () => null,
  peers: [{ deviceId: ADA, name: 'Ada', direct: true }, { deviceId: BO, name: 'Bo', direct: true }],
};

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
  const model = partyModel({
    ...base,
    myName: 'You',
    publishedName: 'Paul',
    sightings: sightingsOf(frame),
    sessions: [hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts')],
    peers: [{ deviceId: ADA, name: 'Ada Live', direct: true }],
  });
  const seats = model.tables[0].seats;
  assert.strictEqual(seats[0].name, 'You');
  assert.strictEqual(seats[0].shortName, 'You');
  // A HOST TRUSTS ITS OWN ROSTER over the frame it published a moment ago, so a
  // peer who renames themselves is current on the host's screen.
  assert.strictEqual(seats[1].name, 'Ada Live');
});

test('a host picks up a rename before the deal, with no seating of its own yet', () => {
  // #79. "Do we hold bot faces of our own" and "may we trust our live roster"
  // were one flag, and it is null between `hostGame` and the first seat change
  // — so a host read names off the frame it had just published and did not
  // notice a rename until somebody took a chair. Two questions now.
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
  assert.strictEqual(model.tables[0].seats[1].name, 'Ada Live',
    'the roster, which a host holds a direct link to — not the frame it published');
});

test('a host still derives a NEIGHBOUR\'s names from their frame, roster or no roster', () => {
  // The other half of #79's split, and the one that must not move: our direct
  // links say nothing about who is sitting at somebody else's table.
  const theirs = lobbyFrame({
    tableId: 't2b2b2b2b2b2b2b2b2b', hostDeviceId: ADA, packId: 'crazy-eights',
    seats: [{ seat: 0, kind: 'device', deviceId: ADA, name: 'Ada' },
      { seat: 1, kind: 'device', deviceId: BO, name: 'Bo In Their Frame' }],
  });
  const model = partyModel({
    ...base,
    sightings: sightingsOf(theirs),
    sessions: [hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts')], // we host something else
    peers: [{ deviceId: ADA, direct: true }, { deviceId: BO, name: 'Bo Renamed', direct: true }],
  });
  assert.strictEqual(model.tables[0].seats[1].name, 'Bo In Their Frame');
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

/* ------------------------------------------------------------------ *
 * Beliefs with time in them (#78)
 *
 * A DOWNGRADE HAS TO HOLD; AN UPGRADE NEVER DOES. Walked forward by handing
 * the model different `now`s — no sleeping, no fake timers, which is the whole
 * dividend of the model being pure.
 * ------------------------------------------------------------------ */

/** A little rig that keeps the beliefs between readings, as the screen does. */
function overTime(readings) {
  let beliefs = emptyBeliefs();
  const out = [];
  for (const [now, input] of readings) {
    const model = partyModel({ ...base, ...input, now, beliefs });
    beliefs = model.beliefs;
    out.push({ model, nextChangeAt: model.beliefs.nextChangeAt });
  }
  return out;
}

const seatsOf = (host, me) => [
  { seat: 0, kind: 'device', deviceId: ADA, name: 'Ada', status: host },
  { seat: 1, kind: 'device', deviceId: BO, name: 'Bo', status: me },
];

test('a seat that blips and recovers never shows a chip at all', () => {
  const at = (status) => ({ sightings: sightingsOf(lobbyFrame({ seats: seatsOf('connected', status) })) });
  const steps = overTime([
    [0, at('connected')],
    [1000, at('interrupted')],   // the blip
    [2000, at('interrupted')],   // still blipping, still inside probation
    [2500, at('connected')],     // recovered, well before SETTLE_MS
  ]);
  assert.deepStrictEqual(steps.map((s) => s.model.tables[0].seats[1].presence),
    ['connected', 'connected', 'connected', 'connected'],
    'a two-second interruption the transport already covered is not news');
});

test('a real disconnection still arrives, once it has held', () => {
  const at = (status) => ({ sightings: sightingsOf(lobbyFrame({ seats: seatsOf('connected', status) })) });
  const steps = overTime([
    [0, at('connected')],
    [1000, at('interrupted')],
    [1000 + SETTLE_MS - 1, at('interrupted')],
    [1000 + SETTLE_MS, at('interrupted')],
  ]);
  assert.deepStrictEqual(steps.map((s) => s.model.tables[0].seats[1].presence),
    ['connected', 'connected', 'connected', 'interrupted']);
});

test('coming back is never delayed — hiding a recovery is the worse lie', () => {
  const at = (status) => ({ sightings: sightingsOf(lobbyFrame({ seats: seatsOf('connected', status) })) });
  const steps = overTime([
    [0, at('gone')],
    [1, at('connected')],
  ]);
  assert.deepStrictEqual(steps.map((s) => s.model.tables[0].seats[1].presence), ['gone', 'connected']);
});

test('a flap does not reset its own probation for ever', () => {
  // THE BUG A NAIVE DEBOUNCE HAS. Restarting the clock on every fresh sighting
  // of the same bad reading means a seat that flaps once a second is never
  // reported at all. The clock runs from when the reading FIRST appeared.
  const at = (status) => ({ sightings: sightingsOf(lobbyFrame({ seats: seatsOf('connected', status) })) });
  const steps = overTime([
    [0, at('connected')],
    [100, at('interrupted')],
    [1100, at('interrupted')],
    [2100, at('interrupted')],
    [100 + SETTLE_MS, at('interrupted')],
  ]);
  assert.strictEqual(steps.at(-1).model.tables[0].seats[1].presence, 'interrupted');
});

test('a worse reading arriving after a bad one restarts the clock for ITS own step', () => {
  const at = (status) => ({ sightings: sightingsOf(lobbyFrame({ seats: seatsOf('connected', status) })) });
  const steps = overTime([
    [0, at('connected')],
    [100, at('interrupted')],
    [100 + SETTLE_MS, at('interrupted')],  // interrupted lands
    [100 + SETTLE_MS + 1, at('gone')],     // now a further downgrade
    [100 + SETTLE_MS + 2, at('gone')],
  ]);
  assert.deepStrictEqual(steps.map((s) => s.model.tables[0].seats[1].presence),
    ['connected', 'connected', 'interrupted', 'interrupted', 'interrupted'],
    'gone waits its own turn rather than inheriting interrupted\'s served time');
});

test("a live table's host blinking off the roster does not rename them", () => {
  const seen = { sightings: sightingsOf(lobbyFrame()), peers: [{ deviceId: ADA, name: 'Ada', direct: true }] };
  const blinked = { sightings: sightingsOf(lobbyFrame()), peers: [] };
  const steps = overTime([[0, seen], [500, blinked], [900, seen]]);
  assert.deepStrictEqual(steps.map((s) => s.model.tables[0].hostName), ['Ada', 'Ada', 'Ada']);
});

test('a host who really is gone becomes Someone, once it has held', () => {
  const seen = { sightings: sightingsOf(lobbyFrame()), peers: [{ deviceId: ADA, name: 'Ada', direct: true }] };
  const gone = { sightings: sightingsOf(lobbyFrame()), peers: [] };
  const steps = overTime([[0, seen], [10, gone], [10 + SETTLE_MS, gone]]);
  assert.deepStrictEqual(steps.map((s) => s.model.tables[0].hostName), ['Ada', 'Ada', 'Someone']);
});

test('a table going dormant waits, and coming back does not', () => {
  const stub = { tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ADA, packId: 'hearts', seat: 1, hostName: 'Ada', lastSeenAt: 5 };
  const live = { sightings: sightingsOf(lobbyFrame()), stubs: [stub] };
  const away = { sightings: [], stubs: [stub] };
  const steps = overTime([[0, live], [10, away], [10 + SETTLE_MS, away], [99_999, live]]);
  assert.deepStrictEqual(steps.map((s) => s.model.tables[0].liveness),
    ['live', 'live', 'offline', 'live']);
});

test('the model says when to look again, and says nothing when nothing is pending', () => {
  const at = (status) => ({ sightings: sightingsOf(lobbyFrame({ seats: seatsOf('connected', status) })) });
  const steps = overTime([
    [0, at('connected')],
    [1000, at('interrupted')],
    [1000 + SETTLE_MS, at('interrupted')],
  ]);
  assert.strictEqual(steps[0].nextChangeAt, null, 'a settled reading needs no wake-up');
  assert.strictEqual(steps[1].nextChangeAt, 1000 + SETTLE_MS, 'the earliest moment it comes due');
  assert.strictEqual(steps[2].nextChangeAt, null, 'and nothing once it has landed');
});

test('a key nobody asked about is forgotten rather than kept for ever', () => {
  // The memory is rebuilt each pass, so a table that leaves earshot does not
  // leave an entry behind for every seat it ever had.
  const two = { sightings: sightingsOf(lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a' }),
    lobbyFrame({ tableId: 't2b2b2b2b2b2b2b2b2b', hostDeviceId: BO, packId: 'gin' })) };
  const one = { sightings: sightingsOf(lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a' })) };
  const steps = overTime([[0, two], [10, one]]);
  const keys = [...steps.at(-1).model.beliefs.settled.keys()];
  assert.ok(keys.every((k) => k.startsWith('t1a1a1a1a1a1a1a1a1a')),
    `stale keys survived: ${keys.join(', ')}`);
});

test('a frame is not a pulse: a host off the roster goes offline, frame or no frame', () => {
  // #78 (c). The directory spares a table through a brief roster gap so the
  // screen has something to say about it — and a spared entry still holds the
  // last frame, so "is there a frame" stopped being enough to call it live.
  const here = { sightings: sightingsOf(lobbyFrame()), peers: [{ deviceId: ADA, direct: true }] };
  const away = { sightings: sightingsOf(lobbyFrame()), peers: [] };
  const steps = overTime([[0, here], [10, away], [10 + SETTLE_MS, away], [99_999, here]]);
  assert.deepStrictEqual(steps.map((s) => s.model.tables[0].liveness),
    ['live', 'live', 'offline', 'live'],
    'held through the blip, offline once it holds, and back at once when they return');
});

test('our own table is always reachable — a device is never in its own peers()', () => {
  const mine = lobbyFrame({ tableId: 't1a1a1a1a1a1a1a1a1a', hostDeviceId: ME, packId: 'hearts' });
  const model = partyModel({
    ...base, sightings: sightingsOf(mine), peers: [],
    sessions: [hostSession('t1a1a1a1a1a1a1a1a1a', 'hearts')],
  });
  assert.strictEqual(model.tables[0].liveness, 'live');
});
