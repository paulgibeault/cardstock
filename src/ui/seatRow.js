// THE OPPONENT ROW: every player who is not you, and how much of each of them
// fits on the felt.
//
// Carved out of src/ui/table.js (#223, seam 1), which resolves 43 DOM ids at
// import time and therefore cannot be loaded by `node --test`. That is the
// whole reason this file takes `el`, `session` and the rest as PARAMETERS: the
// row's fit ladder, its captions and the pack's own counters are decisions a
// Node test should be able to ask about, and for as long as they lived beside
// that element table the only way to ask was a regex over the source.
//
// So the split runs along "does this need the screen":
//
//   - MODULE SCOPE, pure and exported: what a chip says (`scoreChipFor`), what
//     a badge is made of (`fillCounterBadge`), which numbers survive being
//     minimized (`seatCountersFor`), and the ladder itself (`SEAT_TIERS`).
//     These touch `document` when CALLED and never at import, so the module
//     loads under `node --test` and the gates that used to grep for them can
//     import them instead.
//   - `createSeatRow(deps)`: everything that measures or mutates the row —
//     the fit loop, the plate popup and where it is anchored, the view toggle,
//     the edge fades, the height reserve and the scroll-into-view.
//
// WHAT THE ROW IS FOR, in one line, because it is easy to lose in the
// rectangles: it is the only place the other players exist on screen, and the
// discipline through all of it is that nothing about a player moves because
// somebody ELSE's turn began. The fit ladder, the height reserve and the plate
// (rather than an opening seat) are three answers to that same rule.
//
// The pure DECISIONS the row leans on are further out still: which seat the
// carousel should follow and which rungs exist at all are in src/ui/session.js
// (`seatToShow`, `SEAT_VIEWS`), and the ring order is in src/ui/seatRing.js.

import { makeCtx, actingSeats as actingSeatsOf } from '../engine/context.js';
import {
  opponentRing, scoreBearers, defaultScoreChip, seatSideMarks,
} from './seatRing.js';
import { line, svgNode } from './dom.js';
import { hiddenPileChip } from './describe.js';
import { counterTrack, renderCounterTrack, counterPips, renderCounterPips } from './counterTrack.js';
import { normalizeSeatView, nextSeatView, seatToggleOffered, seatToShow } from './session.js';
import { interactionMode, buildUiModel } from './interaction.js';
import { motionAllowed } from './flight.js';

/** Does this pack keep a running score worth showing on the felt? */
export function showsScores(state) {
  return state.pack.scoring?.accumulate === true
    || state.scores.some((n) => n !== 0);
}

/**
 * What a seat's score chip says — the template's answer, or the plain total.
 *
 * Contract rummy's "score" that matters is the contract you have reached and
 * the points are the tiebreak, which is why a plain total is the wrong default
 * for it and right for everything else. That used to be
 * `typeof playerVars[seat].phase === 'number'`, written out twice in this file,
 * beside three more direct reads of the same private var.
 *
 * A PARTNERSHIP HAS ONE SCORE, so the default is the SIDE's total
 * (src/ui/seatRing.js) — which for every pack that has no sides is the seat's
 * own number, unchanged. Which chairs draw a chip at all is `scoreBearers`'
 * question, one rung out in buildSeatRow: this one only says what the chip on a
 * chair says.
 *
 * @returns { short, long, aria } — `short` fits an opponent's plate, `long` is
 *          the human's own chip, which has room for both numbers.
 */
export function scoreChipFor(state, seat) {
  const declared = state.pack.template.scoreChip?.(makeCtx(state), seat);
  if (declared) return declared;
  return defaultScoreChip(state.pack, state.seats, state.scores, seat);
}

/**
 * THE WORD UNDER A PLATE'S NUMBER (#133, round-5 item 49).
 *
 * A seat plate used to be a row of bare digits — "Bruno 0 12 150 —" — legible
 * only to somebody who already knew which slot meant what, and its ONLY name
 * was an `aria-label` nobody sighted ever hears. The vocabulary is the human's
 * own chips' (`buildMySeatStrip`: SCORE, CARDS, BID, BAGS, MELD), so the two
 * halves of the table say a bid the same way.
 *
 * UNDER, NOT BESIDE, and that was measured rather than chosen: captions beside
 * the numbers cost +50% seat width at 375px (Team Spades' carousel scroll ran
 * 683 -> 912-993px), captions underneath cost +29% (683 -> 776) and one pixel
 * of height. The row already scrolls; making it half again as long to say the
 * same words is paying twice.
 *
 * ARIA-WISE THIS IS ONE THING, NOT TWO. The badge carries the counter's own
 * sentence ("bid 4 tricks") and `role="img"`, which stops the caption and the
 * digits being read out beside it — the same trick `.my-seat__chip` uses, and
 * the same reason directionBadge grew a role: an aria-label on a roleless
 * <span> is dropped by most screen readers, so the badge was previously
 * announcing nothing at all.
 */
export function counterCaption(label) {
  const cap = line('seat__count-label', label);
  // Belt and braces beside role="img": the caption is decoration for the
  // accessible name the badge already carries in full.
  cap.setAttribute('aria-hidden', 'true');
  return cap;
}

/** A badge's contents: the number, and the word for it. */
export function fillCounterBadge(badge, text, label, aria) {
  badge.replaceChildren();
  badge.appendChild(line('seat__count-value', text));
  if (label) badge.appendChild(counterCaption(label));
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', aria);
}

export function seatScoreChip(state, seat) {
  const chip = document.createElement('span');
  chip.className = 'seat__score';
  const { short, label, aria } = scoreChipFor(state, seat);
  // The chip's OWN word, defaulted rather than assumed: `scoreChipFor` answers
  // "what is this seat racing", and contract rummy's answer is a contract
  // reached, not a score — "Ph 1" under the word SCORE says the wrong thing in
  // the one pack that overrides the hook.
  fillCounterBadge(chip, short, label || 'Score', aria);
  return chip;
}

/**
 * Which way play is going, for packs where that can change.
 *
 * Only rendered once a reverse has actually happened — a permanent arrow saying
 * "play goes left" on a table that has no other option is chrome that teaches
 * nothing. It appears the moment a reverse lands and then stays, which is
 * exactly when a player needs to be able to check.
 *
 * "A REVERSE" IS A DEPARTURE FROM THE PACK'S OWN DIRECTION, not a negative
 * number. This read `state.direction < 0`, which is true of Thirteen from the
 * first card of the first deal — the pack simply deals counter-clockwise
 * (`rules.direction`) — so a game that can never reverse wore a permanent badge
 * announcing that it had, in the top-right corner where it read as a restart
 * control and sat on the second seat plate at 375px (#122, round-5 item 24).
 * Compared against the pack's declaration, Thirteen has no badge and Wildfire's
 * still appears the instant a reverse card lands.
 *
 * `role="img"`: an aria-label on a bare <div> has no role to attach to and is
 * dropped by most screen readers, which is why the playtest reported the badge
 * as having no accessible name at all. It stays pointer-transparent, so there
 * is no tooltip to give it — a sign that could be hovered could also be tapped,
 * and it sits over a seat plate.
 */
export function directionBadge(state) {
  const natural = state.pack.manifest.rules?.direction === 'counterclockwise' ? -1 : 1;
  if (Math.sign(state.direction || 1) === natural) return null;
  const badge = document.createElement('div');
  badge.className = 'direction-badge';
  badge.textContent = natural < 0 ? '↻' : '↺';
  const words = `Play has reversed — it now goes ${natural < 0 ? 'the other way round the table' : 'to the right'}`;
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', words);
  return badge;
}

/**
 * WHAT THE ROW GIVES UP, IN THE ORDER IT GIVES IT UP.
 *
 * Each rung hides more than the one above. Which rung is used is MEASURED, not
 * guessed: renderSeats builds the row, asks whether it overflows, and steps
 * down only if it does — so a wide screen never collapses anything, and a
 * phone collapses exactly as far as it has to and no further.
 *
 * It used to be a set of seat-count thresholds (collapse at 3 opponents, faces
 * at 4), which is the same guess made twice: a count cannot know how wide a
 * name is, how long a score chip has grown, how many melds are laid down, or
 * how big the window is. It collapsed four-handed tables that had room to
 * spare, and still overflowed by 183px when two seats had to stay open at
 * once.
 *
 * The seat that may ACT never gives anything up, at any rung — whose turn it
 * is, and what they are holding, is what the row is read for.
 *
 * RUNGS NO VIEW CURRENTLY SELECTS, KEPT ON PURPOSE.
 *
 * The ladder is entered from exactly two places now, and neither of them walks
 * its middle. 'all' builds at the top rung and buys room by scrolling instead
 * of descending; 'minimized' starts at 'collapsed' and can only go further
 * down. The rungs BETWEEN those two entry points are the ones the deleted
 * 'auto' passed through on its way down, and nothing reaches them today.
 *
 * They stay, and note what "unreachable" does and does not mean: no view STOPS
 * at these rungs, but their CSS still fires, because the tier classes are
 * cumulative — a row that settled on 'collapsed' or 'faces' is wearing
 * --compact and --tight as well. Deleting the rules would change how the rungs
 * BELOW them draw. What deleting the entries would cost is different again and
 * larger: the ORDER is the part that cost the debugging: what a row gives up
 * first, and second, is a measured answer to the overflow above, not something
 * rederivable from taste.
 *
 * The next view that wants a measured fit — a narrow-window rule, a pack that
 * asks for one, 'auto' coming back because some table needs it — reaches for
 * exactly these, and finding them intact is worth more than the lines saved.
 */
export const SEAT_TIERS = [
  // Everything: fan, name, score, counts, melds, piles.
  'full',
  // Waiting seats lose the fan of backs — decoration, and the widest thing on
  // the plate. Melds and piles stay, so every hit target is still on the felt.
  'compact',
  // ...and their names. The face and the count are still a player and how
  // close they are to going out.
  'tight',
  // Waiting seats become a face you open: fan, melds and piles move into the
  // plate behind a tap (or a drag-hover). This is the first rung that puts a
  // legal move behind a gesture, which is why .seat--target exists.
  'collapsed',
  // ...and lose their names and scores too, wearing the card count on the
  // corner of the avatar. The last rung; below this there is nothing left to
  // give and the row scrolls instead.
  'faces',
];
const TIER_COLLAPSED = SEAT_TIERS.indexOf('collapsed');
const TIER_FACES = SEAT_TIERS.indexOf('faces');

/**
 * The numbers a MINIMIZED seat's face is worth wearing — the pack's answer.
 *
 * Every pack still minimizes; what changes per pack is which number survives
 * it. The default is the hand count, which is right wherever the hand is the
 * race (shedding empties it, a rummy contract is finished by going out) and
 * wrong in sequencing, where Stockpile tops every hand back up to five — so a
 * minimized row read "5 cards" five times over while the stock count, the
 * thing the whole game is a race on, was the number it had put away.
 *
 * See `seatCounters` in src/templates/CONTRACT.md.
 */
export function seatCountersFor(state, seat, { minimized }) {
  const declared = state.pack.template.seatCounters?.(makeCtx(state), seat);
  const count = state.zones.count(`hand.${seat}`);
  // `label` on the DEFAULT too, and not only on the templates' own counters:
  // the caption under a plate's number (see counterCaption) is drawn from it,
  // and a pack that declares no counters is exactly the pack whose bare digit
  // has least else around it to explain itself.
  const list = Array.isArray(declared) && declared.length
    ? declared
    : [{ text: String(count), aria: cardsPhrase(count), label: 'Cards' }];
  // THE PRIMARY NUMBER IS THE SAME WHETHER OR NOT THE SEAT IS MINIMIZED.
  //
  // Counters were once read only off minimized seats, which meant the badge in
  // a given spot on the row silently changed what it MEANT: at a Stockpile
  // table the row read "20 20 5 20 20", and the 5 was not a player whose stock
  // had collapsed — it was the one seat whose turn it was, open, and therefore
  // showing a hand count instead. A number that changes quantity depending on
  // whose turn it is is worse than either quantity alone.
  //
  // `minimizedOnly` is for the counters that are genuinely redundant when the
  // seat is open: a rummy meld count sits directly above the meld chips, and
  // Hearts' points sit above the won pile that holds them.
  //
  // `openOnly` is the other half of the same pair, and it arrived with the pip
  // row (#148): a picture that says a bid and its tricks in one mark REPLACES
  // the two digit badges on a face that has no room for either, and printing
  // all three would be the same hand said twice. The digits are still what an
  // open plate shows, captioned and spoken, so nothing is lost where there is
  // width to lose it in.
  return minimized
    ? list.filter((counter) => !counter.openOnly)
    : list.filter((counter) => !counter.minimizedOnly);
}

/**
 * "1 card", not "1 cards".
 *
 * A seat holding one card is the most consequential moment a rummy table has —
 * it is the one everybody is watching, and the sentence a screen reader says
 * about it should not be the one that sounds broken.
 */
export function cardsPhrase(count) {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

/** The collapsed head's accessible name, rebuilt from its two stored halves. */
export function paintSeatHead(head, targeted) {
  head.setAttribute('aria-label',
    `${head.dataset.seatBase || ''}`
    + `${targeted ? ' Your selected card can be played here.' : ''}`
    + `${head.dataset.seatTail || ''}`);
}

/**
 * HOW THE TWO RUNGS ARE DRAWN: one dot, two dots — how much of each player is
 * on the felt, counted out.
 *
 * WHY there are two of them, and not the three there used to be, is in
 * SEAT_VIEWS (src/ui/session.js). What matters here is that they are ORDERED,
 * least to most, and that the dots count the same way: dots go up, you see
 * more. That is the whole of the design, and it survives the middle rung's
 * removal untouched — a scale reads as a scale at two marks as much as at
 * three. It replaced a set of invented glyphs (⊞ ⊟ ⇥⇤) with no relationship to
 * each other, which had to be learned once per state with nothing carrying
 * between them.
 *
 *   1 dot   minimized  faces for everyone who cannot act, fit or no fit
 *   2 dots  all        every plate open, the row scrolls sideways  (default)
 *
 * `pressed` is the ARIA state, not a second copy of the dots — see the toggle.
 * There was a `title`/`note` pair here as well, for a hover panel that explained
 * the glyphs; the dots need no explaining and the panel is gone.
 */
export const SEAT_VIEW_COPY = {
  minimized: { dots: 1, pressed: true },
  all: { dots: 2, pressed: false },
};
/**
 * The button's name, and it does not change with the state — see the toggle.
 * Named after what the control DOES rather than after either rung, because a
 * toggle's name has to stay true in both of its positions.
 */
export const SEAT_VIEW_LABEL = 'Minimize player cards';

/**
 * The opponent row, holding the screen it draws on rather than resolving it.
 *
 * @param el          the table screen's element table — `opponentsTop`, `table`, `screen`
 * @param session     () => the open session (the plate's pick, the fit cache, the reserve)
 * @param zones       () => the pile/meld renderer (src/ui/zoneRenderer.js)
 * @param liveState   () => the open match's state, or null
 * @param render      (state) => void — a full felt rebuild, for the row's own controls
 * @param mySeat      () => the seat at this device
 * @param isMySeat    (seat) => boolean
 * @param identityOf  (seat) => roster identity
 * @param art         () => the open match's card renderer
 * @param markEntry   (node, key) => node — the settle-in opt-in
 * @param turnToken   () => the "their turn" chip
 * @param committingToken () => the quieter "still choosing" chip
 * @param humanAnnouncements (state) => what this device may say out of turn (§E2)
 * @param heldValueText      (state, def, address) => what a hidden pile has cost
 * @param ownZoneInstances      (state, seat) => the zones a seat draws for itself
 * @param perPlayerZoneInstances (state, seat) => all of them, `table` zones included
 * @param performAnnouncement (state, move) => void — the Catch! button
 * @param isBusy      () => true while a drag owns the pointer
 */
export function createSeatRow({
  el, session, zones, liveState, render, mySeat, isMySeat, identityOf, art,
  markEntry, turnToken, committingToken, humanAnnouncements, heldValueText,
  ownZoneInstances, perPlayerZoneInstances, performAnnouncement, isBusy,
}) {
  // Where the seat row is smooth-scrolling TO, and when it set off:
  // { row, left, at }. Read by pendingSeatShift so a rect measured while the row
  // is still gliding can be corrected to where it is headed — see
  // scrollCorrectedRect in src/ui/flight.js. Deliberately NOT on `session`: it
  // describes the row on screen, it is time-boxed to well under a turn, and a
  // value that outlives a match is already stale by its own rule.
  let pendingSeatScroll = null;

  /**
   * Does this seat hold something the human's selected card can be played onto?
   *
   * A collapsed seat has no visible meld chips, so the glow that would have been
   * on the chip has to move somewhere the player can still see it — onto the
   * avatar, which is then the way in. Without this a legal layoff at a crowded
   * table is a move with no affordance anywhere on screen, which is the one
   * thing the old "never hide .seat__zones" rule existed to prevent.
   */
  function seatHasReadyTarget(state, seat, ui) {
    for (const key of ui.readyMelds.keys()) {
      // "1:" cannot match seat 11's "11:0" — the colon is part of the prefix.
      if (key.startsWith(`${seat}:`)) return true;
    }
    for (const inst of perPlayerZoneInstances(state, seat)) {
      if (ui.readyTargets.has(inst.address)) return true;
    }
    return false;
  }

  /**
   * Re-light the collapsed seats after a SELECTION changed and nothing else did.
   *
   * The same repaint-don't-rebuild contract renderSelection keeps for piles and
   * meld chips (see its header), and the collapsed row genuinely needs it: the
   * avatar glow IS the layoff affordance once the chips are put away, so a glow
   * that only refreshed on a full render would light up one bot move late and
   * stay lit after the card that earned it was played.
   */
  function paintSeatTargets(state, ui) {
    for (const plate of el.opponentsTop.querySelectorAll('.seat')) {
      plate.classList.toggle('seat--hinted', session().hint?.targetSeat === Number(plate.dataset.seat));
    }
    for (const plate of el.opponentsTop.querySelectorAll('.seat--collapsed')) {
      const targeted = seatHasReadyTarget(state, Number(plate.dataset.seat), ui);
      plate.classList.toggle('seat--target', targeted);
      const head = plate.querySelector('.seat__head');
      if (head) paintSeatHead(head, targeted);
    }
  }

  /**
   * The fan of card backs and the seat's own piles: the BODY of a seat plate.
   *
   * Factored out of renderSeats because a collapsed seat still has to be able to
   * show all of it. The popup its avatar opens is this same body, built by this
   * same code, carrying the same live hit targets — so a meld you can lay off
   * onto is never a different object depending on how much room the row happened
   * to have, and the paint pass in renderSelection finds its chips either way.
   */
  function buildSeatBody(state, seat, stagger, ui, into, { compactZones = true } = {}) {
    const count = state.zones.count(`hand.${seat}`);

    // THE OPPONENT'S HAND, DRAWN AS WHAT IS ACTUALLY VISIBLE OF IT.
    //
    // `--mini-step` closes this fan to as little as a fifth of a card, so all
    // but the rightmost back is covered to within a few pixels of its left
    // edge — white paper margin, then the printed panel, and nothing else.
    // Drawing a full back for the covered ones meant rasterising up to ninety
    // vector lines apiece to fill that sliver, for every card in every
    // opponent's hand, on every render. Two opponents holding seventeen cards
    // is a couple of thousand invisible line segments per frame, and it is why
    // a phone dropped frames on a table nothing was even moving on.
    //
    // So the covered ones are a box in the pack's own panel colour (see
    // .mini-hand__edge in table.css) and the one card you can genuinely see is
    // the real thing. Pixel-identical where it counts.
    const mini = document.createElement('div');
    mini.className = 'mini-hand';
    // The count is all the CSS needs to close the fan to a fixed width — see
    // .mini-hand in table.css for why a seat's geometry must not track how
    // many cards it holds. Deliberately not measured here: the card width is a
    // breakpoint-driven custom property, so the arithmetic belongs where that
    // property is defined rather than in a second copy that can drift from it.
    mini.style.setProperty('--mini-count', String(count));
    mini.style.setProperty('--back-panel', art().backPanel);
    for (let i = 0; i < count; i++) {
      const last = i === count - 1;
      const node = last
        ? svgNode(art().back(), stagger ? 'card-deal' : '')
        : document.createElement('span');
      if (!last) {
        if (stagger) node.className = 'card-deal';
        const edge = document.createElement('span');
        edge.className = 'mini-hand__edge';
        node.appendChild(edge);
      }
      markEntry(node, `back:${seat}:${i}`);
      if (stagger) node.style.animationDelay = `${i * 35}ms`;
      mini.appendChild(node);
    }
    // Decorative, and now genuinely unreadable: the covered cards are boxes
    // with nothing to announce. No loss — the fan was announcing "Face-down
    // card" once per card, thirteen times in a row, next to a count badge that
    // already says "13 cards" in one breath.
    mini.setAttribute('aria-hidden', 'true');
    into.appendChild(mini);

    // The seat's own piles, compact: a Stockpile stock and discards, laid-down
    // melds (live hit targets), a Hearts won pile with the points it holds.
    //
    // A `table` zone is NOT among them, on the plate or in the popup the plate
    // opens — ONE PLACE, NOT THREE (#138). The popup was the tempting exception
    // and it is the wrong one: it would put a second, smaller, differently
    // ordered rendering of the same sequence behind a tap, which is the split
    // this flag exists to end rather than a convenience on top of it. The
    // spreads in the middle are full size and always visible, so there is
    // nothing the popup copy could have been for.
    const seatZones = ownZoneInstances(state, seat);
    if (seatZones.length) {
      const strip = document.createElement('div');
      strip.className = 'seat__zones';
      for (const inst of seatZones) {
        if (inst.def.id === 'melds') {
          strip.appendChild(zones().buildMeldStrip(state, seat, ui, { mini: compactZones }));
        } else if (inst.def.visibility === 'none') {
          const pts = heldValueText(state, inst.def, inst.address);
          // THE PILE'S OWN NUMBER, not a second opinion about it. This chip used
          // to print the card count itself, so an opponent's won pile climbed in
          // fours — "Won 4", "Won 8" — beside a bid counted in tricks (#123,
          // item 29). `zoneBadge` is what the pile wears everywhere else, and it
          // is the template that knows four cards are one trick.
          //
          // AND AN EMPTY ONE SAYS NOTHING (#148). There is no dashed rectangle up
          // here for the name to be the missing half of — the chip is the whole
          // pile — so the word arrived alone, and "Won" on a seat that has taken
          // nothing reads as a claim rather than a label. See `hiddenPileChip`.
          const chip = hiddenPileChip(state, inst, pts);
          if (!chip) continue;
          const node = line('seat__pilechip', chip.text);
          node.dataset.zone = inst.address;
          strip.appendChild(node);
        } else {
          strip.appendChild(zones().buildPileNode(state, inst, ui, { mini: compactZones }));
        }
      }
      // A seat whose only pile is an empty hidden one now draws NOTHING here, and
      // an empty strip is not nothing: `.seat__zones` carries a top margin, so
      // appending it would leave every Spades plate a few pixels taller before
      // the first trick than after it — the row's fit ladder measures that.
      if (strip.childElementCount) into.appendChild(strip);
    }
  }

  /**
   * The open seat plate, and where on the screen it sits.
   *
   * FIXED, AND OUTSIDE THE ROW IT BELONGS TO. The obvious build — append it to
   * the seat, position it absolutely — works right up until the row has to
   * scroll, and the row now always can (see .opponent-row's overflow-x): a
   * scrollport clips its own absolutely-positioned children, so the plate would
   * be cut off by the very container the player opened it from. Anchoring it to
   * the seat's rect instead makes it immune to both the row scroller and the
   * carousel, and lets it be clamped to the VIEWPORT rather than to the felt,
   * which is the edge that actually matters.
   *
   * It lives inside el.screen so renderSelection's repaint pass — which walks
   * `el.screen` for `.meld-chip[data-meld]` — keeps finding its chips. That is
   * what makes the melds in here live rather than a picture of live ones.
   */
  function plateLayer() {
    let layer = document.getElementById('seat-plate-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'seat-plate-layer';
      el.screen.appendChild(layer);
    }
    return layer;
  }

  /** Sit under the seat's face, nudged back inside the viewport rather than clipped. */
  function positionPlate(plate, anchorNode) {
    const seatRect = anchorNode.getBoundingClientRect();
    const size = plate.getBoundingClientRect();
    const margin = 8;

    let left = seatRect.left + seatRect.width / 2 - size.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - size.width - margin));

    let top = seatRect.bottom + 6;
    // No room below (a short window, or a row pushed down the felt) — flip above.
    if (top + size.height > window.innerHeight - margin) {
      top = Math.max(margin, seatRect.top - size.height - 6);
    }
    plate.style.left = `${Math.round(left)}px`;
    plate.style.top = `${Math.round(top)}px`;
  }

  /**
   * The seat element whose plate is on screen, or null.
   *
   * Read off the DOM rather than off `session.openSeat`, because the plate may
   * be open without anybody having picked it — the row opens the acting seat's
   * plate by itself. `openSeat` answers "what did the player choose", which is a
   * different question and was the wrong one for the dismiss handlers: with a
   * plate open by turn rather than by tap, they saw `null` and did nothing, so
   * Escape and tapping the felt both stopped closing it.
   */
  function openPlateSeat() {
    const plate = document.querySelector('#seat-plate-layer .seat__plate');
    return plate || null;
  }

  /** Put the open plate away until play moves on. */
  function dismissPlate() {
    if (!session()) return;
    session().openSeat = null;
    session().plateDismissed = true;
  }

  /** Take the open plate off the screen. Safe when there is not one. */
  function closePlate() {
    const layer = document.getElementById('seat-plate-layer');
    if (layer) layer.replaceChildren();
  }

  /**
   * Build the open plate for `seat`. NOT positioned here — see placeOpenPlate.
   */
  function buildPlateFor(state, seat, identity, stagger, ui) {
    const layer = plateLayer();
    layer.replaceChildren();
    const plate = document.createElement('div');
    plate.className = 'seat__plate';
    plate.dataset.seat = String(seat);
    // A disclosure of the head button, which already names the player and says
    // what this does — so this names only what it contains.
    plate.setAttribute('role', 'group');
    plate.setAttribute('aria-label', `${identity.name}'s cards`);
    // The COMPACT pile and chip builders, scaled up by the plate's own CSS
    // rather than swapped for the full-size ones. Full size looked like the
    // right answer for "magnified" and was not: five 90px Stockpile piles do not
    // fit across a plate, so they wrapped, collided, and made the popup taller
    // than the board behind it. Compact parts at plate scale fit on one line,
    // stay a comfortable drop target, and keep the plate small enough to read
    // the felt around it.
    buildSeatBody(state, seat, stagger, ui, plate, { compactZones: true });
    layer.appendChild(plate);
  }

  /**
   * Anchor the open plate to its seat, once the row it hangs off actually exists.
   *
   * SEPARATE FROM BUILDING IT, and that is the whole point of the split: the
   * plate is built inside the seat loop, where the seat's own element has not
   * been appended to the row yet. Measured there, the anchor is an unlaid-out
   * node whose rect is all zeros, and the plate pinned itself to the top-left
   * corner of the window instead of to the face that opened it.
   */
  function placeOpenPlate() {
    const plate = document.querySelector('#seat-plate-layer .seat__plate');
    if (!plate) return;
    const seat = el.opponentsTop.querySelector(`[data-seat="${plate.dataset.seat}"]`);
    if (seat) positionPlate(plate, seat);
  }


  function seatViewOf() {
    return normalizeSeatView(session()?.seatView);
  }

  function seatViewToggle() {
    const view = seatViewOf();
    const copy = SEAT_VIEW_COPY[view];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'opponent-row__toggle';
    button.dataset.view = view;
    // Dots as elements rather than a string of "•" characters: they are drawn by
    // the stylesheet, so they stay round and evenly spaced at any font scale the
    // launcher applies (§5), where punctuation would ride the text metrics.
    for (let i = 0; i < copy.dots; i++) {
      const dot = document.createElement('span');
      dot.className = 'opponent-row__dot';
      button.appendChild(dot);
    }
    // ARIA-PRESSED NOW — AND THE LABEL HELD STILL TO PAY FOR IT.
    //
    // The note that stood here refused aria-pressed because a pressed/unpressed
    // boolean describes two states and would lie about the third. There is no
    // third: this is a toggle, and a toggle is the thing aria-pressed exists for.
    // What has to change alongside it is the label. A name that rewrote itself on
    // every tap ("Player cards: all open. Tap to go back to minimized.") sat on
    // top of a state that also flips, which is one fact announced twice in two
    // vocabularies — and a screen reader reads both, so the player hears the
    // change of position described and then contradicted in wording.
    //
    // So the name says what the button does and stays put, and `pressed` says
    // which rung the row is standing on. Between them they still answer both
    // halves of what the old label answered alone: pressed, the cards are
    // minimized and a tap opens them; unpressed, they are open and a tap
    // minimizes. The dots remain a picture of the same thing for everyone else,
    // which is why they are aria-hidden by being empty spans with no text.
    button.setAttribute('aria-pressed', String(copy.pressed));
    button.setAttribute('aria-label', SEAT_VIEW_LABEL);
    button.addEventListener('click', () => {
      if (!session() || !liveState()) return;
      session().seatView = nextSeatView(view);
      // The seat holding an open plate may not be minimized in the next view.
      session().openSeat = null;
      render(liveState());
    });
    // NO INSPECTOR HERE EITHER. It existed to explain three invented glyphs; a
    // count of dots is a scale that explains itself, and the button's name and
    // pressed state say the rest. A panel that opens over the felt to describe a
    // control in the corner is exactly the kind that was in the way.
    return button;
  }

  /**
   * Draw the opponent row at one rung of SEAT_TIERS. Called more than once per
   * render while renderSeats finds the rung that fits — so it must be a pure
   * rebuild with no side effects outside the row and the plate layer.
   */
  function buildSeatRow(state, stagger, acting, ui, { tier, carousel, mustOpen, showToggle, actor }) {
    el.opponentsTop.replaceChildren();
    // The plate lives outside the row, so clearing the row no longer clears it.
    // Dropped here and rebuilt below if its seat is still open, which keeps
    // "what is on screen" a function of this build rather than of the last one.
    closePlate();

    const collapsing = !carousel && tier >= TIER_COLLAPSED;
    const isCollapsed = (seat) => collapsing && !mustOpen(seat);

    // Whether the seats that may act are TAKING TURNS or all choosing at once —
    // see committingToken for why the marker differs. Asked of the interaction
    // mode rather than the phase name, and asked once for the row.
    const committing = interactionMode(state) === 'pass';

    // WHOSE PLATE IS SHOWING: the player's own pick if they made one, otherwise
    // whoever's turn it is. Their pick is retired when play moves on (see
    // renderSeats), so this follows the turn again by itself rather than leaving
    // them in a state they have to remember to leave.
    const picked = session()?.openSeat;
    const shownSeat = typeof picked === 'number' ? picked
      : (session()?.plateDismissed ? null : actor);

    // In carousel mode every rung is off. That is the bargain: the player asked
    // to see everything and the row bought the room by scrolling, so shedding
    // fans on top of it would answer the request by hiding what it asked for.
    el.opponentsTop.classList.toggle('opponent-row--compact', !carousel && tier >= 1);
    el.opponentsTop.classList.toggle('opponent-row--tight', !carousel && tier >= 2);
    el.opponentsTop.classList.toggle('opponent-row--faces', !carousel && tier >= TIER_FACES);
    el.opponentsTop.classList.toggle('opponent-row--carousel', carousel);

    // THE TOGGLE IS NOT IN THE ROW AT ALL — it lives in the felt's top corner
    // (see seatViewToggle). Inside the row it was content like any other, so
    // `justify-content: center` centred the seats-plus-a-control and pushed the
    // faces 29px off centre; balancing it needed a second empty item at the far
    // end, which was two pieces of furniture to solve a problem neither of them
    // needed to have. Out of the row, the row centres seats and nothing else.
    el.table.querySelector('.opponent-row__toggle')?.remove();
    if (showToggle) el.table.appendChild(seatViewToggle());

    const reversed = directionBadge(state);
    if (reversed) el.opponentsTop.appendChild(reversed);
    const scored = showsScores(state);
    // THE ROW IS A RING, not seat order with a hole in it — see src/ui/seatRing.js.
    // Clockwise from the chair on your left, so a partner (`seats / teams` chairs
    // along) is drawn in the middle of the row, across the table from you.
    const ring = opponentRing(state.seats, mySeat());
    // One chip per SIDE. Your own side's number is on your own chip in the status
    // bar, so your partner's chair carries none; everybody else's side is borne by
    // the first of its chairs the ring reaches.
    const bearers = scoreBearers(state.pack, state.seats, mySeat());
    const challenges = humanAnnouncements(state).filter((a) => a.type === 'challenge');
    for (const seat of ring) {
      if (isMySeat(seat)) continue;
      const identity = identityOf(seat);
      const marks = seatSideMarks(state.pack, state.seats, mySeat(), seat);
      const count = state.zones.count(`hand.${seat}`);
      const active = acting.includes(seat);
      const collapsed = isCollapsed(seat);
      const open = collapsed && shownSeat === seat;
      // Only worth asking about a collapsed seat, whose chips are not on screen
      // to glow for themselves.
      const targeted = collapsed && seatHasReadyTarget(state, seat, ui);

      const wrap = document.createElement('div');
      wrap.className = `seat ${active ? 'seat--active' : ''} ${active && committing ? 'seat--committing' : ''} ${collapsed ? 'seat--collapsed' : ''} ${targeted ? 'seat--target' : ''} ${session().hint?.targetSeat === seat ? 'seat--hinted' : ''} ${marks.partner ? 'seat--partner' : ''}`;
      wrap.dataset.seat = String(seat);
      // A number the STYLESHEET may dress, chosen by the engine and never by pack
      // data (§7b). The word itself goes in the head below, as text rather than
      // as an aria-only attribute: a partner is a fact everybody at the table
      // needs, not an accessibility footnote, and `aria-description` is not
      // reliably announced anyway.
      if (marks.side !== null) wrap.dataset.side = String(marks.side);

      // Collapsed, the head IS the way into the plate, so it is a real button —
      // not a div with a click handler. A span-only child list keeps it valid
      // markup; the Catch! button stays a SIBLING below for the same reason.
      const head = document.createElement(collapsed ? 'button' : 'div');
      head.className = 'seat__head';
      if (collapsed) {
        head.type = 'button';
        head.setAttribute('aria-expanded', String(open));
        head.addEventListener('click', () => {
          if (!session() || !liveState()) return;
          // Closing the seat the TURN opened is "not this turn" rather than a
          // pick of nobody, so it is recorded as a dismissal — which renderSeats
          // retires the moment play moves on.
          if (open) {
            session().openSeat = null;
            session().plateDismissed = true;
          } else {
            session().openSeat = seat;
            session().plateDismissed = false;
          }
          render(liveState());
        });
      }

      // On a MINIMIZED seat the token is worn on the avatar (absolutely, see the
      // stylesheet) rather than taking a slot in the head. In the head it made
      // the acting seat wider than every other seat, which is the exact shift
      // this layout works to remove — a player would move sideways because their
      // neighbour's turn began. An open seat has room for it inline.
      if (active) {
        const token = committing ? committingToken() : turnToken();
        if (collapsed) {
          token.classList.add('turn-token--worn');
          wrap.appendChild(token);
        } else {
          head.appendChild(token);
        }
      }

      const avatar = document.createElement('span');
      avatar.className = 'seat__avatar';
      // Own value from the roster, never a manifest one — this reaches an
      // inline style (§7b).
      avatar.style.background = identity.color;
      // textContent, not innerHTML: the instant a name arrives from a peer,
      // an interpolated template string is the XSS this fleet has shipped
      // twice (GAME_INTEGRATION §7b).
      avatar.textContent = identity.icon || identity.initials;
      avatar.setAttribute('aria-hidden', 'true');
      head.appendChild(avatar);

      const name = document.createElement('span');
      name.className = 'seat__name';
      name.textContent = identity.name;
      // The same string again, for the acting seat's glow: the stylesheet draws
      // it a second time in transparent ink so the halo can be faded on its own
      // layer instead of tweening a text-shadow (see .seat--active .seat__name).
      // A dataset write is data, and CSS attr() inserts a string and never
      // markup, so this is as safe as the textContent above (§7b).
      name.dataset.name = identity.name;
      head.appendChild(name);

      if (marks.partner) {
        const tag = document.createElement('span');
        tag.className = 'seat__partner';
        tag.textContent = 'Partner';
        head.appendChild(tag);
      }

      if (scored && bearers.has(seat)) head.appendChild(seatScoreChip(state, seat));

      // WHAT SURVIVES BEING MINIMIZED, and it is the pack that decides.
      //
      // An open seat wears the plain hand count and shows its piles below, so
      // there is nothing to choose between. A minimized one has room for a
      // couple of digits and has put every pile away, so the number on the face
      // has to be the one the game is actually read for — see seatCountersFor.
      const counters = seatCountersFor(state, seat, { minimized: collapsed });
      counters.forEach((counter, i) => {
        // A NUMBER THAT IS A POSITION GETS DRAWN AS ONE. Some counters are a
        // quantity of things (cards in hand, cards left in stock) and a pill of
        // digits says them completely; some are a place on a road — a cribbage
        // board, 121 holes and two pegs — and a pill throws away the whole point.
        // Which kinds are which is the PLATFORM's closed vocabulary
        // (src/ui/counterTrack.js) and which kind this counter is, is the
        // template's. An unrecognised kind falls through to the badge below.
        // AND WHERE THE FELT ALREADY DRAWS THE ROAD, THE PLATE DOES NOT (#136).
        // A shared board puts every seat's pegs on one road in the middle of the
        // table; an 88px copy of one lane of it, up here, is the same number a
        // third time — the plate's own score pill above already prints it. The
        // counter still counts for the collapsed head's spoken name below.
        if (counterTrack(counter)) {
          if (!session()?.board) head.appendChild(renderCounterTrack(counter));
          return;
        }
        // A NUMBER THAT IS A PROMISE GETS DRAWN AS ONE (#148). The other shape
        // in the same closed vocabulary: a bid and the tricks taken against it
        // are two numbers whose only meaning is the comparison between them, and
        // a row of circles makes that comparison where two digit badges left it
        // to the player to do. Same fail-soft as the track above.
        if (counterPips(counter)) {
          head.appendChild(renderCounterPips(counter));
          return;
        }
        const badge = document.createElement('span');
        // First is the primary badge; the rest are smaller marks beside it. The
        // kind is a TEMPLATE-chosen slug, never pack data reaching an attribute
        // the stylesheet matches on (§7b) — hence the whitelist-ish shape.
        badge.className = i === 0 ? 'seat__count' : 'seat__count--aux';
        if (counter.kind) badge.dataset.counter = String(counter.kind).replace(/[^a-z0-9-]/gi, '');
        // "Their turn" is false in a simultaneous phase, and it was being said on
        // every seat that had not committed yet — see committingToken.
        const says = !active || i !== 0 ? '' : (committing ? '. Still choosing.' : '. Their turn.');
        // The word under the number — the template's own, never invented here, so
        // a pack that calls its trick count something else is quoted rather than
        // translated. It is drawn on every rung and hidden by the stylesheet on
        // the ones with no room for it (.seat--collapsed): the caption is a
        // presentation decision about width, and rebuilding the row's DOM to make
        // it would put the fit ladder's own output inside the fit question.
        fillCounterBadge(badge, counter.text, counter.label, `${counter.aria}${says}`);
        head.appendChild(badge);
      });

      if (collapsed) {
        // The head is a button now, and a button made of badges names itself
        // "🂠 Delphine 42 7 ▤2" if left to name-from-content. Said outright, in
        // the order a player would ask it, with the affordance last.
        //
        // Split into dataset halves for the same reason .meld-chip keeps its
        // label there: the middle clause changes when the SELECTION changes, and
        // paintSeatTargets has to rewrite it without the seat, the counts or the
        // player's name to rebuild it from.
        head.dataset.seatBase = `${identity.name}. ${counters.map((c) => c.aria).join(', ')}.`;
        head.dataset.seatTail = ` ${open ? 'Hide' : 'Show'} their cards.`;
        paintSeatHead(head, targeted);
      }

      wrap.appendChild(head);

      // NO INSPECTOR ON A SEAT. It used to carry the player's name, card count,
      // score and what they had laid down — and every one of those is now
      // printed on the face itself (the name, the score chip, and the counters
      // the pack declares). A panel that repeats the thing it is covering is
      // worse than no panel, and a seat is a big target sitting in the path of
      // ordinary pointer movement, so it was the one that got in the way most.
      //
      // The seat is also the one inspectable that had somewhere better to go:
      // holding it is how you OPEN it, and the plate says all of this at full
      // size with the cards themselves. The tagline is the only thing genuinely
      // lost, and a bot's one-liner is flavour, not information.

      // The fan and the seat's piles: on the plate itself when there is room for
      // it, and inside the popup the avatar opens when there is not. Same
      // builder, same live chips, either way.
      if (!collapsed) {
        buildSeatBody(state, seat, stagger, ui, wrap);
      } else if (open) {
        buildPlateFor(state, seat, identity, stagger, ui);
      }

      // The catch affordance (§E2) lives on the seat it accuses, which is the
      // only place it reads as "you — you never said it".
      const catchMove = challenges.find((a) => a.target === seat);
      if (catchMove) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'seat__catch';
        button.textContent = 'Catch!';
        button.setAttribute('aria-label', `Catch ${identity.name} — they never declared their last card.`);
        button.addEventListener('click', () => liveState() && performAnnouncement(liveState(), catchMove));
        wrap.appendChild(button);
      }

      el.opponentsTop.appendChild(wrap);
    }
  }

  /** Does the row need more width than it has? The whole fit question. */
  function seatRowOverflows() {
    // 1px of tolerance: scrollWidth and clientWidth are integers rounded from
    // fractional layout, so a row that fits exactly can report one pixel over
    // and send the whole ladder down a rung for nothing.
    return el.opponentsTop.scrollWidth > el.opponentsTop.clientWidth + 1;
  }

  function renderSeats(state, stagger, acting, ui) {
    const opponents = state.seats - 1;
    // Two ways to show a crowd, and the player picks — see seatViewToggle here
    // and SEAT_VIEWS in src/ui/session.js. 'all' is the default, so the carousel
    // is the ordinary case now rather than the one somebody asked for.
    const view = seatViewOf();
    const carousel = view === 'all';

    // WHICH SEATS MAY NOT BE MINIMIZED — and it is no longer "whoever is
    // playing".
    //
    // The acting seat used to be forced open in the row, and that one exception
    // was where the movement came from: an open seat is two to three times the
    // width of a face, so every turn it pushed each seat to its right along by
    // 130-ish pixels. Players who had not done anything moved because somebody
    // ELSE started their turn. Now every seat is the same size and the acting
    // seat's detail opens in the plate below it instead — new information
    // appearing rather than existing information sliding.
    //
    // A seat you can CATCH is still forced open, for a reason that is not about
    // turns: the button is worn across the accused seat's own fan (see
    // .seat__catch) and a face has no fan to wear it across. The window is a
    // couple of seconds, the whole mechanic is noticing in time, and the row
    // lurching is a fair price for an alarm — arguably it IS the alarm.
    //
    // Enumerating announcements builds a fresh engine context, which is why it
    // is asked once for the row rather than once per opponent.
    const accused = new Set(
      humanAnnouncements(state).filter((a) => a.type === 'challenge').map((a) => a.target),
    );
    const mustOpen = (seat) => accused.has(seat);

    // Whose plate the row will open by itself: the opponent whose turn it is.
    // `acting` can name several seats in a simultaneous phase (Hearts' pass), and
    // there is no single actor to follow then — so the plate stays out of it.
    const actingOpponents = acting.filter((seat) => !isMySeat(seat));
    const actor = actingOpponents.length === 1 && !accused.has(actingOpponents[0])
      ? actingOpponents[0]
      : null;
    // Play moving on retires both the player's pick and their dismissal, so the
    // plate goes back to following the turn without them having to undo anything.
    if (session() && session().plateActor !== actor) {
      session().plateActor = actor;
      session().openSeat = null;
      session().plateDismissed = false;
    }

    // The toggle is a view control for a crowd, and it is a seat COUNT that says
    // whether there is one — see seatToggleOffered (src/ui/session.js) for why
    // the old "or the row is already scrolling" half had to go once 'all' became
    // the default, and for the latch that keeps a minimized player from being
    // stranded. Built before the fit loop runs so the row is measured with
    // whatever furniture it will actually be drawn with.
    const showToggle = seatToggleOffered(opponents, view);

    const build = (tier) => buildSeatRow(state, stagger, acting, ui, { tier, carousel, mustOpen, showToggle, actor });

    if (carousel) {
      // Nothing is given up and nothing is measured: the row is allowed to be
      // longer than the felt, which is the point of it.
      build(0);
    } else {
      // THE FIT LOOP. Start at the rung that fitted last time — turn to turn the
      // answer is the same, so the common case rebuilds the row exactly once —
      // then step down while it still overflows. It only ever steps DOWN here;
      // stepping back up is what the cache key below is for, so a row cannot
      // oscillate between two rungs on alternating turns.
      //
      // FLOOR, NOT START: 'minimized' means the player has asked for faces, so
      // the ladder begins at the collapsed rung and is still free to go further
      // if even faces do not fit. Beginning at 0 in that mode would just have
      // the fit test hand back the open row it was told not to draw.
      const floor = view === 'minimized' ? TIER_COLLAPSED : 0;
      const cached = session()?.seatFit?.key === seatFitKey(state, mustOpen, view)
        ? session().seatFit.tier
        : 0;
      let tier = Math.max(floor, cached);
      build(tier);
      while (tier < SEAT_TIERS.length - 1 && seatRowOverflows()) {
        tier += 1;
        build(tier);
      }
      if (session()) session().seatFit = { key: seatFitKey(state, mustOpen, view), tier };
    }

    // A seat the player picked but which is no longer minimized — the row grew
    // enough room for it, or it became the accused — cannot keep a plate it has
    // no face to hang off. Checked against what was actually BUILT rather than
    // recomputed, so this cannot disagree with the row on screen.
    if (session() && session().openSeat !== null
        && !el.opponentsTop.querySelector(`.seat--collapsed[data-seat="${session().openSeat}"]`)) {
      session().openSeat = null;
      closePlate();
    }

    reserveSeatRowSpace(state, view);
    scrollActingSeatIntoView(state, acting);
    // After the scroll is ISSUED and not before: the row is where this render
    // left it until the glide starts, and the listener repaints all the way
    // along. Repainted every render because the row's LENGTH changes without
    // anybody scrolling — a bot laying a meld can turn a row that fitted into one
    // that does not, and no scroll event is fired for that.
    paintSeatRowEdges();

    // Every seat is in the DOM now, so the open plate has a rect to hang off.
    placeOpenPlate();
  }

  /**
   * WHICH WAY THE ROW STILL HAS SEATS IN (#133, round-5 item 53).
   *
   * #125 measured item 53 and found no clipping bug: every seat is reachable at
   * 375px, and the "Minimize player cards" toggle shows all three at once. What
   * the playtest could not see is that the row scrolls at all — at 375 the
   * carousel is 683-741px of seats in a 332px port, so the second plate is cut at
   * the edge and the third is not on screen. A cut edge is ambiguous: it reads as
   * a felt that ends there just as easily as one that continues.
   *
   * So the edge that still has content is FADED rather than cut. Two classes, and
   * the stylesheet owns what they look like — see .opponent-row--more-right.
   *
   * NOTHING ON A ROW THAT DOES NOT SCROLL, which is the whole discipline of it: a
   * two-handed Cribbage or Thirteen table gets no mask, no extra paint layer, and
   * no soft edge suggesting a fourth player somewhere off to the right. Same at
   * either extreme — at scrollLeft 0 there is nothing to the left, so the left
   * edge is hard again and the fade is a live answer rather than decoration.
   *
   * The 1px slack is the same rounding tolerance seatRowOverflows keeps: integer
   * scrollWidth off fractional layout would otherwise leave a permanent fade on a
   * row with nowhere to go.
   */
  function paintSeatRowEdges() {
    const row = el.opponentsTop;
    const max = row.scrollWidth - row.clientWidth;
    const scrolls = row.classList.contains('opponent-row--carousel') && max > 1;
    row.classList.toggle('opponent-row--more-left', scrolls && row.scrollLeft > 1);
    row.classList.toggle('opponent-row--more-right', scrolls && row.scrollLeft < max - 1);
  }

  /**
   * The fade follows the finger. Passive because it never calls preventDefault
   * and a non-passive listener on a scroller is a scroll the compositor has to
   * wait for — this one only writes two class names.
   */
  function watchSeatRowEdges() {
    el.opponentsTop.addEventListener('scroll', paintSeatRowEdges, { passive: true });
    paintSeatRowEdges();
  }

  /**
   * HOLD THE ROW'S SHAPE STILL ACROSS TURNS.
   *
   * The row is drawn fresh every time anybody moves, and its natural size tracks
   * whoever is playing — a seat that opens for its turn is both taller and wider
   * than the face it replaced. Left alone that costs the player two pieces of
   * re-orientation on EVERY turn, measured on a six-handed Stockpile table:
   *
   *   - the row grew 43px -> 145px, and the whole felt below it moved down with
   *     it. The build piles — the things you are aiming at — sat 103px lower on
   *     a bot's turn than on yours.
   *   - `justify-content: center` re-centred the seats every time that width
   *     changed, so all five avatars slid ~66px sideways. Nothing about those
   *     players had changed; they moved because somebody ELSE's seat opened.
   *
   * So the row reserves the tallest it has been for this configuration and stays
   * there. A HIGH-WATER MARK rather than a computed maximum because the honest
   * maximum depends on the pack, the seat count and the melds laid down — all
   * things the row can measure about itself once it has been drawn, and none of
   * which it can be told up front.
   *
   * HEIGHT ONLY. There was a width reservation here too, a trailing spacer that
   * held the content at its widest so the seats would stop re-centring. It was
   * the right fix for the wrong era: back then the acting seat opened INSIDE the
   * row and was three times the width of a face. Seats are uniform now — the
   * acting seat's detail goes to the plate — so the content width no longer
   * changes and there is nothing to hold still. What the spacer did instead was
   * outlive its own reason: once a transiently wider row had set the high-water
   * mark, every later row was padded on the right and the faces sat visibly left
   * of centre for the rest of the match. Reserving a width that never varies is
   * all cost and no benefit, so it is gone.
   *
   * The reserve is per configuration, so a resize or a change of view starts a
   * fresh one instead of inheriting a stale, too-large floor.
   *
   * IT APPLIES IN THE CAROUSEL TOO, AND IT DID NOT USE TO.
   *
   * There was an early return here, reasoned as "the carousel is a scroller the
   * player drives; reserving inside it would pad the scrollable length for no
   * one's benefit". That was true of the WIDTH spacer described above, and it
   * stopped being true when the spacer went: a min-height does not lengthen a
   * horizontal scroller by a single pixel.
   *
   * The other half of the argument for skipping it — every seat is the same size
   * in carousel mode, so nothing moves — is about WIDTH. It comes from the acting
   * seat no longer opening INSIDE the row. Height is a different fact and it
   * still moves: in carousel mode nothing is collapsed, so every seat is showing
   * its melds, the row is as tall as its tallest seat, and a seat holding melds
   * is taller than one holding none. That is not a guess — it is the same
   * observation `.opponent-row`'s `align-items: flex-start` was written for. A
   * Milestones bot laying a run grows its seat, and therefore the row, and
   * therefore pushes the whole felt below it down, on somebody ELSE's turn.
   *
   * With 'all' the default view, keeping the early return would have switched
   * #13's protection off at nearly every table on the platform, which is the
   * opposite of what defaulting to it was supposed to buy.
   */
  function reserveSeatRowSpace(state, view) {
    const row = el.opponentsTop;
    // DELIBERATELY COARSER THAN seatFitKey, which counts how many seats have to
    // stay open. That count is the difference between your turn and a bot's —
    // exactly the transition this reservation exists to smooth — so keying off
    // it reset the high-water mark on every turn and the reserve never applied.
    // What the reserve may NOT span is a resize, a seat count, or a view change.
    const key = `${row.clientWidth}:${state.seats}:${view}`;
    const held = session()?.seatRowReserve;
    const reserve = held && held.key === key ? held : { key, height: 0 };

    // A NEW CONFIGURATION MEASURES A ROW WITH NO FLOOR UNDER IT.
    //
    // Starting a fresh reserve at zero is not enough on its own, because the
    // measurement below reads a rect that ALREADY INCLUDES whatever min-height is
    // currently applied — so the first thing a fresh reserve would do is adopt
    // the outgoing view's mark and call it its own, and "per configuration" would
    // be a promise this function does not keep.
    //
    // It hid while the carousel returned early: 'all' cleared the floor on its
    // way past, so every transition through it was scrubbed. Now that both views
    // reserve, the symptom is immediate — tap down to faces on a Milestones table
    // and the row keeps the 163px it needed for open seats holding melds, leaving
    // three-quarters of an inch of empty felt under a row of avatars.
    if (reserve !== held) row.style.minHeight = '';

    // Measured, not summed: `getBoundingClientRect().height` already includes
    // whatever floor is currently applied, and content taller than the floor
    // still reports its real height — so taking the max is enough to grow the
    // reserve and it can never shrink under its own reservation.
    reserve.height = Math.max(reserve.height, Math.round(row.getBoundingClientRect().height));
    row.style.minHeight = `${reserve.height}px`;
    if (session()) session().seatRowReserve = reserve;
  }

  /**
   * Bring the seat worth watching into view, centred where the row allows it.
   *
   * Carousel only. It is the one view whose whole premise is a row longer than
   * the felt, which means it is the one view where the seat you most need to see
   * can be off the end of it — and a player watching a six-handed table should
   * not have to go looking for it.
   *
   * The other view fits by construction (the fit ladder guarantees it), so there
   * is nothing to scroll and this stays out of the way.
   *
   * WHICH seat is worth watching is seatToShow's decision (src/ui/session.js),
   * and it is over there rather than inlined here for a reason this function
   * demonstrates: everything below is offsets and rects, none of it can be loaded
   * by a Node test, and the rule it used to contain — "find .seat--active" — was
   * silently wrong on the human's own turn for exactly as long as nobody could
   * write a test that asked it a question.
   */
  function scrollActingSeatIntoView(state, acting) {
    const row = el.opponentsTop;
    // No carousel, no scrolling — and therefore no unfinished scroll for a rect
    // to be corrected against. Dropped rather than left to time out, so a view
    // change out of the carousel cannot leave a target nobody is travelling to.
    if (!row.classList.contains('opponent-row--carousel')) {
      pendingSeatScroll = null;
      return;
    }
    const seat = seatToShow(state, mySeat(), acting);
    if (seat === null) return;
    const node = row.querySelector(`.seat[data-seat="${seat}"]`);
    if (!node) return;
    const left = seatScrollTarget(row, node);
    if (left === null) return;
    // RECORDED BEFORE THE SCROLL IS ISSUED, because every rect measured between
    // here and the row coming to rest is measured off a moving row — see
    // scrollCorrectedRect in src/ui/flight.js for the card that went for a ride.
    // `Date.now` and not the session clock: this is a time-box on a browser
    // animation, and a frozen clock would keep a stale target alive forever,
    // which is the one outcome the box exists to prevent.
    pendingSeatScroll = { row, left, at: Date.now() };
    row.scrollTo({ left, behavior: motionAllowed() ? 'smooth' : 'auto' });
  }

  /**
   * The seat row's unfinished scroll, as scrollCorrectedRect wants it, or null.
   *
   * `holds` is asked of the node rather than assumed, because the correction is
   * applied by the general-purpose `liveRect` below and most of what that
   * measures — the hand, the centre piles, the discard — is nowhere near the row.
   */
  function pendingSeatShift(node) {
    const pending = pendingSeatScroll;
    if (!pending || !node) return null;
    return {
      left: pending.left,
      scrollLeft: pending.row.scrollLeft,
      elapsedMs: Date.now() - pending.at,
      holds: pending.row.contains(node),
    };
  }

  /**
   * Where the row has to be scrolled to put `node` in the middle of it, or null
   * when it is already near enough that scrolling would be worse than not.
   *
   * SPLIT OUT OF THE SCROLL DELIBERATELY, and not because either half was long.
   * This number is the row's destination, and it is known BEFORE the smooth
   * scroll that chases it — which is precisely what a card in flight needs, since
   * animateMove measures its landing rectangle off a row that is still moving
   * under it. Whoever fixes that reads this value; leaving it computed inside the
   * scrollTo call would have meant re-deriving it from a rect that has already
   * gone stale.
   */
  function seatScrollTarget(row, node) {
    const max = row.scrollWidth - row.clientWidth;
    if (max <= 0) return null;
    const centred = node.offsetLeft + (node.offsetWidth / 2) - (row.clientWidth / 2);
    const left = Math.max(0, Math.min(max, Math.round(centred)));
    // Already there, near enough: re-issuing a smooth scroll every render would
    // restart the animation on each of a turn's several renders and leave the
    // row permanently gliding.
    return Math.abs(row.scrollLeft - left) < 2 ? null : left;
  }

  /**
   * What the chosen rung depends on, as a string.
   *
   * Only things that change how WIDE the row wants to be, because the whole
   * point is to avoid re-probing from the top on an ordinary turn. Melds
   * accumulating and score chips growing are deliberately NOT in here: they only
   * ever make the row wider, and the fit loop already steps down when it
   * overflows. What is in here is what can make the row need LESS room — a seat
   * count, a resize, or a change in how many seats have to stay open.
   */
  function seatFitKey(state, mustOpen, view) {
    let open = 0;
    for (let seat = 0; seat < state.seats; seat++) if (!isMySeat(seat) && mustOpen(seat)) open += 1;
    // `view` is in the key because a cached rung only means anything for the view
    // that measured it. Only 'minimized' reaches the fit loop at all now ('all'
    // scrolls instead of measuring), so in practice this is one value — kept
    // because inheriting 'minimized's floor across a view change is a floor no
    // measurement asked for, which was a live bug back when 'auto' existed to
    // switch back to, and would be one again the moment a measured view returns.
    return `${el.opponentsTop.clientWidth}:${state.seats}:${open}:${view}`;
  }

  /**
   * Re-fit the opponent row when the room it has changes.
   *
   * The same shape, and the same reason, as `watchHandWidth` over in
   * src/ui/handFan.js (the hand's half of the same problem): the width that
   * decides how much the seats have to give up is the ROW's, and it moves for
   * things a window `resize` never hears about — the launcher's font scale, the
   * table screen going from `hidden` to shown at boot, a suspended frame waking
   * with real geometry. Without this the row keeps whichever rung it picked at
   * whatever width it was first measured at, which on a rotated phone is a row
   * still dressed for a screen that is no longer there.
   *
   * Only the seats are rebuilt, not the whole table: nothing else on the felt
   * cares, and a full render here would fight the hand's own observer.
   */
  function watchSeatRowWidth() {
    // WIDTH ONLY, and remembered, because this observes the very element it
    // rebuilds. Re-fitting changes the row's HEIGHT — five faces are a third of
    // a row of open plates — so reacting to every box change would answer its
    // own notification: refit, height moves, observer fires, refit again. It
    // would settle (the second pass produces the same DOM) but it would do a
    // wasted rebuild every time, and it is the shape that becomes a real loop
    // the moment anything downstream is less stable. Width is what the fit
    // question is about; height is only ever its answer.
    let lastWidth = -1;
    const refit = () => {
      const state = liveState();
      // A rebuild mid-drag would replace the seat the pointer is carrying a card
      // to — and the drag holds measured rects for nodes this would throw away.
      if (!state || !session() || isBusy()) return;
      const width = el.opponentsTop.clientWidth;
      // BEFORE the width gate, and outside it. A row can be re-measured at the
      // same width and a different LENGTH — the launcher's font scale, a meld
      // laid down — and the edge fade is a question about the length. Two class
      // writes off geometry the line below is reading anyway.
      paintSeatRowEdges();
      if (width === lastWidth) return;
      lastWidth = width;
      renderSeats(state, false, actingSeatsOf(state), session().ui || buildUiModel(state, {
        seat: mySeat(), moves: [], acts: false, selection: session().selection,
      }));
    };
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', refit);
      return;
    }
    new ResizeObserver(refit).observe(el.opponentsTop);
  }

  return {
    renderSeats,
    paintSeatTargets,
    paintSeatRowEdges,
    watchSeatRowEdges,
    watchSeatRowWidth,
    buildPlateFor,
    placeOpenPlate,
    openPlateSeat,
    dismissPlate,
    pendingSeatShift,
    // NOT CALLED FROM src/ui/table.js — renderSeats drives it. It is out here
    // because it is the one piece of this file a test has a direct question
    // about ("is the anti-reflow reserve still switched off in the carousel",
    // "does a fresh reserve measure the row without the last view's floor on
    // it"), and those two questions were a grep over this function's source for
    // as long as there was no way to call it. See tests/seatView.test.js.
    reserveSeatRowSpace,
  };
}
