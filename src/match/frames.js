// THE OTHER HALF OF THE SCHEMA: HOW A FRAME IS WRITTEN.
//
// `src/match/protocol.js` is the one definition of what a well-formed frame
// looks like coming IN — one `FRAME` table, one `validateFrame`, one verdict.
// Going OUT there was no definition at all. Every producer hand-assembled the
// object literal: the host wrote `{ k: FRAME.REJECT, pid, rule, reason }` three
// times within twenty lines of itself, the client wrote five more in its
// outbound section, `tools/mp-scenarios.mjs` wrote a raw `{ k: 'bye' }` that
// never named `FRAME` at all, and the tests wrote a few dozen with FRAME's
// kinds and free-form bodies.
//
// A HAND-WRITTEN FRAME IS A SCHEMA NOBODY CHECKED. The validator refuses a
// field it does not know about, so an outbound typo does not fail loudly at the
// keyboard — it fails at the far end of a data channel, as a dropped frame, on
// somebody else's phone. That is the most expensive place in this codebase to
// find out that `reason` was spelled `why`.
//
// So: one builder per kind, named for the kind, taking exactly what the
// validator will look for. The pairing is the point — every function here is
// the write-side of a case in `validateBody`, and the round trip (build it,
// validate it, get the same fields back) is what the unit tests pin.
//
// NOTHING HERE SENDS, AND NOTHING HERE STAMPS. A builder returns a plain
// object and no more. `tableId` is added by the one door each module has out —
// `stamp()` in host.js, the spread in client.js's `send` — and putting it here
// instead would give protocol v2 a second place to be honoured and
// `tests/repo-gates.test.js`'s door count something new to miss. A module that
// builds frames must not be a module that can emit one.

import { FRAME, PROTOCOL_VERSION } from './protocol.js';

/**
 * The handshake: which build, which game, and who is in which chair.
 *
 * `protocol` is filled in here rather than asked for. It is not a fact about
 * this table that a caller could know better — it is a fact about the build
 * doing the sending, and a caller that could pass it could pass the wrong one.
 */
export function lobbyFrame({
  packId, packVersion, variants = [], hostDeviceId, seatCount, seats = [],
  started = false, graceMs,
}) {
  return {
    k: FRAME.LOBBY,
    protocol: PROTOCOL_VERSION,
    packId,
    packVersion,
    variants,
    hostDeviceId,
    seatCount,
    seats,
    started: !!started,
    // Optional all the way down the wire: a host that never chose sends
    // nothing and the joiner falls back to its default (protocol.js).
    graceMs,
  };
}

/**
 * One seat's view of the table.
 *
 * A SNAPSHOT IS A VIEW — design decision D2 — so this builds both and the kind
 * is the only difference. Two builders here would be the beginning of the
 * second code path that D2 exists to refuse.
 */
export function viewFrame({ seq, view, events = [], kind = FRAME.VIEW }) {
  return { k: kind, seq, view, events };
}

/**
 * No — and which rule said so, against which proposal.
 *
 * WRITTEN THREE TIMES IN ONE FUNCTION before this existed (`handlePropose`):
 * not-your-seat, unknown-card, and the validator's own verdict, each an
 * identical literal with two words changed. `pid` is positional and first
 * because a reject that cannot be matched to the gesture that caused it is a
 * reject the player never sees.
 */
export function rejectFrame(pid, rule, reason) {
  return { k: FRAME.REJECT, pid, rule, reason };
}

/**
 * An emoji, by index, and optionally whose it was.
 *
 * THE SEAT IS THE HOST'S TO FILL IN. A client builds this with one argument
 * and says nothing about who it came from; the host looks the seat up from the
 * authenticated sender and re-announces. The parameter is second and optional
 * for exactly that reason — see `announceEmote` in host.js.
 */
export function emoteFrame(index, seat) {
  return { k: FRAME.EMOTE, i: index, seat };
}

/** Somebody stood up, or the table closed. `leave` | `replaced` | `closed`. */
export function byeFrame(why = 'leave') {
  return { k: FRAME.BYE, why };
}

/** Asking for a chair. A re-claim of a seat we already hold is the same frame. */
export function claimSeatFrame(seat, localIndex = 0) {
  return { k: FRAME.CLAIM_SEAT, seat, localIndex };
}

/** Asking to move. The host answers with a view or a reject, never an ack. */
export function proposeFrame(pid, move) {
  return { k: FRAME.PROPOSE, pid, move };
}

/** "I think I missed one." `since` is what we already have, never a demand. */
export function snapshotReqFrame(since = 0) {
  return { k: FRAME.SNAPSHOT_REQ, since };
}

/**
 * WHICH SEAT A DEVICE HOLDS, PER THE HOST'S OWN ROSTER.
 *
 * Two byte-identical private copies of this existed — `seatOfSelf` in
 * client.js and `seatOfSelf` in partyModel.js — which is what a roster entry
 * with no reader of its own gets you. They are one question and the answer has
 * to be one function, because the two callers are the client deciding whether
 * it is seated and the panel deciding whether to draw it that way, and those
 * disagreeing is a seat that exists on one screen.
 *
 * NULL, NOT UNDEFINED, and never a falsy seat index: seat 0 is a chair like any
 * other and `mine ? mine.seat : null` is the only shape that says so.
 */
export function seatOfSelf(frame, self) {
  if (!self) return null;
  const mine = (frame?.seats || []).find((s) => s.kind === 'device' && s.deviceId === self);
  return mine ? mine.seat : null;
}
