// TWO TABLES IN ONE PARTY, over the real protocol.
//
// tests/tableDirectory.test.js pins the bookkeeping; this pins the thing the
// bookkeeping was for. Two devices each host a table, a third is in the party
// with both, and every assertion here is a sentence that was false before
// issue #43:
//
//   * both tables are AUTHENTICATED. This is the one that surprises: the
//     sniffer and the client each identified the host as "the device we hold a
//     direct link to, if there is exactly one of those". With two hosts there
//     are two, that test answered null, and the result was not one table too
//     few but NOTHING — every lobby frame from both hosts dropped as spoofed.
//   * a client of table A is not confused by table B's frames.
//   * a host of table A can still see table B.
//
// THE SPOOF CHECK IS ASSERTED IN THE SAME BREATH, because widening "who is the
// host" is exactly the kind of change that quietly widens "who is believed".
// A relayed lobby frame — a fellow joiner claiming to be a host through the hub
// — must still be refused.

import { test } from 'node:test';
import assert from 'node:assert';

import { createSeatTable } from '../src/players/seats.js';
import { createTableHost } from '../src/match/host.js';
import { createTableClient } from '../src/match/client.js';
import { createTableDirectory, tableKeyOf } from '../src/match/tableDirectory.js';
import { FRAME, PROTOCOL_VERSION, validateFrame, isAuthentic } from '../src/match/protocol.js';
import { createPeerNetwork } from '../tools/peer-stub.mjs';
import { loadPackFromDisk } from '../tools/pack-test.mjs';

/**
 * A party of three: Ada hosts one game, Dana hosts another, Kit is in the room
 * with both of them and has sat down at neither.
 *
 * Neither table is DEALT. That is the state the bug lived in — a lobby open,
 * seats being advertised, nobody committed — and it is also the cheapest state
 * to build, because a lobby needs no engine at all (`liveState: () => null` is
 * a table being built, which the protocol already understands).
 */
async function twoHostParty() {
  const net = createPeerNetwork({ hostDeviceIds: ['ada', 'dana'] });
  const adaPort = net.createDevice('ada', { name: 'Ada' });
  const danaPort = net.createDevice('dana', { name: 'Dana' });
  const kitPort = net.createDevice('kit', { name: 'Kit' });

  const mkHost = (peer, deviceId, packId) => {
    const seats = createSeatTable({ seats: 3, localDeviceId: deviceId });
    seats.claim(0, { deviceId });
    seats.seatBot(1);
    seats.seatBot(2);
    return {
      seats,
      host: createTableHost({
        peer,
        seats,
        tableId: `tbl-${deviceId}`,
        liveState: () => null,
        packInfo: () => ({ packId, packVersion: '1.0.0', variants: [] }),
        nameFor: (seat) => `Seat ${seat}`,
        hooks: {},
      }),
    };
  };

  return {
    net,
    ports: { ada: adaPort, dana: danaPort, kit: kitPort },
    ada: mkHost(adaPort, 'ada', 'crazy-eights'),
    dana: mkHost(danaPort, 'dana', 'hearts'),
  };
}

/**
 * The sniffer's rule, lifted out of src/ui/party.js so it can be exercised
 * without a DOM.
 *
 * A COPY IS A LIABILITY and this one is deliberate and small: party.js is the
 * screen, it cannot be imported under `node --test`, and the rule it applies is
 * three lines. What is pinned here is the RULE — direct sender, not relayed —
 * and tests/security.test.js already greps the real file for the sinks it must
 * not use. When the frame router lands (T3) this becomes an import.
 */
function sniff(port, directory, payload, fromDeviceId, meta) {
  const verdict = validateFrame(payload);
  if (!verdict.ok) return null;
  const frame = verdict.frame;
  if (frame.k !== FRAME.LOBBY) return null;
  if (frame.hostDeviceId === port.self().deviceId) return null;
  const direct = port.peers().filter((p) => p.direct).map((p) => p.deviceId);
  const hostDeviceId = direct.includes(fromDeviceId) ? fromDeviceId : null;
  if (!isAuthentic(FRAME.LOBBY, { fromDeviceId, hostDeviceId, relayed: meta?.relayed })) return null;
  return directory.sight(frame);
}

test('a device in a party with two hosts holds two direct links', async () => {
  const party = await twoHostParty();
  const seen = party.ports.kit.peers().filter((p) => p.direct).map((p) => p.deviceId).sort();
  assert.deepStrictEqual(seen, ['ada', 'dana'],
    'the shape the old single-direct-peer rule could not read');
});

test('both hosts’ tables are sighted — the case that used to yield none', async () => {
  const party = await twoHostParty();
  const directory = createTableDirectory();
  party.ports.kit.onMessage((payload, from, meta) => sniff(party.ports.kit, directory, payload, from, meta));

  party.ada.host.start();
  party.dana.host.start();

  assert.strictEqual(directory.size, 2, 'two hosts advertising, two tables known');
  assert.strictEqual(directory.get('tbl-ada').packId, 'crazy-eights');
  assert.strictEqual(directory.get('tbl-dana').packId, 'hearts');
});

test('a relayed lobby frame is still refused — widening the host is not widening trust', async () => {
  const party = await twoHostParty();
  const directory = createTableDirectory();
  party.ports.kit.onMessage((payload, from, meta) => sniff(party.ports.kit, directory, payload, from, meta));

  // A fourth device, seated at nothing, broadcasting a lobby frame that names
  // itself a host. It reaches Kit through the hub, so it arrives relayed.
  const impostorPort = party.net.createDevice('mal', { name: 'Mal' });
  impostorPort.send({
    tableId: 'tbl-mal',
    k: FRAME.LOBBY,
    protocol: PROTOCOL_VERSION,
    packId: 'crazy-eights',
    packVersion: '1.0.0',
    variants: [],
    hostDeviceId: 'mal',
    seatCount: 2,
    seats: [{ seat: 0, kind: 'device', deviceId: 'mal', name: 'Mal', status: 'connected' },
      { seat: 1, kind: 'empty', name: '', status: 'empty' }],
    started: false,
  });

  assert.strictEqual(directory.size, 0, 'a relayed host-role frame advertises nothing');
  assert.ok(!directory.has('tbl-mal'));
});

test('a client of one table is unmoved by the other table’s frames', async () => {
  const party = await twoHostParty();
  const pack = await loadPackFromDisk('crazy-eights');

  const lobbies = [];
  const problems = [];
  const client = createTableClient({
    peer: party.ports.kit,
    tableId: 'tbl-ada',
    // The table Kit sat down at, NAMED. Without this the client falls back to
    // discovery, finds two direct peers, and refuses both.
    host: 'ada',
    expects: () => ({ packId: 'crazy-eights', packVersion: '1.0.0', variants: [] }),
    hooks: {
      onLobby: (frame) => lobbies.push(frame),
      onIncompatible: (why) => problems.push(why),
      onError: (err) => problems.push(err),
    },
  });
  client.start();

  party.ada.host.start();
  party.dana.host.start();

  assert.ok(lobbies.length >= 1, 'Ada’s lobby reached her client');
  assert.ok(lobbies.every((f) => f.hostDeviceId === 'ada'),
    'Dana’s table never presented itself as Ada’s');
  // A NEIGHBOURING TABLE IS NOT AN ATTACK, and protocol v2 is what lets this be
  // said properly. Under v1 the only tool was the authority check, so Dana's
  // perfectly honest frame came back as `spoofed-authority` — an accusation
  // aimed at somebody who had done nothing but deal a different game. Now the
  // frame names its table, this client sees it is not the one it sat down at,
  // and ignores it in silence. The spoof check still exists and still bites;
  // it is simply no longer asked a question about somebody else's table.
  assert.deepStrictEqual(problems, [],
    'a frame for another table is not an error, it is just not ours');
  // And the refusal did not cost Kit the pack it actually loaded.
  assert.strictEqual(pack.id, 'crazy-eights');
});

test('a frame for OUR table from the wrong device is still a spoof', async () => {
  const party = await twoHostParty();
  const problems = [];
  const client = createTableClient({
    peer: party.ports.kit,
    host: 'ada',
    tableId: 'tbl-ada',
    expects: () => ({ packId: 'crazy-eights', packVersion: '1.0.0', variants: [] }),
    hooks: { onError: (err) => problems.push(err) },
  });
  client.start();

  // Dana claims to be speaking FOR ADA'S TABLE. The table id is right, so the
  // v2 filter lets it through to the check that was always the real defence.
  party.ports.dana.send({
    tableId: 'tbl-ada',
    k: FRAME.LOBBY,
    protocol: PROTOCOL_VERSION,
    packId: 'crazy-eights',
    packVersion: '1.0.0',
    variants: [],
    hostDeviceId: 'ada',
    seatCount: 2,
    seats: [{ seat: 0, kind: 'device', deviceId: 'ada', name: 'Ada', status: 'connected' },
      { seat: 1, kind: 'empty', name: '', status: 'empty' }],
    started: false,
  }, { to: 'kit' });

  assert.ok(problems.some((p) => p.kind === 'spoofed-authority' && p.deviceId === 'dana'),
    'naming the right table does not make you its host');
});

test('a host sees a neighbour’s table without joining it', async () => {
  const party = await twoHostParty();
  const directory = createTableDirectory();
  // Ada is hosting, and still listening. What a host does with a sighting is
  // put it on a tile; what it must never do is become a client of it.
  party.ports.ada.onMessage((payload, from, meta) => sniff(party.ports.ada, directory, payload, from, meta));

  party.ada.host.start();
  party.dana.host.start();

  assert.deepStrictEqual(directory.all().map((e) => e.key), ['tbl-dana'],
    'the neighbour’s table is known; our own broadcast is not a discovery');
});

test('the directory keys on the frame’s own host id', async () => {
  const party = await twoHostParty();
  const frames = [];
  party.ports.kit.onMessage((payload) => {
    const verdict = validateFrame(payload);
    if (verdict.ok && verdict.frame.k === FRAME.LOBBY) frames.push(verdict.frame);
  });
  party.ada.host.start();
  party.dana.host.start();

  assert.deepStrictEqual(frames.map(tableKeyOf).sort(), ['tbl-ada', 'tbl-dana'],
    'hostDeviceId is already on the wire — which is why this stage needs no protocol change');
});
