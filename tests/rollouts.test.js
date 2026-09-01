// DETERMINIZED ROLLOUTS, AND THE ONE WAY THEY CAN QUIETLY BECOME CHEATING.
//
// `hard` (src/engine/bot.js) plays each candidate move out to the end of the
// hand, many times, and picks the one that tends to end well. It is handed the
// WHOLE state to do it with — every opponent's hand, the exact stock order —
// so the only thing standing between "a bot that thinks ahead" and "a bot that
// always knew you had the queen" is that it deals itself a fresh, ignorant
// world first (src/engine/determinize.js).
//
// That is not a property anyone can see by reading the chooser. It is a
// property of what the chooser DECIDES, so it is tested the way a
// counter-intelligence probe works: move something the seat is not entitled to
// see, and demand the answer does not change.
//
// THE TRAP IN WRITING THAT PROBE, and it is worth stating plainly because the
// naive version reports cheating that is not there. HAND COUNTS ARE PUBLIC.
// Every zone view ships one (src/engine/view.js), the felt has always drawn
// them, and all three `evaluateState` implementations legitimately read them —
// "they are down to two cards" is exactly the kind of thing a card player
// notices. So a probe that swaps hands of DIFFERENT lengths has changed
// information the seat was entitled to, and a decision that changes with it is
// a bot playing correctly. Measured on the Phase 2 tree: 4,987 decisions across
// all five packs, zero changed under equal-length swaps and ten changed under
// unequal ones. The swaps below are equal-length only, and that is not a
// convenience — it is the difference between a gate and a false alarm.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { forkState } from "../src/engine/fork.js";
import { determinizeState } from "../src/engine/determinize.js";
import { visibleCardIds } from "../src/engine/view.js";
import { createRng } from "../src/engine/rng.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

/** Every pack, at the seat count its lobby tile suggests. */
const TABLES = [
  ["crazy-eights", 4], ["milestones", 4], ["hearts", 4],
  ["wildfire", 4], ["stockpile", 4],
];

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/** Walk a plain bot-vs-bot game, calling `visit(state, seat)` before each move. */
function walk(state, limit, visit) {
  const template = state.pack.template;
  for (let i = 0; i < limit && !state.gameOver; i++) {
    const acting = template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat];
    let move = null;
    let actor = null;
    for (const seat of acting) {
      move = chooseBotMove(state, seat);
      if (move) { actor = seat; break; }
    }
    if (!move) return;
    visit(state, actor);
    applyMove(state, move);
    if (state.events.some((e) => e.type === "roundOver")) return;
  }
}

/**
 * A hard decision that depends on nothing but the state and this seed.
 *
 * `budgetMs: Infinity` is the whole point — a wall-clock budget makes the
 * sample count a function of how busy the machine was, and every assertion here
 * compares two decisions that must have taken the same number of samples. The
 * move cap is small so the suite stays quick; strength is measured in
 * tools/simulate.mjs, not here.
 */
function hardOptions(seed = "probe") {
  return {
    difficulty: "hard",
    random: createRng(seed).next,
    budgetMs: Infinity,
    budgetMoves: 900,
  };
}

const key = (move) => JSON.stringify(move);

/* ------------------------------------------------------------------ *
 * The determinizer's own contract
 * ------------------------------------------------------------------ */

/** Where every card sits, as a comparable string. */
function layout(state) {
  return state.zones.allAddresses()
    .map((address) => `${address}=${state.zones.cards(address).join(",")}`).join("|");
}

test("a determinized world resamples what the seat may not see, and nothing else", async () => {
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `determinize:${packId}`);
    walk(state, 12, () => {});
    const seat = state.turn.seat;

    const visible = visibleCardIds(state, seat);
    const before = layout(state);
    const world = determinizeState(state, seat, createRng("sample:1").next);

    assert.strictEqual(layout(state), before, `${packId}: determinizing mutated the live state`);

    let resampled = 0;
    for (const address of state.zones.allAddresses()) {
      const was = state.zones.cards(address);
      const now = world.zones.cards(address);
      assert.strictEqual(now.length, was.length, `${packId}: ${address} changed size`);
      for (let i = 0; i < was.length; i++) {
        // A card this seat may see has not moved a millimetre — same zone, same
        // position in it. Its own hand and every public pile are its own
        // knowledge and resampling them would be inventing a different game.
        if (visible.has(was[i])) {
          assert.strictEqual(now[i], was[i], `${packId}: ${address}[${i}] is visible and was moved`);
        } else if (now[i] !== was[i]) {
          resampled += 1;
        }
        assert.ok(!visible.has(now[i]) || now[i] === was[i],
          `${packId}: a card the seat can see turned up in a hidden slot`);
      }
    }
    assert.ok(resampled > 0, `${packId}: nothing was resampled — the probe below would prove nothing`);

    // The deck is conserved: no card invented, none lost, none dealt twice.
    const all = world.zones.allAddresses().flatMap((a) => world.zones.cards(a));
    assert.strictEqual(new Set(all).size, all.length, `${packId}: a card was dealt into two places`);
    assert.deepStrictEqual(new Set(all), new Set(state.zones.allAddresses().flatMap((a) => state.zones.cards(a))),
      `${packId}: the resampled world holds a different deck`);

    // And cardLocation still agrees with the zones, which is what every
    // template's own lookups go through.
    for (const address of world.zones.allAddresses()) {
      for (const id of world.zones.cards(address)) {
        assert.strictEqual(world.cardLocation.get(id), address,
          `${packId}: ${id} is in ${address} but cardLocation says ${world.cardLocation.get(id)}`);
      }
    }
  }
});

test("the same seed deals the same world; a different one does not", async () => {
  const state = await dealt("milestones", 4, "determinize:seeded");
  const seat = state.turn.seat;
  const a = determinizeState(state, seat, createRng("sample:1").next);
  const b = determinizeState(state, seat, createRng("sample:1").next);
  const c = determinizeState(state, seat, createRng("sample:2").next);
  assert.strictEqual(layout(a), layout(b), "the same RNG seed produced two different worlds");
  assert.notStrictEqual(layout(a), layout(c), "two different seeds produced the identical world");
});

/* ------------------------------------------------------------------ *
 * The fairness gate
 * ------------------------------------------------------------------ */

/** Does this value name any of `ids`? Structural, like view.js's cardIdsIn. */
function namesAny(value, ids) {
  if (typeof value === "string") return ids.includes(value);
  if (Array.isArray(value)) return value.some((v) => namesAny(v, ids));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).some((v) => namesAny(v, ids));
  }
  return false;
}

/**
 * Two opponents trade hands, on a fork — an alternative world this seat has no
 * way to tell apart from the real one.
 *
 * EQUAL LENGTHS ONLY. See this file's header: a hand's SIZE is public, so
 * swapping a five for an eight is handing the seat different legitimate
 * information and any decision that changes is correct behaviour, not a leak.
 *
 * A committed pass travels with the hand it was committed from. Hearts holds
 * three named cards in `__pendingPass` (src/templates/trick-taking.js), and
 * moving the hand without the commitment does not make an alternative world, it
 * makes an impossible one — the commit would name cards its owner is no longer
 * holding, and a probe run on an impossible state proves nothing about a
 * possible one.
 *
 * @returns the forked state, or null when this position has no two
 *          equal-length hidden hands to trade.
 */
function tradeTwoHiddenHands(state, seat) {
  const hidden = state.zones.allAddresses()
    .map((address) => ({ address, zone: state.zones.get(address) }))
    .filter(({ zone }) => zone.def.visibility === "owner"
      && zone.seat !== null && zone.seat !== seat && zone.cards.length > 0);

  for (let i = 0; i < hidden.length; i++) {
    for (let j = i + 1; j < hidden.length; j++) {
      const one = hidden[i];
      const two = hidden[j];
      if (one.zone.seat === two.zone.seat) continue;
      if (one.zone.cards.length !== two.zone.cards.length) continue;

      const fork = forkState(state);
      const a = one.zone.cards.slice();
      const b = two.zone.cards.slice();
      fork.zones.get(one.address).cards.splice(0, a.length, ...b);
      fork.zones.get(two.address).cards.splice(0, b.length, ...a);
      for (const id of b) fork.cardLocation.set(id, one.address);
      for (const id of a) fork.cardLocation.set(id, two.address);

      const sa = one.zone.seat;
      const sb = two.zone.seat;
      const varsA = { ...fork.playerVars[sa] };
      const varsB = { ...fork.playerVars[sb] };
      for (const name of new Set([...Object.keys(varsA), ...Object.keys(varsB)])) {
        if (!name.startsWith("__")) continue;
        if (!namesAny(varsA[name], a) && !namesAny(varsB[name], b)) continue;
        const held = varsA[name];
        varsA[name] = varsB[name];
        varsB[name] = held;
      }
      fork.playerVars[sa] = varsA;
      fork.playerVars[sb] = varsB;
      return fork;
    }
  }
  return null;
}

test("the hard bot cannot see through the back of a card", async () => {
  for (const [packId, seats] of TABLES) {
    let probed = 0;
    let differed = 0;
    // Two deals rather than one, because a position only offers a probe when
    // two OTHER seats hold the same number of cards — and Wildfire, whose draw-
    // two and draw-four penalties keep hands at different sizes, runs out of
    // them inside a single hand.
    for (let game = 0; game < 2; game++) {
      const state = await dealt(packId, seats, `fairness:${packId}:${game}`);
      walk(state, 90, (live, seat) => {
        if (probed >= 14) return;
        const traded = tradeTwoHiddenHands(live, seat);
        if (!traded) return;

        // Same seed on both sides, so the two runs draw the identical sequence of
        // sample worlds and any difference in the answer is a difference in what
        // was READ.
        const real = chooseBotMove(live, seat, hardOptions("fairness"));
        assert.strictEqual(key(chooseBotMove(traded, seat, hardOptions("fairness"))), key(real),
          `${packId}: seat ${seat} played differently once two OTHER seats swapped hands of the `
          + "same size. Nothing it may legitimately see changed, so the rollouts are reading "
          + "cards this seat cannot see");

        // THE STRONGER FORM OF THE SAME QUESTION, and the one that covers the
        // face-down deck as well as the hands: resample EVERY hidden card into
        // the slots it came from. Counts are untouched by construction, so this
        // is the largest rearrangement the seat provably cannot distinguish.
        const stranger = determinizeState(live, seat, createRng(`stranger:${probed}`).next);
        assert.strictEqual(key(chooseBotMove(stranger, seat, hardOptions("fairness"))), key(real),
          `${packId}: seat ${seat} played differently once every card it cannot see was dealt `
          + "somewhere else — the decision depends on the hidden arrangement");

        probed += 1;
        if (key(real) !== key(chooseBotMove(live, seat))) differed += 1;
      });
    }

    assert.ok(probed >= 8, `${packId}: only ${probed} positions probed — too few to conclude anything`);

    // A gate that passes because the rollouts never ran is a gate on nothing —
    // so the hard chooser has to demonstrably disagree with the medium one
    // somewhere above. EXCEPT where the pack declares no round scoring at all:
    // Stockpile is a race with no points, every rollout of it ends on the same
    // number, and the documented answer to a scorer with no opinion is to fall
    // back rather than to shuffle the candidates. That is worth asserting in
    // its own right, so the exception is a claim rather than a skip.
    const steers = !!(await loadPackFromDisk(packId)).scoring?.roundScore;
    if (steers) {
      assert.ok(differed > 0,
        `${packId}: across ${probed} positions the hard chooser never once played something the `
        + "medium chooser would not have — the rollout layer is not running");
    } else {
      assert.strictEqual(differed, 0,
        `${packId} declares no roundScore, so every rollout ends on the same value and hard must `
        + "be medium here — a difference means the search is ranking on noise");
    }
  }
});

/* ------------------------------------------------------------------ *
 * The budget, and the promise the default makes
 * ------------------------------------------------------------------ */

test("a budget too small for one sweep falls back to the one-ply chooser", async () => {
  // The documented failure mode, exercised: a hard bot that cannot afford to
  // sample must play the medium bot's move, not a random one and not nothing.
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `budget:${packId}`);
    let checked = 0;
    walk(state, 30, (live, seat) => {
      const starved = chooseBotMove(live, seat, {
        difficulty: "hard", random: createRng("starved").next, budgetMs: Infinity, budgetMoves: 0,
      });
      assert.strictEqual(key(starved), key(chooseBotMove(live, seat)),
        `${packId}: a hard bot with no budget did not fall back to the plain chooser`);
      checked += 1;
    });
    assert.ok(checked > 5, `${packId}: only ${checked} decisions seen`);
  }
});

test("the plain chooser consults no randomness at all", async () => {
  // The determinism contract in src/engine/bot.js's header, enforced rather than
  // asserted about: `hard` is the only path that may roll dice, so a caller who
  // asked for nothing must never reach one. A stubbed Math.random catches the
  // accident that a default argument would hide.
  const state = await dealt("milestones", 4, "determinism:no-random");
  const real = Math.random;
  Math.random = () => { throw new Error("chooseBotMove(state, seat) reached Math.random"); };
  try {
    walk(state, 40, (live, seat) => { chooseBotMove(live, seat); });
  } finally {
    Math.random = real;
  }
});

test("a hard decision fits inside the shortest think window the game schedules", async () => {
  // THE BUDGET IS ADDED TO THE PAUSE, NOT HIDDEN INSIDE IT: the bot driver
  // sleeps for `thinkTimeMs` and THEN asks for a move (src/ui/botDriver.js), so
  // the decision has to be short enough that nobody can tell the strong
  // opponent from the fast one by how long it sits there. The tightest window
  // any persona schedules at the default `botDelayMs` of 600 is the reckless
  // bot's 240 ms (src/players/roster.js).
  //
  // Milestones, because contract-rummy's enumerator is the costliest call in
  // the repo and every rollout move pays for it. The measured worst decision
  // here is about 130 ms; the bound is deliberately several times that, because
  // a shared CI box is not a laptop and a flaky timing test gets deleted.
  const state = await dealt("milestones", 4, "budget:clock");
  const random = createRng("clock").next;
  let worst = 0;
  let seen = 0;
  walk(state, 5, (live, seat) => {
    const started = performance.now();
    chooseBotMove(live, seat, { difficulty: "hard", random });
    worst = Math.max(worst, performance.now() - started);
    seen += 1;
  });
  assert.ok(seen >= 4, `only ${seen} decisions timed`);
  assert.ok(worst < 900,
    `the slowest hard decision took ${worst.toFixed(0)} ms, which is longer than a bot's whole `
    + "thinking pause — the rollout budget is not being honoured");
});

/* ------------------------------------------------------------------ *
 * Truncated rollouts, and the two scales they put on one axis
 * ------------------------------------------------------------------ */

/**
 * Run `body` with this pack's `evaluateState` reporting in different units.
 *
 * The templates are module singletons and a pack shares one, so the patch is
 * global for as long as it is installed — hence the restore in `finally`.
 *
 * @returns how many times the evaluator was actually consulted, which is the
 *          difference between a test that proved something and one that ran
 *          against rollouts that all happened to reach the end of the hand.
 */
function withRescaledEvaluator(pack, scale, offset, body) {
  const template = pack.template;
  const real = template.evaluateState;
  let calls = 0;
  template.evaluateState = (ctx, seat) => {
    calls += 1;
    return real(ctx, seat) * scale + offset;
  };
  try {
    body();
  } finally {
    template.evaluateState = real;
  }
  return calls;
}

test("the units a template scores a position in cannot change what the bot plays", async () => {
  // THE SCALE BRIDGE, TESTED AS A SCALE BRIDGE. A rollout that reached the end
  // of the hand is worth a round score; one cut off at `depth` is worth
  // whatever `evaluateState` says. Those are different units, and the only
  // thing keeping the sampler from preferring whichever way a rollout happened
  // to end is that every sweep is centred and scaled by its own spread before
  // it is banked (src/engine/bot.js). That makes the banked number
  // dimensionless — so multiplying the evaluator by a thousand and shifting it
  // by five hundred is a change the decision must not be able to feel.
  //
  // Restated as the bug it catches: bank the two currencies raw and a decision
  // whose sweeps did not all end the same way is settled by whichever scorer
  // happens to report in bigger numbers, which is not an opinion about cards.
  //
  // A WHOLE HAND, NOT ONE POSITION, and that is the difference between this
  // test and the version of it that proved nothing. Mid-hand every rollout is
  // truncated, so every sweep of every candidate is denominated in the
  // evaluator alone and multiplying it through cancels — the property holds for
  // reasons that have nothing to do with the bridge. It is the ENDGAME that
  // mixes the currencies, where one sample of a position finishes the hand
  // inside the depth and the next does not, and the only way to be sure of
  // reaching those positions is to walk into them.
  for (const [packId, seats] of TABLES) {
    const pack = await loadPackFromDisk(packId);
    if (!pack.template.evaluateState) continue;

    const state = await dealt(packId, seats, `units:${packId}`);
    let calls = 0;
    let checked = 0;
    walk(state, 120, (live, seat) => {
      const plain = key(chooseBotMove(live, seat, hardOptions("units")));
      let rescaled = null;
      calls += withRescaledEvaluator(pack, 1000, 500, () => {
        rescaled = key(chooseBotMove(live, seat, hardOptions("units")));
      });
      assert.strictEqual(rescaled, plain,
        `${packId}: seat ${seat} played differently once evaluateState reported the same opinion `
        + "in bigger units. A truncation value is being banked against round scores raw, so the "
        + "bot is ranking moves by which scorer reached them");
      checked += 1;
    });

    assert.ok(checked > 20, `${packId}: only ${checked} decisions probed`);
    assert.ok(calls > 0,
      `${packId}: the evaluator was never consulted, so every rollout ran to the end of the `
      + "hand and this walk proves nothing about mixing the two scales");
  }
});

/* ------------------------------------------------------------------ *
 * The confidence gate
 * ------------------------------------------------------------------ */

test("a sample that cannot separate its favourite defers to the one-ply chooser", async () => {
  // WHAT MAKES `hard` SAFE TO TURN UP. Sixty samples across eight candidates is
  // seven apiece, and an argmax over eight noisy sevens returns whichever one
  // got lucky — which is uncorrelated with quality, and therefore worse than
  // the cheaper ordering it displaced. So the sampler must clear a bar before
  // it may reorder anything (src/engine/bot.js's SAMPLE_CONFIDENCE), and a bar
  // nothing can clear has to leave the medium bot's move standing exactly.
  //
  // BOTH DIRECTIONS, because the first assertion alone would pass just as
  // happily against a rollout layer that never ran at all.
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `confidence:${packId}`);
    let deferred = 0;
    let reordered = 0;
    walk(state, 40, (live, seat) => {
      const medium = key(chooseBotMove(live, seat));
      assert.strictEqual(
        key(chooseBotMove(live, seat, { ...hardOptions("confidence"), confidence: Infinity })),
        medium,
        `${packId}: seat ${seat} let the sampler reorder its moves under a confidence bar no `
        + "sample can clear — the gate is not on the road the fallback takes",
      );
      deferred += 1;
      if (key(chooseBotMove(live, seat, { ...hardOptions("confidence"), confidence: 0 })) !== medium) {
        reordered += 1;
      }
    });
    assert.ok(deferred > 5, `${packId}: only ${deferred} decisions seen`);
    // Stockpile declares no round scoring, so its rollouts are all tied and it
    // falls back for its own reasons — the same exception the fairness gate
    // carves out, and for the same reason.
    const steers = !!(await loadPackFromDisk(packId)).scoring?.roundScore;
    if (steers) {
      assert.ok(reordered > 0,
        `${packId}: with the confidence bar removed the sampler still never reordered anything, `
        + "so the assertion above is passing against a search that is not running");
    }
  }
});
