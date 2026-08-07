// Contract-rummy template (design doc §13.3). Validates against Milestones.
// Each round every player pursues a personal contract (ctx.playerVar 'phase', 1-indexed
// into ctx.rules.contracts). Turn: draw -> meld (lay down once, then hit freely) -> discard.
//
// THIS FILE IS THE RULES. Three things that were sharing it are not rules and
// have moved out:
//   ./melds.js               what a set/run/colour group IS, and what a wild
//                            becomes when it joins one — needed by any melding
//                            game, contracts or no contracts (§13.3's planned
//                            `contracts: none`)
//   ./contract-rummy-bot.js  the search that finds a lay-down or a hit; strategy,
//                            checked by this file's own validateMove
//   ./contract-rummy-ui.js   two human affordances (arrange a tapped selection,
//                            suggest a meld), which decide nothing

import { initializeDeckInto } from '../engine/state.js';
import { selectorMatches } from '../engine/selectors.js';
import { resolveByPlayers, recycleDiscardIntoDraw } from '../engine/deal.js';
import { applyEffect as runEffect, hasKnownEffect } from '../engine/effects.js';
import {
  isWildCard, resolveMeld, resolveHit, itemsMatchContract,
  getMeldGroups, meldKindOf, pinnedAttr, wildHitValues,
} from './melds.js';
import { findContractLayDown, findHits } from './contract-rummy-bot.js';
import { arrangeContract, suggestMeld } from './contract-rummy-ui.js';

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
  ctx.dealEach(resolveByPlayers(ctx.rules.deal, ctx.seats));
  for (let s = 0; s < ctx.seats; s++) {
    ctx.setPlayerVar(s, 'laidDown', false);
    ctx.setPlayerVar(s, 'melds', undefined);
    ctx.setPlayerVar(s, 'skipNextTurn', false);
  }
  ctx.deal('discard', 1);
}

const contractRummy = {
  id: 'contract-rummy',

  defaultZones(rules, seats) {   // eslint-disable-line no-unused-vars
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'sorted', facing: 'up' },
      // `interactive`: hidden, but it is the draw control, so it stays on the felt.
      { id: 'draw', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Draw', interactive: true },
      // `landing: 'discard'`: a play here goes to a meld, never to a pile, so
      // only the discard has an implicit destination.
      { id: 'discard', per: 'shared', visibility: 'top', layout: 'stack', order: 'stack', facing: 'up', label: 'Discard', landing: 'discard' },
      { id: 'melds', per: 'player', visibility: 'all', layout: 'grid', order: 'free', facing: 'up', label: 'Melds' },
    ];
  },

  defaultReactions() {
    return [recycleDiscardIntoDraw()];
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
    ctx.setTurnSeat(ctx.openingSeat());
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

      // "Does this card do something when discarded?" is the engine effects
      // library's question now, not a hardcoded `effect.type === 'skipTarget'`.
      if (hasKnownEffect(ctx.cardById(cardId), 'discard')) {
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

      // COMPLETING THE LAST CONTRACT WINS, THERE AND THEN.
      //
      // It used to advance the phase past the final rung and carry on, and the
      // two rules together made a trap: advance-on-complete does not care who
      // goes out, but the match-over question only ever asked about the seat
      // that DID go out. Finish the course while somebody else goes out and
      // nobody asks about you — so you sit one rung past the end of the ladder
      // with no contract to lay down, unable to empty your hand, unable to go
      // out, and therefore unable ever to win. The match then runs until some
      // other seat manages to finish AND go out in the same round; a real game
      // reached round sixteen this way.
      //
      // Ending the round here also keeps `isGameOver` honest, because it means
      // no seat can ever be sitting past the last rung while play continues.
      if (completed >= ctx.rules.contracts.length) {
        ctx.endRound(seat);
        return;
      }

      if (ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).length === 0) ctx.endRound(seat);
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
      if (ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).length === 0) ctx.endRound(seat);
      return;
    }

    if (move.type === 'discard') {
      const cardId = move.cards[0];
      const card = ctx.cardById(cardId);
      ctx.moveCards([cardId], ctx.zoneAddr('hand', seat), 'discard');

      if (ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).length === 0) {
        ctx.endRound(seat);
        return;
      }

      runEffect(ctx, { card, actor: seat, choice: move.choice, when: 'discard' });
      ctx.setTurnSeat(skipNextTurnFrom(ctx, seat));
      ctx.setPhase('draw');
    }
  },

  /* ---------------------------------------------------------------- *
   * What the platform asks this template about itself (src/templates/CONTRACT.md)
   * ---------------------------------------------------------------- */

  interactionMode(ctx) {
    return ctx.turn.phase === 'draw' ? 'rummy-draw' : 'rummy-meld';
  },

  /**
   * The question a move still owes before it can be applied — asked in a loop
   * by the platform until it answers null.
   *
   * Two questions live here, and they used to live in two different places in
   * src/ui/table.js: WHICH CARD A WILD IS BEING PLAYED AS on its way into a
   * meld, and WHO a discarded skip is aimed at. The second was a hardcoded
   * `effect.type === 'skipTarget' && effect.on === 'discard'` in the platform's
   * move gate — one effect schema's behaviour, known to the UI.
   *
   * The wild question is only asked where the answer is genuinely the player's:
   * a run has two open ends and choosing between them is a real decision (the
   * low end blocks a different card than the high end does). A set or a colour
   * group has exactly one value on offer and a prompt there would be theatre;
   * the same goes for a natural card, which is already the card it is. Answering
   * null is the platform's cue to send the move as it stands and let resolveMeld
   * freeze the one value that fits.
   */
  pendingChoice(ctx, move) {
    if (move?.type === 'hit' && !move.choice?.wilds) {
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
      if (values.length <= 1) return null;
      const attr = pinnedAttr(kind);
      return {
        attr,
        prompt: attr,
        kind: 'value',
        cardId,
        options: values.map((value) => ({ value })),
        apply: (m, value) => ({
          ...m,
          choice: { ...(m.choice || {}), wilds: { [cardId]: { [attr]: value } } },
        }),
      };
    }

    if (move?.type === 'discard' && move.choice?.target === undefined) {
      const card = move.cards?.length ? ctx.cardById(move.cards[0]) : null;
      if (!hasKnownEffect(card, 'discard')) return null;
      const options = [];
      for (let s = 0; s < ctx.seats; s++) if (s !== move.actor) options.push({ value: s });
      if (!options.length) return null;
      return {
        attr: 'player',
        prompt: 'player to skip',
        kind: 'seat',
        cardId: move.cards[0],
        options,
        apply: (m, value) => ({ ...m, choice: { ...(m.choice || {}), target: value } }),
      };
    }

    return null;
  },

  /**
   * A seat's laid-down melds, as the groups a hit can target.
   *
   * Exposed because the table re-implemented this fallback — stored groupings,
   * else the whole zone as one group — in a copy whose own comment admitted it
   * was a copy.
   */
  getMeldGroups(ctx, seat) {
    return getMeldGroups(ctx, seat);
  },

  /**
   * What this seat is RACING, for the felt's score chips.
   *
   * The contract you have reached is the score that matters in this genre and
   * the points are the tiebreak, which is why the platform's plain-score default
   * is wrong here — and why the platform used to read `playerVars[seat].phase`
   * directly in five places.
   */
  scoreChip(ctx, seat) {
    const phase = ctx.playerVar(seat, 'phase');
    const score = ctx.score(seat);
    if (typeof phase !== 'number') return null;
    return {
      short: `Ph ${phase}`,
      long: `Ph ${phase} · ${score}`,
      aria: `on contract ${phase}, ${score} points`,
    };
  },

  /**
   * The hand IS the race here — you win a round by going out — so the default
   * primary counter is already right and this only adds the second one.
   *
   * "Has this player laid down yet" is the question a rummy table is read for,
   * and it is exactly what minimizing a seat hides: the meld chips are the
   * first thing to go behind the tap. The count comes out onto the face so the
   * answer survives at a glance even when the melds themselves do not.
   *
   * Suppressed at zero rather than shown as "▤0": an empty badge on every seat
   * for the first three rounds is noise, and its absence already says nobody
   * has laid down.
   */
  seatCounters(ctx, seat) {
    const hand = ctx.countIn(`hand.${seat}`);
    const counters = [{
      text: String(hand),
      aria: `${hand} ${hand === 1 ? 'card' : 'cards'}`,
      label: 'Cards',
      kind: 'hand',
    }];
    const melds = getMeldGroups(ctx, seat).length;
    if (melds > 0) {
      counters.push({
        text: `▤${melds}`,
        aria: `${melds} laid down`,
        label: 'Laid down',
        kind: 'melds',
        // Only worth the space once the melds are hidden — on an open seat the
        // chips themselves are directly below, and counting them for the
        // player is saying twice what the felt already says once.
        minimizedOnly: true,
      });
    }
    return counters;
  },

  ruleLines() {
    return [
      'A turn is draw, then meld, then discard.',
      'Draw from the deck or take the top of the discard pile.',
      'Once your contract is complete you can lay it down; after that you may add cards to anyone\'s melds.',
      'End your turn by discarding one card.',
    ];
  },

  endingLines(pack) {
    const contracts = pack.rules?.contracts;
    return Array.isArray(contracts) && contracts.length
      ? [`There are ${contracts.length} contracts; the match ends when the last one is played.`]
      : [];
  },

  botVerbs: { layDown: 'laid down their contract', hit: 'hit a meld' },

  statLines(seat) {
    return [
      { label: 'Contract reached', value: seat.phaseReached, always: true },
      { label: 'Melds laid', value: seat.meldsLaid, always: true },
      { label: 'Hits', value: seat.hits },
      { label: 'Cards drawn', value: seat.draws },
    ];
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
      moves.push(...findHits(ctx, seat, contractRummy.validateMove));
    }

    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    for (const cardId of hand) {
      const card = ctx.cardById(cardId);
      if (hasKnownEffect(card, 'discard')) {
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
    return ctx.state.roundEnded;
  },


  /**
   * The match is over once ANYBODY has finished the course.
   *
   * Asked of every seat rather than only of the one that went out. Those are
   * the same seat in ordinary play — applyMove ends the round the moment a
   * final contract is laid down — but they were NOT the same under the old
   * rule, and the gap is what stranded a player one rung past the end of the
   * ladder with no contract left and no way to win. Reading the board rather
   * than a single provisional winner means the answer cannot depend on which
   * seat the pipeline happened to publish.
   *
   * It also decides correctly for a match SAVED under the old rule, where a
   * seat can already be sitting past the last contract: that game is over, and
   * this says so instead of replaying it into the same trap.
   */
  isGameOver(ctx) {
    const last = ctx.rules.contracts.length;
    for (let seat = 0; seat < ctx.seats; seat++) {
      const phase = ctx.playerVar(seat, 'phase');
      if (phase != null && phase > last) return true;
    }
    return false;
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

// The two human affordances live in ./contract-rummy-ui.js; they are part of
// this template's hook surface, so they are composed on here. arrangeContract
// takes the validator it must satisfy rather than importing this module back.
contractRummy.arrangeContract = (ctx, seat, cardIds) =>
  arrangeContract(ctx, seat, cardIds, contractRummy.validateMove);
contractRummy.suggestMeld = suggestMeld;

export default contractRummy;
