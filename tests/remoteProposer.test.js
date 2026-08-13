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
import { enumerateLegalMoves } from '../src/engine/movePipeline.js';
import { createSeatTable } from '../src/players/seats.js';
import { createTableHost } from '../src/match/host.js';
import { createTableClient } from '../src/match/client.js';
import { FRAME } from '../src/match/protocol.js';
import { createPeerNetwork } from '../tools/peer-stub.mjs';
import { loadPackFromDisk, listPackIds } from '../tools/pack-test.mjs';

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
  const host = createTableHost({
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
  const a = createTableClient({
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
      frame: { k: FRAME.PROPOSE, pid: 'h1', move: { ...anyMove, actor: otherSeat } },
    },
    {
      name: 'a card id that names nothing in the deck',
      frame: { k: FRAME.PROPOSE, pid: 'h3', move: { actor: seat, type: anyMove.type, cards: ['no-such-card'] } },
    },
    {
      name: 'a move type this pack has never heard of',
      frame: { k: FRAME.PROPOSE, pid: 'h4', move: { actor: seat, type: 'summonDragon' } },
    },
    {
      name: 'an actor outside the table',
      frame: { k: FRAME.PROPOSE, pid: 'h5', move: { actor: seatCount + 40, type: anyMove.type } },
    },
    {
      name: 'a thousand cards',
      frame: {
        k: FRAME.PROPOSE, pid: 'h6',
        move: { actor: seat, type: anyMove.type, cards: Array.from({ length: 1000 }, () => foreignCard) },
      },
    },
    {
      name: 'a card id shaped like a selector',
      frame: { k: FRAME.PROPOSE, pid: 'h7', move: { actor: seat, type: anyMove.type, cards: ['#hand > *'] } },
    },
    {
      name: 'a zone address shaped like a path traversal',
      frame: {
        k: FRAME.PROPOSE, pid: 'h8',
        move: { actor: seat, type: anyMove.type, from: '../../hand.0', to: 'discard' },
      },
    },
    {
      name: 'a choice whose values are objects',
      frame: {
        k: FRAME.PROPOSE, pid: 'h9',
        move: { actor: seat, type: anyMove.type, choice: { suit: { toString: 'hearts' } } },
      },
    },
    {
      name: 'no move at all',
      frame: { k: FRAME.PROPOSE, pid: 'h10' },
    },
    {
      name: 'a proposal with no proposal id',
      frame: { k: FRAME.PROPOSE, move: { ...anyMove } },
    },
    {
      name: 'a prototype-polluting move',
      // JSON.parse defines `__proto__` as an OWN property, which an object
      // literal cannot express — this is the shape that actually arrives.
      //
      // Aimed at a seat the sender does not hold, so the frame is refused on
      // its merits: a pollution payload riding a move that would have been
      // applied anyway proves nothing about either.
      frame: JSON.parse(`{"k":"${FRAME.PROPOSE}","pid":"h12","move":{"actor":${otherSeat},`
        + `"type":${JSON.stringify(anyMove.type)},"__proto__":{"pwned":true}}}`),
    },
    {
      name: 'a host-only frame from a client',
      frame: { k: FRAME.VIEW, seq: 0, view: { v: 1, seat: 0 } },
    },
  ];

  // The legality cases: a REAL move, minimally altered into a lie. These are
  // the ones that reach validateMove rather than stopping at the validator,
  // and they are the reason this file fingerprints the RNG.
  if (withCards) {
    cases.push({
      name: 'a real move played with a card out of somebody else\'s hand',
      frame: { k: FRAME.PROPOSE, pid: 'h13', move: { ...withCards, cards: [foreignCard] } },
    });
  }
  if (withFrom) {
    cases.push({
      name: 'a real move sourced from another seat\'s hand',
      frame: { k: FRAME.PROPOSE, pid: 'h14', move: { ...withFrom, from: otherHand } },
    });
  }
  return { cases, expressible: { withCards: !!withCards, withFrom: !!withFrom } };
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

for (const packId of listPackIds()) {
  test(`${packId}: a hostile proposal is refused and changes nothing`, async () => {
    const t = await tableFor(packId);
    const { cases } = corpus(t);

    for (const { name, frame, silentOk } of cases) {
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
      k: FRAME.PROPOSE, pid: `flood${i}`,
      move: { actor: t.seat, type: 'playCard', cards: [foreign] },
    }, { to: 'host' });
  }

  assert.equal(fingerprint(t.state), before, 'a flood of illegal proposals moved the state');
});
