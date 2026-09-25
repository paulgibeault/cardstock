// THE CLIMBING BOT — its weights, what it thinks a hand IS, and the two hooks
// the engine grades a position through.
//
// Split out of ./climbing.js, which is the RULES: nothing in this file decides
// whether a move is legal, and every play it ranks came out of that file's own
// `enumerateLegalMoves`. What is here is opinion — how much a shed card is
// worth, how many turns a hand still needs, which of its leads nobody can take
// off it — so it is the file to read when the bot plays badly and the file to
// change when it should play differently.
//
//   `WEIGHTS`          the strategy's numbers, reached through `w`
//                      (src/templates/CONTRACT.md). ./climbing.js publishes them
//                      as `template.weights` for tools/tune.mjs.
//   `handShape`        a hand measured in TURNS rather than in cards
//   `controlOf`        the leads nothing unplayed can answer
//   `botHeuristic`     what one move is worth (#102)
//   `evaluateState`    what the POSITION is worth (#103)
//
// The vocabulary both this file and the rules ask in — what a combination is,
// what beats what, how many cards of a rank a sequence may use — is
// ./climbing-shapes.js, so importing it does not point back at the rules.

import { cardOrder, rankLadderOf } from '../engine/cards.js';
import {
  FIXED_SIZE, bombShapes, isBombShape, vocabularyOf,
  classify, beatsInShape, tokenMatches,
  rankCounts, takeFrom, windows,
} from './climbing-shapes.js';
import { pileWorth } from './climbing-offer.js';

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

/**
 * `{ plays, bombs }` — how many turns this hand needs, and how many of them
 * are chops somebody else's pig has to get past.
 */
function handShape(ctx, cardIds) {
  const vocab = vocabularyOf(ctx);
  const counts = rankCounts(ctx, cardIds);
  let plays = 0;
  let bombs = 0;

  if (vocab.has('quad')) {
    for (const entry of counts.values()) {
      if (entry.total < 4) continue;
      plays += 1;
      if (isBombShape(ctx, 'quad', 4)) bombs += 1;
      takeFrom(entry, 4);
    }
  }

  const strip = vocab.get('consecutive-pairs');
  if (strip) {
    for (const window of windows(counts, 2, (e) => e.strip)) {
      if (window.length < strip.min) continue;
      plays += 1;
      if (isBombShape(ctx, 'consecutive-pairs', window.length)) bombs += 1;
      for (const at of window) takeFrom(counts.get(at), 2, 'strip');
    }
  }

  const run = vocab.get('run');
  if (run) {
    // Repeated, because a rank the hand holds three of can sit in three runs.
    for (let pass = 0; pass < 4; pass++) {
      let laid = false;
      for (const window of windows(counts, 1, (e) => e.run)) {
        if (window.length < run.min) continue;
        plays += 1;
        laid = true;
        for (const at of window) takeFrom(counts.get(at), 1, 'run');
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
      if (windows(counts, 2, (e) => e.strip).some((w) => w.length >= size)) return true;
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
 * The two hooks the engine grades through
 * ------------------------------------------------------------------ */

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
export function botHeuristic(ctx, move, w = WEIGHTS) {
  // A pile on offer is worth the same as any other pile, and the phase that
  // deals them says so (./climbing-offer.js, `pileWorth`).
  const pile = pileWorth(move);
  if (pile !== null) return pile;
  if (move.type === 'pass') return w.PASS_WORTH;
  const played = classify(ctx, move.cards);
  if (!played) return w.PASS_WORTH;
  let score = move.cards.length * w.SHED_WORTH - played.top * w.TOP_COST;
  const current = ctx.var('combo');
  if (current && !beatsInShape(ctx, played, current)) score -= w.CHOP_COST;
  return score;
}

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
export function evaluateState(ctx, seat, w = WEIGHTS) {
  if (ctx.var('instantWin')) return null;
  const hand = ctx.cardIdsIn(ctx.zoneAddr('hand', seat));
  if (!hand.length) return null;
  const { plays, bombs } = handShape(ctx, hand);
  return -hand.length * w.CARD_COST
    - plays * w.PLAY_COST
    + bombs * w.BOMB_WORTH
    + controlOf(ctx, seat) * w.LEAD_WORTH;
}
