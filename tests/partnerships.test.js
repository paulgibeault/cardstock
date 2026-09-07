// TWO SEATS, ONE SIDE (#104) — the engine half.
//
// Everything here runs against a fixture pack in the test tree
// (tests/fixtures/partnersPack.js) rather than a shipped one: Team Spades
// (#105) is the first real consumer and lands after this, and inventing sides
// for Hearts to prove a primitive would be inventing a game nobody plays.
//
// The felt's half of the same work is tests/seatRing.test.js; the promise that
// a pack WITHOUT sides is untouched is tests/replayIdentity.test.js.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, runScoreRound } from "../src/engine/movePipeline.js";
import { evaluateGameOver } from "../src/engine/scoring.js";
import { chooseBotMove, sideStanding, terminalValue } from "../src/engine/bot.js";
import { forkState } from "../src/engine/fork.js";
import { determinizeState } from "../src/engine/determinize.js";
import { viewFor, visibleCardIds } from "../src/engine/view.js";
import { createRng } from "../src/engine/rng.js";
import {
  sidesOf, sidesFor, sideOfSeat, partnersOf, arePartners, hasSides,
  sideScores, sideScoreOf, teamCount, representativeSeat,
} from "../src/engine/sides.js";
import { placements, sideStandings } from "../src/stats/matchStats.js";
import { PARTNERS_MANIFEST, SOLO_MANIFEST } from "./fixtures/partnersPack.js";
import { validate } from "../tools/schema-check.mjs";
import { ROOT } from "../tools/stage.mjs";

const partners = () => loadPack(structuredClone(PARTNERS_MANIFEST));
const solo = () => loadPack(structuredClone(SOLO_MANIFEST));

function dealt(pack, seed) {
  const state = createState({ pack, seats: 4, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/* ------------------------------------------------------------------ *
 * The declaration
 * ------------------------------------------------------------------ */

test("the fixture pack's `players.teams` is a manifest the schema accepts", async () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, "schema", "manifest.schema.json"), "utf8"));
  assert.deepStrictEqual(validate(PARTNERS_MANIFEST, schema), [],
    "the fixture declares players.teams and the closed manifest schema refuses it");
  assert.deepStrictEqual(validate(SOLO_MANIFEST, schema), []);

  // And the schema is CLOSED, so a typo is caught rather than ignored — the
  // whole reason `players` has additionalProperties: false.
  const typo = { ...PARTNERS_MANIFEST, players: { min: 4, max: 4, team: 2 } };
  assert.notDeepStrictEqual(validate(typo, schema), [],
    "`players.team` (singular) validated — the schema is not closed and a mistyped "
    + "declaration would silently play as a free-for-all");
});

test("seats deal round-robin into sides, and a partner sits opposite", () => {
  const pack = partners();
  assert.strictEqual(teamCount(pack, 4), 2);
  assert.deepStrictEqual(sidesOf(pack, 4).map((s) => [...s]), [[0, 2], [1, 3]]);
  assert.strictEqual(sideOfSeat(pack, 4, 0), 0);
  assert.strictEqual(sideOfSeat(pack, 4, 2), 0);
  assert.deepStrictEqual(partnersOf(pack, 4, 1), [3]);
  assert.ok(arePartners(pack, 4, 0, 2));
  assert.ok(!arePartners(pack, 4, 0, 1));
  assert.ok(!arePartners(pack, 4, 0, 0), "a seat is not its own partner");
  // ACROSS THE TABLE falls out of the round-robin rather than being declared:
  // with equal sides the partner is seats/teams chairs along, which at four
  // seats and two sides is the chair opposite.
  assert.strictEqual((0 + 4 / 2) % 4, 2);
});

test("a pack with no sides has one side per seat, which is what makes the fold an identity", () => {
  const pack = solo();
  assert.strictEqual(teamCount(pack, 4), null);
  assert.ok(!hasSides(pack, 4));
  assert.deepStrictEqual(sidesOf(pack, 4).map((s) => [...s]), [[0], [1], [2], [3]]);
  assert.deepStrictEqual(partnersOf(pack, 4, 0), []);
  assert.deepStrictEqual(sideScores(pack, 4, [3, 5, 7, 11]), [3, 5, 7, 11]);
  assert.strictEqual(representativeSeat(pack, 4, 2), 2);
});

test("a seat count the sides cannot divide is played as a free-for-all, not as a lie", () => {
  // The honest failure. `players.min`/`max` is what stops this arising — the
  // fixture declares 4 and 4 — but a mis-seated table must stay playable rather
  // than crash the deal or put three chairs on a two-handed side.
  const pack = partners();
  assert.strictEqual(teamCount(pack, 5), null);
  assert.deepStrictEqual(sidesOf(pack, 5).map((s) => [...s]), [[0], [1], [2], [3], [4]]);
  assert.deepStrictEqual(sidesFor(2, 5).map((s) => [...s]), [[0], [1], [2], [3], [4]]);
  assert.deepStrictEqual(sidesFor(2, 6).map((s) => [...s]), [[0, 2, 4], [1, 3, 5]]);
});

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

test("a round's per-seat deltas fold into the side that took them", () => {
  const pack = partners();
  const state = dealt(pack, "fold");
  // Emptied and re-stocked by hand: what is being tested is the FOLD, and a
  // played-out hand would test the trick rules on the way past.
  for (const address of state.zones.allAddresses()) state.zones.get(address).cards.length = 0;
  const put = (address, ids) => {
    state.zones.get(address).cards.push(...ids);
    for (const id of ids) state.cardLocation.set(id, address);
  };
  put("won.0", ["clubs-2", "clubs-3", "clubs-4"]);          // 3 to side 0
  put("won.1", ["hearts-2"]);                                // 1 to side 1
  put("won.2", ["spades-2", "spades-3"]);                    // 2 to side 0
  put("won.3", ["diamonds-2", "diamonds-3", "diamonds-4", "diamonds-5"]); // 4 to side 1

  const round = runScoreRound(state);
  assert.deepStrictEqual(round, { 0: 3, 1: 1, 2: 2, 3: 4 },
    "the template still returns PER-SEAT deltas — the fold is the engine's, not the template's");

  for (const [seat, delta] of Object.entries(round)) state.scores[Number(seat)] += delta;
  assert.deepStrictEqual(sideScores(pack, 4, state.scores), [5, 5],
    "three cards to seat 0 and two to its partner is five to their side");
  assert.strictEqual(sideScoreOf(pack, 4, state.scores, 2), 5);
});

test("`anyScore >= N` is any SIDE's score, so a partnership plays to the target once", () => {
  const pack = partners();
  const state = dealt(pack, "gameover");

  // Sixteen apiece across a side is thirty-two — over the target of thirty —
  // while no single SEAT has more than sixteen. Points are the penalty here, so
  // the side that did NOT reach it wins, and it is named by its canonical seat
  // (state.winner is a seat and stays one — src/engine/sides.js says why).
  state.scores = [16, 4, 16, 4];
  assert.deepStrictEqual(evaluateGameOver(makeCtx(state)), { over: true, winner: 1 },
    "the side on 32 did not reach a target of 30: game-over is still comparing seats");

  // And one expensive seat does not end a match its side has survived.
  state.scores = [2, 29, 2, 0];
  assert.deepStrictEqual(evaluateGameOver(makeCtx(state)), { over: false },
    "one seat on 29 ended a match whose target is 30 — a seat is being read as a side");

  state.scores = [1, 20, 1, 20];
  assert.deepStrictEqual(evaluateGameOver(makeCtx(state)), { over: true, winner: 0 },
    "the cheaper side (2) did not win against the dearer one (40)");
});

test("a teamless pack reaches game over on exactly the seat totals it always did", () => {
  const pack = solo();
  const state = dealt(pack, "gameover-solo");
  state.scores = [16, 4, 16, 4];
  assert.deepStrictEqual(evaluateGameOver(makeCtx(state)), { over: false },
    "two seats on 16 ended a 30-point free-for-all — the fold is not the identity here");
  state.scores = [2, 31, 2, 0];
  assert.deepStrictEqual(evaluateGameOver(makeCtx(state)), { over: true, winner: 3 });
});

/* ------------------------------------------------------------------ *
 * Standings
 * ------------------------------------------------------------------ */

test("`placements` names sides: partners share a place and neither beats the other", () => {
  const pack = partners();
  const totals = [20, 3, 4, 5];   // side 0: 24, side 1: 8 — cheapest wins here
  const rank = placements(pack, { totals, winner: 1, seats: 4 });
  assert.deepStrictEqual(rank, [1, 0, 1, 0],
    "partners did not finish together — the record would claim you beat your own partner");

  const standing = sideStandings(pack, { totals, winner: 1, seats: 4 });
  assert.deepStrictEqual(standing, [
    { side: 1, seats: [1, 3], total: 8 },
    { side: 0, seats: [0, 2], total: 24 },
  ], "the end-of-match sheet cannot name a winning PAIR from this");
});

test("the losing side is the losing side even when it holds the second-best seat", () => {
  const pack = partners();
  // Seat 3 is the cheapest chair at the table and still finishes second: its
  // partner took eleven, and a side is what its two chairs add up to.
  const totals = [1, 11, 2, 0];   // side 0: 3, side 1: 11
  assert.deepStrictEqual(placements(pack, { totals, winner: 0, seats: 4 }), [0, 1, 0, 1]);
});

test("a teamless pack still ranks seat by seat, winner pinned first", () => {
  const pack = solo();
  const rank = placements(pack, { totals: [5, 1, 9, 3], winner: 1, seats: 4 });
  // lowestScore: 1 then 3 then 5 then 9, and the declared winner is pinned first
  // regardless — which here it already was.
  assert.deepStrictEqual(rank, [2, 0, 3, 1]);
});

/* ------------------------------------------------------------------ *
 * The view layer
 * ------------------------------------------------------------------ */

test("a partner's hand is as hidden as an opponent's", () => {
  // NO NEW VISIBILITY VALUE WAS NEEDED — `owner` already says this — but the
  // whole point of partnerships is a bot and a player who cooperate, and
  // "cooperate" is exactly the word under which somebody eventually decides a
  // partner should be allowed to look. So it is written down.
  const pack = partners();
  const state = dealt(pack, "view");
  const seat = 0;
  const partner = partnersOf(pack, 4, seat)[0];
  assert.strictEqual(partner, 2);

  const view = viewFor(state, seat);
  assert.ok(Array.isArray(view.zones["hand.0"].cards), "a seat cannot see its own hand");
  assert.strictEqual(view.zones[`hand.${partner}`].cards, undefined,
    "the partner's hand was sent to seat 0 — a partnership is not a shared hand");
  assert.strictEqual(view.zones["hand.1"].cards, undefined);
  // The COUNT is public for a partner exactly as it is for an opponent.
  assert.strictEqual(view.zones[`hand.${partner}`].count, state.zones.count(`hand.${partner}`));

  const visible = visibleCardIds(state, seat);
  for (const id of state.zones.cards(`hand.${partner}`)) {
    assert.ok(!visible.has(id), `${id} is in the partner's hand and seat 0 is entitled to see it`);
  }
});

/* ------------------------------------------------------------------ *
 * The bot
 * ------------------------------------------------------------------ */

/** Walk a bot-vs-bot game, calling `visit(state, seat)` before each move. */
function walk(state, limit, visit) {
  const template = state.pack.template;
  for (let i = 0; i < limit && !state.gameOver; i++) {
    const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    let move = null;
    let actor = null;
    for (const seat of acting) {
      move = chooseBotMove(state, seat);
      if (move) { actor = seat; break; }
    }
    if (!move) return;
    visit(state, actor);
    applyMove(state, move);
    if (state.events.some((e) => e.type === "roundOver")) return;
  }
}

/** A reproducible `hard` decision — see tests/rollouts.test.js for why. */
const hardOptions = () => ({
  difficulty: "hard",
  random: createRng("partners:probe").next,
  budgetMs: Infinity,
  budgetMoves: 900,
});

const key = (move) => JSON.stringify(move);

/**
 * Trade the PARTNER's hand with an opponent's, on a fork.
 *
 * EQUAL LENGTHS ONLY, for the reason tests/rollouts.test.js gives at length: a
 * hand's size is public, every evaluator legitimately reads it, and swapping a
 * five for an eight changes information the seat was entitled to. This is the
 * partner-shaped version of that probe — the arrangement across two hands the
 * seat cannot see moves, and nothing it may see does.
 *
 * @returns the forked state, or null when the two hands are different sizes.
 */
function tradePartnerAndOpponent(state, seat, partner, opponent) {
  const a = state.zones.cards(`hand.${partner}`);
  const b = state.zones.cards(`hand.${opponent}`);
  if (a.length === 0 || a.length !== b.length) return null;
  const fork = forkState(state);
  const held = a.slice();
  const other = b.slice();
  fork.zones.get(`hand.${partner}`).cards.splice(0, held.length, ...other);
  fork.zones.get(`hand.${opponent}`).cards.splice(0, other.length, ...held);
  for (const id of other) fork.cardLocation.set(id, `hand.${partner}`);
  for (const id of held) fork.cardLocation.set(id, `hand.${opponent}`);
  return fork;
}

test("the hard bot plays WITH its partner without reading its partner's hand", async () => {
  const pack = partners();
  let probed = 0;
  let differed = 0;
  for (let game = 0; game < 2; game++) {
    const state = dealt(pack, `fairness:partners:${game}`);
    walk(state, 60, (live, seat) => {
      if (probed >= 40) return;
      const partner = partnersOf(pack, 4, seat)[0];
      const opponent = sidesOf(pack, 4)[1 - sideOfSeat(pack, 4, seat)][0];
      const traded = tradePartnerAndOpponent(live, seat, partner, opponent);
      if (!traded) return;

      const real = chooseBotMove(live, seat, hardOptions());
      assert.strictEqual(key(chooseBotMove(traded, seat, hardOptions())), key(real),
        `seat ${seat} played differently once its PARTNER's hand and an opponent's changed `
        + "places. Nothing it may legitimately see moved, so the rollouts are reading its "
        + "partner's cards — a bot that always knew what its partner was holding");

      // The stronger form, covering the deck as well as the two hands: every
      // hidden card dealt somewhere else, counts untouched by construction.
      const stranger = determinizeState(live, seat, createRng(`stranger:${probed}`).next);
      assert.strictEqual(key(chooseBotMove(stranger, seat, hardOptions())), key(real),
        `seat ${seat} played differently once every card it cannot see was dealt somewhere `
        + "else — the decision depends on the hidden arrangement");

      probed += 1;
      if (key(real) !== key(chooseBotMove(live, seat))) differed += 1;
    });
  }
  assert.ok(probed >= 20, `only ${probed} positions probed — too few to conclude anything`);
  // A gate that passes because the rollouts never ran is a gate on nothing.
  assert.ok(differed > 0,
    `across ${probed} positions the hard chooser never once played something the medium chooser `
    + "would not have — the rollout layer is not running and this proves nothing");
});

/**
 * Run `body` with the template answering `matchStanding` differently.
 *
 * Templates are module singletons and a pack shares one, hence the restore.
 */
function withStanding(pack, hook, body) {
  const template = pack.template;
  const had = Object.prototype.hasOwnProperty.call(template, "matchStanding");
  const real = template.matchStanding;
  template.matchStanding = hook;
  try {
    return body();
  } finally {
    if (had) template.matchStanding = real;
    else delete template.matchStanding;
  }
}

test("a seat's standing in the match is its SIDE's standing", () => {
  // ARITHMETIC, NOT A SAMPLING RUN. Whether silencing a partner changes what a
  // Monte Carlo bot happens to play is a question about sample noise, and a
  // probe that answers it passes for the wrong reason as readily as the right
  // one. This is the number the rollout actually grades with.
  const pack = partners();
  const state = dealt(pack, "standing");
  state.scores = [7, 5, 9, 4];
  // Points are the penalty in this pack, so the standing is the negated total —
  // the sign `scoring.gameOver.winner` decides, and the one thing a pack can get
  // wrong to produce a bot that plays to lose.
  assert.strictEqual(sideStanding(state, 0), -16);
  assert.strictEqual(sideStanding(state, 2), -16,
    "two partners reported different standings — they are playing for one score");
  assert.strictEqual(sideStanding(state, 1), -9);

  const bare = dealt(solo(), "standing-solo");
  bare.scores = [7, 5, 9, 4];
  assert.strictEqual(sideStanding(bare, 0), -7,
    "a pack with no sides folded a second seat into its standing");

  // A template that answers for itself is asked per SEAT (that is the documented
  // hook, and a chair is all a template can see) and folded here.
  withStanding(pack, (ctx, seat) => seat * 10, () => {
    assert.strictEqual(sideStanding(state, 0), 20, "0 and 2 is 0 + 20");
    assert.strictEqual(sideStanding(state, 1), 40, "1 and 3 is 10 + 30");
  });
  // And a hook with no answer for one seat on the side has no answer for the side.
  withStanding(pack, (ctx, seat) => (seat === 2 ? null : 1), () => {
    assert.strictEqual(sideStanding(state, 0), null);
    assert.strictEqual(sideStanding(state, 1), 2);
  });
});

test("a finished hand is graded against the other SIDES, so a partner's points are yours", () => {
  // THE BUG THIS IS THE FIX FOR, written as two numbers. A rollout is graded by
  // how much further along the match it left the seat against how much further
  // along it left everyone else — and "everyone else" counted SEATS, so a
  // partner taking ten penalty points landed in the average the deciding seat
  // is trying to beat. The bot was rewarded for its own side's disaster.
  const pack = partners();
  const before = dealt(pack, "outcome");
  before.scores = [0, 0, 0, 0];

  const partnerSuffered = dealt(pack, "outcome");
  partnerSuffered.scores = [0, 0, 10, 0];
  assert.strictEqual(terminalValue(before, partnerSuffered, 0), -10,
    "seat 0's partner took ten penalty points and the hand did not grade as a loss for seat 0");

  const opponentSuffered = dealt(pack, "outcome");
  opponentSuffered.scores = [0, 10, 0, 0];
  assert.strictEqual(terminalValue(before, opponentSuffered, 0), 10,
    "an opponent took ten penalty points and the hand did not grade as a win for seat 0");

  // Counted seat by seat, BOTH of those come out at +10/3 — the same answer,
  // and the wrong sign for the first. That is the arithmetic this replaces.
  assert.notStrictEqual(terminalValue(before, partnerSuffered, 0),
    terminalValue(before, opponentSuffered, 0));

  // And a teamless pack grades exactly as it always did: own minus the mean of
  // the other three seats.
  const bare = dealt(solo(), "outcome-solo");
  bare.scores = [0, 0, 0, 0];
  const bareAfter = dealt(solo(), "outcome-solo");
  bareAfter.scores = [0, 0, 30, 0];
  assert.strictEqual(terminalValue(bare, bareAfter, 0), 10,
    "a free-for-all no longer grades a hand as own-minus-the-average-of-the-rest");
});

test("a side's standing is the sum over its seats, so a teamless pack is unchanged", () => {
  // The same probe on the teamless control: with one seat per side, silencing
  // "the partner" is silencing a seat on the OTHER side, which of course
  // changes things — so the claim here is the narrower one that the pack with
  // no sides never consults a second seat for its own standing. That is what
  // tests/replayIdentity.test.js proves end to end; this pins the arithmetic.
  const pack = solo();
  assert.deepStrictEqual(sideScores(pack, 4, [7, 5, 9, 4]), [7, 5, 9, 4]);
  assert.strictEqual(sideScoreOf(pack, 4, [7, 5, 9, 4], 2), 9);
  const teamed = partners();
  assert.deepStrictEqual(sideScores(teamed, 4, [7, 5, 9, 4]), [16, 9]);
  assert.strictEqual(sideScoreOf(teamed, 4, [7, 5, 9, 4], 2), 16);
});

/* ------------------------------------------------------------------ *
 * End to end
 * ------------------------------------------------------------------ */

test("a partnership match plays out and is won by a side", () => {
  const pack = partners();
  const state = dealt(pack, "endtoend");
  const template = pack.template;
  let moves = 0;
  while (!state.gameOver && moves < 4000) {
    const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    let move = null;
    for (const seat of acting) {
      move = chooseBotMove(state, seat);
      if (move) break;
    }
    if (!move) break;
    applyMove(state, move);
    moves += 1;
  }
  assert.ok(state.gameOver, `the fixture never finished a match in ${moves} moves`);
  const totals = sideScores(pack, 4, state.scores);
  assert.ok(Math.max(...totals) >= 30, `no side reached the target: ${JSON.stringify(totals)}`);
  const winningSide = sideOfSeat(pack, 4, state.winner);
  assert.strictEqual(totals[winningSide], Math.min(...totals),
    "the match was won by a side that is not the cheapest one");
  // 52 cards at a point each, so every hand played is worth 52 between the two
  // sides. The round counter stops where the match did.
  assert.strictEqual(totals[0] + totals[1], 52 * state.roundNumber,
    "the two sides' totals do not add up to the cards that were dealt");
});
