// WHAT A SIDE HAS PROMISED AND WHAT IT HAS TAKEN — the scoring facts a bidding
// table derives rather than stores, in one place (#217).
//
// Every question below has exactly one right answer at a table, and before this
// file each of them had two implementations: one in src/engine/scoring.js, where
// the round is finally priced, and one in src/templates/trick-taking.js, where
// the felt and the bot ask the same questions a hundred times a hand. The
// template's own comment above `contractSeatOf` used to point at the engine's
// copy and explain that they agreed — which is the tell that they were one
// function typed twice. `prizeSign` had a third copy, private to
// src/engine/bot.js.
//
// NOTHING HERE IS STORED, and that is the point rather than an implementation
// detail. Who holds the contract, how many tricks a seat has taken, how many
// bags a side is carrying: each is a function of the public vars and the zones,
// so a replay that lands on the same table gets the same answer. A stored copy
// would be a second version of a public fact, free to drift from it — the
// argument src/engine/scoring.js has always made about `contractSeat`, now made
// once for all seven.
//
// THE SHAPE OF A CALL is `(ctx, seat)` — the engine ctx from
// src/engine/context.js, which is what both the scorer and the template already
// hold. `prizeSign` is the exception: it reads the manifest and nothing else, so
// it takes the PACK, because src/engine/bot.js asks the question from a place
// that has a state and no ctx.
//
// THIS FILE SITS BELOW BOTH CALLERS and imports only `cardValue`/`handValue`
// back out of scoring.js for `bankedOf`. That is a cycle on paper; it is inert
// in practice, because every binding either side reaches for is a hoisted
// function declaration and neither module calls the other while it is still
// evaluating.

import { handValue } from './scoring.js';
import { sidesOf, sideOfSeat } from './sides.js';

/**
 * How many tricks this seat has taken: its won pile, a trick at a time.
 *
 * Every trick is one card per seat, so a won pile's height says how many tricks
 * it is without anybody having to count them separately.
 */
export function tricksOf(ctx, seat) {
  return Math.floor(ctx.countIn(ctx.zoneAddr('won', seat)) / ctx.seats);
}

/**
 * The seat holding the contract at a points auction — the highest bidder, or
 * null before anybody has bid.
 *
 * DERIVED RATHER THAN STORED. Every other seat passed with a 0, a bid has to
 * beat what came before it, so the maximum is unique and every seat at the table
 * watched it being made.
 */
export function contractSeatOf(ctx) {
  let seat = null;
  let best = 0;
  for (let s = 0; s < ctx.seats; s++) {
    const bid = ctx.playerVar(s, 'bid');
    if (Number.isInteger(bid) && bid > best) {
      best = bid;
      seat = s;
    }
  }
  return seat;
}

/** The seats sharing `seat`'s score, `seat`'s own included. */
function sideMembers(ctx, seat) {
  return sidesOf(ctx.pack, ctx.seats)[sideOfSeat(ctx.pack, ctx.seats, seat)];
}

/**
 * What this side has promised between them: every positive bid, added up. Null
 * when no seat on the side has answered the auction yet.
 *
 * A NIL ADDS NOTHING TO THE CONTRACT. It is its own promise, kept or broken by
 * the seat that made it, and it is scored separately wherever it is scored.
 */
export function sideContract(ctx, seat) {
  let contract = 0;
  let bid = false;
  for (const s of sideMembers(ctx, seat)) {
    const own = ctx.playerVar(s, 'bid');
    if (!Number.isInteger(own)) continue;
    bid = true;
    if (own > 0) contract += own;
  }
  return bid ? contract : null;
}

/** How many tricks this side has taken so far, between them. */
export function sideTricks(ctx, seat) {
  let tricks = 0;
  for (const s of sideMembers(ctx, seat)) tricks += tricksOf(ctx, s);
  return tricks;
}

/**
 * THE BAGS THIS SIDE HAS BANKED — what previous rounds left on the books.
 *
 * src/engine/scoring.js keeps a side's running count on its canonical seat and
 * zeroes the partner's, so this sum is over the side rather than over one chair.
 */
export function bankedBagsOf(ctx, seat) {
  let banked = 0;
  for (const s of sideMembers(ctx, seat)) banked += Number(ctx.playerVar(s, 'bags')) || 0;
  return banked;
}

/**
 * THE BAGS THIS SIDE IS CARRYING — banked, plus the ones it has already taken
 * this hand.
 *
 * Null for a pack that does not bag at all (`scoring.bids.bags`), which is the
 * only gate: bags are Spades' arithmetic, declared, and Hearts and Pinochle have
 * none. The SCORER does not use this gate — it defaults an undeclared threshold
 * to ten (`roundScoreBidsAndBags`) — so it asks `bankedBagsOf` and adds the live
 * ones itself; this is the felt's question, and the felt says nothing at a pack
 * that never mentions bags.
 *
 * THE LIVE ONES COUNT. `bags` in playerVars is what the round boundary banked; a
 * trick taken past the contract in THIS hand is already a bag by the time it is
 * taken — the scorer adds `tricks - contract` whenever the contract is made, and
 * a side past its contract has made it. So the number on the felt is the number
 * that will be banked, and it does not sit still for a whole hand and then jump.
 */
export function bagsOf(ctx, seat) {
  if (!ctx.pack.scoring?.bids?.bags) return null;
  const contract = sideContract(ctx, seat);
  const live = contract === null ? 0 : Math.max(0, sideTricks(ctx, seat) - contract);
  return bankedBagsOf(ctx, seat) + live;
}

/**
 * WHAT THIS SEAT HAS IN THE BANK at a pack that scores meld and cards together
 * — what it declared, plus the card value of the pile it has won.
 *
 * Per seat rather than per side because both callers fold differently: the
 * scorer adds a last-trick bonus to one member on the way past, and the bot's
 * points evaluator wants a side total.
 */
export function bankedOf(ctx, seat) {
  const scoring = ctx.pack.scoring || {};
  return (Number(ctx.playerVar(seat, 'meld')?.points) || 0)
    + handValue(ctx.cardsIn(ctx.zoneAddr('won', seat)), scoring);
}

/**
 * WHICH WAY IS UP, from the one manifest field that says so.
 *
 * `scoring.gameOver.winner: 'highestScore'` means points are the PRIZE; anything
 * else means they are the penalty. A pack that says nothing is assumed to be
 * counting penalties, which is the commoner shape and the safer guess.
 *
 * An evaluator that ignores this is the failure the bot layer's comment warns
 * about: a pack that gets it wrong "gets a bot that plays to lose, and nothing
 * else in the codebase would notice". Both of trick-taking's evaluators are
 * written in the direction the SCORE moves and turned round by this, once.
 *
 * TAKES A PACK, NOT A CTX — src/engine/bot.js asks from `standingOf`, which has
 * a state and builds no ctx. The `manifest` fallback is src/engine/bot.js's and
 * is kept: src/engine/packLoader.js always fills `scoring` in, so it can only
 * matter to a pack object nobody built through the loader.
 */
export function prizeSign(pack) {
  const scoring = pack?.scoring || pack?.manifest?.scoring || {};
  return scoring.gameOver?.winner === 'highestScore' ? 1 : -1;
}
