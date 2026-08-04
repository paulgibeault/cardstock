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
