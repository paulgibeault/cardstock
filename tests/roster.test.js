// Who is at the table, and how they play.
//
// The two claims worth pinning here are the ones a player would notice
// breaking, and neither is visible from reading the code:
//
//  1. The opponents are DERIVED FROM THE MATCH SEED, not stored. That is the
//     whole reason the save format did not have to change — so if this ever
//     stops holding, a resumed game silently re-seats different people at the
//     table and the head-to-head record starts filing results against players
//     who were never there.
//  2. A persona can only ever REORDER the template's own ranking. It must not
//     be able to reach a move the heuristic did not rank, because the moment it
//     can, a personality is a second rules engine.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { enumerateLegalMoves, validateMove } from "../src/engine/movePipeline.js";
import { rankOrder } from "../src/engine/cards.js";
import { chooseBotMove, rankMoves } from "../src/engine/bot.js";
import { ROOT } from "../tools/stage.mjs";
import {
  BOT_ROSTER, PERSONAS, buildSeating, pickBotIds, botById, personaOf, thinkTimeMs,
} from "../src/players/roster.js";

function packFromDisk(packId) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

function dealt(packId, seed) {
  const pack = packFromDisk(packId);
  const state = createState({ pack, seats: 3, seed });
  pack.template.setup(makeCtx(state));
  return state;
}

test("the roster is well-formed: unique ids, real personas, own colours", () => {
  const ids = new Set();
  for (const bot of BOT_ROSTER) {
    assert.ok(!ids.has(bot.id), `duplicate bot id ${bot.id}`);
    ids.add(bot.id);
    assert.ok(PERSONAS[bot.persona], `${bot.id} names an unknown persona`);
    // §7b: this reaches an inline style, so it must be a literal we wrote.
    assert.match(bot.color, /^#[0-9a-f]{6}$/i, `${bot.id}: colour must be a plain hex`);
    assert.ok(bot.icon.length > 0, `${bot.id}: needs a face`);
  }
  assert.ok(BOT_ROSTER.length >= 6, "too few bots for the table to feel like it rotates");
});

test("the same seed always seats the same opponents", () => {
  const a = buildSeating(1234, 3, { humanSeat: 0, humanName: "Paul" });
  const b = buildSeating(1234, 3, { humanSeat: 0, humanName: "Paul" });
  assert.deepStrictEqual(a.map((s) => s.botId), b.map((s) => s.botId));
});

test("a different seed brings different opponents", () => {
  // Not a guarantee for any single pair — it is a shuffle — so this asserts
  // the property that matters: across many matches the cast actually rotates.
  const seen = new Set();
  for (let seed = 0; seed < 40; seed++) {
    for (const identity of buildSeating(seed, 3, { humanSeat: 0 })) {
      if (identity.isBot) seen.add(identity.botId);
    }
  }
  assert.ok(seen.size >= 6, `only ${seen.size} distinct bots across 40 deals`);
});

test("opponents at one table are never the same person twice", () => {
  for (let seed = 0; seed < 50; seed++) {
    const bots = buildSeating(seed, 4, { humanSeat: 0 }).filter((s) => s.isBot);
    assert.strictEqual(new Set(bots.map((b) => b.botId)).size, bots.length,
      `seed ${seed} seated a duplicate opponent`);
  }
});

test("the human's seat carries their own name, and never a bot's identity", () => {
  const seating = buildSeating(7, 3, { humanSeat: 0, humanName: "Paul" });
  assert.strictEqual(seating[0].name, "Paul");
  assert.strictEqual(seating[0].isBot, false);
  assert.strictEqual(seating[0].opponentKey, null,
    "the player must never be filed as their own opponent");
  assert.strictEqual(seating[0].shortName, "You");
});

test("a nameless player is 'You' rather than blank", () => {
  for (const name of ["", "   ", undefined, null]) {
    assert.strictEqual(buildSeating(1, 3, { humanSeat: 0, humanName: name })[0].name, "You");
  }
});

test("head-to-head keys are namespaced so a peer can never collide with a bot", () => {
  for (const identity of buildSeating(3, 4, { humanSeat: 0 })) {
    if (!identity.isBot) continue;
    assert.match(identity.opponentKey, /^bot:[\w-]+$/);
  }
});

test("an unknown bot id degrades to a guest instead of throwing", () => {
  // The case: a roster edited after a match was saved. Losing the character is
  // acceptable; failing to open the table is not.
  const unknown = botById("nobody-by-that-name");
  assert.ok(unknown.name);
  assert.ok(personaOf("nobody-by-that-name"));
  assert.strictEqual(pickBotIds(5, 2).length, 2);
});

test("think time scales with the player's bot-speed preference", () => {
  const identity = buildSeating(11, 3, { humanSeat: 0 })[1];
  const [lo, hi] = identity.persona.tempoMs;
  const fast = thinkTimeMs(identity, 60, () => 0.5);
  const normal = thinkTimeMs(identity, 600, () => 0.5);
  assert.ok(normal >= lo && normal <= hi, "the persona's own tempo at 1x");
  assert.ok(fast < normal, "a lower delay setting must still speed bots up");
});

test("a persona reorders the template's ranking and never escapes it", () => {
  const state = dealt("wildfire", "persona:1");
  const legal = enumerateLegalMoves(state, state.turn.seat);
  const plain = rankMoves(state, state.turn.seat);
  const tilted = rankMoves(state, state.turn.seat, { persona: PERSONAS.reckless });

  assert.strictEqual(tilted.length, plain.length, "a persona must not add or drop moves");
  const legalSet = new Set(legal.map((m) => JSON.stringify(m)));
  for (const entry of tilted) {
    assert.ok(legalSet.has(JSON.stringify(entry.move)),
      "a persona surfaced a move the enumerator never offered");
  }
});

test("patience and aggression move the draw in opposite directions", () => {
  const state = dealt("wildfire", "persona:2");
  const seat = state.turn.seat;
  const drawScore = (persona) =>
    rankMoves(state, seat, { persona }).find((e) => e.move.type === "draw").score;

  const neutral = drawScore(null);
  const patient = drawScore({ aggression: 0.4, patience: 2.5 });
  const eager = drawScore({ aggression: 2.5, patience: 0.2 });

  assert.ok(patient > neutral, "patience must make holding more attractive");
  assert.ok(eager < neutral, "aggression must make holding less attractive");
});

test("the tilt decides between closely-ranked moves without overriding the heuristic", () => {
  // The guarantee, stated exactly: a persona breaks near-ties, it does not
  // overrule a clear preference. A bot that drew when it had an obviously good
  // card to play would not read as patient — it would read as broken, and it
  // would stop being an opponent worth beating.
  const state = dealt("wildfire", "persona:3");
  const seat = state.turn.seat;
  const best = (persona) => rankMoves(state, seat, { persona })[0].move.type;

  assert.strictEqual(best({ aggression: 0.3, patience: 3 }), "playCard",
    "even a very patient bot plays when playing is clearly better");
});

test("the plain chooser stays deterministic — simulate.mjs and the rule tests rely on it", () => {
  const a = dealt("hearts", "determinism");
  const b = dealt("hearts", "determinism");
  for (let i = 0; i < 12; i++) {
    assert.deepStrictEqual(chooseBotMove(a, a.turn.seat), chooseBotMove(b, b.turn.seat));
  }
});

/* ------------------------------------------------------------------ *
 * The pass, which used to be a decision nobody could make
 * ------------------------------------------------------------------ */

// A CHOICE WITH ONE OPTION IS NOT A CHOICE. trick-taking's enumerator collapsed
// the whole pass space into a single canned "pass your N highest", so no
// heuristic, persona or search could touch the three most consequential cards a
// Hearts player commits all round — and nothing noticed, because a hand passed
// badly still completes. These two are what would notice.
test("the pass phase offers a real choice, and every option is a legal pass", () => {
  const state = dealt("hearts", "pass:choice");
  assert.strictEqual(state.turn.phase, "pass", "hearts round 1 opens on a pass");
  const seat = state.turn.seat;
  const moves = enumerateLegalMoves(state, seat);

  assert.ok(moves.length > 1, `the pass enumerated ${moves.length} move(s) — nothing to choose between`);
  // Still a SHORTLIST. Seventeen-choose-three is 680 moves, and this list is
  // shipped to every joiner with their view (src/match/host.js).
  assert.ok(moves.length <= 6, `the pass shortlist grew to ${moves.length} — it is shipped over the wire`);

  const seen = new Set();
  for (const move of moves) {
    assert.strictEqual(move.type, "passCards");
    assert.strictEqual(move.cards.length, 3, "hearts passes exactly three");
    assert.strictEqual(new Set(move.cards).size, 3, "a pass named the same card twice");
    assert.ok(validateMove(state, move).legal, `enumerated an illegal pass: ${move.cards}`);
    const key = move.cards.slice().sort().join("|");
    assert.ok(!seen.has(key), "the shortlist offered the same three cards twice");
    seen.add(key);
  }
});

test("a pass is scored as all N cards, not by whichever one sorted first", () => {
  // The exact bug the enumerator would otherwise have walked into:
  // `botHeuristic` read `move.cards[0]`, which was correct while a pass was one
  // canned move and ranks five whole passes by an accident of sort order the
  // moment it is not. Both passes below start with the same card.
  const state = dealt("hearts", "pass:whole");
  const seat = state.turn.seat;
  const hand = [...state.zones.cards(`hand.${seat}`)]
    .sort((a, b) => rankOrder(state.pack.cardsById.get(b)) - rankOrder(state.pack.cardsById.get(a)));
  const heuristic = state.pack.template.botHeuristic;
  const ctx = makeCtx(state);

  const shedHigh = { actor: seat, type: "passCards", cards: [hand[0], hand[1], hand[2]] };
  const shedLow = { actor: seat, type: "passCards", cards: [hand[0], hand.at(-1), hand.at(-2)] };

  assert.ok(heuristic(ctx, shedHigh) > heuristic(ctx, shedLow),
    "two passes sharing a first card scored the same — the whole pass is not being read");
});

test("a persona's mistakes stay near-best, and never reach the worst move", () => {
  const state = dealt("wildfire", "mistakes");
  const seat = state.turn.seat;
  const ranked = rankMoves(state, seat, { persona: PERSONAS.reckless });
  if (ranked.length < 4) return; // nothing to be wrong about

  const allowed = new Set(ranked.slice(0, 3).map((e) => JSON.stringify(e.move)));
  // A stream that always "makes a mistake", so every draw takes the branch.
  let calls = 0;
  const random = () => (calls++ % 2 === 0 ? 0 : 0.99);
  for (let i = 0; i < 40; i++) {
    const move = chooseBotMove(state, seat, { persona: PERSONAS.reckless, random });
    assert.ok(allowed.has(JSON.stringify(move)),
      "a mistake reached beyond the runner-up group");
  }
});
