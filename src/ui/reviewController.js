// THE REVIEW LENS: the felt at any turn of the match (REVIEW_PLAN.md phase 3),
// the reel under it, the map beside or over it, and the two maps the results
// panel and the round sheet open onto it.
//
// Carved out of src/ui/table.js (#223, seam 5), which resolves 43 DOM ids at
// import time and therefore cannot be loaded by `node --test`. That is why this
// file takes `el`, the session slot and the panel doors as PARAMETERS: where a
// review opens, what the reel says, what leaving it puts back and which door a
// tap on the map goes through are questions a Node test should be able to ask
// (tests/reviewController.test.js now drives them).
//
/* ------------------------------------------------------------------ *
 * The log is the match (src/engine/replay.js) and a whole one replays in a
 * few milliseconds, so a position is computed every time it is asked for
 * (src/stats/timeline.js's positionAt) and nothing here caches a state. The
 * LIVE state is never touched: review is a different thing on the felt, and
 * leaving it is rendering the live one again.
 *
 * THE LENS. A finished match shows every position whole. A LIVE match shows
 * what this seat could see at that position — `viewFor` through the same
 * `modelFromView` a joiner renders — so scrubbing back through a hand still
 * being played is never a peek at a card that was face down then. Opponents'
 * hands render as backs either way until the open lens lands (phase 4).
 * ------------------------------------------------------------------ */
//
// WHAT STAYS IN table.js: `session.review` itself (the session is table.js's
// slot, and `feltState` reads the review's state to decide what the felt is
// showing), the handful of `session.review` checks in the render and the move
// loop that say "the felt is not live right now", and the listeners — the
// reel's buttons, the window's keydown (which hands its event to `onKey`) and
// the panels' doors — which initTable wires to this object.

import { serializeMatch } from '../engine/replay.js';
import { viewFor } from '../engine/view.js';
import { matchTimeline, positionAt, seekTargets } from '../stats/timeline.js';
import { reviewMapModel, renderReviewMap, reviewBarModel, paintReviewCursor, beatMoment } from './review.js';
import { modelFromView } from './tableModel.js';
import { paceLevel } from './pace.js';
import { currentPace } from './roundEnding.js';

/**
 * The review, handed what it reads and the doors it opens and closes.
 *
 * `session` is a THUNK: the doors (src/ui/matchDoors.js) replace it on every
 * open and null it on the way out. The round ending goes in as the object
 * itself, because initTable builds it first.
 *
 * The panel doors go IN rather than being imported here: src/ui/panels.js
 * resolves its own element ids at import time, like table.js (see
 * src/ui/roundEnding.js). The same goes for `hideBanner` and `hideShowCard`,
 * which are table.js's one banner slot.
 *
 * @param deps.el        table.js's element table; this reads `log` and the
 *                       reel's six (`reviewBar`, `reviewPrevHand`,
 *                       `reviewPrevTurn`, `reviewNextTurn`, `reviewNextHand`,
 *                       `reviewPosition`)
 * @param deps.session   () => the live session, or null
 * @param deps.render    the whole-felt render; a position is drawn by it
 * @param deps.art       () => the pack's card renderer, for the map's faces
 */
export function createReviewController({
  el, session, roundEnding, liveState, feltState, render, seatLabel, mySeat, cardById, art,
  cancelBotTurn, cancelAnnouncementBeats, scheduleNextTurn, scheduleAnnouncementBeats,
  hideBanner, hideShowCard,
  showGameOver, hideGameOver, hideScoreboard, hideRoundSummary, paintRoundPace,
  showReviewMap, hideReviewMap, isReviewMapOpen, isReviewDrawerOpen, reviewMapNode,
}) {
  /** Can a review be opened on this felt right now? */
  function reviewOffered() {
    const state = liveState();
    if (!state || state.isView || !session() || session().review || state.log.length === 0) return false;
    // FROM THE SHEET IS FINE: the beat is holding at the summary, which knows how
    // to put itself back (`reopenSummary`). Mid-beat — a trick held, a count up —
    // is not: there is a timer or a tap the beat is waiting on.
    if (session().roundSummaryOpen) return !!session().reopenSummary;
    return !session().roundBeat && !session().trickBeat;
  }

  /**
   * THE MATCH AS A TIMELINE, AND THE MAP OF IT — each built in one place (#223).
   * The review's own map, the results panel's and the round sheet's were three
   * copies of the same serialize → timeline → model → render, differing only
   * in where the map stands and what a tap on it does. Those are the arguments.
   */
  function timelineOf(state) {
    const snapshot = serializeMatch(state);
    return { snapshot, timeline: matchTimeline(state.pack, snapshot, { labelOf: seatLabel }) };
  }

  function mapOf(state, timeline, index, { onSeek, onBeat }) {
    const model = reviewMapModel(timeline, { index, labelOf: seatLabel });
    return renderReviewMap(model, {
      art,
      cardOf: (id) => cardById(state, id) ?? null,
      onSeek,
      onBeat,
    });
  }

  /**
   * Open the review at `at`, or at the start of the last turn when not asked —
   * the position a player most wants to look at is the one just before the
   * thing that just happened.
   */
  function enterReview({ at = null, map = false } = {}) {
    if (!reviewOffered()) return;
    const state = liveState();
    cancelBotTurn();
    cancelAnnouncementBeats();
    hideBanner();
    hideGameOver();
    hideScoreboard();
    if (session().roundSummaryOpen) {
      // The sheet steps aside and its countdown stops; `leaveReview` puts both
      // back. `roundSummaryOpen` stays true: we are still between hands.
      roundEnding.cancelRoundBeat();
      hideRoundSummary();
    }
    const { snapshot, timeline } = timelineOf(state);
    session().review = {
      snapshot,
      timeline,
      index: 0,
      state: null,
      lens: state.gameOver ? 'open' : 'own',
    };
    const start = at ?? (seekTargets(timeline, timeline.length).prevTurn ?? 0);
    seekReview(start);
    el.reviewBar.hidden = false;
    if (map) openReviewMap();
  }

  /** Stand the felt at position `n` of the reviewed match. */
  function seekReview(n) {
    const review = session()?.review;
    if (!review) return;
    const live = liveState();
    const index = Math.max(0, Math.min(review.timeline.length, n | 0));
    review.index = index;
    const whole = positionAt(live.pack, review.snapshot, index);
    review.state = review.lens === 'own'
      ? modelFromView(viewFor(whole, mySeat()), live.pack)
      : whole;
    hideShowCard();
    render(review.state);
    paintReviewBar();
    // The map follows the felt, in place: the drawer stays open across a whole
    // review and a rebuild per step would redraw hundreds of faces.
    paintReviewCursor(reviewMapNode(), review.timeline, index);
    // The sentence for where we are: the move that led here, which is what a
    // player stepping back is trying to see.
    const led = index > 0 ? review.timeline.moves[index - 1] : null;
    el.log.textContent = led ? `${led.text}.` : 'The deal.';
  }

  function paintReviewBar() {
    const review = session()?.review;
    if (!review) return;
    const model = reviewBarModel(review.timeline, review.index, seatLabel);
    el.reviewPosition.textContent = model.label;
    el.reviewPrevHand.disabled = model.prevHand == null;
    el.reviewPrevTurn.disabled = model.prevTurn == null;
    el.reviewNextTurn.disabled = model.nextTurn == null;
    el.reviewNextHand.disabled = model.nextHand == null;
  }

  function stepReview(which) {
    const review = session()?.review;
    if (!review) return;
    const target = seekTargets(review.timeline, review.index)[which];
    if (target != null) seekReview(target);
  }

  /**
   * Where the map goes: BESIDE the felt when the window has room for both, so
   * every tap on it moves the felt in view; over it as a sheet otherwise.
   * Answered when the map opens, against the window as it is then.
   */
  function reviewMapFits() {
    return typeof window !== 'undefined' && window.matchMedia?.('(min-width: 900px)').matches;
  }

  function openReviewMap() {
    const review = session()?.review;
    if (!review) return;
    if (isReviewMapOpen()) { hideReviewMap(); refitFelt(); return; }
    const live = liveState();
    const drawer = reviewMapFits();
    const node = mapOf(live, review.timeline, review.index, {
      // A play stands the felt at the moment before it. As a sheet the map
      // closes to show it; as a drawer it stays and the felt moves beside it.
      onSeek: (from) => {
        if (!isReviewDrawerOpen()) hideReviewMap();
        seekReview(from);
      },
      // A beat's head opens it; beside the felt it also shows the winning play
      // landed, which is the moment a player opening a trick wants to see.
      onBeat: (beat, open) => {
        if (open && isReviewDrawerOpen()) seekReview(beatMoment(beat));
      },
    });
    showReviewMap(node, { drawer, title: live.gameOver ? 'The whole game' : 'The game so far' });
    refitFelt();
  }

  /**
   * The finished game's map, for the results panel (issue #191): the same
   * accordion, standing at the end, every play of it a door onto the felt at
   * that moment — the results close, the review opens there, and beside the
   * felt the drawer opens with it so the reading can go on.
   */
  function gameOverMapNode() {
    const state = liveState();
    if (!state || state.isView || !state.log.length) return null;
    const { timeline } = timelineOf(state);
    return mapOf(state, timeline, timeline.length, {
      onSeek: (from) => {
        hideGameOver();
        enterReview({ at: from, map: reviewMapFits() });
      },
    });
  }

  /**
   * The map on the round sheet: the hand just finished, standing at its last
   * trick. Opening it stops the countdown — the sheet's own control shows Manual
   * for the rest of this sheet, the way "End match" does while it asks.
   */
  function roundMapNode() {
    const state = liveState();
    if (!state || state.isView || !state.log.length || !session()?.roundSummaryOpen) return null;
    roundEnding.cancelAutoAdvance();
    paintRoundPace({ ...roundEnding.paceView(paceLevel(currentPace().id)), autoMs: null });
    const { timeline } = timelineOf(state);
    const at = seekTargets(timeline, timeline.length).prevTurn ?? 0;
    return mapOf(state, timeline, at, {
      onSeek: (from) => enterReview({ at: from, map: reviewMapFits() }),
    });
  }

  /** The felt after the drawer took or gave back its width: measure again. */
  function refitFelt() {
    if (!session()) return;
    session().seatFit = null;
    session().handFit = null;
    render(feltState());
  }

  /** Back to the game: the live felt, the bots, and the results if the match was over. */
  function leaveReview() {
    if (!session()?.review) return;
    session().review = null;
    hideReviewMap();
    el.reviewBar.hidden = true;
    const state = liveState();
    if (!state) return;
    session().seatFit = null;
    session().handFit = null;
    if (session().roundSummaryOpen && session().reopenSummary) {
      // Back between hands: the ending on the felt and the sheet over it, its
      // countdown restarted. The bots wait on the sheet's own door, as before.
      render(feltState());
      session().reopenSummary();
      return;
    }
    render(state);
    if (state.gameOver) {
      if (session().ending) showGameOver(state, session().ending);
      return;
    }
    scheduleNextTurn();
    scheduleAnnouncementBeats();
  }

  /**
   * THE REEL FROM THE KEYBOARD (REVIEW_PLAN.md phase 3): arrows step a turn,
   * with Shift a hand; Escape closes the map, then the review. Handed the
   * window's keydown by table.js; answers whether it took the key, so the felt's
   * own keys (the held beat's Enter and Space) are asked only when it did not.
   */
  function onKey(event) {
    if (!session()?.review) return false;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const forward = event.key === 'ArrowRight';
      stepReview(event.shiftKey ? (forward ? 'nextHand' : 'prevHand') : (forward ? 'nextTurn' : 'prevTurn'));
      event.preventDefault();
      return true;
    }
    if (event.key === 'Escape') {
      if (isReviewMapOpen()) { hideReviewMap(); refitFelt(); }
      else leaveReview();
      return true;
    }
    return false;
  }

  return {
    enterReview,
    leaveReview,
    stepReview,
    openReviewMap,
    refitFelt,
    onKey,
    // The panels' two maps (initPanels' `onGameOverMap` / `onRoundMap`).
    gameOverMapNode,
    roundMapNode,
    // Returned for tests only: `enterReview` ends in the first two and every
    // step of the reel in the second and third.
    reviewOffered,
    seekReview,
    paintReviewBar,
  };
}
