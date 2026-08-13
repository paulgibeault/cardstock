#!/usr/bin/env node
// TWO PAIRED LAUNCHERS, ON SCREEN, FOR A HUMAN TO PLAY WITH.
//
// tools/mp-acceptance.mjs answers "does it work" and answers it headlessly. This
// answers "does it FEEL right", which no assertion has an opinion about, and it
// exists because the one thing standing between a developer and that question is
// twenty minutes of ceremony.
//
// THE PAIRING IS THE PART THAT IS AUTOMATED, and only that part. Play Together
// is human-mediated on purpose (p2p/PROTOCOL.md §4): one device shows a code,
// a person carries it to the other by camera or chat, and the second answers.
// That is the right design and a miserable thing to do forty times in an
// afternoon while you are actually trying to look at a seat grid. So this drives
// the same exchange at the transport level — `createOffer` → `createAnswer` →
// `acceptAnswer`, exactly what the dialog does with a human in the middle — and
// then gets out of the way. Everything after the handshake is yours.
//
// TWO BROWSER CONTEXTS, NOT TWO TABS. A context has its own localStorage and
// IndexedDB, so the two windows have genuinely different device ids and identity
// certificates, the way two phones do. Two tabs on one profile share an identity
// and would quietly prove nothing: every authority check in src/match/ is a
// comparison against `peer.self()`.
//
// The windows are named for you — "Host laptop" and "Joiner phone" — because
// with two default profiles both seats read "My device" and the seat grid
// becomes a puzzle.
//
// Usage:  node tools/mp-play.mjs            (host + one joiner)
//         node tools/mp-play.mjs --joiners=2 (host + two, the star topology)
//
// It serves through the launcher's dev.sh, so it takes over port 4791 — and it
// leaves the server RUNNING when you quit, because you are probably about to
// edit something and reload. Ctrl-C closes the browser; `./dev.sh stop` in the
// launcher checkout stops the server.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './stage.mjs';

const LAUNCHER = process.env.ARCADE_LAUNCHER || path.resolve(ROOT, '..', 'paulgibeault.github.io');
const PORT = Number(process.env.ARCADE_PORT || 4791);
const BASE = `http://127.0.0.1:${PORT}`;
const GAME_ID = 'cardstock';

const joinerCount = Number(process.argv.find((a) => a.startsWith('--joiners='))?.split('=')[1] || 1);

if (!fs.existsSync(path.join(LAUNCHER, 'dev.sh'))) {
  console.error(`mp-play: no launcher checkout at ${LAUNCHER}`);
  process.exit(1);
}

// Playwright is the launcher's dependency, not ours — same as mp-acceptance.
const { chromium } = await import(
  pathToFileURL(path.join(LAUNCHER, 'node_modules', 'playwright', 'index.mjs')).href);

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

async function serving() {
  try {
    const response = await fetch(`${BASE}/index.html`);
    await response.arrayBuffer(); // drained: an unconsumed body wedges undici
    return response.ok;
  } catch { return false; }
}

// THE CHECKOUT, not a staged artifact. mp-acceptance stages because only an
// artifact can catch a staging rule that drops a file; this is for editing, and
// serving the checkout means a re-run of dev.sh picks up your last save.
if (await serving()) {
  console.log(`using the dev server already on ${BASE}`);
} else {
  console.log(`starting dev.sh on ${BASE}…`);
  execFileSync(path.join(LAUNCHER, 'dev.sh'), [ROOT], { cwd: LAUNCHER, stdio: 'inherit' });
}

/* ------------------------------------------------------------------ *
 * Two devices
 * ------------------------------------------------------------------ */

// Loopback host candidates only: no STUN round trip, and no traffic that leaves
// this machine to set up a call between two windows on it.
const FORCE_LOCAL_ICE = `
  const OrigRTC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends OrigRTC {
    constructor(cfg = {}) { super({ ...cfg, iceServers: [] }); }
  };
`;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--window-size=1100,900'],
});

async function device(label, deviceName) {
  const context = await browser.newContext({ viewport: null });
  // Written BEFORE the launcher boots, so it never mints a default name — this
  // is the string that ends up on the wire and in the other window's seat grid.
  await context.addInitScript(`
    ${FORCE_LOCAL_ICE}
    try { localStorage.setItem('arcade.v1._meta.deviceName', ${JSON.stringify(deviceName)}); } catch (e) {}
  `);
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`  [${label}]`, err.message));
  await page.goto(`${BASE}/`);
  await page.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');

  // The transport only initialises when a person asks for it — through the
  // Multiplayer menu, then "New connection". Same two clicks, made for you.
  await page.evaluate(() => document.getElementById('menu-multiplayer').click());
  await page.evaluate(() => document.getElementById('connections-dialog-new').click());
  await page.waitForFunction('!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 20000 });
  await page.evaluate(() => {
    const overlay = document.getElementById('p2p-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    if (window.__arcade.closeConnectionsDialog) window.__arcade.closeConnectionsDialog();
  });
  return page;
}

/**
 * The ceremony, with the human step taken out of the middle.
 *
 * This is the QR code and the reply, moved from a camera to a variable. Each
 * host-side `createOffer` mints a fresh link, so calling it twice is the same
 * as tapping Host twice for a second standalone connection — which is exactly
 * how the star topology gets built.
 */
async function pair(hostPage, joinerPage) {
  const offer = await hostPage.evaluate(async () => {
    const { ConnectionUtils } = await import('./p2p/p2p-core.js');
    const addon = window.__arcade.p2p._addon();
    return ConnectionUtils.encodePayload(await addon.peerNode.createOffer());
  });
  const answer = await joinerPage.evaluate(async (packed) => {
    const { ConnectionUtils } = await import('./p2p/p2p-core.js');
    const addon = window.__arcade.p2p._addon();
    return ConnectionUtils.encodePayload(await addon.peerNode.createAnswer(await ConnectionUtils.decodePayload(packed)));
  }, offer);
  await hostPage.evaluate(async (packed) => {
    const { ConnectionUtils } = await import('./p2p/p2p-core.js');
    await window.__arcade.p2p._addon().peerNode.acceptAnswer(await ConnectionUtils.decodePayload(packed));
  }, answer);
  await joinerPage.waitForFunction("window.__arcade.p2p.status() === 'connected'", null, { timeout: 30000 });
}

const host = await device('host', 'Host laptop');
const joiners = [];
for (let i = 0; i < joinerCount; i++) {
  joiners.push(await device(`joiner ${i + 1}`, joinerCount > 1 ? `Joiner phone ${i + 1}` : 'Joiner phone'));
}
for (const joiner of joiners) await pair(host, joiner);

for (const page of [host, ...joiners]) {
  await page.evaluate((id) => window.__arcade.showGame(id, `${id}/index.html`, 'Cardstock'), GAME_ID);
}

console.log(`
  ${joiners.length + 1} launchers are up and paired, with Cardstock mounted in each.

  HOST WINDOW ("Host laptop")
    1. Every game tile now carries "Play together". Tap it on the game you
       want: that opens a party for it WITHOUT dealing anything.
    2. The panel is the table being built — "Open" frees a bot seat so
       somebody can take it.
    3. When everybody is in, tap "Deal". The cards come out once, for all of
       you, and the felt opens on every device at the same moment.

  JOINER WINDOW${joiners.length > 1 ? 'S' : ''} ("Joiner phone")
    4. Being invited is joining: the pack loads and the seats go live on their
       own. Tap "Join the table" in the lobby header, then take a chair.
    5. Turn up AFTER the deal and you can still take a bot's seat — you
       inherit its hand, and the host stops playing it.

  WORTH POKING AT
    · Emotes are under the action bar once you are in a party.
    · Close the panel with Escape or a click outside it; closing is not
      leaving, and leaving is the button inside that says so.
    · Close a joiner window outright and the host should be offered
      bot-fill / wait / end.
    · The launcher may ask you to name the connection and offer auto-reconnect.
      Both are the real flow — answer them however you like.

  Ctrl-C closes the browser. The dev server keeps running, so edit and reload
  freely; re-run ./dev.sh in the launcher checkout to restage.
`);

// Nothing left to drive: hold the process open so the windows stay up.
await new Promise((resolve) => {
  process.on('SIGINT', resolve);
  browser.on('disconnected', resolve);
});
await browser.close().catch(() => {});
