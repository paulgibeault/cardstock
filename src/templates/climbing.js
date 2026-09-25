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
//   combination comparison  `classify` + `beatsInShape` + `chops`, driven by
//                           `rules.combinations` / `rules.matchShape` /
//                           `rules.bombs` (./climbing-shapes.js).
//   a variable-count commit `interactionMode` → 'combination'
//                           (src/ui/interaction.js; the hook itself is
//                           ./climbing-offer.js, which owns the other mode).
//   a trick seats drop out  `passIsFinal`, the `passed` var, and `actingSeats`.
//
// What this file does NOT decide, on purpose: which combinations exist, which
// of them may be played out of shape and over what, whether a pass is final,
// which card must open the first hand and which hands that rule applies to,
// whether a run all of one suit is worth more than a mixed one, which way the
// turn goes, which cards a hand may not end on, and whether a deal can win on
// its own. Every one of them is a key in the manifest and every one is read
// below — `lastCardExcludes` and `instantWins` are #103's house rules, the
// third (`quad-needs-four-pairs`) needed no key at all because a chopping
// ladder was already a declaration and the variant simply patches it, and
// `runUpgrade` and `laterLead: "lowest"` are the two adjustments Thirteen
// asked for after the round-6 playtest.
//
// THIS FILE IS THE RULES. Three things that were sharing it are not rules and
// have moved out (#220), the way contract-rummy is split:
//   ./climbing-shapes.js  what a pile of cards IS and what beats what, plus the
//                         per-rank counting both the rules and the bot measure
//                         hands with — declaration-driven, stateless, and the
//                         shared layer that keeps the two below acyclic
//   ./climbing-offer.js   the two-handed offer deal (#157): a phase, a move, two
//                         zones and the branch it owns in nine hooks
//   ./climbing-bot.js     the weights bag and the strategy — `handShape`,
//                         `controlOf`, `botHeuristic`, `evaluateState`; checked
//                         by this file's own `validateMove`

import { cardOrder, rankIndexOf, rankLadderOf } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { handCounter, kCombinations } from '../engine/templateKit.js';
import {
  FIXED_SIZE, bombShapes, vocabularyOf, outOfSequence,
  classify, beatsInShape, tokenMatches, rankCounts, windows,
} from './climbing-shapes.js';
import {
  offerZones, beginOffer, validateOffer, applyTakeHand, offerMoves,
  offerActingSeats, interactionMode, zoneOnFelt, describeOfferEvent, offerRuleLines,
} from './climbing-offer.js';
import { WEIGHTS, botHeuristic, evaluateState } from './climbing-bot.js';

/**
 * WHAT THE STANDING COMBINATION IS CALLED — "Pair of 4s", "Run of 5".
 *
 * The whole of this game is "what am I answering", and the felt used to say it
 * with a number: the pile wore a count of every card played this trick, so a
 * trick with three singles in it read `3` while the thing to beat was one card
 * (#122, round-5 item 18). A count cannot answer that question — the SHAPE is
 * what `matchShape` compares — so the pile is named instead.
 *
 * The rank is the top card's, which is also the card being beaten: for every
 * shape this game has, the highest card is what a higher answer has to clear.
 * Ranks are the glyphs the cards themselves print (`A`, `K`, `10`), because
 * that is what a player is reading them off.
 */
function comboName(ctx, combo) {
  if (!combo) return null;
  const ladder = rankLadderOf(ctx.pack);
  let best = null;
  for (const id of combo.cards || []) {
    const card = ctx.cardById(id);
    if (card && (!best || cardOrder(card, ladder) > cardOrder(best, ladder))) best = card;
  }
  const rank = best?.rank == null ? '' : String(best.rank);
  // THE SUIT IS PART OF THE NAME once the trick has been upgraded, because it
  // is part of what has to be answered: "Run of 4" would be the same words over
  // a pile a plain run can beat and a pile only a suited run can.
  if (combo.kind === 'run') {
    return combo.suit ? `Run of ${combo.size} in ${combo.suit}` : `Run of ${combo.size}`;
  }
  if (combo.kind === 'consecutive-pairs') return `${combo.size} consecutive pairs`;
  if (combo.kind === 'single') return rank ? `Single ${rank}` : 'A single';
  if (combo.kind === 'pair') return rank ? `Pair of ${rank}s` : 'A pair';
  if (combo.kind === 'triple') return rank ? `Triple ${rank}s` : 'A triple';
  if (combo.kind === 'quad') return rank ? `Four ${rank}s` : 'Four of a kind';
  return null;
}

/* ------------------------------------------------------------------ *
 * Beating what is on the table
 * ------------------------------------------------------------------ */

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
 * `ctx.placeDeck` rather than ctx.moveCards, because the cards are coming from
 * outside the table rather than from another zone, and because no reaction
 * should fire while the deck is being handed out — there is nothing for a
 * zoneEmpty to respond to mid-deal. Sanctioned for the initial deal only
 * (src/templates/CONTRACT.md).
 */
function dealHands(ctx) {
  const per = ctx.rules.deal;
  const ids = ctx.rng.shuffle([...ctx.pack.cardsById.keys()]);
  const first = ctx.openingSeat();
  let at = 0;
  for (let i = 0; i < per; i++) {
    let seat = first;
    for (let n = 0; n < ctx.seats; n++) {
      if (at >= ids.length) return;
      const id = ids[at++];
      ctx.placeDeck(ctx.zoneAddr('hand', seat), [id]);
      // `nextSeat(from, dir)` — a STEP COUNT was being passed as the direction
      // (`nextSeat(first, n)`), which happened to visit every seat exactly once
      // and so dealt a correct but CLOCKWISE hand at a counter-clockwise table.
      // Stepping one seat at a time is the same walk `advance` does, so the
      // deal and the turn order cannot disagree.
      seat = ctx.nextSeat(seat);
    }
  }
}


/**
 * The card whose holder opens hand one, or null for a table with no such rule.
 *
 * `rules.firstLead.card` is either a literal card id ("spades-3") or the
 * selector `"lowest"`.
 *
 * WHY "lowest" HAD TO EXIST (#156). The literal form is the rule everybody
 * describes — "the 3♠ leads" — and it is only correct at a FULL table. Thirteen
 * deals a flat thirteen and leaves the remainder out of play (D-11), so at two
 * seats HALF the deck is never dealt and at three seats a quarter of it: the 3♠
 * is missing from 50.7% of two-seat deals and 25.8% of three-seat ones, over
 * 400 seeded deals each, which is the population figure and not a surprise.
 * Every one of those hands fell through to `ctx.openingSeat()`, which is seat 0,
 * which is the human. The player was handed the opening lead by a bug, in the
 * game whose first rule is that the lowest card leads.
 *
 * So the rule is written as what it means: the minimum on the pack's own TOTAL
 * order (`cardOrder`, suit included, so there is exactly one) among the cards
 * actually dealt. At four seats that IS the 3♠ and nothing changes. The literal
 * form keeps working for a pack that really does mean one nominated card.
 */
function firstLeadCard(ctx) {
  const want = ctx.rules.firstLead?.card;
  if (!want) return null;
  if (want !== 'lowest') return want;
  const ladder = rankLadderOf(ctx.pack);
  let lowest = null;
  let at = Infinity;
  for (let seat = 0; seat < ctx.seats; seat++) {
    for (const id of ctx.cardIdsIn(ctx.zoneAddr('hand', seat))) {
      const order = cardOrder(ctx.cardById(id), ladder);
      if (order < at) {
        at = order;
        lowest = id;
      }
    }
  }
  return lowest;
}

/**
 * A fresh hand, dealt, with the trick state cleared and a leader on the turn.
 *
 * @param opening `null` to apply `rules.firstLead` (hand one, D-2), or the seat
 *                that leads because `rules.laterLead` said so (D-3).
 * @param wonLast the seat that went out last hand, whatever `laterLead` does
 *                with it — the OFFER deal needs it even where the lead does
 *                not, because the loser picks first.
 */
function beginHand(ctx, opening, wonLast = null) {
  ctx.setDirection(ctx.rules.direction === 'counterclockwise' ? -1 : 1);
  ctx.setVar('combo', null);
  ctx.setVar('passed', []);
  ctx.setVar('lastPlayer', null);
  ctx.setVar('trickNumber', 1);
  ctx.setVar('instantWin', null);
  for (let seat = 0; seat < ctx.seats; seat++) ctx.setPlayerVar(seat, '__mustInclude', null);

  // THE DEAL THIS TABLE PLAYS. `beginOffer` answers false for the ordinary one,
  // and true once it has opened the pick phase instead — at which point nothing
  // else may happen until every seat is holding a hand (./climbing-offer.js).
  if (beginOffer(ctx, opening, wonLast)) return;
  dealHands(ctx);
  openPlay(ctx, opening);
}

/**
 * The hands exist; play begins. Split out of `beginHand` because the offer deal
 * (above) puts a whole phase between the two — nothing here may be asked before
 * every seat is holding its cards, and `instantWinShape` is the reason: tới
 * trắng is a fact about a HAND, and at a two-handed table the hands do not
 * exist until both piles have been picked.
 */
function openPlay(ctx, opening) {
  ctx.setVar('opening', null);

  // TỚI TRẮNG IS A FACT ABOUT THE DEAL, so it is asked here and nowhere else —
  // once a card has been played the hand is an ordinary hand, however it was
  // dealt. Seat order settles the vanishingly rare double, and the seat it
  // names leads whatever the first-lead rule would otherwise have said.
  //
  // WHY IT IS NOT AN `endRound` RIGHT HERE, which is the shape this wanted to
  // be. The round boundary is driven by `applyMove` (src/engine/movePipeline.js
  // — `maybeFinishRound` runs after an applied move and nothing else runs it),
  // so a hand ended during the DEAL sits unresolved until somebody moves, and
  // then gets scored one card into the next hand. Instead the check leaves a
  // var, the seat it names has exactly one legal move — lay the whole hand
  // down — and the ordinary "first empty hand" path scores and redeals it
  // inside the boundary that already exists. It is also the honest thing on
  // the felt: you get to put the dragon on the table.
  if (ctx.rules.instantWins) {
    for (let seat = 0; seat < ctx.seats; seat++) {
      const shape = instantWinShape(ctx, ctx.cardIdsIn(ctx.zoneAddr('hand', seat)));
      if (!shape) continue;
      ctx.setVar('instantWin', { seat, shape });
      for (let s = 0; s < ctx.seats; s++) ctx.setPlayerVar(s, '__mustInclude', null);
      ctx.setVar('leader', seat);
      ctx.setTurnSeat(seat);
      ctx.setPhase('play');
      return;
    }
  }

  let leader = opening;
  if (leader === null || leader === undefined) {
    const card = firstLeadCard(ctx);
    const holder = card ? seatHolding(ctx, card) : null;
    if (holder !== null) {
      leader = holder;
      // THE OPENING LEAD MUST CONTAIN IT, held as a var rather than
      // re-derived, because it is true exactly once per hand and stops being
      // true the moment that lead is played.
      if (ctx.rules.firstLead.mustInclude) ctx.setPlayerVar(leader, '__mustInclude', card);
      // WHO HAS IT, SAID OUT LOUD. The rule is the first thing that happens in
      // a hand and until now it happened silently: the turn token moved to a
      // seat for a reason nothing on the felt ever gave, and under
      // `laterLead: "lowest"` it moves for that reason every hand rather than
      // once a match. So the deal announces it.
      //
      // A SEAT AND NOTHING ELSE. Naming the card would publish a card sitting
      // in somebody's hand — the exact thing `requiredCardFor` keeps off the
      // shared vars, and at two and three seats the other players genuinely do
      // not know which card it is, because a quarter to a half of the deck was
      // never dealt (D-11). `lowest` says which rule named the seat, so a pack
      // that nominates one literal card gets a sentence that is true of it.
      ctx.emit('holdsLowest', { seat: leader, lowest: ctx.rules.firstLead.card === 'lowest' });
    } else {
      // Only reachable for a LITERAL `firstLead.card` the deal left out of
      // play; `"lowest"` is resolved against the dealt cards and always names
      // a seat at a table that has been dealt to.
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
 * trick-taking's pass (src/templates/trick-pass.js): everything offered
 * is legal, and a human is not restricted to the list — the felt builds the
 * move from whatever cards were tapped and `validateMove` judges it on its own
 * terms (src/ui/interaction.js, mode 'combination').
 */

/** A card set, as one string — for holding back a play the walk found twice. */
function setKey(cardIds) {
  return [...cardIds].sort().join('|');
}

/**
 * The suited chains of a run window, one rank longer.
 *
 * `null` starts them: one chain per suit present at the window's bottom rank.
 * After that a chain survives only while the hand holds its suit at every rank
 * in turn, which is exactly the shape of a same-suit run.
 */
function extendSuited(chains, here) {
  if (chains === null) {
    const started = new Map();
    for (const entry of here) if (!started.has(entry.card.suit)) started.set(entry.card.suit, [entry]);
    return started;
  }
  for (const [suit, chain] of chains) {
    const next = here.find((entry) => entry.card.suit === suit);
    if (next) chain.push(next);
    else chains.delete(suit);
  }
  return chains;
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
      for (const chosen of kCombinations(group, n)) out.push(chosen.map((e) => e.id));
    }
  }

  const sequential = (at, shape) => byRank.get(at).filter((e) => !outOfSequence(ctx, e.card, shape));

  // Runs: windows of consecutive ladder positions the hand can fill.
  const run = vocab.get('run');
  if (run && (kind === null || kind === 'run')) {
    const upgrades = ctx.rules.runUpgrade === 'same-suit';
    for (let i = 0; i < positions.length; i++) {
      const cardsSoFar = [];
      // ONE CHAIN PER SUIT that has survived every rank of the window so far,
      // and the reason the walk needed a second half at all: the top-card walk
      // below fills every rank under the top with the LOWEST card of that rank,
      // because for an ordinary run those choices are the same play. Under the
      // upgrade they are not — a run is suited or it is not — and the suited
      // one is very often built from cards the top-card walk never reaches. A
      // bot that could not see it would be playing a rule only a human has.
      let chains = null;
      for (let j = i; j < positions.length; j++) {
        if (j > i && positions[j] !== positions[j - 1] + 1) break;
        const here = sequential(positions[j], 'run');
        if (!here.length) break;
        if (upgrades) chains = extendSuited(chains, here);
        const length = j - i + 1;
        if (length >= run.min && wants('run', length)) {
          // Only the TOP rank's choice changes what the run beats.
          const seen = new Set();
          for (const topCard of here) {
            const cards = [...cardsSoFar.map((e) => e.id), topCard.id];
            seen.add(setKey(cards));
            out.push(cards);
          }
          // A suited run of the lowest suit at every rank IS one of the above,
          // so the mixed walk's own sets are held back — an enumerator that
          // offered the same play twice would be a bot choosing between
          // duplicates and a shortlist twice the size on the wire.
          for (const chain of chains ? chains.values() : []) {
            const cards = chain.map((e) => e.id);
            if (!seen.has(setKey(cards))) out.push(cards);
          }
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
        const here = sequential(positions[j], 'consecutive-pairs');
        if (here.length < 2) break;
        const pairs = j - i + 1;
        if (pairs >= strip.min && wants('consecutive-pairs', pairs)) {
          for (const topPair of kCombinations(here, 2)) {
            out.push([...cardsSoFar.map((e) => e.id), ...topPair.map((e) => e.id)]);
          }
        }
        cardsSoFar.push(here[0], here[1]);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The three house rules (#103), each a declaration this file reads
 * ------------------------------------------------------------------ */

/**
 * TỚI TRẮNG — the hand that has won before a card is played, or null.
 *
 * `rules.instantWins` is the switch (D-8, off by default because a hand that
 * ends on the deal is the wrong first impression from the lobby). The five
 * shapes are the traditional list, and every one of them is read off the
 * pack's OWN declarations rather than off Thirteen:
 *
 *   four 2s                 four of the top rank on the `rankLadder`
 *   six pairs               half a hand's worth of pairs (`deal` / 2)
 *   a 3-to-A dragon         one card of every rank EVERY sequence shape may
 *                           contain, i.e. the ladder minus `runExcludes` AND
 *                           minus `stripExcludes`
 *   five consecutive pairs  the longest strip the `bombs` ladder declares
 *   three consecutive       triples in as many consecutive ranks as a run
 *   triples                 needs (`combinations`' `run(3+)`)
 *
 * A pack with a different ladder and a different bomb list gets the same five
 * ideas measured against ITS table, which is the only way this belongs in a
 * template rather than in a Thirteen-shaped branch.
 *
 * THE DRAGON IS THE INTERSECTION, AND THAT IS THE EXPLICIT PART (#158). It used
 * to read `runExcludes` alone, so switching on "a 2 can end a run" moved the
 * dragon from 3-to-A (twelve ranks, twelve cards) to 3-to-2 (thirteen ranks,
 * and therefore the entire thirteen-card hand) — a shape so much rarer that the
 * house rule would have quietly turned the instant win off while the rules page
 * went on offering it. Taking the ranks that no sequence shape excludes keeps
 * the dragon at the traditional 3-to-A under both readings, and says so.
 */
function instantWinShape(ctx, cardIds) {
  if (!ctx.rules.instantWins) return null;
  const ladder = rankLadderOf(ctx.pack);
  const vocab = vocabularyOf(ctx);
  const counts = rankCounts(ctx, cardIds);

  const ranks = ladder.ranks || [];
  const topRank = rankIndexOf(ladder, ranks[ranks.length - 1]);
  if (vocab.has('quad') && (counts.get(topRank)?.total ?? 0) >= 4) return 'four pigs';

  let pairs = 0;
  let sequenceable = 0;
  for (const entry of counts.values()) {
    if (entry.total >= 2) pairs += 1;
    if (entry.seq >= 1) sequenceable += 1;
  }
  // HALF THE HAND IN FRONT OF YOU, not half of `rules.deal`. The two are the
  // same number at every table that deals flat, and they part company under the
  // offer deal — a seventeen-card hand asked for six pairs would be a much
  // commoner instant win than the rule it is named after (#157).
  if (vocab.has('pair') && pairs >= Math.floor(cardIds.length / 2)) return 'six pairs';

  const run = vocab.get('run');
  // No `kind`: a rank ANY sequence shape bars is barred from the dragon.
  const excluded = new Set();
  for (const card of ctx.pack.cardsById.values()) if (outOfSequence(ctx, card)) excluded.add(card.rank);
  const inSequence = ranks.filter((rank) => !excluded.has(rank)).length;
  if (run && sequenceable >= inSequence) return 'a dragon';

  const strip = vocab.get('consecutive-pairs');
  if (strip) {
    const longest = Math.max(0, ...bombShapes(ctx)
      .filter((shape) => shape.kind === 'consecutive-pairs')
      .map((shape) => shape.size ?? strip.min));
    if (longest && windows(counts, 2, (e) => e.strip).some((w) => w.length >= longest)) {
      return `${longest} consecutive pairs`;
    }
  }
  if (run && vocab.has('triple')
    && windows(counts, 3, (e) => e.seq).some((w) => w.length >= run.min)) {
    return `${run.min} consecutive triples`;
  }
  return null;
}

/**
 * Would this play empty the hand on a card the pack forbids ending on?
 *
 * `rules.lastCardExcludes` is the "no ending on a pig" house rule (D-4): a
 * won position becomes a trap, because the 2 that was going to take the last
 * trick is now a card you have to get rid of BEFORE the last trick.
 */
function endsOnExcluded(ctx, seat, cards) {
  const excludes = ctx.rules.lastCardExcludes;
  if (!excludes?.length) return false;
  if (cards.length !== ctx.countIn(ctx.zoneAddr('hand', seat))) return false;
  return cards.some((id) => excludes.some((selector) => selectorMatches(ctx.cardById(id), selector)));
}

/**
 * Is the exclusion in force for this seat right now?
 *
 * IT RELAXES WHERE IT WOULD DEADLOCK, which is the platform's existing policy
 * for a constraint that leaves an actor with nothing (`CARD_PLATFORM_DESIGN.md`
 * §5, and trick-taking's lead constraints do the same). A seat answering can
 * always pass, so the rule is absolute there. A seat on LEAD holding nothing
 * but pigs has no pass to fall back on, and a rule that stops the table is not
 * a rule, it is a stall — so on lead, and only where every other lead is
 * excluded too, the last card goes down.
 */
function exclusionApplies(ctx, seat) {
  if (!ctx.rules.lastCardExcludes?.length) return false;
  if (ctx.var('combo')) return true;
  const required = requiredCardFor(ctx, seat);
  for (const cards of candidateSets(ctx, seat)) {
    if (required && !cards.includes(required)) continue;
    if (!endsOnExcluded(ctx, seat, cards)) return true;
  }
  return false;
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
   *
   * `instantWin` names a SEAT and a shape, never a card: tới trắng is declared
   * out loud at the table the moment it is dealt, and the hand it names is
   * about to be laid face up anyway.
   *
   * `opening` is a SEAT, parked between the round boundary that decided it and
   * the choose phase that spends it (see `beginHand`) — who leads the next hand
   * is something everybody at the table watched being settled.
   */
  publicVars: ['combo', 'passed', 'leader', 'lastPlayer', 'trickNumber', 'instantWin', 'opening'],

  defaultZones(rules, seats) {
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
      // The piles on offer and the one nobody takes, at the one seat count that
      // plays for them and nowhere else (./climbing-offer.js, `offerZones`).
      ...offerZones(rules, seats),
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
   * gives: the default boundary wipes every `playerVars` entry, and who won the
   * last hand is meta-state that outlives a round — `rules.laterLead` may hand
   * that seat the lead, and the offer deal owes it the pick order either way.
   */
  startRound(ctx) {
    // READ ONCE, USED TWICE, and the two uses are not the same question. The
    // LEAD is `rules.laterLead`'s to give away and a pack may decline it; the
    // PICK ORDER under the offer deal is the other half of the same bargain
    // (the loser picks first, the winner leads) and needs the winner whatever
    // the lead rule says. Collapsing them — which is what reading only
    // `opening` did — meant a pack with no `laterLead` dealt its piles to a
    // coin flip every hand.
    let wonLast = null;
    for (let seat = 0; seat < ctx.seats; seat++) {
      if (ctx.playerVar(seat, 'wonLastHand')) wonLast = seat;
      ctx.setPlayerVar(seat, 'wonLastHand', false);
    }
    // `trick-winner` hands the next hand to the seat that went out (D-3).
    // `lowest` — Thirteen's rule — declines it, and `null` is how `beginHand`
    // is told to apply `rules.firstLead` to the cards it is about to deal: the
    // lowest card in play leads EVERY hand, and owes that card every time,
    // exactly as it does on hand one.
    beginHand(ctx, ctx.rules.laterLead === 'trick-winner' ? wonLast : null, wonLast);
  },

  validateMove(ctx, move) {
    // THE PICK PHASE ANSWERS FIRST, and it answers for every move type — a
    // `takeHand` it judges, and anything else while the hands are still in piles
    // it refuses in its own words. A `null` means the phase is not running (or
    // is running and this is not its move), so the rules go on below.
    const choosing = validateOffer(ctx, move);
    if (choosing) return choosing;

    if (move.type === 'playCard') {
      if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn.");
      if (!stillIn(ctx, move.actor)) return ctx.fail('passed', 'You have passed; you are out of this trick.');
      const cards = move.cards || [];
      if (!cards.length) return ctx.fail('no-card', 'No cards specified.');
      const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', move.actor));
      if (!cards.every((id) => hand.includes(id))) return ctx.fail('not-in-hand', 'That card is not in your hand.');

      // A declared instant win is not a combination and is not answered: the
      // whole hand goes down, and nothing else is a move while it stands.
      const instant = ctx.var('instantWin');
      if (instant) {
        if (instant.seat !== move.actor) return ctx.fail('turn', "It's not your turn.");
        if (cards.length !== hand.length) {
          return ctx.fail('instant-win', `You were dealt ${instant.shape} — lay the whole hand down.`);
        }
        return ctx.ok();
      }

      const played = classify(ctx, cards);
      if (!played) return ctx.fail('not-a-combination', 'Those cards are not a combination you can play.');

      const required = requiredCardFor(ctx, move.actor);
      if (required && !cards.includes(required)) {
        const card = ctx.cardById(required);
        return ctx.fail('first-lead',
          `The first lead of the hand has to include the ${card ? `${card.rank} of ${card.suit}` : required}.`);
      }

      // THE FELT SAYS WHY THE MOVE IS MISSING. `enumerateLegalMoves` omits
      // these, and a refusal with a sentence is what the human gets when they
      // gather the cards anyway — the enumerator is a shortlist, so this is
      // the only place the "no ending on a pig" rule can be explained.
      if (endsOnExcluded(ctx, move.actor, cards) && exclusionApplies(ctx, move.actor)) {
        return ctx.fail('last-card',
          'You cannot go out on that — it has to be played before your last card.');
      }

      const current = ctx.var('combo');
      if (!current) return ctx.ok();
      if (beatsInShape(ctx, played, current)) return ctx.ok();
      if (chops(ctx, played, current)) return ctx.ok();
      // NAMED, BECAUSE THE FELT SHOWS THIS SENTENCE NOW. A refused selection puts
      // the reason under the tray it is sitting in (#122), and "a pair of 2" —
      // the shape's kind and its SIZE — was read as a pair of twos. The pile
      // wears the same words (`zoneFocus`), so the refusal and the thing being
      // refused cannot describe the position differently.
      const standing = comboName(ctx, current) || 'the combination on the table';
      const said = standing[0].toLowerCase() + standing.slice(1);
      if (played.kind === current.kind && played.size === current.size) {
        // THE UPGRADE GETS ITS OWN SENTENCE, because "that does not beat it" is
        // a lie about a run that beats it on every card: what is wrong with the
        // play is its suits, and a refusal the player cannot act on is a rule
        // they have to reverse-engineer from a greyed-out button.
        if (current.suit && !played.suit) {
          return ctx.fail('not-suited',
            `The ${said} can only be answered by a higher run all of one suit — or pass.`);
        }
        return ctx.fail('not-higher', `That does not beat the ${said}.`);
      }
      return ctx.fail('wrong-shape', `Answer the ${said} with the same shape, or pass.`);
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
    if (move.type === 'takeHand') {
      // `openPlay` is handed over because the last pick ENDS the phase by
      // starting the hand, and starting a hand is this file's job — the phase
      // owns the pick and hands the table back (./climbing-offer.js).
      applyTakeHand(ctx, move, openPlay);
      return;
    }

    if (move.type === 'pass') {
      // WHAT `passed` MEANS DEPENDS ON THE RULE, and it is worth saying which.
      // Under `passIsFinal` it is the roster of seats out of this trick, and
      // `stillIn` reads it. Under the weak rule (#158's `pass-stays-in`) it is
      // a LOG of the passes this trick and nothing gates on it — a seat can
      // appear in it twice, which is a seat that passed twice and is still
      // being asked. Either way it is cleared by `clearTrick`, and either way
      // it is public: everybody at the table watched each of those passes.
      ctx.setVar('passed', [...passedSeats(ctx), seat]);
      ctx.emit('passed', { seat });
      advance(ctx, seat);
      return;
    }

    const instant = ctx.var('instantWin');
    if (instant) {
      const cards = move.cards.slice();
      ctx.moveCards(cards, ctx.zoneAddr('hand', seat), 'pile');
      ctx.setVar('instantWin', null);
      ctx.setVar('lastPlayer', seat);
      ctx.emit('instantWin', { seat, shape: instant.shape, cards });
      ctx.setPlayerVar(seat, 'wonLastHand', true);
      ctx.endRound(seat);
      return;
    }

    const played = classify(ctx, move.cards);
    const standing = ctx.var('combo');
    ctx.moveCards(move.cards.slice(), ctx.zoneAddr('hand', seat), 'pile');
    const wasLead = !standing;
    ctx.setVar('combo', { ...played, seat });
    ctx.setVar('lastPlayer', seat);
    if (wasLead) ctx.setVar('leader', seat);
    // Spent, and spent for EVERY seat: the requirement belongs to the opening
    // lead of the hand, not to one seat's next turn.
    for (let s = 0; s < ctx.seats; s++) ctx.setPlayerVar(s, '__mustInclude', null);
    ctx.emit('combinationPlayed', {
      seat, kind: played.kind, size: played.size, cards: played.cards.slice(),
      // THE MOMENT THE TRICK CHANGED, and only that moment: every answer from
      // here on is suited too (`beatsInShape`), so carrying the suit on all of
      // them would announce the same upgrade once a turn. The suit is a public
      // fact about cards lying face up — it is the pile's own name now
      // (`comboName`) — so it is in the payload rather than left to be read.
      ...(played.suit && !standing?.suit ? { suited: played.suit } : {}),
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

    // One move per pile still on offer, while there are piles to pick from
    // (./climbing-offer.js, `offerMoves`).
    const choosing = offerMoves(ctx, seat);
    if (choosing) return choosing;

    // A SEAT THAT HAS PASSED IS OFFERED NOTHING for the rest of the trick — the
    // same answer `actingSeats` gives, from the same predicate, so the felt's
    // turn token and the bot scheduler cannot disagree about it.
    if (!stillIn(ctx, seat)) return [];

    // A hand that won on the deal has exactly one thing to do with itself.
    const instant = ctx.var('instantWin');
    if (instant) {
      if (instant.seat !== seat) return [];
      return [{ actor: seat, type: 'playCard', cards: ctx.cardIdsIn(ctx.zoneAddr('hand', seat)).slice() }];
    }

    const current = ctx.var('combo');
    const moves = [];
    const required = requiredCardFor(ctx, seat);
    // Asked once per turn rather than per candidate: it walks the same
    // candidate list this function is building.
    const excluding = exclusionApplies(ctx, seat);
    const push = (cards) => {
      if (required && !cards.includes(required)) return;
      // OMITTED, NOT REFUSED LATE. `validateMove` says the same thing in a
      // sentence; here the move simply is not on the list, which is what keeps
      // a bot from ever proposing it.
      if (excluding && endsOnExcluded(ctx, seat, cards)) return;
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
    // The pick phase answers for itself — `stillIn` below reads "has cards and
    // has not passed", and while the hands are in piles nobody has any
    // (./climbing-offer.js, `offerActingSeats`).
    const choosing = offerActingSeats(ctx);
    if (choosing) return choosing;
    return stillIn(ctx, ctx.turn.seat) ? [ctx.turn.seat] : [];
  },

  isRoundOver(ctx) {
    return ctx.roundEnded();
  },

  /* ---------------------------------------------------------------- *
   * What the platform asks this template about itself
   * ---------------------------------------------------------------- */

  /**
   * Always, for every seat, all round. Gathering here is not a phase you leave:
   * every turn is assembled in the tray, so the slot is reserved for the whole
   * hand and the felt never moves under the fan (#13). It also buys the
   * off-turn tray, which is the one thing a Thirteen player genuinely wants to
   * do while the bots think — line up the run before it is your turn.
   *
   * STILL TRUE THROUGH THE CHOOSE PHASE (#157), for exactly the reason above:
   * there is nothing to gather while the hands are still in piles, and a tray
   * slot that appeared when the hand arrived would move the felt under the fan
   * at the one moment a player is looking at it. The slot sits empty for the
   * two taps the phase lasts. (`stagingPhase` — the platform's default for a
   * template with no opinion — would say no here; climbing has an opinion, and
   * this is it.)
   */
  gathers() {
    return true;
  },

  /**
   * The hand count, which is the race — thirteen down to nothing, and the first
   * one there has gone forward. The platform's default says the same thing;
   * saying it here is what gets the number a label and a proper sentence in the
   * screen reader.
   *
   * AND THE BOMB COUNT #102 EXPECTED TO HANG BESIDE IT IS NOT HERE, which is
   * worth writing down rather than leaving as an omission. This hook is asked
   * of EVERY seat (CONTRACT.md says so, and it is why the badges line up), and
   * `ctx` has no notion of who is looking — so a bomb count would publish a
   * fact about a hidden hand to whoever is sitting in front of the screen. It
   * would not even be a consistent leak: a joined table renders from a
   * filtered view where an opponent's hand is a bare count, so the number
   * would read 0 there and 2 in solo play. The seat that wants it is the
   * viewer's own, and until the hook knows which one that is, it is one number.
   */
  seatCounters(ctx, seat) {
    const hand = ctx.countIn(ctx.zoneAddr('hand', seat));
    const counters = [handCounter(ctx, seat, { suffix: ' left' })];

    // WHO IS STILL IN THIS TRICK (#148). The whole shape of a climbing trick is
    // that seats drop out of it one at a time and the last one standing leads
    // the next — so "has this seat passed" is the fact the table is read for
    // between one play and the next, and until now the only thing that ever
    // said it was a banner that had already gone. It is not a leak, unlike the
    // bomb count above: `passed` is a PUBLIC table var (`publicVars`), a list
    // of seats everybody watched pass.
    //
    // The wording is deliberately about THIS trick rather than about being out
    // for good: `passIsFinal` is a rule a pack declares (D-12), and #158 may
    // relax it — under the weaker rule a passed seat is simply passed for this
    // round of the trick, which is the same mark and the same sentence.
    //
    // `passedSeats` and not `stillIn`, which answers a different question and
    // is wrong here twice over: it is false for a seat that has gone OUT (an
    // empty hand is not a pass, and that seat has already won its place), and
    // true for a passed seat under `passIsFinal: false`, which is exactly the
    // seat this mark exists for.
    if (hand > 0 && passedSeats(ctx).includes(seat)) {
      counters.push({
        text: 'pass',
        aria: 'has passed this trick',
        label: 'Passed',
        kind: 'passed',
      });
    }
    return counters;
  },

  /**
   * WHICH CARDS IN THE PILE ARE THE THING TO ANSWER, and what they are called.
   *
   * `pile` holds every card played this trick, in sequence — that is deliberate
   * (it is the trick, and everybody watched it happen) and it is also why the
   * felt could not say what you were beating: a count of the pile is a count of
   * the trick, not of the standing combination. The template already knows the
   * answer, because `combo` IS the standing combination and carries its own card
   * ids; this hands that to the renderer instead of making it re-derive one.
   *
   * Null while nobody has led: an empty pile wears its own name, and "you are
   * leading" is what an empty pile in this game means.
   */
  zoneFocus(ctx, address) {
    if (address !== 'pile') return null;
    const combo = ctx.var('combo');
    if (!combo) return null;
    const label = comboName(ctx, combo);
    if (!label) return null;
    return { cards: (combo.cards || []).slice(), label, seat: combo.seat };
  },

  /**
   * `priority` is what stops the pass from swallowing the trick. A move here
   * can emit two describable events — `passed` and then `trickCleared`, because
   * the pass that ends the trick is one move — and the banner takes ONE. Taking
   * the first meant a trick that came back to you was announced as somebody
   * else's pass, and "the trick is yours" never appeared on the felt at all
   * (#122, round-5 item 22).
   */
  describeEvent(ev, { seatLabel, viewerSeat } = {}) {
    // `seatLabel` ALREADY SAYS "You" for the reader's own seat (src/ui/table.js)
    // — rebuilding that here was a second copy of a rule the platform owns, and
    // the copy is the thing that goes stale when the rule changes. `viewerSeat`
    // stays for the clauses below that are a DIFFERENT sentence in the second
    // person rather than merely a different name (CONTRACT.md, "Naming a seat").
    // The bag is defaulted because both call sites pass it whole and a direct
    // `describeEvent(ev)` — from a test, or a future caller — should not throw.
    const who = (seat) => seatLabel?.(seat) ?? `Seat ${seat}`;
    const mine = (seat) => seat === viewerSeat;
    // The pick phase's own event, described by the phase — and handed the two
    // naming helpers rather than building a second pair (./climbing-offer.js).
    const offered = describeOfferEvent(ev, { who, mine });
    if (offered) return offered;
    if (ev.type === 'passed') {
      return { text: `${who(ev.seat)} passed`, tone: 'neutral' };
    }
    if (ev.type === 'trickCleared') {
      // The one sentence this game was missing. Distinct from a pass in wording
      // AND in tone: winning the trick is the good outcome of the decision the
      // whole game is made of, and the next thing that happens is your lead.
      return mine(ev.seat)
        ? { text: 'Everybody passed — the lead is yours', tone: 'good', priority: 2 }
        : { text: `${who(ev.seat)} takes the trick and leads`, tone: 'neutral', priority: 2 };
    }
    if (ev.type === 'holdsLowest') {
      // THE TOAST THAT SAYS WHOSE TURN IT IS, and why it is theirs. Priority 2,
      // the same rung `trickCleared` sits on: it is the conclusion of the deal,
      // and at a round boundary it is competing with nothing else — the hand
      // that just ended has already had its own summary.
      const what = ev.lowest ? 'the lowest card' : 'the opening card';
      return mine(ev.seat)
        ? { text: `You have ${what} — you lead`, tone: 'good', priority: 2 }
        : { text: `${who(ev.seat)} has ${what} and leads`, tone: 'neutral', priority: 2 };
    }
    if (ev.type === 'instantWin') {
      return { text: `${who(ev.seat)} was dealt ${ev.shape} — the hand is over`, tone: 'good', priority: 3 };
    }
    if (ev.type === 'combinationPlayed') {
      // SINGLES SAY SOMETHING TOO. They used to return null, so the banner kept
      // whatever it last had — which is how a pass from three turns ago was
      // still standing over your own lead (item 22 again).
      const shape = ev.kind === 'consecutive-pairs' ? `${ev.size} consecutive pairs`
        : ev.kind === 'single' ? 'a single'
          : `a ${ev.kind}`;
      // THE UPGRADE IS THE LOUDER HALF OF THE SENTENCE, because it changes what
      // everybody else may do next and nothing else on the felt says so: the
      // pile's name carries the suit from here on, but a player already looking
      // at their own run needs telling before they gather it.
      if (ev.suited) {
        return {
          text: `${who(ev.seat)} played ${shape} in ${ev.suited} — only suited runs answer it now`,
          tone: mine(ev.seat) ? 'good' : 'neutral',
          priority: 1,
        };
      }
      return { text: `${who(ev.seat)} played ${shape}`, tone: 'neutral' };
    }
    return null;
  },

  ruleLines(rules) {
    const out = ['Beat the cards on the table with the same shape, higher — or pass.'];
    // What the deal is, before what beats what: the sentence belongs to the
    // phase that deals it (./climbing-offer.js, `offerRuleLines`).
    out.push(...offerRuleLines(rules));
    if (rules.matchShape === 'same-type-same-size') {
      out.push('A run only answers a run of the same length; a pair only answers a pair.');
    }
    // BOTH READINGS GET A SENTENCE. `passIsFinal: false` used to print nothing
    // at all, so the one table rule that changes what you may do on your next
    // turn was the one rule the rules page did not mention (#158).
    if (rules.passIsFinal === false) {
      out.push('A pass only skips your turn: you are asked again when the play comes back round.');
    } else {
      out.push('Once you pass you are out of that trick, so pass carefully.');
    }
    if (rules.bombs?.length) out.push('A bomb can be played out of shape to kill the highest cards.');
    if (rules.runUpgrade === 'same-suit') {
      out.push('A run all of one suit upgrades the trick, and from then on only a higher run '
        + 'all of one suit answers it.');
    }
    // The opening lead is a rule about the first turn of a hand, and the felt
    // refuses moves over it, so it says so rather than being discovered.
    if (rules.firstLead?.card === 'lowest') {
      // WHICH HANDS, and it is `laterLead` that says: the sentence used to read
      // "the first hand" under a rule that now opens every one of them the same
      // way, which is the rules page describing a different game.
      const when = rules.laterLead === 'lowest' ? 'every hand' : 'the first hand';
      out.push(rules.firstLead.mustInclude
        ? `The lowest card in play leads ${when}, and that lead has to contain it.`
        : `The lowest card in play leads ${when}.`);
    }
    // UNCONDITIONAL, because the trick clearing to the last player to have
    // played is the GENRE (`clearTrick`) and not a declaration — `laterLead`
    // only says who opens the next HAND. Gated on `trick-winner`, this sentence
    // disappeared the moment a pack declined that rule, taking the one
    // explanation of how a trick ends with it.
    out.push('When everyone else passes, the last player to have played takes the trick '
      + 'and leads the next one.');
    if (rules.laterLead === 'trick-winner') {
      out.push('The seat that goes out leads the next hand.');
    }
    // The two variants that change what is LEGAL say so here, because a rule
    // whose only expression is a move quietly missing from the felt is a rule
    // the player has to reverse-engineer.
    if (rules.lastCardExcludes?.length) {
      out.push('You may not go out on a 2 — it has to be played before your last card.');
    }
    if (rules.instantWins) {
      out.push('Some hands win on the deal: four 2s, six pairs, a 3-to-A dragon, '
        + 'five consecutive pairs or three consecutive triples.');
    }
    // The house rule the exclusion split bought: a run may end on the top of the
    // ladder while a strip of consecutive pairs still may not.
    if (rules.stripExcludes?.length && !rules.runExcludes?.length) {
      out.push('A run may end on a 2 — it still never wraps, and a 2 is still no part '
        + 'of a strip of consecutive pairs.');
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

  botVerbs: { pass: 'passed', takeHand: 'picked a hand' },

  botHeuristic,

  evaluateState,

  /** The strategy's numbers, for a caller that wants to play with different ones. */
  weights: WEIGHTS,
};

// The pick phase owns two hooks outright (./climbing-offer.js says why), so
// they are composed onto the template here rather than written out again.
climbing.interactionMode = interactionMode;
climbing.zoneOnFelt = zoneOnFelt;

export default climbing;
