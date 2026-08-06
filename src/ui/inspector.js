// The card inspector: what is this thing, without having to play it.
//
// One floating panel, reused. Two ways in, because the two pointer families
// genuinely differ:
//
//   fine pointer (mouse/trackpad) — hover, after a short dwell so sweeping
//     the cursor across a fanned hand does not strobe the panel;
//   coarse pointer (touch) — LONG PRESS, cancelled the instant the finger
//     travels past the drag slop, so it can never fight a drag. Reaching for a
//     card to move it must always win over reaching for a card to read it.
//
// DECORATIVE BY CONSTRUCTION. The panel is aria-hidden and adds no
// information: everything in it is already in the element's own accessible
// name (src/ui/describe.js), which is the rule that lets the labels come off
// the felt without taking anything away from a screen reader or a touch device.
//
// The content is built LAZILY — the caller registers a thunk, not a string —
// so hovering costs nothing until it is actually hovered, and a card whose
// point value depends on live state reads the live state.

/** Mouse dwell before the panel appears. */
const HOVER_MS = 350;
/** Finger hold before the panel appears. */
const PRESS_MS = 500;
/** Travel that turns a press into a drag, and so cancels the inspection. */
const SLOP = 6;

let panel = null;
let timer = null;
let anchor = null;
// The node whose inspection is pending or showing. Tracked so a NESTED
// inspectable (a meld chip inside a seat plate) can win against its own
// ancestor — see claimedByDescendant() below.

import { schedule } from './clock.js';
let pendingNode = null;

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'card-inspector';
  panel.hidden = true;
  // See the header: everything here is duplicated in the anchor's aria-label.
  panel.setAttribute('aria-hidden', 'true');
  document.body.appendChild(panel);
  return panel;
}

function clearTimer() {
  if (timer) {
    timer.cancel ? timer.cancel() : clearTimeout(timer);
    timer = null;
  }
}

export function hideInspector() {
  clearTimer();
  anchor = null;
  pendingNode = null;
  if (panel) panel.hidden = true;
}

/**
 * Is a MORE SPECIFIC element already claiming the panel?
 *
 * Inspectables nest: a laid-down meld sits inside an opponent's seat plate,
 * and both have something worth saying. Hovering the meld fires pointerenter
 * on the seat as well, so without this the answer to "what is this meld?"
 * depended on which handler happened to schedule last — and the seat, being
 * the coarser target, could win and report the opponent's card count instead
 * of the cards you were actually pointing at.
 *
 * The rule is simply that the innermost target wins, whatever the event order.
 */
function claimedByDescendant(node) {
  const held = pendingNode || anchor;
  return !!held && held !== node && node.contains(held);
}

function render(content) {
  const node = ensurePanel();
  node.replaceChildren();

  const title = document.createElement('div');
  title.className = 'inspector__title';
  title.textContent = content.title || '';
  node.appendChild(title);

  if (content.lines && content.lines.length) {
    const grid = document.createElement('div');
    grid.className = 'inspector__lines';
    for (const line of content.lines) {
      const label = document.createElement('span');
      label.className = 'inspector__label';
      label.textContent = line.label;
      const value = document.createElement('span');
      value.className = 'inspector__value';
      value.textContent = line.value;
      grid.append(label, value);
    }
    node.appendChild(grid);
  }

  for (const note of content.notes || []) {
    const p = document.createElement('div');
    p.className = 'inspector__note';
    p.textContent = note;
    node.appendChild(p);
  }
  node.hidden = false;
}

/** Sit above the anchor, nudged back inside the viewport rather than clipped. */
function position(target) {
  const node = ensurePanel();
  const rect = target.getBoundingClientRect();
  const size = node.getBoundingClientRect();
  const margin = 8;

  let left = rect.left + rect.width / 2 - size.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - size.width - margin));

  let top = rect.top - size.height - margin;
  // No room above (a card in the top row of seats) — flip below.
  if (top < margin) top = Math.min(rect.bottom + margin, window.innerHeight - size.height - margin);

  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function show(target, describe) {
  const content = describe();
  if (!content) return;
  anchor = target;
  pendingNode = target;
  render(content);
  position(target);
}

/**
 * Make `node` inspectable.
 *
 * @param describe () => { title, lines, notes } | null — evaluated at show
 *                 time, so it always reports the live state.
 * @param isBusy   () => boolean — the caller's veto (a drag in flight); the
 *                 inspector never guesses at what else is going on.
 */
export function attachInspector(node, describe, { isBusy = () => false } = {}) {
  node.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse' || isBusy()) return;
    if (claimedByDescendant(node)) return;
    clearTimer();
    pendingNode = node;
    timer = schedule(() => {
      timer = null;
      if (!isBusy()) show(node, describe);
    }, HOVER_MS);
  });

  node.addEventListener('pointerleave', () => {
    // Leaving an ancestor while the pointer is still inside a descendant that
    // owns the panel must not close it.
    if (claimedByDescendant(node)) return;
    if (anchor === node || !anchor) hideInspector();
    else clearTimer();
  });

  node.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') {
      hideInspector();
      return;
    }
    if (claimedByDescendant(node)) return;
    const startX = event.clientX;
    const startY = event.clientY;
    clearTimer();
    pendingNode = node;

    const onMove = (move) => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      // Past the slop this is a drag, and a drag outranks a look.
      if (dx * dx + dy * dy > SLOP * SLOP) done();
    };
    const done = () => {
      clearTimer();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);

    timer = schedule(() => {
      timer = null;
      if (!isBusy()) show(node, describe);
    }, PRESS_MS);
  });
}

/**
 * Wire the global dismissals once, at boot. Scrolling, resizing or tapping
 * elsewhere all mean "I have moved on" and the panel is anchored to a
 * rectangle that may no longer be there.
 */
export function initInspector() {
  ensurePanel();
  window.addEventListener('scroll', hideInspector, { passive: true, capture: true });
  window.addEventListener('resize', hideInspector, { passive: true });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideInspector();
  });
  document.addEventListener('pointerdown', (event) => {
    if (anchor && !anchor.contains(event.target)) hideInspector();
  }, true);
}
