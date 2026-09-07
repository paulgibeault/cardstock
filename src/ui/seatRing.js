// WHERE THE OTHER CHAIRS GO, AND WHOSE SCORE IS ON THEM.
//
// The felt draws your hand along the bottom and everybody else in one row
// across the top (`src/ui/table.js`, `#opponents-top`). That row was built by
// walking seat 0..n and skipping your own — which is an ORDER, not a ring, and
// the difference only shows when you are not in seat 0. At a four-handed table
// seen from seat 1 the row read 0, 2, 3: the chair on your left drawn on your
// far left, and the chair across the table drawn at the end.
//
// Solo never noticed, because solo always deals the human seat 0
// (`SOLO_HUMAN_SEAT`) and 1, 2, 3 is already the ring. A joiner who took seat 2
// at a hosted table has been looking at a shuffled table all along, and
// partnerships are what make it matter rather than merely untidy: with sides
// declared round-robin, your partner sits `seats / teams` chairs away, and
// "opposite" means the MIDDLE OF THE ROW. It is only in the middle if the row
// starts at the chair on your left and goes round.
//
// So the row is a ring now: `mySeat + 1`, `+ 2`, … wrapped. For every existing
// pack and every solo game that is the identical row; for a partnership it puts
// your partner across from you, which is where they are sitting.
//
// NODE-CLEAN, AND THAT IS THE POINT. `src/ui/table.js` touches `document` at
// import time, so no `node --test` can load it — the same reason
// `src/ui/session.js` exists. Every rule here is a function of numbers and the
// pack, and `tests/seatRing.test.js` holds it to them.

import { sidesOf, sideOfSeat, partnersOf, hasSides, sideScoreOf } from '../engine/sides.js';

/**
 * The other chairs, in the order they sit around the table from `mySeat`.
 *
 * Clockwise from your left, which is the direction seat numbers already run in
 * (`ctx.nextSeat` at direction 1). `mySeat` null — a spectator, or the empty
 * felt behind the lobby — gets the plain 0..n-1, because a viewer with no chair
 * has no left.
 */
export function opponentRing(seats, mySeat) {
  const order = [];
  if (!Number.isInteger(mySeat) || mySeat < 0 || mySeat >= seats) {
    for (let seat = 0; seat < seats; seat++) order.push(seat);
    return order;
  }
  for (let step = 1; step < seats; step++) order.push((mySeat + step) % seats);
  return order;
}

/**
 * The seat sitting directly across from `mySeat`, or null when nobody is.
 *
 * Only ever asked of a partnership, and only ever true of one: with equal sides
 * dealt round-robin the partner is `seats / sides` chairs along, which at the
 * four-seat two-side table this was built for is the chair opposite. A pack
 * with more than one partner per side (three-handed sides, if a game ever wants
 * them) has no single opposite chair and gets null rather than an arbitrary one.
 */
export function partnerSeat(pack, seats, mySeat) {
  if (!Number.isInteger(mySeat)) return null;
  const partners = partnersOf(pack, seats, mySeat);
  return partners.length === 1 ? partners[0] : null;
}

/**
 * WHICH CHAIRS CARRY A SCORE CHIP — one per side, never one per seat.
 *
 * A partnership has one score and the felt has to show one number for it. Drawn
 * per seat, the same total appears twice on the row and reads as two scores
 * that happen to be equal — which is exactly the thing a player at a
 * partnership table is trying not to have to work out.
 *
 * So each side nominates a bearer, and your own chair always bears for your
 * side: your total is already on your own chip in the status bar, so a partner
 * drawing it again in the row would be the duplicate under another name.
 * Everybody else's side is borne by whichever of its chairs the ring reaches
 * first, so the number sits at a stable place in the row rather than moving
 * when the turn does.
 *
 * A teamless pack has one seat per side, so every seat is its own bearer and
 * the row is the row it always was.
 *
 * @returns a Set of seat indices. `mySeat` is in it whenever it is a real seat,
 *          which the opponent row ignores (it never draws your own chair) and
 *          the status bar relies on.
 */
export function scoreBearers(pack, seats, mySeat) {
  const bearers = new Set();
  const claimed = new Set();
  if (Number.isInteger(mySeat) && mySeat >= 0 && mySeat < seats) {
    bearers.add(mySeat);
    claimed.add(sideOfSeat(pack, seats, mySeat));
  }
  for (const seat of opponentRing(seats, mySeat)) {
    const side = sideOfSeat(pack, seats, seat);
    if (claimed.has(side)) continue;
    claimed.add(side);
    bearers.add(seat);
  }
  return bearers;
}

/**
 * The number a seat's chip shows, and what a screen reader is told it is.
 *
 * THE SIDE'S TOTAL, ALWAYS — which for a teamless pack is the seat's own, so
 * this is the plain total it always was. The aria text is where the difference
 * is said out loud, because the digits alone cannot: "26 points" on a partner's
 * chair is a lie about whose points they are.
 *
 * The template's own `scoreChip` hook still wins where it exists
 * (`src/templates/CONTRACT.md`); this is the default it displaces. A template
 * that overrides the chip in a partnership game owes its own fold, and the
 * contract now says so.
 */
export function defaultScoreChip(pack, seats, scores, seat) {
  const total = sideScoreOf(pack, seats, scores, seat);
  const text = String(total);
  return {
    short: text,
    long: text,
    aria: hasSides(pack, seats) ? `${text} points for this side` : `${text} points`,
  };
}

/**
 * A seat's partnership marks, for the row and the seat plate.
 *
 * `side` is a stable small integer the stylesheet may dress (a colour per
 * side), and `partner` is true for the chair you are playing WITH — the one
 * fact the felt has to say plainly, because a player who cannot tell which
 * opponent is their partner is playing a different game.
 */
export function seatSideMarks(pack, seats, mySeat, seat) {
  if (!hasSides(pack, seats)) return { side: null, partner: false };
  return {
    side: sideOfSeat(pack, seats, seat),
    partner: Number.isInteger(mySeat)
      && seat !== mySeat
      && sideOfSeat(pack, seats, seat) === sideOfSeat(pack, seats, mySeat),
  };
}

/** Every side's seats, for a caller that wants to name a pair. */
export function sideSeats(pack, seats) {
  return sidesOf(pack, seats);
}
