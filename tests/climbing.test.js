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

/**
 * Every seat has picked a hand — a no-op at a table that does not deal for
 * them (#157).
 *
 * A two-handed deal opens in `choose` with every hand empty, so a test that
 * asserts anything about the HANDS has to get past it first. Bot moves rather
 * than hand-written ones, because the enumerator is what the felt and the bot
 * both read and a test that reached around it would be pinning a path nobody
 * takes.
 */
function pickHands(state, limit = 8) {
  for (let i = 0; i < limit && state.turn.phase === "choose"; i++) {
    const move = chooseBotMove(state, state.turn.seat);
    assert.ok(move, `nothing to pick with in the choose phase (step ${i})`);
    applyMove(state, move);
  }
  assert.notStrictEqual(state.turn.phase, "choose", "the choose phase never ended");
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
  // `[]` rather than nothing: Thirteen ships `pass-stays-in` on by default
  // (#158), so a load with no variant list is the WEAK rule now and this test
  // would have asserted it while claiming to assert the strong one. The empty
  // list is the plain rule set, and the weak rule gets its own test below.
  const state = await dealt(4, "passed", []);
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

test("pass-stays-in: a passed seat is asked again when the play comes back round", async () => {
  // The mirror of the test above, and the reason the exclusion had to be a
  // rule rather than a constant: `passIsFinal: false` was implemented and
  // unreachable, because no pack offered it (#158).
  const state = await dealt(4, "weak-pass", ["pass-stays-in"]);
  const leader = state.turn.seat;
  applyMove(state, chooseBotMove(state, leader));
  const answerer = state.turn.seat;
  assert.notStrictEqual(answerer, leader, "the turn did not move off the leader");
  applyMove(state, { actor: answerer, type: "pass" });
  assert.ok(state.vars.passed.includes(answerer), "the pass was not recorded");

  // Forced back onto them for the same reason the strong-rule test gives: an
  // off-turn seat is refused with `turn` whatever the pass rule says.
  const hand = state.zones.cards(handAddress(answerer));
  const wasTurn = state.turn.seat;
  state.turn.seat = answerer;
  try {
    assert.ok(enumerateLegalMoves(state, answerer).length,
      "a seat that passed under the weak rule is still being offered nothing");
    assert.deepStrictEqual(acting(state), [answerer],
      "a seat that passed under the weak rule is not being scheduled");
    assert.notStrictEqual(
      validateMove(state, { actor: answerer, type: "playCard", cards: [hand[0]] }).rule, "passed",
      "the weak rule still refuses a passed seat's play as passed");
    assert.ok(validateMove(state, { actor: answerer, type: "pass" }).legal,
      "a seat that passed may not pass again under the weak rule");
  } finally {
    state.turn.seat = wasTurn;
  }

  // AND THE TRICK STILL ENDS. A rule that lets seats re-enter for ever is a
  // stall, not a house rule: `advance` stops at the seat holding the standing
  // combination, so one lap of the table is all a trick can take.
  let steps = 0;
  while (!state.gameOver && steps++ < 20000) {
    const seats = acting(state);
    assert.ok(seats.length, `the table stopped on round ${state.roundNumber} with nobody able to act`);
    applyMove(state, chooseBotMove(state, seats[0]));
  }
  assert.ok(state.gameOver, `the match never ended (${steps} moves, round ${state.roundNumber})`);
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

  // A selection that is not a play KEEPS the slot and turns the button off, with
  // the engine's own sentence for why. `action: null` was the bug: the thumb
  // slot emptied, the sort toggle took it, and the player was left with two
  // cards in a tray, no commit, no refusal and no Pass (#122, round-5 item 19).
  const bad = hand.filter((id) => !play.cards.includes(id)).slice(0, 1).concat(play.cards[0]);
  assert.ok(bad.length > 1, "could not build a two-card selection to refuse");
  const verdict = selectionLegality(state, seat, bad);
  assert.ok(!verdict.legal, "the selection meant to be refused is legal");
  const refused = model(bad).action;
  assert.ok(refused, "an illegal selection left the thumb slot empty");
  assert.match(refused.label, /^Play \d+$/, "a refused commit must still say what it would commit");
  assert.strictEqual(refused.disabled, true, "an illegal selection armed the commit button");
  assert.strictEqual(refused.refusal, verdict.reason,
    "the refusal must be the engine's own sentence, not a second wording of it");
  assert.strictEqual(refused.makeMove, null, "a refused commit must carry no move");
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

/** The one card at the bottom of the pack's total order among those DEALT. */
function lowestInPlay(state) {
  const ladder = rankLadderOf(state.pack);
  let lowest = null;
  let at = Infinity;
  for (let seat = 0; seat < state.seats; seat++) {
    for (const id of state.zones.cards(handAddress(seat))) {
      const order = cardOrder(state.pack.cardsById.get(id), ladder);
      if (order < at) {
        at = order;
        lowest = id;
      }
    }
  }
  return lowest;
}

test("the lowest card IN PLAY leads hand one at every seat count the pack offers", async () => {
  // THE BUG THIS PINS (#156). `firstLead.card` was the literal `spades-3`, and
  // Thirteen deals a flat thirteen with the remainder out of play (D-11), so
  // short-handed the 3♠ is frequently not dealt at all — a quarter of the deck
  // is never dealt at three seats and eighteen of the fifty-two sit out the
  // two-handed offer deal, and the card goes missing at about those rates (33
  // and 29 of the hundred deals THIS sweep walks; 34.6% and 25.0% are the
  // populations). Every one of those fell
  // through to `ctx.openingSeat()`, which on hand one is seat 0, which is the
  // human: the player was handed the opening lead of a game whose first rule is
  // that the lowest card leads.
  //
  // A hundred deals per seat count at four counts is 400, and the bar is 100%:
  // this is not a statistical claim, it is the rule.
  //
  // TWO SEATS GETS THERE THROUGH THE PICKS (#157). The offer deal opens with
  // every hand empty, so the rule this test is about cannot even be asked until
  // both piles have been taken — which is the point at which the template asks
  // it too (`finishChoose`).
  const missing = { 2: 0, 3: 0, 4: 0 };
  for (const seats of [2, 3, 4]) {
    for (let game = 0; game < 100; game++) {
      const state = pickHands(await dealt(seats, `lowest:${seats}:${game}`));
      const lowest = lowestInPlay(state);
      const holder = [...Array(seats).keys()]
        .find((s) => state.zones.cards(handAddress(s)).includes(lowest));
      assert.strictEqual(state.turn.seat, holder,
        `${seats} seats, deal ${game}: the lead went to ${state.turn.seat}, `
        + `not to ${holder} who holds ${lowest}`);
      assert.strictEqual(state.playerVars[holder].__mustInclude, lowest,
        `${seats} seats, deal ${game}: the opening lead does not owe ${lowest}`);
      const spare = state.zones.cards(handAddress(holder)).filter((id) => id !== lowest);
      assert.strictEqual(
        validateMove(state, { actor: holder, type: "playCard", cards: [spare[0]] }).rule,
        "first-lead",
        `${seats} seats, deal ${game}: the opening lead was allowed without ${lowest}`);
      if (![...Array(seats).keys()]
        .some((s) => state.zones.cards(handAddress(s)).includes("spades-3"))) missing[seats] += 1;
    }
  }
  // AN EMPTY PROBE IS NOT A PASS. If the deal stopped leaving the 3♠ out of
  // play the sweep above would be checking nothing that the old code got wrong,
  // so the condition the bug needed is asserted to have occurred.
  assert.ok(missing[2] > 0 && missing[3] > 0,
    `the 3 of spades was in play in every short-handed deal (2: ${missing[2]}, 3: ${missing[3]}), `
    + "so this sweep never reached the case the rule exists for");
  assert.strictEqual(missing[4], 0, "a four-seat deal left the 3 of spades out of play");
});

/**
 * Deal, then throw the deal away and stack `hands` — the idiom the budget test
 * above uses, lifted so the exclusion tests can share it. Everything the
 * template reads about the trick is cleared, so the stacked seat is on lead.
 */
function stackHands(state, hands) {
  for (let seat = 0; seat < state.seats; seat++) {
    const addr = handAddress(seat);
    state.zones.get(addr).cards.length = 0;
    for (const id of hands[seat] || []) {
      state.zones.get(addr).cards.push(id);
      state.cardLocation.set(id, addr);
    }
    state.playerVars[seat].__mustInclude = null;
  }
  state.turn.seat = 0;
  state.vars.combo = null;
  state.vars.passed = [];
  state.vars.lastPlayer = null;
  state.vars.leader = 0;
  return state;
}

async function stacked(hands, variants) {
  const pack = await loadPackFromDisk(PACK, variants);
  const state = createState({ pack, seats: 4, seed: "stacked" });
  pack.template.setup(makeCtx(state));
  return stackHands(state, hands);
}

test("two-tops-runs: a 2 ends a run, and still has no part in a strip", async () => {
  // THE SPLIT THE VARIANT NEEDED (#158). One `runExcludes` governed runs AND
  // consecutive pairs, so buying `Q-K-A-2` by dropping the exclusion would have
  // silently sold `2-2 A-A K-K` — the highest pair in the game inside a
  // bomb-eligible strip, which nobody at any table plays.
  const hands = [
    ["spades-Q", "spades-K", "spades-A", "spades-2", "clubs-2", "clubs-A", "clubs-K", "clubs-Q"],
    ["diamonds-4"], ["diamonds-5"], ["diamonds-6"],
  ];
  const run = ["spades-K", "spades-A", "spades-2"];
  const strip = ["spades-2", "clubs-2", "spades-A", "clubs-A", "spades-K", "clubs-K"];
  const asStrip = ["spades-A", "clubs-A", "spades-K", "clubs-K", "spades-Q", "clubs-Q"];

  const plain = await stacked(hands, []);
  assert.strictEqual(validateMove(plain, { actor: 0, type: "playCard", cards: run }).rule,
    "not-a-combination", "K-A-2 is a run with the house rule OFF");

  const state = await stacked(hands, ["two-tops-runs"]);
  assert.ok(validateMove(state, { actor: 0, type: "playCard", cards: run }).legal,
    "K-A-2 is still refused with the house rule on");
  assert.strictEqual(validateMove(state, { actor: 0, type: "playCard", cards: strip }).rule,
    "not-a-combination", "2-2 A-A K-K became a strip — the exclusion did not split by shape");
  assert.ok(validateMove(state, { actor: 0, type: "playCard", cards: asStrip }).legal,
    "the house rule broke ordinary consecutive pairs");

  // AND THE BOT SEES IT. The enumerator is what a bot picks from, so a run the
  // rule allows and `candidateSets` does not offer is a rule only a human has.
  const offered = enumerateLegalMoves(state, 0)
    .filter((m) => m.cards?.includes("spades-2") && m.cards.length >= 3);
  assert.ok(offered.length,
    "the enumerator offered no run ending on the 2, so the bot cannot play the house rule");
  assert.ok(!enumerateLegalMoves(state, 0).some((m) => m.cards?.length === 6
    && m.cards.includes("clubs-2") && m.cards.includes("spades-2")),
    "the enumerator offered 2-2 A-A K-K as a strip");
});

test("two-tops-runs: the dragon is still 3-to-A, not the whole hand", async () => {
  // THE SIDE EFFECT THAT WOULD HAVE GONE UNNOTICED. Tới trắng's dragon is "one
  // card of every rank a sequence may contain". Read off `runExcludes` alone it
  // becomes 3-to-2 the moment the 2 is let into a run — thirteen ranks, which
  // is the whole hand, which is a shape rare enough that the instant win would
  // simply have stopped happening while the rules page went on offering it.
  // Seeded: `dragon:119` deals seat 2 one card of every rank 3 through A.
  const plain = await dealt(4, "dragon:119", ["instant-wins"]);
  assert.deepStrictEqual(plain.vars.instantWin, { seat: 2, shape: "a dragon" },
    "the seeded deal is no longer a dragon — find another seed rather than dropping the test");
  const both = await dealt(4, "dragon:119", ["instant-wins", "two-tops-runs"]);
  assert.deepStrictEqual(both.vars.instantWin, plain.vars.instantWin,
    "letting a 2 end a run moved the dragon");
});

test("the deal walks the table in the direction of play", async () => {
  // `nextSeat(seat, dir)` was being handed a STEP COUNT as its direction
  // (`nextSeat(openingSeat(), n)`), which visits every seat exactly once and so
  // dealt a perfectly valid hand — clockwise, at a counter-clockwise table
  // (#156). Nothing downstream noticed, because every seat still got thirteen
  // cards. The mirror is what makes it visible: the same shuffle dealt the
  // other way round must land seat s's hand on seat −s.
  const ccw = await dealt(4, "deal-direction");
  const pack = await loadPackFromDisk(PACK);
  pack.rules = { ...pack.rules, direction: "clockwise" };
  const cw = createState({ pack, seats: 4, seed: "deal-direction" });
  pack.template.setup(makeCtx(cw));

  assert.strictEqual(ccw.direction, -1, "the counter-clockwise table is not counter-clockwise");
  assert.strictEqual(cw.direction, 1, "the clockwise table is not clockwise");
  for (let seat = 0; seat < 4; seat++) {
    assert.deepStrictEqual(
      ccw.zones.cards(handAddress(seat)), cw.zones.cards(handAddress((4 - seat) % 4)),
      `seat ${seat}'s counter-clockwise hand is not seat ${(4 - seat) % 4}'s clockwise one, `
      + "so the deal is ignoring state.direction");
  }
});

test("the 3 of spades leads hand one, and the seat that goes out leads hand two", async () => {
  const state = await dealt(4, "leads");
  const holder = [0, 1, 2, 3].find((s) => state.zones.cards(handAddress(s)).includes("spades-3"));
  // At a FULL table the lowest card in play is the 3♠, so the general rule and
  // the sentence everybody describes the game with are the same sentence.
  assert.strictEqual(lowestInPlay(state), "spades-3",
    "a four-seat deal's lowest card in play is not the 3 of spades");
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

/* ------------------------------------------------------------------ *
 * Two-handed: three hands on offer, and you pick one (#157)
 * ------------------------------------------------------------------ */

test("two seats are dealt three hands to choose from, and the piles say nothing but their size", async () => {
  // WHY THE DEAL IS DIFFERENT AT ALL. `rules.deal` is thirteen at every seat
  // count by design (D-11) — but two-handed that leaves twenty-six of the
  // fifty-two unseen by anybody, which is half the pigs and half the bombs
  // simply not turning up. Three piles of seventeen puts thirty-four in play.
  const state = await dealt(2, "offer:deal");
  assert.strictEqual(state.turn.phase, "choose", "the two-handed deal did not open on the pick");
  assert.deepStrictEqual([0, 1].map((s) => state.zones.count(handAddress(s))), [0, 0],
    "somebody was dealt a hand before anybody picked one");
  assert.deepStrictEqual([1, 2, 3].map((n) => state.zones.count(`offer.${n}`)), [17, 17, 17]);
  // 52 does not divide by three, and the odd card is out of play rather than
  // quietly making one pile bigger.
  assert.strictEqual(state.zones.count("aside"), 1, "the odd card is not set aside");

  // THE PICKER IS AN ACTING SEAT. `stillIn` reads "has cards", and in this
  // phase nobody does — so without the phase branch `actingSeats` answers with
  // an empty list, which the simulator reports as a stalled table.
  assert.deepStrictEqual(acting(state), [state.turn.seat]);

  const moves = enumerateLegalMoves(state, state.turn.seat);
  assert.deepStrictEqual(moves.map((m) => m.from), ["offer.1", "offer.2", "offer.3"]);
  assert.ok(moves.every((m) => m.type === "takeHand" && !m.cards),
    "a pick carries cards, so the move itself names the hand it is taking");
  assert.deepStrictEqual(enumerateLegalMoves(state, 1 - state.turn.seat), [],
    "the seat not picking was offered a move");

  // ...and the felt lights all three, keyed by the address it draws them at.
  assert.strictEqual(interactionMode(state), "take-pile");
  const ui = buildUiModel(state, { seat: state.turn.seat, moves, acts: true });
  assert.deepStrictEqual([...ui.readyTargets.keys()], ["offer.1", "offer.2", "offer.3"]);
  assert.strictEqual(ui.handSelectable.size, 0, "an empty hand offered something to tap");
});

test("a pile taken is a hand of 17, and the one nobody took leaves the table", async () => {
  const state = await dealt(2, "offer:take");
  const first = state.turn.seat;
  applyMove(state, { actor: first, type: "takeHand", from: "offer.2" });

  assert.strictEqual(state.zones.count(handAddress(first)), 17, "the whole pile did not arrive");
  assert.strictEqual(state.zones.count("offer.2"), 0);
  assert.strictEqual(state.turn.phase, "choose", "the phase ended a pick early");
  assert.strictEqual(state.turn.seat, 1 - first, "the other seat was not asked to pick");
  // The pile that is gone is gone from the offer, so it cannot be taken twice.
  assert.strictEqual(
    validateMove(state, { actor: 1 - first, type: "takeHand", from: "offer.2" }).rule,
    "not-on-offer");

  applyMove(state, chooseBotMove(state, state.turn.seat));
  assert.strictEqual(state.turn.phase, "play");
  assert.deepStrictEqual([0, 1].map((s) => state.zones.count(handAddress(s))), [17, 17]);
  assert.deepStrictEqual([1, 2, 3].map((n) => state.zones.count(`offer.${n}`)), [0, 0, 0],
    "a pile nobody took is still sitting on the table");
  // SEVENTEEN PLUS ONE, AND NOT INTO THE DISCARD. `discard` is public and
  // `unseenBy` counts it as seen, so putting the unchosen pile there would tell
  // every seat that seventeen named cards are out of play — which is exactly
  // the information nobody at a real table has.
  assert.strictEqual(state.zones.count("aside"), 18);
  assert.strictEqual(state.zones.count("discard"), 0);

  // And then the ordinary rule: the lowest card of the thirty-four in play
  // leads, and owes that card (#156).
  const lowest = lowestInPlay(state);
  const holder = [0, 1].find((s) => state.zones.cards(handAddress(s)).includes(lowest));
  assert.strictEqual(state.turn.seat, holder);
  assert.strictEqual(state.playerVars[holder].__mustInclude, lowest);
  assert.strictEqual(interactionMode(state), "combination", "the mode never left the pick");
});

test("the loser of a hand picks first, and the winner leads once the picks are in", async () => {
  // THE BARGAIN THE RULE IS (#157): the player who lost gets first choice of
  // pile, the player who won gets the lead. Asserted at every round boundary of
  // several whole matches rather than on one seeded hand, because the two
  // halves are decided in different places — `startRound` reads who won, and
  // `finishChoose` spends it two moves later — and a test of one deal would not
  // notice them drifting apart.
  let boundaries = 0;
  for (let game = 0; game < 12; game++) {
    const state = await dealt(2, `offer:order:${game}`);
    for (let step = 0; step < 4000 && !state.gameOver; step++) {
      const seat = acting(state)[0];
      assert.ok(seat !== undefined,
        `the table stopped on round ${state.roundNumber}, phase ${state.turn.phase}`);
      const round = state.roundNumber;
      applyMove(state, chooseBotMove(state, seat));
      if (state.roundNumber === round) continue;
      // `seat` emptied its own hand, which is what ended the round.
      boundaries += 1;
      assert.strictEqual(state.turn.phase, "choose", "the next hand was not dealt as an offer");
      assert.strictEqual(state.turn.seat, 1 - seat,
        `the winner of round ${round} picked first`);
      applyMove(state, chooseBotMove(state, state.turn.seat));
      applyMove(state, chooseBotMove(state, state.turn.seat));
      assert.strictEqual(state.turn.phase, "play");
      assert.strictEqual(state.turn.seat, seat,
        `round ${round + 1} did not open on the seat that went out`);
      assert.ok(state.playerVars.every((own) => !own.__mustInclude),
        "a later hand still owes the lowest card");
    }
  }
  assert.ok(boundaries > 20, `only ${boundaries} hands finished — the sweep proved little`);
});

test("hand one's pick order is a coin toss, not the seat the human is sitting in", async () => {
  // THE DECISION, PINNED (#157). At hand one nobody holds a card when the pick
  // is made, so "the player who does not hold the lowest card picks first" is a
  // rule about a fact that does not exist yet. The other candidate was the
  // rotating opening seat, and on round one that is seat 0 — which is the human,
  // and is the exact shape of the bug #156 removed. So it is the match's own
  // seeded stream, and what this asserts is that it is neither constant nor the
  // player.
  const picks = [0, 0];
  for (let game = 0; game < 120; game++) {
    picks[(await dealt(2, `offer:flip:${game}`)).turn.seat] += 1;
  }
  assert.ok(picks[0] > 20 && picks[1] > 20,
    `hand one's first pick went ${picks[0]}/${picks[1]} — that is not a coin toss`);
});

test("three and four seats are dealt exactly as they were — the offer is two-handed only", async () => {
  // `rules.offer.atSeats` is a single seat count on purpose. A deal that leaked
  // into the tables the pack is actually played at would be the fix costing more
  // than the bug.
  for (const seats of [3, 4]) {
    const state = await dealt(seats, `offer:not:${seats}`);
    assert.strictEqual(state.turn.phase, "play", `${seats} seats opened on a pick`);
    for (let seat = 0; seat < seats; seat++) {
      assert.strictEqual(state.zones.count(handAddress(seat)), 13,
        `${seats} seats: seat ${seat} was not dealt a flat thirteen`);
    }
    assert.ok(!state.zones.has("offer.1"), `${seats} seats: the offer piles exist`);
    assert.ok(!state.zones.has("aside"), `${seats} seats: the aside pile exists`);
    assert.strictEqual(interactionMode(state), "combination");
  }
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
