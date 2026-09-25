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
import { makeCtx, actingSeats, announcementsFor } from '../src/engine/context.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';
import { soloSeatTable, createSeatTable } from '../src/players/seats.js';
import { createBotDriver } from '../src/ui/botDriver.js';
import { botDriverSeams } from '../src/ui/botSeams.js';

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

  // The felt's epoch is still a module slot (until #225), so it passes one.
  const felt = botDriverSeams(() => session, seamsOf({ epoch: () => 99 }));
  assert.equal(felt.currentEpoch(), 99);
});

test('the engine answers who acts and what they may say, unless the caller knows better', () => {
  const seams = botDriverSeams(() => null, seamsOf());
  assert.equal(seams.actingSeatsOf, actingSeats);
  assert.equal(seams.announcementsFor, announcementsFor);
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

test('both drivers are built through the one builder, once each', () => {
  for (const file of ['src/ui/table.js', 'src/ui/party.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal((code.match(/createBotDriver\(/g) || []).length, 1, `${file}: one driver`);
    assert.match(code, /createBotDriver\(botDriverSeams\(\(\) => session, \{/,
      `${file}: the driver's shared seams must come from src/ui/botSeams.js, not a second spelling`);
    // The two live reads are the ones that drifted before (#91, #184).
    for (const shared of ['botDelayMs:', 'difficulty:']) {
      assert.ok(!code.includes(shared), `${file} spells \`${shared}\` again — it is botSeams.js's`);
    }
  }
});
