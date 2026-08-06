#!/usr/bin/env node
// Headless bot-vs-bot simulation (design doc §11). Catches rule deadlocks ("draw pile
// empty and nobody can move"), infinite loops, and scoring bugs before a human plays.
//
// Scope: each simulated instance plays until the current ROUND ends (isRoundOver), not
// a full multi-round match. For shedding/sequencing a round IS the whole game. For
// trick-taking/contract-rummy, a full match (score threshold / all ten Milestones
// contracts) is a separate, much harder question of bot skill, not rule-engine
// correctness — round completion is what actually exercises "does every zone
// transition, reaction and turn-advance terminate cleanly", which is what this bar is
// for.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/engine/packLoader.js';
import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { applyMove } from '../src/engine/movePipeline.js';
import { chooseBotMove } from '../src/engine/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PACKS_DIR = path.join(REPO_ROOT, 'packs');
const MAX_MOVES = 4000;
// contract-rummy rounds are throttled by hitting opportunities (a laid-down seat's
// hand only shrinks via a lucky rank/color match onto an existing meld — plain
// draw/discard nets to zero) and can legitimately run long even with correct rules;
// this is bot-strategy quality, not a rules deadlock, so it gets a longer leash
// rather than a tighter one. See tools/README or the simulate output notes.
const MAX_MOVES_BY_TEMPLATE = { 'contract-rummy': 12000 };

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

/**
 * `variants` is the id list to switch on, or undefined for the pack's own
 * defaults — the same contract tools/pack-test.mjs and src/ui/packSource.js use.
 *
 * VARIANTS WERE NEVER SIMULATED. A house rule is a rule change: `seven-zero`
 * moves whole hands between seats, `draw-until-playable` can drain the pile in
 * one turn, and `no-passing` deletes a phase. Every one of those is exactly the
 * shape of thing this tool exists to find a deadlock in, and none of them had
 * ever been run through it.
 */
async function loadPackFromDisk(packId, variants) {
  const dir = path.join(PACKS_DIR, packId);
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  let deckJson;
  try {
    deckJson = await readJson(path.join(dir, 'deck.json'));
  } catch {
    deckJson = undefined;
  }
  // Cloned: loadPack patches the manifest it is given, and this one is re-read
  // per variant set.
  return loadPack(structuredClone(manifest), { deckJson, variants });
}

// Which seats may currently act. Defaults to just the nominal turn.seat; a template
// may override this for simultaneous-commit phases (design doc §4) where turn.seat
// doesn't advance until every seat has committed — Hearts' passing phase, notably.
function actingSeats(ctx) {
  const template = ctx.pack.template;
  return template.actingSeats ? template.actingSeats(ctx) : [ctx.turn.seat];
}

function playOne(pack, seats, seed) {
  const state = createState({ pack, seats, seed });
  const ctx = makeCtx(state);
  pack.template.setup(ctx);
  const maxMoves = MAX_MOVES_BY_TEMPLATE[pack.template.id] ?? MAX_MOVES;

  let moves = 0;
  let roundDone = false;
  const effectCounts = {};
  while (!state.gameOver && !roundDone && moves < maxMoves) {
    let move = null;
    let actingSeat = null;
    for (const seat of actingSeats(makeCtx(state))) {
      move = chooseBotMove(state, seat);
      if (move) {
        actingSeat = seat;
        break;
      }
    }
    if (!move) return { outcome: 'stall', moves, reason: `no legal move for seat ${actingSeat ?? state.turn.seat}, phase ${state.turn.phase}` };
    effectCounts[move.type] = (effectCounts[move.type] || 0) + 1;
    try {
      applyMove(state, move);
    } catch (e) {
      return { outcome: 'error', moves, reason: e.message };
    }
    // The pipeline advances rounds itself now (a finished hand is scored and the
    // next one dealt inside applyMove), so "did a round complete" is read from
    // the event window rather than isRoundOver — which is already false again
    // by the time the redeal has happened.
    if (state.events.some((e) => e.type === 'roundOver')) roundDone = true;
    moves++;
  }
  if (moves >= maxMoves) return { outcome: 'stall', moves, reason: 'move cap exceeded (live-lock, or just very slow bot convergence)' };
  return { outcome: 'complete', moves, effectCounts };
}

async function simulatePack(packId, games, { seats, variants } = {}) {
  const pack = await loadPackFromDisk(packId, variants);
  const seatCount = seats ?? pack.manifest.players.best ?? pack.manifest.players.min;
  let completed = 0;
  let stalled = 0;
  let errored = 0;
  let totalMoves = 0;
  const stallReasons = new Map();

  for (let i = 0; i < games; i++) {
    const result = playOne(pack, seatCount, `sim:${packId}:${i}`);
    totalMoves += result.moves;
    if (result.outcome === 'complete') completed++;
    else {
      if (result.outcome === 'stall') stalled++;
      else errored++;
      stallReasons.set(result.reason, (stallReasons.get(result.reason) || 0) + 1);
    }
  }

  const label = variants?.length ? `${packId} + ${variants.join(', ')}` : packId;
  console.log(`\n=== ${label} (${seatCount} seats, ${games} games) ===`);
  console.log(`  completed: ${completed}  stalled: ${stalled}  errored: ${errored}`);
  console.log(`  avg moves/game: ${(totalMoves / games).toFixed(1)}`);
  if (stallReasons.size) {
    console.log('  stall/error reasons:');
    for (const [reason, count] of stallReasons) console.log(`    (${count}x) ${reason}`);
  }
  return { completed, stalled, errored };
}

/** Every variant a pack OFFERS, one at a time. `available: false` ones are skipped. */
async function availableVariantIds(packId) {
  const manifest = await readJson(path.join(PACKS_DIR, packId, 'manifest.json'));
  return (manifest.variants || []).filter((v) => v.available !== false).map((v) => v.id);
}

export { simulatePack, availableVariantIds };

async function main() {
  const args = process.argv.slice(2);
  const gamesArg = args.find((a) => a.startsWith('--games='));
  const games = gamesArg ? Number(gamesArg.split('=')[1]) : 1000;
  const all = args.includes('--all');
  const variantsArg = args.find((a) => a === '--variants' || a.startsWith('--variants='));
  // `--variants=a,b` runs one named set; `--variants` alone runs each of the
  // pack's available house rules on its own, which is the sweep CI wants.
  const variantSets = variantsArg === undefined ? null
    : (variantsArg === '--variants' ? 'each' : [variantsArg.split('=')[1].split(',').filter(Boolean)]);
  // Directories only — packs/ also holds index.json (see pack-test.mjs's
  // listPackIds, which dodges the same trap).
  const packIds = all
    ? (await readdir(PACKS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
    : args.filter((a) => !a.startsWith('--'));

  if (packIds.length === 0) {
    console.error('Usage: simulate.mjs <pack-id> [<pack-id>...] | --all [--games=N]');
    process.exit(2);
  }

  let anyBad = false;
  for (const packId of packIds) {
    try {
      const sets = variantSets === 'each'
        ? [undefined, ...(await availableVariantIds(packId)).map((id) => [id])]
        : (variantSets ?? [undefined]);
      for (const variants of sets) {
        const { stalled, errored } = await simulatePack(packId, games, { variants });
        if (stalled > 0 || errored > 0) anyBad = true;
      }
    } catch (e) {
      console.error(`\n=== ${packId} ===\n  ERROR: ${e.stack}`);
      anyBad = true;
    }
  }
  process.exit(anyBad ? 1 : 0);
}

// CLI only — importing this module (the CI gate in tests/) must not run the
// suite, and must never reach the process.exit above.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
