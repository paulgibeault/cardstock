// Everything ONE OPEN MATCH owns, in one object with one reset point.
//
// src/ui/table.js carried about twenty-five module-level mutables, and two
// different functions hand-reset overlapping subsets of them: `adoptMatch`
// cleared some on the way in, `closeTable` cleared some on the way out, and the
// two bot-decision caches were exactly the ones `closeTable` missed. That is
// not a hypothetical: a persona's "did this bot remember to declare?" roll is
// cached per vulnerability window precisely so it is not re-rolled, so a stale
// entry surviving into the next match is a bot whose forgetfulness was decided
// by a game that is over.
//
// So: one object, created by adoptMatch, nulled by closeTable, and `stopSession`
// as the single place every timer is cancelled. A field that is not on this
// object is not per-match state.
//
// WHAT IS DELIBERATELY NOT HERE. `epoch` and `openToken` are lifecycle counters
// that must SURVIVE a session ending — that is their whole job: a bot timer
// already in flight checks its epoch against the module's, and a superseded
// `openTable` checks its token. Putting them on the object they exist to
// outlive would defeat them. Same for `settings`, `drag` and the element
// lookups, which belong to the screen rather than to a match.

/**
 * @param pack     the loaded pack
 * @param state    the live engine state
 * @param seating  who is in each seat (src/players/roster.js)
 * @param cardArt  this pack's renderer (src/ui/cardStyles)
 * @param handPrefs the human's saved fan arrangement for this pack
 */
export function createSession({ pack, state, seating, cardArt, handPrefs }) {
  return {
    pack,
    state,
    seating,
    cardArt,
    handPrefs,

    // The human's tapped-but-not-yet-committed cards: { from, cardIds }.
    // Cleared on every applied move and pruned against the live state on every
    // render, so a stale id can never reach a move.
    selection: null,
    // The order actually on screen (src/ui/handOrder.js) — presentation only.
    displayedHand: [],
    // The UI model the CURRENT render was built from. Pile and meld handlers
    // read it at click time rather than closing over a move, which is what lets
    // a selection change re-arm them without rebuilding the table.
    ui: null,

    // A render that landed mid-drag would replace the node the pointer is
    // holding, so renders are deferred while one is live and replayed after.
    pendingRender: null,
    dealAnimation: false,
    // Which cards were on the felt at the end of the last render, so a card
    // that was already there does not replay its settle-in.
    shownCardKeys: new Set(),
    enteringKeys: null,
    // The fan-peek gesture's live state (which card is raised, the cached
    // strips, the hold timer).
    peek: null,

    // Panel visibility is not a place to keep state. `dismissRoundSummary`
    // used to branch on `!el.roundOverlay.hidden`, which made the DOM the only
    // record of "we are between rounds".
    roundSummaryOpen: false,

    // Timers. Every one of these freezes with a suspended frame (§6c) and every
    // one is cancelled by stopSession below.
    botTimer: null,
    bannerTimer: null,
    announceTimers: [],

    // ONE ROLL PER VULNERABILITY WINDOW, not one per re-render: without the
    // cache a bot gets a fresh chance to remember every time anybody moves, and
    // `callReliability: 0.5` silently becomes 1.
    botCallDecision: new Map(),
    botCatchDecision: new Map(),
  };
}

/** Cancel everything this session has in flight. Safe on null, safe twice. */
export function stopSession(session) {
  if (!session) return;
  if (session.botTimer) session.botTimer.cancel();
  session.botTimer = null;
  if (session.bannerTimer) session.bannerTimer.cancel();
  session.bannerTimer = null;
  for (const timer of session.announceTimers) timer.cancel();
  session.announceTimers = [];
  session.botCallDecision.clear();
  session.botCatchDecision.clear();
  session.peek = null;
  session.pendingRender = null;
  session.selection = null;
}
