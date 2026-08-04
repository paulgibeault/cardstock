// The table UI and its arcade integration.
//
// Everything launcher-shaped goes through two doors: `src/arcade/storage.js`
// for persistence, and the `Arcade.*` calls below for lifecycle, settings and
// chrome. Standalone is first-class — nothing here gates gameplay on
// `Arcade.context.framed` (GAME_INTEGRATION §8); the SDK loads and works at
// the plain GitHub Pages URL too, with storage going straight to localStorage.

import { loadPack } from './engine/packLoader.js';
import { createState } from './engine/state.js';
import { makeCtx } from './engine/context.js';
import { validateMove, applyMove, enumerateLegalMoves } from './engine/movePipeline.js';
import { rehydrateMatch } from './engine/replay.js';
import { chooseBotMove } from './engine/bot.js';
import { baseId } from './engine/selectors.js';
import { renderCardFaceSvg, renderCardBackSvg } from './ui/renderCard.js';
import {
  resolvePackId, rememberPack, loadSettings, saveMatch, loadMatch, clearMatch,
  recordResult, readStats, registerStorageErrorHandler,
} from './arcade/storage.js';
import {
  playDeal, playCardPlayed, playDraw, playShuffle, playInvalid, playWin,
} from './arcade/audio.js';

const HUMAN_SEAT = 0;
const SEAT_COUNT = 3;

const el = {
  status: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  opponentsTop: document.getElementById('opponents-top'),
  drawPile: document.getElementById('draw-pile'),
  discardPile: document.getElementById('discard-pile'),
  hand: document.getElementById('hand'),
  log: document.getElementById('log'),
  drawButton: document.getElementById('draw-button'),
  choiceModal: document.getElementById('choice-modal'),
  choicePanel: document.querySelector('#choice-modal .panel'),
  gameOverOverlay: document.getElementById('game-over-overlay'),
  gameOverMessage: document.getElementById('game-over-message'),
  gameOverRecord: document.getElementById('game-over-record'),
  playAgainButton: document.getElementById('play-again-button'),
};

// `liveState`/`epoch` exist so "Play again" can start a fresh game without a bot-turn
// timer left over from the PREVIOUS game corrupting it — scheduleNextTurn's callback
// checks its own epoch is still current before touching anything. A save import
// (onStateReplaced) bumps the epoch for the same reason.
let livePack = null;
let liveState = null;
let epoch = 0;
let dealAnimation = false;
let botTimer = null;
let settings = null;

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
 * Pack loading
 * ------------------------------------------------------------------ */

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function loadPackFromServer(packId, variants) {
  // Relative, not root-relative — this must work whether the page sits at the origin
  // root, under a subpath (GitHub Pages project site: /cardstock/), or inside the
  // launcher's dev.sh staging (/<gameId>/). Resolves against the document's own URL
  // either way. `packId` is charset-validated before it gets here
  // (storage.js:isValidPackId) — it lands in a fetch path.
  const manifest = await fetchJson(`packs/${packId}/manifest.json`);

  // `deck` is either a BUILT-IN name (standard-52, standard-54, standard-52x<n>
  // — resolved in src/engine/cards.js) or a relative deck file. Ask only when
  // it names a file: speculatively probing for deck.json and swallowing the
  // failure cost a 404 on every crazy-eights and hearts boot, which is a real
  // console error and fails §13's "loads with no console errors".
  //
  // The name is manifest-supplied and lands in a fetch path, so it is
  // constrained to a plain filename in this directory — no slashes, no
  // traversal (§7b).
  let deckJson;
  if (/^[\w-]+\.json$/.test(manifest.deck || '')) {
    deckJson = await fetchJson(`packs/${packId}/${manifest.deck}`);
  }
  return loadPack(manifest, { deckJson, variants });
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function seatLabel(seat) {
  return seat === HUMAN_SEAT ? 'You' : `Bot ${seat}`;
}

function legalPlayCardIds(state) {
  if (state.turn.seat !== HUMAN_SEAT || state.gameOver) return new Set();
  const moves = enumerateLegalMoves(state, HUMAN_SEAT);
  return new Set(moves.filter((m) => m.type === 'playCard').map((m) => m.cards[0]));
}

// Card SVG is markup this repo authors, with every card-derived value escaped
// inside renderCard.js — so innerHTML on a fresh node is safe here in a way it
// is NOT for anything carrying a name or a label. Those use textContent.
function svgNode(markup, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.innerHTML = markup;
  return span;
}

function render(state, message) {
  const legal = legalPlayCardIds(state);
  const stagger = dealAnimation && !Arcade.settings.reducedMotion();

  el.statusText.textContent = state.gameOver
    ? `Game over — ${seatLabel(state.winner)} wins!`
    : `${seatLabel(state.turn.seat)}'s turn`;
  el.status.classList.toggle('status-bar--your-turn', !state.gameOver && state.turn.seat === HUMAN_SEAT);

  el.opponentsTop.replaceChildren();
  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    if (seat === HUMAN_SEAT) continue;
    const wrap = document.createElement('div');
    const count = state.zones.count(`hand.${seat}`);

    // textContent, not innerHTML. The label is literal today, but the instant
    // it becomes Arcade.player.name() or a peer name (Phase 8) an interpolated
    // template string is the peer-name XSS this fleet has shipped twice
    // (GAME_INTEGRATION §7b).
    const label = document.createElement('div');
    label.className = `seat-label ${state.turn.seat === seat ? 'seat-label--active' : ''}`;
    label.textContent = `${seatLabel(seat)} (${count})`;
    wrap.appendChild(label);

    const mini = document.createElement('div');
    mini.className = 'mini-hand';
    for (let i = 0; i < count; i++) {
      const back = svgNode(renderCardBackSvg(), stagger ? 'card-deal' : '');
      if (stagger) back.style.animationDelay = `${i * 35}ms`;
      mini.appendChild(back);
    }
    wrap.appendChild(mini);
    el.opponentsTop.appendChild(wrap);
  }

  const drawTop = state.zones.count('draw');
  el.drawPile.replaceChildren();
  if (drawTop > 0) el.drawPile.appendChild(svgNode(renderCardBackSvg()));
  else el.drawPile.appendChild(svgNode('<div class="card-face"></div>'));
  el.drawPile.nextElementSibling.textContent = `Draw (${drawTop})`;

  const discardTopId = state.zones.top('discard');
  const discardCard = discardTopId ? state.pack.cardsById.get(baseId(discardTopId)) : null;
  el.discardPile.replaceChildren();
  if (discardCard) el.discardPile.appendChild(svgNode(renderCardFaceSvg(discardCard)));
  const activeSuit = state.vars.activeSuit || state.vars.activeColor;
  el.discardPile.nextElementSibling.textContent = activeSuit ? `Active: ${activeSuit}` : '';

  el.hand.replaceChildren();
  const hand = state.zones.cards(`hand.${HUMAN_SEAT}`);
  hand.forEach((cardId, i) => {
    const card = state.pack.cardsById.get(baseId(cardId));
    const isLegal = legal.has(cardId);
    const wrapper = svgNode(renderCardFaceSvg(card),
      `card-face-wrap ${isLegal ? '' : 'card-face--disabled'} ${stagger ? 'card-deal' : ''}`);
    if (stagger) wrapper.style.animationDelay = `${i * 35}ms`;
    wrapper.querySelector('svg').classList.toggle('card-face--disabled', !isLegal);
    if (isLegal) wrapper.addEventListener('click', () => onPlayCard(state, cardId, card));
    el.hand.appendChild(wrapper);
  });
  dealAnimation = false;

  el.drawButton.disabled = state.turn.seat !== HUMAN_SEAT || state.gameOver || legal.size > 0;
  // A game-ending move can arrive with no message (the human's own winning play) or a
  // stale one from the mover ("Bot 2 played" right before Bot 2's own hand emptied) —
  // gameOver always wins the log line over whatever was passed in.
  if (state.gameOver) {
    el.log.textContent = `${seatLabel(state.winner)} wins!`;
    el.gameOverMessage.textContent = state.winner === HUMAN_SEAT ? 'You win! \u{1F389}' : `${seatLabel(state.winner)} wins.`;
    const record = readStats(state.pack.id);
    el.gameOverRecord.textContent = record.played
      ? `${record.won} of ${record.played} in ${state.pack.manifest.name}.`
      : '';
    el.gameOverOverlay.hidden = false;
  } else if (message) {
    el.log.textContent = message;
  }
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
function flushMatch() {
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
function afterMove(state, message) {
  if (state.gameOver) {
    matchDirty = false;
    // A finished match is not something to resume into.
    clearMatch();
    // Before the render, so the overlay can show the updated record — this
    // game's counters are ours to display (§4: `stats` is the surface whose
    // formatting the game owns).
    recordResult(state.pack.id, { won: state.winner === HUMAN_SEAT });
    render(state, message);
    playWin();
    return;
  }
  render(state, message);
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

// §7b: this value reaches an inline style. A CSS colour keyword or hex literal
// is all a pack has any reason to supply, and anything else — a url(), a
// var(), a stray `;` — is a pack doing something it should not.
const CSS_COLOR_RE = /^(?:[a-zA-Z]{3,20}|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;

async function promptChoice(attr, options) {
  el.choicePanel.replaceChildren();
  el.choiceModal.hidden = false;
  return new Promise((resolve) => {
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.textContent = opt;
      const asColour = (attr === 'color' || attr === 'suit') && CSS_COLOR_RE.test(opt);
      btn.style.background = asColour ? opt : '#eee';
      btn.addEventListener('click', () => {
        el.choiceModal.hidden = true;
        resolve(opt);
      });
      el.choicePanel.appendChild(btn);
    }
  });
}

async function onPlayCard(state, cardId, card) {
  let choice;
  const attr = needsChoice(card);
  if (attr) {
    const options =
      attr === 'suit'
        ? ['clubs', 'diamonds', 'hearts', 'spades']
        : [...new Set([...state.pack.cardsById.values()].map((c) => c.color).filter(Boolean))];
    choice = { [attr]: await promptChoice(attr, options) };
  }
  const move = { actor: HUMAN_SEAT, type: 'playCard', cards: [cardId], choice };
  const check = validateMove(state, move);
  if (!check.legal) {
    playInvalid();
    render(state, `Can't play that: ${check.reason}`);
    return;
  }
  applyStateChange(state, move, { far: false });
  afterMove(state);
}

function onDraw(state) {
  const move = { actor: HUMAN_SEAT, type: 'draw' };
  const check = validateMove(state, move);
  if (!check.legal) {
    playInvalid();
    return;
  }
  applyStateChange(state, move, { far: false });
  afterMove(state);
}

function scheduleNextTurn(state, myEpoch) {
  if (state.gameOver || state.turn.seat === HUMAN_SEAT) return;
  // Arcade.session.setTimeout, not setTimeout: it freezes while the frame is
  // suspended (§6c — forgotten timers are the #1 battery drain in a hidden
  // iframe) and cancels itself when a save import replaces state. The epoch
  // guard is still needed for "Play again", which the SDK knows nothing about.
  //
  // Session timers are correct for SOLO play only. Phase 8 replaces them with
  // host-wall-clock timeout EVENTS, because a timer that stops while one
  // player peeks at another game would desync a shared table.
  botTimer = Arcade.session.setTimeout(() => {
    botTimer = null;
    if (myEpoch !== epoch) return; // a "Play again" superseded this game — drop the stale turn
    const seat = state.turn.seat;
    const move = chooseBotMove(state, seat);
    if (!move) return;
    applyStateChange(state, move, { far: true });
    afterMove(state, `${seatLabel(seat)} played.`);
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
 * Open the pack storage points at, resuming the stored match when there is
 * one. Called at boot AND on every save import — `onStateReplaced` is a fresh
 * boot by contract (§3), so it runs exactly the same path.
 */
async function openFromStorage() {
  cancelBotTurn();
  matchDirty = false;

  const stored = loadMatch();
  const packId = resolvePackId(location.search);

  // A stored match pins the variant set: the same pack loaded with different
  // variants is a different rule set, and replaying a log against it diverges.
  const resuming = stored && stored.packId === packId;
  const pack = await loadPackFromServer(packId, resuming ? stored.variants : undefined);

  rememberPack(packId);
  Arcade.ui.setTitle(`Cardstock — ${pack.manifest.name}`);

  if (resuming) {
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
    clearMatch();
  }
  startGame(pack);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function wireLauncherHooks() {
  registerStorageErrorHandler();

  // §6b: the launcher holds teardown ~250 ms for a SYNCHRONOUS flush. Do not
  // start async work here expecting it to finish.
  Arcade.onSuspend(() => flushMatch());
  Arcade.onResume(() => { if (liveState) render(liveState); });

  // §3: treat a save import as a fresh boot. The imported save may not contain
  // the match that is on screen — or any match at all — so nothing about the
  // current view is assumed to survive.
  Arcade.onStateReplaced(() => {
    epoch += 1;
    cancelBotTurn();
    liveState = null;
    openFromStorage().catch(reportBootFailure);
  });

  // Theme, font scale, handedness and reduced motion are applied to <html> by
  // the SDK and handled in CSS (src/ui/table.css). Re-render anyway: the deal
  // stagger is JS-driven, so reducedMotion has to reach a render to take hold.
  Arcade.onSettingsChange(() => {
    settings = loadSettings();
    if (liveState) render(liveState);
  });
}

function reportBootFailure(err) {
  console.error(err);
  el.log.textContent = `Failed to start: ${err.message}`;
  Arcade.ui.toast('Could not start the game.', { kind: 'error', duration: 4000 });
}

async function boot() {
  // §2: nothing may read state before this resolves. Framed, a pre-ready read
  // returns empty because the launcher's snapshot has not arrived yet.
  await Arcade.ready;
  settings = loadSettings();
  wireLauncherHooks();

  el.drawButton.addEventListener('click', () => liveState && onDraw(liveState));
  el.playAgainButton.addEventListener('click', () => livePack && startGame(livePack));

  await openFromStorage();
}

boot().catch(reportBootFailure);
