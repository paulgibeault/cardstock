// A SEAT COUNTER DRAWN AS A PICTURE — the platform's track and pip renderers.
//
// WHY THIS EXISTS. A cribbage board is 121 holes and two pegs a side, and it is
// the thing a cribbage player looks at all game. It is not a card zone — no
// card is ever in it — so nothing on the felt could draw it, and the two ways
// to add it that suggest themselves are both the bug src/templates/CONTRACT.md
// exists to prevent: a `board` hook that only one template will ever implement,
// or a `pack.id === 'cribbage'` in the seat renderer.
//
// The third way is the one taken. `seatCounters` already asks a template "what
// is this seat's number, and what KIND of number is it"; a track is what some
// of those kinds look like when the number is a position on a road rather than
// a quantity of things. So the vocabulary of kinds that render as a track is
// the PLATFORM'S — a closed set, exactly like `INTERACTION_MODES` in
// src/ui/interaction.js — and which kind a seat's counter is remains the
// TEMPLATE'S. Nothing here knows the word cribbage, and a kind this build has
// never heard of falls back to the plain badge rather than throwing.
//
// The three numbers a track needs, beyond what every counter has:
//
//   value  where the front peg is now
//   from   where it was before the last score — the BACK peg, which is how a
//          cribbage board tells you at a glance how the last hand went
//   of     the length of the road
//
// BATTERY RULE (GAME_INTEGRATION §6d, cardstock#24): the pegs MOVE and they do
// not pulse. Their transition is a one-shot on `left`; there is no keyframe
// animation in the stylesheet for this component at all, so there is nothing
// for `--arcade-pulse-count` to have to cap.

/**
 * Counter kinds this build draws as a track. A template naming anything else —
 * or naming one of these without the numbers — gets the ordinary badge.
 */
export const COUNTER_TRACK_KINDS = Object.freeze(['peg']);

/** Where a peg sits, as a percentage of the road, clamped into it. */
function positionOf(n, of) {
  if (!Number.isFinite(n) || !Number.isFinite(of) || of <= 0) return 0;
  return Math.max(0, Math.min(100, (n / of) * 100));
}

/**
 * The track a counter describes, or null if it does not describe one.
 *
 * Pure, and separated from the DOM on purpose: src/ui/table.js touches
 * `document` at import time and therefore cannot be loaded by a Node test, so
 * a model that can be asserted without a browser is the only way the geometry
 * is ever checked (tests/counterTrack.test.js).
 */
export function counterTrack(counter) {
  if (!counter || !COUNTER_TRACK_KINDS.includes(counter.kind)) return null;
  const { value, from, of } = counter;
  if (!Number.isFinite(value) || !Number.isFinite(of) || of <= 0) return null;
  const back = Number.isFinite(from) ? from : 0;
  return {
    kind: counter.kind,
    value,
    // The back peg never overtakes the front one: a score that goes backwards
    // is not a thing in this genre, and drawing one would read as a bug.
    from: Math.min(back, value),
    of,
    frontPct: positionOf(value, of),
    backPct: positionOf(Math.min(back, value), of),
    // Both pegs on the same hole is the start of the game and the start of
    // every seat's first score; the stylesheet fans them apart rather than
    // stacking one invisibly behind the other.
    together: Math.min(back, value) === value,
  };
}

/**
 * The track as DOM, or null.
 *
 * `doc` is a parameter rather than the global so this module stays testable —
 * the same reason `counterTrack` above is pure. Everything that reaches an
 * inline style here is a number this file computed and clamped, never a value
 * from a manifest (§7b): a pack cannot put anything in `left`.
 */
export function renderCounterTrack(counter, doc = globalThis.document) {
  const track = counterTrack(counter);
  if (!track || !doc) return null;

  const wrap = doc.createElement('span');
  wrap.className = 'seat__track';
  wrap.dataset.track = track.kind;
  // ONE ACCESSIBLE NAME FOR THE WHOLE THING. The pegs are decoration — a screen
  // reader that announced "peg, peg, 78" would be worse than the number alone —
  // so the group carries the counter's own sentence and its parts carry none.
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', counter.aria || `${track.value} of ${track.of}`);

  const rail = doc.createElement('span');
  rail.className = 'seat__track-rail';
  rail.setAttribute('aria-hidden', 'true');
  wrap.appendChild(rail);

  // THE PEGS GO INSIDE THE RAIL, and that is the whole of issue #124's first
  // bug. `left` in percent is a percentage of the containing block, so a peg
  // parented to the WRAP was measured against the rail PLUS the printed number
  // beside it: 97.52% of an 88px wrap is x=86 when the rail ends at 57. At 0 the
  // two origins coincide, so it looked right for the first sixty holes of every
  // match and then the peg walked off the board and sat on top of its own score.
  // The rail is `position: relative` in the stylesheet, so parenting is all it
  // takes — the percentage now means what `counterTrack` computed it to mean.
  for (const [which, pct] of [['back', track.backPct], ['front', track.frontPct]]) {
    const peg = doc.createElement('span');
    peg.className = `seat__track-peg seat__track-peg--${which}`;
    peg.style.left = `${pct.toFixed(2)}%`;
    peg.setAttribute('aria-hidden', 'true');
    rail.appendChild(peg);
  }
  if (track.together) wrap.dataset.together = 'true';

  const value = doc.createElement('span');
  value.className = 'seat__track-value';
  value.textContent = counter.text;
  value.setAttribute('aria-hidden', 'true');
  wrap.appendChild(value);

  return wrap;
}

/* ------------------------------------------------------------------ *
 * A SEAT COUNTER DRAWN AS PIPS — a promise and how much of it is kept
 * ------------------------------------------------------------------ *
 *
 * The second shape in this file, and it is here for the same reason the track
 * is: `seatCounters` asks a template "what is this seat's number, and what KIND
 * of number is it", and some kinds are not a quantity at all. A bid is a
 * PROMISE and the tricks taken against it are how much of that promise is
 * already kept — two numbers whose whole meaning is the comparison between
 * them, which two pills of digits side by side refuse to make.
 *
 * That was the round-6 finding on Team Spades (#148): your partner's bid and
 * their trick count both existed on the felt, as small captioned digits among
 * Cards and Bags, and the one question a partnership is played on — "are we
 * going to make it?" — needed reading four badges and doing the arithmetic. A
 * row of circles does the arithmetic: one circle per trick promised, filled
 * left to right as the tricks come in, and you can see from across the table
 * whether a seat is short.
 *
 * THE VOCABULARY IS THE PLATFORM'S, the payload the template's — the same split
 * COUNTER_TRACK_KINDS makes, and the same fail-soft: a kind this build has
 * never heard of, or one without the numbers, falls through to the ordinary
 * digit badge rather than throwing.
 *
 *   bid    how many were promised; null for a seat that has not spoken yet
 *   taken  how many are in, which may be MORE than was promised
 *   nil    the promise was to take none at all — a different thing from bidding
 *          zero at a points auction, which is a pass (see `bidBadge`)
 *
 * FOUR READINGS, AND THE TWO THAT ARE NOT CIRCLES ARE WORDS. A seat that has
 * not bid has no row to draw, and a nil has no circles to promise — so both
 * print the template's own badge text (`—`, `nil`, `BN`) instead, and a nil
 * that has been broken puts the tricks it was caught with beside the word.
 * Nothing here invents that vocabulary; it prints what `text` already said.
 *
 * BATTERY RULE (GAME_INTEGRATION §6d, cardstock#24): a pip fills with a
 * one-shot transition on `background-color` and then sits still. There is no
 * keyframe animation for this component in the stylesheet at all.
 */

/**
 * Counter kinds this build draws as a row of pips. A template naming anything
 * else — or naming this without the numbers — gets the ordinary badge.
 */
export const COUNTER_PIP_KINDS = Object.freeze(['pips']);

/**
 * The most circles a row may hold. Thirteen is a whole hand at the only table
 * that draws one today, and it is also about as many marks as stay countable
 * at a glance; past it the row would be a texture rather than a number.
 */
export const MAX_PIPS = 13;

/** Past this many, the row is drawn small so it still fits a seat's width. */
const DENSE_ABOVE = 7;

/**
 * The row a counter describes, or null if it does not describe one.
 *
 * Pure, and separated from the DOM for the same reason `counterTrack` is:
 * src/ui/table.js touches `document` at import time and cannot be loaded by a
 * Node test, so a model that can be asserted without a browser is the only way
 * this is ever checked (tests/counterTrack.test.js).
 *
 * `pips` is the row left to right, each one a tone:
 *
 *   taken   promised and in — the accent
 *   open    promised and still owed — an empty ring
 *   bag     past the promise: taken, but it is a BAG rather than a trick, and
 *           bags are what eventually cost a Spades side a hundred points
 *   broken  a trick taken on a nil, which is the promise broken
 */
export function counterPips(counter) {
  if (!counter || !COUNTER_PIP_KINDS.includes(counter.kind)) return null;
  const bid = Number.isInteger(counter.bid) && counter.bid >= 0 ? counter.bid : null;
  const taken = Number.isInteger(counter.taken) && counter.taken > 0 ? counter.taken : 0;
  // A nil is the template's word, not a number this file recognises: a 0 at a
  // POINTS auction is a pass and means the opposite (src/templates/
  // trick-taking.js `bidBadge`), so the flag is what decides and the zero is
  // only the fallback for a template that declared one without the other.
  const nil = counter.nil === true || bid === 0;
  const pips = [];
  if (bid === null) {
    // Nothing promised yet, so there is nothing to draw a promise of.
  } else if (nil) {
    // A nil promises no circles. What it can collect is the count of times it
    // has been broken, and those are worth seeing from across the table.
    for (let i = 0; i < Math.min(taken, MAX_PIPS); i++) pips.push('broken');
  } else {
    for (let i = 0; i < Math.min(bid, MAX_PIPS); i++) pips.push(i < taken ? 'taken' : 'open');
    for (let i = bid; i < Math.min(taken, MAX_PIPS); i++) pips.push('bag');
  }
  return {
    kind: counter.kind,
    bid,
    taken,
    nil,
    // The word in front of the circles, where the reading is not circles at
    // all. The template's own badge text — never a word invented here.
    word: bid === null || nil ? (counter.text || '—') : null,
    pips,
    dense: pips.length > DENSE_ABOVE,
  };
}

/**
 * The row as DOM, or null.
 *
 * `doc` is a parameter rather than the global so this module stays testable —
 * the same reason `counterPips` above is pure. Nothing from a manifest reaches
 * an attribute here (§7b): the tones are this file's own closed vocabulary and
 * the only pack-derived string is `word`, which goes in as `textContent`.
 */
export function renderCounterPips(counter, doc = globalThis.document) {
  const row = counterPips(counter);
  if (!row || !doc) return null;

  const wrap = doc.createElement('span');
  wrap.className = 'seat__pips';
  wrap.dataset.pips = row.kind;
  // ONE ACCESSIBLE NAME FOR THE WHOLE ROW, for the reason the track gives: a
  // screen reader announcing thirteen circles and then a word would be far
  // worse than the two numbers it replaces. The counter's own sentence — which
  // still says both numbers in full — is the name, and every part below is
  // aria-hidden.
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', counter.aria || '');
  if (row.dense) wrap.dataset.dense = 'true';

  if (row.word) {
    const word = doc.createElement('span');
    word.className = 'seat__pips-word';
    word.textContent = row.word;
    word.setAttribute('aria-hidden', 'true');
    wrap.appendChild(word);
  }
  for (const tone of row.pips) {
    const pip = doc.createElement('span');
    pip.className = `seat__pip seat__pip--${tone}`;
    pip.setAttribute('aria-hidden', 'true');
    wrap.appendChild(pip);
  }
  return wrap;
}
