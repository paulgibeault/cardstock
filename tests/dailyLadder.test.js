// The daily run's generated ladder, held to the four things a player would
// notice it getting wrong.
//
//   IT IS THE SAME EVERYWHERE   — one date, one ladder, one deal, on any device
//                                 and after any reload. The whole premise of a
//                                 daily is that two people can compare runs.
//   IT IS PLAYABLE              — every rung has a lay-down that EXISTS in the
//                                 deck and that the template's own door accepts.
//                                 A generated `run(11)` on a twelve-rank deck
//                                 with a ten-card deal is a day nobody finishes.
//   IT IS A LADDER              — difficulty never goes down, by the measure
//                                 src/engine/dailyLadder.js writes down.
//   IT IS DIFFERENT TOMORROW    — 365 dates, 365 puzzles, and four distinct
//                                 shapes within any one of them.
//
// The grammar check reads schema/manifest.schema.json rather than restating its
// pattern: the generated ladder has to be something the shipped pack could have
// declared, and a copy of the pattern here would agree with itself forever.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { resolveMeld, itemsMatchContract, parseItem } from "../src/templates/melds.js";
import {
  DAILY_RUNGS, MIN_DISTINCT_SHAPES, dailyLadder, dailyRunFor, dailySeedFor, dateOfDailySeed,
  deckProfile, findDeckLayDown, contractCost, compareContracts, rungSignature,
  isDailyDate, previousDate, applyDailyLadder, isPlayableRung,
} from "../src/engine/dailyLadder.js";

const PACK_ID = "milestones";

function packFromDisk(packId = PACK_ID) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckJson = JSON.parse(fs.readFileSync(path.join(dir, "deck.json"), "utf8"));
  return loadPack(structuredClone(manifest), { deckJson });
}

/** The pattern the pack schema holds `rules.contracts` items to. */
function schemaItemPattern() {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "manifest.schema.json"), "utf8"));
  const pattern = schema.$defs["rules-contract-rummy"].properties.contracts.items.items.pattern;
  assert.ok(pattern, "the schema no longer constrains contract items — this gate is asleep");
  return new RegExp(pattern);
}

/** `n` consecutive YYYY-MM-DD strings starting at `from`. */
function dateRun(from, n) {
  const [y, m, d] = from.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  const p = (x) => (x < 10 ? "0" : "") + x;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}`);
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return out;
}

const pack = packFromDisk();
const profile = deckProfile(pack);
const YEAR = dateRun("2026-01-01", 365);

// The year is swept by seven of the tests below and generating it is the only
// slow thing here. Memoised per date rather than per test — determinism is
// asserted on its own above, so a shared answer is the same answer.
const LADDERS = new Map();
function ladderFor(date) {
  if (!LADDERS.has(date)) LADDERS.set(date, dailyRunFor(pack, date).ladder);
  return LADDERS.get(date);
}

/* ------------------------------------------------------------------ *
 * The same everywhere
 * ------------------------------------------------------------------ */

test("the seed is the pack and the calendar day, and nothing else", () => {
  assert.strictEqual(dailySeedFor("milestones", "2026-09-10"), "milestones|2026-09-10");
  assert.strictEqual(dateOfDailySeed("milestones|2026-09-10"), "2026-09-10");
  assert.strictEqual(dateOfDailySeed("milestones|not-a-date"), null);
  assert.strictEqual(dateOfDailySeed(undefined), null);
  // A Date and its own spelling are the same day.
  assert.strictEqual(dailySeedFor("milestones", new Date(2026, 8, 10)), "milestones|2026-09-10");
  assert.ok(isDailyDate("2026-09-10"));
  assert.ok(!isDailyDate("2026-9-10"));
  assert.ok(!isDailyDate("daily.milestones"));
});

test("a date fixes the whole day — the same ladder, the same seed, every time", () => {
  const a = dailyRunFor(packFromDisk(), "2026-09-10");
  const b = dailyRunFor(packFromDisk(), "2026-09-10");
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.seed, "milestones|2026-09-10");
  // And re-derived from the seed ALONE, which is what a resume has to do: the
  // save carries the seed and nothing about the ladder.
  const rederived = dailyLadder(a.seed, {
    deck: profile, deal: pack.rules.deal, wilds: pack.rules.wilds,
  });
  assert.deepStrictEqual(rederived, a.ladder);
});

test("the day after is a different puzzle", () => {
  const today = dailyRunFor(pack, "2026-09-10");
  const tomorrow = dailyRunFor(pack, "2026-09-11");
  assert.notDeepStrictEqual(today.ladder.contracts, tomorrow.ladder.contracts);
});

test("previousDate walks the calendar, months and leap years included", () => {
  assert.strictEqual(previousDate("2026-09-10"), "2026-09-09");
  assert.strictEqual(previousDate("2026-09-01"), "2026-08-31");
  assert.strictEqual(previousDate("2026-01-01"), "2025-12-31");
  assert.strictEqual(previousDate("2028-03-01"), "2028-02-29");
  assert.strictEqual(previousDate("nonsense"), null);
});

/* ------------------------------------------------------------------ *
 * Playable
 * ------------------------------------------------------------------ */

test("every rung is written in the grammar the pack schema declares", () => {
  const pattern = schemaItemPattern();
  let items = 0;
  for (const date of YEAR) {
    for (const rung of ladderFor(date).contracts) {
      assert.ok(Array.isArray(rung) && rung.length >= 1, `${date}: empty rung`);
      for (const item of rung) {
        assert.match(item, pattern, `${date}: "${item}" is not a contract item`);
        items++;
      }
    }
  }
  assert.ok(items > 3000, `only ${items} items checked — the sweep found nothing`);
});

test("no rung costs the whole deal", () => {
  const deal = pack.rules.deal;
  for (const date of YEAR) {
    for (const rung of ladderFor(date).contracts) {
      const cards = contractCost(rung)[0];
      // Strictly under the deal: laying down `deal` cards from a hand of
      // `deal + 1` and discarding the last one goes out on the same turn.
      assert.ok(cards < deal, `${date}: ${rungSignature(rung)} wants ${cards} of ${deal}`);
      assert.ok(cards >= 2, `${date}: ${rungSignature(rung)} is not a contract`);
    }
  }
});

test("every rung has a lay-down that exists in the deck AND the template accepts", () => {
  // The template's own door, not a restatement of it: `resolveMeld` is what
  // validateMove and applyMove both resolve a lay-down through (see the header
  // of src/templates/melds.js), so a rung that passes here is a rung a player
  // could actually put on the felt.
  const dayPack = packFromDisk();
  const run = dailyRunFor(dayPack, "2026-09-10");
  applyDailyLadder(dayPack, run.ladder);
  const state = createState({ pack: dayPack, seats: 4, seed: run.seed });
  dayPack.template.setup(makeCtx(state));
  const ctx = makeCtx(state);

  let melds = 0;
  for (const rung of run.ladder.contracts) {
    const layDown = findDeckLayDown(deckProfile(dayPack), rung);
    assert.ok(layDown, `${rungSignature(rung)} has no lay-down in the deck`);
    const used = new Set();
    for (const meld of layDown) {
      for (const id of meld.cards) {
        assert.ok(!used.has(id), `${rungSignature(rung)} used ${id} twice`);
        used.add(id);
      }
      const resolved = resolveMeld(ctx, meld.item, meld.cards);
      assert.ok(resolved.ok, `${meld.item}: ${resolved.reason}`);
      melds++;
    }
    assert.ok(itemsMatchContract(layDown.map((m) => m.item), rung),
      `${rungSignature(rung)}: the lay-down does not satisfy its own contract`);
  }
  assert.ok(melds >= DAILY_RUNGS, `only ${melds} melds resolved`);
});

test("a year of rungs all have a lay-down in the deck", () => {
  let rungs = 0;
  for (const date of YEAR) {
    for (const rung of ladderFor(date).contracts) {
      assert.ok(findDeckLayDown(profile, rung), `${date}: ${rungSignature(rung)} is unplayable`);
      rungs++;
    }
  }
  assert.strictEqual(rungs, YEAR.length * DAILY_RUNGS);
});

test("findDeckLayDown refuses what the deck cannot supply", () => {
  // The counterweight to the sweep above: a check that says yes to everything
  // proves nothing. Twelve ranks, eight copies of each, four colours.
  assert.strictEqual(findDeckLayDown(profile, ["run(13)"]), null);
  assert.strictEqual(findDeckLayDown(profile, ["set(9)"]), null);
  assert.strictEqual(findDeckLayDown(profile, ["colorGroup(25)"]), null);
  assert.strictEqual(findDeckLayDown(profile, ["nonsense(3)"]), null);
  assert.ok(findDeckLayDown(profile, ["run(12)"]));
  assert.ok(findDeckLayDown(profile, ["set(8)"]));
  // And the items compete for the same cards rather than each being asked alone.
  assert.ok(findDeckLayDown(profile, ["set(8)", "set(8)"]));
  assert.strictEqual(findDeckLayDown(profile, ["colorGroup(24)", "colorGroup(24)",
    "colorGroup(24)", "colorGroup(24)", "set(2)"]), null);
});

test("no rung pulls two ways at once, and none is a lone set", () => {
  // The second door, and the one the deck cannot answer: `run(6) set(3)` has a
  // lay-down in every deck in the repo and finished 25 hands in 50 at the table
  // (src/engine/dailyLadder.js isPlayableRung carries the measurements). A rung
  // no hand assembles, or no hand can go out on, is a round that never ends.
  assert.ok(!isPlayableRung(["run(6)", "set(3)"]));
  assert.ok(!isPlayableRung(["run(5)", "set(4)"]));
  assert.ok(!isPlayableRung(["run(4)", "set(3)"]));
  // Two small sets still add up to a set appetite.
  assert.ok(!isPlayableRung(["run(5)", "set(2)", "set(2)"]));
  // A set on its own is the least absorbent felt there is — nothing to shed on.
  assert.ok(!isPlayableRung(["set(5)"]));
  assert.ok(!isPlayableRung(["set(6)"]));
  // What survives: a short run beside any set, a long run beside a small one, a
  // long run beside anything that is not a set at all, and two sets together.
  assert.ok(isPlayableRung(["run(3)", "set(6)"]));
  assert.ok(isPlayableRung(["run(7)", "set(2)"]));
  assert.ok(isPlayableRung(["run(5)", "run(4)"]));
  assert.ok(isPlayableRung(["run(5)", "colorGroup(4)"]));
  assert.ok(isPlayableRung(["set(6)", "set(3)"]));
  assert.ok(isPlayableRung(["set(5)", "set(2)"]));
  assert.ok(isPlayableRung(["run(9)"]));
  assert.ok(isPlayableRung(["colorGroup(8)"]));
  // And nonsense, or nothing at all, is not playable either.
  assert.ok(!isPlayableRung(["nonsense(3)"]));
  assert.ok(!isPlayableRung([]));

  let rungs = 0;
  for (const date of YEAR) {
    for (const rung of ladderFor(date).contracts) {
      assert.ok(isPlayableRung(rung), `${date}: ${rungSignature(rung)} is a rung no hand finishes`);
      rungs++;
    }
  }
  assert.strictEqual(rungs, YEAR.length * DAILY_RUNGS);
});

test("the deck profile is the deck the pack actually has", () => {
  assert.deepStrictEqual(profile.limits, { set: 8, run: 12, colorGroup: 24 });
  assert.strictEqual(profile.wilds, 8);
  // Skips are barred from melds (`rules.meldForbidden`) and must not be
  // counted as a rank a run could sit on.
  assert.ok(!profile.byRank.has("skip"));
  assert.ok(!profile.byRank.has("wild"));
});

/* ------------------------------------------------------------------ *
 * A ladder
 * ------------------------------------------------------------------ */

test("contractCost ranks the shapes the way the module documents", () => {
  assert.deepStrictEqual(contractCost(["set(5)", "set(2)"]), [7, 0, 5]);
  assert.deepStrictEqual(contractCost(["run(7)"]), [7, 7, 0]);
  // Same cards; the run is the harder rung, and a rung is never easier than itself.
  assert.ok(compareContracts(["colorGroup(7)"], ["run(7)"]) < 0);
  assert.ok(compareContracts(["run(7)"], ["set(4)", "set(4)"]) < 0);
  assert.strictEqual(compareContracts(["set(3)", "run(4)"], ["run(4)", "set(3)"]), 0);
});

test("difficulty never goes down, on any day of the year", () => {
  let compared = 0;
  for (const date of YEAR) {
    const contracts = ladderFor(date).contracts;
    assert.strictEqual(contracts.length, DAILY_RUNGS, `${date}: wrong rung count`);
    for (let i = 1; i < contracts.length; i++) {
      assert.ok(compareContracts(contracts[i], contracts[i - 1]) >= 0,
        `${date}: rung ${i + 1} (${rungSignature(contracts[i])}) is easier than rung ${i} `
        + `(${rungSignature(contracts[i - 1])})`);
      compared++;
    }
  }
  assert.strictEqual(compared, YEAR.length * (DAILY_RUNGS - 1));
});

/* ------------------------------------------------------------------ *
 * Different tomorrow
 * ------------------------------------------------------------------ */

test("365 consecutive dates produce at least 200 distinct ladders", () => {
  const seen = new Set(YEAR.map((date) =>
    JSON.stringify(ladderFor(date).contracts)));
  assert.ok(seen.size >= 200, `only ${seen.size} distinct ladders in a year`);
});

test("every ladder offers at least four distinct shapes, and no two rungs repeat in a row", () => {
  let worst = Infinity;
  for (const date of YEAR) {
    const signatures = ladderFor(date).contracts.map(rungSignature);
    const distinct = new Set(signatures).size;
    worst = Math.min(worst, distinct);
    assert.ok(distinct >= MIN_DISTINCT_SHAPES, `${date}: only ${distinct} distinct shapes`);
    for (let i = 1; i < signatures.length; i++) {
      assert.notStrictEqual(signatures[i], signatures[i - 1], `${date}: rung ${i + 1} repeats rung ${i}`);
    }
  }
  assert.ok(Number.isFinite(worst), "the sweep checked nothing");
});

test("a year uses all three shapes, and asks for long runs and big sets", () => {
  const kinds = new Set();
  let longRuns = 0;
  let bigSets = 0;
  for (const date of YEAR) {
    for (const rung of ladderFor(date).contracts) {
      for (const item of rung) {
        const { kind, n } = parseItem(item);
        kinds.add(kind);
        if (kind === "run" && n >= 7) longRuns++;
        if (kind === "set" && n >= 5) bigSets++;
      }
    }
  }
  assert.deepStrictEqual([...kinds].sort(), ["colorGroup", "run", "set"]);
  assert.ok(longRuns > 0, "a year with no long run is not an inventive range");
  assert.ok(bigSets > 0, "a year with no big set is not an inventive range");
});

test("the wild rule varies between one and two naturals, and does both", () => {
  const seen = new Set();
  for (const date of YEAR) {
    const { minNaturals, tag } = ladderFor(date).wilds;
    assert.ok(minNaturals === 1 || minNaturals === 2, `${date}: minNaturals ${minNaturals}`);
    // The rest of the pack's wild spec is carried through untouched — the day
    // may raise the naturals bar, it does not get to redefine what a wild is.
    assert.strictEqual(tag, pack.rules.wilds.tag);
    seen.add(minNaturals);
  }
  assert.deepStrictEqual([...seen].sort(), [1, 2]);
});

/* ------------------------------------------------------------------ *
 * Wiring the day onto a pack
 * ------------------------------------------------------------------ */

test("applyDailyLadder moves the rules and the manifest together", () => {
  const dayPack = packFromDisk();
  const before = JSON.stringify(dayPack.rules.contracts);
  const run = dailyRunFor(dayPack, "2026-09-10");
  applyDailyLadder(dayPack, run.ladder);
  assert.notStrictEqual(JSON.stringify(dayPack.rules.contracts), before);
  assert.deepStrictEqual(dayPack.rules.contracts, run.ladder.contracts);
  // `pack.rules` IS `pack.manifest.rules`, which is what keeps the rules panel
  // and the contract strip reading the same ladder as the validator.
  assert.deepStrictEqual(dayPack.manifest.rules.contracts, run.ladder.contracts);
  assert.strictEqual(dayPack.rules.wilds.minNaturals, run.ladder.wilds.minNaturals);
  // And it does not reach the shipped pack every other table is dealt from.
  assert.deepStrictEqual(packFromDisk().rules.contracts, JSON.parse(before));
});

test("dailyLadder needs a deck profile and says so", () => {
  assert.throws(() => dailyLadder("milestones|2026-09-10", { deal: 10 }), /deckProfile/);
});
