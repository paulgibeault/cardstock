// The ORDER every pack deals in, pinned against stored digests (#237).
//
// tests/deal.test.js, tests/fork.test.js and the rule corpus all check what a
// deal holds — counts, membership, a playable starter — and none of them check
// which card went where. A `placeDeck` that dealt the shuffled deck reversed
// kept every one of them green, and tests/replayIdentity.test.js compares a
// tree against itself, so a consistent change passes it too. But a saved match
// replays through the same deal: change the order and every save, every seeded
// repro and every bot-tuning baseline quietly means a different game.
//
// So this digests the post-deal zones — every address, sorted, with its card
// ids IN ZONE ORDER — and compares against a literal written here, never one
// computed at test time. Round 1 at two seeds, plus one round-2 deal so the
// dealer rotation is pinned too. No bot moves: the deal is the whole subject.
// Where a pack's deal does not read the round (the shedding packs, cribbage),
// its r2 digest equals its r1 digest; that is the pin, not a copy-paste slip.
// Hearts and team-spades share a template and a 4-seat layout, so their
// digests match each other for the same reason.
//
// Seat counts are fixed here rather than read from each manifest's `best`, so
// that retuning a lobby default cannot re-pin a deal behind this file's back.
import { test } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { listPackIds, loadPackFromDisk } from "../tools/pack-test.mjs";

const SEEDS = ["deal-order:a", "deal-order:b"];

// pack → [seats, { "<seed>@r<round>": sha256 }]
const PINNED = {
  "crazy-eights": [3, {
    "deal-order:a@r1": "56e7a23746f33850415f69c88d53098aa072b0f2f9926e22e73d2651066cbdcd",
    "deal-order:b@r1": "da8706f61d5c08f8f6bc10972bc4f30754f88d0ae6f698138eb4856226ef0471",
    "deal-order:a@r2": "56e7a23746f33850415f69c88d53098aa072b0f2f9926e22e73d2651066cbdcd",
  }],
  "cribbage": [2, {
    "deal-order:a@r1": "a0f2024270f1b81d449f60f308f96c79c3b40435c373a68c99154a8803087070",
    "deal-order:b@r1": "2ab415d1f4f48f3c7cb38c27d5740231473342b44028d43e70a53c7563e19040",
    "deal-order:a@r2": "a0f2024270f1b81d449f60f308f96c79c3b40435c373a68c99154a8803087070",
  }],
  "hearts": [4, {
    "deal-order:a@r1": "7c51bcf8a486ced6bdca711bc135cc6da95a434b114721c80703816f04a7295b",
    "deal-order:b@r1": "d5f6c1abaf07446f23b37adb32dd1187e9b5c72f91b524eeef4e1bb3d522e183",
    "deal-order:a@r2": "ff5585af1920b65fabd684b8927cc3353bc76fd366bf4b6cf97139785b4d3490",
  }],
  "milestones": [3, {
    "deal-order:a@r1": "31a06afa3f265509f8e15f4911cd44880d8345c2bc1b7d28c61d9cf3edee6583",
    "deal-order:b@r1": "73c7c285ab8a41a241947cd912e8306167ec0ae4e944602befc205b5ab02c4ed",
    "deal-order:a@r2": "31a06afa3f265509f8e15f4911cd44880d8345c2bc1b7d28c61d9cf3edee6583",
  }],
  "pinochle": [4, {
    "deal-order:a@r1": "2ab068ac7db7009dd9767f61b502aaf9a48aa7dc2aa0a6ebd5c76243c2f4b26a",
    "deal-order:b@r1": "3d54e6c0dabcf5c8ceb6870c450b5b1157d5fac71907fc484abe71a29e43174b",
    "deal-order:a@r2": "d729ddc47370f97fbd2dc4ed8076be8c0f9685b0618ff33957b5bcb208bb655c",
  }],
  "stockpile": [4, {
    "deal-order:a@r1": "d63b5bf66496d43659e403e1eb0cc5dbfa05510e3d3c0bf920827df8e355a1e0",
    "deal-order:b@r1": "ef2b96e10d8228576d3f6ab0e2cb5a93d2cabec9c3301fbeb1c7b050c51a4428",
    "deal-order:a@r2": "d63b5bf66496d43659e403e1eb0cc5dbfa05510e3d3c0bf920827df8e355a1e0",
  }],
  "team-spades": [4, {
    "deal-order:a@r1": "7c51bcf8a486ced6bdca711bc135cc6da95a434b114721c80703816f04a7295b",
    "deal-order:b@r1": "d5f6c1abaf07446f23b37adb32dd1187e9b5c72f91b524eeef4e1bb3d522e183",
    "deal-order:a@r2": "ff5585af1920b65fabd684b8927cc3353bc76fd366bf4b6cf97139785b4d3490",
  }],
  "thirteen": [4, {
    "deal-order:a@r1": "4e8b3d744143c84dcf7b739c203b0e43ceba088d296ba86723f6f046f171f196",
    "deal-order:b@r1": "e009b7df8759a3e47a41b5f9ef7dcb8f0a4e057c9495a59b6cf1d69d3e86de56",
    "deal-order:a@r2": "80d8bfde51c1b659ceba94aa804533377de27ef7b8b56683bdc0a6e13f37ab4d",
  }],
  "wildfire": [3, {
    "deal-order:a@r1": "9b7090d07a2701e73dbb138c18fcf0bb8eefca2e64374e2abdcbc1b219b61e7d",
    "deal-order:b@r1": "fda5598894b1e7dd455c44a7438d8787a4b7237fbb11a6bf5487d71d803051fc",
    "deal-order:a@r2": "9b7090d07a2701e73dbb138c18fcf0bb8eefca2e64374e2abdcbc1b219b61e7d",
  }],
};

const CASES = [
  { seed: SEEDS[0], round: 1 },
  { seed: SEEDS[1], round: 1 },
  { seed: SEEDS[0], round: 2 },
];

function dealDigest(pack, { seats, seed, round }) {
  const state = createState({ pack, seats, seed });
  state.roundNumber = round;
  pack.template.setup(makeCtx(state));
  const zones = state.zones.allAddresses().sort()
    .map((address) => [address, state.zones.cards(address)]);
  return crypto.createHash("sha256").update(JSON.stringify(zones)).digest("hex");
}

test("every shipped pack has its deal order pinned here", () => {
  assert.deepStrictEqual(Object.keys(PINNED).sort(), listPackIds(),
    "a pack was added or removed: give it a seat count and digests in PINNED");
});

for (const packId of listPackIds()) {
  test(`${packId}: the deal order matches its pinned digest`, async () => {
    const pinned = PINNED[packId];
    assert.ok(pinned, `${packId} has no entry in PINNED`);
    const [seats, digests] = pinned;
    const pack = await loadPackFromDisk(packId);
    const { min, max } = pack.manifest.players;
    assert.ok(seats >= min && seats <= max, `${packId}: ${seats} seats is outside ${min}–${max}`);
    const drifted = [];
    for (const { seed, round } of CASES) {
      const key = `${seed}@r${round}`;
      const actual = dealDigest(pack, { seats, seed, round });
      if (actual !== digests[key]) drifted.push(`  "${key}": "${actual}",  (pinned ${digests[key]})`);
    }
    if (drifted.length) assert.fail(
      `${packId}'s deal order changed at ${seats} seats — a saved match would replay a ` +
      `different game. If the deal changed on purpose, update the digest for ${packId} in ` +
      `tests/dealOrder.test.js and say why in the PR:\n${drifted.join("\n")}`);
  });
}
