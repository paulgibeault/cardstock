// THE TWO READS A MILESTONES BOT MAKES BEFORE LETTING GO OF A CARD
// (src/templates/contract-rummy-bot.js, FEEDS_NEXT and SAFE_WORTH): don't hand
// the next seat to draw a card it can play onto the felt at once, and a rank a
// rival just threw away is a rank it isn't collecting.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { scoreDiscard, PILE_THROWN_VAR, WEIGHTS } from "../src/templates/contract-rummy-bot.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

async function drawn(seed) {
  const pack = await loadPackFromDisk("milestones");
  const state = createState({ pack, seats: 4, seed });
  pack.template.setup(makeCtx(state));
  const actor = state.turn.seat;
  applyMove(state, { actor, type: "draw", from: "draw" });
  return { state, actor };
}

function place(state, id, address) {
  for (const from of state.zones.allAddresses()) {
    const cards = state.zones.cards(from);
    const at = cards.indexOf(id);
    if (at >= 0) { cards.splice(at, 1); break; }
  }
  state.zones.cards(address).push(id);
}

const cardOf = (state, id) => state.pack.cardsById.get(id.split("#")[0]);
const natural = (state, id) => /^\d+$/.test(String(cardOf(state, id).rank));

test("a discard is cheaper once a rival has been seen throwing its rank", async () => {
  assert.ok(WEIGHTS.SAFE_WORTH > 0, "SAFE_WORTH is off");
  const { state, actor } = await drawn("reads:safe");
  const id = state.zones.cards(`hand.${actor}`).find((c) => natural(state, c));
  const move = { actor, type: "discard", cards: [id] };
  const ctx = makeCtx(state);
  const before = scoreDiscard(ctx, move);
  const rival = (actor + 2) % 4;
  const thrown = Array.from({ length: 4 }, () => []);
  thrown[rival] = [{ rank: cardOf(state, id).rank, color: null }];
  ctx.setVar(PILE_THROWN_VAR, thrown);
  const after = scoreDiscard(makeCtx(state), move);
  assert.ok(Math.abs(after - before - WEIGHTS.SAFE_WORTH) < 1e-9,
    `a rival throwing the rank moved the discard by ${after - before}, not ${WEIGHTS.SAFE_WORTH}`);
});

test("every discard is remembered as rank and colour, never as a card id", async () => {
  const { state, actor } = await drawn("reads:remember");
  const id = state.zones.cards(`hand.${actor}`).find((c) => natural(state, c));
  applyMove(state, { actor, type: "discard", cards: [id] });
  const seen = makeCtx(state).var(PILE_THROWN_VAR)[actor];
  assert.deepStrictEqual(seen, [{ rank: cardOf(state, id).rank, color: cardOf(state, id).color ?? null }]);
  assert.ok(!JSON.stringify(seen).includes(id), "the public record named the card id");
  assert.ok(state.pack.template.publicVars.includes(PILE_THROWN_VAR), "the record is not declared public");
});

test("a card the next seat could hit with is dearer to throw once that seat has laid down", async () => {
  assert.ok(WEIGHTS.FEEDS_NEXT > 0, "FEEDS_NEXT is off");
  const { state, actor } = await drawn("reads:feeds");
  const hand = state.zones.cards(`hand.${actor}`);
  const id = hand.find((c) => natural(state, c));
  const rank = cardOf(state, id).rank;
  // A set of that rank on the ACTOR's own felt: the next seat may hit anyone's melds.
  const mates = [];
  for (const address of state.zones.allAddresses()) {
    if (address === `hand.${actor}`) continue;
    for (const c of state.zones.cards(address)) {
      if (mates.length < 3 && cardOf(state, c).rank === rank) mates.push(c);
    }
  }
  assert.strictEqual(mates.length, 3, "not three more of the rank in the deck");
  const ctx = makeCtx(state);
  for (const c of mates) place(state, c, `melds.${actor}`);
  ctx.setPlayerVar(actor, "melds", [{ item: "set(3)", cards: mates.slice(), wilds: {} }]);
  ctx.setPlayerVar(actor, "laidDown", true);

  const next = ctx.nextSeat(actor);
  const move = { actor, type: "discard", cards: [id] };
  const open = scoreDiscard(makeCtx(state), move);
  ctx.setPlayerVar(next, "laidDown", true);
  const fed = scoreDiscard(makeCtx(state), move);
  assert.ok(Math.abs(open - fed - WEIGHTS.FEEDS_NEXT) < 1e-9,
    `the next seat laying down moved the discard by ${open - fed}, not ${WEIGHTS.FEEDS_NEXT}`);
});
