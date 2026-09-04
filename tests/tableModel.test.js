// THE FELT MUST NOT BE ABLE TO TELL WHICH MODEL IT WAS HANDED.
//
// A joiner draws its table from a ViewState; the host and the solo player draw
// theirs from a real engine state. One renderer serves both, so the whole
// arrangement rests on the view model answering every question the renderer
// asks — and the failure mode if it does not is the worst kind: a `undefined`
// that only appears when two devices are paired, which is exactly the
// configuration nobody is running while they work.
//
// So the parity check below is written from a LIST OF THE READS THE UI MAKES,
// not from a list of what the model happens to expose. When somebody teaches
// the renderer a new question, this test is what tells them there are two
// places to answer it.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { applyMove, enumerateLegalMoves } from '../src/engine/movePipeline.js';
import { chooseBotMove } from '../src/engine/bot.js';
import { viewFor } from '../src/engine/view.js';
import { buildUiModel } from '../src/ui/interaction.js';
import { modelFromState, modelFromView, isHiddenCardId } from '../src/ui/tableModel.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';

async function tableFor(packId, seats = 3, moves = 0) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed: 20260810 });
  pack.template.setup(makeCtx(state));
  for (let i = 0; i < moves; i++) {
    const acting = pack.template.actingSeats
      ? pack.template.actingSeats(makeCtx(state)) : [state.turn.seat];
    const move = chooseBotMove(state, acting[0]);
    if (!move) break;
    applyMove(state, move);
  }
  return { pack, state };
}

function modelOf({ pack, state }, seat) {
  const view = JSON.parse(JSON.stringify(viewFor(state, seat, {
    moves: enumerateLegalMoves(state, seat),
  })));
  return modelFromView(view, pack);
}

/* ------------------------------------------------------------------ *
 * Parity
 * ------------------------------------------------------------------ */

test('modelFromState is the identity — the solo path cannot regress', async () => {
  const { state } = await tableFor('crazy-eights');
  assert.equal(modelFromState(state), state);
});

test('THE VIEW MODEL ANSWERS EVERY READ THE UI MAKES', async () => {
  // The list is the contract. A renderer that learns a new question needs a
  // line here, and this test is what says so.
  const table = await tableFor('crazy-eights', 3, 4);
  const model = modelOf(table, 1);

  const scalarReads = [
    'seats', 'direction', 'roundNumber', 'roundScores', 'roundEnded',
    'roundWinner', 'gameOver', 'winner',
  ];
  for (const key of scalarReads) {
    assert.ok(key in model, `model is missing ${key}`);
  }
  for (const key of ['turn', 'scores', 'playerVars', 'vars', 'pack', 'zones', 'log', 'events']) {
    assert.ok(model[key] !== undefined, `model is missing ${key}`);
  }

  assert.equal(typeof model.turn.seat, 'number');
  assert.ok('phase' in model.turn);
  assert.equal(model.scores.length, table.state.seats);
  assert.equal(model.playerVars.length, table.state.seats);

  // The zone surface the UI actually calls.
  for (const method of ['cards', 'count', 'top', 'has', 'get', 'allAddresses']) {
    assert.equal(typeof model.zones[method], 'function', `zones.${method} is missing`);
  }
  // And the pack surface.
  assert.equal(typeof model.pack.cardsById.get, 'function');
  assert.ok(model.pack.template, 'the template travels with the model');
  assert.ok(model.pack.manifest, 'and the manifest');
});

test('every zone address exists in the model, with the real definitions', async () => {
  const table = await tableFor('stockpile', 3, 4);
  const model = modelOf(table, 1);

  const real = table.state.zones.allAddresses().sort();
  const seen = model.zones.allAddresses().sort();
  assert.deepEqual(seen, real, 'a missing address is a pile that does not draw');

  for (const address of real) {
    assert.equal(model.zones.get(address).def.id, table.state.zones.get(address).def.id);
    assert.equal(model.zones.get(address).def.visibility, table.state.zones.get(address).def.visibility);
  }
});

test('every pile has its true DEPTH, whether or not its cards are visible', async () => {
  // A pile that draws with the wrong depth is a pile that lies about the game:
  // in Stockpile the stock count IS the race, and in Hearts a hand size is how
  // you know who is short.
  for (const packId of ['crazy-eights', 'hearts', 'milestones', 'stockpile']) {
    const table = await tableFor(packId, 3, 3);
    const model = modelOf(table, 1);
    for (const address of table.state.zones.allAddresses()) {
      assert.equal(
        model.zones.count(address),
        table.state.zones.count(address),
        `${packId}: ${address} has the wrong depth`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Secrecy
 * ------------------------------------------------------------------ */

test('the model contains no card the view did not carry', async () => {
  const table = await tableFor('crazy-eights', 3, 4);
  const model = modelOf(table, 1);

  const foreign = new Set(table.state.zones.cards('hand.0').concat(table.state.zones.cards('hand.2')));
  for (const address of model.zones.allAddresses()) {
    for (const id of model.zones.cards(address)) {
      assert.ok(!foreign.has(id), `${address} carries ${id} from another hand`);
    }
  }
});

test('a hidden card resolves to a face-down card, so the pile still draws', async () => {
  // The renderer skips a card it cannot look up, and a skipped card is a pile
  // drawn at the wrong depth. This is the reason placeholders resolve at all.
  const table = await tableFor('crazy-eights', 3, 2);
  const model = modelOf(table, 1);

  const draw = model.zones.cards('draw');
  assert.ok(draw.length > 0);
  for (const id of draw) {
    assert.ok(isHiddenCardId(id), 'the deck is nobody\'s to see');
    const card = model.pack.cardsById.get(id);
    assert.ok(card, 'but it must still resolve, or the pile loses its depth');
    assert.equal(card.hidden, true);
  }
});

test('a top-visible pile shows the top card and backs beneath it', async () => {
  const table = await tableFor('crazy-eights', 3, 4);
  const model = modelOf(table, 1);

  const discard = model.zones.cards('discard');
  const realTop = table.state.zones.top('discard');
  assert.equal(model.zones.top('discard'), realTop, 'the top is the real card');
  for (const id of discard.slice(0, -1)) {
    assert.ok(isHiddenCardId(id), 'the history under it is not');
  }
});

test('my own hand is real, and the opponents are depth only', async () => {
  const table = await tableFor('crazy-eights', 3, 2);
  const model = modelOf(table, 1);

  assert.deepEqual(model.zones.cards('hand.1'), table.state.zones.cards('hand.1'));
  for (const seat of [0, 2]) {
    const cards = model.zones.cards(`hand.${seat}`);
    assert.equal(cards.length, table.state.zones.count(`hand.${seat}`));
    assert.ok(cards.every(isHiddenCardId), `seat ${seat}'s hand leaked`);
  }
});

test('placeholder ids can never collide with a real card id', async () => {
  const table = await tableFor('wildfire', 3, 3);
  const model = modelOf(table, 1);
  for (const address of model.zones.allAddresses()) {
    for (const id of model.zones.cards(address)) {
      if (!isHiddenCardId(id)) continue;
      assert.ok(!table.pack.cardsById.has(id), `${id} collides with a real card`);
      // `~` is outside the [\w-] charset every real id is held to, which is
      // what makes the collision structurally impossible rather than unlikely.
      assert.ok(!/^[\w-]/.test(id));
    }
  }
});

/* ------------------------------------------------------------------ *
 * The things a client must not pretend to have
 * ------------------------------------------------------------------ */

test('a client model carries no log and no seed', async () => {
  const table = await tableFor('crazy-eights', 3, 5);
  const model = modelOf(table, 1);
  assert.deepEqual(model.log, [], 'the log is the match, and the host owns it');
  assert.equal(model.seed, undefined);
  assert.ok(!JSON.stringify(model.view).includes(String(table.state.seed)));
});

test('the seat\'s own private vars are merged where a template looks for them', async () => {
  const table = await tableFor('crazy-eights', 3, 0);
  const drawer = table.state.turn.seat;
  const draw = enumerateLegalMoves(table.state, drawer).find((m) => m.type === 'draw');
  if (!draw) return;
  applyMove(table.state, draw);

  const model = modelOf(table, drawer);
  if (table.state.vars.drawnCardId) {
    assert.equal(model.vars.drawnCardId, table.state.vars.drawnCardId,
      'the drawer needs it exactly where vars.drawnCardId has always been');
  }
  const other = modelOf(table, (drawer + 1) % table.state.seats);
  assert.equal(other.vars.drawnCardId, undefined);
});

test('legal moves come from the host, not from enumerating a partial state', async () => {
  const table = await tableFor('crazy-eights', 3, 0);
  const acting = table.state.turn.seat;
  const model = modelOf(table, acting);
  assert.ok(model.moves.length > 0);
  assert.deepEqual(model.moves, JSON.parse(JSON.stringify(enumerateLegalMoves(table.state, acting))));
});

test('a model survives a JSON round trip of the view it was built from', async () => {
  // The view arrives off a wire, so it has already been through JSON. Anything
  // that only works on a live object would fail in production and pass here if
  // the test skipped the trip.
  const table = await tableFor('hearts', 4, 6);
  const view = JSON.parse(JSON.stringify(viewFor(table.state, 2)));
  const model = modelFromView(view, table.pack);
  assert.equal(model.zones.count('hand.2'), table.state.zones.count('hand.2'));
  assert.deepEqual(model.zones.cards('hand.2'), table.state.zones.cards('hand.2'));
});

/* ------------------------------------------------------------------ *
 * Driving the actual UI
 * ------------------------------------------------------------------ */

test('A CLIENT BUILDS THE SAME UI MODEL AS THE HOST, for its own seat', async () => {
  // The strongest proof available without a browser. `src/ui/interaction.js` is
  // the module that decides what is selectable, what is a drop target, what the
  // action button says — everything the felt does that is not painting. It is
  // DOM-free, so it can be run against both models and the answers compared.
  //
  // If these agree for every seat in every pack, a joiner's table behaves
  // exactly like the host's view of the same seat, which is the whole claim.
  for (const packId of ['crazy-eights', 'wildfire', 'hearts', 'milestones', 'stockpile']) {
    const table = await tableFor(packId, 3, 5);
    for (let seat = 0; seat < table.state.seats; seat++) {
      const acting = table.pack.template.actingSeats
        ? table.pack.template.actingSeats(makeCtx(table.state))
        : [table.state.turn.seat];
      const acts = acting.includes(seat);
      const moves = acts ? enumerateLegalMoves(table.state, seat) : [];

      const fromState = buildUiModel(table.state, { seat, moves, acts });
      const model = modelOf(table, seat);
      const fromView = buildUiModel(model, { seat, moves: model.moves, acts });

      assert.equal(fromView.mode, fromState.mode, `${packId} seat ${seat}: interaction mode`);
      assert.equal(fromView.hint, fromState.hint, `${packId} seat ${seat}: hint`);
      assert.equal(fromView.handMulti, fromState.handMulti, `${packId} seat ${seat}: multi-select`);
      // What arms hold-to-gather (src/ui/handGestures.js). It comes from the
      // template's `gathers` hook, which reads a per-player var — so a joiner
      // that is not sent its own vars would silently lose the gesture.
      assert.equal(fromView.gathering, fromState.gathering,
        `${packId} seat ${seat}: hold-to-gather arming`);
      assert.deepEqual(
        [...fromView.handSelectable].sort(),
        [...fromState.handSelectable].sort(),
        `${packId} seat ${seat}: a different set of cards is playable`,
      );
      assert.deepEqual(
        [...fromView.readyTargets.keys()].sort(),
        [...fromState.readyTargets.keys()].sort(),
        `${packId} seat ${seat}: a different set of drop targets`,
      );
      assert.deepEqual(
        [...fromView.sourceTops.keys()].sort(),
        [...fromState.sourceTops.keys()].sort(),
        `${packId} seat ${seat}: a different set of pick-up piles`,
      );
      // THE BUTTON IS A LABEL AND THE MOVE IT SENDS, and both halves have to
      // match. `deepEqual` on the objects themselves compares `makeMove` by
      // reference, so it could only ever pass where BOTH models had no action
      // at all — which is what it happened to be doing, because the five bot
      // moves above never reached a position with a button on it. Improving the
      // bot moved the wildfire line onto a "Keep it" and the assertion started
      // failing on two closures that build the identical move.
      const button = (ui) => (ui.action ? { label: ui.action.label, move: ui.action.makeMove() } : null);
      assert.deepEqual(button(fromView), button(fromState), `${packId} seat ${seat}: action button`);
    }
  }
});
