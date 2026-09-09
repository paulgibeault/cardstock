// A per-player zone the whole table reads in one place — the `table` flag (#138).
//
// Cribbage's play is per player and always will be: the count, the "go" and
// the show all read a SEAT's own pile, and the bot evaluates from it. What was
// wrong was where the two piles were DRAWN — yours a full spread above your
// hand, theirs a 24px mini pile on their plate 270px away showing one card —
// while the runs and pairs being scored are made across both of them.
//
// The flag says only that. Everything below is either the flag as the engine
// resolves it, or a SOURCE GATE on the three places that have to agree about
// it: a flag nothing reads is a flag that is green forever and draws nothing.
// The felt itself was verified in a browser (see IMPLEMENTATION_NOTES) —
// src/ui/table.js touches `document` on its first line and no Node test can
// load it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createState } from "../src/engine/state.js";
import { loadPackFromDisk } from "../tools/pack-test.mjs";
import { ROOT } from "../tools/stage.mjs";

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
/** Comment lines stripped, so a gate cannot be satisfied by prose about it. */
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const PACKS = ["thirteen", "team-spades", "cribbage", "pinochle", "hearts",
  "milestones", "wildfire", "crazy-eights", "stockpile"];

async function defsOf(packId, seats) {
  const pack = await loadPackFromDisk(packId);
  return createState({ pack, seats, seed: `${packId}-table-zone` }).zones.defs;
}

test("cribbage's play pile is a per-player zone the whole table is shown", async () => {
  const play = (await defsOf("cribbage", 2)).get("play");
  assert.ok(play, "cribbage has no `play` zone any more");
  // The half that must NOT change: it is still per player, because the count,
  // the go and the show are all read off one seat's own pile.
  assert.equal(play.per, "player", "cribbage's play zone stopped being per player — "
    + "the count, the go and the show all read a SEAT's pile (#138 chose option 2 "
    + "over one shared sequence for exactly this reason)");
  assert.equal(play.layout, "spread");
  // ...and the half that says where the two of them are drawn.
  assert.equal(play.table, true,
    "cribbage's play zone no longer asks to be drawn in the middle, so the "
    + "sequence is back to a spread above your hand and a mini pile on their plate");
});

test("no other pack has asked for the row", async () => {
  for (const packId of PACKS) {
    if (packId === "cribbage") continue;
    const defs = await defsOf(packId, packId === "team-spades" || packId === "pinochle" ? 4 : 2);
    for (const def of defs.values()) {
      assert.notEqual(def.table, true,
        `${packId}'s ${def.id} zone now asks for the shared play row — every other `
        + "pack's felt is supposed to be untouched by #138");
    }
  }
});

test("the flag is a declarable zone key, not an undeclared one", () => {
  const schema = JSON.parse(read("schema/manifest.schema.json"));
  const zone = schema.$defs.zone;
  // `additionalProperties: false` is what makes this load-bearing: a variant
  // patching `zones` with a `table` key is REJECTED unless the schema names it.
  assert.equal(zone.additionalProperties, false, "the zone schema stopped being closed");
  assert.equal(zone.properties.table?.type, "boolean",
    "schema/manifest.schema.json does not declare the zone `table` flag, so a "
    + "manifest that sets it fails validation");
});

/* ------------------------------------------------------------------ *
 * SOURCE GATES — a flag nobody reads draws nothing
 * ------------------------------------------------------------------ */

test("the felt reads the flag in all three places it has to", () => {
  const table = code(read("src/ui/table.js"));
  assert.match(table, /def\.per === 'player' && def\.table === true/,
    "src/ui/table.js no longer recognises a `table` zone at all");
  // The two places the zone must NOT be drawn any more. `ownZoneInstances` is
  // the filtered list; both the seat plate (and the popup it opens, which is
  // the same builder) and the human's own pile row have to use it, or the
  // sequence is back in two or three places at once.
  assert.match(table, /const seatZones = ownZoneInstances\(state, seat\);/,
    "a seat plate is drawing every per-player zone again, so a `table` zone is "
    + "back on the plate as a mini pile");
  assert.match(table, /for \(const inst of ownZoneInstances\(state, mySeat\(\)\)\)/,
    "#player-piles is drawing every per-player zone again, so the human's copy "
    + "of a `table` zone is drawn twice");
  // And the one place it must be.
  assert.match(table, /\n\s*renderTablePlay\(state, ui, draggable\);/,
    "render() never calls renderTablePlay, so the middle's play row is never built");
  assert.match(table, /el\.tableZones\.appendChild\(wrap\)/,
    "renderTableZones builds nothing into #table-zones");
});

test("the row and the count share one slot in the felt's middle", () => {
  const html = read("index.html");
  const middle = html.slice(html.indexOf('<div id="felt-middle">'), html.indexOf('<div id="player-piles">'));
  assert.ok(middle.includes('id="table-play"'), "#table-play has left the felt's middle");
  assert.ok(middle.indexOf('id="table-zones"') > middle.indexOf('id="table-play"'),
    "#table-zones is no longer inside #table-play");
  // The count belongs to the sequence beside it, not to the starter. Inside
  // the wrapper is what keeps the two on ONE line of a wrapping middle: two
  // separate flex items are split by the first line break between them, which
  // at 375px is every time.
  assert.ok(middle.indexOf('id="table-counters"') > middle.indexOf('id="table-play"'),
    "#table-counters has moved back out beside the piles, away from the spreads "
    + "whose sum it is");
  const css = read("src/ui/table.css");
  assert.match(css, /#felt-middle\.felt-middle--tabled/,
    "the middle no longer wraps for a table with a play row, so the row is "
    + "squeezed onto the piles' line instead of taking one of its own");
  assert.match(css, /column-gap: calc\(var\(--pile-w, 90px\) \* 0\.6\)/,
    "#table-zones' gutter is no longer a fraction of a card — a spread overhangs "
    + "its own box by 0.21 of a card at each end, so two of them with an ordinary "
    + "gap overlap and the two sequences read as one");
});
