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
import { trickNarration } from './scoreDirection.js';
// Built here rather than threaded through createCelebrations' parameter list:
// it is a pure function OF `seatLabel`, which this module already has, and the
// two describeEvent call sites must hand templates the same bag (#124).
import { agrees } from './describe.js';

/* ------------------------------------------------------------------ *
 * The banner's geometry — pure, so it can be argued with in a test
 * ------------------------------------------------------------------ */

/**
 * HOW LONG A SENTENCE STANDS ON THE FELT, in one place.
 *
 * It used to be two: this timer and a `2.2s` literal on `.event-banner--in` in
 * table.css, which is the kind of pair that stays in step until the day it does
 * not. The number is declared here and handed to the stylesheet as
 * `--banner-hold` in showBanner; the CSS fallback is pinned to this constant by
 * tests/eventBanner.test.js so the two cannot drift apart again.
 */
export const BANNER_HOLD_MS = 2200;

/**
 * HOW LONG THE PILL TAKES TO ARRIVE, AND HOW LONG IT TAKES TO LEAVE.
 *
 * Derived rather than chosen, because `banner-in` already answers it: its
 * entrance frames finish at 18% and its exit begins at 82%, so each movement is
 * 0.18 of the hold. A banner whose middle is a PERSON'S OWN PAUSE (`showBanner`
 * with `held`, #180) is built from those same two movements at the same speed —
 * `banner-enter` and `banner-leave` in table.css — rather than from a second set
 * of numbers that would read as a different banner.
 *
 * Handed to the stylesheet as `--banner-fade`; the CSS fallback is pinned to
 * this constant by tests/eventBanner.test.js, exactly as the hold is.
 */
export const BANNER_FADE_MS = Math.round(BANNER_HOLD_MS * 0.18);

/** Clearance kept between the pill and whatever is above and below it. */
const BANNER_CLEARANCE = 6;

/**
 * The way out of a trick hold that has no clock on it, said in the live region.
 *
 * The status bar says the same thing in its 122px slot ("Nell's trick. Tap to
 * go on."); this is the announced copy, which has room to name both inputs
 * because the hold takes either.
 */
export const TRICK_TAP_HINT = 'Tap the table or press Enter to go on.';

/**
 * WHAT `#log` SAYS WHILE AN OPEN-ENDED TRICK HOLD IS WAITING (#180).
 *
 * TWO FACTS, ONE WRITE. `#log` is `role="status"` and the announced surface, and
 * both halves of this beat now want it: the hold's own branch has to say how to
 * end a pause with no clock on it — the accessibility net for a gate a sighted
 * pointer user discovers by tapping — and the announcement wants to name the
 * winner while the four cards are still whole. Two writes in the same frame is
 * one sentence announced and one lost, and the one at risk was the instruction.
 *
 * JOINED WITH A FULL STOP rather than a dash, because half the narrations this
 * receives already contain an em dash ("Trick is yours — 3 of your 5") and a
 * sentence with two of them parses as neither. Any stop the narration already
 * ends with is dropped so the join cannot double it.
 */
export function trickHoldLine(trickText) {
  const said = String(trickText ?? '').trim().replace(/[.!?]+$/, '');
  return said ? `${said}. ${TRICK_TAP_HINT}` : TRICK_TAP_HINT;
}

/**
 * WHERE THE PILL'S CENTRE GOES, in viewport pixels — the reserved band.
 *
 * The felt has exactly one strip that never holds a card value: between the
 * bottom of the opponent row and the top of the centre piles. Everything below
 * the piles is the player's own half — their piles, the staging tray, the fan —
 * and the hand is sacred, so this only ever looks UP.
 *
 * Four boxes, all measured by the caller: `seats` is the opponent row (the
 * ceiling), `piles` is the band the cards in the middle actually occupy (the
 * floor, because that is the first thing below with a rank corner on it — see
 * placeBanner, which measures the CARDS rather than the box nominally holding
 * them), `middle` is the felt's middle (the anchor for the fallback), and
 * `hand` stands in as the floor for a pack whose middle is empty. A missing
 * box is a box that is not on this felt.
 *
 * `fits: false` means the band could not hold the pill at the height it was
 * measured at with clearance on both sides; the caller shrinks it to one line
 * and asks again. If even that is snug — Hearts at 375x812 leaves 37px between
 * the row and the trick, and a one-line pill is 27 — it is hung from the top of
 * the piles rather than centred, and spills up over the bottom edge of the seat
 * row if it must, because plate chrome is a cheaper thing to cover than a rank.
 */
export function bannerBand(rects, height) {
  const live = (r) => (r && r.height > 0 ? r : null);
  const seats = live(rects.seats);
  const middle = live(rects.middle);
  const floorBox = live(rects.piles) || live(rects.hand);
  const half = height / 2;
  const pad = BANNER_CLEARANCE;
  const ceiling = seats ? seats.bottom : (middle ? middle.top : 0);
  if (!floorBox) return { top: ceiling + pad + half, fits: true };
  const floor = floorBox.top;
  if (floor - ceiling >= height + pad * 2) {
    return { top: (ceiling + floor) / 2, fits: true };
  }
  const anchor = (middle ? middle.top : ceiling) + pad + half;
  // Never off the top of the window: half a pill is not a sentence. The floor
  // is half the pill plus the clearance rather than half plus a token 2px,
  // because the exit frame of banner-in lifts the pill 0.115 of its own height
  // as it fades, and a tight pill placed at 2px would take its first line off
  // the top of the screen on the way out.
  return { top: Math.max(half + pad, Math.min(anchor, floor - pad - half)), fits: false };
}

/**
 * WHAT A TRICK'S OWN CELEBRATION IS WORTH, on the same scale `describeEvent`
 * uses (src/templates/CONTRACT.md, "Saying which event ENDED the move").
 *
 * A trick is narrated by `celebrateTrick` rather than through `eventText`, so
 * for a long time it was outside the priority system entirely and the table
 * expressed "a trick beats everything" by simply not calling `celebrateAction`
 * at all when one had fired. That is right for almost everything — a Draw 2 and
 * a gathered trick in one move is two celebrations and reads as neither — and
 * wrong for exactly the events that are BIGGER than the trick they arrived
 * inside. Spades breaking is the case that found it (#151): the card that
 * breaks a suit is very often the fourth card of a trick, so the one banner
 * that mattered was the one guaranteed to be suppressed.
 *
 * So the rule is a number instead of a special case. A describer that means to
 * outrank the trick says a priority above this; everything at or below it is
 * suppressed exactly as before, which is every event in every other pack.
 */
export const TRICK_BANNER_PRIORITY = 1;

/**
 * @param me          the seat lens (src/players/seats.js); everything is worded
 *                    from the point of view of the seat it names
 * @param seatLabel   (seat) => the name to put in a sentence
 * @param seatPossessive (seat) => that name in the possessive ("Your", "Ada's")
 * @param currentEpoch () => the table's epoch; a delayed flight checks it
 * @param elements    { table, eventBanner, log, hand, opponentsTop }
 * @param art         () => the open match's card renderer
 * @param zoneRect    (address) => rect
 * @param seatRect    (seat) => rect
 * @param pulseSeat   (seat, tone) => void
 * @param cardById    (state, id) => card
 */
export function createCelebrations({
  me, seatLabel, seatPossessive, currentEpoch, el, art, zoneRect, seatRect, pulseSeat, cardById,
}) {
  /** "You peg 3", "Nell pegs 3" — see `agrees` in src/ui/describe.js. */
  const seatVerb = (seat, verb) => agrees(seatLabel(seat), verb);
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
    if (session) {
      session.bannerTimer = null;
      // A HELD PILL HAS NO CLOCK OF ITS OWN (#180), so every door that takes a
      // banner down must also take away the claim on it — otherwise the next
      // `releaseBanner` would fade out whatever the felt is saying by then.
      session.bannerHeld = false;
    }
    el.eventBanner.hidden = true;
  }

  /**
   * Measure the felt and put the pill in the band that holds no card values.
   *
   * The banner used to sit at `top: 34%` of the WINDOW, which is a number about
   * the phone rather than about the table: in Thirteen at 375x812 that lands at
   * 276px and the combination pile starts at 277px, so the sentence covered the
   * cards it was describing (#149). Measured instead, against the three boxes
   * that decide where the felt's empty strip is on THIS layout.
   *
   * Done here rather than in layoutHand because it is not a layout — nothing
   * else moves, the fan is untouched, and the answer is only wanted on the
   * handful of frames a banner actually appears on.
   */
  function placeBanner() {
    const banner = el.eventBanner;
    // A hidden row measures 0x0 (#table-contract on a pack with no contract),
    // and "not there" is what the band arithmetic needs to hear about it.
    const box = (node) => {
      const r = node ? node.getBoundingClientRect() : null;
      return r && r.height > 0 ? { top: r.top, bottom: r.bottom, height: r.height } : null;
    };
    // THE FLOOR IS THE HIGHEST CARD, not the box that nominally holds them.
    // Cards in the middle are posed: a trick is a fan of rotated copies and a
    // cribbage sequence lives in #table-zones rather than #center-piles, so
    // both routinely stick out above `#center-piles`'s own rect. Measuring the
    // box left six banners on five packs grazing a rank corner that was
    // technically outside the pile it belonged to.
    const pilesBox = box(el.centerPiles);
    let cardTop = Infinity;
    for (const face of el.feltMiddle ? el.feltMiddle.querySelectorAll('.card-face') : []) {
      const r = face.getBoundingClientRect();
      if (r.height > 0) cardTop = Math.min(cardTop, r.top);
    }
    const top = Number.isFinite(cardTop)
      ? Math.min(cardTop, pilesBox ? pilesBox.top : cardTop)
      : (pilesBox ? pilesBox.top : null);
    const bottom = pilesBox ? Math.max(pilesBox.bottom, top) : top;
    const floor = top === null ? null : { top, bottom, height: Math.max(1, bottom - top) };
    const rects = {
      seats: box(el.opponentsTop),
      middle: box(el.feltMiddle),
      piles: floor,
      hand: box(el.handRow),
    };
    banner.classList.remove('event-banner--tight');
    let band = bannerBand(rects, banner.getBoundingClientRect().height);
    if (!band.fits) {
      // No band wide enough for the sentence as it wrapped: one line, smaller,
      // ellipsised — which is the trade the issue asks for, because a truncated
      // sentence is recoverable (#log has it whole) and a covered rank is not.
      banner.classList.add('event-banner--tight');
      band = bannerBand(rects, banner.getBoundingClientRect().height);
    }
    banner.style.setProperty('--banner-top', `${Math.round(band.top)}px`);
  }

  /**
   * The celebration layer. Decorative by construction — #log (a live region)
   * carries the same sentence — so it is aria-hidden and free to be theatrical.
   * `tone` is 'good' | 'bad' | 'neutral': winning a clean trick sparkles, eating
   * the queen of spades stings, a bot's trick just gets noted.
   *
   * `held` IS A PILL WITH NO CLOCK ON IT (#180), for the one beat whose length
   * is a person rather than a number: the Manual rung's trick hold, which ends
   * on a tap. Every rung that names a duration holds for less than
   * BANNER_HOLD_MS — Relaxed at the slowest flight is the longest of them and it
   * is half a second short — so an ordinary banner still outlasts the beat it
   * belongs to. An indefinite one does not, and a sentence that dismissed itself
   * two seconds into an open-ended pause would leave the player back where the
   * bug started, looking at an unexplained trick.
   *
   * IT IS A HELD STATE, NOT A LONGER ANIMATION AND NOT A LOOP (cardstock#24).
   * The pill runs `banner-enter` — the same arrival, at the same speed — and
   * then nothing at all runs: a static box sitting on the resting transform
   * through `animation-fill-mode: both`. `releaseBanner` is the other end.
   */
  function showBanner(session, text, tone, { held = false } = {}) {
    if (session.bannerTimer) session.bannerTimer.cancel();
    session.bannerTimer = null;
    session.bannerHeld = false;
    el.eventBanner.textContent = text;
    // Assigning the whole class string is also what clears `--held` and `--out`
    // from the pill this one replaces.
    el.eventBanner.className = `event-banner event-banner--${tone}`;
    // The hold is ONE number (BANNER_HOLD_MS) spent twice: the timer below and
    // the entrance animation's duration, which used to be a `2.2s` literal in
    // table.css that nothing tied to this one. The fade is the same deal.
    el.eventBanner.style.setProperty('--banner-hold', `${BANNER_HOLD_MS}ms`);
    el.eventBanner.style.setProperty('--banner-fade', `${BANNER_FADE_MS}ms`);
    el.eventBanner.hidden = false;
    // Measuring forces the same style flush `void offsetWidth` used to, so this
    // is also what restarts the entrance animation on back-to-back banners.
    placeBanner();
    if (held) {
      el.eventBanner.classList.add('event-banner--held');
      session.bannerHeld = true;
      return;
    }
    el.eventBanner.classList.add('event-banner--in');
    const myEpoch = currentEpoch();
    session.bannerTimer = Arcade.session.setTimeout(() => {
      session.bannerTimer = null;
      if (myEpoch !== currentEpoch()) return;
      el.eventBanner.hidden = true;
    }, BANNER_HOLD_MS);
  }

  /**
   * A HELD PILL COMES DOWN WITH THE THING IT WAS HELD FOR (#180).
   *
   * Called from the one place that knows the hold is over — `runTrickReveal`'s
   * `release`, whichever end asked for it — so the sentence and the four cards
   * leave the felt together: the exit runs over the top of the gather instead of
   * the whole celebration arriving as the cards do.
   *
   * A no-op unless the banner currently on the felt is the held one. If a louder
   * event has since raised its own pill (#151's floor), that pill owns its own
   * clock and this must not reach round and cut it short.
   */
  function releaseBanner(session) {
    if (!session?.bannerHeld) return;
    session.bannerHeld = false;
    if (el.eventBanner.hidden) return;
    el.eventBanner.classList.remove('event-banner--held');
    el.eventBanner.classList.add('event-banner--out');
    if (session.bannerTimer) session.bannerTimer.cancel();
    const myEpoch = currentEpoch();
    session.bannerTimer = Arcade.session.setTimeout(() => {
      session.bannerTimer = null;
      if (myEpoch !== currentEpoch()) return;
      el.eventBanner.hidden = true;
    }, BANNER_FADE_MS);
  }

  /**
   * A TRICK RESOLVING IS TWO MOMENTS, NOT ONE (#180) — and they no longer happen
   * at the same instant, because the beat between them is now long enough to
   * notice.
   *
   * THE ANNOUNCEMENT is what the table SAYS: the banner naming the winner, the
   * live region, the trick cue, the pulse on the seat that took it. It belongs
   * at the START of the hold, while the four cards are whole and the player is
   * looking at them — that is the one beat that exists to be read, and before
   * #180 it was the one beat with nothing on it to read.
   *
   * THE GATHER is what the table DOES: copies flying to the winner's seat. It
   * stays behind the hold's `resume`, because the sweep is exactly what a tap is
   * asking for.
   *
   * `celebrateTrick` is still both in one breath, and it is still the whole
   * story on every path with no hold to split: the multiplayer path where the
   * felt could not pose the trick, and the Instant rung, whose hold is the
   * card's own flight and has no reading time to announce into.
   */
  function announceTrick(session, state, ev, { held = false } = {}) {
    const mine = me.holds(ev.seat);
    // WHICH WAY IS UP IS THE PACK'S (src/ui/scoreDirection.js). `bad` used to be
    // `mine && ev.points > 0` for every pack alike, which is Hearts' reading
    // wearing a platform's clothes: it put every trick a Pinochle player won in
    // the alarm-red tone and told a Spades player the trick they bid for was
    // worth nothing. One read, spent four ways below — banner text, tone, cue
    // and pulse — because those four disagreeing is what made it read as a bug
    // rather than as a wording nit.
    const said = trickNarration({ state, ev, mine, seatLabel });
    const bad = said.bad;

    showBanner(session, said.text, said.tone, { held });
    playTrickTaken({ bad });
    pulseSeat(ev.seat, bad ? 'bad' : 'good');
    // The live region is the CALLER'S, deliberately: an open-ended hold has a
    // second fact to fit in the same write (`trickHoldLine`), and two writes in
    // one frame is one sentence announced and one lost.
    return said;
  }

  /**
   * The sweep. The engine already moved the cards (they left the trick zone
   * before this render), so this flies COPIES from where the trick was to where
   * it went, the same clone-and-animate deal every card flight uses.
   */
  function gatherTrick(state, ev) {
    const from = zoneRect('trick');
    // One measurement, several copies, the last of them 550ms behind the first
    // — see animatePenaltyDraw above for why that no longer scatters them
    // across two plates.
    const to = from ? cardSizedRect(seatRect(ev.seat), from.width * 0.6) : null;
    if (!from || !to || !motionAllowed()) return;
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

  /** Both halves, in one breath — the paths with no hold to split them over. */
  function celebrateTrick(session, state, ev) {
    const said = announceTrick(session, state, ev);
    el.log.textContent = said.text;
    gatherTrick(state, ev);
    return said;
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
   *
   * `priority` is optional on all three and defaults to 0: it is how a describer
   * says "this one is the conclusion of the move, not a step in it" — see
   * celebrateAction.
   */
  function eventText(state, ev) {
    if (ev.say && typeof ev.say.text === 'string') {
      return { text: ev.say.text, tone: ev.say.tone || 'neutral', priority: ev.say.priority || 0 };
    }
    return state.pack.template.describeEvent?.(ev, {
      seatLabel, seatPossessive, seatVerb, viewerSeat: me.seat(),
    }) ?? defaultEventText(ev);
  }

  /**
   * Announce an action card: banner, cue, and a pulse on whoever it landed on.
   *
   * One event per move at most — an action card does one thing — so this picks
   * ONE rather than queueing, which would stack banners on a variant where two
   * effects can fire (a seven-zero swap that also reverses).
   *
   * WHICH one is `priority`, and the default is still "the first that says
   * anything". A move can end more than the turn: the pass that ends a Thirteen
   * trick emits `passed` and then `trickCleared`, and taking the first meant the
   * banner announced somebody's pass while the trick silently came back to you —
   * "the trick is yours" never appeared on the felt at all (#122, round-5 item
   * 22). A describer that knows its event is the CONCLUSION of the move says so
   * with a number; ties fall to the first, which is the order events were
   * emitted in and the behaviour every other pack keeps.
   */
  function celebrateAction(session, state, events, { floor = -1 } = {}) {
    let ev = null;
    let said = null;
    for (const candidate of events) {
      const text = eventText(state, candidate);
      if (!text) continue;
      // `floor` is what the banner is ALREADY saying, on the same scale: the
      // table passes TRICK_BANNER_PRIORITY when a trick has just been
      // celebrated, so only an event that means to outrank a trick gets to
      // overwrite it. The default of -1 is "the banner is free", which lets
      // priority 0 — every event that says nothing about priority — through.
      if ((text.priority || 0) <= floor) continue;
      if (said && (text.priority || 0) <= (said.priority || 0)) continue;
      ev = candidate;
      said = text;
    }
    // A MOVE THAT NARRATES NOTHING TAKES THE LAST SENTENCE DOWN (#149, inbox
    // item 22). It used to leave it standing for the rest of its hold, so a
    // pass from two plays ago was still over the felt while somebody else's
    // cards landed — "on turns where I was leading a brand-new trick it still
    // read 'Fig passed' from three plays ago". The banner describes a position,
    // and the position has just changed; not having a new sentence is a reason
    // to stop saying the old one, not a reason to keep it.
    // NOTHING TO SAY CLEARS A STALE PILL (#149) — unless a trick banner was
    // just shown for this same move (the caller raised the floor above the
    // trick's rung, #151): that pill is this move's answer and stays.
    if (!said) {
      if (floor < 0) hideBanner(session);
      return null;
    }

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

  return {
    hideBanner, showBanner, releaseBanner,
    announceTrick, gatherTrick, celebrateTrick,
    celebrateAction, animatePenaltyDraw,
  };
}
