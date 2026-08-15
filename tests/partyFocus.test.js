// THE FOCUS TRANSITIONS, WHICH HAVE NEVER HAD COVERAGE OF ANY KIND.
//
// `activeKey` was a module-scoped `let` in src/ui/party.js — a file that
// touches `document` at import time, so no Node test could reach it — and the
// rules that moved it were six comments at six call sites. The browser suite
// could only ever assert where the focus ENDED UP after a whole scenario ran,
// which is why the case below that must NOT refocus survived as a comment
// explaining itself rather than as a test.
//
// `nextFocus` returns the next key from the current one (#75 stage 4), so the
// rules are a table of cases.

import { test } from "node:test";
import assert from "node:assert";

import { nextFocus } from "../src/ui/partyFocus.js";

const ADA = "t1a1a1a1a1a1a1a1a1a";
const BO = "t2b2b2b2b2b2b2b2b2b";
const CASS = "t3c3c3c3c3c3c3c3c3c";

/** Idle and unattached, with all three tables in earshot unless said otherwise. */
const room = (over = {}) => ({
  focusedKey: null,
  attached: false,
  joining: false,
  latestKey: null,
  knows: (key) => [ADA, BO, CASS].includes(key),
  ...over,
});

const sighted = (key, provenance = "wire") => ({
  kind: "sighted", entry: { key }, provenance,
});

/* ------------------------------------------------------------------ *
 * A table we heard about
 * ------------------------------------------------------------------ */

test("an unattached device follows the latest table it hears about", () => {
  assert.strictEqual(nextFocus(sighted(ADA), room()), ADA);
  assert.strictEqual(nextFocus(sighted(BO), room({ focusedKey: ADA })), BO);
});

test("a device already at a table is not dragged off it by a neighbour dealing", () => {
  assert.strictEqual(nextFocus(sighted(BO), room({ focusedKey: ADA, attached: true })), ADA,
    "hosting or seated: the panel stays where the player put it");
  assert.strictEqual(nextFocus(sighted(BO), room({ focusedKey: ADA, attached: true })), ADA);
});

test("a join in flight holds the focus still", () => {
  // `joinTable` awaits a pack fetch, and a host broadcasts its lobby several
  // times inside a few milliseconds. Following each one would move the panel
  // out from under the join that is already running.
  assert.strictEqual(nextFocus(sighted(BO), room({ focusedKey: ADA, joining: true })), ADA);
});

test("a frame from our own client only fills an empty focus", () => {
  // We are already sitting at that table; the only open question is whether the
  // panel is pointed at anything yet.
  assert.strictEqual(nextFocus(sighted(ADA, "client"), room()), ADA);
  assert.strictEqual(nextFocus(sighted(ADA, "client"), room({ focusedKey: BO })), BO,
    "and it never takes the focus off whatever the player is looking at");
  // Attachment is not consulted on this path — a client frame arrives precisely
  // BECAUSE we are attached, so testing for it would refuse every one of them.
  assert.strictEqual(nextFocus(sighted(ADA, "client"), room({ attached: true })), ADA);
});

test("focus never moves to a table we have not actually heard of", () => {
  const unknown = "t9z9z9z9z9z9z9z9z9z";
  assert.strictEqual(nextFocus(sighted(unknown), room({ focusedKey: ADA })), ADA);
  assert.strictEqual(nextFocus({ kind: "chosen", key: unknown }, room({ focusedKey: ADA })), ADA);
});

/* ------------------------------------------------------------------ *
 * A table that stopped existing
 * ------------------------------------------------------------------ */

test("a table that closed hands the focus on to whatever else is in the room", () => {
  assert.strictEqual(
    nextFocus({ kind: "closed", keys: [ADA] }, room({ focusedKey: ADA, latestKey: BO })), BO);
  assert.strictEqual(
    nextFocus({ kind: "hosts-gone", keys: [ADA, CASS] }, room({ focusedKey: ADA, latestKey: BO })), BO);
});

test("a table closing somewhere else leaves the focus alone", () => {
  assert.strictEqual(
    nextFocus({ kind: "closed", keys: [BO] }, room({ focusedKey: ADA, latestKey: CASS })), ADA);
});

test("the last table closing leaves the panel pointing at nothing", () => {
  assert.strictEqual(
    nextFocus({ kind: "closed", keys: [ADA] }, room({ focusedKey: ADA, latestKey: null })), null);
});

test("A SUPERSEDED TABLE MUST NOT HAND ON THE FOCUS", () => {
  // THE CASE THIS FILE EXISTS FOR. A host ended one table and dealt another;
  // the replacement is being sighted in the same breath, so `latestKey` IS that
  // replacement. Treating this like `closed` would point the panel at it — and
  // the sighting rule joins the table the panel is pointed at, so a joiner who
  // was only browsing would be auto-joined into a game nobody offered them.
  assert.strictEqual(
    nextFocus({ kind: "superseded", keys: [ADA] }, room({ focusedKey: ADA, latestKey: BO })), null,
    "null, not the replacement");
  assert.strictEqual(
    nextFocus({ kind: "superseded", keys: [ADA] }, room({ focusedKey: CASS, latestKey: BO })), CASS,
    "and a table we were not looking at changes nothing");
});

/* ------------------------------------------------------------------ *
 * The player, and ourselves
 * ------------------------------------------------------------------ */

test("a finger beats every rule", () => {
  assert.strictEqual(nextFocus({ kind: "chosen", key: BO }, room({ focusedKey: ADA, attached: true })), BO,
    "attached, joining, whatever — the player asked for this one");
  assert.strictEqual(nextFocus({ kind: "chosen", key: BO },
    room({ focusedKey: ADA, joining: true })), BO);
});

test("closing our own table puts us back in the room", () => {
  assert.strictEqual(
    nextFocus({ kind: "stopped-hosting" }, room({ focusedKey: ADA, latestKey: BO })), BO);
  // No "were we looking at it" to ask: the table we were looking at is the one
  // we just took away.
  assert.strictEqual(
    nextFocus({ kind: "stopped-hosting" }, room({ focusedKey: CASS, latestKey: BO })), BO);
  assert.strictEqual(
    nextFocus({ kind: "stopped-hosting" }, room({ focusedKey: ADA, latestKey: null })), null);
});

test("an unknown change is a mistake, not a no-op", () => {
  assert.throws(() => nextFocus({ kind: "wandered" }, room()), /unknown change/);
});
