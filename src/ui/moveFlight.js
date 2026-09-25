// CARDS IN FLIGHT ACROSS THE FELT: where a seat, a pile or a meld card sits on
// screen, and the copy of a moved card that travels between two of them.
//
// Carved out of src/ui/table.js (#223, seam 6), which resolves 43 DOM ids at
// import time and therefore cannot be loaded by `node --test`. That is why this
// file takes `el` and the rest as PARAMETERS. Which move types fly a card, where
// each one lands, and which rect a folded seat launches from are questions a
// Node test should be able to ask. For as long as the answers lived beside that
// element table, the only test of them was a regex over animateMove's body
// (tests/flight.test.js now drives it instead, through tests/fixtures/moveFlight.js).
//
// THE FLYING IS NOT HERE. src/ui/flight.js owns the copy itself (`flyCard`),
// the hold on the landing card (`landOn`), the motion gate, and the arithmetic
// (`rectOf`, `cardSizedRect`, `scrollCorrectedRect`). This file decides WHAT
// flies, FROM and TO where, and how long it takes, and it measures those places
// off the table's own elements.
//
// THE ROW'S UNFINISHED SCROLL is the one piece of another seam's state read
// here. `seatRow.pendingSeatShift(node)` answers how far the opponent row still
// has to glide under `node` (src/ui/seatRow.js owns `pendingSeatScroll`), and
// `liveRect` applies it, so a card aimed at a seat mid-scroll lands on that
// seat and not its neighbour.
//
// `epoch` and `zones` come in as thunks: the doors bump the one and initTable
// builds the other after this factory, and both are read at the moment a card
// flies. `zoneStackNode` and `meldChipNode` stay in table.js because the drag
// targets and the round ending find the same nodes with them.

import { flyCard, landOn, motionAllowed, rectOf, cardSizedRect, scrollCorrectedRect } from './flight.js';
import { handAddress, implicitLandingZone } from './interaction.js';

/**
 * How many cards of a lay-down are worth watching arrive.
 *
 * PENALTY_FLIGHT_MAX's reasoning (src/ui/celebrations.js) applied to the other
 * end: a contract is three to six cards in every pack shipped, but the contract
 * ladder is pack data and one that asks for four sets of four would buy sixteen
 * timers and sixteen SVG copies for a moment that has stopped reading as a
 * single event long before that. Cards past the cap are simply already there.
 */
export const LAYDOWN_FLIGHT_MAX = 8;

/** The beat between one laid-down card and the next. */
export const LAYDOWN_STAGGER_MS = 80;

export function createMoveFlight({
  el, epoch, zones, seatRow, isMySeat, mySeat, cardById, art, currentFlightMs,
  zoneStackNode, meldChipNode,
}) {
  /* ------------------------------------------------------------------ *
   * Geometry for card travel — the parts that need the table's own elements.
   * `rectOf` and `cardSizedRect` moved to src/ui/flight.js, which already owns
   * the flying and where dragController's verbatim copy of rectOf now points too.
   * ------------------------------------------------------------------ */

  /** A node's rect, corrected for a seat row that is still gliding under it. */
  function liveRect(node) {
    return scrollCorrectedRect(rectOf(node), seatRow.pendingSeatShift(node));
  }

  /** Where a seat's cards live on screen — the source or target of a card in flight. */
  function seatRect(seat) {
    if (isMySeat(seat)) return rectOf(el.hand);
    const plate = el.opponentsTop.querySelector(`[data-seat="${seat}"]`);
    if (!plate) return null;
    const mini = plate.querySelector('.mini-hand');
    // The fan's last child is the one genuinely rendered card; the rest are the
    // cheap edge boxes renderSeats draws instead of real SVG. Preferring it gives
    // a card-shaped rect where the row is a squat strip, which is what a card
    // leaving this seat should be seen to launch from.
    //
    // FALLING BACK TO THE PLATE IS THE POINT, not a tidy-up. A seat whose fan is
    // put away — collapsed to its face, or merely `display: none` at a compact
    // table — has no rect at all (rectOf answers null for a zero-width node), and
    // this returned null with it: every card that seat drew or played crossed the
    // felt from nowhere, silently, on exactly the crowded tables where watching
    // WHO acted matters most. The face is where the player is looking anyway.
    //
    // Which NODE won matters as much as its rect now: every one of these lives
    // inside the scrolling row, and liveRect has to be told what it measured to
    // know whether the row's unfinished scroll applies to it.
    const node = firstSized([mini?.lastElementChild, mini, plate.querySelector('.seat__avatar'), plate]);
    return liveRect(node);
  }

  /** The first of `nodes` that has a rect — the fallback ladder, as a node. */
  function firstSized(nodes) {
    for (const node of nodes) if (rectOf(node)) return node;
    return null;
  }

  function zoneRect(address) {
    const node = zoneStackNode(address);
    if (!node) return null;
    // Corrected like a seat's, and for the same reason: an opponent's meld strip
    // carries `data-zone="melds.N"` and is drawn INSIDE the seat row, so a hit
    // aimed at one mid-scroll landed on the neighbour's melds.
    return liveRect(node.querySelector?.('.pile-stack__top') || node) || liveRect(node);
  }

  /**
   * Send a copy of the moved card across the table, then reveal where it landed.
   *
   * Called after the reducer and the re-render, with `from` captured before
   * them — by which point the source card is already gone, which is exactly why
   * a copy flies instead of the card itself.
   */
  function animateMove(state, move, from) {
    if (!from) return;
    // ONE DURATION FOR THE WHOLE TABLE, and it is the player's own speed setting
    // rather than a distinction between their cards and a bot's — see
    // flightDurationMs.
    const duration = currentFlightMs();
    if (move.type === 'draw' || move.type === 'takeHand') {
      // A draw has no single landing slot in a fanned hand, so it dissolves on
      // arrival rather than pretending to become a particular card. The human's
      // own draw is face-up because they are about to see it anyway.
      //
      // A WHOLE PILE TAKEN AS A HAND (#157) rides the same flight, and always
      // face down: seventeen cards left that pile at once, nobody had seen any of
      // them, and one back travelling from the pile to the seat says "that pile
      // is now theirs" without picking one of the seventeen to stand for the
      // rest.
      const to = cardSizedRect(seatRect(move.actor), from.width);
      const card = move.type === 'draw' && isMySeat(move.actor)
        ? cardById(state, state.zones.cards(handAddress(mySeat())).at(-1) || '')
        : null;
      flyCard(card ? art().face(card) : art().back(), from, to, { fade: true, duration });
      return;
    }
    if (move.type === 'hit') {
      const card = cardById(state, move.cards?.[0]);
      if (!card) return;
      // IT USED TO DISSOLVE. `fade: true` was right while the destination was a
      // whole meld strip with no slot to land on; the chip's card nodes are a
      // stable target, so the copy now lands ON the card it is a copy of and the
      // real one is held invisible underneath until it does — the same deal a
      // played card gets, and the difference between "a card arrived here" and
      // "a card evaporated near here".
      const seat = move.choice?.seat;
      const landing = meldCardNode(state, seat, move.cards[0]);
      const to = liveRect(landing) || cardSizedRect(zoneRect(`melds.${seat}`), from.width);
      if (!to) return;
      landOn(landing, flyCard(art().face(card), from, to, { duration }));
      return;
    }
    if (move.type === 'layDown') { animateLayDown(state, move, from, duration); return; }
    if (move.type !== 'playCard' && move.type !== 'discard') return;
    const card = cardById(state, move.cards && move.cards[0]);
    if (!card) return;
    const address = implicitLandingZone(state, move);
    if (!address) return;
    const node = zoneStackNode(address);
    const topNode = node ? node.querySelector('.pile-stack__top') : null;
    landOn(topNode, flyCard(art().face(card), from, liveRect(topNode) || zoneRect(address), { duration }));
  }

  /**
   * A contract, laid down and SEEN to be laid down.
   *
   * THE BIGGEST EVENT IN A MILESTONES ROUND HAD NO ANIMATION AT ALL. animateMove
   * handled draw, hit, playCard and discard and returned for everything else, so
   * a bot completing its contract put three to six cards on the felt between two
   * frames — the one moment in the game where you most need to know who did what
   * and it happened without a single pixel moving. tests/flight.test.js now
   * derives the move vocabulary from the templates themselves and fails on any
   * type that is neither animated nor deliberately silent, because a hardcoded
   * list of four is exactly what let this sit unnoticed.
   *
   * Staggered card by card, in meld order, because the count is half the news:
   * three cards arriving together are one event, three arriving in turn are three.
   * Same judgement as animatePenaltyDraw's, for the same reason.
   */
  function animateLayDown(state, move, from, duration) {
    // BEFORE ANYTHING IS HIDDEN. Every card below is held invisible until its
    // copy lands, and with motion off no copy is ever launched — so an early
    // return here is the difference between "no animation" and "the meld you just
    // laid down is blank". flyCard's own gate is too late to help.
    if (!motionAllowed()) return;
    const seat = move.actor;
    const cardIds = (move.choice?.melds || []).flatMap((meld) => meld.cards || []);
    const fallback = cardSizedRect(zoneRect(`melds.${seat}`), from.width);
    const myEpoch = epoch();

    cardIds.slice(0, LAYDOWN_FLIGHT_MAX).forEach((cardId, i) => {
      const card = cardById(state, cardId);
      const landing = meldCardNode(state, seat, cardId);
      const to = liveRect(landing) || fallback;
      if (!card || !to) return;
      landOn(landing, new Promise((resolve) => {
        // A PLAIN setTimeout, NOT `schedule` — which is the session clock, and
        // what the rest of the felt staggers with. The session clock stops with a
        // suspended frame, and a stagger that never fires here is not a missing
        // flight — it is a meld card left at opacity 0 for the rest of the round.
        // Same rule as animationSettled's backstop: the honest timer is the one
        // that still runs in the background.
        setTimeout(() => {
          if (myEpoch !== epoch()) { resolve(); return; }
          flyCard(art().face(card), from, to, { duration }).then(resolve);
        }, i * LAYDOWN_STAGGER_MS);
      }));
    });
  }

  /**
   * Where a card that has just joined a meld now sits, as a node.
   *
   * The chip draws its cards in READING order rather than the order the engine
   * stored them (the template's `meldCardOrder` — a run held `6 3 W 5` reads
   * `3 W 5 6`), so the slot a card landed in cannot be inferred from its position
   * in the move. The group is found by searching for the card rather than by
   * trusting the move's meld index, so this answers for a hit onto somebody else's
   * meld and for a lay-down's own fresh groups without knowing which it was asked
   * about.
   */
  function meldCardNode(state, seat, cardId) {
    if (!zones() || seat === undefined || seat === null) return null;
    const groups = zones().meldGroupsOf(state, seat) || [];
    const index = groups.findIndex((group) => group.cards?.includes(cardId));
    if (index < 0) return null;
    const chip = meldChipNode(`${seat}:${index}`);
    const cards = chip?.querySelector('.meld-chip__cards');
    if (!cards) return null;
    // Filtered exactly as buildMeldStrip filters, or a card the renderer skipped
    // would shift every slot after it by one.
    const ordered = zones().meldCardOrder(state, groups[index])
      .filter((id) => cardById(state, id));
    return cards.children[ordered.indexOf(cardId)] || null;
  }

  return {
    liveRect,
    seatRect,
    zoneRect,
    animateMove,
    // Returned for tests only: table.js reaches both through animateMove.
    animateLayDown,
    meldCardNode,
  };
}
