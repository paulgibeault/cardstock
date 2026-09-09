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

const DEFAULT_MODE = 'auto';

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
 * The WIDEST the fan opens, as a fraction of a card's width.
 *
 * NATURAL used to be a ceiling as well as a default, which meant a hand played
 * down to five cards still wore the thirteen-card overlap with a thousand
 * pixels of empty felt on either side of it (#122, round-5 item 23): every card
 * still had a third of itself under its neighbour for no reason at all. A fan
 * is closed because the table is short of room, so when it is not, it opens.
 *
 * Just under 1 rather than at it: a sliver of overlap is what makes a row of
 * cards read as one hand rather than as a line of separate cards, and at this
 * spacing the covered strip is the outer edge — every rank, suit and pip is
 * fully visible. Above 1 the cards would part, and a hand with gaps in it is a
 * hand somebody has already played out of.
 */
const OPEN = 0.94;

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
 * AND IT FLEXES BOTH WAYS. `natural` was the ceiling as well as the default, so
 * a hand that had been played down to five cards kept the thirteen-card overlap
 * on a table with a thousand pixels going spare (#122 item 23). The room the fan
 * is given is now what decides: closed to `tightest` when there is not enough,
 * open to `OPEN` when there is more than enough, and `natural` is what it sits
 * at in between.
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
  if (needed <= natural) return Math.max(tightest, needed);
  return Math.min(cardWidth * OPEN, needed);
}

/**
 * How far the cards to the RIGHT of a lifted one step aside for it.
 *
 * A LIFTED CARD COMES TO THE FRONT, AND THE FRONT IS ON TOP OF ITS NEIGHBOUR'S
 * ONLY VISIBLE STRIP. The fan overlaps leftward, so each card shows its own left
 * edge and nothing else; raising one (hover, the hint ring, the finger's peek)
 * puts it over exactly the strip its right-hand neighbour is being read by, and
 * that neighbour goes down to a pip (#122 item 23). Ranking the lift lower does
 * not help — then the lift itself is buried, which is the bug the z-order ladder
 * exists to prevent (tests/handZOrder.test.js).
 *
 * So the fan opens instead: everything after the lifted card slides right by
 * exactly the overlap, which is the smallest shift that uncovers the neighbour
 * completely. Zero when the fan is not overlapping — then there is nothing to
 * uncover, and nothing moves.
 *
 * The shift is a transform, so it costs no layout, and `layoutHand` reserves it
 * out of the room the fan may use so the rightmost card can never be pushed off
 * the felt.
 */
export function liftGap({ cardWidth, step }) {
  return Math.max(0, Math.round((cardWidth - step) * 10) / 10);
}

/** Total width a fan of `count` cards occupies at `step`. */
export function fanWidth({ count, cardWidth, step }) {
  return count < 1 ? 0 : cardWidth + Math.max(0, count - 1) * step;
}

/**
 * The narrowest strip a card can show and still be a card you are CHOOSING
 * from, as a fraction of its width.
 *
 * TIGHTEST (0.17) is a different promise: it is the point past which the rank
 * corner itself starts disappearing, so it is the floor for "still legible at
 * all" — what a fan closes to when there is genuinely nowhere else to go. This
 * is the higher bar: the strip you CHOOSE off, not the strip you can just about
 * decipher.
 *
 * HALF THE CARD, and the two numbers that bracket it are measured rather than
 * felt. The corner index (`cornerIndex` in src/ui/cardStyles/classic.js) inks
 * from x≈4 to x≈24 of a 100-wide card, so the rank and its suit occupy the left
 * 0.24; at 0.5 the visible strip is more than twice that, which is what makes
 * the index read as belonging to THIS card rather than as ink at the seam
 * between two, and at the 375px breakpoint's 46px cards it is 23px — a strip a
 * fingertip can be aimed at, against the 14.5px the playtest called unreadable.
 *
 * The window is narrow and it is the issue's own measurements that close it
 * (#134). A 13-card hand on a 375px phone has 312px once the rail leaves the
 * row: one row is 22.2px a card, which has to be judged NOT good enough, so the
 * floor must sit above 0.48. Split in two the same hand gets 29px with the rail
 * still beside it, which has to be judged good enough or the split buys
 * nothing, so the floor must sit below 0.63. 0.5 is the round number in
 * between, and it is the one that says what it means.
 */
const READABLE = 0.5;

/**
 * How many ROWS the fan needs, and the step each of them gets.
 *
 * A fan closes to fit its row, and `fanStep` above says how far. But closing
 * has a bottom: a 13-card hand on a 375px phone was handed 220px, which is
 * 14.5px a card — under READABLE, and a hand you cannot read is not a hand you
 * can play. Below that floor the answer is no longer horizontal. Real players
 * do not squeeze thirteen cards into one strip either; they fan them in two.
 *
 * SO HEIGHT IS SPENT, AND ONLY WHERE THERE IS HEIGHT TO SPEND. `slack` is the
 * room the felt's middle actually has going spare, measured (layoutHand in
 * src/ui/table.js), never assumed: a staging phase — Pinochle's meld
 * declaration, Cribbage's crib discard — has already taken most of it, and a
 * second row bought there would push the felt off the bottom of the screen.
 * When the slack is not there the fan stays on one row and closes, which is the
 * behaviour this replaces: worse, but not broken.
 *
 * FEWEST ROWS THAT CLEAR THE FLOOR. Rows cost a card's height each and buy
 * nothing once the fan is readable, so this stops at the first count that
 * works rather than spreading as wide as it is allowed to.
 *
 * Cards fill rows left to right, top to bottom — `Math.ceil(count / rows)` to a
 * row — so reading order and `handOrder` are untouched: the second row is the
 * end of the same hand, not a second hand.
 *
 * Pure, like everything else in here; the DOM half is three measurements.
 *
 * @param count      cards in the fan
 * @param cardWidth  one card's width in px
 * @param cardHeight one card's height in px — what a row costs
 * @param available  px a single row may occupy
 * @param slack      px of height the felt can give up, beyond the first row
 * @param rowGap     px between rows (the stylesheet's, read back by layoutHand)
 * @returns { rows, step, perRow }
 */
export function fanLayout({ count, cardWidth, cardHeight, available, slack, rowGap = 0 }) {
  const one = { rows: 1, step: fanStep({ count, cardWidth, available }), perRow: count };
  if (count < 2) return one;
  const readable = Math.max(FLOOR_PX, cardWidth * READABLE);
  if (one.step >= readable) return one;

  // A row costs its own height plus the gap above it. What `slack` buys is
  // rows BEYOND the first, which the hand is already paying for.
  const rowCost = (cardHeight || 0) + (rowGap || 0);
  // A row holding one card is not a fan, so a hand can never split further
  // than into pairs however much height is going spare.
  const affordable = rowCost > 0
    ? Math.min(Math.floor(count / 2), 1 + Math.floor(Math.max(0, slack) / rowCost))
    : 1;
  if (affordable < 2) return one;

  let best = one;
  for (let rows = 2; rows <= affordable; rows++) {
    const perRow = Math.ceil(count / rows);
    const step = fanStep({ count: perRow, cardWidth, available });
    best = { rows, step, perRow };
    if (step >= readable) return best;
  }
  // Nothing inside the budget cleared the floor. The widest split it could
  // afford is still the most readable one available, so that is what it gets.
  return best;
}

/** Which row each card lands in, and how many rows there are. Pure. */
export function handRows({ count, rows }) {
  const perRow = Math.ceil(count / Math.max(1, rows));
  const out = [];
  for (let i = 0; i < count; i += perRow) out.push(Math.min(perRow, count - i));
  return out;
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
