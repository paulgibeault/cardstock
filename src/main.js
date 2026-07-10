// Standalone bootstrap for solo bot play. Arcade SDK integration (design doc §17) is a
// later pass — this is deliberately a bare local prototype to prove the engine end to end.

import { loadPack } from './engine/packLoader.js';
import { createState } from './engine/state.js';
import { makeCtx } from './engine/context.js';
import { validateMove, applyMove, enumerateLegalMoves } from './engine/movePipeline.js';
import { chooseBotMove } from './engine/bot.js';
import { baseId } from './engine/selectors.js';
import { renderCardFaceSvg, renderCardBackSvg } from './ui/renderCard.js';

const HUMAN_SEAT = 0;
const SEAT_COUNT = 3;
const PACK_ID = new URLSearchParams(location.search).get('pack') || 'crazy-eights';
const BOT_DELAY_MS = 600;

const el = {
  status: document.getElementById('status-bar'),
  opponentsTop: document.getElementById('opponents-top'),
  drawPile: document.getElementById('draw-pile'),
  discardPile: document.getElementById('discard-pile'),
  hand: document.getElementById('hand'),
  log: document.getElementById('log'),
  drawButton: document.getElementById('draw-button'),
  choiceModal: document.getElementById('choice-modal'),
  choicePanel: document.querySelector('#choice-modal .panel'),
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function loadPackFromServer(packId) {
  const manifest = await fetchJson(`/packs/${packId}/manifest.json`);
  let deckJson;
  try {
    deckJson = await fetchJson(`/packs/${packId}/deck.json`);
  } catch {
    deckJson = undefined;
  }
  return loadPack(manifest, { deckJson });
}

function seatLabel(seat) {
  return seat === HUMAN_SEAT ? 'You' : `Bot ${seat}`;
}

function legalPlayCardIds(state) {
  if (state.turn.seat !== HUMAN_SEAT || state.gameOver) return new Set();
  const moves = enumerateLegalMoves(state, HUMAN_SEAT);
  return new Set(moves.filter((m) => m.type === 'playCard').map((m) => m.cards[0]));
}

function render(state, message) {
  const legal = legalPlayCardIds(state);

  el.status.querySelector('#status-text').textContent = state.gameOver
    ? `Game over — ${seatLabel(state.winner)} wins!`
    : `${seatLabel(state.turn.seat)}'s turn`;

  el.opponentsTop.innerHTML = '';
  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    if (seat === HUMAN_SEAT) continue;
    const wrap = document.createElement('div');
    const count = state.zones.count(`hand.${seat}`);
    wrap.innerHTML = `
      <div class="seat-label ${state.turn.seat === seat ? 'seat-label--active' : ''}">${seatLabel(seat)} (${count})</div>
      <div class="mini-hand">${Array.from({ length: count }, () => renderCardBackSvg()).join('')}</div>
    `;
    el.opponentsTop.appendChild(wrap);
  }

  const drawTop = state.zones.count('draw');
  el.drawPile.innerHTML = drawTop > 0 ? renderCardBackSvg() : '<div class="card-face"></div>';
  el.drawPile.nextElementSibling.textContent = `Draw (${drawTop})`;

  const discardTopId = state.zones.top('discard');
  const discardCard = discardTopId ? state.pack.cardsById.get(baseId(discardTopId)) : null;
  el.discardPile.innerHTML = discardCard ? renderCardFaceSvg(discardCard) : '';
  const activeSuit = state.vars.activeSuit || state.vars.activeColor;
  el.discardPile.nextElementSibling.textContent = activeSuit ? `Active: ${activeSuit}` : '';

  el.hand.innerHTML = '';
  const hand = state.zones.cards(`hand.${HUMAN_SEAT}`);
  for (const cardId of hand) {
    const card = state.pack.cardsById.get(baseId(cardId));
    const isLegal = legal.has(cardId);
    const wrapper = document.createElement('span');
    wrapper.className = `card-face-wrap ${isLegal ? '' : 'card-face--disabled'}`;
    wrapper.innerHTML = renderCardFaceSvg(card);
    wrapper.querySelector('svg').classList.toggle('card-face--disabled', !isLegal);
    if (isLegal) wrapper.addEventListener('click', () => onPlayCard(state, cardId, card));
    el.hand.appendChild(wrapper);
  }

  el.drawButton.disabled = state.turn.seat !== HUMAN_SEAT || state.gameOver || legal.size > 0;
  if (message) el.log.textContent = message;
}

function needsChoice(card) {
  const effect = card.effect;
  if (!effect || typeof effect === 'string') return null;
  return effect.choose || null;
}

async function promptChoice(attr, options) {
  el.choicePanel.innerHTML = '';
  el.choiceModal.hidden = false;
  return new Promise((resolve) => {
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.textContent = opt;
      btn.style.background = attr === 'color' || attr === 'suit' ? opt : '#eee';
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
    render(state, `Can't play that: ${check.reason}`);
    return;
  }
  applyMove(state, move);
  render(state);
  scheduleNextTurn(state);
}

function onDraw(state) {
  const move = { actor: HUMAN_SEAT, type: 'draw' };
  const check = validateMove(state, move);
  if (!check.legal) return;
  applyMove(state, move);
  render(state);
  scheduleNextTurn(state);
}

function scheduleNextTurn(state) {
  if (state.gameOver || state.turn.seat === HUMAN_SEAT) return;
  setTimeout(() => {
    const seat = state.turn.seat;
    const move = chooseBotMove(state, seat);
    if (!move) return;
    applyMove(state, move);
    render(state, `${seatLabel(seat)} played.`);
    scheduleNextTurn(state);
  }, BOT_DELAY_MS);
}

async function boot() {
  const pack = await loadPackFromServer(PACK_ID);
  const state = createState({ pack, seats: SEAT_COUNT, seed: Date.now() });
  const ctx = makeCtx(state);
  pack.template.setup(ctx);

  document.title = `Cardstock — ${pack.manifest.name}`;
  render(state, `Playing ${pack.manifest.name}.`);
  scheduleNextTurn(state);

  el.drawButton.addEventListener('click', () => onDraw(state));
}

boot().catch((err) => {
  console.error(err);
  el.log.textContent = `Failed to start: ${err.message}`;
});
