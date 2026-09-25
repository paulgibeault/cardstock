// THE MAP AND THE REEL, DRAWN — the review UI's two surfaces, as a model and
// then as DOM (the pattern src/ui/showCard.js and src/ui/counterTrack.js set:
// pure first, so a Node test can ask what the map would say; DOM second, so
// src/ui/reviewController.js only has to put it somewhere).
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
// and the felt behind it renders through whatever lens
// src/ui/reviewController.js chose.

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

/** The words a beat's head prints for its kind. */
function beatTitle(beat) {
  switch (beat.kind) {
    case 'trick': return `Trick ${beat.n}`;
    case 'count': return `Count ${beat.n}`;
    case 'lap': return `Round ${beat.n} of the table`;
    case 'pass': return 'The pass';
    case 'bidding': return 'The bidding';
    case 'meld': return 'The meld';
    default: return `Beat ${beat.n}`;
  }
}

/**
 * The map, as data: hands, then BEATS (src/stats/timeline.js's beatsOf), then
 * the plays inside each.
 *
 * A collapsed beat shows who won it and with what; opened, every play in order
 * with the winning one marked. The beat and the play the felt is standing in
 * are `current`, and the current beat starts open.
 *
 * @returns {{ hands: [{ round, title, result, live, beats: [{ from, to, kind,
 *   title, winner, winnerLabel, cards, points, current, open, plays: [{ from,
 *   seat, label, cards, passed, won, texts, marks, current }] }] }] }}
 */
export function reviewMapModel(timeline, { index = 0, labelOf = (s) => `Seat ${s + 1}` } = {}) {
  const hands = timeline.hands.map((hand, h) => {
    const beats = (timeline.beats || []).filter((b) => b.hand === h).map((beat) => {
      const current = beat.from <= index && index < beat.to
        || (index >= timeline.length && beat.to === timeline.length);
      const plays = beat.plays.map((play) => {
        const label = labelOf(play.seat);
        const prefix = `${label} `;
        const moves = timeline.moves.slice(play.from, play.to);
        const marks = [];
        for (const move of moves) {
          for (const mark of move.marks) {
            const text = markText(mark, play.seat, labelOf);
            if (text && !marks.includes(text)) marks.push(text);
          }
        }
        return {
          from: play.from,
          seat: play.seat,
          label,
          cards: play.cards,
          passed: play.passed,
          won: play.won,
          texts: moves.map((m) => (m.text.startsWith(prefix) ? m.text.slice(prefix.length) : m.text)),
          marks,
          current: play.from <= index && index < play.to,
        };
      });
      return {
        from: beat.from,
        to: beat.to,
        kind: beat.kind,
        title: beatTitle(beat),
        winner: beat.winner,
        winnerLabel: beat.winner == null ? '' : labelOf(beat.winner),
        // The head's faces: what won it, or — where nothing wins a lap — every
        // card that was played in it.
        cards: beat.winner == null ? beat.plays.flatMap((p) => p.cards) : beat.winning,
        points: beat.points,
        current,
        open: current,
        plays,
      };
    });
    const result = hand.live
      ? 'in play'
      : hand.totals.map((total, seat) => `${labelOf(seat)} ${total}`).join(' · ');
    // One chip per seat for the header: the running total, and what this hand
    // did to it — the same two numbers the round sheet prints.
    const standings = hand.totals.map((total, seat) => ({
      seat,
      label: labelOf(seat),
      total,
      delta: hand.scores ? (hand.scores[seat] ?? 0) : null,
    }));
    return {
      round: hand.round,
      title: `Hand ${hand.round}`,
      of: timeline.hands.length,
      result,
      standings,
      live: hand.live,
      beats,
    };
  });
  return { hands };
}

/**
 * The position a beat's head stands the felt at: the winning play landed and
 * still on the table. When the winning play is the last move of the beat (the
 * fourth card of a trick, which is gathered inside its own move) the moment
 * before it is the honest picture — three cards down and the winner to play.
 */
export function beatMoment(beat) {
  const won = beat.plays.find((p) => p.won);
  if (!won) return beat.from;
  const next = beat.plays[beat.plays.indexOf(won) + 1];
  return next ? next.from : won.from;
}

function faces(doc, ids, { art, cardOf }) {
  const wrap = doc.createElement('span');
  wrap.className = 'review-cards';
  for (const id of ids) {
    const card = cardOf ? cardOf(id) : null;
    if (card && art) wrap.appendChild(svgNode(art().face(card), 'review-card'));
    else wrap.appendChild(line('review-card review-card--named', String(id)));
  }
  return wrap;
}

/**
 * The map, as DOM.
 *
 * A beat's head is a button that opens and closes it (`aria-expanded`) and
 * calls `onBeat(beat)`; a play inside is a button that calls `onSeek(from)`.
 * `paintReviewCursor` below moves the highlight without rebuilding any of it.
 */
export function renderReviewMap(model, { doc = globalThis.document, art, cardOf, onSeek, onBeat } = {}) {
  const root = doc.createElement('div');
  root.className = 'review-map';
  for (const hand of model.hands) {
    const section = doc.createElement('section');
    section.className = 'review-hand';
    // A HAND IS A CHAPTER, and it has to look like one next to the tricks
    // under it: a band across the list, the title large, and a chip per seat
    // with the total and what the hand did to it.
    const head = doc.createElement('div');
    head.className = `review-hand__head ${hand.live ? 'review-hand__head--live' : ''}`;
    const titleRow = doc.createElement('div');
    titleRow.className = 'review-hand__titlerow';
    titleRow.appendChild(line('review-hand__title', hand.title));
    titleRow.appendChild(line('review-hand__of', hand.live ? 'in play' : `of ${hand.of}`));
    head.appendChild(titleRow);
    const standings = doc.createElement('div');
    standings.className = 'review-hand__standings';
    for (const s of hand.standings) {
      const chip = doc.createElement('span');
      chip.className = 'review-hand__chip';
      chip.appendChild(line('review-hand__chip-name', s.label));
      chip.appendChild(line('review-hand__chip-total', String(s.total)));
      if (s.delta != null && s.delta !== 0) {
        chip.appendChild(line('review-hand__chip-delta', `${s.delta > 0 ? '+' : ''}${s.delta}`));
      }
      standings.appendChild(chip);
    }
    head.appendChild(standings);
    section.appendChild(head);
    for (const beat of hand.beats) {
      const node = doc.createElement('div');
      node.className = `review-beat ${beat.current ? 'review-beat--current' : ''} ${beat.open ? 'review-beat--open' : ''}`;
      node.dataset.from = String(beat.from);
      node.dataset.to = String(beat.to);

      const headBtn = doc.createElement('button');
      headBtn.type = 'button';
      headBtn.className = 'review-beat__head';
      headBtn.setAttribute('aria-expanded', String(!!beat.open));
      headBtn.appendChild(line('review-beat__title', beat.title));
      const who = doc.createElement('span');
      who.className = 'review-beat__who';
      if (beat.winner != null) {
        who.appendChild(line('review-beat__winner', beat.winnerLabel));
        if (beat.points != null && beat.points !== 0) {
          who.appendChild(line('review-beat__points', `${beat.points > 0 ? '+' : ''}${beat.points}`));
        }
      } else {
        who.appendChild(line('review-beat__winner review-beat__winner--none', `${beat.plays.length} play${beat.plays.length === 1 ? '' : 's'}`));
      }
      headBtn.appendChild(who);
      headBtn.appendChild(faces(doc, beat.cards, { art, cardOf }));
      headBtn.addEventListener('click', () => {
        const open = !node.classList.contains('review-beat--open');
        node.classList.toggle('review-beat--open', open);
        headBtn.setAttribute('aria-expanded', String(open));
        onBeat?.(beat, open);
      });
      node.appendChild(headBtn);

      const list = doc.createElement('div');
      list.className = 'review-beat__plays';
      for (const play of beat.plays) {
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = `review-play ${play.won ? 'review-play--won' : ''} ${play.current ? 'review-play--current' : ''}`;
        row.dataset.from = String(play.from);
        if (play.current) row.setAttribute('aria-current', 'true');
        row.appendChild(line('review-play__seat', play.label));
        if (play.passed) {
          row.appendChild(line('review-play__passed', 'passed'));
        } else {
          row.appendChild(faces(doc, play.cards, { art, cardOf }));
        }
        const words = doc.createElement('span');
        words.className = 'review-play__words';
        if (!play.passed || play.texts.some((t) => t !== 'passed')) words.appendChild(line('review-play__text', play.texts.join('; ')));
        if (play.marks.length) words.appendChild(line('review-play__marks', play.marks.join(' · ')));
        row.appendChild(words);
        row.addEventListener('click', () => onSeek?.(play.from));
        list.appendChild(row);
      }
      node.appendChild(list);
      section.appendChild(node);
    }
    root.appendChild(section);
  }
  return root;
}

/**
 * Move the map's highlight to position `index` in place — no rebuild, because
 * a long match is hundreds of drawn faces and the reel steps through it one
 * tap at a time. Opens the beat the felt is standing in and scrolls it into
 * view.
 */
export function paintReviewCursor(root, timeline, index) {
  if (!root) return;
  const atEnd = index >= timeline.length;
  for (const node of root.querySelectorAll('.review-beat')) {
    const from = Number(node.dataset.from);
    const to = Number(node.dataset.to);
    const current = (from <= index && index < to) || (atEnd && to === timeline.length);
    node.classList.toggle('review-beat--current', current);
    if (current && !node.classList.contains('review-beat--open')) {
      node.classList.add('review-beat--open');
      node.querySelector('.review-beat__head')?.setAttribute('aria-expanded', 'true');
    }
  }
  const turn = timeline.turns.find((t) => t.from <= index && index < t.to) || null;
  for (const row of root.querySelectorAll('.review-play')) {
    const current = !!turn && Number(row.dataset.from) === turn.from;
    row.classList.toggle('review-play--current', current);
    if (current) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
  const target = root.querySelector('.review-play--current') || root.querySelector('.review-beat--current');
  target?.scrollIntoView({ block: 'nearest' });
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
