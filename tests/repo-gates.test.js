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
