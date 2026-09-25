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
import { botDriverSeams } from "../src/ui/botSeams.js";

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

/**
 * A TEMPLATE TOUCHES STATE THROUGH `ctx` OR NOT AT ALL (#209).
 *
 * src/engine/context.js's header says the ctx helpers are the only way a
 * template touches state, and src/engine/fork.js's field-by-field copy list is
 * only SOUND while that holds: forkState copies what it knows a move can
 * change, so a template writing through a field it does not copy makes
 * lookahead mutate the live match. That was an intention rather than a rule,
 * and it did not hold — seventeen `ctx.state.` reach-ins, five raw
 * `zone(addr).cards.push` deals and three `state.js` imports had grown around
 * ctx, every one of them a method ctx was simply missing.
 *
 * Deliberately a grep over the source, for the reason the `rules.*` gate above
 * gives: the question is "does any line of a template go around ctx", and the
 * cheapest honest answer is the right one. If a template needs something ctx
 * does not offer, the fix is a method on context.js — never a reach-in.
 *
 * `.js` only: src/templates/CONTRACT.md quotes `ctx.state.roundEnded` in the
 * very paragraph that forbids it.
 */
test("no template reaches past ctx into the state container", () => {
  const files = tracked.filter((f) => f.startsWith("src/templates/") && f.endsWith(".js"));
  assert.ok(files.length >= 5, "src/templates/ has stopped being where templates live");

  const offences = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      // Comments discuss `state.gameOver` and the old imports at length; only
      // code counts.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\bctx\.state\b/.test(line)) {
        offences.push(`${where} reaches into ctx.state — add the method to src/engine/context.js`);
      }
      if (/from\s*['"][^'"]*engine\/state\.js['"]/.test(line)) {
        offences.push(`${where} imports src/engine/state.js — templates go through ctx`);
      }
      // The raw deal: a zone's card array written behind moveCards/placeDeck's
      // back, which is also how cardLocation goes stale.
      if (/\.zone\([^)]*\)\.cards\b/.test(line)) {
        offences.push(`${where} writes a zone's cards array directly — use ctx.placeDeck / ctx.moveCards`);
      }
    });
  }
  assert.deepStrictEqual(offences, [],
    "src/templates/ must touch state only through ctx (src/engine/context.js); "
    + "src/engine/fork.js's copy list depends on it");
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
  // The regex has to bite, or a green run means nothing (docs/plans/TABLES_PLAN.md §11).
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
 * ONE DEFAULT GRACE, IN ONE PLACE (#218).
 *
 * How long a seat gets when its host never chose was written twice: as
 * `DEFAULT_GRACE_MS` in src/ui/partyModel.js, which is what a tile draws its
 * countdown from, and as `TURN_TIMEOUT_MS` in src/ui/party.js, which is what
 * the host's own turn timer actually runs on and the middle entry of
 * `GRACE_CHOICES`. Two constants that had to stay equal and nothing making
 * them: change one and a host who never opened the grace menu runs a timer
 * every tile in the room disagrees with, with no test anywhere that fails.
 *
 * The model is the home, because the dependency only runs one way — party.js
 * is a DOM module and partyModel.js is pure, so the model can never import the
 * screen and the screen imports the model already.
 *
 * A grep, because the question is "is there a second one", and a source scan
 * is the only shape that can answer it.
 */
test("the default grace is one constant, and party.js reads it rather than keeping its own", () => {
  const model = fs.readFileSync(path.join(ROOT, "src/ui/partyModel.js"), "utf8");
  assert.match(model, /^export const DEFAULT_GRACE_MS = 60_000;$/m,
    "src/ui/partyModel.js no longer exports the one default grace");

  const lines = fs.readFileSync(path.join(ROOT, "src/ui/party.js"), "utf8").split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.ok(lines.some(({ line }) => /\bDEFAULT_GRACE_MS\b/.test(line)),
    "src/ui/party.js has stopped reading DEFAULT_GRACE_MS — the two copies are back");
  const copies = lines
    .filter(({ line }) => /=\s*60_?000\b/.test(line))
    .map(({ line, at }) => `src/ui/party.js:${at}  ${line.trim()}`);
  assert.deepStrictEqual(copies, [],
    "a second default grace has been declared in party.js. Import DEFAULT_GRACE_MS "
    + "from ./partyModel.js — the number the tiles promise and the number the timer "
    + "runs on have to be the same number, not two that happen to match.");
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
 *
 * TWO HALVES SINCE #223 SEAM 7. The call site still names its clock — that is
 * the grep — but the option list is built by `botDriverSeams`
 * (src/ui/botSeams.js), which party.js's headless driver shares. That builder
 * CAN be loaded, so the other half is asked of it: the clock the felt names is
 * the clock the driver gets, and there is no default for a forgotten one to
 * fall back to. Either failing is the #71 bug with the call site untouched.
 */
test("the felt's bot driver picks its clock from the match, not from the tab", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/table.js"), "utf8");
  // ONE DRIVER ON THE FELT. A second construction further down the file would
  // be a driver this gate never looked at.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.strictEqual((code.match(/createBotDriver\(/g) || []).length, 1,
    "src/ui/table.js builds more than one bot driver — every one of them has to pick its clock per match");
  // The seams' list is long; only its FIRST option matters here, and it is the
  // line straight after the call opens.
  const opener = src.match(/createBotDriver\(botDriverSeams\(\(\) => session\?\.table \?\? null, \{\s*\n\s*clock:\s*([^\n]*)/);
  assert.ok(opener, "src/ui/table.js no longer opens its bot driver's seams with a `clock:` option");
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

  // THE BUILDER HANDS THAT CLOCK THROUGH, AND HAS NONE OF ITS OWN.
  const noop = () => {};
  const hooks = { identityOf: noop, playMove: noop, playAnnouncement: noop, onError: noop };
  const felt = { kind: "felt", after: noop, at: noop, now: () => 0 };
  assert.strictEqual(botDriverSeams(() => null, { clock: felt, ...hooks }).clock, felt,
    "botDriverSeams must hand the driver the clock its caller named — a clock of its own is a "
    + "fixed answer for the life of the tab");
  assert.throws(() => botDriverSeams(() => null, hooks), /clock/,
    "botDriverSeams must refuse a missing clock rather than default one — the default is the #71 bug");
});

/**
 * ONE TIMER SEAM (#213).
 *
 * `Arcade.session.setTimeout` is a §6c obligation — a timer that freezes with
 * the frame rather than draining a battery nobody is watching — and it was
 * being met in nine places at once: four copies of the same wrapper, plus
 * eleven call sites that reached straight past all of them. One of those
 * copies had a `node --test` fallback and the others did not, so whether a
 * module could be exercised at all depended on which spelling its author
 * happened to pick.
 *
 * The seam is `sessionTimeout` in src/match/clock.js. `src/ui/clock.js`'s
 * `schedule` is the DOM side's `(fn, ms)` spelling of it, and nothing else in
 * `src/` names the SDK's timer. That is what makes "honour the battery rule"
 * an edit to one function, and what lets a test build ONE `Arcade.session`
 * stub and have every timer in the repo answer to it.
 *
 * A grep, for the reason the gate above gives: the question is "does anything
 * reach past the seam", and the cheapest honest answer is the right one.
 * Comment lines are exempt — several of them discuss the SDK timer by name,
 * which is the documentation working rather than a leak.
 */
test("nothing in src/ reaches for the SDK's session timer but the one seam", () => {
  const seam = "src/match/clock.js";
  const leaks = [];
  for (const f of tracked.filter((f) => f.startsWith("src/") && f.endsWith(".js"))) {
    if (f === seam) continue;
    const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // `Arcade.session` at all, not merely `.setTimeout` on it: the namespace
      // is the session clock, and a second door into it is the same leak by a
      // different name.
      if (/\bArcade\s*\??\.\s*session\b/.test(line)) leaks.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(leaks, [],
    `these sites reach past the timer seam: ${leaks.join(", ")}. `
    + `Use \`schedule(fn, ms)\` from src/ui/clock.js (DOM) or \`sessionClock()\` `
    + `from ${seam} — the SDK timer is named in exactly one function so the §6c `
    + "rule has one place to be honoured and tests have one stub to build.");
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

// THE HARNESS HELPERS ARE SHARED NOW, AND STAY SHARED (#207).
//
// Each of these three lines was pasted into ten or more test files before it
// had a home, and each pasted copy had drifted from the thing it was standing
// in for: a `packFromDisk` that forgot loadPack patches its manifest, an
// `Arcade.stats` stub that answered a stored category without the defaults the
// SDK merges under it, an `actingSeats` lambda with no "a finished match acts
// on nobody" guard. A copy is cheap to write and invisible in review, which is
// why this is a gate rather than a note in a header.
test("no test re-copies a harness helper that now has one home", () => {
  const banned = [
    {
      // `packs/<id>/manifest.json` read by hand — tools/lib/packs.mjs's job.
      re: /readFileSync\([^)]*manifest\.json/,
      allow: new Set(["tests/dailyLadder.test.js"]), // reads schema/, not a pack
      say: "load the pack with loadPackFromDiskSync/readPackJsonSync from tools/lib/packs.mjs",
    },
    {
      // A hand-built SDK stub (an object literal) — tests/fixtures/arcade.js's
      // job. Saving and restoring whatever was there (`= had`) is not a stub.
      re: /globalThis\.Arcade\s*=\s*\{/,
      allow: new Set(),
      say: "stand the SDK up with installArcade() from tests/fixtures/arcade.js",
    },
    {
      // The felt's own rule, hand-copied — src/engine/context.js's job.
      re: /\.actingSeats\s*\?/,
      allow: new Set(),
      say: "ask actingSeats(state) — tests/fixtures/engine.js re-exports the engine's",
    },
  ];
  for (const f of tracked.filter((f) => /^tests\/.*\.js$/.test(f))) {
    if (f === "tests/repo-gates.test.js" || f.startsWith("tests/fixtures/")) continue;
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const { re, allow, say } of banned) {
      if (allow.has(f)) continue;
      assert.ok(!re.test(src), `${f} re-copies a shared harness helper (${re}) — ${say}`);
    }
  }
});

// THE ENGINE IS THE BOTTOM LAYER, and a layer is only a layer while something
// checks. `src/engine` is the rules machine: state, moves, scoring, the pack
// loader. `src/templates` is the per-genre policy that sits ON it and
// `src/ui` is the felt that sits on both, so an import in this direction is a
// cycle waiting to close — which is exactly what it was. #210 found two:
// dailyLadder.js reaching for ../templates/melds.js (a one-pack feature filed
// in the engine; it is src/templates/contract-rummy-daily.js now) and
// packLoader.js reaching for ../templates/index.js's `getTemplate` (now
// injected, and bound in src/templates/loadPack.js).
//
// Comment lines are skipped: the modules here discuss the boundary at length,
// and a gate that fires on prose about itself teaches people to stop writing
// the prose.
test("src/engine imports neither src/templates nor src/ui", () => {
  const offenders = [];
  for (const f of tracked.filter((f) => /^src\/engine\/[^/]+\.(js|mjs)$/.test(f))) {
    const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // Static `from '...'` and dynamic `import('...')` alike.
      for (const m of line.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        if (/^\.\.\/(templates|ui)\//.test(m[1])) offenders.push(`${f}:${i + 1} imports ${m[1]}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    "src/engine must not import src/templates or src/ui — the engine is the bottom layer. "
    + "Inject what the engine needs (packLoader's `resolveTemplate`) or move the module "
    + "out of the engine (src/templates/contract-rummy-daily.js).");
});

/* ------------------------------------------------------------------ *
 * THE STYLESHEET (#214)
 * ------------------------------------------------------------------ *
 *
 * The stylesheet was the only tracked file class with no check on it at
 * all, and it showed: ten selector lists written twice in the same context, a
 * `gap` overridden by a second `gap` eleven lines further down the same block,
 * seven byte-identical pulse rings, and three `!important`s papering over a
 * specificity problem in the shared panel rule.
 *
 * A linter would catch all of that, and a linter is what the issue asked for.
 * It is not what this repo is — zero dependencies, and the memory of every
 * npm tree that ever went stale. So the rules live here, as the source scans
 * everything else in this file is, over a CSS reader small enough to read in
 * one sitting. It understands exactly as much as these three questions need:
 * where a block starts, what its prelude was, which @-rules it is inside, and
 * what its declarations are. It does not need to understand CSS.
 */

/** Every style rule in a sheet, with its @-context and its 1-based line. */
function cssRules(src) {
  // Comments become spaces rather than disappearing, so line numbers survive
  // and a `!important` inside a comment cannot be mistaken for a declaration.
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const rules = [];
  const context = [];   // the open @-rule preludes, outermost first
  let buf = "", line = 1, preludeLine = 1;
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  // The at-rules that WRAP other rules. Everything else that opens a brace
  // (@font-face, @page, @property) holds declarations and is read as a rule.
  const wraps = (p) => /^@(media|supports|container|layer|scope|document|(-\w+-)?keyframes)\b/i.test(p);
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "\n") line++;
    if (c === "}") { context.pop(); buf = ""; preludeLine = line; continue; }
    if (c !== "{") {
      if (!buf && /\s/.test(c)) { preludeLine = line; continue; }
      buf += c;
      continue;
    }
    const prelude = norm(buf);
    buf = "";
    if (wraps(prelude)) { context.push(prelude); preludeLine = line; continue; }
    // A declaration block: take it whole, to its matching close.
    let depth = 1, j = i + 1, body = "";
    for (; j < clean.length && depth; j++) {
      if (clean[j] === "{") depth++;
      else if (clean[j] === "}" && !--depth) break;
      body += clean[j];
    }
    rules.push({ prelude, body, line: preludeLine, context: context.join(" >> ") });
    for (let k = i; k < j; k++) if (clean[k] === "\n") line++;
    i = j;
    preludeLine = line;
  }
  return rules;
}

/** Split on the commas that are not inside `:is()`, `:where()`, `[]`, `()`. */
function topLevelSplit(text, sep) {
  const out = [];
  let depth = 0, cur = "";
  for (const c of text) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && !depth) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** A selector list, in a form that ignores whitespace, quoting and order. */
function selectorKey(prelude) {
  return topLevelSplit(prelude, ",")
    .map((s) => s.replace(/\s+/g, " ").trim()
      .replace(/\[[^\]]*\]/g, (m) => m.replace(/["']/g, "")))
    .sort().join(",");
}

function cssDeclarations(body) {
  return topLevelSplit(body, ";").map((d) => d.trim()).filter(Boolean)
    .map((d) => ({
      prop: d.slice(0, d.indexOf(":")).trim(),
      value: d.slice(d.indexOf(":") + 1).trim(),
    }))
    .filter((d) => d.prop);
}

const stylesheets = () => tracked.filter((f) => f.endsWith(".css"))
  .map((f) => ({ file: f, rules: cssRules(fs.readFileSync(path.join(ROOT, f), "utf8")) }));

/* ------------------------------------------------------------------ *
 * THE LINK ORDER (#221)
 * ------------------------------------------------------------------ *
 *
 * The sheet is eleven files now, and there is no `@layer` and no `@import`:
 * the order of the `<link>`s in index.html IS the order of the cascade. That
 * makes the sequence the one invariant of the split that nothing else in the
 * repo states — a reader can see what `felt.css` is for, but not that it has
 * to be read after `seats.css` and before `responsive.css`.
 *
 * So it is written down here, once, as a list. Two rules it encodes:
 *
 *  - `tokens.css` FIRST. Every other file resolves custom properties it
 *    declares, and a `var()` with no declaration in scope falls back rather
 *    than failing, which is the kind of breakage a screenshot does not show.
 *  - `responsive.css` LAST. "Stepping the whole felt down" overrides rules in
 *    five of the sheets above it at equal specificity, so it only wins by
 *    coming after them. Moving it up is the one edit here that silently
 *    changes the table at every width below a desktop window.
 */
const LINKED_CSS = [
  "src/ui/css/tokens.css",
  "src/ui/css/chrome.css",
  "src/ui/css/seats.css",
  "src/ui/css/felt.css",
  "src/ui/css/cards.css",
  "src/ui/css/moments.css",
  "src/ui/css/panels.css",
  "src/ui/css/lobby.css",
  "src/ui/css/party.css",
  "src/ui/css/review.css",
  "src/ui/css/responsive.css",
];

test("index.html links the stylesheets in cascade order", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const linked = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
    .map((m) => (m[0].match(/href="([^"]+)"/) || [])[1]);
  assert.deepStrictEqual(linked, LINKED_CSS,
    "the <link> sequence in index.html is the cascade order. If a sheet moved "
    + "on purpose, move it in LINKED_CSS too and say in the PR what it now "
    + "wins or loses — responsive.css in particular must stay last.");
});

// A sheet nobody links is dead weight that still passes every gate below it,
// and a link to a sheet that is not tracked 404s in the artifact. Set
// equality catches both, and catches a twelfth file added without a link.
test("every tracked stylesheet is linked exactly once", () => {
  assert.deepStrictEqual(
    tracked.filter((f) => f.endsWith(".css")).sort(),
    [...LINKED_CSS].sort(),
    "a stylesheet that is tracked but not linked is dead, and a link to an "
    + "untracked file 404s in the staged artifact");
});

/*
 * A selector written twice is two answers to one question, and the reader has
 * to hold six thousand lines in their head to know which one wins. Every pair
 * this found on its first run was an accident — a PR adding `position:
 * relative` to a selector that already had a block, a token declared next to
 * the one rule that used it — except one.
 */
const DUPLICATE_SELECTORS_ALLOWED = new Set([
  // #table-board is deliberately two rules: the container-query declaration
  // stands apart from the layout block, with a note saying why. Both blocks
  // must stay where they are; see the comments there.
  "#table-board",
]);

// Across the LINKED SHEET, not per file. Before #221 this was one file, so
// per-file and whole-sheet were the same question; after the split they are
// not, and the question worth asking is still the reader's — "which of these
// two wins?" — which does not care that they are now in different files.
test("no stylesheet writes the same selector list twice in one @-context", () => {
  const offenders = [];
  const seen = new Map();
  for (const { file, rules } of stylesheets()) {
    for (const r of rules) {
      const key = selectorKey(r.prelude);
      if (r.context.startsWith("@") && /keyframes/i.test(r.context)) continue; // 0%/100% steps
      const slot = `${r.context}||${key}`;
      if (!seen.has(slot)) seen.set(slot, []);
      seen.get(slot).push(`${file}:${r.line}`);
    }
  }
  for (const [slot, where] of seen) {
    const key = slot.split("||")[1];
    if (where.length > 1 && !DUPLICATE_SELECTORS_ALLOWED.has(key)) {
      offenders.push(`${where.join(", ")} — \`${key}\` ${where.length} times`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    "merge the blocks into the first one, or add the selector to "
    + "DUPLICATE_SELECTORS_ALLOWED with a comment saying why it is two rules");
});

/*
 * The same property twice in one block is either dead code or a fallback. A
 * fallback is written as a LADDER — the two declarations adjacent, the older
 * value first, e.g. `max-height: 100vh; max-height: 100dvh;` — and that shape
 * is allowed. Anything else is one of the two values never taking effect,
 * which is what `.opponent-row`'s `gap: 1.25rem` was, eleven lines above the
 * `clamp()` that replaced it.
 */
test("no stylesheet declares a property twice in one block", () => {
  const offenders = [];
  for (const { file, rules } of stylesheets()) {
    for (const r of rules) {
      const decls = cssDeclarations(r.body);
      decls.forEach((d, i) => {
        const prev = decls.findLastIndex((o, k) => k < i && o.prop === d.prop);
        if (prev < 0) return;
        const ladder = prev === i - 1 && decls[prev].value !== d.value;
        if (!ladder) {
          offenders.push(`${file}:${r.line} \`${r.prelude.slice(0, 48)}\` declares `
            + `\`${d.prop}\` twice`);
        }
      });
    }
  }
  assert.deepStrictEqual(offenders, [],
    "one of the two never takes effect. Delete the dead one — or, if it is a "
    + "fallback for a value an old browser cannot parse, put the two "
    + "declarations next to each other so it reads as a ladder");
});

/*
 * `!important` is how a rule wins an argument it should have settled with a
 * selector, and it is unanswerable: the next rule that needs to override it
 * has to shout too. The only honest use on this table is the kill switch —
 * under prefers-reduced-motion nothing may move, and that has to beat every
 * animation in the file including a pack's own. So it is allowed there and
 * nowhere else.
 *
 * Three lived outside it: `.panel--wide` and `.choice-dialog` fighting the
 * shared panel rule, whose id-and-a-class specificity no modifier could reach.
 * The fix was the selector (`:where()` on the mounting ids), which is always
 * what the fix is.
 */
test("`!important` appears only under prefers-reduced-motion", () => {
  const offenders = [];
  for (const { file, rules } of stylesheets()) {
    for (const r of rules) {
      if (/prefers-reduced-motion/i.test(r.context)) continue;
      for (const d of cssDeclarations(r.body)) {
        if (/!\s*important/i.test(d.value)) {
          offenders.push(`${file}:${r.line} \`${r.prelude.slice(0, 48)}\` — ${d.prop}`);
        }
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    "raise the losing rule's specificity or lower the winning one's "
    + "(`:where()` costs nothing) instead of shouting");
});
