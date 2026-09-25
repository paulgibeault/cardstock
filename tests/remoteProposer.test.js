// THE REMOTE PROPOSER, TREATED AS AN ADVERSARY — for every pack we ship.
//
// tests/protocol.test.js pins the individual refusals on one pack, because
// that is where the protocol's own behaviour is easiest to read. This file
// asks the harder question and asks it everywhere: after a hostile `propose`
// has been through the whole pipeline — validateFrame, the seat-authority
// lookup, the card table, validateMove — is the state BIT-IDENTICAL to what it
// was before the frame arrived?
//
// WHY BIT-IDENTICAL AND NOT "the move wasn't applied". A refusal that leaves a
// footprint is a refusal a peer can steer with. The two footprints worth
// naming, because neither is visible in the log:
//
//   * THE RNG STREAM. `applyMove` draws from a seeded generator, and a match is
//     replayed from seed + log (src/engine/replay.js). A refused proposal that
//     advanced the stream by one call would desync every client from the host
//     at the next shuffle, and nothing in the log would say why. The
//     fingerprint therefore includes `rng.getState()`.
//   * THE EVENT WINDOW. `state.events` is what the table animates from, so a
//     refused move that left an event behind is a card that flies on a client
//     and never moved on the host.
//
// THE POSITIVE CONTROL IS NOT OPTIONAL. Every assertion here is of the form
// "nothing happened", and the cheapest way to pass all of them is to be wired
// up wrong — a host that never received the frame passes the entire corpus.
// So each pack also proposes one genuinely legal move from the seat that holds
// it and asserts the state DID move. Without that, this file grades itself.

import { test } from 'node:test';
import assert from 'node:assert';

import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { enumerateLegalMoves, validateMove } from '../src/engine/movePipeline.js';
import { createSeatTable } from '../src/players/seats.js';
import { createTableHost } from '../src/match/host.js';
import { createTableClient } from '../src/match/client.js';
// THE ENVELOPE IS BUILT; THE MOVE IS THE HOSTILE PART. Every case below is a
// structurally perfect `propose` carrying a lie, which is the only shape that
// reaches validateMove at all — so the frame comes off the same builder the
// real client uses and the corpus stays about the move.
import { proposeFrame, viewFrame } from '../src/match/frames.js';
import { createPeerNetwork } from '../tools/peer-stub.mjs';
import { loadPackFromDisk, listPackIds } from '../tools/pack-test.mjs';

/** The table these hostile frames are aimed at (protocol v2). */
const TID = 'tbl-hostile';

/* ------------------------------------------------------------------ *
 * A host and one remote proposer, on any pack
 * ------------------------------------------------------------------ */

/**
 * Build a table on `packId` where the joiner holds a seat that can actually
 * move, and return everything a hostile frame needs to be aimed.
 *
 * The seat is CHOSEN rather than assumed. Seat 1 is not acting in every pack
 * at every phase — Hearts opens on a simultaneous pass, contract rummy opens
 * on a draw — and a corpus aimed at a seat with no legal moves would refuse
 * everything for the wrong reason and prove nothing.
 */
async function tableFor(packId) {
  const pack = await loadPackFromDisk(packId);
  const seatCount = Math.max(2, pack.manifest.players.best ?? pack.manifest.players.min ?? 2);
  const state = createState({ pack, seats: seatCount, seed: `hostile:${packId}` });
  pack.template.setup(makeCtx(state));

  let seat = null;
  for (let candidate = 1; candidate < seatCount; candidate++) {
    state.turn.seat = candidate;
    if (enumerateLegalMoves(state, candidate).length) { seat = candidate; break; }
  }
  assert.ok(seat !== null, `${packId}: no non-host seat could move — the corpus would prove nothing`);

  const net = createPeerNetwork({ hostDeviceId: 'host' });
  const hostPort = net.createDevice('host', { name: 'Host' });
  const aPort = net.createDevice('a', { name: 'Ada' });

  const seats = createSeatTable({ seats: seatCount, localDeviceId: 'host' });
  seats.claim(0, { deviceId: 'host' });

  const hostErrors = [];
  const host = createTableHost({ tableId: TID,
    peer: hostPort,
    seats,
    liveState: () => state,
    packInfo: () => ({
      packId: pack.id,
      packVersion: pack.manifest?.version,
      variants: pack.activeVariants ?? [],
    }),
    nameFor: (s) => `Seat ${s}`,
    hooks: { onError: (e) => hostErrors.push(e) },
  });

  const rejects = [];
  const a = createTableClient({ tableId: TID,
    peer: aPort,
    expects: () => ({
      packId: pack.id,
      packVersion: pack.manifest?.version,
      variants: pack.activeVariants ?? [],
    }),
    hooks: { onReject: (frame) => rejects.push(frame) },
  });

  host.start();
  a.start();
  net.ready('host', 'a');
  a.claimSeat(seat);

  return { pack, state, seat, seats, host, a, net, aPort, hostErrors, rejects };
}

/**
 * Everything a move could touch, as one string.
 *
 * Structural rather than a list of the fields we expect to be at risk: a
 * fingerprint that only looked where mutation is supposed to happen would pass
 * for exactly as long as nobody mutated somewhere new.
 */
function fingerprint(state) {
  return JSON.stringify({
    log: state.log,
    events: state.events,
    turn: state.turn,
    direction: state.direction,
    vars: state.vars,
    playerVars: state.playerVars,
    scores: state.scores,
    roundNumber: state.roundNumber,
    roundScores: state.roundScores,
    roundEnded: state.roundEnded,
    roundWinner: state.roundWinner,
    gameOver: state.gameOver,
    winner: state.winner,
    zones: state.zones.allAddresses().map((address) => [address, state.zones.cards(address)]),
    // The footprint no other assertion can see: a refused move that drew from
    // the stream desyncs every replay from here on.
    rng: state.rng.getState(),
  });
}

/* ------------------------------------------------------------------ *
 * The corpus
 * ------------------------------------------------------------------ */

/**
 * Hostile frames, built against a live table so each one is plausible rather
 * than merely malformed — a foreign card is a REAL card that a real seat is
 * really holding, which is the version the host cannot refuse on shape alone.
 *
 * TWO KINDS, AND THE SECOND ONE HAS TO BE DERIVED. The shape cases are
 * universal: no pack has ever heard of `summonDragon` and no table has a seat
 * 44. The legality cases are not — "play somebody else's card" is only a
 * hostile frame in a pack whose current phase HAS a card-playing move, and a
 * corpus that hard-coded `playCard` would quietly degrade into an
 * unknown-move-type refusal on the packs that call it something else, testing
 * the same line twice and the interesting line never. So those are built from
 * the seat's own legal moves and skipped, loudly, when this phase cannot
 * express them.
 *
 * `silentOk` marks the few the host may drop without a word; everything else
 * must produce a targeted reject or a logged bad-frame, because a refusal
 * nobody is told about is a client that retries forever.
 */
function corpus({ state, seat }) {
  const seatCount = state.seats;
  const otherSeat = seat === 0 ? 1 : 0;
  const otherHand = `hand.${otherSeat}`;
  const foreignCard = state.zones.cards(otherHand)?.[0] ?? 'no-card';
  const legal = enumerateLegalMoves(state, seat);
  const anyMove = legal[0];
  const withCards = legal.find((m) => Array.isArray(m.cards) && m.cards.length);
  const withFrom = legal.find((m) => typeof m.from === 'string');

  const cases = [
    {
      name: 'a move whose actor is a seat the sender does not hold',
      frame: { ...proposeFrame('h1', { ...anyMove, actor: otherSeat }), tableId: TID },
    },
    {
      name: 'a card id that names nothing in the deck',
      frame: { ...proposeFrame('h3', { actor: seat, type: anyMove.type, cards: ['no-such-card'] }), tableId: TID },
    },
    {
      name: 'a move type this pack has never heard of',
      frame: { ...proposeFrame('h4', { actor: seat, type: 'summonDragon' }), tableId: TID },
    },
    {
      name: 'an actor outside the table',
      frame: { ...proposeFrame('h5', { actor: seatCount + 40, type: anyMove.type }), tableId: TID },
    },
    {
      name: 'a thousand cards',
      frame: {
        ...proposeFrame('h6',
          { actor: seat, type: anyMove.type, cards: Array.from({ length: 1000 }, () => foreignCard) }),
        tableId: TID,
      },
    },
    {
      name: 'a card id shaped like a selector',
      frame: { ...proposeFrame('h7', { actor: seat, type: anyMove.type, cards: ['#hand > *'] }), tableId: TID },
    },
    {
      name: 'a zone address shaped like a path traversal',
      frame: {
        ...proposeFrame('h8', { actor: seat, type: anyMove.type, from: '../../hand.0', to: 'discard' }),
        tableId: TID,
      },
    },
    {
      name: 'a choice whose values are objects',
      frame: {
        ...proposeFrame('h9', { actor: seat, type: anyMove.type, choice: { suit: { toString: 'hearts' } } }),
        tableId: TID,
      },
    },
    {
      name: 'no move at all',
      frame: { ...proposeFrame('h10', undefined), tableId: TID },
    },
    {
      name: 'a proposal with no proposal id',
      frame: { ...proposeFrame(undefined, { ...anyMove }), tableId: TID },
    },
    {
      name: 'a prototype-polluting move',
      // JSON.parse defines `__proto__` as an OWN property, which an object
      // literal cannot express — this is the shape that actually arrives.
      //
      // #244: the pollution used to ride a move with no `tableId`, so
      // `validateFrame` refused it at 'no tableId' before `cleanMove` — let
      // alone `cleanChoice` — ever saw the payload. A broken guard would have
      // left this case green forever.
      //
      // AIMED AT THE SENDER'S OWN SEAT, using the seat's own real legal move,
      // so nothing else (a seat mismatch, a missing card) refuses the frame
      // first. `cleanChoice` is the layer that actually looks at an object's
      // own keys generically (every other field in `cleanMove` is read by a
      // fixed name), so that is where the poison rides — a `__proto__` value
      // that is itself an object fails `cleanChoice`'s allowlist (it is not a
      // string, an integer, or an array) exactly like the "choice whose
      // values are objects" case above, and the whole move is refused before
      // it ever reaches the seat-authority check or `validateMove`.
      frame: {
        ...proposeFrame('h12', { ...anyMove, actor: seat, choice: JSON.parse('{"__proto__":{"pwned":true}}') }),
        tableId: TID,
      },
    },
    {
      name: 'a host-only frame from a client',
      frame: { ...viewFrame({ seq: 0, view: { v: 1, seat: 0 } }), tableId: TID },
    },
  ];

  // The legality cases: a REAL move, minimally altered into a lie. These are
  // the ones that reach validateMove rather than stopping at the validator,
  // and they are the reason this file fingerprints the RNG.
  if (withCards) {
    cases.push({
      name: 'a real move played with a card out of somebody else\'s hand',
      frame: { ...proposeFrame('h13', { ...withCards, cards: [foreignCard] }), tableId: TID },
    });
  }
  if (withFrom) {
    cases.push({
      name: 'a real move sourced from another seat\'s hand',
      frame: { ...proposeFrame('h14', { ...withFrom, from: otherHand }), tableId: TID },
    });
  }
  // A CARD LED THROUGH AN OPEN PASS (#253). No pass move is a `playCard`, so
  // nothing above reaches the play rules while a pass is open — and the play
  // rules alone would take this one. The card is chosen as one the play phase
  // WOULD accept from this seat, so the only thing that can refuse it is the
  // pass itself, and `rule` says which refusal it has to be.
  if (state.turn.phase === 'pass') {
    const lead = playableOnceThePassIsDone(state, seat);
    if (lead) {
      cases.push({
        name: 'a card from the seat\'s own hand, led while the pass is still open',
        frame: { ...proposeFrame('h15', { actor: seat, type: 'playCard', cards: [lead] }), tableId: TID },
        rule: 'phase',
      });
    }
  }
  return { cases, expressible: { withCards: !!withCards, withFrom: !!withFrom } };
}

/**
 * A card from `seat`'s hand that the PLAY rules would accept as a lead, asked
 * of the play phase and then put back — the phase word is the only thing
 * changed, and it is restored before anything else reads the state.
 */
function playableOnceThePassIsDone(state, seat) {
  const phase = state.turn.phase;
  state.turn.phase = 'play';
  try {
    return state.zones.cards(`hand.${seat}`)
      .find((card) => validateMove(state, { actor: seat, type: 'playCard', cards: [card] }).legal) ?? null;
  } finally {
    state.turn.phase = phase;
  }
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

for (const packId of listPackIds()) {
  test(`${packId}: a hostile proposal is refused and changes nothing`, async () => {
    const t = await tableFor(packId);
    const { cases } = corpus(t);

    for (const { name, frame, silentOk, rule } of cases) {
      const before = fingerprint(t.state);
      t.rejects.length = 0;
      t.hostErrors.length = 0;

      t.aPort.send(frame, { to: 'host' });

      assert.equal(fingerprint(t.state), before,
        `${packId}: "${name}" left a footprint on the state`);
      if (!silentOk) {
        assert.ok(t.rejects.length || t.hostErrors.length,
          `${packId}: "${name}" was dropped in silence — the client will retry forever`);
      }
      if (rule) {
        assert.equal(t.rejects[0]?.rule, rule,
          `${packId}: "${name}" was refused for the wrong reason`);
      }
    }

    assert.equal({}.pwned, undefined, 'a proposal polluted Object.prototype');
    assert.equal(Object.prototype.pwned, undefined, 'a proposal polluted Object.prototype');

    // THE POSITIVE CONTROL. Everything above passes on a table that never
    // received a single frame; this is what proves it did.
    const legal = enumerateLegalMoves(t.state, t.seat)[0];
    const before = fingerprint(t.state);
    t.a.propose(legal);
    assert.notEqual(fingerprint(t.state), before,
      `${packId}: a LEGAL proposal from the right seat changed nothing — the corpus above proved nothing`);
    assert.deepEqual(t.rejects.filter((r) => r.pid?.startsWith('p')), [],
      `${packId}: a legal proposal was rejected`);
  });
}

test('the rate limit stops reading a flood without ever letting one through', async () => {
  const t = await tableFor('crazy-eights');
  const before = fingerprint(t.state);
  const foreign = t.state.zones.cards('hand.0')[0];

  // Well past PROPOSE_BUDGET. The budget exists so a peer cannot spin the
  // validator; what it must never do is change the answer for the frames it
  // still reads.
  for (let i = 0; i < 200; i++) {
    t.aPort.send({
      ...proposeFrame(`flood${i}`, { actor: t.seat, type: 'playCard', cards: [foreign] }),
      tableId: TID,
    }, { to: 'host' });
  }

  assert.equal(fingerprint(t.state), before, 'a flood of illegal proposals moved the state');
});

test('Hearts: no seat leads a card while the pass is open (#253)', async () => {
  // The cheaper pin, straight through validateMove on a dealt Hearts hand:
  // every card in every hand, from the turn seat, while no seat has passed.
  // The case in the corpus above proves the same over the wire.
  const pack = await loadPackFromDisk('hearts');
  const state = createState({ pack, seats: 4, seed: 'hostile:pass-blocks-play' });
  pack.template.setup(makeCtx(state));
  assert.equal(state.turn.phase, 'pass', 'the first Hearts hand opens on a pass');

  let tried = 0;
  for (let seat = 0; seat < state.seats; seat++) {
    state.turn.seat = seat;
    assert.ok(playableOnceThePassIsDone(state, seat),
      `seat ${seat} holds no card the play rules would take — this pins nothing`);
    for (const card of state.zones.cards(`hand.${seat}`)) {
      const check = validateMove(state, { actor: seat, type: 'playCard', cards: [card] });
      assert.equal(check.legal, false, `seat ${seat} led ${card} through an open pass`);
      assert.equal(check.rule, 'phase', `seat ${seat} leading ${card} was refused for the wrong reason`);
      tried++;
    }
  }
  assert.equal(tried, 52, 'every card in every hand was tried');
});
