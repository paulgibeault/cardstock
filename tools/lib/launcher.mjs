// WHERE THE LAUNCHER IS, AND WHAT TO SAY WHEN IT IS NOT THERE.
//
// Three tools drive the launcher checkout — acceptance, mp-acceptance, mp-play —
// and each opened with the same four lines: resolve ARCADE_LAUNCHER or the
// sibling clone, read ARCADE_PORT, name the game, and bail with a hint if the
// checkout is missing. The hint is the part that matters and the part that had
// already drifted: mp-play's copy said only "no launcher checkout at <path>",
// which tells a contributor nothing about the sibling clone or about CI's
// `launcher: true`.
//
// The port is 4791 because that is the one dev.sh serves on and the one Paul
// keeps a browser pointed at; a tool that takes it over says so in its own header.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../stage.mjs';

// In CI the pipeline exports ARCADE_LAUNCHER; locally the launcher is the
// sibling checkout every other workflow in this repo assumes.
export const LAUNCHER = process.env.ARCADE_LAUNCHER || path.resolve(ROOT, '..', 'paulgibeault.github.io');
export const PORT = Number(process.env.ARCADE_PORT || 4791);
export const BASE = `http://127.0.0.1:${PORT}`;
export const GAME_ID = 'cardstock';

/**
 * Exit with the standard hint unless the launcher checkout holds `file`.
 *
 * @param tool  the calling tool's name, which leads the message
 * @param file  the path inside the launcher the caller actually needs —
 *              `dev.sh` for the servers, the p2p harness for mp-acceptance
 * @returns the absolute path to `file`, so a caller can go straight on to use it
 */
export function requireLauncher(tool, file = 'dev.sh') {
  const full = path.join(LAUNCHER, file);
  if (!fs.existsSync(full)) {
    console.error(
      `${tool}: no launcher checkout at ${LAUNCHER}\n`
      + '  Locally, clone paulgibeault/paulgibeault.github.io as a sibling directory.\n'
      + '  In CI, ARCADE_LAUNCHER comes from `launcher: true` in .github/workflows/pages.yml.');
    process.exit(1);
  }
  return full;
}

/** The launcher's dev server, run from its own checkout as it expects. */
export function devSh(...args) {
  return execFileSync(path.join(LAUNCHER, 'dev.sh'), args, { cwd: LAUNCHER, stdio: 'inherit' });
}
