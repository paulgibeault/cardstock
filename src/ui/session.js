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

import { makeCtx } from '../engine/context.js';

/**
 * @param pack     the loaded pack
 * @param state    the live engine state
 * @param seats    who OWNS each seat (src/players/seats.js) — device or bot
 * @param seating  who is in each seat (src/players/roster.js)
 * @param cardArt  this pack's renderer (src/ui/cardStyles)
 * @param handPrefs the human's saved fan arrangement for this pack
 */
export function createSession({
  pack, state, seats, seating, cardArt, handPrefs, shared = false, hintsTaken = 0, daily = null,
}) {
  return {
    pack,
    state,
    // IS THIS TODAY'S DAILY RUN? `{ date, seed }`, or null for an ordinary
    // game. Per-match by construction — the ladder this table is playing was
    // derived for that date and is not the ladder the pack ships, so a field
    // that outlived the session would be a rule set outliving the match it
    // belongs to. It decides which storage slot the match is written to
    // (src/arcade/storage.js) and which record its ending goes into.
    daily,
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
    // The refusal sentence #log is currently carrying for a staged selection the
    // engine will not take (renderStageTray). Kept so a repaint for some other
    // reason — a bot moving, a resize — does not re-announce the same sentence
    // to a screen reader that has already read it.
    lastRefusal: null,

    // A render that landed mid-drag would replace the node the pointer is
    // holding, so renders are deferred while one is live and replayed after.
    pendingRender: null,
    dealAnimation: false,
    // Which cards were on the felt at the end of the last render, so a card
    // that was already there does not replay its settle-in.
    shownCardKeys: new Set(),
    enteringKeys: null,
    // The fan-peek gesture's live state (which card is raised, the cached
    // rows and their strips, the hold timer).
    peek: null,

    // Panel visibility is not a place to keep state. `dismissRoundSummary`
    // used to branch on `!el.roundOverlay.hidden`, which made the DOM the only
    // record of "we are between rounds".
    roundSummaryOpen: false,

    // THE FELT IS BEHIND THE ENGINE, ON PURPOSE. Between a round-ending move
    // and the summary being dismissed, the table paints the position the round
    // ended in while `state` already holds the next deal (src/ui/table.js's
    // runRoundBeat). Nothing on that felt is actable — the cards under the
    // player's finger belong to a position the engine has moved past — so
    // `render` reads this and offers nothing while it is true.
    roundBeat: false,
    // The position the round ended in, held for as long as `roundBeat` is true
    // so a repaint with a reason of its own — a resume, a settings change, a
    // seat being claimed — paints the ending rather than the deal underneath.
    // A throwaway `forkState` copy, never logged, saved or published.
    roundFinalState: null,

    // THE SAME IDEA, ONE MOVE SMALLER (#123). A trick is completed and gathered
    // inside a single move, so the position with all four cards on the table
    // existed only inside `applyMove`. `{ seat }` — who is about to take
    // it — while the felt holds that position; null the rest of the time.
    // Nothing is actable while it is set, for the same reason `roundBeat`
    // offers nothing: the engine has moved past what is on screen.
    trickBeat: null,
    // The posed position itself: a throwaway `forkState` copy with the move's
    // placement applied and its consequences deliberately not run
    // (`template.poseMove`). Never logged, saved or published.
    trickPoseState: null,
    // THE WAY OUT OF THAT HOLD, for a tap (#176). `runTrickReveal` is handed a
    // `resume` and both of its call sites pass a different one, so the felt's
    // tap handler cannot close over it — it has to be able to ASK the session
    // what is currently being held, and this is that answer.
    //
    // A LIVE HANDLE, NOT A RECORD OF ONE. It is nulled the instant it runs and
    // by `stopSession` below, and the closure itself refuses to run unless the
    // session still points at it — so a tap arriving after the hold ended, after
    // a second trick armed its own, or after the table closed finds nothing to
    // fire. At the Manual rung it is the ONLY way out: no timer is armed.
    trickResume: null,

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
    // How the player wants the opponent row shown — 'minimized' | 'all'. Per
    // match, deliberately: it is a way of looking at THIS table, not a setting
    // to carry between them. SEAT_VIEWS at the foot of this file says what the
    // two rungs are, and why there is no longer a third.
    seatView: DEFAULT_SEAT_VIEW,
    // Which rung of SEAT_TIERS the opponent row last fitted at, and what that
    // answer depended on. Cached so an ordinary turn rebuilds the row once
    // instead of probing the whole ladder from the top every time anybody
    // moves — see renderSeats' fit loop and seatFitKey.
    seatFit: null,
    // How many rows the fan last split into, and what that answer depended on.
    // Cached for the same reason seatFit is: the row count answers a
    // measurement of the felt's spare height that the row count itself
    // changes, so a raw re-measure could flip the hand between one row and two
    // on alternate renders — see layoutHand in src/ui/table.js.
    handFit: null,
    // The biggest the opponent row has been for the current configuration, so
    // it can hold that shape instead of resizing under the player every time
    // the turn passes. See reserveSeatRowSpace.
    seatRowReserve: null,

    // THE SHARED BOARD ON THE FELT (src/ui/sharedBoard.js, #136), or null for
    // a pack whose seat counters are quantities rather than positions. The
    // MODEL, not the DOM: the seat plates and the status bar's score chip read
    // it to know the felt is already drawing this road and their own 88px copy
    // of one lane of it would be the same number twice.
    board: null,
    // The board's live nodes. Kept so a score REPAINTS the pegs rather than
    // rebuilding them — an element built fresh at 37% has never been anywhere
    // else, so its one-shot transition on `left` has nothing to run from and
    // the peg teleports instead of moving.
    boardHandle: null,

    // Timers. Every one of these freezes with a suspended frame (§6c) and every
    // one is cancelled by stopSession below.
    botTimer: null,
    bannerTimer: null,
    // THE ONE BANNER WITH NO TIMER (#180). A trick held at a rung that waits for
    // a person keeps its pill up for the whole hold, so there is nothing armed
    // to take it down and something has to remember that it is standing —
    // `releaseBanner` brings it down with the cards, and every other door that
    // clears the felt (`hideBanner`, `stopSession`) drops the claim so a later
    // release cannot cut short whatever the banner is saying by then.
    bannerHeld: false,
    announceTimers: [],
    // THE ROUND ENDING'S OWN TIMERS (#150). `runRoundBeat` used to fire these
    // straight at `Arcade.session.setTimeout` and keep no handle: the only
    // thing that stopped a step from painting into a table that had already
    // been closed was an epoch check inside the callback. That is enough to
    // stop it doing damage and not enough to stop it running, and once the
    // summary deals ITSELF there is a timer that must be cancellable by a tap
    // rather than talked out of acting.
    //
    // `beatTimers` are the show's steps and the summary's own opening;
    // `revealTimer` is the completed trick's hold (runTrickReveal);
    // `advanceTimer` is the sheet dealing the next hand by itself.
    beatTimers: [],
    revealTimer: null,
    advanceTimer: null,
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
  session.bannerHeld = false;
  for (const timer of session.announceTimers) timer.cancel();
  session.announceTimers = [];
  for (const timer of session.beatTimers) timer.cancel();
  session.beatTimers = [];
  if (session.revealTimer) session.revealTimer.cancel();
  session.revealTimer = null;
  // AND THE HOLD'S OTHER END WITH IT (#176). Cancelling the timer is only half
  // of stopping a trick hold now that a tap can end one: a resume left on a
  // stopped session is a closure over a finished match waiting for a finger.
  session.trickResume = null;
  if (session.advanceTimer) session.advanceTimer.cancel();
  session.advanceTimer = null;
  if (session.nudgeTimer) session.nudgeTimer.cancel();
  session.nudgeTimer = null;
  session.humanActing = false;
  session.botCallDecision.clear();
  session.botCatchDecision.clear();
  session.peek = null;
  session.pendingRender = null;
  session.selection = null;
}

/* ------------------------------------------------------------------ *
 * The opponent row's policy — the half of it that is not a rectangle
 * ------------------------------------------------------------------ */

/**
 * WHY THESE LIVE HERE AND NOT IN src/ui/table.js, WHERE THEY ARE USED.
 *
 * table.js touches `document` at import time, so no Node test can load it —
 * tests/repo-gates.test.js says so at length, and has had to resort to grepping
 * the source to pin behaviour it could not call. Everything below is a decision
 * about seat numbers and view names with no rectangle anywhere in it, and a
 * decision no test can reach is one that gets re-derived, differently, the next
 * time somebody edits the renderer. This file is already the Node-clean half of
 * the felt and already holds `seatView`'s default, so the vocabulary and the
 * rules that read it sit together.
 */

/**
 * HOW MUCH OF THE OTHER PLAYERS TO SHOW — the player's own two-way choice.
 *
 * It was a three-way cycle — minimized / auto / all — with `auto` the default:
 * give up only what will not fit, measured by renderSeats' fit loop. Two things
 * took the middle rung out.
 *
 * The first is what put `minimized` there in the first place, and it is still
 * true: fitting is not the whole question. Stockpile's piles are small enough
 * that five opponents' worth of them technically fit on any desktop, so `auto`
 * meant that table never minimized at ANY width, however cluttered it read.
 * "Is this too busy" is a preference and the player is the one holding it — so
 * the rung where they say "faces, regardless" survives.
 *
 * The second is that the middle rung was hedging against a fear that turned out
 * to be wrong. `all` was not the default because a row longer than the felt
 * sounded unusable on a phone; tested on one, scrolling that row sideways is
 * how the player checks everybody else's position, and they asked for the
 * maximized row by default and for the middle option to go. So `all` IS the
 * default, and the carousel is not a state to be rescued from: no width
 * threshold, no fallback, nothing that takes it away.
 *
 * ORDERED LEAST TO MOST, which is the whole of how the control explains itself
 * — see SEAT_VIEW_COPY in src/ui/table.js, where the rungs become dots.
 */
export const SEAT_VIEWS = ['minimized', 'all'];
export const DEFAULT_SEAT_VIEW = 'all';

/**
 * A view name the row can actually draw.
 *
 * Deliberately tolerant rather than asserting. `seatView` is a mutable field on
 * a live object, and 'auto' was a legitimate value of it one commit ago — a
 * session built before this list shrank, or a hand-set value from a devtools
 * poke, has to come back as the default rather than reach renderSeats as a view
 * with no branch to catch it. Silently falling back is right here because the
 * consequence of the fallback is visible on screen the moment it happens.
 */
export function normalizeSeatView(view) {
  return SEAT_VIEWS.includes(view) ? view : DEFAULT_SEAT_VIEW;
}

/** The rung a tap moves to, wrapping round from the last to the first. */
export function nextSeatView(view) {
  const i = SEAT_VIEWS.indexOf(normalizeSeatView(view));
  return SEAT_VIEWS[(i + 1) % SEAT_VIEWS.length];
}

/** Offer the "show everyone" toggle from this many opponents up. */
export const CAROUSEL_FROM_SEATS = 3;

/**
 * Is the view toggle worth putting on the felt at all?
 *
 * A SEAT-COUNT QUESTION, and now only that. It used to also be offered whenever
 * the row was already a carousel, which was free while the carousel was
 * something the player had to ask for — and became meaningless the moment `all`
 * was the default, because that clause is then true at every table on the
 * platform. It would have put the control on a two-hander, where both rungs
 * draw the same fully-open row and tapping it changes nothing a player would
 * notice.
 *
 * THE SECOND CLAUSE IS A LATCH, not a second rule. A player standing on
 * `minimized` keeps the way back out whatever the seat count says. Nothing can
 * reach that state today — `state.seats` is fixed for the life of a match and
 * `seatView` is reset with the session — so it costs a comparison against a
 * failure mode (five faces on screen and no control anywhere to undo them) that
 * has no way to announce itself if it ever does arrive.
 */
export function seatToggleOffered(opponents, view) {
  return opponents >= CAROUSEL_FROM_SEATS || normalizeSeatView(view) === 'minimized';
}

/**
 * WHICH SEAT THE OPPONENT ROW SHOULD SCROLL TO, or null to leave it where it is.
 *
 * "Centre whoever is acting" is the obvious rule and it has a hole in it
 * exactly where the player is standing: on the HUMAN's turn the acting seat is
 * the human's own, which is not in the opponent row at all. The lookup found
 * nothing, the row stayed wherever the last bot had left it, and the player
 * made their decision against whichever opponents happened to be parked on
 * screen.
 *
 * On your own turn the seat worth reading is the one that plays AFTER you —
 * their melds and piles are what your discard is about to be handed to.
 * `nextSeat` honours a reversed direction, so a table that has been turned
 * around scrolls the other way without this having to know how that happened.
 *
 * PENDING SKIPS ARE DELIBERATELY NOT MODELLED. The seat after you is the right
 * answer for an ordinary turn, and the ordinary turn is what happens hundreds
 * of times a match. Working out who a skip, a reverse-on-top-of-a-skip or a
 * stacked penalty will actually land on means asking the template a question no
 * template answers, and a confident wrong guess scrolls the row to a player the
 * turn never reaches — worse than not scrolling, because the row LOOKS like it
 * knows something.
 *
 * NULL WHEN SEVERAL SEATS ACT AT ONCE. Hearts' pass has every seat acting until
 * it commits, and there is no single player to follow. renderSeats already
 * refuses to open a plate in that phase for the same reason, and the row must
 * not disagree with the plate about who the table is watching. Null too when
 * nothing is acting, which is how `actingSeatsOf` reports a finished game.
 */
export function seatToShow(state, mySeat, acting) {
  if (acting.length !== 1) return null;
  const [actor] = acting;
  if (actor !== mySeat) return actor;
  const next = makeCtx(state).nextSeat(mySeat, state.direction);
  // A one-seat table is not something anybody deals, but the answer it produces
  // — scroll to yourself, who is not in this row — is worth refusing outright
  // rather than handing on as a seat number that will never be found.
  return next === mySeat ? null : next;
}
