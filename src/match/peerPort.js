// THE ONE PLACE THAT NAMES `Arcade.peer`.
//
// Everything else in src/match/ takes a "peer port" — an object with this
// shape — which is what lets the whole protocol be driven headlessly by a stub
// under `node --test` (tools/peer-stub.mjs), exactly the way the storage
// adapter lets tests stub `Arcade.state` with a Map. A protocol that could only
// be exercised through two real browsers would be a protocol nobody tests the
// hard cases of.
//
// THE CAPS GATE, AND WHY THERE IS NO FALLBACK. Multiplayer needs three
// capabilities and degrades to nothing without them:
//
//   peer.sendTo   targeted sends. Without it every private frame — every hand
//                 — would have to be broadcast. There is no version of this
//                 feature that works without it.
//   peer.roster   who is at the party, and which link is direct. Without it
//                 the host cannot be discovered and a joiner cannot tell its
//                 host from a fellow joiner.
//   peer.meta     the `relayed` flag. Without it the spoof check cannot run,
//                 and a fellow joiner can impersonate the host.
//
// An older launcher gets ONE clear notice telling the player to update, and
// the multiplayer UI never appears. A fallback protocol would mean shipping a
// second, less safe implementation that almost nobody runs and nobody tests —
// and the two cases it would cover (no targeting, no spoof check) are exactly
// the two where being wrong is worst.
//
// THE PARTY IS NOT IN THE PORT, and it is not coming back. `Arcade.peer.party()`
// was read for exactly one thing — a line on the party screen naming whoever
// led the party — and the launcher is deleting the party as a concept: a device
// holds durable CONNECTIONS, and a game is open on some of them. The SDK keeps
// the call and answers null forever, so a port line for it would be a door onto
// a room that no longer exists, and a label derived from it would be a sentence
// that is never printed. The three caps this file gates on are untouched; none
// of them was ever `peer.party`.
//
// STATUS IS NEVER CACHED. `Arcade.peer.status()` is read at call time because
// a game can be mounted before there is anybody to play with and paired
// afterwards; a value read once at init is a multiplayer button that never
// appears.

export const REQUIRED_CAPS = Object.freeze(['peer.sendTo', 'peer.roster', 'peer.meta']);

/**
 * What this launcher can do for us, right now.
 *
 * Returns `{ available, status, missing }`. `available` false with an empty
 * `missing` means there is no peer surface at all (standalone, or an SDK too
 * old to have one) — a different message from "your launcher needs updating".
 */
export function peerAvailability(api = globalThis.Arcade?.peer) {
  if (!api || typeof api.status !== 'function') {
    return { available: false, status: 'unavailable', missing: [], reason: 'no-peer-api' };
  }
  let status;
  try {
    status = api.status();
  } catch {
    return { available: false, status: 'unavailable', missing: [], reason: 'no-peer-api' };
  }
  if (status === 'unavailable') {
    return { available: false, status, missing: [], reason: 'standalone' };
  }
  const caps = typeof api.caps === 'function' ? (api.caps() || []) : [];
  const missing = REQUIRED_CAPS.filter((cap) => !caps.includes(cap));
  if (missing.length) {
    return { available: false, status, missing, reason: 'launcher-too-old' };
  }
  return { available: true, status, missing: [], reason: null };
}

/**
 * Wrap the live SDK as a port.
 *
 * Thin on purpose — the value is the SHAPE, not the behaviour. Anything clever
 * added here is behaviour the stub does not have, which is behaviour the tests
 * do not cover.
 */
export function arcadePeerPort(api = globalThis.Arcade?.peer) {
  if (!api) return null;
  return {
    self: () => api.self(),
    status: () => api.status(),
    caps: () => (typeof api.caps === 'function' ? api.caps() || [] : []),
    peers: () => api.peers() || [],
    send: (payload, opts) => api.send(payload, opts),
    onMessage: (fn) => api.onMessage(fn),
    onReady: (fn) => api.onReady(fn),
    onPeersChange: (fn) => api.onPeersChange(fn),
    onStatus: (fn) => api.onStatus(fn),
    queue: () => (typeof api.queue === 'function' ? api.queue() : { depth: 0, limit: 0, overflowed: false }),
  };
}
