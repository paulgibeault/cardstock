// THE DIAL EXISTED FOR TWO DAYS WITH NO WAY TO TURN IT.
//
// `botDifficulty` shipped as a stored setting with easy/medium/hard behind it
// and nothing anywhere that let a player choose one — the feature was complete
// and unreachable, which is indistinguishable from absent. These tests are
// about the wiring between the engine's dial and the sheet a player actually
// sees, because that is the join that was missing and the join that will break
// again the day a fourth level is added.
//
// PART GREP, FOR THE REASON tests/repo-gates.test.js GIVES. src/ui/newGame.js
// and src/ui/lobby.js touch `document` at import time, so no Node test can
// load them and ask what they render. The list itself was therefore moved into
// src/ui/difficulty.js — a plain data module a test CAN import — and what
// cannot be imported is asserted the cheapest honest way instead.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { DIFFICULTIES } from "../src/engine/bot.js";
import { SKILL_LEVELS, skillLevel } from "../src/ui/difficulty.js";
import { SETTINGS_DEFAULTS } from "../src/arcade/storage.js";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("every difficulty the engine offers is one a player can pick", () => {
  assert.deepStrictEqual(
    SKILL_LEVELS.map((level) => level.id),
    [...DIFFICULTIES],
    "the sheet's levels and the engine's dial have diverged — a difficulty "
    + "nobody can select is a setting that does not exist, and one the engine "
    + "does not know is a setting that silently reads as the default",
  );
});

test("each level says what it is, in words that are not the engine's", () => {
  for (const level of SKILL_LEVELS) {
    assert.ok(level.label && level.label !== level.id,
      `${level.id}: needs a player-facing label, not the engine's own id`);
    assert.ok((level.description || "").length > 20,
      `${level.id}: needs prose saying what that opponent does`);
  }
  const labels = SKILL_LEVELS.map((l) => l.label);
  assert.strictEqual(new Set(labels).size, labels.length, "two levels share a label");
});

// A saved setting is a string on disk and can be anything — an older build, a
// hand-edited save, a future level that was rolled back. The row must still
// paint, and it must paint the same default `chooseBotMove` would play at.
test("an unknown saved value falls back to the shipped default", () => {
  assert.strictEqual(skillLevel("wildly-unreasonable").id, SETTINGS_DEFAULTS.botDifficulty);
  assert.strictEqual(skillLevel(undefined).id, SETTINGS_DEFAULTS.botDifficulty);
  assert.strictEqual(skillLevel("hard").id, "hard");
});

test("the new-game sheet builds its row from that list and hands the answer back", () => {
  const src = read("src/ui/newGame.js");
  assert.match(src, /import \{[^}]*SKILL_LEVELS[^}]*\} from '\.\/difficulty\.js'/,
    "the sheet must render the shared list, or a fourth level would be added to it twice");
  assert.match(src, /for \(const level of SKILL_LEVELS\)/,
    "the sheet must iterate the list rather than hard-code three buttons");
  assert.match(src, /close\(\{[\s\S]*?difficulty,[\s\S]*?\}\)/,
    "the sheet must return the chosen difficulty, or the lobby has nothing to save");
});

test("the lobby saves the choice on the gesture that deals, and only then", () => {
  const src = read("src/ui/lobby.js");
  assert.match(src, /botDifficulty: difficulty/, "the lobby must persist the chosen level");
  // Both doors into a new game — the tile, and re-dealing over a finished one —
  // and each one checked BETWEEN its own askNewGame and its own save.
  //
  // The first draft of this asserted the guard appeared somewhere in the file
  // and it did not bite: moving the save above the check at one call site left
  // the other site's `if (!setup)` sitting close enough to satisfy the pattern.
  // A gate that passes while the thing it watches is broken is worse than no
  // gate, so this walks the sites.
  const sites = [...src.matchAll(/askNewGame\(manifest\)([\s\S]{0,240}?)rememberDifficulty\(setup\)/g)];
  assert.strictEqual(sites.length, 2,
    `${sites.length} new-game path(s) save the answer; both the tile and the re-deal must`);
  for (const [, between] of sites) {
    assert.match(between, /if \(!setup\)/,
      "the save must sit AFTER that path's own backed-out check — cancelling the sheet "
      + "must change nothing");
  }
});

test("both bot drivers are told which difficulty to play at", () => {
  for (const file of ["src/ui/table.js", "src/ui/party.js"]) {
    assert.match(read(file), /difficulty: \(\) => loadSettings\(\)\.botDifficulty/,
      `${file}: the driver reads the setting at fire time (src/ui/botDriver.js), so this `
      + "must be a live read — a snapshot taken at table init is stale the moment the "
      + "sheet changes it");
  }
});
