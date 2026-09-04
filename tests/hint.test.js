// THE HINT IS THE BOT'S OWN RANKING, AND IT HAS TO STAY THAT.
//
// src/ui/hint.js asks `rankMoves` what a player at the chosen difficulty would
// do and puts the answer on the action bar. Three things can quietly go wrong
// with that and none of them would show on a felt that looks fine:
//
//   1. THE SUGGESTION IS NOT A LEGAL MOVE — a hint the player cannot take is
//      worse than none. Every suggestion here is checked against the template's
//      own enumeration, for every pack, at every difficulty.
//   2. THE SENTENCE DOES NOT FIT. The action bar reserves two lines and the
//      table below it is laid out around that (#13, #17); a suggestion that
//      wraps to three moves the felt on exactly the turn the player asked for
//      help. Every sentence a real deal can produce is held to the budget.
//   3. THE DIAL DOES NOT REACH IT. "What a Sharp player would do" is a promise
//      about the bot at `hard`; if the hint ranked at one fixed depth whatever
//      the setting, the sheet's row would be a lie here. So `hard` must differ
//      from `easy` on some decisions, in the packs where the search does
//      anything (tests/lookahead.test.js and tests/rollouts.test.js pin that).
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove, enumerateLegalMoves } from "../src/engine/movePipeline.js";
import { chooseBotMove, DIFFICULTIES } from "../src/engine/bot.js";
import { createRng } from "../src/engine/rng.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { suggestMove, SUGGESTION_MAX_CHARS } from "../src/ui/hint.js";
import { SKILL_LEVELS } from "../src/ui/difficulty.js";

const TABLES = [["crazy-eights", 3], ["wildfire", 3], ["hearts", 4], ["milestones", 3], ["stockpile", 3]];

async function dealt(packId, seats, seed) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

/** Walk a bot-vs-bot game, calling `visit(state, seat)` before each move. */
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
  }
}

/**
 * The reproducible `hard` budget: a wall-clock budget would make the sample
 * count depend on the machine, and the "differs from easy" claim below has to
 * be the same claim on every machine.
 */
function options(difficulty, seed) {
  return { difficulty, random: createRng(seed).next, budgetMs: Infinity, budgetMoves: 600 };
}

const key = (move) => JSON.stringify(move);

test("every suggestion is one of the seat's legal moves, in every pack at every difficulty", async () => {
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `hint:${packId}`);
    let checked = 0;
    walk(state, 80, (live, seat) => {
      const legal = new Set(enumerateLegalMoves(live, seat).map(key));
      for (const difficulty of DIFFICULTIES) {
        const hint = suggestMove(live, seat, options(difficulty, `hint:${packId}:${checked}`));
        assert.ok(hint, `${packId}: no suggestion for seat ${seat} with ${legal.size} legal moves`);
        assert.ok(legal.has(key(hint.move)),
          `${packId} at ${difficulty}: suggested ${key(hint.move)}, which is not a legal move`);
        assert.strictEqual(hint.level.id, difficulty, `${packId}: the hint names the wrong level`);
        checked++;
      }
    });
    assert.ok(checked >= 30, `${packId}: only ${checked} suggestions checked`);
  }
});

test("every suggestion names the level and fits the action bar", async () => {
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `hint-text:${packId}`);
    let longest = "";
    walk(state, 120, (live, seat) => {
      for (const difficulty of DIFFICULTIES) {
        const hint = suggestMove(live, seat, options(difficulty, `text:${packId}`));
        const label = SKILL_LEVELS.find((l) => l.id === difficulty).label;
        assert.ok(hint.text.startsWith(`${label} would `),
          `${packId}: "${hint.text}" does not say what ${label} would do`);
        assert.ok(hint.text.length <= SUGGESTION_MAX_CHARS,
          `${packId}: "${hint.text}" is ${hint.text.length} chars against a budget of ${SUGGESTION_MAX_CHARS}`);
        // The text is prose about a move, never the move's own vocabulary.
        assert.ok(!/layDown|playCard|passCards/.test(hint.text), `${packId}: raw move type in "${hint.text}"`);
        if (hint.text.length > longest.length) longest = hint.text;
      }
    });
    assert.ok(longest.length > 0, `${packId}: no suggestion text produced`);
  }
});

test("what is lit on the felt is what the move touches", async () => {
  const lit = { layDown: false };
  for (const [packId, seats] of TABLES) {
    const state = await dealt(packId, seats, `hint-lights:${packId}`);
    walk(state, packId === "milestones" ? 200 : 80, (live, seat) => {
      const hint = suggestMove(live, seat, { difficulty: "easy" });
      const hand = new Set(live.zones.cards(`hand.${seat}`));
      const pileTop = live.zones.has("discard") ? live.zones.cards("discard").at(-1) : undefined;
      // Every card the move commits is lit — the ones on the move, and for a
      // lay-down the ones inside each proposed meld — so an empty ring set is
      // only right for a move that names no card at all.
      const committed = [...(hint.move.cards || []), ...(hint.move.choice?.melds || []).flatMap((m) => m.cards)];
      for (const id of committed) {
        assert.ok(hint.cardIds.has(id), `${packId}: ${hint.move.type} commits ${id} but the hint does not light it`);
      }
      if (hint.move.type === "layDown") {
        assert.ok(hint.cardIds.size >= 3, `${packId}: a lay-down lit only ${hint.cardIds.size} cards`);
        lit.layDown = true;
      }
      for (const id of hint.cardIds) {
        // A card lit as part of the hint is one the seat may see: its own
        // hand, a pile top it could pick up, or a source pile of its own.
        const ownPile = (hint.move.from || "").endsWith(`.${seat}`) && live.zones.has(hint.move.from)
          && live.zones.cards(hint.move.from).includes(id);
        assert.ok(hand.has(id) || id === pileTop || ownPile,
          `${packId}: hint lights ${id}, which is not in seat ${seat}'s hand or on a pile it may take from`);
      }
      for (const zone of hint.zones) {
        assert.ok(live.zones.has(zone), `${packId}: hint lights a zone that does not exist: ${zone}`);
      }
      if (hint.move.type === "hit") {
        assert.strictEqual(hint.meldKey, `${hint.move.choice.seat}:${hint.move.choice.meld}`);
      } else {
        assert.strictEqual(hint.meldKey, null);
      }
    });
  }
  assert.ok(lit.layDown, "no lay-down was ever suggested, so the meld-card lighting went unexercised");
});

test("the difficulty dial reaches the hint", async () => {
  // The same positions, asked at `hard` and at `easy`, must not always agree
  // — in the packs where the search layers demonstrably change the bot's
  // play. Anything else and the sheet's "Sharp" row is decoration up here.
  for (const [packId, seats] of [["hearts", 4], ["milestones", 3]]) {
    let decisions = 0;
    let differed = 0;
    for (let game = 0; game < 3 && differed === 0; game++) {
      const state = await dealt(packId, seats, `hint-dial:${packId}:${game}`);
      walk(state, 150, (live, seat) => {
        if (enumerateLegalMoves(live, seat).length < 2) return;
        const sharp = suggestMove(live, seat, options("hard", `dial:${decisions}`));
        const easy = suggestMove(live, seat, { difficulty: "easy" });
        decisions++;
        if (key(sharp.move) !== key(easy.move)) differed++;
      });
    }
    assert.ok(decisions > 20, `${packId}: only ${decisions} decisions compared`);
    assert.ok(differed > 0,
      `${packId}: the hint at hard agreed with the hint at easy on all ${decisions} decisions — `
      + "the difficulty is not reaching rankMoves");
  }
});

test("a view gets no hint, because there is no state to rank", async () => {
  const state = await dealt("crazy-eights", 3, "hint:view");
  const view = Object.assign(Object.create(Object.getPrototypeOf(state)), state, { isView: true, moves: [] });
  assert.strictEqual(suggestMove(view, 0, { difficulty: "easy" }), null);
  assert.strictEqual(suggestMove(null, 0), null);
});
