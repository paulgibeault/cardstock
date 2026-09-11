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

/** The rung a tap on the summary's own control moves to, wrapping round. */
export function nextPace(id) {
  const i = PACE_LEVELS.indexOf(paceLevel(id));
  return PACE_LEVELS[(i + 1) % PACE_LEVELS.length].id;
}
