// The simulation, IN CI (design doc §11: "run in CI for every pack").
//
// It never was. `tools/simulate.mjs` is the tool that catches rule deadlocks —
// "draw pile empty and nobody can move", a turn that never advances, an
// infinite reaction cascade — and it only ran when somebody remembered to type
// it. A deadlock introduced by a refactor reached a player before it reached a
// build.
//
// TWO BARS, AND THE SECOND ONE IS THE HONEST PART. Crazy Eights, Wildfire and
// Hearts must complete 100% of rounds: those are rules-complete, and anything
// short of 100 is a bug. Stockpile is NOT gated at 100:
//
//   Stockpile  ~91-95%  a genuine manifest-level rules property: once draw and
//                       recycled are both exhausted a table can have no legal
//                       move at all. The fix is a house rule the reaction
//                       vocabulary cannot express yet, not an engine change —
//                       see the TODO in IMPLEMENTATION_NOTES.md.
//
// Gating that at 100% would mean a permanently red suite; gating it at nothing
// means a real regression could land unnoticed. So it gets a FLOOR, set below
// where it actually sits, which catches a regression without pretending the bar
// is met.
//
// MILESTONES USED TO BE ON THAT LIST AT ~31-40%, and it is worth saying why it
// is not any more, because the diagnosis in this comment was wrong. It was
// written up as slow bot convergence — a laid-down seat's hand only shrinks
// through a lucky hit — but the rounds were not converging slowly, they were
// not converging at all. The contract-rummy heuristic scored the face-up
// discard above the deck unconditionally, so every seat took the pile top every
// turn, the deck was never touched, and the same forty dealt cards circulated
// until the move cap. Teaching the bot when to turn the deck instead
// (src/templates/contract-rummy-bot.js) took Milestones from 16/40 rounds and
// 7,227 moves a round to 1000/1000 and 53. Its floor below is a floor on real
// completion now, not an allowance for a live-lock.
import { test } from "node:test";
import assert from "node:assert";
import {
  simulatePack, simulateMatches, simulateProtocolPack, availableVariantIds,
} from "../tools/simulate.mjs";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";

// Small enough to keep `npm test` quick, large enough that a deadlock in any
// ordinary line of play shows up. The full 1000-game run stays a manual tool.
const GAMES = 40;

test("the rules-complete packs complete every round", async () => {
  for (const packId of ["crazy-eights", "wildfire", "hearts", "thirteen"]) {
    const { completed, stalled, errored } = await simulatePack(packId, GAMES, { variants: [] });
    assert.strictEqual(stalled, 0, `${packId}: ${stalled} stalled rounds`);
    assert.strictEqual(errored, 0, `${packId}: ${errored} rounds threw`);
    assert.strictEqual(completed, GAMES, `${packId}: only ${completed}/${GAMES} rounds completed`);
  }
});

// A house rule is a RULE CHANGE — seven-zero moves whole hands between seats,
// draw-until-playable can drain the pile in one turn, no-passing deletes a
// phase — and every one of those is the shape of thing a deadlock hides in.
// None had ever been simulated.
test("every available house rule also completes every round", async () => {
  for (const packId of ["crazy-eights", "wildfire", "hearts", "thirteen"]) {
    for (const id of await availableVariantIds(packId)) {
      const { completed, stalled, errored } = await simulatePack(packId, GAMES, { variants: [id] });
      assert.strictEqual(stalled + errored, 0, `${packId} + ${id}: ${stalled} stalled, ${errored} threw`);
      assert.strictEqual(completed, GAMES, `${packId} + ${id}: only ${completed}/${GAMES} completed`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * The same games, over the wire
 * ------------------------------------------------------------------ */

// THE BAR IS EQUALITY, NOT A FLOOR — which is a stronger gate than anything
// above and cannot flap.
//
// Protocol mode replays the SAME seeds with the SAME bot, and hands every
// non-host seat's move to a client that must propose it over the stub
// transport. Move selection is therefore bit-identical to the solo run, so the
// two must agree game for game. A percentage bar would have let a whole class
// of failure through: "97% instead of 100%" reads like variance, and there is
// no variance here — one refused frame is one lost game and the numbers say so.
//
// It is also how the gap that made this mode worth building shows up. Four of
// the five packs could not send a card at all (`base#N` ids and `hand.N`
// addresses failed the wire charset) and Milestones could not lay down or hit
// (a meld's `{item, cards, wilds}` was refused as a malformed choice). Every
// one of those is invisible to the solo run and none of them is subtle here:
// the pack simply stops completing rounds.
//
// Milestones used to get four games instead of twelve, because its stalled
// rounds ran to a 12,000-move cap and every move costs a per-seat view. Its
// rounds are fifty-odd moves now, so it pays the same twelve as everyone else.
const PROTOCOL_GAMES_DEFAULT = 12;

// team-spades is here for the move shape as much as for the pack: a bid is the
// first move in the repo that carries a NUMBER as its whole content
// (`choice: {bid: n}`), and a wire validator that dropped it would leave the
// table bidding zero and playing on regardless (#105).
//
// pinochle is here for two more move shapes the wire had never carried: a bid
// whose choice holds a NUMBER AND A STRING together (`{bid, trump}`), and
// `declareMeld`, which ships a list of card ids that never change zone. A
// validator that dropped either would leave the table playing in no trump and
// melding nothing, with every hand still completing cleanly.
for (const packId of ["crazy-eights", "hearts", "wildfire", "stockpile", "milestones", "team-spades",
  "thirteen", "pinochle"]) {
  test(`${packId} plays the same over the protocol as it does in one process`, async () => {
    const games = PROTOCOL_GAMES_DEFAULT;
    const solo = await simulatePack(packId, games, { variants: [] });
    const wire = await simulateProtocolPack(packId, games, { variants: [] });

    assert.strictEqual(wire.errored, 0,
      `${packId}: ${wire.errored} rounds hit a protocol fault — a stall is a rules question, an error is ours`);
    assert.deepStrictEqual(wire, solo,
      `${packId}: the protocol changed the outcome of a game the rules already decided`);
  });
}

test("the rules-complete packs are rules-complete over the wire too", async () => {
  for (const packId of ["crazy-eights", "wildfire", "hearts", "thirteen"]) {
    const { completed, stalled, errored } =
      await simulateProtocolPack(packId, PROTOCOL_GAMES_DEFAULT, { variants: [] });
    assert.strictEqual(stalled + errored, 0, `${packId}: ${stalled} stalled, ${errored} errored over the protocol`);
    assert.strictEqual(completed, PROTOCOL_GAMES_DEFAULT,
      `${packId}: only ${completed}/${PROTOCOL_GAMES_DEFAULT} rounds completed over the protocol`);
  }
});

test("the two floored packs have not got worse", async () => {
  // Floors, not targets. Set below where each actually sits so ordinary
  // seed-to-seed variation does not flap the suite; a real regression halves
  // these long before it reaches either number.
  //
  // Milestones' floor was 0.25 against a measured 31-40%. It now measures
  // 1000/1000 at four seats and 100/100 at every seat count from two to six, so
  // 0.9 is the same kind of number the old one was: a long way below the truth,
  // and a long way ABOVE the 40% the old heuristic managed. Reverting either
  // half of the contract-rummy draw/discard scoring drops this straight through
  // 0.9, which is the regression this line is here to catch.
  const FLOORS = { milestones: 0.9, stockpile: 0.85 };
  for (const [packId, floor] of Object.entries(FLOORS)) {
    const { completed, errored } = await simulatePack(packId, GAMES, { variants: [] });
    assert.strictEqual(errored, 0, `${packId}: ${errored} rounds threw — a stall is documented, a throw is not`);
    const rate = completed / GAMES;
    assert.ok(rate >= floor,
      `${packId}: ${(rate * 100).toFixed(0)}% of rounds completed, below the ${floor * 100}% floor`);
  }
});

/* ------------------------------------------------------------------ *
 * Past round one
 * ------------------------------------------------------------------ */

// EVERY BAR ABOVE PLAYS ROUND ONE AND STOPS, and for Milestones that is the
// round whose contract is two sets. The runs and the colour group are rungs
// four to eight, and that is where a second live-lock sat for as long as the
// harness only ever dealt round one: with a run(8) owed nearly every pile top
// has a neighbour in hand, so two seats took each other's discards every turn
// and the deck never turned. Round one measured 1000/1000 the whole time;
// more than half of two-seat matches never finished (#92).
//
// TWO SEATS, because that is the table where it binds — at four the pile
// changes hands often enough to break the cycle by accident — and because the
// contract-rummy heuristic's whole draw/discard vocabulary was measured at
// four. Gated at 100%: the fix is a potential the round cannot raise forever
// (src/templates/contract-rummy-bot.js, pileGain), not a tuning that happens
// to work, and a stall here is that argument broken.
// TEAM SPADES IS TWO BARS, AND THE SECOND ONE IS THE ONE THAT BIT (#105).
//
// A hand of Spades terminates for the same reason a hand of Hearts does —
// thirteen tricks, one card each, no way to decline — so the round bar is a
// rules-completeness claim like the three above, gated at 100%. What it cannot
// see is the BID, because a hand completes whatever was promised.
//
// The match bar is where a bid is answerable for itself. A match ends when a
// side reaches five hundred, and the first cut of the bidding heuristic never
// got there: the table bid ten of the thirteen tricks between them, paid a
// hundred for every ten bags that made, and drifted DOWNWARDS through a hundred
// rounds — 99 of 100 matches unfinished with every single hand completing
// cleanly. Every bar in this file above this one was green throughout.
test("Team Spades bids, plays and finishes every hand", async () => {
  const { completed, stalled, errored } = await simulatePack("team-spades", GAMES, { variants: [] });
  assert.strictEqual(stalled, 0, `team-spades: ${stalled} stalled rounds`);
  assert.strictEqual(errored, 0, `team-spades: ${errored} rounds threw`);
  assert.strictEqual(completed, GAMES, `team-spades: only ${completed}/${GAMES} rounds completed`);
});

test("a Team Spades match is bid to five hundred, not drifted to a cap", async () => {
  const MATCHES = 10;
  const { completed, stalled, errored } = await simulateMatches("team-spades", MATCHES, { seats: 4, variants: [] });
  assert.strictEqual(errored, 0, `team-spades: ${errored} matches threw`);
  assert.strictEqual(stalled, 0,
    `team-spades: ${stalled} matches never reached the target — a table that under-bids by three `
    + "tricks a hand pays for them in bags and the score goes nowhere");
  assert.strictEqual(completed, MATCHES, `team-spades: only ${completed}/${MATCHES} matches finished`);
});

test("Milestones matches finish at two seats, contract ladder and all", async () => {
  const MATCHES = 12;
  const { completed, stalled, errored } = await simulateMatches("milestones", MATCHES, { seats: 2, variants: [] });
  assert.strictEqual(errored, 0, `milestones: ${errored} matches threw`);
  assert.strictEqual(stalled, 0, `milestones: ${stalled} matches live-locked past round one`);
  assert.strictEqual(completed, MATCHES, `milestones: only ${completed}/${MATCHES} matches finished`);
});

// THE FLOOR IS 100%, WHICH IS THE ONLY HONEST BAR FOR THIS PACK (#102).
//
// Thirteen has no draw pile to exhaust and no reaction to cascade: every trick
// is opened by a seat that MUST play, so every trick sheds at least one card
// and a hand cannot outlive the deck. That is an argument, and this is the
// measurement that checks it — 1000/1000 rounds at four seats, and 200/200 at
// two and at three, when it was written. So it joins the rules-complete list
// above rather than getting an allowance, and the extra bar here is the one
// round one cannot reach: a whole match, carried past the redeal to the
// pack's own game-over rule.
//
// What it catches that round one cannot: `startRound`. The default round
// boundary wipes every playerVars entry, and the seat that went out is
// supposed to lead the next hand — so a template that took the default would
// deal hand two with nobody carrying the lead. Round one never asks.
test("Thirteen matches finish, redeal and all", async () => {
  const MATCHES = 12;
  const { completed, stalled, errored } = await simulateMatches("thirteen", MATCHES, { variants: [] });
  assert.strictEqual(errored, 0, `thirteen: ${errored} matches threw`);
  assert.strictEqual(stalled, 0, `thirteen: ${stalled} matches live-locked past round one`);
  assert.strictEqual(completed, MATCHES, `thirteen: only ${completed}/${MATCHES} matches finished`);
});

/* ------------------------------------------------------------------ *
 * Pinochle (#106)
 * ------------------------------------------------------------------ */

// THREE BARS, AND THE MIDDLE ONE IS THE NEW KIND.
//
// The round bar is the same rules-completeness claim Spades gets: twelve
// tricks, one card each, nobody may decline, so a hand cannot fail to end.
// What it cannot see is either of the two phases in front of it — a hand
// completes whatever was bid and whatever was melded.
//
// The MELD bar is what catches a declaration phase that never closes. It is a
// simultaneous commit like Hearts' pass, and the failure mode is the same
// shape: a seat whose commit is not recorded leaves `actingSeats` offering it
// forever and the hand stalls before a card is led. That is a stall, so the
// round bar would catch it — but only as "0/40 completed", with nothing to say
// which of the three phases hung. Asserting that every hand reaches `play`
// with four melds on the sheet says so directly.
//
// The match bar is where the AUCTION is answerable for itself, exactly as it
// is for Spades: a table that bids what it cannot make loses the whole bid
// every hand, and a table that never opens hands every contract to whoever
// speaks last. Either one still completes every round.
test("Pinochle bids, melds, plays and finishes every hand", async () => {
  const { completed, stalled, errored } = await simulatePack("pinochle", GAMES, { variants: [] });
  assert.strictEqual(stalled, 0, `pinochle: ${stalled} stalled rounds`);
  assert.strictEqual(errored, 0, `pinochle: ${errored} rounds threw`);
  assert.strictEqual(completed, GAMES, `pinochle: only ${completed}/${GAMES} rounds completed`);
});

test("every Pinochle hand gets past the auction and the meld with a trump and four declarations", async () => {
  const pack = await loadPackFromDisk("pinochle");
  for (let game = 0; game < 20; game++) {
    const state = createState({ pack, seats: 4, seed: `meld-bar:${game}` });
    pack.template.setup(makeCtx(state));

    let guard = 0;
    while (state.turn.phase !== "play" && guard++ < 200) {
      const ctx = makeCtx(state);
      const acting = pack.template.actingSeats(ctx);
      let move = null;
      for (const seat of acting) {
        move = chooseBotMove(state, seat);
        if (move) break;
      }
      assert.ok(move, `pinochle game ${game}: no legal move in phase ${state.turn.phase}`);
      applyMove(state, move);
    }
    assert.strictEqual(state.turn.phase, "play",
      `pinochle game ${game}: never reached the first lead — stuck in ${state.turn.phase}`);

    // The auction settled on somebody, and it named a suit the deck holds.
    const bids = state.playerVars.map((v) => v.bid ?? 0);
    assert.ok(Math.max(...bids) >= 100,
      `pinochle game ${game}: nobody holds the contract — bids were ${bids.join(", ")}`);
    assert.ok(["clubs", "diamonds", "hearts", "spades"].includes(state.vars.trumpSuit),
      `pinochle game ${game}: trump is "${state.vars.trumpSuit}"`);

    // Every seat declared, the record is public, and NO CARD LEFT ANY HAND.
    for (let seat = 0; seat < 4; seat++) {
      const meld = state.playerVars[seat].meld;
      assert.ok(meld && Number.isFinite(meld.points),
        `pinochle game ${game}: seat ${seat} reached play with no meld on the sheet`);
      assert.strictEqual(state.playerVars[seat].__pendingMeld, undefined,
        `pinochle game ${game}: seat ${seat} still has a commit pending after the phase closed`);
      assert.strictEqual(state.zones.count(`hand.${seat}`), 12,
        `pinochle game ${game}: seat ${seat} melded cards out of its hand — a meld is scored, not laid down`);
    }
  }
});

test("a Pinochle match is bid to a thousand, not drifted to a cap", async () => {
  const MATCHES = 10;
  const { completed, stalled, errored } = await simulateMatches("pinochle", MATCHES, { seats: 4, variants: [] });
  assert.strictEqual(errored, 0, `pinochle: ${errored} matches threw`);
  assert.strictEqual(stalled, 0,
    `pinochle: ${stalled} matches never reached the target — a table that is set on every hand `
    + "loses the bid it made and the score goes nowhere");
  assert.strictEqual(completed, MATCHES, `pinochle: only ${completed}/${MATCHES} matches finished`);
});

test("Pinochle's simple-counters house rule is the same 250 and the same complete hands", async () => {
  for (const id of await availableVariantIds("pinochle")) {
    const { completed, stalled, errored } = await simulatePack("pinochle", GAMES, { variants: [id] });
    assert.strictEqual(stalled + errored, 0, `pinochle + ${id}: ${stalled} stalled, ${errored} threw`);
    assert.strictEqual(completed, GAMES, `pinochle + ${id}: only ${completed}/${GAMES} completed`);
  }
});

test("Thirteen is rules-complete short-handed too", async () => {
  // D-11: two and three players are 13 cards each with the remainder out of
  // play, which is a different deal shape from the one every bar above uses —
  // at three seats a third of the deck is never seen, so the bot is reasoning
  // about cards that will never come out.
  for (const seats of [2, 3]) {
    const { completed, stalled, errored } =
      await simulatePack("thirteen", GAMES, { seats, variants: [] });
    assert.strictEqual(stalled + errored, 0,
      `thirteen at ${seats} seats: ${stalled} stalled, ${errored} threw`);
    assert.strictEqual(completed, GAMES,
      `thirteen at ${seats} seats: only ${completed}/${GAMES} rounds completed`);
  }
});

/* ------------------------------------------------------------------ *
 * Cribbage, which is a MATCH game and has to be measured as one (#107)
 * ------------------------------------------------------------------ */

// A cribbage HAND is ten moves — two throws to the crib and eight cards laid —
// so the round bar above is a weak claim about it: it barely reaches the play
// and never reaches the show at all. Both bars are here, and the second is the
// one that matters, because everything cribbage does that could deadlock
// happens near the end of a hand: the count reopening after a thirty-one, a go
// scored to the seat that laid last, and the show stopping the instant
// somebody passes 121.
//
// THE ROUND BAR FOUND A REAL DEADLOCK, which is why it is gated at 100% rather
// than floored. Twenty-three games in a thousand stalled with "no legal move
// for seat 1, phase play": a count that closed while one seat still held cards
// and the other did not reopened on the empty seat, whose enumeration is
// nothing (see `openNextCount` in src/templates/cribbage.js). Roughly one hand
// in forty-three — common enough to meet in an evening, rare enough that a
// forty-game bar could have missed it, which is why the manual run is 1000.
test("cribbage completes every hand it is dealt", async () => {
  const { completed, stalled, errored } = await simulatePack("cribbage", GAMES, { variants: [] });
  assert.strictEqual(errored, 0, `cribbage: ${errored} hands threw`);
  assert.strictEqual(stalled, 0, `cribbage: ${stalled} hands stalled`);
  assert.strictEqual(completed, GAMES, `cribbage: only ${completed}/${GAMES} hands completed`);
});

test("every cribbage house rule completes every hand too", async () => {
  // A shorter board and a starter jack that pays nothing are both rule changes
  // at the two moments the game can end early.
  for (const id of await availableVariantIds("cribbage")) {
    const { completed, stalled, errored } = await simulatePack("cribbage", GAMES, { variants: [id] });
    assert.strictEqual(stalled + errored, 0, `cribbage + ${id}: ${stalled} stalled, ${errored} threw`);
    assert.strictEqual(completed, GAMES, `cribbage + ${id}: only ${completed}/${GAMES} completed`);
  }
});

// THE HONEST BAR, and the reason it is a separate test: a cribbage match is
// first to 121 and takes about nine hands, so "did a hand terminate" says
// nothing about whether the board can be pegged out at all. Gated at 100%
// rather than floored — a match that does not finish is a rule that cannot be
// reached, not variance. The manual run is 100 matches; this is a dozen, for
// the same reason every other bar in this file is small.
test("cribbage matches peg all the way out to 121", async () => {
  const MATCHES = 12;
  const { completed, stalled, errored } = await simulateMatches("cribbage", MATCHES, { seats: 2, variants: [] });
  assert.strictEqual(errored, 0, `cribbage: ${errored} matches threw`);
  assert.strictEqual(stalled, 0, `cribbage: ${stalled} matches never reached 121`);
  assert.strictEqual(completed, MATCHES, `cribbage: only ${completed}/${MATCHES} matches finished`);
});

test("cribbage plays the same over the protocol as it does in one process", async () => {
  // Equality, not a floor — see the block above. A simultaneous commit is the
  // shape of move that has failed this gate before (Milestones' meld choices
  // were refused as malformed), and the throw to the crib is one.
  const games = PROTOCOL_GAMES_DEFAULT;
  const solo = await simulatePack("cribbage", games, { variants: [] });
  const wire = await simulateProtocolPack("cribbage", games, { variants: [] });
  assert.strictEqual(wire.errored, 0, `cribbage: ${wire.errored} hands hit a protocol fault`);
  assert.deepStrictEqual(wire, solo,
    "cribbage: the protocol changed the outcome of a hand the rules already decided");
});
