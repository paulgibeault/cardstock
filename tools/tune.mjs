#!/usr/bin/env node
// SELF-PLAY TUNING OF A TEMPLATE'S STRATEGY WEIGHTS.
//
// Every number a template's bot is made of was chosen by hand and swept by
// hand — "raised to 0.6 the seat hoards its cheap cards" — against a metric
// somebody picked at the time. This turns that into a loop: take the shipped
// weights, perturb one, seat the candidate against the incumbent in the same
// simulated games, keep it if it wins by more than the sample's noise, move
// on. Coordinate search, nothing cleverer, because the point is not a better
// optimiser; it is that the metric is the one the game is actually decided by
// (`--match` for a pack whose match is a ladder, #92) and that a weight has
// to EARN its change on fresh deals rather than on the ones it was fitted to.
//
// TWO SEED FAMILIES, AND THE SECOND IS THE HONEST ONE. Every candidate is
// searched on the `tune` family, so the search is reproducible and so a
// candidate's games are exactly its incumbent's games with one opinion
// changed. Then the final weights are re-measured against the SHIPPED ones on
// the `validate` family, which the search never saw. A gain that survives that
// is a gain; one that does not was the search fitting the luck of its deals,
// and the tool says so rather than printing the number it would like to.
//
// WHAT IT DOES NOT DO. It does not write anything back: the output is a JSON
// object of the weights that changed and a validation line, and putting them
// into the template is a commit with a reason attached, not a side effect of
// a tool run. It tunes at `medium` by default, which is deterministic and
// cheap; `hard` works under `--budget-moves` and is a great deal slower.
//
//   node tools/tune.mjs milestones --match --games=200
//   node tools/tune.mjs hearts --games=300 --seats=4
//   node tools/tune.mjs wildfire --only=RIVAL_SHARE,EXIT_WORTH --passes=3
//
// Flags: --difficulty=medium|easy|hard  --games=N  --match  --seats=N
//        --passes=N (sweeps over every weight; default 2)
//        --step=F (a candidate is the weight × (1±F); default 0.5)
//        --confidence=Z (standard errors a candidate must win by; default 2)
//        --only=A,B (restrict to these weights)  --budget-moves=N (for hard)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tournamentPack } from './simulate.mjs';
import { loadPackFromDisk } from './pack-test.mjs';
import { DIFFICULTIES } from '../src/engine/bot.js';

function flag(args, name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/**
 * Seat `candidate` against `incumbent` and say whether it won by more than
 * the noise of the sample. The share is candidate's, out of decisive games.
 */
async function trial(packId, games, candidate, incumbent, options) {
  const result = await tournamentPack(packId, games, {
    ...options,
    quiet: true,
    contenders: [
      { name: 'candidate', difficulty: options.difficulty, weights: candidate },
      { name: 'incumbent', difficulty: options.difficulty, weights: incumbent },
    ],
  });
  const share = result.decisive ? result.wins[0] / result.decisive : 0.5;
  const se = result.decisive ? Math.sqrt((share * (1 - share)) / result.decisive) : Infinity;
  return { share, se, decisive: result.decisive, unfinished: result.unfinished };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const args = process.argv.slice(2);
  const packId = args.find((a) => !a.startsWith('--'));
  if (!packId) {
    console.error('Usage: tune.mjs <pack-id> [--difficulty=medium] [--games=N] [--match] [--seats=N]\n'
      + '                 [--passes=N] [--step=F] [--confidence=Z] [--only=A,B] [--budget-moves=N]');
    process.exit(2);
  }
  const difficulty = flag(args, 'difficulty', 'medium');
  if (!DIFFICULTIES.includes(difficulty)) {
    console.error(`Unknown difficulty "${difficulty}" — one of ${DIFFICULTIES.join(', ')}`);
    process.exit(2);
  }
  const games = Number(flag(args, 'games', 200));
  const passes = Number(flag(args, 'passes', 2));
  const step = Number(flag(args, 'step', 0.5));
  const confidence = Number(flag(args, 'confidence', 2));
  const seatsFlag = flag(args, 'seats', undefined);
  const budgetFlag = flag(args, 'budget-moves', undefined);
  const only = flag(args, 'only', '').split(',').filter(Boolean);
  const options = {
    difficulty,
    match: args.includes('--match'),
    seats: seatsFlag === undefined ? undefined : Number(seatsFlag),
    // Hard has to be reproducible for a candidate's games to be its
    // incumbent's games; the move cap is what makes it so (simulate.mjs).
    budgetMoves: budgetFlag === undefined ? (difficulty === 'hard' ? 4000 : undefined) : Number(budgetFlag),
  };

  const pack = await loadPackFromDisk(packId);
  const shipped = pack.template.weights;
  if (!shipped) {
    console.error(`${packId}'s template (${pack.template.id}) declares no weights — nothing to tune`);
    process.exit(2);
  }
  const keys = only.length ? only : Object.keys(shipped);
  for (const key of keys) {
    if (!(key in shipped)) {
      console.error(`${pack.template.id} has no weight "${key}" — one of ${Object.keys(shipped).join(', ')}`);
      process.exit(2);
    }
  }

  console.log(`=== tuning ${packId} (${pack.template.id}) at ${difficulty}: ${games} ${options.match ? 'matches' : 'rounds'} `
    + `per trial, ${passes} pass${passes === 1 ? '' : 'es'}, step ±${step}, accept at ${confidence} SE ===`);

  let best = { ...shipped };
  let accepted = 0;
  for (let pass = 1; pass <= passes; pass++) {
    console.log(`\n--- pass ${pass} ---`);
    const before = accepted;
    for (const key of keys) {
      const current = best[key];
      // Zero cannot be scaled, so it is nudged by the step itself.
      const tries = current === 0 ? [step, -step] : [current * (1 + step), current * (1 - step)];
      for (const value of tries) {
        const candidate = { ...best, [key]: value };
        const t = await trial(packId, games, candidate, best, { ...options, seedPrefix: 'tune' });
        const wins = t.share - 0.5 > confidence * t.se;
        console.log(`  ${key.padEnd(20)} ${String(current).padStart(6)} -> ${String(Number(value.toFixed(4))).padStart(8)}`
          + `   ${pct(t.share).padStart(6)} ± ${pct(t.se)} of ${t.decisive}`
          + `${t.unfinished ? `  (${t.unfinished} unfinished)` : ''}${wins ? '   ACCEPTED' : ''}`);
        if (wins) { best = candidate; accepted++; break; }
      }
    }
    // Every trial is seeded, so a pass that accepted nothing would be replayed
    // move for move by the next one. Stop while it still means something.
    if (accepted === before) {
      if (pass < passes) console.log('  (nothing accepted this pass — later passes would repeat it exactly)');
      break;
    }
  }

  const changed = Object.fromEntries(Object.entries(best).filter(([k, v]) => v !== shipped[k]));
  console.log(`\n=== ${accepted} change${accepted === 1 ? '' : 's'} accepted ===`);
  if (!Object.keys(changed).length) {
    console.log('The shipped weights held against every candidate. Nothing to validate.');
    return;
  }
  console.log(JSON.stringify(changed, null, 2));

  // Fresh deals the search never saw, twice the sample: this is the number.
  const v = await trial(packId, games * 2, best, shipped, { ...options, seedPrefix: 'validate' });
  const held = v.share - 0.5 > confidence * v.se;
  console.log(`\n=== validation on unseen deals: tuned ${pct(v.share)} ± ${pct(v.se)} of ${v.decisive} against shipped ===`);
  console.log(held
    ? 'The gain holds on deals the search never saw.'
    : 'The gain does NOT hold on unseen deals: the search fitted the luck of its own. Do not ship these.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
