// Pins the platform generator (GAME_INTEGRATION §7c).
//
// src/engine/arcade-rng.js is a byte-identical vendored copy of the launcher's
// canonical file. Nothing in CI checks it against that original — the launcher
// repo is not checked out — so these known-answer vectors are the gate: an
// accidental local edit forks every seed stream in the game, silently, and
// this is what fails instead.
import { test } from "node:test";
import assert from "node:assert";
import { makeRng, hashU32 } from "../src/engine/arcade-rng.js";
import { createRng } from "../src/engine/rng.js";

// The vectors §7c publishes.
const VECTORS = [0.6011037519201636, 0.44829055899754167, 0.8524657934904099];

test("makeRng(42) produces the documented stream", () => {
  const rng = makeRng(42);
  assert.deepStrictEqual([rng(), rng(), rng()], VECTORS);
});

test("the engine adapter rides the same stream", () => {
  const rng = createRng(42);
  assert.deepStrictEqual([rng.next(), rng.next(), rng.next()], VECTORS);
});

test("hashU32 is FNV-1a, not the old hand-rolled hash", () => {
  // The FNV-1a offset basis, which an empty string leaves untouched.
  assert.strictEqual(hashU32(""), 2166136261);
  // Stability across devices is the whole point of string seeding, so pin a
  // real value too. The pre-swap hash returned something else entirely.
  assert.strictEqual(hashU32("cardstock"), 303041715);
});

test("int() stays half-open — the engine's convention, not makeRng's", () => {
  const rng = createRng("half-open");
  for (let i = 0; i < 500; i++) {
    const n = rng.int(4);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 4, `int(4) returned ${n}`);
  }
});

test("shuffle is a copy, deterministic per seed, and a permutation", () => {
  const deck = Array.from({ length: 20 }, (_, i) => `c${i}`);
  const a = createRng("seed-1").shuffle(deck);
  const b = createRng("seed-1").shuffle(deck);
  const c = createRng("seed-2").shuffle(deck);
  assert.deepStrictEqual(a, b, "same seed must produce the same order");
  assert.notDeepStrictEqual(a, c, "different seeds must diverge");
  assert.deepStrictEqual([...a].sort(), [...deck].sort(), "must be a permutation");
  assert.deepStrictEqual(deck, Array.from({ length: 20 }, (_, i) => `c${i}`),
    "must not mutate its input");
});

test("getState/setState resume the exact sequence", () => {
  const rng = createRng("resume");
  rng.next(); rng.next();
  const saved = rng.getState();
  const after = [rng.next(), rng.next(), rng.next()];
  rng.setState(saved);
  assert.deepStrictEqual([rng.next(), rng.next(), rng.next()], after);
});
