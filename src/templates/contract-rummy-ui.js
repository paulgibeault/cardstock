// Two affordances that exist for the HUMAN and never for the engine: fitting a
// tapped selection into a contract, and answering "what goes with this card?".
//
// Split out of contract-rummy.js so the rules file stays rules. Neither of these
// decides anything — arrangeContract puts its answer back through the template's
// own validateMove (handed in, so this module does not form a cycle with the one
// that validates it), and suggestMeld returns cards rather than a move. Nothing
// here can produce a play the player could not have assembled by tapping.
//
// They remain part of the template's hook surface (src/templates/CONTRACT.md);
// contract-rummy.js composes them onto the template object.

import { parseItem, isWildCard } from './melds.js';
import { findMeldForItem, permutations } from './contract-rummy-bot.js';

/**
 * Fit exactly `cardIds` (a player's tapped selection) into the seat's current
 * contract, or return null. Unlike the bot's findContractLayDown, which mines
 * the whole hand, this must use EVERY selected card — a lay-down that quietly
 * ignored two of the cards you picked would move cards you didn't ask to move.
 * The UI's "Lay down" button enables on exactly this returning non-null.
 */
export function arrangeContract(ctx, seat, cardIds, validate) {
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
      if (validate(ctx, move).legal) return melds;
    }
  }
  return null;
}

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
export function suggestMeld(ctx, seat, cardId, { exclude = [] } = {}) {
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
}
