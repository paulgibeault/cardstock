// THE TRICK BEFORE THIS ONE, a tap away.
//
// A completed trick is held on the felt for a beat (src/ui/roundBeat.js's
// trickRevealPlan) and then swept into somebody's won pile, which nobody may
// leaf through. So "what did Otto lead last time — and who took it?" — the
// question every trick table asks out loud — had no answer anywhere on screen
// once the hold was over. Most card tables answer it the same way: the last
// trick stays a tap away until the next one is complete.
//
// That is also what lets the trick hold stay SHORT. A player who can always
// look back is not losing anything when the four cards are swept on a clock.
//
// PURE MODEL, THEN DOM, in that order (the pattern src/ui/showCard.js sets): the
// felt that places it (src/ui/table.js) touches `document` at import and no
// Node test can load it, so what the peek says is a function a test can call.

import { makeCtx } from '../engine/context.js';
import { svgNode, line } from './dom.js';

/**
 * The trick just won, as a record: its cards in play order with the seat that
 * played each, who took it, and which hand it belonged to.
 *
 * WHO PLAYED WHAT IS THE TEMPLATE'S (`zoneCardOwners`, src/templates/
 * trick-taking.js), asked of the POSED position — the trick still on the table
 * with its leader, before the move resolved it (src/engine/poses.js). A guest
 * whose pose did not come, or a template that does not say, gets the cards
 * without the seats rather than seats that might be wrong.
 *
 * @param pose  the posed position the felt held the trick in, or null
 * @param trick the move's `trickWon` event: `{ seat, cards, trickNumber }`
 * @param round the hand this trick was part of — read off the position BEFORE
 *              the move, because a last trick that ended the hand is followed
 *              by a deal, and a peek at it from the next hand would be a peek
 *              into a hand that is over
 */
export function lastTrickOf(pose, trick, round) {
  if (!trick || !Array.isArray(trick.cards) || !trick.cards.length) return null;
  const ids = trick.cards.slice();
  let owners = null;
  let address = null;
  if (pose) {
    try {
      for (const candidate of pose.zones.allAddresses()) {
        const held = pose.zones.cards(candidate);
        if (!ids.every((id) => held.includes(id))) continue;
        address = candidate;
        const all = pose.pack.template.zoneCardOwners?.(makeCtx(pose), candidate);
        if (Array.isArray(all) && all.length === held.length) owners = ids.map((id) => all[held.indexOf(id)]);
        break;
      }
    } catch {
      owners = null;
    }
  }
  return {
    cards: ids.map((id, i) => ({ id, seat: Number.isInteger(owners?.[i]) ? owners[i] : null })),
    winner: Number.isInteger(trick.seat) ? trick.seat : null,
    n: trick.trickNumber ?? null,
    round,
    // Where the trick was played, so the peek can sit beside it; 'trick' is
    // trick-taking's name for it when there was no pose to find it in.
    address: address || 'trick',
  };
}

/**
 * Is there a last trick worth offering on this felt, right now?
 *
 * Only in the hand it belongs to, and only while play is live: during a held
 * trick the trick IS on the table, during a held hand the hand is, and in a
 * review the reel is the way back through the game.
 */
export function lastTrickOffered(record, state, { held = false } = {}) {
  return !!record && !held && !!state && !state.gameOver && record.round === state.roundNumber;
}

/**
 * The peek, as DOM: a small chip that opens a card of the four.
 *
 * @param record    lastTrickOf's answer
 * @param open      whether the card is showing
 * @param art       () => the open match's card renderer
 * @param cardOf    (id) => the card object, or null
 * @param nameOf    (card) => "Queen of Spades"
 * @param identity  (seat) => roster identity, for the mark under each card
 * @param label     (seat) => the name the table uses ("You", "Otto")
 * @param onToggle  () => void
 */
export function renderLastTrickPeek(record, {
  open = false, art, cardOf, nameOf, identity, label, onToggle, doc = globalThis.document,
} = {}) {
  if (!record || !doc) return null;
  const wrap = doc.createElement('div');
  wrap.className = `last-trick ${open ? 'last-trick--open' : ''}`;
  const chip = doc.createElement('button');
  chip.type = 'button';
  chip.className = 'last-trick__chip';
  chip.textContent = 'Last trick';
  chip.setAttribute('aria-expanded', String(open));
  chip.setAttribute('aria-label', lastTrickSentence(record, { label, cardOf, nameOf, open }));
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    onToggle?.();
  });
  wrap.appendChild(chip);
  if (!open) return wrap;

  const card = doc.createElement('div');
  card.className = 'last-trick__card';
  card.setAttribute('aria-hidden', 'true');
  const faces = doc.createElement('div');
  faces.className = 'last-trick__faces';
  for (const { id, seat } of record.cards) {
    const face = cardOf?.(id);
    const slot = doc.createElement('div');
    slot.className = `last-trick__slot ${seat != null && seat === record.winner ? 'last-trick__slot--won' : ''}`;
    if (face) slot.appendChild(svgNode(art().face(face), 'last-trick__face'));
    if (seat != null && identity) {
      const who = identity(seat);
      const mark = line('last-trick__mark', who.icon || who.initials || '');
      // Own value from the roster, never a manifest one — inline style (§7b).
      mark.style.background = who.color;
      slot.appendChild(mark);
    }
    faces.appendChild(slot);
  }
  card.appendChild(faces);
  if (record.winner != null && label) {
    card.appendChild(line('last-trick__who', `${label(record.winner)} took it`));
  }
  wrap.appendChild(card);
  return wrap;
}

/**
 * The peek in words — the chip's accessible name, because the card it opens is
 * decorative: "Last trick: You 9 of Clubs, Nell Queen of Hearts, … Nell took it."
 */
export function lastTrickSentence(record, {
  label = (s) => `Seat ${s}`, cardOf = () => null, nameOf = () => '', open = false,
} = {}) {
  if (!record) return '';
  const plays = record.cards.map(({ id, seat }) => {
    const card = cardOf(id);
    const name = card ? nameOf(card) : '';
    return [seat != null ? label(seat) : '', name].filter(Boolean).join(' ');
  }).filter(Boolean);
  const who = record.winner != null ? ` ${label(record.winner)} took it.` : '';
  return `Last trick: ${plays.join(', ')}.${who} ${open ? 'Tap to hide.' : 'Tap to show the cards.'}`;
}
