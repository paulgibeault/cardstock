// THE BOT THAT BEAT ITS OWN PARTNER (#161).
//
// `src/engine/sides.js` has known which seats share a score since #104, the
// rollout grading has been side-aware since #105, and the function that
// actually CHOSE the card — `botHeuristic` in src/templates/trick-taking.js —
// read the card and nothing else: `-rank - value`, no trick, no trump, no
// partner. At a pack where `followSuit: 'must'` hands a void seat its whole
// hand, the lowest card is very often a low spade, so the bot ruffed the trick
// its partner had already won. The evaluator had the same bug in its own
// currency: raising `holdsUp` paid, so taking the trick off your partner's king
// with your ace scored better than ducking under it.
//
// Every position here is BUILT, not played to. A hand where the bot happens to
// be void with the right three cards in it turns up perhaps once in fifty
// deals, and a test that has to find one is a test that silently stops
// exercising the branch when the deal order changes. The positions are the
// pack's own — loaded from disk, four seats, sides {0,2} and {1,3} out of
// `players.teams` — with the hands and the trick put where the case needs them.
//
// The seat under test is always seat 0 and its partner is always seat 2, which
// is `sideOfSeat`'s round-robin and is asserted below rather than assumed.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { forkState } from "../src/engine/fork.js";
import { rankMoves } from "../src/engine/bot.js";
import { arePartners } from "../src/engine/sides.js";
import { loadPack } from "../src/engine/packLoader.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { PARTNERS_MANIFEST } from "./fixtures/partnersPack.js";

const SEATS = 4;

/**
 * A Team Spades table in the play phase with nothing dealt.
 *
 * `setup` leaves a bid phase and thirteen cards a seat; both are cleared,
 * because what each case needs is three or four named cards and a trick that
 * says exactly what it means. The bids are real (a side that owes tricks is the
 * only side the contract evaluator has an opinion about) and spades are broken,
 * so a lead constraint cannot quietly narrow a pool the case is about.
 */
async function spadesTable({ bids = [3, 3, 3, 3], tricks = [0, 0, 0, 0] } = {}) {
  const pack = await loadPackFromDisk("team-spades");
  const state = createState({ pack, seats: SEATS, seed: "spades-bot-161" });
  pack.template.setup(makeCtx(state));
  for (let s = 0; s < SEATS; s++) {
    state.zones.get(`hand.${s}`).cards.length = 0;
    state.zones.get(`won.${s}`).cards.length = 0;
    state.playerVars[s].bid = bids[s];
    // The won pile is read by DEPTH — a trick is one card a seat — so filler is
    // all "this seat has taken two tricks" needs to be.
    for (let i = 0; i < tricks[s] * SEATS; i++) state.zones.get(`won.${s}`).cards.push(`filler-${s}-${i}`);
  }
  state.zones.get("trick").cards.length = 0;
  state.vars.spadesBroken = true;
  state.vars.trickNumber = 3;
  state.vars.led = null;
  state.vars.leader = 0;
  state.turn.phase = "play";
  return state;
}

/** Put `cards` in seat `seat`'s hand, replacing whatever was there. */
function hand(state, seat, cards) {
  const zone = state.zones.get(`hand.${seat}`);
  zone.cards.length = 0;
  zone.cards.push(...cards);
}

/**
 * Play `cards` into the trick, in order, starting from `leader` — the seat
 * order the template resolves by (`seatsForTrick`), so the trick this leaves is
 * one the engine could have arrived at.
 */
function trick(state, leader, cards) {
  state.vars.leader = leader;
  state.vars.led = state.pack.cardsById.get(cards[0]).suit;
  state.zones.get("trick").cards.push(...cards);
  let seat = leader;
  for (let i = 0; i < cards.length; i++) seat = (seat + 1) % SEATS;
  state.turn.seat = seat;
}

/** The card ids seat `seat` would play, best first, by the cheap heuristic. */
const cheapOrder = (state, seat) => rankMoves(state, seat, { difficulty: "easy" })
  .map((r) => r.move.cards[0]);

test("the seat under test and seat 2 really are partners", async () => {
  const state = await spadesTable();
  assert.ok(arePartners(state.pack, SEATS, 0, 2), "seats 0 and 2 are not a side");
  assert.ok(!arePartners(state.pack, SEATS, 0, 1), "seats 0 and 1 were paired");
});

/* ------------------------------------------------------------------ *
 * The trick your partner has already won
 * ------------------------------------------------------------------ */

test("void over a partner's winning king, the bot discards instead of ruffing", async () => {
  const state = await spadesTable();
  // Seat 1 leads a heart, the PARTNER ruffs it with the king of spades and is
  // winning; seat 3 follows suit. Seat 0 is void in hearts, so `followSuit:
  // 'must'` offers it everything it holds — which is where the bug lived.
  hand(state, 0, ["spades-2", "spades-A", "clubs-4"]);
  trick(state, 1, ["hearts-9", "spades-K", "hearts-2"]);
  assert.strictEqual(state.turn.seat, 0, "the trick did not come round to the seat under test");

  const order = cheapOrder(state, 0);
  assert.strictEqual(order.length, 3, "the enumerator did not offer the whole void hand");
  // THE CLUB, which is the discard. `-rank - value` put the deuce of spades
  // first — a trump spent on top of the partner who had the trick — because it
  // is the lowest card in the hand and nothing in the ranking looked further.
  assert.strictEqual(order[0], "clubs-4",
    `the bot played ${order[0]} over its own partner's winning king`);
  // And the ace is LAST: it is both a ruff and an overtake, and the two charges
  // stack.
  assert.strictEqual(order[2], "spades-A", "overtaking the partner was not the worst option");
});

test("following suit under a partner's winner, the bot still plays low", async () => {
  const state = await spadesTable();
  hand(state, 0, ["hearts-3", "hearts-A"]);
  trick(state, 1, ["hearts-9", "hearts-K", "hearts-2"]);
  const order = cheapOrder(state, 0);
  assert.deepStrictEqual(order, ["hearts-3", "hearts-A"],
    "the bot overtook its partner's king in suit");
});

/**
 * A PARTNERSHIP PACK WHOSE PRICIEST CARD IS NOT ITS HIGHEST — the one table
 * where "never overtake your partner" has to be said out loud.
 *
 * At all three shipped trick-taking packs a card that overtakes is also the
 * dearer card by `-rank - value`, so the old ranking ducked under a partner by
 * accident and the charge for overtaking looks redundant. It is redundant only
 * while a pack's values rise with its ranks. Give a pack Hearts' queen of
 * spades — thirteen points at the tenth rung, with a free king and ace above it
 * — and the accident reverses: the ace is the CHEAP card to play and the bot
 * cashes it on the trick its partner had already won. That is the rule the
 * charge is, and this is the pack that asks for it.
 *
 * Built on tests/fixtures/partnersPack.js (#104's fixture) because inventing a
 * second partnership pack to prove one clause would be inventing a second game.
 */
const DEAR_QUEEN_MANIFEST = {
  ...PARTNERS_MANIFEST,
  id: "fixture-dear-queen",
  name: "Partners, with a queen worth having thrown at you",
  scoring: {
    ...PARTNERS_MANIFEST.scoring,
    cardValues: { "spades-Q": 13 },
    defaultValue: 0,
  },
};

test("never overtake your partner, even when the overtake is the cheap card", async () => {
  const pack = loadPack(structuredClone(DEAR_QUEEN_MANIFEST));
  const state = createState({ pack, seats: SEATS, seed: "spades-bot-161-dear-queen" });
  pack.template.setup(makeCtx(state));
  for (let s = 0; s < SEATS; s++) state.zones.get(`hand.${s}`).cards.length = 0;
  state.zones.get("trick").cards.length = 0;
  state.vars.trickNumber = 3;
  state.turn.phase = "play";
  // The partner leads the king and is winning. The queen ducks under it and
  // costs this side thirteen if the trick comes home; the ace takes the trick
  // off the partner for nothing and is, by the old ranking, the better card.
  hand(state, 0, ["spades-Q", "spades-A"]);
  trick(state, 2, ["spades-K", "spades-3"]);
  assert.strictEqual(state.turn.seat, 0);
  assert.deepStrictEqual(cheapOrder(state, 0), ["spades-Q", "spades-A"],
    "the bot took the trick off its own partner to save a card");
});

/**
 * A CARD THE DECK PAYS YOU TO PLAY, which is what makes the class step a SPREAD
 * and not a ceiling.
 *
 * `trickBand` has to outweigh the widest two cards can be apart by `-rank -
 * value`, and a NEGATIVE card value widens that at the attractive end: a card
 * worth −20 scores twenty above where its rank puts it. Hearts patches exactly
 * this in a shipped variant (`jack-of-diamonds`, `scoring.cardValues.diamonds-J
 * = -10`), and Hearts is safe only because it has no partner to duck under —
 * the first partnership pack to price a card as a bonus would have had the
 * charge quietly fail to outweigh it, and the sort would have inverted without
 * anything going red.
 *
 * Twenty for the ace and thirteen for the jack are chosen so the OLD band
 * (`topRank + topValue + 1` = 26) is not enough and the spread (46) is: the ace
 * charged 26 scores −18, above the jack's −22, and charged 46 scores −38, below
 * it.
 */
const BONUS_ACE_MANIFEST = {
  ...PARTNERS_MANIFEST,
  id: "fixture-bonus-ace",
  name: "Partners, with an ace the deck pays you to play",
  scoring: {
    ...PARTNERS_MANIFEST.scoring,
    cardValues: { "hearts-A": -20, "hearts-J": 13 },
    defaultValue: 0,
  },
};

test("the class step outweighs a card whose value is a bonus, not a cost", async () => {
  const pack = loadPack(structuredClone(BONUS_ACE_MANIFEST));
  const state = createState({ pack, seats: SEATS, seed: "spades-bot-161-bonus-ace" });
  pack.template.setup(makeCtx(state));
  for (let s = 0; s < SEATS; s++) state.zones.get(`hand.${s}`).cards.length = 0;
  state.zones.get("trick").cards.length = 0;
  state.vars.trickNumber = 3;
  state.turn.phase = "play";
  // The partner leads the queen and is winning it. The jack ducks under; the
  // ace takes the trick off the partner and is paid twenty for being played.
  hand(state, 0, ["hearts-A", "hearts-J"]);
  trick(state, 2, ["hearts-Q", "hearts-3"]);
  assert.strictEqual(state.turn.seat, 0);
  assert.deepStrictEqual(cheapOrder(state, 0), ["hearts-J", "hearts-A"],
    "a bonus card outbid the charge for overtaking the partner");
});

/* ------------------------------------------------------------------ *
 * The trick an opponent is winning
 * ------------------------------------------------------------------ */

test("with an opponent winning, the bot plays the cheapest card that wins", async () => {
  const state = await spadesTable();
  // Seat 3 is an opponent and leads; seat 0 plays second, holding two cards
  // that beat the nine and one that does not.
  hand(state, 0, ["hearts-4", "hearts-J", "hearts-A"]);
  trick(state, 3, ["hearts-9"]);
  assert.strictEqual(state.turn.seat, 0);
  assert.deepStrictEqual(cheapOrder(state, 0), ["hearts-J", "hearts-A", "hearts-4"],
    "the cheapest winner did not come first");
});

test("with an opponent winning and nothing that beats them, the bot plays its lowest", async () => {
  const state = await spadesTable();
  hand(state, 0, ["hearts-4", "hearts-8", "hearts-2"]);
  trick(state, 3, ["hearts-J"]);
  assert.deepStrictEqual(cheapOrder(state, 0), ["hearts-2", "hearts-4", "hearts-8"],
    "a losing hand stopped preferring its cheapest card");
});

/* ------------------------------------------------------------------ *
 * Nil — the promise the ranking has to know about
 * ------------------------------------------------------------------ */

test("a live nil does not ruff a trick it could duck", async () => {
  const state = await spadesTable({ bids: [0, 3, 4, 3] });
  // Void in hearts with a low spade and a high club: the lowest card is the
  // trump, it wins, and winning is the one thing this seat promised not to do.
  hand(state, 0, ["spades-2", "clubs-9"]);
  trick(state, 3, ["hearts-J"]);
  assert.deepStrictEqual(cheapOrder(state, 0), ["clubs-9", "spades-2"],
    "the nil bidder ruffed the trick its promise depends on losing");
});

test("a nil already broken plays for tricks like anybody else", async () => {
  const state = await spadesTable({ bids: [0, 3, 4, 3], tricks: [1, 0, 0, 0] });
  hand(state, 0, ["spades-2", "clubs-9"]);
  trick(state, 3, ["hearts-J"]);
  assert.deepStrictEqual(cheapOrder(state, 0), ["spades-2", "clubs-9"],
    "a nil that is already broken went on ducking as if it were not");
});

test("a partner's nil dying is taken back in suit, and never with a trump", async () => {
  // The partner promised nothing and is WINNING the trick, which is the nil
  // being broken in front of this seat.
  const inSuit = await spadesTable({ bids: [4, 3, 0, 3] });
  hand(inSuit, 0, ["hearts-3", "hearts-A"]);
  trick(inSuit, 1, ["hearts-9", "hearts-K", "hearts-2"]);
  assert.deepStrictEqual(cheapOrder(inSuit, 0), ["hearts-A", "hearts-3"],
    "the seat ducked under the partner whose nil it could have saved");

  // Void, the same position: taking it back means ruffing, and it does not.
  const ruff = await spadesTable({ bids: [4, 3, 0, 3] });
  hand(ruff, 0, ["spades-2", "clubs-9"]);
  trick(ruff, 1, ["hearts-9", "hearts-K", "hearts-2"]);
  assert.deepStrictEqual(cheapOrder(ruff, 0), ["clubs-9", "spades-2"],
    "the seat ruffed over its own partner to save a nil");
});

/* ------------------------------------------------------------------ *
 * Hearts, which asked for none of this
 * ------------------------------------------------------------------ */

test("Hearts still ranks by the card alone: nothing above is allowed to reach it", async () => {
  const pack = await loadPackFromDisk("hearts");
  const state = createState({ pack, seats: 4, seed: "spades-bot-161-hearts" });
  pack.template.setup(makeCtx(state));
  for (let s = 0; s < 4; s++) state.zones.get(`hand.${s}`).cards.length = 0;
  state.zones.get("trick").cards.length = 0;
  state.vars.heartsBroken = true;
  state.vars.trickNumber = 3;
  state.turn.phase = "play";
  // A seat that could take the trick with the jack. A pack whose points are the
  // PRIZE wants exactly that; Hearts wants the opposite, and `prizeSign` is the
  // one line that keeps the preference out of it.
  hand(state, 0, ["clubs-4", "clubs-J", "clubs-A"]);
  trick(state, 3, ["clubs-9"]);
  assert.deepStrictEqual(cheapOrder(state, 0), ["clubs-4", "clubs-J", "clubs-A"],
    "Hearts started playing to win tricks");
});

/* ------------------------------------------------------------------ *
 * The evaluator's half of the same bug
 * ------------------------------------------------------------------ */

/** What `evaluateState` makes of the position after `seat` plays `cardId`. */
function valueAfter(state, seat, cardId) {
  const fork = forkState(state);
  applyMove(fork, { actor: seat, type: "playCard", cards: [cardId] });
  const value = fork.pack.template.evaluateState(makeCtx(fork), seat);
  assert.strictEqual(typeof value, "number",
    `evaluateState declined the position after ${cardId} — the case proves nothing`);
  return value;
}

test("the evaluator does not pay a seat for taking the trick off its own partner", async () => {
  const state = await spadesTable({ bids: [3, 3, 3, 3] });
  // The partner leads a LOW heart and is winning it cheaply; seat 3 follows
  // under. Seat 0 plays third, so the trick is still open afterwards and the
  // evaluator is asked about a position rather than a scored round.
  hand(state, 0, ["hearts-3", "hearts-A"]);
  trick(state, 2, ["hearts-4", "hearts-2"]);
  assert.strictEqual(state.turn.seat, 0);

  const duck = valueAfter(state, 0, "hearts-3");
  const overtake = valueAfter(state, 0, "hearts-A");
  // The partner's four already holds the trick for the side, so the ace buys
  // the side nothing and spends the card that could have taken a trick the side
  // has no other way of reaching. The old evaluator preferred the ace, because
  // a higher winning card raised `holdsUp` and the whole of it was credited.
  assert.ok(duck > overtake,
    `ducking under the partner scored ${duck} and overtaking scored ${overtake}`);
});

test("the evaluator still pays for taking a trick off an OPPONENT", async () => {
  const state = await spadesTable({ bids: [3, 3, 3, 3] });
  hand(state, 0, ["hearts-3", "hearts-A"]);
  // Seat 3 — an opponent — is winning this one, and nothing of this side's has
  // been credited with it, so the whole hold is new.
  trick(state, 3, ["hearts-4"]);
  assert.strictEqual(state.turn.seat, 0);
  const duck = valueAfter(state, 0, "hearts-3");
  const win = valueAfter(state, 0, "hearts-A");
  assert.ok(win > duck,
    `taking the trick off an opponent scored ${win} against ${duck} for ducking`);
});

test("the held-card term prices the card a trick was won with", async () => {
  const state = await spadesTable({ bids: [3, 3, 3, 3] });
  // SEAT 0 PLAYS LAST, so the trick closes on its card and both candidates take
  // exactly the same trick. That is what makes this a test of the held-card
  // term and of nothing else: with seats still to play, a higher winner is also
  // a SAFER one (`holdsUp`), and preferring the ace there is the evaluator
  // being right rather than the term being absent.
  hand(state, 0, ["hearts-10", "hearts-A", "clubs-4"]);
  for (const s of [1, 2, 3]) hand(state, s, [`spades-${[4, 5, 6][s - 1]}`, `clubs-${[7, 8, 10][s - 1]}`]);
  trick(state, 1, ["hearts-9", "hearts-2", "hearts-3"]);
  assert.strictEqual(state.turn.seat, 0);
  const cheap = valueAfter(state, 0, "hearts-10");
  const dear = valueAfter(state, 0, "hearts-A");
  assert.ok(cheap > dear,
    `winning with the ten scored ${cheap} and winning with the ace scored ${dear}`);
});
