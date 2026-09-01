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
import { chooseBotMove, DIFFICULTIES } from '../src/engine/bot.js';
import { createRng } from '../src/engine/rng.js';
import { createSeatTable } from '../src/players/seats.js';
import { createTableHost } from '../src/match/host.js';
import { createTableClient } from '../src/match/client.js';
import { cardIdsIn } from '../src/engine/view.js';
import { createPeerNetwork } from './peer-stub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PACKS_DIR = path.join(REPO_ROOT, 'packs');
// ONE CAP FOR EVERY TEMPLATE AGAIN. contract-rummy used to hold a 12,000-move
// exemption here, justified as "rounds throttled by hitting opportunities, slow
// but legitimate convergence". That was a misreading of the symptom: the bot
// took the face-up discard unconditionally, so the deck was never turned and
// the round could not converge at all. With that fixed
// (src/templates/contract-rummy-bot.js) the worst Milestones round out of five
// thousand — every seat count from two to six — finishes in 147 moves, and the
// longest anything else runs is Stockpile's genuinely stuck hands. A cap that
// generous stops being a deadlock detector and becomes a place for the next
// live-lock to hide.
const MAX_MOVES = 4000;

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

/**
 * `choose` is the move policy, so the same loop measures the same games at any
 * difficulty. The default is the plain deterministic chooser — every existing
 * completion bar in this file and in tests/simulate.test.js is a claim about
 * THAT bot, and a harness that quietly simulated a different one would retire
 * those bars without saying so.
 */
function playOne(pack, seats, seed, { choose = chooseBotMove } = {}) {
  const state = createState({ pack, seats, seed });
  const ctx = makeCtx(state);
  pack.template.setup(ctx);

  let moves = 0;
  let roundDone = false;
  let roundScores = null;
  const effectCounts = {};
  while (!state.gameOver && !roundDone && moves < MAX_MOVES) {
    let move = null;
    let actingSeat = null;
    for (const seat of actingSeats(makeCtx(state))) {
      move = choose(state, seat);
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
    const over = state.events.find((e) => e.type === 'roundOver');
    if (over) {
      roundDone = true;
      roundScores = over.scores;
    }
    moves++;
  }
  if (moves >= MAX_MOVES) return { outcome: 'stall', moves, reason: 'move cap exceeded (live-lock, or just very slow bot convergence)' };
  return { outcome: 'complete', moves, effectCounts, roundScores };
}

async function simulatePack(packId, games, { seats, variants, difficulty = null } = {}) {
  const pack = await loadPackFromDisk(packId, variants);
  const seatCount = seats ?? pack.manifest.players.best ?? pack.manifest.players.min;
  let completed = 0;
  let stalled = 0;
  let errored = 0;
  let totalMoves = 0;
  const stallReasons = new Map();

  for (let i = 0; i < games; i++) {
    // Seeded per game so a `--difficulty` run is as reproducible as the default
    // one; `chooseBotMove` only consults it at `hard`.
    const rng = createRng(`bot:${packId}:${i}`);
    const result = playOne(pack, seatCount, `sim:${packId}:${i}`, difficulty ? {
      choose: (state, seat) => chooseBotMove(state, seat, { difficulty, random: rng.next }),
    } : undefined);
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

/* ------------------------------------------------------------------ *
 * TOURNAMENT MODE — is the harder bot actually harder?
 *
 * A difficulty dial that nobody measured would be a preference, not a feature.
 * This seats one difficulty against another at the smallest table the pack
 * allows and counts who wins the hand — the whole acceptance bar for Phase 3,
 * run from the same loop that plays every other simulated game here.
 *
 * TWO THINGS ARE HELD FIXED SO THE NUMBER MEANS SOMETHING:
 *
 *   * THE SEATS ALTERNATE. Dealing order is an advantage in every one of these
 *     packs — the first seat plays first — so a fixed assignment measures the
 *     seat as much as the bot. The contenders swap chairs on every other game.
 *   * THE BUDGET IS THE SHIPPED ONE. `hard` is capped by wall clock on a real
 *     table (src/engine/bot.js), so that is what gets measured — a tournament
 *     run with the clock lifted would report a bot nobody will ever play
 *     against. The price is that the result is a measurement on THIS machine
 *     rather than a bit-reproducible number; the reproducible cap exists and is
 *     what the fairness gate uses, but strength is not a thing to assert in CI.
 *     Every other input is seeded, so a rerun on the same hardware repeats.
 *
 * WHO WON THE HAND is read the same way the rollout's own terminal value reads
 * it: the manifest declares whether points are the goal or the penalty, and a
 * hand where the contenders tie is counted as a tie rather than assigned.
 * ------------------------------------------------------------------ */

/**
 * Who won the hand, from the manifest's own declaration of which way is up.
 *
 * A SECOND, INDEPENDENT READING of the same manifest field the rollout's
 * terminal value uses — deliberately its own copy, for the reason `entitledTo`
 * below keeps one: a scoreboard that imports the thing it is scoring agrees
 * with it by construction, including when both are wrong.
 */
function roundWinners(pack, scores, seatCount) {
  if (!scores) return [];
  const sign = pack.scoring?.gameOver?.winner === 'highestScore' ? 1 : -1;
  let best = -Infinity;
  let winners = [];
  for (let seat = 0; seat < seatCount; seat++) {
    const value = sign * (Number(scores[seat] ?? 0) || 0);
    if (value > best) {
      best = value;
      winners = [seat];
    } else if (value === best) {
      winners.push(seat);
    }
  }
  return winners;
}

/**
 * `budgetMoves` lifts the wall clock off the sampler and caps it by simulated
 * moves instead — `--budget-moves=N` on the command line.
 *
 * WHICH BUDGET YOU MEASURE UNDER IS ITSELF A MEASUREMENT DECISION, and the two
 * answer different questions. The shipped clock answers "is the bot the player
 * will actually meet any good", and it is the honest headline; it is also
 * hostage to whatever else the machine was doing, so a 3%-wide difference
 * between two builds cannot be attributed to the code. The move cap answers "is
 * this change an improvement", because two runs under it sample identically on
 * a busy laptop and an idle one. Both get reported; neither is allowed to stand
 * in for the other.
 */
async function tournamentPack(packId, games,
  { seats, variants, contenders, budgetMoves, depth, confidence } = {}) {
  const pack = await loadPackFromDisk(packId, variants);
  const seatCount = seats ?? Math.max(contenders.length, pack.manifest.players.min ?? 2);
  const wins = contenders.map(() => 0);
  const held = contenders.map(() => 0);
  let ties = 0;
  let unfinished = 0;
  const budget = budgetMoves ? { budgetMs: Infinity, budgetMoves } : {};
  if (depth !== undefined) budget.depth = depth;
  if (confidence !== undefined) budget.confidence = confidence;

  for (let i = 0; i < games; i++) {
    // Seeded per game, so the whole tournament replays move for move.
    const rng = createRng(`tour:${packId}:${i}`);
    const difficultyOf = (seat) => contenders[(seat + i) % contenders.length];
    const result = playOne(pack, seatCount, `sim:${packId}:${i}`, {
      choose: (state, seat) => chooseBotMove(state, seat, {
        difficulty: difficultyOf(seat), random: rng.next, ...budget,
      }),
    });
    if (result.outcome !== 'complete') { unfinished++; continue; }
    for (let seat = 0; seat < seatCount; seat++) {
      held[contenders.indexOf(difficultyOf(seat))] += Number(result.roundScores?.[seat] ?? 0) || 0;
    }
    const winners = roundWinners(pack, result.roundScores, seatCount);
    const won = new Set(winners.map(difficultyOf));
    if (won.size !== 1) { ties++; continue; }
    wins[contenders.indexOf([...won][0])] += 1;
  }

  const decisive = wins.reduce((a, b) => a + b, 0);
  const played = games - unfinished;
  console.log(`\n=== ${packId}: ${contenders.join(' vs ')} (${seatCount} seats, ${games} rounds`
    + `${budgetMoves ? `, budgetMoves=${budgetMoves}` : ', shipped clock'}`
    + `${depth === undefined ? '' : `, depth=${depth}`}`
    + `${confidence === undefined ? '' : `, confidence=${confidence}`}) ===`);
  contenders.forEach((name, i) => {
    const share = decisive ? ((wins[i] / decisive) * 100).toFixed(1) : '—';
    // Mean round score is a DIAGNOSTIC, never the bar. Winning the hand is what
    // the acceptance criterion counts, and it is what the line above reports;
    // the average is here only because it moves on far fewer rounds than a
    // win rate does, which is what tells you whether a change did nothing or
    // did something the win column has not resolved yet.
    const mean = played ? (held[i] / (played * (seatCount / contenders.length))).toFixed(2) : '—';
    console.log(`  ${name.padEnd(7)} ${String(wins[i]).padStart(4)} wins   ${share}% of decisive rounds`
      + `   (mean round score ${mean})`);
  });
  console.log(`  ties: ${ties}   unfinished: ${unfinished}`);
  return { wins, ties, unfinished, contenders };
}

/* ------------------------------------------------------------------ *
 * PROTOCOL MODE — the same games, played through the wire
 * ------------------------------------------------------------------ */

// THE SAME HANDS, DEALT THE SAME WAY, PLAYED THROUGH THE FULL PROTOCOL.
//
// Above, one process holds the state and calls applyMove. Here the state sits
// on a host and every seat but the first is a separate device that can only
// ASK — `propose` over tools/peer-stub.mjs, answered with a per-seat view or a
// reject. Same seeds, same bot, same completion bars; the only thing added is
// four hundred round trips per hand and every chance to get one of them wrong.
//
// WHY THE CLIENTS ARE SCRIPTED RATHER THAN AUTONOMOUS. A client cannot run the
// bot: `chooseBotMove` reads the whole state and a client has a view. So the
// DRIVER — which does hold the state — picks each move exactly as the solo
// simulation would and hands it to the client to propose. That is the point of
// keeping the bars unchanged: move selection is bit-identical to the run above,
// so any divergence in the completion rate is the protocol's, not the bot's.
//
// WHAT THIS CATCHES THAT THE SOLO RUN CANNOT:
//   * a move the host's own rules accept but the wire validator mangles — the
//     `base#N` card ids and `hand.N` addresses that four packs could not send
//     at all until the charset was widened;
//   * a legal move MISSING from the list the host ships with the view (D3), so
//     a joiner would have had no way to make it;
//   * a client whose view disagrees with the host about cards it can see;
//   * a hidden card reaching a device on the wire.
//
// Every one of those is a silent wrong answer in the solo run.

/** How long every published move is audited for every client, then how often. */
const AUDIT_EVERY_MOVE_UNTIL = 200;
const AUDIT_SAMPLE = 25;

/** What `seat` is genuinely entitled to see, computed from the STATE. */
function entitledTo(state, seat) {
  const ok = new Set();
  for (const address of state.zones.allAddresses()) {
    const instance = state.zones.get(address);
    const def = instance.def;
    if (def.visibility === 'all' || (def.visibility === 'owner' && instance.seat === seat)) {
      for (const id of instance.cards) ok.add(id);
    } else if (def.visibility === 'top' && instance.cards.length) {
      ok.add(instance.cards[instance.cards.length - 1]);
    }
  }
  return ok;
}

/** Every card in another seat's hand — the ids whose leak matters most. */
function foreignHands(state, seat) {
  const out = new Set();
  for (const address of state.zones.allAddresses()) {
    const instance = state.zones.get(address);
    if (instance.def.visibility === 'owner' && instance.seat !== seat) {
      for (const id of instance.cards) out.add(id);
    }
  }
  return out;
}

/**
 * Is this string one of the pack's card ids, unambiguously?
 *
 * Wildfire gives `wild-draw4` to both a card and a rank, and the active rank is
 * public — so a sweep that flagged the bare string would be reporting a leak
 * that is not one. The duplicate copies (`#2`…) stay unambiguous and are still
 * caught, and the per-zone structural check below covers the rest. Same
 * reasoning, and the same caveat, as tests/view.test.js.
 */
function cardIdChecker(state) {
  const ids = new Set(state.zones.allAddresses().flatMap((a) => state.zones.cards(a)));
  const attributes = new Set();
  for (const card of state.pack.cardsById.values()) {
    for (const [key, value] of Object.entries(card)) {
      if (key === 'id') continue;
      if (typeof value === 'string') attributes.add(value);
    }
  }
  return (value) => ids.has(value) && !attributes.has(value);
}

/** A move as a comparable string, so "is this in the shipped list" has an answer. */
function moveKey(move) {
  return JSON.stringify([
    move.actor, move.type, move.cards ?? null, move.from ?? null,
    move.to ?? null, move.id ?? null, move.target ?? null, move.choice ?? null,
  ]);
}

/**
 * Audit one client against the truth, after a move has been published.
 *
 * Everything here compares the client's BELIEF to the host's STATE, never to
 * another product of the same filter — a check graded against the thing it is
 * checking passes for as long as the bug is consistent.
 */
function auditClient({ state, seat, client, delivered, isCardId, faults }) {
  const view = client.view();
  if (!view) { faults.push(`seat ${seat} holds no view after a published move`); return; }

  // 1. Privacy, on the wire: what this device was actually handed.
  const foreign = foreignHands(state, seat);
  const allowed = entitledTo(state, seat);
  for (const id of cardIdsIn(delivered, isCardId)) {
    if (foreign.has(id)) faults.push(`seat ${seat} was sent ${id} from another seat's hand`);
    else if (!allowed.has(id)) faults.push(`seat ${seat} was sent ${id}, which it may not see`);
  }

  // 2. Structure: a zone this seat may not look into must carry no card list at
  //    all. A count is information the felt has always shown; an array is not.
  for (const [address, zone] of Object.entries(view.zones || {})) {
    const instance = state.zones.get(address);
    if (!instance) { faults.push(`seat ${seat} was told about a zone that does not exist: ${address}`); continue; }
    const def = instance.def;
    const mayList = def.visibility === 'all' || (def.visibility === 'owner' && instance.seat === seat);
    if (zone.cards && !mayList) {
      faults.push(`seat ${seat} was sent a card list for ${address} (visibility ${def.visibility})`);
    }
    // 3. Truth: where the client IS entitled to the list, it must be the real
    //    one. A view that is private but wrong is a desync nobody notices until
    //    the reject arrives.
    if (zone.cards && JSON.stringify(zone.cards) !== JSON.stringify(instance.cards)) {
      faults.push(`seat ${seat} disagrees with the host about ${address}`);
    }
    if (zone.count !== instance.cards.length) {
      faults.push(`seat ${seat} has the wrong count for ${address}`);
    }
  }

  if (view.turn.seat !== state.turn.seat || view.turn.phase !== state.turn.phase) {
    faults.push(`seat ${seat} is on turn ${view.turn.seat}/${view.turn.phase}, the host on ${state.turn.seat}/${state.turn.phase}`);
  }
}

/**
 * One round, host + (seats - 1) scripted clients, over the stub star.
 *
 * Seat 0 is the host's own — it moves through `applyLocal`, the same door a
 * bot turn and a timeout use. Every other seat is a device that must ask.
 */
function playOneOverProtocol(pack, seatCount, seed) {
  const state = createState({ pack, seats: seatCount, seed });
  pack.template.setup(makeCtx(state));
  const isCardId = cardIdChecker(state);

  const net = createPeerNetwork({ hostDeviceId: 'host' });
  const hostPort = net.createDevice('host', { name: 'Host' });
  const seats = createSeatTable({ seats: seatCount, localDeviceId: 'host' });
  seats.claim(0, { deviceId: 'host' });

  const packInfo = () => ({
    packId: pack.id,
    packVersion: pack.manifest?.version,
    variants: pack.activeVariants ?? [],
  });

  // A VIRTUAL CLOCK, because a simulated hand takes a millisecond and a real
  // one takes twenty minutes. On the wall clock every proposal in a long game
  // lands inside a single 10-second rate-limit window, and the host starts
  // refusing perfectly legal moves at the fortieth — a limit that no human
  // table can reach and every simulated one does. Ticking a virtual second per
  // move restores the proportions the budget was written for.
  let clock = 0;
  const faults = [];
  const host = createTableHost({
    // One table per simulated run (protocol v2 names every frame's table).
    tableId: 'tbl-sim',
    peer: hostPort,
    seats,
    liveState: () => state,
    packInfo,
    nameFor: (seat) => `Seat ${seat}`,
    now: () => clock,
    hooks: { onError: (e) => faults.push(`host: ${e.kind} (${e.reason || e.frame || ''})`) },
  });
  host.start();

  const clients = [null];
  for (let seat = 1; seat < seatCount; seat++) {
    const deviceId = `d${seat}`;
    const port = net.createDevice(deviceId, { name: `Player ${seat}` });
    const client = createTableClient({
      tableId: 'tbl-sim',
      peer: port,
      expects: packInfo,
      hooks: {
        onReject: (frame) => faults.push(`seat ${seat}: host rejected a bot move (${frame.rule})`),
        onIncompatible: (why) => faults.push(`seat ${seat}: incompatible (${why.why})`),
        onError: (e) => faults.push(`seat ${seat}: ${e.kind} (${e.reason || e.frame || ''})`),
      },
    });
    client.start();
    net.ready('host', deviceId);
    client.claimSeat(seat);
    clients.push(client);
  }

  let moves = 0;
  let roundDone = false;
  while (!state.gameOver && !roundDone && moves < MAX_MOVES && !faults.length) {
    let move = null;
    let actingSeat = null;
    for (const seat of actingSeats(makeCtx(state))) {
      move = chooseBotMove(state, seat);
      if (move) { actingSeat = seat; break; }
    }
    if (!move) {
      return { outcome: 'stall', moves, reason: `no legal move for seat ${actingSeat ?? state.turn.seat}, phase ${state.turn.phase}` };
    }

    const before = state.log.length;
    clock += 1000;
    net.clearLog();

    if (actingSeat === 0) {
      const verdict = host.applyLocal(move);
      if (!verdict?.legal) return { outcome: 'error', moves, reason: `host refused its own move: ${verdict?.reason}` };
    } else {
      const client = clients[actingSeat];
      // D3: the host ships the acting seat's legal moves with its view, and a
      // move the bot found but that list does not contain is a move a real
      // joiner could never have made.
      const offered = new Set((client.view()?.moves || []).map(moveKey));
      if (offered.size && !offered.has(moveKey(move))) {
        faults.push(`seat ${actingSeat}: ${move.type} is legal but was not in the shipped move list`);
      }
      client.propose(move);
      if (state.log.length === before) {
        return {
          outcome: 'error', moves,
          reason: faults[0] || `seat ${actingSeat}: a legal ${move.type} was not applied`,
        };
      }
    }

    // DENSE EARLY, SAMPLED LATE. The audit walks every zone of every seat, and
    // a round that runs to the move cap would spend the whole simulation
    // re-proving what the opening two hundred moves already proved. The deal,
    // the first lay-down and every reaction cascade are inside the dense
    // window; past it, one move in twenty-five is enough to catch a drift that
    // would have to persist to matter.
    if (moves < AUDIT_EVERY_MOVE_UNTIL || moves % AUDIT_SAMPLE === 0) {
      for (let seat = 1; seat < seatCount; seat++) {
        auditClient({
          state, seat, client: clients[seat],
          delivered: net.deliveredTo(`d${seat}`), isCardId, faults,
        });
      }
      if (faults.length) return { outcome: 'error', moves, reason: faults[0] };
    }

    if (state.events.some((e) => e.type === 'roundOver')) roundDone = true;
    moves++;
  }

  if (faults.length) return { outcome: 'error', moves, reason: faults[0] };
  if (moves >= MAX_MOVES) return { outcome: 'stall', moves, reason: 'move cap exceeded (live-lock, or just very slow bot convergence)' };
  return { outcome: 'complete', moves };
}

async function simulateProtocolPack(packId, games, { seats, variants } = {}) {
  const pack = await loadPackFromDisk(packId, variants);
  const seatCount = seats ?? pack.manifest.players.best ?? pack.manifest.players.min;
  let completed = 0;
  let stalled = 0;
  let errored = 0;
  let totalMoves = 0;
  const reasons = new Map();

  for (let i = 0; i < games; i++) {
    // The SAME seed as the solo run: same deal, same bot decisions, so a
    // difference in outcome is the protocol's alone.
    const result = playOneOverProtocol(pack, seatCount, `sim:${packId}:${i}`);
    totalMoves += result.moves;
    if (result.outcome === 'complete') completed++;
    else {
      if (result.outcome === 'stall') stalled++;
      else errored++;
      reasons.set(result.reason, (reasons.get(result.reason) || 0) + 1);
    }
  }

  const label = variants?.length ? `${packId} + ${variants.join(', ')}` : packId;
  console.log(`\n=== ${label} over the protocol (host + ${seatCount - 1} clients, ${games} games) ===`);
  console.log(`  completed: ${completed}  stalled: ${stalled}  errored: ${errored}`);
  console.log(`  avg moves/game: ${(totalMoves / games).toFixed(1)}`);
  if (reasons.size) {
    console.log('  stall/error reasons:');
    for (const [reason, count] of reasons) console.log(`    (${count}x) ${reason}`);
  }
  return { completed, stalled, errored };
}

/** Every variant a pack OFFERS, one at a time. `available: false` ones are skipped. */
async function availableVariantIds(packId) {
  const manifest = await readJson(path.join(PACKS_DIR, packId, 'manifest.json'));
  return (manifest.variants || []).filter((v) => v.available !== false).map((v) => v.id);
}

export { simulatePack, simulateProtocolPack, tournamentPack, availableVariantIds };

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

  // `--protocol` plays the same games through host + N clients over the stub
  // transport instead of one in-process state. Slower by roughly the cost of a
  // per-seat view per move, which is why it is a flag rather than the default.
  const protocol = args.includes('--protocol');

  // `--vs=hard,easy` seats one difficulty against another and counts hands won
  // (see TOURNAMENT MODE above). `--difficulty=hard` instead plays the ordinary
  // completion run with every seat at that setting — a deadlock hunt for the
  // rollout bot, which enumerates and applies far more moves per hand than the
  // bot the default bars were measured on.
  const vsArg = args.find((a) => a.startsWith('--vs='));
  const contenders = vsArg ? vsArg.split('=')[1].split(',').filter(Boolean) : null;
  const difficultyArg = args.find((a) => a.startsWith('--difficulty='));
  const difficulty = difficultyArg ? difficultyArg.split('=')[1] : null;
  for (const name of [...(contenders || []), ...(difficulty ? [difficulty] : [])]) {
    if (!DIFFICULTIES.includes(name)) {
      console.error(`Unknown difficulty "${name}" — one of ${DIFFICULTIES.join(', ')}`);
      process.exit(2);
    }
  }
  const seatsArg = args.find((a) => a.startsWith('--seats='));
  const seats = seatsArg ? Number(seatsArg.split('=')[1]) : undefined;
  // See tournamentPack: `--budget-moves=N` swaps the shipped wall clock for the
  // reproducible cap, which is what an A/B between two builds has to run under.
  const budgetArg = args.find((a) => a.startsWith('--budget-moves='));
  const budgetMoves = budgetArg ? Number(budgetArg.split('=')[1]) : undefined;
  // `--rollout-depth=N` overrides how far a hard rollout plays before it asks
  // the template to score the position; `inf` plays every one to the end. This
  // is the knob the depth sweep in IMPLEMENTATION_NOTES.md was measured on.
  const depthArg = args.find((a) => a.startsWith('--rollout-depth='));
  const depthValue = depthArg ? depthArg.split('=')[1] : undefined;
  const depth = depthValue === undefined ? undefined
    : (depthValue === 'inf' ? Infinity : Number(depthValue));
  // `--confidence=N` overrides how many standard errors the sampler's favourite
  // must beat the runner-up by before it may reorder anything; 0 disables the
  // check, which is the build the confidence sweep is measured against.
  const confArg = args.find((a) => a.startsWith('--confidence='));
  const confidence = confArg ? Number(confArg.split('=')[1]) : undefined;

  const run = protocol ? simulateProtocolPack : simulatePack;

  if (packIds.length === 0) {
    console.error('Usage: simulate.mjs <pack-id> [<pack-id>...] | --all [--games=N] [--protocol]\n'
      + '                          [--difficulty=easy|medium|hard] [--vs=hard,easy] [--seats=N]\n'
      + '                          [--budget-moves=N] [--rollout-depth=N|inf] [--confidence=N]');
    process.exit(2);
  }

  let anyBad = false;
  for (const packId of packIds) {
    try {
      if (contenders) {
        await tournamentPack(packId, games,
          { seats, contenders, budgetMoves, depth, confidence });
        continue;
      }
      const sets = variantSets === 'each'
        ? [undefined, ...(await availableVariantIds(packId)).map((id) => [id])]
        : (variantSets ?? [undefined]);
      for (const variants of sets) {
        const { stalled, errored } = await run(packId, games, { variants, seats, difficulty });
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
