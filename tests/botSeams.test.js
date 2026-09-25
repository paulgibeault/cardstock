// ONE OPTION LIST FOR BOTH BOT DRIVERS (#223 seam 7).
//
// The felt's driver (src/ui/table.js) and the headless one for a hosted table
// nobody is looking at (src/ui/party.js) used to spell `createBotDriver`'s
// whole option list twice. src/ui/botSeams.js spells the shared half once;
// this asks it what each shared seam answers, that the seams which differ are
// the caller's and nobody else's, and that a driver built from it plays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../tools/stage.mjs';
import { installArcade } from './fixtures/arcade.js';
import { createState } from '../src/engine/state.js';
import { makeCtx, actingSeats, announcementsFor as engineAnnouncementsFor } from '../src/engine/context.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';
import { soloSeatTable, createSeatTable } from '../src/players/seats.js';
import { createBotDriver } from '../src/ui/botDriver.js';
import { botDriverSeams, announcementsFor } from '../src/ui/botSeams.js';

const noop = () => {};
const seamsOf = (extra = {}) => ({
  clock: { kind: 'fake', after: noop, at: noop, now: () => 0 },
  identityOf: (seat) => ({ seat, name: `Seat ${seat}` }),
  playMove: noop,
  playAnnouncement: noop,
  onError: noop,
  ...extra,
});

test('the settings are read at fire time, not when the driver is built', () => {
  const { store } = installArcade({ state: true });
  const seams = botDriverSeams(() => null, seamsOf());
  store.set('settings', { botDelayMs: 1100, botDifficulty: 'easy' });
  assert.equal(seams.botDelayMs(), 1100);
  assert.equal(seams.difficulty(), 'easy');
  // The new-game sheet writes storage between two matches; the driver outlives both.
  store.set('settings', { botDelayMs: 350, botDifficulty: 'hard' });
  assert.equal(seams.botDelayMs(), 350, 'a Slow match dealt after a Brisk one must play at Slow');
  assert.equal(seams.difficulty(), 'hard', 'a Sharp game dealt after a Steady one must play Sharp');
});

test('the seat lens and the epoch are asked of whichever session is current', () => {
  let session = null;
  const seams = botDriverSeams(() => session, seamsOf());
  // Between matches: the lens's own fallback, never a throw.
  assert.equal(seams.me.seat(), 0);
  assert.equal(seams.me.plays(1), true);

  // A shared table where this device holds seat 2 and seat 1 is a joiner's.
  const seats = createSeatTable({
    seats: 4,
    localDeviceId: 'me',
    owners: [{ kind: 'bot' }, { kind: 'device', deviceId: 'them' }, { kind: 'device', deviceId: 'me' }, null],
  });
  session = { seats, epoch: 7 };
  assert.equal(seams.me.seat(), 2, 'the lens reads the session it is asked in, not the one it was built in');
  assert.equal(seams.me.plays(1), false, 'the house never plays a joiner\'s chair');
  assert.equal(seams.me.plays(3), true);
  assert.equal(seams.currentEpoch(), 7, 'a session carries its own epoch, and that is the default');
  session = { seats: soloSeatTable(4), epoch: 8 };
  assert.equal(seams.currentEpoch(), 8);

  // The felt passes its own screen counter, which has to outlive every table it
  // shows (src/ui/table.js says why it cannot be the table's).
  const felt = botDriverSeams(() => session, seamsOf({ epoch: () => 99 }));
  assert.equal(felt.currentEpoch(), 99);
});

test('the engine answers who acts and what they may say, unless the caller knows better', async () => {
  const seams = botDriverSeams(() => null, seamsOf());
  assert.equal(seams.actingSeatsOf, actingSeats);
  // VIEW-AWARE BY DEFAULT (#225). The felt used to pass its own wrapper and the
  // headless driver took the engine's; now both take this one, which IS the
  // engine's answer for every state that is not a view.
  assert.equal(seams.announcementsFor, announcementsFor);
  installArcade({ state: true });
  const pack = await loadPackFromDisk('crazy-eights');
  const state = createState({ pack, seats: 3, seed: 4242 });
  pack.template.setup(makeCtx(state));
  for (let seat = 0; seat < 3; seat++) {
    assert.deepEqual(announcementsFor(state, seat), engineAnnouncementsFor(state, seat),
      'a real state is the engine\'s to answer');
  }
  const shipped = [{ type: 'announce', actor: 1 }];
  assert.equal(announcementsFor({ isView: true, announcements: shipped }, 1), shipped,
    'a CLIENT IS TOLD: a view answers with the list the host shipped, never an enumeration');
  const viewAware = () => [];
  assert.equal(botDriverSeams(() => null, seamsOf({ announcementsFor: viewAware })).announcementsFor, viewAware);
});

test('what differs is the caller\'s: handed through untouched, and never defaulted', () => {
  const given = seamsOf();
  const seams = botDriverSeams(() => null, given);
  for (const name of ['clock', 'identityOf', 'playMove', 'playAnnouncement', 'onError']) {
    assert.equal(seams[name], given[name], `${name} must be the caller's own`);
  }
  // NO DEFAULT CLOCK: a default is a fixed answer to "which clock", which is #71.
  assert.throws(() => botDriverSeams(() => null, seamsOf({ clock: undefined })), /needs clock/);
  assert.throws(() => botDriverSeams(() => null, seamsOf({ playMove: undefined, onError: 'x' })),
    /needs playMove, onError/);
});

test('a driver built from the seams plays a bot\'s turn through the caller\'s playMove', async () => {
  installArcade({ state: true });
  const pack = await loadPackFromDisk('crazy-eights');
  const state = createState({ pack, seats: 3, seed: 4242 });
  pack.template.setup(makeCtx(state));
  state.turn.seat = 1;
  const pending = [];
  const clock = { kind: 'fake', now: () => 0, after(ms, fn) { pending.push(fn); return { cancel() {} }; } };
  clock.at = clock.after;
  const played = [];
  const session = { seats: soloSeatTable(3), epoch: 1, state, botTimer: null, announceTimers: [],
    botCallDecision: new Map(), botCatchDecision: new Map() };
  const bots = createBotDriver(botDriverSeams(() => session, seamsOf({
    clock,
    playMove: (_s, move, seat) => played.push({ seat, type: move.type }),
    onError: (message) => assert.fail(message),
  })));
  bots.scheduleNextTurn(session, 1);
  assert.equal(pending.length, 1, 'the turn is scheduled on the clock the caller handed in');
  pending.shift()();
  assert.equal(played.length, 1);
  assert.equal(played[0].seat, 1);
});

// TWO EPOCHS, TWO LIFETIMES (#264). The table's epoch moves when the TABLE
// stops; the felt's moves when what the felt SHOWS changes. The case where they
// part is leaving a hosted table for the lobby: the felt's counter moves, the
// table's does not, and the table plays on headless. A felt driver that read
// the table's epoch would play a turn for a screen that is gone; a headless one
// that read the felt's would drop every turn of a table nobody is looking at.
test('the felt drops a turn when the SCREEN changes; the table\'s default drops it only when the table does', async () => {
  installArcade({ state: true });
  const pack = await loadPackFromDisk('crazy-eights');
  const state = createState({ pack, seats: 3, seed: 4242 });
  pack.template.setup(makeCtx(state));
  state.turn.seat = 1;
  const pending = [];
  const clock = { kind: 'fake', now: () => 0, after(ms, fn) { pending.push(fn); return { cancel() {} }; } };
  clock.at = clock.after;
  // BOTH COUNTERS START LEVEL, so the only thing that can drop the felt's turn
  // below is the showing moving — a driver reading the wrong counter plays it.
  const table = { seats: soloSeatTable(3), epoch: 0, state, botTimer: null, announceTimers: [],
    botCallDecision: new Map(), botCatchDecision: new Map() };
  const played = [];
  const driverFor = (who, extra = {}) => createBotDriver(botDriverSeams(() => table, seamsOf({
    clock,
    playMove: (_s, move, seat) => played.push({ who, seat }),
    onError: (message) => assert.fail(message),
    ...extra,
  })));
  let showing = 0;
  const felt = driverFor('felt', { epoch: () => showing });
  const headless = driverFor('headless');
  const fire = () => { assert.equal(pending.length, 1, 'one turn armed'); pending.shift()(); };

  // The felt's turn, armed under the showing it was scheduled in.
  felt.scheduleNextTurn(table, showing);
  // LEAVE FOR THE LOBBY: the doors bump the felt's counter; the table is unbound,
  // not stopped, so its own epoch stays where it was.
  showing += 1;
  fire();
  assert.deepEqual(played, [], 'the felt played a turn for a screen it has already left — '
    + 'its driver is reading the table\'s epoch, not the showing counter it was handed');

  // The same table, its epoch unmoved, plays on headless under the default seam.
  headless.scheduleNextTurn(table, table.epoch);
  fire();
  assert.deepEqual(played, [{ who: 'headless', seat: 1 }],
    'the headless driver must play on: the table did not end when the felt left it');

  // And the default is the TABLE's lifetime: a stopped table drops its turn.
  played.length = 0;
  state.turn.seat = 1;
  headless.scheduleNextTurn(table, table.epoch);
  table.epoch += 1; // what TableSession.stop() does first
  fire();
  assert.deepEqual(played, [], 'the default seam must read the table\'s own epoch');
});

test('both drivers are built through the one builder, once each', () => {
  for (const file of ['src/ui/table.js', 'src/ui/party.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal((code.match(/createBotDriver\(/g) || []).length, 1, `${file}: one driver`);
    // The felt's driver is handed the TABLE it draws (#225); the headless one
    // is built per table and closes over it.
    assert.match(code, /createBotDriver\(botDriverSeams\(\(\) => session(\?\.table \?\? null)?, \{/,
      `${file}: the driver's shared seams must come from src/ui/botSeams.js, not a second spelling`);
    // The two live reads are the ones that drifted before (#91, #184).
    for (const shared of ['botDelayMs:', 'difficulty:']) {
      assert.ok(!code.includes(shared), `${file} spells \`${shared}\` again — it is botSeams.js's`);
    }
    // AND THE VIEW-AWARE ANNOUNCEMENTS ARE THE BUILDER'S DEFAULT NOW (#225): a
    // caller that hands its own in again is a second spelling of that question.
    const call = code.slice(code.indexOf('createBotDriver(botDriverSeams('));
    const options = call.slice(0, call.indexOf('}));'));
    assert.ok(!/announcementsFor/.test(options),
      `${file} hands the bot driver its own announcementsFor — the builder's default is the view-aware one`);
  }
});
