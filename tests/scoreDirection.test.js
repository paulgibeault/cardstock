// WHICH WAY IS UP, IN THE SENTENCES THE TABLE SAYS (#121).
//
// Both narration surfaces here were written while Hearts was the only pack with
// points, and both assumed points are a penalty. The round summary called the
// HIGHEST score the leader, so Thirteen told a player their pile of penalty
// points was progress and they lost on 53 having been promised "17 to go"; the
// trick banner put every Pinochle trick in the alarm-red tone and announced a
// Team Spades trick — the whole object of the game — as "no points".
//
// Neither could be tested before: src/ui/panels.js and src/ui/celebrations.js
// touch the DOM at import time, so no Node test can load them. The sentences are
// in src/ui/scoreDirection.js for exactly that reason, and these tests pin the
// TEXT — one lowestScore pack and one highestScore pack, both functions — off
// real packs loaded from disk, because the whole failure was a wrong reading of
// a real manifest.
//
// The last test is a source gate in the style of tests/repo-gates.test.js: a
// pure function nobody calls is green forever. Reverting either call site alone
// restores the whole bug with every assertion above still passing.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createState } from "../src/engine/state.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { ROOT } from "../tools/stage.mjs";
import { targetSentence, trickNarration, winDirection } from "../src/ui/scoreDirection.js";

const seatLabel = (seat) => ["You", "Nell", "Ada", "Bo"][seat] ?? `Seat ${seat}`;

async function table(packId, { seats = 4 } = {}) {
  const pack = await loadPackFromDisk(packId);
  return createState({ pack, seats, seed: `score-direction-${packId}` });
}

/** Put `tricks` tricks' worth of cards in a seat's won pile — depth is all this reads. */
function wonTricks(state, seat, tricks) {
  const zone = state.zones.get(`won.${seat}`);
  for (let i = 0; i < tricks * state.seats; i++) zone.cards.push(`filler-${seat}-${i}`);
}

/* ------------------------------------------------------------------ *
 * The round summary's target line
 * ------------------------------------------------------------------ */

test("the direction each pack declares is the direction that is read", async () => {
  const seen = {};
  for (const id of ["thirteen", "hearts", "team-spades", "pinochle", "wildfire",
                    "crazy-eights", "milestones", "cribbage", "stockpile"]) {
    seen[id] = winDirection((await loadPackFromDisk(id)));
  }
  assert.deepStrictEqual(seen, {
    thirteen: "lowestScore",
    hearts: "lowestScore",
    "team-spades": "highestScore",
    pinochle: "highestScore",
    wildfire: "highestScore",
    "crazy-eights": "highestScore",
    // Template-owned endings and a pack with no threshold at all: null, and
    // narrated as the penalty direction, exactly as `prizeSign` reads them.
    milestones: null,
    cribbage: null,
    stockpile: null,
  });
});

test("a lowestScore pack is never told that penalty points are progress", async () => {
  const state = await table("thirteen");
  // Thirteen ends at 50 and the LOWEST score wins. Seat 1 is on 33 — closest to
  // ending the match, and closest to losing it.
  const text = targetSentence(state.pack, state.seats, [17, 33, 8, 2]);
  assert.strictEqual(text, "Match ends when anyone reaches 50 — 17 away. Lowest score wins.");
  // The two claims the old sentence made, and the reason a playtester finished
  // on 53 believing they were ahead.
  assert.doesNotMatch(text, /First to/);
  assert.doesNotMatch(text, /to go/);
});

test("Hearts reads the same way — it shares the function and shared the bug", async () => {
  const state = await table("hearts");
  assert.strictEqual(
    targetSentence(state.pack, state.seats, [4, 26, 0, 11]),
    "Match ends when anyone reaches 100 — 74 away. Lowest score wins.",
  );
});

test("a highestScore pack still says exactly what it always said", async () => {
  const state = await table("wildfire");
  assert.strictEqual(
    targetSentence(state.pack, state.seats, [120, 305, 40, 12]),
    "First to 500 wins — 195 to go.",
  );
});

test("the target line folds seats into sides", async () => {
  const state = await table("team-spades");
  // 210 + 40 on one side, 130 + 60 on the other: 250 is the number that matters,
  // not any one partner's half.
  assert.strictEqual(
    targetSentence(state.pack, state.seats, [210, 130, 40, 60]),
    "First to 500 wins — 250 to go.",
  );
});

test("a pack whose template owns the ending says nothing at all", async () => {
  for (const id of ["milestones", "cribbage"]) {
    const state = await table(id, { seats: id === "cribbage" ? 2 : 4 });
    assert.strictEqual(
      targetSentence(state.pack, state.seats, Array(state.seats).fill(30)), "",
      `${id} has no anyScore threshold and must not invent one`);
  }
});

test("a match already at its threshold stops counting down", async () => {
  const state = await table("wildfire");
  assert.strictEqual(targetSentence(state.pack, state.seats, [500, 12, 3, 4]), "");
});

/* ------------------------------------------------------------------ *
 * The trick banner
 * ------------------------------------------------------------------ */

const trick = (state, over = {}) => trickNarration({
  state, mine: true, seatLabel,
  ev: { type: "trickWon", seat: 0, cards: [], points: 0, trickNumber: 3, ...over },
});

test("Hearts still winces: points taken are points against you", async () => {
  const state = await table("hearts");
  assert.deepStrictEqual(trick(state, { points: 5 }), {
    text: "You take the trick — 5 points against you", tone: "bad", bad: true,
  });
  assert.deepStrictEqual(trick(state, { points: 1 }), {
    text: "You take the trick — 1 point against you", tone: "bad", bad: true,
  });
  assert.deepStrictEqual(trick(state, { points: 0 }), {
    text: "Trick is yours — no points", tone: "good", bad: false,
  });
});

test("somebody else's trick is a delta and nothing more, either direction", async () => {
  for (const id of ["hearts", "pinochle"]) {
    const state = await table(id);
    const said = trickNarration({
      state, mine: false, seatLabel,
      ev: { seat: 1, cards: [], points: 7, trickNumber: 3 },
    });
    assert.deepStrictEqual(said, { text: "Nell takes the trick (+7)", tone: "neutral", bad: false },
      `${id}: a bot's trick is neutral`);
  }
});

test("Team Spades counts a trick toward the side's bid, in the good tone", async () => {
  const state = await table("team-spades");
  state.playerVars[0].bid = 3;
  state.playerVars[2].bid = 2;   // partners, across the table
  wonTricks(state, 0, 2);
  wonTricks(state, 2, 1);
  assert.deepStrictEqual(trick(state), {
    text: "Trick is yours — 3 of your 5", tone: "good", bad: false,
  });
});

test("Team Spades names an overtrick as the bag it is", async () => {
  const state = await table("team-spades");
  state.playerVars[0].bid = 3;
  state.playerVars[2].bid = 2;
  wonTricks(state, 0, 4);
  wonTricks(state, 2, 2);
  const said = trick(state);
  assert.strictEqual(said.text, "Trick is yours — 6 of your 5, that's a bag");
  assert.strictEqual(said.tone, "good");
});

test("a broken nil is the one trick a Spades player did not want", async () => {
  const state = await table("team-spades");
  state.playerVars[0].bid = 0;
  state.playerVars[2].bid = 4;
  wonTricks(state, 0, 1);
  assert.deepStrictEqual(trick(state), {
    text: "You take the trick — your nil is broken", tone: "bad", bad: true,
  });
});

test("Pinochle's trick is worth what it is worth, and not against anybody", async () => {
  const state = await table("pinochle");
  // Its bid is in POINTS (rules.bidding.unit), so "3 of your 250" would be two
  // units in one sentence — the plainer wording, with the card points it took.
  state.playerVars[0].bid = 250;
  wonTricks(state, 0, 1);
  const said = trick(state, { points: 19 });
  assert.deepStrictEqual(said, {
    text: "Trick is yours — worth 19 points", tone: "good", bad: false,
  });
  assert.doesNotMatch(said.text, /against you|no points/);
  // A trick with no counters in it is still a trick you won.
  assert.deepStrictEqual(trick(state, { points: 0 }), {
    text: "Trick is yours", tone: "good", bad: false,
  });
});

/* ------------------------------------------------------------------ *
 * The felt actually asks
 * ------------------------------------------------------------------ */

/**
 * A PURE FUNCTION NOBODY CALLS IS GREEN FOREVER.
 *
 * Every assertion above would still pass with both call sites reverted to their
 * own hardcoded sentences, and neither module can be imported here to check —
 * src/ui/panels.js resolves its element table on its first line and
 * src/ui/celebrations.js pulls in the audio layer. So this is a grep, for the
 * reason the rules.* gate in tests/repo-gates.test.js gives: the question is
 * "does the felt read the pack's direction", and the cheapest honest answer is
 * the right one.
 */
test("both narration surfaces go through the shared direction read", () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

  const celebrations = read("src/ui/celebrations.js");
  assert.match(celebrations, /from '\.\/scoreDirection\.js'/,
    "src/ui/celebrations.js no longer imports the direction read");
  assert.match(celebrations, /trickNarration\(\{/,
    "src/ui/celebrations.js must ask for the trick's sentence, not build one");
  const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code(celebrations), /points against you|no points/,
    "Hearts' wording is back in the felt, applied to every pack alike — that is the #121 bug");

  const panels = read("src/ui/panels.js");
  assert.match(panels, /from '\.\/scoreDirection\.js'/,
    "src/ui/panels.js no longer imports the direction read");
  assert.doesNotMatch(code(panels), /First to \$\{/,
    "the round summary is building its own target sentence again");
});
