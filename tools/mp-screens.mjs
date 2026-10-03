// SCREENSHOTS OF THE HOSTING AND JOINING SHEETS, on the same three real devices
// as tools/mp-acceptance.mjs (#286). Not a test: a way to LOOK at every state a
// host and a guest pass through, after a design change, without three phones.
//
//   MP_SCREENS_DIR=/tmp/screens node tools/mp-acceptance.mjs --scenarios=./mp-screens.mjs

import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.MP_SCREENS_DIR || path.join(process.cwd(), 'mp-screens');

function party(frame, method, ...args) {
  return frame.evaluate(async ({ m, a }) => {
    const mod = await window.__mod('src/ui/party.js');
    return mod[m](...a);
  }, { m: method, a: args });
}

/**
 * A fresh ceremony leaves the LAUNCHER asking things (name this connection,
 * reconnect automatically) over the game. Answered no, so the game is visible.
 */
async function drainLauncherDialogs(page) {
  for (let i = 0; i < 6; i++) {
    const clicked = await page.evaluate(() => {
      const answers = /^(cancel|not now|no|skip|later|close)$/i;
      const button = [...document.querySelectorAll('button')]
        .find((b) => b.offsetParent && answers.test(b.textContent.trim()) && !b.closest('iframe'));
      if (!button) return false;
      button.click();
      return true;
    });
    if (!clicked) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function shoot(page, name) {
  fs.mkdirSync(DIR, { recursive: true });
  await new Promise((r) => setTimeout(r, 400));
  await drainLauncherDialogs(page);
  await page.screenshot({ path: path.join(DIR, `${name}.png`) });
  console.log(`  📷 ${name}`);
}

const screens = {
  title: 'hosting and joining, every sheet (screenshots)',
  async run({ waitFor, pages, frames }) {
    for (const page of Object.values(pages)) {
      await page.setViewportSize({ width: 430, height: 900 });
      await drainLauncherDialogs(page);
    }
    await shoot(pages.H, '01-host-lobby');

    const PACK = process.env.MP_SCREENS_PACK || 'thirteen';
    await party(frames.H, 'hostGame', PACK);
    await shoot(pages.H, '02-host-sheet-empty');

    const table = (await party(frames.H, 'partySnapshot')).tables.find((t) => t.packId === PACK);
    await waitFor(async () => {
      await party(frames.A, 'refreshEntry');
      return (await party(frames.A, 'partySnapshot')).tables.some((t) => t.key === table.key);
    }, 20000);
    await party(frames.A, 'hidePartyScreen');
    await shoot(pages.A, '03-guest-lobby-with-table');
    await party(frames.A, 'showPartyScreen', table.key);
    await shoot(pages.A, '04-guest-sheet');

    await frames.A.evaluate(() => document.querySelector('.party-seat__actions button, [data-sit]')?.click());
    await new Promise((r) => setTimeout(r, 1500));
    await shoot(pages.A, '05-guest-seated-waiting');
    await party(frames.H, 'showPartyScreen', table.key);
    await shoot(pages.H, '06-host-sheet-guest-seated');

    // Whatever the sheet offers for seat count, take one away (#284).
    await frames.H.evaluate(() => document.querySelector('[data-seats="less"]')?.click());
    await new Promise((r) => setTimeout(r, 800));
    await shoot(pages.H, '07-host-sheet-fewer-seats');
    await shoot(pages.A, '08-guest-sheet-fewer-seats');

    // THE ONE-TABLE QUESTION (#285), left open long enough to photograph.
    await frames.H.evaluate(async () => {
      const mod = await window.__mod('src/ui/party.js');
      window.__pendingHost = mod.hostGame('hearts');
    });
    await new Promise((r) => setTimeout(r, 800));
    await shoot(pages.H, '09-host-asked-to-close');
    await frames.H.evaluate(() => document.getElementById('confirm-cancel').click());

    // A SEAT AT A TABLE WHOSE HOST IS GONE, with its Forget.
    await frames.B.evaluate(() => {
      const now = Date.now();
      window.Arcade.state.set('mpSeats', [{
        tableId: 'tscreensdormant0001', hostDeviceId: 'dev-elsewhere', packId: 'hearts',
        seat: 2, hostName: 'Dana', savedAt: now, lastSeenAt: now,
      }]);
    });
    await party(frames.B, 'hidePartyScreen');
    await party(frames.B, 'refreshEntry');
    await shoot(pages.B, '10-guest-lobby-offline-tile');

    // AND THE SHEET IN THE DARK THEME.
    await frames.H.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await party(frames.H, 'showPartyScreen', table.key);
    await shoot(pages.H, '11-host-sheet-dark');
    await party(frames.H, 'hidePartyScreen');
    await shoot(pages.H, '12-host-lobby-dark');
  },
};

export const SCENARIOS = [screens];
