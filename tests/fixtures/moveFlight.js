// CARDS IN FLIGHT, STOOD UP WITHOUT A SCREEN.
//
// src/ui/moveFlight.js was carved out of src/ui/table.js (#223 seam 6) so a Node
// test could call it: it takes `el`, `epoch`, `zones`, the seat row and the two
// node lookups as parameters and loads with no `document`. This is the smallest
// table those parameters describe — a hand, an opponent row of plates, the piles
// a card can land on and the meld chips it can join — in one place, because two
// test files ask about it (tests/moveFlight.test.js, and the move-vocabulary
// gate in tests/flight.test.js) and two tables that disagree about what a plate
// holds would be two tests passing against a felt nobody ships.
//
// THE FLYING IS REAL. `flyCard` and `landOn` are src/ui/flight.js's own; what is
// stubbed is the browser underneath them — `document.createElement` for the
// copy, the fly layer it is appended to, and `element.animate`, which records
// its keyframes. Where a card was sent is read back out of those keyframes
// (`landedAt`), which is the same arithmetic flyCard used to aim it, so a
// flight counts only if it really would have crossed the felt.

import { createMoveFlight } from '../../src/ui/moveFlight.js';

/** A rect with the fields getBoundingClientRect answers. */
export function rect(left, top, width, height = width * 1.4) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const NO_RECT = rect(0, 0, 0, 0);

/**
 * Enough of an element for the flights: a rect, a style, children, and the
 * selectors this module asks of it. Anything else it reached for would throw.
 */
export function box(r, { select = {}, children = [], name = '' } = {}) {
  return {
    name,
    style: {},
    children,
    get lastElementChild() { return children.at(-1) ?? null; },
    getBoundingClientRect: () => r ?? NO_RECT,
    querySelector: (selector) => select[selector] ?? null,
  };
}

/**
 * The browser flight.js draws on, installed on the globals and taken off again.
 *
 * `window` and `document` both go on, with every reduced-motion signal
 * permissive (tests/flight.test.js's `withEnv` explains why stubbing only one
 * lets a case pass for the wrong reason); `reducedMotion: true` sets the
 * launcher's `<html>` attribute, the one signal a framed game always has.
 */
export function installBrowser({ reducedMotion = false } = {}) {
  const keys = ['window', 'document', 'Arcade'];
  const present = Object.fromEntries(keys.map((k) => [k, k in globalThis]));
  const saved = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  const flights = [];
  let layer = null;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  delete globalThis.Arcade;
  globalThis.document = {
    documentElement: { dataset: reducedMotion ? { reducedMotion: 'true' } : {} },
    // flightLayer() looks the layer up and makes it on demand, once.
    body: { appendChild: (node) => { layer = node; } },
    getElementById: (id) => (layer && layer.id === id ? layer : null),
    createElement(tag) {
      const node = {
        tag,
        style: {},
        className: '',
        innerHTML: '',
        id: '',
        removed: false,
        setAttribute: () => {},
        appendChild: () => {},
        remove() { this.removed = true; },
        getBoundingClientRect() {
          const width = parseFloat(this.style.width) || 0;
          return rect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0, width);
        },
        animate(keyframes, options) {
          if (this.className === 'fly-card') flights.push({ node: this, keyframes, options });
          return { finished: Promise.resolve() };
        },
      };
      return node;
    },
  };
  return {
    flights,
    restore() {
      for (const k of keys) {
        if (present[k]) globalThis[k] = saved[k]; else delete globalThis[k];
      }
    },
  };
}

/**
 * Where a recorded flight was aimed, as flyCard computed it: the centre and the
 * width of the rect it was handed as `to`.
 */
export function landedAt(flight) {
  const start = flight.node.getBoundingClientRect();
  const end = flight.keyframes.at(-1).transform;
  const [, dx, dy, scale] = end.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/)
    .map(Number);
  return {
    x: round(start.left + start.width / 2 + dx),
    y: round(start.top + start.height / 2 + dy),
    width: round(start.width * scale),
  };
}

/** Rounded to a thousandth of a pixel: the aim is exact, the float is not. */
function round(n) {
  return Math.round(n * 1000) / 1000;
}

/** The centre of `r`, for comparing against `landedAt`. */
export function centre(r) {
  return { x: round(r.left + r.width / 2), y: round(r.top + r.height / 2) };
}

/**
 * A table with everything a flight could aim at, and `createMoveFlight` built
 * over it.
 *
 * Seat 0 is the human's. Seats 1 and 2 are opponents on the row: seat 1's fan
 * is showing, seat 2's is folded to its face. There is a draw pile, one pile
 * that takes both a play and a discard (`pile`), and seat 1 has one meld whose
 * chip draws its cards in reading order — the reverse of the order stored.
 *
 * `opts.pending` is what `seatRow.pendingSeatShift` answers for a node, and
 * every node it was asked about is recorded in `asked`.
 */
export function flightTable(opts = {}) {
  const nodes = {};
  nodes.hand = box(rect(100, 600, 400, 120), { name: 'hand' });
  nodes.fanCard = box(rect(310, 20, 30), { name: 'seat1 fan card' });
  nodes.edge = box(rect(300, 20, 8, 40), { name: 'seat1 edge box' });
  nodes.mini = box(rect(300, 20, 50, 20), { name: 'seat1 mini-hand', children: [nodes.edge, nodes.fanCard] });
  nodes.plate1 = box(rect(280, 0, 120, 90), { name: 'seat1 plate', select: { '.mini-hand': nodes.mini } });
  nodes.avatar2 = box(rect(520, 10, 40, 40), { name: 'seat2 avatar' });
  nodes.foldedMini = box(null, { name: 'seat2 folded mini-hand', children: [box(null)] });
  nodes.plate2 = box(rect(500, 0, 80, 60), {
    name: 'seat2 plate',
    select: { '.mini-hand': nodes.foldedMini, '.seat__avatar': nodes.avatar2 },
  });
  nodes.plate3 = box(rect(640, 0, 80, 60), { name: 'seat3 bare plate' });
  const plates = { 1: nodes.plate1, 2: nodes.plate2, 3: nodes.plate3 };
  nodes.row = box(rect(0, 0, 800, 100), { name: 'opponent row' });
  nodes.row.querySelector = (selector) => {
    const seat = selector.match(/^\[data-seat="(\d+)"\]$/)?.[1];
    return seat === undefined ? null : plates[seat] ?? null;
  };

  nodes.drawTop = box(rect(200, 300, 60), { name: 'draw top' });
  nodes.draw = box(rect(190, 290, 80, 110), { name: 'draw', select: { '.pile-stack__top': nodes.drawTop } });
  nodes.pileTop = box(rect(400, 300, 60), { name: 'pile top' });
  nodes.pile = box(rect(390, 290, 80, 110), { name: 'pile', select: { '.pile-stack__top': nodes.pileTop } });
  nodes.meldStrip = box(rect(300, 110, 120, 50), { name: 'seat1 melds' });
  nodes.meldCards = [0, 1, 2, 3].map((i) => box(rect(300 + 30 * i, 110, 28), { name: `meld slot ${i}` }));
  nodes.meldCardRow = box(rect(300, 110, 120, 40), { name: 'meld cards', children: nodes.meldCards });
  nodes.chip = box(rect(300, 110, 120, 50), { name: 'meld chip', select: { '.meld-chip__cards': nodes.meldCardRow } });
  const zoneNodes = { draw: nodes.draw, pile: nodes.pile, 'melds.1': nodes.meldStrip, ...(opts.zoneNodes || {}) };
  const chips = { '1:0': nodes.chip, ...(opts.chips || {}) };

  // Stored order; the chip reads it back to front. `x9` is a card the renderer
  // cannot resolve, so it is skipped exactly as buildMeldStrip skips it.
  const meldGroups = opts.meldGroups ?? { 1: [{ cards: ['m4', 'm3', 'x9', 'm2', 'm1'] }] };
  const handCards = opts.handCards ?? ['h1', 'h2'];
  const defs = new Map([
    ['draw', { id: 'draw', per: null, landing: null }],
    ['hand', { id: 'hand', per: 'player', landing: 'both' }],
    ['pile', { id: 'pile', per: null, landing: 'both' }],
  ]);
  const state = {
    zones: {
      defs,
      has: (id) => id === 'pile' || id === 'draw',
      cards: (address) => (address === 'hand.0' ? handCards : []),
    },
  };
  const cardById = (_state, id) => (typeof id === 'string' && id && !id.startsWith('x') ? { id } : null);
  const art = () => ({ face: (card) => `<svg data-face="${card.id}"/>`, back: () => '<svg data-back/>' });

  let epoch = 0;
  const asked = [];
  const zones = opts.zones === null ? null : {
    meldGroupsOf: (_state, seat) => meldGroups[seat] ?? [],
    meldCardOrder: (_state, group) => [...group.cards].reverse(),
  };
  const flight = createMoveFlight({
    el: { hand: nodes.hand, opponentsTop: nodes.row },
    epoch: () => epoch,
    zones: () => zones,
    seatRow: {
      pendingSeatShift: (node) => {
        asked.push(node);
        return opts.pending ? opts.pending(node) : null;
      },
    },
    isMySeat: (seat) => seat === 0,
    mySeat: () => 0,
    cardById,
    art,
    currentFlightMs: () => opts.flightMs ?? 420,
    zoneStackNode: (address) => zoneNodes[address] ?? null,
    meldChipNode: (key) => chips[key] ?? null,
  });
  return {
    flight,
    nodes,
    state,
    asked,
    bumpEpoch: () => { epoch += 1; },
  };
}

/** Let every settled flight's `.then` run, so landOn has put its card back. */
export function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}
