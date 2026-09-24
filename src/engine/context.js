// Builds the `ctx` object every template's validateMove/applyMove/enumerateLegalMoves/
// scoreRound function receives. Read helpers are plain functions; mutation helpers
// (moveCards, setVar, advanceTurn, ...) are the only way templates touch state, so all
// state changes funnel through one place.
//
// AND THAT IS NOW A RULE RATHER THAN AN INTENTION. `tests/repo-gates.test.js`
// refuses a `ctx.state.` reach-in or a `src/engine/state.js` import anywhere in
// src/templates/, so a template that needs something this file does not offer
// has to come here and add it. Every reader and writer below that looks
// oddly specific — `roundEnded()`, `roundNumber()`, `placeDeck`,
// `resetPlayerVars` — is a reach-in that used to go around this object, and
// src/engine/fork.js's copy list is only sound while none do.

import { baseId } from './selectors.js';
import { isWild } from './cards.js';
import { moveCards as moveCardsInState, emitEvent, zoneAddress } from './state.js';

/**
 * A zone address, spelled the one way the state container spells it.
 *
 * `n` is the numbered form (`build.3`, and with a seat `discard.3.0`), which
 * sequencing built with template literals in nine places because this helper
 * only took a seat. It is the same `zoneAddress` ZoneSet.define uses to NAME
 * its instances, so an address built here cannot drift from an address that
 * exists.
 */
export function zoneAddr(id, seat, n) {
  return zoneAddress(id, { n, seat });
}

/**
 * Who may act right now. Usually just `turn.seat`; a simultaneous-commit phase
 * (Hearts' passing) is every seat that has not committed yet, and the template
 * says so through the optional `actingSeats` hook (CONTRACT.md §hooks).
 *
 * A FINISHED MATCH ACTS ON NOBODY. That guard used to be written in some copies
 * of this line and not others — notably the party turn timer's, which could
 * therefore re-arm a deadline against `turn.seat` after the match was over.
 * It is the rule, so it lives here and everyone inherits it.
 *
 * Pure over `state` and the template, which is why this is an engine export and
 * not a felt helper: the felt, the party host, the headless bot driver, the
 * rollout and tools/simulate.mjs all need the same answer.
 */
export function actingSeats(state) {
  if (state.gameOver) return [];
  const template = state.pack.template;
  return template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
}

/**
 * What a seat may SAY right now, out of turn (§E2) — never enumerated as a play.
 *
 * Absent the hook the answer is "nothing", and a hook that returns nothing at
 * all is normalised to `[]` so callers can iterate without a guard.
 *
 * Callers holding a CLIENT VIEW must not ask this: a view has other people's
 * hands missing, so the host ships the acting seat's announcements with the
 * frame (design decision D3) and the felt reads `state.announcements` instead.
 */
export function announcementsFor(state, seat) {
  const template = state.pack.template;
  if (!template.enumerateAnnouncements) return [];
  return template.enumerateAnnouncements(makeCtx(state), seat) || [];
}

export function makeCtx(state) {
  const pack = state.pack;
  return {
    state,
    pack,
    rules: pack.rules,
    seats: state.seats,
    turn: state.turn,
    direction: state.direction,
    rng: state.rng,

    zoneAddr,
    zone: (address) => state.zones.get(address),
    hasZone: (address) => state.zones.has(address),
    cardIdsIn: (address) => state.zones.cards(address),
    cardsIn: (address) => state.zones.cards(address).map((id) => pack.cardsById.get(baseId(id))),
    topOf: (address) => state.zones.top(address),
    countIn: (address) => state.zones.count(address),
    cardById: (id) => pack.cardsById.get(baseId(id)),
    locationOf: (cardId) => state.cardLocation.get(cardId),

    /**
     * A card that stands in for another. The pack's own answer — a declared
     * `wilds.tag`, or the card's effect — and not the template's guess at it.
     *
     * This predicate was written out verbatim as a module-level `isWildCard`
     * in melds.js, shedding.js and sequencing.js. Three copies of one line is
     * three chances for a pack's wilds to mean something different depending
     * on which template is asking.
     */
    isWild: (card) => isWild(card, pack.rules?.wilds),

    var: (name) => state.vars[name],
    setVar: (name, value) => {
      state.vars[name] = value;
    },
    playerVar: (seat, name) => state.playerVars[seat]?.[name],
    setPlayerVar: (seat, name, value) => {
      state.playerVars[seat][name] = value;
    },

    /**
     * Wipe every seat's vars for a new hand, carrying only the named ones.
     *
     * The round boundary's default is a total wipe (movePipeline's
     * maybeFinishRound), which is right for a bid and wrong for anything that
     * outlives a hand by definition. The two templates that have such a thing
     * — trick-taking's `bags`, cribbage's `backPeg` — each read the array out,
     * replaced it by hand and wrote the survivors back, in the same four
     * lines. A name with no value on a seat stays absent rather than becoming
     * `undefined`, so a carried-over sheet is the same shape a fresh one is.
     */
    resetPlayerVars: ({ keep = [] } = {}) => {
      state.playerVars = state.playerVars.map((own) => {
        const carried = {};
        for (const name of keep) {
          if (own?.[name] !== undefined) carried[name] = own[name];
        }
        return carried;
      });
    },

    score: (seat) => state.scores[seat],
    addScore: (seat, amount) => {
      state.scores[seat] += amount;
    },

    moveCards: (cardIds, from, to, opts) => moveCardsInState(state, cardIds, from, to, opts),

    /**
     * Move `n` cards off the top of `from` into `to`, stopping early when the
     * source runs dry. Returns how many actually moved, which is not always
     * what was asked for — an exhausted pile that could not be recycled hands
     * over fewer, and the table should say what really happened.
     *
     * This loop existed five times over: shedding's drawCards and its deal,
     * contract-rummy's deal, and sequencing's stock deal and hand top-up.
     */
    deal: (to, n, { from = 'draw' } = {}) => {
      let dealt = 0;
      for (let i = 0; i < n; i++) {
        const top = state.zones.top(from);
        if (top === undefined) break;
        moveCardsInState(state, [top], from, to);
        dealt++;
      }
      return dealt;
    },

    /**
     * Cards straight into a zone, with their locations stamped — THE DEAL, and
     * the one sanctioned way to put a card somewhere it did not come from.
     *
     * Called with no `ids` it shuffles the pack's whole deck in, which is what
     * `state.js initializeDeckInto` was for and what cribbage's setup had
     * copied out line for line. Called with ids it is the raw
     * `zone(addr).cards.push(id); cardLocation.set(id, addr)` pair that
     * climbing's two deals and trick-taking's wrote by hand.
     *
     * NO REACTIONS FIRE, deliberately and unlike `moveCards`: a deal is cards
     * arriving from outside the table, and a zone that is briefly empty
     * mid-deal is not a pile that has run out.
     */
    placeDeck: (address, ids = state.rng.shuffle([...pack.cardsById.keys()])) => {
      const zone = state.zones.get(address);
      for (const id of ids) {
        zone.cards.push(id);
        state.cardLocation.set(id, address);
      }
    },

    /** `n` cards to every seat's `to` zone, seat 0 first — the opening deal. */
    dealEach: (n, { to = 'hand', from = 'draw' } = {}) => {
      for (let seat = 0; seat < state.seats; seat++) {
        for (let i = 0; i < n; i++) {
          const top = state.zones.top(from);
          if (top === undefined) return;
          moveCardsInState(state, [top], from, zoneAddr(to, seat));
        }
      }
    },

    /**
     * Who this round opens on. The deal rotates a seat per round, as it would
     * at a table — without it a new round opens on whoever just won, because
     * the winning play returns before advancing the turn.
     *
     * `(roundNumber - 1) % seats` was written out in shedding and
     * contract-rummy and simply missing from trick-taking, whose dealer was
     * permanently seat 0 in contradiction of the design doc's `dealer: rotate`.
     */
    openingSeat: () => (state.roundNumber - 1) % state.seats,

    /** Which hand this is, counting from 1 — what a passing schedule rotates on. */
    roundNumber: () => state.roundNumber,

    nextSeat: (from = state.turn.seat, dir = state.direction) => (((from + dir) % state.seats) + state.seats) % state.seats,
    setTurnSeat: (seat) => {
      state.turn.seat = seat;
    },
    setPhase: (phase) => {
      state.turn.phase = phase;
    },
    setDirection: (d) => {
      state.direction = d;
    },
    reverseDirection: () => {
      state.direction *= -1;
    },

    /**
     * THIS HAND IS FINISHED, and `winner` is whoever finished it.
     *
     * Whether the MATCH is over is not this template's call: it is the pack's
     * scoring.gameOver ("anyScore >= 100"), or template.isGameOver where the
     * pack says the template decides. The pipeline consumes this flag in
     * maybeFinishRound, scores the round, and then either ends the match or
     * deals the next one.
     *
     * Templates used to say this with setGameOver() and read it back out of
     * state.gameOver in their own isRoundOver — a wart the pipeline documented
     * and worked around by resetting the flag. A round ending is not a match
     * ending, and now it does not have to pretend to be.
     */
    endRound: (winner = null) => {
      state.roundEnded = true;
      state.roundWinner = winner;
    },

    /**
     * Has this hand finished? The answer `isRoundOver` gives back, and the
     * guard every step that can be reached AFTER a hand ends has to ask —
     * cribbage's peg, its play-out and its show all check it, because a game
     * decided mid-count must stop counting.
     */
    roundEnded: () => state.roundEnded,

    /** The MATCH is over. Distinct from endRound above, deliberately. */
    setGameOver: (winner) => {
      state.gameOver = true;
      state.winner = winner;
    },

    /** Is the MATCH over? Again distinct from `roundEnded` above. */
    gameOver: () => state.gameOver,

    // Derived events for the UI (state.events) — a trick resolving, a lay-down
    // landing. Never part of the persisted log; see state.js.
    emit: (type, payload = {}) => emitEvent(state, type, payload),

    fail: (rule, reason) => ({ legal: false, rule, reason }),
    ok: () => ({ legal: true }),
  };
}
