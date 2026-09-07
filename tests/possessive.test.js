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
import { possessive, SECOND_PERSON } from "../src/ui/describe.js";
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

/** The felt's own wording, as a template's describeEvent receives it. */
const label = (seat) => (seat === 0 ? SECOND_PERSON : ["", "Marlow"][seat] || `Seat ${seat}`);
const voice = { seatLabel: label, seatPossessive: (seat) => possessive(label(seat)), viewerSeat: 0 };

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
