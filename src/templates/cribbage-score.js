// THE SHOW, AS ONE PURE FUNCTION.
//
// Cribbage's scoring vocabulary — fifteens, pairs, runs, flushes, his nobs — is
// the only thing in this repo that scores a HAND OF CARDS rather than a pile, a
// trick or a meld, and it is the part of the game a player will argue with. So
// it lives alone, takes no ctx, touches no state, and is swept over the whole
// distribution — all 12,994,800 (four-card hand, starter) pairs — by a test
// that never loads the engine (tests/cribbageScore.test.js).
//
// WHAT IT DOES NOT KNOW, and is handed instead:
//
//   valueOf(card)  the card's COUNTING value — ace 1, face cards 10. That is
//                  the pack's `scoring.cardValues`, resolved by
//                  src/engine/scoring.js, not a fact this module may assume.
//   orderOf(card)  where the card sits on the pack's rank ladder (#101), which
//                  is what a RUN is consecutive in. Cribbage's ladder is
//                  `A 2 … K`, so the two are famously different numbers: a king
//                  is worth ten and sits thirteen rungs up, which is why J-Q-K
//                  is a run of three and 10-J-Q is one too, while all five of
//                  them together count thirty and not fifty.
//   isNobs(card)   which card is "the jack", from the pack's `rules.nobs`
//                  selector. Defaulted to the standard deck's J so the module
//                  stands up on its own; src/templates/cribbage.js always
//                  passes the manifest's answer.
//
// A rank the ladder does not name (`orderOf` < 0) takes no part in runs. It
// still counts for fifteens and pairs, which are facts about value and rank.

/** Two points, for each of the four things that are worth two points. */
const PAIR = 2;
const FIFTEEN = 2;

/** A four-card flush in the hand; the crib's must be five (see `flushOf`). */
const HAND_FLUSH = 4;

/** His nobs: the jack of the starter's suit, held. */
const NOBS = 1;

/** The highest a five-card show can reach. Nothing may exceed it. */
export const MAX_SHOW = 29;

/**
 * Scores no five cards can add up to.
 *
 * A curiosity that is also the sharpest available test of the whole table: any
 * arithmetic slip in fifteens, pairs or runs lands on one of these long before
 * it produces a number outside 0…29. Kept here rather than in the test because
 * it is a property of the rules, not of the assertion.
 */
export const IMPOSSIBLE_SHOWS = Object.freeze([19, 25, 26, 27]);

const defaultIsNobs = (card) => card?.rank === 'J';

function cardKey(card) {
  return card?.id ?? `${card?.rank ?? '?'}-${card?.suit ?? '?'}`;
}

/**
 * Scratch for the subset table below, reused across calls.
 *
 * Sized for the biggest hand this can be asked about — a crowded table's crib
 * holds two cards a seat plus the starter — and grown rather than reallocated
 * if some pack ever wants more. Module-level mutable state earns its keep
 * exactly once in this file and this is the place: the table is written before
 * it is read on every call, `scoreHand` never re-enters itself, and the
 * alternative is two typed-array allocations per scored hand in a function
 * called thirteen million times by one test.
 */
let subsetSums = new Int32Array(1 << 12);
let subsetCounts = new Uint8Array(1 << 12);

/**
 * Every subset of `cards` (size ≥ 2) whose counting values total fifteen.
 *
 * THE SUBSET SUMS ARE BUILT ONCE, INCREMENTALLY, because this is the hot
 * function: the distribution test sweeps 12,994,800 (hand, starter) pairs
 * through it, and the obvious nested loop reads each card 31 times over. The
 * identity is that a mask's sum is the sum of the mask with its lowest set bit
 * cleared, plus the value of that bit — so the whole table costs one addition
 * per subset instead of five. The subset SIZE is the same trick: one more than
 * its parent's.
 */
function fifteensOf(cards, valueOf, out) {
  const n = cards.length;
  const values = new Array(n);
  for (let i = 0; i < n; i++) values[i] = valueOf(cards[i]);

  const size = 1 << n;
  if (size > subsetSums.length) {
    subsetSums = new Int32Array(size);
    subsetCounts = new Uint8Array(size);
  }
  const sums = subsetSums;
  const counts = subsetCounts;
  sums[0] = 0;
  counts[0] = 0;
  let points = 0;
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    const rest = mask ^ low;
    const i = 31 - Math.clz32(low);
    sums[mask] = sums[rest] + values[i];
    counts[mask] = counts[rest] + 1;
    if (counts[mask] < 2 || sums[mask] !== 15) continue;
    points += FIFTEEN;
    if (out) {
      out.push({
        kind: 'fifteen',
        points: FIFTEEN,
        cards: cards.filter((_, k) => mask & (1 << k)).map(cardKey),
      });
    }
  }
  return points;
}

/** Every unordered pair of equal RANK — which is what a pair is, not equal value. */
function pairsOf(cards, out) {
  let points = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (cards[i].rank !== cards[j].rank) continue;
      points += PAIR;
      if (out) out.push({ kind: 'pair', points: PAIR, cards: [cardKey(cards[i]), cardKey(cards[j])] });
    }
  }
  return points;
}

/**
 * RUNS, INCLUDING THE DOUBLE RUN, WITHOUT ENUMERATING ANYTHING.
 *
 * The rule players actually use is multiplicative: find each maximal stretch of
 * consecutive ranks present, and if it is three or more long it scores its
 * LENGTH once per distinct way of choosing one card per rung. A double run of
 * three (5-6-6-7) is 3 × 2 = 6; a double-double (5-6-6-7-7) is 3 × 2 × 2 = 12;
 * a triple run is 3 × 3 = 9.
 *
 * Only maximal stretches count, which is what stops 4-5-6-7 being scored as two
 * runs of three as well as one of four.
 */
function runsOf(cards, orderOf, out) {
  // The distinct rungs occupied, ascending, with how many cards sit on each.
  // A plain pair of small arrays rather than a Map: five cards is an insertion
  // sort's whole natural habitat, and this runs thirteen million times in the
  // distribution test.
  const rungs = [];
  const many = [];
  for (const card of cards) {
    const rung = orderOf(card);
    if (!Number.isInteger(rung) || rung < 0) continue;
    let at = rungs.length;
    while (at > 0 && rungs[at - 1] > rung) at--;
    if (at > 0 && rungs[at - 1] === rung) {
      many[at - 1]++;
      continue;
    }
    rungs.splice(at, 0, rung);
    many.splice(at, 0, 1);
  }

  let points = 0;
  let start = 0;
  for (let i = 0; i <= rungs.length; i++) {
    const breaks = i === rungs.length || rungs[i] !== rungs[i - 1] + 1;
    if (i > start && breaks) {
      const length = i - start;
      if (length >= 3) {
        let ways = 1;
        for (let k = start; k < i; k++) ways *= many[k];
        points += length * ways;
        if (out) {
          const lo = rungs[start];
          const hi = rungs[i - 1];
          out.push({
            kind: 'run',
            points: length * ways,
            cards: cards.filter((card) => {
              const rung = orderOf(card);
              return rung >= lo && rung <= hi;
            }).map(cardKey),
          });
        }
      }
      start = i;
    }
  }
  return points;
}

/**
 * THE FLUSH, AND THE ONE ASYMMETRY IN THE WHOLE TABLE.
 *
 * Four cards of a suit in the HAND score four, and five score five. In the
 * CRIB, four score nothing at all: the crib is made of two players' throwaways,
 * so a four-card crib flush is an accident rather than a holding, and only the
 * five-card version — starter included — counts.
 *
 * Suitless cards (a joker in some other pack's deck) never flush.
 */
function flushOf(hand, starter, isCrib, out) {
  const suit = hand[0]?.suit;
  if (!suit || !hand.every((card) => card.suit === suit)) return 0;
  const withStarter = starter?.suit === suit;
  if (isCrib && !withStarter) return 0;
  const points = HAND_FLUSH + (withStarter ? 1 : 0);
  if (out) {
    out.push({
      kind: 'flush',
      points,
      cards: [...hand, ...(withStarter ? [starter] : [])].map(cardKey),
    });
  }
  return points;
}

/** His nobs: a jack in HAND (never the starter) of the starter's suit. */
function nobsOf(hand, starter, isNobs, out) {
  if (!starter?.suit) return 0;
  for (const card of hand) {
    if (!isNobs(card) || card.suit !== starter.suit) continue;
    if (out) out.push({ kind: 'nobs', points: NOBS, cards: [cardKey(card)] });
    return NOBS;
  }
  return 0;
}

/**
 * What four cards and a starter are worth at the show.
 *
 * @param cards   the four held cards (the crib, when `isCrib`)
 * @param starter the cut card, or null — with no starter this scores the four
 *                on their own, which is what the play phase's own scorer needs.
 * @param opts    { isCrib, valueOf, orderOf, isNobs } — see the file header.
 * @returns { total, breakdown } — `breakdown` is omitted work when `parts` is
 *          false, which is how the distribution sweep and the bot afford it.
 */
export function scoreHand(cards, starter, opts = {}) {
  const {
    isCrib = false,
    valueOf,
    orderOf,
    isNobs = defaultIsNobs,
    parts = true,
  } = opts;
  if (typeof valueOf !== 'function' || typeof orderOf !== 'function') {
    throw new Error('scoreHand needs valueOf and orderOf — see src/templates/cribbage-score.js');
  }

  const hand = (cards || []).filter(Boolean);
  const all = starter ? [...hand, starter] : hand.slice();
  const breakdown = parts ? [] : null;

  const total = fifteensOf(all, valueOf, breakdown)
    + pairsOf(all, breakdown)
    + runsOf(all, orderOf, breakdown)
    + flushOf(hand, starter, isCrib, breakdown)
    + nobsOf(hand, starter, isNobs, breakdown);

  return breakdown ? { total, breakdown } : { total };
}

/* ------------------------------------------------------------------ *
 * What the parts are CALLED
 * ------------------------------------------------------------------ */

/**
 * WHAT ONE PART OF A SCORE IS CALLED OUT LOUD.
 *
 * Every scoring event in this game carried its breakdown from the day it
 * shipped and the felt said only the total, so a fifteen, a pair and a run all
 * read "Nell pegs 2" — three completely different things to have happen to you
 * (#124, item 41). These are the words a cribbage player uses; they are the
 * whole reason the game has a vocabulary at all.
 *
 * HERE RATHER THAN IN THE TEMPLATE because there are now two surfaces printing
 * them — the banner sentence (src/templates/cribbage.js) and the show card
 * (src/ui/showCard.js, #152) — and a `kind` this file can emit and neither of
 * them can name is a hole that only shows up on the felt. The names belong with
 * the thing that names the kinds.
 *
 * `n` is the number of CARDS in the part, which is what separates a pair from a
 * pair royal and sizes a run. It arrives as `part.n` from a wire event
 * (cribbage.js's `partsOf`) and as `part.cards.length` from a breakdown, so
 * both are accepted.
 */
export function partPhrase(part) {
  const n = part?.n ?? part?.cards?.length ?? 0;
  switch (part?.kind) {
    case 'fifteen': return 'fifteen';
    case 'thirty-one': return 'thirty-one';
    // Three of a kind is a pair royal and four is a double pair royal — six and
    // twelve holes. Calling either of them "a pair" undersells the hand badly.
    case 'pair': return n >= 4 ? 'double pair royal' : n === 3 ? 'pair royal' : 'a pair';
    case 'run': return `a run of ${n}`;
    case 'flush': return `a flush of ${n}`;
    // The one this pack puts in its own tagline and had never once printed.
    case 'nobs': return 'his nobs';
    default: return null;
  }
}

/** The breakdown as one clause: "fifteen, fifteen and a pair". */
export function namedParts(parts) {
  return joinParts((parts || []).map(partPhrase).filter(Boolean));
}

/**
 * THE SAME CLAUSE WITH THE ARITHMETIC IN IT: "fifteen for 2 and a pair for 2".
 *
 * For the play, where there is no card to draw and the banner is the whole of
 * what the player gets (#152). "Nell pegs 4 — fifteen and a pair" left the four
 * to be divided up by the reader, which is the one sum a cribbage player is
 * doing out loud anyway.
 *
 * ONE PART KEEPS THE PLAIN PHRASE, because the total has already said what it
 * is worth: "You peg 2 — a pair for 2 — the count is 8" says two twice.
 */
export function scoredParts(parts) {
  const list = (parts || []).filter((part) => partPhrase(part));
  if (list.length < 2) return namedParts(list);
  return joinParts(list.map((part) => `${partPhrase(part)} for ${part.points ?? 0}`));
}

/** "a", "a and b", "a, b and c" — the one list style the felt uses. */
function joinParts(words) {
  if (!words.length) return '';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/* ------------------------------------------------------------------ *
 * The play, which is a different scorer entirely
 * ------------------------------------------------------------------ */

/**
 * What the card just laid scores AS IT LANDS — the pegging half of the game.
 *
 * Deliberately not `scoreHand` with a shorter list. The play scores a SEQUENCE:
 * fifteen and thirty-one are facts about the running total rather than about a
 * subset, pairs count only backwards from the card just played, and a run may
 * be made in any order but only out of an unbroken tail of the pile. Trying to
 * express that as a hand would get every one of them wrong.
 *
 * @param played  the cards on the table this count, oldest first, INCLUDING the
 *                one just laid.
 * @param opts    { valueOf, orderOf, parts }
 * @returns { total, count, breakdown } — `count` is the running total after it.
 */
export function scorePlay(played, opts = {}) {
  const { valueOf, orderOf, parts = true } = opts;
  if (typeof valueOf !== 'function' || typeof orderOf !== 'function') {
    throw new Error('scorePlay needs valueOf and orderOf — see src/templates/cribbage-score.js');
  }
  const breakdown = parts ? [] : null;
  const count = played.reduce((sum, card) => sum + valueOf(card), 0);
  let total = 0;

  if (count === 15) {
    total += FIFTEEN;
    if (breakdown) breakdown.push({ kind: 'fifteen', points: FIFTEEN, cards: played.map(cardKey) });
  }
  if (count === 31) {
    total += 2;
    if (breakdown) breakdown.push({ kind: 'thirty-one', points: 2, cards: played.map(cardKey) });
  }

  // Pairs count BACKWARDS from the card just laid: three of a kind is a pair
  // royal (6) because it makes three pairs, not one.
  const last = played[played.length - 1];
  let same = 0;
  for (let i = played.length - 2; i >= 0; i--) {
    if (played[i].rank !== last?.rank) break;
    same++;
  }
  if (same > 0) {
    const points = same * (same + 1); // 1→2, 2→6, 3→12: 2 × pairs made
    total += points;
    if (breakdown) breakdown.push({ kind: 'pair', points, cards: played.slice(-(same + 1)).map(cardKey) });
  }

  // A run in the play is the LONGEST unbroken tail of the pile whose ranks are
  // consecutive in some order and all distinct. 5-4-6 is a run of three;
  // 5-4-5-6 is not, because the tail that would make it has two fives in it.
  for (let length = played.length; length >= 3; length--) {
    const tail = played.slice(-length);
    const rungs = tail.map(orderOf);
    if (rungs.some((r) => !Number.isInteger(r) || r < 0)) continue;
    const distinct = new Set(rungs);
    if (distinct.size !== length) continue;
    if (Math.max(...rungs) - Math.min(...rungs) !== length - 1) continue;
    total += length;
    if (breakdown) breakdown.push({ kind: 'run', points: length, cards: tail.map(cardKey) });
    break;
  }

  return breakdown ? { total, count, breakdown } : { total, count };
}
