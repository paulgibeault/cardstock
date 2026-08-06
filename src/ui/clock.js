// The launcher's session clock, and the one gesture ritual that needs it.
//
// TIMERS MUST FREEZE WITH THE FRAME (§6c). A forgotten timer in a hidden iframe
// is the fleet's number one battery drain, and the SDK's `Arcade.session`
// timeouts are the answer — but modules that are game-agnostic by design
// (src/ui/dragController.js) must not import the SDK, and modules that can be
// exercised under `node --test` must not require it to exist. So the wrapper
// lives here, with a plain-setTimeout fallback, and everything that needs a
// cancellable timer takes it from one place.
//
// Three copies of this function existed: src/ui/table.js's `sessionSchedule`,
// src/ui/inspector.js's `schedule`, and dragController's injected parameter
// (which src/ui/table.js was satisfying with its own copy).

/** @returns { cancel() } — cancellable, whichever clock answered. */
export function schedule(fn, ms) {
  const session = typeof window !== 'undefined' && window.Arcade && window.Arcade.session;
  if (session && typeof session.setTimeout === 'function') return session.setTimeout(fn, ms);
  const id = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(id) };
}

/**
 * Eat the `click` a pointerup is about to fire on the PRESS target.
 *
 * A pointerup still fires a click on whatever the press began on, and every
 * draggable thing on this table is ALSO a tap target — a hand card that plays
 * itself, a pile that picks its top card up. A gesture that has already acted
 * (a completed drag, a scrub that landed on a different card) must not then act
 * again on the wrong element. The listener is capturing so it beats the
 * element's own handler, and self-clears if no click arrives at all.
 *
 * dragController and the hand's scrub gesture each had a copy of this, and the
 * table's copy carried a comment reading "Same shape and the same reason as the
 * drag controller's".
 */
export function swallowNextClick() {
  let timer = null;
  const eat = (event) => {
    event.stopPropagation();
    event.preventDefault();
    window.removeEventListener('click', eat, true);
    if (timer) timer.cancel();
  };
  window.addEventListener('click', eat, true);
  timer = schedule(() => window.removeEventListener('click', eat, true), 400);
}
