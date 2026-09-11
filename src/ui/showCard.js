// THE SHOW, DRAWN RATHER THAN SAID.
//
// Cribbage's show is the scoring moment of the whole game and the felt used to
// spend one sentence on it: "Nell's hand is worth 8 — fifteen, fifteen, a pair
// and a run of three", in a banner, for a second and a half, over four cards
// the player then had to re-count for themselves to see where any of it came
// from (#152). Everything needed to SHOW it was already on the event: the cards
// scored, the combinations, what each one was worth.
//
// So this is a card, not a caption — the name, the five faces, one row per
// combination with its points, and the total — and it replaces the banner for
// `showScored` while the same sentence still goes to #log.
//
// PURE MODEL, THEN DOM, in one file and in that order (the pattern
// src/ui/counterTrack.js sets): src/ui/table.js touches `document` at import
// and can never be loaded by a Node test, so a model that can be asserted
// without a browser is the only way any of this arithmetic is ever checked
// (tests/showCard.test.js). `showCardModel` knows nothing about elements;
// `renderShowCard` knows nothing about cribbage.
//
// NINETEEN. A hand worth nothing is called a nineteen, because nineteen is the
// lowest score five cards cannot make (`IMPOSSIBLE_SHOWS` in
// src/templates/cribbage-score.js is the same joke, written down). A zero on a
// card that otherwise lists combinations reads like a bug; the word reads like
// the game.
//
// BATTERY RULE (cardstock#24): the card fades in once and then sits there. No
// keyframe in this component loops, and the highlight is a transition.

import { svgNode, line } from './dom.js';
import { partPhrase } from '../templates/cribbage-score.js';

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
} = {}) {
  const title = `${String(whose || '').trim()} ${isCrib ? 'crib' : 'hand'}`.trim();

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

  const zero = !rows.length || !points;
  const spoken = rows.map((r) => `${r.label} ${r.points}`).join(', ');

  return {
    title,
    faces,
    rows: zero ? [] : rows,
    total: points || 0,
    zero,
    // For the log line and for anything that wants one string. The felt's own
    // sentence is the template's (`describeEvent`); this is the card read out.
    aria: zero
      ? `${title}: ${NINETEEN} — nothing.`
      : `${title}: ${spoken} — ${points}.`,
  };
}

/**
 * The card, as DOM.
 *
 * `doc` is a parameter rather than the global for the same reason
 * `renderCounterTrack` takes one: so this file can be loaded by a test.
 *
 * DECORATIVE BY CONSTRUCTION, exactly like #event-banner, which is what it
 * replaces: #log is the live region and carries the same sentence, so the whole
 * card is aria-hidden and nothing in it is focusable. A transient overlay that
 * lived for a second and a half and put five buttons in the tab order while it
 * did would be a worse table for everybody.
 *
 * @param art  () => the open match's card renderer, for the faces
 */
export function renderShowCard(model, { doc = globalThis.document, art } = {}) {
  if (!model || !doc) return null;

  const card = doc.createElement('div');
  card.className = 'show-card';
  card.setAttribute('aria-hidden', 'true');
  card.appendChild(line('show-card__title', model.title));

  const faces = doc.createElement('div');
  faces.className = 'show-card__faces';
  for (const face of model.faces) {
    const slot = art ? svgNode(art().face(face.card), 'show-card__face') : doc.createElement('span');
    if (!art) slot.className = 'show-card__face';
    slot.dataset.at = String(face.at);
    // THE CUT IS NOT ONE OF YOURS, and every combination on the card may or may
    // not use it — which is the single most-argued fact at a cribbage table.
    // Set apart rather than labelled: one gap says it in no words.
    if (face.starter) slot.classList.add('show-card__face--starter');
    faces.appendChild(slot);
  }
  card.appendChild(faces);

  if (model.zero) {
    card.appendChild(line('show-card__nineteen', NINETEEN));
  } else {
    const list = doc.createElement('div');
    list.className = 'show-card__parts';
    for (const row of model.rows) {
      const item = doc.createElement('div');
      item.className = 'show-card__part';
      if (row.at.length) item.dataset.at = row.at.join(' ');
      item.appendChild(line('show-card__part-name', row.label));
      item.appendChild(line('show-card__part-points', String(row.points)));
      list.appendChild(item);
    }
    card.appendChild(list);

    const total = doc.createElement('div');
    total.className = 'show-card__total';
    total.appendChild(line('show-card__total-label', 'Total'));
    total.appendChild(line('show-card__total-points', String(model.total)));
    card.appendChild(total);
  }

  wireHighlight(card);
  return card;
}

/**
 * WHICH CARDS MADE THIS ONE — under the cursor, or under a finger.
 *
 * The positions are on the rows already (`data-at`), so this is a class on the
 * faces and nothing else: no state, no re-render, and it survives the card
 * being thrown away at the next step because it never lived anywhere but the
 * nodes. Pointer events rather than `:hover`, because a phone has no hover and
 * the fifteens are exactly what a player wants to poke at.
 *
 * `pointerdown` rather than `click`: this card is replaced by the next step's
 * in a second and a half and a tap that has to complete to do anything would
 * often not.
 */
function wireHighlight(card) {
  const faces = card.querySelectorAll('.show-card__face');
  const clear = () => faces.forEach((f) => f.classList.remove('show-card__face--lit'));
  const light = (item) => {
    clear();
    const at = (item.dataset.at || '').split(/\s+/).filter(Boolean);
    for (const face of faces) if (at.includes(face.dataset.at)) face.classList.add('show-card__face--lit');
  };
  for (const item of card.querySelectorAll('.show-card__part[data-at]')) {
    item.addEventListener('pointerenter', () => light(item));
    item.addEventListener('pointerdown', () => light(item));
    item.addEventListener('pointerleave', clear);
  }
}
