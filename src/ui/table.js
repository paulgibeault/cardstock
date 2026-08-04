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

import { createState } from '../engine/state.js';
import { makeCtx } from '../engine/context.js';
import { validateMove, applyMove, enumerateLegalMoves } from '../engine/movePipeline.js';
import { rehydrateMatch } from '../engine/replay.js';
import { chooseBotMove } from '../engine/bot.js';
import { baseId } from '../engine/selectors.js';
import { makeCardRenderer } from './cardStyles/index.js';
import { fetchPack } from './packSource.js';
import { flyCard, landOn, motionAllowed } from './flight.js';
import { safeCssColor } from './css.js';
import {
  rememberPack, loadSettings, saveMatch, loadMatch, clearMatch, recordResult, readStats,
} from '../arcade/storage.js';
import {
  playDeal, playCardPlayed, playDraw, playShuffle, playInvalid, playWin,
} from '../arcade/audio.js';

const HUMAN_SEAT = 0;
const SEAT_COUNT = 3;

/** How many discards stay visible under the top one. Enough to read as a pile. */
const DISCARD_DEPTH = 3;

/**
 * Templates this table renders COMPLETELY, and can therefore be played through
 * from deal to game over.
 *
 * Everything else opens and is legible — hands, seats, and whichever shared
 * pile the pack has — but is missing the controls its genre needs: Hearts has
 * no way to pass three cards, Milestones cannot lay a meld down, Stockpile
 * cannot choose a build pile. The lobby reads this to label those tiles rather
 * than letting a player discover it two screens in (src/ui/lobby.js).
 *
 * This lives here because it is a fact about the UI, not about the packs. Move
 * a template out of this set by teaching the table its moves, not by editing a
 * manifest.
 */
export const FULLY_PLAYABLE_TEMPLATES = new Set(['shedding']);

const el = {
  screen: document.getElementById('table-screen'),
  status: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  gameName: document.getElementById('game-name'),
  lobbyButton: document.getElementById('lobby-button'),
  opponentsTop: document.getElementById('opponents-top'),
  drawSlot: document.getElementById('draw-slot'),
  drawPile: document.getElementById('draw-pile'),
  drawCount: document.getElementById('draw-count'),
  centerSlot: document.getElementById('center-slot'),
  centerPile: document.getElementById('center-pile'),
  centerLabel: document.getElementById('center-pile-label'),
  hand: document.getElementById('hand'),
  log: document.getElementById('log'),
  choiceModal: document.getElementById('choice-modal'),
  choicePrompt: document.getElementById('choice-prompt'),
  choicePanel: document.getElementById('choice-options'),
  choiceCancel: document.getElementById('choice-cancel'),
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
//
// Named `cardArt` and not `cards`, which is not fussiness: renderPiles already
// has a local `const cards` for the pile's contents, and a module-level `cards`
// is SHADOWED by it for the whole function — including the lines above the
// declaration, where it is in the temporal dead zone. That is a ReferenceError
// on the first render of every table, and nothing in the unit tests reaches it.
let cardArt = makeCardRenderer({});
let dealAnimation = false;
let botTimer = null;
let settings = null;
let exitToLobby = () => {};

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
 * Rendering
 * ------------------------------------------------------------------ */

function seatLabel(seat) {
  return seat === HUMAN_SEAT ? 'You' : `Bot ${seat}`;
}

// Own values, not pack input — these reach an inline style and never pass
// through anything a manifest can influence.
const SEAT_COLORS = ['#2f6fb0', '#b0603a', '#4a7a4e', '#7a5aa8', '#a8823a', '#3a8a8a', '#8a3a63', '#5a6a8a'];

function legalPlayCardIds(state) {
  if (state.turn.seat !== HUMAN_SEAT || state.gameOver) return new Set();
  const moves = enumerateLegalMoves(state, HUMAN_SEAT);
  return new Set(moves.filter((m) => m.type === 'playCard').map((m) => m.cards[0]));
}

// Card SVG is markup this repo authors, with every card-derived value escaped
// inside src/ui/cardStyles — so innerHTML on a fresh node is safe here in a way
// it is NOT for anything carrying a name or a label. Those use textContent.
function svgNode(markup, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.innerHTML = markup;
  return span;
}

function cardById(state, cardId) {
  return state.pack.cardsById.get(baseId(cardId));
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

function renderSeats(state, stagger) {
  el.opponentsTop.replaceChildren();
  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    if (seat === HUMAN_SEAT) continue;
    const count = state.zones.count(`hand.${seat}`);
    const active = !state.gameOver && state.turn.seat === seat;

    const wrap = document.createElement('div');
    wrap.className = `seat ${active ? 'seat--active' : ''}`;
    wrap.dataset.seat = String(seat);

    const head = document.createElement('div');
    head.className = 'seat__head';

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
    badge.setAttribute('aria-label', `${count} cards`);
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
    el.opponentsTop.appendChild(wrap);
  }
}

/**
 * The shared pile in the middle of the table, whichever one this pack has.
 *
 * Not every template has a discard: trick-taking collects into `trick`
 * instead, and sequencing's discards are per-player. Asking the state rather
 * than assuming is what stops a pack from throwing "Unknown zone address" the
 * moment it is opened — which is what Hearts did when the lobby first started
 * offering it.
 */
function centerZone(state) {
  if (state.zones.has('discard')) return 'discard';
  if (state.zones.has('trick')) return 'trick';
  return null;
}

function renderPiles(state, canDraw) {
  const hasDraw = state.zones.has('draw');
  el.drawSlot.hidden = !hasDraw;
  if (hasDraw) {
    const drawTop = state.zones.count('draw');
    el.drawPile.replaceChildren();
    el.drawPile.classList.toggle('pile-stack--deep', drawTop > 2);
    el.drawPile.classList.toggle('pile-stack--ready', canDraw);
    if (drawTop > 0) el.drawPile.appendChild(svgNode(cardArt.back(), 'pile-stack__top'));
    else el.drawPile.appendChild(svgNode('<div class="card-face card-face--empty"></div>', 'pile-stack__top'));
    el.drawPile.disabled = !canDraw;
    // The visible label is a count; the button needs to say what pressing it does.
    el.drawPile.setAttribute('aria-label', `Draw a card. ${drawTop} left in the pile.`);
    el.drawCount.textContent = `Draw (${drawTop})`;
  } else {
    el.drawPile.disabled = true;
  }

  const address = centerZone(state);
  el.centerSlot.hidden = !address;
  el.centerPile.replaceChildren();
  if (!address) return;

  // A discard keeps a few cards of HISTORY under the top one, stacked — a pile
  // that only ever shows one card reads as a slide viewer. A trick is not a
  // pile at all: every card in it is live information about who played what,
  // so it spreads instead of stacking and shows the whole trick.
  const isTrick = address === 'trick';
  const cards = state.zones.cards(address);
  const visible = isTrick ? cards.slice(-state.seats) : cards.slice(-DISCARD_DEPTH);
  el.centerPile.classList.toggle('pile-stack--spread', isTrick);

  visible.forEach((cardId, i) => {
    const card = cardById(state, cardId);
    if (!card) return;
    const isTop = i === visible.length - 1;
    const node = svgNode(cardArt.face(card), `pile-stack__card ${isTop ? 'pile-stack__top' : ''}`);
    node.style.setProperty('--stack-index', String(i - (visible.length - 1) / 2));
    node.style.setProperty('--stack-tilt', `${tiltFor(cardId, isTop && !isTrick ? 2 : 7).toFixed(2)}deg`);
    el.centerPile.appendChild(node);
  });

  const activeSuit = state.vars.activeSuit || state.vars.activeColor;
  el.centerLabel.textContent = isTrick
    ? `Trick (${cards.length})`
    : (activeSuit ? `Active: ${activeSuit}` : '');
}

function renderHand(state, legal, stagger) {
  el.hand.replaceChildren();
  const hand = state.zones.cards(`hand.${HUMAN_SEAT}`);
  hand.forEach((cardId, i) => {
    const card = cardById(state, cardId);
    const isLegal = legal.has(cardId);
    const wrapper = svgNode(cardArt.face(card),
      `card-face-wrap ${isLegal ? '' : 'card-face--disabled'} ${stagger ? 'card-deal' : ''}`);
    if (stagger) wrapper.style.animationDelay = `${i * 35}ms`;
    wrapper.querySelector('svg').classList.toggle('card-face--disabled', !isLegal);
    if (isLegal) {
      wrapper.classList.add('card-face-wrap--playable');
      wrapper.addEventListener('click', () => onPlayCard(state, cardId, card, wrapper));
    }
    el.hand.appendChild(wrapper);
  });
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

function render(state, message) {
  const legal = legalPlayCardIds(state);
  const stagger = dealAnimation && motionAllowed();

  const yourTurn = !state.gameOver && state.turn.seat === HUMAN_SEAT;
  el.statusText.textContent = state.gameOver
    ? `Game over — ${seatLabel(state.winner)} wins!`
    : (yourTurn ? 'Your turn' : `${seatLabel(state.turn.seat)}'s turn`);
  el.status.classList.toggle('status-bar--your-turn', yourTurn);
  el.status.classList.toggle('status-bar--thinking', !state.gameOver && !yourTurn);

  // Drawing is offered only when there is nothing legal to play, which is the
  // rule these packs share — so the pile lighting up is itself the hint that
  // you are stuck, and no separate prompt has to say so.
  const canDraw = yourTurn && legal.size === 0;

  renderSeats(state, stagger);
  renderPiles(state, canDraw);
  renderHand(state, legal, stagger);
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

function centerRect() {
  return rectOf(el.centerPile.querySelector('.pile-stack__top') || el.centerPile);
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
    const to = seatRect(move.actor);
    const card = move.actor === HUMAN_SEAT
      ? cardById(state, state.zones.cards(`hand.${HUMAN_SEAT}`).at(-1) || '')
      : null;
    flyCard(card ? cardArt.face(card) : cardArt.back(), from, to, { fade: true });
    return;
  }
  const card = cardById(state, move.cards && move.cards[0]);
  if (!card) return;
  landOn(el.centerPile.querySelector('.pile-stack__top'),
    flyCard(cardArt.face(card), from, centerRect()));
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

// The one place a move reaches the engine, so the sound of a move cannot drift
// from the fact of it. `far` is the opponent-vs-you signal the pack carries in
// space rather than timbre (js/soundpack.js).
//
// A reshuffle is derived rather than announced: recycling happens inside a zone
// reaction (src/engine/state.js), which the UI never sees, so the draw pile
// GROWING across a move is the observable event. That is the honest trigger —
// no other move can make it happen.
function applyStateChange(state, move, { far }) {
  const drawBefore = state.zones.has('draw') ? state.zones.count('draw') : 0;
  applyMove(state, move);
  const drawAfter = state.zones.has('draw') ? state.zones.count('draw') : 0;

  if (move.type === 'draw') playDraw();
  else playCardPlayed({ far });
  if (drawAfter > drawBefore) playShuffle();
}

// Every applied move funnels through here, whoever made it. Keeping the
// render/persist/schedule trio in one place is what stops a new move type from
// silently skipping the save.
function afterMove(state, move, from, message) {
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
    playWin();
    return;
  }
  render(state, message);
  animateMove(state, move, from);
  persistMatch();
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
 * Ask for a suit or colour, or null if the player backs out.
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

async function onPlayCard(state, cardId, card, sourceNode) {
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
  const move = { actor: HUMAN_SEAT, type: 'playCard', cards: [cardId], choice };
  const check = validateMove(state, move);
  if (!check.legal) {
    playInvalid();
    render(state, `Can't play that: ${check.reason}`);
    return;
  }
  const from = rectOf(sourceNode);
  applyStateChange(state, move, { far: false });
  afterMove(state, move, from);
}

function onDraw(state) {
  const move = { actor: HUMAN_SEAT, type: 'draw' };
  const check = validateMove(state, move);
  if (!check.legal) {
    playInvalid();
    return;
  }
  const from = rectOf(el.drawPile);
  applyStateChange(state, move, { far: false });
  afterMove(state, move, from);
}

function scheduleNextTurn(state, myEpoch) {
  if (state.gameOver || state.turn.seat === HUMAN_SEAT) return;
  // Arcade.session.setTimeout, not setTimeout: it freezes while the frame is
  // suspended (§6c — forgotten timers are the #1 battery drain in a hidden
  // iframe) and cancels itself when a save import replaces state. The epoch
  // guard is still needed for "Play again" and for leaving to the lobby, which
  // the SDK knows nothing about.
  botTimer = Arcade.session.setTimeout(() => {
    botTimer = null;
    if (myEpoch !== epoch) return; // superseded — drop the stale turn
    const seat = state.turn.seat;
    const move = chooseBotMove(state, seat);
    if (!move) return;
    const from = move.type === 'draw' ? rectOf(el.drawPile) : seatRect(seat);
    applyStateChange(state, move, { far: true });
    afterMove(state, move, from, `${seatLabel(seat)} ${move.type === 'draw' ? 'drew' : 'played'}.`);
  }, settings.botDelayMs);
}

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
  // Before the first render, and from the PACK rather than the manifest alone:
  // the deck is what tells a style which colours it actually has to draw.
  cardArt = makeCardRenderer(pack.manifest, pack.cardsById);
  el.gameOverOverlay.hidden = true;
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
  el.gameOverOverlay.hidden = true;
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

  el.drawPile.addEventListener('click', () => liveState && onDraw(liveState));
  el.playAgainButton.addEventListener('click', () => livePack && startGame(livePack));
  el.lobbyButton.addEventListener('click', () => exitToLobby());
  el.gameOverLobbyButton.addEventListener('click', () => exitToLobby());
}

/** Surface a boot/open failure on the table's own log line. */
export function reportTableError(message) {
  el.log.textContent = message;
}
