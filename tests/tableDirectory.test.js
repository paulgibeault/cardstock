// THE DIRECTORY, WHICH IS THE WHOLE OF "THERE CAN BE MORE THAN ONE TABLE".
//
// src/ui/party.js held one `invitation` slot and could therefore know about one
// table. Everything below is a fact that slot got wrong: a second host
// overwrote the first, a table nobody had heard from in an hour looked as live
// as one dealing right now, and a host that walked out of the building left an
// advertisement for a felt that no longer existed.
//
// Node-clean by construction — no DOM, no Arcade global, no engine — because
// the module is one of the pieces a second game inherits whole
// (TABLES_PLAN.md §10) and a dependency added here would be a dependency it
// carries.

import { test } from 'node:test';
import assert from 'node:assert';

import { createTableDirectory, tableKeyOf } from '../src/match/tableDirectory.js';
import { FRAME, PROTOCOL_VERSION } from '../src/match/protocol.js';

/** A lobby frame of the shape src/match/host.js broadcasts. */
function lobby({ hostDeviceId = 'ada', packId = 'crazy-eights', started = false, seats = [], tableId = null } = {}) {
  return {
    // A table is named by ITSELF from protocol v2 on. Defaulting it to the host
    // keeps every existing case reading the same way — one table per host — and
    // lets the cases that care about two tables on one device say so.
    tableId: tableId || `tbl-${hostDeviceId}`,
    k: FRAME.LOBBY,
    protocol: PROTOCOL_VERSION,
    packId,
    variants: [],
    hostDeviceId,
    seatCount: seats.length || 2,
    seats,
    started,
  };
}

/** A clock that only moves when a test says so. */
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; return t; } };
}

test('a frame files under its host, and a frame without one is refused', () => {
  assert.strictEqual(tableKeyOf(lobby({ hostDeviceId: 'ada' })), 'tbl-ada');
  // A frame with no id of its own still files under its host — the fallback
  // that keeps a pre-v2 sighting from becoming unfilable.
  assert.strictEqual(tableKeyOf({ hostDeviceId: 'ada' }), 'ada');
  assert.strictEqual(tableKeyOf({ k: FRAME.LOBBY }), null);
  assert.strictEqual(tableKeyOf(null), null);

  const dir = createTableDirectory();
  assert.strictEqual(dir.sight({ k: FRAME.LOBBY, packId: 'hearts' }), null);
  assert.strictEqual(dir.size, 0, 'a hostless frame is not a table');
});

test('two hosts are two tables — the case the single slot could not hold', () => {
  const dir = createTableDirectory();
  dir.sight(lobby({ hostDeviceId: 'ada', packId: 'crazy-eights' }));
  dir.sight(lobby({ hostDeviceId: 'dana', packId: 'hearts' }));

  assert.strictEqual(dir.size, 2);
  assert.strictEqual(dir.get('tbl-ada').packId, 'crazy-eights');
  assert.strictEqual(dir.get('tbl-dana').packId, 'hearts');
  // The old behaviour, stated as the thing that must NOT happen: the second
  // sighting did not evict the first.
  assert.ok(dir.has('tbl-ada'), "the first host's table survived the second's arrival");
});

test('re-sighting a table updates it in place and keeps its position', () => {
  const clock = fakeClock();
  const dir = createTableDirectory({ now: clock.now });
  dir.sight(lobby({ hostDeviceId: 'ada', started: false }));
  dir.sight(lobby({ hostDeviceId: 'dana' }));
  const firstSeen = dir.get('tbl-ada').firstSeenAt;

  clock.advance(5000);
  dir.sight(lobby({ hostDeviceId: 'ada', started: true }));

  assert.strictEqual(dir.size, 2, 're-sighting is an update, not an insert');
  assert.strictEqual(dir.get('tbl-ada').frame.started, true, 'the newer frame won');
  assert.strictEqual(dir.get('tbl-ada').firstSeenAt, firstSeen, 'first sighting is remembered');
  assert.strictEqual(dir.get('tbl-ada').lastSeenAt, clock.now());
  // TILE ORDER IS INSERTION ORDER. A host re-broadcasts its lobby on every seat
  // change, and a row of tiles that reshuffled every time somebody sat down
  // would be a row nobody could tap reliably.
  assert.deepStrictEqual(dir.all().map((e) => e.key), ['tbl-ada', 'tbl-dana']);
});

test('the latest sighting is what an unattached device follows', () => {
  const clock = fakeClock();
  const dir = createTableDirectory({ now: clock.now });
  assert.strictEqual(dir.latest(), null, 'nothing in earshot is a real answer');

  dir.sight(lobby({ hostDeviceId: 'ada' }));
  clock.advance(10);
  dir.sight(lobby({ hostDeviceId: 'dana' }));
  assert.strictEqual(dir.latest().key, 'tbl-dana');

  clock.advance(10);
  dir.sight(lobby({ hostDeviceId: 'ada' }));
  assert.strictEqual(dir.latest().key, 'tbl-ada', 'talking again makes a table current');
});

test('tables are findable by pack, and two hosts may run the same one', () => {
  const dir = createTableDirectory();
  dir.sight(lobby({ hostDeviceId: 'ada', packId: 'hearts' }));
  dir.sight(lobby({ hostDeviceId: 'dana', packId: 'hearts' }));
  dir.sight(lobby({ hostDeviceId: 'kit', packId: 'crazy-eights' }));

  assert.deepStrictEqual(dir.forPack('hearts').map((e) => e.key), ['tbl-ada', 'tbl-dana']);
  assert.deepStrictEqual(dir.forPack('crazy-eights').map((e) => e.key), ['tbl-kit']);
  assert.deepStrictEqual(dir.forPack('stockpile'), []);
});

test('a host that closes politely is forgotten by name', () => {
  const dir = createTableDirectory();
  dir.sight(lobby({ hostDeviceId: 'ada' }));
  dir.sight(lobby({ hostDeviceId: 'dana' }));

  assert.strictEqual(dir.forget('tbl-ada'), true);
  assert.strictEqual(dir.forget('tbl-ada'), false, 'forgetting twice is not an error');
  assert.strictEqual(dir.size, 1);
  assert.strictEqual(dir.get('tbl-ada'), null);
  assert.ok(dir.has('tbl-dana'), 'the other table was not disturbed');
});

test('a host that vanishes is pruned against the roster', () => {
  const dir = createTableDirectory();
  dir.sight(lobby({ hostDeviceId: 'ada' }));
  dir.sight(lobby({ hostDeviceId: 'dana' }));
  dir.sight(lobby({ hostDeviceId: 'kit' }));

  // Dana's battery died: no `bye`, just an absence from the party roster.
  const dropped = dir.retain(['ada', 'kit']);

  assert.deepStrictEqual(dropped, ['tbl-dana']);
  assert.strictEqual(dir.size, 2);
  assert.ok(dir.has('tbl-ada') && dir.has('tbl-kit'));
});

test('retaining against an empty roster clears the board, and says what went', () => {
  const dir = createTableDirectory();
  dir.sight(lobby({ hostDeviceId: 'ada' }));
  dir.sight(lobby({ hostDeviceId: 'dana' }));

  assert.deepStrictEqual(dir.retain([]).sort(), ['tbl-ada', 'tbl-dana']);
  assert.strictEqual(dir.size, 0);
  assert.deepStrictEqual(dir.retain([]), [], 'a prune with nothing to prune is silent');
});
