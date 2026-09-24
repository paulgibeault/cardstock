// THE ONE LINE THAT USED TO BE FIVE LINES (#208).
//
// `actingSeats` and `announcementsFor` were copied into the felt, the party
// turn timer, the party bot driver, the match host, the rollout and
// tools/simulate.mjs. The copies had drifted: the turn timer's was missing the
// `gameOver` guard, so a deadline could be re-armed against `turn.seat` after
// the match was over. They are engine exports now, and these pin the rule the
// copies are supposed to share — most of all `gameOver -> []`, which no other
// test in the suite happened to observe.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx, actingSeats, announcementsFor } from '../src/engine/context.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return { pack, state };
}

test('without the hook, the acting seat is the seat whose turn it is', async () => {
  const { pack, state } = await dealt('crazy-eights', 3, 4242);
  assert.equal(pack.template.actingSeats, undefined, 'crazy-eights takes the default');
  assert.deepEqual(actingSeats(state), [state.turn.seat]);
});

test('a simultaneous-commit phase acts on every seat that has not committed', async () => {
  const { state } = await dealt('hearts', 4, 99);
  assert.equal(state.turn.phase, 'pass', 'hearts deals into its passing phase');
  assert.deepEqual(actingSeats(state), [0, 1, 2, 3], 'nobody has committed a pass yet');
});

test('a finished match acts on nobody, hook or no hook', async () => {
  for (const id of ['crazy-eights', 'hearts']) {
    const { state } = await dealt(id, 4, 7);
    assert.ok(actingSeats(state).length > 0, `${id} acts before the match ends`);

    state.gameOver = true;
    assert.deepEqual(actingSeats(state), [], `${id} acts on nobody once gameOver`);
  }
});

test('announcementsFor is empty without the hook, and offers the call with it', async () => {
  const plain = await dealt('hearts', 4, 5);
  assert.equal(plain.pack.template.enumerateAnnouncements, undefined, 'hearts declares none');
  assert.deepEqual(announcementsFor(plain.state, 0), [], 'no hook is an empty list, not undefined');

  const wild = await dealt('wildfire', 3, 5);
  assert.ok(wild.pack.template.enumerateAnnouncements, 'wildfire declares the last-card call');
  assert.deepEqual(announcementsFor(wild.state, 0), [], 'a full hand is nowhere near the call');

  // Down to the last card: the window the button exists for.
  const ctx = makeCtx(wild.state);
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', 0));
  ctx.moveCards(hand.slice(1), ctx.zoneAddr('hand', 0), 'discard');
  const offered = announcementsFor(wild.state, 0);
  assert.ok(offered.some((m) => m.type === 'announce'), 'seat 0 may now call last card');
});
