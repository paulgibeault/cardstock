#!/usr/bin/env node
// Headless rule-test runner. Builds each test's `setup` state directly (no dealing/
// play-through), then runs its `assert` sequence. See schema/rules-test.schema.json.

import { readFile } from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/engine/packLoader.js';
import { createState } from '../src/engine/state.js';
import { validateMove, applyMove, applyAnnouncement, runScoreRound } from '../src/engine/movePipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
export const PACKS_DIR = path.join(REPO_ROOT, 'packs');

/**
 * Every pack id on disk. One source of truth for the CLI and tests/packs.test.js.
 *
 * Directories only — `packs/` also holds index.json, the list the browser
 * lobby fetches because nothing client-side can read a directory. Without the
 * isDirectory filter that file reads as a pack named "index.json" and every
 * caller here tries to load a manifest out of it.
 */
export function listPackIds() {
  return fsSync.readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

/**
 * Exported so a test can render a real deck without a second copy of this.
 *
 * `variants` is the id list to switch on, or undefined for the pack's own
 * defaults — the same contract src/ui/packSource.js hands the browser, so a
 * rule test and a real table are loading the pack the same way.
 */
export async function loadPackFromDisk(packId, variants) {
  const dir = path.join(PACKS_DIR, packId);
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  let deckJson;
  try {
    deckJson = await readJson(path.join(dir, 'deck.json'));
  } catch {
    deckJson = undefined;
  }
  // Cloned, because loadPack patches the manifest it is given and this one is
  // re-read per variant set — a patch leaking into the next load would make a
  // variant test contaminate the plain one after it.
  return loadPack(structuredClone(manifest), { deckJson, variants });
}

function buildStateFromSetup(pack, setup) {
  const state = createState({ pack, seats: setup.seats, seed: `pack-test:${pack.id}` });
  if (setup.turn) {
    state.turn.seat = setup.turn.seat ?? 0;
    state.turn.phase = setup.turn.phase ?? null;
  }
  if (setup.direction) state.direction = setup.direction === 'counterclockwise' ? -1 : 1;
  if (setup.vars) Object.assign(state.vars, setup.vars);
  if (setup.playerVars) {
    for (const [seat, vars] of Object.entries(setup.playerVars)) {
      Object.assign(state.playerVars[Number(seat)], vars);
    }
  }
  if (setup.scores) {
    for (const [seat, val] of Object.entries(setup.scores)) state.scores[Number(seat)] = val;
  }

  const placed = new Set();
  for (const [address, cardIds] of Object.entries(setup.zones || {})) {
    if (!state.zones.has(address)) throw new Error(`setup references unknown zone address: ${address}`);
    const zone = state.zones.get(address);
    zone.cards.push(...cardIds);
    for (const id of cardIds) {
      state.cardLocation.set(id, address);
      placed.add(id);
    }
  }

  const unlistedMode = setup.unlisted ?? 'draw';
  if (unlistedMode === 'draw' && state.zones.has('draw')) {
    const remaining = [...pack.cardsById.keys()].filter((id) => !placed.has(id));
    const drawZone = state.zones.get('draw');
    drawZone.cards.unshift(...remaining);
    for (const id of remaining) state.cardLocation.set(id, 'draw');
  }

  return state;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function checkExpect(state, expected) {
  const problems = [];
  if (expected.zones) {
    for (const [address, want] of Object.entries(expected.zones)) {
      const zone = state.zones.get(address);
      if (typeof want === 'number') {
        if (zone.cards.length !== want) problems.push(`zone ${address}: expected count ${want}, got ${zone.cards.length}`);
      } else if (!deepEqual(zone.cards, want)) {
        problems.push(`zone ${address}: expected [${want.join(',')}], got [${zone.cards.join(',')}]`);
      }
    }
  }
  if (expected.vars) {
    for (const [k, v] of Object.entries(expected.vars)) {
      if (!deepEqual(state.vars[k], v)) problems.push(`var ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(state.vars[k])}`);
    }
  }
  if (expected.playerVars) {
    for (const [seat, vars] of Object.entries(expected.playerVars)) {
      for (const [k, v] of Object.entries(vars)) {
        const got = state.playerVars[Number(seat)]?.[k];
        if (!deepEqual(got, v)) problems.push(`playerVars.${seat}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
      }
    }
  }
  if (expected.turn) {
    if (expected.turn.seat !== undefined && state.turn.seat !== expected.turn.seat) {
      problems.push(`turn.seat: expected ${expected.turn.seat}, got ${state.turn.seat}`);
    }
    if (expected.turn.phase !== undefined && state.turn.phase !== expected.turn.phase) {
      problems.push(`turn.phase: expected ${expected.turn.phase}, got ${state.turn.phase}`);
    }
  }
  if (expected.direction) {
    const want = expected.direction === 'counterclockwise' ? -1 : 1;
    if (state.direction !== want) problems.push(`direction: expected ${expected.direction}, got ${state.direction === 1 ? 'clockwise' : 'counterclockwise'}`);
  }
  if (expected.scores) {
    for (const [seat, v] of Object.entries(expected.scores)) {
      if (state.scores[Number(seat)] !== v) problems.push(`scores.${seat}: expected ${v}, got ${state.scores[Number(seat)]}`);
    }
  }
  if (expected.gameOver !== undefined && state.gameOver !== expected.gameOver) {
    problems.push(`gameOver: expected ${expected.gameOver}, got ${state.gameOver}`);
  }
  if (expected.winner !== undefined && state.winner !== expected.winner) {
    problems.push(`winner: expected ${expected.winner}, got ${state.winner}`);
  }
  return problems;
}

function runAssertion(state, assertion) {
  if (assertion.move) {
    const result = validateMove(state, assertion.move);
    if (result.legal !== assertion.legal) {
      return [`expected legal=${assertion.legal}, got legal=${result.legal}${result.rule ? ` (rule: ${result.rule}, ${result.reason || ''})` : ''}`];
    }
    if (assertion.rule && result.rule !== assertion.rule) {
      return [`expected rule "${assertion.rule}", got "${result.rule}"`];
    }
    return [];
  }
  if (assertion.apply) {
    try {
      applyMove(state, assertion.apply);
      return [];
    } catch (e) {
      return [`apply threw: ${e.message}`];
    }
  }
  if (assertion.announce) {
    try {
      applyAnnouncement(state, assertion.announce);
      return [];
    } catch (e) {
      return [`announce threw: ${e.message}`];
    }
  }
  if (assertion.score) {
    const scores = runScoreRound(state);
    const problems = [];
    for (const [seat, want] of Object.entries(assertion.score)) {
      const got = scores[Number(seat)];
      if (got !== want) problems.push(`score seat ${seat}: expected ${want}, got ${got}`);
    }
    return problems;
  }
  if (assertion.expect) {
    return checkExpect(state, assertion.expect);
  }
  return [`unrecognized assertion: ${JSON.stringify(assertion)}`];
}

// The single runner. `log: null` silences it for programmatic callers
// (tests/packs.test.js) — they read `failures` instead of scraping stdout, so
// the CLI and the CI gate exercise the same code rather than two copies.
export async function runPackTests(packId, { log = console.log } = {}) {
  const say = log || (() => {});
  const testFile = await readJson(path.join(PACKS_DIR, packId, 'tests', 'rules.test.json'));

  // VARIANTS ARE PART OF THE RULE SET, so a test names the one it is about.
  // The schema has documented `variants` at both levels since it was written
  // and nothing here read it — every test ran against the pack's defaults, so
  // a variant test silently asserted the base game's behaviour and passed for
  // the wrong reason. That is how Wildfire's seven-zero swap could be dead in
  // the engine with a green suite.
  //
  // Packs are loaded once per DISTINCT variant set rather than per test: a load
  // expands the whole deck, and most files name no variants at all.
  const packs = new Map();
  const packFor = async (variants) => {
    const key = variants ? [...variants].sort().join(',') : '';
    if (!packs.has(key)) packs.set(key, await loadPackFromDisk(packId, variants));
    return packs.get(key);
  };

  let passed = 0;
  const failures = [];
  for (const test of testFile.tests) {
    const pack = await packFor(test.variants ?? testFile.variants);
    const state = buildStateFromSetup(pack, test.setup);
    const problems = [];
    for (let i = 0; i < test.assert.length; i++) {
      const result = runAssertion(state, test.assert[i]);
      if (result.length) problems.push(`  assert[${i}]: ${result.join('; ')}`);
    }
    if (problems.length === 0) {
      passed++;
      say(`  \x1b[32m✓\x1b[0m ${test.name}`);
    } else {
      failures.push({ name: test.name, problems });
      say(`  \x1b[31m✗\x1b[0m ${test.name}`);
      for (const p of problems) say(`    \x1b[31m${p}\x1b[0m`);
    }
  }
  say(`${packId}: ${passed} passed, ${failures.length} failed\n`);
  return { passed, failed: failures.length, failures };
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const packIds = all ? listPackIds() : args.filter((a) => !a.startsWith('--'));

  if (packIds.length === 0) {
    console.error('Usage: pack-test.mjs <pack-id> [<pack-id>...] | --all');
    process.exit(2);
  }

  let totalFailed = 0;
  for (const packId of packIds) {
    console.log(`\n=== ${packId} ===`);
    try {
      const { failed } = await runPackTests(packId);
      totalFailed += failed;
    } catch (e) {
      console.error(`  \x1b[31mERROR loading/running ${packId}: ${e.stack}\x1b[0m`);
      totalFailed += 1;
    }
  }
  process.exit(totalFailed > 0 ? 1 : 0);
}

// CLI only — importing this module (tests/packs.test.js) must not run the
// suite, and must never reach the process.exit above.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
