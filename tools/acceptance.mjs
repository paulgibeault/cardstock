#!/usr/bin/env node
// The arcade's own integration gate, run against this game: `npm run acceptance`.
//
// GAME_INTEGRATION §13 ships tools/acceptance.mjs in the LAUNCHER repo — a
// Playwright runner for the whole checklist (framed handshake, namespaced
// storage, save/load round-trip, font-scale propagation, suspend/resume, caps
// negotiation, graceful degradation under an older launcher). None of that is
// this repo's to reimplement, and tests/ deliberately doesn't try: those test
// the game, this tests the integration.
//
// The doc's flow is `./dev.sh ../cardstock` in one shell and the runner in
// another. This does both in one process, so the whole checklist is one
// command.
//
// CI does not run this YET. The fleet's `launcher: true` input invokes exactly
// this script (it checks the launcher out as ARCADE_LAUNCHER), but the flag is
// off in .github/workflows/pages.yml until `cardstock` is in the launcher's
// upstream catalog.json — without a catalog entry there is no tile to launch
// the game from and the framed-boot check correctly fails. The comment there
// carries the re-enable instructions.
//
// IT STAGES FIRST, AND SERVES THE ARTIFACT — not the checkout. Same reason
// tools/verify-artifact.mjs does: a checkout obviously contains every file, so
// only the artifact can catch a staging rule that drops one the game needs at
// runtime. Pointing dev.sh at the checkout would also mount the CI launcher
// clone (.launcher/, which lives inside this workspace) underneath the game.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, stage } from './stage.mjs';

// In CI the pipeline exports ARCADE_LAUNCHER; locally the launcher is the
// sibling checkout every other workflow in this repo assumes.
const LAUNCHER = process.env.ARCADE_LAUNCHER || path.resolve(ROOT, '..', 'paulgibeault.github.io');
const PORT = process.env.ARCADE_PORT || '4791';
const GAME_ID = 'cardstock';

if (!fs.existsSync(path.join(LAUNCHER, 'dev.sh'))) {
  console.error(
    `acceptance: no launcher checkout at ${LAUNCHER}\n` +
    '  Locally, clone paulgibeault/paulgibeault.github.io as a sibling directory.\n' +
    '  In CI, ARCADE_LAUNCHER comes from `launcher: true` in .github/workflows/pages.yml.');
  process.exit(1);
}

const devSh = (...args) =>
  execFileSync(path.join(LAUNCHER, 'dev.sh'), args, { cwd: LAUNCHER, stdio: 'inherit' });

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardstock-acceptance-'));
let started = false;
try {
  const { staged } = stage(outDir);
  console.log(`staged ${staged} files for acceptance`);

  // dev.sh reads the mount slug from Arcade.init({ gameId }) in index.html, so
  // a temp directory still mounts at /cardstock/ — the checkout's name is not
  // authoritative and neither is this one.
  devSh(outDir);
  started = true;

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [path.join(LAUNCHER, 'tools', 'acceptance.mjs'), `http://127.0.0.1:${PORT}/${GAME_ID}/`],
      { cwd: LAUNCHER, stdio: 'inherit' });
    child.on('close', (c) => resolve(c ?? 1));
  });
  process.exitCode = code;
} finally {
  // Always, even on a throw: a leaked background server holds the port and
  // makes the NEXT run fail for a reason that has nothing to do with the game.
  if (started) { try { devSh('stop'); } catch { /* already gone */ } }
  fs.rmSync(outDir, { recursive: true, force: true });
}
