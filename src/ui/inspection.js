// THE HAND, OPENED: what the felt turns face up while a finished hand is looked
// at, as data.
//
// A hand used to end one floating card at a time. Each seat that the round
// priced got its own show card over the middle of the felt — "Nell's hand",
// tap, "Otto's hand", tap — while the seat plates above went on showing the
// backs of the very cards being counted, and the score sheet then came down
// over all of it. The cards were never where the players were.
//
// NOW THE BOARD IS THE DISPLAY. Every seat's ended hand turns face up ON ITS
// OWN PLATE, all at once, wearing what it cost; the sheet docks under the felt
// rather than over it and lists every count side by side; and a tap on a count
// lights the cards it was made of wherever they are on the table. One look,
// one decision — the deal — instead of a tap per seat.
//
// PURE, for the reason src/ui/showCard.js and src/ui/roundBeat.js are: the felt
// that draws this (src/ui/seatRow.js, src/ui/panels.js) touches `document` at
// import, so the only way "which cards does Otto's plate show" is ever checked
// is a function a Node test can call (tests/inspection.test.js).

import { showSteps } from './roundBeat.js';
import { isHiddenCardId } from './tableModel.js';

/**
 * Everything the felt needs to hold a hand open: the counts the round made, in
 * the order the rules made them.
 *
 * `counts` are the reveals (src/engine/scoring.js's `showScored`) — cribbage's
 * show and every card-pricing pack's leftover and penalty reveals — and are
 * empty for a pack that prices nothing at the boundary (Team Spades scores
 * tricks against bids, which the sheet's contract line says). They are empty on
 * a guest who caught up mid-sheet too: a snapshot carries no events.
 *
 * @param events  the move's event window
 * @param final   true when the hand that ended was the match's last
 */
export function inspectionOf(events, { final = false } = {}) {
  return { counts: showSteps(events), final: !!final };
}

/** The cards one seat holds in `shown`, or [] — never a placeholder for a hidden one. */
function handOf(shown, seat) {
  const address = `hand.${seat}`;
  if (!shown?.zones?.has?.(address)) return [];
  return shown.zones.cards(address).filter((id) => !isHiddenCardId(id));
}

/**
 * What one seat's plate turns face up while the hand is held, or null for a
 * plate that stays as it is.
 *
 * THE HAND THE SEAT WAS LEFT HOLDING comes first, read straight off the ending
 * position rather than off the events: it is the cards themselves, it is there
 * on a guest's open pose (src/engine/view.js's `opensAtHandEnd`) whether or not
 * an event survived, and it is there for a pack that prices nothing too — a
 * Crazy Eights hand is worth showing whatever the scoring made of it.
 *
 * A seat that played its whole hand out shows WHAT IT TOOK instead, when the
 * round priced that (Hearts' penalty cards, `reason: 'taken'`). Nothing else is
 * a seat's to show: a trick pile counted only by its height says that on the
 * sheet, and cribbage's counted hands are already face up in the middle of the
 * felt where they were pegged.
 *
 * @returns { cards, kind, points, counts } where `kind` is 'hand' | 'taken' |
 *   null, `points` is what the seat's own counts came to (null when it had
 *   none), and `counts` are those counts — the crib's included, because the
 *   dealer's crib is that seat's to score.
 */
export function plateReveal(shown, inspection, seat) {
  if (!inspection || !shown) return null;
  const counts = inspection.counts.filter((c) => c.seat === seat);
  const points = counts.length ? counts.reduce((sum, c) => sum + (Number(c.points) || 0), 0) : null;
  const hand = handOf(shown, seat);
  const taken = counts.find((c) => c.reason === 'taken');
  const cards = hand.length ? hand : (taken?.cards || []).slice();
  const kind = hand.length ? 'hand' : (cards.length ? 'taken' : null);
  if (!cards.length && points == null) return null;
  return { cards, kind, points, counts };
}

/**
 * Every card a count was made of, in the count's own order — the ids the felt
 * lights when the count is picked on the sheet.
 *
 * `extra` is the one card a count can use that is not its own: cribbage's cut
 * (`showStep`'s `starterId`), which every hand and the crib score with. A part
 * names its cards by POSITION in `[...count.cards, extra]` (src/templates/
 * cribbage.js's `partsOf`), which is why the cut has to be appended rather than
 * looked up.
 */
export function countCardIds(count, extra = null) {
  return aligned(count, extra).filter(Boolean);
}

/** The ids one part of a count was made of — a fifteen, a pair, a run. */
export function partCardIds(count, part, extra = null) {
  const all = aligned(count, extra);
  return (Array.isArray(part?.at) ? part.at : []).map((i) => all[i]).filter(Boolean);
}

/**
 * The count's cards with the cut appended, POSITION FOR POSITION: a card this
 * device may not name is a null in its place rather than a gap, or every part
 * after it would point one card along.
 */
function aligned(count, extra) {
  const own = (Array.isArray(count?.cards) ? count.cards : [])
    .map((id) => (typeof id === 'string' && !isHiddenCardId(id) ? id : null));
  return extra ? [...own, extra] : own;
}
