// The table screen: one open match, rendered and driven.
//
// Extracted from src/main.js when the lobby arrived, which left main.js as
// boot plus a two-screen router. The contract that came with it:
//
//   THE OPEN TABLE IS THE ONLY MATCH THAT ADVANCES.
//
// That is structural, not policed. There is exactly one hydrated `liveState`;
// bot turns are scheduled only by scheduleNextTurn against it; and every path
// that closes a table cancels the pending timer and bumps `epoch`, so a
// callback already in flight drops its turn instead of applying it. A match
// that is not on screen is DATA — a seed and a log in storage — not a process.
// Nothing is running for it to pause.
//
// Solo only, deliberately. Session timers freeze with the frame (§6c), which
// is right for one player and wrong for a shared table: a game that stopped
// while one player glanced at another tab would desync every peer. Phase 8
// replaces them with host-wall-clock timeout events (ARCADE_ENHANCEMENTS §8.2).
//
// RENDERING IS ZONE-DRIVEN. The table no longer hard-codes "a draw pile and a
// center pile": every shared zone the pack declares (draw, discard, trick,
// build.1..N) gets a pile in the center row, every per-player zone beyond the
// hand (stock, discard.N, melds, won) gets one in the human's own row and a
// compact copy on each opponent's seat plate. The zone definitions
// (template defaults, overridable per pack — see src/engine/state.js) carry
// the layout/label/facing the renderer needs, which is what the design doc §3
// always said they were for.
//
// INPUT IS MOVE-DRIVEN. enumerateLegalMoves is the single source of what the
// human may do; the UI's job is to dress those moves as taps. One-tap play
// for single-destination games (shedding, a trick), tap-source →
// tap-destination where a move needs a `to` (Stockpile's build piles),
// multi-select plus one button where a move carries several cards (Hearts'
// pass, Milestones' lay-down). The selection can never construct a move the
// engine would refuse — every tap target is derived from a move that already
// enumerated as legal.

import { createState } from '../engine/state.js';
import { makeCtx } from '../engine/context.js';
import { validateMove, applyMove, enumerateLegalMoves } from '../engine/movePipeline.js';
import { rehydrateMatch } from '../engine/replay.js';
import { chooseBotMove } from '../engine/bot.js';
import { baseId } from '../engine/selectors.js';
import { handValue } from '../engine/scoring.js';
import { makeCardRenderer } from './cardStyles/index.js';
import { fetchPack } from './packSource.js';
import { flyCard, landOn, motionAllowed } from './flight.js';
import { safeCssColor } from './css.js';
import {
  rememberPack, loadSettings, saveMatch, loadMatch, clearMatch, recordResult, readStats,
} from '../arcade/storage.js';
import {
  playDeal, playCardPlayed, playDraw, playShuffle, playInvalid, playWin, playTrickTaken,
} from '../arcade/audio.js';

const HUMAN_SEAT = 0;
const SEAT_COUNT = 3;

/** How many discards stay visible under the top one. Enough to read as a pile. */
const DISCARD_DEPTH = 3;

/**
 * Templates this table renders COMPLETELY, and can therefore be played through
 * from deal to game over. All four, since the table learned zone-driven piles,
 * pass/lay-down selection, and the round loop — the lobby reads this to decide
 * which tiles still carry a Preview badge (none, today; the set stays because
 * a fifth template would start life outside it).
 */
export const FULLY_PLAYABLE_TEMPLATES = new Set([
  'shedding', 'trick-taking', 'contract-rummy', 'sequencing',
]);

const el = {
  screen: document.getElementById('table-screen'),
  status: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  gameName: document.getElementById('game-name'),
  lobbyButton: document.getElementById('lobby-button'),
  opponentsTop: document.getElementById('opponents-top'),
  centerPiles: document.getElementById('center-piles'),
  playerPiles: document.getElementById('player-piles'),
  actionBar: document.getElementById('action-bar'),
  actionHint: document.getElementById('action-hint'),
  actionButton: document.getElementById('action-button'),
  hand: document.getElementById('hand'),
  log: document.getElementById('log'),
  eventBanner: document.getElementById('event-banner'),
  choiceModal: document.getElementById('choice-modal'),
  choicePrompt: document.getElementById('choice-prompt'),
  choicePanel: document.getElementById('choice-options'),
  choiceCancel: document.getElementById('choice-cancel'),
  roundOverlay: document.getElementById('round-overlay'),
  roundTitle: document.getElementById('round-title'),
  roundScores: document.getElementById('round-scores'),
  roundContinue: document.getElementById('round-continue'),
  gameOverOverlay: document.getElementById('game-over-overlay'),
  gameOverFan: document.getElementById('game-over-fan'),
  gameOverMessage: document.getElementById('game-over-message'),
  gameOverRecord: document.getElementById('game-over-record'),
  playAgainButton: document.getElementById('play-again-button'),
  gameOverLobbyButton: document.getElementById('game-over-lobby-button'),
};

// `liveState`/`epoch` exist so "Play again" can start a fresh game without a bot-turn
// timer left over from the PREVIOUS game corrupting it — scheduleNextTurn's callback
// checks its own epoch is still current before touching anything. A save import
// (onStateReplaced) and leaving for the lobby bump the epoch for the same reason.
let livePack = null;
let liveState = null;
let epoch = 0;

// The open table's card art, built once from its pack (src/ui/cardStyles).
// Rebuilt in adoptMatch rather than per render: resolving a theme walks the
// whole deck for its colours, which is not something to do sixty times a
// second, and the memoised card back would be thrown away with it.
let cardArt = makeCardRenderer({});
let dealAnimation = false;
let botTimer = null;
let bannerTimer = null;
let settings = null;
let exitToLobby = () => {};

// The human's tapped-but-not-yet-committed cards: { from: zoneAddress,
// cardIds: [id, ...] }. Multi-card only where a move takes several cards
// (passing, a lay-down); everywhere else it holds exactly one. Cleared on
// every applied move and pruned against the live state on every render, so a
// stale id can never reach a move.
let selection = null;

// openTable() awaits a fetch, and the player can be back in the lobby before it
// lands. `epoch` cannot cover that gap — it is bumped when the match is ADOPTED,
// which is the thing we are trying not to do. So opening carries its own token:
// whoever bumps it last owns the screen, and a superseded open returns quietly.
let openToken = 0;

// Resolves a pending suit/colour prompt with null when the table closes under
// it, so the awaiting move handler unwinds instead of applying a move to a
// match nobody is looking at.
let cancelPendingChoice = null;

// The match is written SYNCHRONOUSLY after every applied move.
//
// An earlier version coalesced these behind a zero-delay Arcade.session timer
// to avoid re-serializing the log per bot turn. That was wrong in a way worth
// recording: session timers freeze while the frame is suspended, which is
// precisely the moment a pending save has to have already landed — a game
// backgrounded before the timer fired kept its pending write frozen with it.
// Persistence must never ride a gameplay-paced clock. Moves are ≥600 ms apart
// and a match log is a few KB, so the coalescing bought nothing real.
//
// `matchDirty` survives only as onSuspend's belt-and-braces: state that
// changed outside a move (the opening deal) is flushed there too.
let matchDirty = false;

/* ------------------------------------------------------------------ *
 * State questions
 * ------------------------------------------------------------------ */

function seatLabel(seat) {
  return seat === HUMAN_SEAT ? 'You' : `Bot ${seat}`;
}

// Own values, not pack input — these reach an inline style and never pass
// through anything a manifest can influence.
const SEAT_COLORS = ['#2f6fb0', '#b0603a', '#4a7a4e', '#7a5aa8', '#a8823a', '#3a8a8a', '#8a3a63', '#5a6a8a'];

/**
 * Who may act right now. Usually just turn.seat; a simultaneous-commit phase
 * (Hearts' passing) is every seat that has not committed yet — the template
 * says so via actingSeats, the same hook tools/simulate.mjs consults. This is
 * what un-stalls the pass phase: the bot driver below schedules whichever
 * bot may act, not whoever nominally holds the turn.
 */
function actingSeatsOf(state) {
  if (state.gameOver) return [];
  const template = state.pack.template;
  if (template.actingSeats) return template.actingSeats(makeCtx(state));
  return [state.turn.seat];
}

function cardById(state, cardId) {
  return state.pack.cardsById.get(baseId(cardId));
}

/**
 * How the human's taps are interpreted for the open pack — derived from the
 * template and the current phase, never stored:
 *   'tap'        one tap plays the card; the destination is implicit
 *                (shedding's discard, a trick).
 *   'pass'       multi-select exactly N cards, commit with the action button.
 *   'rummy-draw' tap the deck or the discard pile to draw from it.
 *   'rummy-meld' multi-select for a lay-down; a single selected card arms
 *                meld chips (hit) and the discard pile (end of turn).
 *   'place'      select one card from hand/stock/discard top, then tap a
 *                build pile (play) or an own discard pile (end of turn).
 */
function interactionMode(state) {
  const id = state.pack.template.id;
  if (id === 'trick-taking') return state.turn.phase === 'pass' ? 'pass' : 'tap';
  if (id === 'contract-rummy') return state.turn.phase === 'draw' ? 'rummy-draw' : 'rummy-meld';
  if (id === 'sequencing') return 'place';
  return 'tap';
}

function selectedIds() {
  return selection ? selection.cardIds : [];
}

function isSelected(from, cardId) {
  return !!selection && selection.from === from && selection.cardIds.includes(cardId);
}

/** Drop a selection the state has moved out from under (rerender, resume). */
function pruneSelection(state) {
  if (!selection) return;
  if (!state.zones.has(selection.from)) { selection = null; return; }
  const inZone = state.zones.cards(selection.from);
  if (!selection.cardIds.every((id) => inZone.includes(id))) selection = null;
}

/* ------------------------------------------------------------------ *
 * The per-render UI model
 * ------------------------------------------------------------------ */

/**
 * Everything a render needs to know about what is tappable, derived in one
 * place from the enumerated legal moves so the pile builders stay dumb:
 *   handSelectable  Set of hand card ids that respond to a tap
 *   handMulti       whether hand taps toggle membership or replace
 *   sourceTops      Map zoneAddress -> top card id, for piles whose top can
 *                   be picked up as a source (Stockpile's stock/discards)
 *   readyTargets    Map zoneAddress -> move to apply when that pile is tapped
 *   readyMelds      Map "seat:index" -> hit move for that meld chip
 *   action          { label, makeMove() } for the action button, or null
 *   hint            the action bar's text
 */
function buildUiModel(state, humanMoves, humanActs) {
  const mode = interactionMode(state);
  const handAddr = `hand.${HUMAN_SEAT}`;
  const ui = {
    mode,
    handSelectable: new Set(),
    handMulti: false,
    sourceTops: new Map(),
    readyTargets: new Map(),
    readyMelds: new Map(),
    action: null,
    hint: '',
  };
  if (!humanActs) {
    if (mode === 'pass' && !state.gameOver) ui.hint = ''; // covered by status text
    return ui;
  }

  const hand = state.zones.cards(handAddr);
  const sel = selectedIds();

  if (mode === 'tap') {
    for (const move of humanMoves) {
      if (move.type === 'playCard') ui.handSelectable.add(move.cards[0]);
    }
    // Drawing is offered only when there is nothing legal to play, which is
    // the rule these packs share — so the pile lighting up is itself the hint
    // that you are stuck, and no separate prompt has to say so.
    if (ui.handSelectable.size === 0) {
      const draw = humanMoves.find((m) => m.type === 'draw');
      if (draw) ui.readyTargets.set('draw', draw);
    }
    ui.hint = 'Your turn';
    return ui;
  }

  if (mode === 'pass') {
    const count = state.pack.rules.passing?.count ?? 3;
    const direction = { left: 'to the left', right: 'to the right', across: 'across' }[state.vars.passDirection] || '';
    for (const id of hand) ui.handSelectable.add(id);
    ui.handMulti = true;
    ui.hint = `Pick ${count} cards to pass ${direction}`.trim();
    if (sel.length === count && selection.from === handAddr) {
      ui.action = {
        label: `Pass ${count} cards`,
        makeMove: () => ({ actor: HUMAN_SEAT, type: 'passCards', cards: selectedIds().slice() }),
      };
    }
    return ui;
  }

  if (mode === 'rummy-draw') {
    for (const move of humanMoves) {
      if (move.type === 'draw') ui.readyTargets.set(move.from ?? 'draw', move);
    }
    ui.hint = ui.readyTargets.has('discard')
      ? 'Draw from the deck or the discard pile'
      : 'Draw from the deck';
    return ui;
  }

  if (mode === 'rummy-meld') {
    const ctx = makeCtx(state);
    const laidDown = state.playerVars[HUMAN_SEAT]?.laidDown;
    for (const id of hand) ui.handSelectable.add(id);
    ui.handMulti = !laidDown;

    if (!laidDown) {
      const contract = state.pack.rules.contracts?.[(state.playerVars[HUMAN_SEAT]?.phase ?? 1) - 1] || [];
      ui.hint = `Contract: ${contract.map(describeContractItem).join(' + ')} — select cards to lay down, or discard`;
      if (sel.length && selection.from === handAddr && state.pack.template.arrangeContract) {
        const melds = state.pack.template.arrangeContract(ctx, HUMAN_SEAT, sel);
        if (melds) {
          ui.action = {
            label: 'Lay down',
            makeMove: () => ({ actor: HUMAN_SEAT, type: 'layDown', choice: { melds } }),
          };
        }
      }
    } else {
      ui.hint = 'Hit any meld with a matching card, or discard to end your turn';
    }

    if (sel.length === 1 && selection.from === handAddr) {
      const cardId = sel[0];
      for (const move of humanMoves) {
        if (move.type === 'discard' && move.cards[0] === cardId && !ui.readyTargets.has('discard')) {
          // Enumerated targeted discards (a skip card) arrive with a concrete
          // choice.target baked in — one variant per victim. The tap must NOT
          // inherit one silently; performHumanMove sees the bare move and asks.
          ui.readyTargets.set('discard', { actor: move.actor, type: 'discard', cards: move.cards });
        }
        if (move.type === 'hit' && move.cards[0] === cardId) {
          ui.readyMelds.set(`${move.choice.seat}:${move.choice.meld}`, move);
        }
      }
    } else if (sel.length > 1) {
      // A multi-card selection with no lay-down: still let a plain discard
      // happen the moment the selection shrinks back to one.
    }
    return ui;
  }

  // mode === 'place' (sequencing)
  for (const move of humanMoves) {
    if (move.type !== 'playCard' && move.type !== 'discard') continue;
    const from = move.from;
    if (from === handAddr) ui.handSelectable.add(move.cards[0]);
    else if (from) ui.sourceTops.set(from, move.cards[0]);
    if (sel.length === 1 && selection.from === (from ?? handAddr) && move.cards[0] === sel[0]) {
      ui.readyTargets.set(move.to, move);
    }
  }
  if (!sel.length) ui.hint = 'Play from your stock, hand, or discard piles';
  else if (selection.from === handAddr) ui.hint = 'Tap a build pile to play it — or one of your discard piles to end your turn';
  else ui.hint = 'Tap a build pile to play it';
  return ui;
}

function describeContractItem(item) {
  const m = /^(\w+)\((\d+)\)$/.exec(item || '');
  if (!m) return item;
  if (m[1] === 'set') return `set of ${m[2]}`;
  if (m[1] === 'run') return `run of ${m[2]}`;
  if (m[1] === 'colorGroup') return `${m[2]} of one color`;
  return item;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

// Card SVG is markup this repo authors, with every card-derived value escaped
// inside src/ui/cardStyles — so innerHTML on a fresh node is safe here in a way
// it is NOT for anything carrying a name or a label. Those use textContent.
function svgNode(markup, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.innerHTML = markup;
  return span;
}

// A stable pseudo-random tilt per card. Seeded from the id rather than
// Math.random() so a re-render — a resize, a settings change, a resumed match —
// puts every card back exactly where it was. A discard pile that reshuffles
// its own scatter on every repaint looks broken.
function tiltFor(cardId, spread) {
  let h = 0;
  for (let i = 0; i < cardId.length; i++) h = (h * 31 + cardId.charCodeAt(i)) | 0;
  return ((h % 1000) / 1000) * spread * 2 - spread;
}

/** The consistent "it is this player's turn" token, worn by seats and the action bar. */
function turnToken() {
  const token = document.createElement('span');
  token.className = 'turn-token';
  token.setAttribute('aria-hidden', 'true');
  return token;
}

function line(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/** Zone instances of a definition: 'build' with count 4 -> build.1..build.4. */
function instancesOf(def, seat) {
  const numbers = def.count ? Array.from({ length: def.count }, (_, i) => i + 1) : [null];
  return numbers.map((n) => {
    let addr = n != null ? `${def.id}.${n}` : def.id;
    if (seat != null) addr = `${addr}.${seat}`;
    return { def, n, address: addr };
  });
}

function sharedZoneInstances(state) {
  const out = [];
  for (const def of state.zones.defs.values()) {
    if (def.per === 'player') continue;
    // Hidden shared zones (Stockpile's `recycled`) stay off the table; the
    // draw pile is the one hidden zone that is also a control, so it shows.
    if (def.visibility === 'none' && def.id !== 'draw') continue;
    out.push(...instancesOf(def, null));
  }
  // The deck reads best on the left, whatever order the template declared.
  return out.sort((a, b) => (b.def.id === 'draw') - (a.def.id === 'draw'));
}

function perPlayerZoneInstances(state, seat) {
  const out = [];
  for (const def of state.zones.defs.values()) {
    if (def.per !== 'player' || def.id === 'hand') continue;
    out.push(...instancesOf(def, seat));
  }
  return out;
}

function zoneStackNode(address) {
  return el.screen.querySelector(`[data-zone="${CSS.escape(address)}"]`);
}

function pileLabelText(state, inst) {
  const { def, n, address } = inst;
  const count = state.zones.count(address);
  const base = `${def.label || def.id}${n != null ? ` ${n}` : ''}`;
  if (def.id === 'discard' && def.per !== 'player') {
    // Shedding's discard doubles as the active-state readout after a wild.
    const active = state.vars.activeSuit || state.vars.activeColor;
    if (active) return `Active: ${active}`;
  }
  if (def.id === 'trick') return `${base} (${count})`;
  if (def.capacity != null) return `${base} · ${count}/${def.capacity}`;
  return `${base} (${count})`;
}

/**
 * One pile on the felt, for any zone. Always a <button>: whether it does
 * anything this render is decided by the UI model (a ready target applies its
 * move, a source top picks itself up), and a pile that does neither is simply
 * disabled — same element, same geometry, no relayout when a pile wakes up.
 */
function buildPileNode(state, inst, ui, { mini = false } = {}) {
  const { def, address } = inst;
  const cards = state.zones.cards(address);
  const count = cards.length;
  const wrap = document.createElement('div');
  wrap.className = `pile ${mini ? 'pile--mini' : ''}`;

  const stack = document.createElement('button');
  stack.type = 'button';
  stack.className = 'pile-stack';
  stack.dataset.zone = address;

  const target = ui.readyTargets.get(address) || null;
  const sourceTop = !target && ui.sourceTops.has(address) ? ui.sourceTops.get(address) : null;
  const isSpread = def.layout === 'spread' || def.id === 'trick';
  const faceDown = def.facing === 'down' || def.visibility === 'none';

  stack.classList.toggle('pile-stack--deep', count > 2);
  stack.classList.toggle('pile-stack--spread', isSpread && !mini);
  stack.classList.toggle('pile-stack--ready', !!target);
  stack.classList.toggle('pile-stack--source', !!sourceTop);
  stack.classList.toggle('pile-stack--picked', !!sourceTop && isSelected(address, sourceTop));

  if (faceDown) {
    stack.appendChild(count > 0
      ? svgNode(cardArt.back(), 'pile-stack__top')
      : svgNode('<div class="card-face card-face--empty"></div>', 'pile-stack__top'));
  } else if (isSpread && !mini) {
    // A trick is not a pile: every card in it is live information about who
    // played what, so it spreads and shows the whole trick.
    const visible = cards.slice(-state.seats);
    visible.forEach((cardId, i) => {
      const card = cardById(state, cardId);
      if (!card) return;
      const isTop = i === visible.length - 1;
      const node = svgNode(cardArt.face(card), `pile-stack__card ${isTop ? 'pile-stack__top' : ''}`);
      node.style.setProperty('--stack-index', String(i - (visible.length - 1) / 2));
      node.style.setProperty('--stack-tilt', `${tiltFor(cardId, 7).toFixed(2)}deg`);
      stack.appendChild(node);
    });
    if (!visible.length) stack.appendChild(svgNode('<div class="card-face card-face--empty"></div>', 'pile-stack__top'));
  } else {
    // A face-up pile keeps a few cards of HISTORY under the top one, stacked —
    // a pile that only ever shows one card reads as a slide viewer.
    const visible = cards.slice(mini ? -1 : -DISCARD_DEPTH);
    visible.forEach((cardId, i) => {
      const card = cardById(state, cardId);
      if (!card) return;
      const isTop = i === visible.length - 1;
      const node = svgNode(cardArt.face(card), `pile-stack__card ${isTop ? 'pile-stack__top' : ''}`);
      node.style.setProperty('--stack-index', String(i - (visible.length - 1) / 2));
      node.style.setProperty('--stack-tilt', `${tiltFor(cardId, isTop ? 2 : 5).toFixed(2)}deg`);
      stack.appendChild(node);
    });
    if (!visible.length) stack.appendChild(svgNode('<div class="card-face card-face--empty"></div>', 'pile-stack__top'));
  }

  const labelText = pileLabelText(state, inst);

  if (target) {
    stack.disabled = false;
    const verb = target.type === 'draw' ? 'Draw a card from'
      : target.type === 'discard' ? 'Discard to'
        : 'Play your selected card onto';
    stack.setAttribute('aria-label', `${verb} ${labelText}.`);
    stack.addEventListener('click', () => liveState && performHumanMove(liveState, target, stack));
  } else if (sourceTop) {
    stack.disabled = false;
    stack.setAttribute('aria-label', `${labelText}: pick up the top card to play it.`);
    stack.addEventListener('click', () => {
      if (!liveState) return;
      selection = isSelected(address, sourceTop) ? null : { from: address, cardIds: [sourceTop] };
      render(liveState);
    });
  } else {
    stack.disabled = true;
    stack.setAttribute('aria-label', `${labelText}.`);
  }

  if (!mini) {
    const label = document.createElement('div');
    label.className = 'pile-count';
    label.textContent = labelText;
    wrap.appendChild(stack);
    wrap.appendChild(label);
  } else {
    stack.setAttribute('title', labelText);
    wrap.appendChild(stack);
  }
  return wrap;
}

// Per-seat meld groupings mirror the template's playerVar bookkeeping: the
// stored [{item, cards}] when a lay-down recorded one, else the whole zone as
// one group (the same fallback contract-rummy's getMeldGroups applies).
function meldGroupsOf(state, seat) {
  const stored = state.playerVars[seat]?.melds;
  if (stored) return stored;
  const addr = `melds.${seat}`;
  if (!state.zones.has(addr)) return [];
  const cards = state.zones.cards(addr);
  return cards.length ? [{ item: null, cards: cards.slice() }] : [];
}

/** A seat's laid-down melds as tappable chips — the hit targets. */
function buildMeldStrip(state, seat, ui, { mini = false } = {}) {
  const strip = document.createElement('div');
  strip.className = `meld-strip ${mini ? 'meld-strip--mini' : ''}`;
  strip.dataset.zone = `melds.${seat}`;
  const groups = meldGroupsOf(state, seat);
  groups.forEach((group, i) => {
    const move = ui.readyMelds.get(`${seat}:${i}`) || null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `meld-chip ${move ? 'meld-chip--ready' : ''}`;
    for (const cardId of group.cards) {
      const card = cardById(state, cardId);
      if (card) chip.appendChild(svgNode(cardArt.face(card), 'meld-chip__card'));
    }
    const what = group.item ? describeContractItem(group.item) : 'meld';
    if (move) {
      chip.disabled = false;
      chip.setAttribute('aria-label', `${seatLabel(seat)}'s ${what}, ${group.cards.length} cards. Add your selected card.`);
      chip.addEventListener('click', () => liveState && performHumanMove(liveState, move, chip));
    } else {
      chip.disabled = true;
      chip.setAttribute('aria-label', `${seatLabel(seat)}'s ${what}, ${group.cards.length} cards.`);
    }
    strip.appendChild(chip);
  });
  return strip;
}

/** Hearts' point total taken so far — worth a chip on the won pile. */
function wonPointsText(state, seat) {
  const addr = `won.${seat}`;
  if (!state.zones.has(addr) || !state.pack.scoring?.cardValues) return null;
  const cards = state.zones.cards(addr).map((id) => cardById(state, id)).filter(Boolean);
  const pts = handValue(cards, state.pack.scoring);
  return pts > 0 ? `${pts} pts` : null;
}

function renderSeats(state, stagger, acting, ui) {
  el.opponentsTop.replaceChildren();
  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    if (seat === HUMAN_SEAT) continue;
    const count = state.zones.count(`hand.${seat}`);
    const active = acting.includes(seat);

    const wrap = document.createElement('div');
    wrap.className = `seat ${active ? 'seat--active' : ''}`;
    wrap.dataset.seat = String(seat);

    const head = document.createElement('div');
    head.className = 'seat__head';

    if (active) head.appendChild(turnToken());

    const avatar = document.createElement('span');
    avatar.className = 'seat__avatar';
    avatar.style.background = SEAT_COLORS[seat % SEAT_COLORS.length];
    // textContent, not innerHTML. The label is literal today, but the instant
    // it becomes Arcade.player.name() or a peer name (Phase 8) an interpolated
    // template string is the peer-name XSS this fleet has shipped twice
    // (GAME_INTEGRATION §7b).
    avatar.textContent = seatLabel(seat).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
    head.appendChild(avatar);

    const name = document.createElement('span');
    name.className = 'seat__name';
    name.textContent = seatLabel(seat);
    head.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'seat__count';
    badge.textContent = String(count);
    // The visible badge is a bare number, which reads as nothing on its own.
    badge.setAttribute('aria-label', `${count} cards${active ? '. Their turn.' : ''}`);
    head.appendChild(badge);

    wrap.appendChild(head);

    const mini = document.createElement('div');
    mini.className = 'mini-hand';
    for (let i = 0; i < count; i++) {
      const back = svgNode(cardArt.back(), stagger ? 'card-deal' : '');
      if (stagger) back.style.animationDelay = `${i * 35}ms`;
      mini.appendChild(back);
    }
    wrap.appendChild(mini);

    // The seat's own piles, compact: a Stockpile stock and discards, laid-down
    // melds (live hit targets), a Hearts won pile with the points it holds.
    const zones = perPlayerZoneInstances(state, seat);
    if (zones.length) {
      const strip = document.createElement('div');
      strip.className = 'seat__zones';
      for (const inst of zones) {
        if (inst.def.id === 'melds') {
          strip.appendChild(buildMeldStrip(state, seat, ui, { mini: true }));
        } else if (inst.def.visibility === 'none') {
          const pts = inst.def.id === 'won' ? wonPointsText(state, seat) : null;
          const chip = line('seat__pilechip', `${inst.def.label || inst.def.id} ${state.zones.count(inst.address)}${pts ? ` · ${pts}` : ''}`);
          chip.dataset.zone = inst.address;
          strip.appendChild(chip);
        } else {
          strip.appendChild(buildPileNode(state, inst, ui, { mini: true }));
        }
      }
      wrap.appendChild(strip);
    }

    el.opponentsTop.appendChild(wrap);
  }
}

function renderCenterZones(state, ui) {
  el.centerPiles.replaceChildren();
  for (const inst of sharedZoneInstances(state)) {
    el.centerPiles.appendChild(buildPileNode(state, inst, ui));
  }
}

function renderPlayerZones(state, ui) {
  el.playerPiles.replaceChildren();
  for (const inst of perPlayerZoneInstances(state, HUMAN_SEAT)) {
    if (inst.def.id === 'melds') {
      el.playerPiles.appendChild(buildMeldStrip(state, HUMAN_SEAT, ui));
    } else if (inst.def.visibility === 'none') {
      // The human's own hidden pile (a Hearts won pile): a face-down pile with
      // its count — and its cost, when the pack scores what it holds.
      const pts = inst.def.id === 'won' ? wonPointsText(state, HUMAN_SEAT) : null;
      const pile = buildPileNode(state, inst, ui);
      if (pts) pile.querySelector('.pile-count').textContent = `${pileLabelText(state, inst)} · ${pts}`;
      el.playerPiles.appendChild(pile);
    } else {
      el.playerPiles.appendChild(buildPileNode(state, inst, ui));
    }
  }
}

function renderHand(state, ui, stagger) {
  el.hand.replaceChildren();
  const handAddr = `hand.${HUMAN_SEAT}`;
  const hand = state.zones.cards(handAddr);
  const committedPass = state.playerVars[HUMAN_SEAT]?.__pendingPass;
  hand.forEach((cardId, i) => {
    const card = cardById(state, cardId);
    const selectable = ui.handSelectable.has(cardId);
    const selected = isSelected(handAddr, cardId) || (committedPass || []).includes(cardId);
    const wrapper = svgNode(cardArt.face(card),
      `card-face-wrap ${selectable ? '' : 'card-face--disabled'} ${stagger ? 'card-deal' : ''} ${selected ? 'card-face-wrap--selected' : ''}`);
    if (stagger) wrapper.style.animationDelay = `${i * 35}ms`;
    wrapper.querySelector('svg').classList.toggle('card-face--disabled', !selectable);
    if (selectable) {
      wrapper.classList.add('card-face-wrap--playable');
      wrapper.addEventListener('click', () => onHandCard(state, cardId, card, wrapper, ui));
    }
    el.hand.appendChild(wrapper);
  });
}

function renderActionBar(state, ui, humanActs) {
  const waitingOnPass = interactionMode(state) === 'pass'
    && !humanActs && !state.gameOver
    && state.playerVars[HUMAN_SEAT]?.__pendingPass !== undefined;
  const hint = humanActs ? ui.hint : (waitingOnPass ? 'Waiting for the other players to pass…' : '');
  el.actionBar.hidden = !hint;
  el.actionBar.classList.toggle('action-bar--acting', humanActs);
  el.actionHint.textContent = hint;
  if (ui.action && humanActs) {
    el.actionButton.hidden = false;
    el.actionButton.textContent = ui.action.label;
    el.actionButton.onclick = () => {
      if (!liveState) return;
      const move = ui.action.makeMove();
      performHumanMove(liveState, move, el.actionButton);
    };
  } else {
    el.actionButton.hidden = true;
    el.actionButton.onclick = null;
  }
}

function showGameOver(state) {
  el.gameOverFan.replaceChildren();
  for (const face of heroFaces(state.pack)) {
    el.gameOverFan.appendChild(svgNode(cardArt.face(face), 'game-over-fan__card'));
  }
  el.gameOverMessage.textContent = state.winner === HUMAN_SEAT
    ? 'You win! \u{1F389}'
    : `${seatLabel(state.winner)} wins.`;
  const record = readStats(state.pack.id);
  el.gameOverRecord.textContent = record.played
    ? `${record.won} of ${record.played} in ${state.pack.manifest.name}.`
    : '';
  el.gameOverOverlay.classList.toggle('game-over--won', state.winner === HUMAN_SEAT);
  el.gameOverOverlay.hidden = false;
}

/** Display-only faces from the manifest; see schema `heroCards`. */
function heroFaces(pack) {
  const faces = pack.manifest.heroCards;
  return Array.isArray(faces) ? faces.slice(0, 3) : [];
}

function statusTextFor(state, acting) {
  if (state.gameOver) return `Game over — ${seatLabel(state.winner)} wins!`;
  if (state.turn.phase === 'pass') {
    return acting.includes(HUMAN_SEAT) ? 'Passing — your pick' : 'Waiting for passes…';
  }
  return acting.includes(HUMAN_SEAT) ? 'Your turn' : `${seatLabel(state.turn.seat)}'s turn`;
}

function render(state, message) {
  pruneSelection(state);
  const acting = actingSeatsOf(state);
  const humanActs = acting.includes(HUMAN_SEAT);
  const humanMoves = humanActs ? enumerateLegalMoves(state, HUMAN_SEAT) : [];
  const ui = buildUiModel(state, humanMoves, humanActs);
  const stagger = dealAnimation && motionAllowed();

  el.statusText.textContent = statusTextFor(state, acting);
  el.status.classList.toggle('status-bar--your-turn', humanActs);
  el.status.classList.toggle('status-bar--thinking', !state.gameOver && !humanActs);

  renderSeats(state, stagger, acting, ui);
  renderCenterZones(state, ui);
  renderPlayerZones(state, ui);
  renderHand(state, ui, stagger);
  renderActionBar(state, ui, humanActs);
  dealAnimation = false;

  // A game-ending move can arrive with no message (the human's own winning play) or a
  // stale one from the mover ("Bot 2 played" right before Bot 2's own hand emptied) —
  // gameOver always wins the log line over whatever was passed in.
  if (state.gameOver) {
    el.log.textContent = `${seatLabel(state.winner)} wins!`;
    showGameOver(state);
  } else if (message) {
    el.log.textContent = message;
  }
}

/* ------------------------------------------------------------------ *
 * Geometry for card travel
 * ------------------------------------------------------------------ */

function rectOf(node) {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.width ? r : null;
}

/** Where a seat's cards live on screen — the source or target of a card in flight. */
function seatRect(seat) {
  if (seat === HUMAN_SEAT) return rectOf(el.hand);
  return rectOf(el.opponentsTop.querySelector(`[data-seat="${seat}"] .mini-hand`));
}

/**
 * A card-sized rectangle centred on `rect`. flyCard scales its copy to the
 * destination's width, which is right when the destination IS a card — and
 * comically wrong when it is a whole fanned hand, where the copy would balloon
 * to the hand's full width mid-flight.
 */
function cardSizedRect(rect, width) {
  if (!rect) return null;
  const height = width * 1.4;
  return {
    left: rect.left + rect.width / 2 - width / 2,
    top: rect.top + rect.height / 2 - height / 2,
    width,
    height,
  };
}

function zoneRect(address) {
  const node = zoneStackNode(address);
  if (!node) return null;
  return rectOf(node.querySelector?.('.pile-stack__top') || node) || rectOf(node);
}

/** The zone a played/discarded card visibly lands in, for the flight target. */
function landingZone(state, move) {
  if (move.to) return move.to;
  if (move.type === 'discard') return 'discard';
  if (state.zones.has('trick')) return 'trick';
  if (state.zones.has('discard')) return 'discard';
  return null;
}

/**
 * Send a copy of the moved card across the table, then reveal where it landed.
 *
 * Called after the reducer and the re-render, with `from` captured before
 * them — by which point the source card is already gone, which is exactly why
 * a copy flies instead of the card itself.
 */
function animateMove(state, move, from) {
  if (!from) return;
  if (move.type === 'draw') {
    // A draw has no single landing slot in a fanned hand, so it dissolves on
    // arrival rather than pretending to become a particular card. The human's
    // own draw is face-up because they are about to see it anyway.
    const to = cardSizedRect(seatRect(move.actor), from.width);
    const card = move.actor === HUMAN_SEAT
      ? cardById(state, state.zones.cards(`hand.${HUMAN_SEAT}`).at(-1) || '')
      : null;
    flyCard(card ? cardArt.face(card) : cardArt.back(), from, to, { fade: true });
    return;
  }
  if (move.type === 'hit') {
    const card = cardById(state, move.cards?.[0]);
    const to = cardSizedRect(zoneRect(`melds.${move.choice?.seat}`), from.width);
    if (card && to) flyCard(cardArt.face(card), from, to, { fade: true });
    return;
  }
  if (move.type !== 'playCard' && move.type !== 'discard') return;
  const card = cardById(state, move.cards && move.cards[0]);
  if (!card) return;
  const address = landingZone(state, move);
  if (!address) return;
  const node = zoneStackNode(address);
  const topNode = node ? node.querySelector('.pile-stack__top') : null;
  landOn(topNode, flyCard(cardArt.face(card), from, rectOf(topNode) || zoneRect(address)));
}

/* ------------------------------------------------------------------ *
 * Table moments: banners, trick gathers, round summaries
 * ------------------------------------------------------------------ */

function hideBanner() {
  if (bannerTimer) bannerTimer.cancel();
  bannerTimer = null;
  el.eventBanner.hidden = true;
}

/**
 * The celebration layer. Decorative by construction — #log (a live region)
 * carries the same sentence — so it is aria-hidden and free to be theatrical.
 * `tone` is 'good' | 'bad' | 'neutral': winning a clean trick sparkles, eating
 * the queen of spades stings, a bot's trick just gets noted.
 */
function showBanner(text, tone) {
  if (bannerTimer) bannerTimer.cancel();
  el.eventBanner.textContent = text;
  el.eventBanner.className = `event-banner event-banner--${tone}`;
  el.eventBanner.hidden = false;
  // Restart the entrance animation when banners come back-to-back.
  void el.eventBanner.offsetWidth;
  el.eventBanner.classList.add('event-banner--in');
  const myEpoch = epoch;
  bannerTimer = Arcade.session.setTimeout(() => {
    bannerTimer = null;
    if (myEpoch !== epoch) return;
    el.eventBanner.hidden = true;
  }, 2200);
}

/**
 * A trick resolving: gather its cards to the winner's seat, say what it cost,
 * and celebrate — or wince. The engine already moved the cards (they left the
 * trick zone before this render), so the gather flies COPIES from where the
 * trick was to where it went, the same clone-and-animate deal every card
 * flight uses.
 */
function celebrateTrick(state, ev) {
  const mine = ev.seat === HUMAN_SEAT;
  const bad = mine && ev.points > 0;

  const from = zoneRect('trick');
  const to = from ? cardSizedRect(seatRect(ev.seat), from.width * 0.6) : null;
  if (from && to && motionAllowed()) {
    const myEpoch = epoch;
    ev.cards.forEach((cardId, i) => {
      const card = cardById(state, cardId);
      if (!card) return;
      Arcade.session.setTimeout(() => {
        if (myEpoch !== epoch) return;
        flyCard(cardArt.face(card), from, to, { fade: true, duration: 320 });
      }, 140 + i * 70);
    });
  }

  const text = mine
    ? (ev.points > 0 ? `You take the trick — ${ev.points} point${ev.points === 1 ? '' : 's'} against you` : 'Trick is yours — no points')
    : `${seatLabel(ev.seat)} takes the trick${ev.points > 0 ? ` (+${ev.points})` : ''}`;
  showBanner(text, mine ? (bad ? 'bad' : 'good') : 'neutral');
  el.log.textContent = text;
  playTrickTaken({ bad });

  const seatNode = el.opponentsTop.querySelector(`[data-seat="${ev.seat}"]`);
  const pulseTarget = mine ? el.hand : seatNode;
  if (pulseTarget) {
    pulseTarget.classList.remove('zone-celebrate', 'zone-lament');
    void pulseTarget.offsetWidth;
    pulseTarget.classList.add(bad ? 'zone-lament' : 'zone-celebrate');
  }
}

/** The score sheet between rounds. Bot turns stay parked until it is dismissed. */
function showRoundSummary(state, ev) {
  el.roundTitle.textContent = `Round ${ev.round} over`;
  el.roundScores.replaceChildren();
  for (let s = 0; s < state.seats; s++) {
    const delta = ev.scores[s] ?? 0;
    const row = document.createElement('div');
    row.className = `round-scores__row ${s === HUMAN_SEAT ? 'round-scores__row--you' : ''}`;
    row.appendChild(line('round-scores__name', seatLabel(s)));
    row.appendChild(line('round-scores__delta', delta > 0 ? `+${delta}` : `${delta}`));
    row.appendChild(line('round-scores__total', `${ev.totals[s]}`));
    el.roundScores.appendChild(row);
  }
  el.roundContinue.textContent = `Deal round ${state.roundNumber}`;
  el.roundOverlay.hidden = false;
}

function dismissRoundSummary() {
  if (el.roundOverlay.hidden || !liveState) return;
  el.roundOverlay.hidden = true;
  dealAnimation = true;
  playDeal(SEAT_COUNT);
  render(liveState, `Round ${liveState.roundNumber}.`);
  scheduleNextTurn(liveState, epoch);
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function persistMatch() {
  if (!liveState) return;
  matchDirty = false;
  saveMatch(liveState);
}

/** Synchronous by construction — onSuspend calls this directly (§6b). */
export function flushTable() {
  if (matchDirty) persistMatch();
}

/* ------------------------------------------------------------------ *
 * Applying moves
 * ------------------------------------------------------------------ */

// The one place a move reaches the engine, so the sound of a move cannot drift
// from the fact of it. `far` is the opponent-vs-you signal the pack carries in
// space rather than timbre (js/soundpack.js).
//
// A reshuffle is no longer inferred from pile counts: the engine's reactions
// announce themselves on state.events (src/engine/state.js), and 'recycled'
// during a move IS the shuffle, whoever's move surfaced it.
function applyStateChange(state, move, { far }) {
  applyMove(state, move);
  if (move.type === 'draw') playDraw();
  else playCardPlayed({ far });
  if (state.events.some((e) => e.type === 'recycled')) playShuffle();
}

// Every applied move funnels through here, whoever made it. Keeping the
// render/persist/schedule trio in one place is what stops a new move type from
// silently skipping the save — and it is where the move's event window
// (state.events) becomes table moments: a trick gathered, a round scored.
function afterMove(state, move, from, message) {
  const events = state.events;
  const trick = events.find((e) => e.type === 'trickWon');
  const passed = events.find((e) => e.type === 'cardsPassed');
  const roundOver = events.find((e) => e.type === 'roundOver' && !e.over);

  if (state.gameOver) {
    matchDirty = false;
    // A finished match is not something to resume into.
    clearMatch(state.pack.id);
    // Before the render, so the overlay can show the updated record — this
    // game's counters are ours to display (§4: `stats` is the surface whose
    // formatting the game owns).
    recordResult(state.pack.id, { won: state.winner === HUMAN_SEAT });
    render(state, message);
    animateMove(state, move, from);
    if (trick) celebrateTrick(state, trick);
    playWin();
    return;
  }

  if (passed && !message) message = 'Cards passed. Play!';
  render(state, message);
  animateMove(state, move, from);
  if (trick) celebrateTrick(state, trick);
  persistMatch();

  if (roundOver) {
    // The engine has already dealt the next round beneath this move; the
    // summary sits on top of the fresh deal and bot play waits for its
    // dismissal. A beat of delay lets a closing trick's gather land first.
    const myEpoch = epoch;
    Arcade.session.setTimeout(() => {
      if (myEpoch !== epoch) return;
      showRoundSummary(state, roundOver);
    }, trick ? 900 : 250);
    return;
  }

  scheduleNextTurn(state, epoch);
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

function needsChoice(card) {
  const effect = card.effect;
  if (!effect || typeof effect === 'string') return null;
  return effect.choose || null;
}

/**
 * Ask for a suit or colour (or a player, for targeted effects), or null if
 * the player backs out.
 *
 * Cancellable on purpose. Tapping a wild used to be an irreversible commitment
 * to a modal with no way out, and closing the table under an open prompt left
 * the awaiting handler holding a promise that could still resolve into a match
 * that was no longer on screen.
 */
async function promptChoice(attr, options) {
  el.choicePrompt.textContent = `Choose a ${attr}`;
  el.choicePanel.replaceChildren();
  el.choiceModal.hidden = false;
  return new Promise((resolve) => {
    const close = (value) => {
      cancelPendingChoice = null;
      el.choiceModal.hidden = true;
      resolve(value);
    };
    cancelPendingChoice = () => close(null);
    el.choiceCancel.onclick = () => close(null);
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.textContent = opt;
      // §7b: this value reaches an inline style. A colour keyword or hex
      // literal is all a pack has any reason to supply.
      const asColour = (attr === 'color' || attr === 'suit') && safeCssColor(opt);
      btn.className = `choice-option ${asColour ? 'choice-option--swatch' : ''}`;
      if (asColour) btn.style.background = asColour;
      btn.addEventListener('click', () => close(opt));
      el.choicePanel.appendChild(btn);
    }
  });
}

function closeChoiceModal() {
  if (cancelPendingChoice) cancelPendingChoice();
  el.choiceModal.hidden = true;
}

/**
 * The single gate between a human tap and the engine, whatever dressed the
 * move up (a hand card, a pile, a meld chip, the action button). Fills in any
 * choice the move still owes — a discard that skips a player asks who —
 * validates, and hands off to the shared apply/render/persist path.
 */
async function performHumanMove(state, move, sourceNode) {
  const myEpoch = epoch;

  if (move.type === 'discard' && move.cards) {
    const card = cardById(state, move.cards[0]);
    const effect = card?.effect;
    if (effect?.type === 'skipTarget' && effect.on === 'discard' && move.choice?.target === undefined) {
      const others = [];
      for (let s = 0; s < state.seats; s++) if (s !== HUMAN_SEAT) others.push(s);
      const picked = await promptChoice('player to skip', others.map((s) => seatLabel(s)));
      if (picked === null || myEpoch !== epoch) return;
      move = { ...move, choice: { ...(move.choice || {}), target: others[others.map((s) => seatLabel(s)).indexOf(picked)] } };
    }
  }

  const check = validateMove(state, move);
  if (!check.legal) {
    playInvalid();
    render(state, `Can't do that: ${check.reason}`);
    return;
  }
  const from = rectOf(sourceNode) || (move.from ? zoneRect(move.from) : null) || seatRect(HUMAN_SEAT);
  selection = null;
  applyStateChange(state, move, { far: false });
  afterMove(state, move, from);
}

/** A tap on one of the human's own hand cards, interpreted per the UI model. */
async function onHandCard(state, cardId, card, sourceNode, ui) {
  const handAddr = `hand.${HUMAN_SEAT}`;

  if (ui.mode === 'tap') {
    // One tap plays it — the destination is implicit. Wilds ask their question
    // first, exactly as before.
    const myEpoch = epoch;
    let choice;
    const attr = needsChoice(card);
    if (attr) {
      const options =
        attr === 'suit'
          ? ['clubs', 'diamonds', 'hearts', 'spades']
          : [...new Set([...state.pack.cardsById.values()].map((c) => c.color).filter(Boolean))];
      const picked = await promptChoice(attr, options);
      // Backed out, or the table closed while the prompt was open — either way
      // this move belongs to a match that is no longer the one on screen.
      if (picked === null || myEpoch !== epoch) return;
      choice = { [attr]: picked };
    }
    performHumanMove(state, { actor: HUMAN_SEAT, type: 'playCard', cards: [cardId], choice }, sourceNode);
    return;
  }

  // Selection modes: toggle membership (multi) or replace (single).
  if (selection && selection.from !== handAddr) selection = null;
  if (ui.handMulti) {
    const ids = selection ? selection.cardIds.slice() : [];
    const at = ids.indexOf(cardId);
    if (at !== -1) ids.splice(at, 1);
    else ids.push(cardId);
    selection = ids.length ? { from: handAddr, cardIds: ids } : null;
  } else {
    selection = isSelected(handAddr, cardId) ? null : { from: handAddr, cardIds: [cardId] };
  }
  render(state);
}

function scheduleNextTurn(state, myEpoch) {
  if (state.gameOver) return;
  if (!actingSeatsOf(state).some((s) => s !== HUMAN_SEAT)) return;
  // Arcade.session.setTimeout, not setTimeout: it freezes while the frame is
  // suspended (§6c — forgotten timers are the #1 battery drain in a hidden
  // iframe) and cancels itself when a save import replaces state. The epoch
  // guard is still needed for "Play again" and for leaving to the lobby, which
  // the SDK knows nothing about.
  botTimer = Arcade.session.setTimeout(() => {
    botTimer = null;
    if (myEpoch !== epoch) return; // superseded — drop the stale turn
    const seat = actingSeatsOf(state).find((s) => s !== HUMAN_SEAT);
    if (seat === undefined) return; // the human became the only one who may act
    const move = chooseBotMove(state, seat);
    if (!move) return;
    const from = move.type === 'draw'
      ? (zoneRect(move.from ?? 'draw') || seatRect(seat))
      : seatRect(seat);
    applyStateChange(state, move, { far: true });
    afterMove(state, move, from, `${seatLabel(seat)} ${BOT_VERBS[move.type] || 'played'}.`);
  }, settings.botDelayMs);
}

const BOT_VERBS = {
  draw: 'drew',
  playCard: 'played',
  discard: 'discarded',
  passCards: 'passed',
  layDown: 'laid down their contract',
  hit: 'hit a meld',
  pass: 'passed the turn',
};

function cancelBotTurn() {
  if (botTimer) botTimer.cancel();
  botTimer = null;
}

/* ------------------------------------------------------------------ *
 * Match lifecycle
 * ------------------------------------------------------------------ */

function adoptMatch(pack, state, message) {
  epoch += 1;
  livePack = pack;
  liveState = state;
  selection = null;
  // Before the first render, and from the PACK rather than the manifest alone:
  // the deck is what tells a style which colours it actually has to draw.
  cardArt = makeCardRenderer(pack.manifest, pack.cardsById);
  el.gameOverOverlay.hidden = true;
  el.roundOverlay.hidden = true;
  hideBanner();
  render(state, message);
  persistMatch();
  scheduleNextTurn(state, epoch);
}

function startGame(pack) {
  cancelBotTurn();
  // Date.now() is only the entropy source. The seed itself is persisted with
  // the match from the first write, which is what makes the log replayable
  // (src/engine/replay.js) rather than merely re-runnable.
  const state = createState({ pack, seats: SEAT_COUNT, seed: Date.now() });
  pack.template.setup(makeCtx(state));
  dealAnimation = true;
  playDeal(SEAT_COUNT);
  adoptMatch(state.pack, state, `Playing ${pack.manifest.name}.`);
}

/**
 * Open `packId`'s table: resume its saved match when there is one, deal a
 * fresh game when there is not.
 *
 * Every entry to the table goes through here — a lobby tap, a `?pack=` deep
 * link, and a save import (`onStateReplaced` is a fresh boot by contract, §3).
 */
export async function openTable(packId) {
  const myToken = ++openToken;
  cancelBotTurn();
  closeChoiceModal();
  matchDirty = false;

  // The pack has to be fetched before anything can be drawn, and the chrome
  // would otherwise keep the PREVIOUS game's name on screen while it lands.
  el.gameName.textContent = '';
  el.statusText.textContent = 'Dealing…';

  // A stored match pins the variant set: the same pack loaded with different
  // variants is a different rule set, and replaying a log against it diverges.
  const stored = loadMatch(packId);
  const pack = await fetchPack(packId, stored ? stored.variants : undefined);
  if (myToken !== openToken) return; // the player left before the pack landed

  rememberPack(packId);
  Arcade.ui.setTitle(`Cardstock — ${pack.manifest.name}`);
  el.gameName.textContent = pack.manifest.name;
  el.gameOverOverlay.hidden = true;

  if (stored) {
    try {
      const state = rehydrateMatch(pack, stored);
      if (!state.gameOver) {
        adoptMatch(pack, state, `Resumed ${pack.manifest.name}.`);
        return;
      }
    } catch (err) {
      // A pack whose rules moved under a stored log. Losing one match is the
      // right cost; resuming into a state the current rules could never have
      // produced is not.
      console.warn('[cardstock] could not replay the stored match, starting fresh', err);
    }
    clearMatch(packId);
  }
  startGame(pack);
}

/**
 * Leave the table. The match keeps its place in storage; nothing about it
 * keeps running.
 */
export function closeTable() {
  openToken += 1;          // abandon any open still in flight
  epoch += 1;              // and any bot turn already scheduled
  cancelBotTurn();
  closeChoiceModal();
  flushTable();
  liveState = null;
  livePack = null;
  selection = null;
  hideBanner();
  el.gameOverOverlay.hidden = true;
  el.roundOverlay.hidden = true;
}

export function isTableOpen() {
  return liveState !== null;
}

/** Re-render in place — onResume, and after a settings change. */
export function rerenderTable() {
  settings = loadSettings();
  if (liveState) render(liveState);
}

export function initTable({ onExit }) {
  exitToLobby = onExit;
  settings = loadSettings();

  el.playAgainButton.addEventListener('click', () => livePack && startGame(livePack));
  el.lobbyButton.addEventListener('click', () => exitToLobby());
  el.gameOverLobbyButton.addEventListener('click', () => exitToLobby());
  el.roundContinue.addEventListener('click', () => dismissRoundSummary());
}

/** Surface a boot/open failure on the table's own log line. */
export function reportTableError(message) {
  el.log.textContent = message;
}
