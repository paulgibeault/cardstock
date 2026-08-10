// WHICH SEATS THE BOT DRIVER WILL PLAY, and — the point of these — which it
// will not.
//
// The driver used to be handed `humanSeat`, a NUMBER captured once at init().
// Every "is this seat a bot's" question in it was `seat !== humanSeat`, which
// is two assumptions rolled together: that the seat I hold is knowable before
// the match exists, and that there is exactly one of it. A shared table breaks
// both — a joiner claims a chair after the lobby, and hotseat holds two.
//
// So it now takes the seat LENS (src/players/seats.js) and asks it at fire
// time. These tests pin that: the driver skips whatever the lens calls mine,
// not seat zero, and it re-asks rather than trusting an answer it cached.
//
// The felt cannot pin this itself. Every timer in the driver is
// `Arcade.session.setTimeout`, which freezes while the frame is suspended
// (§6c) — and a preview pane loads the page hidden, so a browser check of the
// bot path silently verifies nothing at all.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';
import { createSeatTable, createSeatLens, soloSeatTable } from '../src/players/seats.js';
import { createBotDriver } from '../src/ui/botDriver.js';

/**
 * A stand-in for the SDK's session clock that fires nothing on its own.
 *
 * The driver schedules through `Arcade.session.setTimeout`; the tests want to
 * decide WHEN that lands, so pending callbacks are parked here and run by
 * hand. `flush` is what a suspended frame never does, which is the whole
 * reason these tests exist rather than a click-through.
 */
function fakeSessionClock() {
  const pending = [];
  globalThis.Arcade = {
    session: {
      setTimeout(fn, ms) {
        const entry = { fn, ms, cancelled: false };
        pending.push(entry);
        return { cancel() { entry.cancelled = true; } };
      },
    },
  };
  return {
    pending,
    flush() {
      const live = pending.filter((e) => !e.cancelled);
      pending.length = 0;
      for (const entry of live) entry.fn();
      return live.length;
    },
  };
}

function freshSession(state) {
  return {
    state,
    botTimer: null,
    announceTimers: [],
    botCallDecision: new Map(),
    botCatchDecision: new Map(),
  };
}

/** A driver wired to a lens, recording every seat it actually moved. */
function driverFor(seatTable, state, { acting = null } = {}) {
  const played = [];
  const errors = [];
  const me = createSeatLens(() => seatTable);
  const bots = createBotDriver({
    currentEpoch: () => 1,
    botDelayMs: () => 0,
    me,
    identityOf: (seat) => ({ seat, name: `Seat ${seat}`, persona: null }),
    actingSeatsOf: acting || ((s) => (s.gameOver ? [] : [s.turn.seat])),
    announcementsFor: () => [],
    playMove: (_state, move, seat) => played.push({ seat, type: move.type }),
    playAnnouncement: () => {},
    onError: (message) => errors.push(message),
  });
  return { bots, played, errors, me };
}

async function crazyEights(seats = 3) {
  const pack = await loadPackFromDisk('crazy-eights');
  const state = createState({ pack, seats, seed: 4242 });
  pack.template.setup(makeCtx(state));
  return state;
}

test('the driver plays a seat the lens does not call mine', async () => {
  const clock = fakeSessionClock();
  const state = await crazyEights(3);
  state.turn.seat = 1; // a bot's turn

  const { bots, played, errors } = driverFor(soloSeatTable(3), state);
  const session = freshSession(state);
  bots.scheduleNextTurn(session, 1);
  assert.equal(clock.flush(), 1, 'one turn was scheduled');

  assert.deepEqual(errors, []);
  assert.equal(played.length, 1);
  assert.equal(played[0].seat, 1);
});

test('the driver never plays the seat this device holds', async () => {
  const clock = fakeSessionClock();
  const state = await crazyEights(3);
  state.turn.seat = 0; // the human's own turn, in a solo table

  const { bots, played } = driverFor(soloSeatTable(3), state);
  bots.scheduleNextTurn(freshSession(state), 1);

  assert.equal(clock.pending.length, 0, 'nothing is scheduled on my own turn');
  assert.equal(played.length, 0);
});

test('MINE IS NOT SEAT ZERO: the driver skips whichever seat the lens names', async () => {
  // The regression this package exists for. A joiner holding seat 2 must see
  // the driver play seats 0 and 1 and leave 2 alone — the exact inverse of
  // what a hard-coded `humanSeat = 0` would do.
  const clock = fakeSessionClock();
  const state = await crazyEights(3);

  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(2, { deviceId: 'me' });
  seats.seatBot(0);
  seats.seatBot(1);

  const { bots, played } = driverFor(seats, state);

  state.turn.seat = 2; // MY turn now — the driver must not move for me
  bots.scheduleNextTurn(freshSession(state), 1);
  assert.equal(clock.pending.length, 0, 'seat 2 is mine, so nothing is scheduled');

  state.turn.seat = 0; // a bot's turn, at the index a constant would have called "human"
  bots.scheduleNextTurn(freshSession(state), 1);
  assert.equal(clock.flush(), 1);
  assert.equal(played.length, 1);
  assert.equal(played[0].seat, 0);
});

test('hotseat: every seat this device holds is skipped, not just the first', async () => {
  const clock = fakeSessionClock();
  const state = await crazyEights(3);

  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(0, { deviceId: 'me', localIndex: 0 });
  seats.claim(1, { deviceId: 'me', localIndex: 1 });
  seats.seatBot(2);

  const { bots, played } = driverFor(seats, state);

  for (const seat of [0, 1]) {
    state.turn.seat = seat;
    bots.scheduleNextTurn(freshSession(state), 1);
    assert.equal(clock.pending.length, 0, `seat ${seat} is mine`);
  }

  state.turn.seat = 2;
  bots.scheduleNextTurn(freshSession(state), 1);
  assert.equal(clock.flush(), 1);
  assert.deepEqual(played.map((p) => p.seat), [2]);
});

test('ownership is re-read at fire time, not captured when the turn was scheduled', async () => {
  // A bot filling an abandoned seat, and the player coming back to reclaim it,
  // both change the answer BETWEEN the schedule and the fire. A captured
  // number cannot see that; the lens can.
  const clock = fakeSessionClock();
  const state = await crazyEights(3);
  state.turn.seat = 1;

  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(0, { deviceId: 'me' });
  seats.seatBot(1);
  seats.seatBot(2);

  const { bots, played } = driverFor(seats, state);
  bots.scheduleNextTurn(freshSession(state), 1);
  assert.equal(clock.pending.length, 1, 'seat 1 was a bot when this was scheduled');

  // The seat's owner comes back before the timer lands.
  seats.claim(1, { deviceId: 'me', localIndex: 1 });
  clock.flush();

  assert.equal(played.length, 0, 'the driver re-asked and declined to play a seat now mine');
});

test('a lens with no table yet answers seat 0, so the pre-match felt is unchanged', () => {
  const lens = createSeatLens(() => null);
  assert.equal(lens.seat(), 0);
  assert.equal(lens.holds(0), true);
  assert.equal(lens.holds(1), false);
});

test('an unseated joiner holds nothing and still draws a table', () => {
  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  const lens = createSeatLens(() => seats);
  // No claim yet: `seat()` must still answer a number the renderer can use,
  // and `holds` must be false for every seat so no hand is drawn as mine.
  assert.equal(lens.seat(), 0);
  for (const seat of [0, 1, 2]) assert.equal(lens.holds(seat), false);
});
