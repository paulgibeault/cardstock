// Shedding template (design doc §13.2). Validates against Crazy Eights and Wildfire.
// Match-and-discard: play a card matching the active state on any matchOn attribute
// (or a wild), first to empty hand wins.

import { runRoundScore, evaluateGameOver } from '../engine/scoring.js';
import { initializeDeckInto } from '../engine/state.js';

function resolveCount(spec, seats) {
  if (typeof spec === 'number') return spec;
  return spec.byPlayers?.[String(seats)] ?? spec.default;
}

function isWildEffect(effect) {
  if (!effect) return false;
  const type = typeof effect === 'string' ? effect : effect.type;
  return type === 'wild' || type === 'wildDrawN';
}

function effectOf(card) {
  return card.effect || null;
}

function activeVarName(attr) {
  return 'active' + attr[0].toUpperCase() + attr.slice(1);
}

// The "active" value for a matchOn attribute is an explicit var when a wild set one
// (e.g. activeSuit after a color choice); otherwise it's whatever the actual top-of-
// discard card carries for that attribute — ranks are never chosen by a wild, so they
// always fall through to this case.
function getActiveValue(ctx, attr) {
  const explicit = ctx.var(activeVarName(attr));
  if (explicit !== undefined) return explicit;
  const topId = ctx.topOf('discard');
  const topCard = topId !== undefined ? ctx.cardById(topId) : undefined;
  return topCard ? topCard[attr] : undefined;
}

function cardMatchesActive(ctx, card) {
  if (isWildEffect(effectOf(card))) return true;
  return ctx.rules.matchOn.some((attr) => {
    const active = getActiveValue(ctx, attr);
    return active !== undefined && card[attr] === active;
  });
}

function updateActiveAfterPlay(ctx, card, choice) {
  for (const attr of ctx.rules.matchOn) {
    if (choice && choice[attr] !== undefined) {
      ctx.setVar(activeVarName(attr), choice[attr]);
      continue;
    }
    if (card[attr] !== null && card[attr] !== undefined) {
      ctx.setVar(activeVarName(attr), card[attr]);
    }
    // Cards that don't define this attribute (e.g. a suitless wild) leave the
    // prior active value in place.
  }
}

function drawCards(ctx, seat, n) {
  for (let i = 0; i < n; i++) {
    const drawZone = ctx.zone('draw');
    if (drawZone.cards.length === 0) break; // truly exhausted (recycle already tried)
    const topId = drawZone.cards[drawZone.cards.length - 1];
    ctx.moveCards([topId], 'draw', ctx.zoneAddr('hand', seat));
  }
}

function lastCardCallVarName(cfg) {
  return `__${cfg.id}Called`;
}

function applyEffect(ctx, card, playerSeat, choice) {
  const effect = effectOf(card);
  const type = typeof effect === 'string' ? effect : effect.type;
  let advance = 1;

  if (type === 'skip') {
    advance = 2;
  } else if (type === 'reverse') {
    ctx.reverseDirection();
    advance = ctx.seats === 2 ? 2 : 1;
  } else if (type === 'drawN' || type === 'wildDrawN') {
    const target = ctx.nextSeat(playerSeat);
    drawCards(ctx, target, effect.n);
    advance = 2;
  } else if (type === 'swapHands') {
    const other = choice?.player;
    if (other !== undefined && other !== playerSeat) {
      const a = ctx.zoneAddr('hand', playerSeat);
      const b = ctx.zoneAddr('hand', other);
      const aCards = ctx.cardIdsIn(a).slice();
      const bCards = ctx.cardIdsIn(b).slice();
      ctx.moveCards(aCards, a, b);
      ctx.moveCards(bCards, b, a);
    }
    advance = 1;
  } else if (type === 'rotateHands') {
    const seats = ctx.seats;
    const snapshots = Array.from({ length: seats }, (_, s) => ctx.cardIdsIn(ctx.zoneAddr('hand', s)).slice());
    for (let s = 0; s < seats; s++) {
      const dest = ctx.nextSeat(s);
      if (dest === s || snapshots[s].length === 0) continue;
      ctx.moveCards(snapshots[s], ctx.zoneAddr('hand', s), ctx.zoneAddr('hand', dest));
    }
    advance = 1;
  }

  let seat = playerSeat;
  for (let i = 0; i < advance; i++) seat = ctx.nextSeat(seat);
  ctx.setTurnSeat(seat);
  ctx.setPhase('play');
}

function applyPlayCard(ctx, move) {
  const seat = move.actor;
  const cardId = move.cards[0];
  const card = ctx.cardById(cardId);

  ctx.moveCards([cardId], ctx.zoneAddr('hand', seat), 'discard');
  updateActiveAfterPlay(ctx, card, move.choice);

  const handLeft = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  if (handLeft.length === 0) {
    ctx.setGameOver(seat);
    return;
  }

  const effect = effectOf(card);
  if (effect) applyEffect(ctx, card, seat, move.choice);
  else {
    ctx.setTurnSeat(ctx.nextSeat(seat));
    ctx.setPhase('play');
  }
}

function applyDraw(ctx, move) {
  const seat = move.actor;
  const mode = ctx.rules.drawWhenStuck;
  if (mode === 'until-playable') {
    for (let i = 0; i < 200; i++) {
      const before = ctx.countIn('draw');
      drawCards(ctx, seat, 1);
      if (ctx.countIn('draw') === before && before === 0) break; // deck truly exhausted
      const newest = ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).slice(-1)[0];
      if (!newest) break;
      if (cardMatchesActive(ctx, ctx.cardById(newest))) break;
    }
  } else {
    drawCards(ctx, seat, mode ?? 1);
  }
  ctx.setTurnSeat(ctx.nextSeat(seat));
  ctx.setPhase('play');
}

const shedding = {
  id: 'shedding',

  defaultZones() {
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'sorted', facing: 'up' },
      { id: 'draw', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Draw' },
      { id: 'discard', per: 'shared', visibility: 'top', layout: 'stack', order: 'stack', facing: 'up', label: 'Discard' },
    ];
  },

  defaultReactions() {
    return [{ when: 'zoneEmpty:draw', do: 'recycle', from: 'discard', keepTop: true, shuffle: true }];
  },

  setup(ctx) {
    initializeDeckInto(ctx.state, 'draw');
    const dealCount = resolveCount(ctx.rules.deal, ctx.seats);
    for (let s = 0; s < ctx.seats; s++) {
      for (let i = 0; i < dealCount; i++) {
        const top = ctx.zone('draw').cards.slice(-1)[0];
        if (top === undefined) break;
        ctx.moveCards([top], 'draw', ctx.zoneAddr('hand', s));
      }
    }
    // Flip the starting discard card. If it happens to be a wild, its choice is
    // left unset (activeSuit/activeColor stay undefined) — pack authors are
    // expected to accept this at friend-scale; a stricter engine would reshuffle.
    const starter = ctx.zone('draw').cards.slice(-1)[0];
    if (starter !== undefined) {
      ctx.moveCards([starter], 'draw', 'discard');
      updateActiveAfterPlay(ctx, ctx.cardById(starter), null);
    }
    ctx.setPhase('play');
  },

  validateMove(ctx, move) {
    if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");

    if (move.type === 'playCard') {
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!hand.includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');
      const card = ctx.cardById(cardId);

      if (isWildEffect(effectOf(card))) {
        const effect = effectOf(card);
        const chooseAttr = typeof effect === 'object' ? effect.choose : undefined;
        if (chooseAttr && (!move.choice || move.choice[chooseAttr] === undefined)) {
          return ctx.fail('choice-required', `Choose a ${chooseAttr} to continue with.`);
        }
        return ctx.ok();
      }
      if (!cardMatchesActive(ctx, card)) {
        return ctx.fail('match', 'That card does not match the current suit/rank/color.');
      }
      return ctx.ok();
    }

    if (move.type === 'draw') {
      return ctx.ok();
    }

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    if (move.type === 'playCard') applyPlayCard(ctx, move);
    else if (move.type === 'draw') applyDraw(ctx, move);
  },

  applyAnnouncement(ctx, announcement) {
    const cfg = ctx.rules.lastCardCall;
    if (!cfg) return;
    const varName = lastCardCallVarName(cfg);
    if (announcement.id === cfg.id) {
      ctx.setPlayerVar(announcement.actor, varName, true);
      return;
    }
    if (announcement.challenge === cfg.id) {
      const target = announcement.target;
      const called = ctx.playerVar(target, varName);
      const handLen = ctx.cardIdsIn(ctx.zoneAddr('hand', target)).length;
      if (!called && handLen === (cfg.atHandCount ?? 1)) {
        drawCards(ctx, target, cfg.penalty?.draw ?? 0);
      }
    }
  },

  enumerateLegalMoves(ctx, seat) {
    const moves = [];
    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    for (const cardId of hand) {
      const card = ctx.cardById(cardId);
      const effect = effectOf(card);
      if (isWildEffect(effect)) {
        const chooseAttr = typeof effect === 'object' ? effect.choose : undefined;
        if (chooseAttr === 'suit') {
          for (const suit of ['clubs', 'diamonds', 'hearts', 'spades']) {
            moves.push({ actor: seat, type: 'playCard', cards: [cardId], choice: { suit } });
          }
        } else if (chooseAttr === 'color') {
          const colors = [...new Set([...ctx.pack.cardsById.values()].map((c) => c.color).filter(Boolean))];
          for (const color of colors) {
            moves.push({ actor: seat, type: 'playCard', cards: [cardId], choice: { color } });
          }
        } else {
          moves.push({ actor: seat, type: 'playCard', cards: [cardId] });
        }
      } else if (cardMatchesActive(ctx, card)) {
        moves.push({ actor: seat, type: 'playCard', cards: [cardId] });
      }
    }
    moves.push({ actor: seat, type: 'draw' });
    return moves;
  },

  isRoundOver(ctx) {
    return ctx.state.gameOver;
  },

  scoreRound(ctx) {
    return runRoundScore(ctx);
  },

  isGameOver(ctx) {
    return evaluateGameOver(ctx)?.over ?? ctx.state.gameOver;
  },

  botHeuristic(ctx, move) {
    if (move.type === 'draw') return -1;
    const card = ctx.cardById(move.cards[0]);
    // Prefer dumping high-value / action cards first — simple, deliberately dumb.
    return 1 + (card.value ?? 0) * 0.01 + (effectOf(card) ? 0.5 : 0);
  },
};

export default shedding;
