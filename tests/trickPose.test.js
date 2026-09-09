// THE POSITION A MOVE PASSES THROUGH — `template.poseMove` (issue #123).
//
// The fourth card of a trick is played and all four are swept into the winner's
// pile inside one `applyMove`, which is right and is not negotiable: a replay
// has to reach the same position at the same move. What it cost was the felt —
// driven frame by frame on unmodified main, the trick pile went 1 → 2 → 3 → 0
// and the deciding card was never once a rendered card.
//
// So the felt asks the template for the half-move, on a throwaway fork. These
// tests pin the two halves of "throwaway": that the pose IS the position with
// four cards on the table, and that it is a strict SUBSET of the real move —
// nothing scored, nothing gathered, no event emitted, and the live state it was
// forked from untouched. A pose that did any of those would be a second set of
// rules living in the renderer.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { forkState } from "../src/engine/fork.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

function put(state, address, cardIds) {
  const zone = state.zones.get(address);
  zone.cards.push(...cardIds);
  for (const id of cardIds) state.cardLocation.set(id, address);
}

/** A Team Spades table with three cards down and the fourth in seat 3's hand. */
async function threeDown({ inTrick = ["hearts-4", "hearts-J", "hearts-9"] } = {}) {
  const pack = await loadPackFromDisk("team-spades");
  const state = createState({ pack, seats: 4, seed: "trick-pose" });
  for (let seat = 0; seat < 4; seat++) {
    state.zones.get(`hand.${seat}`).cards.length = 0;
    state.playerVars[seat].bid = 3;
  }
  state.zones.get("trick").cards.length = 0;
  put(state, "trick", inTrick);
  put(state, "hand.3", ["hearts-2", "spades-5"]);
  Object.assign(state.vars, { led: "hearts", leader: 0, spadesBroken: false, trickNumber: 4 });
  state.turn.seat = 3;
  state.turn.phase = "play";
  return { pack, state };
}

const play = { actor: 3, type: "playCard", cards: ["hearts-2"] };

test("the pose is the position with every card of the trick on the table", async () => {
  const { pack, state } = await threeDown();
  const posed = forkState(state);
  assert.equal(pack.template.poseMove(makeCtx(posed), play), true);

  assert.equal(posed.zones.count("trick"), 4, "all four cards are on the trick");
  assert.deepEqual(posed.zones.cards("trick"),
    ["hearts-4", "hearts-J", "hearts-9", "hearts-2"], "in the order they were played");
  for (let seat = 0; seat < 4; seat++) {
    assert.equal(posed.zones.count(`won.${seat}`), 0, `seat ${seat} has gathered nothing yet`);
  }
  assert.equal(posed.zones.count("hand.3"), 1, "the played card left the hand");
});

// The whole reason this is a hook and not a UI trick: the pose must be a subset
// of the move, or the felt is running rules of its own.
test("the pose scores nothing, says nothing and ends nobody's turn", async () => {
  const { pack, state } = await threeDown();
  const posed = forkState(state);
  posed.events.length = 0;
  pack.template.poseMove(makeCtx(posed), play);

  assert.deepEqual(posed.events, [], "no trickWon, no anything");
  assert.deepEqual(posed.scores, state.scores, "nothing scored");
  assert.equal(posed.turn.seat, 3, "the turn has not moved on");
  assert.equal(posed.vars.trickNumber, 4, "and the trick number has not");
});

// A LEAD, A SECOND AND A THIRD CARD land on a trick that stays on the table
// anyway. There is nothing to hold, and posing every play would put a beat
// between every card and the next.
test("only the card that completes a trick is worth a pose", async () => {
  const { pack, state } = await threeDown({ inTrick: [] });
  for (const already of [[], ["hearts-4"], ["hearts-4", "hearts-J"]]) {
    const posed = forkState(state);
    posed.zones.get("trick").cards.length = 0;
    for (const id of already) put(posed, "trick", [id]);
    assert.equal(pack.template.poseMove(makeCtx(posed), play), false,
      `${already.length} cards already down is not a pose`);
  }
});

test("a move that is not a played card is never posed", async () => {
  const { pack, state } = await threeDown();
  const posed = forkState(state);
  assert.equal(pack.template.poseMove(makeCtx(posed), { actor: 3, type: "bid", choice: { bid: 2 } }), false);
  assert.equal(pack.template.poseMove(makeCtx(posed), undefined), false);
});

// THE FORK IS A THROWAWAY. It is taken before the move reaches the engine and
// the engine must not be able to tell that it existed — the same posture
// `takeRoundFinal` has (#120).
test("posing a fork leaves the state it was forked from alone", async () => {
  const { pack, state } = await threeDown();
  const posed = forkState(state);
  pack.template.poseMove(makeCtx(posed), play);

  assert.equal(state.zones.count("trick"), 3, "the live trick is where it was");
  assert.equal(state.zones.count("hand.3"), 2, "and the live hand still holds the card");

  // And the real move still does everything it always did, on top of that
  // untouched state: this is the assertion that the pose did not eat the move.
  applyMove(state, play);
  const trick = state.events.find((e) => e.type === "trickWon");
  assert.ok(trick, "the real move still resolves the trick");
  assert.equal(trick.seat, 1, "hearts-J takes it");
  assert.equal(state.zones.count("trick"), 0, "and the table is swept");
  assert.equal(state.zones.count("won.1"), 4);
});

// Every pack on this template gets the reveal, so every pack on this template
// has to be able to pose. Hearts and Pinochle are the two the trick beat was
// audited against on the felt (#123's Verified section).
test("every trick-taking pack poses its own fourth card", async () => {
  for (const id of ["team-spades", "hearts", "pinochle"]) {
    const pack = await loadPackFromDisk(id);
    assert.equal(typeof pack.template.poseMove, "function", `${id} has no poseMove`);
    const state = createState({ pack, seats: 4, seed: `pose-${id}` });
    // `createState` does not deal — it builds the zones — so the trick is laid
    // out by hand from the pack's own deck. Three down, and the fourth in the
    // hand about to play it.
    const deck = [...pack.cardsById.keys()].slice(0, 4);
    put(state, "trick", deck.slice(0, 3));
    put(state, "hand.0", [deck[3]]);
    Object.assign(state.vars, { leader: 1, led: makeCtx(state).cardById(deck[0]).suit });
    state.turn.seat = 0;
    state.turn.phase = "play";
    const posed = forkState(state);
    assert.equal(pack.template.poseMove(makeCtx(posed), { actor: 0, type: "playCard", cards: [deck[3]] }), true,
      `${id} refused to pose a completed trick`);
    assert.equal(posed.zones.count("trick"), 4, `${id} posed a trick of the wrong size`);
  }
});
