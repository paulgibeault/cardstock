// THE CARD A BOT MAY NOT THROW AWAY, AND THE PILE IT MAY NOT BUILD.
//
// Three packs deal wilds, and all three used to give them away (#160). The
// defect was never in one place: the cheap move scorer rated Crazy Eights'
// eight at the TOP of the hand because it has the biggest value and an effect,
// contract-rummy's position scorer clamped a wild's worth through a progress
// cap and then paid 3.75 to shed it, and Stockpile's bot had five flat numbers
// and no opinion about a card at all. Every difficulty inherits whichever of
// those it touches: `easy` ranks by `botHeuristic` alone, a `hard` rollout
// plays every chair with it, `medium` ranks by `evaluateState`, and the Hint
// button on the felt ranks with the same code as all of them.
//
// So the claim is made twice for each pack. Once DIRECTLY, against a position
// built to have exactly one wrong answer in it — which is the test that names
// the bug — and once as a PROPERTY of real play, walked over seeded games at
// both difficulties that rank deterministically, which is the test that catches
// the next scorer that quietly disagrees with this one.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { chooseBotMove, rankMoves } from "../src/engine/bot.js";
import { isWild } from "../src/engine/cards.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

const wild = (state, id) => isWild(state.pack.cardsById.get(id.split("#")[0]), state.pack.rules.wilds);

/** Every card the deal put anywhere, so a test can go looking for one. */
function everyCardId(state) {
  const out = [];
  for (const address of state.zones.allAddresses()) out.push(...state.zones.cards(address));
  return out;
}

/** Move `id` out of whatever zone holds it and onto the top of `address`. */
function place(state, id, address) {
  for (const from of state.zones.allAddresses()) {
    const cards = state.zones.cards(from);
    const at = cards.indexOf(id);
    if (at >= 0) { cards.splice(at, 1); break; }
  }
  state.zones.cards(address).push(id);
}

/** Empty `address` back into the draw pile, so a hand can be built from scratch. */
function clear(state, address) {
  const cards = state.zones.cards(address);
  state.zones.cards("draw").push(...cards.splice(0, cards.length));
}

const find = (state, ids, fn) => ids.find((id) => fn(state.pack.cardsById.get(id.split("#")[0]), id));

/** Walk a bot-vs-bot game, calling `visit(state, seat, move)` on each move. */
function walk(state, limit, difficulty, visit) {
  const template = state.pack.template;
  for (let i = 0; i < limit && !state.gameOver; i++) {
    const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    let move = null;
    let actor = null;
    for (const seat of acting) {
      move = chooseBotMove(state, seat, { difficulty });
      if (move) { actor = seat; break; }
    }
    if (!move) return;
    visit(state, actor, move);
    applyMove(state, move);
  }
}

/* ------------------------------------------------------------------ *
 * Shedding — Crazy Eights and Wildfire
 * ------------------------------------------------------------------ */

/**
 * A hand of exactly one wild and one card that matches the pile, and a bot
 * asked which to play. Before #160 the answer was the wild, every time and at
 * every difficulty, because `1 + value×0.01 + (effect ? 0.5 : 0)` rates an
 * eight at 2.00 and a natural at most at 1.10.
 */
async function sheddingFork(packId, seats, seed) {
  const state = await dealt(packId, seats, seed);
  const ids = everyCardId(state);
  const top = state.pack.cardsById.get(state.zones.top("discard").split("#")[0]);
  const attr = state.pack.rules.matchOn[0];
  const wildId = find(state, ids, (card) => isWild(card, state.pack.rules.wilds));
  const naturalId = find(state, ids, (card) =>
    !isWild(card, state.pack.rules.wilds) && card[attr] === top[attr] && !card.effect);
  assert.ok(wildId && naturalId, `${packId}: no wild / no natural match to build the position from`);
  const hand = state.zones.zoneAddr ? null : `hand.${state.turn.seat}`;
  clear(state, hand);
  place(state, wildId, hand);
  place(state, naturalId, hand);
  return { state, seat: state.turn.seat, wildId, naturalId, hand };
}

test("shedding plays the natural and keeps the wild", async () => {
  for (const [packId, seats] of [["crazy-eights", 4], ["wildfire", 4]]) {
    for (const difficulty of ["easy", "medium"]) {
      const { state, seat, wildId, naturalId } = await sheddingFork(packId, seats, `wilds:${packId}`);
      const ranked = rankMoves(state, seat, { difficulty });
      const plays = ranked.filter((r) => r.move.type === "playCard");
      assert.ok(plays.some((r) => r.move.cards[0] === wildId), `${packId}: the wild was not even offered`);
      assert.ok(plays.some((r) => r.move.cards[0] === naturalId), `${packId}: the natural was not even offered`);
      assert.strictEqual(ranked[0].move.cards?.[0], naturalId,
        `${packId} at ${difficulty}: played ${ranked[0].move.cards?.[0]} rather than the natural`);
      const wildScore = Math.max(...plays.filter((r) => r.move.cards[0] === wildId).map((r) => r.score));
      const naturalScore = Math.min(...plays.filter((r) => r.move.cards[0] === naturalId).map((r) => r.score));
      assert.ok(wildScore < naturalScore,
        `${packId} at ${difficulty}: the wild scored ${wildScore} against the natural's ${naturalScore}`);
    }
  }
});

/**
 * AT `easy`, WHICH IS ALSO THE ROLLOUT POLICY AND THE HINT.
 *
 * `medium` is deliberately allowed to spend a wild while something natural
 * fits, and it should be: an eight played to name the suit three of your other
 * cards are in buys three ways out of the hand for one, which is the whole
 * reason `evaluateState` exists and is what the pack's own how-to-play
 * describes. What is never right is leading the wild because it is worth fifty
 * points and has an effect, and that is `botHeuristic`'s answer — the one every
 * `hard` rollout plays with and the one the Hint button ranks by.
 */
test("shedding never spends a wild while a natural fits, over whole games", async () => {
  for (const [packId, seats] of [["crazy-eights", 4], ["wildfire", 4]]) {
    let wildsPlayed = 0;
    let naturalsPlayed = 0;
    for (let game = 0; game < 4; game++) {
      const state = await dealt(packId, seats, `wilds:walk:${packId}:${game}`);
      walk(state, 300, "easy", (live, seat, move) => {
        if (move.type !== "playCard") return;
        if (!wild(live, move.cards[0])) { naturalsPlayed++; return; }
        wildsPlayed++;
        // The wild went down: nothing natural may have been on offer.
        const natural = enumerateLegalMoves(live, seat)
          .find((m) => m.type === "playCard" && !wild(live, m.cards[0]));
        assert.ok(!natural,
          `${packId}: seat ${seat} spent a wild holding a playable ${natural?.cards[0]}`);
      });
    }
    assert.ok(wildsPlayed > 0 && naturalsPlayed > 0,
      `${packId}: ${wildsPlayed} wilds and ${naturalsPlayed} naturals played — nothing was exercised`);
  }
});

/* ------------------------------------------------------------------ *
 * Contract rummy — Milestones
 * ------------------------------------------------------------------ */

test("milestones never discards a wild while a natural is in hand", async () => {
  for (const difficulty of ["easy", "medium"]) {
    let discards = 0;
    let seen = 0;
    for (let game = 0; game < 3; game++) {
      const state = await dealt("milestones", 4, `wilds:milestones:${game}`);
      walk(state, 600, difficulty, (live, seat, move) => {
        if (move.type !== "discard") return;
        discards++;
        const hand = live.zones.cards(`hand.${seat}`);
        if (hand.some((id) => wild(live, id))) seen++;
        if (!wild(live, move.cards[0])) return;
        const natural = hand.find((id) => !wild(live, id));
        assert.ok(!natural,
          `milestones at ${difficulty}: seat ${seat} discarded a wild holding ${natural}`);
      });
    }
    assert.ok(discards > 50 && seen > 0,
      `milestones at ${difficulty}: ${discards} discards, ${seen} of them with a wild in hand — nothing was exercised`);
  }
});

test("a held wild beats the position that threw it away", async () => {
  // The direct reading of the defect: `evaluateState` used to rate the hand
  // that had just shed its wild ABOVE the hand that still held it, in both of
  // its branches, which is what made `medium` throw them.
  const state = await dealt("milestones", 4, "wilds:milestones:eval");
  const template = state.pack.template;
  const ctx = makeCtx(state);
  const seat = state.turn.seat;
  const hand = state.zones.cards(`hand.${seat}`);
  const wildId = find(state, everyCardId(state), (card) => isWild(card, state.pack.rules.wilds));
  assert.ok(wildId, "milestones: no wild in the deck");
  place(state, wildId, `hand.${seat}`);
  const held = template.evaluateState(ctx, seat);

  const dearest = hand.filter((id) => id !== wildId)
    .sort((a, b) => (state.pack.cardsById.get(b.split("#")[0]).value ?? 0)
      - (state.pack.cardsById.get(a.split("#")[0]).value ?? 0))[0];
  assert.ok(dearest, "milestones: nothing natural in hand to compare against");

  const without = (id) => {
    const at = hand.indexOf(id);
    const removed = hand.splice(at, 1);
    try { return template.evaluateState(makeCtx(state), seat); } finally { hand.splice(at, 0, ...removed); }
  };
  assert.ok(without(wildId) < without(dearest),
    `milestones: throwing the wild scored ${without(wildId)} against ${without(dearest)} for the dearest natural`);
  assert.ok(held > without(wildId),
    `milestones: holding the wild scored ${held}, throwing it ${without(wildId)}`);
});

/* ------------------------------------------------------------------ *
 * Sequencing — Stockpile
 * ------------------------------------------------------------------ */

/** Take a card of `rank` from wherever it is sitting and hand it back. */
function spare(state, rank) {
  const id = find(state, everyCardId(state), (card) => String(card.rank) === String(rank));
  assert.ok(id, `stockpile: no rank ${rank} left in the deck`);
  return id;
}

/**
 * A TABLE WITH ONE WRONG ANSWER ON IT.
 *
 * Four build piles at four different heights and a wild in hand, which is the
 * only card in the game that may be played onto any of them — so the pile IS
 * the decision, which is exactly the decision the old five-number heuristic
 * never made. One of the four leaves the pile wanting the rank sitting face up
 * on the opponent's stock; it has to come last.
 */
test("the build play that feeds an opponent's stock top is ranked last", async () => {
  const state = await dealt("stockpile", 4, "wilds:stockpile:feeds");
  const seat = state.turn.seat;
  const rival = (seat + 1) % state.seats;

  for (const n of [1, 2, 3, 4]) clear(state, `build.${n}`);
  const heights = { 1: 2, 2: 5, 3: 7, 4: 9 };      // so they want 3, 6, 8 and 10
  for (const [n, height] of Object.entries(heights)) {
    for (let rank = 1; rank <= height; rank++) place(state, spare(state, rank), `build.${n}`);
  }
  clear(state, `stock.${rival}`);
  place(state, spare(state, 9), `stock.${rival}`);  // the rival wants a 9…
  clear(state, `stock.${seat}`);
  place(state, spare(state, 12), `stock.${seat}`);  // …and nothing here sets me up
  clear(state, `hand.${seat}`);
  const wildId = find(state, everyCardId(state), (card) => isWild(card, state.pack.rules.wilds));
  assert.ok(wildId, "stockpile: no wild in the deck");
  place(state, wildId, `hand.${seat}`);

  const plays = rankMoves(state, seat, { difficulty: "easy" })
    .filter((r) => r.move.type === "playCard" && r.move.cards[0] === wildId);
  assert.strictEqual(plays.length, 4, "stockpile: the wild was not offered onto all four piles");
  // Build 3 stands at seven, so a wild on it leaves it wanting the rival's 9.
  const onto = (n) => plays.find((r) => r.move.to === `build.${n}`);
  const worst = Math.min(...plays.map((r) => r.score));
  assert.strictEqual(onto(3).score, worst,
    `stockpile: the pile that would want the rival's 9 scored ${onto(3).score}, `
    + `the best of the others ${Math.max(...plays.filter((r) => r.move.to !== "build.3").map((r) => r.score))}`);
  assert.ok(onto(3).score < onto(1).score, "stockpile: feeding the rival cost nothing");
});

/**
 * A WILD IS NEVER ACTUALLY DISCARDED IN STOCKPILE, because it is playable onto
 * every build pile at every height and every play outranks every discard — so
 * the claim has to be made about the RANKING, which is where the felt's Hint
 * button reads it too, and not about what a bot happened to do.
 *
 * Asked of `easy`, which is `botHeuristic` alone and so is the claim itself.
 * The position evaluator says the same thing by a different route — a held
 * wild is worth WILD_IN_HAND and nothing natural is — and that is the test
 * below.
 */
test("stockpile ranks a wild discard below every natural one", async () => {
  let checked = 0;
  for (let game = 0; game < 2; game++) {
    const state = await dealt("stockpile", 4, `wilds:stockpile:${game}`);
    walk(state, 300, "easy", (live, seat) => {
      const hand = live.zones.cards(`hand.${seat}`);
      if (!hand.some((id) => wild(live, id)) || !hand.some((id) => !wild(live, id))) return;
      const discards = rankMoves(live, seat, { difficulty: "easy" }).filter((r) => r.move.type === "discard");
      if (discards.length === 0) return;
      const worstNatural = Math.min(...discards.filter((r) => !wild(live, r.move.cards[0])).map((r) => r.score));
      const bestWild = Math.max(...discards.filter((r) => wild(live, r.move.cards[0])).map((r) => r.score));
      assert.ok(bestWild < worstNatural,
        `stockpile: seat ${seat} rated a wild discard ${bestWild} against ${worstNatural} for the worst natural`);
      checked++;
    });
  }
  assert.ok(checked > 20, `stockpile: only ${checked} positions had both a wild and a natural to compare`);
});

test("stockpile's evaluator would rather hold the wild than the natural", async () => {
  const state = await dealt("stockpile", 4, "wilds:stockpile:hold");
  const template = state.pack.template;
  const seat = state.turn.seat;
  const hand = state.zones.cards(`hand.${seat}`);
  const wildId = find(state, everyCardId(state), (card) => isWild(card, state.pack.rules.wilds));
  const naturalId = hand.find((id) => !wild(state, id));
  assert.ok(wildId && naturalId, "stockpile: nothing to compare");
  place(state, wildId, `hand.${seat}`);

  const without = (id) => {
    const at = hand.indexOf(id);
    const removed = hand.splice(at, 1);
    try { return template.evaluateState(makeCtx(state), seat); } finally { hand.splice(at, 0, ...removed); }
  };
  assert.ok(without(wildId) < without(naturalId),
    `stockpile: shedding the wild scored ${without(wildId)}, shedding the natural ${without(naturalId)}`);
});

test("stockpile's rollouts have something to tell them apart", async () => {
  // `matchStanding` is what a finished rollout is graded by, and without it
  // Stockpile's every rollout came back worth exactly zero — the manifest
  // names no scoring — so `hard` had no spread and fell back to enumeration
  // order. The claim is arithmetic, not a sampling probe: one card off the
  // stock has to move the standing.
  const state = await dealt("stockpile", 4, "wilds:stockpile:standing");
  const template = state.pack.template;
  assert.strictEqual(typeof template.matchStanding, "function", "stockpile: no matchStanding");
  const before = template.matchStanding(makeCtx(state), 0);
  state.zones.cards("stock.0").pop();
  assert.ok(template.matchStanding(makeCtx(state), 0) > before,
    "stockpile: playing a card off the stock did not improve the seat's standing");
});
