// The overlays that sit on top of the table: the round score sheet, the
// scoreboard, and the game-over panel with the match's stats.
//
// Split out of src/ui/table.js in the UX pass. They belong together and apart
// from the felt for one reason: every one of them is a READ-ONLY view of
// things the engine already knows — a score array, a log replayed into
// counters (src/stats/matchStats.js), a stored record — and none of them can
// affect a move. Keeping them here means the table module stays about playing
// and this one stays about reporting.
//
// EVERY NAME COMES FROM THE SEATING (src/players/roster.js) and is rendered
// with textContent. There is no string interpolation of a player name into
// markup anywhere in this file, which is the rule §17.8 exists for.

import { statLinesFor } from '../stats/matchStats.js';
import { sideScoreOf, sidesOf, foldToSides } from '../engine/sides.js';
import { targetSentence as matchTargetSentence, winDirection } from './scoreDirection.js';
import { line, svgNode } from './dom.js';

const el = {
  roundOverlay: document.getElementById('round-overlay'),
  roundPanel: document.getElementById('round-panel'),
  roundFold: document.getElementById('round-fold'),
  roundFoot: document.querySelector('#round-panel .round-panel__foot'),
  roundTitle: document.getElementById('round-title'),
  roundScores: document.getElementById('round-scores'),
  roundContinue: document.getElementById('round-continue'),
  roundTarget: document.getElementById('round-target'),
  roundReady: document.getElementById('round-ready'),
  roundEndMatch: document.getElementById('round-end-match'),
  roundRing: document.getElementById('round-ring'),
  roundRingFill: document.querySelector('#round-ring .deal-ring__fill'),
  roundRingTrack: document.querySelector('#round-ring .deal-ring__track'),
  roundPace: document.getElementById('round-pace'),

  scoreOverlay: document.getElementById('scoreboard-overlay'),
  scoreTotals: document.getElementById('scoreboard-totals'),
  scoreHistory: document.getElementById('scoreboard-history'),
  scoreClose: document.getElementById('scoreboard-close'),
  scoreReview: document.getElementById('scoreboard-review'),
  gameOverReview: document.getElementById('game-over-review'),
  gameOverMapToggle: document.getElementById('game-over-map-toggle'),
  roundMapToggle: document.getElementById('round-map-toggle'),
  roundMap: document.getElementById('round-map'),
  gameOverMap: document.getElementById('game-over-map'),
  reviewOverlay: document.getElementById('review-overlay'),
  reviewMapHost: document.getElementById('review-map-host'),
  reviewClose: document.getElementById('review-close'),
  reviewDrawer: document.getElementById('review-drawer'),
  reviewDrawerHost: document.getElementById('review-drawer-host'),
  reviewDrawerClose: document.getElementById('review-drawer-close'),
  scoreRules: document.getElementById('scoreboard-rules'),

  rulesOverlay: document.getElementById('rules-overlay'),
  rulesTitle: document.getElementById('rules-title'),
  rulesTagline: document.getElementById('rules-tagline'),
  rulesBody: document.getElementById('rules-body'),
  rulesClose: document.getElementById('rules-close'),


  gameOverOverlay: document.getElementById('game-over-overlay'),
  gameOverFan: document.getElementById('game-over-fan'),
  gameOverMessage: document.getElementById('game-over-message'),
  gameOverRecord: document.getElementById('game-over-record'),
  gameOverStats: document.getElementById('game-over-stats'),
  gameOverRounds: document.getElementById('game-over-rounds'),
  gameOverRoundsToggle: document.getElementById('game-over-rounds-toggle'),
  playAgainButton: document.getElementById('play-again-button'),
  gameOverLobbyButton: document.getElementById('game-over-lobby-button'),
};

/** A seat's name with its icon in front, as two text nodes — never markup. */
function nameCell(className, identity) {
  const wrap = document.createElement('span');
  wrap.className = className;
  if (identity?.icon) {
    const icon = document.createElement('span');
    icon.className = 'seat-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = identity.icon;
    wrap.appendChild(icon);
  }
  const name = document.createElement('span');
  name.textContent = identity?.name || `Seat ${identity?.seat ?? '?'}`;
  wrap.appendChild(name);
  return wrap;
}

function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

/* ------------------------------------------------------------------ *
 * A SIDE IS A ROW — the sheet's unit, and it used to be a chair
 * ------------------------------------------------------------------ *
 *
 * A PARTNERSHIP SCORES ONCE. This sheet listed four players and, for every
 * partnership pack we ship, two of those rows were structurally dead: both
 * scorers in src/engine/scoring.js bank a side's whole result on `members[0]`
 * (`bids-and-bags` and `meld-and-tricks` alike), so the partner's DELTA was
 * `+0` every round for the whole match while the TOTAL beside it climbed to
 * 682 — the same number as the banker's, because the total was already folded
 * to the side. One sheet, saying both that this player scored nothing and that
 * they have 682. Whichever a player believed, the sheet had told them the other
 * (#125 item 50).
 *
 * THE PREVIOUS SPLIT AND WHY IT DOES NOT SURVIVE. The rule here was "a delta is
 * per seat and a total is per side", reasoned as: what a seat took this hand is
 * genuinely that seat's, and "you took four, your partner took eight" is the
 * conversation a partnership actually has. That reasoning was sound and its
 * premise is not true of this platform — no scorer we ship splits a side's
 * round score between its members, so the per-seat delta was never the sentence
 * it was defended as. It was one seat's total wearing four rows. A scorer that
 * genuinely does divide a hand between partners can take the split back, and
 * this is the note that says what to check first: whether `scoreRound` returns
 * a nonzero delta for more than one seat of a side.
 *
 * A TEAMLESS PACK IS UNCHANGED, and not by a branch: `sidesOf` gives a pack
 * with no partnerships one side per seat, so every row below is exactly the
 * row it was — same order, same name, same delta, same total.
 */

/** The rows this sheet has, one per side, in side order. */
function sideRowsOf(state, seating) {
  return sidesOf(state.pack, state.seats).map((members) => ({
    members,
    // The row the player is reading their own score off, which is any row
    // holding a chair they are sitting in.
    mine: members.some((s) => seating[s] && !seating[s].isBot),
  }));
}

/**
 * The name on a side's row: one player, or a pair spelled out.
 *
 * Both names, never "Your side" — a score sheet is read afterwards and at a
 * table where the seating rotates, "your side" is the one label that stops
 * meaning anything the moment the panel is screenshotted or the match is
 * resumed from storage.
 */
function sideNameCell(className, members, seating) {
  const wrap = document.createElement('span');
  wrap.className = className;
  members.forEach((seat, i) => {
    if (i > 0) wrap.appendChild(document.createTextNode(' & '));
    // `.name-cell` and not the bare row class: the row class is a flex box with
    // a gap, and a nested cell with no class of its own put the icon hard
    // against the name — "★You & 🦔Fig".
    wrap.appendChild(nameCell('name-cell', seating[seat]));
  });
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Round summary
 * ------------------------------------------------------------------ */

/**
 * The score sheet between rounds. Bot turns stay parked until it is dismissed.
 *
 * `contract` is an optional per-seat phrase — "Bid 3, took 4" — supplied by the
 * table from the position the round ENDED in (#120's fork; the live state has
 * already wiped the bids and dealt the next hand, so this cannot be re-derived
 * here). It rides INSIDE the name cell rather than as a fourth column, because
 * the sheet is a three-column grid and a row is `display: contents`.
 *
 * A delta of `-30` is the arithmetic; "Bid 4, took 3" is the reason, and the
 * reason was nowhere on this sheet — least of all for the human, whose own bid
 * was not shown anywhere at all (#123, item 28).
 */
export function showRoundSummary(state, ev, seating, contract = null, pace = null, {
  guest = null, counts = [], art = null, focus = null, final = null,
} = {}) {
  // ONE SHEET, TWO MOMENTS. Between hands it deals the next one; at the end of
  // the match it is the final look (#120) — the same sheet with the winner as
  // its title and the results as the only way on, so the last hand is
  // inspected exactly as every hand before it was.
  el.roundTitle.textContent = final ? final.result : `Round ${ev.round} over`;
  el.roundScores.replaceChildren();
  activeFocus = focus;
  // A COLUMN WITH NOTHING TO SAY SAYS NOTHING (#124, item 43): a pack that pegs
  // its points live scores nothing at the round boundary, and `roundScores`
  // comes back empty. Tested structurally, so a pack that genuinely scored
  // nobody still prints "+0". The cell stays because the grid is `display:
  // contents` and a skipped cell shifts every cell after it.
  const hasDeltas = Object.keys(ev?.scores || {}).length > 0;
  // ONE ROW PER SIDE (#125): both partnership scorers bank a side's whole result
  // on its first member, so a per-seat delta at a partnership pack is
  // structurally "+0" beside a total the seat never earned alone. A teamless
  // pack is unchanged — `sidesOf` gives it one side per seat and the fold is
  // the identity. The contract note (#123, "Bid 3, took 2") is per seat, so a
  // side's row carries one per member in member order.
  const sides = sidesOf(state.pack, state.seats);
  const deltas = foldToSides(ev?.scores || {}, sides);
  const totals = foldToSides(ev?.totals || state.scores, sides);
  // ONE CARD PER SIDE, SIDE BY SIDE. The sheet sits under the felt while the
  // board is read, so it is laid out WIDE and short — a row of sides, each with
  // its number and the counts that made it — rather than a tall list that
  // climbs over the cards it is about.
  el.roundScores.classList.add('round-scores--sides');
  sideRowsOf(state, seating).forEach(({ members, mine }, side) => {
    const card = document.createElement('div');
    card.className = `round-side ${mine ? 'round-side--you' : ''}`;
    const head = document.createElement('div');
    head.className = 'round-side__head';
    const name = sideNameCell('round-side__name', members, seating);
    head.appendChild(name);
    const nums = document.createElement('span');
    nums.className = 'round-side__nums';
    if (hasDeltas) nums.appendChild(line('round-side__delta', signed(deltas[side] ?? 0)));
    nums.appendChild(line('round-side__total', `${totals[side] ?? 0}`));
    head.appendChild(nums);
    card.appendChild(head);
    const notes = members.map((s) => contract?.[s]).filter(Boolean);
    if (notes.length) card.appendChild(line('round-side__note', notes.join(' · ')));
    // WHAT THE NUMBER WAS MADE OF, inside the side it explains — every count
    // this side's seats made, at once, instead of one floating card per tap.
    const own = (counts || []).filter((c) => members.includes(c.seat));
    if (own.length) card.appendChild(countsCell(own, art));
    el.roundScores.appendChild(card);
  });
  el.roundPanel.classList.toggle('round-panel--final', !!final);
  el.roundContinue.textContent = final ? 'See the results' : `Deal round ${state.roundNumber}`;
  el.roundTarget.textContent = final ? (final.play || '') : targetSentence(state, ev);
  el.roundTarget.hidden = !el.roundTarget.textContent;
  // A GUEST'S SHEET IS THE HOST'S SHEET WITH THE HOST'S CONTROLS TAKEN OFF
  // (#283). The host deals, so the guest's button is a tick instead; ending
  // the match and the pace are the host's to set; and the trick-by-trick map
  // reads a log that only the host keeps. The final look has none of the three:
  // there is no next hand to pace or to walk away from.
  el.roundEndMatch.hidden = !!guest || !!final;
  el.roundMapToggle.hidden = !!guest || !!final;
  // The foot holds the map and the pace, and neither is offered then.
  el.roundFoot.hidden = !!guest || !!final;
  el.roundContinue.disabled = false;
  if (guest) paintGuestReady(guest);
  else paintRoundReady(final ? '' : hostReadyLine);
  setFolded(false);
  el.roundOverlay.hidden = false;
  dock(true);
  // AFTER THE UNHIDE, and it has to be: the ring's geometry is measured off the
  // button, and a button inside `display: none` measures zero.
  paintRoundPace(final ? null : pace);
}

/* ------------------------------------------------------------------ *
 * The counts, on the sheet (src/ui/inspection.js)
 * ------------------------------------------------------------------ */

/** What the felt is asked to light, or null — set by the sheet that is open. */
let activeFocus = null;
/** The count the player PICKED (a tap), which a pointer leaving does not clear. */
let pinned = null;

/** Light `ids` on the felt (and `seat`'s plate), or put everything back with null. */
function focusOn(target) {
  if (activeFocus) activeFocus(target);
}

/**
 * One side's counts: whose, the cards, and what each part came to.
 *
 * EVERY PIECE IS A WAY TO POINT AT THE FELT. Resting on a count (or focusing
 * it) lights all of its cards wherever they are on the table; a part — a
 * fifteen, a pair, "2 cards at 1" — lights only the cards it was made of; a tap
 * pins either until it is tapped again. The faces drawn here are small and the
 * point is not to read them — it is the board that is read, and these say
 * which cards on it to read.
 *
 * @param list the side's counts, each `{ seat, title, faces: [{ id, card }],
 *             parts: [{ label, points, ids }], points, ids }`
 */
function countsCell(list, art) {
  const cell = document.createElement('div');
  cell.className = 'round-side__counts';
  for (const count of list) {
    const block = document.createElement('div');
    block.className = 'round-count';
    block.tabIndex = 0;
    block.setAttribute('role', 'button');
    block.setAttribute('aria-label', count.aria || count.title);
    const target = { ids: count.ids, seat: count.seat };
    const head = document.createElement('div');
    head.className = 'round-count__head';
    head.appendChild(line('round-count__title', count.label || count.title));
    head.appendChild(line('round-count__points', count.zero ? count.zeroLabel : String(count.points)));
    block.appendChild(head);
    if (art && count.faces.length) {
      const faces = document.createElement('div');
      faces.className = 'round-count__faces';
      faces.setAttribute('aria-hidden', 'true');
      for (const face of count.faces) {
        const node = svgNode(art().face(face.card), 'round-count__face');
        node.dataset.cardId = face.id;
        if (face.starter) node.classList.add('round-count__face--starter');
        faces.appendChild(node);
      }
      block.appendChild(faces);
    }
    if (count.parts.length) {
      const parts = document.createElement('div');
      parts.className = 'round-count__parts';
      for (const part of count.parts) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'round-count__part';
        chip.textContent = `${part.label} ${part.points}`;
        const lights = { ids: part.ids, seat: count.seat };
        chip.addEventListener('pointerenter', () => { if (!pinned) focusOn(lights); });
        chip.addEventListener('pointerleave', () => { if (!pinned) focusOn(target); });
        chip.addEventListener('focus', () => focusOn(lights));
        chip.addEventListener('click', (event) => {
          event.stopPropagation();
          pinned = pinned === chip ? null : chip;
          focusOn(pinned ? lights : target);
          paintPinned();
        });
        parts.appendChild(chip);
      }
      block.appendChild(parts);
    }
    block.addEventListener('pointerenter', () => { if (!pinned) focusOn(target); });
    block.addEventListener('pointerleave', () => { if (!pinned) focusOn(null); });
    block.addEventListener('focus', () => focusOn(target));
    block.addEventListener('blur', () => { if (!pinned) focusOn(null); });
    const pick = () => {
      pinned = pinned === block ? null : block;
      focusOn(pinned ? target : null);
      paintPinned();
    };
    block.addEventListener('click', pick);
    block.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      pick();
    });
    cell.appendChild(block);
  }
  return cell;
}

/** Mark the picked count or part on the sheet. */
function paintPinned() {
  for (const node of el.roundScores.querySelectorAll('.round-count--pinned, .round-count__part--pinned')) {
    node.classList.remove('round-count--pinned', 'round-count__part--pinned');
  }
  if (!pinned) return;
  pinned.classList.add(pinned.classList.contains('round-count') ? 'round-count--pinned' : 'round-count__part--pinned');
}

/**
 * THE FELT MAKES ROOM FOR THE SHEET rather than going under it. The sheet docks
 * at the foot of the screen, and at a table whose cards sit low — cribbage's
 * pegging piles, a shedding pack's discard — an overlay there would cover the
 * very cards it lists. So while it is up the table screen is padded by the
 * sheet's own height (measured, because it is one row of counts at one pack and
 * three at another, and folding it changes it), and the board lays itself out
 * in what is left — the review drawer's arrangement, turned on its side.
 */
let dockObserver = null;
function dock(on) {
  const root = document.documentElement;
  document.body.classList.toggle('round-docked', on);
  if (!on) {
    dockObserver?.disconnect();
    root.style.removeProperty('--round-dock');
    return;
  }
  const measure = () => root.style.setProperty('--round-dock', `${Math.ceil(el.roundPanel.offsetHeight) + 8}px`);
  measure();
  if (typeof ResizeObserver === 'function') {
    dockObserver ??= new ResizeObserver(measure);
    dockObserver.observe(el.roundPanel);
  }
}

/**
 * FOLDED, the sheet is its title and its buttons — the whole felt is the thing
 * on screen. A phone has room for the board or the sheet and not both, and the
 * point of holding a hand open is to look at the board.
 */
function setFolded(folded) {
  el.roundPanel.classList.toggle('round-panel--folded', folded);
  el.roundFold.setAttribute('aria-expanded', String(!folded));
  el.roundFold.setAttribute('aria-label', folded ? 'Show the score sheet' : 'Fold the score sheet away');
}

/* ------------------------------------------------------------------ *
 * The pace of the sheet (#150)
 * ------------------------------------------------------------------ */

/** The button's own corner radius (src/ui/css/panels.css `#round-continue`). */
const DEAL_RADIUS = 8;

/**
 * Show or hide the ring — BY ATTRIBUTE, and that is not a style choice.
 *
 * `hidden` is an IDL property of HTMLElement. `#round-ring` is an `<svg>`, and
 * SVGElement does not have one: `ring.hidden = false` quietly defines a
 * JavaScript expando on the object and leaves the ATTRIBUTE exactly where it
 * was, so `.deal-ring[hidden] { display: none }` went on applying. The ring
 * never appeared once, while every value the code could read said it should —
 * `ring.hidden` was false, the dash array was right, the animation was
 * running, and `getComputedStyle(...).display` was `none`.
 */
function showRing(on) {
  if (on) el.roundRing.removeAttribute('hidden');
  else el.roundRing.setAttribute('hidden', '');
}

/**
 * Draw the pace: the rung's name on its cycling control, and the countdown as
 * an outline filling in around the Deal button.
 *
 * THE TIMER IS NOT HERE. src/ui/table.js owns it, because the only thing
 * allowed to deal the next hand is `dismissRoundSummary` — the single door that
 * also re-arms the bots — and a panel that could fire it would be a second one.
 * This function draws a duration; it never measures one.
 *
 * @param pace `{ label, autoMs, animate, paused }`, or null to leave the sheet bare:
 *             `autoMs` null is the Manual rung (no ring at all), and `animate`
 *             false is reduced motion or a power saver, where the outline is
 *             drawn whole and still, and the timer still fires.
 */
export function paintRoundPace(pace) {
  el.roundPace.hidden = !pace;
  if (!pace) {
    showRing(false);
    return;
  }
  // PAUSED is a timed rung whose countdown a touch on the table stopped
  // (`pauseAutoAdvance`): the sheet now waits for the button, and says so.
  el.roundPace.textContent = `Pace · ${pace.label}${pace.paused ? ' · paused' : ''} ▸`;
  el.roundPace.setAttribute('aria-label', `Pace: ${pace.label}${pace.paused ? ', paused while you look' : ''}. Tap to change.`);

  if (pace.autoMs == null) {
    showRing(false);
    return;
  }
  // MEASURED WITHOUT THE TRANSFORM, and that is the whole reason this is
  // `offsetWidth` and not `getBoundingClientRect()`. This runs on the frame the
  // overlay is unhidden, and the panel's entrance (`settle-in`, src/ui/css/panels.css)
  // starts at `scale(0.96)`: a client rect read then is 96% of the button, while
  // the svg's own layout box — which the path is drawn in, and which a transform
  // does not touch — is full size. The dash array came out 4% short of the real
  // perimeter, so the ring reached the end of its countdown with a ~15px gap
  // still open at the top-left. `offsetWidth` is the border-box in layout pixels,
  // which is the box the path lives in.
  const bw = el.roundContinue.offsetWidth;
  const bh = el.roundContinue.offsetHeight;
  // A zero-sized button is a sheet that is not on screen; drawing an outline
  // for it would bake a NaN into the dash array and leave a ring that never
  // fills once it is.
  if (!(bw > 0 && bh > 0)) {
    showRing(false);
    return;
  }
  // The svg is inset 2px inside the button (src/ui/css/panels.css says why), so its
  // own box is 4px smaller in each dimension and a 2px stroke centred on that
  // edge lies wholly on the button's own surface.
  const w = bw - 4;
  const h = bh - 4;
  const r = Math.min(DEAL_RADIUS - 2, w / 2, h / 2);
  const len = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
  for (const rect of [el.roundRingTrack, el.roundRingFill]) {
    rect.setAttribute('rx', String(r));
    rect.setAttribute('ry', String(r));
  }
  el.roundRing.style.setProperty('--deal-ring-len', String(len));
  el.roundRing.style.setProperty('--deal-ring-ms', `${pace.autoMs}ms`);
  showRing(true);
  // RESTARTED, NOT RESUMED. Cycling the rung on the sheet restarts the
  // countdown (src/ui/table.js does the same to the timer), and an animation
  // whose class is already on the element would otherwise carry on from
  // wherever the last rung had got to. Removing the class, forcing a reflow and
  // putting it back is the one reliable way to re-run a CSS animation.
  el.roundRing.classList.remove('deal-ring--running', 'deal-ring--static');
  void el.roundRing.getBoundingClientRect();
  el.roundRing.classList.add(pace.animate ? 'deal-ring--running' : 'deal-ring--static');
}

/**
 * How much further this match has to run.
 *
 * The sentence itself is in src/ui/scoreDirection.js, with the reasoning for its
 * two directions: this file resolves its element table on its first line, so
 * nothing in it can be loaded by a Node test, and the text of a line that was
 * false for Thirteen and Hearts for a whole playtest (#121) is precisely the
 * thing that wants pinning by one. This wrapper stays because the panel's own
 * subject is a state and a roundOver event, and the pure function's is a pack
 * and a totals array.
 */
function targetSentence(state, ev) {
  return matchTargetSentence(state.pack, state.seats, ev.totals);
}

// The host's ready line, kept so a sheet opened (or re-opened from a review)
// after the ticks arrived still shows them.
let hostReadyLine = '';

/** Who at a shared table has said they are ready — the host's sheet (#283). */
export function setHostReadyLine(text) {
  hostReadyLine = text || '';
  if (!el.roundOverlay.hidden && !el.roundEndMatch.hidden) paintRoundReady(hostReadyLine);
}

/**
 * The ready line under the score (#283) — the host's "Bea is ready", or the
 * guest's "Ada deals the next hand". Empty hides it.
 */
export function paintRoundReady(text) {
  el.roundReady.textContent = text || '';
  el.roundReady.hidden = !text;
}

/** A guest's button: a tick they give once, then a tick they have given. */
export function paintGuestReady({ ready = false, waiting = '' }) {
  el.roundContinue.textContent = ready ? 'Ready \u2713' : 'I\u2019m ready';
  el.roundContinue.disabled = !!ready;
  paintRoundReady(waiting);
}

export function hideRoundSummary() {
  focusOn(null);
  activeFocus = null;
  pinned = null;
  el.roundOverlay.hidden = true;
  dock(false);
  el.roundMap.hidden = true;
  el.roundMap.replaceChildren();
  el.roundMapToggle.setAttribute('aria-expanded', 'false');
  // The ring stops being a countdown the moment the sheet stops being on
  // screen. Left running, its animation would still be ticking inside a hidden
  // overlay — the exact battery shape cardstock#24 exists to forbid — and would
  // be halfway filled when the next round opened the sheet again.
  el.roundRing.classList.remove('deal-ring--running', 'deal-ring--static');
  showRing(false);
}

/* ------------------------------------------------------------------ *
 * Scoreboard — the same sheet, every round of it
 * ------------------------------------------------------------------ */

function roundHistoryInto(node, rounds, seating, seats, pack = null) {
  node.replaceChildren();
  if (!rounds.length) {
    node.appendChild(line('round-history__empty', 'No rounds have been scored yet.'));
    return;
  }
  // A COLUMN PER SIDE, for the same reason the summary above has a row per side
  // — and a pack with no partnerships gets one side per seat, so its grid is
  // the grid it always was.
  const sides = sidesOf(pack, seats);
  const table = document.createElement('div');
  table.className = 'round-history__grid';
  table.style.setProperty('--history-cols', String(sides.length));

  table.appendChild(line('round-history__head', ''));
  for (const members of sides) {
    table.appendChild(sideNameCell('round-history__head', members, seating));
  }
  for (const round of rounds) {
    table.appendChild(line('round-history__label', `R${round.round}`));
    for (const delta of foldToSides(round.scores, sides)) {
      table.appendChild(line('round-history__cell', signed(delta)));
    }
  }
  table.appendChild(line('round-history__label round-history__label--total', 'Total'));
  const last = rounds[rounds.length - 1];
  for (const total of foldToSides(last.totals, sides)) {
    table.appendChild(line('round-history__cell round-history__cell--total', `${total}`));
  }
  node.appendChild(table);
}

/**
 * Open the scoreboard.
 *
 * `stats` is a computeMatchStats() result, or null when the log could not be
 * replayed — in which case the totals still show, because those come straight
 * off the live state and are never in doubt.
 */
export function showScoreboard(state, seating, stats) {
  el.scoreTotals.replaceChildren();
  const totals = foldToSides(state.scores, sidesOf(state.pack, state.seats));
  sideRowsOf(state, seating).forEach(({ members, mine }, side) => {
    const row = document.createElement('div');
    row.className = `round-scores__row ${mine ? 'round-scores__row--you' : ''}`;
    row.appendChild(sideNameCell('round-scores__name', members, seating));
    // The difficulty label is a fact about ONE bot, so it is only said where
    // the row is one bot — a pair of personas in this slot is a second name
    // column, and where they differ it would be two answers to one question.
    const solo = members.length === 1 ? seating[members[0]] : null;
    row.appendChild(line('round-scores__delta', solo?.isBot ? (solo.persona?.label || '') : ''));
    row.appendChild(line('round-scores__total', `${totals[side] ?? 0}`));
    el.scoreTotals.appendChild(row);
  });
  roundHistoryInto(el.scoreHistory, stats ? stats.rounds : [], seating, state.seats, state.pack);
  el.scoreOverlay.hidden = false;
}

export function hideScoreboard() {
  el.scoreOverlay.hidden = true;
}

/* ------------------------------------------------------------------ *
 * The last card, before the results
 * ------------------------------------------------------------------ */


/**
 * Hold the results back until the player has actually looked at the ending.
 *
 * THIS IS A PAUSE, NOT A PANEL, and the difference is the whole design. A match
 * ends on a card — somebody's last one — and showGameOver used to open on the
 * same frame that card was still flying to the discard, so the one moment the
 * whole game had been building to was covered by a score sheet before anybody
 * saw who played what.
 *
 * IT IS THE ROUND SHEET NOW, folded into its final shape. It used to be a bar of
 * three sentences, which held the felt still and then said nothing about it —
 * every opponent's last cards were still backs under it. The last hand is now
 * inspected exactly as every hand before it was: the plates turn face up, the
 * sheet docks under the felt with the last hand's counts, and the only way on is
 * the player asking for the results. Nothing times out: "I want longer to look"
 * is not a thing to answer with a timer.
 *
 * @param sheet  what `showRoundSummary` draws — `{ state, ev, seating, contract,
 *               counts, art, focus }` — with `result` (who won) and `play` (the
 *               last card and who played it, or '')
 * @returns a promise that resolves true when acknowledged, false when the table
 *          closed under it — so a caller can decline to open a panel over a
 *          match that is no longer on screen.
 */
export function awaitFinalLook({ state, ev, seating, contract = null, counts = [], art = null, focus = null, result, play = '' }) {
  if (finalAnswer) finalAnswer(false);
  showRoundSummary(state, ev || {}, seating, contract, null, {
    counts, art, focus, final: { result, play },
  });
  return new Promise((resolve) => {
    finalAnswer = (acknowledged) => {
      finalAnswer = null;
      hideRoundSummary();
      resolve(acknowledged);
    };
    // preventScroll: the sheet is fixed, but focusing into it still scrolls the
    // felt behind it — and the felt is the thing this exists to let people see.
    el.roundContinue.focus({ preventScroll: true });
  });
}

/** The final look's answer, while it is waiting for one. */
let finalAnswer = null;

/** Take the final look down without answering it — a screen change under it. */
export function hideFinalLook() {
  if (finalAnswer) finalAnswer(false);
}

/** Is the sheet up as the final look rather than between hands? */
export function isFinalLookOpen() {
  return !!finalAnswer;
}

/* ------------------------------------------------------------------ *
 * Game over
 * ------------------------------------------------------------------ */

/**
 * @param scoreLine (seat) => {label, value} | null — the number that DECIDED
 *                  the match, first on every card. It used to be absent: the
 *                  panel that closes a match led with Moves and Cards played
 *                  and put the scores a click away under "Round by round", so
 *                  the default view of the result was trivia (#122, round-5
 *                  item 26). Passed in rather than read here because which way
 *                  the number counts is the pack's (src/ui/scoreDirection.js).
 */
function statsInto(node, template, stats, seating, seats, winner, { hints = 0, hintSeat = null, scoreLine = null } = {}) {
  node.replaceChildren();
  // NO STATS IS NOT NO SCORE (#283): a guest keeps no log to compute stats
  // from, but the number that decided the match is in its view all the same.
  if (!stats && !scoreLine) return;

  for (let s = 0; s < seats; s++) {
    const lines = stats ? statLinesFor(template, stats.perSeat[s]) : [];
    const score = scoreLine?.(s);
    if (score) lines.unshift(score);
    // Hints are not in the log (src/ui/hint.js), so they are not in `stats`;
    // they are the one line added here, on the card of the seat that asked.
    if (s === hintSeat && hints > 0) lines.push({ label: 'Hints taken', value: String(hints) });
    if (!lines.length) continue;
    const card = document.createElement('div');
    card.className = `stat-card ${s === winner ? 'stat-card--winner' : ''}`;
    card.appendChild(nameCell('stat-card__name', seating[s]));
    const grid = document.createElement('div');
    grid.className = 'stat-card__lines';
    for (const l of lines) {
      grid.appendChild(line('stat-card__label', l.label));
      grid.appendChild(line('stat-card__value', l.value));
    }
    card.appendChild(grid);
    node.appendChild(card);
  }
}

/**
 * The end of a match: who won, what the record now is, and what happened.
 *
 * @param recordText  the pack record + head-to-head sentence, already built by
 *                    the caller (it owns the storage read)
 * @param stats       a computeMatchStats() result, or null
 * @param heroFaces   display-only faces from the manifest
 * @param renderFace  card markup for one face — the open table's own renderer
 */
export function showGameOver(state, {
  seating, stats, recordText, heroFaces = [], renderFace, hints = 0, hintSeat = null, sides = null,
  guest = false,
}) {
  // A GUEST'S RESULTS (#283): the same sheet, without the doors that need the
  // log (review, the map) or the host's authority (dealing again).
  el.playAgainButton.hidden = guest;
  el.gameOverReview.hidden = guest;
  el.gameOverMapToggle.hidden = guest;
  el.gameOverFan.replaceChildren();
  for (const face of heroFaces) {
    const span = document.createElement('span');
    span.className = 'game-over-fan__card';
    // Card SVG is markup this repo authors, with every card-derived value
    // escaped inside src/ui/cardStyles — unlike anything carrying a name.
    span.innerHTML = renderFace(face);
    el.gameOverFan.appendChild(span);
  }

  // This panel is only ever the ENGINE's ending — a game the player abandons
  // never reaches a table, it is dropped from the lobby (src/ui/lobby.js).
  const winner = state.winner;
  // A MATCH IS WON BY A SIDE, and at every table without partnerships a side is
  // one seat — so this is the sentence it always was, with the pair spelled out
  // where there is one. `sides` is `sideStandings` output (src/stats/matchStats.js),
  // best first; without it the winning seat stands alone as before.
  const champions = (sides?.[0]?.seats || [winner]).filter((seat) => seating[seat]);
  const won = champions.some((seat) => seating[seat] && !seating[seat].isBot);
  el.gameOverMessage.replaceChildren();
  if (won) {
    el.gameOverMessage.textContent = champions.length > 1 ? 'Your side wins! \u{1F389}' : 'You win! \u{1F389}';
  } else if (champions.length === 0) {
    el.gameOverMessage.textContent = 'Match over.';
  } else {
    champions.forEach((seat, i) => {
      if (i > 0) el.gameOverMessage.appendChild(document.createTextNode(' & '));
      el.gameOverMessage.appendChild(nameCell('', seating[seat]));
    });
    el.gameOverMessage.appendChild(document.createTextNode(champions.length > 1 ? ' win.' : ' wins.'));
  }

  el.gameOverRecord.textContent = recordText || '';
  // THE SCORES THAT DECIDED IT, FIRST. `sideScoreOf` is the same reading the
  // scoreboard takes, so a partnership's card shows the side's number rather
  // than half of it; the LABEL is the pack's direction, because at Thirteen and
  // Hearts calling a penalty total a "Score" is the same misdirection #121 took
  // out of the round panel's target line. Only a declared `lowestScore` earns
  // the penalty word: a template-owned ending (Cribbage, Milestones) is a score
  // its owner counts up, and `pointsArePrize` declines to answer for those.
  const scoreWord = winDirection(state.pack) === 'lowestScore' ? 'Penalty points' : 'Score';
  statsInto(el.gameOverStats, state.pack.template, stats, seating, state.seats, winner, {
    hints,
    hintSeat,
    scoreLine: (seat) => (Array.isArray(state.scores)
      ? { label: scoreWord, value: String(sideScoreOf(state.pack, state.seats, state.scores, seat)) }
      : null),
  });

  const rounds = stats ? stats.rounds : [];
  el.gameOverRoundsToggle.hidden = rounds.length === 0;
  el.gameOverRounds.hidden = true;
  el.gameOverRoundsToggle.setAttribute('aria-expanded', 'false');
  roundHistoryInto(el.gameOverRounds, rounds, seating, state.seats, state.pack);

  // The map closed, and emptied: it is built for THIS match when it is asked
  // for, never carried from the last one.
  el.gameOverMap.hidden = true;
  el.gameOverMap.replaceChildren();
  el.gameOverMapToggle.setAttribute('aria-expanded', 'false');
  el.gameOverOverlay.classList.toggle('game-over--won', won);
  el.gameOverOverlay.hidden = false;
}

export function hideGameOver() {
  el.gameOverOverlay.hidden = true;
  el.gameOverMap.hidden = true;
  el.gameOverMap.replaceChildren();
}

/**
 * The map of the game (src/ui/review.js builds `node`): beside the felt as a
 * drawer where there is room, over it as a sheet where there is not.
 *
 * THE TABLE DECIDES WHICH — `drawer` is its call, made against the window —
 * because the felt is what has to make room, and it does so by a class on
 * body that src/ui/css/review.css reads (`body.review-drawer`).
 */
export function showReviewMap(node, { drawer = false, title = 'The game so far' } = {}) {
  hideReviewMap();
  // "So far" is a live match's word; a finished one is the whole game.
  for (const head of [el.reviewDrawer, el.reviewOverlay]) {
    const t = head.querySelector('.panel__title');
    if (t) t.textContent = title;
  }
  if (drawer) {
    el.reviewDrawerHost.replaceChildren(node);
    el.reviewDrawer.hidden = false;
    document.body.classList.add('review-drawer');
  } else {
    el.reviewMapHost.replaceChildren(node);
    el.reviewOverlay.hidden = false;
  }
  // The row the felt is standing on, in view — a map of a long match is a
  // list of hundreds, and opening it at the top is opening it at the deal.
  (node.querySelector('.review-play--current') || node.querySelector('.review-beat--current'))
    ?.scrollIntoView({ block: 'center' });
}

export function hideReviewMap() {
  el.reviewOverlay.hidden = true;
  el.reviewMapHost.replaceChildren();
  el.reviewDrawer.hidden = true;
  el.reviewDrawerHost.replaceChildren();
  document.body.classList.remove('review-drawer');
}

export function isReviewMapOpen() {
  return !el.reviewOverlay.hidden || !el.reviewDrawer.hidden;
}

/** Is the map open BESIDE the felt, where the felt can follow a tap? */
export function isReviewDrawerOpen() {
  return !el.reviewDrawer.hidden;
}

/** The map's live node, for a cursor repaint, or null. */
export function reviewMapNode() {
  return el.reviewDrawerHost.firstElementChild || el.reviewMapHost.firstElementChild || null;
}

export function hideAllPanels() {
  hideGameOver();
  hideFinalLook();
  hideRoundSummary();
  hideReviewMap();
  hideScoreboard();
  hideRules();
}

/* ------------------------------------------------------------------ *
 * How to play
 * ------------------------------------------------------------------ */

/**
 * Show the rules for a pack. Takes the generated data (src/ui/rules.js), not
 * the pack — the panel's job is to put text on screen, and keeping the
 * derivation out of it is what lets the lobby show a pack's rules without a
 * match existing.
 */
export function showRules(rules) {
  el.rulesTitle.textContent = rules.title;
  el.rulesTagline.textContent = rules.tagline;
  el.rulesTagline.hidden = !rules.tagline;
  el.rulesBody.replaceChildren();
  for (const section of rules.sections) {
    const heading = document.createElement('h3');
    heading.className = 'rules__heading';
    heading.textContent = section.heading;
    el.rulesBody.appendChild(heading);
    const ul = document.createElement('ul');
    ul.className = 'rules__list';
    for (const text of section.lines) {
      const li = document.createElement('li');
      // textContent throughout: a pack's prose is pack-supplied data, and this
      // panel is the one place a whole paragraph of it reaches the screen.
      li.textContent = text;
      ul.appendChild(li);
    }
    el.rulesBody.appendChild(ul);
  }
  el.rulesOverlay.hidden = false;
  // preventScroll: the overlay is fixed, but focusing into it still scrolls
  // the LOBBY behind it, so closing the panel left the player somewhere they
  // never navigated to.
  el.rulesClose.focus({ preventScroll: true });
}

export function hideRules() {
  el.rulesOverlay.hidden = true;
}

/**
 * Wire the panels' buttons once. Every callback belongs to the table, which
 * owns the match — these overlays only ask.
 */
export function initPanels({
  onContinueRound, onPlayAgain, onLobby, onCloseScoreboard, onEndMatch, onRules, onCyclePace, onReview,
  onReviewMapClosed, onGameOverMap, onRoundMap,
}) {
  el.rulesClose.addEventListener('click', () => hideRules());
  // TWO DOORS INTO REVIEW: the scoreboard mid-match, and the results panel at
  // the end. Both close themselves first; the reel is what opens instead.
  el.scoreReview.addEventListener('click', () => { hideScoreboard(); onReview?.(); });
  el.gameOverReview.addEventListener('click', () => { hideGameOver(); onReview?.(); });
  el.reviewClose.addEventListener('click', () => hideReviewMap());
  el.reviewDrawerClose.addEventListener('click', () => { hideReviewMap(); onReviewMapClosed?.(); });
  el.scoreRules.addEventListener('click', () => onRules?.());
  el.roundContinue.addEventListener('click', () => {
    if (finalAnswer) finalAnswer(true);
    else onContinueRound();
  });
  el.roundFold.addEventListener('click', () => {
    setFolded(!el.roundPanel.classList.contains('round-panel--folded'));
  });
  el.roundEndMatch.addEventListener('click', () => onEndMatch());
  el.roundPace.addEventListener('click', () => onCyclePace?.());
  // THE SHEET NO LONGER DEALS FROM ANYWHERE BUT ITS BUTTON. It did (#150): a
  // player who had read the score reached for what they were looking at. What
  // they are looking at now is a list of counts, each of which is a way to
  // point at the board, so a tap on the sheet means "show me that" — and a deal
  // fired by a tap meant as a question is the one misread this sheet cannot
  // afford. The button, Enter on it, and the countdown are the three doors.
  el.playAgainButton.addEventListener('click', () => onPlayAgain());
  el.gameOverLobbyButton.addEventListener('click', () => onLobby());
  el.scoreClose.addEventListener('click', () => {
    hideScoreboard();
    onCloseScoreboard?.();
  });
  // THE MAP INSIDE THE RESULTS. Built on the first open by the table
  // (`onGameOverMap` returns the node, or null when there is nothing to map),
  // because the table owns the timeline and the card renderer; this panel
  // only owns where it goes.
  el.gameOverMapToggle.addEventListener('click', () => {
    const open = el.gameOverMap.hidden;
    if (open && !el.gameOverMap.firstElementChild) {
      const node = onGameOverMap?.();
      if (!node) return;
      el.gameOverMap.replaceChildren(node);
    }
    el.gameOverMap.hidden = !open;
    el.gameOverMapToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      // The last trick, in view: a finished game's map opens at its end.
      el.gameOverMap.querySelector('.review-beat--current')?.scrollIntoView({ block: 'nearest' });
    }
  });
  // THE SAME MAP ON THE ROUND SHEET. `onRoundMap` builds it AND stops the
  // sheet's countdown, because a player who opened this is reading, not
  // waiting to deal; the sheet's own tap-to-deal already excludes it above.
  el.roundMapToggle.addEventListener('click', () => {
    const open = el.roundMap.hidden;
    if (open && !el.roundMap.firstElementChild) {
      const node = onRoundMap?.();
      if (!node) return;
      el.roundMap.replaceChildren(node);
    }
    el.roundMap.hidden = !open;
    el.roundMapToggle.setAttribute('aria-expanded', String(open));
    if (open) el.roundMap.querySelector('.review-beat--current')?.scrollIntoView({ block: 'nearest' });
  });
  el.gameOverRoundsToggle.addEventListener('click', () => {
    const open = el.gameOverRounds.hidden;
    el.gameOverRounds.hidden = !open;
    // The chevron says open or shut (src/ui/css/panels.css `.sheet-disclosure`);
    // the heading keeps its name either way, like a heading.
    el.gameOverRoundsToggle.setAttribute('aria-expanded', String(open));
  });
}
