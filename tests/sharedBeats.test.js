// A GUEST SEES WHAT THE HOST SEES (#283).
//
// The engine finishes a trick, ends a hand and deals the next one inside one
// move. The host's felt shows those moments off a pre-move copy, but a guest
// only ever had the post-move view: the fourth card of a trick never appeared,
// the score sheet never opened, and the end of the match never came. These
// tests pin the wire half of the fix: the host sends the posed positions and
// the pause it is in, refuses guest moves during that pause, and counts the
// guests' ready ticks. The felt half is src/ui/guestBeats.js, tested below
// with injected effects.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { chooseBotMove } from '../src/engine/bot.js';
import { actingSeats } from '../src/engine/context.js';
import { createSeatTable } from '../src/players/seats.js';
import { createTableHost } from '../src/match/host.js';
import { createTableClient } from '../src/match/client.js';
import { tableRules } from '../src/engine/tableRules.js';
import { validateFrame, FRAME } from '../src/match/protocol.js';
import { viewFrame, readyFrame } from '../src/match/frames.js';
import { createGuestBeats } from '../src/ui/guestBeats.js';
import { createPeerNetwork } from '../tools/peer-stub.mjs';
import { loadPackFromDisk } from '../tools/pack-test.mjs';

const TID = 'tbl-beats';

/** Hearts for four: the host at seat 0, Ada (a guest) at seat 1, two bots. */
async function heartsTable({ holdsBeats = () => false } = {}) {
  const pack = await loadPackFromDisk('hearts');
  const state = createState({ pack, seats: 4, seed: 20261003 });
  pack.template.setup(makeCtx(state));

  const net = createPeerNetwork({ hostDeviceId: 'host' });
  const hostPort = net.createDevice('host', { name: 'Host' });
  const aPort = net.createDevice('a', { name: 'Ada' });
  const seats = createSeatTable({ seats: 4, localDeviceId: 'host' });
  seats.claim(0, { deviceId: 'host' });

  const applied = [];
  const beats = [];
  const host = createTableHost({
    rules: tableRules,
    tableId: TID,
    peer: hostPort,
    seats,
    liveState: () => state,
    packInfo: () => ({ packId: pack.id, packVersion: pack.manifest?.version, variants: [] }),
    holdsBeats,
    hooks: {
      onApplied: (_state, move, _events, extra) => applied.push({ move, extra }),
      onBeat: (info) => beats.push(info),
    },
  });
  const seen = { views: [], rejects: [] };
  const a = createTableClient({
    rules: tableRules,
    tableId: TID,
    peer: aPort,
    expects: () => ({ packId: pack.id, packVersion: pack.manifest?.version, variants: [] }),
    hooks: {
      onView: (view, events, meta) => seen.views.push({ view, events, meta }),
      onReject: (frame) => seen.rejects.push(frame),
    },
  });
  host.start();
  a.start();
  net.ready('host', 'a');
  a.claimSeat(1);
  return { state, host, a, seen, applied, beats, net };
}

/**
 * Play one move the way a real table would: Ada proposes her own, the host
 * applies everyone else's. Returns the events of the move.
 */
function step(t) {
  const seat = actingSeats(t.state)[0];
  const move = chooseBotMove(t.state, seat);
  assert.ok(move, `seat ${seat} has a move`);
  if (seat === 1) t.a.propose(move);
  else t.host.applyLocal(move);
  return { seat, events: t.state.events.slice() };
}

/** Play until a move's events satisfy `until`; returns that move. */
function playUntil(t, until, cap = 400) {
  for (let i = 0; i < cap; i++) {
    const done = step(t);
    if (until(done)) return done;
  }
  throw new Error('never reached');
}

test('a guest is sent the completed trick, with its cards face up (#283)', async () => {
  const t = await heartsTable();
  playUntil(t, ({ events }) => events.some((e) => e.type === 'trickWon'));
  const last = t.seen.views.at(-1);
  const pose = last.meta.poses?.trick;
  assert.ok(pose, 'the frame that finished the trick carries the trick as it stood');
  assert.equal(pose.zones.trick.cards.length, 4, 'all four cards are on the posed trick');
  assert.deepEqual(pose.moves, [], 'nothing on a pose is actable');
  const won = last.events.find((e) => e.type === 'trickWon');
  assert.equal(won.cards.length, 4, 'the trick was face up, so its cards are not hidden from the guest');
  assert.equal(won.hiddenCards, undefined);
  assert.equal(last.view.zones.trick.cards.length, 0, 'while the live view has already swept it');
});

test("the host keeps the position before a guest's move, for its own felt (#283)", async () => {
  const t = await heartsTable();
  playUntil(t, ({ seat }) => seat === 1);
  const remote = t.applied.at(-1);
  assert.ok(remote.extra?.pre, 'onApplied is handed the pre-move copy');
  assert.notStrictEqual(remote.extra.pre, t.state, 'a copy, not the live state');
});

test('between hands the guest is held, refused, and can say it is ready (#283)', async () => {
  const t = await heartsTable({ holdsBeats: () => true });
  playUntil(t, ({ events }) => events.some((e) => e.type === 'roundOver'));
  const ended = t.seen.views.at(-1);
  assert.deepEqual(ended.meta.beat, { kind: 'round', ready: [] }, 'the guest is told the host is between hands');
  assert.ok(ended.meta.poses?.final, 'and is shown the hand as it ended');
  assert.deepEqual(ended.view.moves, [], 'no moves are offered under the sheet');
  assert.deepEqual(ended.view.deadlines, [], 'and nobody is on the clock');

  // A move that would be legal in the new hand is still refused.
  const hand = ended.view.zones['hand.1'].cards;
  t.a.propose({ actor: 1, type: 'play', cards: [hand[0]], from: 'hand.1', to: 'trick' });
  assert.equal(t.seen.rejects.at(-1)?.rule, 'between-hands');

  t.a.ready();
  assert.deepEqual(t.host.beat(), { kind: 'round', ready: [1] });
  assert.deepEqual(t.seen.views.at(-1).meta.beat, { kind: 'round', ready: [1] }, 'the tick goes back out');

  const before = t.seen.views.length;
  assert.equal(t.host.endBeat(), true);
  const after = t.seen.views.at(-1);
  assert.ok(t.seen.views.length > before, 'closing the beat publishes');
  assert.equal(after.meta.beat, null, 'the guest is let out');
  assert.equal(t.host.beat(), null);
  assert.deepEqual(t.beats.map((b) => b && b.ready), [[], [1], null]);
});

test('a host nobody is watching holds no beat (#283)', async () => {
  const t = await heartsTable({ holdsBeats: () => false });
  playUntil(t, ({ events }) => events.some((e) => e.type === 'roundOver'));
  assert.equal(t.seen.views.at(-1).meta.beat, null);
  assert.equal(t.host.beat(), null);
});

test('poses, beats and ready ticks survive the validator, and nonsense does not (#283)', () => {
  const view = { v: 1 };
  const frame = { ...viewFrame({ seq: 3, view, poses: { trick: view }, beat: { kind: 'round', ready: [1] } }), tableId: TID };
  const verdict = validateFrame(frame);
  assert.ok(verdict.ok, verdict.reason);
  assert.deepEqual(verdict.frame.poses, { trick: view });
  assert.deepEqual(verdict.frame.beat, { kind: 'round', ready: [1] });

  const bare = validateFrame({ ...viewFrame({ seq: 3, view }), tableId: TID });
  assert.ok(!('poses' in bare.frame) && !('beat' in bare.frame), 'an ordinary view is unchanged');

  assert.ok(validateFrame({ ...readyFrame(), tableId: TID }).ok);
  assert.equal(validateFrame({ ...frame, beat: { kind: 'nap' } }).ok, false);
  assert.equal(validateFrame({ ...frame, beat: { kind: 'round', ready: [99] } }).ok, false);
  assert.equal(validateFrame({ ...frame, poses: { trick: { nope: 1 } } }).ok, false);
  assert.equal(FRAME.READY, 'ready');
});

/* ------------------------------------------------------------------ *
 * The guest's felt: src/ui/guestBeats.js
 * ------------------------------------------------------------------ */

function fakeFelt() {
  const log = [];
  const timers = [];
  const beats = createGuestBeats({
    show: (view, opts = {}) => log.push(['show', view.id, opts.dealing ? 'dealing' : '']),
    openSummary: ({ view, event, ready }) => log.push(['summary', view.id, event?.round ?? null, ready.join()]),
    paintReady: (ready) => log.push(['ready', ready.join()]),
    closeSummary: () => log.push(['close']),
    showResults: (view) => log.push(['results', view.id]),
    hideResults: () => log.push(['hide-results']),
    holdMs: () => 1500,
    trickMessage: () => 'took it',
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false, cancel() { this.cancelled = true; } };
      timers.push(timer);
      return timer;
    },
  });
  const fire = () => {
    const timer = timers.shift();
    if (timer && !timer.cancelled) timer.fn();
  };
  return { beats, log, timers, fire };
}

const trickWon = { type: 'trickWon', seat: 2, cards: ['a', 'b', 'c', 'd'] };
const roundOver = { type: 'roundOver', round: 1, scores: {}, totals: [0, 0, 0, 0] };

test('a guest holds the completed trick, and what came after it waits (#283)', () => {
  const f = fakeFelt();
  f.beats.receive({ id: 'live1' }, [trickWon], { poses: { trick: { id: 'pose1' } } });
  f.beats.receive({ id: 'live2' }, [], {});
  assert.deepEqual(f.log, [['show', 'pose1', '']], 'the trick is on the felt, and the next view is queued');
  assert.equal(f.timers[0].ms, 1500);
  f.fire();
  assert.deepEqual(f.log.slice(1), [['show', 'live1', ''], ['show', 'live2', '']]);
});

test("a guest's sheet stays up exactly as long as the host's (#283)", () => {
  const f = fakeFelt();
  const beat = { kind: 'round', ready: [] };
  f.beats.receive({ id: 'next' }, [trickWon, roundOver],
    { poses: { trick: { id: 'pose' }, final: { id: 'ended' } }, beat });
  f.fire();
  assert.deepEqual(f.log, [['show', 'pose', ''], ['show', 'ended', ''], ['summary', 'next', 1, '']]);
  assert.equal(f.beats.betweenHands(), true);

  f.beats.receive({ id: 'next' }, [], { beat: { kind: 'round', ready: [1] } });
  assert.deepEqual(f.log.at(-1), ['ready', '1'], 'a tick repaints and changes nothing else');

  f.beats.receive({ id: 'next2' }, [], {});
  assert.deepEqual(f.log.slice(-2), [['close'], ['show', 'next2', 'dealing']], 'the host dealt on, so the guest does');
  assert.equal(f.beats.betweenHands(), false);
});

test('a hand that ends with nobody holding it deals straight on (#283)', () => {
  const f = fakeFelt();
  f.beats.receive({ id: 'next' }, [roundOver], {});
  assert.deepEqual(f.log, [['show', 'next', 'dealing']]);
});

test('the end of the match reaches the guest, and a rematch takes it down (#283)', () => {
  const f = fakeFelt();
  f.beats.receive({ id: 'over', gameOver: true }, [trickWon, { ...roundOver, over: true }],
    { poses: { trick: { id: 'pose' }, final: { id: 'ended' } } });
  f.fire();
  assert.deepEqual(f.log, [['show', 'pose', ''], ['show', 'ended', ''], ['results', 'over']]);
  f.beats.receive({ id: 'fresh' }, [], {});
  assert.deepEqual(f.log.slice(-2), [['hide-results'], ['show', 'fresh', '']]);
});

test('a guest who reconnects mid-sheet is caught up and told the host is between hands (#283)', () => {
  const f = fakeFelt();
  f.beats.receive({ id: 'now' }, [], { snapshot: true, beat: { kind: 'round', ready: [2] } });
  assert.deepEqual(f.log, [['show', 'now', ''], ['summary', 'now', null, '2']]);
});

test('leaving mid-hold cancels the hold and closes what is open (#283)', () => {
  const f = fakeFelt();
  f.beats.receive({ id: 'live' }, [trickWon], { poses: { trick: { id: 'pose' } } });
  f.beats.reset();
  assert.equal(f.timers[0].cancelled, true);
  f.timers[0].fn(); // a timer that fires anyway must not draw
  assert.deepEqual(f.log, [['show', 'pose', '']]);
});
