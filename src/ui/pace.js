// HOW LONG THE TABLE WAITS BETWEEN HANDS — the player's own answer.
//
// The round summary has always been a door with one key: `dismissRoundSummary`
// in src/ui/table.js deals the next hand and re-arms the bots, and nothing but
// a tap on "Deal round N" ever turned it. That is right for a player reading a
// four-seat score sheet and wrong for a player who has read it, knows the
// score, and wants the next hand. Round-6 playtest, item on #150: "some people
// want that pause; many want the next hand to just come."
//
// A DIAL WITH NAMED RUNGS AND NO NUMBER BOX. `botDelayMs` sits next door in
// SETTINGS_DEFAULTS as a millisecond count with no UI at all, and the reason it
// never grew one is that "how many milliseconds should a card take" is not a
// question anybody has an answer to. Four rungs a player can feel the
// difference between is a question they do: wait for me, give me a breath, get
// on with it, don't stop.
//
// A DATA MODULE, for the reason src/ui/difficulty.js is one: the two things
// that render this list (src/ui/newGame.js, src/ui/panels.js) both reach for
// `document` at import time, so no Node test can load them and ask what they
// offer. The list is the part worth pinning — add a rung and
// tests/pace.test.js fails until the sheet can offer it and the arithmetic
// knows what it means, rather than the rung existing with no way to pick it.
//
// ORDERED LEAST AUTOMATIC TO MOST, which is the whole of how the segmented row
// explains itself: the left end never moves without you, the right end never
// waits.

/**
 * `autoMs` is how long the summary stays up before it deals itself, and `null`
 * is the rung that never does. `stepScale` multiplies one show step
 * (src/ui/roundBeat.js's SHOW_STEP_MS) — cribbage's count is the one reveal a
 * pace preference has to stretch with, because "fifteen two, fifteen four, and
 * a pair is six" is the part of a hand that is read rather than watched.
 *
 * `instant` is its own flag rather than `autoMs === 0`, because it means
 * something arithmetically different: not "hold the summary for no time" but
 * "there is no transition" — no hold on the ending, no show steps, no sheet.
 * The result goes to #log as one line and the deal begins.
 */
export const PACE_LEVELS = Object.freeze([
  Object.freeze({
    id: 'manual',
    label: 'Manual',
    autoMs: null,
    stepScale: 1,
    instant: false,
    description: 'The score sheet waits for you. Nothing is dealt until you say so.',
  }),
  Object.freeze({
    id: 'relaxed',
    label: 'Relaxed',
    autoMs: 6000,
    stepScale: 1.4,
    instant: false,
    description: 'A long look at the score, and the counting slows down to match.',
  }),
  Object.freeze({
    id: 'quick',
    label: 'Quick',
    autoMs: 2500,
    stepScale: 1,
    instant: false,
    description: 'Long enough to read what happened, then the next hand comes.',
  }),
  Object.freeze({
    id: 'instant',
    label: 'Instant',
    autoMs: 0,
    stepScale: 0,
    instant: true,
    description: 'No sheet between hands — the result goes to the log and the deal starts.',
  }),
]);

/** The shipped rung. See src/arcade/storage.js for why it is this one. */
export const DEFAULT_PACE = 'quick';

/**
 * The rung `id` names, or the default one.
 *
 * Deliberately tolerant, exactly like `skillLevel`: this reads a string out of
 * storage that an older build, a rolled-back rung or a hand-edited save can
 * make nonsense, and the consequence of falling back is visible on the very
 * next hand.
 */
export function paceLevel(id) {
  return PACE_LEVELS.find((level) => level.id === id)
    || PACE_LEVELS.find((level) => level.id === DEFAULT_PACE);
}

/**
 * The rungs the summary's own control may offer, in the order it offers them.
 *
 * TWO THINGS ABOUT THIS LIST ARE DELIBERATE, and both of them are #174.
 *
 * IT LEAVES OUT `instant`, because a control that offers it deletes itself. The
 * summary is the only surface that carries this control mid-match, `instant` is
 * the rung that shows no summary, and the tap that picks it is therefore the
 * last tap that can ever reach it: `runRoundBeat` takes its `dismissRoundSummary`
 * early return from then on and no sheet opens again for the rest of the match.
 * The rung itself is not going anywhere — src/ui/newGame.js still offers all
 * four, and between matches there is no sheet to delete.
 *
 * IT RUNS THE LIST BACKWARDS, from most automatic to least, which is the one
 * place in this module that does not read left-to-right off the segmented row.
 * The row is a picture of the four rungs; this is a single button, and a button
 * only knows the one thing the player just did with it. That thing is a tap
 * made BECAUSE they are not ready to deal yet — so every tap has to hand them
 * MORE time than they had, never less, and the walk goes Quick → Relaxed →
 * Manual → Quick. Wrapping from Manual back to Quick is the only step that
 * shortens anything, and it is the step out of the rung that never deals at all.
 */
const SUMMARY_PACE_CYCLE = Object.freeze(
  PACE_LEVELS.filter((level) => !level.instant).map((level) => level.id).reverse(),
);

/**
 * The rung a tap on the summary's own control moves to, wrapping round.
 *
 * Named for the surface rather than for the list because the surface is why a
 * rung is missing: at the call site (src/ui/table.js's `cyclePace`) "summary"
 * is the whole explanation for why this is not simply the next entry in
 * `PACE_LEVELS`.
 */
export function nextSummaryPace(id) {
  // An id that resolves to `instant` is not on the cycle, and -1 + 1 lands on
  // the first entry — Quick, which is the right answer for the same reason the
  // walk runs backwards: Quick is the shortest wait that still shows a sheet,
  // and any wait at all is more time than Instant's none. It costs nothing
  // today, because a player at `instant` is never shown a sheet to tap.
  const i = SUMMARY_PACE_CYCLE.indexOf(paceLevel(id).id);
  return SUMMARY_PACE_CYCLE[(i + 1) % SUMMARY_PACE_CYCLE.length];
}
