// Cards travelling across the table.
//
// A card game without card movement reads as a list that redraws itself. This
// is the animation that makes the table a table: a played card leaves the hand
// it was in and arrives on the pile, so the player sees WHO acted and WHERE it
// went without reading the log line.
//
// It is a clone-and-animate, not a layout animation. The real card is already
// gone from the hand by the time this runs — the reducer applied the move and
// the table re-rendered — so what flies is a throwaway copy in a fixed-position
// layer above everything, and the destination card is held invisible until the
// copy lands on top of it.
//
// Motion gating is checked HERE rather than at each call site, so a new call
// site cannot forget it. Two independent signals, both required:
//   - the launcher's reduced-motion setting (§5), which the SDK also enforces
//     for CSS animations but cannot enforce for a JS-driven one; and
//   - the OS preference, which is the only signal a standalone visit has.

/** Both reduced-motion signals, either of which disables travel. */
export function motionAllowed() {
  try {
    if (window.Arcade && Arcade.settings && Arcade.settings.reducedMotion()) return false;
  } catch { /* an SDK too old to have the setting is not a reason to freeze the table */ }
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The layer is created on demand so index.html carries no element that only JS
 * uses. Exported because a dragged card is the same kind of object as a flying
 * one — a throwaway copy above the table — and giving the drag ghost its own
 * layer would mean two stacking contexts to keep in sync (src/ui/dragController.js).
 */
export function flightLayer() {
  let layer = document.getElementById('fly-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'fly-layer';
    // Decorative by construction: it is a copy of a card the table already
    // renders and announces. Announcing it again would double every move.
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * Resolve when `animation` finishes — or when `ms` have passed, whichever
 * comes first.
 *
 * NEVER WAIT ON A COMPOSITOR YOU DO NOT CONTROL. `animation.finished` settles
 * on the animation timeline, and a document that is not being painted has no
 * animation timeline: in a background tab, a hidden launcher frame, or any
 * embedding that throttles rAF to zero, the promise stays pending forever.
 * That is fatal here rather than merely untidy, because both callers use the
 * resolution to make a card VISIBLE AGAIN — the flight layer un-hides the
 * destination, the drag controller un-hides the card in your hand. A promise
 * that never settles is a card that never comes back.
 *
 * Found the hard way: a table backgrounded mid-drag came back with a hole in
 * the hand. setTimeout keeps running (throttled, but it runs, and it fires on
 * the way back to the foreground), so it is the honest backstop.
 */
export function animationSettled(animation, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    animation.finished.catch(() => {}).then(done);
    setTimeout(done, ms);
  });
}

/**
 * Fly a copy of a card from one screen rectangle to another.
 *
 * @param markup  card SVG from src/ui/cardStyles — markup this repo authors,
 *                with every card-derived value escaped inside that module. The
 *                same rule as the table's own svgNode(): safe for innerHTML in
 *                a way that anything carrying a name or label is NOT.
 * @param from,to viewport rectangles (getBoundingClientRect). `from` must be
 *                read BEFORE the move is applied — the source is gone after.
 * @param fade    true for a card that dissolves on arrival (a draw, whose
 *                destination is a fanned hand with no single landing slot)
 *                rather than landing on a specific card.
 * @returns a promise that resolves when the card has landed, always — a
 *          cancelled or unsupported animation resolves rather than rejecting,
 *          because callers use this to un-hide the destination and a rejection
 *          would leave a card permanently invisible.
 */
export function flyCard(markup, from, to, { fade = false, duration = 260 } = {}) {
  if (!from || !to || !from.width || !to.width || !motionAllowed()) return Promise.resolve();

  const node = document.createElement('div');
  node.className = 'fly-card';
  node.innerHTML = markup;
  node.style.left = `${from.left}px`;
  node.style.top = `${from.top}px`;
  node.style.width = `${from.width}px`;
  flightLayer().appendChild(node);

  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const scale = to.width / from.width;

  let settled;
  try {
    const animation = node.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: fade ? 0 : 1 },
    ], { duration, easing: 'cubic-bezier(0.25, 0.8, 0.35, 1)', fill: 'forwards' });
    // Guarded rather than awaited bare — see animationSettled(). landOn() holds
    // the destination card invisible until this resolves, so "never" is not an
    // acceptable answer.
    settled = animationSettled(animation, duration + 400);
  } catch {
    node.remove();
    return Promise.resolve();
  }

  return settled.then(() => node.remove());
}

/**
 * Hold `node` invisible until `arrival` resolves, so the flying copy is the
 * only card on screen in transit. Visibility is restored on every path,
 * including a rejected or never-started flight.
 */
export function landOn(node, arrival) {
  if (!node) return arrival;
  node.style.opacity = '0';
  return arrival.then(() => { node.style.opacity = ''; });
}
