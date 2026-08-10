// Reading a fan with a finger: peek, scrub, and hold-to-gather.
//
// Extracted from src/ui/table.js because it is pointer choreography, not felt —
// the same reason src/ui/dragController.js is its own module, and it follows
// dragController's pattern: inject the callbacks, keep no state of your own
// (the live gesture lives on the session, so it dies with the match).
//
// PEEK: the card under the finger rises out of the fan, before the finger is
// lifted, and follows the finger along the row. A fan overlaps, so all you can
// see of most cards is a strip down the left edge — on a phone, thinner than
// the finger covering it. `:hover` solves this for a mouse and does nothing for
// a touch, which left the player tapping a sliver and finding out afterwards
// what they had chosen. Raising on pointerDOWN turns a tap into
// look-then-commit.
//
// The visible strip of card i runs from its own left edge to the NEXT card's,
// because later siblings paint over earlier ones; the last card owns its full
// width. That is exactly the region the player can see, which is what makes
// this feel like pointing at the card rather than at a hitbox.
//
// Hit-testing is by cached rect, not by event target: touch capture sends every
// move to the element the press began on, so the target is always the first
// card. The rects are measured once per press for the same reason the drag
// controller measures its targets once (issue #6) — the fan does not move while
// a finger is on it.

import { schedule, swallowNextClick } from './clock.js';
import { smartSelection } from './interaction.js';

/**
 * @param hand        the #hand element
 * @param session     () => the open session, or null
 * @param me          the seat lens (src/players/seats.js); its seat owns this fan
 * @param cardById    (state, id) => card
 * @param onSelect    (state, cardId, card, node, ui) => void — the same handler
 *                    a tap runs. A scrub is a nicer way to REACH a card, never
 *                    a second rules path.
 * @param onGathered  (state, count) => void — re-render after a hold gathered a
 *                    meld (the cards leave the fan for the tray)
 */
export function watchHandGestures({ hand, session, me, cardById, onSelect, onGathered }) {
  const el = { hand };
  /**
   * PEEK: the card under the finger rises out of the fan, before the finger is
   * lifted, and follows the finger along the row.
   *
   * A fan overlaps, so all you can see of most cards is a strip down the left
   * edge — on a phone, thinner than the finger covering it. `:hover` solves this
   * for a mouse and does nothing for a touch, which left the player tapping a
   * sliver and finding out afterwards what they had chosen. Raising on
   * pointerDOWN turns a tap into look-then-commit: what you are on is legible
   * while you are still on it, and sliding to a neighbour costs nothing.
   *
   * Hit-testing is by cached rect, not by event target: touch capture sends
   * every move to the element the press began on, so the target is always the
   * first card. The rects are measured once per press for the same reason the
   * drag controller measures its targets once (issue #6) — the fan does not
   * move while a finger is on it.
   *
   * The visible strip of card i runs from its own left edge to the NEXT card's,
   * because later siblings paint over earlier ones; the last card owns its full
   * width. That is exactly the region the player can see, which is what makes
   * this feel like pointing at the card rather than at a hitbox.
   */
  function paintPeek(wrapper) {
    if (!session()) return;
    if (peek() && peek().node === wrapper) return;
    if (peek() && peek().node) peek().node.classList.remove('card-face-wrap--peek');
    if (peek()) peek().node = wrapper;
    if (wrapper) wrapper.classList.add('card-face-wrap--peek');
  }

  function clearPeek() {
    if (!session()) return;
    disarmSmartSelect();
    if (peek() && peek().node) peek().node.classList.remove('card-face-wrap--peek');
    peek(null);
  }

  /* ------------------------------------------------------------------ *
   * Gathering a meld by holding one card
   * ------------------------------------------------------------------ */

  /** How long a hold has to last to mean "and the rest of this meld". */
  const SMART_SELECT_MS = 500;

  /**
   * HOLD A CARD TO GATHER ITS MELD.
   *
   * The last of the three answers to "assembling a meld on a phone is too
   * cramped", and the one that skips the problem rather than easing it: the pack
   * already knows that the two other sevens go with this seven, so picking them
   * out of the fan by hand is work the rules could have done. Hold the seven and
   * the group arrives in the tray.
   *
   * Only where the question means something — a rummy hand still choosing what
   * to lay down. Everywhere else a long press keeps meaning "what is this card?"
   * (src/ui/inspector.js), which the inspector's own veto is told about below.
   *
   * The gathered cards go through the ORDINARY selection, so this can no more
   * construct an illegal lay-down than tapping the same cards could.
   */
  function smartSelectArmed() {
    return !!session?.ui && session()?.ui.mode === 'rummy-meld' && session()?.ui.handMulti;
  }

  function disarmSmartSelect() {
    if (peek()?.hold) {
      peek().hold.cancel();
      peek().hold = null;
    }
  }

  function armSmartSelect(wrapper) {
    if (!smartSelectArmed() || !peek()) return;
    peek().hold = schedule(() => {
      if (!peek()) return;
      peek().hold = null;
      const cardId = wrapper.dataset.cardId;
      const next = smartSelection(session().state, me.seat(), cardId, session().selection);
      if (!next) {
        // Nothing in hand goes with it. Say so on the card rather than in words:
        // a group that does not exist is not an error, just an answer.
        wrapper.classList.add('card-face-wrap--nomatch');
        schedule(() => wrapper.classList.remove('card-face-wrap--nomatch'), 400);
        return;
      }
      const gathered = next.cardIds.length - (session().selection ? session().selection.cardIds.length : 0);
      session().selection = next;
      clearPeek();
      // A full render: the gathered cards leave the fan for the tray.
      onGathered(session().state, gathered);
    }, SMART_SELECT_MS);
  }

  /** The fan card whose VISIBLE strip contains `clientX`. */
  function cardStripAt(clientX) {
    if (!peek() || !peek().strips.length) return null;
    const strips = peek().strips;
    if (clientX < strips[0].left) return strips[0].node;
    for (let i = 0; i < strips.length; i++) {
      const right = i + 1 < strips.length ? strips[i + 1].left : strips[i].right;
      if (clientX < right) return strips[i].node;
    }
    return strips[strips.length - 1].node;
  }

  function attach() {
    el.hand.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // Whatever the last press left behind. A pointerup can go missing — the
      // finger leaves the window, a drag takes the gesture over — and a card
      // left raised is a card claiming to be under a finger that is not there.
      clearPeek();
      const wrapper = event.target.closest?.('.card-face-wrap');
      if (!wrapper || !el.hand.contains(wrapper)) return;
      const strips = [...el.hand.children].map((node) => {
        const r = node.getBoundingClientRect();
        return { node, left: r.left, right: r.right };
      });
      peek({ node: null, strips, pointerId: event.pointerId, scrubbed: false, hold: null });
      paintPeek(wrapper);
      armSmartSelect(wrapper);
    });

    el.hand.addEventListener('pointermove', (event) => {
      if (!peek() || event.pointerId !== peek().pointerId) return;
      const under = cardStripAt(event.clientX);
      if (under && under !== peek().node) {
        peek().scrubbed = true;
        // The press has become a slide, so it is no longer a hold.
        disarmSmartSelect();
      }
      if (under) paintPeek(under);
    });

    // A scrub that ended on a card other than the one pressed has to activate
    // THAT card: the browser's click will name the press target, which is the
    // whole thing the player was scrubbing away from.
    const finish = (event) => {
      if (!peek() || event.pointerId !== peek().pointerId) return;
      const landed = peek().node;
      const scrubbed = peek().scrubbed;
      clearPeek();
      if (!scrubbed || !landed || !session()?.state || !session()?.ui) return;
      const cardId = landed.dataset.cardId;
      // Only what a tap could already have done — the same model, the same
      // guard. A scrub is a nicer way to reach a card, never a second rules path.
      if (!session()?.ui.handSelectable.has(cardId)) return;
      const card = cardById(session().state, cardId);
      if (!card) return;
      swallowNextClick();
      onSelect(session().state, cardId, card, landed, session().ui);
    };
    el.hand.addEventListener('pointerup', finish);
    el.hand.addEventListener('pointercancel', () => clearPeek());
  }

  attach();
  return { clearPeek, smartSelectArmed };

  function peek(value) {
    const s = session();
    if (!s) return null;
    if (value !== undefined) s.peek = value;
    return s.peek;
  }
}
