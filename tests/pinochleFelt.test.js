// What Pinochle's felt is allowed to keep quiet about — which is nothing (#125).
//
// Nine playtest findings, one shape: the engine knew and the table did not say.
// Trump was named and never displayed; the human's own meld produced the same
// silence whether the hand held a run in trump or nothing at all; the auction
// ran with no visible high bid; three seats wore the turn token at once.
//
// EVERY ASSERTION BELOW IS ABOUT A HOOK'S ANSWER, not about the DOM, because
// src/ui/table.js and its neighbours resolve their element tables on their
// first line and cannot be loaded by a Node test. That is also why the file
// ends with SOURCE GATES: a hook whose answer is perfect and whose call site
// has been deleted is a hook that is green forever and shows nothing. The felt
// itself was verified in a browser; these are what stop it regressing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { ROOT } from "../tools/stage.mjs";
import { chooserTile } from "../src/ui/cardStyles/chooser.js";

const seatLabel = (seat) => ["You", "Nell", "Ada", "Bo"][seat] ?? `Seat ${seat}`;

async function ctxFor(packId = "pinochle", seed = "pinochle-felt") {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats: 4, seed });
  pack.template.setup(makeCtx(state));
  return makeCtx(state);
}

/** Apply a move straight through the template, the way the felt's fork does. */
function apply(ctx, move) {
  ctx.pack.template.applyMove(ctx, move);
}

/** Run the auction out: `bids` is [{ bid, trump? }] in seat-turn order. */
function auction(ctx, bids) {
  for (const entry of bids) {
    const seat = ctx.turn.seat;
    const choice = entry.trump ? { bid: entry.bid, trump: entry.trump } : { bid: entry.bid };
    apply(ctx, { actor: seat, type: "bid", choice });
  }
}

const chips = (ctx, seat = 0) => ctx.pack.template.contractChips(ctx, seat);
const chip = (ctx, key, seat = 0) => (chips(ctx, seat) || []).find((c) => c.key === key) || null;

/* ------------------------------------------------------------------ *
 * The contract strip
 * ------------------------------------------------------------------ */

test("the auction chip names the standing high bid AND whose it is", async () => {
  const ctx = await ctxFor();
  assert.equal(ctx.turn.phase, "bid");

  const opening = chip(ctx, "bid");
  assert.ok(opening, "no high-bid chip during the auction");
  assert.equal(opening.value, "—", "an auction nobody has opened must not show a number");
  assert.equal(opening.seat, null, "nobody holds a bid that has not been made");

  const first = ctx.turn.seat;
  apply(ctx, { actor: first, type: "bid", choice: { bid: 150, trump: "hearts" } });

  const standing = chip(ctx, "bid");
  assert.equal(standing.value, "150");
  // THE HALF THE FELT COULD NOT SAY. Two seats that have both bid wear the same
  // gold chip; only a name separates the leader from the seat just outbid.
  assert.equal(standing.seat, first, "the high bid is not credited to anybody");
  assert.equal(standing.suit, "hearts", "the suit the leader named is public and is not shown");

  // Outbid, and the chip follows the money rather than the last speaker.
  const second = ctx.turn.seat;
  assert.notEqual(second, first);
  apply(ctx, { actor: second, type: "bid", choice: { bid: 160, trump: "spades" } });
  assert.equal(chip(ctx, "bid").value, "160");
  assert.equal(chip(ctx, "bid").seat, second);

  // A pass does not take the lead away from the seat that holds it.
  const third = ctx.turn.seat;
  apply(ctx, { actor: third, type: "bid", choice: { bid: 0 } });
  assert.equal(chip(ctx, "bid").seat, second, "a pass moved the high bid");
});

test("trump and the contract stay on the strip for the rest of the hand", async () => {
  const ctx = await ctxFor();
  auction(ctx, [
    { bid: 120, trump: "clubs" },
    { bid: 0 },
    { bid: 140, trump: "spades" },
    { bid: 0 },
  ]);
  assert.notEqual(ctx.turn.phase, "bid", "the auction did not settle");
  assert.equal(ctx.var("trumpSuit"), "spades");

  const trump = chip(ctx, "trump");
  assert.ok(trump, "trump is named and the felt has no chip for it");
  assert.equal(trump.value, "Spades");
  // The SUIT TOKEN, not the caption: this is the key the pack's own card
  // renderer is looked up by, and a capitalised label misses it silently.
  assert.equal(trump.suit, "spades");
  assert.ok(chooserTile("suit", trump.suit, null),
    "the strip's suit does not resolve to a card in the pack's own renderer");

  const contract = chip(ctx, "contract");
  assert.equal(contract.value, "140");
  assert.ok(Number.isInteger(contract.seat), "the contract is nobody's");

  // Still there once the melds are in and the first card is on the table.
  for (let seat = 0; seat < ctx.seats; seat++) {
    apply(ctx, { actor: seat, type: "declareMeld", cards: [] });
  }
  assert.equal(ctx.turn.phase, "play");
  assert.equal(chip(ctx, "trump").value, "Spades", "trump left the strip once play began");
});

test("your own meld is on the strip, and nothing to declare reads as nothing", async () => {
  const ctx = await ctxFor();
  auction(ctx, [{ bid: 100, trump: "hearts" }, { bid: 0 }, { bid: 0 }, { bid: 0 }]);
  assert.equal(chip(ctx, "meld"), null, "a meld chip before anybody has declared");

  // The whole hand, and then nothing at all — the two cases the playtest could
  // not tell apart, from the seat that has no plate of its own to read.
  const hand = ctx.cardIdsIn(ctx.zoneAddr("hand", 0));
  for (let seat = 0; seat < ctx.seats; seat++) {
    apply(ctx, { actor: seat, type: "declareMeld", cards: seat === 0 ? hand : [] });
  }
  const mine = chip(ctx, "meld");
  assert.ok(mine, "the seat doing the looking cannot see its own meld");
  assert.equal(mine.value, String(ctx.playerVar(0, "meld").points));
  assert.ok(Number(mine.value) > 0, "this fixture was meant to hold some meld");

  // And the empty declaration, read from a seat that made one.
  const empty = chip(ctx, "meld", 1);
  assert.equal(ctx.playerVar(1, "meld").points, 0);
  assert.equal(empty.value, "None",
    "a declaration of nothing reads as a score of zero, which is the #125 bug");
  assert.match(empty.aria, /no meld/i);
});

test("a pack whose trump never changes gets no strip at all", async () => {
  // The `directionBadge` rule: a permanent badge saying the same word on every
  // hand of every match teaches nothing. Spades' trump is in its name.
  for (const packId of ["team-spades", "hearts"]) {
    const ctx = await ctxFor(packId, `${packId}-strip`);
    assert.notEqual(ctx.pack.rules.trump, "chosen", `${packId} chooses its trump now — revisit this`);
    assert.equal(ctx.pack.template.contractChips(ctx, 0), null,
      `${packId} grew a contract strip it has nothing to put in`);
  }
});

/* ------------------------------------------------------------------ *
 * Who played what
 * ------------------------------------------------------------------ */

test("the trick says who played each card, in play order", async () => {
  const ctx = await ctxFor();
  auction(ctx, [{ bid: 100, trump: "hearts" }, { bid: 0 }, { bid: 0 }, { bid: 0 }]);
  for (let seat = 0; seat < ctx.seats; seat++) apply(ctx, { actor: seat, type: "declareMeld", cards: [] });

  const owners = () => ctx.pack.template.zoneCardOwners(ctx, "trick");
  assert.equal(owners(), null, "an empty trick has owners");

  const played = [];
  for (let i = 0; i < 3; i++) {
    const seat = ctx.turn.seat;
    const card = ctx.pack.template.enumerateLegalMoves(ctx, seat)[0].cards[0];
    apply(ctx, { actor: seat, type: "playCard", cards: [card] });
    played.push(seat);
    assert.deepEqual(owners(), played,
      `after ${i + 1} card(s) the trick names the wrong seats`);
  }
  // One per card, always — a short list would label the wrong card.
  assert.equal(owners().length, ctx.countIn("trick"));

  // Only the trick. A won pile is nobody's business and a hand is its owner's.
  assert.equal(ctx.pack.template.zoneCardOwners(ctx, "won.0"), null);
  assert.equal(ctx.pack.template.zoneCardOwners(ctx, "hand.0"), null);
});

/* ------------------------------------------------------------------ *
 * What is said out loud
 * ------------------------------------------------------------------ */

const pinochle = await loadPackFromDisk("pinochle");
const say = (ev, viewerSeat = 0) =>
  pinochle.template.describeEvent(ev, { seatLabel, viewerSeat });

test("the auction announces the suit, whoever won it", () => {
  // The reported case: the log read "Pip bid. Bruno bid. Sable bid." and the
  // trump suit was never said at all on a hand the player did not win.
  const theirs = say({ type: "contractSet", seat: 2, bid: 140, trump: "spades", forced: false });
  assert.ok(theirs, "a bot winning the auction says nothing");
  assert.match(theirs.text, /Ada/, "the winner is not named");
  assert.match(theirs.text, /140/);
  assert.match(theirs.text, /Spades are trump/);

  const mine = say({ type: "contractSet", seat: 0, bid: 140, trump: "hearts", forced: false });
  assert.match(mine.text, /^You won the auction/);
  assert.match(mine.text, /Hearts are trump/);

  // Stuck with it is not the same sentence as won it.
  const stuck = say({ type: "contractSet", seat: 1, bid: 100, trump: "clubs", forced: true });
  assert.match(stuck.text, /stuck with the bid/);

  // A hand with no trump named has nothing to announce and must not invent one.
  assert.equal(say({ type: "contractSet", seat: 1, bid: 100, trump: null }), null);
});

test("your own meld is said, and only yours", () => {
  const melds = [
    { id: "royal-marriage", label: "Royal marriage", points: 4, suit: "hearts" },
    { id: "pinochle", label: "Pinochle", points: 4 },
  ];
  const mine = say({ type: "meldDeclared", seat: 0, points: 8, melds });
  assert.match(mine.text, /You meld 8/);
  assert.match(mine.text, /Royal marriage in hearts/, "the melds found are not named");
  assert.match(mine.text, /Pinochle/);

  // THE OTHER THREE SAY NOTHING, which is also what makes the platform's
  // first-sentence-wins loop land on the viewer's own declaration whatever
  // order the four events were emitted in (src/ui/celebrations.js).
  for (const seat of [1, 2, 3]) {
    assert.equal(say({ type: "meldDeclared", seat, points: 8, melds }), null,
      `seat ${seat}'s meld is being narrated to seat 0`);
  }

  // The case the playtest ran deliberately: a hand with no meld in it.
  const none = say({ type: "meldDeclared", seat: 0, points: 0, melds: [] });
  assert.match(none.text, /Nothing to declare/);
  assert.doesNotMatch(none.text, /meld 0/, "an empty declaration reads as a score of nothing");
});

/* ------------------------------------------------------------------ *
 * The trump chooser
 * ------------------------------------------------------------------ */

test("the trump step is a sentence, and its options resolve to cards", async () => {
  const ctx = await ctxFor();
  const seat = ctx.turn.seat;
  const ask = ctx.pack.template.pendingChoice(ctx, { actor: seat, type: "bid", choice: { bid: 140 } });
  assert.ok(ask, "a points bid that has not named a suit is not being asked for one");

  // A WHOLE SENTENCE, not a noun phrase completing "Choose a …". The old one
  // read "Choose a suit to play it in", which names no referent for "it".
  assert.ok(ask.question, "the trump step has no sentence of its own");
  assert.match(ask.question, /trump/i, "the sentence does not say what is being named");
  assert.match(ask.question, /140/, "the sentence does not say what was bid");
  assert.match(ask.question, /\.$/, "not a sentence");
  assert.doesNotMatch(ask.question, /play it in/, "the broken referent is back");

  // AND IT DRAWS. `attr` is the template's word for the question and is not in
  // the platform's art vocabulary; `art` is, and this is the assertion that
  // catches the two being conflated again.
  assert.equal(ask.art, "suit");
  for (const option of ask.options) {
    assert.ok(chooserTile(ask.art, option.value, null),
      `no card art for ${option.value} — the chooser falls back to a word button`);
    assert.notEqual(option.value, option.label, "this fixture wanted a pretty label to test");
  }

  // The bar behind the dialog was still saying "Your bid", which is the step
  // before this one.
  assert.ok(ask.status, "the status bar keeps the previous step's sentence");
  assert.doesNotMatch(ask.status, /Your bid/);
});

/* ------------------------------------------------------------------ *
 * SOURCE GATES — a hook nobody calls is green forever
 * ------------------------------------------------------------------ */

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
/** Comment lines stripped, so a gate cannot be satisfied by prose about it. */
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("the felt still asks for everything the hooks answer", () => {
  const strip = read("src/ui/contractStrip.js");
  assert.match(code(strip), /template\.contractChips\?\.\(/,
    "src/ui/contractStrip.js no longer asks the template for its chips");
  const table = code(read("src/ui/table.js"));
  assert.match(table, /createContractStrip\(/, "the contract strip is never created");
  // THE WHOLE STATEMENT, guard included. Matching only `contractStrip.render(`
  // passed a build where the call had been fenced off behind `if (false)` —
  // which is exactly the shape a regression takes, and the first cut of this
  // gate sat green through it.
  assert.match(table, /\n\s*if \(contractStrip\) contractStrip\.render\(state\);/,
    "the contract strip is never rendered");

  assert.match(code(read("src/ui/zoneRenderer.js")), /template\.zoneCardOwners\?\.\(/,
    "src/ui/zoneRenderer.js no longer asks who played what");

  // A simultaneous commit gets its own mark; the turn token means one turn.
  // The whole choice, for the same reason as above: `committingToken()` alone
  // matches the function's own declaration, so deleting every CALL left this
  // green.
  assert.match(table, /const token = committing \? committingToken\(\) : turnToken\(\);/,
    "the meld and pass phases are back on the platform's turn token");
  assert.match(table, /interactionMode\(state\) === 'pass'/,
    "the commit phase is being recognised some other way than by its mode");
});

test("the chooser looks its art up by the option's VALUE, not its caption", () => {
  const dialog = code(read("src/ui/choiceDialog.js"));
  assert.match(dialog, /art\.chooser\(attr, value\)/,
    "src/ui/choiceDialog.js is keying the card art off the label again — a pretty "
    + "caption then silently deletes the picture");
  assert.match(dialog, /art\.chooserTint\(attr, opt\.value\)/,
    "the tint is keyed off the label");
  assert.match(code(read("src/ui/table.js")), /ask\.art \|\| ask\.attr/,
    "src/ui/table.js is passing the template's word for the question as the art key");
});

test("the round sheet folds to sides rather than listing chairs", () => {
  const panels = read("src/ui/panels.js");
  assert.match(panels, /from '\.\.\/engine\/sides\.js'/,
    "src/ui/panels.js no longer reads the partnership table");
  assert.match(code(panels), /foldToSides\(ev\.scores, sides\)/,
    "the round sheet's DELTA is per seat again — for every partnership scorer we "
    + "ship that is +0 on one partner every round while the total climbs (#125)");
  assert.doesNotMatch(code(panels), /ev\.scores\[s\]/,
    "a per-seat delta is back on the round sheet");
  assert.doesNotMatch(code(panels), /round\.scores\[s\]/,
    "a per-seat delta is back in the round history");
});

test("the trick's gather does not paint over the event banner", () => {
  const css = read("src/ui/table.css");
  const zOf = (selector) => {
    const block = new RegExp(`\\n${selector}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(block, `no ${selector} block in src/ui/table.css`);
    const z = /z-index:\s*(-?\d+)/.exec(block[1]);
    assert.ok(z, `${selector} declares no z-index`);
    return Number(z[1]);
  };
  const banner = zOf("#event-banner");
  const fly = zOf("#fly-layer");
  // The reported symptom was a message cut in half mid-word by a card scaled
  // 2x on its way to somebody's won pile.
  assert.ok(banner > fly,
    `#event-banner (${banner}) must sit above #fly-layer (${fly}), or the trick's `
    + "gather redacts its own caption");
  // And still under the modals, which cover the whole felt when they open.
  assert.ok(banner < 10, `#event-banner (${banner}) is at or above the modal layer`);
});
