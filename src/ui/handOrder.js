// How the player's own hand is arranged.
//
// HAND ORDER IS PRESENTATION, NEVER STATE. Nothing here touches the engine's
// zone array, and no rearrangement is ever appended to the event log. Three
// reasons, in order of how badly each would bite:
//
//  1. The log is the saved match (src/engine/replay.js). A shuffle of your own
//     hand is not a move, and writing one would make every save bigger and
//     every replay carry choreography that changes no outcome.
//  2. Determinism. Zone order feeds `sorted` zones and the enumerators; a
//     player dragging their cards about must not be able to change which move
//     a bot or a rule test sees first.
//  3. Multiplayer, when it lands: how you like your cards fanned is nobody
//     else's business, and this way it never leaves the device.
//
// So the engine keeps dealing order and this module decides what the FAN looks
// like — a permutation applied at render time, pruned against the real hand on
// every pass so a stale id can no more reach the screen than a stale selection
// can reach a move.

import { RANKS } from '../engine/cards.js';

export const SORT_MODES = Object.freeze(['auto', 'suit', 'rank', 'manual']);

export const SORT_LABELS = Object.freeze({
  auto: 'Deal order',
  suit: 'By suit',
  rank: 'By rank',
  manual: 'My order',
});

export const DEFAULT_MODE = 'auto';

export function isSortMode(mode) {
  return SORT_MODES.includes(mode);
}

function rankIndex(card) {
  const asNumber = Number(card?.rank);
  // Numeric ranks sort numerically (a Skip-Bo 12 is above a 2); everything
  // else falls back to the standard rank ladder, and an unrecognised rank
  // sorts last rather than colliding with the aces.
  if (Number.isFinite(asNumber)) return asNumber;
  const i = RANKS.indexOf(card?.rank);
  return i === -1 ? 999 : 100 + i;
}

function groupKey(card) {
  return card?.suit || card?.color || '';
}

/**
 * Order `cardIds` for display.
 *
 * @param cardIds  the hand as the engine holds it (deal order)
 * @param cardOf   id -> card definition
 * @param mode     one of SORT_MODES
 * @param manual   the stored permutation, only consulted for 'manual'
 * @returns a NEW array — never the caller's, and never the zone's.
 */
export function orderHand(cardIds, cardOf, mode = DEFAULT_MODE, manual = []) {
  const ids = cardIds.slice();
  if (mode === 'manual') return applyManual(ids, manual);
  if (mode === 'auto') {
    return ids.sort((a, b) => (cardOf(a)?.sortOrder ?? 0) - (cardOf(b)?.sortOrder ?? 0));
  }
  if (mode === 'suit') {
    return ids.sort((a, b) => {
      const ca = cardOf(a);
      const cb = cardOf(b);
      const ga = groupKey(ca);
      const gb = groupKey(cb);
      if (ga !== gb) return ga < gb ? -1 : 1;
      return rankIndex(ca) - rankIndex(cb);
    });
  }
  // 'rank'
  return ids.sort((a, b) => {
    const ca = cardOf(a);
    const cb = cardOf(b);
    const byRank = rankIndex(ca) - rankIndex(cb);
    if (byRank !== 0) return byRank;
    const ga = groupKey(ca);
    const gb = groupKey(cb);
    return ga === gb ? 0 : (ga < gb ? -1 : 1);
  });
}

/**
 * Lay `ids` out in the player's stored order.
 *
 * Cards the permutation has never heard of — everything drawn since it was
 * written — go on the END rather than being dropped: a fan that silently loses
 * the card you just drew is worse than one whose newest card is not where you
 * would have put it. Ids the hand no longer holds are ignored, which is the
 * same pruning discipline the selection gets.
 */
export function applyManual(ids, manual) {
  const held = new Set(ids);
  const seen = new Set();
  const out = [];
  for (const id of manual || []) {
    if (held.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of ids) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * The permutation after dragging `cardId` to sit at display index `toIndex`.
 *
 * Takes and returns a full display order, so the caller can hand back exactly
 * what it drew and store exactly what it will draw next time.
 */
export function reorder(displayed, cardId, toIndex) {
  const out = displayed.filter((id) => id !== cardId);
  const at = Math.max(0, Math.min(out.length, toIndex));
  out.splice(at, 0, cardId);
  return out;
}

/** The next mode in the toggle's cycle. */
export function nextMode(mode) {
  const i = SORT_MODES.indexOf(mode);
  return SORT_MODES[(i + 1) % SORT_MODES.length];
}

/* ------------------------------------------------------------------ *
 * How tightly the fan closes
 * ------------------------------------------------------------------ */

/** The natural spacing, as a fraction of a card's width, with room to spare. */
const NATURAL = 0.69;

/**
 * The tightest useful spacing. A card's rank corner lives in roughly its left
 * sixth, so closing past this hides the one thing an overlapped card still has
 * to say — and a fan you cannot read is not saving you anything.
 */
const TIGHTEST = 0.17;

/** Never below this many px, however small the cards get. */
const FLOOR_PX = 10;

/**
 * How far each card should sit from the one before it.
 *
 * SPACING FLEXES, CARD SIZE DOES NOT. A hand is the one thing on the table
 * whose size the layout cannot choose — the pack decides how many cards you
 * hold, and Milestones deals ten while a phone is 375px wide. Shrinking the
 * cards would make every hand harder to read to solve a problem only big hands
 * have; closing the fan is what a real player does, and it costs nothing until
 * the corners start disappearing.
 *
 * Pure so the rule can be pinned in tests — the DOM half is just two
 * measurements (layoutHand in src/ui/table.js).
 *
 * @param count      cards in the hand
 * @param cardWidth  one card's width in px
 * @param available  px the fan may occupy
 */
export function fanStep({ count, cardWidth, available }) {
  const natural = cardWidth * NATURAL;
  if (count < 2) return natural;
  const tightest = Math.max(FLOOR_PX, cardWidth * TIGHTEST);
  const needed = (available - cardWidth) / (count - 1);
  return Math.min(natural, Math.max(tightest, needed));
}

/** Total width a fan of `count` cards occupies at `step`. */
export function fanWidth({ count, cardWidth, step }) {
  return count < 1 ? 0 : cardWidth + Math.max(0, count - 1) * step;
}

/* ------------------------------------------------------------------ *
 * Reading the fan with a finger
 * ------------------------------------------------------------------ */

/**
 * How much more horizontal than vertical a movement must be to count as
 * reading along the fan rather than lifting a card out of it.
 *
 * Not 1:1. A finger dragging a card upward off the row rarely goes straight
 * up — the hand pivots at the wrist, so an honest lift arrives with real
 * sideways travel in it. Requiring the horizontal component to clearly
 * dominate keeps those lifts as drags. Erring this way is deliberate: a scrub
 * misread as a drag costs a snap-back, while a drag misread as a scrub drops a
 * card the player was carrying somewhere.
 */
const SCRUB_RATIO = 1.5;

/**
 * What a press on a hand card that has started to move MEANS.
 *
 * Two gestures share one starting position, because both are things you do to
 * a card in your own hand:
 *   'scrub' — sliding along the fan to see what is in it. The cards overlap,
 *             so most of each one is hidden, and on a phone a card's visible
 *             strip is thinner than a fingertip. Sliding raises whichever card
 *             is under the finger, which is how you read a row you cannot see.
 *   'drag'  — lifting a card out, to play it or to re-order the fan.
 *
 * Pure, and takes the delta rather than the event, so the rule can be pinned
 * in tests while the pointer mechanics get a manual pass — same split as
 * fanStep above and pickTarget in dragController.
 */
export function classifyHandGesture({ dx, dy }) {
  return Math.abs(dx) > Math.abs(dy) * SCRUB_RATIO ? 'scrub' : 'drag';
}
