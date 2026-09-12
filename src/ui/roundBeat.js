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
// questions about numbers, and a number is a thing a test can ask for. The same
// goes for the trick hold the rung now governs (#176) and for the ceiling a
// shared table puts on it: "does this table ever wait forever with three other
// people at it" has to be answerable without a browser.
//
// AND A SCHEDULE IS STILL A SCHEDULE WHEN IT HAS NO CLOCK IN IT (#181). At the
// rung that waits, the show is a SEQUENCE — one count, then a person, then the
// next — so the `at` a step runs on is null and the arithmetic that used to
// order the sheet against it has nothing to subtract. What does not change is
// that the ordering is this module's to state: `nextShowBeat` at the foot of the
// file is the same question asked in the units that are left.

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
 *
 * AND IT IS THE HALF NO RUNG SCALES (#176). A pace preference is an answer to
 * "how long do I want to look at this"; the floor is an answer to "has it
 * arrived yet", which is a fact about the animation rather than a taste. The
 * rung moves READ_AFTER_LANDING_MS and leaves this alone — the one exception
 * being `instant`, which asks for no looking time at all and therefore has
 * nothing for a floor to hold up.
 */
export const MIN_TRICK_REVEAL_MS = 700;

/**
 * How long all four cards stay whole once the last of them has landed, at the
 * SHIPPED rung. Every other rung is this number times its own `trickReadScale`
 * (src/ui/pace.js, #176) — the floor above is not scaled by anything.
 */
export const READ_AFTER_LANDING_MS = 500;

/**
 * THE LONGEST A SHARED TABLE WILL HOLD A TRICK, whatever the rung says.
 *
 * The trick hold is purely local and that is what makes a per-device pause safe
 * at all: `takeTrickPose` poses a throwaway fork the engine has never heard of,
 * and the live state has already advanced past it. Nobody else is waiting.
 *
 * An INDEFINITE hold is where that stops being true. Three other players keep
 * playing into a device whose local queue is gated on a tap that may never come,
 * and a backlog has to drain somewhere — so Manual's open gate becomes a beat
 * when the table is shared, and every other rung is capped by the same line
 * rather than by a branch that only Manual takes.
 *
 * TWO SECONDS, and the number is chosen so that it takes NOTHING away from any
 * rung that names a duration: the longest of those is Relaxed at the 700ms
 * flight ceiling, which is 1700ms. So the cap only ever converts the one
 * indefinite rung, and it never cuts into the flight-measured floor. It is also
 * about as long as the slowest bot persona already sits thinking before a card
 * (src/players/roster.js, `tempoMs` up to 1900) — one move's worth of lag is a
 * wait this table's players are already used to absorbing.
 */
export const SHARED_TRICK_HOLD_MS = 2000;

/**
 * How long the felt holds the four cards of a completed trick, or null when
 * this move did not complete one.
 *
 * `holdMs` IS NULL FOR A HOLD WITH NO END — the Manual rung, where the four
 * cards stay until the player taps the felt or presses a key (src/ui/table.js's
 * runTrickReveal arms no timer at all for it). A plan is still returned: there
 * IS a beat, it simply has no clock on it.
 *
 * `posed` is false when the felt could not reconstruct that position — the
 * multiplayer path, where the host applied the move before this device heard
 * about it and there is no pre-move copy to advance (the same degradation
 * `narrate` describes below). There is nothing to hold then, so nothing is
 * held: the gather happens as it always did.
 *
 * `reads` IS WHETHER THE HOLD CONTAINS READING TIME (#180) — true at every rung
 * whose hold is more than the card arriving, and false at Instant, whose hold is
 * the flight alone. src/ui/table.js announces the winner at the TOP of a hold
 * that reads and with the gather at the one that does not.
 *
 * `shared` is a DIFFERENT multiplayer question and the one `posed` does not
 * cover: a LOCAL move at a shared table poses like any other, so it is the case
 * SHARED_TRICK_HOLD_MS exists for.
 *
 * @param pace the player's rung (src/ui/pace.js). It scales the reading time on
 *             top of the floor, and at the two ends it replaces the arithmetic:
 *             Manual waits for a person, Instant waits only for the card.
 */
export function trickRevealPlan(events, {
  flightMs = 0, posed = true, pace = DEFAULT_PACE, shared = false,
} = {}) {
  if (!posed) return null;
  const trick = (events || []).find((e) => e.type === 'trickWon');
  if (!trick) return null;

  const read = paceLevel(pace).trickReadScale;
  // THE FLOOR GOES WITH THE READING TIME, and Instant is the rung that has
  // neither. A hold of exactly the flight is still a hold: `runTrickReveal`
  // renders the posed position and flies the fourth card onto it, so this is
  // the card ARRIVING and nothing after it.
  //
  // WHY NOT SIMPLY RETURN NULL AT THIS RUNG, which would be less code: no plan
  // means no pose, and `afterMove` then renders the live state and runs
  // `celebrateTrick` on the same frame — the gather starts at 140ms while the
  // played card is still 280ms from landing. That is the pre-#123 felt, where
  // the deciding card was never once a rendered card. Instant is allowed to
  // skip the reading; it is not allowed to sweep a card out of the air.
  const natural = read == null ? null
    : read === 0 ? flightMs
      : Math.max(MIN_TRICK_REVEAL_MS, flightMs + Math.round(READ_AFTER_LANDING_MS * read));

  // IS THERE A BEAT TO READ THE TRICK ON, or only a card arriving? (#180)
  //
  // The table says who won at the TOP of a hold rather than after it, because
  // the whole point of the hold is that the player is looking at four whole
  // cards and wants to know what just happened to them. Instant is the one rung
  // where that is wrong: its hold is the flight and nothing else, so an
  // announcement at the top would name the winner — and sound the trick cue —
  // while the deciding card is still in the air. At that rung the announcement
  // stays where it has always been, with the gather.
  const reads = read == null || read > 0;

  if (!shared) return { trick, holdMs: natural, reads };
  return {
    trick,
    reads,
    holdMs: natural == null ? SHARED_TRICK_HOLD_MS : Math.min(SHARED_TRICK_HOLD_MS, natural),
  };
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
 * THE LONGEST A SHARED TABLE WILL LEAVE ONE COUNT UP, whatever the rung says.
 *
 * SHARED_TRICK_HOLD_MS's argument, one beat later and for the same reason. A
 * REMOTE move runs no steps at all — `narrate` is false on that path and the
 * show degrades to the plain hold — but a LOCAL move at a shared table narrates
 * like any other, and a count with no clock on it gates this device's queue on a
 * tap that may never come while three other players keep playing.
 *
 * IT IS THE SLOWEST RUNG'S OWN STEP, not a fourth duration nobody chose. The cap
 * converts exactly one rung, the one that waits for a person, so what it should
 * convert that rung to is the most generous thing any rung already asks for:
 * Relaxed's 1.4 × SHOW_STEP_MS. Every rung that names a step is untouched, which
 * is not a property of the number but of where it is applied — see roundBeatPlan,
 * where the cap replaces a null and is never a `min` over a rung's own answer.
 */
export const SHARED_SHOW_STEP_MS = 2100;

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
 *                 removes the beat entirely. At the rung that waits it takes the
 *                 clock off the show altogether (#181).
 * @param shared   is anybody else at this table? The one thing it changes is
 *                 that a count cannot wait forever — see SHARED_SHOW_STEP_MS. It
 *                 is a DIFFERENT question from `narrate`, which is about a
 *                 REMOTE move having no position to pose; this is about a local
 *                 move at a table other people are playing at.
 * @returns null when this move did not end a round with the match still going;
 *          otherwise { roundOver, gathered, holdMs, steps, summaryAt, pace,
 *          stepMs, autoAdvanceMs, instant } where every step carries the `at`
 *          it runs on — or `null` for a step that runs on a person instead —
 *          and `summaryAt` is after all of them either by arithmetic or, at the
 *          rung with no arithmetic left, by `nextShowBeat` below.
 */
export function roundBeatPlan(events, {
  flightMs = 0, stepMs = SHOW_STEP_MS, narrate = true, pace = DEFAULT_PACE, shared = false,
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
  //
  // AND `null` IS THE RUNG THAT DOES NOT STRETCH THE COUNT BUT STOPS IT (#181).
  // The third term to say "wait for me" with an absence rather than a number,
  // after `autoMs` and `trickReadScale`, and it is read the same way everywhere
  // it lands below: no duration, because at that rung a count does not have one.
  // A shared table is where the gate is closed for you, and the cap REPLACES the
  // null rather than being a ceiling over every rung — a `min` here would re-pace
  // Relaxed's count for everybody at the table, which is not what it is for.
  const scaled = level.stepScale == null
    ? (shared ? SHARED_SHOW_STEP_MS : null)
    : Math.round(stepMs * level.stepScale);

  // THE SHOW IS A TIMELINE OR A SEQUENCE, AND `at` IS WHICH (#181). A step with
  // a number on it runs on a clock, that many milliseconds after the move; a
  // step with `null` runs when the step before it is dismissed — the same word
  // `holdMs` uses for a hold that ends when a person ends it.
  //
  // THE FIRST STEP KEEPS ITS NUMBER AT EITHER KIND OF RUNG, and that is not an
  // inconsistency in the idiom: there is nothing on the felt to dismiss until a
  // count is on it, so the first one opens on the hold and the taps begin after
  // it. Cribbage's show is then exactly the three taps it was asked for — pone,
  // the dealer, the crib — with the sheet's own as the fourth.
  const steps = (narrate && !level.instant ? showSteps(events) : []).map((step, i) => ({
    ...step,
    at: i === 0 ? holdMs : (scaled == null ? null : holdMs + i * scaled),
  }));
  // THE SUMMARY IS ALWAYS LAST, and this is the line that says so. It is the
  // acknowledgement — its Continue is what deals the next hand — so anything it
  // covers has to have been readable first.
  //
  // NULL IS THAT SAME SENTENCE WITH THE CLOCK TAKEN OUT OF IT. The sheet opens
  // when the last count is dismissed, which is after every count by construction
  // rather than by arithmetic — `nextShowBeat` below is where that becomes a
  // question a test can still ask. A round with no steps to wait on has nothing
  // to sequence, so its sheet opens on the hold at every rung, exactly as it
  // does for every pack that counts no show at all.
  const summaryAt = !steps.length ? holdMs
    : (scaled == null ? null : steps[steps.length - 1].at + scaled);

  return {
    roundOver,
    gathered,
    holdMs,
    steps,
    summaryAt,
    pace: level.id,
    // How long one count stands, or null for the rung where a count stands
    // until it is dismissed. The renderer reads THIS to know which kind of show
    // it is running, for the same reason it reads `holdMs == null` for the trick.
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

/**
 * What the show puts up after `dismissed` counts, or null for the round summary.
 *
 * THE SEQUENCE'S OWN ARITHMETIC, for the rung that has no other kind (#181).
 * While a show runs on a clock, "does the summary open after everything it is
 * meant to follow" is a comparison of two numbers and that is how this module
 * has always answered it. A show that waits for a person has no numbers left to
 * compare — every `at` after the first is null and so is `summaryAt` — and the
 * question does not stop mattering just because the arithmetic went away. So it
 * becomes a function, and the renderer WALKS THIS ONE (src/ui/table.js's
 * runShowSequence) rather than keeping its own cursor beside it: a rule with a
 * test on it and nothing reading it is the same as no rule.
 *
 * COUNTING DISMISSALS RATHER THAN THE STEP ON SCREEN, because that is what the
 * renderer actually knows at the moment it asks: it has just been tapped, and
 * the question is what to put up next. Nothing but the last count can be
 * followed by the sheet, which is the whole of the ordering.
 */
export function nextShowBeat(plan, dismissed) {
  const steps = plan?.steps || [];
  return dismissed >= 0 && dismissed < steps.length ? steps[dismissed] : null;
}
