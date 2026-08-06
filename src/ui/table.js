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
import { validateMove, applyMove, legalMovesFor } from '../engine/movePipeline.js';
import { rehydrateMatch, packVersionChanged } from '../engine/replay.js';
import { baseId } from '../engine/selectors.js';
import { handValue } from '../engine/scoring.js';
import { buildSeating } from '../players/roster.js';
import { makeCardRenderer } from './cardStyles/index.js';
import { fetchPack } from './packSource.js';
import { flyCard, landOn, motionAllowed, flightLayer, rectOf, cardSizedRect } from './flight.js';
import { safeCssColor } from './css.js';
import { createSession, stopSession } from './session.js';
import { createBotDriver, botVerb } from './botDriver.js';
import { schedule } from './clock.js';
import { line, svgNode, clearSvgCache } from './dom.js';
import { promptChoice, closeChoiceDialog } from './choiceDialog.js';
import { createCelebrations } from './celebrations.js';
import { createContractLadder } from './contractLadder.js';
import { createMatchRecord } from './matchRecord.js';
import { watchHandGestures } from './handGestures.js';
import { closeConfirm, confirmAction } from './confirm.js';
import { createDragController } from './dragController.js';
import { attachInspector, hideInspector } from './inspector.js';
import {
  describeCard, describeZone, cardAriaLabel, zoneAriaLabel, zoneBadge, cardName,
} from './describe.js';
import {
  interactionMode, stagingPhase, buildUiModel, dropCandidates, draggableSources, pruneSelection,
  isSelected, handAddress, implicitLandingZone,
  describeContractItem,
} from './interaction.js';
import {
  orderHand, reorder, nextMode, isSortMode, fanStep, classifyHandGesture, SORT_LABELS,
} from './handOrder.js';
import {
  initPanels, showRoundSummary, hideRoundSummary,
  showScoreboard, showGameOver, hideAllPanels, showRules, awaitFinalLook,
} from './panels.js';
import { packRules } from './rules.js';
import {
  rememberPack, loadSettings, saveMatch, loadMatch, clearMatch, recordForfeit,
  loadHandPrefs, saveHandPrefs,
} from '../arcade/storage.js';
import {
  playDeal, playCardPlayed, playDraw, playShuffle, playInvalid, playWin, playAnnouncement,
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
};

// ONE OPEN MATCH, ONE OBJECT (src/ui/session.js). Everything a match owns —
// its state, its seating, its card art, the selection, the timers, the bot
// decision caches — lives on `session`, created by adoptMatch and nulled by
// closeTable. It replaced twenty-five module-level mutables that two different
// functions hand-reset in overlapping subsets.
//
// `epoch` stays a module counter because its whole job is to OUTLIVE a session:
// scheduleNextTurn's callback checks its own epoch is still current before
// touching anything, so "Play again", a save import (onStateReplaced) and
// leaving for the lobby all bump it to drop a turn already in flight.
let session = null;
let epoch = 0;

// The screen's own furniture, not the match's.
let settings = null;
let exitToLobby = () => {};
// Pointer choreography for lifting a card (src/ui/dragController.js), created
// once at init and reused by every match.
let drag = null;
// A renderer with no pack behind it, for the moment before the first match.
const EMPTY_ART = makeCardRenderer({});

// openTable() awaits a fetch, and the player can be back in the lobby before it
// lands. `epoch` cannot cover that gap — it is bumped when the match is ADOPTED,
// which is the thing we are trying not to do. So opening carries its own token:
// whoever bumps it last owns the screen, and a superseded open returns quietly.
let openToken = 0;

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
  return session?.seating[seat] || { seat, name: `Seat ${seat}`, icon: '', color: '#6b7280', isBot: seat !== HUMAN_SEAT };
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

/**
 * Cards this seat has already committed to a simultaneous phase — drawn as
 * chosen, and no longer choosable.
 *
 * Trick-taking keeps them in a double-underscore-PRIVATE player var, which this
 * file read directly in three places. Asking the template is the difference
 * between the platform knowing that Hearts has a passing phase and the platform
 * knowing that some genres commit a selection before playing it.
 */
function committedSelectionOf(state, seat) {
  return state.pack.template.committedSelection?.(makeCtx(state), seat) ?? null;
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

/** The open match's card art, or an empty renderer before there is one. */
function art() {
  return session ? session.cardArt : EMPTY_ART;
}

/**
 * The open match, or null. Functions rather than fields because "is a table
 * open" is asked all over this file as a truthiness check, and a session that
 * has been nulled has to answer it honestly from every one of them.
 */
function liveState() {
  return session ? session.state : null;
}

function livePack() {
  return session ? session.pack : null;
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
/** Note `key` as present, and mark `node` as fresh if it was not before. */
function markEntry(node, key) {
  if (!session || !session.enteringKeys) return node;
  session.enteringKeys.add(key);
  if (session.shownCardKeys.has(key)) return node;
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

/**
 * Flash a seat — good or bad — as the thing that just happened to it.
 *
 * The three-line ritual (remove both classes, force a reflow so the animation
 * restarts, add one back) was written out verbatim three times: a trick landing,
 * an action card landing, and the winner at game over. Forgetting the reflow is
 * a pulse that silently does not play the second time.
 *
 * A seat is `el.hand` when it is yours and a plate otherwise, which is the other
 * half of what all three copies had in common.
 */
function pulseSeat(seat, tone = 'good') {
  const node = seat === HUMAN_SEAT
    ? el.hand
    : el.opponentsTop.querySelector(`[data-seat="${seat}"]`);
  if (!node) return;
  node.classList.remove('zone-celebrate', 'zone-lament');
  void node.offsetWidth;
  node.classList.add(tone === 'bad' ? 'zone-lament' : 'zone-celebrate');
}

/** The consistent "it is this player's turn" token, worn by seats and the action bar. */
function turnToken() {
  const token = document.createElement('span');
  token.className = 'turn-token';
  token.setAttribute('aria-hidden', 'true');
  return token;
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
    // Hidden shared zones (Stockpile's `recycled`) stay off the table; a
    // hidden zone that is ALSO a control says so with `interactive` in its
    // definition, which is how the draw pile keeps its place without this line
    // knowing that a draw pile is called "draw".
    if (def.visibility === 'none' && !def.interactive) continue;
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
  stack.classList.toggle('pile-stack--picked', !!sourceTop && isSelected(session.selection, address, sourceTop));

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
  const isSpread = def.layout === 'spread';
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
      ? art().back()
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
      const node = placeCard(art().face(card), i, visible.length, cardId, isTop);
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
      const markup = (!isTop && secretUnder) ? art().back() : art().face(card);
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
    if (!liveState() || !session.ui) return;
    const move = session.ui.readyTargets.get(address);
    if (move) {
      performHumanMove(liveState(), move, stack);
      return;
    }
    const top = session.ui.sourceTops.get(address);
    if (top === undefined) return;
    session.selection = isSelected(session.selection, address, top) ? null : { from: address, cardIds: [top] };
    renderSelection(liveState());
  });
  paintPileState(stack, ui);

  // Any face-up top card the human owns lifts, whether or not it has anywhere
  // to go — a refused drop simply snaps home. That is the "cards on felt"
  // feel, and it is also how a player LEARNS what is legal.
  if (draggableTop && topNode && drag) {
    drag.attach(topNode, { kind: 'pile', from: address, cardId: draggableTop });
  }

  attachInspector(stack, () => (liveState() ? describeZone(liveState(), inst) : null),
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
  // The template answers what the table is matching on and whether the top card
  // can show it for itself (`onCard`) — this file used to rebuild the
  // `active${Attr}` var name and probe the discard by name.
  const match = state.pack.template.activeMatch?.(makeCtx(state));
  if (!match || match.address !== address || match.onCard) return null;
  // Through the pack's palette and safeCssColor: pack data reaching a style
  // property (§7b). A pack with no palette entry for this value still gets
  // the word, just without the dot.
  //
  // `cardArt.theme.palette`, not `cardArt.palette` — the renderer exposes its
  // resolved theme, and the shorter spelling was undefined, so this swatch
  // never once appeared. Same typo, same silent nothing, in flashFelt.
  return { attr: match.attr, value: match.value, tint: safeCssColor(art().theme.palette?.[match.value]) };
}

// The template's own grouping, asked for rather than re-derived: this used to
// be a copy of contract-rummy's getMeldGroups fallback whose comment admitted
// it was a copy, which is exactly how two answers to "what are this seat's
// melds" start to disagree.
function meldGroupsOf(state, seat) {
  return state.pack.template.getMeldGroups?.(makeCtx(state), seat) || [];
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
      if (card) cards.appendChild(svgNode(art().face(card), 'meld-chip__card'));
    }
    chip.appendChild(cards);
    chip.appendChild(line('meld-chip__label', what));

    chip.dataset.meldLabel = `${owner} ${what}, ${group.cards.length} cards.`;
    // Late-bound for the same reason the piles are — see paintPileState.
    chip.addEventListener('click', () => {
      const ready = session.ui && session.ui.readyMelds.get(meldKey);
      if (ready && liveState()) performHumanMove(liveState(), ready, chip);
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
 * What a pile has cost so far, for a pile whose contents are worth points.
 *
 * `def.showsHeldValue` rather than `def.id === 'won'`: a hidden pile holding
 * scoring cards is a fact about the zone, so it is declared beside the zone
 * (trick-taking's defaultZones). Hearts is the game that made it worth showing;
 * it is not the rule.
 */
function heldValueText(state, def, address) {
  if (!def.showsHeldValue || !state.zones.has(address) || !state.pack.scoring?.cardValues) return null;
  const cards = state.zones.cards(address).map((id) => cardById(state, id)).filter(Boolean);
  const pts = handValue(cards, state.pack.scoring);
  return pts > 0 ? `${pts} pts` : null;
}

/** Does this pack keep a running score worth showing on the felt? */
function showsScores(state) {
  return state.pack.scoring?.accumulate === true
    || state.scores.some((n) => n !== 0);
}

/**
 * What a seat's score chip says — the template's answer, or the plain total.
 *
 * Contract rummy's "score" that matters is the contract you have reached and
 * the points are the tiebreak, which is why a plain total is the wrong default
 * for it and right for everything else. That used to be
 * `typeof playerVars[seat].phase === 'number'`, written out twice in this file,
 * beside three more direct reads of the same private var.
 *
 * @returns { short, long, aria } — `short` fits an opponent's plate, `long` is
 *          the human's own chip, which has room for both numbers.
 */
function scoreChipFor(state, seat) {
  const declared = state.pack.template.scoreChip?.(makeCtx(state), seat);
  if (declared) return declared;
  const score = String(state.scores[seat]);
  return { short: score, long: score, aria: `${score} points` };
}

function seatScoreChip(state, seat) {
  const chip = document.createElement('span');
  chip.className = 'seat__score';
  const { short, aria } = scoreChipFor(state, seat);
  chip.textContent = short;
  chip.setAttribute('aria-label', aria);
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
    mini.style.setProperty('--back-panel', art().backPanel);
    for (let i = 0; i < count; i++) {
      const last = i === count - 1;
      const node = last
        ? svgNode(art().back(), stagger ? 'card-deal' : '')
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
          const pts = heldValueText(state, inst.def, inst.address);
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
      button.addEventListener('click', () => liveState() && performAnnouncement(liveState(), catchMove));
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
      const pts = heldValueText(state, inst.def, inst.address);
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
  if (!session.selection || session.selection.from !== handAddress(HUMAN_SEAT)) return [];
  return session.selection.cardIds;
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
    const node = svgNode(art().face(card), 'stage-card');
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
  session.displayedHand = orderHand(engineHand, (id) => cardById(state, id), session.handPrefs.mode, session.handPrefs.order);
  const committedPass = committedSelectionOf(state, HUMAN_SEAT);

  // Gathered cards are drawn in the tray instead, so the fan holds only what
  // is still to be chosen from. handPrefs.order is NOT touched — a card put
  // back returns to the exact slot it left, because it never left the order.
  const staged = new Set(stagedIds(state, ui));
  const fanned = staged.size ? session.displayedHand.filter((id) => !staged.has(id)) : session.displayedHand;

  fanned.forEach((cardId, i) => {
    const card = cardById(state, cardId);
    const selectable = ui.handSelectable.has(cardId);
    const selected = isSelected(session.selection, handAddr, cardId) || (committedPass || []).includes(cardId);
    // A card you cannot play is DRAWN as one — grey stock, deeper ink, baked
    // into the art (src/ui/cardStyles/shared.js). It used to be the live card
    // under `opacity: 0.78`, which cost a composited layer per unplayable card
    // per frame and faded the rank you are reading to find out why it is
    // unplayable. Only the hand does this: a pile or an opponent's card is not
    // yours to play, so there is nothing for it to say there.
    const wrapper = svgNode(art().face(card, !selectable),
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
      { isBusy: () => (!!drag && drag.isDragging()) || !!gestures?.smartSelectArmed() });

    el.hand.appendChild(wrapper);
  });

  el.handSort.textContent = SORT_LABELS[session.handPrefs.mode] || SORT_LABELS.auto;
  el.handSort.setAttribute('aria-label', `Hand order: ${SORT_LABELS[session.handPrefs.mode]}. Change it.`);
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
    window.addEventListener('resize', () => { if (liveState()) layoutHand(); });
    return;
  }
  // Observing the ROW, not the hand: the hand's own width is what layoutHand
  // changes, so watching it would be a feedback loop.
  new ResizeObserver(() => { if (liveState()) layoutHand(); }).observe(el.handRow);
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
    button.addEventListener('click', () => liveState() && performAnnouncement(liveState(), option));
    el.announceBar.appendChild(button);
  }
}

function renderActionBar(state, ui, humanActs) {
  const waitingOnPass = interactionMode(state) === 'pass'
    && !humanActs && !state.gameOver
    && committedSelectionOf(state, HUMAN_SEAT) !== null;
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
      if (!liveState()) return;
      performHumanMove(liveState(), ui.action.makeMove(), el.actionButton);
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
    el.scoreChipValue.textContent = scoreChipFor(state, HUMAN_SEAT).long;
    el.scoreChip.setAttribute('aria-label', `Your score: ${state.scores[HUMAN_SEAT]}. Open the scoreboard.`);
  }
}

function statusTextFor(state, acting) {
  if (state.gameOver) return `Game over — ${winnerSentence(state)}`;
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
    session.pendingRender = { state };
    return;
  }
  session.selection = pruneSelection(state, session.selection);
  const acting = actingSeatsOf(state);
  const humanActs = acting.includes(HUMAN_SEAT);
  const humanMoves = humanActs ? legalMovesFor(state, HUMAN_SEAT) : [];
  const ui = buildUiModel(state, { seat: HUMAN_SEAT, moves: humanMoves, acts: humanActs, selection: session.selection });
  session.ui = ui;

  const handAddr = handAddress(HUMAN_SEAT);
  const committedPass = committedSelectionOf(state, HUMAN_SEAT) || [];
  for (const wrapper of el.hand.children) {
    const cardId = wrapper.dataset.cardId;
    const selected = isSelected(session.selection, handAddr, cardId) || committedPass.includes(cardId);
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
    session.pendingRender = { state, message };
    return;
  }
  // Collected as the sub-renderers run; swapped in at the end so the NEXT
  // render knows what was already on the felt (see markEntry above).
  session.enteringKeys = new Set();
  session.selection = pruneSelection(state, session.selection);
  const acting = actingSeatsOf(state);
  const humanActs = acting.includes(HUMAN_SEAT);
  const humanMoves = humanActs ? legalMovesFor(state, HUMAN_SEAT) : [];
  const ui = buildUiModel(state, { seat: HUMAN_SEAT, moves: humanMoves, acts: humanActs, selection: session.selection });
  const draggable = draggableSources(state, { seat: HUMAN_SEAT, acts: humanActs });
  const stagger = session.dealAnimation && motionAllowed();

  session.ui = ui;

  renderStatusBar(state, acting);
  renderSeats(state, stagger, acting, ui);
  if (ladder) ladder.render(state);
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
  session.dealAnimation = false;
  session.shownCardKeys = session.enteringKeys;
  session.enteringKeys = null;

  // A game-ending move can arrive with no message (the human's own winning play) or a
  // stale one from the mover ("Bot 2 played" right before Bot 2's own hand emptied) —
  // gameOver always wins the log line over whatever was passed in.
  if (state.gameOver) {
    el.log.textContent = winnerSentence(state);
  } else if (message) {
    el.log.textContent = message;
  }
}

/** Re-render after a drag settles, replaying whatever was deferred. */
function onDragSettled() {
  const deferred = session.pendingRender;
  session.pendingRender = null;
  if (!liveState()) return;
  render(deferred ? deferred.state : liveState(), deferred ? deferred.message : undefined);
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
  const state = liveState();
  if (!state) return null;
  const card = cardById(state, handle.cardId);
  if (!card) return null;
  hideInspector();
  // The drag owns the gesture from here; the peek raise would fight the ghost
  // for the same card, and the hand's own pointerup may never arrive.
  if (gestures) gestures.clearPeek();

  const acting = actingSeatsOf(state);
  const humanActs = acting.includes(HUMAN_SEAT);
  const targets = [];

  if (humanActs) {
    const moves = legalMovesFor(state, HUMAN_SEAT);
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

  return { markup: art().face(card), targets };
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
  if (!livePack() || !liveState()) return;
  session.handPrefs = { mode: 'manual', order: reorder(session.displayedHand, cardId, index) };
  saveHandPrefs(livePack().id, session.handPrefs);
  render(liveState());
}

function cycleHandSort() {
  if (!liveState() || !livePack()) return;
  const mode = nextMode(session.handPrefs.mode);
  session.handPrefs = {
    // Switching AWAY from manual keeps the permutation: the player gets their
    // arrangement back when they cycle round to it, instead of being punished
    // for glancing at a sorted view.
    mode: isSortMode(mode) ? mode : 'auto',
    order: session.handPrefs.mode === 'manual' ? session.displayedHand.slice() : session.handPrefs.order,
  };
  saveHandPrefs(livePack().id, session.handPrefs);
  render(liveState());
}

/* ------------------------------------------------------------------ *
 * Geometry for card travel — the parts that need the table's own elements.
 * `rectOf` and `cardSizedRect` moved to src/ui/flight.js, which already owns
 * the flying and where dragController's verbatim copy of rectOf now points too.
 * ------------------------------------------------------------------ */

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
    flyCard(card ? art().face(card) : art().back(), from, to, { fade: true });
    return;
  }
  if (move.type === 'hit') {
    const card = cardById(state, move.cards?.[0]);
    const to = cardSizedRect(zoneRect(`melds.${move.choice?.seat}`), from.width);
    if (card && to) flyCard(art().face(card), from, to, { fade: true });
    return;
  }
  if (move.type !== 'playCard' && move.type !== 'discard') return;
  const card = cardById(state, move.cards && move.cards[0]);
  if (!card) return;
  const address = implicitLandingZone(state, move);
  if (!address) return;
  const node = zoneStackNode(address);
  const topNode = node ? node.querySelector('.pile-stack__top') : null;
  landOn(topNode, flyCard(art().face(card), from, rectOf(topNode) || zoneRect(address)));
}

/* ------------------------------------------------------------------ *
 * Table moments — src/ui/celebrations.js owns the banners, the trick
 * gather, the action-card narration and the penalty flight. These are the
 * thin wrappers that hand it the open session.
 * ------------------------------------------------------------------ */

let moments = null;
let ladder = null;
let gestures = null;
let record = null;

function hideBanner() { if (moments) moments.hideBanner(session); }
function showBanner(text, tone) { if (moments) moments.showBanner(session, text, tone); }
function celebrateTrick(state, ev) { if (moments) moments.celebrateTrick(session, state, ev); }
function celebrateAction(state, events) { return moments ? moments.celebrateAction(session, state, events) : null; }
function animatePenaltyDraw(state, seat, count, delay) { if (moments) moments.animatePenaltyDraw(state, seat, count, delay); }

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
  if (!liveState()) return;
  const state = liveState();
  const myEpoch = epoch;
  const leader = Math.max(...state.scores);
  const ahead = state.scores[HUMAN_SEAT] >= leader;
  const ok = await confirmAction(
    `End this ${state.pack.manifest.name} match after ${state.roundNumber - 1} `
    + `${state.roundNumber - 1 === 1 ? 'round' : 'rounds'}?`
    + (ahead ? '' : ' It counts as a forfeit.'),
    { okLabel: 'End match', cancelLabel: 'Keep playing' },
  );
  if (!ok || myEpoch !== epoch || liveState() !== state) return;

  cancelBotTurn();
  cancelAnnouncementBeats();
  clearMatch(state.pack.id);
  recordForfeit(state.pack.id, session.seating);
  session.roundSummaryOpen = false;
  hideRoundSummary();
  exitToLobby();
}

function dismissRoundSummary() {
  // The SESSION says whether we are between rounds; the panel merely shows it.
  // This used to branch on `!el.roundOverlay.hidden` (panels.isRoundSummaryOpen),
  // which made a DOM attribute the only record of a game-state fact — and one
  // that any other code path hiding the overlay would silently erase.
  if (!session || !session.roundSummaryOpen || !liveState()) return;
  session.roundSummaryOpen = false;
  hideRoundSummary();
  session.dealAnimation = true;
  playDeal(liveState().seats);
  render(liveState(), `Round ${liveState().roundNumber}.`);
  scheduleNextTurn();
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Write the match. §17.3 says a match-critical write must CHECK its result, and
 * this one did not: a quota-full or otherwise refused save returned false and
 * the table carried on as if the game were safe, so the loss only surfaced when
 * the player came back to a lobby tile that had forgotten their game.
 *
 * Said once per session, not once per move: a storage backend that has started
 * refusing writes will refuse the next forty too, and forty identical banners
 * is not information.
 */
let saveFailureReported = false;

function persistMatch() {
  const state = liveState();
  if (!state) return;
  const ok = saveMatch(state);
  if (ok !== false || saveFailureReported) return;
  saveFailureReported = true;
  reportTableError('This game could not be saved — it may not be here when you come back.');
}

/**
 * Synchronous by construction — onSuspend calls this directly (§6b).
 *
 * This used to be `if (matchDirty) persistMatch()`, and `matchDirty` was never
 * once set true: every assignment in the file wrote `false`. So the flush wired
 * to Arcade.onSuspend was a provable no-op, and the comment claiming the
 * opening deal reached storage through it was wrong. It reached storage because
 * every mutation path calls persistMatch() synchronously — which is also why
 * deleting the flag costs nothing. persistMatch is idempotent and a match log
 * is a few KB, so the honest flush is simply to write.
 */
export function flushTable() {
  persistMatch();
}

/* ------------------------------------------------------------------ *
 * Stats and the record
 * ------------------------------------------------------------------ */

/**
 * Who won, in the sentence the felt says it in.
 *
 * One phrasing, three former callers: the status bar said "Game over — You
 * win!", the log line said the same thing built a different way, and this said
 * a third. `seatLabel` already falls back to a plate name, so the extra
 * `session.seating[winner] ? … : …` here was a fourth spelling of the same
 * lookup.
 */
function winnerSentence(state) {
  return state.winner === HUMAN_SEAT ? 'You win!' : `${seatLabel(state.winner)} wins.`;
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
  const who = move.actor === HUMAN_SEAT ? 'you' : seatLabel(move.actor);
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
  pulseSeat(state.winner, 'good');
  Arcade.session.setTimeout(async () => {
    if (myEpoch !== epoch) return;
    const acknowledged = await awaitFinalLook(winnerSentence(state), finalPlaySentence(state, move));
    // Closed under it, or a new game started while it was up — either way these
    // results belong to a match that is no longer the one on screen.
    if (!acknowledged || myEpoch !== epoch) return;
    showGameOver(state, ending);
  }, 700);
}

function openScoreboard() {
  if (!liveState()) return;
  showScoreboard(liveState(), session.seating, record.safeStats(liveState()));
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
  soundReactions(state);
}

/**
 * The sounds a move's REACTIONS make, whatever kind of move surfaced them.
 *
 * A reshuffle is not inferred from pile counts: the engine's reactions announce
 * themselves on state.events (src/engine/state.js), and 'recycled' during a move
 * IS the shuffle. Split out of applyStateChange because an ANNOUNCEMENT can
 * surface one too — a challenge penalty-draw that empties the pile recycles it —
 * and the announcement path skipped this entirely, so that shuffle was silent.
 */
function soundReactions(state) {
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
    const ending = record.concludeMatch(state);
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
      session.roundSummaryOpen = true;
      showRoundSummary(state, roundOver, session.seating);
    }, trick ? 900 : 250);
    return;
  }

  scheduleNextTurn();
  scheduleAnnouncementBeats();
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

/**
 * How many questions one move may owe. A ceiling, not a budget: the loop below
 * is driven by the template answering null, and this only stops a hook that
 * never stops asking from hanging the table.
 */
const MAX_PENDING_CHOICES = 6;

/**
 * Fill in everything `move` still owes, asking the player where the answer is
 * genuinely theirs.
 *
 * ONE HOOK, ASKED IN A LOOP, INSTEAD OF THREE HARDCODED EFFECT SCHEMAS. This
 * used to be: a `choose: 'player'` branch, a colour/suit branch with the four
 * French suits written out (wrong for any nonstandard deck), a call to the
 * contract-rummy-specific `wildChoice`, and a
 * `effect.type === 'skipTarget' && effect.on === 'discard'` special case — four
 * pieces of effect-schema knowledge in the platform's move gate. The template
 * now names the question and says where the answer goes; this renders it.
 *
 * A QUESTION WITH ONE ANSWER IS NOT A QUESTION. At a two-hander there is exactly
 * one other player, and a dialog confirming the only living opponent is a tax on
 * every seven you play — so a single option is applied without asking, which is
 * the same judgement contract-rummy makes about a set (one possible value, never
 * asked).
 *
 * @returns the completed move, or null if the player backed out.
 */
async function fillPendingChoices(state, move, myEpoch) {
  const template = state.pack.template;
  if (!template.pendingChoice) return move;
  for (let asked = 0; asked < MAX_PENDING_CHOICES; asked++) {
    const ask = template.pendingChoice(makeCtx(state), move);
    if (!ask || !ask.options?.length) return move;

    // A seat is a number the template cannot dress: its name and mark belong to
    // the roster (src/players/roster.js), which is the platform's business.
    const options = ask.options.map((o) => {
      if (ask.kind !== 'seat') return { value: o.value, label: o.label ?? String(o.value) };
      const identity = identityOf(o.value);
      return { value: o.value, label: o.label ?? identity.name, icon: identity.icon || null };
    });

    let picked;
    if (options.length === 1) {
      picked = options[0].value;
    } else {
      picked = await promptChoice(art(), ask.prompt || ask.attr, options,
        { card: ask.cardId ? cardById(state, ask.cardId) : null });
      // Backed out, or the table closed while the prompt was open — either way
      // this move belongs to a match that is no longer the one on screen.
      if (picked === null || myEpoch !== epoch) return null;
    }
    move = ask.apply(move, picked);
  }
  return move;
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

  const completed = await fillPendingChoices(state, move, myEpoch);
  if (completed === null || myEpoch !== epoch) return;
  move = completed;

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
  if (session.selection && session.selection.from !== handAddr) session.selection = null;
  if (ui.handMulti) {
    const ids = session.selection ? session.selection.cardIds.slice() : [];
    const at = ids.indexOf(cardId);
    if (at !== -1) ids.splice(at, 1);
    else ids.push(cardId);
    session.selection = ids.length ? { from: handAddr, cardIds: ids } : null;
    // The card moves between the fan and the tray, so the fan's child count
    // changes and it has to be rebuilt and re-measured — the fast path below
    // deliberately does neither. The flight covers the rebuild.
    const from = rectOf(sourceNode);
    render(state);
    flyToStage(state, cardId, from);
    return;
  }
  session.selection = isSelected(session.selection, handAddr, cardId) ? null : { from: handAddr, cardIds: [cardId] };
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
  flyCard(art().face(card), from, to, { duration: 180 })
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
  if (myEpoch !== epoch || !liveState()) return;
  const check = validateMove(state, move);
  // The window closed while the timer ran — somebody else got there first, or
  // the target played. That is an ordinary outcome, not an error.
  if (!check.legal) return;

  applyMove(state, move);
  soundReactions(state);
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
  // An announcement can end a round — a challenge penalty that empties the
  // draw pile, a declaration that is the last thing before somebody goes out —
  // and the summary is `afterMove`'s job, which this path deliberately does not
  // re-enter (re-scheduling the turn would restart a bot's think time every
  // time anybody spoke). So the ONE thing it has to notice for itself is that.
  const roundOver = state.events.find((e) => e.type === 'roundOver' && !e.over);
  if (roundOver) {
    cancelAnnouncementBeats();
    const beatEpoch = epoch;
    Arcade.session.setTimeout(() => {
      if (beatEpoch !== epoch) return;
      session.roundSummaryOpen = true;
      showRoundSummary(state, roundOver, session.seating);
    }, 250);
    return;
  }
  scheduleAnnouncementBeats();
}

/* ------------------------------------------------------------------ *
 * The bot driver — src/ui/botDriver.js owns the timers and the persona rolls.
 * These are its four seams back into the felt.
 * ------------------------------------------------------------------ */

let bots = null;

function cancelBotTurn() { if (bots) bots.cancelTurn(session); }
function cancelAnnouncementBeats() { if (bots) bots.cancelBeats(session); }
function scheduleNextTurn() { if (bots) bots.scheduleNextTurn(session, epoch); }
function scheduleAnnouncementBeats() { if (bots) bots.scheduleAnnouncementBeats(session, epoch); }

/* ------------------------------------------------------------------ *
 * Match lifecycle
 * ------------------------------------------------------------------ */

/**
 * Take over the screen for `state`. THE ONLY PLACE A SESSION IS BORN.
 *
 * A fresh object rather than a field-by-field reset, which is what this used to
 * be — and the two bot-decision caches are exactly the ones the other half of
 * the ritual (closeTable) forgot, so a persona's "did they remember to declare?"
 * roll could survive into a match that had not been dealt when it was made.
 */
function adoptMatch(pack, state, message, { dealing = false } = {}) {
  epoch += 1;
  stopSession(session);
  if (drag) drag.cancel();
  session = createSession({
    pack,
    state,
    // Who is at this table — derived from the match SEED, so a resumed game
    // re-seats the same opponents and a fresh deal brings new ones.
    seating: buildSeating(state.seed, state.seats, { humanSeat: HUMAN_SEAT, humanName: humanName() }),
    // From the PACK rather than the manifest alone: the deck is what tells a
    // style which colours it actually has to draw. Built once per match rather
    // than per render — resolving a theme walks the whole deck.
    cardArt: makeCardRenderer(pack.manifest, pack.cardsById),
    handPrefs: loadHandPrefs(pack.id),
  });
  // Set on the NEW session, not before it exists: a fresh deal staggers its
  // cards in, a resumed match must not (the cards have been there all along).
  session.dealAnimation = dealing;
  // The parsed-SVG cache is keyed by markup the OLD renderer produced, so it is
  // dead weight from here on — and left alone it would accumulate one entry per
  // card per pack for as long as the tab is open.
  clearSvgCache();
  hideAllPanels();
  hideBanner();
  render(state, message);
  persistMatch();
  scheduleNextTurn();
  scheduleAnnouncementBeats();
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
  playDeal(seatCount);
  adoptMatch(state.pack, state, `Playing ${pack.manifest.name}.`, { dealing: true });
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
  closeChoiceDialog();

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
    // Asked BEFORE the replay, because a version bump is the one cause of a
    // failed replay we can name. Reordering two entries in a deck file changes
    // cardsById's insertion order, which changes the seeded shuffle, which
    // deals every stored match a different hand — so the log replays into a
    // state its own moves are illegal in. "The rules changed" is the honest
    // sentence; "could not replay" is not one a player can do anything with.
    const rulesMoved = packVersionChanged(pack, stored);
    try {
      if (rulesMoved) throw new Error(`pack version changed: ${stored.packVersion} → ${pack.manifest.version}`);
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
      if (rulesMoved) reportTableError(`${pack.manifest.name}'s rules have changed — dealing a fresh game.`);
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
  closeChoiceDialog();
  closeConfirm();
  hideInspector();
  if (drag) drag.cancel();
  flushTable();
  // ONE RESET POINT. Everything a match owned — its timers, its selection, its
  // bot decisions, its idea of which cards were already on the felt — goes with
  // the object. There is no longer a list here to fall out of date with the one
  // in adoptMatch.
  hideBanner();
  stopSession(session);
  session = null;
  hideAllPanels();
  if (ladder) ladder.hide();
}

export function isTableOpen() {
  return liveState() !== null;
}

/** Re-render in place — onResume, and after a settings change. */
export function rerenderTable() {
  settings = loadSettings();
  if (liveState()) render(liveState());
}

export function initTable({ onExit }) {
  exitToLobby = onExit;
  settings = loadSettings();

  drag = createDragController({
    layer: flightLayer,
    onLift: onDragLift,
    onSettle: onDragSettled,
    // Only a hand card can be scrubbed along; a pile top has no row to read.
    classifyGesture: ({ dx, dy, handle }) => (
      handle.kind === 'hand' ? classifyHandGesture({ dx, dy }) : 'drag'
    ),
  });

  // The bot driver takes its seams rather than reaching for module state — see
  // src/ui/botDriver.js for why it is the first thing out of this file.
  record = createMatchRecord({
    humanSeat: HUMAN_SEAT,
    seating: () => session.seating,
    art,
    // The record is written on the way out of a match, so the timers stop
    // first — a bot turn landing after the books are closed would reopen it.
    onConclude: () => { cancelBotTurn(); cancelAnnouncementBeats(); },
  });

  ladder = createContractLadder({
    el: el.contractLadder,
    humanSeat: HUMAN_SEAT,
    identityOf,
    attachInspector,
    isBusy: () => !!drag && drag.isDragging(),
  });

  moments = createCelebrations({
    humanSeat: HUMAN_SEAT,
    seatLabel,
    currentEpoch: () => epoch,
    el,
    art,
    zoneRect,
    seatRect,
    pulseSeat,
    cardById,
  });

  bots = createBotDriver({
    currentEpoch: () => epoch,
    botDelayMs: () => settings.botDelayMs,
    humanSeat: HUMAN_SEAT,
    identityOf,
    actingSeatsOf,
    announcementsFor,
    playMove: (state, move, seat) => {
      const from = move.type === 'draw'
        ? (zoneRect(move.from ?? 'draw') || seatRect(seat))
        : seatRect(seat);
      applyStateChange(state, move, { far: true });
      afterMove(state, move, from, `${identityOf(seat).name} ${botVerb(state.pack.template, move.type)}.`);
    },
    playAnnouncement: (state, move, myEpoch) => performAnnouncement(state, move, myEpoch),
    onError: reportTableError,
  });

  initPanels({
    onContinueRound: () => dismissRoundSummary(),
    onPlayAgain: () => livePack() && startGame(livePack(), liveState()?.seats),
    onLobby: () => exitToLobby(),
    onEndMatch: () => endMatchFromSummary(),
    onRules: () => livePack() && showRules(packRules(livePack())),
    onCloseScoreboard: () => {},
  });

  // The fan's spacing is the one thing that depends on how much room the row
  // has, and it is a custom property rather than a re-render — so reacting to
  // a width change costs two measurements, not a repaint of the table.
  watchHandWidth();
  ladder.watch(liveState);
  gestures = watchHandGestures({
    hand: el.hand,
    session: () => session,
    humanSeat: HUMAN_SEAT,
    cardById,
    onSelect: onHandCard,
    // A full render: the gathered cards leave the fan for the tray.
    onGathered: (state, count) => render(state, `Gathered ${count} cards.`),
  });

  el.lobbyButton.addEventListener('click', () => exitToLobby());
  el.scoreChip.addEventListener('click', () => openScoreboard());
  el.handSort.addEventListener('click', () => cycleHandSort());
}

/** Surface a boot/open failure on the table's own log line. */
export function reportTableError(message) {
  el.log.textContent = message;
}
