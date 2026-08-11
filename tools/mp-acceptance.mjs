#!/usr/bin/env node
// THREE REAL LAUNCHERS, THREE REAL BROWSER PROFILES, ONE REAL RTCPeerConnection.
//
// This is WP-C6's Definition of Done (MULTIPLAYER_PLAN.md §11) and the tier
// above tests/protocol.test.js. That file drives the same modules over an
// in-memory star and is where the nasty cases live — a spoofed authority frame,
// a dropped view, a proposal from the wrong seat — because every one of them is
// four lines there and an ordeal here. What it cannot do is the thing this file
// exists for: prove the protocol survives contact with the actual transport, in
// three genuinely separate devices, with the actual launcher mediating.
//
// WHY THE LAUNCHER'S HARNESS RATHER THAN OUR OWN. `startP2PHarness` already
// solves the parts that make a p2p test honest, and re-solving them here would
// mean maintaining a second, worse copy:
//
//   * one BROWSER CONTEXT PER DEVICE — distinct localStorage and IndexedDB, so
//     device ids and DTLS identity certificates genuinely differ the way they
//     do between two phones. Two tabs on one profile share an identity and
//     prove nothing about a protocol whose every authority check is per-device.
//   * an in-test DEAD DROP on a local port, standing in for the public MQTT
//     brokers, so a run touches no external infrastructure.
//   * FORCED LOCAL ICE (empty iceServers), so no STUN round trip.
//   * the SIGNALING CEREMONY driven at the transport level. The real one is
//     human-mediated on purpose — a QR code and a chat app — so automating it
//     through the launcher's dialog would mean intercepting the clipboard and
//     re-finding buttons that move between steps, and re-doing all of it every
//     time that dialog changes.
//
// WHY dev.sh SERVES AND THE HARNESS DOES NOT. `startP2PHarness` brings a bare
// `python3 -m http.server`, which is right for the launcher's own fixtures and
// wrong for us: GAME IFRAMES ARE SANDBOXED WITHOUT allow-same-origin, so their
// origin is `null` and every module script and fetch inside one arrives as a
// CORS request. A header-less server answers those with a 404-shaped failure —
// `src/main.js` never even executes — while the page still looks alive, because
// `/arcade-sdk.js` is a CLASSIC script and classic scripts are no-cors. That is
// a genuinely nasty way to lose an afternoon, and it is why this suite stages
// through the launcher's `dev.sh` (which runs tools/dev-server.py, sending the
// `Access-Control-Allow-Origin: *` GitHub Pages sends in production) and then
// hands `startP2PHarness` that same port. The harness's own server loses the
// bind and exits; nothing races, because dev.sh is confirmed listening first.
//
// HOW IT REACHES THE GAME. ES modules are singletons per URL, so
// `import(new URL('src/ui/party.js', location.href))` inside the game's frame
// returns THE SAME module instance `src/main.js` is running on. The suite
// clicks real buttons and reads the real DOM wherever it can.
//
// Two exports exist partly for this suite and are named as such in
// src/ui/party.js: `partySnapshot()` reports what the screen already shows, and
// `takeTurn()` takes the turn this device has been offered, by the same two
// roads a finger takes (a joiner proposes from the host-shipped list; a host
// applies). Three browser contexts cannot reach a module-scoped `let`, and a
// scripted hand has to be able to say "your turn" — but the line is that
// neither one grants a capability the UI does not already offer.
//
// IT SERVES THE STAGED ARTIFACT, NOT THE CHECKOUT — same reason
// tools/acceptance.mjs and tools/verify-artifact.mjs do. A checkout obviously
// contains every file, so only the artifact can catch a staging rule that drops
// one the game needs at runtime. ONE CONSEQUENCE WORTH KNOWING BEFORE YOU DEBUG
// A GHOST: staging copies `git ls-files`, so a NEW FILE YOU HAVE NOT `git
// add`ED IS NOT IN THE RUN. The check below names them rather than letting you
// wonder why an import 404s.
//
// IT TAKES OVER PORT 4791, the port dev.sh serves on — so it stops whatever
// local dev server is already there, exactly as `npm run acceptance` does.
//
// Usage:  node tools/mp-acceptance.mjs            (all scenarios)
//         node tools/mp-acceptance.mjs --only=3   (one, by number)
//
// Exit code: 0 if every check passes, 1 otherwise.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, stage } from './stage.mjs';

/* ------------------------------------------------------------------ *
 * Where everything lives
 * ------------------------------------------------------------------ */

// In CI the pipeline exports ARCADE_LAUNCHER; locally the launcher is the
// sibling checkout every other workflow in this repo assumes.
const LAUNCHER = process.env.ARCADE_LAUNCHER || path.resolve(ROOT, '..', 'paulgibeault.github.io');
const PORT = Number(process.env.ARCADE_PORT || 4791);
const DROP_PORT = Number(process.env.ARCADE_MP_DROP_PORT || 4812);
const GAME_ID = 'cardstock';

const harnessPath = path.join(LAUNCHER, 'tools', 'lib', 'p2p-test-harness.mjs');
if (!fs.existsSync(harnessPath)) {
  console.error(
    `mp-acceptance: no launcher checkout at ${LAUNCHER}\n`
    + '  Locally, clone paulgibeault/paulgibeault.github.io as a sibling directory.\n'
    + '  In CI, ARCADE_LAUNCHER comes from `launcher: true` in .github/workflows/pages.yml.');
  process.exit(1);
}

const { startP2PHarness, makeCheck, waitFor } = await import(pathToFileURL(harnessPath).href);
const { check, failed } = makeCheck();

const devSh = (...args) =>
  execFileSync(path.join(LAUNCHER, 'dev.sh'), args, { cwd: LAUNCHER, stdio: 'inherit' });

/* ------------------------------------------------------------------ *
 * Staging
 * ------------------------------------------------------------------ */

/** Files the artifact will not contain because git has never heard of them. */
function untrackedGameFiles() {
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: ROOT, encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((f) => /^(src|packs|js)\//.test(f) || f === 'index.html');
}

/**
 * Give a frame a way to import the game's OWN modules.
 *
 * `location.href` is the mounted index.html, so `__mod('src/ui/party.js')`
 * resolves to exactly the URL `src/main.js` imported — and an ES module is one
 * instance per URL, so what comes back is the live module the game is running
 * on, not a second copy with its own state.
 *
 * Installed by the TEST, on the page, at run time. Nothing in the shipped game
 * knows this exists.
 */
function installModuleLoader(frame) {
  return frame.evaluate(() => {
    window.__mod = (specifier) => import(new URL(specifier, location.href).href);
  });
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

const missing = untrackedGameFiles();
if (missing.length) {
  console.error('\nmp-acceptance: these files are UNTRACKED and will not be in the artifact:');
  for (const f of missing) console.error(`  ${f}`);
  console.error('  `git add` them first — otherwise the run tests a build without them.\n');
  process.exit(2);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardstock-mp-'));
const { staged } = stage(outDir);
console.log(`staged ${staged} files for multiplayer acceptance`);

// dev.sh reads the mount slug from Arcade.init({ gameId }) in index.html, so a
// temp directory still mounts at /cardstock/.
devSh(outDir);

const harness = await startP2PHarness({ port: PORT, dropPort: DROP_PORT });
let exitCode = 1;
try {
  console.log('\nCardstock multiplayer acceptance — host + two joiners, real transport\n');

  /* --- 1. Three devices, three launchers ------------------------- */

  const contexts = {};
  for (const label of ['H', 'A', 'B']) contexts[label] = await harness.newDeviceContext();
  const H = await harness.launcherPage('H', contexts.H);
  const A = await harness.launcherPage('A', contexts.A);
  const B = await harness.launcherPage('B', contexts.B);

  for (const [page, label] of [[H, 'host'], [A, 'joiner A'], [B, 'joiner B']]) {
    await harness.bootBridge(page, { closeDialog: true });
    check(`${label}: bridge + vendored transport loaded`, true);
  }

  /* --- 2. The star: two ceremonies against one host --------------- */

  // waitHost:false — the host's aggregate status is not what a second link
  // proves, and the first is still live while the second is minted.
  await harness.ceremony(H, A, { waitHost: false });
  check('joiner A connected (first link)', true);
  await harness.ceremony(H, B, { waitHost: false });
  await H.waitForFunction('window.__arcade.p2p._addon().peerNode.peers.size === 2', null, { timeout: 20000 });
  check('joiner B connected — the host holds two live links', true);

  // Read AFTER the ceremonies: the id is minted when the peer node first needs
  // one, so a read at boot returns null and every later comparison silently
  // compares nothing to nothing.
  const devices = {
    H: await harness.deviceIdOf(H),
    A: await harness.deviceIdOf(A),
    B: await harness.deviceIdOf(B),
  };
  check('three genuinely distinct device ids',
    Object.values(devices).every(Boolean) && new Set(Object.values(devices)).size === 3,
    Object.values(devices).join(' '));

  /* --- 3. Cardstock, mounted in all three ------------------------- */

  for (const page of [H, A, B]) {
    await page.evaluate((id) => window.__arcade.showGame(id, `${id}/index.html`, 'Cardstock'), GAME_ID);
  }
  const frames = {
    H: await harness.fixtureFrame(H, `${GAME_ID}/index.html`),
    A: await harness.fixtureFrame(A, `${GAME_ID}/index.html`),
    B: await harness.fixtureFrame(B, `${GAME_ID}/index.html`),
  };
  for (const frame of Object.values(frames)) {
    // The lobby grid is rendered by src/main.js — so waiting for it proves the
    // MODULE graph ran, not merely that the classic-script SDK loaded. That
    // distinction is the whole CORS trap described in the header.
    await frame.waitForFunction("!!document.querySelector('#lobby-grid .tile')", null, { timeout: 20000 });
    await installModuleLoader(frame);
  }
  check('cardstock booted in all three launchers', true);

  for (const frame of Object.values(frames)) {
    await frame.waitForFunction("window.Arcade.peer.status() === 'connected'", null, { timeout: 20000 });
  }
  check('all three games see peer.status connected', true);

  // The id the GAME is given has to be the id the launcher holds — every
  // authority check in src/match/ is a comparison against `peer.self()`, so a
  // game reading a different identity than the transport binds would pass every
  // test in tests/ and trust the wrong device here.
  for (const [label, frame] of Object.entries(frames)) {
    const seen = await frame.evaluate(() => window.Arcade.peer.self()?.deviceId || null);
    check(`${label}: the game's peer.self() is the launcher's device id`, seen === devices[label],
      `${seen} vs ${devices[label]}`);
  }

  /* --- 4. The caps gate, against the real launcher ---------------- */

  // src/match/peerPort.js refuses to show any multiplayer UI without
  // peer.sendTo / peer.roster / peer.meta, and names what is missing so the
  // notice can be specific. Everything below depends on the real launcher
  // actually satisfying it — which nothing in tests/ can check, because the
  // stub grants those caps by construction.
  const availability = await frames.A.evaluate(async () => {
    const { peerAvailability } = await window.__mod('src/match/peerPort.js');
    return { ...peerAvailability(), caps: window.Arcade.peer.caps() };
  });
  check('joiner A: the launcher satisfies every required capability',
    availability.available && availability.missing.length === 0,
    availability.missing.length ? `missing ${availability.missing.join(', ')}` : availability.caps.join(','));

  /* --- 5. The frame really is the running game -------------------- */

  // If dynamic import handed back a SECOND copy of the module graph, every
  // assertion in every scenario below would be inspecting a table nobody is
  // looking at. Cheap to prove, and catastrophic to assume.
  const sameInstance = await frames.H.evaluate(async () => {
    const table = await window.__mod('src/ui/table.js');
    const again = await window.__mod('./src/ui/table.js');
    return table === again && typeof table.isTableOpen === 'function';
  });
  check('the game modules a scenario drives are the ones the game is running', sameInstance);

  /* --- 6. The checklist ------------------------------------------- */

  const { SCENARIOS } = await import('./mp-scenarios.mjs');
  const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
  for (const [index, scenario] of SCENARIOS.entries()) {
    if (only && String(index + 1) !== only) continue;
    console.log(`\n--- ${index + 1}. ${scenario.title}`);
    await scenario.run({ harness, check, waitFor, pages: { H, A, B }, frames, devices });
  }

  exitCode = failed() ? 1 : 0;
  console.log(`\n${failed() ? `${failed()} check(s) failed` : 'all checks passed'}`);
} catch (err) {
  console.error('\nmp-acceptance: the run itself failed\n', err);
} finally {
  await harness.shutdown();
  // Always, even on a throw: a leaked background server holds the port and
  // makes the NEXT run fail for a reason that has nothing to do with the game.
  try { devSh('stop'); } catch { /* already gone */ }
  fs.rmSync(outDir, { recursive: true, force: true });
}

process.exit(exitCode);
