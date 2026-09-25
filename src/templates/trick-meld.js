// THE MELD, as one of the trick-taking template's optional phases (#224).
//
// A phase module: the core (src/templates/trick-taking.js) holds the phase list
// and composes these slices onto its hooks — see the PHASE MODULE comment there
// for what each member means.
//
// Everything below was lifted out of trick-taking.js unchanged.

import { detectDeclaredMelds, meldNames } from './melds.js';
import { trumpSuitOf } from './trick-shared.js';

/* ------------------------------------------------------------------ *
 * THE MELD — a phase that SCORES a selection and moves nothing
 * ------------------------------------------------------------------ *
 *
 * The third optional phase, and its shape is the pass's rather than the bid's:
 * every seat commits at once, nobody may read anybody else's choice until they
 * all have, and `turn.seat` does not move while it is open (`actingSeats`).
 *
 * WHAT MAKES IT A DIFFERENT PHASE FROM THE PASS, and the reason it is not one
 * with a flag on it: a pass MOVES the cards it commits, into somebody else's
 * hand, and it is exactly N of them. A meld moves nothing at all — the cards
 * you show the table are the cards you then have to win tricks with — and its
 * size is whatever the hand happens to hold, from nothing to the lot.
 *
 * WHAT IS PUBLISHED, AND WHAT IS NOT. `meld` is a per-seat var with no `__`
 * prefix, so every seat is told what every other seat melded and for how much;
 * that is what a player calls out at a table and the seats after them write
 * down. It carries NO CARD IDS (see `detectDeclaredMelds`) — the hand is still
 * `visibility: 'owner'` and stays that way, partner's included. The selection
 * on its way to being committed hides behind `__pendingMeld` for the same
 * reason the pass does: a commit anybody can read is not a commit.
 */
function pendingMeldOf(ctx, seat) {
  return ctx.playerVar(seat, '__pendingMeld');
}

function everySeatHasMelded(ctx) {
  for (let seat = 0; seat < ctx.seats; seat++) {
    if (pendingMeldOf(ctx, seat) === undefined) return false;
  }
  return true;
}

/**
 * The declaration this seat's hand is worth, whole — what a bot commits and
 * what the felt would suggest.
 *
 * Every card the detector could use, and no others: a declaration is scored
 * over what it contains, so there is nothing to gain from showing a card that
 * is in no meld and nothing to lose by showing every card that is in one.
 */
function bestMeldSelection(ctx, seat) {
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  return detectDeclaredMelds(ctx, hand, trumpSuitOf(ctx)).used;
}

/** Does this pack meld at all? The rule is a non-empty list of combinations. */
function melds(rules) {
  return Array.isArray(rules?.melds) && rules.melds.length > 0;
}

export const meldPhase = {
  id: 'meld',
  moveType: 'declareMeld',
  botVerbs: { declareMeld: 'melded' },
  // THE MELD IS THE PASS'S GESTURE, and reusing the mode rather than adding a
  // sixth is the whole reason `commitPrompt` exists: pick cards out of the
  // fan, watch them stage, commit with the action button. Everything that
  // differs — what the button says, what move it makes, how many cards arm it
  // — is answered here rather than by a new string that six downstream
  // surfaces would each have to learn (src/ui/interaction.js).
  interactionMode: 'pass',
  /** Nothing is led until every seat has declared (the core's validateMove). */
  playBlocked: 'The melds have not all been declared.',

  start(ctx) {
    if (!melds(ctx.rules)) return false;
    for (let seat = 0; seat < ctx.seats; seat++) ctx.setPlayerVar(seat, '__pendingMeld', undefined);
    ctx.setPhase('meld');
    return true;
  },

  validate(ctx, move) {
    if (!melds(ctx.rules)) return ctx.fail('no-melding', 'This game has no melding phase.');
    if (ctx.turn.phase !== 'meld') return ctx.fail('phase', 'Not in the melding phase.');
    if (pendingMeldOf(ctx, move.actor) !== undefined) {
      return ctx.fail('already-melded', 'You have already declared your meld.');
    }
    const cards = move.cards || [];
    if (new Set(cards).size !== cards.length) {
      return ctx.fail('duplicate-card', 'A card can only be declared once.');
    }
    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
    if (!cards.every((id) => hand.includes(id))) {
      return ctx.fail('not-in-hand', 'That card is not in your hand.');
    }
    // ANY SELECTION IS A LEGAL DECLARATION, including none of it. Showing a
    // card that is in no meld is worth nothing and costs nothing, and
    // under-declaring is a player's own business — there is no rule at a
    // table that makes you claim everything you hold.
    return ctx.ok();
  },

  apply(ctx, move, advance) {
    ctx.setPlayerVar(move.actor, '__pendingMeld', (move.cards || []).slice());
    if (!everySeatHasMelded(ctx)) return;

    const trump = trumpSuitOf(ctx);
    for (let seat = 0; seat < ctx.seats; seat++) {
      const declared = detectDeclaredMelds(ctx, pendingMeldOf(ctx, seat), trump);
      ctx.setPlayerVar(seat, '__pendingMeld', undefined);
      ctx.setPlayerVar(seat, 'meld', { points: declared.points, melds: declared.melds });
      ctx.emit('meldDeclared', { seat, points: declared.points, melds: declared.melds });
    }
    advance();
  },

  // ONE CANDIDATE, AND IT IS THE WHOLE ANSWER. Unlike a pass, a declaration
  // has no trade-off in it: every meld the hand holds is worth its points and
  // showing one costs nothing, so "declare everything that counts" is not a
  // shortlist of a space — it is the space, with the dominated members left
  // out. A human is not restricted to it; the felt builds the move from
  // whatever was staged (src/ui/interaction.js).
  enumerate(ctx, seat) {
    if (pendingMeldOf(ctx, seat) !== undefined) return [];
    return [{ actor: seat, type: 'declareMeld', cards: bestMeldSelection(ctx, seat) }];
  },

  actingSeats(ctx) {
    const seats = [];
    for (let s = 0; s < ctx.seats; s++) if (pendingMeldOf(ctx, s) === undefined) seats.push(s);
    return seats;
  },

  /**
   * THE MELD (#106): a declaration is committed at ANY size, nothing at all
   * included — a hand with no meld in it still has to say so before the table
   * can move on — and it moves no card anywhere. So it is a `min`/`max` rather
   * than a `count`, and it NAMES its move, because a commit of zero cards has
   * no card-carrying move for the platform to read the type off.
   */
  commitPrompt(ctx, seat) {
    return {
      action: 'Declare',
      moveType: 'declareMeld',
      min: 0,
      max: ctx.countIn(ctx.zoneAddr('hand', seat)),
      staging: 'Declare your meld',
      waiting: 'Waiting for melds…',
    };
  },

  committed(ctx, seat) {
    return pendingMeldOf(ctx, seat);
  },

  // WHAT THIS SEAT DECLARED, ON EVERY SEAT'S FELT. A meld is called out at a
  // table and written down by everybody, and the cards it was made of stay in
  // a hand nobody else may look at — so the number and the names are the
  // whole of what there is to show, and they are shown for every seat rather
  // than only for the one looking.
  counters(ctx, seat) {
    if (!melds(ctx.rules)) return [];
    const meld = ctx.playerVar(seat, 'meld');
    const named = meldNames(meld?.melds).join(', ');
    return [{
      text: meld ? String(meld.points) : '—',
      aria: !meld ? 'has not declared a meld yet'
        : named ? `melded ${meld.points}: ${named}` : 'declared no meld',
      label: 'Meld',
      kind: 'meld',
    }];
  },

  /**
   * THE MELD CHIP IS THE VIEWER'S OWN, and it is here because there is nowhere
   * else for it. Every other seat's meld is on that seat's plate
   * (`counters` above); the seat doing the looking has no plate, so its own
   * declaration — the number the whole phase exists to produce — was the one
   * that never appeared anywhere.
   */
  chips(ctx, seat) {
    const meld = Number.isInteger(seat) ? ctx.playerVar(seat, 'meld') : null;
    if (!meld) return [];
    return [{
      key: 'meld',
      label: 'Your meld',
      // A DECLARATION OF NOTHING IS STILL A DECLARATION, and it has to read
      // as one: "0" beside "Your meld" is the same shape as a real score and
      // says the phase produced a number. "None" says the hand held nothing.
      value: meld.points > 0 ? String(meld.points) : 'None',
      aria: meld.points > 0 ? `Your meld: ${meld.points}` : 'You declared no meld',
    }];
  },

  /**
   * THE MELD SENTENCE IS THE VIEWER'S OWN. Everybody else's is a number on
   * their plate the moment it lands (`counters`), and four banners in a row
   * would be four seats' worth of arithmetic thrown at a player who wanted one.
   * `viewerSeat` is what makes that possible without the template knowing who
   * is looking — and returning null for the other three seats is also what
   * makes the platform's "first event that yields a sentence" loop
   * (src/ui/celebrations.js) land on the right one, whatever order the four
   * declarations were emitted in.
   */
  describe(ev, { viewerSeat } = {}) {
    if (ev.type !== 'meldDeclared') return null;
    if (ev.seat !== viewerSeat) return null;
    if (!ev.points) return { text: 'Nothing to declare — no meld in your hand.', tone: 'neutral' };
    const named = meldNames(ev.melds).join(', ');
    return { text: `You meld ${ev.points}: ${named}.`, tone: 'good' };
  },

  /**
   * A DECLARATION IS WORTH EXACTLY WHAT IT SCORES. No lookahead, no
   * trade-off: the cards do not move, so the position after it is the
   * position before it with a number added.
   */
  score(ctx, move) {
    return detectDeclaredMelds(ctx, move.cards || [], trumpSuitOf(ctx)).points;
  },

  ruleLines(rules) {
    if (!melds(rules)) return [];
    return ['Then everybody declares their meld — the scoring combinations they were dealt. '
      + 'The points go on the sheet and the cards stay in your hand, so what you have just shown the '
      + 'table is what you still have to win tricks with.'];
  },
};
