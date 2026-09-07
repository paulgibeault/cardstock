// The fifth template, and the four things it had to buy (THIRTEEN_RULES.md §3.2).
//
// The rule TABLE — what beats what, what is a run, what a bomb chops — is in
// packs/thirteen/tests/rules.test.json, where a pack author can read it without
// reading JavaScript. What is here is everything that is a claim about the
// TEMPLATE rather than about Thirteen:
//
//   1. the enumeration is a shortlist, and everything on it is legal;
//   2. a seat that has passed is out, in the enumerator AND in the scheduler,
//      because a disagreement between those two is a bot offered a move that
//      throws or a felt whose turn token points at nobody;
//   3. the order is the pack's TOTAL order, suit included, and not `rankOrder`;
//   4. the new interaction mode's legality is live and exact.
//
// (2) and (4) also stand in for something this repo cannot do headlessly: the
// Browser pane cannot load game iframes and there is no browser automation on
// this machine, so the felt itself was NOT exercised for this change. These are
// the pure halves of the two surfaces a human would have found a bug in.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, validateMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { buildUiModel, selectionLegality, interactionMode, handAddress } from "../src/ui/interaction.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { cardOrder, rankLadderOf } from "../src/engine/cards.js";
import { determinizeState } from "../src/engine/determinize.js";
import { createRng } from "../src/engine/rng.js";

const PACK = "thirteen";

async function dealt(seats = 4, seed = "climbing", variants = undefined) {
  const pack = await loadPackFromDisk(PACK, variants);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/** Who may act, straight off the template's own hook. */
function acting(state) {
  const template = state.pack.template;
  return template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
}

/* ------------------------------------------------------------------ *
 * 1. The enumeration
 * ------------------------------------------------------------------ */

test("every move the enumerator offers is one the engine accepts", async () => {
  // The contract's own words: a bot picks from this list and every tap target
  // is derived from it, so a move on it that validateMove refuses is a move
  // that throws in front of a player.
  //
  // TWENTY-FOUR HANDS, WHERE #102 NEEDED TWELVE, and the reason is the whole
  // point of #103: `evaluateState` keeps its runs together, so a hand ends in
  // 36 moves where the greedy bot took 44 and each game offers the sweep
  // fewer positions. The bar is a count of MOVES CHECKED and it stays where it
  // was; what moved is how many deals it takes to reach it.
  let checked = 0;
  for (let game = 0; game < 24; game++) {
    const state = await dealt(4, `enum:${game}`);
    for (let step = 0; step < 400 && !state.gameOver; step++) {
      const seat = acting(state)[0];
      if (seat === undefined) break;
      const moves = enumerateLegalMoves(state, seat);
      if (!moves.length) break;
      for (const move of moves) {
        const verdict = validateMove(state, move);
        assert.ok(verdict.legal,
          `enumerated a ${move.type} of ${(move.cards || []).join("+")} that the engine refuses `
          + `(${verdict.rule}: ${verdict.reason})`);
        checked++;
      }
      applyMove(state, chooseBotMove(state, seat));
      if (state.events.some((e) => e.type === "roundOver")) break;
    }
  }
  assert.ok(checked > 2000, `only ${checked} enumerated moves were checked — the sweep found nothing to do`);
});

test("the enumeration is bounded by the hand's SHAPE, not by its subsets", async () => {
  // THE BUDGET, ASSERTED — on a CONSTRUCTED hand rather than a dealt one,
  // because a random deal cannot tell the two designs apart. The difference
  // between a shape walk and a subset walk is the SUIT VARIANTS: every run and
  // every strip of consecutive pairs can be built from any card of each rank,
  // and those variants are the same play (a run is compared by its top card
  // alone). A hand of thirteen distinct ranks has none of them, so both designs
  // agree there; a hand of three ranks in every suit is nothing but them.
  //
  //   three ranks × four suits, shape walk   55 moves
  //   the same hand, walking the subsets    325 moves — 64 runs and 216 strips
  //                                         that differ only in which 5 is on
  //                                         the bottom
  //
  // The bar sits between them. It is not a performance test: 8,191 subsets is
  // cheap enough in milliseconds. It is that the LIST is what a bot ranks and
  // what the host ships a joiner with every view, and six times the list to say
  // the same thing is six times the wire and a bot choosing between duplicates.
  const pack = await loadPackFromDisk(PACK);
  const state = createState({ pack, seats: 4, seed: "budget" });
  pack.template.setup(makeCtx(state));

  const hand = ["3", "4", "5"].flatMap((rank) =>
    ["spades", "clubs", "diamonds", "hearts"].map((suit) => `${suit}-${rank}`));
  for (let seat = 0; seat < 4; seat++) {
    const addr = handAddress(seat);
    state.zones.get(addr).cards.length = 0;
  }
  const addr = handAddress(0);
  state.zones.get(addr).cards.push(...hand);
  for (const id of hand) state.cardLocation.set(id, addr);
  for (let seat = 1; seat < 4; seat++) {
    const other = `${handAddress(seat)}`;
    state.zones.get(other).cards.push(`hearts-${seat + 6}`);
    state.cardLocation.set(`hearts-${seat + 6}`, other);
  }
  state.turn.seat = 0;
  state.vars.combo = null;
  state.vars.passed = [];
  for (let seat = 0; seat < 4; seat++) state.playerVars[seat].__mustInclude = null;

  const worst = enumerateLegalMoves(state, 0).length;
  assert.ok(worst >= 40, `the worst-shape hand only enumerated ${worst} — the bar would prove nothing`);
  assert.ok(worst <= 120,
    `a twelve-card hand of three ranks enumerated ${worst} moves; the shape walk gives 55 and `
    + "a subset walk 325, so this is the subset walk");

  // And the ordinary case, dealt: measured over 300 four-seat hands the worst
  // LEADING seat enumerated 31 moves against a mean of 6.5, and the worst
  // ANSWERING seat 14 against a mean of 3.6 — an answering seat is smaller
  // because the led kind and size fix the shape.
  let worstLead = 0;
  let worstAnswer = 0;
  for (let game = 0; game < 40; game++) {
    const dealtState = await dealt(4, `budget:${game}`);
    for (let step = 0; step < 400 && !dealtState.gameOver; step++) {
      const seat = acting(dealtState)[0];
      if (seat === undefined) break;
      const n = enumerateLegalMoves(dealtState, seat).length;
      if (!n) break;
      if (dealtState.vars.combo) worstAnswer = Math.max(worstAnswer, n);
      else worstLead = Math.max(worstLead, n);
      applyMove(dealtState, chooseBotMove(dealtState, seat));
      if (dealtState.events.some((e) => e.type === "roundOver")) break;
    }
  }
  assert.ok(worstLead > 0 && worstAnswer > 0, "the sweep never saw both a lead and an answer");
  assert.ok(worstLead <= 90, `a leading seat enumerated ${worstLead} moves`);
  assert.ok(worstAnswer <= 40, `an answering seat enumerated ${worstAnswer} moves`);
});

/* ------------------------------------------------------------------ *
 * 2. A trick seats drop out of
 * ------------------------------------------------------------------ */

test("a seat that has passed is offered nothing for the rest of the trick", async () => {
  const state = await dealt(4, "passed");
  const leader = state.turn.seat;
  applyMove(state, chooseBotMove(state, leader));
  const answerer = state.turn.seat;
  assert.notStrictEqual(answerer, leader, "the turn did not move off the leader");

  assert.ok(enumerateLegalMoves(state, answerer).length, "an answering seat had nothing at all");
  applyMove(state, { actor: answerer, type: "pass" });

  assert.ok(state.vars.passed.includes(answerer), "the pass was not recorded");
  assert.ok(!acting(state).includes(answerer), "a passed seat is still being scheduled");

  // ASKED WITH THE TURN FORCED BACK ONTO THEM, because otherwise this passes
  // for the wrong reason: an off-turn seat is offered nothing and refused with
  // `turn` whether or not it has passed, so the assertion would hold in a build
  // where passing did nothing at all. What is being tested is that the pass is
  // FINAL — that the play coming back around below you changes nothing.
  const hand = state.zones.cards(handAddress(answerer));
  const wasTurn = state.turn.seat;
  state.turn.seat = answerer;
  try {
    assert.deepStrictEqual(enumerateLegalMoves(state, answerer), [],
      "a passed seat is still being offered moves");
    assert.strictEqual(
      validateMove(state, { actor: answerer, type: "playCard", cards: [hand[0]] }).rule, "passed",
      "a passed seat can still play");
    assert.strictEqual(validateMove(state, { actor: answerer, type: "pass" }).rule, "passed",
      "a passed seat can pass again");
    assert.deepStrictEqual(acting(state), [], "a passed seat on the turn is still scheduled");
  } finally {
    state.turn.seat = wasTurn;
  }
});

test("the felt's turn token and the bot scheduler never disagree", async () => {
  // `actingSeats` and `turn.seat` are two answers to one question, and the felt
  // draws its token from the second while src/ui/botDriver.js schedules from the
  // first. A template whose applyMove leaves the turn on a seat that has passed
  // or gone out makes them disagree, and the symptom is a table that stops.
  for (let game = 0; game < 12; game++) {
    const state = await dealt(4, `token:${game}`);
    for (let step = 0; step < 400 && !state.gameOver; step++) {
      const seats = acting(state);
      assert.deepStrictEqual(seats, [state.turn.seat],
        `step ${step}: actingSeats says ${JSON.stringify(seats)}, the turn token says ${state.turn.seat}`);
      const moves = enumerateLegalMoves(state, seats[0]);
      assert.ok(moves.length, `step ${step}: seat ${seats[0]} is on the turn with no legal move`);
      applyMove(state, chooseBotMove(state, seats[0]));
      if (state.events.some((e) => e.type === "roundOver")) break;
    }
  }
});

/* ------------------------------------------------------------------ *
 * 3. The order is the pack's, and it is total
 * ------------------------------------------------------------------ */

test("the ladder decides, suit included — not the rank alone", async () => {
  const state = await dealt(4, "order");
  const ladder = rankLadderOf(state.pack);
  const at = (id) => cardOrder(state.pack.cardsById.get(id), ladder);

  // The 2 is the top of the game and the 3 the bottom, which is not the deck's
  // own order and not a rotation of it.
  assert.ok(at("spades-2") > at("hearts-A"), "the 2 does not outrank the ace");
  assert.ok(at("spades-3") < at("spades-4"), "the 3 is not the bottom of the ladder");
  // The tiebreak that makes it TOTAL: no two cards are equal (D-5).
  const seen = new Set([...state.pack.cardsById.keys()].map(at));
  assert.strictEqual(seen.size, state.pack.cardsById.size, "two cards share a place on the order");
  assert.ok(at("hearts-9") > at("clubs-9") && at("clubs-9") > at("spades-9"),
    "the suit ladder is not breaking the tie");
});

test("the template never reaches for the rank-only order", () => {
  // `rankOrder` is the function that put the jack on top of the nine
  // (src/engine/cards.js), and it is rank-only, so it cannot separate 9♥9♦ from
  // 9♣9♠ — a pair comparison built on it has ties, and a tie in this genre is a
  // position with no legal answer and no legal refusal. Comments are stripped
  // because this file's header talks about it at length.
  const source = fs.readFileSync(path.join(ROOT, "src/templates/climbing.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\brankOrder\b/,
    "climbing must compare with cardOrder, which is total; rankOrder is not");
});

/* ------------------------------------------------------------------ *
 * 4. The new interaction mode
 * ------------------------------------------------------------------ */

test("the commit button arms exactly when the selection is a legal play", async () => {
  const state = await dealt(4, "mode");
  const seat = state.turn.seat;
  assert.strictEqual(interactionMode(state), "combination");

  const from = handAddress(seat);
  const hand = state.zones.cards(from);
  const moves = enumerateLegalMoves(state, seat);
  const model = (cardIds) => buildUiModel(state, {
    seat, moves, acts: true, selection: cardIds.length ? { from, cardIds } : null,
  });

  // Every card lifts: legality is a property of the SET, so there is no
  // per-card answer to grey one out with.
  assert.strictEqual(model([]).handSelectable.size, hand.length);
  assert.ok(model([]).handMulti, "the mode does not multi-select");

  // A legal combination arms the button, and the move it makes is one the
  // engine accepts.
  const play = moves.find((m) => m.type === "playCard" && m.cards.length > 1)
    || moves.find((m) => m.type === "playCard");
  const armed = model(play.cards.slice()).action;
  assert.ok(armed, "a legal selection left the button unarmed");
  assert.match(armed.label, /^Play \d+$/);
  assert.ok(validateMove(state, armed.makeMove()).legal, "the armed button makes an illegal move");

  // A selection that is not a play arms nothing — which is the live answer the
  // player gets as cards go in, rather than a surprise at commit.
  const bad = hand.filter((id) => !play.cards.includes(id)).slice(0, 1).concat(play.cards[0]);
  if (bad.length > 1 && !selectionLegality(state, seat, bad).legal) {
    assert.strictEqual(model(bad).action, null, "an illegal selection armed the commit button");
  }
});

test("passing is offered on an empty selection, and never while cards are staged", async () => {
  const state = await dealt(4, "mode-pass");
  const leader = state.turn.seat;
  applyMove(state, chooseBotMove(state, leader));
  const seat = state.turn.seat;
  const from = handAddress(seat);
  const moves = enumerateLegalMoves(state, seat);
  assert.ok(moves.some((m) => m.type === "pass"), "an answering seat cannot pass");

  const empty = buildUiModel(state, { seat, moves, acts: true, selection: null });
  assert.deepStrictEqual(empty.action && empty.action.label, "Pass");
  assert.ok(validateMove(state, empty.action.makeMove()).legal);

  // Mid-gather the button must not flip out from under the player.
  const staged = buildUiModel(state, {
    seat, moves, acts: true, selection: { from, cardIds: [state.zones.cards(from)[0]] },
  });
  assert.ok(staged.action === null || staged.action.label.startsWith("Play"),
    `the button read "${staged.action && staged.action.label}" while cards were staged`);
});

test("a leading seat is never offered a pass — somebody has to play", async () => {
  const state = await dealt(4, "lead");
  const moves = enumerateLegalMoves(state, state.turn.seat);
  assert.ok(!moves.some((m) => m.type === "pass"), "the leader was offered a pass");
  assert.strictEqual(
    validateMove(state, { actor: state.turn.seat, type: "pass" }).rule, "must-lead");
});

/* ------------------------------------------------------------------ *
 * 5. The position evaluator, and the one thing it must not know (#103)
 * ------------------------------------------------------------------ */

test("the evaluator judges the position without seeing the hands it is judging against", async () => {
  // THE FAIRNESS GATE FOR THE ONE-PLY PATH, and it has to live here because
  // the one in tests/rollouts.test.js cannot reach it. That gate probes the
  // `hard` chooser, which DEALS ITSELF AN IGNORANT WORLD before it looks at
  // anything (src/engine/determinize.js) — so a peeking `evaluateState` is
  // invisible to it by construction. `medium` is the path where the evaluator
  // reads the real state, and `chooseBotMove(state, seat)` with no options is
  // exactly that, deterministic and with no sampling in the way.
  //
  // The probe is the strongest form the rollout gate uses: resample EVERY card
  // this seat cannot see into the slots it came from. Hand sizes, the pile and
  // the discard are untouched by construction, so everything the seat is
  // ENTITLED to know is identical and any change in the answer is a change in
  // what was read. This game makes the temptation concrete — "can they chop my
  // pig" is the question a Thirteen player most wants answered and the one
  // that is not theirs to ask.
  let probed = 0;
  for (let game = 0; game < 8; game++) {
    const state = await dealt(4, `blind:${game}`);
    for (let step = 0; step < 400 && !state.gameOver; step++) {
      const seat = acting(state)[0];
      if (seat === undefined) break;
      const chosen = JSON.stringify(chooseBotMove(state, seat));
      for (const sample of [1, 2, 3]) {
        const stranger = determinizeState(state, seat, createRng(`stranger:${game}:${step}:${sample}`).next);
        assert.strictEqual(JSON.stringify(chooseBotMove(stranger, seat)), chosen,
          `seat ${seat} played differently once every card it cannot see was dealt somewhere `
          + "else — evaluateState is reading hands, not the position");
      }
      probed += 1;
      applyMove(state, chooseBotMove(state, seat));
      if (state.events.some((e) => e.type === "roundOver")) break;
    }
  }
  assert.ok(probed > 200, `only ${probed} decisions probed — too few to conclude anything`);
});

/* ------------------------------------------------------------------ *
 * 6. The two house rules that change what is LEGAL (#103)
 * ------------------------------------------------------------------ *
 *
 * The rule TABLE for all three variants is in the pack, as always
 * (packs/thirteen/tests/rules.test.json). What is here is the half a
 * given-state table cannot reach: the DEAL-TIME check, which no constructed
 * setup can invoke, and the ENUMERATOR, which is what a bot picks from.
 */

/** The ladder, low to high, as this pack declares it. */
const LADDER = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const rankOf = (id) => id.slice(id.indexOf("-") + 1);

/**
 * Is this hand one of the five tới trắng shapes?
 *
 * WRITTEN OUT LONGHAND AND FROM THE RULES DOC (THIRTEEN_RULES.md D-8), not
 * from the template — a checker that called the template's own would agree
 * with it about anything, including about being wrong.
 */
function instantHand(cards) {
  const counts = new Map();
  for (const id of cards) counts.set(rankOf(id), (counts.get(rankOf(id)) || 0) + 1);
  const held = (rank, n) => (counts.get(rank) || 0) >= n;

  // `slice(0, 12)` throughout: the 2 sits at the top of the ladder and no
  // sequence may contain it, so every consecutive shape stops at the ace.
  if (held("2", 4)) return "four 2s";
  if ([...counts.values()].filter((n) => n >= 2).length >= 6) return "six pairs";
  if (LADDER.slice(0, 12).every((rank) => held(rank, 1))) return "a dragon";
  for (const [n, len, name] of [[2, 5, "five consecutive pairs"], [3, 3, "three consecutive triples"]]) {
    for (let start = 0; start + len <= 12; start++) {
      if (LADDER.slice(start, start + len).every((rank) => held(rank, n))) return name;
    }
  }
  return null;
}

test("instant-wins: the deal that has already won is found, and its hand is the only move", async () => {
  // THE CHECK IS AT THE DEAL, so it cannot be reached from a constructed
  // position — the pack's rule table asserts what happens once the var is set
  // and this asserts that it is ever set, and set for the right hands.
  //
  // A SWEEP RATHER THAN A STACKED DECK: `dealHands` shuffles, so the only way
  // in is the seed, and roughly one deal in thirty-five at four seats is a tới
  // trắng (measured: 587 of 20,000). Four hundred deals is comfortably enough
  // to see a dozen and cheap enough to keep in the suite.
  let fired = 0;
  const shapes = new Set();
  for (let game = 0; game < 400; game++) {
    const state = await dealt(4, `instant:${game}`, ["instant-wins"]);
    const declared = state.vars.instantWin;
    for (let seat = 0; seat < 4; seat++) {
      const hand = state.zones.cards(handAddress(seat));
      const truth = instantHand(hand);
      // Seat order settles a double, so a later seat may hold one and not be
      // the one named. Anybody NAMED must be holding one.
      if (declared && declared.seat === seat) {
        assert.ok(truth, `seat ${seat} was declared an instant win holding ${hand.join(" ")}`);
      } else if (!declared) {
        assert.strictEqual(truth, null,
          `seat ${seat} was dealt ${truth} and nothing fired: ${hand.join(" ")}`);
      }
    }
    if (!declared) continue;
    fired += 1;
    shapes.add(declared.shape);

    // ONE MOVE, AND IT IS THE WHOLE HAND. Everybody else is offered nothing —
    // there is no trick to answer.
    const hand = state.zones.cards(handAddress(declared.seat));
    assert.strictEqual(state.turn.seat, declared.seat, "the hand that won is not on the turn");
    const moves = enumerateLegalMoves(state, declared.seat);
    assert.strictEqual(moves.length, 1, `the winner was offered ${moves.length} moves`);
    assert.deepStrictEqual([...moves[0].cards].sort(), [...hand].sort());
    for (let seat = 0; seat < 4; seat++) {
      if (seat === declared.seat) continue;
      assert.deepStrictEqual(enumerateLegalMoves(state, seat), [],
        `seat ${seat} was offered a move while an instant win stood`);
    }

    // And it is scored and redealt through the ordinary round boundary.
    const round = state.roundNumber;
    applyMove(state, chooseBotMove(state, declared.seat));
    assert.ok(state.roundNumber > round || state.gameOver,
      "laying an instant win down did not end the hand");
    assert.ok(state.scores[declared.seat] === 0,
      `the seat that won on the deal was charged ${state.scores[declared.seat]}`);
  }
  assert.ok(fired >= 5, `only ${fired} of 400 deals were an instant win — too few to conclude anything`);
  assert.ok(shapes.size >= 2, `only one shape (${[...shapes]}) ever fired`);

  // THE OTHER HALF, and the half that makes this a variant rather than a rule:
  // the same deals with the switch off are ordinary hands.
  let checked = 0;
  for (let game = 0; game < 400 && checked < 400; game++) {
    const state = await dealt(4, `instant:${game}`, []);
    assert.ok(!state.vars.instantWin, `seed ${game} won on the deal with the variant switched off`);
    checked += 1;
  }
});

test("no-ending-on-two: the bot is never offered the move the rule takes away", async () => {
  // WHAT THE ENUMERATOR LEFT OUT, MEASURED AGAINST WHAT IT WOULD HAVE OFFERED.
  // The comparison is the same position read through the pack loaded WITHOUT
  // the variant — the deck and the card ids are identical, so swapping the
  // pack under the state for the length of one call asks the same question of
  // the same cards under the other rule set.
  const plain = await loadPackFromDisk(PACK, []);
  let omitted = 0;
  let relaxed = 0;
  let turns = 0;

  for (let game = 0; game < 40; game++) {
    const state = await dealt(4, `noteen:${game}`, ["no-ending-on-two"]);
    const variant = state.pack;
    for (let step = 0; step < 400 && !state.gameOver; step++) {
      const seat = acting(state)[0];
      if (seat === undefined) break;
      const moves = enumerateLegalMoves(state, seat);
      assert.ok(moves.length, `step ${step}: seat ${seat} is on the turn with no legal move`);
      turns++;

      state.pack = plain;
      const all = enumerateLegalMoves(state, seat);
      state.pack = variant;

      const keys = new Set(moves.map((m) => JSON.stringify(m)));
      const hand = state.zones.cards(handAddress(seat));
      const dropped = all.filter((m) => !keys.has(JSON.stringify(m)));
      for (const move of dropped) {
        assert.strictEqual(move.type, "playCard", "the rule removed something that is not a play");
        assert.strictEqual(move.cards.length, hand.length,
          `a play of ${move.cards.join("+")} was removed and it was not the seat's last`);
        assert.ok(move.cards.some((id) => rankOf(id) === "2"),
          `a play of ${move.cards.join("+")} was removed and it holds no 2`);
      }
      omitted += dropped.length;

      // THE RELAXATION, counted so the sweep can say it saw one: a leader
      // holding nothing but pigs keeps the play, because a rule that stops the
      // table is a stall and not a rule.
      if (dropped.length === 0 && !state.vars.combo
        && moves.every((m) => m.cards.length === hand.length
          && m.cards.some((id) => rankOf(id) === "2"))) {
        relaxed += 1;
      }

      const chosen = chooseBotMove(state, seat);
      assert.ok(keys.has(JSON.stringify(chosen)), "the bot played a move the rule removed");
      applyMove(state, chosen);
      if (state.events.some((e) => e.type === "roundOver")) break;
    }
  }
  assert.ok(turns > 500, `only ${turns} turns swept`);
  // Measured on this sweep: 10 plays removed and 4 relaxations across 1,484
  // turns of 40 hands. Both are small because both are endgame events — if a
  // change to the bot moves them to zero, widen the sweep rather than dropping
  // the bar, because a zero here is a rule that never applied.
  assert.ok(omitted > 0,
    `across ${turns} turns the rule never removed a single move, so nothing above is being tested`);
  assert.ok(relaxed > 0,
    `across ${turns} turns no seat was ever left holding nothing but the card it may not go out `
    + "on, so the deadlock the relaxation exists for was never reached in this sweep");
});

/* ------------------------------------------------------------------ *
 * Deal to game over, which is what earned the registry entry
 * ------------------------------------------------------------------ */

test("the 3 of spades leads hand one, and the seat that goes out leads hand two", async () => {
  const state = await dealt(4, "leads");
  const holder = [0, 1, 2, 3].find((s) => state.zones.cards(handAddress(s)).includes("spades-3"));
  assert.strictEqual(state.turn.seat, holder, "hand one did not open on the 3 of spades");
  assert.strictEqual(state.playerVars[holder].__mustInclude, "spades-3",
    "the requirement is not on the seat holding the card");

  // RECORDED IS NOT ENFORCED. Asserting only that the var is set passes in a
  // build where nothing ever reads it, so the refusal is asserted directly.
  const other = state.zones.cards(handAddress(holder)).filter((id) => id !== "spades-3");
  assert.strictEqual(
    validateMove(state, { actor: holder, type: "playCard", cards: [other[0]] }).rule, "first-lead",
    "the opening lead was allowed without the 3 of spades");
  assert.ok(validateMove(state, { actor: holder, type: "playCard", cards: ["spades-3"] }).legal);
  assert.ok(enumerateLegalMoves(state, holder).every((m) => m.cards.includes("spades-3")),
    "a move without the 3 of spades was offered for the opening lead");

  for (let step = 0; step < 1000 && state.roundNumber === 1 && !state.gameOver; step++) {
    applyMove(state, chooseBotMove(state, acting(state)[0]));
  }
  assert.strictEqual(state.roundNumber, 2, "the first hand never ended");
  // Hand two is opened by whoever went out, free to lead anything (D-3).
  assert.ok(state.playerVars.every((own) => !own.__mustInclude),
    "hand two still owes the 3 of spades");
  assert.strictEqual(state.turn.seat, state.vars.leader);
});

test("a match plays from the deal to game over, and the lowest total wins", async () => {
  const state = await dealt(4, "match");
  let steps = 0;
  while (!state.gameOver && steps++ < 20000) {
    const seats = acting(state);
    assert.ok(seats.length, `the table stopped on round ${state.roundNumber} with nobody able to act`);
    applyMove(state, chooseBotMove(state, seats[0]));
  }
  assert.ok(state.gameOver, `the match never ended (${steps} moves, round ${state.roundNumber})`);
  assert.ok(state.roundNumber > 1, "the match ended inside its first hand");

  // POINTS ARE THE PENALTY HERE, and getting the sign backwards ships a bot
  // that plays to lose with nothing else in the repo noticing
  // (src/templates/CONTRACT.md). The manifest says lowestScore; the engine had
  // better agree.
  const lowest = state.scores.indexOf(Math.min(...state.scores));
  assert.strictEqual(state.scores[state.winner], state.scores[lowest],
    `seat ${state.winner} won on ${state.scores[state.winner]} against a low of ${state.scores[lowest]}`);
});
