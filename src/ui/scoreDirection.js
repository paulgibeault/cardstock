// WHICH WAY IS UP, FOR THE SENTENCES THE TABLE SAYS.
//
// Two narration surfaces used to assume that points are a penalty, because both
// were written while Hearts was the only pack that had any:
//
//   * the round summary's target line ("First to 50 wins — 17 to go"), which
//     read the HIGHEST score as the leader — so Thirteen, whose lowest score
//     wins, told a player that the pile of penalty points they were losing with
//     was progress. A playtester finished on 53, was told "17 to go" for most of
//     the match, and lost (#121, feedback item 20);
//   * the trick banner ("N points against you" / "no points"), which put every
//     trick a Team Spades or Pinochle player won — the whole object of both
//     games — in the alarm-red tone, or announced a Spades trick that was
//     exactly what they bid for as "no points" (items 30 and 45).
//
// The fact both were missing is declared per pack and read everywhere else:
// `scoring.gameOver.winner`. `src/engine/scoring.js`'s `evaluateGameOver` reads
// it to pick the winner, the bot's match standing signs its accumulated score by
// it, and trick-taking's evaluators turn themselves round on it once
// (`prizeSign`) — "which way is up is the pack's, and an evaluator must read
// it", src/templates/CONTRACT.md. The narration is the one layer that never got
// the reading, which is how three shipped packs ended up describing a win as a
// loss with every test green.
//
// SO THE SENTENCES LIVE HERE, PURE, AND THE TWO PANELS CALL THEM. Both of the
// modules that need them touch the DOM at import time — src/ui/panels.js resolves
// its element table on the first line, src/ui/celebrations.js pulls in the flight
// and audio layers — so neither can be loaded by a Node test, and the text of a
// sentence that was wrong for three packs is exactly the thing that wants
// pinning. Nothing in this file reads or writes a DOM node; it takes a state and
// an event and returns strings (tests/scoreDirection.test.js).
//
// THE READING MATCHES `prizeSign` DELIBERATELY, including its fallback: only
// `highestScore` means points are the prize, and anything else — `lowestScore`,
// a template-owned ending, a pack with no threshold at all — is narrated as the
// penalty it has always been. A UI that disagreed with the bot about which way
// is up would be the same bug wearing different clothes.

import { sidesOf, sideOfSeat, sideScores } from '../engine/sides.js';

/**
 * 'highestScore' | 'lowestScore' | null — the pack's own declaration, and null
 * for a pack whose template owns the ending (Cribbage, Milestones) or which has
 * no match threshold at all (Stockpile).
 */
export function winDirection(pack) {
  const winner = pack?.scoring?.gameOver?.winner;
  if (winner === 'highestScore' || winner === 'lowestScore') return winner;
  return null;
}

/** Are points the prize at this pack, or the bill? `prizeSign`'s question. */
export function pointsArePrize(pack) {
  return winDirection(pack) === 'highestScore';
}

/** The match threshold a pack declares as `anyScore >= N`, or null. */
export function matchTarget(pack) {
  const m = /^anyScore\s*>=\s*(\d+)$/.exec(pack?.scoring?.gameOver?.when || '');
  return m ? Number(m[1]) : null;
}

function plural(n) {
  return n === 1 ? '' : 's';
}

/* ------------------------------------------------------------------ *
 * The round summary's target line
 * ------------------------------------------------------------------ */

/**
 * How much further this match has to run — said in the pack's own direction.
 *
 * "The match continues indefinitely" was the original complaint, and it was a
 * complaint about not being able to SEE the end: Wildfire runs to 500 and
 * nothing on the felt said so. A pack that ends some other way (Milestones on
 * its tenth contract) still says nothing here.
 *
 * THE DISTANCE IS THE SAME NUMBER IN BOTH DIRECTIONS, and that is the part that
 * hid the bug for a whole playtest. `anyScore >= N` fires on the FIRST side to
 * reach N whichever way the pack scores, so the side closest to ending the match
 * is the highest one either way — `Math.max` was never the mistake. The mistake
 * was calling that side "first to N wins" when at Thirteen and Hearts it is the
 * side closest to LOSING.
 *
 * WHICH READING, AND WHY. Two were on the table for a penalty-scored race:
 * count down to the lowest seat's distance from the threshold (which is a number
 * that means nothing — nobody is racing toward 50), or keep the honest countdown
 * and correct the claim attached to it. This is the second: the first clause is
 * the fact a player wants (how much longer), the second is the direction, and
 * neither of them says that the number going up is progress. It names no seat,
 * which keeps this a pure function of the pack and the totals — the round sheet
 * directly above it already shows every seat's name against their total, so a
 * name here would be the third copy of something two lines of the same panel
 * already say.
 *
 * @param pack   the loaded pack
 * @param seats  the seat count
 * @param totals per-seat running totals (a roundOver event's `totals`)
 */
export function targetSentence(pack, seats, totals) {
  const target = matchTarget(pack);
  if (target === null) return '';
  // The threshold is a SIDE's, the same reading `evaluateGameOver` takes.
  const nearest = Math.max(...sideScores(pack, seats, totals || []));
  const togo = target - nearest;
  if (!Number.isFinite(togo) || togo <= 0) return '';
  if (pointsArePrize(pack)) return `First to ${target} wins — ${togo} to go.`;
  return `Match ends when anyone reaches ${target} — ${togo} away. Lowest score wins.`;
}

/* ------------------------------------------------------------------ *
 * The trick banner
 * ------------------------------------------------------------------ */

/**
 * The seats on the side `seat` plays for. A teamless pack answers `[seat]`,
 * which is what lets everything below speak sides and nothing else.
 */
function sideMembers(pack, seats, seat) {
  return sidesOf(pack, seats)[sideOfSeat(pack, seats, seat)] || [seat];
}

/**
 * How many tricks this seat's SIDE has taken, counting the one just won.
 *
 * A trick is one card per seat, so a won pile's height says how many tricks it
 * holds without anybody counting them separately — the same derivation
 * `roundScoreBidsAndBags` uses (src/engine/scoring.js). The pile's DEPTH is
 * public even where its cards are not (`zoneView`, src/engine/view.js), so this
 * answers identically at a remote seat. null when the pack has no won piles.
 */
function tricksTakenBySide(state, seat) {
  const { pack, seats } = state;
  let tricks = 0;
  for (const s of sideMembers(pack, seats, seat)) {
    const address = `won.${s}`;
    if (!state.zones?.has?.(address)) return null;
    tricks += Math.floor(state.zones.count(address) / seats);
  }
  return tricks;
}

/**
 * The contract this seat's side is playing to, in TRICKS, or null when the pack
 * does not bid in tricks.
 *
 * A SIDE'S CONTRACT, NOT A SEAT'S. Partners' bids add up and the side's tricks
 * pay them off — that is the rule that makes overtaking your partner pointless
 * (src/engine/scoring.js), so "3 of your 5" is the number a Spades player is
 * actually counting even when three of the five were their partner's. A nil is
 * excluded from the sum for the same reason it is there: a seat that promised
 * nothing added nothing to the contract.
 *
 * PINOCHLE BIDS POINTS, not tricks (`rules.bidding.unit`), so "3 of your 250"
 * would be two different units in one sentence. It gets the plainer wording
 * below instead.
 */
function trickContractOfSide(state, seat) {
  const bidding = state.pack?.rules?.bidding;
  if (!bidding || bidding.unit === 'points') return null;
  let contract = 0;
  let bid = false;
  for (const s of sideMembers(state.pack, state.seats, seat)) {
    const own = state.playerVars?.[s]?.bid;
    if (!Number.isInteger(own)) continue;
    bid = true;
    if (own > 0) contract += own;
  }
  return bid ? contract : null;
}

/** Did this seat promise to take nothing at all? */
function bidNil(state, seat) {
  return trickContractOfSide(state, seat) !== null && state.playerVars?.[seat]?.bid === 0;
}

/**
 * What a resolved trick SAYS, and in which tone.
 *
 * `bad` is the flag the felt spends three ways — the banner tone, the cue
 * (`playTrickTaken`) and the seat pulse — and before #121 it was
 * `mine && ev.points > 0` for every pack alike. It is a judgement about the
 * seat reading the banner, so it can only ever be true of that seat's own
 * trick; a bot taking a pile of hearts is still neutral, because the felt does
 * not editorialise about other people's hands.
 *
 * @param state     the table's state or view — read-only, for zones and vars
 * @param ev        the `trickWon` event: { seat, cards, points, trickNumber }
 * @param mine      does the seat reading this hold the winning seat?
 * @param seatLabel (seat) => the name to put in a sentence
 * @returns { text, tone, bad }
 */
export function trickNarration({ state, ev, mine, seatLabel }) {
  if (!mine) {
    // Unchanged, and true either way round: a raw delta on somebody else's
    // pile. The felt says what happened and leaves the arithmetic alone.
    const text = `${seatLabel(ev.seat)} takes the trick${ev.points > 0 ? ` (+${ev.points})` : ''}`;
    return { text, tone: 'neutral', bad: false };
  }

  if (!pointsArePrize(state.pack)) {
    // HEARTS, AND EVERY PACK WHOSE POINTS ARE THE BILL. Exactly the sentences
    // that shipped — this is the reading that was always right for the one pack
    // it was written for, and it must not move.
    const text = ev.points > 0
      ? `You take the trick — ${ev.points} point${plural(ev.points)} against you`
      : 'Trick is yours — no points';
    return { text, tone: ev.points > 0 ? 'bad' : 'good', bad: ev.points > 0 };
  }

  // A NIL IS THE ONE TRICK A SPADES PLAYER DOES NOT WANT, and the mirror image
  // of the bug this file exists to fix: a table that cheered every trick at a
  // points-are-the-prize pack would be just as wrong for the seat that promised
  // to take none. The hundred it costs is the pack's own (`scoring.bids.nil`);
  // the sentence only says the promise is gone.
  if (bidNil(state, ev.seat)) {
    return { text: 'You take the trick — your nil is broken', tone: 'bad', bad: true };
  }

  const contract = trickContractOfSide(state, ev.seat);
  const tricks = contract ? tricksTakenBySide(state, ev.seat) : null;
  let text;
  if (contract && tricks !== null) {
    // "3 of your 5" — the sentence item 30 asked for, counting the thing the
    // player bid in. Past the contract every trick is a bag, which is a point
    // now and a hundred against the side when ten have piled up, so the count
    // keeps running and says what it has turned into rather than stopping at
    // the contract and reading like a bug.
    text = tricks > contract
      ? `Trick is yours — ${tricks} of your ${contract}, that's a bag`
      : `Trick is yours — ${tricks} of your ${contract}`;
  } else if (ev.points > 0) {
    // Pinochle: no bid counted in tricks, and a pile of card points that is
    // worth exactly what it says toward the side's total.
    text = `Trick is yours — worth ${ev.points} point${plural(ev.points)}`;
  } else {
    text = 'Trick is yours';
  }
  return { text, tone: 'good', bad: false };
}
