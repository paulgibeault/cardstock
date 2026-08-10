// A TURN THAT RAN OUT IS A MOVE, NOT A UI EVENT.
//
// The temptation is to treat a timeout as something the table does — grey the
// seat out, skip it, carry on. That desynchronises a shared match on the first
// one: the host's state and every client's have now diverged by a fact that is
// nowhere in the log, so a resync, a resume from storage, or a replay all
// reconstruct a game in which that seat never ran out of time.
//
// So expiry produces an ordinary MOVE through the ordinary pipeline. The log
// stays the whole truth, `rehydrateMatch` still rebuilds the table exactly,
// and clients learn about it the same way they learn about anything else — the
// next view frame. Nothing here applies anything itself: it decides WHO ran out
// and hands that to the host, which is the only party allowed to move.
//
// ONE SIDE HOLDS THE CLOCK. Clients receive deadlines and render countdowns;
// only the host arms this. A client that could time seats out would be a client
// that can force its opponents to pass by running its clock fast.
//
// SIMULTANEOUS PHASES GET A DEADLINE EACH. Hearts' passing has every
// uncommitted seat acting at once (`actingSeats`), so a single "current turn"
// deadline would either expire the wrong seat or expire all of them together.
// Deadlines are keyed by seat and reconciled on every arm: seats that stopped
// acting lose theirs, seats that started acting gain one, and a seat that has
// been waited on all along KEEPS the deadline it already had rather than
// having its clock quietly reset by somebody else's move.

import { deadline } from './clock.js';

/**
 * @param clock         a clock from src/match/clock.js (the host's wall clock)
 * @param timeoutMs     how long a seat may sit there, in ms
 * @param actingSeatsOf (state) => seats that may act right now
 * @param waitsOn       (seat) => is this a seat we time? (bots and our own
 *                      seats are not — a bot is scheduled by the bot driver,
 *                      and timing ourselves out would be the host penalising
 *                      its own player for thinking)
 * @param onExpire      (state, seat) => void — the host applies the takeover
 *                      move through the normal pipeline
 * @param currentEpoch  () => the table's epoch, checked at fire time
 */
export function createTurnTimer({
  clock,
  timeoutMs,
  actingSeatsOf,
  waitsOn,
  onExpire,
  currentEpoch = () => 0,
}) {
  /** seat -> { expiresAt, timer } */
  const live = new Map();

  function clear(seat) {
    const entry = live.get(seat);
    if (entry) entry.timer.cancel();
    live.delete(seat);
  }

  function cancelAll() {
    for (const seat of [...live.keys()]) clear(seat);
  }

  /**
   * Bring the deadline set in line with who is actually being waited on.
   * Idempotent: calling it twice on an unchanged state changes nothing, which
   * matters because the table arms after every move and a re-arm that reset
   * everyone's clock would make a timeout unreachable at a busy table.
   */
  function arm(state) {
    if (!state || state.gameOver) {
      cancelAll();
      return deadlines();
    }
    const acting = new Set(actingSeatsOf(state).filter((seat) => waitsOn(seat)));

    for (const seat of [...live.keys()]) if (!acting.has(seat)) clear(seat);

    for (const seat of acting) {
      if (live.has(seat)) continue; // already on the clock — do not restart it
      const myEpoch = currentEpoch();
      const expiresAt = clock.now() + timeoutMs;
      // REGISTERED BEFORE IT IS SCHEDULED. `clock.at` fires SYNCHRONOUSLY for a
      // deadline already past (a zero or negative timeout), and if the entry
      // were installed after that call returned, the callback's own
      // `live.delete` would find nothing and the entry would then be written
      // back over the top — a deadline reported to every client forever,
      // attached to a timer that has already run.
      const entry = { expiresAt, timer: { cancel() {} } };
      live.set(seat, entry);
      entry.timer = clock.at(expiresAt, () => {
        live.delete(seat);
        if (myEpoch !== currentEpoch()) return; // superseded — drop the stale expiry
        // Re-ask rather than trust the snapshot this was armed from: the seat
        // may have moved, been filled by a bot, or had the round end under it
        // while the deadline was pending.
        if (!actingSeatsOf(state).includes(seat)) return;
        if (!waitsOn(seat)) return;
        onExpire(state, seat);
      });
    }
    return deadlines();
  }

  /** The wire form: what a `view` frame carries so clients can count down. */
  function deadlines() {
    return [...live.entries()]
      .map(([seat, entry]) => deadline(seat, 'turn', entry.expiresAt))
      .sort((a, b) => a.seat - b.seat);
  }

  return { arm, deadlines, cancelAll, clear };
}
