// Contract-rummy template (design doc §13.3). Validates against Milestones.
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

/**
 * Cards a meld will not take at all — Milestones' skips, which are an action
 * you play at somebody, not a card with a place in a run.
 *
 * Declared per pack (`rules.meldForbidden`, the same selector vocabulary as
 * `discardPickupForbidden`) rather than inferred from "has an effect", because
 * those are different questions and a pack is entitled to a meldable action
 * card. It is also not a cosmetic gate: a skip's rank is the STRING "skip", and
 * a set is checked by comparing meld values for equality, so three of them were
 * a legal set(3) — with a wild pinnable to rank "skip" on top of it.
 */
function isMeldable(ctx, card) {
  const forbidden = ctx.rules.meldForbidden;
  if (!forbidden?.length) return true;
  return !forbidden.some((sel) => selectorMatches(card, sel));
}

/* ------------------------------------------------------------------ *
 * What a wild stands for
 * ------------------------------------------------------------------ *
 *
 * A WILD IS ONLY WILD IN THE HAND. The moment it is played it becomes one
 * specific card and stays that card for the rest of the round. That is the
 * rule at a table, and skipping it is not a cosmetic omission: a run laid as
 * "3, wild, wild, 6" whose wilds never took a value is a run that still has a
 * 4 and a 5 missing, so the next player can hit it with a 4 and the same slot
 * gets filled twice. The meld ends up holding five cards' worth of ranks in a
 * four-rank window, and no later check can untangle which wild was supposed
 * to be which.
 *
 * So every meld carries the values its wilds took. `group.wilds` is
 * { cardId: { rank } } — or { color } for a colour group — written once, when
 * the card leaves the hand, and never rewritten: a hit merges NEW assignments
 * in and the existing ones win every collision (see resolveHit). Validation
 * reads a wild through that map and treats it as an ordinary card of that
 * value, which is all it takes for the double-fill above to come back as "a
 * run cannot repeat a rank".
 *
 * Cards are pack-level and shared across matches, so the assignment lives in
 * match state (the seat's `melds` playerVar) rather than on the card. It is
 * derived by applyMove from the logged move, so a replay rebuilds it exactly.
 */

const RANK_DOMAINS = new WeakMap();

// The ranks a run may occupy: the numeric ranks the pack's deck actually
// holds. A frozen value has to be one a card could have had — without this
// the window search below is free to run a meld off either end of the deck
// (a "1, 2, wild" whose wild is a 0), and freezing a rank no card can ever
// match makes a slot that is neither filled nor fillable.
function rankDomain(ctx) {
  let domain = RANK_DOMAINS.get(ctx.pack);
  if (!domain) {
    const ranks = [];
    for (const card of ctx.pack.cardsById.values()) {
      const r = card.rank === '' || card.rank == null ? NaN : Number(card.rank);
      if (Number.isFinite(r)) ranks.push(r);
    }
    // An empty range for a deck with no numeric ranks: every window is then
    // wider than the domain, so runs are rejected rather than mis-frozen.
    domain = ranks.length ? { min: Math.min(...ranks), max: Math.max(...ranks) } : { min: 0, max: -1 };
    RANK_DOMAINS.set(ctx.pack, domain);
  }
  return domain;
}

// A run or a set pins a wild's RANK; a colour group pins its COLOUR. Nothing
// else about the card is decided — a run in this template never constrains
// colour, so a wild in one is a rank and no more.
function pinnedAttr(kind) {
  return kind === 'colorGroup' ? 'color' : 'rank';
}

function entriesOf(ctx, cardIds) {
  return cardIds.map((id) => ({ id, card: ctx.cardById(id) }));
}

// What a card counts as inside a meld of this kind: its own attribute, or —
// for a wild — whatever it was frozen to. `undefined` means a wild nobody has
// assigned, which is a state no laid-down meld is allowed to be in.
function meldValue(ctx, entry, kind, wilds) {
  const attr = pinnedAttr(kind);
  if (!isWildCard(ctx, entry.card)) return entry.card[attr];
  return wilds?.[entry.id]?.[attr];
}

/**
 * Freeze a value onto every wild in `entries` that does not have one yet, and
 * carry the ones that do through untouched.
 *
 * `pinned` is what is already decided: the values a meld's wilds took when
 * they were played, plus anything the move itself declared. Everything else
 * is derived, because a played wild has to mean something even when nobody
 * said what, and for each meld kind there is one sensible answer:
 *
 *   set / colour group   the rank or colour the naturals already share
 *   run                  the gaps in the window the fixed ranks sit in — and
 *                        where they do not fill the window (a 3, a 4 and two
 *                        wilds), the window that starts on the lowest of them
 *                        and runs UP, slid down only as far as the top of the
 *                        deck forces.
 *
 * A player who wants the other window says so and this leaves it alone; see
 * `wildChoice`, which is the question the table asks before the card lands.
 * Deriving is not guessing what the player meant so much as making sure SOME
 * value is on the card by the time it is on the felt.
 *
 * @returns { ok: true, wilds } | { ok: false, rule, reason }
 */
function assignWilds(ctx, kind, size, entries, pinned = {}) {
  const attr = pinnedAttr(kind);
  const wilds = {};
  const unassigned = [];
  for (const entry of entries) {
    if (!isWildCard(ctx, entry.card)) continue;
    const value = pinned[entry.id]?.[attr];
    if (value === undefined) unassigned.push(entry);
    else wilds[entry.id] = { [attr]: value };
  }
  if (!unassigned.length) return { ok: true, wilds };

  const naturals = entries.filter((e) => !isWildCard(ctx, e.card));
  const noValue = {
    ok: false,
    rule: 'wild-value-required',
    reason: 'A wild has to be played as a specific card, and nothing here says which.',
  };

  if (kind === 'set' || kind === 'colorGroup') {
    const value = naturals.length ? naturals[0].card[attr] : Object.values(wilds)[0]?.[attr];
    if (value === undefined) return noValue;
    for (const entry of unassigned) wilds[entry.id] = { [attr]: value };
    return { ok: true, wilds };
  }

  if (kind === 'run') {
    const fixed = [
      ...naturals.map((e) => Number(e.card.rank)),
      ...Object.values(wilds).map((w) => Number(w.rank)),
    ];
    if (fixed.some((r) => !Number.isFinite(r))) {
      return { ok: false, rule: 'invalid-meld', reason: 'Run cards must have numeric ranks.' };
    }
    if (!fixed.length) return noValue;

    const low = Math.min(...fixed);
    const high = Math.max(...fixed);
    if (high - low + 1 > size) {
      return { ok: false, rule: 'invalid-meld', reason: 'Run cards do not fit within the meld size.' };
    }
    const domain = rankDomain(ctx);
    let start = Math.min(low, domain.max - size + 1);
    start = Math.max(start, domain.min);
    if (start > low || start + size - 1 < high) {
      return { ok: false, rule: 'invalid-meld', reason: 'That run does not fit within the deck.' };
    }

    const taken = new Set(fixed);
    const free = [];
    for (let r = start; r < start + size; r++) if (!taken.has(r)) free.push(r);
    // Fewer holes than wilds means two cards are competing for one rank; the
    // value check reports it as the repeat it is.
    if (free.length < unassigned.length) {
      return { ok: false, rule: 'invalid-meld', reason: 'A run cannot repeat a rank.' };
    }
    unassigned.forEach((entry, i) => { wilds[entry.id] = { rank: String(free[i]) }; });
    return { ok: true, wilds };
  }

  return { ok: false, rule: 'invalid-meld', reason: `Unknown meld kind "${kind}".` };
}

// The quota rules — how many cards, how many of them may be wild. Checked
// BEFORE any value is frozen, because "three wilds and nothing else" is a
// meld that fails on min-naturals, not on the wilds having no rank to take.
function checkMeldQuota(ctx, parsed, entries) {
  if (entries.length !== parsed.n) {
    return { ok: false, rule: 'invalid-meld', reason: 'Card count does not match the meld size.' };
  }
  const wildsCfg = ctx.rules.wilds || {};
  const naturals = entries.filter((e) => !isWildCard(ctx, e.card));
  const wildCount = entries.length - naturals.length;
  if (naturals.length < (wildsCfg.minNaturals ?? 0)) {
    return { ok: false, rule: 'min-naturals', reason: 'A meld needs at least one natural (non-wild) card.' };
  }
  if (wildsCfg.maxPerMeld != null && wildCount > wildsCfg.maxPerMeld) {
    return { ok: false, rule: 'too-many-wilds', reason: 'Too many wild cards in one meld.' };
  }
  return { ok: true };
}

// The composition rules, read through the frozen assignments: from here down
// a wild IS the card it was played as, and the checks are the ones any pile
// of naturals would face.
function checkMeldValues(ctx, parsed, entries, wilds) {
  const values = entries.map((e) => meldValue(ctx, e, parsed.kind, wilds));
  if (values.some((v) => v === undefined || v === null)) {
    return { ok: false, rule: 'wild-value-required', reason: 'A wild in this meld has no value.' };
  }

  if (parsed.kind === 'set') {
    if (values.some((v) => v !== values[0])) {
      return { ok: false, rule: 'invalid-meld', reason: 'All cards in a set must share a rank.' };
    }
    return { ok: true };
  }

  if (parsed.kind === 'run') {
    const ranks = values.map((v) => Number(v));
    if (ranks.some((r) => !Number.isFinite(r))) {
      return { ok: false, rule: 'invalid-meld', reason: 'Run cards must have numeric ranks.' };
    }
    if (new Set(ranks).size !== ranks.length) {
      return { ok: false, rule: 'invalid-meld', reason: 'A run cannot repeat a rank.' };
    }
    const low = Math.min(...ranks);
    const high = Math.max(...ranks);
    // Every card's rank is known, so a run is either unbroken or it is not —
    // there is no longer a hole for a later card to claim.
    if (high - low + 1 !== parsed.n) {
      return { ok: false, rule: 'invalid-meld', reason: 'Run cards do not fit within the meld size.' };
    }
    const domain = rankDomain(ctx);
    if (low < domain.min || high > domain.max) {
      return { ok: false, rule: 'invalid-meld', reason: 'A run cannot carry on past the ends of the deck.' };
    }
    return { ok: true };
  }

  if (parsed.kind === 'colorGroup') {
    if (values.some((v) => v !== values[0])) {
      return { ok: false, rule: 'invalid-meld', reason: 'All cards in a color group must share a color.' };
    }
    return { ok: true };
  }

  return { ok: false, rule: 'invalid-meld', reason: `Unknown meld kind "${parsed.kind}".` };
}

/**
 * Legality AND the wild values in one answer, so validateMove and applyMove
 * cannot reach different conclusions about what a wild became. Both call
 * this; validate throws the values away, apply stores them.
 *
 * @param pinned values that are already settled — the meld's own frozen wilds
 *               and any the move declares.
 * @returns { ok: true, wilds } | { ok: false, rule, reason }
 */
function resolveMeld(ctx, item, cardIds, pinned = {}) {
  const parsed = parseItem(item);
  if (!parsed) return { ok: false, rule: 'invalid-meld', reason: `Unknown meld item "${item}".` };
  if (!Array.isArray(cardIds)) {
    return { ok: false, rule: 'invalid-meld', reason: 'A meld needs a list of cards.' };
  }
  const entries = entriesOf(ctx, cardIds);
  if (entries.some((e) => !e.card)) {
    return { ok: false, rule: 'invalid-meld', reason: 'A meld names a card that is not in this deck.' };
  }

  // Before quota or values: a barred card is not a meld that came out wrong,
  // it is a card with no business in one. Checked here, in the single function
  // both lay-downs and hits resolve through, so the bot's search (which reaches
  // it via findMeldForItem) obeys the same rule as the table.
  const barred = entries.find((e) => !isMeldable(ctx, e.card));
  if (barred) {
    return {
      ok: false,
      rule: 'not-meldable',
      reason: `A ${barred.card.rank} card cannot be part of a meld.`,
    };
  }

  const quota = checkMeldQuota(ctx, parsed, entries);
  if (!quota.ok) return quota;

  const assigned = assignWilds(ctx, parsed.kind, parsed.n, entries, pinned);
  if (!assigned.ok) return assigned;

  const values = checkMeldValues(ctx, parsed, entries, assigned.wilds);
  if (!values.ok) return values;
  return { ok: true, wilds: assigned.wilds };
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

// What a meld's wilds are ALREADY standing for. A group laid down through
// applyMove carries them. One that did not — a rule test poking the melds
// zone, a group the fallback above invented — is pinned here, on first read,
// from the meld as it stands: frozen a little late, but frozen before anyone
// gets to hit it, which is the property that matters.
function pinnedWildsOf(ctx, group, kind) {
  if (group.wilds) return group.wilds;
  const entries = entriesOf(ctx, group.cards);
  const assigned = assignWilds(ctx, kind, entries.length, entries);
  return assigned.ok ? assigned.wilds : {};
}

/**
 * A hit resolved the same way a lay-down is, with one addition: the target
 * meld's own wilds are pinned LAST, so they win every collision. A move that
 * arrives naming a new value for a wild already on the table is not applying
 * a choice, it is rewriting history, and the whole point of freezing is that
 * it cannot.
 */
function resolveHit(ctx, group, kind, cardIds, declared) {
  const cards = [...group.cards, ...cardIds];
  const pinned = { ...(declared || {}), ...pinnedWildsOf(ctx, group, kind) };
  const resolved = resolveMeld(ctx, `${kind}(${cards.length})`, cards, pinned);
  return { ...resolved, item: `${kind}(${cards.length})`, cards };
}

// Every value a wild could take on its way onto this meld, asked of
// resolveHit itself so the list can never offer something a hit would then
// refuse. A set or a colour group has exactly one answer; a run has its two
// open ends, which is the only place the player has a real say.
function wildHitValues(ctx, group, kind, cardId) {
  const attr = pinnedAttr(kind);
  let candidates;
  if (attr === 'color') {
    candidates = [...new Set([...ctx.pack.cardsById.values()].map((c) => c.color).filter(Boolean))];
  } else {
    const domain = rankDomain(ctx);
    candidates = [];
    for (let r = domain.min; r <= domain.max; r++) candidates.push(String(r));
  }
  return candidates.filter((value) => resolveHit(ctx, group, kind, [cardId], { [cardId]: { [attr]: value } }).ok);
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
//
// Returns { cards: [id, ...], wilds } or null: a candidate is only an answer once
// resolveMeld has frozen a value onto every wild in it, which also means a window
// that runs off the end of the deck is rejected here rather than laid down.
function findMeldForItem(ctx, parsed, available) {
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
function findContractLayDown(ctx, seat) {
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
function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

// Every legal one-card hit across every seat's melds, via validateMove itself so this
// can never drift from what applyMove would actually accept.
//
// A wild appears once per value it could take, the same way shedding enumerates a
// wild once per colour: the value is part of the move, so two values are two moves.
// That is what lets a bot pick one and the table ask a human which they meant.
function findHits(ctx, seat) {
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
          if (contractRummy.validateMove(ctx, move).legal) hits.push(move);
        }
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

// The per-round part of dealing, shared by setup (round 1) and startRound
// (rounds 2+): shuffle the whole deck into `draw`, deal, reset the round-scoped
// player vars, flip the starter. Zones are already empty on both paths — fresh
// from createState, or cleared by the pipeline's round boundary.
function dealRound(ctx) {
  initializeDeckInto(ctx.state, 'draw');
  const dealCount = typeof ctx.rules.deal === 'number' ? ctx.rules.deal : ctx.rules.deal?.default ?? 10;
  for (let s = 0; s < ctx.seats; s++) {
    for (let i = 0; i < dealCount; i++) {
      const top = ctx.zone('draw').cards.slice(-1)[0];
      if (top === undefined) break;
      ctx.moveCards([top], 'draw', ctx.zoneAddr('hand', s));
    }
    ctx.setPlayerVar(s, 'laidDown', false);
    ctx.setPlayerVar(s, 'melds', undefined);
    ctx.setPlayerVar(s, 'skipNextTurn', false);
  }
  const starter = ctx.zone('draw').cards.slice(-1)[0];
  if (starter !== undefined) ctx.moveCards([starter], 'draw', 'discard');
}

const contractRummy = {
  id: 'contract-rummy',

  defaultZones() {
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'sorted', facing: 'up' },
      { id: 'draw', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Draw' },
      { id: 'discard', per: 'shared', visibility: 'top', layout: 'stack', order: 'stack', facing: 'up', label: 'Discard' },
      { id: 'melds', per: 'player', visibility: 'all', layout: 'grid', order: 'free', facing: 'up', label: 'Melds' },
    ];
  },

  defaultReactions() {
    return [{ when: 'zoneEmpty:draw', do: 'recycle', from: 'discard', keepTop: true, shuffle: true }];
  },

  setup(ctx) {
    dealRound(ctx);
    for (let s = 0; s < ctx.seats; s++) ctx.setPlayerVar(s, 'phase', 1);
    ctx.setTurnSeat(0);
    ctx.setPhase('draw');
  },

  // Between rounds the deal resets but the CONTRACTS do not: 'phase' is the
  // whole point of the game and survives; laidDown/melds/skipNextTurn are
  // round-scoped. The opening lead rotates so seat 0 doesn't start every round.
  startRound(ctx) {
    dealRound(ctx);
    ctx.setTurnSeat((ctx.state.roundNumber - 1) % ctx.seats);
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
        // meld.wilds is what the player says their wilds are; anything they
        // leave unsaid gets a value here, and either way the meld is judged
        // with every wild already standing for something.
        const result = resolveMeld(ctx, meld.item, meld.cards, meld.wilds || {});
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
      const result = resolveHit(ctx, group, kind, cardIds, move.choice?.wilds);
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
        // Resolved once more rather than trusted from the move: the values
        // stored here are the ones validation just approved, and a move that
        // named none still lands with its wilds decided.
        const resolved = resolveMeld(ctx, meld.item, meld.cards, meld.wilds || {});
        ctx.moveCards(meld.cards, ctx.zoneAddr('hand', seat), ctx.zoneAddr('melds', seat));
        groups.push({ item: meld.item, cards: meld.cards.slice(), wilds: resolved.wilds || {} });
      }
      ctx.setPlayerVar(seat, 'melds', groups);
      ctx.setPlayerVar(seat, 'laidDown', true);
      // advance-on-complete: completing a phase's contract advances it for next round,
      // independent of who wins this round.
      const completed = ctx.playerVar(seat, 'phase');
      ctx.setPlayerVar(seat, 'phase', completed + 1);
      ctx.emit('laidDown', { seat, contract: completed, melds: groups.length });
      if (ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).length === 0) ctx.setGameOver(seat);
      return;
    }

    if (move.type === 'hit') {
      const { seat: targetSeat, meld: meldIndex } = move.choice;
      const groups = getMeldGroups(ctx, targetSeat);
      const group = groups[meldIndex];
      const kind = meldKindOf(ctx, group);
      const resolved = resolveHit(ctx, group, kind, move.cards, move.choice?.wilds);
      ctx.moveCards(move.cards, ctx.zoneAddr('hand', seat), ctx.zoneAddr('melds', targetSeat));
      group.cards.push(...move.cards);
      group.item = `${kind}(${group.cards.length})`;
      // Includes the meld's existing assignments untouched — resolveHit pins
      // them over anything the move had to say about them.
      group.wilds = resolved.wilds || group.wilds || {};
      ctx.setPlayerVar(targetSeat, 'melds', groups);
      ctx.emit('hit', { seat, targetSeat, meld: meldIndex });
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

  /**
   * Fit exactly `cardIds` (a player's tapped selection) into the seat's current
   * contract, or return null. Unlike the bot's findContractLayDown, which mines
   * the whole hand, this must use EVERY selected card — a lay-down that quietly
   * ignored two of the cards you picked would move cards you didn't ask to move.
   * The UI's "Lay down" button enables on exactly this returning non-null.
   */
  arrangeContract(ctx, seat, cardIds) {
    const contract = ctx.rules.contracts[ctx.playerVar(seat, 'phase') - 1];
    if (!contract || !cardIds.length) return null;
    const pool = cardIds.map((id) => ({ id, card: ctx.cardById(id) }));
    for (const order of permutations(contract)) {
      let available = pool.slice();
      const melds = [];
      let ok = true;
      for (const item of order) {
        const parsed = parseItem(item);
        const found = parsed && findMeldForItem(ctx, parsed, available);
        if (!found) { ok = false; break; }
        // The wild values travel with the melds so the move the button makes
        // says what each wild is, rather than leaving applyMove to guess again.
        melds.push({ item, cards: found.cards, wilds: found.wilds });
        available = available.filter((c) => !found.cards.includes(c.id));
      }
      if (ok && available.length === 0) {
        // Re-order to match the declared contract so the move reads naturally.
        const move = { actor: seat, type: 'layDown', choice: { melds } };
        if (contractRummy.validateMove(ctx, move).legal) return melds;
      }
    }
    return null;
  },

  /**
   * The cards in `seat`'s hand that would go WITH `cardId` toward one item of
   * their current contract — the group a player would gather by hand.
   *
   * Exists because gathering a meld is the hardest thing to do on a phone: a
   * ten-card fan gives each card a strip about a third as wide as a finger is
   * accurate, and a set of three means finding two more slivers that match one
   * you can barely see. Holding a card asks this question instead, and the
   * answer is a group the player can accept or put back.
   *
   * A SUGGESTION, NOT A DECISION. It returns cards, never a move; the caller
   * feeds them to the ordinary selection, and arrangeContract above remains
   * the only thing that decides a lay-down is legal. Nothing here can produce
   * a play the player could not have assembled by tapping.
   *
   * The search is findMeldForItem, unchanged, with its input narrowed to cards
   * that could share a meld with the pressed one — same rank for a set, same
   * colour for a colour group, a reachable rank window for a run — and the
   * pressed card first, because both branches take the first candidate they
   * see and that is what guarantees it ends up in the answer.
   *
   * A wild returns null on purpose: a wild belongs to whichever meld you
   * decide to spend it on, so "the cards that go with this one" has no answer
   * the player has not already given.
   *
   * @param exclude cards already spoken for by a meld gathered earlier. A
   *                contract is several items and they are gathered one at a
   *                time, so the second group must be built from what the first
   *                LEFT — otherwise a hold that reaches for the same wild
   *                twice hands back a selection no lay-down can use.
   * @returns { item, cards: [cardId, ...] } | null
   */
  suggestMeld(ctx, seat, cardId, { exclude = [] } = {}) {
    const contract = ctx.rules.contracts?.[ctx.playerVar(seat, 'phase') - 1];
    const pressed = ctx.cardById(cardId);
    if (!contract || !pressed || isWildCard(ctx, pressed)) return null;

    const spent = new Set(exclude);
    spent.delete(cardId);
    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat))
      .filter((id) => !spent.has(id))
      .map((id) => ({ id, card: ctx.cardById(id) }))
      .filter((c) => c.card);
    if (!hand.some((c) => c.id === cardId)) return null;

    const wilds = hand.filter((c) => isWildCard(ctx, c.card));
    const naturals = hand.filter((c) => !isWildCard(ctx, c.card) && c.id !== cardId);
    const self = hand.find((c) => c.id === cardId);
    const pressedRank = Number(pressed.rank);

    for (const item of contract) {
      const parsed = parseItem(item);
      if (!parsed) continue;
      let kin;
      if (parsed.kind === 'set') {
        kin = naturals.filter((c) => c.card.rank === pressed.rank);
      } else if (parsed.kind === 'colorGroup') {
        kin = naturals.filter((c) => c.card.color === pressed.color);
      } else if (parsed.kind === 'run') {
        if (Number.isNaN(pressedRank)) continue;
        // Only ranks that could share a window of this length with the pressed
        // one; anything further out cannot be in the same run whatever else is.
        kin = naturals.filter((c) => {
          const r = Number(c.card.rank);
          return !Number.isNaN(r) && Math.abs(r - pressedRank) < parsed.n;
        });
      } else {
        continue;
      }
      const found = findMeldForItem(ctx, parsed, [self, ...kin, ...wilds]);
      // The narrowing makes this near-certain, but a run window can still slide
      // off the pressed rank — so it is checked rather than assumed.
      if (found && found.cards.includes(cardId)) return { item, cards: found.cards };
    }
    return null;
  },

  /**
   * The question a hit still owes before it can be applied: which card a wild
   * is being played as.
   *
   * Only asked where the answer is genuinely the player's — a run has two
   * open ends and the choice between them is a real one (the low end blocks a
   * different card than the high end does). A set or a colour group has
   * exactly one value on offer, and a prompt there would be theatre; the same
   * goes for a natural card, which is already the card it is.
   *
   * Returns null when there is nothing to ask, which is the caller's cue to
   * send the move as it stands and let resolveMeld freeze the one value that
   * fits.
   *
   * @returns { cardId, attr: 'rank' | 'color', values: [string, ...] } | null
   */
  wildChoice(ctx, move) {
    if (move?.type !== 'hit' || move.choice?.wilds) return null;
    const cardId = move.cards?.[0];
    const card = cardId && ctx.cardById(cardId);
    if (!card || !isWildCard(ctx, card)) return null;
    const { seat: targetSeat, meld: meldIndex } = move.choice || {};
    if (targetSeat === undefined || meldIndex === undefined) return null;
    const group = getMeldGroups(ctx, targetSeat)[meldIndex];
    if (!group) return null;
    const kind = meldKindOf(ctx, group);
    if (!kind) return null;
    const values = wildHitValues(ctx, group, kind, cardId);
    return values.length > 1 ? { cardId, attr: pinnedAttr(kind), values } : null;
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
