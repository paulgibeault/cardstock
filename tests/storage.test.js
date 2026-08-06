// The lobby's storage contract: one saved table per pack, and no game lost on
// the way there.
//
// These are the invariants a player would feel break. "Starting Hearts kept my
// Crazy Eights game" is the whole point of the per-pack keys, and the legacy
// migration only ever runs once per install — on the upgrade, in the field,
// where nobody is watching. Both are cheap to assert and expensive to discover.
import { test, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { serializeMatch } from "../src/engine/replay.js";
import { ROOT } from "../tools/stage.mjs";
import {
  KEYS, MATCH_KEY_PREFIX, matchKey, isMatchKey, saveMatch, loadMatch, clearMatch,
  listMatchSummaries, lastPlayedPack, rememberPack,
} from "../src/arcade/storage.js";

// The SDK's synchronous state surface is a key/value store; a Map is the whole
// of what storage.js uses. Standing this up here rather than importing a stub
// from src/ keeps the production module free of a test seam.
const store = new Map();
globalThis.Arcade = {
  state: {
    get: (k) => store.get(k),
    set: (k, v) => { store.set(k, structuredClone(v)); return true; },
    remove: (k) => store.delete(k),
    getOrInit: (k, d) => (store.has(k) ? store.get(k) : d),
  },
};

beforeEach(() => store.clear());

function packFromDisk(packId) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

/** A real match, some moves in — the thing that actually gets stored. */
function playedMatch(packId, moves = 6) {
  const pack = packFromDisk(packId);
  const state = createState({ pack, seats: 3, seed: `storage:${packId}` });
  pack.template.setup(makeCtx(state));
  for (let i = 0; i < moves && !state.gameOver; i++) {
    const move = chooseBotMove(state, state.turn.seat);
    if (!move) break;
    applyMove(state, move);
  }
  return state;
}

test("keys are namespaced per pack and recognisable as match keys", () => {
  assert.strictEqual(matchKey("hearts"), `${MATCH_KEY_PREFIX}hearts`);
  assert.ok(isMatchKey(matchKey("hearts")));
  assert.ok(!isMatchKey(KEYS.settings));
  assert.ok(!isMatchKey(KEYS.lastPack));
  assert.ok(!isMatchKey(undefined));
});

test("two packs hold their own saved games at the same time", () => {
  const hearts = playedMatch("hearts");
  const eights = playedMatch("crazy-eights");
  saveMatch(hearts);
  saveMatch(eights);

  assert.strictEqual(loadMatch("hearts").log.length, hearts.log.length);
  assert.strictEqual(loadMatch("crazy-eights").log.length, eights.log.length);

  // The regression the per-pack keys exist to prevent: before them, saving the
  // second match overwrote the first and the player lost a game by opening
  // another one.
  assert.notStrictEqual(loadMatch("hearts").log.length, loadMatch("crazy-eights").log.length);
});

test("clearing one pack's match leaves the others alone", () => {
  saveMatch(playedMatch("hearts"));
  saveMatch(playedMatch("crazy-eights"));
  clearMatch("hearts");
  assert.strictEqual(loadMatch("hearts"), null);
  assert.ok(loadMatch("crazy-eights"));
});

test("a match found under the wrong pack's key is refused, not replayed", () => {
  // Only reachable through a hand-edited save bundle, but the lobby would
  // otherwise advertise a resumable game the table then refuses to open.
  store.set(matchKey("hearts"), serializeMatch(playedMatch("crazy-eights")));
  assert.strictEqual(loadMatch("hearts"), null);
});

test("junk in a match key reads as no saved game", () => {
  for (const junk of [null, 42, "a match", {}, { formatVersion: 99 }]) {
    store.set(matchKey("hearts"), junk);
    assert.strictEqual(loadMatch("hearts"), null, `accepted ${JSON.stringify(junk)}`);
  }
});

test("an invalid pack id never reaches a key", () => {
  for (const bad of ["../../etc/passwd", "a/b", "", null, undefined]) {
    assert.strictEqual(loadMatch(bad), null);
    assert.strictEqual(clearMatch(bad), false);
  }
  assert.strictEqual(store.size, 0);
});

test("summaries describe the waiting games without replaying them", () => {
  const hearts = playedMatch("hearts", 8);
  saveMatch(hearts);

  const summaries = listMatchSummaries(["crazy-eights", "hearts", "wildfire"]);
  assert.deepStrictEqual([...summaries.keys()], ["hearts"], "packs with no match must be absent");

  const s = summaries.get("hearts");
  assert.strictEqual(s.packId, "hearts");
  assert.strictEqual(s.moves, hearts.log.length);
  assert.strictEqual(s.seats, 3);
  assert.ok(typeof s.savedAt === "number");
});

test("the last pack played is a hint the lobby can trust or ignore", () => {
  assert.strictEqual(lastPlayedPack(), null);
  rememberPack("stockpile");
  assert.strictEqual(lastPlayedPack(), "stockpile");

  assert.strictEqual(rememberPack("../evil"), false);
  assert.strictEqual(lastPlayedPack(), "stockpile");
});
