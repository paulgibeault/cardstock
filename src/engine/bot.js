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
// tools/simulate.mjs and the rule tests reproducible. Randomness enters only
// when a caller asks for it — a persona, or the `hard` difficulty's samples —
// and it lives OUTSIDE the reducer, on an injectable `random` rather than on
// `state.rng`. Replay re-applies the logged move and never re-runs this
// function, so a bot's coin flips can never desync a resumed match.
// tests/rollouts.test.js pins the no-options path by making Math.random throw.

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

// DIFFICULTY IS DEPTH; PERSONA IS STILL STYLE. `easy` is the heuristic and the
// persona's mistakes — the bot this game shipped with. `medium` adds the one
// ply above. `hard` samples: it deals itself worlds consistent with what the
// seat knows (src/engine/determinize.js) and plays each candidate out to the
// end of the hand in each of them.
//
// The two dials are deliberately orthogonal. A reckless expert and a patient
// beginner are both people you have played cards with, and collapsing them into
// one "skill" slider would have made every hard opponent feel the same.
//
// BUDGET, NOT DEPTH, is how `hard` is capped — a wall-clock ceiling AND a
// simulated-move ceiling, either of which ends the sampling. Which of the two
// binds depends entirely on the pack (contract-rummy's enumerator is the
// costliest call in the repo), and that is the point: nothing here has to know
// which pack is on the table to spend the same amount of effort on it.

import { legalMovesFor, enumerateLegalMoves, applyMove } from './movePipeline.js';
import { makeCtx } from './context.js';
import { forkState } from './fork.js';
import { determinizeState } from './determinize.js';
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

/** The depth dial. Anything else a caller passes is read as the default. */
export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);

/**
 * MEDIUM IS THE DEFAULT AND HAS TO BE, because `chooseBotMove(state, seat)`
 * with no options is a contract: tools/simulate.mjs, the rule tests and the
 * turn-timeout takeover all call it that way and all require the same move back
 * every time. `hard` needs randomness, so it can never be what a caller who
 * asked for nothing gets.
 */
const DEFAULT_DIFFICULTY = 'medium';

function normalizeDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : DEFAULT_DIFFICULTY;
}

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
function scoreByLookahead(state, seat, moves, cheap, evaluate) {
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

/* ------------------------------------------------------------------ *
 * Flat Monte Carlo — `hard`
 * ------------------------------------------------------------------ */

/**
 * How many candidates get rolled out at all.
 *
 * Narrower than the one-ply shortlist (16) because a rollout costs a whole hand
 * rather than a single move, and a sample budget spent on the ninth-best
 * discard is a sample not spent separating the first from the second. The rest
 * keep the cheap heuristic's own order underneath, exactly as the one-ply
 * shortlist leaves them.
 */
const ROLLOUT_WIDTH = 8;

/**
 * A single rollout may not play more than one hand's worth of moves.
 *
 * The worst Milestones round out of five thousand finishes in 147 moves and a
 * rollout starts MID-hand, so this is roughly double the longest thing it can
 * legitimately be asked to do. It is a live-lock detector, not a tuning knob:
 * a rollout that hits it produced no information and is thrown away, which is
 * the same answer tools/simulate.mjs's cap gives for the same reason.
 */
const ROLLOUT_MOVE_CAP = 300;

/**
 * HOW FAR A ROLLOUT PLAYS BEFORE IT ASKS THE TEMPLATE WHERE IT GOT TO, and the
 * variance-reduction the whole `hard` bot was failing on without it.
 *
 * Playing to the end of the hand and reading the round score is the truthful
 * signal, and mid-hand it is almost all noise. A Milestones round takes a
 * hundred and forty moves to finish, so a terminal score sampled from move
 * twenty is mostly a measurement of the DEAL — of which cards the sampler
 * happened to hand out — and the candidate move being judged contributes a
 * sliver of it. The budget affords about sixty samples split across up to eight
 * candidates, so an argmax over that was reading seven noisy numbers each and
 * losing to the cheap heuristic it was supposed to be improving on: measured
 * 41–48% of hands against `easy`, which is a difficulty dial that plays WORSE
 * turned up.
 *
 * Cutting the rollout off and asking `evaluateState` instead trades a little
 * bias for a great deal of variance, which is the right trade at this sample
 * count. Swept at 200 rounds a side, under the reproducible budget: 8 moves is
 * too short to see a lay-down coming, and everything from 16 upward converges,
 * so this is the shallowest depth that had stopped improving — shallow being
 * worth having, because a shorter rollout is a cheaper one and the budget buys
 * samples with what it saves.
 *
 * A TEMPLATE WITH NO `evaluateState` IS NOT TRUNCATED AT ALL. There is nothing
 * to ask, so it plays to the end exactly as it did before — Stockpile's
 * sequencing pack is the one in the repo, and it falls back to one ply for its
 * own reasons anyway (it declares no round scoring, so every rollout of it ends
 * on the same number).
 */
const ROLLOUT_DEPTH = 16;

/**
 * THE THINK WINDOW IS THE BUDGET, and it is capped from both ends.
 *
 * `ms` is what a decision may spend on the wall clock, and on every pack but
 * the cheapest it is the cap that actually binds. The tightest window the game
 * schedules is the reckless persona's 240 ms at the default `botDelayMs` of 600
 * (src/players/roster.js), and the decision happens AFTER that timer fires — so
 * it is ADDED to the pause rather than hidden inside it. 120 ms keeps the
 * slowest hard turn shorter than the fastest bot's own thinking pause, which is
 * the bar that matters: nobody should be able to tell which opponent is the
 * strong one by how long it sits there. Measured worst case at that setting is
 * about 130 ms, on four-handed Milestones.
 *
 * `moves` is the same ceiling expressed in simulated moves, and it is what a
 * caller that needs the SAME ANSWER TWICE uses: pass `budgetMs: Infinity` and
 * the sampling depends on nothing but this cap and the caller's RNG. The
 * fairness gate does exactly that, with a much smaller cap of its own.
 *
 * The two are not interchangeable and deliberately so. A simulated move costs
 * about ten times as much in contract-rummy as in shedding — `movePipeline.js`
 * calls its enumeration the costliest in the repo — so no single move count is
 * 120 ms in every pack. 40,000 is roughly 120 ms in the CHEAPEST one, which
 * makes it a backstop everywhere else rather than the thing deciding how well
 * the bot plays. Tuning it down to "120 ms on the dearest pack" is the tempting
 * symmetry and it was measured: it starves Crazy Eights to sixty-odd samples,
 * and hard stops beating easy at all.
 */
const ROLLOUT_BUDGET_MS = 120;
const ROLLOUT_BUDGET_MOVES = 40000;

/**
 * A hard ceiling on samples, so a trivially cheap position stops eventually.
 *
 * High enough to sit near the budget rather than under it — Crazy Eights, the
 * cheapest pack that samples at all, averages 379 of these four hundred per
 * decision — and present because a two-card endgame would otherwise spin out
 * the whole budget re-proving the same two rollouts.
 */
const MAX_SAMPLES = 400;

/**
 * HOW SURE THE SAMPLE HAS TO BE BEFORE IT MAY OVERRULE THE CHEAPER RANKING,
 * counted in standard errors of the gap between the best candidate and the
 * runner-up.
 *
 * The failure this exists to stop is specific and it is not "the bot plays a
 * slightly worse move". Sixty-odd samples split across eight candidates is
 * seven apiece, and an argmax over eight noisy sevens does not return a good
 * move — it returns whichever candidate got lucky, which is uncorrelated with
 * quality and therefore strictly worse than the one-ply ordering it displaced.
 * That is how a difficulty dial ends up playing WORSE turned up.
 *
 * So the sampler has to earn the right to reorder. If the gap it found is
 * inside its own noise it says nothing at all and the turn falls back to one
 * ply — the same fallback a starved budget already takes, down the same road.
 *
 * PAIRED, WHICH IS THE ONLY REASON THIS IS AFFORDABLE. Every candidate is
 * measured in the SAME worlds, so the quantity being tested is the per-sweep
 * DIFFERENCE between two moves rather than the difference of two independent
 * averages. The deal cancels out of that difference, and its spread is a small
 * fraction of the spread of either candidate on its own — which is what makes a
 * seven-sample decision able to clear the bar at all.
 *
 * AND IT IS DELIBERATELY NOT A SIGNIFICANCE TEST, whatever it looks like. The
 * best and the runner-up are chosen by the same data the test then reads, so
 * the bar is optimistically biased and a real statistician would want a
 * correction. It is not trying to publish; it is trying to separate "the sample
 * has an opinion" from "the sample has a coin". One standard error is where the
 * measured behaviour turns: see IMPLEMENTATION_NOTES.md for the sweep.
 */
const SAMPLE_CONFIDENCE = 1;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * How far along the MATCH `seat` is, on the template's own scale.
 *
 * A template that exports `matchStanding` (src/templates/CONTRACT.md) answers
 * this itself, and contract-rummy is why the hook exists: a Milestones match
 * is won by laying the tenth contract down, and the round score — the cards
 * you were caught holding — never decides it. A bot steering by round score
 * there optimises a scoreboard (#92).
 *
 * WITHOUT THE HOOK, THE STANDING IS THE ACCUMULATED SCORE, signed by the one
 * manifest field that says which way is up. Points are not universally good:
 * Crazy Eights hands the round's whole pot to whoever went out
 * (`winner: 'highestScore'`), Hearts counts them against you. A pack that says
 * nothing is assumed to be counting penalties, which is the commoner shape and
 * the safer guess. Differenced across a round (below) this is exactly the
 * round score, so a template without the hook is scored as it always was.
 *
 * @returns a finite number, or null for a template whose hook had no answer
 */
function standingOf(state, seat) {
  const hook = state.pack.template.matchStanding;
  if (hook) {
    const value = hook(makeCtx(state), seat);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  const scoring = state.pack.scoring || state.pack.manifest?.scoring || {};
  const sign = scoring.gameOver?.winner === 'highestScore' ? 1 : -1;
  return sign * (Number(state.scores?.[seat] ?? 0) || 0);
}

/**
 * How a finished hand turned out for `seat`: how much further along the match
 * it left the seat, against how much further along it left everyone else.
 *
 * A DIFFERENCE ACROSS THE ROUND, not a reading of the final position. The
 * rollout began at `before` and ended at `after`, one round boundary later,
 * and what the candidate move is answerable for is the change — a seat that
 * was already three rungs clear is three rungs clear under every candidate,
 * and that term would cancel out of the comparison anyway.
 *
 * RELATIVE, NOT ABSOLUTE. A rollout is compared against other rollouts of the
 * same position, so what matters is the MARGIN over the other seats rather than
 * the raw total: "I went out and left them holding forty" and "I went out and
 * left them holding four" are different outcomes and an absolute own-score
 * would call the first of them identical to the second in Hearts. Under a
 * ladder it is the same reading: going out before the opponent lays down is
 * worth a rung they did not get.
 *
 * @returns null when the template's standing had no answer for some seat —
 *          the same "this rollout produced no information" the caller already
 *          handles for the evaluator.
 */
function terminalValue(before, after, seat) {
  let own = null;
  let others = 0;
  let n = 0;
  for (let s = 0; s < after.seats; s++) {
    const was = standingOf(before, s);
    const now = standingOf(after, s);
    if (was === null || now === null) return null;
    if (s === seat) {
      own = now - was;
    } else {
      others += now - was;
      n += 1;
    }
  }
  return own - (n ? others / n : 0);
}

/**
 * Play `move` out in `world`, then let the cheap chooser finish the hand.
 *
 * THE ROLLOUT POLICY IS THE CHEAP ONE, deliberately. This is
 * tools/simulate.mjs's `playOne` loop started mid-game — the same actingSeats
 * question, the same "a round ended when the event window says so" reading —
 * and using `easy` for it rather than `medium` is what pays for the sample
 * count. A rollout does not have to play well; it has to play PLAUSIBLY and
 * cheaply, many times.
 *
 * `enumerate` is the exact, uncached enumerator throughout, because a
 * determinized world has had its zones rewritten in place — the one thing
 * `legalMovesFor`'s memo key cannot see (src/engine/fork.js's header).
 *
 * @returns a run — `{ sim, played, finished }` — or null for a rollout that
 *          produced no information (it stalled, it threw, or it wandered into
 *          the live-lock cap). A run that came back UNFINISHED was cut off at
 *          `depth` and is the caller's to either evaluate or resume.
 */
function rollout(world, move, seat, spent, depth) {
  const sim = forkState(world);
  try {
    applyMove(sim, move);
  } catch {
    return null;
  }
  spent.moves += 1;
  const run = { sim, played: 0, finished: sim.events.some((e) => e.type === 'roundOver') };
  return advance(run, spent, depth) ? run : null;
}

/**
 * Carry a run forward until the hand ends, `depth` moves have been played, or
 * it becomes clear the hand is never going to end.
 *
 * SEPARATE FROM `rollout` BECAUSE A TRUNCATED RUN CAN BE ASKED TO CONTINUE.
 * `scoreByRollout` resumes the ones it cut off whenever cutting them off would
 * have left two candidates on different scales — see its header.
 *
 * @returns false for a run that produced no information; true for one that
 *          either finished or stopped at the depth it was given.
 */
function advance(run, spent, depth) {
  const sim = run.sim;
  const template = sim.pack.template;
  while (!run.finished && !sim.gameOver && run.played < ROLLOUT_MOVE_CAP) {
    if (run.played >= depth) return true;
    const acting = template.actingSeats ? template.actingSeats(makeCtx(sim)) : [sim.turn.seat];
    let next = null;
    for (const s of acting) {
      next = chooseBotMove(sim, s, { difficulty: 'easy', enumerate: enumerateLegalMoves });
      if (next) break;
    }
    if (!next) return false;
    try {
      applyMove(sim, next);
    } catch {
      return false;
    }
    run.played += 1;
    spent.moves += 1;
    if (sim.events.some((e) => e.type === 'roundOver')) run.finished = true;
  }
  return run.finished;
}

/**
 * What one rollout came to, in whichever of the two currencies applies.
 *
 * A FINISHED HAND IS ALWAYS READ FROM THE STANDING, never from the evaluator.
 * The round is over; there is no position left to have an opinion about, and
 * the pack has already said what happened — in rungs, or in points.
 *
 * @param before the position the rollout started from, for the difference
 *               `terminalValue` takes across the round
 * @returns null when the template's evaluator or standing returned something
 *          that is not a number, which is the same "this turn cannot be ranked
 *          this way" answer the one-ply scorer gives.
 */
function valueOf(run, before, seat, evaluate) {
  if (run.finished) return terminalValue(before, run.sim, seat);
  const value = evaluate(makeCtx(run.sim), seat);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Score each move by how the hand tends to END after it, or say it could not.
 *
 * ONE WORLD PER SWEEP, SHARED BY EVERY CANDIDATE. The sample is drawn once and
 * all the candidates are tried in it, which is both cheaper and fairer: two
 * moves compared in the same deal differ by the move, and two moves compared in
 * different deals differ by the deal. It also makes the ordering honest — the
 * world is dealt without reference to which move is about to be played in it.
 *
 * AND SWEEPS ARE ALL-OR-NOTHING. Averaging a candidate that got four samples
 * against one that got three is a bias toward whichever happened to be
 * enumerated first, so a sweep interrupted by the budget is discarded whole. A
 * sweep that cannot finish at all — the very first one — means the budget does
 * not cover one rollout per candidate, and the whole turn falls back to one ply.
 *
 * TWO CURRENCIES, AND THE ONE RULE THAT KEEPS THEM FROM BEING ADDED UP. A
 * rollout that reached the end of the hand is worth what it did to the seat's
 * standing in the match (`terminalValue` — the round score, unless the
 * template says the match is about something else); one that was cut off at
 * `depth` is worth what `evaluateState` says the position is.
 * Those are different units — Milestones points against an arbitrary
 * per-template scale — and averaging them together builds a bot that prefers
 * whichever way the rollout happened to end, which is a bias with no meaning at
 * all. Two things keep them apart:
 *
 *   * WITHIN A SWEEP, ONE CURRENCY. Every candidate in a sweep is played in the
 *     same world to the same depth, so they normally agree about whether the
 *     hand ended. When they do NOT — the endgame, where one candidate goes out
 *     and another does not — the truncated ones are RESUMED to the end rather
 *     than evaluated. Truncation is an optimisation, and it is abandoned the
 *     moment it would make two candidates incomparable. It costs little where it
 *     happens, because a hand that one candidate can finish inside `depth` is a
 *     hand with very little of itself left.
 *   * ACROSS SWEEPS, NO CURRENCY AT ALL. Each sweep is centred on its own mean
 *     and divided by its own spread before it is banked, so what a sweep
 *     contributes is "how much better than the alternatives, in units of what
 *     was at stake in this particular world". That is dimensionless, so a sweep
 *     denominated in points and a sweep denominated in position score add up
 *     honestly.
 *
 * THE CENTRING IS ALSO THE POINT, not just the bridge — and it is worth saying
 * plainly, because it fixes the same defect truncation does. A rollout's
 * terminal score is mostly a measurement of the DEAL the sampler dealt: a world
 * where this seat drew well scores high under every candidate. Subtracting the
 * sweep's own mean deletes exactly that term, which is the classic paired
 * comparison — the candidates already share a world, and this is what finally
 * spends that.
 *
 * `null` means "rank this turn some other way", and the zero-spread case is the
 * important one: a pack that declares no scoring at all (Stockpile) gives every
 * rollout the same terminal value, so every sweep has a spread of zero, nothing
 * is ever banked, and a scorer with no opinion says so rather than silently
 * returning every move tied and letting enumeration order decide.
 */
/**
 * Did the sampler actually separate its favourite from the next one along?
 *
 * The test is on the PAIRED per-sweep differences — see SAMPLE_CONFIDENCE — so
 * this reads the banked rows rather than the two averages. `rows` are already
 * centred and scaled per sweep, so the answer is unit-free and the same bar
 * means the same thing in every pack.
 *
 * A SINGLE SWEEP CANNOT SEPARATE ANYTHING. With one row there is no spread to
 * estimate and the honest answer is "no", not "infinitely confident" — the
 * shape of arithmetic bug that would make a starved decision the most decisive
 * one on the table.
 */
function separated(rows, means, confidence) {
  if (confidence <= 0) return true;
  if (rows.length < 2) return false;

  let best = 0;
  for (let k = 1; k < means.length; k++) if (means[k] > means[best]) best = k;
  let next = -1;
  for (let k = 0; k < means.length; k++) {
    if (k === best) continue;
    if (next < 0 || means[k] > means[next]) next = k;
  }
  if (next < 0) return false;

  const gap = means[best] - means[next];
  let variance = 0;
  for (const row of rows) variance += ((row[best] - row[next]) - gap) ** 2;
  // n-1: the mean being subtracted was estimated from these same rows.
  const error = Math.sqrt(variance / (rows.length - 1) / rows.length);
  return gap > confidence * error;
}

function scoreByRollout(state, seat, moves, cheap,
  { random, budgetMs, budgetMoves, depth, confidence }) {
  const shortlist = moves.map((move, i) => i);
  if (moves.length > ROLLOUT_WIDTH) {
    shortlist.sort((a, b) => cheap[b] - cheap[a] || a - b);
    shortlist.length = ROLLOUT_WIDTH;
  }
  // A template with no position evaluator has nothing to be asked at a cut
  // point, so it plays to the end exactly as it did before the depth existed.
  const evaluate = state.pack.template.evaluateState;
  const cut = evaluate ? depth : Infinity;

  // One row per banked sweep, each already centred and scaled. Kept rather than
  // summed because the confidence check below needs the candidates PAIRED — the
  // spread of the difference between two moves in the same world is a far
  // smaller number than the spread of either of them.
  const rows = [];
  const spent = { moves: 0 };
  const started = now();

  for (let sweep = 0; sweep < MAX_SAMPLES; sweep++) {
    const world = determinizeState(state, seat, random);
    const runs = [];
    for (const i of shortlist) {
      const run = rollout(world, moves[i], seat, spent, cut);
      if (!run) break;
      runs.push(run);
      // Checked INSIDE the sweep as well as between sweeps: the first sweep has
      // no measured cost to extrapolate from, and a pack whose every rollout is
      // expensive must be able to give up during it rather than after it.
      if (spent.moves >= budgetMoves || now() - started >= budgetMs) break;
    }
    if (runs.length < shortlist.length) break;

    // The mixed sweep — see the header. Resuming can fail the same ways a
    // rollout can, and a sweep that cannot be put on one scale is discarded
    // whole rather than banked half-converted.
    const finished = runs.filter((run) => run.finished).length;
    if (finished > 0 && finished < runs.length) {
      let resumed = true;
      for (const run of runs) {
        if (!run.finished && !advance(run, spent, Infinity)) { resumed = false; break; }
      }
      if (!resumed) break;
    }

    const values = [];
    for (const run of runs) {
      const value = valueOf(run, state, seat, evaluate);
      if (value === null) break;
      values.push(value);
    }
    if (values.length < runs.length) break;

    let mean = 0;
    for (const value of values) mean += value;
    mean /= values.length;
    let variance = 0;
    for (const value of values) variance += (value - mean) ** 2;
    const sd = Math.sqrt(variance / values.length);
    // A world in which every candidate came out identically has told us
    // nothing, and dividing by its spread would be dividing by zero. It still
    // cost what it cost, so it still counts against the budget.
    if (sd > 0) rows.push(values.map((value) => (value - mean) / sd));

    // One more sweep costs about what the sweeps so far averaged. Stop before
    // the one that would overrun, rather than after it.
    const done = sweep + 1;
    if (spent.moves + spent.moves / done > budgetMoves) break;
    const elapsed = now() - started;
    if (elapsed + elapsed / done > budgetMs) break;
  }
  if (rows.length === 0) return null;

  const means = shortlist.map((_, k) => {
    let total = 0;
    for (const row of rows) total += row[k];
    return total / rows.length;
  });

  let lo = Infinity;
  let hi = -Infinity;
  for (const mean of means) {
    if (mean < lo) lo = mean;
    if (mean > hi) hi = mean;
  }
  if (hi === lo) return null;
  if (!separated(rows, means, confidence)) return null;

  const band = hi - lo;
  const ranked = new Map();
  shortlist.forEach((i, k) => ranked.set(i, means[k]));
  // Enumeration order preserved for the moves the shortlist never reached, so
  // the stable sort below leaves them in the template's own order — which in
  // contract-rummy is itself strategy (see its enumerateLegalMoves).
  return moves.map((move, i) => ({ move, score: ranked.has(i) ? ranked.get(i) : lo - band }));
}

/**
 * Rank every legal move for `seat`, best first.
 *
 * Exported because the ranking is useful on its own: the hint system wants the
 * top entry, and the tests want to assert that a persona reordered the list
 * without having to run the chooser's coin flips.
 *
 * THE THREE SCORERS FALL THROUGH IN ONE DIRECTION ONLY — rollouts to one ply to
 * the cheap heuristic — and each step down is a scorer saying it could not put
 * this turn's candidates on one scale. A hard bot on a position it cannot
 * sample is a medium bot for that turn, which is the right failure: it is
 * quieter than thinking for a second and it is never worse than the bot the
 * player would have had anyway.
 *
 * @param opts.difficulty 'easy' | 'medium' | 'hard'; anything else is medium
 * @param opts.random     injectable `() => [0,1)`; only consulted by `hard`
 * @param opts.budgetMs   wall-clock ceiling for a `hard` decision. Infinity
 *                        makes the decision reproducible — see the budget
 *                        constants above.
 * @param opts.budgetMoves simulated-move ceiling for a `hard` decision
 * @param opts.depth      how far a `hard` rollout plays before it asks
 *                        `evaluateState` where it got to. Infinity plays every
 *                        rollout to the end of the hand, which is what a
 *                        template with no evaluator gets regardless.
 * @param opts.confidence how many standard errors the sampler's favourite must
 *                        beat the runner-up by before it is allowed to reorder
 *                        anything. 0 disables the check — see SAMPLE_CONFIDENCE.
 * @param opts.enumerate  how to ask for the legal moves. Defaults to the memo,
 *                        which is who it was written for; a caller simulating
 *                        on a fork must pass the exact enumerator.
 * @returns Array<{ move, score }> — a fresh array, safe to mutate.
 */
export function rankMoves(state, seat, {
  persona = null,
  difficulty = DEFAULT_DIFFICULTY,
  random = Math.random,
  budgetMs = ROLLOUT_BUDGET_MS,
  budgetMoves = ROLLOUT_BUDGET_MOVES,
  depth = ROLLOUT_DEPTH,
  confidence = SAMPLE_CONFIDENCE,
  enumerate = legalMovesFor,
} = {}) {
  const moves = enumerate(state, seat);
  if (moves.length === 0) return [];
  const ctx = makeCtx(state);
  const heuristic = state.pack.template.botHeuristic || defaultHeuristic;
  const evaluate = state.pack.template.evaluateState;
  const skill = normalizeDifficulty(difficulty);

  const cheap = moves.map((move) => heuristic(ctx, move));
  const scored = (skill === 'hard'
      && scoreByRollout(state, seat, moves, cheap,
        { random, budgetMs, budgetMoves, depth, confidence }))
    || (skill !== 'easy' && evaluate
      && scoreByLookahead(state, seat, moves, cheap, evaluate))
    || moves.map((move, i) => ({ move, score: cheap[i] }));
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
 * @param opts.random  injectable for tests; consulted with a persona, and by
 *                     `hard` for its samples
 * @param opts        everything else is passed straight to `rankMoves`
 */
export function chooseBotMove(state, seat, { persona = null, random = Math.random, ...opts } = {}) {
  const ranked = rankMoves(state, seat, { ...opts, persona, random });
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
