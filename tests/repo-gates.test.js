// Source-level gates: everything tracked has to parse.
//
// Deliberately about the SOURCE, not the deploy — what the published artifact
// must contain is tools/verify-artifact.mjs's job, and it checks the staged
// output rather than the checkout, which is the only way to catch a staging
// rule that drops a file the game needs.
import { test } from "node:test";
import assert from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { listPackIds, validatePackFiles } from "../tools/pack-test.mjs";

const tracked = execSync("git ls-files -z", { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter(Boolean);

test("every tracked JS file parses", () => {
  for (const f of tracked.filter((f) => /\.(js|mjs)$/.test(f))) {
    const r = spawnSync(process.execPath, ["--check", f], { cwd: ROOT });
    assert.strictEqual(r.status, 0, `node --check ${f} failed:\n${r.stderr}`);
  }
});

test("every tracked JSON file parses", () => {
  for (const f of tracked.filter((f) => f.endsWith(".json"))) {
    assert.doesNotThrow(
      () => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")),
      `${f} is not valid JSON`);
  }
});

// The vendored fleet files are byte-identical copies (GAME_INTEGRATION §13a).
// Their canonical home is the launcher repo, which is not checked out in CI,
// so this can only assert that nobody has started editing them locally —
// the marker comment every canonical copy carries.
test("vendored fleet files still declare themselves canonical", () => {
  for (const f of ["tools/verify-artifact.mjs", "tools/inject-precache.mjs",
                   "src/engine/arcade-rng.js"]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue; // arrives in Phase 2
    const src = fs.readFileSync(p, "utf8");
    assert.match(src, /IDENTICAL IN EVERY FLEET REPO/,
      `${f} is a vendored copy — re-copy the launcher's canonical file, never edit it here`);
  }
});

// The lobby fetches packs/index.json because a browser cannot list a
// directory. That makes it a hand-maintained mirror of `packs/`, and a mirror
// nobody checks goes stale — a pack added without an entry is invisible in the
// lobby, and an entry left behind after a rename 404s a tile.
//
// Set equality, not deep equality: the file's ORDER is the lobby's grid order,
// which is an editorial choice and deliberately not alphabetical.
test("packs/index.json lists exactly the packs on disk", () => {
  const listed = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packs", "index.json"), "utf8")).packs;
  assert.ok(Array.isArray(listed), "packs/index.json must have a `packs` array");
  assert.deepStrictEqual(new Set(listed), new Set(listPackIds()));
  assert.strictEqual(listed.length, new Set(listed).size, "duplicate pack id");
});

// Every tile in the lobby is drawn from its manifest alone — the lobby does
// NOT load decks, because opening it would then cost a full pack load per
// game. A manifest missing this metadata renders a blank card on the felt.
test("every pack manifest carries its lobby presentation", () => {
  for (const packId of listPackIds()) {
    const m = JSON.parse(fs.readFileSync(
      path.join(ROOT, "packs", packId, "manifest.json"), "utf8"));
    assert.ok(m.tagline, `${packId}: no tagline for its lobby tile`);
    assert.match(m.accent, /^#[0-9a-fA-F]{6}$/, `${packId}: accent must be a 6-digit hex`);
    assert.ok(Array.isArray(m.heroCards) && m.heroCards.length === 3,
      `${packId}: heroCards must be the three faces the tile fans`);
  }
});

// THE SCHEMAS ARE NORMATIVE (design doc §11) — which was an aspiration until
// this gate existed, because no code in the repo read schema/*.json at all. The
// first run of it found `meldForbidden` declared by a manifest, read by two
// modules, and absent from a closed schema; and the rule-test move shape missing
// the `id`/`target` that announcements have carried since they shipped.
//
// The check itself lives in tools/pack-test.mjs so a pack author running
// `npm run pack-test` gets the identical gate locally, per §11's promise.
test("every pack validates against schema/", async () => {
  const problems = [];
  for (const packId of listPackIds()) problems.push(...(await validatePackFiles(packId)));
  assert.deepStrictEqual(problems, []);
});

/**
 * A DECLARED PARAMETER NOBODY READS IS A LIE THE SCHEMA TELLS.
 *
 * This is the gate that would have caught `playAfterDraw` / `mustPlayIfAble`
 * sitting unread in two manifests through a whole playtest cycle (feedback #14
 * and #15), and the dozen others the architecture review found behind them:
 * `trickWinner`, `dealAll`, `leader`, `progression`, `layDown`, `hitting`,
 * `goingOut`, `turnEnd`, `undo`, `turnTimer`, `ui.felt`. Every one of them
 * described behaviour that was hardcoded somewhere in src/, so a pack author
 * could change the declaration and watch nothing happen.
 *
 * Deliberately a grep and not something cleverer: the question is "does any
 * line of the platform mention this key", and the cheapest honest answer is the
 * right one. A false pass needs someone to write `rules.foo` in a comment,
 * which is a much smaller failure than the one it prevents.
 *
 * Variants marked `available: false` are excluded — those are declarations of
 * intent for rules no template implements yet, which the schema gate above
 * skips for the same reason.
 */
test("every rules.* key a manifest declares is read somewhere in src/", () => {
  const source = tracked
    .filter((f) => f.startsWith("src/") && f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
    .join("\n");

  const declared = new Map(); // key -> packs that declare it
  for (const packId of listPackIds()) {
    const m = JSON.parse(fs.readFileSync(
      path.join(ROOT, "packs", packId, "manifest.json"), "utf8"));
    const note = (key) => {
      if (!declared.has(key)) declared.set(key, []);
      declared.get(key).push(packId);
    };
    for (const key of Object.keys(m.rules || {})) note(key);
    for (const variant of m.variants || []) {
      if (variant.available === false) continue;
      for (const dotted of Object.keys(variant.patch || {})) {
        const [head, key] = dotted.split(".");
        if (head === "rules" && key) note(key);
      }
    }
  }

  const unread = [...declared.entries()]
    .filter(([key]) => !new RegExp(String.raw`rules\??\.${key}\b`).test(source))
    .map(([key, packs]) => `rules.${key} (declared by ${packs.join(", ")})`);
  assert.deepStrictEqual(unread, [],
    "declared but read by no line of src/ — implement it or delete it, per the §13 extension policy");
});

// §10: CI rewrites this line with sed on every deploy. If the shape drifts the
// rewrite silently stops firing and every fix ships to nobody who has already
// visited — which has happened twice in this fleet. Assert the SHAPE, not the
// value: comparing it to package.json's version false-fails on any PR left
// open across a deploy.
test("sw.js keeps the CI-owned APP_VERSION line shape", () => {
  const p = path.join(ROOT, "sw.js");
  if (!fs.existsSync(p)) return; // arrives in Phase 5
  assert.match(fs.readFileSync(p, "utf8"), /^const APP_VERSION = '\d+\.\d+\.\d+';$/m);
});

/**
 * ONE DOOR OUT, PER MODULE (#63).
 *
 * Every frame the host or the client sends is completed on the way out —
 * `stamp()` in host.js, the spread in client.js's `send`/`broadcast` — and
 * protocol v2 makes that completion load-bearing: a frame without a `tableId`
 * is refused by the other end's validator.
 *
 * #56 was exactly this. `emote` and `sendBye` reached for `peer.send` directly
 * because they take no `{ to }`, skipped the stamp along with the targeting,
 * and went out unaddressable. Every unit test passed; a joiner who left could
 * never rejoin.
 *
 * So: `peer.send` may be named only inside the functions that complete a frame.
 * Anywhere else is a frame leaving through a door nobody is watching.
 */
/**
 * NO IMPLICIT SUBJECT (#73).
 *
 * `function f(session = ourTable())` reads as a convenience and behaves as a
 * trap: forget the argument and the call compiles, passes review, and answers
 * about whichever table the panel happens to be pointed at. That bug shipped
 * three times during the two-table work — #64, #69, and `takeTurn` in #58 —
 * and every time the shape that admitted it was this default.
 *
 * So the session is a required parameter, and a caller that genuinely means
 * "the table on screen" writes `ourTable()` at the call site, where the choice
 * of subject is visible to whoever reads it next.
 *
 * THE PARAMETER SHAPE ONLY. `const session = ourTable()` inside a function is
 * exactly the legibility this asks for, and the file talks about the pattern in
 * prose — neither is what the gate is about.
 */
const OURTABLE_DEFAULT = /\([^()]*\b[A-Za-z_$][\w$]*\s*=\s*ourTable\(\)/;

test("party.js takes its session, never defaults to the focused table", () => {
  // The regex has to bite, or a green run means nothing (TABLES_PLAN.md §11).
  assert.match("function refreshSeats(session = ourTable()) {", OURTABLE_DEFAULT);
  assert.match("function askAboutSeat(seat, session = ourTable()) {", OURTABLE_DEFAULT);
  assert.doesNotMatch("  const session = ourTable();", OURTABLE_DEFAULT);

  const file = "src/ui/party.js";
  const offenders = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(({ line }) => OURTABLE_DEFAULT.test(line))
    .map(({ line, at }) => `${file}:${at}  ${line.trim()}`);
  assert.deepStrictEqual(offenders, [],
    "a session defaulted to ourTable() answers about the focused table, not the one "
    + "the caller meant. Make it a required parameter and write ourTable() at the call site.");
});

/**
 * THE FELT'S BOTS ASK WHICH TABLE THEY ARE AT (#71).
 *
 * `createBotDriver` is built once, in `initTable`, before any match exists — so
 * the clock it is handed has to be one that asks per timer, not one chosen at
 * construction. Hand it `sessionClock()` and a HOSTED table the host is looking
 * at schedules its bots on time that freezes when the frame suspends: the host
 * pockets their phone on a bot's turn and the table stops for everybody at it.
 *
 * `tests/clock.test.js` proves `feltClock` dispatches correctly. It cannot
 * prove the felt ASKS — src/ui/table.js touches `document` at import time, so
 * no Node test can load it, and the symptom needs a frame suspension the
 * three-launcher harness has no hook for. Reverting the call site alone to
 * `() => false` reintroduces the whole bug with 493 tests still green, which is
 * what this gate is for.
 *
 * Deliberately a grep, for the reason the rules.* gate above gives: the
 * question is "does the felt's driver read the shared flag", and the cheapest
 * honest answer is the right one.
 */
test("the felt's bot driver picks its clock from the match, not from the tab", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/table.js"), "utf8");
  // The driver's option list is long; only its FIRST option matters here, and
  // it is the line straight after the call opens.
  const opener = src.match(/createBotDriver\(\{\s*\n\s*clock:\s*([^\n]*)/);
  assert.ok(opener, "src/ui/table.js no longer opens its bot driver with a `clock:` option");
  assert.match(opener[1], /feltClock\(/,
    "the felt's driver must take feltClock — a fixed clock is the solo answer for the life of the tab");
  // The predicate itself, captured rather than pattern-matched around: a
  // negative lookahead here backtracks through `\s*` and quietly passes on the
  // very text it is meant to refuse.
  const predicate = (opener[1].match(/shared:\s*\(\)\s*=>([^,}]+)/) || [, ''])[1].trim();
  assert.ok(predicate, "feltClock is not being asked a `shared` question at all");
  assert.match(predicate, /session/,
    `feltClock must read the MATCH on the felt, not a constant — found \`shared: () => ${predicate}\`, `
    + "which is the #71 bug restored");
});

test("no frame leaves src/match without going through its stamping helper", () => {
  const allowed = {
    "src/match/host.js": 2,     // sendTo + broadcast, both via stamp()
    // ONE DOOR, NOT TWO, since protocol v3. The second was `broadcast`, for the
    // `emote` and `bye` a joiner said to the room; both are targeted at the host
    // now and re-announced by it, so a client speaks to exactly one device.
    "src/match/client.js": 1,   // send (targeted), spreading tableId
    // THE UI DOES NOT TOUCH THE WIRE. party.js sent three frames of its own —
    // an emote and the two `bye`s — each stamping `tableId` by hand. Correct,
    // and three more doors beside which a fourth could be added without anyone
    // noticing it had skipped the stamp. They go through the host now.
    "src/ui/party.js": 0,
  };
  for (const [file, budget] of Object.entries(allowed)) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    // Comments talk about `peer.send` a great deal; only calls count.
    const calls = src.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .filter((l) => /\b(peer|port)\??\.send\s*\(/.test(l)).length;
    assert.strictEqual(calls, budget,
      `${file} has ${calls} peer.send call(s), expected ${budget}. `
      + "A new one means a frame that skips the stamp — give it to send()/broadcast() instead. "
      + "If the door count genuinely changed, update this gate deliberately.");
  }
});
