// WHAT OUTRANKS WHAT, and the two places the platform used to guess.
//
// `rankOrder` put `Number(card.rank)` and the position in RANKS on ONE number
// line, so on a standard 52 the jack landed on 9 (its RANKS index) and tied the
// nine, the queen tied the ten, and the TEN STRICTLY OUTRANKED THE JACK.
// `rankDomain` scanned `Number(card.rank)` alone, so the run window of a
// standard 52 was {2 … 10} and no run could ever hold a face card.
//
// The order is declared now (`rankLadder` at the root of a manifest) and
// resolved once per pack in src/engine/cards.js. These tests are also the
// honesty check for the declaration itself: `rankLadder` is deliberately NOT
// under `rules`, so the "every declared parameter is read somewhere in src/"
// gate in repo-gates.test.js does not cover it, and the schema description says
// to look here instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  RANKS, buildStandardDeck, cardOrder, rankAt, rankIndexOf, rankLadderOf, rankOrder,
} from "../src/engine/cards.js";
import { loadPack } from "../src/engine/packLoader.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { resolveMeld, rankDomain } from "../src/templates/melds.js";
import { ROOT } from "../tools/stage.mjs";

function packFromDisk(packId, extra = {}) {
  const dir = path.join(ROOT, "packs", packId);
  const manifest = {
    ...JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")),
    ...extra,
  };
  const deckPath = path.join(dir, "deck.json");
  const deckJson = fs.existsSync(deckPath)
    ? JSON.parse(fs.readFileSync(deckPath, "utf8")) : undefined;
  return loadPack(manifest, { deckJson });
}

/** A pack over a built-in deck, so a ladder can be declared without a pack on disk. */
function packWith(overrides) {
  return loadPack({
    id: "ladder-probe",
    name: "Ladder probe",
    version: "0.0.0",
    players: { min: 2, max: 4, best: 4 },
    deck: "standard-52",
    template: "trick-taking",
    rules: {},
    ...overrides,
  });
}

/* ------------------------------------------------------------------ *
 * The standard ladder
 * ------------------------------------------------------------------ */

test("rankOrder is strictly monotonic and injective over the standard ladder within a suit", () => {
  const pack = packWith({});
  const ladder = rankLadderOf(pack);

  const orders = RANKS.map((rank) => rankOrder(pack.cardsById.get(`hearts-${rank}`), ladder));
  for (let i = 1; i < orders.length; i++) {
    assert.ok(orders[i] > orders[i - 1],
      `${RANKS[i]} must outrank ${RANKS[i - 1]}, got ${orders[i]} vs ${orders[i - 1]}`);
  }
  assert.equal(new Set(orders).size, RANKS.length, "two ranks share a place on the ladder");

  // Named, because these four are the whole bug: the jack used to score 9 (its
  // index in RANKS) and lose to the ten, which scored 10 (its numeric value).
  const of = (rank) => rankOrder(pack.cardsById.get(`hearts-${rank}`), ladder);
  assert.ok(of("J") > of("10"), "the jack must outrank the ten");
  assert.ok(of("J") > of("9"), "the jack must outrank the nine");
  assert.ok(of("Q") > of("10"), "the queen must outrank the ten");
  assert.ok(of("A") > of("K"), "the ace must outrank the king");
});

test("the ladder is the same in every suit, so a trick is decided by rank alone", () => {
  const pack = packWith({});
  const ladder = rankLadderOf(pack);
  for (const rank of RANKS) {
    const orders = ["clubs", "diamonds", "hearts", "spades"]
      .map((suit) => rankOrder(pack.cardsById.get(`${suit}-${rank}`), ladder));
    assert.equal(new Set(orders).size, 1, `${rank} ranks differently in different suits`);
  }
});

test("called without a ladder, rankOrder is still monotonic over the standard ranks", () => {
  // The deckless answer — no pack to ask, so it falls back to the same three
  // tiers, stacked rather than merged. It cannot know a DECLARED order, but it
  // must not put the jack on top of the nine either.
  const orders = RANKS.map((rank) => rankOrder({ rank, sortOrder: 0 }));
  for (let i = 1; i < orders.length; i++) {
    assert.ok(orders[i] > orders[i - 1], `${RANKS[i]} must outrank ${RANKS[i - 1]} with no ladder`);
  }
});

/* ------------------------------------------------------------------ *
 * The declaration, and what a pack that makes none gets
 * ------------------------------------------------------------------ */

test("a declared rankLadder is the order, however little it resembles the deck's", () => {
  // Thirteen (#102) and Pinochle (#106) — the two orders on the roadmap that
  // no derivation from a standard 52 could ever produce.
  const thirteen = rankLadderOf(packWith({
    rankLadder: ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"],
  }));
  assert.deepEqual([...thirteen.ranks], ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"]);
  assert.ok(rankIndexOf(thirteen, "2") > rankIndexOf(thirteen, "A"), "the two is Thirteen's top card");
  assert.ok(rankIndexOf(thirteen, "3") < rankIndexOf(thirteen, "4"), "the three is Thirteen's bottom card");

  const pinochle = rankLadderOf(packWith({ rankLadder: ["9", "J", "Q", "K", "10", "A"] }));
  assert.ok(rankIndexOf(pinochle, "10") > rankIndexOf(pinochle, "K"),
    "Pinochle's ten sits between the king and the ace");
  assert.ok(rankIndexOf(pinochle, "J") > rankIndexOf(pinochle, "9"));
});

test("a rank the declaration does not name sits below the whole ladder", () => {
  // Pinochle's ladder over an unstripped deck: the 2-8 it never names must not
  // be silently promoted above the ace. A card nobody gave a place to should
  // not win a trick.
  const pack = packWith({ rankLadder: ["9", "J", "Q", "K", "10", "A"] });
  const ladder = rankLadderOf(pack);
  assert.ok(rankIndexOf(ladder, "8") < rankIndexOf(ladder, "9"), "an unnamed rank outranked a named one");
  assert.equal(new Set(ladder.ranks).size, ladder.ranks.length, "the ladder repeats a rank");
  // Still injective over the whole deck, which is what stops two unnamed ranks
  // from tying each other.
  const seen = new Set(RANKS.map((rank) => rankOrder(pack.cardsById.get(`clubs-${rank}`), ladder)));
  assert.equal(seen.size, RANKS.length);
});

test("a pack that declares nothing keeps the order its deck already implied", () => {
  // Milestones and Stockpile are ranked 1-12 with word-ranked action cards, and
  // Wildfire 0-9 with the same. Numbers ascending, then anything the standard
  // ladder names, then the words in deck order — which is exactly where they
  // sat before the ladder existed, so nothing about these three moves.
  for (const packId of ["milestones", "stockpile", "wildfire"]) {
    const pack = packFromDisk(packId);
    const ladder = rankLadderOf(pack);
    const numeric = ladder.ranks.filter((r) => Number.isFinite(Number(r)));
    assert.deepEqual(numeric, [...numeric].sort((a, b) => Number(a) - Number(b)),
      `${packId}: numeric ranks are not in ascending order`);
    assert.deepEqual(ladder.ranks.slice(0, numeric.length), numeric,
      `${packId}: a word-ranked card slipped in among the numbers`);
    assert.equal(new Set(ladder.ranks).size, ladder.ranks.length, `${packId}: a rank appears twice`);
  }

  // Hearts declares nothing either, and gets the standard ladder back.
  assert.deepEqual([...rankLadderOf(packFromDisk("hearts")).ranks], RANKS);
});

test("a suitLadder makes the order over the deck total", () => {
  // Thirteen's tiebreak (#102). Nothing consumes it yet; `cardOrder` is where
  // it is read, and "no two cards compare equal" is the property a climbing
  // game's "play higher or pass" needs.
  const pack = packWith({
    rankLadder: ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"],
    suitLadder: ["spades", "clubs", "diamonds", "hearts"],
  });
  const ladder = rankLadderOf(pack);
  const orders = [...pack.cardsById.values()].map((card) => cardOrder(card, ladder));
  assert.equal(new Set(orders).size, 52, "two cards share a place in a total order");
  assert.ok(cardOrder(pack.cardsById.get("hearts-5"), ladder)
    > cardOrder(pack.cardsById.get("spades-5"), ladder), "hearts outrank spades on a tie");
  assert.ok(cardOrder(pack.cardsById.get("spades-6"), ladder)
    > cardOrder(pack.cardsById.get("hearts-5"), ladder), "the suit tiebreak overtook the rank");

  // Without one, ties are ties — inventing an order the pack never declared
  // would be worse than admitting there is none.
  const plain = rankLadderOf(packWith({}));
  assert.equal(cardOrder(pack.cardsById.get("hearts-5"), plain),
    cardOrder(pack.cardsById.get("spades-5"), plain));
});

test("rankAt is the inverse of rankIndexOf, which is what freezes a wild", () => {
  const ladder = rankLadderOf(packWith({}));
  for (const rank of RANKS) assert.equal(rankAt(ladder, rankIndexOf(ladder, rank)), rank);
  assert.equal(rankIndexOf(ladder, "joker"), -1, "a rank off the ladder must say so");
  assert.equal(rankAt(ladder, -1), undefined);
});

test("a rank the deck never uses is not on the ladder at all", () => {
  const deck = buildStandardDeck("standard-54", { jokers: 2 });
  assert.ok(deck.cards.some((c) => c.rank === "joker"));
  const pack = loadPack({
    id: "jokers", name: "Jokers", version: "0.0.0",
    players: { min: 2, max: 4, best: 4 },
    deck: "standard-54", template: "trick-taking", rules: {},
  });
  const ladder = rankLadderOf(pack);
  // The joker IS in this deck, so it gets a place — in the third tier, above
  // the ranks the standard ladder names, because deck order is the last resort.
  assert.ok(rankIndexOf(ladder, "joker") > rankIndexOf(ladder, "A"));
});

/* ------------------------------------------------------------------ *
 * The run window
 * ------------------------------------------------------------------ */

/** Contract-rummy over an unmodified standard 52 — the pack #107 will be. */
function rummy52() {
  const pack = loadPack({
    id: "rummy52",
    name: "Rummy 52",
    version: "0.0.0",
    players: { min: 2, max: 4, best: 4 },
    deck: "standard-52",
    template: "contract-rummy",
    rules: {
      deal: 10,
      contracts: [["run(4)"], ["set(3)", "run(4)"]],
      wilds: { tag: "wild", minNaturals: 1, maxPerMeld: null },
      drawFrom: ["draw", "discard"],
    },
  });
  const state = createState({ pack, seats: 2, seed: "rank-ladder" });
  pack.template.setup(makeCtx(state));
  return makeCtx(state);
}

test("a run of face cards resolves on a standard-52 pack", () => {
  const ctx = rummy52();

  // The bug, stated as the meld it refused: the run domain was built from
  // Number(card.rank), so it was {2 … 10} and 10-J-Q-K was "past the ends of
  // the deck" — on a deck that has all four of those cards.
  const jqka = resolveMeld(ctx, "run(4)", ["hearts-J", "hearts-Q", "hearts-K", "hearts-A"]);
  assert.ok(jqka.ok, `J-Q-K-A was refused: ${jqka.rule} — ${jqka.reason}`);

  const tenUp = resolveMeld(ctx, "run(4)", ["clubs-10", "clubs-J", "clubs-Q", "clubs-K"]);
  assert.ok(tenUp.ok, `10-J-Q-K was refused: ${tenUp.rule} — ${tenUp.reason}`);

  // And the ladder decides which runs are runs: the jack follows the ten, so a
  // window that skips it is still a gap.
  const skipsTheJack = resolveMeld(ctx, "run(4)", ["clubs-9", "clubs-10", "clubs-Q", "clubs-K"]);
  assert.equal(skipsTheJack.ok, false, "9-10-Q-K is not a run");

  // The ace is the top of this ladder, so nothing runs off the end past it.
  const overTheTop = resolveMeld(ctx, "run(4)", ["clubs-Q", "clubs-K", "clubs-A", "spades-2"]);
  assert.equal(overTheTop.ok, false, "Q-K-A-2 wrapped around the top of the deck");
});

test("a wild in a face-card run freezes to a face card", () => {
  const ctx = rummy52();
  // No pack ships a wild-tagged standard 52 yet, so the wild here is the
  // deck's own: `cardTags` puts the tag on the queens, which is all
  // `rules.wilds.tag` asks for.
  const tagged = loadPack({
    id: "rummy52w",
    name: "Rummy 52 (wilds)",
    version: "0.0.0",
    players: { min: 2, max: 4, best: 4 },
    deck: "standard-52",
    template: "contract-rummy",
    cardTags: { "rank:Q": ["wild"] },
    rules: {
      deal: 10,
      contracts: [["run(4)"]],
      wilds: { tag: "wild", minNaturals: 1, maxPerMeld: null },
      drawFrom: ["draw", "discard"],
    },
  });
  const state = createState({ pack: tagged, seats: 2, seed: "rank-ladder-wild" });
  tagged.template.setup(makeCtx(state));
  const wildCtx = makeCtx(state);

  const run = resolveMeld(wildCtx, "run(4)", ["clubs-10", "clubs-J", "hearts-Q", "clubs-K"]);
  assert.ok(run.ok, `10-J-[wild]-K was refused: ${run.rule} — ${run.reason}`);
  assert.equal(run.wilds["hearts-Q"].rank, "Q",
    "the wild filled the hole between the jack and the king, which is the queen");

  // Only the ladder can say that. On the old numeric scan the hole between a
  // jack and a king had no rank a card could carry.
  assert.equal(ctx.pack.cardsById.get("clubs-Q").rank, "Q");
});

test("the run domain spans the whole ladder, minus the cards a run cannot sit on", () => {
  const ctx = rummy52();
  const ladder = rankLadderOf(ctx.pack);
  assert.deepEqual(rankDomain(ctx), { min: 0, max: RANKS.length - 1 });
  assert.equal(rankAt(ladder, rankDomain(ctx).max), "A");

  // Milestones bars its skips from melds and its wilds have no rank of their
  // own, so its window is still the twelve numbers it always was — the same
  // twelve ranks, now counted as ladder positions.
  const milestones = packFromDisk("milestones");
  const mState = createState({ pack: milestones, seats: 3, seed: "rank-ladder-milestones" });
  milestones.template.setup(makeCtx(mState));
  const mCtx = makeCtx(mState);
  const mLadder = rankLadderOf(milestones);
  const domain = rankDomain(mCtx);
  assert.equal(domain.max - domain.min + 1, 12, "Milestones' run window changed width");
  assert.equal(rankAt(mLadder, domain.min), "1");
  assert.equal(rankAt(mLadder, domain.max), "12");
});
