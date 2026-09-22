// THE MAP AND THE REEL, DRAWN — the review UI's two surfaces, as a model and
// then as DOM (the pattern src/ui/showCard.js and src/ui/counterTrack.js set:
// pure first, so a Node test can ask what the map would say; DOM second, so
// src/ui/table.js only has to put it somewhere).
//
// THE MAP is the scrollable record of the game: one section per hand with its
// result, one row per turn with the seat, the cards it played (drawn, not
// named — "showing each played card" was the ask) and the sentence for each
// move, plus what the turn caused (a trick taken, a declaration). Every row is
// a door: tapping it stands the felt at the start of that turn.
//
// THE REEL is the bar under the felt while reviewing: previous hand, previous
// turn, where you are, next turn, next hand, and the way back to the game.
//
// What either of them shows of HIDDEN cards is not decided here: the map draws
// the cards the LOG names (a played card is public by the time it is played),
// and the felt behind it renders through whatever lens table.js chose.

import { line, svgNode } from './dom.js';
import { baseId } from '../engine/selectors.js';
import { seekTargets, positionLabel } from '../stats/timeline.js';

/** One mark as the words the map prints beside a turn, or null to say nothing. */
function markText(mark, turnSeat, labelOf) {
  const who = mark.seat == null ? '' : labelOf(mark.seat);
  switch (mark.type) {
    case 'trickWon': return mark.seat === turnSeat ? 'takes the trick' : `${who} takes the trick`;
    case 'trickCleared': return mark.seat === turnSeat ? 'takes the pile' : `${who} takes the pile`;
    case 'roundOver': return mark.over ? 'the match ends' : 'the hand ends';
    case 'announced': return mark.label ? `says “${mark.label}”` : 'declares';
    case 'caught': return `${who} is caught`;
    case 'instantWin': return 'an instant win';
    default: return null;
  }
}

/**
 * The map, as data.
 *
 * @param timeline a matchTimeline()
 * @param index    the position the felt is standing at
 * @param labelOf  (seat) => name
 * @returns {{ hands: [{ round, title, result, live, turns: [{ from, seat,
 *   label, texts, cards, marks, current }] }] }}
 */
export function reviewMapModel(timeline, { index = 0, labelOf = (s) => `Seat ${s + 1}` } = {}) {
  const hands = timeline.hands.map((hand, h) => {
    const turns = timeline.turns
      .filter((t) => t.hand === h)
      .map((turn) => {
        const moves = timeline.moves.slice(turn.from, turn.to);
        const marks = [];
        for (const move of moves) {
          for (const mark of move.marks) {
            const text = markText(mark, turn.seat, labelOf);
            if (text && !marks.includes(text)) marks.push(text);
          }
        }
        const label = labelOf(turn.seat);
        // The seat column already says who, so the row's words start at the
        // verb: "played 3 of Spades" beside "You", not "You played..." twice.
        const prefix = `${label} `;
        return {
          from: turn.from,
          seat: turn.seat,
          label,
          texts: moves.map((m) => (m.text.startsWith(prefix) ? m.text.slice(prefix.length) : m.text)),
          cards: moves.flatMap((m) => m.cards),
          marks,
          // The row the felt is standing on: the turn that contains the
          // position, so a scrub that lands mid-turn still lights one row.
          current: turn.from <= index && index < turn.to,
        };
      });
    const result = hand.live
      ? 'in play'
      : hand.totals.map((total, seat) => `${labelOf(seat)} ${total}`).join(' · ');
    return { round: hand.round, title: `Hand ${hand.round}`, result, live: hand.live, turns };
  });
  return { hands };
}

/**
 * The map, as DOM. Each row is a button that calls `onSeek(from)`.
 *
 * @param art    () => the open match's card renderer, for the faces
 * @param cardOf (id) => the card record, or null
 */
export function renderReviewMap(model, { doc = globalThis.document, art, cardOf, onSeek } = {}) {
  const root = doc.createElement('div');
  root.className = 'review-map';
  for (const hand of model.hands) {
    const section = doc.createElement('section');
    section.className = 'review-hand';
    const head = doc.createElement('div');
    head.className = 'review-hand__head';
    head.appendChild(line('review-hand__title', hand.title));
    head.appendChild(line('review-hand__result', hand.result));
    section.appendChild(head);
    for (const turn of hand.turns) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = `review-turn ${turn.current ? 'review-turn--current' : ''}`;
      row.dataset.from = String(turn.from);
      if (turn.current) row.setAttribute('aria-current', 'true');
      row.appendChild(line('review-turn__seat', turn.label));
      const cards = doc.createElement('span');
      cards.className = 'review-turn__cards';
      for (const id of turn.cards) {
        const card = cardOf ? cardOf(id) : null;
        if (card && art) cards.appendChild(svgNode(art().face(card), 'review-card'));
        else cards.appendChild(line('review-card review-card--named', String(id)));
      }
      row.appendChild(cards);
      const words = doc.createElement('span');
      words.className = 'review-turn__words';
      words.appendChild(line('review-turn__text', turn.texts.join('; ')));
      if (turn.marks.length) words.appendChild(line('review-turn__marks', turn.marks.join(' · ')));
      row.appendChild(words);
      row.addEventListener('click', () => onSeek?.(turn.from));
      section.appendChild(row);
    }
    root.appendChild(section);
  }
  return root;
}

/** What the reel shows and where each of its buttons goes. */
export function reviewBarModel(timeline, index, labelOf) {
  const targets = seekTargets(timeline, index);
  return {
    label: positionLabel(timeline, index, labelOf),
    ...targets,
    atEnd: index >= timeline.length,
  };
}
