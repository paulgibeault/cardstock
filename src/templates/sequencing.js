// Sequencing template (design doc §13.4). Validates against Stockpile.
// Shared build piles fill 1..buildRule.to in order (wilds fill any slot); each player
// races to empty their stock pile through hand/stock/discard plays, ending their turn
// by discarding one card to an own numbered discard pile.

import { selectorMatches, selectorMatchesAny } from '../engine/selectors.js';
import { initializeDeckInto } from '../engine/state.js';
import { evaluateGameOver } from '../engine/scoring.js';
import { resolveByPlayers } from '../engine/deal.js';

// Zone addresses this template cares about are always `<kind>[.n].<seat>` for
// per-player zones (hand/stock/discard) — the seat is always the last segment.
function zoneKindAndSeat(address) {
  const parts = address.split('.');
  return { kind: parts[0], seat: Number(parts[parts.length - 1]) };
}

function isWildCard(ctx, card) {
  return selectorMatches(card, `tag:${ctx.rules.wilds.tag}`);
}

// The rank a build pile needs next is just its current length offset from buildRule.from
// — using pile position instead of parsing the top card's rank is what makes this work
// when the top card is a wild (which has no numeric rank of its own).
function requiredRank(ctx, buildAddr) {
  return ctx.countIn(buildAddr) + ctx.rules.buildRule.from;
}

function cardPlayableOn(ctx, card, buildAddr) {
  if (ctx.countIn(buildAddr) === 0) return selectorMatchesAny(card, ctx.rules.buildStart);
  return isWildCard(ctx, card) || Number(card.rank) === requiredRank(ctx, buildAddr);
}

function topUpHand(ctx, seat) {
  const to = ctx.rules.handRefill?.to ?? 5;
  const handAddr = ctx.zoneAddr('hand', seat);
  while (ctx.countIn(handAddr) < to) {
    const top = ctx.topOf('draw');
    if (top === undefined) break; // draw and recycled both exhausted
    ctx.moveCards([top], 'draw', handAddr);
  }
}

function applyPlayCard(ctx, move) {
  const seat = move.actor;
  const from = move.from;

  ctx.moveCards([move.cards[0]], from, move.to);

  const { kind } = zoneKindAndSeat(from);
  if (kind === 'stock' && ctx.countIn(from) === 0) {
    ctx.setGameOver(seat);
    return;
  }
  if (kind === 'hand' && ctx.countIn(from) === 0 && ctx.rules.handRefill?.onEmptyMidTurn) {
    topUpHand(ctx, seat);
  }
}

function applyDiscard(ctx, move) {
  const seat = move.actor;
  ctx.moveCards([move.cards[0]], move.from, move.to);
  ctx.setTurnSeat(ctx.nextSeat(seat));
  ctx.setPhase('play');
  if (ctx.rules.handRefill?.atTurnStart) topUpHand(ctx, ctx.turn.seat);
}

const sequencing = {
  id: 'sequencing',

  defaultZones(rules) {
    const buildCapacity = rules.buildRule.to - rules.buildRule.from + 1;
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'free', facing: 'up' },
      // `top` is the honest model for a stock: the card on top is face up and
      // everything under it is face down and genuinely secret.
      { id: 'stock', per: 'player', visibility: 'top', layout: 'stack', order: 'stack', facing: 'up', label: 'Stock' },
      // A personal discard pile is NOT secret, and calling it `top` was a
      // modelling slip rather than a rule. At a real table these piles are
      // face up and fanned — everybody can read every card in them, and only
      // the TOP one is playable. Playability is enforced by validateMove
      // ("Only the top card of that pile is playable"), which is where it
      // belongs; visibility is about who may SEE, and the answer here is
      // everyone. The distinction started mattering when piles learned to fan
      // (`ui.zoneOverlap`): under `top` the fan drew card backs, hiding
      // information the game has never hidden. It will matter more when Phase
      // 8 filters per-seat views off this same field.
      { id: 'discard', per: 'player', count: rules.discardPiles, visibility: 'all', layout: 'stack', order: 'stack', facing: 'up', label: 'Discard' },
      { id: 'build', per: 'shared', count: rules.buildPiles, visibility: 'top', layout: 'stack', order: 'stack', facing: 'up', capacity: buildCapacity, label: 'Build' },
      { id: 'recycled', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down' },
      { id: 'draw', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Draw' },
    ];
  },

  defaultReactions() {
    return [
      { when: 'zoneFull:build.*', do: 'moveAll', to: 'recycled' },
      { when: 'zoneEmpty:draw', do: 'recycle', from: 'recycled', shuffle: true },
    ];
  },

  setup(ctx) {
    initializeDeckInto(ctx.state, 'draw');
    const stockSize = resolveByPlayers(ctx.rules.stockSize, ctx.seats);
    for (let s = 0; s < ctx.seats; s++) {
      for (let i = 0; i < stockSize; i++) {
        const top = ctx.topOf('draw');
        if (top === undefined) break;
        ctx.moveCards([top], 'draw', ctx.zoneAddr('stock', s));
      }
    }
    for (let s = 0; s < ctx.seats; s++) topUpHand(ctx, s);
    ctx.setPhase('play');
  },

  validateMove(ctx, move) {
    if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");

    if (move.type === 'playCard') {
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const { from, to } = move;
      if (!from || !ctx.hasZone(from)) return ctx.fail('bad-zone', 'Unknown source zone.');
      if (!to || !ctx.hasZone(to)) return ctx.fail('bad-zone', 'Unknown target zone.');

      const { kind, seat } = zoneKindAndSeat(from);
      if (!ctx.rules.playableFrom.includes(kind)) return ctx.fail('not-playable-from', `Cannot play from ${kind}.`);
      if (seat !== move.actor) return ctx.fail('not-your-zone', 'That is not your pile.');

      // Stock and discard are physical piles — only the top card is playable. Hand
      // cards can be played in any order.
      if (kind === 'stock' || kind === 'discard') {
        if (ctx.topOf(from) !== cardId) return ctx.fail('not-top', 'Only the top card of that pile is playable.');
      } else if (!ctx.cardIdsIn(from).includes(cardId)) {
        return ctx.fail('not-in-hand', 'That card is not in your hand.');
      }

      if (!to.startsWith('build.')) return ctx.fail('bad-target', 'Cards are played onto a build pile.');

      const card = ctx.cardById(cardId);
      if (!cardPlayableOn(ctx, card, to)) {
        return ctx.fail('build-rule', 'That card cannot be played on that build pile right now.');
      }
      return ctx.ok();
    }

    if (move.type === 'discard') {
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const { from, to } = move;
      if (!from || !ctx.hasZone(from)) return ctx.fail('bad-zone', 'Unknown source zone.');
      if (!to || !ctx.hasZone(to)) return ctx.fail('bad-zone', 'Unknown target zone.');

      const src = zoneKindAndSeat(from);
      if (src.kind !== 'hand' || src.seat !== move.actor) return ctx.fail('not-your-hand', 'You can only discard from your own hand.');
      if (!ctx.cardIdsIn(from).includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');

      const dst = zoneKindAndSeat(to);
      if (dst.kind !== 'discard' || dst.seat !== move.actor) return ctx.fail('not-your-pile', 'You can only discard to your own pile.');
      return ctx.ok();
    }

    // A player with an empty hand and no legal stock/discard play (only reachable
    // once the shared draw pile — and its recycled backlog — are both exhausted)
    // has nothing to end their turn with; the turn just passes.
    if (move.type === 'pass') return ctx.ok();

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    if (move.type === 'playCard') applyPlayCard(ctx, move);
    else if (move.type === 'discard') applyDiscard(ctx, move);
    else if (move.type === 'pass') ctx.setTurnSeat(ctx.nextSeat(move.actor));
  },

  enumerateLegalMoves(ctx, seat) {
    const moves = [];
    const sources = [];
    if (ctx.rules.playableFrom.includes('stock')) {
      const from = ctx.zoneAddr('stock', seat);
      const top = ctx.topOf(from);
      if (top !== undefined) sources.push({ cardId: top, from });
    }
    if (ctx.rules.playableFrom.includes('hand')) {
      const from = ctx.zoneAddr('hand', seat);
      for (const cardId of ctx.cardIdsIn(from)) sources.push({ cardId, from });
    }
    if (ctx.rules.playableFrom.includes('discard')) {
      for (let n = 1; n <= ctx.rules.discardPiles; n++) {
        const from = `discard.${n}.${seat}`;
        const top = ctx.topOf(from);
        if (top !== undefined) sources.push({ cardId: top, from });
      }
    }

    for (const { cardId, from } of sources) {
      const card = ctx.cardById(cardId);
      for (let n = 1; n <= ctx.rules.buildPiles; n++) {
        const to = `build.${n}`;
        if (cardPlayableOn(ctx, card, to)) moves.push({ actor: seat, type: 'playCard', cards: [cardId], from, to });
      }
    }

    const handAddr = ctx.zoneAddr('hand', seat);
    for (const cardId of ctx.cardIdsIn(handAddr)) {
      for (let n = 1; n <= ctx.rules.discardPiles; n++) {
        moves.push({ actor: seat, type: 'discard', cards: [cardId], from: handAddr, to: `discard.${n}.${seat}` });
      }
    }

    if (moves.length === 0) moves.push({ actor: seat, type: 'pass' });
    return moves;
  },

  isRoundOver(ctx) {
    return ctx.state.gameOver;
  },

  scoreRound() {
    return {};
  },

  isGameOver(ctx) {
    return evaluateGameOver(ctx)?.over ?? ctx.state.gameOver;
  },

  botHeuristic(ctx, move) {
    if (move.type === 'pass') return -2;
    if (move.type === 'discard') return -1;
    // Emptying the stock pile is the win condition — prioritize stock plays, then
    // clearing discard piles (frees them up), then hand plays.
    const { kind } = zoneKindAndSeat(move.from);
    if (kind === 'stock') return 3;
    if (kind === 'discard') return 2;
    return 1;
  },
};

export default sequencing;
