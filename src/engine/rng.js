// Deterministic seeded RNG. Never use Math.random() in engine code — replay,
// resync and the rule-test harness all depend on identical sequences from the
// same seed.
//
// This is a thin ADAPTER, not an implementation. The generator itself is the
// platform's (GAME_INTEGRATION §7c): `arcade-rng.js` is vendored byte-identical
// next to this file and imported relatively, which is the only specifier that
// resolves in both the browser and `node --test`. The adapter exists solely to
// keep the `{ next, int, shuffle }` shape every engine call site already uses,
// so swapping the generator touched no other file.
//
// Note the deliberate signature difference: `makeRng().int(min, max)` is
// INCLUSIVE on both ends, while this engine's `int(maxExclusive)` is the
// half-open form its call sites expect. Do not collapse one into the other.
//
// This replaced a hand-rolled mulberry32 with a custom seed hash. The two
// produce different streams from the same string seed, so the swap happened
// before any seed was persisted — afterwards it would have been a save-compat
// break (ARCADE_COMPLIANCE.md finding D).
import { makeRng } from './arcade-rng.js';

export function createRng(seed) {
  const next = makeRng(seed);
  return {
    next,
    int(maxExclusive) {
      return Math.floor(next() * maxExclusive);
    },
    shuffle(arr) {
      return next.shuffle(arr);
    },
    // The whole generator state is one u32. Nothing persists it today —
    // `activeMatch` stores seed + event log and re-derives the stream by
    // replay (src/engine/replay.js), which is also the shape a multiplayer
    // snapshot carries. Exposed because the cost is zero and a future
    // mid-stream save would otherwise have to reach past this adapter.
    getState() {
      return next.getState();
    },
    setState(s) {
      return next.setState(s);
    },
  };
}
