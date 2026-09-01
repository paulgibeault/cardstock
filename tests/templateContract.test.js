// The template contract, enforced (src/templates/CONTRACT.md).
//
// WHY A SHAPE TEST AND NOT JUST A DOCUMENT. The contract was undocumented and
// unenforced, and the consequence was not that templates broke — it was that
// per-genre knowledge kept collecting in PLATFORM files behind
// `template.id === '…'` switches, because that was the only place it could go.
// Six of them had accumulated by the time the architecture review counted:
// interaction modes, the rules page's turn and ending prose, the lobby's genre
// labels and preview set, the card-style default, the stats panel, and the bot's
// log verbs.
//
// So this file tests two things:
//   1. every template still answers everything the platform asks it, in the
//      shape the platform expects; and
//   2. the platform still contains no branch on which template it is holding.
//
// (2) is the one that matters. A fifth template must be a new file in
// src/templates/ plus one entry in registry.js, and this is what makes that
// claim checkable rather than aspirational.

import { test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { getTemplate, TEMPLATE_IDS } from "../src/templates/index.js";
import { TEMPLATE_INFO } from "../src/templates/registry.js";
import { INTERACTION_MODES } from "../src/ui/interaction.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk, listPackIds } from "../tools/pack-test.mjs";

const REQUIRED = [
  "defaultZones", "setup", "validateMove", "applyMove",
  "enumerateLegalMoves", "isRoundOver",
];

// Everything else the platform may call. Optional, but if a template defines
// one it has to be callable — a typo'd hook name is a hook that silently never
// fires, which is the failure mode the whole contract is here to prevent.
const OPTIONAL_FUNCTIONS = [
  "defaultReactions", "startRound", "scoreRound", "isGameOver", "botHeuristic",
  // Grades a POSITION rather than a move, and its presence is what turns on the
  // one-ply lookahead in src/engine/bot.js — so a typo here is not a hook that
  // silently never fires, it is a whole search layer that silently never runs.
  "evaluateState",
  "actingSeats", "enumerateAnnouncements", "applyAnnouncement",
  "interactionMode", "pendingChoice", "activeMatch", "scoreChip",
  "seatCounters",
  "committedSelection", "getMeldGroups", "describeEvent",
  "ruleLines", "endingLines", "statLines",
  "arrangeContract", "suggestMeld",
  // Not called by the engine but by the per-seat view filter
  // (src/engine/view.js): which shared vars a peer may see. A FUNCTION when the
  // names come from the rules, which is why it belongs in this list rather
  // than among the data members below.
  "publicVars",
];

test("every template answers everything the engine calls unconditionally", () => {
  for (const id of TEMPLATE_IDS) {
    const template = getTemplate(id);
    assert.strictEqual(template.id, id, `${id}: template.id disagrees with its registry key`);
    for (const member of REQUIRED) {
      assert.strictEqual(typeof template[member], "function", `${id}: missing required ${member}()`);
    }
  }
});

test("no template exports a hook name the platform does not call", () => {
  const known = new Set([
    "id", "genreLabel", "defaultCardStyle", "playable", "botVerbs",
    ...REQUIRED, ...OPTIONAL_FUNCTIONS,
  ]);
  for (const id of TEMPLATE_IDS) {
    for (const key of Object.keys(getTemplate(id))) {
      assert.ok(known.has(key),
        `${id}: exports "${key}", which nothing in the platform reads — `
        + "add it to src/templates/CONTRACT.md and to this list, or delete it");
    }
  }
});

test("defaultZones takes (rules, seats) — both, in every template", async () => {
  const covered = new Set();
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    covered.add(pack.template.id);
    // Not the declared arity: three of the four templates named no parameters
    // at all while state.js passed two, which is legal JS and exactly the kind
    // of drift that makes a signature meaningless. What is tested is that
    // calling it the way state.js calls it produces usable zone definitions.
    const zones = pack.template.defaultZones(pack.rules, 4);
    assert.ok(Array.isArray(zones) && zones.length, `${packId}: defaultZones gave nothing`);
    for (const def of zones) {
      assert.ok(typeof def.id === "string" && def.id, `${packId}: a zone with no id`);
      if (def.landing !== undefined) {
        assert.ok(["play", "discard", "both"].includes(def.landing),
          `${packId}: zone ${def.id} has an unknown landing "${def.landing}"`);
      }
    }
  }
  assert.deepStrictEqual([...covered].sort(), [...TEMPLATE_IDS].sort(),
    "a template with no pack exercising it is a template nothing tests");
});

test("registry metadata covers exactly the templates that exist", () => {
  assert.deepStrictEqual(Object.keys(TEMPLATE_INFO).sort(), [...TEMPLATE_IDS].sort());
  for (const [id, info] of Object.entries(TEMPLATE_INFO)) {
    assert.ok(info.genreLabel, `${id}: no genre label for its lobby tile`);
    assert.ok(info.defaultCardStyle, `${id}: no default card style`);
    assert.strictEqual(typeof info.playable, "boolean", `${id}: playable must be a boolean`);
    // Stamped onto the template object by index.js, so gameplay code never has
    // to know the registry exists.
    assert.strictEqual(getTemplate(id).genreLabel, info.genreLabel);
  }
});

test("every template's interactionMode names a mode the platform can render", async () => {
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    const state = createState({ pack, seats: 4, seed: `contract:${packId}` });
    pack.template.setup(makeCtx(state));
    const mode = pack.template.interactionMode?.(makeCtx(state));
    assert.ok(INTERACTION_MODES.includes(mode),
      `${packId}: interactionMode gave "${mode}", which is not in INTERACTION_MODES`);
  }
});

test("seatCounters, where offered, is a usable list and its primary always shows", async () => {
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    if (!pack.template.seatCounters) continue;
    const state = createState({ pack, seats: 4, seed: `contract:${packId}` });
    pack.template.setup(makeCtx(state));

    for (let seat = 0; seat < state.seats; seat++) {
      const counters = pack.template.seatCounters(makeCtx(state), seat);
      assert.ok(Array.isArray(counters) && counters.length,
        `${packId}: seatCounters gave nothing for seat ${seat} — return null to take the default`);
      for (const counter of counters) {
        assert.strictEqual(typeof counter.text, "string", `${packId}: a counter with no text`);
        assert.ok(counter.text.length <= 4,
          `${packId}: "${counter.text}" is too long for a face — a counter is a couple of characters`);
        assert.ok(typeof counter.aria === "string" && counter.aria,
          `${packId}: "${counter.text}" is printed but never said`);
      }
      // THE FIRST ONE IS THE NUMBER THE ROW IS READ FOR, so it may not be the
      // kind that only appears once a seat is minimized. Marking it that way
      // made a Stockpile row read "20 20 5 20 20" — four seats showing their
      // stock and the open one still showing a hand count, the same badge
      // meaning two different quantities depending on whose turn it was.
      assert.ok(!counters[0].minimizedOnly,
        `${packId}: the primary counter is minimizedOnly, so an open seat shows a different quantity`);
    }
  }
});

test("a sequencing seat counts down its STOCK, which is the race, not its hand", async () => {
  // The regression this exists for: the platform's default is the hand count,
  // and sequencing tops every hand back up to a full five at the end of a turn
  // — so a minimized row said "5 cards" once per opponent, the same digit every
  // time, while the number the whole game is a race on was the one it had put
  // away. Asserted through the template registry rather than a pack id.
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    if (pack.template.id !== "sequencing") continue;
    const state = createState({ pack, seats: 4, seed: `contract:${packId}` });
    pack.template.setup(makeCtx(state));

    const seat = 1;
    const stock = state.zones.count(`stock.${seat}`);
    const hand = state.zones.count(`hand.${seat}`);
    assert.notStrictEqual(stock, hand,
      `${packId}: stock and hand deal to the same size, so this test cannot tell them apart`);

    const primary = pack.template.seatCounters(makeCtx(state), seat)[0];
    assert.strictEqual(primary.text, String(stock),
      `${packId}: a minimized seat shows "${primary.text}" where its stock holds ${stock}`);
  }
});

test("a pendingChoice, where one is offered, is answerable and lands a legal move", async () => {
  // Only asserts the SHAPE of an Ask across whatever the packs actually offer at
  // a fresh deal; the answers themselves are pinned per-template in
  // tests/interaction.test.js and the pack rule tests.
  for (const packId of listPackIds()) {
    const pack = await loadPackFromDisk(packId);
    if (!pack.template.pendingChoice) continue;
    const state = createState({ pack, seats: 4, seed: `contract:${packId}` });
    pack.template.setup(makeCtx(state));
    const ctx = makeCtx(state);
    for (const move of pack.template.enumerateLegalMoves(ctx, state.turn.seat)) {
      // Enumerated moves arrive with their answers already on them, so strip the
      // choice back off to reach the question the table would be asked.
      const { choice, ...bare } = move;   // eslint-disable-line no-unused-vars
      const ask = pack.template.pendingChoice(makeCtx(state), bare);
      if (!ask) continue;
      assert.ok(typeof ask.attr === "string" && ask.attr, `${packId}: an Ask with no attr`);
      assert.ok(["value", "seat"].includes(ask.kind), `${packId}: unknown Ask kind "${ask.kind}"`);
      assert.ok(Array.isArray(ask.options) && ask.options.length, `${packId}: an Ask with no options`);
      assert.strictEqual(typeof ask.apply, "function", `${packId}: an Ask with no apply()`);
      for (const option of ask.options) {
        const answered = ask.apply(bare, option.value);
        assert.ok(pack.template.validateMove(makeCtx(state), answered).legal,
          `${packId}: answering ${JSON.stringify(option.value)} left an illegal move`);
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * The invariant the hooks exist to protect
 * ------------------------------------------------------------------ */

const tracked = execSync("git ls-files -z src", { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter((f) => f.endsWith(".js"));

test("no platform file branches on which template it is holding", () => {
  // Comments are stripped first: the fixes for these switches are documented
  // beside where they used to be, and quoting the old code is the clearest way
  // to say what changed.
  const offenders = [];
  for (const file of tracked) {
    if (file.startsWith("src/templates/")) continue;
    const source = fs.readFileSync(path.join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    source.split("\n").forEach((lineText, i) => {
      if (/template(\?)?\.id\s*[=!]==?|\.template\s*[=!]==?\s*['"]/.test(lineText)) {
        offenders.push(`${file}:${i + 1}: ${lineText.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    "per-genre knowledge belongs in src/templates/ behind a hook — see src/templates/CONTRACT.md");
});

test("no platform file branches on which PACK it is holding", () => {
  const offenders = [];
  for (const file of tracked) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    source.split("\n").forEach((lineText, i) => {
      if (/pack(\?)?\.id\s*[=!]==?\s*['"]/.test(lineText)) {
        offenders.push(`${file}:${i + 1}: ${lineText.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [], "packs are manifest-only; no pack-id branch may exist in src/");
});

test("the lobby loads no gameplay code", () => {
  // The lobby's whole cost ceiling is that opening it never loads a pack, a
  // deck or the table. It used to import FULLY_PLAYABLE_TEMPLATES from
  // src/ui/table.js, which dragged 3,000 lines of table plus the engine in
  // behind one Set.
  const lobby = fs.readFileSync(path.join(ROOT, "src/ui/lobby.js"), "utf8");
  const imports = [...lobby.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(!/table\.js$/.test(spec), `lobby imports ${spec}`);
    assert.ok(!/^\.\.\/engine\//.test(spec), `lobby imports the engine: ${spec}`);
    assert.ok(!/^\.\.\/templates\/(?!registry\.js)/.test(spec),
      `lobby imports a template: ${spec} — presentation facts live in registry.js`);
  }
});
