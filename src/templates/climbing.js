// Climbing template (THIRTEEN_RULES.md §3). Validates against Thirteen (Tiến lên).
//
// The genre: play a SET of cards that beats the previous set of the same shape
// and size, or pass — and a pass is final for the trick. Big Two, President and
// Zheng Shangyou are the same engine with a different combination table and a
// different ladder, which is why every one of those tables is a declaration in
// the pack rather than a constant here.
//
// The four things it needed that no other template had, and where each landed:
//
//   a TOTAL card order      `cardOrder` (src/engine/cards.js, #101). Never
//                           `rankOrder`: pairs compare by their highest card
//                           INCLUDING suit, so 9♥9♦ beats 9♣9♠ (D-5), and a tie
//                           would be a position with no legal answer and no
//                           legal refusal.
//   combination comparison  `classify` + `beatsInShape` + `chops` below, driven
//                           by `rules.combinations` / `rules.matchShape` /
//                           `rules.bombs`.
//   a variable-count commit `interactionMode` → 'combination'
//                           (src/ui/interaction.js).
//   a trick seats drop out  `passIsFinal`, the `passed` var, and `actingSeats`.
//
// What this file does NOT decide, on purpose: which combinations exist, which
// of them may be played out of shape and over what, whether a pass is final,
// which card must open the first hand, and which way the turn goes. All six are
// keys in the manifest, and every one of them is read below.

import { cardOrder, rankIndexOf, rankLadderOf } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { groupByRank, rankWindow } from './melds.js';

/* ------------------------------------------------------------------ *
 * What a greedy bot thinks a move is worth (see `botHeuristic`)
 * ------------------------------------------------------------------ *
 *
 * #102 owes a bot that plays LEGALLY and reaches `isRoundOver` under greedy
 * play, so the rollout layer has something to grade; playing WELL — shape
 * preservation, `evaluateState` — is #103, and these numbers are the seam it
 * takes over through (src/templates/CONTRACT.md, `weights`).
 *
 * Cards out of hand is the race, so it is the unit. Everything else is priced
 * against it: a combination's top card is what you are spending, a bomb spent
 * out of shape is a card you cannot chop with later, and passing sheds nothing
 * at all.
 */
const SHED_WORTH = 10;

/** Per ladder step of the combination's top card — play low, keep the pigs. */
const TOP_COST = 0.35;

/** Spending a bomb out of shape on something a plain answer would have beaten. */
const CHOP_COST = 25;

/** A pass sheds nothing, so it sits below every play that sheds one card. */
const PASS_WORTH = -1;

export const WEIGHTS = Object.freeze({ SHED_WORTH, TOP_COST, CHOP_COST, PASS_WORTH });

/* ------------------------------------------------------------------ *
 * The declared combination vocabulary
 * ------------------------------------------------------------------ */

/**
 * `"single"`, `"quad"`, `"run(3+)"`, `"consecutive-pairs(3+)"` — a kind, and
 * optionally a size which may be an exact number or a floor.
 */
function parseShape(entry) {
  const m = /^([a-z][a-z-]*)(?:\((\d+)\+?\))?$/.exec(String(entry ?? ''));
  if (!m) return null;
  return { kind: m[1], size: m[2] === undefined ? null : Number(m[2]) };
}

/**
 * How many cards each fixed-size shape is made of. A pair is two of a rank
 * whatever the pack calls the game; a run's and a strip's sizes come from the
 * declaration, because those are the ones that vary.
 */
const FIXED_SIZE = Object.freeze({ single: 1, pair: 2, triple: 3, quad: 4 });

const VOCABULARIES = new WeakMap();

/**
 * The pack's `rules.combinations`, resolved to `kind -> { min }`.
 *
 * Memoised on the PACK: the declaration is fixed once loaded, and this is asked
 * once per classification, which is once per enumerated move.
 *
 * A shape the pack does not declare is NOT A PLAY. That is the whole reason the
 * vocabulary is a manifest key rather than a constant — a Big Two pack that
 * drops the triple, or a President pack that adds a quintuple, changes this
 * list and nothing else.
 */
function vocabularyOf(ctx) {
  let vocab = VOCABULARIES.get(ctx.pack);
  if (vocab) return vocab;
  vocab = new Map();
  for (const entry of ctx.rules.combinations || []) {
    const shape = parseShape(entry);
    if (!shape) continue;
    vocab.set(shape.kind, { min: FIXED_SIZE[shape.kind] ?? shape.size ?? 1 });
  }
  VOCABULARIES.set(ctx.pack, vocab);
  return vocab;
}

/**
 * A card no sequence may contain — Thirteen's 2, which sits at the TOP of the
 * ladder and so has no neighbour above it and no business inside a run
 * (`rules.runExcludes: ["rank:2"]`). Applies to consecutive pairs too: `A-A
 * K-K Q-Q` is a bomb and `2-2 A-A K-K` is not a combination at all.
 */
function outOfSequence(ctx, card) {
  const excludes = ctx.rules.runExcludes;
  if (!excludes?.length) return false;
  return excludes.some((selector) => selectorMatches(card, selector));
}

/**
 * WHAT THIS PILE OF CARDS IS, or null for a pile that is not a play.
 *
 * `size` is the shape's own unit, which is what `matchShape` compares and what
 * a `bombs` entry names: cards for a run, PAIRS for a strip of consecutive
 * pairs, and the fixed count for everything else. The kind disambiguates it, so
 * `consecutive-pairs(3)` is unambiguously three pairs and never three cards.
 *
 * `top` is the position of the highest card on the pack's TOTAL order — rank
 * first, suit as the tiebreak (#101's `cardOrder`). Every comparison in the
 * game is against this one number, including for a four of a kind, where
 * comparing top cards and comparing ranks are the same answer.
 */
function classify(ctx, cardIds) {
  if (!Array.isArray(cardIds) || !cardIds.length) return null;
  if (new Set(cardIds).size !== cardIds.length) return null;
  const cards = cardIds.map((id) => ctx.cardById(id));
  if (cards.some((card) => !card)) return null;

  const vocab = vocabularyOf(ctx);
  const ladder = rankLadderOf(ctx.pack);
  const top = Math.max(...cards.map((card) => cardOrder(card, ladder)));
  const byRank = groupByRank(cards);
  const n = cards.length;

  // One rank: a single, a pair, a triple or a four of a kind.
  if (byRank.size === 1) {
    const kind = Object.keys(FIXED_SIZE).find((k) => FIXED_SIZE[k] === n);
    if (!kind || !vocab.has(kind)) return null;
    return { kind, size: n, top, cards: cardIds.slice() };
  }

  if (cards.some((card) => outOfSequence(ctx, card))) return null;
  const indices = [...byRank.keys()].map((rank) => rankIndexOf(ladder, rank));
  if (indices.some((i) => i < 0)) return null;
  const window = rankWindow(indices);
  if (!window.ok) return null;

  // Distinct consecutive ranks, one card each: a run.
  if (byRank.size === n) {
    const run = vocab.get('run');
    if (run && n >= run.min) return { kind: 'run', size: n, top, cards: cardIds.slice() };
    return null;
  }

  // Distinct consecutive ranks, exactly two cards each: consecutive pairs.
  if (byRank.size * 2 === n && [...byRank.values()].every((group) => group.length === 2)) {
    const strip = vocab.get('consecutive-pairs');
    const pairs = byRank.size;
    if (strip && pairs >= strip.min) {
      return { kind: 'consecutive-pairs', size: pairs, top, cards: cardIds.slice() };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Beating what is on the table
 * ------------------------------------------------------------------ */

/**
 * IN SHAPE: the same kind, the same size, strictly higher.
 *
 * `rules.matchShape` is what says so. `same-type-same-size` is the only answer
 * the template knows, and a pack that names another gets no in-shape answer at
 * all rather than a silent fallback to this one — a rule nobody implements
 * should refuse moves, not accept them (D-7 is exactly this: a five-card run is
 * not a legal answer to a four-card run, it is simply not an answer).
 */
function beatsInShape(ctx, played, current) {
  if (ctx.rules.matchShape !== 'same-type-same-size') return false;
  if (played.kind !== current.kind || played.size !== current.size) return false;
  return played.top > current.top;
}

/**
 * Does this `bombs` token describe `combo`?
 *
 * A token is a shape (`quad`, `consecutive-pairs(3)`), optionally narrowed by a
 * card selector after a colon (`single:rank:2` — a single 2, which is the card
 * the whole mechanic exists to kill), or the bare `*` for a bomb that chops
 * anything. The selector must match EVERY card, so `pair:rank:2` is a pair of
 * pigs and not a pig with a friend.
 */
function tokenMatches(ctx, token, combo) {
  if (token === '*') return true;
  const at = String(token).indexOf(':');
  const shape = parseShape(at === -1 ? token : String(token).slice(0, at));
  if (!shape || shape.kind !== combo.kind) return false;
  if (shape.size !== null && shape.size !== combo.size) return false;
  if (at === -1) return true;
  const selector = String(token).slice(at + 1);
  return combo.cards.every((id) => selectorMatches(ctx.cardById(id), selector));
}

/**
 * OUT OF SHAPE: `played` is a declared bomb and `current` is on its list.
 *
 * The chopping ladder is the DECLARATION ORDER of `rules.bombs`, and it is a
 * ladder rather than a flag because a chop can itself be chopped: chopping a
 * pig with a four of a kind does not end the trick, and the next seat may chop
 * the chop with four consecutive pairs or with a higher four of a kind (that
 * second one is the in-shape path above, which is why nothing here special-
 * cases it).
 *
 * A bomb LED is an ordinary combination of its own shape and is answered in
 * shape — there is no `current` for this function to be asked about, so that
 * rule needs no code, only the absence of any.
 */
function chops(ctx, played, current) {
  for (const bomb of ctx.rules.bombs || []) {
    if (!tokenMatches(ctx, bomb.shape, played)) continue;
    if ((bomb.beats || []).some((token) => tokenMatches(ctx, token, current))) return true;
  }
  return false;
}

/** Everything this seat could put on the table right now, in one predicate. */
function answers(ctx, played, current) {
  if (!current) return true;
  return beatsInShape(ctx, played, current) || chops(ctx, played, current);
}

/* ------------------------------------------------------------------ *
 * The trick, and who is still in it
 * ------------------------------------------------------------------ */

function passedSeats(ctx) {
  const passed = ctx.var('passed');
  return Array.isArray(passed) ? passed : [];
}

/**
 * May this seat act at all?
 *
 * `rules.passIsFinal` is the rule (D-12): once you have passed you are out of
 * the trick and may not re-enter, even when the play comes back around below
 * you. A pack that declares it false gets the weaker rule — a passed seat is
 * asked again next time round — for free.
 */
function stillIn(ctx, seat) {
  if (ctx.countIn(ctx.zoneAddr('hand', seat)) === 0) return false;
  if (ctx.rules.passIsFinal === false) return true;
  return !passedSeats(ctx).includes(seat);
}

/**
 * The card this seat's lead must contain, or null.
 *
 * ASKED OF THE SEAT, NOT OF THE TABLE, for two reasons that arrived in that
 * order. The first is the same one trick-taking's first lead has (`if
 * (hand.includes(required))`): the requirement belongs to whoever is holding
 * the card, and a seat that is not holding it has an ordinary free lead —
 * written as a fact about the hand rather than as "the leader IS the holder, so
 * this cannot come up", because anything that puts another seat on the turn
 * before that lead is spent would otherwise find a seat with no legal move at
 * all and a stalled table.
 *
 * The second is a LEAK, and the per-seat leak sweep (tests/view.test.js) caught
 * it: this was a shared var holding `spades-3`, which is a CARD ID SITTING IN
 * SOMEBODY'S HAND — the exact shape of `drawnCardId`, the case the shared-var
 * allowlist exists for. That the information is harmless here (the holder is on
 * the turn, so the table can infer it anyway) is not the point; publishing a
 * hand's card id because it happens to be deducible is how the next one gets
 * published because nobody re-checked. So it is a `__` playerVar, which reaches
 * only its owner (src/engine/view.js) — and its owner is the one seat that
 * needs it, including when that seat is a joiner holding nothing but a view.
 */
function requiredCardFor(ctx, seat) {
  const required = ctx.playerVar(seat, '__mustInclude');
  if (!required) return null;
  return ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).includes(required) ? required : null;
}

function seatHolding(ctx, cardId) {
  for (let seat = 0; seat < ctx.seats; seat++) {
    if (ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).includes(cardId)) return seat;
  }
  return null;
}

/**
 * The trick is over: the last seat to have played takes it, the table is swept,
 * and they lead the next one free to lead anything (`rules.laterLead`).
 */
function clearTrick(ctx, winner) {
  const cards = ctx.cardIdsIn('pile').slice();
  if (cards.length) ctx.moveCards(cards, 'pile', 'discard');
  const trickNumber = ctx.var('trickNumber') ?? 1;
  ctx.emit('trickCleared', { seat: winner, cards, trickNumber });
  ctx.setVar('combo', null);
  ctx.setVar('passed', []);
  ctx.setVar('leader', winner);
  ctx.setVar('lastPlayer', null);
  ctx.setVar('trickNumber', trickNumber + 1);
  ctx.setTurnSeat(winner);
}

/**
 * Whose turn it is after `from` has played or passed.
 *
 * Walks the ring in `state.direction` — counter-clockwise for Thirteen (D-1) —
 * skipping every seat that has passed or has no cards. Reaching the seat that
 * played the standing combination without finding anybody still in means
 * everybody else has passed, which is what ends the trick.
 */
function advance(ctx, from) {
  const winner = ctx.var('lastPlayer');
  if (winner === null || winner === undefined) return;
  let seat = from;
  for (let i = 0; i < ctx.seats; i++) {
    seat = ctx.nextSeat(seat);
    if (seat === winner) break;
    if (stillIn(ctx, seat)) {
      ctx.setTurnSeat(seat);
      return;
    }
  }
  clearTrick(ctx, winner);
}

/* ------------------------------------------------------------------ *
 * Dealing a hand
 * ------------------------------------------------------------------ */

/**
 * `rules.deal` cards each, seat by seat from whoever this round opens on, and
 * whatever is left over is OUT OF PLAY (D-11: three players see 39 of the 52,
 * which is genuinely how it is played short-handed).
 *
 * Writing the zone arrays directly rather than going through ctx.moveCards is
 * sanctioned for the initial deal only — src/templates/CONTRACT.md — because
 * there is nothing for a zoneEmpty reaction to respond to while the deck is
 * being handed out.
 */
function dealHands(ctx) {
  const per = ctx.rules.deal;
  const ids = ctx.rng.shuffle([...ctx.pack.cardsById.keys()]);
  let at = 0;
  for (let i = 0; i < per; i++) {
    for (let n = 0; n < ctx.seats; n++) {
      if (at >= ids.length) return;
      const id = ids[at++];
      const addr = ctx.zoneAddr('hand', ctx.nextSeat(ctx.openingSeat(), n));
      ctx.zone(addr).cards.push(id);
      ctx.state.cardLocation.set(id, addr);
    }
  }
}

/**
 * A fresh hand, dealt, with the trick state cleared and a leader on the turn.
 *
 * @param opening `null` to apply `rules.firstLead` (hand one, D-2), or the seat
 *                that leads because `rules.laterLead` said so (D-3).
 */
function beginHand(ctx, opening) {
  ctx.setDirection(ctx.rules.direction === 'counterclockwise' ? -1 : 1);
  dealHands(ctx);
  ctx.setVar('combo', null);
  ctx.setVar('passed', []);
  ctx.setVar('lastPlayer', null);
  ctx.setVar('trickNumber', 1);
  for (let seat = 0; seat < ctx.seats; seat++) ctx.setPlayerVar(seat, '__mustInclude', null);

  let leader = opening;
  if (leader === null || leader === undefined) {
    const firstLead = ctx.rules.firstLead;
    const holder = firstLead?.card ? seatHolding(ctx, firstLead.card) : null;
    if (holder !== null) {
      leader = holder;
      // THE OPENING LEAD MUST CONTAIN IT, held as a var rather than
      // re-derived, because it is true exactly once per match and stops being
      // true the moment that lead is played.
      if (firstLead.mustInclude) ctx.setPlayerVar(leader, '__mustInclude', firstLead.card);
    } else {
      leader = ctx.openingSeat();
    }
  }
  ctx.setVar('leader', leader);
  ctx.setTurnSeat(leader);
  ctx.setPhase('play');
}

/* ------------------------------------------------------------------ *
 * Enumerating the legal moves without enumerating the subsets
 * ------------------------------------------------------------------ *
 *
 * THE BUDGET. A thirteen-card hand has 8,191 non-empty subsets and almost none
 * of them are a play, so the space that gets walked is the space of legal
 * COMBINATIONS, which is bounded by the hand's SHAPE rather than by its size:
 *
 *   singles              one per card                                  ≤ 13
 *   pairs / triples      C(k,2) and C(k,3) per rank, k ≤ 4             ≤ 18 / 12
 *   quads                one per rank holding four                     ≤ 3
 *   runs                 one per (start, length) window whose every
 *                        rank the hand holds, × each card of the TOP
 *                        rank (see below)                              ≤ 66 × 4
 *   consecutive pairs    one per window of ranks the hand holds two
 *                        of, × each pair of the top rank               ≤ 15 × 6
 *
 * Measured rather than reasoned: over three hundred four-seat Thirteen hands
 * the worst LEADING seat enumerated 31 moves against a mean of 6.5, and the
 * worst ANSWERING seat 14 against a mean of 3.6 — an answering seat is far
 * smaller because the led kind and size fix the shape and only the strictly
 * higher ones survive. The worst SHAPE, which no random deal produces, is a
 * hand of few ranks in every suit: three ranks × four suits enumerates 55 here
 * and 325 walking the subsets, which is the separation tests/climbing.test.js
 * pins the budget against.
 *
 * WHAT IT DELIBERATELY OMITS, and why that is not a contract breach: within a
 * run or a strip, every rank below the top can be filled by any of the cards
 * the hand holds of that rank, and those variants are the SAME PLAY — they beat
 * exactly the same combinations, because a run is compared by its top card
 * alone. Enumerating them would multiply the list by 4^L to offer the bot the
 * same move over and over. So the lowest card of each rank is taken, which is
 * also the one a player wants to spend, and the TOP rank — the only position
 * where the choice changes what the combination beats — is enumerated in full.
 *
 * This is the same discipline, and the same kind of shortlist, as
 * trick-taking's pass (src/templates/trick-taking.js:153): everything offered
 * is legal, and a human is not restricted to the list — the felt builds the
 * move from whatever cards were tapped and `validateMove` judges it on its own
 * terms (src/ui/interaction.js, mode 'combination').
 */

function combinationsFrom(cards, k) {
  if (k > cards.length) return [];
  const out = [];
  const pick = (start, chosen) => {
    if (chosen.length === k) { out.push(chosen.slice()); return; }
    for (let i = start; i < cards.length; i++) {
      chosen.push(cards[i]);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Every combination the seat could form, as card-id lists. Shape-bounded. */
function candidateSets(ctx, seat, { kind = null, size = null } = {}) {
  const ladder = rankLadderOf(ctx.pack);
  const vocab = vocabularyOf(ctx);
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat))
    .map((id) => ({ id, card: ctx.cardById(id) }))
    .filter((entry) => entry.card)
    .sort((a, b) => cardOrder(a.card, ladder) - cardOrder(b.card, ladder));

  const byRank = new Map();
  for (const entry of hand) {
    const at = rankIndexOf(ladder, entry.card.rank);
    if (at < 0) continue;
    if (!byRank.has(at)) byRank.set(at, []);
    byRank.get(at).push(entry);
  }
  const positions = [...byRank.keys()].sort((a, b) => a - b);
  const wants = (k, n) => (kind === null || kind === k) && (size === null || size === n);
  const out = [];

  // Same-rank shapes.
  for (const at of positions) {
    const group = byRank.get(at);
    for (const [k, n] of Object.entries(FIXED_SIZE)) {
      if (!vocab.has(k) || group.length < n || !wants(k, n)) continue;
      for (const chosen of combinationsFrom(group, n)) out.push(chosen.map((e) => e.id));
    }
  }

  const sequential = (at) => byRank.get(at).filter((e) => !outOfSequence(ctx, e.card));

  // Runs: windows of consecutive ladder positions the hand can fill.
  const run = vocab.get('run');
  if (run && (kind === null || kind === 'run')) {
    for (let i = 0; i < positions.length; i++) {
      const cardsSoFar = [];
      for (let j = i; j < positions.length; j++) {
        if (j > i && positions[j] !== positions[j - 1] + 1) break;
        const here = sequential(positions[j]);
        if (!here.length) break;
        const length = j - i + 1;
        if (length >= run.min && wants('run', length)) {
          // Only the TOP rank's choice changes what the run beats.
          for (const topCard of here) out.push([...cardsSoFar.map((e) => e.id), topCard.id]);
        }
        cardsSoFar.push(here[0]);
      }
    }
  }

  // Consecutive pairs: the same windows, over ranks the hand holds two of.
  const strip = vocab.get('consecutive-pairs');
  if (strip && (kind === null || kind === 'consecutive-pairs')) {
    for (let i = 0; i < positions.length; i++) {
      const cardsSoFar = [];
      for (let j = i; j < positions.length; j++) {
        if (j > i && positions[j] !== positions[j - 1] + 1) break;
        const here = sequential(positions[j]);
        if (here.length < 2) break;
        const pairs = j - i + 1;
        if (pairs >= strip.min && wants('consecutive-pairs', pairs)) {
          for (const topPair of combinationsFrom(here, 2)) {
            out.push([...cardsSoFar.map((e) => e.id), ...topPair.map((e) => e.id)]);
          }
        }
        cardsSoFar.push(here[0], here[1]);
      }
    }
  }
  return out;
}

/** Every shape a declared bomb can take, for a seat looking to chop. */
function bombShapes(ctx) {
  const shapes = [];
  for (const bomb of ctx.rules.bombs || []) {
    const shape = parseShape(bomb.shape);
    if (shape) shapes.push({ kind: shape.kind, size: shape.size ?? FIXED_SIZE[shape.kind] ?? null });
  }
  return shapes;
}

/* ------------------------------------------------------------------ *
 * The template
 * ------------------------------------------------------------------ */

const climbing = {
  id: 'climbing',

  /**
   * What a peer may see of the shared vars (src/engine/view.js — the allowlist
   * is fail-closed, so anything not named here reaches nobody).
   *
   * Every one of these is a fact of the TABLE that everybody at it watched
   * happen: what is on the pile and what shape it is, who put it there, and who
   * has dropped out of the trick. `combo.cards` are ids, and they are ids of
   * cards sitting face up in the `pile` zone, which is `visibility: 'all'` for
   * the same reason.
   *
   * WHAT IS NOT HERE: the 3♠ the opening lead owes. It is a card in a hand, so
   * it is `__mustInclude` on the seat holding it — see `requiredCardFor`.
   */
  publicVars: ['combo', 'passed', 'leader', 'lastPlayer', 'trickNumber'],

  defaultZones(rules, seats) {   // eslint-disable-line no-unused-vars
    return [
      { id: 'hand', per: 'player', visibility: 'owner', layout: 'fan', order: 'sorted', facing: 'up' },
      // The standing combination, face up in the middle. `landing: 'play'` is
      // where a played card goes when the move names no destination.
      { id: 'pile', per: 'shared', visibility: 'all', layout: 'spread', order: 'sequence', facing: 'up', label: 'Pile', landing: 'play' },
      // Swept tricks. `all`, not `none`: everybody watched these cards being
      // played, and in a game whose whole skill is knowing which pigs are still
      // out there, hiding them would delete public information rather than
      // protect private information.
      { id: 'discard', per: 'shared', visibility: 'all', layout: 'stack', order: 'stack', facing: 'up', label: 'Played' },
    ];
  },

  defaultReactions() {
    return [];
  },

  setup(ctx) {
    beginHand(ctx, null);
  },

  /**
   * Hand two onward. Implemented for the reason CONTRACT.md's `startRound` trap
   * gives: the default boundary wipes every `playerVars` entry, and the seat
   * that went out last hand leads this one (`rules.laterLead: "trick-winner"`,
   * D-3) — which is meta-state that outlives a round.
   */
  startRound(ctx) {
    let opening = null;
    for (let seat = 0; seat < ctx.seats; seat++) {
      if (ctx.playerVar(seat, 'wonLastHand')) opening = seat;
      ctx.setPlayerVar(seat, 'wonLastHand', false);
    }
    if (ctx.rules.laterLead !== 'trick-winner') opening = null;
    beginHand(ctx, opening);
  },

  validateMove(ctx, move) {
    if (move.type === 'playCard') {
      if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");
      if (!stillIn(ctx, move.actor)) return ctx.fail('passed', 'You have passed; you are out of this trick.');
      const cards = move.cards || [];
      if (!cards.length) return ctx.fail('no-card', 'No cards specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!cards.every((id) => hand.includes(id))) return ctx.fail('not-in-hand', 'That card is not in your hand.');

      const played = classify(ctx, cards);
      if (!played) return ctx.fail('not-a-combination', 'Those cards are not a combination you can play.');

      const required = requiredCardFor(ctx, move.actor);
      if (required && !cards.includes(required)) {
        const card = ctx.cardById(required);
        return ctx.fail('first-lead',
          `The first lead of the hand has to include the ${card ? `${card.rank} of ${card.suit}` : required}.`);
      }

      const current = ctx.var('combo');
      if (!current) return ctx.ok();
      if (beatsInShape(ctx, played, current)) return ctx.ok();
      if (chops(ctx, played, current)) return ctx.ok();
      if (played.kind === current.kind && played.size === current.size) {
        return ctx.fail('not-higher', 'That does not beat the combination on the table.');
      }
      return ctx.fail('wrong-shape', `Answer a ${current.kind} of ${current.size} with the same shape, or pass.`);
    }

    if (move.type === 'pass') {
      if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");
      if (!ctx.var('combo')) return ctx.fail('must-lead', 'You are leading — you have to play something.');
      if (!stillIn(ctx, move.actor)) return ctx.fail('passed', 'You have already passed this trick.');
      return ctx.ok();
    }

    return ctx.fail('unknown-move', `Unknown move type: ${move.type}`);
  },

  applyMove(ctx, move) {
    const seat = move.actor;
    if (move.type === 'pass') {
      ctx.setVar('passed', [...passedSeats(ctx), seat]);
      ctx.emit('passed', { seat });
      advance(ctx, seat);
      return;
    }

    const played = classify(ctx, move.cards);
    ctx.moveCards(move.cards.slice(), ctx.zoneAddr('hand', seat), 'pile');
    const wasLead = !ctx.var('combo');
    ctx.setVar('combo', { ...played, seat });
    ctx.setVar('lastPlayer', seat);
    if (wasLead) ctx.setVar('leader', seat);
    // Spent, and spent for EVERY seat: the requirement belongs to the opening
    // lead of the hand, not to one seat's next turn.
    for (let s = 0; s < ctx.seats; s++) ctx.setPlayerVar(s, '__mustInclude', null);
    ctx.emit('combinationPlayed', {
      seat, kind: played.kind, size: played.size, cards: played.cards.slice(),
    });

    // `rules.winner: "first-empty-hand"` — going forward ends the hand.
    if (ctx.countIn(ctx.zoneAddr('hand', seat)) === 0) {
      ctx.setPlayerVar(seat, 'wonLastHand', true);
      ctx.endRound(seat);
      return;
    }
    advance(ctx, seat);
  },

  enumerateLegalMoves(ctx, seat) {
    if (seat !== ctx.turn.seat) return [];
    // A SEAT THAT HAS PASSED IS OFFERED NOTHING for the rest of the trick — the
    // same answer `actingSeats` gives, from the same predicate, so the felt's
    // turn token and the bot scheduler cannot disagree about it.
    if (!stillIn(ctx, seat)) return [];

    const current = ctx.var('combo');
    const moves = [];
    const required = requiredCardFor(ctx, seat);
    const push = (cards) => {
      if (required && !cards.includes(required)) return;
      moves.push({ actor: seat, type: 'playCard', cards });
    };

    if (!current) {
      for (const cards of candidateSets(ctx, seat)) push(cards);
      return moves;
    }

    // Answering: the led kind and size fix the shape, and only the strictly
    // higher ones survive.
    for (const cards of candidateSets(ctx, seat, { kind: current.kind, size: current.size })) {
      const played = classify(ctx, cards);
      if (played && beatsInShape(ctx, played, current)) push(cards);
    }
    // Out of shape: whichever declared bombs this combination is on the list of.
    for (const shape of bombShapes(ctx)) {
      if (shape.kind === current.kind && shape.size === current.size) continue;
      for (const cards of candidateSets(ctx, seat, shape)) {
        const played = classify(ctx, cards);
        if (played && chops(ctx, played, current)) push(cards);
      }
    }
    moves.push({ actor: seat, type: 'pass' });
    return moves;
  },

  /**
   * A TRICK SEATS DROP OUT OF (THIRTEEN_RULES.md §3.2).
   *
   * The seats that may act shrink as the trick goes on, and a plain round-robin
   * would schedule a bot that has already passed. `applyMove` never leaves the
   * turn on a seat that has passed or gone out, so this is the same seat the
   * felt's turn token draws — asserted rather than assumed, because that
   * agreement is the whole point of the hook and an empty answer is a loud
   * stall (tools/simulate.mjs) rather than a bot offered a move that throws.
   */
  actingSeats(ctx) {
    return stillIn(ctx, ctx.turn.seat) ? [ctx.turn.seat] : [];
  },

  isRoundOver(ctx) {
    return ctx.state.roundEnded;
  },

  /* ---------------------------------------------------------------- *
   * What the platform asks this template about itself
   * ---------------------------------------------------------------- */

  /**
   * Multi-select then commit, with a VARIABLE count — the mode this template
   * bought (src/ui/interaction.js). `pass` is the near miss and is exactly N;
   * here the count is whatever the combination is, and whether the selection is
   * a play at all is a live question the action button answers as cards go in.
   */
  interactionMode() {
    return 'combination';
  },

  /**
   * Always, for every seat, all round. Gathering here is not a phase you leave:
   * every turn is assembled in the tray, so the slot is reserved for the whole
   * hand and the felt never moves under the fan (#13). It also buys the
   * off-turn tray, which is the one thing a Thirteen player genuinely wants to
   * do while the bots think — line up the run before it is your turn.
   */
  gathers() {
    return true;
  },

  /**
   * The hand count, which is the race — thirteen down to nothing, and the first
   * one there has gone forward. The platform's default says the same thing;
   * saying it here is what gets the number a label and a proper sentence in the
   * screen reader, and it is the counter #103 will hang a bomb count beside.
   */
  seatCounters(ctx, seat) {
    const hand = ctx.countIn(ctx.zoneAddr('hand', seat));
    return [{
      text: String(hand),
      aria: `${hand} ${hand === 1 ? 'card' : 'cards'} left`,
      label: 'Cards',
      kind: 'hand',
    }];
  },

  describeEvent(ev, { seatLabel, viewerSeat }) {
    const who = (seat) => (seat === viewerSeat ? 'You' : seatLabel(seat));
    if (ev.type === 'passed') {
      return { text: `${who(ev.seat)} passed`, tone: 'neutral' };
    }
    if (ev.type === 'trickCleared') {
      return { text: `${who(ev.seat)} took the pile and lead`, tone: 'neutral' };
    }
    if (ev.type === 'combinationPlayed' && ev.size > 1) {
      const shape = ev.kind === 'consecutive-pairs' ? `${ev.size} consecutive pairs` : `a ${ev.kind}`;
      return { text: `${who(ev.seat)} played ${shape}`, tone: 'neutral' };
    }
    return null;
  },

  ruleLines(rules) {
    const out = ['Beat the cards on the table with the same shape, higher — or pass.'];
    if (rules.matchShape === 'same-type-same-size') {
      out.push('A run only answers a run of the same length; a pair only answers a pair.');
    }
    if (rules.passIsFinal) out.push('Once you pass you are out of that trick, so pass carefully.');
    if (rules.bombs?.length) out.push('A bomb can be played out of shape to kill the highest cards.');
    if (rules.laterLead === 'trick-winner') {
      out.push('When everyone else passes, the last player to have played leads the next trick.');
    }
    return out;
  },

  endingLines(pack) {
    const out = [];
    if (pack.rules?.winner === 'first-empty-hand') {
      out.push('The first player to get rid of every card wins the hand.');
    }
    out.push('Everybody else scores the cards left in their hand, and the lowest total wins the match.');
    return out;
  },

  botVerbs: { pass: 'passed' },

  /**
   * PLAY LEGALLY, AND GET THERE — the bar #102 owes and no more (#103 is the
   * bot that keeps its shape).
   *
   * Shedding is the race, so shedding is what it counts; the top card is what
   * the play costs, so it is subtracted; and a bomb spent out of shape is
   * charged for, so the bot does not chop a pig on trick one with the four of a
   * kind it will want later. Passing is worth less than any play that sheds a
   * card, which is what makes `isRoundOver` reachable under greedy play: every
   * trick's leader must play, so every trick sheds at least one card and a hand
   * cannot run longer than the deck.
   */
  botHeuristic(ctx, move, w = WEIGHTS) {
    if (move.type === 'pass') return w.PASS_WORTH;
    const played = classify(ctx, move.cards);
    if (!played) return w.PASS_WORTH;
    let score = move.cards.length * w.SHED_WORTH - played.top * w.TOP_COST;
    const current = ctx.var('combo');
    if (current && !beatsInShape(ctx, played, current)) score -= w.CHOP_COST;
    return score;
  },

  /** The strategy's numbers, for a caller that wants to play with different ones. */
  weights: WEIGHTS,
};

export default climbing;
