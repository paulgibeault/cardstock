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
//
// THE PACE PREFERENCE IS A TERM IN THIS ARITHMETIC (issue #150), and it is here
// rather than in the renderer for the reason everything else is: "does Instant
// actually skip the sheet, and does Relaxed actually stretch the count" are
// questions about numbers, and a number is a thing a test can ask for.

import { paceLevel, DEFAULT_PACE } from './pace.js';

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
 * The floor on how long a completed trick stays WHOLE on the felt, before the
 * winner gathers it (issue #123).
 *
 * Long enough to look from the card that was led to the card that beat it,
 * which is two saccades and a decision; short enough that thirteen of them in a
 * hand is not thirteen pauses.
 *
 * MEASURED FROM WHEN THE FOURTH CARD LANDS, not from the move, and that is the
 * whole reason `READ_AFTER_LANDING_MS` is a separate term rather than a bigger
 * floor. The card is still in the air when `applyMove` returns — the flight is
 * the player's own pace setting (src/ui/flight.js) — so a flat hold spends
 * itself watching the card arrive: at the default 420ms flight the first
 * measurement of this fix showed four cards on the felt for 283ms, most of the
 * hold having gone on the flight.
 */
export const MIN_TRICK_REVEAL_MS = 700;

/** How long all four cards stay whole once the last of them has landed. */
export const READ_AFTER_LANDING_MS = 500;

/**
 * How long the felt holds the four cards of a completed trick, or null when
 * this move did not complete one.
 *
 * `posed` is false when the felt could not reconstruct that position — the
 * multiplayer path, where the host applied the move before this device heard
 * about it and there is no pre-move copy to advance (the same degradation
 * `narrate` describes below). There is nothing to hold then, so nothing is
 * held: the gather happens as it always did.
 */
export function trickRevealPlan(events, { flightMs = 0, posed = true } = {}) {
  if (!posed) return null;
  const trick = (events || []).find((e) => e.type === 'trickWon');
  if (!trick) return null;
  return { trick, holdMs: Math.max(MIN_TRICK_REVEAL_MS, flightMs + READ_AFTER_LANDING_MS) };
}

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
 *
 * `parts` is the WORDS half of the same payload — fifteen, a pair, his nobs —
 * and it survives the wire where the card ids do not. It is carried here for
 * one reason: the sentence for a step is rebuilt from the step
 * (src/ui/table.js's `playShowStep`), so anything the template's narration
 * reads has to be on it. Dropping it is how "his nobs" stayed invisible while
 * being in the pack's own tagline (#124, item 41).
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
      parts: Array.isArray(ev.parts) ? ev.parts.slice() : [],
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
 * @param pace     the player's rung (src/ui/pace.js). It stretches the show and
 *                 decides whether the sheet deals itself — and at `instant` it
 *                 removes the beat entirely.
 * @returns null when this move did not end a round with the match still going;
 *          otherwise { roundOver, gathered, holdMs, steps, summaryAt, pace,
 *          stepMs, autoAdvanceMs, instant } where every step carries the `at`
 *          it runs on and `summaryAt` is strictly after all of them.
 */
export function roundBeatPlan(events, {
  flightMs = 0, stepMs = SHOW_STEP_MS, narrate = true, pace = DEFAULT_PACE,
} = {}) {
  const roundOver = (events || []).find((e) => e.type === 'roundOver' && !e.over);
  if (!roundOver) return null;

  const level = paceLevel(pace);
  const gathered = (events || []).some((e) => e.type === 'trickWon');

  // THE HOLD IS NOT SCALED BY THE PACE, and that is deliberate. It is measured
  // against the FLIGHT — it exists so the last card has landed before anything
  // asks to be read — and the flight is already the player's own speed setting
  // (flightDurationMs). A pace rung that shortened it would be a preference for
  // reading a card that is still in the air. The pace is about the pause
  // BETWEEN hands, and `instant` is the one rung that says there is not one.
  const holdMs = level.instant ? 0 : (gathered
    ? Math.max(MIN_TRICK_HOLD_MS, flightMs + 640)
    : Math.max(MIN_HOLD_MS, flightMs + 280));

  // A show is the part of a round ending that is READ rather than watched, so
  // it is the part a pace rung stretches. `instant` scales it to nothing, which
  // drops the steps altogether — there is no such thing as a step you are given
  // no time to read.
  const scaled = Math.round(stepMs * level.stepScale);
  const steps = (narrate && !level.instant ? showSteps(events) : [])
    .map((step, i) => ({ ...step, at: holdMs + i * scaled }));
  // THE SUMMARY IS ALWAYS LAST, and this is the line that says so. It is the
  // acknowledgement — its Continue is what deals the next hand — so anything it
  // covers has to have been readable first.
  const summaryAt = steps.length ? steps[steps.length - 1].at + scaled : holdMs;

  return {
    roundOver,
    gathered,
    holdMs,
    steps,
    summaryAt,
    pace: level.id,
    stepMs: scaled,
    // How long the sheet stands before it deals itself, or null for the rung
    // that never does. The renderer arms one timer off this and nothing else,
    // so "Manual never advances" is this being null.
    autoAdvanceMs: level.autoMs,
    // No sheet at all: the result is a line in #log and the deal is the next
    // thing on the felt (src/ui/table.js's runRoundBeat).
    instant: level.instant,
  };
}
