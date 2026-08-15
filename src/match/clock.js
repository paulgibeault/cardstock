// TWO CLOCKS, AND WHY A SHARED TABLE CANNOT USE THE FIRST.
//
// (Three exports, but two clocks: `feltClock` at the bottom is not a third kind
// of time, it is the choice between these two made per timer instead of once.)
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
 * THE FELT'S CLOCK, CHOSEN PER TIMER RATHER THAN ONCE (#71).
 *
 * The felt's bot driver is built once, in `initTable`, before any match exists
 * — and a match is what decides which clock is right. So the driver was handed
 * `sessionClock()` at construction and kept it for the life of the tab, which
 * is correct for the solo play that is nearly all of it and wrong for the case
 * this exists to fix: a HOSTED table the host is looking at.
 *
 * There, a bot's turn was scheduled on a clock that freezes when the frame
 * suspends. Host pockets their phone on a bot's turn and the table stops for
 * everybody — the mirror image of the bug #58 fixed, which was a table that
 * could not play while unwatched. The turn timer is no help: `waitsOn` only
 * ever waits on device-held seats, because a bot needs no encouragement.
 *
 * WHY NOT DECIDE AT BIND TIME. Nothing rebuilds the driver between matches, so
 * "decide once, when the match is adopted" would mean either rebuilding it or
 * mutating a clock in place. Asking per timer is smaller and has no lifecycle:
 * the question is answered at the only moment it matters, which is when a turn
 * is actually being scheduled.
 *
 * BOTH HANDLES ALREADY AGREE. `Arcade.session.setTimeout` returns
 * `{ cancel() }` and so does `wallClock.at`, so a handle from either can be
 * cancelled without anyone remembering which clock issued it. That is what
 * makes this a four-line dispatch rather than a bookkeeping layer.
 *
 * @param shared () => is the match on the felt a SHARED one? Read at schedule
 *               time, never cached — the felt adopts matches over its lifetime
 *               and the answer changes with each.
 */
export function feltClock({ shared, session = sessionClock(), wall = wallClock() } = {}) {
  const pick = () => (shared() ? wall : session);
  return {
    kind: 'felt',
    now: () => pick().now(),
    after: (ms, fn) => pick().after(ms, fn),
    at: (expiresAt, fn) => pick().at(expiresAt, fn),
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
