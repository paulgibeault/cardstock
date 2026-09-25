// THE DOORS ONTO THE FELT, DRIVEN (#223, seam 4).
//
// src/ui/matchDoors.js holds every way a match arrives on the felt — a solo
// open or resume, the daily run, "Play again", the host's deal and its way
// back, a joiner's view — and the way it leaves. It takes its elements and the
// table's slots as parameters, so these tests open real packs from disk,
// deal, resume and close, and read what each door did in the order it did it
// (tests/fixtures/matchDoors.js).
//
// Before the carve these were a regex over table.js at most: tests/speed.test.js
// grepped that every door's body mentions `adoptMatch(`, and
// tests/eventBanner.test.js grepped for `if (dealing) celebrateDeal(state);`.
// Both now ask the doors instead.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { doorsHarness } from "./fixtures/matchDoors.js";
import { seatsFor } from "../src/ui/matchDoors.js";
import { loadPackFromDiskSync } from "../tools/lib/packs.mjs";
import { applyMove, legalMovesFor } from "../src/engine/movePipeline.js";
import { actingSeats } from "../src/engine/context.js";
import { viewFor } from "../src/engine/view.js";
import { saveMatch, loadMatch } from "../src/arcade/storage.js";
import { dailyRunFor } from "../src/templates/contract-rummy-daily.js";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** What `adoptMatch` does, in order, once a door has a state to seat. */
const ADOPT = (dealing) => [
  "bumpEpoch", "forgetPreMove", "drag.cancel", "setSession",
  "hideAllPanels", "setHelpOpen(false)", "hideBanner", "render",
  ...(dealing ? ["celebrateDeal"] : []),
  "persistMatch", "scheduleNextTurn", "scheduleAnnouncementBeats",
];

/** The three doors that wait for a pack all start by claiming the screen. */
const CLAIM = ["cancelBotTurn", "cancelAnnouncementBeats", "closeChoiceDialog"];

/** Play the acting seat's first legal move, `n` times — a match with a log. */
function playSome(state, n) {
  for (let i = 0; i < n; i++) {
    const seat = actingSeats(state)[0];
    const [move] = legalMovesFor(state, seat);
    applyMove(state, move);
  }
  return state;
}

const tail = (calls, n) => calls.slice(calls.length - n);

test("seatsFor: no request is the pack's own recommendation, and a request is clamped", () => {
  const thirteen = loadPackFromDiskSync("thirteen");
  const { best, min, max } = thirteen.manifest.players;
  assert.strictEqual(seatsFor(thirteen, undefined), best,
    "a deep link with no seat count must get the manifest's `players.best` (#156), not a flat 3");
  assert.strictEqual(seatsFor(thirteen, 99), max);
  assert.strictEqual(seatsFor(thirteen, 0), min);
  assert.strictEqual(seatsFor({ manifest: {} }, undefined), 3,
    "a manifest that says nothing falls back to three chairs");
});

test("every door that seats a match goes through adoptMatch, one room, in one order", async () => {
  // EVERY DOOR INTO A MATCH GOES THROUGH ONE ROOM, which is what makes a single
  // fix there a fix rather than a fifth place to forget (speed.test.js's #184
  // gate asked this of the source; this asks it of the doors). A door that
  // seats a match some other way fails on its tail.
  const h = doorsHarness();

  await h.doors.openTable("hearts");
  assert.deepStrictEqual(h.calls.slice(0, 3), CLAIM, "openTable must claim the screen first");
  assert.deepStrictEqual(tail(h.calls, ADOPT(true).length), ADOPT(true), "openTable, fresh");
  assert.deepStrictEqual(h.titles, ["Hearts"]);
  assert.deepStrictEqual(h.rendered.map((r) => r.message), ["Playing Hearts."]);
  const dealt = h.slots.session.state;
  assert.strictEqual(h.slots.session.dealAnimation, true, "a fresh deal staggers its cards in");
  assert.ok(legalMovesFor(dealt, actingSeats(dealt)[0]).length > 0,
    "a fresh deal is a DEALT hand: the template's own setup must have run on it");

  h.reset();
  h.doors.startGame(dealt.pack, dealt.seats);
  assert.deepStrictEqual(h.calls, ["cancelBotTurn", "cancelAnnouncementBeats", ...ADOPT(true)],
    "Play again: silence the old table, deal, adopt");
  assert.notStrictEqual(h.slots.session.state, dealt, "Play again deals a new state");
  assert.strictEqual(h.slots.session.state.seats, dealt.seats, "at the same seat count");

  h.reset();
  const seats = h.slots.session.seats;
  const seating = h.slots.session.seating;
  const hosted = await h.doors.dealHostedTable({ packId: "hearts", seats, seating });
  assert.deepStrictEqual(h.calls.slice(0, 3), CLAIM, "the host's deal must claim the screen first");
  assert.deepStrictEqual(tail(h.calls, ADOPT(true).length), ADOPT(true), "dealHostedTable");
  assert.strictEqual(h.slots.session.state, hosted, "the door returns the state it seated");
  assert.strictEqual(h.slots.session.shared, true, "a hosted deal is a shared table");
  assert.strictEqual(h.slots.session.seats, seats, "the party's seat table, not a solo one");
  assert.deepStrictEqual(h.rendered.map((r) => r.message), ["Playing Hearts."]);

  h.reset();
  const back = await h.doors.resumeHostedTable({ packId: "hearts", state: hosted, seats, seating });
  assert.deepStrictEqual(h.calls.slice(0, 3), CLAIM, "the host's way back must claim the screen first");
  assert.deepStrictEqual(tail(h.calls, ADOPT(false).length), ADOPT(false), "resumeHostedTable");
  assert.strictEqual(back, hosted, "it deals nothing: the state handed in is the state seated");
  assert.strictEqual(h.slots.session.dealAnimation, false, "a resumed table must not re-stagger its cards");
  assert.deepStrictEqual(h.rendered.map((r) => r.message), ["Back at Hearts."]);

  // THE HOSTED PREAMBLE, ONE COPY: claim, fetch, remember, title, clear.
  assert.strictEqual(h.store.get("lastPack"), "hearts", "the pack is remembered for the lobby");
  assert.deepStrictEqual(h.titles, ["Hearts"]);
  assert.strictEqual(h.slots.epoch, 4, "one bump per match seated, none besides");
});

test("a fresh deal narrates what the deal said; a resume never does", async () => {
  // A resume arrives having REPLAYED its log, so `state.events` there is the
  // last move of a hand that has been going for twenty turns — narrating it
  // would open the table on a sentence about something the player did yesterday.
  const h = doorsHarness();
  await h.doors.openTable("hearts");
  assert.deepStrictEqual(h.celebrated, [h.slots.session.state], "a fresh solo deal narrates");

  saveMatch(playSome(h.slots.session.state, 2));
  h.reset();
  await h.doors.openTable("hearts");
  assert.deepStrictEqual(h.rendered.map((r) => r.message), ["Resumed Hearts."]);
  assert.deepStrictEqual(h.celebrated, [], "a resumed solo match narrated its replayed last move");

  h.reset();
  const { seats, seating, state } = h.slots.session;
  await h.doors.resumeHostedTable({ packId: "hearts", state, seats, seating });
  assert.deepStrictEqual(h.celebrated, [], "a hosted table put back on the felt narrated its last move");

  h.reset();
  await h.doors.dealHostedTable({ packId: "hearts", seats, seating });
  assert.deepStrictEqual(h.celebrated, [h.slots.session.state], "the host's fresh deal narrates");
});

test("a stored match wins over what the caller asked for, and resumes where it was", async () => {
  const h = doorsHarness();
  await h.doors.openTable("hearts");
  const played = playSome(h.slots.session.state, 3);
  saveMatch(played, { hints: 2 });

  h.reset();
  await h.doors.openTable("hearts", { seats: 6, variants: ["asked-for"] });
  const resumed = h.slots.session.state;
  assert.deepStrictEqual(h.server.requests.at(-1).variants, loadMatch("hearts").variants,
    "the pack is fetched under the STORED variant set — its log was recorded under that rule set");
  assert.strictEqual(resumed.log.length, played.log.length, "the same move count after a resume");
  assert.strictEqual(resumed.seed, played.seed, "the same match, not a new deal");
  assert.strictEqual(resumed.seats, played.seats,
    "the stored match's seat count wins over the one asked for — its log was recorded at it");
  assert.strictEqual(h.slots.session.hintsTaken, 2, "the hints taken ride along with the resume");
  assert.strictEqual(h.slots.session.dealAnimation, false);
  assert.deepStrictEqual(tail(h.calls, ADOPT(false).length), ADOPT(false));
});

test("a stored match the pack's rules have moved under is dropped, said, and dealt fresh", async () => {
  const h = doorsHarness();
  await h.doors.openTable("hearts");
  saveMatch(playSome(h.slots.session.state, 1));
  const key = [...h.store.keys()].find((k) => h.store.get(k)?.packId === "hearts");
  h.store.set(key, { ...h.store.get(key), packVersion: "0.0.0-older" });

  h.reset();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await h.doors.openTable("hearts");
  } finally {
    console.warn = warn;
  }
  assert.deepStrictEqual(h.errors, ["Hearts's rules have changed — dealing a fresh game."],
    "a version bump is the one failed replay the player can be told the reason for");
  assert.deepStrictEqual(h.rendered.map((r) => r.message), ["Playing Hearts."]);
  assert.strictEqual(h.slots.session.state.log.length, 0, "a fresh deal, not the stale log");
});

test("the daily door: today's ladder, the day's seed and seats, and its own slot", async () => {
  const h = doorsHarness();
  const run = dailyRunFor(loadPackFromDiskSync("milestones"));
  const pack = loadPackFromDiskSync("milestones");
  const { best, min } = pack.manifest.players;

  await h.doors.openTable("milestones", { daily: true, seats: 2 });
  const { session } = h.slots;
  assert.deepStrictEqual(h.titles, [`Milestones — daily ${run.date}`], "the launcher bar says which day");
  assert.deepStrictEqual(h.rendered.map((r) => r.message), [`Milestones daily — ${run.date}.`]);
  assert.deepStrictEqual(session.daily, { date: run.date, seed: run.seed });
  assert.strictEqual(session.state.seed, run.seed, "the day's seed, so every device deals the same cards");
  assert.strictEqual(session.state.seats, seatsFor(pack, best ?? min),
    "a daily's chair count is the manifest's, not the sheet's");

  // Its OWN slot: the daily in progress resumes as the daily.
  saveMatch(playSome(session.state, 2), { slot: "daily" });
  assert.strictEqual(loadMatch("milestones"), null, "the casual slot is untouched by the daily");
  h.reset();
  await h.doors.openTable("milestones", { daily: true });
  assert.deepStrictEqual(h.rendered.map((r) => r.message),
    [`Back on the Milestones daily — ${run.date}.`]);
  assert.strictEqual(h.slots.session.state.log.length, 2);

  // YESTERDAY'S unfinished run is dropped, not resumed, and today's is dealt.
  const key = [...h.store.keys()].find((k) => h.store.get(k)?.seed === run.seed);
  // With an EMPTY log, so the replay itself could not fail and paper over a
  // missing seed check: the only thing that may drop it is that it is not today.
  h.store.set(key, { ...h.store.get(key), seed: "milestones|1999-01-01", log: [] });
  h.reset();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await h.doors.openTable("milestones", { daily: true });
  } finally {
    console.warn = warn;
  }
  assert.deepStrictEqual(warnings, [], "yesterday's run is dropped by date, not by a failed replay");
  assert.deepStrictEqual(h.rendered.map((r) => r.message), [`Milestones daily — ${run.date}.`]);
  assert.strictEqual(h.slots.session.state.seed, run.seed);
  assert.strictEqual(h.errors.length, 0, "an abandoned daily is not an error");
});

test("an open the player walked away from lands on nothing", async () => {
  // openTable awaits a fetch and the player can be back in the lobby before it
  // lands. The token, not the epoch, is what drops it.
  const h = doorsHarness();
  h.server.hold();
  const opening = h.doors.openTable("hearts");
  h.doors.closeTable();
  h.reset();
  h.server.release();
  await opening;
  assert.deepStrictEqual(h.calls, [], "a superseded open must not touch the felt at all");
  assert.strictEqual(h.slots.session, null);
  assert.deepStrictEqual(h.titles, []);
  assert.strictEqual(h.store.get("lastPack"), undefined, "nor remember a pack the player left");

  // And the same for the host's doors: a later open supersedes an earlier one.
  await h.doors.openTable("hearts");
  const { seats, seating, state } = h.slots.session;
  h.server.hold();
  const dealing = h.doors.dealHostedTable({ packId: "hearts", seats, seating });
  const resuming = h.doors.resumeHostedTable({ packId: "hearts", state, seats, seating });
  const opened = h.doors.openTable("cribbage");
  h.reset();
  h.server.release();
  assert.strictEqual(await dealing, null, "a superseded hosted deal reports that it did nothing");
  assert.strictEqual(await resuming, null);
  await opened;
  assert.deepStrictEqual(h.titles, ["Cribbage"], "only the last open takes the screen");
  assert.strictEqual(h.slots.session.pack.id, "cribbage");
});

test("closeTable is the one reset point, in one order", async () => {
  const h = doorsHarness();
  await h.doors.openTable("hearts");
  const epoch = h.slots.epoch;
  h.reset();
  h.doors.closeTable();
  assert.deepStrictEqual(h.calls, [
    "bumpEpoch", "cancelBotTurn", "cancelAnnouncementBeats", "closeChoiceDialog", "closeConfirm",
    "drag.cancel", "flushTable", "hideBanner", "forgetPreMove", "setSession(null)",
    "hideAllPanels", "setHelpOpen(false)", "ladder.hide", "contractStrip.hide",
  ], "the save is flushed BEFORE the session goes, and nothing of the match outlives it");
  assert.strictEqual(h.slots.session, null);
  assert.strictEqual(h.slots.epoch, epoch + 1, "a bot turn already scheduled must find itself stale");
  h.reset();
  h.doors.rerenderTable();
  assert.deepStrictEqual(h.calls, [], "with no match open there is nothing to re-render");
});

test("rerenderTable paints the live felt in place", async () => {
  const h = doorsHarness();
  await h.doors.openTable("hearts");
  const session = h.slots.session;
  h.reset();
  h.doors.rerenderTable();
  assert.deepStrictEqual(h.calls, ["render"]);
  assert.strictEqual(h.rendered[0].state, session.state);
  assert.strictEqual(h.slots.session, session, "in place: no new session");
});

test("a joiner's view: a new pack is a new session, the same pack is replaced in place", async () => {
  const h = doorsHarness();
  const pack = loadPackFromDiskSync("hearts");
  await h.doors.openTable("hearts");
  const { state: hostState, seating } = h.slots.session;
  h.doors.closeTable();
  const client = { propose() {} };
  const view = { ...viewFor(hostState, 1), seat: 1 };

  h.reset();
  h.doors.adoptSharedView({ view, pack, seating, client, message: "Joined." });
  assert.deepStrictEqual(h.calls, ["bumpEpoch", "drag.cancel", "setSession", "hideAllPanels", "hideBanner", "render"]);
  assert.strictEqual(h.slots.sharedTable, client);
  const first = h.slots.session;
  const firstModel = first.state;
  assert.strictEqual(firstModel.isView, true);
  assert.strictEqual(first.seating, seating, "who is at the table is the host's word, handed in");
  assert.deepStrictEqual(h.rendered.map((r) => r.message), ["Joined."]);

  // AN ORDINARY VIEW IS A REPLACEMENT, NOT A NEW MATCH (design decision D2).
  h.reset();
  h.doors.adoptSharedView({ view, pack, seating });
  assert.deepStrictEqual(h.calls, ["render"], "no epoch bump, no teardown, for the next frame");
  assert.strictEqual(h.slots.session, first, "the same session, so a card can animate across frames");
  assert.notStrictEqual(first.state, firstModel, "the new frame's model is swapped in");
  assert.strictEqual(h.rendered[0].state, first.state, "and that is the model painted");
  assert.strictEqual(h.slots.sharedTable, client, "a frame with no client keeps the one it has");
});

// THE SLOTS, AND WHO WRITES THEM. table.js keeps `session` and `epoch` because
// the felt reads them everywhere; the doors are the only writers and reach them
// through setters. A write that grows back in table.js outside those two
// setters is a door that is not in the doors.
test("the session and the epoch are written only through the doors' setters", () => {
  const code = (rel) => read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const table = code("src/ui/table.js");
  assert.deepStrictEqual(table.match(/(?<!let )(?<![\w.$])session = [^\n]*/g),
    ["session = next; },"], "table.js assigns the session somewhere other than setSession");
  assert.deepStrictEqual(table.match(/(?<!let )(?<![\w.$])epoch (?:\+= 1|= )[^\n]*/g),
    ["epoch += 1; },"], "table.js bumps the epoch somewhere other than bumpEpoch");
  assert.doesNotMatch(table, /\bopenToken\b/, "the open token belongs to the doors alone");
  const doors = code("src/ui/matchDoors.js");
  assert.doesNotMatch(doors, /(?<![\w.$])(?:session|epoch|sharedTable) (?:=|\+=) /,
    "the doors write the table's slots only through the setters they are handed");
});
