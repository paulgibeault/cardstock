// THE LEAK TESTS.
//
// The whole multiplayer design rests on one claim: what the host sends a seat
// contains nothing that seat may not see. Everything else — the protocol, the
// lobby, the recovery ladder — is plumbing around that claim, so it is asserted
// STRUCTURALLY rather than field by field.
//
// The method: play every pack out with bots, and at every single step, for
// every seat, walk the entire serialised payload looking for any string that is
// a card id, and check it against the set that seat is genuinely entitled to.
// A test that only looked where ids are supposed to live would pass for exactly
// as long as nobody put one somewhere new — which is precisely how
// `drawnCardId` (a card in one player's hand, living in a SHARED var) got past
// a first reading of this codebase.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { applyMove, enumerateLegalMoves } from '../src/engine/movePipeline.js';
import { chooseBotMove } from '../src/engine/bot.js';
import { serializeMatch } from '../src/engine/replay.js';
import { viewFor, eventsFor, cardIdsIn, VIEW_VERSION } from '../src/engine/view.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';

const PACKS = ['crazy-eights', 'wildfire', 'hearts', 'milestones', 'stockpile'];

async function tableFor(packId, seats = 3) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed: 20260810 });
  pack.template.setup(makeCtx(state));
  return state;
}

/**
 * Is this string one of the pack's card ids?
 *
 * AMBIGUOUS STRINGS ARE EXCLUDED, and Wildfire is why. Its deck gives the
 * wild-draw-four card the id `wild-draw4` AND the rank `wild-draw4`, so the
 * public "what rank is currently in play" var carries a string identical to a
 * card id. A sweep that flagged it would be reporting a leak that is not one,
 * and a test that cries wolf gets its assertion loosened later by somebody in
 * a hurry.
 *
 * The cost is real and worth naming: a genuine leak of that ONE copy (`#2`,
 * `#3` and `#4` stay unambiguous and are still caught) would slip this sweep.
 * The structural per-zone assertions below cover it — they check that a
 * foreign hand carries no `cards` array at all, which no rank collision can
 * mask.
 */
function cardIdChecker(state) {
  const ids = new Set(state.zones.allAddresses().flatMap((a) => state.zones.cards(a)));
  const attributes = new Set();
  for (const card of state.pack.cardsById.values()) {
    for (const [key, value] of Object.entries(card)) {
      if (key === 'id') continue; // the id is what we are looking FOR
      if (typeof value === 'string') attributes.add(value);
    }
  }
  return (value) => ids.has(value) && !attributes.has(value);
}

/**
 * What `seat` is genuinely entitled to see, computed from the STATE rather than
 * from the view — so the test never grades the filter against itself.
 */
function entitled(state, seat) {
  const ok = new Set();
  for (const address of state.zones.allAddresses()) {
    const instance = state.zones.get(address);
    const def = instance.def;
    if (def.visibility === 'all') {
      for (const id of instance.cards) ok.add(id);
    } else if (def.visibility === 'owner' && instance.seat === seat) {
      for (const id of instance.cards) ok.add(id);
    } else if (def.visibility === 'top' && instance.cards.length) {
      ok.add(instance.cards[instance.cards.length - 1]);
    }
  }
  return ok;
}

/** Every card id in another seat's hand — the ids that matter most. */
function foreignHands(state, seat) {
  const out = new Set();
  for (const address of state.zones.allAddresses()) {
    const instance = state.zones.get(address);
    if (instance.def.visibility === 'owner' && instance.seat !== seat) {
      for (const id of instance.cards) out.add(id);
    }
  }
  return out;
}

/** One step of bot play; returns false when there is nothing legal left. */
function stepOnce(state) {
  const template = state.pack.template;
  const acting = template.actingSeats
    ? template.actingSeats(makeCtx(state))
    : [state.turn.seat];
  for (const seat of acting) {
    const move = chooseBotMove(state, seat);
    if (move) {
      applyMove(state, move);
      return true;
    }
  }
  return false;
}

for (const packId of PACKS) {
  test(`${packId}: no seat's view ever contains a card it may not see`, async () => {
    const state = await tableFor(packId);
    const isCardId = cardIdChecker(state);
    let steps = 0;

    while (steps < 120 && !state.gameOver) {
      for (let seat = 0; seat < state.seats; seat++) {
        const allowed = entitled(state, seat);
        const foreign = foreignHands(state, seat);

        const view = viewFor(state, seat, {
          moves: enumerateLegalMoves(state, seat),
          announcements: state.pack.template.enumerateAnnouncements
            ? state.pack.template.enumerateAnnouncements(makeCtx(state), seat)
            : [],
        });
        const events = eventsFor(state, seat, state.events);

        for (const payload of [view, events]) {
          const wire = JSON.parse(JSON.stringify(payload));
          for (const id of cardIdsIn(wire, isCardId)) {
            assert.ok(
              !foreign.has(id),
              `${packId} step ${steps}: seat ${seat} was sent ${id}, which is in another seat's hand`,
            );
            assert.ok(
              allowed.has(id),
              `${packId} step ${steps}: seat ${seat} was sent ${id}, which it is not entitled to see`,
            );
          }
        }
      }
      if (!stepOnce(state)) break;
      steps += 1;
    }

    assert.ok(steps > 5, `${packId} only managed ${steps} steps — the sweep proved little`);
  });
}

test('THE SEED NEVER LEAVES THE HOST', async () => {
  // The save payload is full information by construction: seed + log replays
  // every hand at the table. That is right for storage and wrong for a peer,
  // and it is the single most expensive mistake this design could make.
  const state = await tableFor('crazy-eights');
  const save = serializeMatch(state);
  assert.ok(save.seed !== undefined, 'the SAVE still carries it');

  for (let seat = 0; seat < state.seats; seat++) {
    const wire = JSON.stringify(viewFor(state, seat));
    assert.ok(!wire.includes(String(state.seed)), `seat ${seat}'s view carries the seed`);
    assert.equal(JSON.parse(wire).seed, undefined);
    assert.equal(JSON.parse(wire).log, undefined);
  }
});

test('a hand is real ids for its owner and a bare count for everyone else', async () => {
  const state = await tableFor('crazy-eights');
  const mine = viewFor(state, 0);
  const theirs = viewFor(state, 1);

  assert.ok(Array.isArray(mine.zones['hand.0'].cards), 'I see my own hand');
  assert.equal(mine.zones['hand.0'].cards.length, mine.zones['hand.0'].count);

  assert.equal(theirs.zones['hand.0'].cards, undefined, 'they get no ids for my hand');
  assert.equal(theirs.zones['hand.0'].count, mine.zones['hand.0'].count, 'but they do get the count');
});

test('a face-down deck is a count to everybody — that is the shuffle', async () => {
  const state = await tableFor('crazy-eights');
  for (let seat = 0; seat < state.seats; seat++) {
    const view = viewFor(state, seat);
    assert.equal(view.zones.draw.cards, undefined);
    assert.equal(view.zones.draw.top, undefined);
    assert.ok(view.zones.draw.count > 0);
  }
});

test('a top-visibility pile sends the top card and hides the history', async () => {
  const state = await tableFor('crazy-eights');
  const view = viewFor(state, 0);
  const discard = view.zones.discard;
  assert.equal(typeof discard.top, 'string');
  assert.equal(discard.cards, undefined, 'the pile beneath stays hidden');
  // It matters here beyond taste: shedding recycles the discard back into the
  // draw pile, so publishing its order would publish the future deck.
  assert.ok(discard.count >= 1);
});

test("Hearts' won pile hides its cards but publishes its cost", async () => {
  // The audit's subtlest finding: `visibility: 'none'` yet the felt has always
  // shown the running points, because everyone watched the tricks being taken.
  const state = await tableFor('hearts', 4);
  let guard = 0;
  while (guard++ < 200 && !state.zones.cards('won.0').length && !state.gameOver) {
    if (!stepOnce(state)) break;
  }

  const view = viewFor(state, 1);
  const won = view.zones['won.0'];
  assert.equal(won.cards, undefined, 'nobody leafs through the tricks');
  assert.equal(typeof won.heldValue, 'number', 'but the cost is public');
});

test('a simultaneous commit stays committed — nobody reads my pass', async () => {
  // Hearts' passing phase is only a commit for as long as the other seats
  // cannot see the selection.
  const state = await tableFor('hearts', 4);
  const move = chooseBotMove(state, 0);
  assert.equal(move.type, 'passCards');
  applyMove(state, move);
  assert.ok(state.playerVars[0].__pendingPass, 'seat 0 has committed');

  const mine = viewFor(state, 0);
  assert.ok(mine.playerVars[0].__pendingPass, 'I can see my own commitment');

  for (const spy of [1, 2, 3]) {
    const view = viewFor(state, spy);
    assert.equal(view.playerVars[0].__pendingPass, undefined,
      `seat ${spy} can read seat 0's committed pass`);
  }
});

test('an undeclared shared var reaches only the seat whose turn produced it', async () => {
  // `drawnCardId` is a card in somebody's hand living in a SHARED var. The
  // allowlist is what stops it, and this is the case it was built for.
  const state = await tableFor('crazy-eights');
  const drawer = state.turn.seat;
  const draw = enumerateLegalMoves(state, drawer).find((m) => m.type === 'draw');
  assert.ok(draw, 'a draw is available');
  applyMove(state, draw);

  if (state.vars.drawnCardId) {
    const mine = viewFor(state, drawer);
    assert.equal(mine.privateVars.drawnCardId, state.vars.drawnCardId,
      'the drawer needs it to play the card it just drew');
    for (let seat = 0; seat < state.seats; seat++) {
      if (seat === drawer) continue;
      const view = viewFor(state, seat);
      assert.equal(view.vars.drawnCardId, undefined);
      assert.equal(view.privateVars.drawnCardId, undefined,
        `seat ${seat} was told which card seat ${drawer} drew`);
    }
  }
});

test('public shared vars do reach everyone — the filter is not just "hide"', async () => {
  const state = await tableFor('hearts', 4);
  state.vars.leader = 2;
  state.vars.led = 'hearts';
  for (let seat = 0; seat < state.seats; seat++) {
    const view = viewFor(state, seat);
    assert.equal(view.vars.leader, 2);
    assert.equal(view.vars.led, 'hearts');
  }
});

test('public player vars reach everyone; the contract ladder needs them', async () => {
  const state = await tableFor('milestones', 3);
  state.playerVars[1].phase = 3;
  state.playerVars[1].laidDown = true;
  const view = viewFor(state, 0);
  assert.equal(view.playerVars[1].phase, 3);
  assert.equal(view.playerVars[1].laidDown, true);
});

test('a spectator sees the public table and no hand at all', async () => {
  const state = await tableFor('crazy-eights');
  const view = viewFor(state, null);
  for (let seat = 0; seat < state.seats; seat++) {
    assert.equal(view.zones[`hand.${seat}`].cards, undefined);
    assert.ok(view.zones[`hand.${seat}`].count > 0);
  }
  assert.deepEqual(view.privateVars, {});
});

test('a view is plain JSON — no Maps, no RNG, no pack, no live aliasing', async () => {
  const state = await tableFor('stockpile', 3);
  const view = viewFor(state, 0, { moves: enumerateLegalMoves(state, 0) });
  const round = JSON.parse(JSON.stringify(view));
  assert.deepEqual(round, view, 'survives a round trip unchanged');

  // Nothing in the view may alias live engine state.
  const before = state.zones.cards('hand.0').slice();
  view.zones['hand.0'].cards.push('tampered');
  assert.deepEqual(state.zones.cards('hand.0'), before);
  assert.equal(view.v, VIEW_VERSION);
});

test('legal moves ride with the view, and only for the seat asking', async () => {
  const state = await tableFor('crazy-eights');
  const acting = state.turn.seat;
  const moves = enumerateLegalMoves(state, acting);
  const view = viewFor(state, acting, { moves });
  assert.ok(view.moves.length > 0);
  assert.deepEqual(view.moves, JSON.parse(JSON.stringify(moves)));

  const other = viewFor(state, (acting + 1) % state.seats);
  assert.deepEqual(other.moves, [], 'a seat that did not ask is told nothing');
});

test('an event carrying a hidden card is stripped but keeps its shape', async () => {
  const state = await tableFor('crazy-eights');
  const hidden = state.zones.cards('hand.1')[0];
  const visible = state.zones.cards('discard')[0];
  const events = [{ type: 'invented', seat: 1, cards: [hidden, visible] }];

  const seen = eventsFor(state, 0, events)[0];
  assert.ok(!seen.cards.includes(hidden), 'the foreign card is gone');
  assert.equal(seen.hiddenCards, 1, 'but the count survives, so a flight can still be sized');

  const owner = eventsFor(state, 1, events)[0];
  assert.ok(owner.cards.includes(hidden), 'its owner still sees it');
  assert.equal(owner.hiddenCards, undefined);
});

test('a template publishes vars its RULES name, not just literal ones', async () => {
  // Shedding's public vars are one `active<Attr>` per attribute the pack
  // matches on, so Wildfire (which matches on colour and rank) publishes
  // `activeRank` while Crazy Eights does not. A literal allowlist could not
  // have expressed that, and the sweep above caught it as a false leak.
  const wildfire = await tableFor('wildfire');
  const attrs = wildfire.pack.rules.matchOn;
  assert.ok(attrs.includes('rank'), 'wildfire matches on rank');

  wildfire.vars.activeRank = 'wild-draw4';
  for (let seat = 0; seat < wildfire.seats; seat++) {
    const view = viewFor(wildfire, seat);
    assert.equal(view.vars.activeRank, 'wild-draw4',
      `seat ${seat} must be told what is currently in play`);
  }
});

test('a template that declares nothing publishes nothing', async () => {
  const state = await tableFor('milestones', 3);
  state.vars.somethingNobodyDeclared = 'secret';
  const other = viewFor(state, (state.turn.seat + 1) % state.seats);
  assert.equal(other.vars.somethingNobodyDeclared, undefined);
  assert.equal(other.privateVars.somethingNobodyDeclared, undefined);
});
