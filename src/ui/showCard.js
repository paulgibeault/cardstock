// THE SHOW, DRAWN RATHER THAN SAID.
//
// Cribbage's show is the scoring moment of the whole game and the felt used to
// spend one sentence on it: "Nell's hand is worth 8 — fifteen, fifteen, a pair
// and a run of three", in a banner, for a second and a half, over four cards
// the player then had to re-count for themselves to see where any of it came
// from (#152). Everything needed to SHOW it was already on the event: the cards
// scored, the combinations, what each one was worth.
//
// So a count became a card, not a caption — the name, the faces, one row per
// combination with its points, and the total. It was a floating card over the
// middle of the felt, one count at a time; it is now one block per count on the
// docked round sheet, all of them at once, each a way to light its own cards on
// the board (src/ui/inspection.js, src/ui/panels.js's `countsCell`). This model
// is what every block is drawn from.
//
// PURE, and only a model now: src/ui/table.js touches `document` at import and
// can never be loaded by a Node test, so a model that can be asserted without a
// browser is the only way any of this arithmetic is ever checked
// (tests/showCard.test.js).
//
// NINETEEN. A hand worth nothing is called a nineteen, because nineteen is the
// lowest score five cards cannot make (`IMPOSSIBLE_SHOWS` in
// src/templates/cribbage-score.js is the same joke, written down). A zero on a
// card that otherwise lists combinations reads like a bug; the word reads like
// the game.

// WHAT A PART IS CALLED, from the file that documents the event it rides on
// (`showScored`, src/engine/scoring.js). This used to be
// `import { partPhrase } from '../templates/cribbage-score.js'` — a platform
// renderer naming one template's module, and the reveal's own `held` rows spelled
// out a second time here because that module had never heard of them (#219).
import { partPhrase } from '../engine/scoring.js';

/** What a hand worth nothing is called. */
export const NINETEEN = 'nineteen';

/**
 * The card, as data.
 *
 * @param whose   the possessive the table uses for this seat — "Your", "Nell's"
 *                (src/ui/table.js's `seatPossessive`). The one label in the
 *                vocabulary that does not take an apostrophe-s is "You", which
 *                is exactly why this is not built here out of a name.
 * @param isCrib  the crib's step rather than a hand's
 * @param points  what the event says it scored — the AUTHORITY for the total,
 *                never the sum of the rows. They agree, and a card that
 *                silently re-derived the number would be the one surface that
 *                could disagree with the peg that has already moved.
 * @param parts   the event's breakdown: `{ kind, points, n, at }`, where `at` is
 *                the positions in `cards` the part was made of (see `partsOf`
 *                in src/templates/cribbage.js — positions, not card ids).
 * @param cards   the scored card objects in event order: the four held (or the
 *                crib), then the starter. Nulls are tolerated and dropped; a
 *                remote client has no ids and therefore no cards at all.
 * @param starterAt which position in `cards` is the cut. Null when there is none.
 *
 * @returns { title, faces, rows, total, zero, aria }
 */
export function showCardModel({
  whose = '', isCrib = false, points = 0, parts = [], cards = [], starterAt = null,
  what = null, zeroLabel = NINETEEN,
} = {}) {
  const title = `${String(whose || '').trim()} ${what || (isCrib ? 'crib' : 'hand')}`.trim();

  const faces = (Array.isArray(cards) ? cards : [])
    .map((card, at) => (card ? { card, at, starter: at === starterAt } : null))
    .filter(Boolean);

  const rows = (Array.isArray(parts) ? parts : [])
    .map((part) => {
      const label = partPhrase(part);
      if (!label) return null;
      return {
        label,
        points: part.points ?? 0,
        // Only the positions this card is actually drawing. A part whose cards
        // fell outside the list (which is every part on a remote client, where
        // the ids were stripped before the positions were computed) highlights
        // nothing rather than highlighting the wrong faces.
        at: (Array.isArray(part.at) ? part.at : []).filter((i) => faces.some((f) => f.at === i)),
      };
    })
    .filter(Boolean);

  // A ZERO IS NOT ALWAYS A NINETEEN. Cribbage's word for a hand worth nothing
  // is the caller's default; a reveal (src/engine/scoring.js) of cards that
  // happened to cost nothing says so in plain words, because the joke belongs
  // to one game.
  const zero = !rows.length || !points;
  const spoken = rows.map((r) => `${r.label} ${r.points}`).join(', ');

  return {
    title,
    faces,
    rows: zero ? [] : rows,
    total: points || 0,
    zero,
    zeroLabel,
    // For the log line and for anything that wants one string. The felt's own
    // sentence is the template's (`describeEvent`); this is the card read out.
    aria: zero
      ? `${title}: ${zeroLabel} — nothing.`
      : `${title}: ${spoken} — ${points}.`,
  };
}
