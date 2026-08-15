// TWO DOORS, ONE MEANING (#75 stage 3).
//
// A lobby frame reaches this device two ways and always has: the subscription
// in src/ui/tableSightings.js, which believes a frame from a direct,
// unrelayed sender; and our own client in src/match/client.js, which believes
// one from the host it sat down with. Neither door subsumes the other — they
// are separate `peer.onMessage` subscriptions with different authority rules —
// so most frames arrive at both.
//
// WHAT HAPPENS NEXT USED TO BE TWO PARTIAL COPIES, and that is what these tests
// are about. The subscription filed the sighting, aged the seat stub, retired a
// superseded table and cleared a stale notice; the client's `onLobby` filed the
// sighting and wrote the stub and did none of the rest. A frame that reached
// only the client got the short path — no ageing, no superseded table retired —
// and nothing anywhere could see it, because in the ordinary case the sniffer
// had already done the work.
//
// THAT IS ALSO WHY THE BROWSER TIER CANNOT PROVE THIS. `npm run mp-acceptance`
// drives the real transport, where both doors fire, so the partial path is
// masked by the full one. The only place the two can be told apart is here,
// calling one door at a time.

import { test, beforeEach } from "node:test";
import assert from "node:assert";

import { createTableSightings } from "../src/ui/tableSightings.js";
import { FRAME, PROTOCOL_VERSION } from "../src/match/protocol.js";

// The SDK's synchronous state surface is a key/value store; a Map is the whole
// of what storage.js uses (the same stub tests/storage.test.js stands up).
const store = new Map();
globalThis.Arcade = {
  state: {
    get: (k) => store.get(k),
    set: (k, v) => { store.set(k, structuredClone(v)); return true; },
    remove: (k) => store.delete(k),
    getOrInit: (k, d) => (store.has(k) ? store.get(k) : d),
  },
};

const ME = "device-me";
const ADA = "device-ada";
const T1 = "t1a1a1a1a1a1a1a1a1a";
const T2 = "t2b2b2b2b2b2b2b2b2b";

function lobby({ tableId = T1, hostDeviceId = ADA, packId = "hearts", seats = null, started = false } = {}) {
  return {
    k: FRAME.LOBBY,
    protocol: PROTOCOL_VERSION,
    tableId,
    hostDeviceId,
    packId,
    variants: [],
    graceMs: 60_000,
    started,
    seatCount: 2,
    seats: seats || [
      { seat: 0, kind: "device", deviceId: hostDeviceId, name: "Ada" },
      { seat: 1, kind: "device", deviceId: ME, name: "Me" },
    ],
  };
}

/** A sightings instance with every callback recorded rather than acted on. */
function standUp({ peers = [{ deviceId: ADA, name: "Ada", direct: true }] } = {}) {
  const seen = { sightings: [], notices: [], stale: [], closed: [], gone: [], superseded: [] };
  let handler = null;
  const port = {
    peers: () => peers,
    onMessage: (fn) => { handler = fn; return () => {}; },
  };
  const sightings = createTableSightings({
    port: () => port,
    selfId: () => ME,
    peerName: (id) => (id === ADA ? "Ada" : "Someone"),
    hosting: () => false,
    clearStaleNotice: (frame, known) => seen.stale.push({ packId: frame.packId, known: !!known }),
    setNotice: (text) => seen.notices.push(text),
    onSighting: (event) => seen.sightings.push(event),
    onTableClosed: (key) => seen.closed.push(key),
    onHostsGone: (keys) => seen.gone.push(...keys),
    onSuperseded: (keys) => seen.superseded.push(...keys),
  });
  sightings.start();
  // A `bye` carries no `hostDeviceId` — the sender IS the claim — so the
  // sender is a parameter rather than something read off the frame.
  return {
    sightings,
    seen,
    deliver: (frame, meta, from) => handler(frame, from ?? frame.hostDeviceId ?? ADA, meta),
  };
}

const stubs = () => store.get("mpSeats") || [];

beforeEach(() => store.clear());

/* ------------------------------------------------------------------ *
 * The two doors mean the same thing
 * ------------------------------------------------------------------ */

test("a frame through the client door does everything the wire door does", () => {
  const viaWire = standUp();
  viaWire.deliver(lobby(), {});

  const viaClient = standUp();
  viaClient.sightings.noteLobby(lobby(), { provenance: "client" });

  const shape = (s) => ({
    tables: s.sightings.map((e) => e.entry.key),
    stale: s.stale,
    stubs: stubs().map((stub) => [stub.tableId, stub.seat]),
  });
  // The stubs assertion below reads whichever run wrote last; both wrote the
  // same one, which is the point.
  assert.deepStrictEqual(shape(viaWire.seen).tables, shape(viaClient.seen).tables);
  assert.deepStrictEqual(shape(viaWire.seen).stale, shape(viaClient.seen).stale);
  assert.deepStrictEqual(stubs().map((s) => [s.tableId, s.seat]), [[T1, 1]]);
});

test("the client door retires a superseded table — the half it used to skip", () => {
  const { sightings, seen } = standUp();
  // We are sitting at Ada's first Hearts table, with a stub to prove it.
  sightings.noteLobby(lobby({ tableId: T1 }), { provenance: "client" });
  assert.deepStrictEqual(stubs().map((s) => s.tableId), [T1]);

  // Ada ends it and deals another. Same host, same pack, a new minted id — the
  // one pairing that means the old seat is gone for good.
  sightings.noteLobby(lobby({ tableId: T2 }), { provenance: "client" });

  assert.deepStrictEqual(seen.superseded, [T1], "the old table is retired");
  assert.deepStrictEqual(sightings.tables.all().map((e) => e.key), [T2]);
  assert.deepStrictEqual(stubs().map((s) => s.tableId), [T2], "the old seat stub is gone");
  assert.match(seen.notices.at(-1), /started a new game/);
});

test("provenance reaches the screen, because the two doors still focus differently", () => {
  const { sightings, seen } = standUp();
  sightings.noteLobby(lobby(), { provenance: "client" });
  assert.strictEqual(seen.sightings[0].provenance, "client");

  const wire = standUp();
  wire.deliver(lobby(), {});
  assert.strictEqual(wire.seen.sightings[0].provenance, "wire");
});

/* ------------------------------------------------------------------ *
 * Idempotence — because both doors fire for the same frame
 * ------------------------------------------------------------------ */

test("the same frame through both doors is exactly the same as through one", () => {
  const { sightings, seen } = standUp();
  const frame = lobby();
  sightings.noteLobby(frame, { provenance: "wire" });
  const afterOne = {
    tables: sightings.tables.all().map((e) => e.key),
    stubs: stubs().map((s) => [s.tableId, s.seat]),
    superseded: [...seen.superseded],
    notices: [...seen.notices],
  };

  sightings.noteLobby(frame, { provenance: "client" });
  assert.deepStrictEqual(sightings.tables.all().map((e) => e.key), afterOne.tables);
  assert.deepStrictEqual(stubs().map((s) => [s.tableId, s.seat]), afterOne.stubs);
  assert.deepStrictEqual(seen.superseded, afterOne.superseded,
    "the second pass must not retire the table the first just filed");
  assert.deepStrictEqual(seen.notices, afterOne.notices, "and must not re-announce anything");
});

/* ------------------------------------------------------------------ *
 * The trust rules did not move, and this is the file that says so
 * ------------------------------------------------------------------ */

test("a relayed lobby frame is refused: a fellow joiner cannot advertise a table", () => {
  const { seen, deliver } = standUp();
  deliver(lobby(), { relayed: true });
  assert.deepStrictEqual(seen.sightings, []);
});

test("a frame from a device we hold no direct link to is refused", () => {
  const { seen, deliver } = standUp({ peers: [{ deviceId: ADA, name: "Ada", direct: false }] });
  deliver(lobby(), {});
  assert.deepStrictEqual(seen.sightings, []);
});

test("our own broadcast come back to us is not a table we discovered", () => {
  const { seen, deliver } = standUp({ peers: [{ deviceId: ME, direct: true }] });
  deliver(lobby({ hostDeviceId: ME }), {});
  assert.deepStrictEqual(seen.sightings, []);
});

test("only a host's own unrelayed 'closed' retires a table", () => {
  const { seen, deliver, sightings } = standUp();
  deliver(lobby(), {});
  assert.strictEqual(sightings.tables.all().length, 1);

  const bye = (why, tableId = T1) => ({ k: FRAME.BYE, tableId, why });

  // A joiner standing up, relayed through the hub. Not a table ending.
  deliver(bye("leave"), { relayed: true });
  assert.strictEqual(sightings.tables.all().length, 1);
  // A relayed 'closed' is a fellow joiner claiming an authority it lacks.
  deliver(bye("closed"), { relayed: true });
  assert.strictEqual(sightings.tables.all().length, 1);
  // 'replaced' is about one seat, not the felt.
  deliver(bye("replaced"), {});
  assert.strictEqual(sightings.tables.all().length, 1);

  deliver(bye("closed"), {});
  assert.deepStrictEqual(sightings.tables.all(), []);
  assert.deepStrictEqual(seen.closed, [T1]);
});

/* ------------------------------------------------------------------ *
 * A host that stopped answering
 * ------------------------------------------------------------------ */

test("a table whose host left the party is pruned; one still on the roster is not", () => {
  const { sightings, seen, deliver } = standUp();
  deliver(lobby(), {});
  sightings.pruneDead();
  assert.deepStrictEqual(seen.gone, [], "Ada is still on the roster");

  const quiet = standUp({ peers: [] });
  quiet.sightings.noteLobby(lobby(), { provenance: "wire" });
  quiet.sightings.pruneDead();
  assert.deepStrictEqual(quiet.seen.gone, [T1]);
});
