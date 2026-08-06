// Seed + event log really does reconstruct the match.
//
// This is the pre-commitment Phase 2 owes Phase 8 (ARCADE_ENHANCEMENTS.md):
// `activeMatch` persists a seed and a move log and re-hydrates by replaying
// the reducer, which is the identical payload a multiplayer `snapshot` frame
// carries and the identical path an `overflowed` resync takes. If this ever
// regresses to a state dump, save/resume keeps working and multiplayer
// quietly loses the cheap version of its hardest problem — so it is pinned
// here rather than left as a comment.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { serializeMatch, rehydrateMatch, isReplayableMatch, MATCH_FORMAT_VERSION }
  from "../src/engine/replay.js";
import { ROOT } from "../tools/stage.mjs";
import { listPackIds } from "../tools/pack-test.mjs";

function packFromDisk(packId) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

/** Play `moves` bot turns from a fresh deal and return the live state. */
function playOut(pack, seed, seats, moves) {
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  for (let i = 0; i < moves && !state.gameOver; i++) {
    const seat = state.turn.seat;
    const move = chooseBotMove(state, seat);
    if (!move) break;
    applyMove(state, move);
  }
  return state;
}

/** Everything a player can see, flattened for comparison. */
function fingerprint(state) {
  return {
    zones: Object.fromEntries(
      state.zones.allAddresses().sort().map((a) => [a, state.zones.cards(a).join(",")])),
    turn: state.turn,
    direction: state.direction,
    vars: state.vars,
    playerVars: state.playerVars,
    scores: state.scores,
    gameOver: state.gameOver,
    winner: state.winner,
    logLength: state.log.length,
  };
}

for (const packId of listPackIds()) {
  test(`${packId}: a played-out match replays to an identical state`, () => {
    const pack = packFromDisk(packId);
    const seats = Math.max(2, Math.min(4, pack.manifest.players.max));
    const played = playOut(pack, `replay:${packId}`, seats, 40);
    assert.ok(played.log.length > 0, "the scripted match made no moves to replay");

    const snapshot = serializeMatch(played, { savedAt: 0 });
    assert.ok(isReplayableMatch(snapshot), "serializeMatch produced an unreplayable payload");

    // A second pack instance, exactly as a cold boot would build it — nothing
    // is shared with the live match but the seed and the log.
    const rehydrated = rehydrateMatch(packFromDisk(packId), snapshot);
    assert.deepStrictEqual(fingerprint(rehydrated), fingerprint(played));
  });
}

// A turn that ends by "keeping" a drawn card ends through a logged `pass`
// move, and that is the entire reason it is a move at all: a turn ended in the
// UI would be absent from the log, and a resumed match would replay the draw
// and then sit in a phase nobody ever left. Both ways out of playDrawn have to
// survive the round trip, so both are driven here.
test("a draw you may play from replays through either exit", () => {
  const pack = packFromDisk("wildfire");
  const state = createState({ pack, seats: 3, seed: "play-after-draw-replay" });
  pack.template.setup(makeCtx(state));

  let kept = 0;
  let played = 0;
  for (let i = 0; i < 400 && !state.gameOver; i++) {
    const seat = state.turn.seat;
    // Alternate the two exits, so one log carries both.
    const move = state.turn.phase === "playDrawn" && kept <= played
      ? { actor: seat, type: "pass" }
      : chooseBotMove(state, seat);
    if (!move) break;
    if (state.turn.phase === "playDrawn") {
      if (move.type === "pass") kept++;
      else played++;
    }
    applyMove(state, move);
  }
  assert.ok(kept > 0 && played > 0,
    `the match exercised neither exit (kept ${kept}, played ${played})`);
  assert.ok(state.log.some((m) => m.type === "pass"), "the keep never reached the log");

  const snapshot = serializeMatch(state, { savedAt: 0 });
  assert.deepStrictEqual(fingerprint(rehydrateMatch(packFromDisk("wildfire"), snapshot)),
    fingerprint(state));
});

test("the snapshot is JSON round-trippable — it crosses a storage bridge and a wire", () => {
  const pack = packFromDisk("crazy-eights");
  const played = playOut(pack, "json-safe", 3, 20);
  const snapshot = serializeMatch(played, { savedAt: 0 });
  const viaJson = JSON.parse(JSON.stringify(snapshot));
  assert.deepStrictEqual(viaJson, snapshot);
  assert.deepStrictEqual(
    fingerprint(rehydrateMatch(packFromDisk("crazy-eights"), viaJson)),
    fingerprint(played));
});

test("the log is stored without its seq — replay renumbers from the reducer", () => {
  const pack = packFromDisk("crazy-eights");
  const played = playOut(pack, "no-seq", 3, 10);
  const snapshot = serializeMatch(played, { savedAt: 0 });
  assert.ok(snapshot.log.every((m) => !("seq" in m)), "seq leaked into the payload");
  const rehydrated = rehydrateMatch(packFromDisk("crazy-eights"), snapshot);
  assert.deepStrictEqual(rehydrated.log.map((m) => m.seq),
    played.log.map((m) => m.seq));
});

test("unreplayable payloads are rejected, not guessed at", () => {
  const ok = serializeMatch(playOut(packFromDisk("crazy-eights"), "reject", 3, 5), { savedAt: 0 });
  assert.ok(isReplayableMatch(ok));

  for (const bad of [
    null, undefined, 42, "a match", [],
    { ...ok, formatVersion: MATCH_FORMAT_VERSION + 1 },
    { ...ok, packId: 7 },
    { ...ok, seats: 99 },
    { ...ok, seed: null },
    { ...ok, log: "not an array" },
    { ...ok, log: [{ actor: 0 }] },          // no move type
    { ...ok, variants: undefined },
  ]) {
    assert.ok(!isReplayableMatch(bad), `should have been rejected: ${JSON.stringify(bad)?.slice(0, 80)}`);
  }
});

test("a snapshot from another pack is refused rather than replayed", () => {
  const snapshot = serializeMatch(playOut(packFromDisk("crazy-eights"), "x-pack", 3, 5), { savedAt: 0 });
  assert.throws(() => rehydrateMatch(packFromDisk("hearts"), snapshot), /pack mismatch/);
});

/* ------------------------------------------------------------------ *
 * The incremental strip (issue #6)
 * ------------------------------------------------------------------ */

// serializeMatch runs after EVERY applied move and every announcement, so
// re-stripping the whole log each time made persistence grow with the match.
// It now extends a cached array instead. These pin the two things that could
// go wrong with a cache: a payload that misses the newest move, and two
// payloads that turn out to be the same array.

test("an incrementally stripped log matches stripping the whole thing", () => {
  const pack = packFromDisk("crazy-eights");
  const state = playOut(pack, "strip", 3, 0);
  for (let i = 0; i < 25 && !state.gameOver; i++) {
    const move = chooseBotMove(state, state.turn.seat);
    if (!move) break;
    applyMove(state, move);
    // Serialize after every single move — the real call pattern, and the one
    // the cache has to stay correct under.
    const naive = state.log.map(({ seq, ...rest }) => rest);
    assert.deepStrictEqual(serializeMatch(state, { savedAt: 0 }).log, naive,
      `diverged after ${i + 1} moves`);
  }
  assert.ok(state.log.length > 5, "expected the game to have actually progressed");
});

test("an earlier payload does not grow a move it was never given", () => {
  const pack = packFromDisk("crazy-eights");
  const state = playOut(pack, "alias", 3, 6);
  const first = serializeMatch(state, { savedAt: 0 });
  const lengthWhenTaken = first.log.length;

  const move = chooseBotMove(state, state.turn.seat);
  applyMove(state, move);
  const second = serializeMatch(state, { savedAt: 0 });

  assert.strictEqual(first.log.length, lengthWhenTaken, "the old payload was mutated");
  assert.strictEqual(second.log.length, lengthWhenTaken + 1);
  assert.notStrictEqual(first.log, second.log, "payloads share one array");
});

test("a cached log still round-trips through rehydrate", () => {
  const pack = packFromDisk("milestones");
  const state = playOut(pack, "cached-rt", 3, 20);
  serializeMatch(state, { savedAt: 0 });          // prime the cache
  const snapshot = serializeMatch(state, { savedAt: 0 });
  assert.deepStrictEqual(fingerprint(rehydrateMatch(pack, snapshot)), fingerprint(state));
});
