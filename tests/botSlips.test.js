// TWO THINGS A PLAYTEST READ AS "THE BOT CANNOT SEE THE TABLE".
//
// Milestones bots aimed every skip at seat 0, the host, because every target
// scored the same and the stable sort kept the first one enumerated, even
// when the host was already sitting out a turn and a second skip did nothing.
// And a persona's "mistake" took the runner-up by RANK, so in a hand where
// the best move was a hit, the slip threw away the card that would have hit,
// and with three cards left it could throw the wild.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { chooseBotMove, rankMoves } from "../src/engine/bot.js";
import { PERSONAS } from "../src/players/roster.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { actingSeats } from "./fixtures/engine.js";

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
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

/**
 * A four-seat Milestones table where the acting seat has drawn and holds a
 * skip, and `leader` (never seat 0, never the first seat in turn order) is
 * three rungs further up the ladder than anybody else.
 */
async function skipTable() {
  const state = await dealt("milestones", 4, "slips:skip");
  const actor = state.turn.seat;
  applyMove(state, { actor, type: "draw", from: "draw" });
  const skip = [...state.zones.cards("draw")]
    .find((id) => state.pack.cardsById.get(id.split("#")[0]).rank === "skip");
  assert.ok(skip, "no skip left in the draw pile to hand the seat");
  place(state, skip, `hand.${actor}`);
  const others = [0, 1, 2, 3].filter((s) => s !== actor);
  const leader = others[others.length - 1];
  assert.notStrictEqual(leader, 0, "the leader has to be someone seat order would not pick");
  makeCtx(state).setPlayerVar(leader, "phase", 4);
  return { state, actor, leader, skip, others };
}

const skipsOf = (ranked, skip) => ranked.filter((e) => e.move.type === "discard" && e.move.cards[0] === skip);

test("a skip goes to the seat nearest the top of the ladder, at every deterministic difficulty", async () => {
  for (const difficulty of ["easy", "medium"]) {
    const { state, actor, leader, skip } = await skipTable();
    const best = skipsOf(rankMoves(state, actor, { difficulty }), skip)[0];
    assert.ok(best, `${difficulty}: the skip was never offered as a discard`);
    assert.strictEqual(best.move.choice.target, leader,
      `${difficulty}: the skip went to seat ${best.move.choice.target}, not the leader (seat ${leader})`);
  }
});

test("a seat already skipping its next turn is not skipped again while anyone else could be", async () => {
  for (const difficulty of ["easy", "medium"]) {
    const { state, actor, leader, skip, others } = await skipTable();
    makeCtx(state).setPlayerVar(leader, "skipNextTurn", true);
    const targets = enumerateLegalMoves(state, actor)
      .filter((m) => m.type === "discard" && m.cards[0] === skip)
      .map((m) => m.choice.target);
    assert.deepStrictEqual([...targets].sort(), others.filter((s) => s !== leader).sort(),
      `${difficulty}: the already-skipped seat was still offered as a target`);
    const best = skipsOf(rankMoves(state, actor, { difficulty }), skip)[0];
    assert.notStrictEqual(best.move.choice.target, leader,
      `${difficulty}: the skip was spent on a seat that was already skipping`);
  }
});

/**
 * Walk whole Milestones hands with the sloppiest persona and a random stream
 * that ALWAYS takes the mistake branch, checking every move it makes against
 * the ranking it was made from.
 */
test("a persona's slip picks a slightly worse card for the same action, never a different action", async () => {
  let calls = 0;
  const random = () => (calls++ % 2 === 0 ? 0 : 0.99);
  let hitTurns = 0;
  let slips = 0;
  for (let game = 0; game < 6; game++) {
    const state = await dealt("milestones", 4, `slips:persona:${game}`);
    for (let i = 0; i < 400 && !state.gameOver; i++) {
      const [seat] = actingSeats(state);
      const opts = { persona: PERSONAS.reckless, difficulty: "easy" };
      const ranked = rankMoves(state, seat, opts);
      const move = chooseBotMove(state, seat, { ...opts, random });
      if (!move) break;
      const best = ranked[0];
      const worst = ranked[ranked.length - 1].score;
      const chosen = ranked.find((e) => JSON.stringify(e.move) === JSON.stringify(move));
      assert.strictEqual(move.type, best.move.type,
        `a slip turned a ${best.move.type} into a ${move.type}`);
      assert.ok(chosen.score >= best.score - 0.25 * (best.score - worst),
        `a slip reached a move scored ${chosen.score} against a best of ${best.score}`);
      if (best.move.type === "hit") hitTurns++;
      if (chosen !== best) slips++;
      applyMove(state, move);
    }
  }
  assert.ok(hitTurns > 20, `only ${hitTurns} turns had a hit on offer — nothing was exercised`);
  assert.ok(slips > 20, `only ${slips} slips were made — the mistake branch was not exercised`);
});
