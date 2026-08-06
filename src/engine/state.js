// The state container: zones, card locations, turn/vars/scores, and zone-lifecycle
// reactions (recycle/moveAll). Zone addressing: shared zone id ('discard', 'build.2'),
// per-player zone with seat as the LAST segment ('hand.2', 'discard.1.0' = pile 1 of
// seat 0) — matches schema/rules-test.schema.json's documented convention.

import { createRng } from './rng.js';

export function zoneAddress(id, { n, seat } = {}) {
  let addr = n != null ? `${id}.${n}` : id;
  if (seat != null) addr = `${addr}.${seat}`;
  return addr;
}

class ZoneInstance {
  constructor(def, seat, n) {
    this.def = def;
    this.seat = seat;
    this.n = n;
    this.cards = [];
  }
}

export class ZoneSet {
  constructor() {
    this.defs = new Map();
    this.instances = new Map(); // address -> ZoneInstance
  }

  define(def, seats) {
    this.defs.set(def.id, def);
    const numbers = def.count ? Array.from({ length: def.count }, (_, i) => i + 1) : [null];
    for (const n of numbers) {
      if (def.per === 'player') {
        for (let seat = 0; seat < seats; seat++) {
          const addr = zoneAddress(def.id, { n, seat });
          this.instances.set(addr, new ZoneInstance(def, seat, n));
        }
      } else {
        const addr = zoneAddress(def.id, { n });
        this.instances.set(addr, new ZoneInstance(def, null, n));
      }
    }
  }

  has(address) {
    return this.instances.has(address);
  }

  get(address) {
    const z = this.instances.get(address);
    if (!z) throw new Error(`Unknown zone address: ${address}`);
    return z;
  }

  cards(address) {
    return this.get(address).cards;
  }

  count(address) {
    return this.get(address).cards.length;
  }

  top(address) {
    const c = this.cards(address);
    return c.length ? c[c.length - 1] : undefined;
  }

  allAddresses() {
    return [...this.instances.keys()];
  }
}

function patternToRegex(pattern) {
  const escaped = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.]+');
  return new RegExp(`^${escaped}$`);
}

/**
 * A reaction with its trigger pre-parsed, and the zone addresses it can fire on
 * already worked out.
 *
 * Compiled once at createState rather than inside checkReactions' loop. The
 * sweep itself is deliberate and stays — it is what fixed the Stockpile recycle
 * deadlock (IMPLEMENTATION_NOTES bug 1) — but it ran `new RegExp` per reaction
 * per sweep iteration per moveCards call, and then tested it against every zone
 * address in the game. Zone addresses are fixed after createState, so the match
 * is a fact about the pack, not about the move.
 */
function compileReaction(reaction, zones) {
  const colonIdx = reaction.when.indexOf(':');
  if (colonIdx === -1) return null;
  const kind = reaction.when.slice(0, colonIdx);
  const regex = patternToRegex(reaction.when.slice(colonIdx + 1));
  const addresses = zones.allAddresses().filter((address) => regex.test(address));
  return addresses.length ? { reaction, kind, addresses } : null;
}

export function createState({ pack, seats, seed }) {
  const zones = new ZoneSet();
  const defsById = new Map();
  for (const def of pack.template.defaultZones(pack.rules, seats)) defsById.set(def.id, def);
  for (const def of pack.manifest.zones || []) defsById.set(def.id, def); // pack-declared zones override template defaults
  for (const def of defsById.values()) zones.define(def, seats);

  const reactions = [
    ...(pack.template.defaultReactions ? pack.template.defaultReactions(pack.rules) : []),
    ...(pack.manifest.reactions || []),
  ];

  return {
    pack,
    seats,
    seed,
    rng: createRng(seed),
    zones,
    reactions,
    // Same list, pre-parsed — see compileReaction. `reactions` stays as the
    // declared form because describe.js reads it to tell a player that the draw
    // pile refills from the discard.
    compiledReactions: reactions.map((r) => compileReaction(r, zones)).filter(Boolean),
    cardLocation: new Map(),
    turn: { seat: 0, phase: null },
    direction: 1,
    vars: {},
    playerVars: Array.from({ length: seats }, () => ({})),
    scores: Array.from({ length: seats }, () => 0),
    roundNumber: 1,
    roundScores: null,
    // A HAND ENDING AND A MATCH ENDING ARE TWO DIFFERENT FACTS, and until
    // ctx.endRound existed the templates had only one flag to say either with:
    // they set `gameOver` to mean "this hand is finished", their isRoundOver
    // read it straight back, and the pipeline had to reset it to false again
    // before dealing the next round. `roundEnded` is the hand's own signal;
    // `gameOver` returns to meaning the match is over. Both are DERIVED — the
    // log is the match (src/engine/replay.js) — so neither is persisted.
    roundEnded: false,
    roundWinner: null,
    gameOver: false,
    winner: null,
    log: [],
    // Transient, derived, and NOT persisted: what happened inside the last
    // applied move (a trick resolving, a pile recycling, a round ending).
    // serializeMatch ignores it and replay regenerates it, so it can never
    // drift from the log. movePipeline.applyMove clears it per move; the UI
    // reads it after to drive animation/sound without re-deriving the engine's
    // internals from zone diffs.
    events: [],
  };
}

/** Append a derived event for the UI. Safe before/after any move. */
export function emitEvent(state, type, payload) {
  state.events.push({ type, ...payload });
}

/** Empty every zone and the location map — the reset between rounds. */
export function clearAllZones(state) {
  for (const address of state.zones.allAddresses()) {
    state.zones.get(address).cards.length = 0;
  }
  state.cardLocation.clear();
}

export function moveCards(state, cardIds, fromAddress, toAddress, { position = 'top' } = {}) {
  const from = state.zones.get(fromAddress);
  const to = state.zones.get(toAddress);
  for (const cardId of cardIds) {
    const idx = from.cards.indexOf(cardId);
    if (idx === -1) {
      throw new Error(`Card ${cardId} not in zone ${fromAddress} (looking in ${JSON.stringify(from.cards)})`);
    }
    from.cards.splice(idx, 1);
    if (position === 'bottom') to.cards.unshift(cardId);
    else to.cards.push(cardId);
    state.cardLocation.set(cardId, toAddress);
  }
  checkReactions(state);
}

// Reactions can cascade: a build pile completing (zoneFull) dumps into `recycled`,
// which is exactly what an empty draw pile's `zoneEmpty` reaction is waiting on. A
// single-zone check can't see that — "recycled" gaining cards doesn't match a
// "zoneEmpty:draw" pattern — so every mutation re-sweeps every reaction against every
// zone until nothing fires, rather than only re-checking the zone that was just
// directly touched.
function checkReactions(state) {
  const compiled = state.compiledReactions;
  if (!compiled || compiled.length === 0) return;
  let firedAny = true;
  let guard = 0;
  const maxIterations = (compiled.length + 1) * state.zones.allAddresses().length + 8;
  while (firedAny && guard++ < maxIterations) {
    firedAny = false;
    for (const { reaction, kind, addresses } of compiled) {
      for (const address of addresses) {
        const zone = state.zones.instances.get(address);
        const triggered =
          (kind === 'zoneEmpty' && zone.cards.length === 0) ||
          (kind === 'zoneFull' && zone.def.capacity != null && zone.cards.length >= zone.def.capacity);
        if (triggered && applyReaction(state, reaction, address)) firedAny = true;
      }
    }
  }
}

// Returns true iff the reaction actually moved cards (so the sweep above knows to
// keep going) — a no-op recycle (empty source) or moveAll (empty trigger, shouldn't
// happen but guarded) returns false so the sweep can reach its fixed point.
function applyReaction(state, reaction, triggerAddress) {
  if (reaction.do === 'recycle') {
    const source = state.zones.instances.get(reaction.from);
    if (!source || source.cards.length === 0) return false;
    let keep;
    let moving = source.cards.slice();
    if (reaction.keepTop) keep = moving.pop();
    if (!moving.length) return false;
    if (reaction.shuffle) moving = state.rng.shuffle(moving);
    source.cards.length = 0;
    if (keep !== undefined) source.cards.push(keep);
    const target = state.zones.instances.get(triggerAddress);
    target.cards.push(...moving);
    for (const id of moving) state.cardLocation.set(id, triggerAddress);
    emitEvent(state, 'recycled', { from: reaction.from, to: triggerAddress, count: moving.length });
    return true;
  }
  if (reaction.do === 'moveAll') {
    const zone = state.zones.instances.get(triggerAddress);
    const moving = zone.cards.slice();
    if (!moving.length) return false;
    zone.cards.length = 0;
    const target = state.zones.instances.get(reaction.to);
    target.cards.push(...moving);
    for (const id of moving) state.cardLocation.set(id, reaction.to);
    emitEvent(state, 'pileCleared', { zone: triggerAddress, to: reaction.to, count: moving.length });
    return true;
  }
  return false;
}

// Shuffles every card in the pack's deck into the named zone and stamps cardLocation.
// Used by template setup() to build the initial draw pile / stock.
export function initializeDeckInto(state, address) {
  const ids = state.rng.shuffle([...state.pack.cardsById.keys()]);
  const zone = state.zones.get(address);
  zone.cards.push(...ids);
  for (const id of ids) state.cardLocation.set(id, address);
}
