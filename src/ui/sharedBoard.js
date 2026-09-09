// ONE ROAD, EVERY SEAT ON IT — the platform's shared board.
//
// WHY THIS EXISTS. `src/ui/counterTrack.js` taught the felt that some seat
// counters are a POSITION rather than a quantity, and drew each one where its
// seat already was: 88px on the opponent's plate, 90px squeezed into the status
// bar's own chip. Round 5 played a whole cribbage match on that and the note
// that came back was "where is my board and pegs?" (#136). Two tracks that
// small, in the two corners of the felt the eye never goes mid-hand, are not a
// board — they are two progress bars that happen to be about the same road.
//
// A cribbage board is ONE object with both players on it, and the reason it is
// one object is that the only question worth asking of it is comparative: am I
// ahead, by how much, and did that last hand close the gap. Two separate bars
// at two separate scales in two separate places make that a subtraction. One
// road with two lanes makes it a glance.
//
// STILL NOTHING KNOWS THE WORD CRIBBAGE, and that is the same claim
// counterTrack.js makes and for the same reason (src/templates/CONTRACT.md).
// This module is handed a list of seats and their primary counters; the ones
// whose counter is a track (`counterTrack()` says so — the platform's closed
// vocabulary of kinds, currently `peg`) get a lane, and a pack whose seats
// count things rather than stand somewhere produces no board at all and the
// felt keeps the row hidden with no space reserved.
//
// THE SPLIT IS THE ONE counterTrack.js USES. `sharedBoard()` is pure and takes
// no DOM, because src/ui/table.js touches `document` at import time and can
// therefore never be loaded by a `node --test` — a model that can be asserted
// without a browser is the only way this geometry is ever checked
// (tests/sharedBoard.test.js). `renderSharedBoard()` takes the document as a
// parameter for the same reason.
//
// BATTERY RULE (GAME_INTEGRATION §6d, cardstock#24): the pegs MOVE and they do
// not pulse. There is no `@keyframes` anywhere on this component; a peg's only
// motion is a one-shot transition on `left`, which is why the renderer UPDATES
// an existing board in place (`updateSharedBoard`) rather than rebuilding it —
// a fresh element does not transition from anywhere, it simply appears.

import { counterTrack } from './counterTrack.js';

/**
 * The units of the road, in holes.
 *
 * A `peg` counter is a position on a road measured in holes, and a road
 * measured in holes is marked in fives and numbered in thirties — that is the
 * genre's own ruler, the same way `peg` itself is the platform's own word.
 * 121, the length every board in this build actually has, is four thirty-hole
 * streets and the last hole home.
 */
export const HOLES_PER_TICK = 5;
export const HOLES_PER_STREET = 30;

/**
 * The finest tick the eye can still read as a ruler, as a percentage of the
 * road. Below this the marks stop being orientation and become grey — a road
 * of 121 puts them 4.1% apart, and a hypothetical road of a thousand holes
 * would be a solid bar pretending to be a scale, so it gets a plain rail.
 */
const FINEST_TICK_PCT = 1.5;

/** Where a hole sits on the road, as a percentage, clamped into it. */
function pctOf(hole, of) {
  if (!Number.isFinite(hole) || !Number.isFinite(of) || of <= 0) return 0;
  return Math.max(0, Math.min(100, (hole / of) * 100));
}

/**
 * The numbered streets printed under the road — 30, 60 and 90 on a 121-hole
 * board.
 *
 * A STREET WITHIN A TICK OF THE END IS NOT PRINTED, and 120 on a board of 121
 * is exactly that. The end of the road already carries a number — the target,
 * which closes the scale — and "120 121" five pixels apart is two numbers
 * where the player wanted one; it shipped that way in the first screenshot of
 * this component and read as a single muddled five-digit thing. The street's
 * MARK on the rail stays: it is the gradient, and it is what the eye is
 * actually counting by.
 */
function streetsOn(of) {
  const out = [];
  if (!Number.isFinite(of) || of < HOLES_PER_STREET * 2) return out;
  for (let hole = HOLES_PER_STREET; hole <= of - HOLES_PER_TICK; hole += HOLES_PER_STREET) {
    out.push({ hole, pct: pctOf(hole, of) });
  }
  return out;
}

/**
 * The board a set of seats describes, or null if they do not describe one.
 *
 * @param seats  [{ seat, counter, name, mark, color, mine, partner, side }]
 *               in the order the lanes should be drawn — the caller owns ring
 *               order, because who sits where is the table's business and not
 *               this component's (src/ui/seatRing.js).
 *
 * EVERY LANE IS MEASURED AGAINST THE SAME ROAD, and that is the whole
 * difference between this and two tracks side by side. `counterTrack` computes
 * each seat's position as a fraction of ITS OWN `of`; here the road is the
 * longest one any lane declares and every peg is re-measured against it, so two
 * seats playing to different targets would be drawn at different places rather
 * than both at "80% of something".
 */
export function sharedBoard(seats) {
  const rows = [];
  for (const entry of Array.isArray(seats) ? seats : []) {
    const track = counterTrack(entry?.counter);
    if (track) rows.push({ entry, track });
  }
  if (!rows.length) return null;

  const of = Math.max(...rows.map((r) => r.track.of));
  if (!Number.isFinite(of) || of <= 0) return null;

  const tickPct = pctOf(HOLES_PER_TICK, of);
  const lanes = rows.map(({ entry, track }) => {
    const frontPct = pctOf(track.value, of);
    const backPct = pctOf(track.from, of);
    return {
      seat: entry.seat,
      name: entry.name || '',
      mark: entry.mark || '',
      color: entry.color || '',
      mine: !!entry.mine,
      partner: !!entry.partner,
      side: Number.isInteger(entry.side) ? entry.side : null,
      value: track.value,
      of: track.of,
      text: entry.counter.text ?? String(track.value),
      // "You: 45 of 121, up 6" — the seat's name in front of the sentence the
      // counter already knows how to say about itself. A lane is one image with
      // one name; its pegs, ticks and numbers are decoration and say nothing.
      aria: `${entry.name || 'Seat'}: ${entry.counter.aria || `${track.value} of ${track.of}`}`,
      frontPct,
      backPct,
      together: backPct === frontPct,
    };
  });

  return {
    of,
    label: rows[0].entry.counter.label || '',
    kind: rows[0].track.kind,
    // The ticks are drawn as a repeating gradient on the rail rather than as
    // holes: at 375px the road is a couple of hundred pixels for 121 holes, so
    // they are TEXTURE and the pegs carry the meaning. Null where they would be
    // too fine to read as a ruler.
    tickPct: tickPct >= FINEST_TICK_PCT ? tickPct : null,
    streetPct: pctOf(HOLES_PER_STREET, of) >= FINEST_TICK_PCT ? pctOf(HOLES_PER_STREET, of) : null,
    streets: streetsOn(of),
    lanes,
    // What "the same board" means to `updateSharedBoard`: the same seats, in
    // the same order, on the same road. Anything else is a new board and gets
    // built rather than repainted.
    key: `${rows[0].track.kind}:${of}:${lanes.map((l) => l.seat).join(',')}`,
  };
}

/** A percentage, printed the one way this module prints percentages. */
const pct = (n) => `${n.toFixed(2)}%`;

/**
 * The board as DOM, or null.
 *
 * Returns a HANDLE rather than a bare node — the node plus a reference to every
 * part `updateSharedBoard` has to repaint. The alternative is re-querying the
 * tree on every render, which works and which this file does not do for the
 * same reason the model is pure: the parts are the thing being tested, and a
 * handle can be asserted through a fifteen-line document stub while a
 * `querySelector` cannot.
 *
 * Everything reaching an inline style here is a number this module computed and
 * clamped, or a colour from the ROSTER (§7b) — never a value out of a pack
 * manifest.
 */
export function renderSharedBoard(model, doc = globalThis.document) {
  if (!model || !doc) return null;

  const node = doc.createElement('div');
  node.className = 'board';
  node.dataset.board = model.kind;
  if (model.label) {
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', model.label);
  }
  // The ruler, as two repeating gradients the stylesheet composes onto the
  // rail. Percentages, so a tick is a HOLE and not a pixel: the same rail at
  // 216px on a phone and 490px on a desktop is marked in the same fives.
  if (model.tickPct) node.style.setProperty('--board-tick', pct(model.tickPct));
  if (model.streetPct) node.style.setProperty('--board-street', pct(model.streetPct));

  const lanes = new Map();
  for (const lane of model.lanes) {
    const row = doc.createElement('div');
    row.className = 'board__lane'
      + (lane.mine ? ' board__lane--mine' : '')
      + (lane.partner ? ' board__lane--partner' : '');
    row.dataset.seat = String(lane.seat);
    if (lane.side !== null) row.dataset.side = String(lane.side);
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', lane.aria);

    // THE ROSTER'S MARK, the same one the seat plate wears and the trick's
    // owner tags use (zoneRenderer.js `ownerTag`) — "this is a player" is one
    // vocabulary wherever it turns up, so a lane is matched to a chair rather
    // than read.
    const mark = doc.createElement('span');
    mark.className = 'board__mark';
    mark.style.background = lane.color;
    mark.textContent = lane.mark;
    mark.setAttribute('aria-hidden', 'true');
    row.appendChild(mark);

    const name = doc.createElement('span');
    name.className = 'board__name';
    name.textContent = lane.name;
    name.setAttribute('aria-hidden', 'true');
    row.appendChild(name);

    const rail = doc.createElement('span');
    rail.className = 'board__rail';
    rail.setAttribute('aria-hidden', 'true');
    row.appendChild(rail);

    // THE PEGS GO INSIDE THE RAIL. `left` in percent is a percentage of the
    // containing block, and #124 is the whole story of what happens when that
    // block is the rail plus whatever is printed beside it: the peg walks off
    // the road somewhere past hole sixty and lands on its own number.
    const pegs = {};
    for (const [which, at] of [['back', lane.backPct], ['front', lane.frontPct]]) {
      const peg = doc.createElement('span');
      peg.className = `board__peg board__peg--${which}`;
      peg.style.left = pct(at);
      peg.style.background = lane.color;
      peg.setAttribute('aria-hidden', 'true');
      rail.appendChild(peg);
      pegs[which] = peg;
    }
    if (lane.together) row.dataset.together = 'true';

    const value = doc.createElement('span');
    value.className = 'board__value';
    value.textContent = lane.text;
    value.setAttribute('aria-hidden', 'true');
    row.appendChild(value);

    node.appendChild(row);
    lanes.set(lane.seat, { row, front: pegs.front, back: pegs.back, value });
  }

  // The scale, once, under both lanes — the way a real board numbers its
  // streets between the tracks rather than on each of them. The road's own
  // length closes it, because "45" means nothing without "of 121" and the
  // lanes print only the first half of that.
  const scale = doc.createElement('div');
  scale.className = 'board__scale';
  scale.setAttribute('aria-hidden', 'true');
  for (const street of model.streets) {
    const num = doc.createElement('span');
    num.className = 'board__scale-num';
    num.style.left = pct(street.pct);
    num.textContent = String(street.hole);
    scale.appendChild(num);
  }
  const target = doc.createElement('span');
  target.className = 'board__target';
  target.textContent = String(model.of);
  scale.appendChild(target);
  node.appendChild(scale);

  return { node, key: model.key, lanes };
}

/**
 * Repaint a board that is already on the felt, or say it cannot.
 *
 * THIS IS WHY THE PEGS MOVE. A render rebuilds the felt, and an element built
 * fresh at 37% has never been anywhere else — the transition on `left` has no
 * old value to run from, so a rebuilt board TELEPORTS its pegs and the one
 * piece of motion this component is allowed never happens. Repainting the same
 * nodes is what turns a score into a peg sliding up the road, which is the
 * thing a cribbage player is actually watching for.
 *
 * @returns false when the handle is a board for a different set of seats or a
 *          different road — the caller builds a new one.
 */
export function updateSharedBoard(handle, model) {
  if (!handle || !model || handle.key !== model.key) return false;
  for (const lane of model.lanes) {
    const parts = handle.lanes.get(lane.seat);
    if (!parts) return false;
    parts.front.style.left = pct(lane.frontPct);
    parts.back.style.left = pct(lane.backPct);
    parts.value.textContent = lane.text;
    parts.row.setAttribute('aria-label', lane.aria);
    if (lane.together) parts.row.dataset.together = 'true';
    else delete parts.row.dataset.together;
  }
  return true;
}
