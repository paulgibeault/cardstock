// The Milestones bot's meld search: can this hand satisfy a whole contract, and
// what may it add to somebody else's melds?
//
// Split out of contract-rummy.js because it is STRATEGY, not rules — nothing
// here decides what is legal (every candidate is put back through the
// template's own validateMove before it counts), and it is by a wide margin the
// most expensive code in the repo per call. Keeping it beside the rules made
// the rules file 961 lines and made it easy to mistake a search heuristic for
// a constraint.

import {
  isWildCard, isMeldable, parseItem, resolveMeld, meldKindOf,
  getMeldGroups, pinnedAttr, wildHitValues,
} from './melds.js';

export function groupBy(items, keyFn) {
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
//
// Returns { cards: [id, ...], wilds } or null: a candidate is only an answer once
// resolveMeld has frozen a value onto every wild in it, which also means a window
// that runs off the end of the deck is rejected here rather than laid down.
export function findMeldForItem(ctx, parsed, available) {
  const meldable = available.filter((c) => isMeldable(ctx, c.card));
  const wilds = meldable.filter((c) => isWildCard(ctx, c.card));
  const naturals = meldable.filter((c) => !isWildCard(ctx, c.card));
  const minNaturals = ctx.rules.wilds?.minNaturals ?? 0;
  const maxWilds = ctx.rules.wilds?.maxPerMeld;
  const item = `${parsed.kind}(${parsed.n})`;

  function tryComplete(naturalCards, wildsNeeded) {
    if (naturalCards.length < minNaturals) return null;
    if (maxWilds != null && wildsNeeded > maxWilds) return null;
    if (wildsNeeded > wilds.length) return null;
    const cards = [...naturalCards.map((c) => c.id), ...wilds.slice(0, wildsNeeded).map((c) => c.id)];
    const resolved = resolveMeld(ctx, item, cards, {});
    return resolved.ok ? { cards, wilds: resolved.wilds } : null;
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
export function findContractLayDown(ctx, seat) {
  const contract = ctx.rules.contracts[ctx.playerVar(seat, 'phase') - 1];
  if (!contract) return null;
  let available = ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).map((id) => ({ id, card: ctx.cardById(id) }));
  const melds = [];
  for (const item of contract) {
    const parsed = parseItem(item);
    const found = parsed && findMeldForItem(ctx, parsed, available);
    if (!found) return null;
    melds.push({ item, cards: found.cards, wilds: found.wilds });
    available = available.filter((c) => !found.cards.includes(c.id));
  }
  return melds;
}

// All orderings of a contract's items. Contracts are at most a few items, so this
// is bounded and cheap; trying every order is what makes arrangeContract succeed on
// selections a single greedy pass would mis-partition (a card that fits either item).
export function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

// Every legal one-card hit across every seat's melds, via the template's own
// validateMove — handed in rather than imported, so the strategy module does not
// form a cycle with the rules module it is checked by. Passing the validator is
// also the statement that the bot cannot invent a move: everything it proposes
// has already been through the same door a human's move goes through.
//
// A wild appears once per value it could take, the same way shedding enumerates a
// wild once per colour: the value is part of the move, so two values are two moves.
// That is what lets a bot pick one and the table ask a human which they meant.
export function findHits(ctx, seat, validate) {
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const hits = [];
  for (let targetSeat = 0; targetSeat < ctx.seats; targetSeat++) {
    const groups = getMeldGroups(ctx, targetSeat);
    for (let meldIndex = 0; meldIndex < groups.length; meldIndex++) {
      const group = groups[meldIndex];
      const kind = meldKindOf(ctx, group);
      for (const cardId of hand) {
        const card = ctx.cardById(cardId);
        const attr = kind && pinnedAttr(kind);
        const values = kind && card && isWildCard(ctx, card) ? wildHitValues(ctx, group, kind, cardId) : [null];
        for (const value of values) {
          const choice = { seat: targetSeat, meld: meldIndex };
          if (value !== null) choice.wilds = { [cardId]: { [attr]: value } };
          const move = { actor: seat, type: 'hit', cards: [cardId], choice };
          if (validate(ctx, move).legal) hits.push(move);
        }
      }
    }
  }
  return hits;
}
