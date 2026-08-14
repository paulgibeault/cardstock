// THE SESSION AND THE DOOR — unit cover for the two objects T3 hangs on.
//
// These are deliberately about ownership and policy rather than about play:
// whether a table survives the felt walking away from it, and whether the two
// TABLES_PLAN.md §1 invariants are answered in one place. The wire-level nets
// for two concurrent tables live in tests/twoSessions.test.js and
// tests/twoTables.test.js; this file is the layer above them.

import { test } from 'node:test';
import assert from 'node:assert';

import { createTableSession } from '../src/match/tableSession.js';
import { createSessionRegistry } from '../src/match/sessionRegistry.js';

const ID = { hearts: 't1aaaaaaaaaaaaaaaaa', eights: 't2bbbbbbbbbbbbbbbbb', other: 't3ccccccccccccccccc' };

/** A session with a stub host/client/timer that records its own teardown. */
function sessionFor(tableId, packId, role, { seat = null } = {}) {
  const session = createTableSession({ tableId, packId, role });
  const stopped = { host: false, client: false, timer: false };
  session.attach({
    host: role === 'host' ? { stop: () => { stopped.host = true; } } : null,
    client: role === 'joiner' ? { stop: () => { stopped.client = true; }, seat: () => seat } : null,
    timer: role === 'host' ? { cancelAll: () => { stopped.timer = true; } } : null,
  });
  return { session, stopped };
}

/* ------------------------------------------------------------------ *
 * The session
 * ------------------------------------------------------------------ */

test('a session refuses a tableId that is not a SAFE_ID', () => {
  assert.throws(() => createTableSession({ tableId: 'not a safe id!', packId: 'hearts', role: 'host' }));
  assert.throws(() => createTableSession({ tableId: null, packId: 'hearts', role: 'host' }));
});

test('a session refuses a role that is neither host nor joiner', () => {
  assert.throws(() => createTableSession({ tableId: ID.hearts, packId: 'hearts', role: 'spectator' }));
});

test('unbinding does not end the table — the whole point of the inversion', () => {
  const { session, stopped } = sessionFor(ID.hearts, 'hearts', 'host');
  session.state = { turn: { seat: 0 } };
  session.bound = true;

  session.bound = false;

  assert.equal(session.liveState().turn.seat, 0, 'the state outlives the felt looking away');
  assert.ok(session.host, 'and so does the host');
  assert.equal(stopped.host, false);
  assert.equal(stopped.timer, false);
});

test('stop() takes down every instrument, and is safe twice', () => {
  const { session, stopped } = sessionFor(ID.hearts, 'hearts', 'host');
  session.state = { turn: { seat: 0 } };
  session.decided.add(2);

  session.stop();

  assert.deepEqual(stopped, { host: true, client: false, timer: true });
  assert.equal(session.liveState(), null);
  assert.equal(session.decided.size, 0);
  assert.doesNotThrow(() => session.stop());
});

test('context() is the shape the felt used to own, by live reference', () => {
  const { session } = sessionFor(ID.hearts, 'hearts', 'host');
  const state = { turn: { seat: 1 } };
  session.state = state;
  session.pack = { id: 'hearts' };
  session.seats = { count: 4 };
  session.seating = [{ name: 'You' }];

  const ctx = session.context();
  assert.strictEqual(ctx.state, state, 'the same object, not a snapshot');
  assert.strictEqual(ctx.seats, session.seats);
  assert.equal(ctx.pack.id, 'hearts');
});

test('a session with nothing dealt yet has no context', () => {
  const { session } = sessionFor(ID.hearts, 'hearts', 'host');
  assert.equal(session.context(), null);
});

/* ------------------------------------------------------------------ *
 * The registry's door
 * ------------------------------------------------------------------ */

test('hosting one pack does not refuse hosting another', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.hearts, 'hearts', 'host').session);

  assert.equal(reg.refusalToHost('eights'), null);
  assert.match(reg.refusalToHost('hearts'), /already hosting/);
});

test('a seat at somebody else’s Crazy Eights does not refuse hosting Hearts', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.eights, 'eights', 'joiner', { seat: 2 }).session);

  assert.equal(reg.refusalToHost('hearts'), null, 'the refusal T1 was written to remove');
  assert.match(reg.refusalToHost('eights'), /Leave it to host your own/);
});

test('a client that never sat down refuses nothing', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.eights, 'eights', 'joiner', { seat: null }).session);

  assert.equal(reg.refusalToHost('eights'), null, 'speculative join is not a seat');
  assert.equal(reg.refusalToSit('eights'), null);
});

test('seat zero is a held seat, not a falsy one', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.eights, 'eights', 'joiner', { seat: 0 }).session);

  assert.match(reg.refusalToSit('eights'), /already seated/);
});

test('you cannot sit at a pack you are hosting', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.hearts, 'hearts', 'host').session);

  assert.match(reg.refusalToSit('hearts'), /Stop hosting/);
  assert.equal(reg.refusalToSit('eights'), null);
});

test('refusals name the game when given a name', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.hearts, 'hearts', 'host').session);

  const notice = reg.refusalToHost('hearts', { nameOf: () => 'Hearts' });
  assert.match(notice, /Hearts/);
});

/* ------------------------------------------------------------------ *
 * Binding, membership, teardown
 * ------------------------------------------------------------------ */

test('binding moves attention and never membership', () => {
  const reg = createSessionRegistry();
  const a = reg.add(sessionFor(ID.hearts, 'hearts', 'host').session);
  const b = reg.add(sessionFor(ID.eights, 'eights', 'host').session);

  reg.bind(ID.hearts);
  assert.equal(a.bound, true);
  assert.equal(b.bound, false);

  reg.bind(ID.eights);
  assert.equal(a.bound, false, 'exactly one felt, so exactly one bound session');
  assert.equal(b.bound, true);
  assert.equal(reg.size(), 2, 'and both tables are still live');
  assert.equal(reg.bound().tableId, ID.eights);
});

test('unbinding leaves both tables running', () => {
  const reg = createSessionRegistry();
  const { session, stopped } = sessionFor(ID.hearts, 'hearts', 'host');
  reg.add(session);
  reg.bind(ID.hearts);

  reg.unbind();

  assert.equal(reg.bound(), null);
  assert.equal(reg.size(), 1);
  assert.equal(stopped.host, false);
});

test('binding an unknown id unbinds rather than throwing', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.hearts, 'hearts', 'host').session);
  reg.bind(ID.hearts);

  assert.equal(reg.bind(ID.other), null);
  assert.equal(reg.bound(), null);
  assert.equal(reg.size(), 1);
});

test('remove ends the table it drops — no host left answering frames', () => {
  const reg = createSessionRegistry();
  const { session, stopped } = sessionFor(ID.hearts, 'hearts', 'host');
  reg.add(session);
  reg.bind(ID.hearts);

  reg.remove(ID.hearts);

  assert.equal(reg.size(), 0);
  assert.equal(reg.bound(), null, 'and takes the binding with it');
  assert.equal(stopped.host, true);
  assert.equal(stopped.timer, true);
  assert.equal(reg.remove(ID.hearts), null, 'removing twice is not an error');
});

test('clear ends every table', () => {
  const reg = createSessionRegistry();
  const one = sessionFor(ID.hearts, 'hearts', 'host');
  const two = sessionFor(ID.eights, 'eights', 'joiner', { seat: 1 });
  reg.add(one.session);
  reg.add(two.session);

  reg.clear();

  assert.equal(reg.size(), 0);
  assert.equal(one.stopped.host, true);
  assert.equal(two.stopped.client, true);
});

test('hosted and joined split the same registry', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.hearts, 'hearts', 'host').session);
  reg.add(sessionFor(ID.eights, 'eights', 'joiner', { seat: 1 }).session);

  assert.deepEqual(reg.hosted().map((s) => s.packId), ['hearts']);
  assert.deepEqual(reg.joined().map((s) => s.packId), ['eights']);
  assert.equal(reg.hostedForPack('hearts').tableId, ID.hearts);
  assert.equal(reg.seatedForPack('eights').tableId, ID.eights);
});

test('two tables of different packs can both be hosted — the #43 case', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.hearts, 'hearts', 'host').session);
  assert.equal(reg.refusalToHost('eights'), null);
  reg.add(sessionFor(ID.eights, 'eights', 'host').session);

  assert.equal(reg.hosted().length, 2);
  assert.notEqual(reg.get(ID.hearts), reg.get(ID.eights));
});
