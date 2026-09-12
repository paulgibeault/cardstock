// HOW LONG THE TABLE WAITS BETWEEN HANDS — the player's own answer.
//
// The round summary has always been a door with one key: `dismissRoundSummary`
// in src/ui/table.js deals the next hand and re-arms the bots, and nothing but
// a tap on "Deal round N" ever turned it. That is right for a player reading a
// four-seat score sheet and wrong for a player who has read it, knows the
// score, and wants the next hand. Round-6 playtest, item on #150: "some people
// want that pause; many want the next hand to just come."
//
// A DIAL WITH NAMED RUNGS AND NO NUMBER BOX. `botDelayMs` sat next door in
// SETTINGS_DEFAULTS as a millisecond count with no UI at all, and the reason it
// had never grown one is that "how many milliseconds should a card take" is not
// a question anybody has an answer to. Four rungs a player can feel the
// difference between is a question they do: wait for me, give me a breath, get
// on with it, don't stop.
//
// THAT ARGUMENT OUTLIVED THIS FILE, and it is why the sentence above is in the
// past tense: src/ui/speed.js (#175) gave the millisecond count next door the
// same four-rung treatment rather than leaving the one setting that decides how
// fast a card crosses the felt reachable only by hand-editing a save.
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
//
// ONE DIAL, TWO BEATS (issue #176). The same rung now also says how long a
// COMPLETED TRICK stays whole on the felt, and it is the same dial rather than a
// second one on purpose: four hand rungs times four trick rungs is sixteen
// combinations and most of them are incoherent — Instant hands with Relaxed
// tricks is not a preference anybody holds. What a rung means is "how much of
// this game do I want to watch", and that answer is one answer.
//
// THE SHIPPED RUNG IS `manual`, AND IT WAS `quick` UNTIL 2026-09-11. What was
// believed: the round-6 reading was one-directional — "nobody asked for a
// longer wait and several people asked for none" — and #176 wrote that down as
// a decision a flip would need NEW EVIDENCE to reverse, not symmetry with the
// trick beat. What changed it: Paul played the merged build, with the trick tap
// in it, and read round 6 back the other way round. What those players were
// asking for was a way OUT of a wait they could not end; the tap is that way
// out. A clock that deals over you is a different thing, and with a tap on both
// beats it is no longer the price of not being stuck. What is believed now: the
// table should not move until a person moves it. src/arcade/storage.js's `pace`
// carries the argument in full, because that is where the value on disk lives.
//
// WHAT THAT COSTS, SAID PLAINLY, because it is one word here and three beats on
// the felt: `manual`'s `trickReadScale` and `stepScale` are null as well as its
// `autoMs`, so a game at the defaults now holds EVERY COMPLETED TRICK until a
// tap, EVERY COUNT OF A SHOW until a tap, and every score sheet — thirteen taps
// a hand plus one at a trick-taking pack, and four at a cribbage hand, where the
// shipped table used to run itself end to end. That is the single biggest
// behaviour change in #176 and #181 and it is intended. What keeps it a beat
// rather than a freeze is that every one of those waits ends on a tap anywhere
// on the felt or on Enter/Space, and that the felt SAYS so at exactly the rungs
// where nothing else will: src/ui/table.js's `statusTextFor` reads "<seat>'s
// trick. Tap to go on." and "Round over. Tap to go on." whenever the beat has no
// clock on it, and the same sentence goes to #log. A shared table is the one
// place those gates are closed for you (src/ui/roundBeat.js's
// SHARED_TRICK_HOLD_MS and SHARED_SHOW_STEP_MS).

/**
 * `autoMs` is how long the summary stays up before it deals itself, and `null`
 * is the rung that never does. `stepScale` multiplies one show step
 * (src/ui/roundBeat.js's SHOW_STEP_MS) — cribbage's count is the one reveal a
 * pace preference has to stretch with, because "fifteen two, fifteen four, and
 * a pair is six" is the part of a hand that is read rather than watched — and
 * `null` there is the same word as `autoMs`'s: not a slower count but no clock
 * on it at all, one count per tap (#181).
 *
 * `instant` is its own flag rather than `autoMs === 0`, because it means
 * something arithmetically different: not "hold the summary for no time" but
 * "there is no transition" — no hold on the ending, no show steps, no sheet.
 * The result goes to #log as one line and the deal begins.
 *
 * `trickReadScale` is the same preference ONE MOVE SMALLER (issue #176). It
 * multiplies the time a completed trick stays whole on the felt once the fourth
 * card has landed (src/ui/roundBeat.js's READ_AFTER_LANDING_MS) — the READ time
 * and only that. The other half of the trick hold is a floor measured against
 * the card flight, it exists so the fourth card has ARRIVED before the winner
 * gathers, and no rung touches it: that is not a preference anybody holds.
 *
 * Two of its values are not multiplications. `null` is the rung that waits for
 * you, exactly as `autoMs` is between hands: the four cards stay whole until the
 * player taps the felt or presses a key. `0` keeps no reading time AND no floor
 * — the card still has to land, so the hold is the flight and nothing more.
 * `stepScale` now says the same two things with the same two values, so the
 * three terms read alike at every rung: a number is a duration, a null is a
 * person, and a zero is nothing to read.
 *
 * WHY THIS IS A SCALE ON THE READ AND NOT A DURATION PER RUNG: `quick` is the
 * rung that reproduces the hold this repo has always had, and "that rung's
 * trick hold is exactly the number it has always been" is then a structural
 * fact (scale 1) rather than a number kept in step by hand in two files. That
 * sentence used to read "the DEFAULT trick hold", because `quick` was also the
 * shipped rung when this was written; it no longer is (see the header), and the
 * arithmetic is untouched by that. Scale 1 is a statement about a rung, not
 * about which rung ships.
 */
export const PACE_LEVELS = Object.freeze([
  Object.freeze({
    id: 'manual',
    label: 'Manual',
    autoMs: null,
    // AND THE COUNT WAITS TOO (#181). This was 1 — the show ran at the shipped
    // step while the two beats on either side of it waited for a person, so
    // "fifteen two, fifteen four, and a pair is six" came and went in a second
    // and a half, three times, at the rung whose whole meaning is that nothing
    // moves without you. Null is the same word `autoMs` uses one line up: the
    // count stays on the felt until the player dismisses it, and a cribbage hand
    // ends in four deliberate inputs — pone, the dealer, the crib, the sheet.
    stepScale: null,
    // A BEHAVIOUR CHANGE FOR EVERY PLAYER, NOT ONLY THE ONES ALREADY STANDING
    // HERE, because this is the shipped rung now. Manual used to mean "the
    // SHEET waits for you" and a completed trick still swept itself after
    // ~920ms. It now means the trick waits too, indefinitely, until a tap or a
    // key ends it — and a player who has never opened the settings gets that
    // from their first trick. Safe because the tap exists before any hold is
    // armed (src/ui/table.js's runTrickReveal wires it first), because the
    // status bar and #log both promise it at exactly the holds with no clock on
    // them, and because a shared table caps this rung like every other one —
    // see SHARED_TRICK_HOLD_MS.
    trickReadScale: null,
    instant: false,
    description: 'The table waits for you: a finished trick, each count of a show and the score sheet all stay until you say so.',
  }),
  Object.freeze({
    id: 'relaxed',
    label: 'Relaxed',
    autoMs: 6000,
    stepScale: 1.4,
    // TWICE THE READING TIME, AND DELIBERATELY NOWHERE NEAR `autoMs`. 6000ms is
    // what a four-seat SCORE SHEET is worth; a trick is four cards and the
    // question "who took that?", and thirteen of those at six seconds each is 78
    // seconds per hand of pure waiting (#176 records this as decided against).
    // Doubling 500ms to a full second is the step from a glance to a read — long
    // enough to look from the card that was led to the card that beat it and say
    // so out loud — and costs about six and a half seconds over a whole hand.
    trickReadScale: 2,
    instant: false,
    description: 'A long look at the score, a longer look at each trick, and the counting slows to match.',
  }),
  Object.freeze({
    id: 'quick',
    label: 'Quick',
    autoMs: 2500,
    stepScale: 1,
    // TODAY'S NUMBER, EXACTLY. #176's acceptance criterion was that the rung
    // this repo ships must not make a thirteen-trick hand one millisecond
    // longer than it already is, and this was that rung when the criterion was
    // written. It is one tap off the default now, and the number is still
    // pinned: this is the rung a player reaches for when they want the table to
    // run itself, and "runs itself at the speed it always did" is the whole of
    // what they are asking for.
    trickReadScale: 1,
    instant: false,
    description: 'Long enough to read what happened, then the next trick — and the next hand — comes.',
  }),
  Object.freeze({
    id: 'instant',
    label: 'Instant',
    autoMs: 0,
    stepScale: 0,
    // NO READING TIME AND NO FLOOR — but still not nothing. See trickRevealPlan:
    // the hold becomes the flight, because the one thing this rung may not do is
    // start the gather while the fourth card is still in the air.
    trickReadScale: 0,
    instant: true,
    description: 'No sheet between hands, and no pause on a trick beyond the card arriving.',
  }),
]);

/**
 * The shipped rung. See src/arcade/storage.js for why it is this one — it was
 * `quick` until 2026-09-11, and that file carries both the old argument and
 * what overturned it.
 */
export const DEFAULT_PACE = 'manual';

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
 * shortens anything, and it is the step out of the rung that never deals at
 * all: from a rung with no clock on it there is no more time to be handed out,
 * so any wrap a cycle can offer is a reduction.
 *
 * AND THAT WRAP IS NOW THE FIRST TAP ANYBODY MAKES, because the shipped rung is
 * Manual. That reads backwards against the paragraph above and it is not the
 * bug #174 fixed. A player tapping this control on a sheet that was never going
 * to close by itself is not asking for more time; they are asking the table to
 * start moving. Quick is the most conservative thing "start moving" can mean —
 * the shortest wait that STILL SHOWS A SHEET — and the rung that would delete
 * this control is still the one rung the cycle cannot reach.
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
