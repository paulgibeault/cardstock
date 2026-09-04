// Wild-freezing meld logic: what a set, a run and a colour group ARE, and what
// a wild becomes when it joins one.
//
// Split out of contract-rummy.js (961 lines) because none of it is about
// contracts. A plain Rummy or Gin pack — the design doc's planned
// `contracts: none` (§13.3) — needs every function here and none of the
// contract ladder around it; so does any future template that melds.
//
// Pure over (ctx, cards): nothing here mutates state. resolveMeld answers
// legality AND the wild assignments in one call, which is what stops
// validateMove and applyMove from reaching different conclusions about what a
// wild became.

import { selectorMatches } from '../engine/selectors.js';
import { distinctValues, isWild } from '../engine/cards.js';

export function isWildCard(ctx, card) {
  return isWild(card, ctx.rules.wilds);
}

export function parseItem(item) {
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
export function isMeldable(ctx, card) {
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
export function rankDomain(ctx) {
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
export function pinnedAttr(kind) {
  return kind === 'colorGroup' ? 'color' : 'rank';
}

export function entriesOf(ctx, cardIds) {
  return cardIds.map((id) => ({ id, card: ctx.cardById(id) }));
}

// What a card counts as inside a meld of this kind: its own attribute, or —
// for a wild — whatever it was frozen to. `undefined` means a wild nobody has
// assigned, which is a state no laid-down meld is allowed to be in.
export function meldValue(ctx, entry, kind, wilds) {
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
 * `pendingChoice`, which is the question the table asks before the card lands.
 * Deriving is not guessing what the player meant so much as making sure SOME
 * value is on the card by the time it is on the felt.
 *
 * @returns { ok: true, wilds } | { ok: false, rule, reason }
 */
export function assignWilds(ctx, kind, size, entries, pinned = {}) {
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
export function checkMeldQuota(ctx, parsed, entries) {
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
export function checkMeldValues(ctx, parsed, entries, wilds) {
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
export function resolveMeld(ctx, item, cardIds, pinned = {}) {
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
export function itemsMatchContract(items, contract) {
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
export function inferKind(naturals) {
  if (naturals.length === 0) return null;
  if (naturals.every((c) => c.rank === naturals[0].rank)) return 'set';
  if (naturals.every((c) => c.color === naturals[0].color)) return 'colorGroup';
  return 'run';
}

// Per-seat meld groupings live in playerVar 'melds' ([{item, cards: [id,...]}]) so hits
// can target one meld among several without needing to slice a flat zone by position.
// A seat that never went through applyLayDown (e.g. a rule test that pokes the melds.N
// zone directly) is treated as one meld covering everything currently in that zone.
export function getMeldGroups(ctx, seat) {
  const stored = ctx.playerVar(seat, 'melds');
  if (stored) return stored;
  const cards = ctx.cardIdsIn(ctx.zoneAddr('melds', seat)).slice();
  return cards.length ? [{ item: null, cards }] : [];
}

export function meldKindOf(ctx, group) {
  const parsed = parseItem(group.item);
  if (parsed) return parsed.kind;
  return inferKind(group.cards.map((id) => ctx.cardById(id)).filter((c) => !isWildCard(ctx, c)));
}

// What a meld's wilds are ALREADY standing for. A group laid down through
// applyMove carries them. One that did not — a rule test poking the melds
// zone, a group the fallback above invented — is pinned here, on first read,
// from the meld as it stands: frozen a little late, but frozen before anyone
// gets to hit it, which is the property that matters.
export function pinnedWildsOf(ctx, group, kind) {
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
export function resolveHit(ctx, group, kind, cardIds, declared) {
  const cards = [...group.cards, ...cardIds];
  const pinned = { ...(declared || {}), ...pinnedWildsOf(ctx, group, kind) };
  const resolved = resolveMeld(ctx, `${kind}(${cards.length})`, cards, pinned);
  return { ...resolved, item: `${kind}(${cards.length})`, cards };
}

/**
 * The order a laid-down meld should be READ in — `3 W 5 6` for a run laid as
 * `6 3 W 5`, with the wild sitting in the slot of the rank it was frozen to.
 *
 * ORDERED WHERE IT IS READ, NOT WHERE IT IS STORED. `group.cards` is match
 * state: a replay rebuilds it move by move, the multiplayer wire ships it, and
 * `move.choice.meld` indexes into the groups array. Sorting the stored array to
 * win a purely visual property would change shapes the rules and the protocol
 * depend on, and it still would not fix a single match already saved — the old
 * order is in the log. A pure function over the group has neither problem: it
 * fixes every meld ever laid, including the ones on disk, and the engine never
 * sees it.
 *
 * TOTAL, AND IT MAY NOT LOSE A CARD. This is what the felt draws, so every
 * degenerate group — a wild nobody has valued yet, a kind this file does not
 * know, a card id that is not in the pack, no cards at all — comes back in the
 * order it went in rather than as a short list or a throw. A chip that silently
 * renders three cards of a four-card meld is a worse bug than an unsorted one,
 * and the caller cannot tell the difference by looking.
 *
 * @param kind optional; derived from the group when omitted.
 * @returns a permutation of `group.cards` — always the same ids, always the
 *          same length.
 */
export function meldDisplayOrder(ctx, group, kind) {
  const cards = group?.cards;
  if (!Array.isArray(cards) || cards.length < 2) return Array.isArray(cards) ? cards.slice() : [];
  try {
    const meldKind = kind === undefined ? meldKindOf(ctx, group) : kind;
    if (meldKind !== 'run' && meldKind !== 'set' && meldKind !== 'colorGroup') return cards.slice();

    const entries = entriesOf(ctx, cards);
    // A card the pack does not have cannot be valued, and guessing where it
    // goes is how a sort turns into a scramble. Draw it as it was stored.
    if (entries.some((e) => !e.card)) return cards.slice();

    const wilds = pinnedWildsOf(ctx, group, meldKind);
    // Decorated with the original index so the sort is stable regardless of the
    // engine's sort implementation: equal keys keep the order they were laid in.
    const decorated = entries.map((entry, i) => ({
      id: entry.id,
      i,
      wild: isWildCard(ctx, entry.card),
      value: meldValue(ctx, entry, meldKind, wilds),
    }));

    if (meldKind === 'run') {
      const ranks = decorated.map((d) => Number(d.value));
      // An unvalued wild has no slot to sit in — mid-hit, or a group assembled
      // by a test that never went through applyMove. Rather than pile the
      // nowhere-cards at one end and imply an order that is not there, leave the
      // whole meld alone until every card knows what it is.
      if (ranks.some((r) => !Number.isFinite(r))) return cards.slice();
      decorated.forEach((d, i) => { d.key = ranks[i]; });
      decorated.sort((a, b) => a.key - b.key || a.i - b.i);
      return decorated.map((d) => d.id);
    }

    // A set shares a rank and a colour group shares a colour, so there is no
    // "correct" order among them at all — sorting on the shared value would be
    // sorting on a constant. Naturals first, wilds last is the one arrangement
    // that says something true: it puts the cards that ARE what they show
    // before the ones standing in for them, so a reader counts the real 7s
    // without picking wilds out of the middle.
    decorated.sort((a, b) => (a.wild === b.wild ? a.i - b.i : (a.wild ? 1 : -1)));
    return decorated.map((d) => d.id);
  } catch {
    // Belt and braces over the checks above: no arrangement of match state is
    // worth a blank table.
    return cards.slice();
  }
}

// Every value a wild could take on its way onto this meld, asked of
// resolveHit itself so the list can never offer something a hit would then
// refuse. A set or a colour group has exactly one answer; a run has its two
// open ends, which is the only place the player has a real say.
export function wildHitValues(ctx, group, kind, cardId) {
  const attr = pinnedAttr(kind);
  let candidates;
  if (attr === 'color') {
    candidates = distinctValues(ctx.pack.cardsById, 'color');
  } else {
    const domain = rankDomain(ctx);
    candidates = [];
    for (let r = domain.min; r <= domain.max; r++) candidates.push(String(r));
  }
  return candidates.filter((value) => resolveHit(ctx, group, kind, [cardId], { [cardId]: { [attr]: value } }).ok);
}
