// A THROWAWAY COPY OF A LIVE MATCH — the "what if I played this" state that
// lookahead runs on, and that the caller is free to wreck.
//
// HAND-ROLLED, AND NOT BY PREFERENCE. `structuredClone` is the obvious answer
// and it throws on this object: `state.pack` carries the template's FUNCTIONS
// and a Map of card records, `state.rng` is a closure over a u32, `state.zones`
// is a class instance holding another Map of class instances, and
// `compiledReactions` holds compiled RegExps. So the copy is written out field
// by field, which has the side benefit that every field has to be DECIDED
// about — the alternative is a deep clone that silently starts copying whatever
// a future field turns out to be.
//
// WHAT IS COPIED, AND WHY EACH ONE. Everything the pipeline or a template
// mutates during a move:
//
//   zones          every instance's `cards` array (ZoneSet.clone, state.js)
//   cardLocation   a fresh Map — moveCards stamps it on every card it moves
//   turn           setTurnSeat/setPhase write through this object
//   direction      reverseDirection
//   vars           deep, because a template may mutate a var's contents in
//   playerVars     place rather than through setVar — contract-rummy's `melds`
//                  is the live example: getMeldGroups hands back the stored
//                  array and applyMove pushes onto a group's `cards`. A shallow
//                  `{...}` would have let a forked hit grow the ORIGINAL meld.
//   scores         addScore, and the round boundary's own accumulation
//   events         applyMove does `events.length = 0`, in place, every move
//   log            a fresh array; the entries inside are shared because the log
//                  is append-only (src/engine/replay.js says so and pins it)
//   rng            a fresh generator, positioned at the source's current state
//
//   roundNumber / roundScores / roundEnded / roundWinner / gameOver / winner
//                  the round boundary writes ALL SIX (movePipeline's
//                  maybeFinishRound), and they are the easy ones to miss
//                  because nothing touches them until a hand happens to end
//                  inside the very move being tried.
//
// `roundScores` is the one copy here that is DEFENSIVE rather than load-bearing:
// maybeFinishRound replaces it wholesale, so sharing the object would survive
// today, and tests/fork.test.js cannot catch a regression in it for exactly
// that reason. It is copied because it is a per-seat total that a future
// scoring hook would naturally accumulate into, and that version of the bug is
// silent money moving between seats.
//
// WHAT IS SHARED, because nothing ever writes to it after createState:
// `pack` (and through it `template`, `cardsById`, `rules`, `manifest`), `seats`,
// `seed`, `reactions`, `compiledReactions`, and the zone `def` objects.
//
// THE MEMOIZATION TRAP. `legalMovesFor` (src/engine/movePipeline.js) memoizes on
// `${log.length}:${roundNumber}:${turn.seat}:${turn.phase}:${seat}` and is only
// sound while a state changes EXCLUSIVELY through `applyMove` on that same
// object. A fork exists to be poked at — Phase 3's determinizer will redeal
// hidden zones in place, which changes what is legal without touching the log —
// so anything simulating on a fork must call the exact, uncached
// `enumerateLegalMoves`. The live path in src/engine/bot.js stays on
// `legalMovesFor`, which is who the memo was written for.
//
// NOT A SAVE FORMAT. A fork is in-memory only and deliberately shares its pack;
// the persistable form of a match is still seed + log (src/engine/replay.js).

import { createRng } from './rng.js';

/**
 * A deep copy of plain JSON-ish data, passing anything else through by
 * reference.
 *
 * Used for `vars`, `playerVars` and `roundScores`, all three of which are
 * already required to be wire-serialisable — src/engine/view.js ships them to
 * a peer — so "plain" is the whole domain here rather than a hopeful guess. A
 * Map or a class instance appearing in one would be a bug in the template, and
 * passing it through by reference keeps this function from inventing a second,
 * quieter definition of what a var may be.
 */
function copyPlain(value) {
  if (Array.isArray(value)) return value.map(copyPlain);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const key of Object.keys(value)) out[key] = copyPlain(value[key]);
    return out;
  }
  return value;
}

/**
 * A state you may apply moves to without the original noticing.
 *
 * The fork is a plain object of the same shape `createState` returns, so every
 * engine entry point — `makeCtx`, `applyMove`, `enumerateLegalMoves`,
 * `serializeMatch` — takes it as-is.
 */
export function forkState(state) {
  // Positioned, not re-seeded. `createRng(seed)` gives a generator at the top
  // of the stream; `setState(getState())` moves it to exactly where the source
  // has got to, so a fork that recycles a discard pile or deals the next round
  // draws the cards the original would have. Reading `getState()` is a pure
  // read of the source's counter (src/engine/arcade-rng.js) and does not
  // advance it.
  const rng = createRng(state.seed);
  rng.setState(state.rng.getState());

  return {
    // Shared: fixed at createState, never written to.
    pack: state.pack,
    seats: state.seats,
    seed: state.seed,
    reactions: state.reactions,
    compiledReactions: state.compiledReactions,

    // Copied: everything a move can move.
    rng,
    zones: state.zones.clone(),
    cardLocation: new Map(state.cardLocation),
    turn: { ...state.turn },
    direction: state.direction,
    vars: copyPlain(state.vars),
    playerVars: state.playerVars.map(copyPlain),
    scores: state.scores.slice(),
    roundNumber: state.roundNumber,
    roundScores: copyPlain(state.roundScores),
    roundEnded: state.roundEnded,
    roundWinner: state.roundWinner,
    gameOver: state.gameOver,
    winner: state.winner,
    log: state.log.slice(),
    events: state.events.slice(),
  };
}
