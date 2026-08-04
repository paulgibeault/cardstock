// Stage the deploy artifact: tracked files minus the dev set.
//
// ONE implementation, two callers — the deploy job runs it to build dist/,
// and tools/verify-artifact.mjs runs it into a temp dir to prove the result
// contains everything the game asks for at runtime. That shared origin is the
// point: a staging rule the tests don't exercise is a rule that goes stale in
// silence, which is how a published site ends up missing a directory nobody
// noticed.
//
// This is the ONLY per-app file of the three (GAME_INTEGRATION §13a);
// verify-artifact.mjs and inject-precache.mjs are byte-identical fleet-wide
// and must never be edited locally.
//
// Usage: node tools/stage.mjs <outDir>
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectPrecache } from "./inject-precache.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Published, deliberately not precached. Empty on purpose: everything this
// game publishes is needed to play a hand offline — index.html, the module
// graph under src/, and every pack's manifest/deck under packs/. There is no
// diagnostic, provenance archive or on-demand asset to leave out.
//
// verify-artifact.mjs fails the build on any published file that is neither
// cached nor named here, so an omission is a decision written down rather
// than one nobody notices.
export const PRECACHE_EXCLUDE = [];

// Dev-only: tooling, tests, notes, and local helpers. Everything else a repo
// tracks is game content and ships.
//
// `schema/` is here because the JSON Schemas are authoring-time contracts for
// pack files — nothing fetches them at runtime, and the loader deliberately
// does not re-validate in the browser (see src/engine/packLoader.js).
const EXCLUDE_DIRS = new Set([".github", ".claude", "node_modules",
  "tests", "test", "docs", "scratch", "tools", "scripts", "schema"]);
const EXCLUDE_ROOT = new Set(["package.json", "package-lock.json",
  ".gitignore", "go.sh", "ago",
  // Pages deploys from GitHub Actions, so there is no Jekyll build to opt out
  // of and the marker is dead weight in the artifact.
  ".nojekyll"]);
const EXCLUDE_EXT = new Set([".md", ".py", ".pid"]);

export function isDevOnly(f) {
  return EXCLUDE_DIRS.has(f.split("/")[0]) ||
    (!f.includes("/") && EXCLUDE_ROOT.has(f)) ||
    (!f.includes("/") && /^test_/.test(f)) ||
    EXCLUDE_EXT.has(path.extname(f)) ||
    // The fleet default only excludes TOP-LEVEL directories, and cardstock's
    // rule tests are nested one pack deep (packs/<id>/tests/rules.test.json).
    // Without this they publish, and then verify-artifact.mjs demands they be
    // precached — shipping the test corpus to every player's offline cache.
    /(^|\/)tests\//.test(f);
}

/** Stage into outDir and return it. */
export function stage(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  const files = execSync("git ls-files -z", { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
  let staged = 0;
  for (const f of files) {
    if (isDevOnly(f)) continue;
    fs.mkdirSync(path.join(outDir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(outDir, f));
    staged++;
  }
  // Last, so it sees the finished artifact — the precache list is written from
  // what is actually about to deploy, not from what anyone believes is.
  injectPrecache(outDir, { exclude: PRECACHE_EXCLUDE });
  return { outDir, staged, total: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = process.argv[2];
  if (!out) { console.error("usage: node tools/stage.mjs <outDir>"); process.exit(1); }
  const r = stage(path.resolve(ROOT, out));
  console.log(`staged ${r.staged} files to ${out}/ (${r.total - r.staged} dev files excluded)`);
}
