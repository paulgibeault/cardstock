// Shedding template (design doc §13.2). Validates against Crazy Eights and Wildfire.
// Match-and-discard: play a card matching the active state on any matchOn attribute
// (or a wild), first to empty hand wins.

import { initializeDeckInto } from '../engine/state.js';
import { resolveByPlayers, recycleDiscardIntoDraw } from '../engine/deal.js';
import { distinctValues, isWild } from '../engine/cards.js';
import { applyEffect as runEffect } from '../engine/effects.js';
import { cardValue } from '../engine/scoring.js';

/* ------------------------------------------------------------------ *
 * What a position is worth (see `evaluateState` at the foot of this file)
 * ------------------------------------------------------------------ *
 *
 * The scale is arbitrary and per-template — the lookahead only ever compares it
 * against itself — but the RATIOS are the opinion. One card out of the hand is
 * worth more than one more way to get a card out of the hand, which is worth
 * more than a point of end-of-round cost, because emptying the hand is how you
 * win and the points are only what losing costs.
 */
const CARD_IN_HAND = 4;
const EXIT_WORTH = 1.5;
const WILD_WORTH = 1.5;
const DEADWOOD_WORTH = 0.05;

/** How much the nearest opponent's hand discounts your own position. */
const RIVAL_SHARE = 2;

/**
 * The five numbers above, gathered, so a caller can hand `evaluateState` a
 * different set (src/templates/CONTRACT.md, `weights`). The constants keep
 * their comments; this is the shipped value of each, frozen.
 */
export const WEIGHTS = Object.freeze({
  CARD_IN_HAND, EXIT_WORTH, WILD_WORTH, DEADWOOD_WORTH, RIVAL_SHARE,
});

/**
 * A card that plays on anything. Asked of the shared predicate rather than of
 * the effect type alone, so a pack that tags its wilds is understood here the
 * same way contract-rummy and sequencing understand theirs.
 */
function isWildCard(ctx, card) {
  return isWild(card, ctx.rules.wilds);
}

function effectOf(card) {
  return card.effect || null;
}

/** What this card makes you decide before it lands, or undefined for most cards. */
function chooseAttrOf(effect) {
  return typeof effect === 'object' && effect ? effect.choose : undefined;
}

/**
 * EVERY ANSWER A CARD'S `choose` HAS, as the choice object each enumerated move
 * carries — `[null]` when the card asks nothing.
 *
 * This exists because "the card asks a question" and "the moves say what the
 * answers are" had drifted apart, and the seven-zero variant fell down the gap.
 * A wild enumerated one move per colour; a `swapHands` seven declared
 * `choose: 'player'` and enumerated ONE move with no choice on it at all. So
 * `applyEffect` read `choice.player` off a move that never had one, found
 * undefined, and quietly did nothing — for bots and for the human alike. The
 * card said "Swap hands with a player of your choosing" and no hand ever moved.
 *
 * Enumerating the targets is what makes the variant real, and it makes it real
 * in the one place the whole engine agrees on: the bot chooser picks from this
 * list, the table's tap targets are derived from it, and validateMove holds
 * anything that arrives by another road to the same shape.
 *
 * A target is a SEAT NUMBER, not a value off a card — the one choice in this
 * template that is about the table rather than about the deck.
 */
function choiceValues(ctx, seat, attr) {
  if (attr === 'player') {
    // A target is a SEAT NUMBER, not a value off a card — the one choice in
    // this template that is about the table rather than about the deck. A
    // one-seat table has nobody to swap with, and returns none.
    const out = [];
    for (let s = 0; s < ctx.seats; s++) if (s !== seat) out.push(s);
    return out;
  }
  // Every OTHER answer comes out of the deck. The suit list used to be the four
  // French suits, written out — which is a claim about the deck that only one
  // of the five packs can make, and the colour branch was already deriving its
  // answers properly, in a loop that also existed in contract-rummy.
  if (attr === 'suit' || attr === 'color') return distinctValues(ctx.pack.cardsById, attr);
  // An attribute this template has no answers for. The card still plays; the
  // effect that wanted the choice will find none and skip, which is what an
  // unrecognised `choose` should do rather than making the card dead.
  return [];
}

function choiceOptions(ctx, seat, attr) {
  if (!attr) return [null];
  const values = choiceValues(ctx, seat, attr);
  return values.length ? values.map((value) => ({ [attr]: value })) : [null];
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
  if (isWildCard(ctx, card)) return true;
  return ctx.rules.matchOn.some((attr) => {
    const active = getActiveValue(ctx, attr);
    return active !== undefined && card[attr] === active;
  });
}

/**
 * Is there anything in this hand that could be played right now?
 *
 * Only asked under `mustPlayIfAble`, and asked of the WHOLE hand because that
 * is the rule: you may not draw while you are holding a card that fits. The
 * same predicate the enumerator filters on (a wild always fits, everything else
 * has to match), so the offered moves and the validator cannot disagree — which
 * is the invariant that made this flag worth implementing rather than deleting.
 * The help text in src/ui/rules.js has been reading it since it was written.
 */
function hasPlayableCard(ctx, seat) {
  return ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).some((id) => cardMatchesActive(ctx, ctx.cardById(id)));
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
  return ctx.deal(ctx.zoneAddr('hand', seat), n);
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
 * Run an action card's effect and move the turn on by what it says.
 *
 * The effects themselves live in src/engine/effects.js now — they are engine
 * operations (design doc §7), not shedding's private business, and
 * contract-rummy was hand-implementing its own `skipTarget` for want of them.
 * What stays here is the one thing that IS this template's: what a turn is, and
 * therefore what "advance by two" means.
 */
function applyEffect(ctx, card, playerSeat, choice) {
  const { advanceBy } = runEffect(ctx, { card, actor: playerSeat, choice });
  let seat = playerSeat;
  for (let i = 0; i < advanceBy; i++) seat = ctx.nextSeat(seat);
  ctx.setTurnSeat(seat);
  ctx.setPhase('play');
}

function applyPlayCard(ctx, move) {
  const seat = move.actor;
  const cardId = move.cards[0];
  const card = ctx.cardById(cardId);

  // Cleared here rather than in applyEffect, which sets the phase and the turn
  // itself and returns down several paths — and a stale `drawnCardId` outliving
  // the turn that owned it would lock the NEXT player's hand to somebody else's
  // card the moment anything set the phase back to playDrawn.
  ctx.setVar('drawnCardId', null);

  ctx.moveCards([cardId], ctx.zoneAddr('hand', seat), 'discard');
  updateActiveAfterPlay(ctx, card, move.choice);

  // A wild is the one play whose consequence is invisible on the card itself:
  // the discard shows a wild, and what the table now has to match is a colour
  // that exists only in a var. The event carries the chosen values so the felt
  // can show them without knowing which attribute this pack chooses on.
  if (isWildCard(ctx, card)) {
    const chosen = {};
    for (const attr of ctx.rules.matchOn) {
      const value = getActiveValue(ctx, attr);
      if (value !== undefined) chosen[attr] = value;
    }
    ctx.emit('wildPlayed', { seat, chose: chosen });
  }

  const handLeft = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  if (handLeft.length === 0) {
    // The ROUND is over; whether the MATCH is over is the pipeline's call from
    // the pack's scoring.gameOver. See ctx.endRound in src/engine/context.js.
    ctx.endRound(seat);
    return;
  }

  const effect = effectOf(card);
  if (effect) applyEffect(ctx, card, seat, move.choice);
  else {
    ctx.setTurnSeat(ctx.nextSeat(seat));
    ctx.setPhase('play');
  }
}

/* ------------------------------------------------------------------ *
 * Drawing, and the turn that does not end with it — `playAfterDraw`
 * ------------------------------------------------------------------ *
 *
 * The canonical draw rule is six things at once, and only two of them were
 * ever implemented: you may draw even holding a playable card (saving a wild
 * is a real move); a drawn card that fits may be played at once; you are not
 * obliged to play it; the hand you held BEFORE the draw goes dead for the rest
 * of the turn; one draw a turn; and a penalty draw is never any of this.
 *
 * The manifests declared it — `playAfterDraw` / `mustPlayIfAble` have been
 * sitting in packs/wildfire and packs/crazy-eights since they were written —
 * and nothing read them. Everything below is gated on those flags, so a pack
 * that says `playAfterDraw: false` (or says nothing) plays exactly as before.
 *
 * THE TURN ENDS WITH A MOVE, `pass`, FOR THE SAME REASON AN ANNOUNCEMENT IS A
 * MOVE (see the block comment above). "The player looked at the drawn card and
 * decided to keep it" is a state change — it is what hands the turn on — and a
 * turn ended implicitly in UI code would be absent from the log, so a resumed
 * match would replay the draw and then sit forever in a phase nobody ever left.
 * Routed through propose → validate → apply → log it replays, resumes, and
 * drives the bots with no extra machinery: `pass` scores like `draw`, and the
 * bot chooser already treats both as holding moves (src/engine/bot.js).
 *
 * The live card is a turn-scoped var rather than "the last card in the hand",
 * because a hand is re-sorted for display and the rule has to survive that.
 */

/** The one card that may be played this turn, or null when the hand is free. */
function drawnCardIdOf(ctx) {
  if (ctx.turn.phase !== 'playDrawn') return null;
  return ctx.var('drawnCardId') ?? null;
}

function applyDraw(ctx, move) {
  const seat = move.actor;
  const handAddr = ctx.zoneAddr('hand', seat);
  const held = ctx.cardIdsIn(handAddr).length;
  const mode = ctx.rules.drawWhenStuck;
  if (mode === 'until-playable') {
    for (let i = 0; i < 200; i++) {
      const before = ctx.countIn('draw');
      drawCards(ctx, seat, 1);
      if (ctx.countIn('draw') === before && before === 0) break; // deck truly exhausted
      const newest = ctx.cardIdsIn(handAddr).slice(-1)[0];
      if (!newest) break;
      if (cardMatchesActive(ctx, ctx.cardById(newest))) break;
    }
  } else {
    drawCards(ctx, seat, mode ?? 1);
  }

  // What actually arrived, not what was asked for: `drawWhenStuck: 0` and an
  // exhausted pile that could not be recycled both deal nothing, and the card
  // already at the end of the hand is one the player has been holding.
  const after = ctx.cardIdsIn(handAddr);
  const drawn = after.length > held ? after[after.length - 1] : null;
  // Under `until-playable` the loop above already stopped ON a playable card;
  // that final card enters this state like any other.
  if (drawn && ctx.rules.playAfterDraw && cardMatchesActive(ctx, ctx.cardById(drawn))) {
    ctx.setVar('drawnCardId', drawn);
    ctx.setPhase('playDrawn');
    // Deliberately says only WHO — the card is in one player's hand and the
    // event stream is read by every seat's view.
    ctx.emit('drewPlayable', { seat });
    return;
  }
  ctx.setVar('drawnCardId', null);
  ctx.setTurnSeat(ctx.nextSeat(seat));
  ctx.setPhase('play');
}

function applyPass(ctx, move) {
  ctx.setVar('drawnCardId', null);
  ctx.setTurnSeat(ctx.nextSeat(move.actor));
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
  // Re-checked rather than assumed legal: applyAnnouncementUnlogged (the
  // rule-test entry point) reaches this without going through validateMove.
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

  // WHICH SHARED VARS A PEER MAY SEE (src/engine/view.js). An ALLOWLIST, so a
  // var nobody thought about stays private: `drawnCardId` is the reason — it
  // holds a card sitting in one player's hand, and a denylist would have had
  // to know to exclude it in advance. It is deliberately absent here, so it
  // reaches only the seat that drew it.
  publicVars: (rules) => (rules.matchOn || []).map(activeVarName),

  defaultZones(rules, seats) {   // eslint-disable-line no-unused-vars
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'sorted', facing: 'up' },
      // `interactive`: a hidden pile the human can still tap (it is the draw
      // control). Without it the table would filter it off the felt with the
      // other invisible zones.
      { id: 'draw', per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Draw', interactive: true },
      // `landing: 'both'`: where a played AND a discarded card lands when the
      // move names no destination. The table used to probe for 'discard' and
      // then 'trick' by name.
      { id: 'discard', per: 'shared', visibility: 'top', layout: 'stack', order: 'stack', facing: 'up', label: 'Discard', landing: 'both' },
    ];
  },

  defaultReactions() {
    return [recycleDiscardIntoDraw()];
  },

  setup(ctx) {
    initializeDeckInto(ctx.state, 'draw');
    ctx.dealEach(resolveByPlayers(ctx.rules.deal, ctx.seats));
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
      if (!isWildCard(ctx, ctx.cardById(top))) {
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
    ctx.setTurnSeat(ctx.openingSeat());
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

    // The drawn card is the only live one, and saying so HERE rather than only
    // in enumerateLegalMoves is what makes the rule real: the enumeration is a
    // prompt, the validator is the rule, and every move — a bot's, a replayed
    // one, a dragged one — comes back through this door.
    const drawnCardId = drawnCardIdOf(ctx);
    if (drawnCardId && move.type === 'playCard' && move.cards?.[0] !== drawnCardId) {
      return ctx.fail('drawn-only',
        'Only the card you just drew can be played — the rest of your hand waits for your next turn.');
    }

    if (move.type === 'pass') {
      // Illegal in the ordinary play phase, and that is not an oversight:
      // `mustPlayIfAble: false` says you may DRAW instead of playing, not that
      // you may sit a turn out for free. The only way to reach a pass is to
      // have drawn first, which is what makes it "keep it" rather than "skip".
      if (ctx.turn.phase !== 'playDrawn') {
        return ctx.fail('phase', 'There is nothing to keep — draw or play a card.');
      }
      return ctx.ok();
    }

    if (move.type === 'playCard') {
      const cardId = move.cards?.[0];
      if (!cardId) return ctx.fail('no-card', 'No card specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!hand.includes(cardId)) return ctx.fail('not-in-hand', 'That card is not in your hand.');
      const card = ctx.cardById(cardId);

      const effect = effectOf(card);
      if (!cardMatchesActive(ctx, card)) {
        return ctx.fail('match', 'That card does not match the current suit/rank/color.');
      }

      // The choice is demanded of EVERY card that asks for one, not only of a
      // wild. It used to be checked inside the wild branch, so a seven-zero
      // seven — an ordinary card with `choose: 'player'` — sailed through with
      // no target and swapped nothing (see choiceOptions above).
      const chooseAttr = chooseAttrOf(effect);
      if (chooseAttr) {
        const picked = move.choice ? move.choice[chooseAttr] : undefined;
        // Absent is only a failure when there was something to pick: a
        // two-hander has one opponent and a solitaire table has none, and
        // choiceOptions is the single place that decides which.
        const offered = choiceOptions(ctx, move.actor, chooseAttr);
        const asked = offered.length > 1 || offered[0] !== null;
        if (picked === undefined) {
          // Only ever seen if a move reaches the engine without having been
          // asked — the table asks first. Worded per attribute anyway: "choose
          // a player to continue with" is not a sentence about a target.
          if (asked) {
            return ctx.fail('choice-required', chooseAttr === 'player'
              ? 'Choose the player this card acts on.'
              : `Choose a ${chooseAttr} to continue with.`);
          }
        } else if (chooseAttr === 'player') {
          // A seat, and one that exists — this is the only choice in the
          // template that indexes the table rather than naming a card value,
          // so a stray string here would address a zone that is not there.
          if (!Number.isInteger(picked) || picked < 0 || picked >= ctx.seats || picked === move.actor) {
            return ctx.fail('no-target', 'No such player.');
          }
        }
      }
      return ctx.ok();
    }

    if (move.type === 'draw') {
      // One draw a turn. Nothing enumerates a second one, but a stored log or a
      // peer's move arrives here without having asked.
      if (drawnCardId) return ctx.fail('one-draw', 'You have already drawn this turn.');
      if (ctx.rules.mustPlayIfAble && hasPlayableCard(ctx, move.actor)) {
        return ctx.fail('must-play', 'You are holding a card that fits, and this game makes you play it.');
      }
      return ctx.ok();
    }

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    if (move.type === 'playCard') applyPlayCard(ctx, move);
    else if (move.type === 'draw') applyDraw(ctx, move);
    else if (move.type === 'pass') applyPass(ctx, move);
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
    // After a draw the hand is one card long as far as this turn is concerned.
    // Narrowing the ENUMERATION, and not only the validator, is what makes the
    // dead-hand rule hold for bots and for humans out of the same code: the bot
    // chooser picks from this list, and every tap target the table lights up is
    // derived from it (src/ui/interaction.js).
    const drawnCardId = seat === ctx.turn.seat ? drawnCardIdOf(ctx) : null;
    const hand = drawnCardId
      ? ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).filter((id) => id === drawnCardId)
      : ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    for (const cardId of hand) {
      const card = ctx.cardById(cardId);
      const effect = effectOf(card);
      // A wild plays on anything; everything else has to match. That test is
      // about whether the card may be PLAYED — what it then asks you to decide
      // is a separate question, and one an ordinary action card is allowed to
      // ask too (the seven-zero swap is a plain seven that happens to have a
      // target).
      if (!cardMatchesActive(ctx, card)) continue;
      for (const choice of choiceOptions(ctx, seat, chooseAttrOf(effect))) {
        moves.push(choice
          ? { actor: seat, type: 'playCard', cards: [cardId], choice }
          : { actor: seat, type: 'playCard', cards: [cardId] });
      }
    }
    // Exactly two ways out of playDrawn — play it, or keep it — so the table
    // can never render a dead end, and a bot can never be stranded in it.
    if (drawnCardId) moves.push({ actor: seat, type: 'pass' });
    // `mustPlayIfAble` withheld from the enumeration as well as the validator:
    // a bot picks from this list, so a draw offered here and refused there is a
    // frozen table rather than a rule. `moves.length` is exactly "something in
    // this hand is playable", which is the condition the validator checks.
    else if (!ctx.rules.mustPlayIfAble || moves.length === 0) moves.push({ actor: seat, type: 'draw' });
    return moves;
  },

  isRoundOver(ctx) {
    return ctx.state.roundEnded;
  },


  /* ---------------------------------------------------------------- *
   * What the platform asks this template about itself (src/templates/CONTRACT.md)
   * ---------------------------------------------------------------- */

  interactionMode(ctx) {
    return ctx.turn.phase === 'playDrawn' ? 'play-drawn' : 'tap';
  },

  /**
   * The value the whole table is playing to, and whether the card on the
   * discard can say it for itself.
   *
   * ONE FUNCTION FOR A CONVENTION THAT WAS SPREAD ACROSS THREE FILES. The table
   * built the var name from the attribute (`active${Attr}`), describe.js did the
   * derivation in reverse to get back from the var name to the attribute, and
   * two more places simply wrote `activeSuit || activeColor` and hoped. The
   * convention is this template's, so it is answered here.
   *
   * `onCard: false` is the whole reason the platform asks: a wild sits on the
   * discard showing no colour at all while every hand has to match one, and
   * that is the case the badge draws a swatch for and the screen reader is told
   * about.
   */
  activeMatch(ctx) {
    if (!ctx.hasZone('discard')) return null;
    const topId = ctx.topOf('discard');
    const card = topId !== undefined ? ctx.cardById(topId) : null;
    for (const attr of ctx.rules.matchOn || []) {
      const value = getActiveValue(ctx, attr);
      if (value === undefined || value === null) continue;
      return { address: 'discard', attr, value, onCard: !!card && card[attr] !== null && card[attr] !== undefined };
    }
    return null;
  },

  /**
   * The question this move still owes before it can be applied.
   *
   * Asked in a loop by the platform until it answers null — see
   * performHumanMove in src/ui/table.js. The template names the question and
   * says where the answer goes (`apply`); the platform renders the chooser and
   * knows nothing about effect schemas. That inversion is what makes a
   * pack-defined effect get a chooser for free.
   */
  pendingChoice(ctx, move) {
    if (move?.type !== 'playCard' || !move.cards?.length) return null;
    const card = ctx.cardById(move.cards[0]);
    const attr = chooseAttrOf(effectOf(card));
    if (!attr || move.choice?.[attr] !== undefined) return null;
    const values = choiceValues(ctx, move.actor, attr);
    if (!values.length) return null;
    return {
      attr,
      // "Choose a player to swap hands with" — being asked for a target is not
      // the same sentence in every game that asks for one.
      prompt: attr === 'player' ? 'player to swap hands with' : attr,
      kind: attr === 'player' ? 'seat' : 'value',
      cardId: move.cards[0],
      options: values.map((value) => ({ value })),
      apply: (m, value) => ({ ...m, choice: { ...(m.choice || {}), [attr]: value } }),
    };
  },

  /** The shape of a turn, for the generated rules page (src/ui/rules.js). */
  ruleLines(rules) {
    // "or", emphatically: matching on colour AND rank would be a different and
    // much worse game, and this is the sentence a new player reads first.
    const on = (rules.matchOn || []).map((a) => `the same ${a}`);
    const list = on.length <= 1 ? on.join('')
      : on.length === 2 ? `${on[0]} or ${on[1]}`
        : `${on.slice(0, -1).join(', ')} or ${on.at(-1)}`;
    const out = [`On your turn, play one card matching ${list || 'the top card'}.`];
    // "If you cannot play, draw" and "you may draw whenever you like" are
    // different games, and the pack already says which one this is. Reading
    // `mustPlayIfAble` here is what stops the help page from teaching a rule
    // the table no longer enforces — validateMove reads the same flag.
    const optional = rules.mustPlayIfAble !== true;
    if (rules.drawWhenStuck === 'until-playable') {
      out.push(optional
        ? 'You may draw instead of playing, and you keep drawing until something fits.'
        : 'If you cannot play, draw until you can.');
    } else if (rules.drawWhenStuck) {
      const n = rules.drawWhenStuck;
      const cards = n === 1 ? 'a card' : `${n} cards`;
      out.push(optional
        ? `You may draw ${cards} instead of playing — even holding something that fits, which is how you hang on to a card you would rather not spend yet.`
        : `If you cannot play, draw ${cards} and your turn ends.`);
    }
    if (rules.playAfterDraw && rules.drawWhenStuck) {
      out.push('A card you draw can be played straight away if it fits, or kept — either ends your turn, '
        + 'and the rest of your hand is out of play until your next one.');
    }
    return out;
  },

  endingLines(pack) {
    return pack.rules?.winner === 'first-empty-hand'
      ? ['A round ends the moment one player is out of cards.']
      : [];
  },

  /** What a bot's move is CALLED in the log line, beyond the platform's defaults. */
  botVerbs: { pass: 'kept the card they drew' },

  /** The end-of-match numbers this genre's players care about, in reading order. */
  statLines(seat) {
    return [
      { label: 'Cards played', value: seat.cardsPlayed, always: true },
      { label: 'Cards drawn', value: seat.draws, always: true },
      { label: 'Action cards', value: seat.effectsPlayed },
      { label: 'Declared', value: seat.declared },
      { label: 'Caught someone', value: seat.caughtOthers },
      { label: 'Caught out', value: seat.wasCaught },
    ];
  },

  botHeuristic(ctx, move) {
    // Keeping a drawn card costs the same as drawing one: both decline to
    // commit a card, and both are what a bot does when nothing better is on
    // offer. A persona's `patience` already reads them as one family
    // (HOLDING_MOVES, src/engine/bot.js), so a cautious bot hangs on to a
    // drawn wild for the same reason it hangs on to a held one.
    if (move.type === 'draw' || move.type === 'pass') return -1;
    const card = ctx.cardById(move.cards[0]);
    // Prefer dumping high-value / action cards first — simple, deliberately dumb.
    return 1 + (card.value ?? 0) * 0.01 + (effectOf(card) ? 0.5 : 0);
  },

  /**
   * HOW GOOD THIS POSITION IS FOR `seat` — the lookahead's scorer
   * (src/engine/bot.js), higher is better.
   *
   * The move scorer above is honest about being dumb, and the thing it cannot
   * say is the whole game: a wild is not "a card worth 50 points to dump", it
   * is the card that lets you play again next turn, and the colour you name
   * with it decides whether the rest of your hand is playable at all. A
   * position knows that; a move looked at on its own does not.
   *
   * SO: how close am I to empty, what my hand would cost me if somebody else
   * got there first, and how many ways out of it I still have — against how
   * close the nearest opponent is. The race is the game, so the opponent term
   * is the hand somebody is holding, which everyone at the table can count.
   *
   * IT DELIBERATELY DOES NOT READ anybody else's cards, nor the draw pile, nor
   * the discard pile below the face-up top. All of it is right there in the
   * state a bot is handed, and reading it here would be the "it always knew"
   * unfairness Phase 3's determinizer exists to make impossible for rollouts.
   * The exits below are counted against the ACTIVE value, which is a shared var
   * every seat can see.
   *
   * WHAT IT IS WORTH. Six hundred rounds with one seat on the evaluator and the
   * other three on `botHeuristic`, rotating which is which: Wildfire's evaluated
   * seat goes out 28.7% of the time against a 25% share, and drops to 26.7% if
   * the two exit terms are taken out. Crazy Eights is a wash at 25.2% — its
   * hands are short and its wilds few, so there is less position to read.
   */
  evaluateState(ctx, seat, w = WEIGHTS) {
    const scoring = ctx.pack.scoring || {};
    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));

    let score = -hand.length * w.CARD_IN_HAND;
    for (const id of hand) {
      const card = ctx.cardById(id);
      // A wild is an exit AND an exit that chooses the next active value, so it
      // counts twice; anything matching the active value is one way out.
      if (isWildCard(ctx, card)) score += w.EXIT_WORTH + w.WILD_WORTH;
      else if (cardMatchesActive(ctx, card)) score += w.EXIT_WORTH;
      // Left holding these when somebody goes out, they are what the round
      // costs (scoring.roundScore: hand-values-to-winner).
      score -= cardValue(card, scoring) * w.DEADWOOD_WORTH;
    }

    let rivalCards = Infinity;
    for (let s = 0; s < ctx.seats; s++) {
      if (s === seat) continue;
      rivalCards = Math.min(rivalCards, ctx.countIn(ctx.zoneAddr('hand', s)));
    }
    return Number.isFinite(rivalCards) ? score + rivalCards * w.RIVAL_SHARE : score;
  },

  /** The evaluator's numbers, for a caller that wants to play with different ones. */
  weights: WEIGHTS,
};

export default shedding;
