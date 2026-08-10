// WHO OWNS EACH SEAT — a device and a local index, or a bot.
//
// The solo table has exactly one answer to "which seat am I": zero. That answer
// was a module constant in src/ui/table.js (`HUMAN_SEAT = 0`), read from about
// fifty places, and it bakes in two assumptions a shared table breaks: that a
// seat index identifies a PLAYER, and that exactly one seat can ever be mine.
//
// A seat owner is therefore `(deviceId, localIndex)` — the pair design §17.4
// settled on — or a bot, or nobody yet. `localIndex` tells two players sharing
// one device apart (hotseat) and is 0 for every remote seat. It exists NOW,
// before anything reads it, because the alternative is a save-format break the
// day hotseat ships: MULTIPLAYER_PLAN.md §4 lists it among the pre-commitments
// this package owes the protocol.
//
// DEVICE IDS ARE OPAQUE HERE, AND THE LOCAL ONE IS A PARAMETER. This module
// never asks the launcher who we are — the caller passes `localDeviceId` in.
// That is what keeps it DOM-free and Node-clean the way src/players/roster.js
// is, so the tests can pin an ownership table without an `Arcade` global, and
// what keeps the SDK out of the engine's neighbours.
//
// OWNERSHIP IS NOT IDENTITY. What a seat is CALLED, which persona plays it and
// what its head-to-head key is all belong to roster.js. This module answers one
// question — whose seat is it — and a shared table needs that answer separately
// because a seat's owner can change (a drop, a rebind, a bot filling in) while
// its identity does not.

/**
 * The stand-in device id for a table with no peers. Solo play still binds its
 * human seat to a device rather than special-casing "no device", so the local
 * and multiplayer paths ask the same question and only one of them can be
 * wrong.
 */
export const LOCAL_DEVICE = '@local';

/** A seat nobody holds. Frozen and shared — callers only ever read it. */
const EMPTY = Object.freeze({ kind: 'empty', deviceId: null, localIndex: null, botId: null });

function deviceOwner(deviceId, localIndex) {
  return Object.freeze({ kind: 'device', deviceId, localIndex, botId: null });
}

function botOwner(botId) {
  return Object.freeze({ kind: 'bot', deviceId: null, localIndex: null, botId: botId ?? null });
}

/**
 * Build the ownership table for a match.
 *
 * @param seats          how many seats the match has
 * @param localDeviceId  what this device calls itself
 * @param owners         optional pre-built owner array (from `deserialize`);
 *                       omitted for a fresh table, which starts all-empty
 */
export function createSeatTable({ seats, localDeviceId = LOCAL_DEVICE, owners = null } = {}) {
  const count = Number(seats);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`createSeatTable: seats must be a positive integer, got ${seats}`);
  }
  const slots = Array.from({ length: count }, (_, seat) => {
    const given = owners?.[seat];
    if (!given || given.kind === 'empty') return EMPTY;
    if (given.kind === 'bot') return botOwner(given.botId);
    return deviceOwner(given.deviceId, given.localIndex ?? 0);
  });

  function inRange(seat) {
    return Number.isInteger(seat) && seat >= 0 && seat < count;
  }

  const table = {
    count,
    localDeviceId,

    /** The owner record for a seat. Always an object; never null. */
    ownerOf(seat) {
      return inRange(seat) ? slots[seat] : EMPTY;
    },

    /** Is this seat held by a human on THIS device? */
    isLocal(seat) {
      const owner = table.ownerOf(seat);
      return owner.kind === 'device' && owner.deviceId === localDeviceId;
    },

    /** Is this seat held by a human on some OTHER device? */
    isRemote(seat) {
      const owner = table.ownerOf(seat);
      return owner.kind === 'device' && owner.deviceId !== localDeviceId;
    },

    isBot(seat) {
      return table.ownerOf(seat).kind === 'bot';
    },

    isEmpty(seat) {
      return table.ownerOf(seat).kind === 'empty';
    },

    /** Every seat this device plays, in seat order. Hotseat returns several. */
    localSeats() {
      const out = [];
      for (let seat = 0; seat < count; seat++) if (table.isLocal(seat)) out.push(seat);
      return out;
    },

    /**
     * The seat this device renders itself as — the one whose hand sits at the
     * bottom of the felt.
     *
     * NULL IS A REAL ANSWER, not a failure: a joiner who has not claimed a seat
     * yet, and a spectator, both own no seat and must still be able to draw the
     * table. Callers that need a number for a solo-shaped question supply their
     * own fallback rather than having one invented here.
     */
    primaryLocalSeat() {
      for (let seat = 0; seat < count; seat++) if (table.isLocal(seat)) return seat;
      return null;
    },

    /** Which seat a given player holds, or null. */
    seatOf(deviceId, localIndex = 0) {
      for (let seat = 0; seat < count; seat++) {
        const owner = slots[seat];
        if (owner.kind === 'device' && owner.deviceId === deviceId && owner.localIndex === localIndex) {
          return seat;
        }
      }
      return null;
    },

    /** Every seat held by one device, whatever its local index. */
    seatsOfDevice(deviceId) {
      const out = [];
      for (let seat = 0; seat < count; seat++) {
        if (slots[seat].kind === 'device' && slots[seat].deviceId === deviceId) out.push(seat);
      }
      return out;
    },

    /**
     * Seat a player, returning true if it took.
     *
     * A CLAIM IS REFUSED, NEVER STOLEN. The host arbitrates seating and a
     * refusal is the answer a client gets when two people tapped the same chair
     * — so an occupied seat says no rather than evicting whoever is in it. The
     * one exception is the player already there: re-claiming your own seat is
     * how a rebind after a drop succeeds without a release first.
     */
    claim(seat, { deviceId, localIndex = 0 } = {}) {
      if (!inRange(seat) || deviceId == null) return false;
      const held = table.seatOf(deviceId, localIndex);
      if (held !== null && held !== seat) return false; // one seat per player
      const owner = slots[seat];
      const mine = owner.kind === 'device'
        && owner.deviceId === deviceId
        && owner.localIndex === localIndex;
      if (owner.kind === 'device' && !mine) return false;
      slots[seat] = deviceOwner(deviceId, localIndex);
      return true;
    },

    /** Put a bot in a seat. Overwrites whatever was there — the host's call. */
    seatBot(seat, botId = null) {
      if (!inRange(seat)) return false;
      slots[seat] = botOwner(botId);
      return true;
    },

    /** Empty a seat. */
    release(seat) {
      if (!inRange(seat)) return false;
      slots[seat] = EMPTY;
      return true;
    },

    /**
     * The persistable form — plain JSON, no functions, safe to hand to storage
     * or put in a frame. Paired with `deserializeSeatTable` below.
     */
    serialize() {
      return {
        seats: count,
        owners: slots.map((owner) => (owner.kind === 'empty'
          ? { kind: 'empty' }
          : owner.kind === 'bot'
            ? { kind: 'bot', botId: owner.botId }
            : { kind: 'device', deviceId: owner.deviceId, localIndex: owner.localIndex })),
      };
    },
  };

  return table;
}

/**
 * Rebuild a seat table from `serialize()` output, re-answering "which of these
 * is me" against the device doing the rebuilding.
 *
 * THE LOCAL DEVICE IS NOT PART OF THE PAYLOAD, deliberately: the same saved
 * table read by two devices must yield two different `localSeats()`, and a
 * stored "this one is mine" would be a lie on the second one.
 */
export function deserializeSeatTable(payload, { localDeviceId = LOCAL_DEVICE } = {}) {
  const seats = payload?.seats;
  if (!Number.isInteger(seats) || seats < 1) return null;
  if (!Array.isArray(payload.owners) || payload.owners.length !== seats) return null;
  return createSeatTable({ seats, localDeviceId, owners: payload.owners });
}

/**
 * The two questions every rendering module actually asks, as ONE live seam.
 *
 * Six modules — the zone renderer, the match record, the contract ladder, the
 * celebrations, the hand gestures and the bot driver — each took a `humanSeat`
 * NUMBER at init(). That is wrong twice over for a shared table. It is captured
 * once, before a match exists, so a seat that is decided later (a joiner
 * claiming a chair) can never reach them; and it is a single number, so
 * "is this seat mine" and "which seat do I draw at" are forced to be the same
 * question when hotseat makes them different.
 *
 * A lens is read at CALL time and answers both. `fallbackSeat` is what it says
 * before any table exists, which keeps the pre-session render — the empty felt
 * behind the lobby — behaving exactly as it did when the answer was a constant.
 *
 * @param getTable  () => seat table, or null before a match is adopted
 */
export function createSeatLens(getTable, { fallbackSeat = 0 } = {}) {
  return {
    /** The seat this device draws itself at. */
    seat() {
      const table = getTable();
      if (!table) return fallbackSeat;
      return table.primaryLocalSeat() ?? fallbackSeat;
    },
    /** Does this device hold `seat`? Safe on null/undefined seats. */
    holds(seat) {
      const table = getTable();
      if (!table) return seat === fallbackSeat;
      return table.isLocal(seat);
    },
  };
}

/**
 * The solo table: one human seat on this device, bots everywhere else.
 *
 * This is the shape every existing match has, expressed in the new vocabulary
 * so the single-player path and the shared one ask the same module the same
 * question. `humanSeat` stays a parameter rather than a hard zero because
 * roster.js already takes one, and the two must not disagree about which chair
 * the star is in.
 */
export function soloSeatTable(seats, { humanSeat = 0, localDeviceId = LOCAL_DEVICE } = {}) {
  const table = createSeatTable({ seats, localDeviceId });
  for (let seat = 0; seat < table.count; seat++) {
    if (seat === humanSeat) table.claim(seat, { deviceId: localDeviceId, localIndex: 0 });
    else table.seatBot(seat);
  }
  return table;
}
