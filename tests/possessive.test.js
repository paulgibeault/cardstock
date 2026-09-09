// "You's hand is worth 2."
//
// That sentence reached a screenshot in #107. The felt calls the local player
// "You" (`seatLabel`, src/ui/table.js) and a template narrating a seat's
// POSSESSION built the possessive itself, with an apostrophe-s that is right
// for every proper noun at the table and wrong for the one label that is a
// pronoun. It reads correctly for every opponent, which is exactly why it
// survived: the bug is invisible unless the sentence is about you.
//
// So the rule lives with the other wording helpers and is asserted here in
// both halves — the pure inflection, and the sentence a template actually
// produces with it.
import { test } from "node:test";
import assert from "node:assert";
import { possessive, agrees, SECOND_PERSON } from "../src/ui/describe.js";
import { getTemplate, TEMPLATE_IDS } from "../src/templates/index.js";

test("the second person is the one label that does not take an apostrophe-s", () => {
  assert.strictEqual(possessive(SECOND_PERSON), "Your");
  assert.strictEqual(possessive("You"), "Your", "the literal the felt actually passes");
  assert.strictEqual(possessive("Delphine"), "Delphine's");
  assert.strictEqual(possessive("Marlow"), "Marlow's");
  // Left alone on purpose: a name ending in s has two defensible spellings and
  // players type their own names. See the note in src/ui/describe.js.
  assert.strictEqual(possessive("Ross"), "Ross's");
  assert.notStrictEqual(possessive(SECOND_PERSON), "You's");
});

// THE SAME IRREGULARITY, ONE PART OF SPEECH OVER (#124, item 41). Cribbage's
// play narration said `${seatLabel(seat)} pegs ${n}` — right for every opponent
// and "You pegs 3" to the person playing, which is the #107 bug again in a
// verb. It survived a whole playtest for the same reason: nobody reads the
// sentence about themselves until they score.
test("the second person takes the bare verb and everybody else takes the -s", () => {
  assert.strictEqual(agrees(SECOND_PERSON, "peg"), "peg");
  assert.strictEqual(agrees("You", "peg"), "peg", "the literal the felt actually passes");
  assert.strictEqual(agrees("Marlow", "peg"), "pegs");
  assert.strictEqual(agrees("Delphine", "score"), "scores");
  assert.notStrictEqual(agrees(SECOND_PERSON, "peg"), "pegs");
});

/** The felt's own wording, as a template's describeEvent receives it. */
const label = (seat) => (seat === 0 ? SECOND_PERSON : ["", "Marlow"][seat] || `Seat ${seat}`);
const voice = {
  seatLabel: label,
  seatPossessive: (seat) => possessive(label(seat)),
  seatVerb: (seat, verb) => agrees(label(seat), verb),
  viewerSeat: 0,
};

test("cribbage's pegging is narrated in the second person to the seat doing it", () => {
  const cribbage = getTemplate("cribbage");
  const said = (seat) => cribbage.describeEvent({
    type: "pegPlay", seat, count: 8, points: 2, parts: [{ kind: "pair", points: 2, n: 2 }],
  }, voice).text;

  assert.strictEqual(said(0), "You peg 2 — a pair — the count is 8.",
    'the felt said "You pegs 2" for a whole playtest');
  assert.strictEqual(said(1), "Marlow pegs 2 — a pair — the count is 8.");
});

// WHAT scored, not just how much. A fifteen, a pair and a run are three
// different things to have happen to you and all three read "pegs 2".
test("cribbage names what a score was made of", () => {
  const cribbage = getTemplate("cribbage");
  const show = (parts, isCrib = false) => cribbage.describeEvent(
    { type: "showScored", seat: 1, isCrib, points: 5, parts }, voice,
  ).text;

  assert.match(show([{ kind: "fifteen", points: 2, n: 2 }]), /fifteen/);
  assert.match(show([{ kind: "run", points: 3, n: 3 }]), /a run of 3/);
  assert.match(show([{ kind: "pair", points: 6, n: 3 }]), /pair royal/);
  assert.match(show([{ kind: "pair", points: 12, n: 4 }]), /double pair royal/);
  // In this pack's own tagline and its manifest, and never once on the felt.
  assert.match(show([{ kind: "nobs", points: 1, n: 1 }]), /his nobs/,
    "\"one for his nobs\" is in the pack's tagline and was never narrated");
  // The crib's own score is a sentence of its own — the dealer used to gain
  // its points in silence.
  assert.strictEqual(
    show([{ kind: "fifteen", points: 2, n: 2 }, { kind: "nobs", points: 1, n: 1 }], true),
    "Marlow's crib is worth 5 — fifteen and his nobs.");
  assert.strictEqual(show([]), "Marlow's hand is worth 5.",
    "a breakdown that says nothing adds no clause");
});

test("cribbage's show is narrated in the second person to the seat playing it", () => {
  const cribbage = getTemplate("cribbage");
  const said = (seat, isCrib) =>
    cribbage.describeEvent({ type: "showScored", seat, isCrib, points: 2, parts: [] }, voice).text;

  assert.strictEqual(said(0, false), "Your hand is worth 2.",
    "the sentence in the #107 screenshot said \"You's hand is worth 2.\"");
  assert.strictEqual(said(0, true), "Your crib is worth 2.");
  assert.strictEqual(said(1, false), "Marlow's hand is worth 2.");
  assert.strictEqual(said(1, true), "Marlow's crib is worth 2.");
});

test("no template builds a possessive out of a seat label by hand", () => {
  // The gate, not the example. `${seatLabel(seat)}'s` is correct for every
  // opponent and wrong for the reader, so it passes review and passes play
  // testing by anyone watching a bot's turn. Templates ask for the possessive
  // instead; the platform owns which labels are irregular.
  const offenders = [];
  for (const id of TEMPLATE_IDS) {
    const fn = getTemplate(id).describeEvent;
    if (!fn) continue;
    const source = fn.toString().replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // A `}'s` immediately after a template-literal interpolation is the shape.
    if (/\}'s\b/.test(source)) offenders.push(id);
  }
  assert.deepStrictEqual(offenders, [],
    "a template is spelling a possessive itself — take `seatPossessive` from describeEvent's "
    + "second argument, which knows that the local seat is \"You\" and wants \"Your\"");
});
