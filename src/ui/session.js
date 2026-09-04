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
 * @param seats    who OWNS each seat (src/players/seats.js) — device or bot
 * @param seating  who is in each seat (src/players/roster.js)
 * @param cardArt  this pack's renderer (src/ui/cardStyles)
 * @param handPrefs the human's saved fan arrangement for this pack
 */
export function createSession({ pack, state, seats, seating, cardArt, handPrefs, shared = false, hintsTaken = 0 }) {
  return {
    pack,
    state,
    // IS THIS A TABLE OTHER PEOPLE ARE AT? A shared match belongs to its
    // TableSession (src/match/tableSession.js) and is persisted there, under
    // `mpMatch.<tableId>`. The felt must not ALSO write it to the solo slot:
    // that produced two copies of one game which diverged from the first move,
    // and put "Resume"/"Start over" on the lobby tile for a hand three people
    // were sitting at.
    shared,
    // Ownership (which device plays which chair) and identity (what that seat
    // is called) are two different facts, and a shared table can change the
    // first without touching the second — so they are two fields, not one.
    seats,
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
    // The hint the player asked for this turn (src/ui/hint.js): the move, its
    // sentence, and what to light. Cleared by every applied move and by any
    // render where the human is no longer acting, so a suggestion can never
    // outlive the position it was made in.
    hint: null,
    // How many hints this match has handed out so far. Not in the log — a
    // hint is not a move and a replay must not know one was asked for — so
    // it rides beside the saved match (src/arcade/storage.js saveMatch) and is
    // counted into the pack's record when the match concludes, which is the
    // one place the question "does anybody use this" can be answered from.
    hintsTaken,

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

    // Which collapsed seat the player has PICKED to open, or null to let the
    // plate follow whoever is playing. The opponent row is rebuilt wholesale on
    // every render, so an open plate cannot live in the DOM alone — a bot
    // moving would close it under the player's finger.
    openSeat: null,
    // The player closed the plate the turn opened for them. Cleared the moment
    // play moves on, so dismissing it is "not this turn" rather than a mode
    // they have to remember to switch back out of.
    plateDismissed: false,
    // Which seat the plate last opened itself for, so a change of turn can be
    // told from a re-render on the same turn.
    plateActor: null,
    // How the player wants the opponent row shown — 'auto' | 'minimized' |
    // 'all'. Per match, deliberately: it is a way of looking at THIS table,
    // not a setting to carry between them.
    //
    // 'auto' gives up only what will not fit (renderSeats' fit loop), which is
    // right until it is not: Stockpile's piles are small enough that five
    // opponents' worth of them technically fit on any desktop, so 'auto' alone
    // meant that table never minimized at all no matter how cluttered it read.
    // 'minimized' is the player saying they would rather see faces regardless,
    // and 'all' is the opposite — every plate open, the row scrolling.
    seatView: 'auto',
    // Which rung of SEAT_TIERS the opponent row last fitted at, and what that
    // answer depended on. Cached so an ordinary turn rebuilds the row once
    // instead of probing the whole ladder from the top every time anybody
    // moves — see renderSeats' fit loop and seatFitKey.
    seatFit: null,
    // The biggest the opponent row has been for the current configuration, so
    // it can hold that shape instead of resizing under the player every time
    // the turn passes. See reserveSeatRowSpace.
    seatRowReserve: null,

    // Timers. Every one of these freezes with a suspended frame (§6c) and every
    // one is cancelled by stopSession below.
    botTimer: null,
    bannerTimer: null,
    announceTimers: [],
    // The one-shot that replays a pulse when the human has been sitting on
    // their own turn (see scheduleIdleNudge in src/ui/table.js). Re-armed by
    // every render, so at most one of these exists at a time.
    nudgeTimer: null,

    // Whether the human could act as of the last render. The action bar's turn
    // token is static markup, so its finite pulse has to be replayed on the
    // transition into the human's turn — and a boolean here is what tells that
    // transition apart from the renders that follow it.
    humanActing: false,

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
  if (session.nudgeTimer) session.nudgeTimer.cancel();
  session.nudgeTimer = null;
  session.humanActing = false;
  session.botCallDecision.clear();
  session.botCatchDecision.clear();
  session.peek = null;
  session.pendingRender = null;
  session.selection = null;
}
