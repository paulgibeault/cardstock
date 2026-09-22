// THE REVEAL: every pack that prices cards at the end of a hand says so one
// seat at a time (issue #189, and "I want this on all games. Especially 13.").
//
// Cribbage's show was the only round ending the felt could hold up count by
// count, because cribbage was the only template that emitted `showScored`. The
// three scoring strategies that price CARDS (src/engine/scoring.js) now emit the
// same event — the cards, their value, and which price it was — so the felt's
// existing beat (src/ui/roundBeat.js) holds a Thirteen hand exactly as it holds
// a cribbage count, and the match end gets it too (finalShowPlan).
//
// Played through real packs with the house bot to the first round boundary,
// because the emission runs inside the round boundary and a hand-built state
// would be a second opinion about when that happens.

import { test } from "node:test";
import assert from "node:assert";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { createRng } from "../src/engine/rng.js";
import { forkState } from "../src/engine/fork.js";
import { handValue } from "../src/engine/scoring.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { showSteps } from "../src/ui/roundBeat.js";
import { showCardModel } from "../src/ui/showCard.js";
import { revealSentence } from "../src/ui/scoreDirection.js";

/** Play `packId` with the house bot until the first round boundary; the ending move's events. */
async function firstRoundEnd(packId, seats, seed = 3) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed });
  pack.template.setup(makeCtx(state));
  const rng = createRng(seed);
  for (let guard = 0; guard < 3000; guard++) {
    const acting = pack.template.actingSeats ? pack.template.actingSeats(makeCtx(state)) : [state.turn.seat];
    const seat = acting[0] ?? state.turn.seat;
    const move = chooseBotMove(state, seat, { difficulty: 'easy', random: rng.next });
    assert.ok(move, `${packId}: the bot ran out of moves before the hand ended`);
    // THE POSITION THE HAND ENDED IN, which is gone the instant the boundary
    // runs (it re-deals inside the move): the move re-applied to a fork with
    // the boundary deliberately not run — exactly what the felt does
    // (src/ui/table.js's takeRoundFinal). A reveal has to describe THIS.
    const ending = forkState(state);
    pack.template.applyMove(makeCtx(ending), move);
    const hands = {};
    for (let s = 0; s < seats; s++) hands[s] = ending.zones.cards(`hand.${s}`).map((id) => pack.cardsById.get(id));
    const won = {};
    for (let s = 0; s < seats; s++) if (ending.zones.has(`won.${s}`)) won[s] = ending.zones.cards(`won.${s}`).map((id) => pack.cardsById.get(id));
    applyMove(state, move);
    const over = state.events.find((e) => e.type === 'roundOver');
    if (over) return { pack, state, over, events: state.events.slice(), hands, won, move };
  }
  assert.fail(`${packId}: no round ended`);
}

const reveals = (events) => events.filter((e) => e.type === 'showScored');

test("Thirteen: every seat caught with cards is shown, and its card is its own delta", async () => {
  const { pack, over, events, hands } = await firstRoundEnd('thirteen', 4);
  const steps = reveals(events);
  assert.ok(steps.length >= 1, 'somebody was caught with cards');
  const caught = Object.keys(hands).filter((s) => hands[s].length).map(Number);
  assert.deepStrictEqual(steps.map((e) => e.seat).sort(), caught.sort(), 'one reveal per seat still holding cards');
  for (const step of steps) {
    assert.strictEqual(step.reason, 'leftover');
    assert.deepStrictEqual(step.cards, hands[step.seat].map((c) => c.id), 'the cards are the hand as it stood');
    assert.strictEqual(step.n, step.cards.length);
    assert.strictEqual(step.points, over.scores[step.seat], 'the card says what the sheet will charge');
    assert.strictEqual(step.points, handValue(hands[step.seat], pack.scoring));
    const rows = step.parts;
    assert.strictEqual(rows.reduce((sum, r) => sum + r.points, 0), step.points, 'the rows add up to the total');
    assert.strictEqual(rows.reduce((sum, r) => sum + r.n, 0), step.n, 'every card is in exactly one row');
  }
  // In table order from the seat that went out, so the reading goes round the
  // table rather than jumping.
  const winner = Number(Object.keys(over.scores).find((s) => !hands[s].length));
  const order = steps.map((e) => (e.seat - winner + 4) % 4);
  assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b));
  // The event precedes the boundary it explains.
  assert.ok(events.findIndex((e) => e.type === 'showScored') < events.findIndex((e) => e.type === 'roundOver'));
});

test("Crazy Eights: every other hand is shown, priced to the seat that went out", async () => {
  const { over, events, hands } = await firstRoundEnd('crazy-eights', 4);
  const steps = reveals(events);
  const winner = Number(Object.keys(hands).find((s) => !hands[s].length));
  assert.ok(Number.isInteger(winner), 'somebody went out');
  assert.ok(steps.length === 3, 'the three hands that did not go out');
  for (const step of steps) {
    assert.strictEqual(step.reason, 'to-winner');
    assert.strictEqual(step.to, winner);
    assert.notStrictEqual(step.seat, winner);
    assert.deepStrictEqual(step.cards, hands[step.seat].map((c) => c.id));
  }
  assert.strictEqual(steps.reduce((sum, s) => sum + s.points, 0), over.scores[winner],
    'the three cards add up to what the winner banks');
});

test("Milestones: a leftover hand is priced like Thirteen's", async () => {
  const { over, events, hands } = await firstRoundEnd('milestones', 4);
  const steps = reveals(events);
  assert.ok(steps.length >= 1);
  for (const step of steps) {
    assert.strictEqual(step.reason, 'leftover');
    assert.strictEqual(step.points, over.scores[step.seat]);
    assert.deepStrictEqual(step.cards, hands[step.seat].map((c) => c.id));
  }
});

test("Hearts: the cards a seat was made to take, and only the ones that cost", async () => {
  const { pack, over, events, won } = await firstRoundEnd('hearts', 4);
  const steps = reveals(events);
  assert.ok(steps.length >= 1, 'somebody took a heart');
  const shooter = steps.find((s) => s.sweep);
  for (const step of steps) {
    assert.strictEqual(step.reason, 'taken');
    const priced = won[step.seat].filter((c) => handValue([c], pack.scoring) !== 0).map((c) => c.id);
    assert.deepStrictEqual(step.cards, priced, 'hearts and the Queen, not the whole pile');
    assert.ok(step.cards.length > 0);
    if (!shooter) assert.strictEqual(step.points, over.scores[step.seat]);
  }
  if (!shooter) {
    assert.strictEqual(steps.reduce((sum, s) => sum + s.points, 0), 26, 'all 26 points were taken by somebody');
  }
});

test("packs that price no cards reveal nothing, and cribbage keeps its own show", async () => {
  for (const [id, seats] of [['team-spades', 4], ['stockpile', 2]]) {
    const { events } = await firstRoundEnd(id, seats);
    assert.deepStrictEqual(reveals(events), [], `${id} has no cards to price`);
  }
  const { events } = await firstRoundEnd('cribbage', 2);
  const steps = reveals(events);
  assert.ok(steps.length >= 1);
  for (const step of steps) assert.strictEqual(step.reason, undefined, 'a cribbage count carries no reason');
});

/* ------------------------------------------------------------------ *
 * What the felt makes of a reveal
 * ------------------------------------------------------------------ */

test("a reveal step keeps its price, its recipient and its count through showSteps", () => {
  const [step] = showSteps([{
    type: 'showScored', seat: 2, isCrib: false, reason: 'to-winner', to: 0, sweep: null,
    points: 61, n: 3, cards: ['spades-8', 'hearts-K', 'clubs-A'],
    parts: [{ kind: 'held', n: 1, each: 50, points: 50, at: [0] }, { kind: 'held', n: 1, each: 10, points: 10, at: [1] }, { kind: 'held', n: 1, each: 1, points: 1, at: [2] }],
  }]);
  assert.strictEqual(step.reason, 'to-winner');
  assert.strictEqual(step.to, 0);
  assert.strictEqual(step.n, 3);
  // And a count that lost its ids on the wire still knows how many there were.
  const [stripped] = showSteps([{ type: 'showScored', seat: 1, reason: 'leftover', points: 7, n: 7, cards: [], parts: [] }]);
  assert.strictEqual(stripped.n, 7);
});

test("the reveal card rows read as cards at a value, and a zero is not a nineteen", () => {
  const card = (id) => ({ id, rank: id.split('-')[1], suit: id.split('-')[0] });
  const model = showCardModel({
    whose: "Nell's", points: 9, cards: ['a-1', 'b-1', 'c-1', 'd-6'].map(card),
    parts: [{ kind: 'held', n: 1, each: 6, points: 6, at: [3] }, { kind: 'held', n: 3, each: 1, points: 3, at: [0, 1, 2] }],
  });
  assert.deepStrictEqual(model.rows.map((r) => [r.label, r.points]), [['a card at 6', 6], ['3 cards at 1', 3]]);
  assert.strictEqual(model.title, "Nell's hand");
  const taken = showCardModel({ whose: 'Your', points: 0, cards: [], parts: [], what: 'penalty cards', zeroLabel: 'nothing' });
  assert.strictEqual(taken.title, 'Your penalty cards');
  assert.strictEqual(taken.zeroLabel, 'nothing');
  assert.match(taken.aria, /nothing/);
  assert.doesNotMatch(taken.aria, /nineteen/);
  // Cribbage's default is untouched.
  assert.match(showCardModel({ whose: 'Your', points: 0 }).aria, /nineteen/);
});

test("the reveal's sentence follows the price, and its tone follows the viewer", () => {
  const label = (s) => (s === 0 ? 'You' : ['You', 'Nell', 'Ada', 'Bo'][s]);
  const possessive = (s) => (s === 0 ? 'Your' : `${label(s)}'s`);
  const say = (step) => revealSentence(step, { label, possessive, viewerSeat: 0 });
  assert.deepStrictEqual(say({ seat: 1, reason: 'leftover', n: 7, points: 7 }),
    { text: 'Nell is caught with 7 cards — 7 points.', tone: 'neutral' });
  assert.deepStrictEqual(say({ seat: 0, reason: 'leftover', n: 1, points: 1 }),
    { text: 'You are caught with 1 card — 1 point.', tone: 'bad' });
  assert.deepStrictEqual(say({ seat: 2, reason: 'to-winner', to: 0, n: 3, points: 61 }),
    { text: "Ada's 3 cards are worth 61 to You.", tone: 'good' });
  assert.deepStrictEqual(say({ seat: 0, reason: 'to-winner', to: 3, n: 1, points: 50 }),
    { text: 'Your 1 card is worth 50 to Bo.', tone: 'bad' });
  assert.deepStrictEqual(say({ seat: 3, reason: 'taken', n: 6, points: 18 }),
    { text: 'Bo took 18 in penalty cards.', tone: 'neutral' });
  assert.deepStrictEqual(say({ seat: 1, reason: 'taken', sweep: 'others-gain-sum', n: 14, points: 26 }),
    { text: 'Nell shot the moon — 26 to everyone else.', tone: 'bad' });
  assert.deepStrictEqual(say({ seat: 0, reason: 'taken', sweep: 'self-lose-sum', n: 14, points: 26 }),
    { text: 'You shot the moon — 26 off your score.', tone: 'good' });
  assert.strictEqual(say({ seat: 1, isCrib: false, points: 8, parts: [] }), null, "a cribbage count is the template's sentence");
});

// PART GREP: src/ui/table.js touches the DOM at import, so the one thing that
// turns these events into a held card — the step player asking the platform for
// the sentence and spotlighting the hand rather than a play pile — is pinned by
// reading the source.
test("the step player says a reveal in the platform's words and lights the right zone", async () => {
  const fs = await import("node:fs");
  const table = fs.readFileSync(new URL("../src/ui/table.js", import.meta.url), "utf8");
  const player = table.slice(table.indexOf("function playShowStep("), table.indexOf("function showCardFor("));
  assert.match(player, /revealSentence\(step,/);
  assert.match(player, /step\.reason === 'taken' \? 'won' : 'hand'/);
  assert.match(table.slice(table.indexOf("function showCardFor(")), /zeroLabel: step\.reason \? 'nothing'/);
});
