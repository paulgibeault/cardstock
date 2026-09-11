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
// which card must open the first hand, which way the turn goes, which cards a
// hand may not end on, and whether a deal can win on its own. All eight are
// keys in the manifest, and every one of them is read below — the last two are
// #103's house rules (`lastCardExcludes`, `instantWins`), and the third
// (`quad-needs-four-pairs`) needed no key at all, because a chopping ladder
// was already a declaration and the variant simply patches it.

import { cardOrder, rankIndexOf, rankLadderOf } from '../engine/cards.js';
import { selectorMatches } from '../engine/selectors.js';
import { groupByRank, rankWindow } from './melds.js';

/* ------------------------------------------------------------------ *
 * What a greedy bot thinks a move is worth (see `botHeuristic`)
 * ------------------------------------------------------------------ *
 *
 * #102 owed a bot that plays LEGALLY and reaches `isRoundOver` under greedy
 * play, so the rollout layer had something to grade; playing WELL — shape
 * preservation — is `evaluateState` at the foot of this file (#103), and these
 * numbers are the seam it took over through (src/templates/CONTRACT.md,
 * `weights`).
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

/* ------------------------------------------------------------------ *
 * What a POSITION is worth (see `evaluateState`)
 * ------------------------------------------------------------------ *
 *
 * The same unit, the same direction, a different question. A card still in
 * hand is a card not yet shed, so it is the cost; but thirteen cards that are
 * four plays beat eleven cards that are eleven, and that is the whole game.
 */
const CARD_COST = 1;

/**
 * Per TURN the hand still needs — the structure term, and the reason this hook
 * exists at all.
 *
 * Priced above a card because that is the claim: breaking a five-card run to
 * answer a single sheds one card (worth 1) and turns one play into four
 * (worth 3 × this). At 2.5 the bot passes rather than make that trade, and
 * plays the run when it is on lead. Below about 1.5 it stops preferring the
 * intact hand at all, which is the shipped `botHeuristic` with extra steps.
 */
const PLAY_COST = 2.5;

/** A bomb still in hand — the answer to somebody else's pig, unspent. */
const BOMB_WORTH = 3;

/** A lead nothing left in the deck can answer in shape. */
const LEAD_WORTH = 2;

export const WEIGHTS = Object.freeze({
  SHED_WORTH, TOP_COST, CHOP_COST, PASS_WORTH,
  CARD_COST, PLAY_COST, BOMB_WORTH, LEAD_WORTH,
});

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
  if (combo.kind === 'run') return `Run of ${combo.size}`;
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
  ctx.setVar('instantWin', null);
  for (let seat = 0; seat < ctx.seats; seat++) ctx.setPlayerVar(seat, '__mustInclude', null);

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

/**
 * Is a combination of this kind and size a bomb?
 *
 * `size >=` rather than `===` because a strip of six consecutive pairs
 * CONTAINS the five-pair bomb the pack declared, and a hand holding one holds
 * the answer to a pig whether or not the whole thing is on the ladder.
 */
function isBombShape(ctx, kind, size) {
  return bombShapes(ctx).some((shape) => shape.kind === kind
    && (shape.size === null || size >= shape.size));
}

/* ------------------------------------------------------------------ *
 * What a hand IS, as distinct from how big it is
 * ------------------------------------------------------------------ *
 *
 * THE ONE FACT THE MOVE-BY-MOVE HEURISTIC CANNOT SEE. `botHeuristic` grades a
 * play by what it sheds and what it spends, and by that reading answering a
 * single 7 with the 8 out of `6-7-8-9-10` is a fine move: one card gone, a
 * cheap card at that. It is the losing move in the game. The run was one turn
 * and is now four, and four turns is four tricks somebody else gets to lead.
 *
 * So the hand is measured in TURNS: greedily cover it with the biggest legal
 * combinations the pack declares and count them. Quads first (a quad is one
 * play and usually a bomb), then strips of consecutive pairs, then runs, then
 * whatever is left as pairs, triples and singles. Any fixed order is a
 * heuristic; this one is the order a player actually reads their hand in.
 */
function rankCounts(ctx, cardIds) {
  const ladder = rankLadderOf(ctx.pack);
  const counts = new Map();
  for (const id of cardIds) {
    const card = ctx.cardById(id);
    if (!card) continue;
    const at = rankIndexOf(ladder, card.rank);
    if (at < 0) continue;
    if (!counts.has(at)) counts.set(at, { total: 0, seq: 0 });
    const entry = counts.get(at);
    entry.total += 1;
    // A card no sequence may contain (Thirteen's 2) counts toward a quad and a
    // pair and toward nothing that runs.
    if (!outOfSequence(ctx, card)) entry.seq += 1;
  }
  return counts;
}

/**
 * Maximal windows of CONSECUTIVE ladder positions holding at least `each`
 * cards apiece — the same walk `candidateSets` does, over counts rather than
 * over card ids, because a hand being measured does not need the ids back.
 */
function windows(counts, each, pick) {
  const positions = [...counts.keys()].sort((a, b) => a - b)
    .filter((at) => pick(counts.get(at)) >= each);
  const out = [];
  let group = [];
  for (const at of positions) {
    if (group.length && at !== group[group.length - 1] + 1) {
      out.push(group);
      group = [];
    }
    group.push(at);
  }
  if (group.length) out.push(group);
  return out;
}

/**
 * `{ plays, bombs }` — how many turns this hand needs, and how many of them
 * are chops somebody else's pig has to get past.
 */
function handShape(ctx, cardIds) {
  const vocab = vocabularyOf(ctx);
  const counts = rankCounts(ctx, cardIds);
  let plays = 0;
  let bombs = 0;

  // Same-rank cards spend the ones a sequence could not have used first.
  const takeFlat = (entry, k) => {
    const fromSeq = Math.max(0, k - (entry.total - entry.seq));
    entry.total -= k;
    entry.seq -= fromSeq;
  };

  if (vocab.has('quad')) {
    for (const entry of counts.values()) {
      if (entry.total < 4) continue;
      plays += 1;
      if (isBombShape(ctx, 'quad', 4)) bombs += 1;
      takeFlat(entry, 4);
    }
  }

  const strip = vocab.get('consecutive-pairs');
  if (strip) {
    for (const window of windows(counts, 2, (e) => e.seq)) {
      if (window.length < strip.min) continue;
      plays += 1;
      if (isBombShape(ctx, 'consecutive-pairs', window.length)) bombs += 1;
      for (const at of window) {
        const entry = counts.get(at);
        entry.total -= 2;
        entry.seq -= 2;
      }
    }
  }

  const run = vocab.get('run');
  if (run) {
    // Repeated, because a rank the hand holds three of can sit in three runs.
    for (let pass = 0; pass < 4; pass++) {
      let laid = false;
      for (const window of windows(counts, 1, (e) => e.seq)) {
        if (window.length < run.min) continue;
        plays += 1;
        laid = true;
        for (const at of window) {
          const entry = counts.get(at);
          entry.total -= 1;
          entry.seq -= 1;
        }
      }
      if (!laid) break;
    }
  }

  for (const entry of counts.values()) {
    const left = entry.total;
    if (left <= 0) continue;
    const kind = Object.keys(FIXED_SIZE).find((k) => FIXED_SIZE[k] === left);
    plays += kind && vocab.has(kind) ? 1 : left;
  }
  return { plays, bombs };
}

/* ------------------------------------------------------------------ *
 * Control — the cards nothing left in the deck can answer
 * ------------------------------------------------------------------ */

/**
 * Every card that is neither in `seat`'s hand nor face up on the table.
 *
 * Short-handed, this includes the cards the deal left OUT of play (D-11: three
 * players see 39 of the 52) — which is the conservative and the honest answer
 * at once. Nobody has seen them, this seat cannot tell them from a card in
 * somebody's hand, and treating them as still out there is what keeps the
 * reading identical for every seat.
 */
function unseenBy(ctx, seat) {
  const seen = new Set(ctx.cardIdsIn(ctx.zoneAddr('hand', seat)));
  for (const id of ctx.cardIdsIn('pile')) seen.add(id);
  for (const id of ctx.cardIdsIn('discard')) seen.add(id);
  const out = [];
  for (const id of ctx.pack.cardsById.keys()) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * Could a bomb still be ASSEMBLED out of the cards nobody has played?
 *
 * Arithmetic over public information, and the distinction is the whole
 * fairness question: this asks whether the unplayed remainder of the DECK
 * could contain a chop, never whether the seat across the table is holding
 * one. Early in a hand the answer is yes and a pig is worth little; by the
 * endgame, when the fours of a kind have all been broken up, it is no and a
 * pig is a trick.
 */
function chopAssemblable(ctx, unseen) {
  const counts = rankCounts(ctx, unseen);
  for (const shape of bombShapes(ctx)) {
    if (shape.kind === 'consecutive-pairs') {
      const size = shape.size ?? 3;
      if (windows(counts, 2, (e) => e.seq).some((w) => w.length >= size)) return true;
      continue;
    }
    const size = shape.size ?? FIXED_SIZE[shape.kind] ?? 1;
    for (const entry of counts.values()) if (entry.total >= size) return true;
  }
  return false;
}

/** Is this combination one a declared bomb names as a target? */
function isChopTarget(ctx, combo) {
  for (const bomb of ctx.rules.bombs || []) {
    if ((bomb.beats || []).some((token) => tokenMatches(ctx, token, combo))) return true;
  }
  return false;
}

/**
 * How many leads this hand holds that nothing still out there can answer.
 *
 * The top of the total order downward: every card of `seat`'s that outranks
 * the highest card nobody has seen is a lead the table can only pass on. That
 * is "holding the highest remaining card" counted rather than flagged, which
 * matters because holding the 2♥ AND the 2♦ is two free tricks, not one.
 *
 * A card a bomb could chop only counts while no bomb can still be built — the
 * pig that cannot be chopped is the whole reason this game's endgame is worth
 * playing, and `chopAssemblable` is the public half of that question.
 */
function controlOf(ctx, seat) {
  const ladder = rankLadderOf(ctx.pack);
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  const unseen = unseenBy(ctx, seat);
  let ceiling = -1;
  for (const id of unseen) ceiling = Math.max(ceiling, cardOrder(ctx.cardById(id), ladder));
  const chopped = chopAssemblable(ctx, unseen);
  let leads = 0;
  for (const id of hand) {
    if (cardOrder(ctx.cardById(id), ladder) <= ceiling) continue;
    if (chopped) {
      const single = classify(ctx, [id]);
      if (single && isChopTarget(ctx, single)) continue;
    }
    leads += 1;
  }
  return leads;
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
 *   a 3-to-A dragon         one card of every rank a sequence may contain,
 *                           i.e. the ladder minus `runExcludes`
 *   five consecutive pairs  the longest strip the `bombs` ladder declares
 *   three consecutive       triples in as many consecutive ranks as a run
 *   triples                 needs (`combinations`' `run(3+)`)
 *
 * A pack with a different ladder and a different bomb list gets the same five
 * ideas measured against ITS table, which is the only way this belongs in a
 * template rather than in a Thirteen-shaped branch.
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
  if (vocab.has('pair') && pairs >= Math.floor((ctx.rules.deal ?? cardIds.length) / 2)) return 'six pairs';

  const run = vocab.get('run');
  const excluded = new Set();
  for (const card of ctx.pack.cardsById.values()) if (outOfSequence(ctx, card)) excluded.add(card.rank);
  const inSequence = ranks.filter((rank) => !excluded.has(rank)).length;
  if (run && sequenceable >= inSequence) return 'a dragon';

  const strip = vocab.get('consecutive-pairs');
  if (strip) {
    const longest = Math.max(0, ...bombShapes(ctx)
      .filter((shape) => shape.kind === 'consecutive-pairs')
      .map((shape) => shape.size ?? strip.min));
    if (longest && windows(counts, 2, (e) => e.seq).some((w) => w.length >= longest)) {
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
   */
  publicVars: ['combo', 'passed', 'leader', 'lastPlayer', 'trickNumber', 'instantWin'],

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
    if (move.type === 'pass') {
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
    const counters = [{
      text: String(hand),
      aria: `${hand} ${hand === 1 ? 'card' : 'cards'} left`,
      label: 'Cards',
      kind: 'hand',
    }];

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
  describeEvent(ev, { seatLabel, viewerSeat }) {
    const who = (seat) => (seat === viewerSeat ? 'You' : seatLabel(seat));
    const mine = (seat) => seat === viewerSeat;
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

  /**
   * HOW GOOD THIS POSITION IS FOR `seat` — the lookahead's scorer
   * (src/engine/bot.js), higher is better. In this genre that means "how few
   * turns I still need, and how many of them nobody can take off me".
   *
   * WHAT `botHeuristic` CANNOT SAY, and the reason the hook is here at all.
   * Grading a move one at a time, answering a lone 7 with the 8 out of
   * `6-7-8-9-10` is a cheap card for a shed card and looks fine. It is how you
   * lose: the run was one turn and is now four. A move scorer has no way to
   * see that, because the damage is not in the cards that left — it is in the
   * SHAPE of the ones that stayed. So this reads the hand that is left:
   *
   *   its size            the race, and the unit everything else is priced in
   *   its `plays`         how many turns it would take to shed under a greedy
   *                       cover — the structure term, and a broken run raises
   *                       it by three
   *   its bombs           a chop still in hand is somebody else's pig answered
   *   its control         the cards nothing unplayed can beat (`controlOf`)
   *
   * WHAT IT DELIBERATELY DOES NOT READ. Anybody else's hand — not the cards,
   * and not the counts either. The counts are public and it would be within
   * its rights (src/engine/view.js ships one with every zone), but at one ply
   * they are identical under every candidate this seat is choosing between, so
   * a term built on them would be a weight the tuner could not move. The
   * search layer is what compares seats; this says what the position is worth.
   *
   * And, the one this game makes tempting: it does NOT ask whether an opponent
   * can chop. `controlOf` asks whether a bomb could still be ASSEMBLED from
   * the cards nobody has played — arithmetic over the discard, the pile and
   * this seat's own hand — never who is holding what. A bot that knew your
   * four of a kind was gone would play a pig into it and nothing in the suite
   * would catch it except the fairness gate, which is exactly why that gate
   * exists (tests/rollouts.test.js).
   *
   * `null` where there is nothing to judge: a hand that has been laid down,
   * and a deal that won before it was played.
   */
  evaluateState(ctx, seat, w = WEIGHTS) {
    if (ctx.var('instantWin')) return null;
    const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
    if (!hand.length) return null;
    const { plays, bombs } = handShape(ctx, hand);
    return -hand.length * w.CARD_COST
      - plays * w.PLAY_COST
      + bombs * w.BOMB_WORTH
      + controlOf(ctx, seat) * w.LEAD_WORTH;
  },

  /** The strategy's numbers, for a caller that wants to play with different ones. */
  weights: WEIGHTS,
};

export default climbing;
