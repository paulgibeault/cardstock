// Generic bot: enumerate legal moves via the template, score each with the template's
// heuristic (or a flat fallback), play the best. Also the basis for hints and the
// headless simulation harness (design doc §10).
//
// PERSONALITY IS A LENS, NOT A SECOND BRAIN. The template's `botHeuristic` still
// decides what a good move IS — it is the only thing that knows a Hearts lead
// from a Skip-Bo build — and a persona (src/players/roster.js) only shapes how
// that ranking is consumed: a tilt toward committing or holding, and a chance
// of settling for the runner-up. A personality therefore cannot invent a move,
// skip validation, or prefer something illegal; the worst it can do is play
// second-best, which is exactly what a distractible opponent does.
//
// SCALE-FREE BY CONSTRUCTION. Heuristics have wildly different ranges —
// shedding scores 1.0–1.5, trick-taking −17–0 — so the tilt is expressed as a
// fraction of the SPREAD of this turn's own scores rather than as a fixed
// number of points. A tilt worth "a quarter of the gap between the best and
// worst move here" means the same thing in both games; +0.3 does not.
//
// AND IT IS A TIE-BREAKER, NOT AN OVERRIDE — deliberately, and worth saying
// plainly because the numbers look timid otherwise. A tilt big enough to make
// a "patient" bot draw while holding an obviously good card would not read as
// patient; it would read as broken, and an opponent who throws games is not
// one worth beating. So the tilt decides between moves the heuristic already
// rates as close, and `mistakeRate` is where visible fallibility actually
// comes from. The tests pin exactly this, in both directions.
//
// DETERMINISM. `chooseBotMove(state, seat)` with no options is exactly what it
// always was: no randomness, first-best wins ties. That is what keeps
// tools/simulate.mjs and the rule tests reproducible. Randomness only enters
// when a caller passes a persona, and it lives OUTSIDE the reducer — replay
// re-applies the logged move and never re-runs this function, so a bot's coin
// flips can never desync a resumed match.

// ONE PLY, WHERE THE TEMPLATE OFFERS TO JUDGE A POSITION. `botHeuristic` scores
// a MOVE — "a discard with no hand-mates is cheap to lose" — which cannot say
// the thing that actually decides a rummy turn: "and it leaves me one card off
// the contract". A template that exports `evaluateState` gets each of its legal
// moves played out on a throwaway fork (src/engine/fork.js) and the resulting
// POSITION scored instead. Templates without the hook are untouched.
//
// Everything below the scorer is unchanged by that. The persona tilt and
// `mistakeRate` still operate on the ranked list, the no-persona path is still
// the plain deterministic chooser, and the determinism contract above still
// holds verbatim: a fork is seeded from the source's own RNG position, so
// forking and applying consume no randomness the original would have seen.

import { legalMovesFor, applyMove } from './movePipeline.js';
import { makeCtx } from './context.js';
import { forkState } from './fork.js';
import { visibleCardIds } from './view.js';

function defaultHeuristic(ctx, move) {
  return move.type === 'draw' ? -1 : 1;
}

/**
 * A CEILING ON THE WORK ONE DECISION MAY DO, not a tuning knob — the moves
 * beyond it are ranked by the cheap heuristic and never forked.
 *
 * One ply is a fork plus a full `applyMove` per candidate, and contract-rummy is
 * the template that could make that hurt: once seats have laid down, its
 * enumerator offers every (meld × hand-card × wild-value) hit it can find, and
 * `movePipeline.js` calls it the costliest enumeration in the repo.
 *
 * MEASURED RATHER THAN ASSUMED, and the measurement is why this number is high
 * enough to be invisible. Across sixty games per configuration, the widest turn
 * any pack offers is 17 moves at four-handed Milestones and 23 at six-handed —
 * one turn in three thousand and twenty-three in three thousand respectively —
 * and Hearts, Crazy Eights and Wildfire never pass fifteen. Phase 1 is why: the
 * hands that used to enumerate for hundreds of moves were the live-locked ones.
 * Removing the cap entirely changes `npm test` by about 0.15s on 7.0, which is
 * noise, so this buys nothing today and exists for the pack that deals sixteen
 * cards to eight seats.
 *
 * Sixteen because it is above every width measured for the seat counts the
 * packs are actually played at, so the shortlist is a backstop rather than
 * something ordinary play runs into.
 */
const LOOKAHEAD_WIDTH = 16;

/** Moves that decline to commit a card. Persona `patience` speaks to these. */
const HOLDING_MOVES = new Set(['draw', 'pass']);

/** How much of the score spread a full point of aggression/patience is worth. */
const TILT_SHARE = 0.25;

/**
 * ONE PLY IS NOT ALLOWED TO TURN THE DECK OVER — the trap that makes this
 * function longer than it looks like it should be.
 *
 * Playing a move out on a fork produces a REAL position, dealt from the real
 * shuffle, and `chooseBotMove` is handed the whole state (tools/simulate.mjs
 * says so in as many words). So "draw from the deck, then score the hand you
 * ended up with" is a bot reading the top of a face-down pile before deciding
 * whether to take it — and it is not a subtle failure. Milestones went straight
 * back to the live-lock Phase 1 had just fixed: the deck's top card never
 * changes while nobody draws it, so a seat that judged it once as worse than
 * the face-up pile judged it that way forever, and four seats doing that
 * circulate the same forty cards until the move cap.
 *
 * The rule is therefore the entitlement rule, asked forward in time: if the
 * fork turned up a card `seat` could not see beforehand, that outcome was not
 * knowable and the move cannot be judged by it. This is Phase 3's fairness
 * criterion arriving a phase early because the alternative did not work.
 */
function revealsHiddenCards(before, fork, seat) {
  for (const id of visibleCardIds(fork, seat)) {
    if (!before.has(id)) return true;
  }
  return false;
}

/**
 * Score each move by the position it leaves behind, or say it could not.
 *
 * `null` means "score this turn with `botHeuristic` instead", and it is the
 * answer whenever the candidates cannot be put on one scale — mixing a position
 * score with a move score would rank moves by which scorer happened to reach
 * them.
 *
 * BANDS, ON ONE SCALE. Everything the evaluator scored sits at face value; a
 * clear spread above and below it are the moves it could not score.
 *
 * ABOVE: the moves that ENDED THE ROUND inside `applyMove`. The pipeline has
 * already scored the hand and dealt the next one by the time we could look, so
 * there is no position left to judge — and the honest reading is that the seat
 * went out, because in every template here a round ends through
 * `ctx.endRound(seat)` fired by the acting seat emptying its own hand, or on the
 * last card of a hand where it was the only legal move.
 *
 * BELOW: the moves the shortlist never reached, left in the cheap heuristic's
 * own order — what they would have had with no lookahead at all — and, beside
 * them, the moves with a HIDDEN outcome that the cheap heuristic had ALREADY
 * rated below everything the evaluator scored. Lookahead may reorder the moves
 * it can see the consequences of; it may not overturn the heuristic's verdict
 * on a move it cannot. Anything else — a hidden move the heuristic rated among
 * or above the scored ones — has no honest place on this scale and the whole
 * turn falls back instead.
 *
 * That one line is what gives shedding a lookahead at all: `mustPlayIfAble` is
 * false in both its packs, so a draw is legal on EVERY turn and a rule of "any
 * hidden move means fall back" would mean the hook never ran. `botHeuristic`
 * already rates a draw below every play, so the evaluator sorts the plays and
 * the draw stays where it was put.
 */
function scoreByLookahead(state, seat, moves, ctx, heuristic, evaluate) {
  const cheap = moves.map((move) => heuristic(ctx, move));
  const shortlist = moves.map((move, i) => i);
  if (moves.length > LOOKAHEAD_WIDTH) {
    shortlist.sort((a, b) => cheap[b] - cheap[a] || a - b);
    shortlist.length = LOOKAHEAD_WIDTH;
  }

  const before = visibleCardIds(state, seat);
  const values = new Map();
  const terminal = new Set();
  const hidden = [];
  let lo = Infinity;
  let hi = -Infinity;
  let cheapLo = Infinity;
  for (const i of shortlist) {
    const fork = forkState(state);
    // A move off the enumerator is legal by construction, so this cannot throw
    // for any template in the repo. Guarded anyway, and conservatively: a bot
    // that crashes the table is a worse failure than one that spends a turn on
    // its cheap heuristic.
    try {
      applyMove(fork, moves[i]);
    } catch {
      return null;
    }
    if (fork.roundNumber !== state.roundNumber || fork.gameOver) {
      terminal.add(i);
      continue;
    }
    if (revealsHiddenCards(before, fork, seat)) {
      hidden.push(i);
      continue;
    }
    const value = evaluate(makeCtx(fork), seat);
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    values.set(i, value);
    if (value < lo) lo = value;
    if (value > hi) hi = value;
    if (cheap[i] < cheapLo) cheapLo = cheap[i];
  }
  if (values.size === 0) return null;

  for (const i of hidden) {
    if (cheap[i] >= cheapLo) return null;
  }

  const band = hi - lo || 1;
  // Built in enumeration order, so the stable sort below leaves equally scored
  // moves — every unreached move, and every round-ending one — in the order the
  // template offered them. Contract-rummy's enumeration order is itself
  // strategy (see its enumerateLegalMoves), and this is what preserves it.
  return moves.map((move, i) => ({
    move,
    score: terminal.has(i) ? hi + band : (values.get(i) ?? lo - band),
  }));
}

/**
 * Rank every legal move for `seat`, best first.
 *
 * Exported because the ranking is useful on its own: the hint system wants the
 * top entry, and the tests want to assert that a persona reordered the list
 * without having to run the chooser's coin flips.
 *
 * @returns Array<{ move, score }> — a fresh array, safe to mutate.
 */
export function rankMoves(state, seat, { persona = null } = {}) {
  const moves = legalMovesFor(state, seat);
  if (moves.length === 0) return [];
  const ctx = makeCtx(state);
  const heuristic = state.pack.template.botHeuristic || defaultHeuristic;
  const evaluate = state.pack.template.evaluateState;

  const scored = (evaluate && scoreByLookahead(state, seat, moves, ctx, heuristic, evaluate))
    || moves.map((move) => ({ move, score: heuristic(ctx, move) }));
  if (persona) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const entry of scored) {
      if (entry.score < lo) lo = entry.score;
      if (entry.score > hi) hi = entry.score;
    }
    const spread = hi - lo;
    // Every move scored the same: there is nothing for a tilt to reorder, and
    // scaling by a zero spread would be a no-op anyway.
    if (spread > 0) {
      const unit = spread * TILT_SHARE;
      for (const entry of scored) {
        const bias = HOLDING_MOVES.has(entry.move.type)
          ? (persona.patience ?? 1) - 1
          : (persona.aggression ?? 1) - 1;
        entry.score += bias * unit;
      }
    }
  }

  // Stable sort (V8's is): equal scores keep enumeration order, which is what
  // preserves the no-persona path's exact historical behaviour.
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * The move this seat plays.
 *
 * @param opts.persona a src/players/roster.js persona, or null for the plain
 *                     deterministic chooser
 * @param opts.random  injectable for tests; only consulted with a persona
 */
export function chooseBotMove(state, seat, { persona = null, random = Math.random } = {}) {
  const ranked = rankMoves(state, seat, { persona });
  if (ranked.length === 0) return null;
  if (!persona || ranked.length === 1) return ranked[0].move;

  // A mistake is a NEAR-miss, not a random flail: the runner-up, or the one
  // after it. A bot that occasionally plays the third-best card reads as
  // distracted; one that plays the worst card available reads as broken.
  const mistakeRate = persona.mistakeRate ?? 0;
  if (mistakeRate > 0 && random() < mistakeRate) {
    const alternatives = ranked.slice(1, 3);
    return alternatives[Math.floor(random() * alternatives.length)].move;
  }
  return ranked[0].move;
}
