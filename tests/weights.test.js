// THE WEIGHTS ARE A PARAMETER, NOT A MOOD.
//
// A template's strategy numbers reach its hooks through `w` (CONTRACT.md,
// `weights`), so that two seats in one simulated game can hold two different
// opinions — the whole basis of tools/tune.mjs. Three things have to be true
// for that to mean anything, and each is the kind that silently stops being
// true when somebody adds a constant and reads it directly:
//
//   1. THE DEFAULT IS THE TEMPLATE. Passing `template.weights` explicitly
//      ranks exactly as passing nothing does.
//   2. EVERY WEIGHT IS READ THROUGH `w`. A weight the hooks ignore is a knob
//      the tuner turns to no effect, so each one, perturbed hard, has to change
//      some decision somewhere — or it does not belong in the object.
//   3. NOTHING LEAKS BETWEEN SEATS. A seat ranked with the shipped weights
//      gets the same answer whether or not another seat was just ranked with
//      strange ones. Module-level "current weights" state would fail this.
//   4. EVERY `w.KEY` A HOOK READS IS IN THE BAG. Rules 1-3 only ever look at
//      what is IN `template.weights`; a key that vanished from it is invisible
//      to them, and the read quietly becomes `undefined` arithmetic (#252).
import { test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { getTemplate } from "../src/templates/index.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove, rankMoves } from "../src/engine/bot.js";
import { createRng } from "../src/engine/rng.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { actingSeats } from "./fixtures/engine.js";

// One table per template, plus a second for trick-taking — because that
// template now houses two games with different currencies, and a weight only
// speaks at a pack whose RULES reach the code that reads it. Hearts takes no
// bid, so its ranking cannot possibly move when a contract weight is perturbed;
// Team Spades is where those live (#105).
const TABLES = [["milestones", 3], ["hearts", 4], ["wildfire", 3], ["team-spades", 4], ["thirteen", 4], ["pinochle", 4],
  // Stockpile joined the list when sequencing grew an evaluator and a weights
  // bag of its own (#160). Its table is the one where the rival term is a fact
  // rather than an inference — every seat's stock top is face up — so a weight
  // that reads the opposition has somewhere to be exercised.
  ["stockpile", 4],
  // Cribbage was missing from this list for its whole life (#206), so its six
  // weights had never been through any of the three rules below. Two seats is
  // not a choice — the pack is `min: 2, max: 2` — and it is the seat count the
  // template's crib arithmetic is written for.
  ["cribbage", 2]];

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/** Walk a bot-vs-bot game, calling `visit(state, seat)` before each move. */
function walk(state, limit, visit) {
  for (let i = 0; i < limit && !state.gameOver; i++) {
    const acting = actingSeats(state);
    let move = null;
    let actor = null;
    for (const seat of acting) {
      move = chooseBotMove(state, seat);
      if (move) { actor = seat; break; }
    }
    if (!move) return;
    visit(state, actor);
    applyMove(state, move);
  }
}

const ranking = (state, seat, opts) => JSON.stringify(rankMoves(state, seat, opts).map((r) => [r.move, r.score]));

test("passing the template's own weights ranks exactly as passing none", async () => {
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `weights:default:${packId}`);
    const weights = state.pack.template.weights;
    assert.ok(weights, `${packId}: no weights to test`);
    let checked = 0;
    walk(state, 120, (live, seat) => {
      for (const difficulty of ["easy", "medium"]) {
        assert.strictEqual(ranking(live, seat, { difficulty, weights }), ranking(live, seat, { difficulty }),
          `${packId} at ${difficulty}: the template's own weights ranked differently from the default`);
      }
      // `hard` samples, so it is compared under a seeded, move-capped budget.
      const hard = (extra) => ranking(live, seat, {
        difficulty: "hard", random: createRng("w").next, budgetMs: Infinity, budgetMoves: 600, ...extra,
      });
      assert.strictEqual(hard({ weights }), hard({}), `${packId} at hard: weights changed the sampling`);
      checked++;
    });
    assert.ok(checked > 30, `${packId}: only ${checked} positions checked`);
  }
});

/**
 * A contract-rummy table with every kind of contract on it at once.
 *
 * A walk from a fresh deal spends its first fifty moves on round one, which is
 * two sets, and never reaches the colour group at rung eight — so a weight
 * that only speaks under a colour-group contract looks unread. Rungs are
 * per-seat state, so three seats can owe a colour group, a run and two sets
 * in the same hand, and then every term has a seat that exercises it.
 */
function spreadContracts(state) {
  if (!state.pack.rules.contracts) return;
  const ctx = makeCtx(state);
  const rungs = [8, 4, 1];
  for (let s = 0; s < state.seats; s++) ctx.setPlayerVar(s, "phase", rungs[s % rungs.length]);
}

/**
 * ASKED PER TEMPLATE, ACROSS EVERY TABLE THAT USES IT — which is a weaker claim
 * than the per-pack one this started as, and the only true one.
 *
 * The per-pack version was right while every template had one shape of game
 * under it. Trick-taking now has two: Hearts, which is scored in the points its
 * cards charge, and Team Spades, which is scored on a promise and reads a
 * different half of the same hooks (#105). A contract weight perturbed at a
 * Hearts table cannot move anything, because Hearts never bids — and asserting
 * that it does would only ever be satisfied by deleting the weight or by faking
 * a bid in a pack that has none.
 *
 * What is still asserted, and is the thing worth asserting: a weight in the
 * frozen bag must change SOME decision at SOME table. A knob no shipped pack
 * can turn is still a lie to the tuner.
 */
test("every weight a template declares is one its hooks actually read", async () => {
  const probes = new Map();   // `${templateId}.${key}` -> { moved, packs }
  for (const [packId, seats] of TABLES) {
    const template = (await dealt(packId, seats, "probe")).pack.template;
    for (const key of Object.keys(template.weights)) {
      const id = `${template.id}.${key}`;
      const probe = probes.get(id) || { moved: false, packs: [] };
      probes.set(id, probe);
      // Proven at an earlier table: nothing to learn from proving it twice, and
      // the probe is the expensive half of this file.
      if (probe.moved) continue;
      probe.packs.push(packId);
      // Perturbed hard, in both directions, because a single direction can
      // land on a value the position happens to be indifferent to.
      for (const factor of [0, 8]) {
        const weights = { ...template.weights, [key]: template.weights[key] * factor + (factor === 0 ? -5 : 0) };
        const state = await dealt(packId, seats, `weights:read:${packId}:${key}`);
        spreadContracts(state);
        // FOUR HUNDRED MOVES, NOT TWO. A weight that only speaks in a position
        // the walk has to reach is hostage to the deal, and this one is: fixing
        // Thirteen's deal to honour `state.direction` (#156) re-dealt the seeded
        // game, and the first position offering `climbing.CHOP_COST` an
        // out-of-shape bomb moved from inside 200 moves to step 229. The weight
        // is read; the walk was short. The probe stops the moment a weight
        // moves, so the longer budget is only ever spent on the ones that have
        // not been proven yet.
        walk(state, 400, (live, seat) => {
          if (probe.moved) return;
          for (const difficulty of ["easy", "medium"]) {
            if (ranking(live, seat, { difficulty, weights }) !== ranking(live, seat, { difficulty })) probe.moved = true;
          }
        });
        if (probe.moved) break;
      }
    }
  }
  for (const [id, probe] of probes) {
    assert.ok(probe.moved,
      `weights.${id} was perturbed at ${probe.packs.join(", ")} and no ranking changed — `
      + "the hooks do not read it at any table that exercises them");
  }
});

test("one seat's weights do not leak into the next seat's ranking", async () => {
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `weights:leak:${packId}`);
    const template = state.pack.template;
    const strange = Object.fromEntries(Object.keys(template.weights).map((k) => [k, -template.weights[k] * 3 - 1]));
    walk(state, 120, (live, seat) => {
      const before = ranking(live, seat, { difficulty: "medium" });
      const other = (seat + 1) % live.seats;
      rankMoves(live, other, { difficulty: "medium", weights: strange });
      rankMoves(live, seat, { difficulty: "medium", weights: strange });
      assert.strictEqual(ranking(live, seat, { difficulty: "medium" }), before,
        `${packId}: ranking seat ${seat} with strange weights changed its ranking with the shipped ones`);
    });
  }
});

/**
 * WHICH BAG A FILE'S `w` IS. A template's hooks live in more than one file —
 * trick-taking's phases each bring a share that the core merges onto ONE frozen
 * bag (#224), and climbing and contract-rummy keep their strategy in a `-bot`
 * module — so every `w.KEY` is resolved against the bag the TEMPLATE ships, the
 * one the tuner hands back in, not against whatever the file itself declares.
 *
 * A file absent from this map may not read `w.KEY` at all: a new module that
 * starts reading weights has to say whose they are.
 */
const BAG_OF_FILE = {
  "src/templates/trick-taking.js": "trick-taking",
  "src/templates/trick-pass.js": "trick-taking",
  "src/templates/trick-auction.js": "trick-taking",
  "src/templates/trick-meld.js": "trick-taking",
  "src/templates/climbing.js": "climbing",
  "src/templates/climbing-bot.js": "climbing",
  "src/templates/contract-rummy.js": "contract-rummy",
  "src/templates/contract-rummy-bot.js": "contract-rummy",
  "src/templates/cribbage.js": "cribbage",
  "src/templates/sequencing.js": "sequencing",
  "src/templates/shedding.js": "shedding",
};

// The files that read weights today. An empty scan of one of these means the
// regex went blind, not that the file is clean.
const READS_EXPECTED = [
  "src/templates/trick-taking.js", "src/templates/trick-pass.js", "src/templates/trick-auction.js",
  "src/templates/climbing-bot.js", "src/templates/contract-rummy-bot.js",
  "src/templates/cribbage.js", "src/templates/sequencing.js", "src/templates/shedding.js",
];

/** Comments blanked, newlines kept, so a match's offset still names its line. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
  .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

// `w` is the weights parameter in every file below. Local `w`s that are not
// (climbing's `(w) => w.length` windows, melds.js's `w.rank`) read lower-case
// members, which the upper-case KEY pattern cannot match.
const WEIGHT_READ = /\bw\.([A-Z][A-Z0-9_]*)\b/g;

test("every w.KEY a template reads is a key in that template's weights bag", () => {
  const files = execSync("git ls-files src/templates", { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f.endsWith(".js"));
  const missing = [];
  const readsIn = new Map();
  for (const file of files) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
    for (const m of code.matchAll(WEIGHT_READ)) {
      const line = code.slice(0, m.index).split("\n").length;
      readsIn.set(file, (readsIn.get(file) || 0) + 1);
      const templateId = BAG_OF_FILE[file];
      if (!templateId) {
        missing.push(`${file}:${line} reads w.${m[1]}, but the file is not in BAG_OF_FILE — say whose weights it reads`);
        continue;
      }
      if (!Object.hasOwn(getTemplate(templateId).weights, m[1])) {
        missing.push(`${file}:${line} reads w.${m[1]}, which is not in the ${templateId} weights bag`);
      }
    }
  }
  for (const file of READS_EXPECTED) {
    assert.ok(readsIn.get(file) > 0, `${file}: the scan found no w.KEY reads — the pattern has gone blind`);
  }
  assert.deepStrictEqual(missing, [], `weights read but not in the bag:\n  ${missing.join("\n  ")}`);
});
