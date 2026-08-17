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
// THE FOURTH CAP IS A REQUEST, NOT A REQUIREMENT. `peer.invite` asks the
// launcher to offer this game to the devices it is connected to, and it is the
// first capability this file treats as optional — because the three above are
// what the protocol is made of and this one is a door onto it. A launcher
// without it still carries every frame; what it cannot do is OPEN A GAME, and
// under such a launcher a paired connection was already live, so there was
// nothing to open. The rule from the paragraph above still holds and gets no
// exception: we do not hand-roll a proposal over the wire when the cap is
// missing. There is nothing to hand-roll — consent is the launcher's to take,
// a game can ask and never grant — so the fallback is a SENTENCE, not a second
// protocol: "add a device in the launcher's Multiplayer menu", which happens to
// be the same sentence a current launcher gets when it has nobody to ask.
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

/** The optional one: asked for, never required. See the header. */
export const INVITE_CAP = 'peer.invite';

/**
 * What this launcher can do for us, right now.
 *
 * Returns `{ available, status, missing, reason, canInvite }`. `available`
 * false with an empty `missing` means there is no peer surface at all
 * (standalone, or an SDK too old to have one) — a different message from "your
 * launcher needs updating".
 *
 * `canInvite` IS PART OF THE SAME ANSWER on purpose. It is a fourth cap read,
 * and a second entry point for it would be a second place that decides what
 * this launcher will let us do — the thing this function exists to be the only
 * one of. The door in src/ui/party.js already asks here before it opens.
 */
export function peerAvailability(api = globalThis.Arcade?.peer) {
  if (!api || typeof api.status !== 'function') {
    return { available: false, status: 'unavailable', missing: [], reason: 'no-peer-api', canInvite: false };
  }
  let status;
  try {
    status = api.status();
  } catch {
    return { available: false, status: 'unavailable', missing: [], reason: 'no-peer-api', canInvite: false };
  }
  if (status === 'unavailable') {
    return { available: false, status, missing: [], reason: 'standalone', canInvite: false };
  }
  const caps = typeof api.caps === 'function' ? (api.caps() || []) : [];
  const missing = REQUIRED_CAPS.filter((cap) => !caps.includes(cap));
  const canInvite = caps.includes(INVITE_CAP);
  if (missing.length) {
    return { available: false, status, missing, reason: 'launcher-too-old', canInvite };
  }
  return { available: true, status, missing: [], reason: null, canInvite };
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
    // Guarded like `caps` and `queue`, and for the same reason: an SDK that
    // predates the call has no such function, and a port that only works on the
    // launcher we happen to be looking at is a port that fails on a phone.
    // Resolves the NUMBER OF PROPOSALS SENT — never who said yes. Consent
    // arrives later, as a peer appearing in the roster.
    invite: () => (typeof api.invite === 'function' ? api.invite() : Promise.resolve(0)),
  };
}
