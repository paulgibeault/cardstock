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
// The felt cannot pin this itself. The driver's clock is injected, and the one
// solo hands it is the session clock — `Arcade.session.setTimeout`, which
// freezes while the frame is suspended (§6c). A preview pane loads the page
// hidden, so a browser check of the bot path sits frozen and verifies nothing
// at all. A fake clock is the only honest way to assert any of this.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';
import { createSeatTable, createSeatLens, soloSeatTable } from '../src/players/seats.js';
import { createBotDriver } from '../src/ui/botDriver.js';
import { applyMove } from '../src/engine/movePipeline.js';
import { chooseBotMove } from '../src/engine/bot.js';

/**
 * A clock that fires nothing on its own.
 *
 * The driver takes its clock as a seam (src/match/clock.js), so the tests hand
 * it one whose pending callbacks are parked and run by hand. `flush` is what a
 * suspended frame never does — which is the whole reason this coverage is a
 * Node test rather than a click-through: a preview pane loads the page hidden,
 * so the real session clock would sit frozen and every assertion below would
 * pass vacuously.
 */
function fakeClock() {
  const pending = [];
  return {
    pending,
    kind: 'fake',
    now: () => 0,
    after(ms, fn) {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return { cancel() { entry.cancelled = true; } };
    },
    at(expiresAt, fn) { return this.after(expiresAt, fn); },
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
function driverFor(seatTable, state, { acting = null, clock = fakeClock(), difficulty = undefined } = {}) {
  const played = [];
  const errors = [];
  const me = createSeatLens(() => seatTable);
  const bots = createBotDriver({
    clock,
    currentEpoch: () => 1,
    botDelayMs: () => 0,
    ...(difficulty ? { difficulty } : {}),
    me,
    identityOf: (seat) => ({ seat, name: `Seat ${seat}`, persona: null }),
    actingSeatsOf: acting || ((s) => (s.gameOver ? [] : [s.turn.seat])),
    announcementsFor: () => [],
    playMove: (_state, move, seat) => played.push({ seat, type: move.type, move }),
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
  const clock = fakeClock();
  const state = await crazyEights(3);
  state.turn.seat = 1; // a bot's turn

  const { bots, played, errors } = driverFor(soloSeatTable(3), state, { clock });
  const session = freshSession(state);
  bots.scheduleNextTurn(session, 1);
  assert.equal(clock.flush(), 1, 'one turn was scheduled');

  assert.deepEqual(errors, []);
  assert.equal(played.length, 1);
  assert.equal(played[0].seat, 1);
});

test('the driver never plays the seat this device holds', async () => {
  const clock = fakeClock();
  const state = await crazyEights(3);
  state.turn.seat = 0; // the human's own turn, in a solo table

  const { bots, played } = driverFor(soloSeatTable(3), state, { clock });
  bots.scheduleNextTurn(freshSession(state), 1);

  assert.equal(clock.pending.length, 0, 'nothing is scheduled on my own turn');
  assert.equal(played.length, 0);
});

test('MINE IS NOT SEAT ZERO: the driver skips whichever seat the lens names', async () => {
  // The regression this package exists for. A joiner holding seat 2 must see
  // the driver play seats 0 and 1 and leave 2 alone — the exact inverse of
  // what a hard-coded `humanSeat = 0` would do.
  const clock = fakeClock();
  const state = await crazyEights(3);

  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(2, { deviceId: 'me' });
  seats.seatBot(0);
  seats.seatBot(1);

  const { bots, played } = driverFor(seats, state, { clock });

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
  const clock = fakeClock();
  const state = await crazyEights(3);

  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(0, { deviceId: 'me', localIndex: 0 });
  seats.claim(1, { deviceId: 'me', localIndex: 1 });
  seats.seatBot(2);

  const { bots, played } = driverFor(seats, state, { clock });

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
  const clock = fakeClock();
  const state = await crazyEights(3);
  state.turn.seat = 1;

  const seats = createSeatTable({ seats: 3, localDeviceId: 'me' });
  seats.claim(0, { deviceId: 'me' });
  seats.seatBot(1);
  seats.seatBot(2);

  const { bots, played } = driverFor(seats, state, { clock });
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

/* ------------------------------------------------------------------ *
 * The difficulty dial reaches the chooser
 * ------------------------------------------------------------------ */

test('the driver hands the table its difficulty, and reads it when the turn fires', async () => {
  // THE WIRING IS THE WHOLE FEATURE HERE. A difficulty setting the driver reads
  // but never forwards is a preference that changes nothing, and it would pass
  // every other test in this file — the driver still plays the right seat at
  // the right time, just always at the default depth. So this asserts on the
  // MOVE: a position where easy and medium genuinely disagree, played twice.
  //
  // Read at fire time rather than at schedule time, like `botDelayMs` is:
  // changing the dial mid-hand should take effect on the next turn, not at the
  // next deal.
  const state = await crazyEights(3);
  let seat = null;
  for (let i = 0; i < 200 && seat === null; i++) {
    const acting = state.turn.seat;
    const move = chooseBotMove(state, acting);
    if (!move) break;
    // Seat 0 is this device's in a solo table, so the driver would decline it.
    if (acting !== 0
      && JSON.stringify(chooseBotMove(state, acting, { difficulty: 'easy' })) !== JSON.stringify(move)) {
      seat = acting;
      break;
    }
    applyMove(state, move);
    if (state.events.some((e) => e.type === 'roundOver')) break;
  }
  assert.notStrictEqual(seat, null,
    'no crazy-eights position found where easy and medium disagree — this test cannot tell them apart');

  const asked = [];
  for (const depth of ['easy', 'medium']) {
    const clock = fakeClock();
    const { bots, played } = driverFor(soloSeatTable(3), state, {
      clock, difficulty: () => { asked.push(depth); return depth; },
    });
    const before = asked.length;
    bots.scheduleNextTurn(freshSession(state), 1);
    assert.strictEqual(asked.length, before,
      'the difficulty was read while merely SCHEDULING the turn, so changing it mid-hand would not land');
    clock.flush();
    assert.strictEqual(played.length, 1, `${depth}: the turn did not play`);
    assert.deepStrictEqual(played[0].move, chooseBotMove(state, seat, { difficulty: depth }),
      `${depth}: the driver played something other than what that difficulty chooses`);
  }
});
