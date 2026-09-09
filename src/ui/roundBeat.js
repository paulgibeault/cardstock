// WHEN THE FELT SHOWS A ROUND ENDING — the schedule, as arithmetic.
//
// The engine deals the next round INSIDE the move that ends the old one
// (src/engine/movePipeline.js's maybeFinishRound: score, roundNumber += 1,
// clearAllZones, setup, all before applyMove returns). That is correct and it
// is not negotiable — the redeal consumes seeded RNG and a replay has to cross
// the boundary at exactly the same move. What was wrong was the felt taking
// that as its cue to REPAINT: the round summary opened over a hand that had
// already been dealt, an advanced turn indicator, and in cribbage a show that
// had come and gone in a frame and a half.
//
// So the fix is a schedule, and a schedule is arithmetic over an event window.
// This module is that arithmetic and nothing else — no DOM, no timers, no
// state — so the one thing that was impossible to check by reading (does the
// summary open AFTER everything it is meant to follow?) is a function with a
// test. src/ui/table.js owns the timers that run the plan.
//
// THE PLAN IS ONLY EVER FOR A ROUND THAT ENDED WITH THE MATCH STILL ON. A
// `roundOver` carrying `over: true` is the match ending, which `offerFinalLook`
// already holds correctly (issue #120 is explicit that it is reused, not
// changed), and there is no redeal underneath it to hide.

/** The floor on the hold, and the number `offerFinalLook` has always used. */
export const MIN_HOLD_MS = 700;

/**
 * The floor on the hold when a trick closed the round.
 *
 * `celebrateTrick` flies the gather 140ms in and staggers a copy every 70ms for
 * up to four cards, each in the air 320ms — so the last of them lands around
 * 670ms after the move. The summary used to open at 900ms flat, which cleared
 * that at the default flight and did not at a slow one.
 */
export const MIN_TRICK_HOLD_MS = 900;

/**
 * How long one step of a show stays up before the next replaces it.
 *
 * "Fifteen two, fifteen four, and a pair is six" is a sentence a person says
 * out loud at a table, and this is roughly how long saying it takes. Long
 * enough to read a number and look at the cards it came from; short enough that
 * three of them is not a cutscene.
 */
export const SHOW_STEP_MS = 1500;

/**
 * The reveals a round ending owes, in the order the rules put them in.
 *
 * Cribbage is the only pack that emits `showScored` today and the order is the
 * game: pone counts, then the dealer, then the crib, and a pone sitting on 118
 * wins before the dealer ever turns a card over. So this preserves EMISSION
 * ORDER rather than sorting by seat — the template emitted them in the order
 * they are scored (src/templates/cribbage.js, `theShow`) and that order is the
 * rule.
 *
 * `cards` is present on a LOCAL table and absent on a remote one: the wire form
 * of the event carries counts instead of ids, deliberately (cribbage.js's
 * `partsOf`). A step with no cards still has a seat, a number and a sentence,
 * which is the whole of what the beat needs — the spotlight is the part that
 * degrades.
 */
export function showSteps(events) {
  const out = [];
  for (const ev of events || []) {
    if (ev.type !== 'showScored') continue;
    out.push({
      seat: ev.seat,
      isCrib: !!ev.isCrib,
      points: ev.points ?? 0,
      cards: Array.isArray(ev.cards) ? ev.cards.slice() : [],
    });
  }
  return out;
}

/**
 * The whole schedule for one round ending, in milliseconds from the move.
 *
 * @param events   the move's event window (state.events)
 * @param flightMs how long a card is in the air right now (src/ui/flight.js) —
 *                 the hold is measured against it for the same reason
 *                 `offerFinalLook`'s is: the beat exists so the last card has
 *                 LANDED before anything asks to be read, and the flight scales
 *                 with the player's own pace setting.
 * @param narrate  false when the felt cannot reconstruct the ending position —
 *                 the multiplayer path, where the move was applied by the host
 *                 module before this device heard about it and there is no
 *                 pre-move snapshot to pose. The hold still applies; the
 *                 step-by-step reveal, which has to repaint the felt, does not.
 * @returns null when this move did not end a round with the match still going;
 *          otherwise { roundOver, gathered, holdMs, steps, summaryAt } where
 *          every step carries the `at` it runs on and `summaryAt` is strictly
 *          after all of them.
 */
export function roundBeatPlan(events, { flightMs = 0, stepMs = SHOW_STEP_MS, narrate = true } = {}) {
  const roundOver = (events || []).find((e) => e.type === 'roundOver' && !e.over);
  if (!roundOver) return null;

  const gathered = (events || []).some((e) => e.type === 'trickWon');
  const holdMs = gathered
    ? Math.max(MIN_TRICK_HOLD_MS, flightMs + 640)
    : Math.max(MIN_HOLD_MS, flightMs + 280);

  const steps = (narrate ? showSteps(events) : [])
    .map((step, i) => ({ ...step, at: holdMs + i * stepMs }));
  // THE SUMMARY IS ALWAYS LAST, and this is the line that says so. It is the
  // acknowledgement — its Continue is what deals the next hand — so anything it
  // covers has to have been readable first.
  const summaryAt = steps.length ? steps[steps.length - 1].at + stepMs : holdMs;

  return { roundOver, gathered, holdMs, steps, summaryAt };
}
