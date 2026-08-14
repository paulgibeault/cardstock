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
import { createSeatTable } from '../src/players/seats.js';
import { createTableHost } from '../src/match/host.js';
import { createTableClient } from '../src/match/client.js';
import { cardIdsIn } from '../src/engine/view.js';
import { createPeerNetwork } from './peer-stub.mjs';

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
  const maxMoves = MAX_MOVES_BY_TEMPLATE[pack.template.id] ?? MAX_MOVES;
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
  while (!state.gameOver && !roundDone && moves < maxMoves && !faults.length) {
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
    // a contract-rummy round that runs to its twelve-thousand-move cap would
    // spend the whole simulation re-proving what the opening two hundred moves
    // already proved. The deal, the first lay-down and every reaction cascade
    // are inside the dense window; past it, one move in twenty-five is enough
    // to catch a drift that would have to persist to matter.
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
  if (moves >= maxMoves) return { outcome: 'stall', moves, reason: 'move cap exceeded (live-lock, or just very slow bot convergence)' };
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

export { simulatePack, simulateProtocolPack, availableVariantIds };

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
  const run = protocol ? simulateProtocolPack : simulatePack;

  if (packIds.length === 0) {
    console.error('Usage: simulate.mjs <pack-id> [<pack-id>...] | --all [--games=N] [--protocol]');
    process.exit(2);
  }

  let anyBad = false;
  for (const packId of packIds) {
    try {
      const sets = variantSets === 'each'
        ? [undefined, ...(await availableVariantIds(packId)).map((id) => [id])]
        : (variantSets ?? [undefined]);
      for (const variants of sets) {
        const { stalled, errored } = await run(packId, games, { variants });
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
