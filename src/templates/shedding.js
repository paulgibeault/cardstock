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

/* ------------------------------------------------------------------ *
 * The last-card call ("Uno!") — design doc §4, "announcements"
 * ------------------------------------------------------------------ *
 *
 * AN ANNOUNCEMENT IS A MOVE. It is declared in the manifest (`lastCardCall`),
 * but it reaches the state through the ordinary propose → validate → apply →
 * LOG pipeline like everything else, and that last word is the reason: the log
 * IS the saved match (src/engine/replay.js). An announcement applied around
 * the pipeline would set a player var that no replay could reproduce, so a
 * resumed game would forget who had called and quietly re-expose them to a
 * penalty they had already avoided.
 *
 * Two move types, both deliberately OUT of turn — which is what makes them
 * announcements rather than plays, and why the turn check below is scoped to
 * the turn moves instead of guarding the whole validator:
 *
 *   announce   the actor declares their own last card
 *   challenge  anyone catches a seat that is at the count and never declared
 *
 * They are also deliberately absent from `enumerateLegalMoves`: that list is
 * "what may I do with my turn", and it feeds the bot's move chooser. An
 * announcement is offered through `enumerateAnnouncements` instead, so a bot
 * decides whether to remember (persona `callReliability`) rather than having
 * a heuristic accidentally rank "say Uno" against "play the red 7".
 */

function lastCardCallVarName(cfg) {
  return `__${cfg.id}Called`;
}

// The hand size each seat was last seen holding, so refreshCallFlags can tell a
// descent (which a declaration survives) from a growth (which ends it).
function lastCardSeenVarName(cfg) {
  return `__${cfg.id}Seen`;
}

function callCountOf(cfg) {
  return cfg.atHandCount ?? 1;
}

function handSizeOf(ctx, seat) {
  return ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).length;
}

/**
 * May this seat declare right now?
 *
 * DELIBERATELY WIDER THAN THE VULNERABLE WINDOW, because that is the actual
 * rule at a table: you say it AS you play your second-to-last card, not after.
 * A player holding two cards who declares and then plays one has done the
 * normal, correct thing and must not be catchable — so the legal window is
 * "at the count, or one card above it", and the flag has to survive the
 * descent through it.
 *
 * The narrower window is what gets OFFERED (see enumerateAnnouncements): the
 * moment worth putting a button on screen for is the one where forgetting
 * costs you. Validation is the rule; enumeration is the prompt. They are
 * allowed to differ, and this is not the first place in this engine where they
 * do — the passing phase enumerates one canonical pass without that being the
 * only legal one.
 */
function canDeclare(ctx, cfg, seat) {
  const size = handSizeOf(ctx, seat);
  return size > 0 && size <= callCountOf(cfg) + 1;
}

/** At the count and yet to say so — the window a challenge is valid in. */
function isVulnerable(ctx, cfg, seat) {
  return handSizeOf(ctx, seat) === callCountOf(cfg)
    && !ctx.playerVar(seat, lastCardCallVarName(cfg));
}

/**
 * Drop the "already called" flag from every seat whose hand has grown since we
 * last looked, after every applied move.
 *
 * Swept over all seats rather than threaded through each hand mutation: a hand
 * changes size from a play, a draw, a Draw-2 landing on someone else, a swap, a
 * rotation and a challenge penalty, and a rule that has to be remembered at six
 * call sites is a rule that will be forgotten at the seventh.
 *
 * A DECLARATION COVERS ONE DESCENT, NOT THE REST OF THE ROUND. It has to
 * survive the descent through the declaring window — canDeclare() lets you
 * declare at one card above the count, so a player who says it and then plays
 * their second-to-last card must not be catchable — but the moment the hand
 * grows the descent is over and the next one needs saying again.
 *
 * Comparing against the LAST SEEN SIZE rather than a fixed threshold is what
 * makes that work. A threshold of `count + 1` looks equivalent and is not:
 * Wildfire's `drawWhenStuck: 1` means a player at one card draws back to
 * exactly two, which is not greater than two, so the stale call survived and
 * that seat could never be caught again for the rest of the round no matter how
 * many times they returned to their last card. `count` on its own is worse — it
 * wipes the pre-emptive declaration the instant it is acted on.
 *
 * The old threshold is kept as a floor for one path only: applyAnnouncement()
 * is a rule-test entry point that reaches applyAnnounce() without validateMove,
 * so it can set a flag at a hand size canDeclare() would have refused.
 */
function refreshCallFlags(ctx) {
  const cfg = ctx.rules.lastCardCall;
  if (!cfg) return;
  const varName = lastCardCallVarName(cfg);
  const seenName = lastCardSeenVarName(cfg);
  const limit = callCountOf(cfg) + 1;
  for (let s = 0; s < ctx.seats; s++) {
    const size = handSizeOf(ctx, s);
    const seen = ctx.playerVar(s, seenName);
    if (ctx.playerVar(s, varName) && (size > limit || (seen !== undefined && size > seen))) {
      ctx.setPlayerVar(s, varName, false);
    }
    ctx.setPlayerVar(s, seenName, size);
  }
}

/**
 * An action card's effect, and the derived event that says it happened.
 *
 * The event is not decoration. An action card is the most consequential thing
 * anyone plays and, until these existed, the least visible: the state changed
 * — a seat lost their turn, the table turned round, somebody was handed four
 * cards — and the only trace was that the discard looked different and the log
 * said "Rook played." The engine knows exactly who it happened to, and this is
 * the channel that already carries a trick resolving to the felt, so the table
 * can say so without re-deriving any of it from zone diffs.
 */
function applyEffect(ctx, card, playerSeat, choice) {
  const effect = effectOf(card);
  const type = typeof effect === 'string' ? effect : effect.type;
  let advance = 1;

  if (type === 'skip') {
    const target = ctx.nextSeat(playerSeat);
    ctx.emit('skipped', { by: playerSeat, seat: target });
    advance = 2;
  } else if (type === 'reverse') {
    ctx.reverseDirection();
    // Emitted after the flip, so `direction` is the one now in force.
    ctx.emit('reversed', { by: playerSeat, direction: ctx.state.direction });
    advance = ctx.seats === 2 ? 2 : 1;
  } else if (type === 'drawN' || type === 'wildDrawN') {
    const target = ctx.nextSeat(playerSeat);
    const before = ctx.cardIdsIn(ctx.zoneAddr('hand', target)).length;
    drawCards(ctx, target, effect.n);
    // The count actually dealt, not the one asked for: an exhausted pile that
    // could not be recycled hands over fewer, and the table should say what
    // really happened.
    ctx.emit('penalty', {
      by: playerSeat,
      seat: target,
      drew: ctx.cardIdsIn(ctx.zoneAddr('hand', target)).length - before,
      asked: effect.n,
    });
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
      ctx.emit('handsSwapped', { by: playerSeat, seat: other });
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
    ctx.emit('handsRotated', { by: playerSeat, direction: ctx.state.direction });
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

  // A wild is the one play whose consequence is invisible on the card itself:
  // the discard shows a wild, and what the table now has to match is a colour
  // that exists only in a var. The event carries the chosen values so the felt
  // can show them without knowing which attribute this pack chooses on.
  if (isWildEffect(effectOf(card))) {
    const chosen = {};
    for (const attr of ctx.rules.matchOn) {
      const value = getActiveValue(ctx, attr);
      if (value !== undefined) chosen[attr] = value;
    }
    ctx.emit('wildPlayed', { seat, chose: chosen });
  }

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

function applyAnnounce(ctx, move) {
  const cfg = ctx.rules.lastCardCall;
  if (!cfg) return;
  ctx.setPlayerVar(move.actor, lastCardCallVarName(cfg), true);
  ctx.emit('announced', { seat: move.actor, id: cfg.id, label: cfg.label || 'Last card!' });
}

function applyChallenge(ctx, move) {
  const cfg = ctx.rules.lastCardCall;
  if (!cfg) return;
  const target = move.target;
  // Re-checked rather than assumed legal: applyAnnouncement (the rule-test
  // entry point) reaches this without going through validateMove.
  if (!isVulnerable(ctx, cfg, target)) return;
  const penalty = cfg.penalty?.draw ?? 0;
  const before = handSizeOf(ctx, target);
  drawCards(ctx, target, penalty);
  ctx.emit('caught', {
    seat: move.actor,
    target,
    drew: handSizeOf(ctx, target) - before,
    label: cfg.label || 'Last card!',
  });
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
    // Flip the starting discard card, burying wilds until a natural one turns up.
    //
    // A wild starter is not merely untidy, it is unplayable: a wild carries no
    // colour or suit of its own, so updateActiveAfterPlay leaves every matchOn
    // attribute unset and cardMatchesActive then rejects EVERY ordinary card in
    // every hand. The table grinds through draws until somebody happens to turn
    // up another wild — and under the draw-to-match variant the first player
    // draws most of the pile doing it. At Wildfire's ratio (8 of 108 cards) that
    // was one deal in fourteen.
    //
    // Buried to the bottom rather than reshuffled: it stays in play, and it
    // costs no RNG draws, so a seed still deals the same game.
    let starter;
    const drawPile = ctx.zone('draw').cards;
    for (let guard = drawPile.length; guard > 0; guard--) {
      const top = drawPile[drawPile.length - 1];
      if (top === undefined) break;
      if (!isWildEffect(effectOf(ctx.cardById(top)))) {
        starter = top;
        break;
      }
      ctx.moveCards([top], 'draw', 'draw', { position: 'bottom' });
    }
    if (starter !== undefined) {
      ctx.moveCards([starter], 'draw', 'discard');
      updateActiveAfterPlay(ctx, ctx.cardById(starter), null);
    }
    // A fresh deal starts fresh: without this a new round inherited the previous
    // one's direction (whatever the last reverse left it at) and opened on
    // whoever had just won, because applyPlayCard returns before advancing the
    // turn. The deal rotates a seat per round, as it would at a table.
    ctx.setDirection(1);
    ctx.setTurnSeat((ctx.state.roundNumber - 1) % ctx.seats);
    ctx.setPhase('play');
  },

  validateMove(ctx, move) {
    // Announcements first, and before the turn check: being out of turn is
    // what they ARE (see the block comment above).
    if (move.type === 'announce' || move.type === 'challenge') {
      const cfg = ctx.rules.lastCardCall;
      if (!cfg) return ctx.fail('no-announcement', 'This game has nothing to declare.');
      if (move.id !== cfg.id) return ctx.fail('unknown-announcement', `Unknown announcement: ${move.id}`);

      if (move.type === 'announce') {
        if (!canDeclare(ctx, cfg, move.actor)) {
          return ctx.fail('not-at-count',
            `You can only declare when you are down to ${callCountOf(cfg)} card(s).`);
        }
        if (ctx.playerVar(move.actor, lastCardCallVarName(cfg))) {
          return ctx.fail('already-called', 'You have already declared.');
        }
        return ctx.ok();
      }

      const target = move.target;
      if (target === undefined || target === null) return ctx.fail('no-target', 'No player named.');
      if (target === move.actor) return ctx.fail('self-challenge', 'You cannot catch yourself.');
      if (target < 0 || target >= ctx.seats) return ctx.fail('no-target', 'No such player.');
      if (!isVulnerable(ctx, cfg, target)) {
        return ctx.fail('not-catchable', 'There is nothing to catch them on.');
      }
      return ctx.ok();
    }

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
    else if (move.type === 'announce') applyAnnounce(ctx, move);
    else if (move.type === 'challenge') applyChallenge(ctx, move);
    refreshCallFlags(ctx);
  },

  /**
   * What `seat` may say right now, as ready-to-validate moves.
   *
   * Same discipline as enumerateLegalMoves: the UI dresses these as buttons
   * and the bot driver rolls its persona against them, but neither ever
   * CONSTRUCTS one — every announcement that reaches the engine came out of
   * this list and goes back through validateMove.
   */
  enumerateAnnouncements(ctx, seat) {
    const cfg = ctx.rules.lastCardCall;
    if (!cfg || ctx.state.gameOver) return [];
    const out = [];
    if (isVulnerable(ctx, cfg, seat)) {
      out.push({ actor: seat, type: 'announce', id: cfg.id, label: cfg.label || 'Last card!' });
    }
    for (let s = 0; s < ctx.seats; s++) {
      if (s === seat) continue;
      if (!isVulnerable(ctx, cfg, s)) continue;
      out.push({ actor: seat, type: 'challenge', id: cfg.id, target: s, label: 'Catch!' });
    }
    return out;
  },

  /**
   * Kept as the pre-move-pipeline entry point (tools/pack-test.mjs' `announce`
   * assertion calls it) — now a thin adapter onto the move path, so a rule test
   * and a real table exercise exactly the same code.
   */
  applyAnnouncement(ctx, announcement) {
    const cfg = ctx.rules.lastCardCall;
    if (!cfg) return;
    if (announcement.challenge === cfg.id) {
      applyChallenge(ctx, { actor: announcement.actor, target: announcement.target, id: cfg.id });
    } else if (announcement.id === cfg.id) {
      applyAnnounce(ctx, { actor: announcement.actor, id: cfg.id });
    }
    refreshCallFlags(ctx);
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
