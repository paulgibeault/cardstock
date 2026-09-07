// A SEAT COUNTER DRAWN LONG — the platform's track renderer.
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

  for (const [which, pct] of [['back', track.backPct], ['front', track.frontPct]]) {
    const peg = doc.createElement('span');
    peg.className = `seat__track-peg seat__track-peg--${which}`;
    peg.style.left = `${pct.toFixed(2)}%`;
    peg.setAttribute('aria-hidden', 'true');
    wrap.appendChild(peg);
  }
  if (track.together) wrap.dataset.together = 'true';

  const value = doc.createElement('span');
  value.className = 'seat__track-value';
  value.textContent = counter.text;
  value.setAttribute('aria-hidden', 'true');
  wrap.appendChild(value);

  return wrap;
}
