// Card effects as ENGINE OPERATIONS, keyed by name (design doc §7: "effects are
// engine operations … usable anywhere").
//
// They were not. `applyEffect` — skip, reverse, drawN, wild, wildDrawN,
// swapHands, rotateHands — lived inside src/templates/shedding.js, so any other
// template that wanted one had to write it again; and contract-rummy did
// exactly that, hand-implementing `skipTarget` across its validator, its
// applyMove and a private `skipNextTurnFrom` helper. A pack that declared
// `"effect": "skip"` on a rummy card got nothing at all.
//
// The seam is deliberately the same one §7 promises `logic.js` custom effects:
// an effect is `(ctx, { card, effect, actor, choice }) -> { advanceBy? }`, and a
// pack-defined effect registered here would work in every template without any
// of them learning its name.
//
// TURN ADVANCEMENT IS A RETURN VALUE, NOT A SIDE EFFECT. `advanceBy` is how
// many seats to move on — 2 for a skip, 2 for a penalty draw that also costs the
// turn, and (the case that makes it worth returning rather than doing) 2 for a
// reverse at a two-hander, where turning the table round means the same player
// goes again. The CALLER moves the turn, because "what a turn is" is the
// template's business: shedding advances seats, contract-rummy walks past
// everyone carrying a skip flag.

import { emitEvent } from './state.js';

function drawInto(ctx, seat, n) {
  return ctx.deal(ctx.zoneAddr('hand', seat), n);
}

/**
 * The built-in effect vocabulary. Each returns what it wants done to the turn;
 * anything it changes about the table it does through `ctx`.
 *
 * The derived events are not decoration. An action card is the most
 * consequential thing anyone plays and, until these existed, the least visible:
 * the state changed — a seat lost their turn, the table turned round, somebody
 * was handed four cards — and the only trace was that the discard looked
 * different and the log said "Rook played."
 */
export const EFFECTS = {
  skip(ctx, { actor }) {
    ctx.emit('skipped', { by: actor, seat: ctx.nextSeat(actor) });
    return { advanceBy: 2 };
  },

  reverse(ctx, { actor }) {
    ctx.reverseDirection();
    // Emitted after the flip, so `direction` is the one now in force.
    ctx.emit('reversed', { by: actor, direction: ctx.state.direction });
    // At a two-hander "the other direction" is the same seat, so the reverse
    // is a skip — advancing one would hand the turn straight back.
    return { advanceBy: ctx.seats === 2 ? 2 : 1 };
  },

  drawN(ctx, { effect, actor }) {
    const target = ctx.nextSeat(actor);
    const drew = drawInto(ctx, target, effect.n);
    // The count actually dealt, not the one asked for: an exhausted pile that
    // could not be recycled hands over fewer, and the table should say what
    // really happened.
    ctx.emit('penalty', { by: actor, seat: target, drew, asked: effect.n });
    return { advanceBy: 2 };
  },

  /** A wild's whole effect is the choice it demands, which the move carries. */
  wild() {
    return { advanceBy: 1 };
  },

  wildDrawN(ctx, args) {
    return EFFECTS.drawN(ctx, args);
  },

  swapHands(ctx, { actor, choice }) {
    const other = choice?.player;
    if (other === undefined || other === actor) return { advanceBy: 1 };
    const a = ctx.zoneAddr('hand', actor);
    const b = ctx.zoneAddr('hand', other);
    const aCards = ctx.cardIdsIn(a).slice();
    const bCards = ctx.cardIdsIn(b).slice();
    ctx.moveCards(aCards, a, b);
    ctx.moveCards(bCards, b, a);
    ctx.emit('handsSwapped', { by: actor, seat: other });
    return { advanceBy: 1 };
  },

  rotateHands(ctx, { actor }) {
    const seats = ctx.seats;
    const snapshots = Array.from({ length: seats }, (unused, s) => ctx.cardIdsIn(ctx.zoneAddr('hand', s)).slice());
    for (let s = 0; s < seats; s++) {
      const dest = ctx.nextSeat(s);
      if (dest === s || snapshots[s].length === 0) continue;
      ctx.moveCards(snapshots[s], ctx.zoneAddr('hand', s), ctx.zoneAddr('hand', dest));
    }
    ctx.emit('handsRotated', { by: actor, direction: ctx.state.direction });
    return { advanceBy: 1 };
  },

  /**
   * Mark a NAMED seat to lose their next turn — Milestones' Skip, which is an
   * action you play AT somebody rather than at whoever happens to be next.
   *
   * The flag rather than an immediate advance is what makes it work when the
   * effect fires on a discard: the discarding player's turn is ending anyway,
   * and the seat being skipped may be several places away.
   */
  skipTarget(ctx, { actor, choice }) {
    const target = choice?.target;
    if (target === undefined || target === actor) return { advanceBy: 1 };
    ctx.setPlayerVar(target, 'skipNextTurn', true);
    ctx.emit('skipped', { by: actor, seat: target });
    return { advanceBy: 1 };
  },
};

export function effectType(card) {
  const effect = card?.effect;
  if (!effect) return null;
  return typeof effect === 'string' ? effect : effect.type;
}

/** Does this card carry an effect the engine knows how to run? */
export function hasKnownEffect(card, when = 'play') {
  const type = effectType(card);
  if (!type || !EFFECTS[type]) return false;
  const effect = card.effect;
  return (typeof effect === 'string' ? 'play' : effect.on || 'play') === when;
}

/**
 * Run `card`'s effect, if it has one this build knows.
 *
 * @param when  'play' or 'discard' — an effect declares which moment it fires
 *              at, and a card played normally must not fire a discard effect.
 * @returns { advanceBy } — always, so a caller can advance the turn without
 *          checking whether anything happened.
 */
export function applyEffect(ctx, { card, actor, choice, when = 'play' }) {
  const type = effectType(card);
  const effect = card?.effect;
  const fires = (typeof effect === 'string' ? 'play' : effect?.on || 'play') === when;
  const fn = type && fires ? EFFECTS[type] : null;
  if (!fn) return { advanceBy: 1 };
  return { advanceBy: 1, ...fn(ctx, { card, effect: typeof effect === 'string' ? { type } : effect, actor, choice }) };
}

// Re-exported so a template can emit an engine-shaped event without reaching
// into state.js itself.
export { emitEvent };
