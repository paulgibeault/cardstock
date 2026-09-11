// The action-card event vocabulary (src/templates/shedding.js).
//
// A skip, a reverse and a Draw 2 are the most consequential things anyone
// plays and were, until these events existed, the least visible: the state
// changed and the only trace on the felt was that the discard looked
// different. The table now narrates them (celebrateAction in src/ui/table.js),
// and what it narrates is this — so these tests pin the payloads the wording
// turns on, above all `seat`, which is always the seat it HAPPENED TO rather
// than the seat that played it.
import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { TRICK_BANNER_PRIORITY } from "../src/ui/celebrations.js";

function put(state, address, cardIds) {
  const zone = state.zones.get(address);
  zone.cards.push(...cardIds);
  for (const id of cardIds) state.cardLocation.set(id, address);
}

// A three-seat Wildfire table mid-hand, with the deck left in the draw pile so
// a penalty has something real to deal.
async function wildfireTable({ hands, discard = ["red-5"], activeColor = "red", seat = 0 }) {
  const pack = await loadPackFromDisk("wildfire");
  const state = createState({ pack, seats: 3, seed: "action-events" });
  const placed = new Set([...discard, ...Object.values(hands).flat()]);
  put(state, "discard", discard);
  for (const [addr, cards] of Object.entries(hands)) put(state, addr, cards);
  put(state, "draw", [...pack.cardsById.keys()].filter((id) => !placed.has(id)));
  state.vars.activeColor = activeColor;
  state.turn.seat = seat;
  state.turn.phase = "play";
  return { pack, state };
}

function eventOf(state, type) {
  return state.events.find((e) => e.type === type);
}

test("a skip names the seat that loses its turn, not the one that played it", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-skip", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-skip"] });

  const ev = eventOf(state, "skipped");
  assert.ok(ev, "a skip emits `skipped`");
  assert.equal(ev.by, 0, "played by seat 0");
  assert.equal(ev.seat, 1, "landed on seat 1");
  assert.equal(state.turn.seat, 2, "and seat 1's turn is genuinely gone");
});

test("a reverse reports the direction now in force", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-reverse", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-reverse"] });

  const ev = eventOf(state, "reversed");
  assert.ok(ev, "a reverse emits `reversed`");
  assert.equal(ev.direction, -1, "the direction reported is the one after the flip");
  assert.equal(state.direction, -1);
});

test("a penalty reports the cards actually dealt", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-draw2", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-draw2"] });

  const ev = eventOf(state, "penalty");
  assert.ok(ev, "a Draw 2 emits `penalty`");
  assert.equal(ev.seat, 1, "it landed on seat 1");
  assert.equal(ev.drew, 2);
  assert.equal(ev.asked, 2);
  assert.equal(state.zones.count("hand.1"), 3, "one card became three");
});

test("a wild carries the value it chose, which its own face cannot show", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["wild", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["wild"], choice: { color: "blue" } });

  const ev = eventOf(state, "wildPlayed");
  assert.ok(ev, "a wild emits `wildPlayed`");
  assert.equal(ev.seat, 0);
  assert.equal(ev.chose.color, "blue", "the chosen colour rides on the event");
  assert.equal(state.vars.activeColor, "blue");
});

test("an ordinary card says nothing — the felt stays quiet", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-5#2", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-5#2"] });

  const noisy = state.events.filter((e) => e.type !== "roundOver" && e.type !== "roundStart");
  assert.deepEqual(noisy, [], `a plain play emitted ${JSON.stringify(noisy)}`);
});

test("winning on an action card does not penalise anybody", async () => {
  // applyPlayCard returns at the win before applyEffect, which is deliberate:
  // the hand is over, so there is no next player to hand two cards to. The
  // event channel has to agree, or the table narrates a penalty that the
  // engine never applied.
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-draw2"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-draw2"] });

  assert.equal(eventOf(state, "penalty"), undefined, "no penalty is announced");
  // The hand sizes cannot be read back for this: emptying a hand ends the
  // round, and the pipeline has already dealt the next one underneath this
  // move. What is observable is that the round ended, and that seat 0 was
  // scored as the winner — the losers' cards going TO them.
  const over = eventOf(state, "roundOver");
  assert.ok(over, "the hand ended");
  assert.ok(over.scores[0] > 0, `seat 0 won the round (scores: ${JSON.stringify(over.scores)})`);
});

test("the events survive a replay, because they are derived from the log", async () => {
  const { pack, state } = await wildfireTable({
    hands: { "hand.0": ["red-skip", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-skip"] });
  const first = eventOf(state, "skipped");

  // Same state, same move, applied again from scratch: the event stream is a
  // function of the move, never of anything the UI did with the last one.
  const { state: again } = await wildfireTable({
    hands: { "hand.0": ["red-skip", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  applyMove(again, { actor: 0, type: "playCard", cards: ["red-skip"] });

  assert.deepEqual(eventOf(again, "skipped"), first);
  assert.ok(pack);
});

test("the event window is one move wide", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-skip", "red-3"], "hand.1": ["blue-1"], "hand.2": ["red-2"] },
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-skip"] });
  assert.ok(eventOf(state, "skipped"));

  // Seat 1 was skipped, so seat 2 acts next; their plain play must clear it.
  applyMove(state, { actor: 2, type: "playCard", cards: ["red-2"] });
  assert.equal(eventOf(state, "skipped"), undefined, "last move's event did not linger");
});

// The table flies `drew` copies from the deck to the seat that was hit, and it
// picks WHICH faces to draw by taking the last `drew` of that seat's hand
// (animatePenaltyDraw in src/ui/table.js). That is only true while a draw
// APPENDS, so pin it here rather than in a comment: the day a template inserts
// a drawn card anywhere else, the human's own penalty would fly the wrong
// cards — a wrong card is worse than no animation, and nothing else would fail.
test("a penalty's cards arrive at the END of the hand it lands on", async () => {
  const { state } = await wildfireTable({
    hands: { "hand.0": ["red-draw2", "green-3"], "hand.1": ["blue-1"], "hand.2": ["blue-2"] },
  });
  const deckTop = state.zones.cards("draw").slice(-2);
  applyMove(state, { actor: 0, type: "playCard", cards: ["red-draw2"] });

  const ev = eventOf(state, "penalty");
  const hand = state.zones.cards(`hand.${ev.seat}`);
  assert.deepEqual(hand.slice(-ev.drew), deckTop.slice().reverse(),
    "the last `drew` cards of the hand are the ones just taken off the deck");
  assert.deepEqual(hand.slice(0, -ev.drew), ["blue-1"], "and nothing it held moved");
});

/* ------------------------------------------------------------------ *
 * BREAKING (#151) — the one rule in the trick genre the felt never said
 * ------------------------------------------------------------------ *
 *
 * `placeCard` in src/templates/trick-taking.js flipped `spadesBroken` and
 * emitted nothing, so a player found out that spades were broken by noticing
 * that leading one was suddenly allowed. These pin the event that fixes it:
 * its payload, that it fires EXACTLY ONCE a hand, that the var it sets is one
 * a joiner can actually see, and that its sentence outranks the trick it so
 * often arrives inside.
 */

/** A trick table mid-hand, with the hands dealt by hand and nothing broken. */
async function trickTable(packId, hands, { broken = false, seats = 4, trickNumber = 1 } = {}) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed: "breaking" });
  for (let seat = 0; seat < seats; seat++) state.zones.get(`hand.${seat}`).cards.length = 0;
  for (const [addr, cards] of Object.entries(hands)) put(state, addr, cards);
  for (let seat = 0; seat < seats; seat++) state.playerVars[seat].bid = 3;
  state.turn.phase = "play";
  state.turn.seat = 0;
  state.vars.trickNumber = trickNumber;
  state.vars.leader = 0;
  state.vars.led = null;
  state.vars[pack.rules.breaking.var] = broken;
  return { pack, state };
}

test("a suit breaking is an event, and it names the card that did it", async () => {
  // Seat 0 leads a heart; seat 1 is void and throws a spade in. That is the
  // whole of "spades are broken", and it used to happen in silence.
  const { state } = await trickTable("team-spades", {
    "hand.0": ["hearts-5", "clubs-3"],
    "hand.1": ["spades-7", "diamonds-4"],
    "hand.2": ["hearts-9", "clubs-8"],
    "hand.3": ["hearts-2", "clubs-9"],
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["hearts-5"] });
  assert.equal(eventOf(state, "broken"), undefined, "a heart breaks nothing");

  applyMove(state, { actor: 1, type: "playCard", cards: ["spades-7"] });
  const ev = eventOf(state, "broken");
  assert.ok(ev, "the spade emits `broken`");
  assert.equal(ev.seat, 1, "the seat that played it");
  assert.deepEqual(ev.cards, ["spades-7"],
    "the id rides in `cards`, which is the only field src/engine/view.js filters");
  assert.equal(ev.suit, "spades", "the suit that may now be led");
  assert.deepEqual(ev.card, { rank: "7", suit: "spades" },
    "and what broke it, because describeEvent gets no card lookup");
  assert.equal(ev.varName, "spadesBroken");
  assert.equal(state.vars.spadesBroken, true, "and the rule really did change");
});

test("the break fires once a hand, however many spades follow it", async () => {
  const { state } = await trickTable("team-spades", {
    "hand.0": ["hearts-5", "hearts-6"],
    "hand.1": ["spades-7", "spades-8"],
    "hand.2": ["hearts-9", "hearts-10"],
    "hand.3": ["hearts-2", "hearts-3"],
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["hearts-5"] });
  applyMove(state, { actor: 1, type: "playCard", cards: ["spades-7"] });
  assert.ok(eventOf(state, "broken"), "the first spade breaks them");

  applyMove(state, { actor: 2, type: "playCard", cards: ["hearts-9"] });
  applyMove(state, { actor: 3, type: "playCard", cards: ["hearts-2"] });
  // Seat 1 took that trick with the spade, so it leads the next one — with the
  // second spade, which breaks nothing because they are already broken.
  applyMove(state, { actor: 1, type: "playCard", cards: ["spades-8"] });
  assert.equal(eventOf(state, "broken"), undefined,
    "a second spade in a hand where spades are already broken announces nothing");
});

test("hearts names the suit that is freed, not the suit of the card", async () => {
  // The queen of spades breaks hearts: `breaking.when` is `tag:penalty played`
  // and the lead constraint it lifts is `suit:hearts`. A sentence built off the
  // card would say "Spades are broken" at a table with no spade rule in it.
  const { state } = await trickTable("hearts", {
    "hand.0": ["clubs-5", "clubs-3"],
    "hand.1": ["spades-Q", "diamonds-4"],
    "hand.2": ["clubs-9", "clubs-8"],
    "hand.3": ["clubs-2", "clubs-4"],
    // The queen is a `tag:penalty` card and those are barred from the first
    // trick (`playConstraints: notTrick1`), so this is the second.
  }, { trickNumber: 2 });
  applyMove(state, { actor: 0, type: "playCard", cards: ["clubs-5"] });
  applyMove(state, { actor: 1, type: "playCard", cards: ["spades-Q"] });

  const ev = eventOf(state, "broken");
  assert.ok(ev, "the queen emits `broken`");
  assert.equal(ev.suit, "hearts", "hearts are what may now be led");
  assert.deepEqual(ev.card, { rank: "Q", suit: "spades" }, "and a spade is what did it");
  assert.equal(state.vars.heartsBroken, true);
});

// THE MISMATCH THIS ISSUE FOUND. `publicVars` read `rules.broken?.varName` and
// no manifest has ever had a `rules.broken` — the key is `rules.breaking.var`.
// The optional chaining made it silent, and the cost was a joiner whose own
// lead constraint never lifted: their view said the suit had never been broken
// for the whole hand while the host's legal-move list said otherwise.
test("the var a break sets is one a joiner can see", async () => {
  for (const [packId, varName] of [["team-spades", "spadesBroken"], ["hearts", "heartsBroken"]]) {
    const pack = await loadPackFromDisk(packId);
    assert.ok(pack.template.publicVars(pack.rules).includes(varName),
      `${packId}: ${varName} must be public — it governs what every seat may lead`);
  }
});

test("a pack with no breaking rule publishes no extra var", async () => {
  const pack = await loadPackFromDisk("pinochle");
  const published = pack.template.publicVars(pack.rules);
  assert.deepEqual(published, ["leader", "led", "trickNumber", "passDirection", "trumpSuit"],
    "nothing is invented for a pack that never breaks anything");
});

test("the break outranks the trick it so often arrives inside", async () => {
  const { pack, state } = await trickTable("team-spades", {
    "hand.0": ["hearts-5"],
    "hand.1": ["hearts-9"],
    "hand.2": ["hearts-2"],
    "hand.3": ["spades-7"],
  });
  applyMove(state, { actor: 0, type: "playCard", cards: ["hearts-5"] });
  applyMove(state, { actor: 1, type: "playCard", cards: ["hearts-9"] });
  applyMove(state, { actor: 2, type: "playCard", cards: ["hearts-2"] });
  // The FOURTH card of the trick is the spade, so the move that breaks them is
  // also the move that sweeps the trick — which is the case the banner used to
  // lose entirely (src/ui/table.js suppressed celebrateAction whenever a trick
  // had fired).
  applyMove(state, { actor: 3, type: "playCard", cards: ["spades-7"] });
  assert.ok(eventOf(state, "trickWon"), "the trick resolved in the same move");

  const ev = eventOf(state, "broken");
  assert.ok(ev, "and the break is still on the event window");
  const said = pack.template.describeEvent(ev, {
    seatLabel: (seat) => ["Ada", "Fig", "Pip", "Sable"][seat], viewerSeat: 0,
  });
  assert.equal(said.text, "Spades are broken — Sable played the 7♠");
  assert.ok((said.priority || 0) > TRICK_BANNER_PRIORITY,
    "a break must out-rank a trick's own celebration or the banner never shows it");
});

test("the sentence says \"you\" to the seat that broke them", async () => {
  const pack = await loadPackFromDisk("team-spades");
  const ev = {
    type: "broken", seat: 2, suit: "spades", card: { rank: "K", suit: "spades" },
  };
  const said = (viewerSeat) => pack.template.describeEvent(ev, {
    seatLabel: (seat) => ["Ada", "Fig", "Pip", "Sable"][seat], viewerSeat,
  }).text;
  assert.equal(said(2), "Spades are broken — you played the K♠");
  assert.equal(said(0), "Spades are broken — Pip played the K♠");
});

// The mark that outlives the banner: a chip on the contract strip, read off the
// var rather than off the event, which is what makes it survive a reload.
test("a broken suit leaves a chip on the felt until the next deal", async () => {
  const { pack, state } = await trickTable("team-spades", {
    "hand.0": ["hearts-5"], "hand.1": ["spades-7"], "hand.2": ["hearts-9"], "hand.3": ["hearts-2"],
  });
  const chips = () => pack.template.contractChips(makeCtx(state), 0) || [];
  assert.equal(chips().find((c) => c.key === "broken"), undefined,
    "nothing is marked before anything is broken");

  applyMove(state, { actor: 0, type: "playCard", cards: ["hearts-5"] });
  applyMove(state, { actor: 1, type: "playCard", cards: ["spades-7"] });
  const chip = chips().find((c) => c.key === "broken");
  assert.ok(chip, "the strip carries the mark once the suit is broken");
  assert.equal(chip.value, "Broken");
  assert.equal(chip.label, "Spades");
  assert.equal(chip.suit, "spades", "drawn with the pack's own suit tile");

  // THE NEXT DEAL CLEARS IT, and nothing had to remember to: `setup` sets the
  // var back to false and the chip is a reading of the var.
  state.vars.spadesBroken = false;
  assert.equal(chips().find((c) => c.key === "broken"), undefined);
});

test("hearts marks hearts, and a pack that breaks nothing has no strip at all", async () => {
  const { pack, state } = await trickTable("hearts", {
    "hand.0": ["clubs-5"], "hand.1": ["hearts-4"], "hand.2": ["clubs-9"], "hand.3": ["clubs-2"],
  });
  state.vars.heartsBroken = true;
  const chip = (pack.template.contractChips(makeCtx(state), 0) || [])
    .find((c) => c.key === "broken");
  assert.equal(chip.label, "Hearts");

  const spades = await loadPackFromDisk("thirteen");
  assert.equal(spades.template.contractChips?.(makeCtx(createState({
    pack: spades, seats: 4, seed: "no-break",
  })), 0) ?? null, null, "a pack with no contract and no breaking rule keeps the row's height");
});

// ONE SENTENCE ON THE RULES PAGE. The rule was enforced from the day the
// template shipped and written down nowhere.
test("the rules page explains breaking for the packs that do it", async () => {
  for (const [packId, suit] of [["team-spades", "spades"], ["hearts", "hearts"]]) {
    const pack = await loadPackFromDisk(packId);
    const lines = pack.template.ruleLines(pack.rules);
    const said = lines.find((line) => /broken/.test(line));
    assert.ok(said, `${packId}: the rules page never mentions breaking`);
    assert.ok(said.includes(suit), `${packId}: the sentence must name ${suit}`);
  }
  const pinochle = await loadPackFromDisk("pinochle");
  assert.equal(pinochle.template.ruleLines(pinochle.rules).find((l) => /broken/.test(l)), undefined,
    "and says nothing about it to a pack that has no such rule");
});
