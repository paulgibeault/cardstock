// Picking a card up and putting it down.
//
// GAME-AGNOSTIC ON PURPOSE. This module knows about pointers, a ghost card, a
// set of rectangles it may be dropped on, and the way home. It knows nothing
// about zones, moves or legality — the caller answers `onLift` with the drop
// targets it is willing to accept, which is how the drag layer inherits the
// tap path's invariant (every target came from an enumerated legal move,
// src/ui/interaction.js) instead of re-deriving it.
//
// THE TAP PATH STAYS FIRST-CLASS. A press that never travels past the slop
// threshold is not a drag at all — the click fires and the table behaves
// exactly as it did before this file existed. That is both the accessibility
// posture (design doc §12: "full tap-only input path (no drag required)") and
// the reason this could ship without touching a single tap handler.
//
// WHY THE SOURCE IS HIDDEN RATHER THAN MOVED. The card that flies is a COPY in
// the fixed-position flight layer, and the real node is held invisible under
// it — the same clone-and-animate deal src/ui/flight.js uses for a played
// card. It also happens to BE the "reveals the card underneath" behaviour: a
// pile whose top card is in the air is showing its next card, because that
// card was always there.
//
// One pointer at a time, by construction: a second press while a drag is live
// is ignored rather than starting a rival drag with its own ghost.

import { motionAllowed, animationSettled } from './flight.js';

/** How far a pointer must travel before a press becomes a drag, in px. */
const SLOP = 6;

/** How long the snap-back takes when a drop is refused. */
const RETURN_MS = 240;

function rectOf(node) {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.width ? r : null;
}

/** Overlap area of two rects, 0 when they do not intersect. */
function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Which target the ghost is most over — the one it overlaps by the largest
 * area, or null when it overlaps none.
 *
 * Pure, and takes rects rather than nodes, because THE RECTS ARE MEASURED
 * ONCE PER DRAG rather than once per pointer event. Reading a rect right after
 * writing the ghost's transform forces a synchronous layout, and at 120Hz over
 * a table full of drop-shadowed cards that was the single most expensive thing
 * the drag did. Nothing reflows a target mid-drag — the caller defers renders
 * while `isDragging()`, the hidden source keeps its box, and the hover paint is
 * a pseudo-element — so a snapshot is as correct as a fresh read.
 *
 * @param targets [{ rect }] — entries with a null rect are skipped.
 */
export function pickTarget(ghostRect, targets) {
  let best = null;
  let bestArea = 0;
  for (const target of targets) {
    if (!target.rect) continue;
    const area = overlapArea(ghostRect, target.rect);
    if (area > bestArea) {
      bestArea = area;
      best = target;
    }
  }
  return best;
}

/** setTimeout dressed as the launcher's cancellable-timer shape. */
function plainSchedule(fn, ms) {
  const id = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(id) };
}

/**
 * @param layer       () => the fixed-position element the ghost lives in
 * @param onLift      (handle) => { markup, targets: [{ node, onDrop }] } | null
 *                    Returning null refuses the drag before anything moves.
 * @param onSettle    () => void, after every drag ends (dropped or not) — the
 *                    caller's cue to re-render and clear its own selection.
 * @param schedule    (fn, ms) => { cancel() }. Injected rather than imported:
 *                    this module stays SDK-free (see the header), but the app
 *                    wants its one timer on the launcher's session clock so it
 *                    freezes with a suspended frame like every other timer.
 * @param classifyGesture ({dx, dy, handle, event}) => 'drag' | 'scrub', asked
 *                    once, when a press first travels past the slop threshold.
 *                    'scrub' abandons the press so the caller's own listener
 *                    owns the gesture. Default: everything is a drag.
 */
export function createDragController({
  layer,
  onLift,
  onSettle = () => {},
  schedule = plainSchedule,
  classifyGesture = () => 'drag',
}) {
  // Everything about the CURRENT drag. Null between drags; the presence of
  // `ghost` is what distinguishes "armed, might become a drag" from "dragging".
  let pending = null;
  let drag = null;

  /**
   * Measure every drop target. Called once at lift, and again only when the
   * page geometry moves under the drag — a scroll or a viewport resize, the
   * two things that invalidate a viewport-relative rect without any layout of
   * ours having changed.
   */
  function measureTargets() {
    if (!drag) return;
    for (const target of drag.targets) target.rect = rectOf(target.node);
  }

  function targetUnder(ghostRect) {
    return pickTarget(ghostRect, drag.targets);
  }

  function paintHover(next) {
    if (drag.hover === next) return;
    if (drag.hover) drag.hover.node.classList.remove('drop-target--over');
    drag.hover = next;
    if (next) next.node.classList.add('drop-target--over');
  }

  function moveGhost(clientX, clientY) {
    const left = clientX - drag.grabX;
    const top = clientY - drag.grabY;
    drag.ghost.style.transform = `translate(${left - drag.home.left}px, ${top - drag.home.top}px)`;
    return { left, top, right: left + drag.home.width, bottom: top + drag.home.height };
  }

  /**
   * Tear the drag down. `restore` un-hides the source card; `settle` asks the
   * caller to re-render.
   *
   * A COMMITTED drop passes `settle: false` on purpose — its own move handler
   * renders the result, and settling first would repaint the table from the
   * pre-move state with a selection that is about to be spent.
   */
  function teardown({ restore, settle = true }) {
    if (!drag) return;
    for (const target of drag.targets) {
      target.node.classList.remove('drop-target', 'drop-target--over');
    }
    drag.ghost.remove();
    if (restore && drag.source) drag.source.style.visibility = '';
    document.body.classList.remove('is-dragging');
    drag = null;
    if (settle) onSettle();
  }

  /** A refused drop: the card zooms back to where it was lifted from. */
  function snapHome() {
    if (!drag) return;
    const ghost = drag.ghost;
    const source = drag.source;
    const finish = () => {
      // The source is un-hidden by the SAME callback on every path, including
      // an animation that never started — a card left permanently invisible is
      // the one failure mode here that loses a player their game.
      if (source) source.style.visibility = '';
      ghost.remove();
    };

    for (const target of drag.targets) {
      target.node.classList.remove('drop-target', 'drop-target--over');
    }
    document.body.classList.remove('is-dragging');
    drag = null;

    if (!motionAllowed()) {
      finish();
      onSettle();
      return;
    }
    let settled;
    try {
      const animation = ghost.animate(
        [{ transform: ghost.style.transform }, { transform: 'translate(0, 0)' }],
        { duration: RETURN_MS, easing: 'cubic-bezier(0.3, 0.8, 0.4, 1)', fill: 'forwards' },
      );
      // Guarded, not awaited bare: `finish()` is what puts the player's card
      // back, and a frame-starved document would otherwise never run it. See
      // animationSettled() in src/ui/flight.js for the full account.
      settled = animationSettled(animation, RETURN_MS + 400);
    } catch {
      finish();
      onSettle();
      return;
    }
    settled.then(() => {
      finish();
      onSettle();
    });
  }

  /**
   * @param origin where the PRESS started, not where the pointer is now.
   *
   * That distinction is load-bearing. The grab offset — which part of the card
   * is under the finger — has to be measured from the press, because by the
   * time the pointer has travelled past the slop threshold it may be a long
   * way from the card. Measuring it here from the CURRENT position made the
   * ghost's offset cancel out its own motion, so a quick flick left the card
   * sitting at home while the pointer sailed off, and nothing ever registered
   * as a drop. A slow drag hid it: the error is only ever as large as the
   * distance travelled since the press.
   */
  function begin(handle, node, event, origin) {
    const lift = onLift(handle);
    if (!lift || !lift.markup) return false;

    const home = rectOf(node);
    if (!home) return false;

    const ghost = document.createElement('div');
    ghost.className = 'fly-card drag-ghost';
    ghost.innerHTML = lift.markup;
    ghost.style.left = `${home.left}px`;
    ghost.style.top = `${home.top}px`;
    ghost.style.width = `${home.width}px`;
    layer().appendChild(ghost);

    node.style.visibility = 'hidden';
    document.body.classList.add('is-dragging');

    drag = {
      handle,
      source: node,
      ghost,
      home,
      // Where inside the card the finger landed, so the card does not jump to
      // centre itself under the pointer the instant it lifts.
      grabX: origin.x - home.left,
      grabY: origin.y - home.top,
      targets: lift.targets || [],
      hover: null,
    };
    // Classes first, THEN measure: `.drop-target` only paints a pseudo-element
    // ring (src/ui/table.css), so it moves nothing — but measuring after the
    // write keeps the one forced layout of the whole drag right here, where it
    // is unavoidable, instead of once per pointer event.
    for (const target of drag.targets) target.node.classList.add('drop-target');
    measureTargets();
    paintHover(targetUnder(moveGhost(event.clientX, event.clientY)));
    return true;
  }

  function onPointerMove(event) {
    if (drag) {
      event.preventDefault();
      paintHover(targetUnder(moveGhost(event.clientX, event.clientY)));
      return;
    }
    if (!pending) return;
    const dx = event.clientX - pending.startX;
    const dy = event.clientY - pending.startY;
    if (dx * dx + dy * dy < SLOP * SLOP) return;
    const { handle, node, startX, startY } = pending;
    // A press that has travelled far enough to mean SOMETHING still has to be
    // asked what it means. The caller can claim the gesture for itself — the
    // hand does, for a finger sliding along the fan to read it — and this
    // module stays out of the question: it hands over the delta and takes the
    // answer. Anything but 'scrub' is a drag, so a caller that does not care
    // (the default) gets exactly the old behaviour.
    if (classifyGesture({ dx, dy, handle, event }) === 'scrub') {
      pending = null;
      detach();
      return;
    }
    pending = null;
    if (!begin(handle, node, event, { x: startX, y: startY })) detach();
  }

  /**
   * Eat the `click` that follows a real drag.
   *
   * A pointerup still fires a click on whatever the press began on, and every
   * draggable thing here is ALSO a tap target — a hand card that plays itself,
   * a pile that picks its top card up. Without this, dropping a card would
   * apply the drop and then immediately apply the tap, playing twice or
   * re-selecting the card that just left. The listener is capturing so it
   * beats the element's own handler, and self-clears if no click arrives
   * (a drop onto a non-interactive area).
   */
  function swallowNextClick() {
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

  function onPointerUp(event) {
    if (!drag) {
      pending = null;
      detach();
      return;
    }
    swallowNextClick();
    // A drop is the ONE place a move is committed, and it happens after the
    // ghost is gone so the re-render draws the card in its new home rather
    // than fighting a copy of it still in the air.
    const target = drag.hover;
    detach();
    if (target) {
      teardown({ restore: false, settle: false });
      target.onDrop(event);
    } else {
      snapHome();
    }
  }

  function onPointerCancel() {
    pending = null;
    detach();
    if (drag) snapHome();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !drag) return;
    event.preventDefault();
    detach();
    snapHome();
  }

  // Listeners live on the window, not on the card: the source node is HIDDEN
  // the moment a drag starts, and a hidden element stops receiving pointer
  // events (and drops any pointer capture it held) — so a drag anchored to it
  // would freeze on its first move.
  function attachWindow() {
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    // Capturing, because a scroll inside any scrollable ancestor moves the
    // targets just as surely as a document scroll and does not bubble.
    window.addEventListener('scroll', measureTargets, { capture: true, passive: true });
    window.addEventListener('resize', measureTargets);
  }

  function detach() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('scroll', measureTargets, { capture: true });
    window.removeEventListener('resize', measureTargets);
  }

  return {
    /** Make `node` a drag handle carrying `handle` for the lift callback. */
    attach(node, handle) {
      node.classList.add('draggable');
      node.addEventListener('pointerdown', (event) => {
        // Primary button only, and never a second drag on top of a live one.
        if (event.button !== 0 || drag || pending) return;
        pending = { handle, node, startX: event.clientX, startY: event.clientY };
        attachWindow();
      });
    },

    isDragging() {
      return drag !== null;
    },

    /** Abandon any live drag — leaving the table, a state replacement. */
    cancel() {
      pending = null;
      detach();
      if (drag) teardown({ restore: true });
    },
  };
}
