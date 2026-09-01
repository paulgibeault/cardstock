// THE ONE-PLY LAYER, AND THE TWO WAYS IT CAN BE A LIE.
//
// A template that exports `evaluateState` (src/templates/CONTRACT.md) gets its
// legal moves played out on a fork and the resulting positions scored, instead
// of the moves themselves. Two failures would leave that looking fine:
//
//   1. NOBODY CALLS IT. A hook wired up wrong is a hook that silently never
//      fires — the failure the whole template contract exists to prevent — and
//      a bot that quietly kept using `botHeuristic` would still pass every
//      completion bar in the suite, because those measure whether rounds END.
//      So the test is that a template WITH the hook demonstrably ranks moves
//      differently from the same template with the hook taken away.
//
//   2. IT CHEATS. Playing a move out on a fork produces a REAL position dealt
//      from the REAL shuffle, and the bot is handed the whole state — so
//      "draw from the deck and score the hand you ended up with" is a bot
//      reading a face-down pile. That is not hypothetical: it is what the first
//      cut of this did, and it put Milestones straight back into the live-lock
//      Phase 1 had just fixed, because a deck top judged worse than the pile
//      once is judged worse forever. Fairness is a criterion here, not a nicety.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { chooseBotMove, rankMoves } from "../src/engine/bot.js";
import { forkState } from "../src/engine/fork.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

/** Rank the same position with the template's `evaluateState` hook removed. */
function rankWithoutLookahead(state, seat) {
  const template = state.pack.template;
  const hook = template.evaluateState;
  delete template.evaluateState;
  try {
    return rankMoves(state, seat);
  } finally {
    template.evaluateState = hook;
  }
}

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

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

test("a template with evaluateState ranks positions, not moves", async () => {
  // The proof that the hook is REACHED. Ripping `evaluateState` out has to
  // change what the bot plays; if it does not, nothing below it is running.
  for (const [packId, seats] of [["milestones", 4], ["hearts", 4], ["crazy-eights", 4]]) {
    let turns = 0;
    let differed = 0;
    for (let game = 0; game < 3; game++) {
      const state = await dealt(packId, seats, `lookahead:${packId}:${game}`);
      assert.strictEqual(typeof state.pack.template.evaluateState, "function",
        `${packId}: no evaluateState to exercise`);
      walk(state, 400, (live, seat) => {
        const withLookahead = rankMoves(live, seat)[0];
        const withoutLookahead = rankWithoutLookahead(live, seat)[0];
        turns++;
        if (JSON.stringify(withLookahead.move) !== JSON.stringify(withoutLookahead.move)) differed++;
      });
    }
    assert.ok(turns > 30, `${packId}: only ${turns} decisions seen — too few to conclude anything`);
    assert.ok(differed > 0,
      `${packId}: the one-ply ranking agreed with botHeuristic on all ${turns} decisions — `
      + "evaluateState is either never called or has no opinion, and either way it is not doing anything");
  }
});

test("a template with no evaluateState is ranked exactly as it always was", async () => {
  // The other half of the same claim: the lookahead must not touch a template
  // that did not ask for it. Stockpile's sequencing template offers no hook.
  const state = await dealt("stockpile", 4, "lookahead:stockpile");
  assert.strictEqual(state.pack.template.evaluateState, undefined,
    "sequencing has grown an evaluateState — pick another template for this test");
  walk(state, 60, (live, seat) => {
    assert.deepStrictEqual(
      rankMoves(live, seat).map((r) => [r.move, r.score]),
      rankWithoutLookahead(live, seat).map((r) => [r.move, r.score]),
    );
  });
});

test("the lookahead cannot see through the back of a card", async () => {
  // THE FAIRNESS GATE, in the one place Phase 2 can already fail it. In a
  // Milestones draw phase the two candidates are "take the face-up pile top"
  // and "turn the deck" — and the deck's top is a card this seat may not see.
  // Reordering the face-down deck must therefore change nothing about the
  // decision. (It changes plenty about the OUTCOME; that is the point.)
  const state = await dealt("milestones", 4, "lookahead:blind");
  let checked = 0;
  walk(state, 200, (live, seat) => {
    if (live.turn.phase !== "draw") return;
    const deck = live.zones.cards("draw");
    if (deck.length < 6) return;

    const chosen = JSON.stringify(chooseBotMove(live, seat));
    // Every rearrangement of the face-down pile, tried on forks so the live
    // game is untouched. A bot that peeked would answer differently for at
    // least one of them.
    for (const swapWith of [1, 2, 3, 4, 5]) {
      const fork = forkState(live);
      const cards = fork.zones.cards("draw");
      const top = cards.length - 1;
      [cards[top], cards[top - swapWith]] = [cards[top - swapWith], cards[top]];
      assert.strictEqual(JSON.stringify(chooseBotMove(fork, seat)), chosen,
        `seat ${seat} changed its draw once the ${swapWith}th card down was moved to the top of a `
        + "FACE-DOWN pile — the lookahead is reading cards this seat may not see");
    }
    checked++;
  });
  assert.ok(checked > 10, `only ${checked} draw phases examined — too few to conclude anything`);
});

test("shedding still gets a lookahead on a turn where drawing is legal", async () => {
  // THE BOTTOM BAND EARNS ITS PLACE HERE OR NOWHERE. `mustPlayIfAble` is false
  // in both shedding packs, so a draw — whose outcome is a face-down card — is
  // legal on literally every turn. Refusing to rank a turn that contains any
  // hidden-outcome move is the tempting conservative rule and it would silently
  // switch shedding's evaluator off for the whole game. `botHeuristic` already
  // rates a draw below every play, so the draw keeps that verdict and the
  // evaluator sorts the plays.
  for (const packId of ["crazy-eights", "wildfire"]) {
    let withDraw = 0;
    let differed = 0;
    for (let game = 0; game < 4; game++) {
      const state = await dealt(packId, 4, `lookahead:draws:${packId}:${game}`);
      walk(state, 300, (live, seat) => {
        const moves = enumerateLegalMoves(live, seat);
        if (!moves.some((m) => m.type === "draw") || moves.length < 3) return;
        withDraw++;
        if (JSON.stringify(rankMoves(live, seat)[0].move)
          !== JSON.stringify(rankWithoutLookahead(live, seat)[0].move)) differed++;
      });
    }
    assert.ok(withDraw > 20, `${packId}: only ${withDraw} turns offered a draw beside two plays`);
    assert.ok(differed > 0,
      `${packId}: on all ${withDraw} turns where a draw was legal the lookahead agreed with `
      + "botHeuristic — a hidden-outcome move is switching the evaluator off for the whole turn");
  }
});

test("a round-ending move outranks every position the evaluator scored", async () => {
  // Going out is the objective, and the pipeline has already scored the hand
  // and dealt the next one by the time a fork could be looked at — so a
  // round-ending move is BANDED above the scored ones rather than scored.
  //
  // Built rather than stumbled on, because the position has to contain both
  // kinds of move at once: a Milestones seat holding exactly its opening
  // contract — set(3) + set(3) — can either lay it all down, which empties the
  // hand and ends the round, or throw one of the six away, which does not.
  const state = await dealt("milestones", 4, "lookahead:terminal");
  const seat = state.turn.seat;
  const handAddr = `hand.${seat}`;
  const contract = ["red-1", "blue-1", "green-1", "red-2", "blue-2", "green-2"];
  assert.deepStrictEqual(state.pack.rules.contracts[0], ["set(3)", "set(3)"],
    "Milestones' opening contract changed — rebuild this hand to match it");

  // Everything currently anywhere goes to the draw pile, then the six cards
  // come back out into one hand. Zones are written directly because this is a
  // constructed position, not a line of play.
  for (const address of state.zones.allAddresses()) {
    for (const id of state.zones.cards(address).slice()) {
      if (address === "draw") continue;
      state.zones.cards(address).length = 0;
    }
  }
  const deck = state.zones.cards("draw");
  deck.length = 0;
  for (const id of state.pack.cardsById.keys()) {
    if (contract.includes(id)) continue;
    deck.push(id);
    state.cardLocation.set(id, "draw");
  }
  for (const id of contract) {
    state.zones.cards(handAddr).push(id);
    state.cardLocation.set(id, handAddr);
  }
  state.zones.cards("discard").push(deck.pop());
  state.cardLocation.set(state.zones.cards("discard")[0], "discard");
  state.turn.phase = "meld";

  // The exact enumerator, not the memo: this state was edited in place and
  // `legalMovesFor`'s key cannot see that (src/engine/fork.js's header).
  const moves = enumerateLegalMoves(state, seat);
  const layDown = moves.find((m) => m.type === "layDown");
  assert.ok(layDown, "the constructed hand does not satisfy the contract");
  assert.ok(moves.some((m) => m.type === "discard"), "no non-terminal move to rank the lay-down against");

  const ranked = rankMoves(state, seat);
  assert.strictEqual(ranked[0].move.type, "layDown",
    "the move that ends the round was not ranked first");
  const top = ranked[0].score;
  assert.ok(ranked.slice(1).every((r) => r.move.type === "layDown" || r.score < top),
    "a move that did not end the round scored as high as the one that did");
});

test("a turn with more candidates than the lookahead budget still ranks all of them", async () => {
  // THE SHORTLIST, exercised where it actually bites. Milestones is the only
  // pack that passes the budget at all and only at six seats — the widest turn
  // measured at four is seventeen moves, once in three thousand — so a
  // four-handed table would leave this path untested and the assertion would
  // quietly pass on a turn the shortlist never touched. The moves it does not
  // reach must still come back, once each, tied at the bottom band.
  let widest = 0;
  for (let game = 0; game < 12 && widest === 0; game++) {
    const state = await dealt("milestones", 6, `lookahead:wide:${game}`);
    walk(state, 800, (live, seat) => {
      const moves = enumerateLegalMoves(live, seat);
      if (moves.length <= 16 || widest) return;
      const ranked = rankMoves(live, seat);
      assert.strictEqual(ranked.length, moves.length,
        "the shortlist dropped moves instead of ranking them below the ones it scored");
      assert.strictEqual(new Set(ranked.map((r) => JSON.stringify(r.move))).size, ranked.length,
        "a move came back twice");
      const floor = Math.min(...ranked.map((r) => r.score));
      assert.ok(ranked.filter((r) => r.score === floor).length >= moves.length - 16,
        "the moves outside the budget were not left tied at the bottom band");
      widest = moves.length;
    });
  }
  assert.ok(widest > 16,
    `no Milestones turn enumerated past the ${16} the lookahead budgets for — the shortlist is untested`);
});
