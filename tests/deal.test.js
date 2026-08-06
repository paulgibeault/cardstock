// What a fresh deal guarantees, for every shedding pack.
//
// The rule-test corpus (tools/pack-test.mjs) builds each state directly from a
// `setup` block precisely so a rule can be pinned without dealing — which
// leaves template.setup() itself, the one piece of rule that only runs at a
// deal, untested by it. These are the deal-time invariants: a starting card
// anyone can actually play on, and a round that opens fresh rather than wearing
// the previous round's direction and turn.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { baseId } from "../src/engine/selectors.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";

const SHEDDING_PACKS = ["wildfire", "crazy-eights"];

function isWild(card) {
  const effect = card?.effect;
  if (!effect) return false;
  const type = typeof effect === "string" ? effect : effect.type;
  return type === "wild" || type === "wildDrawN";
}

function deal(pack, { seats = 3, seed = "deal-test", roundNumber = 1 } = {}) {
  const state = createState({ pack, seats, seed });
  state.roundNumber = roundNumber;
  pack.template.setup(makeCtx(state));
  return state;
}

function starterOf(pack, state) {
  const topId = state.zones.top("discard");
  assert.ok(topId !== undefined, "a card was flipped to the discard");
  return { id: topId, card: pack.cardsById.get(baseId(topId)) };
}

for (const packId of SHEDDING_PACKS) {
  test(`${packId}: the starting card is never a wild`, async () => {
    const pack = await loadPackFromDisk(packId);
    // Enough seeds to cross the ~7% of shuffles that used to turn up a wild.
    for (let i = 0; i < 200; i++) {
      const state = deal(pack, { seed: `starter-${i}` });
      const { id, card } = starterOf(pack, state);
      assert.ok(
        !isWild(card),
        `seed starter-${i} dealt a wild starter (${id}) — every ordinary card would be unplayable`,
      );
    }
  });

  test(`${packId}: the active attribute is set, so ordinary cards can match`, async () => {
    const pack = await loadPackFromDisk(packId);
    for (let i = 0; i < 40; i++) {
      const state = deal(pack, { seed: `active-${i}` });
      const { id, card } = starterOf(pack, state);
      const carries = pack.rules.matchOn.some(
        (attr) => card[attr] !== null && card[attr] !== undefined,
      );
      assert.ok(carries, `starter ${id} carries none of ${pack.rules.matchOn.join("/")}`);
    }
  });

  test(`${packId}: burying a wild starter keeps it in the deck`, async () => {
    const pack = await loadPackFromDisk(packId);
    const total = pack.cardsById.size;
    for (let i = 0; i < 40; i++) {
      const state = deal(pack, { seed: `conserve-${i}` });
      const held = state.zones
        .allAddresses()
        .reduce((sum, addr) => sum + state.zones.count(addr), 0);
      assert.equal(held, total, "every card in the deck is still somewhere on the table");
    }
  });

  test(`${packId}: a new round opens fresh, not mid-reverse on the winner`, async () => {
    const pack = await loadPackFromDisk(packId);
    const state = createState({ pack, seats: 3, seed: "reset" });
    // Stand in for the round that just ended: reversed, and parked on its winner.
    state.direction = -1;
    state.turn.seat = 2;
    state.roundNumber = 2;
    pack.template.setup(makeCtx(state));
    assert.equal(state.direction, 1, "direction resets with the deal");
    assert.equal(state.turn.seat, 1, "the deal rotates one seat per round");
  });
}
