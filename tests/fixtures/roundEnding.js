// THE ROUND ENDING, STOOD UP WITHOUT A SCREEN.
//
// src/ui/roundEnding.js was carved out of src/ui/table.js precisely so a Node
// test could call it (#223 seam 2): it takes `el`, `session`, `epoch` and every
// door it knocks on as parameters, and it loads with no `document` at all. This
// is the smallest set of those parameters that lets the beats actually run, in
// one place, because four test files ask about them and four stubs that disagree
// about what `session` looks like would be four tests passing against a felt
// nobody ships.
//
// THE TIMERS ARE THE POINT, so they do not tick by themselves. `installArcade`'s
// session clock (tests/fixtures/arcade.js) records `{ fn, ms, cancel() }` and
// fires nothing — which is what `src/ui/clock.js`'s `schedule` reaches for — so a
// test says WHEN a beat's clock goes off by calling `fire()`, and a test about the
// rung that has no clock can assert that nothing was armed at all.
//
// WHAT IT DOES NOT STUB is the plan: `roundBeatPlan`/`finalShowPlan` are pure and
// the tests build real ones, because a hand-written plan is a test about a shape
// the renderer would never be given.

import { installArcade } from './arcade.js';
import { createTableSession } from '../../src/match/tableSession.js';
import { createRoundEnding } from '../../src/ui/roundEnding.js';

/**
 * A session with the beat fields src/ui/session.js gives a real one, pointing
 * at a solo table (src/match/tableSession.js) the way every felt session does
 * since #225 — the seating, the daily flag and "are other people here" are the
 * table's, not the session's.
 */
export function stubSession(extra = {}) {
  return {
    table: createTableSession({ packId: 'test-pack', role: 'solo' }),
    dealAnimation: false,
    roundSummaryOpen: false,
    reopenSummary: null,
    roundBeat: false,
    roundFinalState: null,
    trickBeat: null,
    trickPoseState: null,
    beatResume: null,
    beatOpenedAt: null,
    beatTimers: [],
    revealTimer: null,
    advanceTimer: null,
    ...extra,
  };
}

/**
 * A state with just enough on it for the ending to read: no template hooks, so
 * every `?.()` in the module short-circuits to "the platform's own reveal".
 */
export function stubState(extra = {}) {
  return {
    seats: 4,
    roundNumber: 3,
    scores: [0, 0, 0, 0],
    events: [],
    // `actingSeats` reads it when the show repaints the bar by hand.
    turn: { seat: 0, phase: 'play' },
    pack: { id: 'test-pack', manifest: { name: 'Testy' }, template: {} },
    ...extra,
  };
}

/**
 * @param overrides anything above, plus any dep you want to watch or replace.
 * @returns `{ ending, session, el, calls, said, timers, store, fire, setEpoch, arcade }`
 *   — `calls` is every dep call in order as `['name', ...args]`, `said` is every
 *   write to `#log` in order (so "one write per frame" is answerable), and
 *   `timers` is the live arcade timer list.
 */
export function roundEndingHarness(overrides = {}) {
  const { session: sessionOverride, state: stateOverride, ...deps } = overrides;
  const { store, timers, arcade } = installArcade({ state: true, session: true });
  const session = sessionOverride ?? stubSession();
  const state = stateOverride ?? stubState();
  const calls = [];
  const said = [];
  let epoch = 1;

  const spy = (name, impl) => (...args) => {
    calls.push([name, ...args]);
    return impl ? impl(...args) : undefined;
  };

  // `#log` is the live region every beat speaks through, and "how many times was
  // it written in one frame" is a real question about it (#180), so the write is
  // recorded rather than merely kept.
  const log = {
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; said.push(v); },
  };

  const el = {
    log,
    // `spotlightZone` sweeps the felt for the pile it lit last.
    screen: { querySelectorAll: () => [] },
  };

  const base = {
    el,
    session: () => session,
    epoch: () => epoch,
    liveState: () => state,
    feltState: () => state,
    render: spy('render'),
    animateMove: spy('animateMove'),
    renderStatusBar: spy('renderStatusBar'),
    seatLabel: (seat) => `Seat ${seat}`,
    seatPossessive: (seat) => `Seat ${seat}'s`,
    mySeat: () => 0,
    voiceOf: () => ({}),
    cardById: () => null,
    zoneStackNode: () => null,
    pulseSeat: spy('pulseSeat'),
    showBanner: spy('showBanner'),
    showShowCard: spy('showShowCard'),
    hideShowCard: spy('hideShowCard'),
    releaseBanner: spy('releaseBanner'),
    celebrateDeal: spy('celebrateDeal'),
    currentFlightMs: () => 420,
    powerSaving: () => false,
    scheduleNextTurn: spy('scheduleNextTurn'),
    cancelBotTurn: spy('cancelBotTurn'),
    cancelAnnouncementBeats: spy('cancelAnnouncementBeats'),
    exitToLobby: spy('exitToLobby'),
    showRoundSummary: spy('showRoundSummary'),
    hideRoundSummary: spy('hideRoundSummary'),
    paintRoundPace: spy('paintRoundPace'),
    confirmAction: spy('confirmAction', () => Promise.resolve(true)),
  };

  const ending = createRoundEnding({ ...base, ...deps });

  return {
    ending,
    session,
    state,
    el,
    calls,
    said,
    timers,
    arcade,
    // The SDK's state map, for a test that wants to write the preferences blob
    // the way the lobby does. It is the harness's own — installing Arcade twice
    // replaces the first store, so a test must use this one.
    store,
    /** The names of the deps called, in order — for "what happened, and when". */
    names: () => calls.map((c) => c[0]),
    setEpoch: (n) => { epoch = n; },
    /**
     * Fire the nth live timer (default: the oldest), the way a clock would — once.
     * A fired timer is spent, so it leaves `live()` exactly as a real one would.
     */
    fire(n = 0) {
      const live = timers.filter((t) => !t.cancelled && !t.fired);
      if (!live[n]) throw new Error(`no live timer ${n} (of ${live.length})`);
      live[n].fired = true;
      live[n].fn();
    },
    /** Every timer that has neither been cancelled nor fired, oldest first. */
    live: () => timers.filter((t) => !t.cancelled && !t.fired),
  };
}

/** An input event as the felt's listeners see one: a moment, nothing else. */
export function inputAt(timeStamp) {
  return { timeStamp };
}
