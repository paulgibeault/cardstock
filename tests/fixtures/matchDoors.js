// THE DOORS, STOOD UP WITHOUT A SCREEN.
//
// src/ui/matchDoors.js was carved out of src/ui/table.js (#223, seam 4) so a
// Node test could open, resume, deal and close a match and watch what each door
// does. This is the table.js half of that, as small as it can be: the session,
// epoch and joiner slots with their setters, a spy for every door the doors
// reach back through, and packs served from disk instead of over the network.
//
// Every spy writes its NAME into one ordered `calls` list, because the order is
// most of what a door is — a session born before the old one's timers stopped,
// or a save written before the render, is a door with the right parts in the
// wrong order.

import { createMatchDoors } from "../../src/ui/matchDoors.js";
import { createTableSession } from "../../src/match/tableSession.js";
import { persistTable } from "../../src/arcade/persist.js";
import { loadPackFromDiskSync } from "../../tools/lib/packs.mjs";
import { installArcade } from "./arcade.js";

/**
 * A HOSTED TABLE, the shape src/ui/party.js hands the two hosted doors (#225):
 * the party's TableSession with its seats and seating already on it, and — for
 * the way back — the state it has been holding.
 */
export function hostTable(packId, { tableId = "t1a1a1a1a1a1a1a1a1a", variants = [], state = null, seats, seating }) {
  const table = createTableSession({ tableId, packId, role: "host", variants });
  table.seats = seats;
  table.seating = seating;
  table.state = state;
  return table;
}

/**
 * A JOINER'S TABLE: the loaded pack and the client, as src/ui/party.js's
 * `joinTable` builds one before its first view arrives.
 */
export function joinerTable(pack, { tableId = "t2b2b2b2b2b2b2b2b2b", client = null } = {}) {
  const table = createTableSession({ tableId, packId: pack.id, role: "joiner" });
  table.pack = pack;
  if (client) table.attach({ client });
  return table;
}

/**
 * A fetch the test decides when to land. `fetchPack` resolves on the next
 * microtask unless `hold()` was called first, in which case it waits for
 * `release()` — the gap in which the player can leave for the lobby.
 */
function packServer() {
  const held = [];
  let holding = false;
  const requests = [];
  async function fetchPack(packId, variants) {
    requests.push({ packId, variants });
    if (holding) await new Promise((resolve) => held.push(resolve));
    return loadPackFromDiskSync(packId, variants);
  }
  return {
    fetchPack,
    requests,
    hold() { holding = true; },
    release() { holding = false; for (const r of held.splice(0)) r(); },
  };
}

/**
 * @param persist  true to hand the doors table.js's REAL save — src/arcade/
 *                 persist.js's `persistTable` of the table on the felt, which is
 *                 all table.js's `persistMatch`/`flushTable` are since #225 —
 *                 instead of a spy. Either way the call is logged by name.
 */
export function doorsHarness({ persist = false } = {}) {
  // `stats` too: ending a match writes the record, and a test that walks a match
  // out through the round summary (tests/persist.test.js) reaches it.
  const arcade = installArcade({ state: true, session: true, stats: true });
  const titles = [];
  arcade.arcade.ui = { setTitle: (t) => titles.push(t) };

  const slots = { session: null, epoch: 0, sharedTable: null };
  const calls = [];
  const rendered = [];
  const celebrated = [];
  const errors = [];
  const spy = (name) => () => { calls.push(name); };
  const server = packServer();

  const doors = createMatchDoors({
    el: { statusText: { textContent: "" } },
    session: () => slots.session,
    setSession: (next) => { calls.push(next ? "setSession" : "setSession(null)"); slots.session = next; },
    bumpEpoch: () => { calls.push("bumpEpoch"); slots.epoch += 1; },
    sharedTable: () => slots.sharedTable,
    setSharedTable: (client) => { slots.sharedTable = client; },
    drag: () => ({ cancel: spy("drag.cancel") }),
    ladder: () => ({ hide: spy("ladder.hide") }),
    contractStrip: () => ({ hide: spy("contractStrip.hide") }),
    roundEnding: { forgetPreMove: spy("forgetPreMove") },
    fetchPack: server.fetchPack,
    render: (state, message) => { calls.push("render"); rendered.push({ state, message }); },
    liveState: () => (slots.session ? slots.session.table.state : null),
    feltState: () => (slots.session ? slots.session.table.state : null),
    humanName: () => "You",
    celebrateDeal: (state) => { calls.push("celebrateDeal"); celebrated.push(state); },
    persistMatch: persist
      ? () => { calls.push("persistMatch"); if (slots.session) persistTable(slots.session.table); }
      : spy("persistMatch"),
    flushTable: persist
      ? () => { calls.push("flushTable"); if (slots.session) persistTable(slots.session.table); }
      : spy("flushTable"),
    scheduleNextTurn: spy("scheduleNextTurn"),
    scheduleAnnouncementBeats: spy("scheduleAnnouncementBeats"),
    cancelBotTurn: spy("cancelBotTurn"),
    cancelAnnouncementBeats: spy("cancelAnnouncementBeats"),
    hideBanner: spy("hideBanner"),
    setHelpOpen: (open) => { calls.push(`setHelpOpen(${open})`); },
    reportTableError: (message) => { calls.push("reportTableError"); errors.push(message); },
    hideAllPanels: spy("hideAllPanels"),
    closeChoiceDialog: spy("closeChoiceDialog"),
    closeConfirm: spy("closeConfirm"),
  });

  return {
    doors, slots, calls, rendered, celebrated, errors, titles, server,
    store: arcade.store,
    /** Forget what the doors did so far; the slots are left as they are. */
    reset() { calls.length = 0; rendered.length = 0; celebrated.length = 0; errors.length = 0; titles.length = 0; },
  };
}
