// A GAME WITH NO SIDES MUST SERIALIZE TO THE SAME BYTES IT ALWAYS DID.
//
// Partnerships (#104) rewrote the three places that ask "how is this seat
// doing" in terms of SIDES: `evaluateGameOver` compares a side's total to the
// threshold, `placements` ranks sides, and the bot's rollout grades a hand by
// the change in its SIDE's standing. Every one of those is meant to be the
// identity for a pack that declares no sides — one side per seat, a fold over a
// single term — and "meant to be" is exactly the claim a test has to make
// unfalsifiable.
//
// WHY THE BOT IS IN THE LOOP AND NOT JUST THE SCORER. A match payload is seed +
// log (src/engine/replay.js), and the log is the MOVES. So the only way a
// scoring change can show up in a serialized match is by changing what somebody
// chose to play — which is precisely what a fold done wrong in `terminalValue`
// would do, and precisely what a test of `scoreRound` alone could never see.
// The walk below therefore plays the five shipped packs with the `hard` bot,
// whose rollouts read the standing on every sample.
//
// HOW THE EXPECTED VALUE WAS OBTAINED, because a golden nobody can regenerate
// is a golden nobody can trust: the identical walk was run against the commit
// BEFORE the partnership work (ea81211) and against the tree after it, and the
// digest below is what both produced. To re-derive it, check out that commit
// into a worktree and run this file there.
//
// REPRODUCIBLE BY CONSTRUCTION. `budgetMs: Infinity` and a fixed move budget,
// because a wall-clock budget makes the sample count a function of how busy the
// machine is — the same reason tests/rollouts.test.js does it. The RNG is
// re-seeded per decision so the answer cannot depend on how many decisions came
// before it.
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { serializeMatch, MATCH_FORMAT_VERSION } from "../src/engine/replay.js";
import { createRng } from "../src/engine/rng.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

/** Every shipped pack, at the seat count its lobby tile suggests. */
const TABLES = [
  ["crazy-eights", 4], ["milestones", 4], ["hearts", 4],
  ["wildfire", 4], ["stockpile", 4],
];

/** The digest of the five payloads, taken at ea81211 — see the header. */
const GOLDEN = "c8829cc60061594904047b61bfe9a4f76209f56a438b82b021566fefc20606a1";

async function walkedPayloads() {
  const payloads = [];
  for (const [packId, seats] of TABLES) {
    const pack = await loadPackFromDisk(packId);
    const state = createState({ pack, seats, seed: `identity:${packId}` });
    pack.template.setup(makeCtx(state));
    const template = pack.template;
    for (let i = 0; i < 40 && !state.gameOver; i++) {
      const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
      let move = null;
      for (const seat of acting) {
        move = chooseBotMove(state, seat, {
          difficulty: "hard",
          random: createRng(`identity:${packId}:${i}`).next,
          budgetMs: Infinity,
          budgetMoves: 300,
        });
        if (move) break;
      }
      if (!move) break;
      applyMove(state, move);
    }
    // `savedAt` is a clock reading and the one field that legitimately differs
    // between two runs, so it is pinned rather than compared.
    payloads.push(JSON.stringify(serializeMatch(state, { savedAt: 0 })));
  }
  return payloads;
}

test("a pack with no sides serializes byte-identically to before partnerships", async () => {
  const payloads = await walkedPayloads();
  // The probe has to have done something, or the digest is a hash of five empty
  // logs and would agree with anything.
  for (const payload of payloads) {
    const parsed = JSON.parse(payload);
    assert.ok(parsed.log.length > 4,
      `${parsed.packId} played only ${parsed.log.length} moves — too few for the digest to mean anything`);
  }
  const digest = createHash("sha256").update(payloads.join("\n")).digest("hex");
  assert.strictEqual(digest, GOLDEN,
    "the five shipped packs no longer serialize to the bytes they did before partnerships "
    + "(#104). Something folded a teamless pack through a side and did not come back the same: "
    + "check evaluateGameOver, placements, and the bot's terminalValue. See this file's header "
    + "for how to re-derive the golden.");
});

test("the match format did not change, so no stored match needs migrating", () => {
  // The acceptance for #104 is "unchanged, or bumped with a migration". It is
  // unchanged, and it is unchanged for a reason worth pinning: partnerships
  // added no field to a match payload at all. Sides are derived from the
  // manifest (src/engine/sides.js), so a stored match carries the same eight
  // keys it always did and a pack that grows sides re-derives them on load.
  assert.strictEqual(MATCH_FORMAT_VERSION, 1);
});
