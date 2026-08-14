// THE WIRE VOCABULARY, AND THE DOOR EVERY FRAME COMES THROUGH.
//
// Nine frame kinds, one validator, no interpretation. This module knows what a
// well-formed frame looks like and nothing whatever about cards — which is what
// lets the host and the client share one definition of "malformed" instead of
// each inventing half of one.
//
// EVERY FRAME IS HOSTILE UNTIL IT HAS BEEN THROUGH HERE. Peer input arrives
// from a device we did not write, running a build we did not ship, over a
// channel anybody in the party can put bytes on. Phase 4 hardened what happens
// to a peer's NAME once it reaches the DOM; this is the layer that decides
// whether the rest of the frame is worth looking at at all. Two rules make the
// difference between a validator and a formality:
//
//   1. It returns a verdict, it never throws. A malformed frame is an ordinary
//      thing to receive and must cost one dropped frame, not a broken table.
//   2. It is a WHITELIST all the way down. Unknown kinds are refused, unknown
//      fields are dropped rather than forwarded, and every id is charset-checked
//      before it can reach a selector, an attribute or a Map key.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: decide whether a move is LEGAL.
// A `propose` that is structurally perfect is still just a request; only the
// host's validateMove says yes, and it says so against the real state. Shape
// and legality are different questions and conflating them is how a client
// talks its way into a move.

/**
 * Bump when a frame's meaning changes. Carried in `lobby` and checked by every
 * client before it seats itself.
 *
 * THERE IS NO NEGOTIATION AND THAT IS THE POINT. Two builds that disagree get
 * a reload prompt, never a downgrade path — the fleet's service worker
 * converges versions on its own (the launcher owns the only update control),
 * so the honest move is to wait for that rather than to keep a mismatched
 * client at a table where it can desync a hand nobody can replay.
 */
export const PROTOCOL_VERSION = 2;

export const FRAME = Object.freeze({
  LOBBY: 'lobby',
  CLAIM_SEAT: 'claim-seat',
  PROPOSE: 'propose',
  VIEW: 'view',
  REJECT: 'reject',
  SNAPSHOT_REQ: 'snapshot-req',
  SNAPSHOT: 'snapshot',
  EMOTE: 'emote',
  BYE: 'bye',
});

/** Frames only a host may send. A client that accepts one from a peer is spoofed. */
export const HOST_FRAMES = Object.freeze([FRAME.LOBBY, FRAME.VIEW, FRAME.REJECT, FRAME.SNAPSHOT]);

/** Frames only a client sends. */
export const CLIENT_FRAMES = Object.freeze([FRAME.CLAIM_SEAT, FRAME.PROPOSE, FRAME.SNAPSHOT_REQ]);

/**
 * A FIXED SET, INDEXED BY POSITION — there is no free-text channel at this
 * table, deliberately. Free text is a moderation problem, a localisation
 * problem and an XSS surface, and the whole feature is "let them know you saw
 * that". An index cannot be any of those things.
 */
export const EMOTES = Object.freeze(['👏', '😂', '😮', '🤔', '😅', '🎉', '👍', '🫡']);

/** The charset every wire-supplied id is held to before it can reach anything. */
const SAFE_ID = /^[\w-]{1,64}$/;

/**
 * A CARD INSTANCE ID, WHICH IS NOT THE SAME CHARSET — and pretending it was
 * meant that four of the five packs could not play a card over the wire.
 *
 * `src/engine/cards.js` mints the second and later copies of a card as
 * `base#N` (`yellow-draw2#2`, `sb-wild#6`), and `baseId()` splits on that '#'.
 * Held to `SAFE_ID`, every one of those ids failed, so a `propose` carrying a
 * real card from Wildfire or Stockpile was refused as malformed before it ever
 * reached a rule. Only Crazy Eights' opening `draw` — a move with no cards at
 * all — got through, which is exactly why the gap survived a passing suite.
 *
 * The suffix is bounded to digits, so the widened charset still cannot express
 * a selector, a path or a template hole.
 */
const SAFE_CARD_ID = /^[\w-]{1,64}(#\d{1,4})?$/;

/**
 * A ZONE ADDRESS: a zone name plus its dot-separated numeric parts —
 * `hand.1`, `build.2`, `discard.4.3`. Same story as the card ids above; a
 * move's `from`/`to` are addresses, and no address with a seat index in it
 * matched `SAFE_ID` either.
 *
 * The parts are DIGITS ONLY. That is what keeps the dot from becoming a path:
 * there is no `../`, no `.length`, no `.constructor` expressible here.
 */
const SAFE_ADDRESS = /^[\w-]{1,64}(\.\d{1,3}){0,3}$/;

export function isSafeCardId(value) {
  return typeof value === 'string' && SAFE_CARD_ID.test(value);
}

export function isSafeAddress(value) {
  return typeof value === 'string' && SAFE_ADDRESS.test(value);
}

/**
 * A CONTRACT ITEM: `set(3)`, `run(7)`, `colorGroup(4)`. The grammar is
 * `parseItem`'s own (src/templates/melds.js), copied rather than imported —
 * this module knows the wire and nothing about templates, and a validator that
 * reached into a template for its charset would be a validator that changes
 * meaning when a template does.
 */
const SAFE_ITEM = /^\w{1,20}\(\d{1,2}\)$/;

/** Bounds. A peer that sends more than this is not playing a card game. */
/**
 * The window a host may give a seat, in ms.
 *
 * BOUNDED ON BOTH SIDES because it arrives over the wire. A zero would time
 * every seat out on arrival and a very large one is indistinguishable from no
 * timer at all — neither is a table anybody meant to sit at, and both are
 * cheaper to refuse here than to reason about at the clock.
 */
export const GRACE_LIMITS = Object.freeze({ min: 5_000, max: 24 * 60 * 60 * 1000 });

const LIMITS = Object.freeze({
  cards: 32,
  seats: 8,
  melds: 32,
  nameChars: 60,
  reasonChars: 200,
  variants: 16,
  // A wild takes ONE attribute value (a rank, a suit, a colour). Four is
  // already generous for a card game and small enough to be uninteresting.
  wildAttrs: 4,
  // Any other integer in a choice — a meld index, a contract number. Bounded
  // so an index cannot arrive as 1e9 and be handed to an allocator.
  index: 1000,
});

export function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function isSeatIndex(value, seats = LIMITS.seats) {
  return Number.isInteger(value) && value >= 0 && value < seats;
}

function fail(reason) {
  return { ok: false, reason };
}

function ok(frame) {
  return { ok: true, frame };
}

/**
 * A move as it arrives from a peer: structurally sound, and NOTHING MORE.
 *
 * The card ids are charset-checked here and checked against the pack's actual
 * card table by the host — this layer cannot do the second, because it has no
 * pack, and a validator that pretended to would be the worst of both.
 */
function cleanMove(raw, seats) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isSafeId(raw.type)) return null;
  if (!isSeatIndex(raw.actor, seats)) return null;

  const move = { actor: raw.actor, type: raw.type };

  if (raw.cards !== undefined) {
    if (!Array.isArray(raw.cards) || raw.cards.length > LIMITS.cards) return null;
    if (!raw.cards.every(isSafeCardId)) return null;
    move.cards = raw.cards.slice();
  }
  for (const key of ['from', 'to']) {
    if (raw[key] === undefined) continue;
    if (!isSafeAddress(raw[key])) return null;
    move[key] = raw[key];
  }
  if (raw.id !== undefined) {
    // A meld id, a contract id — a name, never an address.
    if (!isSafeId(raw.id)) return null;
    move.id = raw.id;
  }
  if (raw.target !== undefined) {
    if (!isSeatIndex(raw.target, seats)) return null;
    move.target = raw.target;
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string' || raw.label.length > LIMITS.nameChars) return null;
    move.label = raw.label;
  }
  if (raw.choice !== undefined) {
    const choice = cleanChoice(raw.choice, seats);
    if (choice === null) return null;
    move.choice = choice;
  }
  return move;
}

/**
 * WHAT A PLAYER SAYS THEIR WILDS TOOK: `{ [cardId]: { [attribute]: value } }`.
 *
 * A wild has no rank until somebody gives it one, and a run of "3, wild, wild,
 * 6" is only a run if the two wilds are a 4 and a 5. So the assignment travels
 * with the move (src/templates/melds.js) and the host re-derives it against the
 * real cards — this layer only decides that the shape is a shape.
 */
function cleanWilds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > LIMITS.cards) return null;
  const out = {};
  for (const [cardId, assignment] of entries) {
    if (!isSafeCardId(cardId)) return null;
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) return null;
    const pairs = Object.entries(assignment);
    if (pairs.length > LIMITS.wildAttrs) return null;
    const clean = {};
    for (const [attribute, value] of pairs) {
      if (!isSafeId(attribute)) return null;
      if (typeof value === 'string') {
        if (!isSafeId(value)) return null;
        clean[attribute] = value;
      } else if (Number.isInteger(value) && value >= 0 && value < LIMITS.index) {
        clean[attribute] = value;
      } else return null;
    }
    out[cardId] = clean;
  }
  return out;
}

/**
 * ONE LAID-DOWN GROUP: which contract item it satisfies, which cards are in it,
 * and what its wilds became. This is contract rummy's actual vocabulary, and
 * until it was written down here Milestones could not be played over the wire
 * at all — every `layDown` and every `hit` was refused as a malformed choice,
 * on a validator whose comment claimed to handle "a list of melds".
 */
function cleanMeldGroup(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.item !== 'string' || !SAFE_ITEM.test(raw.item)) return null;
  if (!Array.isArray(raw.cards) || raw.cards.length > LIMITS.cards) return null;
  if (!raw.cards.every(isSafeCardId)) return null;
  const group = { item: raw.item, cards: raw.cards.slice() };
  if (raw.wilds !== undefined) {
    const wilds = cleanWilds(raw.wilds);
    if (!wilds) return null;
    group.wilds = wilds;
  }
  return group;
}

/**
 * A move's answered Ask.
 *
 * BOUNDED RATHER THAN SHALLOW. The vocabulary is small and closed — a suit, a
 * colour, a target seat, a meld index, a list of laid-down groups, and the
 * values a meld's wilds took — and every branch below names one of those. What
 * it is not is a general object cleaner: there is no recursion, every key and
 * every leaf is charset-checked, and anything that is not one of these shapes
 * is a peer probing rather than playing.
 */
function cleanChoice(raw, seats) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isSafeId(key)) return null;
    if (key === 'wilds') {
      const wilds = cleanWilds(value);
      if (!wilds) return null;
      out[key] = wilds;
    } else if (typeof value === 'string') {
      // A suit, a colour, a contract name — or a card. The card-id charset is
      // the union of all of them and is no less bounded, so one check serves
      // rather than a per-key table that goes stale the first time a template
      // asks a new question.
      if (!isSafeCardId(value)) return null;
      out[key] = value;
    } else if (Number.isInteger(value)) {
      if ((key === 'target' || key === 'seat') && !isSeatIndex(value, seats)) return null;
      if (value < 0 || value >= LIMITS.index) return null;
      out[key] = value;
    } else if (Array.isArray(value)) {
      if (value.length > LIMITS.melds) return null;
      const groups = [];
      for (const group of value) {
        if (Array.isArray(group)) {
          // The bare form: a group of card ids and nothing else.
          if (group.length > LIMITS.cards) return null;
          if (!group.every(isSafeCardId)) return null;
          groups.push(group.slice());
        } else {
          const meld = cleanMeldGroup(group);
          if (!meld) return null;
          groups.push(meld);
        }
      }
      out[key] = groups;
    } else {
      return null;
    }
  }
  return out;
}

function cleanSeatRoster(raw) {
  if (!Array.isArray(raw) || raw.length > LIMITS.seats) return null;
  const seats = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    if (!isSeatIndex(entry.seat, LIMITS.seats)) return null;
    const seat = { seat: entry.seat, kind: entry.kind };
    if (!['device', 'bot', 'empty'].includes(entry.kind)) return null;
    if (entry.deviceId !== undefined && entry.deviceId !== null) {
      if (!isSafeId(entry.deviceId)) return null;
      seat.deviceId = entry.deviceId;
    }
    if (entry.localIndex !== undefined && entry.localIndex !== null) {
      if (!Number.isInteger(entry.localIndex) || entry.localIndex < 0 || entry.localIndex > 8) return null;
      seat.localIndex = entry.localIndex;
    }
    if (entry.name !== undefined) {
      if (typeof entry.name !== 'string') return null;
      // Clamped, never rejected: a long name is a rude peer, not an attacker,
      // and dropping their whole lobby frame over it would be worse. Escaping
      // is the DOM's job (Phase 4) — this only bounds it.
      seat.name = entry.name.slice(0, LIMITS.nameChars);
    }
    if (entry.status !== undefined) {
      if (!['connected', 'interrupted', 'gone', 'bot', 'empty'].includes(entry.status)) return null;
      seat.status = entry.status;
    }
    seats.push(seat);
  }
  return seats;
}

/**
 * The one door. Returns `{ok: true, frame}` with a CLEANED COPY — never the
 * object that came off the wire, so nothing downstream can be handed a field
 * this function did not look at.
 */
/**
 * EVERY FRAME NAMES ITS TABLE, and that is the protocol v2 change.
 *
 * v1 got away with `hostDeviceId` because a device hosted at most one table, so
 * the host's identity WAS the table's. The moment one device can run two, that
 * stops being true, and the frames with no room to say which are the ones where
 * it matters most: a `claim-seat` arriving at a device with two tables open was
 * applied to BOTH of them, and "the host closed the table" could not say which
 * table had closed.
 *
 * Checked once here rather than in nine cases, because a frame kind added later
 * must not be able to forget it.
 */
export function validateFrame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('not an object');
  const kind = raw.k;
  if (typeof kind !== 'string') return fail('no kind');
  if (!isSafeId(raw.tableId)) return fail('no tableId');
  const verdict = validateBody(raw, kind);
  // Attached after the body rather than inside every case: one place to change,
  // and no case can ship without it.
  if (verdict.ok) verdict.frame.tableId = raw.tableId;
  return verdict;
}

/**
 * Mint a table's name.
 *
 * RANDOM RATHER THAN DERIVED, and the difference shows up exactly once: a host
 * ends Tuesday's Hearts and deals a fresh one. Same host, same pack — a derived
 * id would be identical and a joiner's saved seat would silently re-claim into
 * a game that is not the one they were playing. `(hostDeviceId, packId)` stays
 * the uniqueness rule for LIVE tables; this is the name that tells two of them
 * apart across time.
 */
export function mintTableId() {
  const bytes = new Uint8Array(9);
  (globalThis.crypto ?? {}).getRandomValues?.(bytes);
  let out = 't';
  for (const byte of bytes) out += byte.toString(36).padStart(2, '0');
  return out.slice(0, 19);
}

function validateBody(raw, kind) {
  switch (kind) {
    case FRAME.LOBBY: {
      if (!Number.isInteger(raw.protocol)) return fail('lobby: no protocol version');
      if (!isSafeId(raw.packId)) return fail('lobby: bad packId');
      if (raw.packVersion !== undefined && typeof raw.packVersion !== 'string') {
        return fail('lobby: bad packVersion');
      }
      if (!Array.isArray(raw.variants) || raw.variants.length > LIMITS.variants
        || !raw.variants.every(isSafeId)) return fail('lobby: bad variants');
      if (!isSafeId(raw.hostDeviceId)) return fail('lobby: bad hostDeviceId');
      const seats = cleanSeatRoster(raw.seats);
      if (!seats) return fail('lobby: bad seat roster');
      if (!Number.isInteger(raw.seatCount) || raw.seatCount < 2 || raw.seatCount > LIMITS.seats) {
        return fail('lobby: bad seatCount');
      }
      if (raw.started !== undefined && typeof raw.started !== 'boolean') return fail('lobby: bad started');
      // HOW LONG A SEAT GETS, so a joiner's countdown is the host's rule rather
      // than a constant compiled into the joiner's build (plan §7). Optional:
      // a host that never chose sends nothing and the joiner falls back to the
      // default, which is also what a v2 build from before this shipped does.
      if (raw.graceMs !== undefined
        && (!Number.isInteger(raw.graceMs) || raw.graceMs < GRACE_LIMITS.min || raw.graceMs > GRACE_LIMITS.max)) {
        return fail('lobby: bad graceMs');
      }
      return ok({
        k: kind,
        protocol: raw.protocol,
        packId: raw.packId,
        packVersion: raw.packVersion,
        variants: raw.variants.slice(),
        hostDeviceId: raw.hostDeviceId,
        seatCount: raw.seatCount,
        seats,
        started: !!raw.started,
        graceMs: raw.graceMs,
      });
    }

    case FRAME.CLAIM_SEAT: {
      if (!isSeatIndex(raw.seat)) return fail('claim-seat: bad seat');
      const localIndex = raw.localIndex === undefined ? 0 : raw.localIndex;
      if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex > 8) {
        return fail('claim-seat: bad localIndex');
      }
      return ok({ k: kind, seat: raw.seat, localIndex });
    }

    case FRAME.PROPOSE: {
      if (!isSafeId(raw.pid)) return fail('propose: bad pid');
      const move = cleanMove(raw.move, LIMITS.seats);
      if (!move) return fail('propose: bad move');
      return ok({ k: kind, pid: raw.pid, move });
    }

    case FRAME.VIEW:
    case FRAME.SNAPSHOT: {
      // A snapshot IS a view — design decision D2, and the reason recovery is
      // free rather than a second code path that gets tested half as often.
      const view = raw.view;
      if (!view || typeof view !== 'object') return fail(`${kind}: no view`);
      if (!Number.isInteger(view.v)) return fail(`${kind}: view has no version`);
      if (!Number.isInteger(raw.seq) || raw.seq < 0) return fail(`${kind}: bad seq`);
      return ok({ k: kind, seq: raw.seq, view, events: Array.isArray(raw.events) ? raw.events : [] });
    }

    case FRAME.REJECT: {
      if (!isSafeId(raw.pid)) return fail('reject: bad pid');
      if (raw.reason !== undefined && typeof raw.reason !== 'string') return fail('reject: bad reason');
      return ok({
        k: kind,
        pid: raw.pid,
        rule: isSafeId(raw.rule) ? raw.rule : null,
        reason: (raw.reason || '').slice(0, LIMITS.reasonChars),
      });
    }

    case FRAME.SNAPSHOT_REQ: {
      const since = raw.since === undefined ? 0 : raw.since;
      if (!Number.isInteger(since) || since < 0) return fail('snapshot-req: bad since');
      return ok({ k: kind, since });
    }

    case FRAME.EMOTE: {
      if (!Number.isInteger(raw.i) || raw.i < 0 || raw.i >= EMOTES.length) return fail('emote: bad index');
      return ok({ k: kind, i: raw.i });
    }

    case FRAME.BYE: {
      const why = raw.why;
      if (why !== undefined && !['leave', 'replaced', 'closed'].includes(why)) return fail('bye: bad reason');
      return ok({ k: kind, why: why || 'leave' });
    }

    default:
      return fail(`unknown kind ${JSON.stringify(kind).slice(0, 40)}`);
  }
}

/**
 * May a frame of this kind be believed from this sender?
 *
 * THE SPOOF CHECK, AND IT NEEDS `peer.meta`. A host-role frame that arrives
 * RELAYED did not come off our direct link to the host — under a star topology
 * the hub forwards between spokes, so a fellow joiner can put a `view` frame on
 * the wire addressed to us. It is the transport's `relayed` flag, not anything
 * in the payload, that tells the two apart; a payload field would be the very
 * thing an impostor controls.
 */
export function isAuthentic(kind, { fromDeviceId, hostDeviceId, relayed }) {
  if (!HOST_FRAMES.includes(kind)) return true;
  if (!hostDeviceId || fromDeviceId !== hostDeviceId) return false;
  return relayed !== true;
}
