// A GUEST'S TABLE KEEPS THE HOST'S TIME (#283).
//
// The host's felt pauses three times that the live state cannot show. It holds
// the completed trick before the sweep. It holds the hand as it ended under the
// score sheet until the host deals on. And it puts the results up at the end of
// a match. The engine has moved past all three by the time the move returns, so
// a guest drawing only the views it was sent jumped straight to the next trick,
// straight into the next hand, and never saw the end of the match at all.
//
// The host now sends the positions it is holding (`meta.poses`) and the pause it
// is in (`meta.beat`). This module turns those into the same pauses on the
// guest's felt. It is a SEQUENCER and nothing else: frames go in in the order
// they arrived and come out in that order, with holds in between. Everything it
// does to the screen is injected, so the order of what is shown can be tested
// without a DOM (tests/guestBeats.test.js).
//
// WHAT IT NEVER DOES IS DECIDE ANYTHING. A guest's sheet closes when the host's
// does — a view without `beat` — and not on any clock of its own. The trick
// hold is the one timed pause, because the host's own trick hold at a shared
// table is timed too (SHARED_TRICK_HOLD_MS) and the two are meant to match.

/**
 * @param effects  what each pause does to the screen:
 *   show(view, { message, dealing })   draw a view on the felt
 *   openSummary({ view, event, ready }) the round sheet, the guest's version
 *   paintReady(ready)                   the sheet's ready line, refreshed
 *   closeSummary()
 *   showResults(view)                   the match is over
 *   hideResults()
 *   holdMs(events)                      how long the completed trick stays
 *   trickMessage(trickWonEvent)         what the log says while it does
 *   schedule(fn, ms)                    a handle with `cancel()` (src/ui/clock.js)
 */
export function createGuestBeats(effects) {
  const fx = {
    paintReady: () => {}, holdMs: () => 0, trickMessage: () => '', ...effects,
  };
  const queue = [];
  let holding = null; // the trick hold in progress: { handle }
  let generation = 0; // bumped by reset, so a hold armed before it cannot land after it
  let betweenHands = false;
  let resultsUp = false;

  function receive(view, events = [], meta = {}) {
    queue.push({ view, events, meta });
    pump();
  }

  function pump() {
    while (!holding && queue.length) step(queue.shift());
  }

  function step({ view, events, meta }) {
    // UNDER THE SHEET, NOTHING MOVES BUT THE TICKS. Every frame the host sends
    // while it is still between hands says so; the first one that does not is
    // the host dealing on, and that is the only thing that closes the sheet.
    if (betweenHands) {
      if (meta.beat) {
        fx.paintReady(meta.beat.ready || []);
        return;
      }
      betweenHands = false;
      fx.closeSummary();
      fx.show(view, { dealing: true });
      return;
    }

    // A NEW MATCH TAKES THE RESULTS DOWN. The host dealt again from its own
    // results sheet, and the first view of that deal is not over.
    if (resultsUp && !view.gameOver) {
      resultsUp = false;
      fx.hideResults();
    }

    // A SNAPSHOT IS A CATCH-UP, NOT A REPLAY. A guest who reconnects mid-sheet
    // is shown where the table is, and told that the host is between hands —
    // the score they missed is not something a snapshot carries.
    if (meta.snapshot) {
      fx.show(view, { message: 'Caught up.' });
      if (meta.beat) {
        betweenHands = true;
        fx.openSummary({ view, event: null, ready: meta.beat.ready || [] });
      } else if (view.gameOver && !resultsUp) {
        resultsUp = true;
        fx.showResults(view);
      }
      return;
    }

    const trick = events.find((e) => e.type === 'trickWon');
    const posed = meta.poses?.trick;
    if (trick && posed) {
      fx.show(posed, { message: fx.trickMessage(trick) });
      const mine = generation;
      holding = {};
      holding.handle = fx.schedule(() => {
        if (mine !== generation) return;
        holding = null;
        settle({ view, events, meta });
        pump();
      }, fx.holdMs(events));
      return;
    }
    settle({ view, events, meta });
  }

  /** Everything after the trick: the hand ending, the match ending, or play on. */
  function settle({ view, events, meta }) {
    const ended = events.find((e) => e.type === 'roundOver');
    if (view.gameOver) {
      // The hand that ended the match, as it ended, under the results.
      fx.show(meta.poses?.final || view, {});
      if (!resultsUp) {
        resultsUp = true;
        fx.showResults(view);
      }
      return;
    }
    if (ended && meta.beat) {
      fx.show(meta.poses?.final || view, {});
      betweenHands = true;
      fx.openSummary({ view, event: ended, ready: meta.beat.ready || [] });
      return;
    }
    // A hand that ended with nobody holding it open (the host is not looking at
    // this table) deals straight on, as the host's own table does.
    fx.show(view, { dealing: !!ended });
  }

  /** Forget everything — the guest left, or the table closed. */
  function reset() {
    generation += 1;
    holding?.handle?.cancel?.();
    holding = null;
    queue.length = 0;
    if (betweenHands) fx.closeSummary();
    if (resultsUp) fx.hideResults();
    betweenHands = false;
    resultsUp = false;
  }

  return {
    receive,
    reset,
    betweenHands: () => betweenHands,
    resultsUp: () => resultsUp,
  };
}
