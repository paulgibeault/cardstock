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

const PACKS = ['crazy-eights', 'wildfire', 'hearts', 'milestones', 'stockpile', 'thirteen', 'pinochle'];

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

// Three seats unless the pack cannot be played at three. Pinochle declares
// 4/4 — and at three the sweep would run it teamless and with a sixteen-card
// hand, which is a table nobody can sit at and a weaker test than the one this
// pack actually needs.
const SWEEP_SEATS = { pinochle: 4 };

for (const packId of PACKS) {
  test(`${packId}: no seat's view ever contains a card it may not see`, async () => {
    const state = await tableFor(packId, SWEEP_SEATS[packId] ?? 3);
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

/* ------------------------------------------------------------------ *
 * A partnership at a hosted table (#105)
 * ------------------------------------------------------------------ *
 *
 * Two humans as partners is the case Team Spades adds, and it asks the filter
 * two things nothing before it did: a promise everybody heard must REACH
 * everybody, and a partner's hand must stay as hidden as an opponent's. The
 * second is the one worth stating out loud — "we are a side" is a scoring fact
 * and not a licence to see each other's cards, and a filter that had confused
 * the two would have looked perfectly reasonable in a diff.
 */

/** Bid every seat's way through the bidding phase and stop at the first lead. */
async function bidRound(seed = 'spades:view') {
  const pack = await loadPackFromDisk('team-spades');
  const state = createState({ pack, seats: 4, seed });
  pack.template.setup(makeCtx(state));
  assert.equal(state.turn.phase, 'bid', 'a Spades hand opens in the bidding phase');
  let guard = 0;
  while (state.turn.phase === 'bid' && guard++ < 10) {
    const move = chooseBotMove(state, state.turn.seat);
    assert.equal(move.type, 'bid');
    applyMove(state, move);
  }
  assert.equal(state.turn.phase, 'play', 'the bidding finished');
  return state;
}

test('Team Spades: every seat is told every bid — a promise is said out loud', async () => {
  const state = await bidRound();
  const bids = state.playerVars.map((vars) => vars.bid);
  assert.ok(bids.every((bid) => Number.isInteger(bid)), `every seat bid: ${JSON.stringify(bids)}`);

  for (let seat = 0; seat < state.seats; seat++) {
    const view = viewFor(state, seat, { moves: enumerateLegalMoves(state, seat) });
    for (let other = 0; other < state.seats; other++) {
      assert.equal(view.playerVars[other].bid, bids[other],
        `seat ${seat} cannot see what seat ${other} bid, and the seats after it bid knowing`);
    }
  }
});

test('Team Spades: a partner is a shared score, not a shared hand', async () => {
  const state = await bidRound('spades:partners');
  // seats 0 and 2 are one side, 1 and 3 the other (src/engine/sides.js).
  const view = viewFor(state, 0, { moves: enumerateLegalMoves(state, 0) });
  assert.ok(Array.isArray(view.zones['hand.0'].cards), 'I see my own hand');

  for (const other of [1, 2, 3]) {
    const zone = view.zones[`hand.${other}`];
    assert.equal(zone.cards, undefined,
      `seat 0 was sent seat ${other}'s hand${other === 2 ? ' — its PARTNER\'s hand' : ''}`);
    assert.equal(zone.count, state.zones.cards(`hand.${other}`).length, 'the count is public, as it always was');
  }

  // And structurally, over the whole payload: nothing of the partner's hand
  // reaches the seat by any other field either.
  const isCardId = cardIdChecker(state);
  const partnerCards = new Set(state.zones.cards('hand.2'));
  const wire = JSON.parse(JSON.stringify(view));
  for (const id of cardIdsIn(wire, isCardId)) {
    assert.ok(!partnerCards.has(id), `${id} is in the partner's hand and reached seat 0`);
  }
});

test('Team Spades: the whole hand plays out without a card reaching the wrong seat', async () => {
  // The same structural sweep the packs above get, at the four-seat partnership
  // table this pack actually seats — and through the bidding phase, which is
  // the first phase in the repo where the acting seat holds no card at all.
  const state = await bidRound('spades:sweep');
  const isCardId = cardIdChecker(state);
  let steps = 0;
  while (steps < 60 && !state.gameOver) {
    for (let seat = 0; seat < state.seats; seat++) {
      const allowed = entitled(state, seat);
      const foreign = foreignHands(state, seat);
      const view = viewFor(state, seat, { moves: enumerateLegalMoves(state, seat) });
      const wire = JSON.parse(JSON.stringify(view));
      for (const id of cardIdsIn(wire, isCardId)) {
        assert.ok(!foreign.has(id), `step ${steps}: seat ${seat} was sent ${id}, in another seat's hand`);
        assert.ok(allowed.has(id), `step ${steps}: seat ${seat} was sent ${id}, which it may not see`);
      }
    }
    if (!stepOnce(state)) break;
    steps += 1;
  }
  assert.ok(steps > 20, `only ${steps} steps — the sweep proved little`);
});

/* ------------------------------------------------------------------ *
 * Pinochle: a meld is SHOWN and a hand is not (#106)
 * ------------------------------------------------------------------ */

/**
 * A Pinochle hand carried through its auction and its meld phase, stopping at
 * the first lead — the position this pack's whole privacy question lives in.
 */
async function meldRound(seed = 'pinochle:melds') {
  const pack = await loadPackFromDisk('pinochle');
  const state = createState({ pack, seats: 4, seed });
  pack.template.setup(makeCtx(state));
  assert.equal(state.turn.phase, 'bid', 'a Pinochle hand opens in the bidding phase');
  let guard = 0;
  while (state.turn.phase !== 'play' && guard++ < 30) {
    const acting = pack.template.actingSeats(makeCtx(state));
    let played = false;
    for (const seat of acting) {
      const move = chooseBotMove(state, seat);
      if (!move) continue;
      applyMove(state, move);
      played = true;
      break;
    }
    assert.ok(played, `nothing legal in phase ${state.turn.phase}`);
  }
  assert.equal(state.turn.phase, 'play', 'the auction and the meld both finished');
  return state;
}

test('Pinochle: every seat is told every meld — a declaration is said out loud', async () => {
  const state = await meldRound();
  const melds = state.playerVars.map((vars) => vars.meld);
  assert.ok(melds.every((m) => m && Number.isFinite(m.points)),
    `every seat declared: ${JSON.stringify(melds)}`);
  assert.ok(melds.some((m) => m.points > 0),
    'no seat at this table melded anything, so the test would pass on an empty record');

  for (let seat = 0; seat < state.seats; seat++) {
    const view = viewFor(state, seat, { moves: enumerateLegalMoves(state, seat) });
    for (let other = 0; other < state.seats; other++) {
      assert.deepEqual(view.playerVars[other].meld, melds[other],
        `seat ${seat} cannot read what seat ${other} melded, and everybody at a table writes it down`);
    }
    // The commit on its way in is the opposite rule, and it has been cleared by
    // now — but a template that left it behind would be publishing a card list.
    for (let other = 0; other < state.seats; other++) {
      assert.equal(view.playerVars[other].__pendingMeld, undefined,
        `seat ${seat} was sent seat ${other}'s pending meld selection`);
    }
  }
});

test('Pinochle: a meld is scored, not laid down — the cards stay in a hand nobody may read', async () => {
  const state = await meldRound('pinochle:hands');
  const isCardId = cardIdChecker(state);

  for (let seat = 0; seat < state.seats; seat++) {
    assert.equal(state.zones.cards(`hand.${seat}`).length, 12,
      `seat ${seat} does not hold twelve cards — a declaration moved something`);
  }

  const view = viewFor(state, 0, { moves: enumerateLegalMoves(state, 0) });
  assert.ok(Array.isArray(view.zones['hand.0'].cards), 'I see my own hand');
  for (const other of [1, 2, 3]) {
    assert.equal(view.zones[`hand.${other}`].cards, undefined,
      `seat 0 was sent seat ${other}'s hand${other === 2 ? " — its PARTNER's hand" : ''}`);
  }

  // AND STRUCTURALLY, WHICH IS THE POINT. The melds are public and the cards
  // that made them are not, so the record has to carry names and numbers and no
  // ids at all — see `detectDeclaredMelds`. A meld var that shipped its cards
  // would put every other seat's holding on the wire while every zone in the
  // payload was still correctly redacted.
  const foreign = foreignHands(state, 0);
  const wire = JSON.parse(JSON.stringify(view));
  for (const id of cardIdsIn(wire, isCardId)) {
    assert.ok(!foreign.has(id), `${id} is in another seat's hand and reached seat 0`);
  }
});

test('Pinochle: the pending declaration is a commit — nobody reads it before the phase closes', async () => {
  const pack = await loadPackFromDisk('pinochle');
  const state = createState({ pack, seats: 4, seed: 'pinochle:commit' });
  pack.template.setup(makeCtx(state));
  let guard = 0;
  while (state.turn.phase === 'bid' && guard++ < 20) applyMove(state, chooseBotMove(state, state.turn.seat));
  assert.equal(state.turn.phase, 'meld');

  // One seat commits; the other three have not, so the phase is still open.
  applyMove(state, chooseBotMove(state, 0));
  assert.equal(state.turn.phase, 'meld', 'one declaration did not close the phase');
  // ASKED THROUGH THE PLATFORM'S OWN ACCESSOR rather than by reaching for the
  // private var by name: `committedSelection` is what the felt draws a staged
  // card from (src/templates/CONTRACT.md), so a template that renamed or
  // un-hid its bookkeeping still answers this — and the leak assertions below
  // are then the ones that fire, instead of the setup line.
  const pending = pack.template.committedSelection(makeCtx(state), 0);
  assert.ok(Array.isArray(pending) && pending.length, 'seat 0 has a commit on record');

  const isCardId = cardIdChecker(state);
  for (const seat of [1, 2, 3]) {
    const view = viewFor(state, seat, { moves: enumerateLegalMoves(state, seat) });
    const wire = JSON.parse(JSON.stringify(view));
    const leaked = [...cardIdsIn(wire, isCardId)].filter((id) => pending.includes(id));
    assert.deepEqual(leaked, [], `seat ${seat} was sent ${leaked.join(', ')} out of seat 0's commit`);
  }
  // Its owner still sees it, or the felt could not draw its own staged cards.
  const own = JSON.parse(JSON.stringify(viewFor(state, 0, { moves: enumerateLegalMoves(state, 0) })));
  const mine = new Set(cardIdsIn(own, isCardId));
  assert.ok(pending.every((id) => mine.has(id)), 'seat 0 cannot see its own commit');
});

test('a shared var nobody declared is published to nobody', async () => {
  // The allowlist, from the other side: milestones declares exactly one shared
  // var, and a second one appearing in the bag — a new template's bookkeeping,
  // a stray write — must not ride out with it.
  const state = await tableFor('milestones', 3);
  state.vars.somethingNobodyDeclared = 'secret';
  const other = viewFor(state, (state.turn.seat + 1) % state.seats);
  assert.equal(other.vars.somethingNobodyDeclared, undefined);
  assert.equal(other.privateVars.somethingNobodyDeclared, undefined);
});

test('a hand on offer is a count to everybody, its own picker included', async () => {
  // THE ONE PILE IN THE REPO WHOSE OWNER MAY NOT LOOK AT IT (#157). Thirteen at
  // two seats deals three face-down hands of seventeen and each player takes
  // one — and the whole decision is that you are picking blind. A `cards` array
  // reaching ANY seat would not be a subtle privacy bug, it would be the phase
  // stopping being a choice: the seat on turn would be picking the pile it had
  // already read.
  //
  // The per-seat sweep at the top of this file covers three and four seats;
  // this is the deal that only exists at two, and the seat it matters most for
  // is the one the platform's own `privateVars` rule would otherwise let
  // through — the seat whose turn it is.
  const state = await tableFor('thirteen', 2);
  assert.equal(state.turn.phase, 'choose', 'the two-handed deal did not open on the pick');
  const offers = ['offer.1', 'offer.2', 'offer.3'];
  for (const address of [...offers, 'aside']) {
    assert.ok(state.zones.count(address) > 0, `${address} is empty, so this proves nothing`);
  }

  const isCardId = cardIdChecker(state);
  for (const seat of [0, 1, null]) {
    const view = viewFor(state, seat, {
      moves: seat === null ? [] : enumerateLegalMoves(state, seat),
    });
    const wire = JSON.parse(JSON.stringify(view));
    // Structural: no list at all, from a zone nobody may look into.
    for (const address of [...offers, 'aside']) {
      assert.equal(wire.zones[address].cards, undefined,
        `seat ${seat} was sent the cards of ${address}`);
      assert.equal(wire.zones[address].top, undefined,
        `seat ${seat} was sent the top of ${address}`);
      assert.equal(wire.zones[address].count, state.zones.count(address),
        `seat ${seat} has the wrong count for ${address} — the SIZE is public`);
    }
    // ...and the sweep, over the whole payload including the legal moves that
    // ride with it: a `takeHand` names a pile, never a card.
    const allowed = entitled(state, seat);
    for (const id of cardIdsIn(wire, isCardId)) {
      assert.ok(allowed.has(id), `seat ${seat} was sent ${id}, which is sitting in a pile on offer`);
    }
  }

  // Taking one is the moment the cards become yours and nobody else's — the
  // same rule the hand zone has always had, arriving seventeen at a time.
  const picker = state.turn.seat;
  applyMove(state, { actor: picker, type: 'takeHand', from: 'offer.1' });
  const mine = viewFor(state, picker);
  const theirs = viewFor(state, 1 - picker);
  assert.equal(mine.zones[`hand.${picker}`].cards.length, 17);
  assert.equal(theirs.zones[`hand.${picker}`].cards, undefined);
  assert.equal(theirs.zones[`hand.${picker}`].count, 17);
  // And the event that announced it carried the count and never the ids.
  const taken = state.events.find((e) => e.type === 'handTaken');
  assert.ok(taken && taken.count === 17, 'no handTaken event, or it does not say how many');
  assert.equal(taken.cards, undefined, 'the handTaken event carries card ids');
});

test('a joiner sees the combination on the table and who has dropped out', async () => {
  // WHAT A CLIMBING TABLE IS UNPLAYABLE WITHOUT (#102). A joiner holds a view
  // and never a state, so anything the felt draws that is not a zone has to be
  // in the shared-var allowlist — and for this genre that is the STANDING
  // COMBINATION (what shape and size you have to answer, and what you have to
  // beat) and the PASS STATE (who is still in the trick). Neither is derivable
  // from the pile: a pile of six cards could be three consecutive pairs or a
  // six-card run, and nothing about the cards says who declined to answer them.
  const state = await tableFor('thirteen', 4);

  // The opening lead, then one seat passing, so both facts are real.
  applyMove(state, chooseBotMove(state, state.turn.seat));
  const passer = state.turn.seat;
  applyMove(state, { actor: passer, type: 'pass' });

  const combo = state.vars.combo;
  assert.ok(combo && combo.kind, 'no combination was recorded on the table');

  for (let seat = 0; seat < state.seats; seat++) {
    const view = viewFor(state, seat, { moves: enumerateLegalMoves(state, seat) });
    assert.deepEqual(view.vars.combo, combo, `seat ${seat} cannot see what is on the table`);
    assert.deepEqual(view.vars.passed, [passer], `seat ${seat} cannot see who has passed`);
    assert.equal(view.vars.lastPlayer, state.vars.lastPlayer);
    assert.equal(view.vars.trickNumber, state.vars.trickNumber);

    // ...and still nobody else's hand. The combination's cards are ids, and
    // they are ids of cards face up in the pile — which is exactly why the
    // sweep above has to keep passing with them published.
    for (let other = 0; other < state.seats; other++) {
      if (other === seat) continue;
      assert.equal(view.zones[`hand.${other}`].cards, undefined,
        `seat ${seat} was sent seat ${other}'s hand`);
      assert.equal(view.zones[`hand.${other}`].count, state.zones.count(`hand.${other}`));
    }
    assert.ok(Array.isArray(view.zones[`hand.${seat}`].cards), 'a seat cannot see its own hand');
  }

  // A spectator gets the table and no hand at all, the combination included —
  // it is the one thing that makes watching legible.
  const spectator = viewFor(state, null);
  assert.deepEqual(spectator.vars.combo, combo);
  assert.deepEqual(spectator.vars.passed, [passer]);
  for (let seat = 0; seat < state.seats; seat++) {
    assert.equal(spectator.zones[`hand.${seat}`].cards, undefined);
  }
});
