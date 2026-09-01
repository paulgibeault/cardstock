// A FORK IS A DEAD END, and the original never hears about it.
//
// `forkState` (src/engine/fork.js) is hand-rolled because the live state is not
// clonable, and a hand-rolled copy is exactly the kind of thing that is correct
// on the day it is written and one field short a month later. The whole bot
// lookahead runs on these; a shared array here does not throw, it silently
// plays the human's cards for them, on the felt, in a live match.
//
// So the test is not "does forkState copy the fields it says it copies" — it is
// "play a real run of moves on the fork and prove the original is untouched",
// which is the property that actually matters and the one that stays true when
// somebody adds a field. It is checked two ways at once: `serializeMatch` (the
// match's own identity — seed plus log) and a direct comparison of every piece
// of mutable state the engine has.
//
// BOTH DIRECTIONS. Mutating the ORIGINAL must not reach the fork either. The
// two are not symmetric in the code — the fork is the copy — and a `Map` handed
// over by reference would pass a one-way test.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { forkState } from "../src/engine/fork.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { serializeMatch } from "../src/engine/replay.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

/**
 * Everything a move can move, as one comparable value.
 *
 * Deliberately written out rather than derived from Object.keys(state): a
 * snapshot that asks the state what it contains cannot notice a field the fork
 * forgot, because it would read the same forgotten field on both sides.
 */
function snapshot(state) {
  const zones = {};
  for (const address of state.zones.allAddresses()) zones[address] = state.zones.cards(address).slice();
  return {
    zones,
    cardLocation: [...state.cardLocation.entries()].sort(),
    turn: { ...state.turn },
    direction: state.direction,
    vars: JSON.parse(JSON.stringify(state.vars ?? {})),
    playerVars: JSON.parse(JSON.stringify(state.playerVars ?? [])),
    scores: state.scores.slice(),
    roundNumber: state.roundNumber,
    roundScores: JSON.parse(JSON.stringify(state.roundScores ?? null)),
    roundEnded: state.roundEnded,
    roundWinner: state.roundWinner,
    gameOver: state.gameOver,
    winner: state.winner,
    logLength: state.log.length,
    // Transient and never persisted, and included here anyway: `applyMove`
    // empties this array IN PLACE, so a shared one means a bot thinking about
    // its turn wipes the event window the felt is mid-animation on.
    events: JSON.parse(JSON.stringify(state.events ?? [])),
    rng: state.rng.getState(),
  };
}

/**
 * Play out `limit` moves ON THE FORK, calling the EXACT enumerator.
 *
 * `legalMovesFor`'s memo keys on log length and turn and is only sound while a
 * state changes solely through applyMove on that object — the rule the fork
 * helper's header states. `chooseBotMove` is on the live path and may keep
 * using the memo; a simulation on a fork may not, and this test walks the same
 * road the memo is documented as unsafe for.
 */
function playOnFork(fork, limit) {
  let played = 0;
  for (let i = 0; i < limit && !fork.gameOver; i++) {
    const template = fork.pack.template;
    const acting = template.actingSeats ? template.actingSeats(makeCtx(fork)) : [fork.turn.seat];
    let move = null;
    for (const seat of acting) {
      const moves = enumerateLegalMoves(fork, seat);
      if (moves.length) { move = moves[0]; break; }
    }
    if (!move) break;
    applyMove(fork, move);
    played++;
  }
  return played;
}

// A SHEDDING PACK AND A MELDING ONE, at minimum: they exercise different halves
// of the state. Crazy Eights moves cards between hands and recycles the discard
// pile back into the draw (a reaction firing inside moveCards, consuming RNG);
// Milestones mutates `playerVars.melds` IN PLACE through getMeldGroups, which is
// the field a shallow `{...playerVars[s]}` would have shared. Hearts is here for
// its simultaneous-commit phase, whose whole state is a player var.
const PACKS = ["crazy-eights", "milestones", "hearts"];

test("a fork can be played out without the original noticing", async () => {
  for (const packId of PACKS) {
    const pack = await loadPackFromDisk(packId);
    const seats = pack.manifest.players.best ?? pack.manifest.players.min;

    // Part-way through a real game, not at the deal: an opening position has
    // empty vars and untouched scores, so half the fields would compare equal
    // whether they were copied or not.
    const state = createState({ pack, seats, seed: `fork:${packId}` });
    pack.template.setup(makeCtx(state));
    for (let i = 0; i < 25 && !state.gameOver; i++) {
      const move = chooseBotMove(state, state.turn.seat);
      if (!move) break;
      applyMove(state, move);
    }

    const before = snapshot(state);
    const beforeMatch = serializeMatch(state, { savedAt: 0 });

    // Long enough to cross a round boundary where the pack allows one — that is
    // where `roundNumber`, `roundScores`, `roundEnded`, `roundWinner`, `winner`
    // and a whole fresh deal all move at once, and every one of them is a field
    // nothing else in the test would have touched.
    const fork = forkState(state);
    const played = playOnFork(fork, 400);
    assert.ok(played > 5, `${packId}: only ${played} moves played on the fork — nothing was proved`);

    assert.deepStrictEqual(snapshot(state), before,
      `${packId}: playing ${played} moves on a fork changed the original state`);
    assert.deepStrictEqual(serializeMatch(state, { savedAt: 0 }), beforeMatch,
      `${packId}: the original match no longer serializes to what it did before the fork`);
  }
});

test("a fork crosses a round boundary and the original stays on its own round", async () => {
  // The boundary specifically, because maybeFinishRound writes six fields the
  // rest of a game never touches and re-deals every zone from the RNG.
  const pack = await loadPackFromDisk("crazy-eights");
  const state = createState({ pack, seats: 3, seed: "fork:boundary" });
  pack.template.setup(makeCtx(state));

  const before = snapshot(state);
  const fork = forkState(state);
  playOnFork(fork, 2000);

  assert.ok(fork.roundNumber > state.roundNumber || fork.gameOver,
    "the fork never reached a round boundary, so this test proves nothing about one");
  assert.deepStrictEqual(snapshot(state), before,
    "the original moved with the fork across a round boundary");
});

test("mutating the original does not reach a fork already taken", async () => {
  const pack = await loadPackFromDisk("milestones");
  const state = createState({ pack, seats: 4, seed: "fork:reverse" });
  pack.template.setup(makeCtx(state));
  for (let i = 0; i < 20 && !state.gameOver; i++) {
    const move = chooseBotMove(state, state.turn.seat);
    if (!move) break;
    applyMove(state, move);
  }

  const fork = forkState(state);
  const before = snapshot(fork);

  for (let i = 0; i < 30 && !state.gameOver; i++) {
    const move = chooseBotMove(state, state.turn.seat);
    if (!move) break;
    applyMove(state, move);
  }

  assert.deepStrictEqual(snapshot(fork), before,
    "the original's moves reached a fork that had already been taken");
});

test("a fork's RNG continues the original's stream instead of restarting it", async () => {
  // `createRng(seed)` alone would put the fork back at the top of the sequence,
  // so a forked recycle or re-deal would produce a shuffle the original could
  // never have produced — and reading the source's position must not advance it.
  const pack = await loadPackFromDisk("crazy-eights");
  const state = createState({ pack, seats: 3, seed: "fork:rng" });
  pack.template.setup(makeCtx(state));

  const position = state.rng.getState();
  const fork = forkState(state);
  assert.strictEqual(state.rng.getState(), position, "taking a fork advanced the original's RNG");
  assert.strictEqual(fork.rng.getState(), position, "the fork's RNG did not start where the original was");
  assert.deepStrictEqual(fork.rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8]), state.rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8]),
    "the fork's stream diverged from the original's");
});
