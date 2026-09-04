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

/* ------------------------------------------------------------------ *
 * Geometry — where a card is, and where it is going
 * ------------------------------------------------------------------ *
 *
 * flight.js already owns the flying, so it owns the arithmetic too. These lived
 * in src/ui/table.js, where `rectOf` was a verbatim copy of the one in
 * src/ui/dragController.js — the same eight lines in three modules, all doing
 * the same thing for the same reason.
 */

/** A node's rect, or null when it has no size (unlaid-out, hidden, suspended). */
export function rectOf(node) {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.width ? r : null;
}

/**
 * A card-sized rectangle centred on `rect`.
 *
 * flyCard scales its copy to the destination's width, which is right when the
 * destination IS a card and comically wrong when it is a whole fanned hand,
 * where the copy would balloon to the hand's full width mid-flight.
 */
export function cardSizedRect(rect, width) {
  if (!rect) return null;
  const height = width * 1.4;
  return {
    left: rect.left + rect.width / 2 - width / 2,
    top: rect.top + rect.height / 2 - height / 2,
    width,
    height,
  };
}

/* ------------------------------------------------------------------ *
 * A rect measured off a row that is still moving
 * ------------------------------------------------------------------ *
 *
 * "SOMETIMES ONE OF THE CARDS GOES FOR A RIDE TO THE NEIGHBOUR'S DECK."
 *
 * The seat row auto-scrolls when the turn moves (scrollActingSeatIntoView in
 * src/ui/table.js) and it does so SMOOTHLY, which means the row is still
 * gliding when the move that caused the scroll measures where its card should
 * land. Measured in Chrome: a one-seat scroll of ~140px takes ~290ms and the
 * seat has covered the whole 140px by t=260ms — one card pitch, the full
 * distance, arriving cleanly on the neighbour's plate. Not a near-miss that
 * reads as sloppiness; a wrong seat that reads as the card changing hands.
 *
 * The celebrations are worse and they are why the report says "one of the
 * cards": src/ui/celebrations.js measures its destination ONCE and then
 * launches copies on timers up to 550ms later, so the first copy lands right
 * and the last lands a seat over.
 *
 * THE FIX IS TO AIM AT WHERE THE SEAT WILL BE. The scroll's destination is
 * known before the scroll starts (seatScrollTarget), so a rect measured mid-
 * glide can be shifted by the distance the row has left to travel. It is
 * self-annihilating: as the scroll completes, `left` and `scrollLeft` converge
 * and the correction goes to zero on its own.
 *
 * WHY NOT THE ALTERNATIVES, so nobody re-litigates them:
 *   - AWAITING THE SCROLL (`scrollend`, with a timeout backstop) before
 *     animating. `afterMove` cannot become async: it ends in `persistMatch`
 *     and `scheduleNextTurn`, so awaiting there delays bot pacing globally.
 *     Fire-and-forget instead and every one of its several call sites needs a
 *     fresh epoch guard — plus ~300ms of dead air on every turn, plus a Safari
 *     fallback for a `scrollend` it does not send.
 *   - MEASURING BEFORE THE RENDER. Tempting, and wrong in an instructive way:
 *     pre-render the acting seat IS the centred one, so that rect is stale by
 *     the same pitch in the opposite direction.
 *
 * The correction is applied where rects are MEASURED (seatRect, zoneRect and
 * the meld-chip lookup in src/ui/table.js) rather than where flights are
 * launched, which is what fixes the celebration sites too without their
 * knowing that the row scrolls at all.
 */

/**
 * How long a pending scroll target may be believed.
 *
 * THE SAME RULE animationSettled states below: never wait on a compositor you
 * do not control. Nothing here awaits anything, but a recorded target is a
 * promise about the future made by a scroll this module cannot observe — the
 * player can grab the row and drag it somewhere else, a resize can clamp it, a
 * suspended frame can leave it half-way. Every one of those makes the stored
 * `left` a lie, and an uncapped lie would displace every rect on the table for
 * the rest of the match. The longest scroll the rig measured was ~290ms; 700
 * is generous enough to cover a slow device and short enough that a stale
 * value is gone before the next turn.
 */
export const SCROLL_SETTLE_MS = 700;

/**
 * `rect`, moved to where it will be once the row finishes scrolling.
 *
 * Pure on purpose — the arithmetic is the whole fix and the DOM half of it
 * (which row, which node, what time it is) is three lines that no Node test can
 * reach. See tests/flight.test.js.
 *
 * @param rect     the rect as measured right now, or null
 * @param pending  the row's unfinished scroll, or null when none is running:
 *                 { left } the scroll's destination, { scrollLeft } where the
 *                 row is at this instant, { elapsedMs } since it was issued,
 *                 and { holds } whether the measured node is inside that row.
 */
export function scrollCorrectedRect(rect, pending) {
  if (!rect || !pending || !pending.holds) return rect;
  // A negative elapsed is a clock that went backwards, which is not a state
  // this can reason about; a large one is a scroll that has long since ended
  // or been abandoned. Both mean "believe the rect in front of you".
  const { elapsedMs } = pending;
  if (!(elapsedMs >= 0) || elapsedMs > SCROLL_SETTLE_MS) return rect;
  const shift = pending.left - pending.scrollLeft;
  if (!shift) return rect;
  // Content moves the OPPOSITE way to scrollLeft: a row scrolling 140px to the
  // right carries its seats 140px to the left.
  const left = rect.left - shift;
  return {
    left, top: rect.top, width: rect.width, height: rect.height,
    right: left + rect.width, bottom: rect.top + rect.height,
  };
}

/* ------------------------------------------------------------------ *
 * How long a card takes to cross the felt
 * ------------------------------------------------------------------ */

/**
 * The default, and the two ends of the scale.
 *
 * 260 WAS TOO SHORT AND THE PLAYTEST SAID SO: "when players/bots play their
 * cards, the animation is too fast to notice". A quarter of a second is fine
 * for a card hopping between the fan and the tray and far too little for one
 * crossing the whole table, which is the trip that carries the information —
 * WHO played and WHERE it went. It survives as the floor rather than the
 * default, because at the fastest bot speed a longer flight would still be in
 * the air when the next bot moves.
 */
export const FLIGHT_MS = 420;
export const FLIGHT_MIN_MS = 260;
export const FLIGHT_MAX_MS = 700;

/**
 * How long this table's cards should fly, given the player's bot-speed setting.
 *
 * "SLOWER BOTS" ALREADY MEANS "I WANT LONGER TO WATCH THIS", and it was being
 * spent entirely on think time — the bot paused for a second and then teleported
 * its card. One setting, one intention: the pause and the flight scale together.
 *
 * Scaled off the same 600ms baseline `thinkTimeMs` uses (src/players/roster.js)
 * and defended the same way, because this reads a value out of storage that a
 * hand-edited save or an older build can make nonsense: a non-number, a zero, a
 * negative all land back on the default rather than on a card that never
 * arrives or one that never leaves.
 */
export function flightDurationMs(botDelayMs) {
  const scale = (Number(botDelayMs) || 600) / 600;
  return Math.round(Math.min(FLIGHT_MAX_MS, Math.max(FLIGHT_MIN_MS, FLIGHT_MS * scale)));
}

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
export function flyCard(markup, from, to, { fade = false, duration = FLIGHT_MS } = {}) {
  if (!from || !to || !from.width || !to.width || !motionAllowed()) return Promise.resolve();

  const node = document.createElement('div');
  node.className = 'fly-card';
  node.innerHTML = markup;
  node.style.left = `${from.left}px`;
  node.style.top = `${from.top}px`;
  node.style.width = `${from.width}px`;
  flightLayer().appendChild(node);

  // Measured, not assumed. The copy takes its width from `from` but its HEIGHT
  // from the card's own aspect, so the two only agree when `from` was already
  // card-shaped. Launch one from a rect that is not — an opponent's mini-hand
  // is a strip about a third of a card tall — and centring on `from.height`
  // puts the copy's real centre far below the one the arithmetic used: it
  // lands low, is removed, and the destination card (already rendered, merely
  // held invisible) appears to snap up into place.
  //
  // Reading the box back costs one forced layout on a single node, which is
  // cheaper than every call site having to know what shape a card is.
  const start = node.getBoundingClientRect();
  const dx = (to.left + to.width / 2) - (start.left + start.width / 2);
  const dy = (to.top + to.height / 2) - (start.top + start.height / 2);
  const scale = to.width / start.width;

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
