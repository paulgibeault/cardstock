// Table moments: what the felt SAYS and SHOWS when something happens.
//
// Extracted from src/ui/table.js because every function here is read-only over
// the state and the move's event window — the same posture as src/ui/panels.js.
// Nothing in this file decides anything; it narrates.
//
// THE EVENT VOCABULARY IS OPEN, in three layers, because a closed one meant a
// pack-defined effect could change the game and leave the banner blank:
//   1. the event's own `say: { text, tone }`, for an effect that already knows
//      its own sentence when it emits;
//   2. the template's `describeEvent(ev)`, for a genre that narrates its own;
//   3. the built-ins below, which are the engine effects library's own events
//      (src/engine/effects.js) and therefore genuinely platform-level.
// The candidate set is "every event that yields a sentence" rather than a
// hardcoded list of six names — an event nobody describes returns null and the
// next one is tried, which is what every non-action event does.

import { flyCard, motionAllowed, rectOf, cardSizedRect } from './flight.js';
import { safeCssColor } from './css.js';
import { handAddress } from './interaction.js';
import { playTrickTaken, playActionCard } from '../arcade/audio.js';

/**
 * @param me          the seat lens (src/players/seats.js); everything is worded
 *                    from the point of view of the seat it names
 * @param seatLabel   (seat) => the name to put in a sentence
 * @param currentEpoch () => the table's epoch; a delayed flight checks it
 * @param elements    { table, eventBanner, log, hand, opponentsTop }
 * @param art         () => the open match's card renderer
 * @param zoneRect    (address) => rect
 * @param seatRect    (seat) => rect
 * @param pulseSeat   (seat, tone) => void
 * @param cardById    (state, id) => card
 */
export function createCelebrations({
  me, seatLabel, currentEpoch, el, art, zoneRect, seatRect, pulseSeat, cardById,
}) {
  /**
   * How many penalty cards are worth watching arrive.
   *
   * A Draw 4 is four. `effect.n` and `lastCardCall.penalty.draw` are pack values
   * though, and a pack that says forty would otherwise buy forty timers and forty
   * SVG copies for a moment that is over in a second. The banner says the real
   * number; this is only how many of them fly.
   */
  const PENALTY_FLIGHT_MAX = 6;

  /**
   * A handful of cards, seen to leave the deck.
   *
   * A DRAW YOU DID NOT ASK FOR WAS THE ONE DRAW THE TABLE NEVER SHOWED. A Draw 4
   * is the most violent thing anybody plays and it happened as a number changing
   * on a seat plate: the banner said "You draw 4", the hand was suddenly four
   * cards wider, and nothing connected the two. animateMove covers the draw a
   * player MAKES, because that flight starts under the finger that asked for it.
   * This covers the ones handed to you — a Draw 2, a Draw 4, and the cards a
   * missed "Last card!" costs, which is the same event wearing another name.
   *
   * The cards that actually arrived are the last `count` of the hand: every draw
   * appends (src/templates/shedding.js), and the display order the fan is in is a
   * VIEW that never reaches the zone. Face-up for the human, who is about to sort
   * them anyway; a bot's penalty flies backs, because the table does not know
   * what a bot was dealt any more than you do.
   */
  function animatePenaltyDraw(state, seat, count, delay) {
    if (!count || count < 1 || !motionAllowed()) return;
    const from = zoneRect('draw');
    if (!from) return;
    // MEASURED ONCE, FOR COPIES THAT LEAVE UP TO HALF A SECOND LATER. That is
    // safe only because `seatRect` answers with where the seat will BE rather
    // than where it is (scrollCorrectedRect, src/ui/flight.js): while the seat
    // row was still smooth-scrolling, the first copy landed on the right plate
    // and the last one landed on the neighbour's — which is the "sometimes one
    // of the cards goes for a ride" the playtest reported.
    const to = cardSizedRect(seatRect(seat), from.width);
    if (!to) return;

    const ids = me.holds(seat)
      ? state.zones.cards(handAddress(seat)).slice(-count)
      : [];
    const myEpoch = currentEpoch();
    for (let i = 0; i < Math.min(count, PENALTY_FLIGHT_MAX); i++) {
      const card = ids.length ? cardById(state, ids[i]) : null;
      // Dealt one after another rather than as a fan, because that is what makes
      // four read as FOUR — a single flight of four overlapping copies is one
      // event, and the count is the whole insult.
      Arcade.session.setTimeout(() => {
        if (myEpoch !== currentEpoch()) return;
        flyCard(card ? art().face(card) : art().back(), from, to,
          { fade: true, duration: 300 });
      }, delay + i * 110);
    }
  }

  /* ------------------------------------------------------------------ *
   * Table moments: banners, trick gathers, round summaries
   * ------------------------------------------------------------------ */

  function hideBanner(session) {
    if (session?.bannerTimer) session.bannerTimer.cancel();
    if (session) session.bannerTimer = null;
    el.eventBanner.hidden = true;
  }

  /**
   * The celebration layer. Decorative by construction — #log (a live region)
   * carries the same sentence — so it is aria-hidden and free to be theatrical.
   * `tone` is 'good' | 'bad' | 'neutral': winning a clean trick sparkles, eating
   * the queen of spades stings, a bot's trick just gets noted.
   */
  function showBanner(session, text, tone) {
    if (session.bannerTimer) session.bannerTimer.cancel();
    el.eventBanner.textContent = text;
    el.eventBanner.className = `event-banner event-banner--${tone}`;
    el.eventBanner.hidden = false;
    // Restart the entrance animation when banners come back-to-back.
    void el.eventBanner.offsetWidth;
    el.eventBanner.classList.add('event-banner--in');
    const myEpoch = currentEpoch();
    session.bannerTimer = Arcade.session.setTimeout(() => {
      session.bannerTimer = null;
      if (myEpoch !== currentEpoch()) return;
      el.eventBanner.hidden = true;
    }, 2200);
  }

  /**
   * A trick resolving: gather its cards to the winner's seat, say what it cost,
   * and celebrate — or wince. The engine already moved the cards (they left the
   * trick zone before this render), so the gather flies COPIES from where the
   * trick was to where it went, the same clone-and-animate deal every card
   * flight uses.
   */
  function celebrateTrick(session, state, ev) {
    const mine = me.holds(ev.seat);
    const bad = mine && ev.points > 0;

    const from = zoneRect('trick');
    // One measurement, several copies, the last of them 550ms behind the first
    // — see animatePenaltyDraw above for why that no longer scatters them
    // across two plates.
    const to = from ? cardSizedRect(seatRect(ev.seat), from.width * 0.6) : null;
    if (from && to && motionAllowed()) {
      const myEpoch = currentEpoch();
      ev.cards.forEach((cardId, i) => {
        const card = cardById(state, cardId);
        if (!card) return;
        Arcade.session.setTimeout(() => {
          if (myEpoch !== currentEpoch()) return;
          flyCard(art().face(card), from, to, { fade: true, duration: 320 });
        }, 140 + i * 70);
      });
    }

    const text = mine
      ? (ev.points > 0 ? `You take the trick — ${ev.points} point${ev.points === 1 ? '' : 's'} against you` : 'Trick is yours — no points')
      : `${seatLabel(ev.seat)} takes the trick${ev.points > 0 ? ` (+${ev.points})` : ''}`;
    showBanner(session, text, mine ? (bad ? 'bad' : 'good') : 'neutral');
    el.log.textContent = text;
    playTrickTaken({ bad });

    pulseSeat(ev.seat, bad ? 'bad' : 'good');
  }

  /* ------------------------------------------------------------------ *
   * Action cards, made visible
   * ------------------------------------------------------------------ */

  /**
   * What each action event says on the felt, from the point of view of whoever
   * is reading it.
   *
   * `seat` on these events is always the seat it HAPPENED TO, which is the one
   * fact the wording turns on: the same Draw 4 is a small triumph when you play
   * it and an outrage when you eat it, and a table that narrated both the same
   * way would be describing the cards rather than the game.
   */
  function defaultEventText(ev) {
    const you = (seat) => me.holds(seat);
    const name = (seat) => (you(seat) ? 'You' : seatLabel(seat));

    if (ev.type === 'skipped') {
      return you(ev.seat)
        ? { text: 'Skipped — your turn is gone', tone: 'bad' }
        : { text: `${name(ev.seat)} is skipped`, tone: you(ev.by) ? 'good' : 'neutral' };
    }
    if (ev.type === 'reversed') {
      return { text: 'Direction reversed', tone: 'neutral' };
    }
    if (ev.type === 'penalty') {
      if (!ev.drew) return null; // the pile was empty; nothing actually happened
      const n = ev.drew;
      return you(ev.seat)
        ? { text: `You draw ${n} and lose your turn`, tone: 'bad' }
        : { text: `${name(ev.seat)} draws ${n}`, tone: you(ev.by) ? 'good' : 'neutral' };
    }
    if (ev.type === 'wildPlayed') {
      const chose = Object.values(ev.chose || {})[0];
      if (!chose) return null;
      return { text: `${name(ev.seat)} chose ${chose}`, tone: 'neutral' };
    }
    if (ev.type === 'handsSwapped') {
      // Only "You" has a lower-case form; a name is a proper noun. This used to
      // lower-case whatever landed in the object position, which nobody had seen
      // because the swap itself never fired — "You swapped hands with delphine".
      const object = you(ev.seat) ? 'you' : name(ev.seat);
      return { text: `${name(ev.by)} swapped hands with ${object}`, tone: 'neutral' };
    }
    if (ev.type === 'handsRotated') {
      return { text: 'Every hand moves round', tone: 'neutral' };
    }
    return null;
  }

  /**
   * What an emitted event SAYS, or null for the many that say nothing on the felt.
   *
   * AN OPEN VOCABULARY, IN THREE LAYERS, because a closed one meant a pack-defined
   * effect could change the game and leave the banner blank:
   *
   *   1. the event's own `say: { text, tone }`, for an effect that already knows
   *      its own sentence when it emits;
   *   2. the template's `describeEvent(ev)`, for a genre that narrates its own;
   *   3. the built-ins above, which are the engine effects library's own events
   *      (src/engine/effects.js) and therefore genuinely platform-level.
   *
   * The candidate set is "every event that yields a sentence" rather than a
   * hardcoded list of six names — an event nobody describes simply returns null
   * and the next one is tried, which is what every non-action event does.
   */
  function eventText(state, ev) {
    if (ev.say && typeof ev.say.text === 'string') {
      return { text: ev.say.text, tone: ev.say.tone || 'neutral' };
    }
    return state.pack.template.describeEvent?.(ev, { seatLabel, viewerSeat: me.seat() })
      ?? defaultEventText(ev);
  }

  /**
   * Announce an action card: banner, cue, and a pulse on whoever it landed on.
   *
   * One event per move at most — an action card does one thing — so this takes
   * the first rather than queueing, which would stack banners on a variant where
   * two effects can fire (a seven-zero swap that also reverses).
   */
  function celebrateAction(session, state, events) {
    let ev = null;
    let said = null;
    for (const candidate of events) {
      const text = eventText(state, candidate);
      if (!text) continue;
      ev = candidate;
      said = text;
      break;
    }
    if (!said) return null;

    showBanner(session, said.text, said.tone);
    playActionCard({ against: me.holds(ev.seat) && said.tone === 'bad' });

    // After the card that caused it has landed on the discard (animateMove's
    // flight, launched a beat before this): the play and the punishment are two
    // events in that order, and overlapping them makes one blur. 300ms was
    // chosen against a 260ms flight and is now a little short of the 420ms
    // default — deliberately left alone, because a penalty that begins as the
    // card is still settling reads as a consequence, and one that waits for a
    // full stop reads as an interruption.
    if (ev.type === 'penalty') animatePenaltyDraw(state, ev.seat, ev.drew, 300);

    // The pulse lands on the seat it happened to, not the seat that played it:
    // the question a player is asking at this moment is "who did that hit".
    const victim = ev.seat;
    if (victim !== undefined && victim !== null) pulseSeat(victim, said.tone);
    flashFelt(ev);
    return said;
  }

  /**
   * A wash of colour across the felt — the pack-level "background effect" an
   * action card earns.
   *
   * Driven by a class and a custom property rather than an inline animation so a
   * pack's own stylesheet can restyle or silence it, and so reduced motion turns
   * it off with everything else (see the media query in table.css). The tint of a
   * wild is the colour that was chosen, which makes the flash carry the one piece
   * of information the discard card itself cannot show.
   */
  function flashFelt(ev) {
    if (!el.table || !motionAllowed()) return;
    const chosen = ev.type === 'wildPlayed' ? Object.values(ev.chose || {})[0] : null;
    // Through the pack's own palette, so the wash is the colour the player just
    // picked as that pack draws it — and through safeCssColor, because a palette
    // is pack-supplied data on its way into a style property.
    const tint = chosen ? safeCssColor(art().theme.palette?.[chosen]) : null;
    el.table.style.removeProperty('--flash-tint');
    if (tint) el.table.style.setProperty('--flash-tint', tint);
    el.table.classList.remove('table--flash');
    void el.table.offsetWidth;
    el.table.classList.add('table--flash');
  }

  return { hideBanner, showBanner, celebrateTrick, celebrateAction, animatePenaltyDraw };
}
