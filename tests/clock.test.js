// THE HOST'S CLOCK, and the two things a shared table needs from it that a
// session timer cannot give: it does not stop when a frame is suspended, and a
// deadline it slept through still resolves correctly on the next breath.
//
// Both are asserted against a FAKE clock rather than by waiting, which is the
// only way to express "the process was frozen for four minutes" in a test that
// finishes in milliseconds.

import { test } from 'node:test';
import assert from 'node:assert';

import { wallClock, sessionClock, feltClock, deadline } from '../src/match/clock.js';
import { createTurnTimer } from '../src/match/turnTimer.js';

/**
 * A controllable stand-in for wall time plus setTimeout.
 *
 * `advance(ms)` moves time AND delivers every timer whose delay has elapsed,
 * repeatedly, so a re-scheduling deadline converges. `sleep(ms)` moves time
 * WITHOUT delivering anything first — a frozen process — and then delivers, so
 * the wall clock has to notice on its next tick that the deadline is long past.
 */
function testHost() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map();

  const host = {
    now: () => now,
    schedule(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + Math.max(0, ms) });
      return id;
    },
    unschedule(id) { timers.delete(id); },
    /** Move time forward, delivering timers as they come due. */
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      while (guard++ < 10_000) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.fn();
      }
      now = target;
    },
    /** The process was frozen: time passed, nothing was delivered. */
    sleep(ms) {
      now += ms;
    },
    /** Deliver whatever is now overdue, without moving time further. */
    drain() {
      let guard = 0;
      while (guard++ < 10_000) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= now);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.fn();
      }
    },
    pending: () => timers.size,
  };
  return host;
}

function clockOn(host) {
  return wallClock({ now: host.now, schedule: host.schedule, unschedule: host.unschedule });
}

test('a wall-clock deadline fires when its time arrives', () => {
  const host = testHost();
  const clock = clockOn(host);
  let fired = 0;
  clock.at(host.now() + 5000, () => { fired += 1; });

  host.advance(4000);
  assert.equal(fired, 0, 'not yet');
  host.advance(2000);
  assert.equal(fired, 1);
});

test('after(ms) is just a deadline computed from now', () => {
  const host = testHost();
  const clock = clockOn(host);
  let fired = 0;
  clock.after(3000, () => { fired += 1; });
  host.advance(2999);
  assert.equal(fired, 0);
  host.advance(2);
  assert.equal(fired, 1);
});

test('A SLEPT-THROUGH DEADLINE RESOLVES ON THE NEXT BREATH', () => {
  // The reason `at` exists. The process is frozen well past the deadline and
  // delivers nothing while asleep; on the first tick after, the clock must
  // notice the deadline is long gone and fire rather than waiting out a stale
  // duration it was handed before the nap.
  const host = testHost();
  const clock = clockOn(host);
  let fired = 0;
  clock.at(host.now() + 8000, () => { fired += 1; });

  host.sleep(120_000); // two minutes in a pocket
  assert.equal(fired, 0, 'nothing was delivered while frozen');

  host.drain();
  assert.equal(fired, 1, 'it fired on the first tick after waking');
});

test('a cancelled deadline never fires, and leaves no timer behind', () => {
  const host = testHost();
  const clock = clockOn(host);
  let fired = 0;
  const timer = clock.at(host.now() + 1000, () => { fired += 1; });
  timer.cancel();
  host.advance(5000);
  assert.equal(fired, 0);
  assert.equal(host.pending(), 0);
});

test('cancelling twice is safe', () => {
  const host = testHost();
  const clock = clockOn(host);
  const timer = clock.at(host.now() + 1000, () => {});
  timer.cancel();
  assert.doesNotThrow(() => timer.cancel());
});

test('a deadline already in the past fires immediately', () => {
  const host = testHost();
  const clock = clockOn(host);
  let fired = 0;
  clock.at(host.now() - 1, () => { fired += 1; });
  assert.equal(fired, 1);
});

test('the session clock is the SDK timer, untouched', () => {
  const calls = [];
  globalThis.Arcade = {
    session: {
      setTimeout(fn, ms) { calls.push(ms); return { cancel() {} }; },
    },
  };
  const clock = sessionClock();
  clock.after(750, () => {});
  assert.deepEqual(calls, [750]);
  assert.equal(clock.kind, 'session');
});

/* ------------------------------------------------------------------ *
 * The felt's clock — which of the two, asked per timer (#71)
 * ------------------------------------------------------------------ */

/** Two recording stand-ins, so a test can say which one was reached for. */
function twoClocks() {
  const reached = [];
  const make = (kind) => ({
    kind,
    now: () => (kind === 'wall' ? 1000 : 2000),
    after(ms, fn) { reached.push([kind, 'after', ms]); return { cancel() { reached.push([kind, 'cancel']); } }; },
    at(expiresAt, fn) { reached.push([kind, 'at', expiresAt]); return { cancel() {} }; },
  });
  return { reached, session: make('session'), wall: make('wall') };
}

test('a solo match schedules bots on the session clock, which freezes on suspend', () => {
  const { reached, session, wall } = twoClocks();
  const clock = feltClock({ shared: () => false, session, wall });
  clock.after(800, () => {});
  assert.deepEqual(reached, [['session', 'after', 800]]);
});

test('a SHARED match schedules bots on the wall clock, because the hand does not stop', () => {
  // THE BUG THIS FIXES. A hosted table the host is LOOKING AT used to schedule
  // its bots on session time, so the host pocketing their phone on a bot's turn
  // stopped the table for everybody at it.
  const { reached, session, wall } = twoClocks();
  const clock = feltClock({ shared: () => true, session, wall });
  clock.after(800, () => {});
  assert.deepEqual(reached, [['wall', 'after', 800]]);
});

test('the question is asked per timer, not once — the felt outlives every match', () => {
  // `bots` is built once in `initTable`, before any match exists, and is never
  // rebuilt. A clock chosen at construction would be the SOLO answer for the
  // life of the tab.
  let shared = false;
  const { reached, session, wall } = twoClocks();
  const clock = feltClock({ shared: () => shared, session, wall });

  clock.after(100, () => {});          // solo hand
  shared = true;                        // ...then the player hosts a table
  clock.after(200, () => {});
  shared = false;                       // ...and goes back to solo
  clock.after(300, () => {});

  assert.deepEqual(reached, [
    ['session', 'after', 100],
    ['wall', 'after', 200],
    ['session', 'after', 300],
  ]);
});

test('a handle cancels through whichever clock issued it', () => {
  // Both `Arcade.session.setTimeout` and `wallClock.at` return `{ cancel() }`,
  // which is what lets the driver hold one `botTimer` slot and never ask where
  // it came from.
  const { reached, session, wall } = twoClocks();
  let shared = true;
  const clock = feltClock({ shared: () => shared, session, wall });
  clock.after(50, () => {}).cancel();
  shared = false;
  clock.after(60, () => {}).cancel();
  assert.deepEqual(reached.filter((r) => r[1] === 'cancel'), [['wall', 'cancel'], ['session', 'cancel']]);
});

test('deadlines dispatch too, so a countdown and a turn agree about time', () => {
  const { reached, session, wall } = twoClocks();
  feltClock({ shared: () => true, session, wall }).at(9999, () => {});
  feltClock({ shared: () => false, session, wall }).at(8888, () => {});
  assert.deepEqual(reached, [['wall', 'at', 9999], ['session', 'at', 8888]]);
});

test('a deadline travels as {seat, kind, expiresAt}', () => {
  assert.deepEqual(deadline(2, 'turn', 1234), { seat: 2, kind: 'turn', expiresAt: 1234 });
});

/* ------------------------------------------------------------------ *
 * Turn timer
 * ------------------------------------------------------------------ */

function timerHarness(host, { acting, waitsOn = () => true, timeoutMs = 10_000 } = {}) {
  const expired = [];
  const timer = createTurnTimer({
    clock: clockOn(host),
    timeoutMs,
    actingSeatsOf: acting,
    waitsOn,
    onExpire: (_state, seat) => expired.push(seat),
  });
  return { timer, expired };
}

test('an expired turn reports the seat, for the host to move through the pipeline', () => {
  const host = testHost();
  const state = { gameOver: false };
  const { timer, expired } = timerHarness(host, { acting: () => [1] });

  timer.arm(state);
  host.advance(9000);
  assert.deepEqual(expired, []);
  host.advance(2000);
  assert.deepEqual(expired, [1]);
});

test('re-arming does not restart a clock a seat is already on', () => {
  // The table arms after every move. If that reset everybody's deadline, a
  // timeout would be unreachable at a busy table.
  const host = testHost();
  const state = { gameOver: false };
  const { timer, expired } = timerHarness(host, { acting: () => [1] });

  timer.arm(state);
  const first = timer.deadlines()[0].expiresAt;
  host.advance(6000);
  timer.arm(state);
  assert.equal(timer.deadlines()[0].expiresAt, first, 'same deadline, not a fresh one');

  host.advance(5000);
  assert.deepEqual(expired, [1]);
});

test('a seat that stops acting loses its deadline', () => {
  const host = testHost();
  const state = { gameOver: false };
  let acting = [1];
  const { timer, expired } = timerHarness(host, { acting: () => acting });

  timer.arm(state);
  assert.equal(timer.deadlines().length, 1);

  acting = [2];
  timer.arm(state);
  assert.deepEqual(timer.deadlines().map((d) => d.seat), [2]);

  host.advance(20_000);
  assert.deepEqual(expired, [2], 'only the seat still being waited on expired');
});

test('a simultaneous phase gives every waited-on seat its own deadline', () => {
  // Hearts' passing: three uncommitted seats acting at once. One "current
  // turn" deadline would expire the wrong seat, or all of them together.
  const host = testHost();
  const state = { gameOver: false };
  const { timer, expired } = timerHarness(host, { acting: () => [1, 2, 3] });

  timer.arm(state);
  assert.deepEqual(timer.deadlines().map((d) => d.seat), [1, 2, 3]);

  host.advance(11_000);
  assert.deepEqual(expired.sort(), [1, 2, 3]);
});

test('bots and my own seats are not timed', () => {
  const host = testHost();
  const state = { gameOver: false };
  // Only seat 2 is a remote human we are waiting on.
  const { timer, expired } = timerHarness(host, {
    acting: () => [0, 1, 2],
    waitsOn: (seat) => seat === 2,
  });

  timer.arm(state);
  assert.deepEqual(timer.deadlines().map((d) => d.seat), [2]);
  host.advance(20_000);
  assert.deepEqual(expired, [2]);
});

test('a seat that moved before its deadline does not expire', () => {
  const host = testHost();
  const state = { gameOver: false };
  let acting = [1];
  const { timer, expired } = timerHarness(host, { acting: () => acting });

  timer.arm(state);
  host.advance(9000);
  acting = []; // they moved; nobody is being waited on now
  timer.arm(state);
  host.advance(5000);
  assert.deepEqual(expired, [], 'the pending deadline was dropped');
});

test('game over cancels every deadline', () => {
  const host = testHost();
  const state = { gameOver: false };
  const { timer, expired } = timerHarness(host, { acting: () => [1, 2] });

  timer.arm(state);
  assert.equal(timer.deadlines().length, 2);

  state.gameOver = true;
  timer.arm(state);
  assert.deepEqual(timer.deadlines(), []);
  host.advance(20_000);
  assert.deepEqual(expired, []);
});

test('a stale epoch drops the expiry — "Play again" must not move the old table', () => {
  const host = testHost();
  const state = { gameOver: false };
  let epoch = 1;
  const expired = [];
  const timer = createTurnTimer({
    clock: clockOn(host),
    timeoutMs: 5000,
    actingSeatsOf: () => [1],
    waitsOn: () => true,
    onExpire: (_s, seat) => expired.push(seat),
    currentEpoch: () => epoch,
  });

  timer.arm(state);
  epoch = 2; // the match was replaced while the deadline was pending
  host.advance(10_000);
  assert.deepEqual(expired, []);
});

test('cancelAll clears everything and leaves no host timer behind', () => {
  const host = testHost();
  const state = { gameOver: false };
  const { timer, expired } = timerHarness(host, { acting: () => [1, 2, 3] });
  timer.arm(state);
  timer.cancelAll();

  assert.deepEqual(timer.deadlines(), []);
  host.advance(30_000);
  assert.deepEqual(expired, []);
  assert.equal(host.pending(), 0);
});

test('a zero timeout expires at once without leaving a phantom deadline', () => {
  // `clock.at` fires synchronously for a deadline already past. The entry must
  // already be registered when that happens, or the callback's own cleanup
  // finds nothing and a dead deadline is reported to clients forever.
  const host = testHost();
  const state = { gameOver: false };
  const { timer, expired } = timerHarness(host, { acting: () => [1], timeoutMs: 0 });

  timer.arm(state);
  assert.deepEqual(expired, [1], 'it expired immediately');
  assert.deepEqual(timer.deadlines(), [], 'and left nothing behind');
});
