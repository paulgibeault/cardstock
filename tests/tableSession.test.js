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

test('seat zero is a held seat, not a falsy one', () => {
  const reg = createSessionRegistry();
  reg.add(sessionFor(ID.eights, 'eights', 'joiner', { seat: 0 }).session);

  // `seat() === 0` is the whole reason heldSeat compares against undefined
  // rather than testing truthiness: seat 0 is a chair like any other.
  assert.match(reg.refusalToHost('eights'), /Leave it to host your own/);
});

/* ------------------------------------------------------------------ *
 * Bots at a table nobody is looking at (T3 2b)
 * ------------------------------------------------------------------ */

/** A cancellable in the shape botDriver's clock hands back. */
function fakeTimer() {
  const t = { cancelled: false, cancel() { t.cancelled = true; } };
  return t;
}

test('a session carries the bot driver’s scratch, so two tables never share it', () => {
  const a = createTableSession({ tableId: ID.hearts, packId: 'hearts', role: 'host' });
  const b = createTableSession({ tableId: ID.eights, packId: 'eights', role: 'host' });

  a.botCallDecision.set(1, true);
  a.announceTimers.push(fakeTimer());

  assert.equal(b.botCallDecision.size, 0, 'a persona roll at one table is not a roll at the other');
  assert.equal(b.announceTimers.length, 0);
  assert.notStrictEqual(a.botCatchDecision, b.botCatchDecision);
});

test('cancelBots drops the pending turn and every beat, and forgets the rolls', () => {
  const s = createTableSession({ tableId: ID.hearts, packId: 'hearts', role: 'host' });
  const turn = fakeTimer();
  const beat = fakeTimer();
  s.botTimer = turn;
  s.announceTimers.push(beat);
  s.botCallDecision.set(1, true);
  s.botCatchDecision.set('1>2', true);

  s.cancelBots();

  assert.equal(turn.cancelled, true);
  assert.equal(beat.cancelled, true);
  assert.equal(s.botTimer, null);
  assert.deepEqual(s.announceTimers, []);
  assert.equal(s.botCallDecision.size, 0, 'a stale roll must not outlive the window it was made for');
  assert.equal(s.botCatchDecision.size, 0);
});

test('stop moves the epoch before it clears the state', () => {
  const s = createTableSession({ tableId: ID.hearts, packId: 'hearts', role: 'host' });
  s.state = { turn: { seat: 0 } };
  const before = s.epoch;
  const turn = fakeTimer();
  s.botTimer = turn;

  s.stop();

  // A TURN ALREADY IN FLIGHT READS THE EPOCH AT FIRE TIME. Bumping it here is
  // what makes that turn drop itself rather than reach for a null state.
  assert.ok(s.epoch > before, 'the epoch moved');
  assert.equal(turn.cancelled, true);
  assert.equal(s.liveState(), null);
  assert.equal(s.bots, null);
});
