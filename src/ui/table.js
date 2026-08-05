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
import { confirmAction, closeConfirm } from './confirm.js';
import { createDragController } from './dragController.js';
import { attachInspector, hideInspector } from './inspector.js';
import {
  describeCard, describeZone, cardAriaLabel, zoneAriaLabel, zoneBadgeText, cardName,
} from './describe.js';
import {
  interactionMode, buildUiModel, dropCandidates, draggableSources, pruneSelection,
  isSelected, handAddress, implicitLandingZone,
  describeContractItem, describeContract, shortContract,
} from './interaction.js';
import {
  orderHand, reorder, nextMode, isSortMode, fanStep, SORT_LABELS,
} from './handOrder.js';
import {
  initPanels, showRoundSummary, hideRoundSummary, isRoundSummaryOpen,
  showScoreboard, showGameOver, hideAllPanels,
} from './panels.js';
import {
  rememberPack, loadSettings, saveMatch, loadMatch, clearMatch, recordResult, readStats,
  loadHandPrefs, saveHandPrefs,
} from '../arcade/storage.js';
import {
  playDeal, playCardPlayed, playDraw, playShuffle, playInvalid, playWin, playTrickTaken,
  playAnnouncement,
} from '../arcade/audio.js';

const HUMAN_SEAT = 0;
const SEAT_COUNT = 3;

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
  status: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  gameName: document.getElementById('game-name'),
  lobbyButton: document.getElementById('lobby-button'),
  scoreChip: document.getElementById('score-chip'),
  scoreChipValue: document.getElementById('score-chip-value'),
  forfeitButton: document.getElementById('forfeit-button'),
  opponentsTop: document.getElementById('opponents-top'),
  centerPiles: document.getElementById('center-piles'),
  playerPiles: document.getElementById('player-piles'),
  announceBar: document.getElementById('announce-bar'),
  contractLadder: document.getElementById('contract-ladder'),
  actionBar: document.getElementById('action-bar'),
  actionHint: document.getElementById('action-hint'),
  actionButton: document.getElementById('action-button'),
  handRow: document.getElementById('hand-row'),
  hand: document.getElementById('hand'),
  handSort: document.getElementById('hand-sort'),
  log: document.getElementById('log'),
  eventBanner: document.getElementById('event-banner'),
  choiceModal: document.getElementById('choice-modal'),
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

// A forfeited match is over without `state.gameOver` being true — the engine
// never decided anything, the player walked away. Kept as its own flag so no
// engine invariant has to be faked to represent it.
let forfeited = false;

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
  if (state.gameOver || forfeited) return [];
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
  if (!template.enumerateAnnouncements || forfeited) return [];
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

function meldChipNode(meldKey) {
  return el.screen.querySelector(`[data-meld="${CSS.escape(meldKey)}"]`);
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
  stack.classList.toggle('pile-stack--ready', !!target);
  stack.classList.toggle('pile-stack--source', !!sourceTop);
  stack.classList.toggle('pile-stack--picked', !!sourceTop && isSelected(selection, address, sourceTop));
  if (overlap) stack.classList.add(`pile-stack--overlap-${overlap === 'vertical' ? 'v' : 'h'}`);

  /** Place one card in the stack, carrying its index for the overlap offsets. */
  const placeCard = (markup, i, visibleCount, cardId, isTop) => {
    const node = svgNode(markup, `pile-stack__card ${isTop ? 'pile-stack__top' : ''}`);
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
    stack.style.setProperty('--overlap-count', String(Math.max(0, visible.length - 1)));
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

  const ariaLabel = zoneAriaLabel(state, inst);

  if (target) {
    stack.disabled = false;
    const verb = target.type === 'draw' ? 'Draw a card from'
      : target.type === 'discard' ? 'Discard to'
        : 'Play your selected card onto';
    stack.setAttribute('aria-label', `${verb} ${ariaLabel}`);
    stack.addEventListener('click', () => liveState && performHumanMove(liveState, target, stack));
  } else if (sourceTop) {
    stack.disabled = false;
    stack.setAttribute('aria-label', `${ariaLabel} Pick up the top card to play it.`);
    stack.addEventListener('click', () => {
      if (!liveState) return;
      selection = isSelected(selection, address, sourceTop) ? null : { from: address, cardIds: [sourceTop] };
      render(liveState);
    });
  } else {
    stack.disabled = true;
    stack.setAttribute('aria-label', ariaLabel);
  }

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
    badge.textContent = zoneBadgeText(state, inst);
    badge.setAttribute('aria-hidden', 'true');
    wrap.appendChild(badge);
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
    chip.className = `meld-chip ${move ? 'meld-chip--ready' : ''}`;
    chip.dataset.meld = meldKey;

    const cards = document.createElement('span');
    cards.className = 'meld-chip__cards';
    for (const cardId of group.cards) {
      const card = cardById(state, cardId);
      if (card) cards.appendChild(svgNode(cardArt.face(card), 'meld-chip__card'));
    }
    chip.appendChild(cards);
    chip.appendChild(line('meld-chip__label', what));

    const label = `${owner} ${what}, ${group.cards.length} cards.`;
    if (move) {
      chip.disabled = false;
      chip.setAttribute('aria-label', `${label} Add your selected card.`);
      chip.addEventListener('click', () => liveState && performHumanMove(liveState, move, chip));
    } else {
      chip.disabled = true;
      chip.setAttribute('aria-label', label);
    }

    // Reading a meld card by card is the thing a squeezed strip made
    // impossible, so the inspector spells the whole thing out.
    attachInspector(chip, () => ({
      title: `${owner} ${what}`,
      lines: group.cards
        .map((cardId) => cardById(state, cardId))
        .filter(Boolean)
        .map((card, n) => ({ label: `Card ${n + 1}`, value: cardName(card) })),
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
function renderContractLadder(state) {
  const contracts = state.pack.rules.contracts;
  if (!Array.isArray(contracts) || !contracts.length) {
    el.contractLadder.hidden = true;
    el.contractLadder.replaceChildren();
    return;
  }

  const minePhase = state.playerVars[HUMAN_SEAT]?.phase ?? null;
  el.contractLadder.replaceChildren();

  contracts.forEach((items, index) => {
    const phase = index + 1;
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
  });

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

function renderSeats(state, stagger, acting, ui) {
  el.opponentsTop.replaceChildren();
  const scored = showsScores(state);
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

    // The catch affordance (§E2) lives on the seat it accuses, which is the
    // only place it reads as "you — you never said it".
    const catchMove = humanAnnouncements(state).find((a) => a.type === 'challenge' && a.target === seat);
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

function renderHand(state, ui, stagger, draggable) {
  el.hand.replaceChildren();
  const handAddr = handAddress(HUMAN_SEAT);
  const engineHand = state.zones.cards(handAddr);
  // The engine's order is dealing order and stays that way; what the player
  // sees is their own arrangement (src/ui/handOrder.js).
  displayedHand = orderHand(engineHand, (id) => cardById(state, id), handPrefs.mode, handPrefs.order);
  const committedPass = state.playerVars[HUMAN_SEAT]?.__pendingPass;

  displayedHand.forEach((cardId, i) => {
    const card = cardById(state, cardId);
    const selectable = ui.handSelectable.has(cardId);
    const selected = isSelected(selection, handAddr, cardId) || (committedPass || []).includes(cardId);
    const wrapper = svgNode(cardArt.face(card),
      `card-face-wrap ${selectable ? '' : 'card-face--disabled'} ${stagger ? 'card-deal' : ''} ${selected ? 'card-face-wrap--selected' : ''}`);
    wrapper.dataset.cardId = cardId;
    if (stagger) wrapper.style.animationDelay = `${i * 35}ms`;
    wrapper.querySelector('svg').classList.toggle('card-face--disabled', !selectable);

    // Every hand card is reachable by keyboard, playable or not: a card that
    // cannot be focused cannot be inspected, and "why can't I play this?" is
    // a question the disabled ones are the whole reason for.
    wrapper.setAttribute('role', 'button');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('aria-label',
      `${cardAriaLabel(card, state.pack, { position: i + 1, of: displayedHand.length })}`
      + (selectable ? ' Playable.' : ''));
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
    attachInspector(wrapper, () => describeCard(card, state.pack),
      { isBusy: () => !!drag && drag.isDragging() });

    el.hand.appendChild(wrapper);
  });

  el.handSort.textContent = SORT_LABELS[handPrefs.mode] || SORT_LABELS.auto;
  el.handSort.setAttribute('aria-label', `Hand order: ${SORT_LABELS[handPrefs.mode]}. Change it.`);
  el.handSort.hidden = engineHand.length < 2;
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

function renderAnnounceBar(state) {
  const options = humanAnnouncements(state).filter((a) => a.type === 'announce');
  el.announceBar.replaceChildren();
  el.announceBar.hidden = options.length === 0;
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
  el.actionBar.hidden = !hint;
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
  el.status.classList.toggle('status-bar--thinking', !state.gameOver && !forfeited && !humanActs);

  const scored = showsScores(state);
  el.scoreChip.hidden = !scored;
  if (scored) {
    const phase = state.playerVars[HUMAN_SEAT]?.phase;
    el.scoreChipValue.textContent = typeof phase === 'number'
      ? `Ph ${phase} · ${state.scores[HUMAN_SEAT]}`
      : String(state.scores[HUMAN_SEAT]);
    el.scoreChip.setAttribute('aria-label', `Your score: ${state.scores[HUMAN_SEAT]}. Open the scoreboard.`);
  }
  el.forfeitButton.hidden = state.gameOver || forfeited;
}

function statusTextFor(state, acting) {
  if (forfeited) return 'Game forfeited.';
  if (state.gameOver) return `Game over — ${seatLabel(state.winner)} ${state.winner === HUMAN_SEAT ? 'win' : 'wins'}!`;
  if (state.turn.phase === 'pass') {
    return acting.includes(HUMAN_SEAT) ? 'Passing — your pick' : 'Waiting for passes…';
  }
  return acting.includes(HUMAN_SEAT) ? 'Your turn' : `${seatLabel(state.turn.seat)}'s turn`;
}

function render(state, message) {
  // A render mid-drag would replace the very node the pointer is holding.
  // Deferred, then replayed by the controller's settle callback.
  if (drag && drag.isDragging()) {
    pendingRender = { state, message };
    return;
  }
  selection = pruneSelection(state, selection);
  const acting = actingSeatsOf(state);
  const humanActs = acting.includes(HUMAN_SEAT);
  const humanMoves = humanActs ? enumerateLegalMoves(state, HUMAN_SEAT) : [];
  const ui = buildUiModel(state, { seat: HUMAN_SEAT, moves: humanMoves, acts: humanActs, selection });
  const draggable = draggableSources(state, { seat: HUMAN_SEAT, acts: humanActs });
  const stagger = dealAnimation && motionAllowed();

  renderStatusBar(state, acting);
  renderSeats(state, stagger, acting, ui);
  renderContractLadder(state);
  renderCenterZones(state, ui, draggable);
  renderPlayerZones(state, ui, draggable);
  renderHand(state, ui, stagger, draggable);
  renderAnnounceBar(state);
  renderActionBar(state, ui, humanActs);
  dealAnimation = false;

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
function opponentOutcomes(state, stats, { forfeit }) {
  const rank = stats && !forfeit
    ? placements(state.pack, { totals: stats.totals, winner: state.winner, seats: state.seats })
    : null;
  return seating
    .filter((identity) => identity.isBot && identity.opponentKey)
    .map((identity) => ({
      key: identity.opponentKey,
      // Walking away is not beating anybody.
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
 * End the match in the books: record it, stop it resuming, and show the panel.
 *
 * One door for both endings — the engine deciding, and the player walking
 * away — because the two must agree about what a loss is. They differ only in
 * `forfeit`, which is recorded honestly rather than being hidden as an
 * ordinary defeat.
 */
function concludeMatch(state, { forfeit = false } = {}) {
  cancelBotTurn();
  cancelAnnouncementBeats();
  matchDirty = false;
  // A finished match is not something to resume into.
  clearMatch(state.pack.id);
  const stats = safeStats(state);
  recordResult(state.pack.id, {
    won: !forfeit && state.winner === HUMAN_SEAT,
    forfeit,
    opponents: opponentOutcomes(state, stats, { forfeit }),
  });
  showGameOver(state, {
    seating,
    stats,
    recordText: recordSentence(state),
    heroFaces: heroFaces(state.pack),
    renderFace: (face) => cardArt.face(face),
    forfeited: forfeit,
  });
}

/** Display-only faces from the manifest; see schema `heroCards`. */
function heroFaces(pack) {
  const faces = pack.manifest.heroCards;
  return Array.isArray(faces) ? faces.slice(0, 3) : [];
}

async function forfeitMatch() {
  if (!liveState || liveState.gameOver || forfeited) return;
  const name = livePack.manifest.name;
  const ok = await confirmAction(
    `Forfeit your game of ${name}? It counts as a loss and the game is gone.`,
    { okLabel: 'Forfeit', cancelLabel: 'Keep playing' },
  );
  if (!ok || !liveState || liveState.gameOver || forfeited) return;
  forfeited = true;
  if (drag) drag.cancel();
  concludeMatch(liveState, { forfeit: true });
  render(liveState);
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
    // Before the render, so the overlay can show the updated record — this
    // game's counters are ours to display (§4: `stats` is the surface whose
    // formatting the game owns).
    concludeMatch(state);
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
    if (attr) {
      const options = attr === 'suit'
        ? ['clubs', 'diamonds', 'hearts', 'spades']
        : [...new Set([...state.pack.cardsById.values()].map((c) => c.color).filter(Boolean))];
      const picked = await promptChoice(attr, options);
      // Backed out, or the table closed while the prompt was open — either way
      // this move belongs to a match that is no longer the one on screen.
      if (picked === null || myEpoch !== epoch) return;
      move = { ...move, choice: { [attr]: picked } };
    }
  }

  if (move.type === 'discard' && move.cards) {
    const card = cardById(state, move.cards[0]);
    const effect = card?.effect;
    if (effect?.type === 'skipTarget' && effect.on === 'discard' && move.choice?.target === undefined) {
      const others = [];
      for (let s = 0; s < state.seats; s++) if (s !== HUMAN_SEAT) others.push(s);
      const labels = others.map((s) => identityOf(s).name);
      const picked = await promptChoice('player to skip', labels);
      if (picked === null || myEpoch !== epoch) return;
      move = { ...move, choice: { ...(move.choice || {}), target: others[labels.indexOf(picked)] } };
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
function onHandCard(state, cardId, card, sourceNode, ui) {
  const handAddr = handAddress(HUMAN_SEAT);

  if (ui.mode === 'tap') {
    // One tap plays it — the destination is implicit, and the wild's question
    // is asked by performHumanMove, the same place a drop asks it.
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
  } else {
    selection = isSelected(selection, handAddr, cardId) ? null : { from: handAddr, cardIds: [cardId] };
  }
  render(state);
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
  if (state.gameOver || forfeited) return;
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
  if (state.gameOver || forfeited) return;
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
  forfeited = false;
  pendingRender = null;
  botCallDecision.clear();
  botCatchDecision.clear();
  if (drag) drag.cancel();
  // Before the first render, and from the PACK rather than the manifest alone:
  // the deck is what tells a style which colours it actually has to draw.
  cardArt = makeCardRenderer(pack.manifest, pack.cardsById);
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

function startGame(pack) {
  cancelBotTurn();
  cancelAnnouncementBeats();
  // Date.now() is only the entropy source. The seed itself is persisted with
  // the match from the first write, which is what makes the log replayable
  // (src/engine/replay.js) rather than merely re-runnable — and, since the
  // seating is derived from it, what rotates the opponents per game.
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
  cancelAnnouncementBeats();
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
  cancelAnnouncementBeats();
  closeChoiceModal();
  closeConfirm();
  hideInspector();
  if (drag) drag.cancel();
  flushTable();
  liveState = null;
  livePack = null;
  selection = null;
  seating = [];
  forfeited = false;
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
  });

  initPanels({
    onContinueRound: () => dismissRoundSummary(),
    onPlayAgain: () => livePack && startGame(livePack),
    onLobby: () => exitToLobby(),
    onCloseScoreboard: () => {},
  });

  // The fan's spacing is the one thing that depends on how much room the row
  // has, and it is a custom property rather than a re-render — so reacting to
  // a width change costs two measurements, not a repaint of the table.
  watchHandWidth();

  el.lobbyButton.addEventListener('click', () => exitToLobby());
  el.scoreChip.addEventListener('click', () => openScoreboard());
  el.forfeitButton.addEventListener('click', () => { forfeitMatch(); });
  el.handSort.addEventListener('click', () => cycleHandSort());
}

/** Surface a boot/open failure on the table's own log line. */
export function reportTableError(message) {
  el.log.textContent = message;
}
