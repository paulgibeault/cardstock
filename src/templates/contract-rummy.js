// Contract-rummy template (design doc §13.3). Validates against Phase 10.
// Each round every player pursues a personal contract (ctx.playerVar 'phase', 1-indexed
// into ctx.rules.contracts). Turn: draw -> meld (lay down once, then hit freely) -> discard.

import { runRoundScore } from '../engine/scoring.js';
import { initializeDeckInto } from '../engine/state.js';
import { selectorMatches } from '../engine/selectors.js';

function isWildCard(ctx, card) {
  const tag = ctx.rules.wilds?.tag;
  return !!tag && Array.isArray(card.tags) && card.tags.includes(tag);
}

function parseItem(item) {
  const m = /^(\w+)\((\d+)\)$/.exec(item || '');
  if (!m) return null;
  return { kind: m[1], n: Number(m[2]) };
}

// Contract satisfaction is a multiset match on item strings — order of melds in the
// move doesn't have to mirror the order the contract lists them in.
function itemsMatchContract(items, contract) {
  if (items.length !== contract.length) return false;
  const remaining = contract.slice();
  for (const item of items) {
    const idx = remaining.indexOf(item);
    if (idx === -1) return false;
    remaining.splice(idx, 1);
  }
  return true;
}

// Naturals-only type inference, used when a meld's declared item vocabulary isn't
// available (e.g. a hit target built directly by a rule test, with no stored grouping).
function inferKind(naturals) {
  if (naturals.length === 0) return null;
  if (naturals.every((c) => c.rank === naturals[0].rank)) return 'set';
  if (naturals.every((c) => c.color === naturals[0].color)) return 'colorGroup';
  return 'run';
}

// { ok: true } or { ok: false, rule, reason }. `cards` are card objects (not ids).
function validateMeldComposition(ctx, item, cards) {
  const parsed = parseItem(item);
  if (!parsed) return { ok: false, rule: 'invalid-meld', reason: `Unknown meld item "${item}".` };
  if (cards.length !== parsed.n) {
    return { ok: false, rule: 'invalid-meld', reason: 'Card count does not match the meld size.' };
  }

  const wildsCfg = ctx.rules.wilds || {};
  const naturals = cards.filter((c) => !isWildCard(ctx, c));
  const wildCount = cards.length - naturals.length;
  const minNaturals = wildsCfg.minNaturals ?? 0;
  if (naturals.length < minNaturals) {
    return { ok: false, rule: 'min-naturals', reason: 'A meld needs at least one natural (non-wild) card.' };
  }
  if (wildsCfg.maxPerMeld != null && wildCount > wildsCfg.maxPerMeld) {
    return { ok: false, rule: 'too-many-wilds', reason: 'Too many wild cards in one meld.' };
  }

  if (parsed.kind === 'set') {
    const rank = naturals[0].rank;
    if (naturals.some((c) => c.rank !== rank)) {
      return { ok: false, rule: 'invalid-meld', reason: 'All cards in a set must share a rank.' };
    }
  } else if (parsed.kind === 'run') {
    const ranks = naturals.map((c) => Number(c.rank));
    if (ranks.some((r) => Number.isNaN(r))) {
      return { ok: false, rule: 'invalid-meld', reason: 'Run cards must have numeric ranks.' };
    }
    if (new Set(ranks).size !== ranks.length) {
      return { ok: false, rule: 'invalid-meld', reason: 'A run cannot repeat a rank.' };
    }
    const span = Math.max(...ranks) - Math.min(...ranks) + 1;
    if (span > parsed.n) {
      return { ok: false, rule: 'invalid-meld', reason: 'Run cards do not fit within the meld size.' };
    }
  } else if (parsed.kind === 'colorGroup') {
    const color = naturals[0].color;
    if (naturals.some((c) => c.color !== color)) {
      return { ok: false, rule: 'invalid-meld', reason: 'All cards in a color group must share a color.' };
    }
  } else {
    return { ok: false, rule: 'invalid-meld', reason: `Unknown meld kind "${parsed.kind}".` };
  }

  return { ok: true };
}

// Per-seat meld groupings live in playerVar 'melds' ([{item, cards: [id,...]}]) so hits
// can target one meld among several without needing to slice a flat zone by position.
// A seat that never went through applyLayDown (e.g. a rule test that pokes the melds.N
// zone directly) is treated as one meld covering everything currently in that zone.
function getMeldGroups(ctx, seat) {
  const stored = ctx.playerVar(seat, 'melds');
  if (stored) return stored;
  const cards = ctx.cardIdsIn(ctx.zoneAddr('melds', seat)).slice();
  return cards.length ? [{ item: null, cards }] : [];
}

function meldKindOf(ctx, group) {
  const parsed = parseItem(group.item);
  if (parsed) return parsed.kind;
  return inferKind(group.cards.map((id) => ctx.cardById(id)).filter((c) => !isWildCard(ctx, c)));
}

function groupBy(items, keyFn) {
  const out = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

// Greedy search for `n` cards (from `available`, a list of {id, card}) satisfying one
// meld item, spending as few wilds as the natural cards on hand allow. Not globally
// optimal across a whole contract — good enough for a bot to make steady progress.
function findMeldForItem(ctx, parsed, available) {
  const wilds = available.filter((c) => isWildCard(ctx, c.card));
  const naturals = available.filter((c) => !isWildCard(ctx, c.card));
  const minNaturals = ctx.rules.wilds?.minNaturals ?? 0;
  const maxWilds = ctx.rules.wilds?.maxPerMeld;

  function tryComplete(naturalCards, wildsNeeded) {
    if (naturalCards.length < minNaturals) return null;
    if (maxWilds != null && wildsNeeded > maxWilds) return null;
    if (wildsNeeded > wilds.length) return null;
    return [...naturalCards.map((c) => c.id), ...wilds.slice(0, wildsNeeded).map((c) => c.id)];
  }

  if (parsed.kind === 'set' || parsed.kind === 'colorGroup') {
    const key = parsed.kind === 'set' ? (c) => c.card.rank : (c) => c.card.color;
    for (const group of groupBy(naturals, key).values()) {
      const naturalsUsed = group.slice(0, parsed.n);
      const found = tryComplete(naturalsUsed, parsed.n - naturalsUsed.length);
      if (found) return found;
    }
    return null;
  }

  if (parsed.kind === 'run') {
    const byRank = new Map();
    for (const c of naturals) {
      const r = Number(c.card.rank);
      if (!Number.isNaN(r) && !byRank.has(r)) byRank.set(r, c);
    }
    const ranks = [...byRank.keys()];
    if (ranks.length === 0) return null;
    const minR = Math.min(...ranks);
    const maxR = Math.max(...ranks);
    for (let start = minR - parsed.n + 1; start <= maxR; start++) {
      const naturalsUsed = [];
      let wildsNeeded = 0;
      for (let r = start; r < start + parsed.n; r++) {
        if (byRank.has(r)) naturalsUsed.push(byRank.get(r));
        else wildsNeeded++;
      }
      const found = tryComplete(naturalsUsed, wildsNeeded);
      if (found) return found;
    }
    return null;
  }

  return null;
}

// Attempts to satisfy every item of the seat's current contract from their hand in one
// shot, each item drawing from whatever the previous items left behind. Returns null if
// any item can't be completed — the bot just discards that turn instead.
function findContractLayDown(ctx, seat) {
  const contract = ctx.rules.contracts[ctx.playerVar(seat, 'phase') - 1];
  if (!contract) return null;
  let available = ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).map((id) => ({ id, card: ctx.cardById(id) }));
  const melds = [];
  for (const item of contract) {
    const parsed = parseItem(item);
    const foundIds = parsed && findMeldForItem(ctx, parsed, available);
    if (!foundIds) return null;
    melds.push({ item, cards: foundIds });
    available = available.filter((c) => !foundIds.includes(c.id));
  }
  return melds;
}

// Every legal one-card hit across every seat's melds, via validateMove itself so this
// can never drift from what applyMove would actually accept.
function findHits(ctx, seat) {
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const hits = [];
  for (let targetSeat = 0; targetSeat < ctx.seats; targetSeat++) {
    const groups = getMeldGroups(ctx, targetSeat);
    for (let meldIndex = 0; meldIndex < groups.length; meldIndex++) {
      for (const cardId of hand) {
        const move = { actor: seat, type: 'hit', cards: [cardId], choice: { seat: targetSeat, meld: meldIndex } };
        if (contractRummy.validateMove(ctx, move).legal) hits.push(move);
      }
    }
  }
  return hits;
}

function skipNextTurnFrom(ctx, seat) {
  let next = ctx.nextSeat(seat);
  while (ctx.playerVar(next, 'skipNextTurn')) {
    ctx.setPlayerVar(next, 'skipNextTurn', false);
    next = ctx.nextSeat(next);
  }
  return next;
}

const contractRummy = {
  id: 'contract-rummy',

  defaultZones() {
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'sorted', facing: 'up' },
      { id: 'draw', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down' },
      { id: 'discard', per: 'shared', visibility: 'top', layout: 'stack', order: 'stack', facing: 'up' },
      { id: 'melds', per: 'player', visibility: 'all', layout: 'grid', order: 'free', facing: 'up' },
    ];
  },

  defaultReactions() {
    return [{ when: 'zoneEmpty:draw', do: 'recycle', from: 'discard', keepTop: true, shuffle: true }];
  },

  setup(ctx) {
    initializeDeckInto(ctx.state, 'draw');
    const dealCount = typeof ctx.rules.deal === 'number' ? ctx.rules.deal : ctx.rules.deal?.default ?? 10;
    for (let s = 0; s < ctx.seats; s++) {
      for (let i = 0; i < dealCount; i++) {
        const top = ctx.zone('draw').cards.slice(-1)[0];
        if (top === undefined) break;
        ctx.moveCards([top], 'draw', ctx.zoneAddr('hand', s));
      }
      ctx.setPlayerVar(s, 'phase', 1);
      ctx.setPlayerVar(s, 'laidDown', false);
    }
    const starter = ctx.zone('draw').cards.slice(-1)[0];
    if (starter !== undefined) ctx.moveCards([starter], 'draw', 'discard');
    ctx.setPhase('draw');
  },

  validateMove(ctx, move) {
    if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");

    if (move.type === 'draw') {
      if (ctx.turn.phase !== 'draw') return ctx.fail('phase', 'Not the draw phase.');
      const from = move.from ?? 'draw';
      if (!ctx.rules.drawFrom.includes(from)) return ctx.fail('bad-source', `Cannot draw from "${from}".`);
      if (from === 'discard') {
        const topId = ctx.topOf('discard');
        if (topId !== undefined) {
          const card = ctx.cardById(topId);
          const forbidden = ctx.rules.discardPickupForbidden || [];
          if (forbidden.some((sel) => selectorMatches(card, sel))) {
            return ctx.fail('discard-pickup-forbidden', 'That card cannot be picked up from the discard pile.');
          }
        }
      }
      return ctx.ok();
    }

    if (move.type === 'layDown') {
      if (ctx.turn.phase !== 'meld') return ctx.fail('phase', 'Not the meld phase.');
      if (ctx.playerVar(move.actor, 'laidDown')) {
        return ctx.fail('already-laid-down', 'You have already laid down this round.');
      }
      const melds = move.choice?.melds;
      if (!melds || !melds.length) return ctx.fail('no-melds', 'No melds specified.');

      const contract = ctx.rules.contracts[ctx.playerVar(move.actor, 'phase') - 1];
      if (!contract) return ctx.fail('no-contract', 'No contract for the current phase.');
      if (!itemsMatchContract(melds.map((m) => m.item), contract)) {
        return ctx.fail('contract-mismatch', "Melds do not match the player's current contract.");
      }

      const allCardIds = melds.flatMap((m) => m.cards);
      if (new Set(allCardIds).size !== allCardIds.length) {
        return ctx.fail('duplicate-card', 'A card was used in more than one meld.');
      }
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!allCardIds.every((id) => hand.includes(id))) {
        return ctx.fail('not-in-hand', 'A meld card is not in your hand.');
      }

      for (const meld of melds) {
        const result = validateMeldComposition(ctx, meld.item, meld.cards.map((id) => ctx.cardById(id)));
        if (!result.ok) return ctx.fail(result.rule, result.reason);
      }
      return ctx.ok();
    }

    if (move.type === 'hit') {
      if (ctx.turn.phase !== 'meld') return ctx.fail('phase', 'Not the meld phase.');
      if (!ctx.playerVar(move.actor, 'laidDown')) {
        return ctx.fail('not-laid-down', 'You must lay down before hitting.');
      }
      const { seat: targetSeat, meld: meldIndex } = move.choice || {};
      if (targetSeat === undefined || meldIndex === undefined) {
        return ctx.fail('no-target', 'No hit target specified.');
      }
      const groups = getMeldGroups(ctx, targetSeat);
      const group = groups[meldIndex];
      if (!group) return ctx.fail('no-such-meld', 'No such meld.');

      const cardIds = move.cards;
      if (!cardIds || !cardIds.length) return ctx.fail('no-card', 'No card specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!cardIds.every((id) => hand.includes(id))) {
        return ctx.fail('not-in-hand', 'A hit card is not in your hand.');
      }

      const kind = meldKindOf(ctx, group);
      if (!kind) return ctx.fail('invalid-target-meld', 'Target meld has no valid composition.');
      const candidateCards = [...group.cards, ...cardIds].map((id) => ctx.cardById(id));
      const result = validateMeldComposition(ctx, `${kind}(${candidateCards.length})`, candidateCards);
      if (!result.ok) return ctx.fail(result.rule, result.reason);
      return ctx.ok();
    }

    if (move.type === 'discard') {
      if (ctx.turn.phase !== 'meld' && ctx.turn.phase !== 'discard') {
        return ctx.fail('phase', 'Not able to discard right now.');
      }
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!hand.includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');

      const effect = ctx.cardById(cardId).effect;
      if (effect?.type === 'skipTarget' && effect.on === 'discard') {
        const target = move.choice?.target;
        if (target === undefined || target === move.actor) {
          return ctx.fail('choice-required', 'Choose a player to skip.');
        }
      }
      return ctx.ok();
    }

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    const seat = move.actor;

    if (move.type === 'draw') {
      const from = move.from ?? 'draw';
      const topId = ctx.topOf(from);
      if (topId !== undefined) ctx.moveCards([topId], from, ctx.zoneAddr('hand', seat));
      ctx.setPhase('meld');
      return;
    }

    if (move.type === 'layDown') {
      const groups = [];
      for (const meld of move.choice.melds) {
        ctx.moveCards(meld.cards, ctx.zoneAddr('hand', seat), ctx.zoneAddr('melds', seat));
        groups.push({ item: meld.item, cards: meld.cards.slice() });
      }
      ctx.setPlayerVar(seat, 'melds', groups);
      ctx.setPlayerVar(seat, 'laidDown', true);
      // advance-on-complete: completing a phase's contract advances it for next round,
      // independent of who wins this round.
      ctx.setPlayerVar(seat, 'phase', ctx.playerVar(seat, 'phase') + 1);
      if (ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).length === 0) ctx.setGameOver(seat);
      return;
    }

    if (move.type === 'hit') {
      const { seat: targetSeat, meld: meldIndex } = move.choice;
      const groups = getMeldGroups(ctx, targetSeat);
      const group = groups[meldIndex];
      const kind = meldKindOf(ctx, group);
      ctx.moveCards(move.cards, ctx.zoneAddr('hand', seat), ctx.zoneAddr('melds', targetSeat));
      group.cards.push(...move.cards);
      group.item = `${kind}(${group.cards.length})`;
      ctx.setPlayerVar(targetSeat, 'melds', groups);
      if (ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).length === 0) ctx.setGameOver(seat);
      return;
    }

    if (move.type === 'discard') {
      const cardId = move.cards[0];
      const card = ctx.cardById(cardId);
      ctx.moveCards([cardId], ctx.zoneAddr('hand', seat), 'discard');

      if (ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).length === 0) {
        ctx.setGameOver(seat);
        return;
      }

      if (card.effect?.type === 'skipTarget' && card.effect.on === 'discard') {
        ctx.setPlayerVar(move.choice.target, 'skipNextTurn', true);
      }
      ctx.setTurnSeat(skipNextTurnFrom(ctx, seat));
      ctx.setPhase('draw');
    }
  },

  enumerateLegalMoves(ctx, seat) {
    const moves = [];
    if (ctx.turn.phase === 'draw') {
      for (const from of ctx.rules.drawFrom) {
        const move = { actor: seat, type: 'draw', from };
        if (contractRummy.validateMove(ctx, move).legal) moves.push(move);
      }
      return moves;
    }

    // Bots always prefer shrinking their hand toward zero: try a full-contract layDown
    // first, then any legal hit, and only fall back to a bare discard. bot.js's default
    // heuristic scores every non-draw move equally and keeps the first candidate on
    // ties, so list order here is what makes that preference stick.
    if (!ctx.playerVar(seat, 'laidDown')) {
      const melds = findContractLayDown(ctx, seat);
      if (melds) moves.push({ actor: seat, type: 'layDown', choice: { melds } });
    } else {
      moves.push(...findHits(ctx, seat));
    }

    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    for (const cardId of hand) {
      const card = ctx.cardById(cardId);
      if (card.effect?.type === 'skipTarget' && card.effect.on === 'discard') {
        for (let target = 0; target < ctx.seats; target++) {
          if (target === seat) continue;
          moves.push({ actor: seat, type: 'discard', cards: [cardId], choice: { target } });
        }
      } else {
        moves.push({ actor: seat, type: 'discard', cards: [cardId] });
      }
    }
    return moves;
  },

  isRoundOver(ctx) {
    return ctx.state.gameOver;
  },

  scoreRound(ctx) {
    return runRoundScore(ctx);
  },

  // Not exercised end-to-end by the rule tests: the whole-game winner is whoever goes
  // out (state.winner, set by applyMove on emptying their hand) having already completed
  // the final contract in ctx.rules.contracts (their 'phase' playerVar advanced past it).
  isGameOver(ctx) {
    if (!ctx.state.gameOver || ctx.state.winner == null) return false;
    const phase = ctx.playerVar(ctx.state.winner, 'phase');
    return phase != null && phase > ctx.rules.contracts.length;
  },

  botHeuristic(ctx, move) {
    if (move.type === 'draw') return move.from === 'discard' ? 0.5 : -1;
    if (move.type === 'layDown') return 100;
    if (move.type === 'hit') return 50;
    // Discard the card that contributes least toward the current contract: prefer
    // keeping anything that shares a rank or color with something else in hand (a
    // building block for a future set/colorGroup) over cards with no hand-mates at
    // all. Without this a bot's hand composition random-walks instead of converging
    // on a layDown, and rounds can run long enough to look like a live-lock.
    const cardId = move.cards[0];
    const card = ctx.cardById(cardId);
    if (isWildCard(ctx, card)) return -100;
    const handIds = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
    const rankMates = handIds.filter((id) => id !== cardId && ctx.cardById(id).rank === card.rank).length;
    const colorMates = handIds.filter((id) => id !== cardId && ctx.cardById(id).color === card.color).length;
    return -(rankMates * 2 + colorMates * 0.1);
  },
};

export default contractRummy;
