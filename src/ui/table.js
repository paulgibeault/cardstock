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
// INPUT IS MOVE-DRIVEN, IN TWO DRESSINGS. enumerateLegalMoves is the single
// source of what the human may do; the UI's job is to dress those moves as
// taps AND as drops. Both ask src/ui/interaction.js the same question and get
// moves that already enumerated as legal, so a dragged card can no more
// construct an illegal play than a tapped one could. Tap-only remains a
// complete path (design doc §12) — drag is an enhancement layered over it,
// which is why no tap handler changed when it arrived.
//
// WHAT THIS MODULE NO LONGER DOES. The pure "what may I do" model lives in
// src/ui/interaction.js, the overlays in src/ui/panels.js, the pointer
// choreography in src/ui/dragController.js, and who-is-who in
// src/players/roster.js. What is left here is the felt itself: piles, seats,
// the hand, and the loop that turns a move into sound, motion and a save.

import { createState } from '../engine/state.js';
import { makeCtx } from '../engine/context.js';
import { validateMove, applyMove, enumerateLegalMoves } from '../engine/movePipeline.js';
import { rehydrateMatch, serializeMatch } from '../engine/replay.js';
import { chooseBotMove } from '../engine/bot.js';
import { baseId } from '../engine/selectors.js';
import { handValue } from '../engine/scoring.js';
import { buildSeating, thinkTimeMs } from '../players/roster.js';
import { computeMatchStats, placements } from '../stats/matchStats.js';
import { makeCardRenderer } from './cardStyles/index.js';
import { fetchPack } from './packSource.js';
import { flyCard, landOn, motionAllowed, flightLayer } from './flight.js';
import { safeCssColor } from './css.js';
import { closeConfirm, confirmAction } from './confirm.js';
import { createDragController } from './dragController.js';
import { attachInspector, hideInspector } from './inspector.js';
import {
  describeCard, describeZone, cardAriaLabel, zoneAriaLabel, zoneBadge, cardName,
} from './describe.js';
import {
  interactionMode, stagingPhase, buildUiModel, dropCandidates, draggableSources, pruneSelection,
  isSelected, handAddress, implicitLandingZone, smartSelection, ladderRungs,
  describeContractItem, describeContract, shortContract,
} from './interaction.js';
import {
  orderHand, reorder, nextMode, isSortMode, fanStep, classifyHandGesture, SORT_LABELS,
} from './handOrder.js';
import {
  initPanels, showRoundSummary, hideRoundSummary, isRoundSummaryOpen,
  showScoreboard, showGameOver, hideAllPanels, showRules, awaitFinalLook,
} from './panels.js';
import { packRules } from './rules.js';
import {
  rememberPack, loadSettings, saveMatch, loadMatch, clearMatch, recordResult, readStats,
  loadHandPrefs, saveHandPrefs,
} from '../arcade/storage.js';
import {
  playDeal, playCardPlayed, playDraw, playShuffle, playInvalid, playWin, playTrickTaken,
  playAnnouncement, playActionCard,
} from '../arcade/audio.js';

const HUMAN_SEAT = 0;
// The table's own default when nothing asks for anything else — a deep link,
// a resumed match with its own seat count, a pack whose minimum is higher.
// The new-game sheet (src/ui/newGame.js) is what usually decides this now.
const SEAT_COUNT = 3;

/** Clamp a requested seat count to what the pack says it can seat. */
function seatsFor(pack, requested) {
  const players = pack.manifest.players || {};
  const min = players.min ?? 2;
  const max = players.max ?? 8;
  const want = Number.isFinite(requested) ? requested : SEAT_COUNT;
  return Math.max(min, Math.min(max, want));
}

/** How many discards stay visible under the top one. Enough to read as a pile. */
const DISCARD_DEPTH = 3;

/** §7b: this value reaches a class name, so it is an allow-list, not a passthrough. */
const OVERLAP_MODES = new Set(['horizontal', 'vertical']);

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
  table: document.getElementById('table'),
  status: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  lobbyButton: document.getElementById('lobby-button'),
  scoreChip: document.getElementById('score-chip'),
  scoreChipValue: document.getElementById('score-chip-value'),
  opponentsTop: document.getElementById('opponents-top'),
  centerPiles: document.getElementById('center-piles'),
  playerPiles: document.getElementById('player-piles'),
  announceBar: document.getElementById('announce-bar'),
  contractLadder: document.getElementById('contract-ladder'),
  actionBar: document.getElementById('action-bar'),
  actionHint: document.getElementById('action-hint'),
  actionButton: document.getElementById('action-button'),
  stageRow: document.getElementById('stage-row'),
  stageTray: document.getElementById('stage-tray'),
  handRow: document.getElementById('hand-row'),
  hand: document.getElementById('hand'),
  handSort: document.getElementById('hand-sort'),
  log: document.getElementById('log'),
  eventBanner: document.getElementById('event-banner'),
  choiceModal: document.getElementById('choice-modal'),
  choiceDialog: document.getElementById('choice-dialog'),
  choiceCard: document.getElementById('choice-card'),
  choicePrompt: document.getElementById('choice-prompt'),
  choicePanel: document.getElementById('choice-options'),
  choiceCancel: document.getElementById('choice-cancel'),
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

// Who is in each seat, for this match (src/players/roster.js). Derived from the
// match SEED, so it survives a resume without being serialized and rotates on
// every fresh deal.
let seating = [];

// The human's tapped-but-not-yet-committed cards: { from: zoneAddress,
// cardIds: [id, ...] }. Multi-card only where a move takes several cards
// (passing, a lay-down); everywhere else it holds exactly one. Cleared on
// every applied move and pruned against the live state on every render, so a
// stale id can never reach a move.
let selection = null;

// How this pack's hand is arranged, and the order actually on screen. Both are
// PRESENTATION (src/ui/handOrder.js): neither ever reaches the engine, so a
// player rearranging their fan cannot change what a move enumerates.
let handPrefs = { mode: 'auto', order: [] };
let displayedHand = [];

// The UI model the CURRENT render was built from. Pile and meld handlers read
// it at click time rather than closing over a move, which is what lets a
// selection change re-arm them without rebuilding the table (renderSelection).
let currentUi = null;

// Pointer choreography for lifting a card (src/ui/dragController.js), created
// once at init. A render that landed mid-drag would replace the very node the
// pointer is holding, so renders are DEFERRED while one is live and replayed
// when it settles.
let drag = null;
let pendingRender = null;

/**
 * The launcher's session clock, in the cancellable-timer shape, with a plain
 * fallback so a module can be exercised without the SDK on the page.
 *
 * Exists so modules that must not import the SDK — dragController.js is
 * game-agnostic by design — can still have their timers freeze with a
 * suspended frame (§6c) rather than burning battery in a hidden iframe.
 */
function sessionSchedule(fn, ms) {
  const session = typeof window !== 'undefined' && window.Arcade && window.Arcade.session;
  if (session && typeof session.setTimeout === 'function') return session.setTimeout(fn, ms);
  const id = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(id) };
}

// Announcement beats (§E2) — a bot remembering to declare, or noticing that
// you did not. Timers, so they are cancelled on every path that closes or
// replaces the table, exactly like the bot-turn timer.
let announceTimers = [];
// One roll per vulnerability window, not one per re-render: without this a bot
// gets a fresh chance to remember every time anybody moves, and
// `callReliability` silently becomes 1.
const botCallDecision = new Map();
const botCatchDecision = new Map();

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

/**
 * The player's own display name, from the arcade-wide identity — the same one
 * a peer will see when Phase 8 lands (§17.4), which is why it is read here
 * rather than invented. Never interpolated into markup; it reaches the DOM
 * only as textContent, through the roster.
 */
function humanName() {
  try {
    return (window.Arcade && Arcade.player && Arcade.player.name()) || '';
  } catch {
    return '';
  }
}

function identityOf(seat) {
  return seating[seat] || { seat, name: `Seat ${seat}`, icon: '', color: '#6b7280', isBot: seat !== HUMAN_SEAT };
}

/** The name to put in a sentence about a seat. */
function seatLabel(seat) {
  const identity = identityOf(seat);
  return seat === HUMAN_SEAT ? 'You' : identity.name;
}

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

/** What a seat may SAY right now, out of turn (§E2). Never enumerated as a play. */
function announcementsFor(state, seat) {
  const template = state.pack.template;
  if (!template.enumerateAnnouncements) return [];
  return template.enumerateAnnouncements(makeCtx(state), seat) || [];
}

/**
 * How a zone's visible cards are laid out, from the pack's `ui.zoneOverlap`.
 *
 * PRESENTATION, so it lives in `ui` rather than in the engine's zone def: how
 * far a discard pile fans says nothing about the rules, and putting it in `ui`
 * means a variant can change it with a one-line manifest patch
 * (`"ui.zoneOverlap.discard": "vertical"`) instead of restating a whole zone
 * definition. Allow-listed on the way out — the value reaches a class name.
 */
function overlapFor(state, def) {
  const declared = state.pack.manifest.ui?.zoneOverlap?.[def.id];
  return OVERLAP_MODES.has(declared) ? declared : null;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

// Card SVG is markup this repo authors, with every card-derived value escaped
// inside src/ui/cardStyles — so innerHTML on a fresh node is safe here in a way
// it is NOT for anything carrying a name or a label. Those use textContent.
//
// PARSED ONCE PER DISTINCT CARD, NOT ONCE PER APPEARANCE. cardArt memoizes the
// markup STRING, but innerHTML still ran the HTML parser every time — and a
// render rebuilds every card on the table, so a four-handed rummy table paid
// for 60-100 parses on every tap. A <template> holds the parsed result and
// cloneNode copies it, which is the same work the browser does for a repeated
// element and a great deal less than re-reading the text.
//
// Keyed by the markup itself, so two cards that look identical (every card
// back in the deck) share one entry and a change of card style simply misses
// the old keys — adoptMatch clears it anyway when the renderer is rebuilt.
const svgTemplates = new Map();

function svgNode(markup, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  let template = svgTemplates.get(markup);
  if (!template) {
    template = document.createElement('template');
    template.innerHTML = markup;
    svgTemplates.set(markup, template);
  }
  span.appendChild(template.content.cloneNode(true));
  return span;
}

/**
 * Which cards were on the felt at the end of the last render.
 *
 * `.card-face--fresh` is opt-in per card because the table rebuilds its DOM
 * wholesale: without this every card is a new element every render and replays
 * the settle-in, so one bot move makes the whole table twitch. This started as
 * a hand-only set, which fixed the loudest case but not the only one: a pile's
 * top card, an opponent's fan and a laid-down meld are rebuilt on exactly the
 * same schedule and were all still replaying it. One set of keys now covers
 * every card the table draws.
 *
 * Keys are strings the renderers make up, not bare card ids, because not
 * everything that arrives is a card with an id: an opponent's nth face-down
 * back is `back:2:7`, and the same card in a different pile has genuinely
 * arrived somewhere and should say so.
 */
let shownCardKeys = new Set();
let enteringKeys = null;

/** Note `key` as present, and mark `node` as fresh if it was not before. */
function markEntry(node, key) {
  if (!enteringKeys) return node;
  enteringKeys.add(key);
  if (shownCardKeys.has(key)) return node;
  const face = node.querySelector('.card-face') || node.firstElementChild;
  if (face) face.classList.add('card-face--fresh');
  return node;
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

function meldChipNode(meldKey) {
  return el.screen.querySelector(`[data-meld="${CSS.escape(meldKey)}"]`);
}

/**
 * Paint what a pile currently OFFERS: a place to put the selected card, a top
 * card to pick up, or nothing.
 *
 * Split out of buildPileNode because this is the only part of a pile that a
 * selection changes. Everything else about it — the cards, the depth cue, the
 * badge — is the same before and after, so re-running it in place is what lets
 * a tap on a hand card stop rebuilding the table (renderSelection).
 *
 * Reads the label off the node rather than the state: the accessible name's
 * subject is fixed by the zone, and only the verb in front of it moves.
 */
function paintPileState(stack, ui) {
  const address = stack.dataset.zone;
  const ariaLabel = stack.dataset.zoneLabel || '';
  const target = ui.readyTargets.get(address) || null;
  const sourceTop = !target && ui.sourceTops.has(address) ? ui.sourceTops.get(address) : null;

  stack.classList.toggle('pile-stack--ready', !!target);
  stack.classList.toggle('pile-stack--source', !!sourceTop);
  stack.classList.toggle('pile-stack--picked', !!sourceTop && isSelected(selection, address, sourceTop));

  if (target) {
    const verb = target.type === 'draw' ? 'Draw a card from'
      : target.type === 'discard' ? 'Discard to'
        : 'Play your selected card onto';
    stack.disabled = false;
    stack.setAttribute('aria-label', `${verb} ${ariaLabel}`);
  } else if (sourceTop) {
    stack.disabled = false;
    stack.setAttribute('aria-label', `${ariaLabel} Pick up the top card to play it.`);
  } else {
    stack.disabled = true;
    stack.setAttribute('aria-label', ariaLabel);
  }
}

/** The same, for a meld chip: whether the selected card extends this meld. */
function paintMeldState(chip, ui) {
  const move = ui.readyMelds.get(chip.dataset.meld) || null;
  const label = chip.dataset.meldLabel || '';
  chip.classList.toggle('meld-chip--ready', !!move);
  chip.disabled = !move;
  chip.setAttribute('aria-label', move ? `${label} Add your selected card.` : label);
}

/**
 * One pile on the felt, for any zone. Always a <button>: whether it does
 * anything this render is decided by the UI model (a ready target applies its
 * move, a source top picks itself up), and a pile that does neither is simply
 * disabled — same element, same geometry, no relayout when a pile wakes up.
 *
 * The pile's WORDS live in its accessible name and its inspector panel; what
 * is printed on the felt is a count badge (src/ui/describe.js explains why the
 * split is that way round and not the other).
 */
function buildPileNode(state, inst, ui, { mini = false, draggableTop = null } = {}) {
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
  // A pile whose contract is "only the top card is public" must not leak the
  // ones under it. It used to draw DISCARD_DEPTH real faces for depth, which
  // showed Stockpile players the next three cards of everybody's discards.
  const secretUnder = def.visibility === 'top';
  const overlap = mini ? null : overlapFor(state, def);

  stack.classList.toggle('pile-stack--deep', count > 2);
  stack.classList.toggle('pile-stack--spread', isSpread && !mini);
  if (overlap) {
    stack.classList.add(`pile-stack--overlap-${overlap === 'vertical' ? 'v' : 'h'}`);
    // How many card-widths the slot RESERVES — a constant, not the count on
    // hand. See .pile-stack--overlap-v in table.css: a pile that resized as it
    // filled re-centred every other pile in its row on every discard.
    stack.style.setProperty('--overlap-slots', String(DISCARD_DEPTH - 1));
  }

  /** Place one card in the stack, carrying its index for the overlap offsets. */
  const placeCard = (markup, i, visibleCount, cardId, isTop) => {
    const node = svgNode(markup, `pile-stack__card ${isTop ? 'pile-stack__top' : ''}`);
    // Keyed by zone as well as card: the same card arriving in a DIFFERENT
    // pile has entered that pile, which is the moment worth animating.
    markEntry(node, `${address}:${cardId}`);
    node.style.setProperty('--stack-index', String(i - (visibleCount - 1) / 2));
    node.style.setProperty('--overlap-index', String(i));
    if (cardId) node.style.setProperty('--stack-tilt', `${tiltFor(cardId, isTop ? 2 : 5).toFixed(2)}deg`);
    stack.appendChild(node);
    return node;
  };

  let topNode = null;
  if (faceDown) {
    topNode = svgNode(count > 0
      ? cardArt.back()
      : '<div class="card-face card-face--empty"></div>', 'pile-stack__top');
    // A face-down pile is one node whatever its depth, so the thing that
    // "enters" is the pile going from empty to not.
    markEntry(topNode, `${address}:down:${count > 0}`);
    stack.appendChild(topNode);
  } else if (isSpread && !mini) {
    // A trick is not a pile: every card in it is live information about who
    // played what, so it spreads and shows the whole trick.
    const visible = cards.slice(-state.seats);
    visible.forEach((cardId, i) => {
      const card = cardById(state, cardId);
      if (!card) return;
      const isTop = i === visible.length - 1;
      const node = placeCard(cardArt.face(card), i, visible.length, cardId, isTop);
      node.style.setProperty('--stack-tilt', `${tiltFor(cardId, 7).toFixed(2)}deg`);
      if (isTop) topNode = node;
    });
    if (!visible.length) stack.appendChild(svgNode('<div class="card-face card-face--empty"></div>', 'pile-stack__top'));
  } else {
    // A face-up pile keeps a few cards of HISTORY under the top one, stacked —
    // a pile that only ever shows one card reads as a slide viewer. On a
    // top-visible pile that history is drawn as BACKS: the depth is public,
    // the cards are not.
    const depth = mini ? 1 : DISCARD_DEPTH;
    const visible = cards.slice(-depth);
    visible.forEach((cardId, i) => {
      const isTop = i === visible.length - 1;
      const card = cardById(state, cardId);
      if (!card) return;
      const markup = (!isTop && secretUnder) ? cardArt.back() : cardArt.face(card);
      const node = placeCard(markup, i, visible.length, cardId, isTop);
      if (isTop) topNode = node;
    });
    if (!visible.length) stack.appendChild(svgNode('<div class="card-face card-face--empty"></div>', 'pile-stack__top'));
  }

  stack.dataset.zoneLabel = zoneAriaLabel(state, inst);

  // LATE-BOUND, and bound unconditionally. The handler asks the current UI
  // model what this pile does at the moment it is clicked instead of closing
  // over the move that happened to be ready when it was built — which is what
  // lets a selection change re-arm every pile in place (paintPileState) rather
  // than rebuilding the whole table to change which ones glow.
  stack.addEventListener('click', () => {
    if (!liveState || !currentUi) return;
    const move = currentUi.readyTargets.get(address);
    if (move) {
      performHumanMove(liveState, move, stack);
      return;
    }
    const top = currentUi.sourceTops.get(address);
    if (top === undefined) return;
    selection = isSelected(selection, address, top) ? null : { from: address, cardIds: [top] };
    renderSelection(liveState);
  });
  paintPileState(stack, ui);

  // Any face-up top card the human owns lifts, whether or not it has anywhere
  // to go — a refused drop simply snaps home. That is the "cards on felt"
  // feel, and it is also how a player LEARNS what is legal.
  if (draggableTop && topNode && drag) {
    drag.attach(topNode, { kind: 'pile', from: address, cardId: draggableTop });
  }

  attachInspector(stack, () => (liveState ? describeZone(liveState, inst) : null),
    { isBusy: () => !!drag && drag.isDragging() });

  wrap.appendChild(stack);
  if (!mini) {
    const badge = document.createElement('div');
    badge.className = 'pile-count';
    // The words moved to the accessible name and the inspector; what is left
    // on the felt is the number you actually watch.
    const { text: badgeText, kind, suit } = zoneBadge(state, inst);
    badge.textContent = badgeText;
    if (kind === 'match') {
      // THE SUIT IN FORCE IS NOT A PILE LABEL, so it does not get a pile
      // label's voice. It is the rule every hand at the table is playing to,
      // and after an eight it is the ONLY place that rule is written — the
      // card underneath shows the suit it was, not the suit it chose. Big
      // glyph, suit-inked, no pill. See .pile-count--match.
      badge.classList.add('pile-count--match');
      // dataset, and only for a suit describe.js recognised: a pack's own var
      // never reaches an attribute the stylesheet then matches on (§7b).
      if (suit) badge.dataset.suit = suit;
    }
    // The badge already carries the suit or the word for an active colour
    // (zoneBadge); this adds the swatch, and only in the case a card cannot
    // show for itself. Said aloud by describeZone's note, which reaches the
    // pile's own name.
    const active = activeMatchTint(state, address);
    if (active) {
      badge.classList.add('pile-count--active-match');
      if (active.tint) badge.style.setProperty('--active-tint', active.tint);
    }
    badge.setAttribute('aria-hidden', 'true');
    wrap.appendChild(badge);
  }
  return wrap;
}

/**
 * The colour the table is matching on when the top card cannot say it itself.
 *
 * There is exactly one case and it is the most consequential card in the game:
 * a wild sits on the discard showing no colour at all, while what every hand
 * now has to match is a value living in a var. zoneBadge already writes
 * the WORD there (describe.js) — this is what turns that word into something
 * readable at a glance, which for a colour is a swatch.
 *
 * Returns null when the top card carries the attribute itself, so the badge
 * stays a plain word on an ordinary play and the swatch means "a wild chose
 * this" rather than merely "this pile is a discard".
 */
function activeMatchTint(state, address) {
  if (address !== 'discard' || !state.zones.has('discard')) return null;
  const matchOn = state.pack.rules?.matchOn;
  if (!Array.isArray(matchOn)) return null;
  const topId = state.zones.top('discard');
  const card = topId ? cardById(state, topId) : null;
  if (!card) return null;

  for (const attr of matchOn) {
    if (card[attr] !== null && card[attr] !== undefined) continue; // the card says it
    const value = state.vars[`active${attr[0].toUpperCase()}${attr.slice(1)}`];
    if (value === undefined || value === null) continue;
    // Through the pack's palette and safeCssColor: pack data reaching a style
    // property (§7b). A pack with no palette entry for this value still gets
    // the word, just without the dot.
    //
    // `cardArt.theme.palette`, not `cardArt.palette` — the renderer exposes its
    // resolved theme, and the shorter spelling was undefined, so this swatch
    // never once appeared. Same typo, same silent nothing, in flashFelt.
    return { attr, value, tint: safeCssColor(cardArt.theme.palette?.[value]) };
  }
  return null;
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

/**
 * How a card in a laid-down meld reads.
 *
 * A wild on the felt is not a wild any more — it is the card it was played
 * as, and the meld records which (`group.wilds`). Saying so is the difference
 * between a run a player can read and one they have to reconstruct, and it is
 * the only place the frozen value is visible: the card art still shows a wild,
 * because that is the card that will go back in the box.
 */
function meldCardName(group, cardId, card) {
  const pinned = group.wilds?.[cardId];
  const value = pinned?.rank ?? pinned?.color;
  return value === undefined ? cardName(card) : `${cardName(card)} — played as ${value}`;
}

/**
 * A seat's laid-down melds as chips — the hit targets, and the single most
 * useful piece of public information on the table.
 *
 * Each chip carries the cards AND a caption naming the requirement they
 * satisfied. The cards alone cannot say that: three 7s and three 7s are two
 * different rungs of the ladder depending on the contract that asked for them,
 * and an opponent's laid-down phase is exactly what you plan your own turn
 * around.
 */
function buildMeldStrip(state, seat, ui, { mini = false } = {}) {
  const strip = document.createElement('div');
  strip.className = `meld-strip ${mini ? 'meld-strip--mini' : ''}`;
  strip.dataset.zone = `melds.${seat}`;
  const groups = meldGroupsOf(state, seat);
  const owner = seat === HUMAN_SEAT ? 'Your' : `${identityOf(seat).name}'s`;

  groups.forEach((group, i) => {
    const meldKey = `${seat}:${i}`;
    const move = ui.readyMelds.get(meldKey) || null;
    const what = group.item ? describeContractItem(group.item) : 'meld';

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'meld-chip';
    chip.dataset.meld = meldKey;

    const cards = document.createElement('span');
    cards.className = 'meld-chip__cards';
    for (const cardId of group.cards) {
      const card = cardById(state, cardId);
      if (card) cards.appendChild(svgNode(cardArt.face(card), 'meld-chip__card'));
    }
    chip.appendChild(cards);
    chip.appendChild(line('meld-chip__label', what));

    chip.dataset.meldLabel = `${owner} ${what}, ${group.cards.length} cards.`;
    // Late-bound for the same reason the piles are — see paintPileState.
    chip.addEventListener('click', () => {
      const ready = currentUi && currentUi.readyMelds.get(meldKey);
      if (ready && liveState) performHumanMove(liveState, ready, chip);
    });
    paintMeldState(chip, ui);

    // Reading a meld card by card is the thing a squeezed strip made
    // impossible, so the inspector spells the whole thing out.
    attachInspector(chip, () => ({
      title: `${owner} ${what}`,
      lines: group.cards
        .map((cardId) => ({ cardId, card: cardById(state, cardId) }))
        .filter((entry) => entry.card)
        .map((entry, n) => ({
          label: `Card ${n + 1}`,
          value: meldCardName(group, entry.cardId, entry.card),
        })),
      notes: move ? ['Your selected card extends this meld — tap to play it.'] : [],
    }), { isBusy: () => !!drag && drag.isDragging() });

    strip.appendChild(chip);
  });
  return strip;
}

/**
 * The contract ladder: every rung of the race, and who is standing on it.
 *
 * Contract-rummy's per-player progression is the whole game (design doc
 * §13.3) and it used to be a two-character chip on a name plate — you could
 * see that Nell was on "Ph 3" but not what phase 3 asks for, how many rungs
 * are left, or how far ahead of you she is. Data-driven, so it appears for any
 * pack declaring `rules.contracts` and stays hidden for everything else.
 *
 * Rungs carry the SHORT form (`S3+R4`) with a one-line key, and hovering gives
 * the sentence — the same words-versus-badge split the pile labels use.
 */
/**
 * How many ladder rungs the row can hold at this width.
 *
 * Read from the same breakpoints table.css sizes the rungs at, rather than
 * measured: a measurement here would be a forced layout on every render, and
 * the widths that matter are exactly the ones the stylesheet already names.
 * A desktop row fits the whole course, so it gets it — truncation is a
 * response to a narrow screen, not the ladder's preference.
 */
function ladderBudget() {
  if (typeof window.matchMedia !== 'function') return 5;
  if (window.matchMedia('(max-width: 420px)').matches) return 5;
  if (window.matchMedia('(max-width: 720px)').matches) return 7;
  return Infinity;
}

function renderContractLadder(state) {
  const contracts = state.pack.rules.contracts;
  if (!Array.isArray(contracts) || !contracts.length) {
    el.contractLadder.hidden = true;
    el.contractLadder.replaceChildren();
    return;
  }

  const minePhase = state.playerVars[HUMAN_SEAT]?.phase ?? null;
  el.contractLadder.replaceChildren();

  // Which rungs survive the squeeze, and where the collapsed runs go — see
  // ladderRungs in src/ui/interaction.js for what may be dropped and why.
  const occupied = [];
  for (let seat = 0; seat < state.seats; seat++) {
    const phase = state.playerVars[seat]?.phase ?? null;
    if (phase) occupied.push(phase);
  }

  for (const entry of ladderRungs(contracts.length, { minePhase, occupied, maxRungs: ladderBudget() })) {
    if (entry.kind === 'gap') {
      const span = entry.to - entry.from + 1;
      const where = span === 1 ? `Contract ${entry.from}` : `Contracts ${entry.from}–${entry.to}`;
      const gap = document.createElement('div');
      gap.className = 'ladder__gap';
      gap.appendChild(line('ladder__gap-mark', '⋯'));

      // ANYONE THE SQUEEZE HID IS DRAWN HERE. Collapsing a rung is only safe
      // because the players standing on it come with it — "who is behind me"
      // survives at coarser resolution rather than vanishing.
      const inside = [];
      for (let seat = 0; seat < state.seats; seat++) {
        const phase = state.playerVars[seat]?.phase ?? null;
        if (phase === null || phase < entry.from || phase > entry.to) continue;
        const identity = identityOf(seat);
        inside.push(identity);
        const pip = document.createElement('span');
        pip.className = 'ladder__pip ladder__pip--tucked';
        pip.style.background = identity.color;
        pip.textContent = identity.icon || identity.initials;
        pip.setAttribute('aria-hidden', 'true');
        gap.appendChild(pip);
      }

      const names = inside.map((i) => (i.seat === HUMAN_SEAT ? 'you' : i.name));
      gap.setAttribute('aria-label', `${where}.`
        + (names.length ? ` On them: ${names.join(', ')}.` : ' Nobody is on them.'));
      attachInspector(gap, () => ({
        title: where,
        lines: contracts.slice(entry.from - 1, entry.to).map((items, n) => ({
          label: String(entry.from + n), value: describeContract(items),
        })),
        notes: names.length ? [`Currently on these: ${names.join(', ')}.`] : ['Nobody is on these yet.'],
      }), { isBusy: () => !!drag && drag.isDragging() });
      el.contractLadder.appendChild(gap);
      continue;
    }

    const phase = entry.phase;
    const items = contracts[phase - 1];
    const rung = document.createElement('div');
    const mine = phase === minePhase;
    rung.className = `ladder__rung ${mine ? 'ladder__rung--mine' : ''} `
      + `${minePhase && phase < minePhase ? 'ladder__rung--past' : ''}`;

    rung.appendChild(line('ladder__no', String(phase)));
    rung.appendChild(line('ladder__req', shortContract(items)));

    const who = document.createElement('div');
    who.className = 'ladder__who';
    const here = [];
    for (let seat = 0; seat < state.seats; seat++) {
      if ((state.playerVars[seat]?.phase ?? null) !== phase) continue;
      const identity = identityOf(seat);
      here.push(identity);
      const pip = document.createElement('span');
      pip.className = 'ladder__pip';
      // Roster colour — an own value, never a manifest one (§7b).
      pip.style.background = identity.color;
      pip.textContent = identity.icon || identity.initials;
      pip.setAttribute('aria-hidden', 'true');
      who.appendChild(pip);
    }
    rung.appendChild(who);

    const names = here.map((i) => (i.seat === HUMAN_SEAT ? 'you' : i.name));
    rung.setAttribute('aria-label',
      `Contract ${phase} of ${contracts.length}: ${describeContract(items)}.`
      + (names.length ? ` On it: ${names.join(', ')}.` : ' Nobody is on it.'));

    attachInspector(rung, () => ({
      title: `Contract ${phase}`,
      lines: items.map((item, n) => ({ label: `Part ${n + 1}`, value: describeContractItem(item) })),
      notes: names.length
        ? [`Currently on it: ${names.join(', ')}.`]
        : ['Nobody is on this contract.'],
    }), { isBusy: () => !!drag && drag.isDragging() });

    el.contractLadder.appendChild(rung);
  }

  el.contractLadder.appendChild(line('ladder__key', 'S set · R run · C colour'));
  el.contractLadder.hidden = false;
}

/** Hearts' point total taken so far — worth a chip on the won pile. */
function wonPointsText(state, seat) {
  const addr = `won.${seat}`;
  if (!state.zones.has(addr) || !state.pack.scoring?.cardValues) return null;
  const cards = state.zones.cards(addr).map((id) => cardById(state, id)).filter(Boolean);
  const pts = handValue(cards, state.pack.scoring);
  return pts > 0 ? `${pts} pts` : null;
}

/** Does this pack keep a running score worth showing on the felt? */
function showsScores(state) {
  return state.pack.scoring?.accumulate === true
    || state.scores.some((n) => n !== 0);
}

function seatScoreChip(state, seat) {
  const chip = document.createElement('span');
  chip.className = 'seat__score';
  const phase = state.playerVars[seat]?.phase;
  // Contract rummy's "score" that matters is the contract you have reached;
  // the points are the tiebreak. Show what the player is actually racing.
  const text = typeof phase === 'number' ? `Ph ${phase}` : `${state.scores[seat]}`;
  chip.textContent = text;
  chip.setAttribute('aria-label', typeof phase === 'number'
    ? `on contract ${phase}, ${state.scores[seat]} points`
    : `${state.scores[seat]} points`);
  return chip;
}

/**
 * Which way play is going, for packs where that can change.
 *
 * Only rendered once a reverse has actually happened — `state.direction` is 1
 * in every game that never turns round, and a permanent arrow saying "play
 * goes left" on a table that has no other option is chrome that teaches
 * nothing. It appears the moment a reverse lands and then stays, which is
 * exactly when a player needs to be able to check.
 */
function directionBadge(state) {
  if (state.direction >= 0) return null;
  const badge = document.createElement('div');
  badge.className = 'direction-badge';
  badge.textContent = '↺';
  badge.setAttribute('aria-label', 'Play has reversed — it now goes to the right');
  return badge;
}

// How many opponent plates fit on one line before they have to give things up.
// Measured in seats rather than pixels because the plates are all the same
// width: the mini-hand closes its own fan to a fixed cap (see .mini-hand), so
// a seat holding seventeen cards is exactly as wide as one holding two.
const COMPACT_FROM_SEATS = 4;
const TIGHT_FROM_SEATS = 6;

function renderSeats(state, stagger, acting, ui) {
  el.opponentsTop.replaceChildren();
  // One row, always — see .opponent-row. Past these counts the seats that are
  // not acting shed their card fan, then their names, so the row narrows
  // instead of wrapping and stealing the felt's height.
  const opponents = state.seats - 1;
  el.opponentsTop.classList.toggle('opponent-row--compact', opponents >= COMPACT_FROM_SEATS);
  el.opponentsTop.classList.toggle('opponent-row--tight', opponents >= TIGHT_FROM_SEATS);
  const reversed = directionBadge(state);
  if (reversed) el.opponentsTop.appendChild(reversed);
  const scored = showsScores(state);
  // Hoisted out of the seat loop: the answer does not depend on the seat, and
  // enumerating announcements builds a fresh engine context every time. Asking
  // once per opponent and throwing all but one answer away cost N contexts per
  // render for a list that is the same list N times over.
  const challenges = humanAnnouncements(state).filter((a) => a.type === 'challenge');
  for (let seat = 0; seat < state.seats; seat++) {
    if (seat === HUMAN_SEAT) continue;
    const identity = identityOf(seat);
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
    // Own value from the roster, never a manifest one — this reaches an
    // inline style (§7b).
    avatar.style.background = identity.color;
    // textContent, not innerHTML: the instant a name arrives from a peer,
    // an interpolated template string is the XSS this fleet has shipped
    // twice (GAME_INTEGRATION §7b).
    avatar.textContent = identity.icon || identity.initials;
    avatar.setAttribute('aria-hidden', 'true');
    head.appendChild(avatar);

    const name = document.createElement('span');
    name.className = 'seat__name';
    name.textContent = identity.name;
    head.appendChild(name);

    if (scored) head.appendChild(seatScoreChip(state, seat));

    const badge = document.createElement('span');
    badge.className = 'seat__count';
    badge.textContent = String(count);
    // The visible badge is a bare number, which reads as nothing on its own.
    badge.setAttribute('aria-label', `${count} cards${active ? '. Their turn.' : ''}`);
    head.appendChild(badge);

    wrap.appendChild(head);

    // Who this opponent IS, on hover — the personality is only playable if it
    // is legible.
    attachInspector(wrap, () => ({
      title: `${identity.icon} ${identity.name}`.trim(),
      lines: [
        { label: 'Cards', value: String(count) },
        { label: 'Score', value: String(state.scores[seat]) },
      ],
      notes: identity.tagline ? [identity.tagline] : [],
    }), { isBusy: () => !!drag && drag.isDragging() });

    // THE OPPONENT'S HAND, DRAWN AS WHAT IS ACTUALLY VISIBLE OF IT.
    //
    // `--mini-step` closes this fan to as little as a fifth of a card, so all
    // but the rightmost back is covered to within a few pixels of its left
    // edge — white paper margin, then the printed panel, and nothing else.
    // Drawing a full back for the covered ones meant rasterising up to ninety
    // vector lines apiece to fill that sliver, for every card in every
    // opponent's hand, on every render. Two opponents holding seventeen cards
    // is a couple of thousand invisible line segments per frame, and it is why
    // a phone dropped frames on a table nothing was even moving on.
    //
    // So the covered ones are a box in the pack's own panel colour (see
    // .mini-hand__edge in table.css) and the one card you can genuinely see is
    // the real thing. Pixel-identical where it counts.
    const mini = document.createElement('div');
    mini.className = 'mini-hand';
    // The count is all the CSS needs to close the fan to a fixed width — see
    // .mini-hand in table.css for why a seat's geometry must not track how
    // many cards it holds. Deliberately not measured here: the card width is a
    // breakpoint-driven custom property, so the arithmetic belongs where that
    // property is defined rather than in a second copy that can drift from it.
    mini.style.setProperty('--mini-count', String(count));
    mini.style.setProperty('--back-panel', cardArt.backPanel);
    for (let i = 0; i < count; i++) {
      const last = i === count - 1;
      const node = last
        ? svgNode(cardArt.back(), stagger ? 'card-deal' : '')
        : document.createElement('span');
      if (!last) {
        if (stagger) node.className = 'card-deal';
        const edge = document.createElement('span');
        edge.className = 'mini-hand__edge';
        node.appendChild(edge);
      }
      markEntry(node, `back:${seat}:${i}`);
      if (stagger) node.style.animationDelay = `${i * 35}ms`;
      mini.appendChild(node);
    }
    // Decorative, and now genuinely unreadable: the covered cards are boxes
    // with nothing to announce. No loss — the fan was announcing "Face-down
    // card" once per card, thirteen times in a row, next to a count badge that
    // already says "13 cards" in one breath.
    mini.setAttribute('aria-hidden', 'true');
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

    // The catch affordance (§E2) lives on the seat it accuses, which is the
    // only place it reads as "you — you never said it".
    const catchMove = challenges.find((a) => a.target === seat);
    if (catchMove) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'seat__catch';
      button.textContent = 'Catch!';
      button.setAttribute('aria-label', `Catch ${identity.name} — they never declared their last card.`);
      button.addEventListener('click', () => liveState && performAnnouncement(liveState, catchMove));
      wrap.appendChild(button);
    }

    el.opponentsTop.appendChild(wrap);
  }
}

function renderCenterZones(state, ui, draggable) {
  el.centerPiles.replaceChildren();
  for (const inst of sharedZoneInstances(state)) {
    el.centerPiles.appendChild(buildPileNode(state, inst, ui, {
      draggableTop: draggable.piles.get(inst.address) || null,
    }));
  }
}

function renderPlayerZones(state, ui, draggable) {
  el.playerPiles.replaceChildren();
  for (const inst of perPlayerZoneInstances(state, HUMAN_SEAT)) {
    if (inst.def.id === 'melds') {
      el.playerPiles.appendChild(buildMeldStrip(state, HUMAN_SEAT, ui));
    } else if (inst.def.visibility === 'none') {
      // The human's own hidden pile (a Hearts won pile): a face-down pile with
      // its count — and its cost, when the pack scores what it holds.
      const pts = inst.def.id === 'won' ? wonPointsText(state, HUMAN_SEAT) : null;
      const pile = buildPileNode(state, inst, ui);
      if (pts) pile.querySelector('.pile-count').textContent = pts;
      el.playerPiles.appendChild(pile);
    } else {
      el.playerPiles.appendChild(buildPileNode(state, inst, ui, {
        draggableTop: draggable.piles.get(inst.address) || null,
      }));
    }
  }
}

/**
 * Which of the hand's cards are waiting in the tray rather than in the fan.
 *
 * Only in the modes that gather several cards before committing them — laying
 * down a contract, choosing a pass. Everywhere else a selection is a single
 * card that is about to be played somewhere, and lifting it out of the fan
 * would be motion for a card that is leaving anyway.
 */
function stagedIds(state, ui) {
  if (!ui.handMulti) return [];
  if (!selection || selection.from !== handAddress(HUMAN_SEAT)) return [];
  return selection.cardIds;
}

/**
 * The gathered cards, at readable size, in the order they were picked.
 *
 * This is the answer to "assembling a meld on a phone is too cramped": a
 * ten-card fan gives each card a strip about as wide as a fingertip is
 * accurate, and picking a fourth card out of it after three are already
 * chosen means hitting a sliver whose neighbours look the same. Staged cards
 * LEAVE the fan, so every pick makes the next one easier — the fan re-fans
 * wider on its own — and the meld you have built so far is shown as cards
 * rather than as highlights buried in the row you are trying to read.
 *
 * The tray owns no state. It renders `selection`, and tapping a card in it
 * runs the same toggle a tap in the fan runs.
 */
function renderStageTray(state, ui) {
  const staged = stagedIds(state, ui);
  // The SLOT belongs to the phase, the CONTENTS belong to the human. Gating
  // the row itself on `ui.handMulti` meant it left the felt's flex column
  // every time the answer changed — twice a turn in contract rummy, once the
  // bots start drawing and melding — and took a card's height of table with
  // it (#13). A pack that never stages still gets no row at all.
  el.stageRow.hidden = !stagingPhase(state);
  el.stageRow.classList.toggle('stage-row--empty', !ui.handMulti);
  el.stageRow.inert = !ui.handMulti;
  if (!ui.handMulti) {
    el.stageTray.replaceChildren();
    return;
  }
  el.stageTray.setAttribute('aria-label', staged.length
    ? `Gathered: ${staged.length} cards. Tap one to put it back.`
    : 'Gathered cards appear here.');
  el.stageTray.replaceChildren();
  for (const cardId of staged) {
    const card = cardById(state, cardId);
    if (!card) continue;
    const node = svgNode(cardArt.face(card), 'stage-card');
    node.dataset.cardId = cardId;
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.setAttribute('aria-label', `${cardAriaLabel(card, state.pack)} Gathered. Tap to put it back.`);
    const putBack = () => onHandCard(state, cardId, card, node, ui);
    node.addEventListener('click', putBack);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      putBack();
    });
    attachInspector(node, () => describeCard(card, state.pack),
      { isBusy: () => !!drag && drag.isDragging() });
    el.stageTray.appendChild(node);
  }
}

function renderHand(state, ui, stagger, draggable) {
  el.hand.replaceChildren();
  const handAddr = handAddress(HUMAN_SEAT);
  const engineHand = state.zones.cards(handAddr);
  // The engine's order is dealing order and stays that way; what the player
  // sees is their own arrangement (src/ui/handOrder.js).
  displayedHand = orderHand(engineHand, (id) => cardById(state, id), handPrefs.mode, handPrefs.order);
  const committedPass = state.playerVars[HUMAN_SEAT]?.__pendingPass;

  // Gathered cards are drawn in the tray instead, so the fan holds only what
  // is still to be chosen from. handPrefs.order is NOT touched — a card put
  // back returns to the exact slot it left, because it never left the order.
  const staged = new Set(stagedIds(state, ui));
  const fanned = staged.size ? displayedHand.filter((id) => !staged.has(id)) : displayedHand;

  fanned.forEach((cardId, i) => {
    const card = cardById(state, cardId);
    const selectable = ui.handSelectable.has(cardId);
    const selected = isSelected(selection, handAddr, cardId) || (committedPass || []).includes(cardId);
    // A card you cannot play is DRAWN as one — grey stock, deeper ink, baked
    // into the art (src/ui/cardStyles/shared.js). It used to be the live card
    // under `opacity: 0.78`, which cost a composited layer per unplayable card
    // per frame and faded the rank you are reading to find out why it is
    // unplayable. Only the hand does this: a pile or an opponent's card is not
    // yours to play, so there is nothing for it to say there.
    const wrapper = svgNode(cardArt.face(card, !selectable),
      `card-face-wrap ${selectable ? '' : 'card-face--disabled'} ${stagger ? 'card-deal' : ''} ${selected ? 'card-face-wrap--selected' : ''}`);
    markEntry(wrapper, `hand:${cardId}`);
    wrapper.dataset.cardId = cardId;
    if (stagger) wrapper.style.animationDelay = `${i * 35}ms`;
    const svg = wrapper.querySelector('svg');
    svg.classList.toggle('card-face--disabled', !selectable);

    // Every hand card is reachable by keyboard, playable or not: a card that
    // cannot be focused cannot be inspected, and "why can't I play this?" is
    // a question the disabled ones are the whole reason for.
    wrapper.setAttribute('role', 'button');
    wrapper.tabIndex = 0;
    // "Playable" is the wrong word in a gathering mode — a tap there stages
    // the card, it does not commit it — and off-turn it would be an outright
    // lie, now that a meld can be arranged while the bots think.
    const affordance = !selectable ? ''
      : (ui.handMulti ? ' Tap to gather.' : ' Playable.');
    wrapper.setAttribute('aria-label',
      `${cardAriaLabel(card, state.pack, { position: i + 1, of: fanned.length })}${affordance}`);
    wrapper.setAttribute('aria-pressed', String(!!selected));

    const activate = () => onHandCard(state, cardId, card, wrapper, ui);
    if (selectable) {
      wrapper.classList.add('card-face-wrap--playable');
      wrapper.addEventListener('click', activate);
    }
    wrapper.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (selectable) activate();
    });

    if (draggable.hand.has(cardId) && drag) {
      drag.attach(wrapper, { kind: 'hand', from: handAddr, cardId });
    }
    // Where a hold gathers a meld, it cannot also open the inspector — two
    // things on one gesture, and the one that changes the board must win.
    // The card's description is still on its accessible name, and everywhere
    // outside a rummy lay-down the long press means "what is this?" as before.
    attachInspector(wrapper, () => describeCard(card, state.pack),
      { isBusy: () => (!!drag && drag.isDragging()) || smartSelectArmed() });

    el.hand.appendChild(wrapper);
  });

  el.handSort.textContent = SORT_LABELS[handPrefs.mode] || SORT_LABELS.auto;
  el.handSort.setAttribute('aria-label', `Hand order: ${SORT_LABELS[handPrefs.mode]}. Change it.`);
  el.handSort.hidden = engineHand.length < 2;
  renderStageTray(state, ui);
  layoutHand();
}

/**
 * Tighten the fan until the hand fits the felt.
 *
 * A hand is the one thing on the table whose size the layout cannot choose:
 * the pack decides how many cards you hold, and Milestones deals ten while a
 * phone is 375px wide. Fixed spacing therefore has exactly two failure modes —
 * a hand that runs off both edges, or cards so small they cannot be read — and
 * the fix for both is the same one a real player uses: close the fan.
 *
 * So the SPACING is what flexes, never the card size. Each card keeps its full
 * width and slides further under its neighbour, which is why a squeezed hand
 * still shows every card's rank corner rather than shrinking into unreadable
 * confetti. The floor stops it closing past the point where those corners
 * disappear.
 *
 * Cheap enough to run on every render and every resize: two measurements and
 * one custom property, no relayout of anything else.
 */
function layoutHand() {
  const count = el.hand.childElementCount;
  if (count < 2) {
    el.hand.style.removeProperty('--fan-step');
    return;
  }

  // A row with no width has not been laid out yet — the table screen is still
  // `hidden` at boot, and a suspended launcher frame reports zero for
  // everything. Measuring anyway would compute "no room at all" and pin the
  // fan shut until something else forced a relayout, so the honest move is to
  // leave the CSS fallback in place and wait for the observer below to say the
  // row has a size.
  const rowWidth = el.handRow.clientWidth;
  if (!rowWidth) return;

  const styles = getComputedStyle(el.hand);
  const cardWidth = parseFloat(styles.getPropertyValue('--hand-card-w')) || 70;
  const padding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  // The sort toggle shares the row, so the fan may not have all of it.
  const reserved = el.handSort.hidden ? 0 : el.handSort.offsetWidth + 12;
  const available = Math.max(cardWidth, rowWidth - reserved - padding - 4);

  const step = fanStep({ count, cardWidth, available });
  el.hand.style.setProperty('--fan-step', `${step.toFixed(2)}px`);
}

/**
 * Re-fan whenever the row's width changes, whatever changed it.
 *
 * A ResizeObserver rather than a window `resize` listener because the width
 * that matters is the ROW's, and it moves for reasons the window never hears
 * about: the launcher's font scale, the table screen going from `hidden` to
 * shown at boot, a suspended frame waking up with real geometry. All three
 * previously left the fan at whatever it guessed the first time.
 */
function watchHandWidth() {
  if (typeof ResizeObserver !== 'function') {
    window.addEventListener('resize', () => { if (liveState) layoutHand(); });
    return;
  }
  // Observing the ROW, not the hand: the hand's own width is what layoutHand
  // changes, so watching it would be a feedback loop.
  new ResizeObserver(() => { if (liveState) layoutHand(); }).observe(el.handRow);
}

/**
 * Re-draw the ladder when the window crosses a width where it holds a
 * different number of rungs. Only the ladder: everything else on the felt
 * resizes through CSS variables and needs no help.
 */
function watchLadderWidth() {
  if (typeof window.matchMedia !== 'function') return;
  let budget = ladderBudget();
  const recheck = () => {
    const next = ladderBudget();
    if (next === budget) return;
    budget = next;
    if (liveState) renderContractLadder(liveState);
  };
  for (const query of ['(max-width: 420px)', '(max-width: 720px)']) {
    const mq = window.matchMedia(query);
    if (mq.addEventListener) mq.addEventListener('change', recheck);
    else if (mq.addListener) mq.addListener(recheck);
  }
}

/* ------------------------------------------------------------------ *
 * Reading the fan with a finger
 * ------------------------------------------------------------------ */

/**
 * PEEK: the card under the finger rises out of the fan, before the finger is
 * lifted, and follows the finger along the row.
 *
 * A fan overlaps, so all you can see of most cards is a strip down the left
 * edge — on a phone, thinner than the finger covering it. `:hover` solves this
 * for a mouse and does nothing for a touch, which left the player tapping a
 * sliver and finding out afterwards what they had chosen. Raising on
 * pointerDOWN turns a tap into look-then-commit: what you are on is legible
 * while you are still on it, and sliding to a neighbour costs nothing.
 *
 * Hit-testing is by cached rect, not by event target: touch capture sends
 * every move to the element the press began on, so the target is always the
 * first card. The rects are measured once per press for the same reason the
 * drag controller measures its targets once (issue #6) — the fan does not
 * move while a finger is on it.
 *
 * The visible strip of card i runs from its own left edge to the NEXT card's,
 * because later siblings paint over earlier ones; the last card owns its full
 * width. That is exactly the region the player can see, which is what makes
 * this feel like pointing at the card rather than at a hitbox.
 */
let peek = null;

function paintPeek(wrapper) {
  if (peek && peek.node === wrapper) return;
  if (peek && peek.node) peek.node.classList.remove('card-face-wrap--peek');
  if (peek) peek.node = wrapper;
  if (wrapper) wrapper.classList.add('card-face-wrap--peek');
}

function clearPeek() {
  disarmSmartSelect();
  if (peek && peek.node) peek.node.classList.remove('card-face-wrap--peek');
  peek = null;
}

/* ------------------------------------------------------------------ *
 * Gathering a meld by holding one card
 * ------------------------------------------------------------------ */

/** How long a hold has to last to mean "and the rest of this meld". */
const SMART_SELECT_MS = 500;

/**
 * HOLD A CARD TO GATHER ITS MELD.
 *
 * The last of the three answers to "assembling a meld on a phone is too
 * cramped", and the one that skips the problem rather than easing it: the pack
 * already knows that the two other sevens go with this seven, so picking them
 * out of the fan by hand is work the rules could have done. Hold the seven and
 * the group arrives in the tray.
 *
 * Only where the question means something — a rummy hand still choosing what
 * to lay down. Everywhere else a long press keeps meaning "what is this card?"
 * (src/ui/inspector.js), which the inspector's own veto is told about below.
 *
 * The gathered cards go through the ORDINARY selection, so this can no more
 * construct an illegal lay-down than tapping the same cards could.
 */
function smartSelectArmed() {
  return !!currentUi && currentUi.mode === 'rummy-meld' && currentUi.handMulti;
}

function disarmSmartSelect() {
  if (peek && peek.hold) {
    peek.hold.cancel();
    peek.hold = null;
  }
}

function armSmartSelect(wrapper) {
  if (!smartSelectArmed() || !peek) return;
  peek.hold = sessionSchedule(() => {
    if (!peek) return;
    peek.hold = null;
    const cardId = wrapper.dataset.cardId;
    const next = smartSelection(liveState, HUMAN_SEAT, cardId, selection);
    if (!next) {
      // Nothing in hand goes with it. Say so on the card rather than in words:
      // a group that does not exist is not an error, just an answer.
      wrapper.classList.add('card-face-wrap--nomatch');
      sessionSchedule(() => wrapper.classList.remove('card-face-wrap--nomatch'), 400);
      return;
    }
    const gathered = next.cardIds.length - (selection ? selection.cardIds.length : 0);
    selection = next;
    clearPeek();
    // A full render: the gathered cards leave the fan for the tray.
    render(liveState, `Gathered ${gathered} cards.`);
  }, SMART_SELECT_MS);
}

/** The fan card whose VISIBLE strip contains `clientX`. */
function cardStripAt(clientX) {
  if (!peek || !peek.strips.length) return null;
  const strips = peek.strips;
  if (clientX < strips[0].left) return strips[0].node;
  for (let i = 0; i < strips.length; i++) {
    const right = i + 1 < strips.length ? strips[i + 1].left : strips[i].right;
    if (clientX < right) return strips[i].node;
  }
  return strips[strips.length - 1].node;
}

function watchHandPeek() {
  el.hand.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // Whatever the last press left behind. A pointerup can go missing — the
    // finger leaves the window, a drag takes the gesture over — and a card
    // left raised is a card claiming to be under a finger that is not there.
    clearPeek();
    const wrapper = event.target.closest?.('.card-face-wrap');
    if (!wrapper || !el.hand.contains(wrapper)) return;
    const strips = [...el.hand.children].map((node) => {
      const r = node.getBoundingClientRect();
      return { node, left: r.left, right: r.right };
    });
    peek = { node: null, strips, pointerId: event.pointerId, scrubbed: false, hold: null };
    paintPeek(wrapper);
    armSmartSelect(wrapper);
  });

  el.hand.addEventListener('pointermove', (event) => {
    if (!peek || event.pointerId !== peek.pointerId) return;
    const under = cardStripAt(event.clientX);
    if (under && under !== peek.node) {
      peek.scrubbed = true;
      // The press has become a slide, so it is no longer a hold.
      disarmSmartSelect();
    }
    if (under) paintPeek(under);
  });

  // A scrub that ended on a card other than the one pressed has to activate
  // THAT card: the browser's click will name the press target, which is the
  // whole thing the player was scrubbing away from.
  const finish = (event) => {
    if (!peek || event.pointerId !== peek.pointerId) return;
    const landed = peek.node;
    const scrubbed = peek.scrubbed;
    clearPeek();
    if (!scrubbed || !landed || !liveState || !currentUi) return;
    const cardId = landed.dataset.cardId;
    // Only what a tap could already have done — the same model, the same
    // guard. A scrub is a nicer way to reach a card, never a second rules path.
    if (!currentUi.handSelectable.has(cardId)) return;
    const card = cardById(liveState, cardId);
    if (!card) return;
    swallowClick();
    onHandCard(liveState, cardId, card, landed, currentUi);
  };
  el.hand.addEventListener('pointerup', finish);
  el.hand.addEventListener('pointercancel', () => clearPeek());
}

/**
 * Eat the click that a pointerup is about to fire on the PRESS target.
 * Capturing, so it beats the card's own handler. Same shape and the same
 * reason as the drag controller's — a scrub has already acted, and letting the
 * click through would act again on the wrong card.
 */
function swallowClick() {
  const eat = (event) => {
    event.stopPropagation();
    event.preventDefault();
    window.removeEventListener('click', eat, true);
    timer.cancel();
  };
  window.addEventListener('click', eat, true);
  const timer = sessionSchedule(() => window.removeEventListener('click', eat, true), 400);
}

/**
 * The out-of-turn bar: what the human may declare or call out right now.
 *
 * Rendered from `enumerateAnnouncements` exactly as the action bar is rendered
 * from `enumerateLegalMoves` — the UI never invents an announcement, and a
 * pack that declares none simply gets an empty bar. "Uno" is only the first
 * customer of this surface (§E2).
 */
function humanAnnouncements(state) {
  return announcementsFor(state, HUMAN_SEAT);
}

/**
 * Can this pack ever fill the announce bar?
 *
 * A PROPERTY OF THE PACK, not of the moment — the same question
 * `announcementsFor` asks, asked once so the bar's slot can be reserved for
 * the whole match rather than appearing with the button in it (see the bar's
 * note in src/ui/table.css).
 *
 * The TEMPLATE's hook, deliberately, rather than the rules block a particular
 * template reads: Crazy Eights is a shedding pack with no last-card rule, so
 * it pays a strip of felt for a bar it can never fill. That is the safe way to
 * be wrong. Asking the pack instead would reserve nothing for the next kind of
 * announcement somebody adds, and the table would silently start jumping again
 * — which is the bug this whole surface is here to have fixed (#13).
 */
function packAnnounces(state) {
  return !!state.pack.template.enumerateAnnouncements;
}

function renderAnnounceBar(state) {
  const options = humanAnnouncements(state).filter((a) => a.type === 'announce');
  // `hidden` is now the PACK's answer and nothing else; whether there is
  // anything to say right now is a class, so the bar keeps its slot in the
  // felt's column either way. See #action-bar below for the full story — this
  // is the same bug and the same fix (#13).
  el.announceBar.hidden = !packAnnounces(state);
  el.announceBar.classList.toggle('announce-bar--empty', options.length === 0);
  // The buttons are left standing while the bar fades out, so `inert` is what
  // stops a keyboard or a screen reader reaching a call whose window has
  // already closed — `visibility: hidden` only lands when the fade ends.
  el.announceBar.inert = options.length === 0;
  if (options.length === 0) return;
  el.announceBar.replaceChildren();
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'announce-button';
    // The keyphrase is PACK DATA — a pirate-themed pack says "Avast!" and
    // this code never learns the word.
    button.textContent = option.label || 'Last card!';
    button.addEventListener('click', () => liveState && performAnnouncement(liveState, option));
    el.announceBar.appendChild(button);
  }
}

function renderActionBar(state, ui, humanActs) {
  const waitingOnPass = interactionMode(state) === 'pass'
    && !humanActs && !state.gameOver
    && state.playerVars[HUMAN_SEAT]?.__pendingPass !== undefined;
  const hint = humanActs ? ui.hint : (waitingOnPass ? 'Waiting for the other players to pass…' : '');
  // NOT `hidden`. This bar sits in the felt's flex column, and a bar that
  // leaves the column takes its height with it — which meant the turn cue
  // moved the whole table every time the turn changed hands (#13). It keeps
  // its slot now and only stops being visible; src/ui/table.css holds the
  // reserved height and the reasoning.
  el.actionBar.classList.toggle('action-bar--empty', !hint);
  // Nothing else changes on the way out. The bar keeps its last words and its
  // token while it fades — clearing them first would collapse the pill
  // mid-fade — and `inert` is what makes those leftovers unreachable at once,
  // by keyboard and by screen reader, rather than when the fade ends.
  el.actionBar.inert = !hint;
  if (!hint) {
    el.actionButton.onclick = null;
    return;
  }
  el.actionBar.classList.toggle('action-bar--acting', humanActs);
  el.actionHint.textContent = hint;
  if (ui.action && humanActs) {
    el.actionButton.hidden = false;
    el.actionButton.textContent = ui.action.label;
    el.actionButton.onclick = () => {
      if (!liveState) return;
      performHumanMove(liveState, ui.action.makeMove(), el.actionButton);
    };
  } else {
    el.actionButton.hidden = true;
    el.actionButton.onclick = null;
  }
}

function renderStatusBar(state, acting) {
  el.statusText.textContent = statusTextFor(state, acting);
  const humanActs = acting.includes(HUMAN_SEAT);
  el.status.classList.toggle('status-bar--your-turn', humanActs);
  el.status.classList.toggle('status-bar--thinking', !state.gameOver && !humanActs);

  const scored = showsScores(state);
  el.scoreChip.hidden = !scored;
  if (scored) {
    const phase = state.playerVars[HUMAN_SEAT]?.phase;
    el.scoreChipValue.textContent = typeof phase === 'number'
      ? `Ph ${phase} · ${state.scores[HUMAN_SEAT]}`
      : String(state.scores[HUMAN_SEAT]);
    el.scoreChip.setAttribute('aria-label', `Your score: ${state.scores[HUMAN_SEAT]}. Open the scoreboard.`);
  }
}

function statusTextFor(state, acting) {
  if (state.gameOver) return `Game over — ${seatLabel(state.winner)} ${state.winner === HUMAN_SEAT ? 'win' : 'wins'}!`;
  if (state.turn.phase === 'pass') {
    return acting.includes(HUMAN_SEAT) ? 'Passing — your pick' : 'Waiting for passes…';
  }
  return acting.includes(HUMAN_SEAT) ? 'Your turn' : `${seatLabel(state.turn.seat)}'s turn`;
}

/**
 * A SELECTION changed, and nothing else did.
 *
 * Picking a card up in your own hand moves no cards, scores nothing and ends
 * no turn. What it changes is which things are lit: the card itself, the piles
 * and melds that would accept it, and the action button. Everything else on
 * the felt — every opponent's fan, every pile, the contract ladder — is
 * identical before and after, and rebuilding it was the single most expensive
 * thing a tap did (issue #6 §3): every card's SVG re-parsed, every listener
 * re-attached, every animation restarted, and the fan re-measured.
 *
 * So this repaints the three things that moved and leaves the DOM alone. It is
 * the same UI model a full render would have built — the model is pure and
 * cheap; it was only ever the DOM that was expensive.
 *
 * NOT for anything that changes what the hand CONTAINS. Cards leaving or
 * entering the fan change its child count, and the fan has to be rebuilt and
 * re-measured for that; those paths still call render().
 */
function renderSelection(state) {
  if (drag && drag.isDragging()) {
    pendingRender = { state };
    return;
  }
  selection = pruneSelection(state, selection);
  const acting = actingSeatsOf(state);
  const humanActs = acting.includes(HUMAN_SEAT);
  const humanMoves = humanActs ? enumerateLegalMoves(state, HUMAN_SEAT) : [];
  const ui = buildUiModel(state, { seat: HUMAN_SEAT, moves: humanMoves, acts: humanActs, selection });
  currentUi = ui;

  const handAddr = handAddress(HUMAN_SEAT);
  const committedPass = state.playerVars[HUMAN_SEAT]?.__pendingPass || [];
  for (const wrapper of el.hand.children) {
    const cardId = wrapper.dataset.cardId;
    const selected = isSelected(selection, handAddr, cardId) || committedPass.includes(cardId);
    wrapper.classList.toggle('card-face-wrap--selected', selected);
    wrapper.setAttribute('aria-pressed', String(selected));
  }
  for (const stack of el.screen.querySelectorAll('.pile-stack[data-zone]')) paintPileState(stack, ui);
  for (const chip of el.screen.querySelectorAll('.meld-chip[data-meld]')) paintMeldState(chip, ui);
  renderActionBar(state, ui, humanActs);
}

function render(state, message) {
  // A render mid-drag would replace the very node the pointer is holding.
  // Deferred, then replayed by the controller's settle callback.
  if (drag && drag.isDragging()) {
    pendingRender = { state, message };
    return;
  }
  // Collected as the sub-renderers run; swapped in at the end so the NEXT
  // render knows what was already on the felt (see markEntry above).
  enteringKeys = new Set();
  selection = pruneSelection(state, selection);
  const acting = actingSeatsOf(state);
  const humanActs = acting.includes(HUMAN_SEAT);
  const humanMoves = humanActs ? enumerateLegalMoves(state, HUMAN_SEAT) : [];
  const ui = buildUiModel(state, { seat: HUMAN_SEAT, moves: humanMoves, acts: humanActs, selection });
  const draggable = draggableSources(state, { seat: HUMAN_SEAT, acts: humanActs });
  const stagger = dealAnimation && motionAllowed();

  currentUi = ui;

  renderStatusBar(state, acting);
  renderSeats(state, stagger, acting, ui);
  renderContractLadder(state);
  renderCenterZones(state, ui, draggable);
  renderPlayerZones(state, ui, draggable);
  // The two bars go BEFORE the hand, and the order is load-bearing: renderHand
  // ends by measuring how much room the fan has. Measured with the previous
  // render's bars still showing, the fan was laid out against a row of the
  // wrong height — and if that flipped a scrollbar, against the wrong width
  // too. The ResizeObserver then corrected it a frame later, which the player
  // saw as the hand re-fanning itself.
  // Neither bar changes height with the turn any more (#13), so the ordinary
  // turn no longer costs a re-measure at all — but the announce bar still
  // leaves the column entirely for a pack that cannot announce, and a hint
  // long enough to wrap is still a taller bar. The order stays.
  renderAnnounceBar(state);
  renderActionBar(state, ui, humanActs);
  renderHand(state, ui, stagger, draggable);
  dealAnimation = false;
  shownCardKeys = enteringKeys;
  enteringKeys = null;

  // A game-ending move can arrive with no message (the human's own winning play) or a
  // stale one from the mover ("Bot 2 played" right before Bot 2's own hand emptied) —
  // gameOver always wins the log line over whatever was passed in.
  if (state.gameOver) {
    el.log.textContent = `${seatLabel(state.winner)} ${state.winner === HUMAN_SEAT ? 'win' : 'wins'}!`;
  } else if (message) {
    el.log.textContent = message;
  }
}

/** Re-render after a drag settles, replaying whatever was deferred. */
function onDragSettled() {
  const deferred = pendingRender;
  pendingRender = null;
  if (!liveState) return;
  render(deferred ? deferred.state : liveState, deferred ? deferred.message : undefined);
}

/* ------------------------------------------------------------------ *
 * Dragging
 * ------------------------------------------------------------------ */

/**
 * A card has been lifted: what does it look like, and where may it land?
 *
 * The targets come from src/ui/interaction.js, which derives them from the
 * SAME enumerated legal moves the tap path uses — so this function cannot
 * offer a drop the engine would refuse, and an empty target list (a card with
 * nothing to do) is a perfectly ordinary answer that ends in a snap-back.
 */
function onDragLift(handle) {
  const state = liveState;
  if (!state) return null;
  const card = cardById(state, handle.cardId);
  if (!card) return null;
  hideInspector();
  // The drag owns the gesture from here; the peek raise would fight the ghost
  // for the same card, and the hand's own pointerup may never arrive.
  clearPeek();

  const acting = actingSeatsOf(state);
  const humanActs = acting.includes(HUMAN_SEAT);
  const targets = [];

  if (humanActs) {
    const moves = enumerateLegalMoves(state, HUMAN_SEAT);
    for (const candidate of dropCandidates(state, {
      seat: HUMAN_SEAT,
      moves,
      source: { from: handle.from, cardId: handle.cardId },
    })) {
      const node = candidate.kind === 'zone'
        ? zoneStackNode(candidate.address)
        : meldChipNode(candidate.meldKey);
      if (node) targets.push({ node, onDrop: () => performHumanMove(state, candidate.move, node) });
    }
  }

  // Dropping a hand card back into the hand is REARRANGING, and it is always
  // available — including on an opponent's turn, which is exactly when a
  // player tidies their cards.
  if (handle.kind === 'hand') {
    targets.push({
      node: el.hand,
      onDrop: (event) => reorderHandAt(handle.cardId, event.clientX),
    });
  }

  return { markup: cardArt.face(card), targets };
}

/**
 * Drop `cardId` where the pointer left it.
 *
 * Rearranging by hand IMPLIES "my order" — a player who has just moved a card
 * has said what they want more clearly than any toggle could, so the mode
 * follows the gesture rather than making them find a control first.
 */
function reorderHandAt(cardId, clientX) {
  const nodes = [...el.hand.querySelectorAll('[data-card-id]')];
  let index = nodes.length;
  for (let i = 0; i < nodes.length; i++) {
    const rect = nodes[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      index = i;
      break;
    }
  }
  if (!livePack || !liveState) return;
  handPrefs = { mode: 'manual', order: reorder(displayedHand, cardId, index) };
  saveHandPrefs(livePack.id, handPrefs);
  render(liveState);
}

function cycleHandSort() {
  if (!liveState || !livePack) return;
  const mode = nextMode(handPrefs.mode);
  handPrefs = {
    // Switching AWAY from manual keeps the permutation: the player gets their
    // arrangement back when they cycle round to it, instead of being punished
    // for glancing at a sorted view.
    mode: isSortMode(mode) ? mode : 'auto',
    order: handPrefs.mode === 'manual' ? displayedHand.slice() : handPrefs.order,
  };
  saveHandPrefs(livePack.id, handPrefs);
  render(liveState);
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
  const mini = el.opponentsTop.querySelector(`[data-seat="${seat}"] .mini-hand`);
  if (!mini) return null;
  // The fan's last child is the one genuinely rendered card; the rest are the
  // cheap edge boxes renderSeats draws instead of real SVG. Preferring it gives
  // a card-shaped rect where the row is a squat strip, which is what a card
  // leaving this seat should be seen to launch from.
  return rectOf(mini.lastElementChild) || rectOf(mini);
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
      ? cardById(state, state.zones.cards(handAddress(HUMAN_SEAT)).at(-1) || '')
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
  const address = implicitLandingZone(state, move);
  if (!address) return;
  const node = zoneStackNode(address);
  const topNode = node ? node.querySelector('.pile-stack__top') : null;
  landOn(topNode, flyCard(cardArt.face(card), from, rectOf(topNode) || zoneRect(address)));
}

/**
 * How many penalty cards are worth watching arrive.
 *
 * A Draw 4 is four. `effect.n` and `lastCardCall.penalty.draw` are pack values
 * though, and a pack that says forty would otherwise buy forty timers and forty
 * SVG copies for a moment that is over in a second. The banner says the real
 * number; this is only how many of them fly.
 */
const PENALTY_FLIGHT_MAX = 6;

/**
 * A handful of cards, seen to leave the deck.
 *
 * A DRAW YOU DID NOT ASK FOR WAS THE ONE DRAW THE TABLE NEVER SHOWED. A Draw 4
 * is the most violent thing anybody plays and it happened as a number changing
 * on a seat plate: the banner said "You draw 4", the hand was suddenly four
 * cards wider, and nothing connected the two. animateMove covers the draw a
 * player MAKES, because that flight starts under the finger that asked for it.
 * This covers the ones handed to you — a Draw 2, a Draw 4, and the cards a
 * missed "Last card!" costs, which is the same event wearing another name.
 *
 * The cards that actually arrived are the last `count` of the hand: every draw
 * appends (src/templates/shedding.js), and the display order the fan is in is a
 * VIEW that never reaches the zone. Face-up for the human, who is about to sort
 * them anyway; a bot's penalty flies backs, because the table does not know
 * what a bot was dealt any more than you do.
 */
function animatePenaltyDraw(state, seat, count, delay) {
  if (!count || count < 1 || !motionAllowed()) return;
  const from = zoneRect('draw');
  if (!from) return;
  const to = cardSizedRect(seatRect(seat), from.width);
  if (!to) return;

  const ids = seat === HUMAN_SEAT
    ? state.zones.cards(handAddress(seat)).slice(-count)
    : [];
  const myEpoch = epoch;
  for (let i = 0; i < Math.min(count, PENALTY_FLIGHT_MAX); i++) {
    const card = ids.length ? cardById(state, ids[i]) : null;
    // Dealt one after another rather than as a fan, because that is what makes
    // four read as FOUR — a single flight of four overlapping copies is one
    // event, and the count is the whole insult.
    Arcade.session.setTimeout(() => {
      if (myEpoch !== epoch) return;
      flyCard(card ? cardArt.face(card) : cardArt.back(), from, to,
        { fade: true, duration: 300 });
    }, delay + i * 110);
  }
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

/* ------------------------------------------------------------------ *
 * Action cards, made visible
 * ------------------------------------------------------------------ */

/**
 * What each action event says on the felt, from the point of view of whoever
 * is reading it.
 *
 * `seat` on these events is always the seat it HAPPENED TO, which is the one
 * fact the wording turns on: the same Draw 4 is a small triumph when you play
 * it and an outrage when you eat it, and a table that narrated both the same
 * way would be describing the cards rather than the game.
 */
function actionEventText(ev) {
  const you = (seat) => seat === HUMAN_SEAT;
  const name = (seat) => (you(seat) ? 'You' : seatLabel(seat));

  if (ev.type === 'skipped') {
    return you(ev.seat)
      ? { text: 'Skipped — your turn is gone', tone: 'bad' }
      : { text: `${name(ev.seat)} is skipped`, tone: you(ev.by) ? 'good' : 'neutral' };
  }
  if (ev.type === 'reversed') {
    return { text: 'Direction reversed', tone: 'neutral' };
  }
  if (ev.type === 'penalty') {
    if (!ev.drew) return null; // the pile was empty; nothing actually happened
    const n = ev.drew;
    return you(ev.seat)
      ? { text: `You draw ${n} and lose your turn`, tone: 'bad' }
      : { text: `${name(ev.seat)} draws ${n}`, tone: you(ev.by) ? 'good' : 'neutral' };
  }
  if (ev.type === 'wildPlayed') {
    const chose = Object.values(ev.chose || {})[0];
    if (!chose) return null;
    return { text: `${name(ev.seat)} chose ${chose}`, tone: 'neutral' };
  }
  if (ev.type === 'handsSwapped') {
    // Only "You" has a lower-case form; a name is a proper noun. This used to
    // lower-case whatever landed in the object position, which nobody had seen
    // because the swap itself never fired — "You swapped hands with delphine".
    const object = you(ev.seat) ? 'you' : name(ev.seat);
    return { text: `${name(ev.by)} swapped hands with ${object}`, tone: 'neutral' };
  }
  if (ev.type === 'handsRotated') {
    return { text: 'Every hand moves round', tone: 'neutral' };
  }
  return null;
}

const ACTION_EVENTS = new Set([
  'skipped', 'reversed', 'penalty', 'wildPlayed', 'handsSwapped', 'handsRotated',
]);

/**
 * Announce an action card: banner, cue, and a pulse on whoever it landed on.
 *
 * One event per move at most — an action card does one thing — so this takes
 * the first rather than queueing, which would stack banners on a variant where
 * two effects can fire (a seven-zero swap that also reverses).
 */
function celebrateAction(state, events) {
  const ev = events.find((e) => ACTION_EVENTS.has(e.type));
  if (!ev) return null;
  const said = actionEventText(ev);
  if (!said) return null;

  showBanner(said.text, said.tone);
  playActionCard({ against: ev.seat === HUMAN_SEAT && said.tone === 'bad' });

  // After the card that caused it has landed on the discard (animateMove's 260ms
  // flight, launched a beat before this): the play and the punishment are two
  // events in that order, and overlapping them makes one blur.
  if (ev.type === 'penalty') animatePenaltyDraw(state, ev.seat, ev.drew, 300);

  // The pulse lands on the seat it happened to, not the seat that played it:
  // the question a player is asking at this moment is "who did that hit".
  const victim = ev.seat;
  if (victim !== undefined && victim !== null) {
    const target = victim === HUMAN_SEAT
      ? el.hand
      : el.opponentsTop.querySelector(`[data-seat="${victim}"]`);
    if (target) {
      target.classList.remove('zone-celebrate', 'zone-lament');
      void target.offsetWidth;
      target.classList.add(said.tone === 'bad' ? 'zone-lament' : 'zone-celebrate');
    }
  }
  flashFelt(ev);
  return said;
}

/**
 * A wash of colour across the felt — the pack-level "background effect" an
 * action card earns.
 *
 * Driven by a class and a custom property rather than an inline animation so a
 * pack's own stylesheet can restyle or silence it, and so reduced motion turns
 * it off with everything else (see the media query in table.css). The tint of a
 * wild is the colour that was chosen, which makes the flash carry the one piece
 * of information the discard card itself cannot show.
 */
function flashFelt(ev) {
  if (!el.table || !motionAllowed()) return;
  const chosen = ev.type === 'wildPlayed' ? Object.values(ev.chose || {})[0] : null;
  // Through the pack's own palette, so the wash is the colour the player just
  // picked as that pack draws it — and through safeCssColor, because a palette
  // is pack-supplied data on its way into a style property.
  const tint = chosen ? safeCssColor(cardArt.theme.palette?.[chosen]) : null;
  el.table.style.removeProperty('--flash-tint');
  if (tint) el.table.style.setProperty('--flash-tint', tint);
  el.table.classList.remove('table--flash');
  void el.table.offsetWidth;
  el.table.classList.add('table--flash');
}

/**
 * Stop here, between rounds, without playing the match out.
 *
 * The door that was missing. A match runs to its pack's threshold — Wildfire's
 * is 500 points, which is a long evening — and the only way out was to close
 * the table, which by design does NOT end anything: the game keeps its place
 * and sits in the lobby waiting. That is right for "I'll come back to this"
 * and wrong for "I'm done with this one", and there was no way to say the
 * second.
 *
 * Recorded as a forfeit through the same contract the lobby's Start over uses.
 * The two doors out of an unfinished match must not disagree about what a loss
 * is — leaving while behind is not a way to avoid the loss appearing.
 */
async function endMatchFromSummary() {
  if (!liveState) return;
  const state = liveState;
  const myEpoch = epoch;
  const leader = Math.max(...state.scores);
  const ahead = state.scores[HUMAN_SEAT] >= leader;
  const ok = await confirmAction(
    `End this ${state.pack.manifest.name} match after ${state.roundNumber - 1} `
    + `${state.roundNumber - 1 === 1 ? 'round' : 'rounds'}?`
    + (ahead ? '' : ' It counts as a forfeit.'),
    { okLabel: 'End match', cancelLabel: 'Keep playing' },
  );
  if (!ok || myEpoch !== epoch || liveState !== state) return;

  cancelBotTurn();
  cancelAnnouncementBeats();
  matchDirty = false;
  clearMatch(state.pack.id);
  recordResult(state.pack.id, {
    won: false,
    forfeit: true,
    opponents: seating
      .filter((identity) => identity.isBot)
      .map((identity) => ({ key: identity.opponentKey, beaten: false })),
  });
  hideRoundSummary();
  exitToLobby();
}

function dismissRoundSummary() {
  if (!isRoundSummaryOpen() || !liveState) return;
  hideRoundSummary();
  dealAnimation = true;
  playDeal(liveState.seats);
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
 * Stats and the record
 * ------------------------------------------------------------------ */

/**
 * This match's numbers, replayed out of its own log (src/stats/matchStats.js).
 *
 * Never throws to the caller: a log the current rules can no longer replay is
 * a reason to show no stats, never a reason to lose the game-over panel — and
 * it is the same failure openTable() already handles by starting fresh.
 */
function safeStats(state) {
  try {
    return computeMatchStats(state.pack, serializeMatch(state));
  } catch (err) {
    console.warn('[cardstock] could not compute match stats', err);
    return null;
  }
}

/** The per-opponent outcomes this match contributes to the head-to-head record. */
function opponentOutcomes(state, stats) {
  const rank = stats
    ? placements(state.pack, { totals: stats.totals, winner: state.winner, seats: state.seats })
    : null;
  return seating
    .filter((identity) => identity.isBot && identity.opponentKey)
    .map((identity) => ({
      key: identity.opponentKey,
      beaten: !!rank && rank[HUMAN_SEAT] < rank[identity.seat],
    }));
}

function recordSentence(state) {
  const record = readStats(state.pack.id);
  const overall = record.played
    ? `${record.won} of ${record.played} in ${state.pack.manifest.name}`
    : '';
  const head = seating
    .filter((identity) => identity.isBot && record.opponents[identity.opponentKey])
    .map((identity) => {
      const r = record.opponents[identity.opponentKey];
      return `${r.won}–${r.played - r.won} vs ${identity.name}`;
    })
    .join(' · ');
  const streak = record.streak > 1 ? `${record.streak} in a row` : '';
  return [overall, streak, head].filter(Boolean).join(' — ');
}

/**
 * End the match in the books: record it and stop it resuming.
 *
 * This is the ENGINE deciding. The other ending — the player walking away —
 * is the lobby's, recorded through the same `recordResult` contract with
 * `forfeit: true` (src/ui/lobby.js). The two doors must never disagree about
 * what a loss is, which is why the storage payload still carries the field
 * even though the only value written here is `false`.
 *
 * BOOKKEEPING ONLY — it no longer opens the panel. The record has to be written
 * before the panel is built (the panel shows it), but the panel itself now
 * waits for the player (awaitFinalLook), and those are two different moments.
 * Returns everything showGameOver will need, so the wait does not have to hold
 * on to a live state to recompute it.
 */
function concludeMatch(state) {
  cancelBotTurn();
  cancelAnnouncementBeats();
  matchDirty = false;
  // A finished match is not something to resume into.
  clearMatch(state.pack.id);
  const stats = safeStats(state);
  recordResult(state.pack.id, {
    won: state.winner === HUMAN_SEAT,
    forfeit: false,
    opponents: opponentOutcomes(state, stats),
  });
  return {
    seating,
    stats,
    recordText: recordSentence(state),
    heroFaces: heroFaces(state.pack),
    renderFace: (face) => cardArt.face(face),
  };
}

/** Who won, in the sentence the felt says it in. */
function winnerSentence(state) {
  const winner = state.winner;
  if (winner === HUMAN_SEAT) return 'You win!';
  const name = seating[winner] ? seating[winner].name : seatLabel(winner);
  return `${name} wins.`;
}

/**
 * The move that ended it, named.
 *
 * The winner and the last card are NOT always the same person's business — a
 * pack that plays to a points threshold can be won by somebody who did not make
 * the final play — so this is a second line rather than a clause in the first.
 * Empty when the ending was not a card (a match that ends on a pass, or a round
 * that tipped the totals), because a caption with nothing to caption is noise.
 */
function finalPlaySentence(state, move) {
  if (!move || (move.type !== 'playCard' && move.type !== 'discard')) return '';
  const card = cardById(state, move.cards && move.cards[0]);
  if (!card) return '';
  const who = move.actor === HUMAN_SEAT
    ? 'you'
    : (seating[move.actor] ? seating[move.actor].name : seatLabel(move.actor));
  return `Last card: ${cardName(card)}, played by ${who}.`;
}

/**
 * Leave the ending on the felt until the player has had their look at it.
 *
 * Delayed by a beat so the final card has landed on the discard before anything
 * asks to be read — the bar arriving mid-flight would be the same interruption
 * the panel used to be, only smaller. The winner's seat pulses underneath, so
 * the answer to "who?" is on the table and not only in the sentence.
 */
function offerFinalLook(state, move, ending) {
  const myEpoch = epoch;
  const winnerNode = state.winner === HUMAN_SEAT
    ? el.hand
    : el.opponentsTop.querySelector(`[data-seat="${state.winner}"]`);
  if (winnerNode) {
    winnerNode.classList.remove('zone-celebrate', 'zone-lament');
    void winnerNode.offsetWidth;
    winnerNode.classList.add('zone-celebrate');
  }
  Arcade.session.setTimeout(async () => {
    if (myEpoch !== epoch) return;
    const acknowledged = await awaitFinalLook(winnerSentence(state), finalPlaySentence(state, move));
    // Closed under it, or a new game started while it was up — either way these
    // results belong to a match that is no longer the one on screen.
    if (!acknowledged || myEpoch !== epoch) return;
    showGameOver(state, ending);
  }, 700);
}

/** Display-only faces from the manifest; see schema `heroCards`. */
function heroFaces(pack) {
  const faces = pack.manifest.heroCards;
  return Array.isArray(faces) ? faces.slice(0, 3) : [];
}

function openScoreboard() {
  if (!liveState) return;
  showScoreboard(liveState, seating, safeStats(liveState));
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
  // Keeping a drawn card moves nothing, so it makes no sound. A card-on-felt
  // slap for a turn where no card was played is the table lying about what
  // happened — and the drawn card's own sound already played a beat ago.
  if (move.type === 'draw') playDraw();
  else if (move.type !== 'pass') playCardPlayed({ far });
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
    // Recorded before the render, so the panel that is eventually built can
    // show the updated record — this game's counters are ours to display (§4:
    // `stats` is the surface whose formatting the game owns). The PANEL itself
    // waits: the last card is the thing worth watching, and it is still in the
    // air on this frame.
    const ending = concludeMatch(state);
    render(state, message);
    animateMove(state, move, from);
    if (trick) celebrateTrick(state, trick);
    playWin();
    offerFinalLook(state, move, ending);
    return;
  }

  if (passed && !message) message = 'Cards passed. Play!';
  render(state, message);
  animateMove(state, move, from);
  if (trick) celebrateTrick(state, trick);
  // After the card has been seen to land, and only when a trick is not already
  // holding the felt — two celebrations at once is neither.
  const action = trick ? null : celebrateAction(state, events);
  // The action is the better sentence: "Rook played." says less than nothing
  // next to "You draw 4 and lose your turn", and the log is the live region a
  // screen reader hears.
  if (action) el.log.textContent = action.text;
  persistMatch();

  if (roundOver) {
    // The engine has already dealt the next round beneath this move; the
    // summary sits on top of the fresh deal and bot play waits for its
    // dismissal. A beat of delay lets a closing trick's gather land first.
    cancelAnnouncementBeats();
    const myEpoch = epoch;
    Arcade.session.setTimeout(() => {
      if (myEpoch !== epoch) return;
      showRoundSummary(state, roundOver, seating);
    }, trick ? 900 : 250);
    return;
  }

  scheduleNextTurn(state, epoch);
  scheduleAnnouncementBeats(state, epoch);
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
 * One option of a card's question, as a button.
 *
 * THE PICTURE IS THE TARGET AND THE WORD IS THE CAPTION, and both are always
 * there. The art is what makes the choice quick — you aim at the red one, not
 * at the four-letter word that starts with r — and the word is what makes it
 * possible at all for a player who cannot separate the colours, which in a
 * game whose entire rule IS colour is not a minor audience.
 *
 * Three kinds of option, in the order they are tried: a card the pack's own
 * renderer can draw (a colour, a suit, a rank); a PLAYER, which is not a card
 * and gets the mark that seat wears everywhere else instead; and a bare word
 * for anything a template invents that is neither.
 *
 * `value` is pack data on two paths and is handled as such on both: textContent
 * for the caption, and a lookup key for the art, which is generated inside
 * src/ui/cardStyles/chooser.js with everything escaped.
 */
function buildChoiceOption(attr, { value, icon = null }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const art = cardArt.chooser(attr, value);
  btn.className = `choice-option ${art ? 'choice-option--card'
    : icon ? 'choice-option--seat' : 'choice-option--word'}`;
  // Named outright rather than left to name-from-content. The caption below is
  // the name either way, but the picture beside it is a whole card's worth of
  // markup for the computation to walk past, and the one thing this button
  // must never be is unlabelled.
  btn.setAttribute('aria-label', value);
  if (art) {
    btn.appendChild(svgNode(art, 'choice-option__art'));
  } else if (icon) {
    // The seat's own mark, the same one on its plate and in the score sheet
    // (src/players/roster.js) — one vocabulary for "this is a player",
    // wherever they turn up. Decorative: the name below carries the meaning.
    const mark = document.createElement('span');
    mark.className = 'choice-option__icon';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = icon;
    btn.appendChild(mark);
  }
  const caption = document.createElement('span');
  caption.className = 'choice-option__name';
  caption.textContent = value;
  btn.appendChild(caption);
  return btn;
}

/**
 * Ask for a suit or colour (or a player, for targeted effects), or null if
 * the player backs out.
 *
 * Cancellable on purpose. Tapping a wild used to be an irreversible commitment
 * to a modal with no way out, and closing the table under an open prompt left
 * the awaiting handler holding a promise that could still resolve into a match
 * that was no longer on screen.
 *
 * `options` are plain strings, or `{ value, icon }` when an option has a mark
 * of its own — which today means a player, whose face belongs to a seat rather
 * than to the deck. The promise always resolves with the `value`.
 *
 * `card` is the card that asked — shown at the top of the panel, because "what
 * does this become" is a question about a specific object and the answer reads
 * better next to it. Optional: a wild already lying in somebody's meld has no
 * single card to show.
 */
async function promptChoice(attr, options, { card = null } = {}) {
  const choices = options.map((o) => (typeof o === 'string' ? { value: o, icon: null } : o));
  el.choicePrompt.textContent = `Choose a ${attr}`;
  el.choicePanel.replaceChildren();
  el.choiceCard.replaceChildren();
  if (card) el.choiceCard.appendChild(svgNode(cardArt.face(card), 'choice-dialog__face'));
  el.choiceCard.hidden = !card;
  // Four options are the rosette on the wild itself, so they are laid out as
  // one — two by two — rather than as a row that wraps differently per width.
  el.choicePanel.className = `choice-grid ${choices.length === 4 ? 'choice-grid--quad' : ''}`;
  el.choiceModal.hidden = false;

  return new Promise((resolve) => {
    const buttons = [];
    const close = (value) => {
      cancelPendingChoice = null;
      el.choiceModal.removeEventListener('keydown', onKey);
      el.choiceModal.hidden = true;
      el.choiceDialog.style.removeProperty('--choice-tint');
      resolve(value);
    };

    // Roving focus, because the four colours are a GRID and Tab through a grid
    // is the wrong gesture: on a 2x2 the arrow key you press is the direction
    // you meant. Escape backs out, same as Cancel — this dialog is one of the
    // few in the app where changing your mind is a legitimate move.
    const move = (step) => {
      const at = buttons.indexOf(document.activeElement);
      const next = buttons[((at === -1 ? 0 : at) + step + buttons.length) % buttons.length];
      if (next) next.focus({ preventScroll: true });
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(null); return; }
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
      if (step === undefined) return;
      ev.preventDefault();
      move(step);
    };
    el.choiceModal.addEventListener('keydown', onKey);

    cancelPendingChoice = () => close(null);
    el.choiceCancel.onclick = () => close(null);

    for (const opt of choices) {
      const btn = buildChoiceOption(attr, opt);
      // The panel takes the colour of whatever is under the finger, so the
      // answer is visible before it is committed — and the felt then washes in
      // that same colour when it is (flashFelt). §7b: through safeCssColor,
      // because a pack value is reaching a style property.
      const tint = safeCssColor(cardArt.chooserTint(attr, opt.value));
      const light = () => {
        if (tint) el.choiceDialog.style.setProperty('--choice-tint', tint);
        else el.choiceDialog.style.removeProperty('--choice-tint');
      };
      btn.addEventListener('focus', light);
      btn.addEventListener('pointerenter', light);
      btn.addEventListener('click', () => close(opt.value));
      buttons.push(btn);
      el.choicePanel.appendChild(btn);
    }
    // preventScroll: the dialog is fixed, but focusing into it still scrolls
    // the felt behind it — the same trap the rules panel documents.
    if (buttons[0]) buttons[0].focus({ preventScroll: true });
  });
}

function closeChoiceModal() {
  if (cancelPendingChoice) cancelPendingChoice();
  el.choiceModal.hidden = true;
}

/**
 * "Which of them?" — the seat number, or null if the player backs out.
 *
 * A QUESTION WITH ONE ANSWER IS NOT A QUESTION. At a two-hander there is
 * exactly one other player, and a dialog asking you to confirm the only living
 * opponent is a tax on every seven you play. The same judgement the meld's
 * wildChoice makes ("a set has one answer and is never asked"), applied to the
 * one choice that is about the table rather than the deck.
 *
 * `label` completes the sentence "Choose a …", so each caller says what the
 * target is FOR — being skipped is not the same as having your hand taken.
 */
async function pickOpponent(state, card, label = 'player to swap hands with') {
  const others = [];
  for (let s = 0; s < state.seats; s++) if (s !== HUMAN_SEAT) others.push(s);
  if (others.length === 0) return null;
  if (others.length === 1) return others[0];
  // Each seat carries the mark it wears everywhere else, so the answer is a
  // face rather than a name to read (src/players/roster.js).
  const options = others.map((s) => {
    const identity = identityOf(s);
    return { value: identity.name, icon: identity.icon || null };
  });
  const picked = await promptChoice(label, options, { card });
  if (picked === null) return null;
  return others[options.findIndex((o) => o.value === picked)];
}

/**
 * The single gate between a human gesture and the engine, whatever dressed the
 * move up — a hand card, a pile, a meld chip, the action button, or a card
 * dropped onto a pile. Fills in any choice the move still owes (a wild asks
 * its colour; a discard that skips a player asks who), validates, and hands
 * off to the shared apply/render/persist path.
 *
 * The wild prompt used to live in the tap handler alone, which meant a dropped
 * wild would have bypassed it. Asking HERE is what lets both dressings stay
 * one code path.
 */
async function performHumanMove(state, move, sourceNode) {
  const myEpoch = epoch;

  if (move.type === 'playCard' && move.cards && !move.choice) {
    const card = cardById(state, move.cards[0]);
    const attr = card ? needsChoice(card) : null;
    // A TARGET IS A SEAT, NOT A VALUE OFF A CARD, and that is the whole reason
    // this is a branch rather than one more entry in the list below. Wildfire's
    // seven-zero seven says `choose: 'player'`, and the colour branch answered
    // it with the deck's colours — so the card that reads "Swap hands with a
    // player of your choosing" offered you red, yellow, green and blue, and the
    // engine then looked for a seat called "red" and swapped nothing.
    if (attr === 'player') {
      const picked = await pickOpponent(state, card);
      if (picked === null || myEpoch !== epoch) return;
      move = { ...move, choice: { player: picked } };
    } else if (attr) {
      const options = attr === 'suit'
        ? ['clubs', 'diamonds', 'hearts', 'spades']
        : [...new Set([...state.pack.cardsById.values()].map((c) => c.color).filter(Boolean))];
      const picked = await promptChoice(attr, options, { card });
      // Backed out, or the table closed while the prompt was open — either way
      // this move belongs to a match that is no longer the one on screen.
      if (picked === null || myEpoch !== epoch) return;
      move = { ...move, choice: { [attr]: picked } };
    }
  }

  // A wild joining a meld has to become a specific card before it lands, and
  // for a run there are two honest answers (either end). The template says
  // when the question is real; a set has one answer and is never asked.
  if (move.type === 'hit' && move.cards && state.pack.template.wildChoice) {
    const ask = state.pack.template.wildChoice(makeCtx(state), move);
    if (ask) {
      const picked = await promptChoice(ask.attr, ask.values, { card: cardById(state, ask.cardId) });
      if (picked === null || myEpoch !== epoch) return;
      move = {
        ...move,
        choice: { ...(move.choice || {}), wilds: { [ask.cardId]: { [ask.attr]: picked } } },
      };
    }
  }

  if (move.type === 'discard' && move.cards) {
    const card = cardById(state, move.cards[0]);
    const effect = card?.effect;
    if (effect?.type === 'skipTarget' && effect.on === 'discard' && move.choice?.target === undefined) {
      const picked = await pickOpponent(state, card, 'player to skip');
      if (picked === null || myEpoch !== epoch) return;
      move = { ...move, choice: { ...(move.choice || {}), target: picked } };
    }
  }

  const check = validateMove(state, move);
  if (!check.legal) {
    playInvalid();
    render(state, `Can't do that: ${check.reason}`);
    return;
  }
  const from = rectOf(sourceNode) || (move.from ? zoneRect(move.from) : null) || seatRect(HUMAN_SEAT);
  // NOT `selection = null`. The render inside afterMove prunes it per card
  // (pruneSelection), which drops exactly what this move consumed and leaves
  // the rest staged. Clearing wholesale is what made a Milestones meld
  // impossible to build across turns: every turn ends in a discard, and the
  // discard took the tray with it.
  applyStateChange(state, move, { far: false });
  afterMove(state, move, from);
}

/** A tap on one of the human's own hand cards, interpreted per the UI model. */
function onHandCard(state, cardId, card, sourceNode, ui) {
  const handAddr = handAddress(HUMAN_SEAT);

  if (ui.mode === 'tap' || ui.mode === 'play-drawn') {
    // One tap plays it — the destination is implicit, and the wild's question
    // is asked by performHumanMove, the same place a drop asks it. In
    // 'play-drawn' only the drawn card is in ui.handSelectable, and this is
    // reached only through a selectable card.
    performHumanMove(state, { actor: HUMAN_SEAT, type: 'playCard', cards: [cardId] }, sourceNode);
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
    // The card moves between the fan and the tray, so the fan's child count
    // changes and it has to be rebuilt and re-measured — the fast path below
    // deliberately does neither. The flight covers the rebuild.
    const from = rectOf(sourceNode);
    render(state);
    flyToStage(state, cardId, from);
    return;
  }
  selection = isSelected(selection, handAddr, cardId) ? null : { from: handAddr, cardIds: [cardId] };
  // Nothing moved — repaint what is lit rather than rebuilding the table.
  renderSelection(state);
}

/**
 * Carry a card between the fan and the tray, so the two rows read as one
 * gesture rather than as the card vanishing from one place and appearing in
 * another. `from` is measured BEFORE the render that moved it.
 */
function flyToStage(state, cardId, from) {
  if (!from || !motionAllowed()) return;
  const landed = el.stageTray.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)
    || el.hand.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
  const to = rectOf(landed);
  if (!to) return;
  const card = cardById(state, cardId);
  if (!card) return;
  // Held invisible under the copy and revealed when it lands — the same
  // clone-and-animate deal a played card gets. flyCard always resolves, so the
  // card cannot be left permanently hidden.
  landed.style.visibility = 'hidden';
  flyCard(cardArt.face(card), from, to, { duration: 180 })
    .then(() => { landed.style.visibility = ''; });
}

/* ------------------------------------------------------------------ *
 * Announcements (§E2)
 * ------------------------------------------------------------------ */

/**
 * Apply an announcement — the player's, or a bot's.
 *
 * Deliberately NOT routed through afterMove: an announcement never changes
 * whose turn it is, so re-entering the turn scheduler would cancel and restart
 * a bot's think time every time somebody spoke.
 */
function performAnnouncement(state, move, myEpoch = epoch) {
  if (myEpoch !== epoch || !liveState) return;
  const check = validateMove(state, move);
  // The window closed while the timer ran — somebody else got there first, or
  // the target played. That is an ordinary outcome, not an error.
  if (!check.legal) return;

  applyMove(state, move);
  const caught = state.events.find((e) => e.type === 'caught');
  const announced = state.events.find((e) => e.type === 'announced');
  playAnnouncement({ caught: !!caught });

  let message = '';
  if (announced) {
    const who = announced.seat === HUMAN_SEAT ? 'You' : identityOf(announced.seat).name;
    message = `${who}: “${announced.label}”`;
    showBanner(message, announced.seat === HUMAN_SEAT ? 'good' : 'neutral');
  } else if (caught) {
    const catcher = caught.seat === HUMAN_SEAT ? 'You' : identityOf(caught.seat).name;
    const victim = caught.target === HUMAN_SEAT ? 'you' : identityOf(caught.target).name;
    message = `${catcher} caught ${victim} — ${caught.drew} card${caught.drew === 1 ? '' : 's'}.`;
    showBanner(message, caught.target === HUMAN_SEAT ? 'bad' : 'good');
  }

  render(state, message);
  // After the render, so the hand the cards are flying INTO is the one on
  // screen. A catch costs cards exactly the way a Draw 2 does, and it is the
  // same flight for the same reason — the number in the banner is the whole
  // point of the rule, and a number is not a thing you watch happen.
  if (caught) animatePenaltyDraw(state, caught.target, caught.drew, 120);
  persistMatch();
  scheduleAnnouncementBeats(state, epoch);
}

function cancelAnnouncementBeats() {
  for (const timer of announceTimers) timer.cancel();
  announceTimers = [];
}

/**
 * Decide, once per window, whether each bot remembers to declare and whether
 * each notices somebody who did not — then schedule what they decided.
 *
 * THIS IS WHERE THE MECHANIC BECOMES A GAME. A bot that always declares makes
 * the catch button decorative; one that always catches makes forgetting an
 * instant loss. Persona weights (`callReliability`, `catchAttention`) and a
 * deliberate delay before a catch are what leave room for a player to declare
 * late and get away with it — which is exactly the tension the rule has at a
 * real table.
 *
 * The decision is CACHED per vulnerability window. Re-rolling on every render
 * would hand a forgetful bot a fresh chance every time anybody moved, and
 * `callReliability: 0.5` would behave like 1.
 */
function scheduleAnnouncementBeats(state, myEpoch) {
  cancelAnnouncementBeats();
  if (state.gameOver) return;
  if (!state.pack.template.enumerateAnnouncements) return;

  const schedule = (fn, ms) => {
    announceTimers.push(Arcade.session.setTimeout(() => {
      if (myEpoch !== epoch) return;
      fn();
    }, ms));
  };

  for (let seat = 0; seat < state.seats; seat++) {
    if (seat === HUMAN_SEAT) continue;
    const identity = identityOf(seat);
    const persona = identity.persona;
    if (!persona) continue;
    const options = announcementsFor(state, seat);

    const own = options.find((a) => a.type === 'announce');
    if (!own) {
      botCallDecision.delete(seat);
    } else {
      if (!botCallDecision.has(seat)) {
        botCallDecision.set(seat, Math.random() < persona.callReliability);
      }
      if (botCallDecision.get(seat)) {
        // They say it as they put the card down, near enough.
        schedule(() => performAnnouncement(state, own, myEpoch),
          Math.round(thinkTimeMs(identity, settings.botDelayMs) * 0.4));
      }
    }

    for (const option of options) {
      if (option.type !== 'challenge') continue;
      const key = `${seat}>${option.target}`;
      if (!botCatchDecision.has(key)) {
        botCatchDecision.set(key, Math.random() < persona.catchAttention);
      }
      if (!botCatchDecision.get(key)) continue;
      // The grace is the whole fairness of it: a sharp bot pounces in under a
      // second, a dreamy one takes three, and either way you had a moment to
      // say it yourself.
      const grace = 700 + (1 - persona.catchAttention) * 2600 + Math.random() * 500;
      schedule(() => performAnnouncement(state, option, myEpoch), Math.round(grace));
    }
  }

  // Windows that have closed leave no stale decision behind to be reused by
  // the next one.
  for (const key of [...botCatchDecision.keys()]) {
    const target = Number(key.split('>')[1]);
    const stillOpen = announcementsFor(state, Number(key.split('>')[0]))
      .some((a) => a.type === 'challenge' && a.target === target);
    if (!stillOpen) botCatchDecision.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * The bot driver
 * ------------------------------------------------------------------ */

function scheduleNextTurn(state, myEpoch) {
  // Cancel first: an announcement or a re-entry could otherwise leave two
  // timers racing to move the same bot.
  cancelBotTurn();
  if (state.gameOver) return;
  const acting = actingSeatsOf(state);
  const seat = acting.find((s) => s !== HUMAN_SEAT);
  if (seat === undefined) return;

  const identity = identityOf(seat);
  // Arcade.session.setTimeout, not setTimeout: it freezes while the frame is
  // suspended (§6c — forgotten timers are the #1 battery drain in a hidden
  // iframe) and cancels itself when a save import replaces state. The epoch
  // guard is still needed for "Play again" and for leaving to the lobby, which
  // the SDK knows nothing about.
  botTimer = Arcade.session.setTimeout(() => {
    botTimer = null;
    if (myEpoch !== epoch) return; // superseded — drop the stale turn
    const actingNow = actingSeatsOf(state).find((s) => s !== HUMAN_SEAT);
    if (actingNow === undefined) return; // the human became the only one who may act
    const move = chooseBotMove(state, actingNow, { persona: identityOf(actingNow).persona });
    if (!move) return;
    const from = move.type === 'draw'
      ? (zoneRect(move.from ?? 'draw') || seatRect(actingNow))
      : seatRect(actingNow);
    applyStateChange(state, move, { far: true });
    afterMove(state, move, from, `${identityOf(actingNow).name} ${BOT_VERBS[move.type] || 'played'}.`);
  }, thinkTimeMs(identity, settings.botDelayMs));
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
  pendingRender = null;
  botCallDecision.clear();
  botCatchDecision.clear();
  if (drag) drag.cancel();
  // Before the first render, and from the PACK rather than the manifest alone:
  // the deck is what tells a style which colours it actually has to draw.
  cardArt = makeCardRenderer(pack.manifest, pack.cardsById);
  // The parsed-SVG cache is keyed by markup the old renderer produced, so it
  // is dead weight from here on — and left alone it would accumulate one
  // entry per card per pack for as long as the tab is open.
  svgTemplates.clear();
  // Same reason, same moment: the keys name cards of the pack being replaced,
  // so the new table gets a clean deal-in instead of inheriting this one's
  // idea of what was already on the felt.
  shownCardKeys = new Set();
  enteringKeys = null;
  // Who is at this table — derived from the match SEED, so a resumed game
  // re-seats the same opponents and a fresh deal brings new ones.
  seating = buildSeating(state.seed, state.seats, {
    humanSeat: HUMAN_SEAT,
    humanName: humanName(),
  });
  handPrefs = loadHandPrefs(pack.id);
  hideAllPanels();
  hideBanner();
  render(state, message);
  persistMatch();
  scheduleNextTurn(state, epoch);
  scheduleAnnouncementBeats(state, epoch);
}

function startGame(pack, seats) {
  cancelBotTurn();
  cancelAnnouncementBeats();
  const seatCount = seatsFor(pack, seats);
  // Date.now() is only the entropy source. The seed itself is persisted with
  // the match from the first write, which is what makes the log replayable
  // (src/engine/replay.js) rather than merely re-runnable — and, since the
  // seating is derived from it, what rotates the opponents per game.
  const state = createState({ pack, seats: seatCount, seed: Date.now() });
  pack.template.setup(makeCtx(state));
  dealAnimation = true;
  playDeal(seatCount);
  adoptMatch(state.pack, state, `Playing ${pack.manifest.name}.`);
}

/**
 * Open `packId`'s table: resume its saved match when there is one, deal a
 * fresh game when there is not.
 *
 * Every entry to the table goes through here — a lobby tap, a `?pack=` deep
 * link, and a save import (`onStateReplaced` is a fresh boot by contract, §3).
 */
export async function openTable(packId, { variants, seats } = {}) {
  const myToken = ++openToken;
  cancelBotTurn();
  cancelAnnouncementBeats();
  closeChoiceModal();
  matchDirty = false;

  el.statusText.textContent = 'Dealing…';

  // A stored match pins the variant set: the same pack loaded with different
  // variants is a different rule set, and replaying a log against it diverges.
  // A stored match wins over anything the caller asked for: its log was
  // recorded under ITS rule set and seating, and replaying it under another is
  // divergence, not a preference.
  const stored = loadMatch(packId);
  const pack = await fetchPack(packId, stored ? stored.variants : variants);
  if (myToken !== openToken) return; // the player left before the pack landed

  rememberPack(packId);
  // The variant's name ALONE, and only in the launcher's title bar. At a table
  // the game you are playing is the only name that means anything, and saying
  // it twice — once in the launcher bar, once in our own — cost the status bar
  // the room it needed to stay on one line. The lobby restores the wordmark
  // (src/main.js).
  Arcade.ui.setTitle(pack.manifest.name);
  hideAllPanels();

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
  startGame(pack, seats);
}

/**
 * Leave the table. The match keeps its place in storage; nothing about it
 * keeps running.
 */
export function closeTable() {
  openToken += 1;          // abandon any open still in flight
  epoch += 1;              // and any bot turn already scheduled
  cancelBotTurn();
  cancelAnnouncementBeats();
  closeChoiceModal();
  closeConfirm();
  hideInspector();
  if (drag) drag.cancel();
  flushTable();
  // Keyed to the pack that just closed, so the next table gets a clean
  // deal-in rather than inheriting this one's idea of what is already there.
  // (adoptMatch clears these too — this is the leaving-for-the-lobby path,
  // which may not be followed by another table at all.)
  shownCardKeys = new Set();
  enteringKeys = null;
  liveState = null;
  livePack = null;
  selection = null;
  seating = [];
  pendingRender = null;
  hideBanner();
  hideAllPanels();
  el.contractLadder.hidden = true;
  el.contractLadder.replaceChildren();
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

  drag = createDragController({
    layer: flightLayer,
    onLift: onDragLift,
    onSettle: onDragSettled,
    // The controller is deliberately SDK-free, so the session clock is handed
    // to it rather than imported — same reasoning as the timers at §6c below.
    schedule: sessionSchedule,
    // Only a hand card can be scrubbed along; a pile top has no row to read.
    classifyGesture: ({ dx, dy, handle }) => (
      handle.kind === 'hand' ? classifyHandGesture({ dx, dy }) : 'drag'
    ),
  });

  initPanels({
    onContinueRound: () => dismissRoundSummary(),
    onPlayAgain: () => livePack && startGame(livePack, liveState?.seats),
    onLobby: () => exitToLobby(),
    onEndMatch: () => endMatchFromSummary(),
    onRules: () => livePack && showRules(packRules(livePack)),
    onCloseScoreboard: () => {},
  });

  // The fan's spacing is the one thing that depends on how much room the row
  // has, and it is a custom property rather than a re-render — so reacting to
  // a width change costs two measurements, not a repaint of the table.
  watchHandWidth();
  watchLadderWidth();
  watchHandPeek();

  el.lobbyButton.addEventListener('click', () => exitToLobby());
  el.scoreChip.addEventListener('click', () => openScoreboard());
  el.handSort.addEventListener('click', () => cycleHandSort());
}

/** Surface a boot/open failure on the table's own log line. */
export function reportTableError(message) {
  el.log.textContent = message;
}
