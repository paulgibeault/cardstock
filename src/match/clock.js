// TWO CLOCKS, AND WHY A SHARED TABLE CANNOT USE THE FIRST.
//
// Every timer at a solo table is `Arcade.session.setTimeout`, and that is
// right: it FREEZES while the frame is suspended (§6c — forgotten timers are
// the fleet's number one battery drain) and cancels itself when a save import
// replaces the state. A bot that stops thinking while nobody is looking is
// exactly what one player wants.
//
// It is exactly wrong for a table three people share. A suspended frame is one
// player putting their phone in a pocket; the hand does not stop, and the turn
// clock they are burning is real time whether or not their tab is painting.
// Worse, a frozen clock is a clock that silently disagrees with everyone
// else's — and a shared table with two disagreeing clocks has no answer to
// "whose turn expired first" that both sides will accept.
//
// So a shared table runs on ONE clock, the host's wall clock, and the pieces
// that used to schedule for themselves take a clock instead (src/ui/botDriver.js).
//
// DEADLINES, NOT DURATIONS. `at(expiresAt)` is the load-bearing half. A
// duration handed to setTimeout is a promise the platform does not keep:
// background tabs throttle timers to a second or more, and a suspended process
// stops delivering them entirely, so "fire in 8000ms" drifts by however long
// the machine was asleep. A deadline is an absolute fact that survives the nap
// — on every wake the clock asks how much is left and reschedules, rather than
// accumulating ticks it was never given. That is why a host can sleep through
// a turn timeout and still resolve it correctly on the next breath.
//
// WHY THIS DIRECTORY. `src/match/` is match-level infrastructure that is
// neither the pure engine (which must stay deterministic and clock-free — a
// wall clock in `src/engine/` is an invitation to desync a replay) nor the DOM
// (`src/ui/`). The multiplayer protocol lands here too, so it will not be a
// one-file directory for long.

/** How often a pending deadline re-checks itself. */
const WAKE_INTERVAL_MS = 250;

/**
 * The solo clock: the SDK's session timers, unchanged.
 *
 * Deliberately a thin wrapper rather than a re-implementation — the freezing
 * and the import-cancellation are the features, and re-creating them here
 * would mean owning two copies of a §6c obligation.
 */
export function sessionClock() {
  return {
    kind: 'session',
    now: () => Date.now(),
    after(ms, fn) {
      return Arcade.session.setTimeout(fn, ms);
    },
    at(expiresAt, fn) {
      // The session clock freezes anyway, so the remaining-time arithmetic
      // that makes `at` honest on the wall clock would be theatre here. One
      // timer, the duration it implies.
      return Arcade.session.setTimeout(fn, Math.max(0, expiresAt - Date.now()));
    },
  };
}

/**
 * The host clock: real time, and deadlines that survive a sleeping tab.
 *
 * @param now  injectable for tests; a fake clock is the only way to assert
 *             "slept through the deadline" without actually sleeping
 */
export function wallClock({ now = () => Date.now(), schedule = setTimeout, unschedule = clearTimeout } = {}) {
  function at(expiresAt, fn) {
    let handle = null;
    let cancelled = false;

    function tick() {
      handle = null;
      if (cancelled) return;
      const remaining = expiresAt - now();
      if (remaining <= 0) {
        fn();
        return;
      }
      // Never sleep longer than the wake interval, so a deadline that arrives
      // while the process was frozen is noticed on the first breath after it
      // rather than at whatever moment a stale duration happens to land.
      handle = schedule(tick, Math.min(remaining, WAKE_INTERVAL_MS));
    }

    tick();
    return {
      cancel() {
        cancelled = true;
        if (handle !== null) unschedule(handle);
        handle = null;
      },
    };
  }

  return {
    kind: 'wall',
    now,
    after: (ms, fn) => at(now() + ms, fn),
    at,
  };
}

/**
 * A deadline as it travels: `{ seat, kind, expiresAt }`.
 *
 * ABSOLUTE, AND THE HOST'S. A client renders a countdown from it and never
 * acts on it — the host owns expiry, because a client whose clock runs fast
 * would otherwise be able to time its own opponents out. `expiresAt` is host
 * epoch milliseconds; a client that wants a countdown compares it against the
 * offset it derives from the frame it arrived in rather than trusting its own
 * wall clock to agree.
 */
export function deadline(seat, kind, expiresAt) {
  return { seat, kind, expiresAt };
}
