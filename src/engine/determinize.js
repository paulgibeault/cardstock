// A WORLD CONSISTENT WITH WHAT ONE SEAT KNOWS — the state a rollout is allowed
// to play forward.
//
// A bot is handed the WHOLE state: every hand, the exact stock order
// (tools/simulate.mjs says so in as many words). That is fine for a scorer that
// only reads its own cards, and it is a cheat the moment anything SIMULATES
// forward, because the simulation inherits the real shuffle. Phase 2's answer
// was to refuse: src/engine/bot.js declines to judge any move whose fork turned
// up a card the seat could not see. That guard is honest and it is also a
// ceiling — a draw off the deck and the commit that resolves a Hearts pass are
// exactly the moves a strong player thinks hardest about, and they are the ones
// it can never score.
//
// Determinizing lifts the ceiling without lifting the guard's rule. Every card
// this seat is not entitled to see is pooled, shuffled, and dealt back into the
// slots it came from. The seat's own hand and every public zone are untouched,
// every zone keeps its exact count, and `cardLocation` still agrees with the
// zones. The unknown card is now a SAMPLE rather than a peek: average enough
// samples and you have judged the move against the distribution the seat can
// legitimately reason about.
//
// THE RNG IS THE CALLER'S, NEVER `state.rng`. This randomness lives outside the
// reducer — the same rule persona mistakes follow (src/players/roster.js).
// Drawing from the match stream here would shift every card dealt afterwards
// and desync any log written by a build that thought about a different number
// of samples.
//
// THE SHUFFLE MUST NOT DEPEND ON THE ARRANGEMENT IT IS HIDING — the trap that
// makes the `sort` below load-bearing rather than tidy. Fisher-Yates over the
// pool in zone-and-index order gives a DIFFERENT deal when two opponents swap
// hands, even though the seat's knowledge is identical and the pool is the same
// set of cards. The fairness gate (tests/rollouts.test.js) is precisely a probe
// for "did the decision change when something invisible moved", so an
// order-sensitive shuffle would report the bot cheating when it is not — or,
// worse, would be "fixed" by weakening the gate. Sorting the pool first makes
// the sample a function of the SET of unknown cards and the caller's RNG, and
// of nothing else.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   * It does not model MEMORY. A card that was face up in the discard pile ten
//     turns ago is hidden again the moment it is buried, and a Hearts `won`
//     pile is `visibility: 'none'` even to its owner — so both get resampled. A
//     human remembers more than that. Erring toward forgetting is the safe
//     direction: the bot can only ever know less than it is entitled to, never
//     more, and `heldValue` (the public point total the felt has always shown)
//     is the one thing a resampled `won` pile can disagree with.
//   * It does not model INFERENCE. "They passed on hearts twice, so they are
//     void" is real information and this pools every unknown card uniformly.
//     That is the honest floor for flat Monte Carlo; an opponent model is a
//     different feature.
//   * It does not touch scores, the log, the turn, or any var that does not
//     name a card.
//
// A HIDDEN COMMITMENT IS UN-MADE RATHER THAN REWRITTEN — the trap that turns a
// determinized state from plausible-looking into actually legal.
//
// A template's private bookkeeping can NAME hidden cards. Hearts'
// `__pendingPass` is the live example: three cards out of a hand nobody may
// see, held until every seat has committed. Redeal that hand and the commitment
// names cards its owner no longer holds, and the moment the last seat commits,
// `moveCards` throws — the rollout that most needed determinizing is the one
// that crashes.
//
// The fix is not to re-point the reference at whatever landed in those slots.
// That works, and it makes the sample depend on WHICH SLOTS the real cards were
// sitting in — hidden arrangement leaking into the model, and the fairness gate
// catches it as cheating even though nothing is being read. So a `__`-prefixed
// per-seat var (view.js's own definition of "this seat's secret") that names
// any hidden card is CLEARED for every seat but the one deciding. In the
// sampled world that seat has not committed yet, and the rollout policy commits
// for it out of the hand it was just dealt. That is the honest model of what
// this seat knows: somebody committed something, and this is a plausible
// something.

import { forkState } from './fork.js';
import { visibleCardIds } from './view.js';

/** Fisher-Yates on a copy, driven by the caller's `random()`. */
function shuffled(ids, random) {
  const out = ids.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Does this value name any of the cards that were just moved?
 *
 * Structural rather than a list of known var names, for the reason `cardIdsIn`
 * (src/engine/view.js) is: a walk that only looked where card ids are supposed
 * to live works for exactly as long as nobody puts one somewhere new, and here
 * the cost of missing one is a rollout that throws.
 */
function namesAny(value, ids) {
  if (typeof value === 'string') return ids.has(value);
  if (Array.isArray(value)) return value.some((item) => namesAny(item, ids));
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).some((item) => namesAny(item, ids));
  }
  return false;
}

/** This seat's private bookkeeping, by the convention view.js already uses. */
function isSecretPlayerVar(key) {
  return key.startsWith('__');
}

/**
 * A fork of `state` in which everything `seat` may not see has been resampled.
 *
 * @param random a caller-supplied `() => [0,1)`. Seed it and the sample is
 *               reproducible, which is what the fairness gate and the
 *               tournament harness need.
 * @returns a fresh state (src/engine/fork.js). The original is untouched, and
 *          the copy must be simulated with the exact, uncached
 *          `enumerateLegalMoves` — a redeal changes what is legal without
 *          touching the log, which is the one thing `legalMovesFor`'s memo key
 *          cannot see.
 */
export function determinizeState(state, seat, random) {
  const fork = forkState(state);
  const visible = visibleCardIds(state, seat);

  // Every position holding a card this seat is not entitled to know, in a fixed
  // address order so the redeal is reproducible.
  const slots = [];
  for (const address of fork.zones.allAddresses()) {
    const cards = fork.zones.get(address).cards;
    for (let i = 0; i < cards.length; i++) {
      if (!visible.has(cards[i])) slots.push({ address, index: i, was: cards[i] });
    }
  }
  if (slots.length === 0) return fork;

  // Sorted before shuffling — see the header. The pool is a SET as far as this
  // function is concerned; which slot each card happened to be sitting in is
  // exactly the information being hidden.
  const pool = shuffled(slots.map((slot) => slot.was).sort(), random);

  const moved = new Set();
  for (let k = 0; k < slots.length; k++) {
    const { address, index, was } = slots[k];
    const id = pool[k];
    fork.zones.get(address).cards[index] = id;
    fork.cardLocation.set(id, address);
    moved.add(was);
  }

  // The commitments that named cards this seat cannot see — see the header.
  fork.playerVars = fork.playerVars.map((own, s) => {
    if (s === seat) return own;
    let out = own;
    for (const [key, value] of Object.entries(own)) {
      if (!isSecretPlayerVar(key) || !namesAny(value, moved)) continue;
      if (out === own) out = { ...own };
      out[key] = undefined;
    }
    return out;
  });
  return fork;
}
