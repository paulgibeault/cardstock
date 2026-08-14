// Boot, the launcher integration, and a two-screen router.
//
// Everything launcher-shaped goes through two doors: `src/arcade/storage.js`
// for persistence, and the `Arcade.*` calls below for lifecycle, settings and
// chrome. Standalone is first-class — nothing here gates gameplay on
// `Arcade.context.framed` (GAME_INTEGRATION §8); the SDK loads and works at
// the plain GitHub Pages URL too, with storage going straight to localStorage.
//
// The screens are LOBBY and TABLE, swapped in one document. No URL routing:
// launcher deep links are `#app=cardstock` and cannot carry a query, so there
// is nothing to deep-link to and nothing for a history entry to mean. The one
// exception is `?pack=`, which still lands straight on a table — it is how the
// dev server, the §13 acceptance run, and hand-shared links open a game.
//
// ONE FELT, BUT NO LONGER ONE MATCH. Entering a table binds the felt to it and
// leaving unbinds; the match itself belongs to a TableSession
// (src/match/tableSession.js) and outlives both. A hosted table nobody is
// looking at keeps arbitrating and keeps playing its bots — which is the whole
// of #43, and the reason `goToLobby` below no longer stops hosting.

import { registerStorageErrorHandler, packOverride } from './arcade/storage.js';
import {
  initTable, openTable, closeTable, flushTable, rerenderTable, isTableOpen, reportTableError,
} from './ui/table.js';
import {
  initLobby, renderLobby, showLobby, hideLobby, reportLobbyError,
} from './ui/lobby.js';
import {
  initParty, refreshEntry as refreshPartyEntry, hidePartyScreen, hostGame, canHost, leaveFelt,
} from './ui/party.js';
import { initInspector, hideInspector } from './ui/inspector.js';

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

async function goToLobby() {
  // LEAVING THE TABLE NO LONGER ENDS THE PARTY. It used to have to: the felt
  // owned the engine state, so closing it dropped the match, and a host still
  // publishing a lobby for a match that no longer existed was a table nobody
  // could join. The session inversion (#48) moved the state into the session,
  // so the match survives the felt and the honest thing to do on the way out is
  // stop LOOKING at it — which is what `leaveFelt` means. Bots at a table
  // nobody is watching keep playing; ending it is the "Stop hosting" button,
  // which says so.
  leaveFelt();
  closeTable();
  hideInspector();
  hidePartyScreen();
  document.getElementById('table-screen').hidden = true;
  Arcade.ui.setTitle('Cardstock');
  showLobby();
  // Asked again on every arrival rather than remembered: a party can be formed
  // while the player is sitting on this screen, and a door drawn once at boot
  // is a door that never opens (src/match/peerPort.js).
  refreshPartyEntry();
  try {
    await renderLobby();
  } catch (err) {
    console.error(err);
    reportLobbyError('Could not load the game list. Check your connection and reload.');
  }
}

async function goToTable(packId, setup) {
  hideLobby();
  hideInspector();
  hidePartyScreen();
  document.getElementById('table-screen').hidden = false;
  try {
    // `setup` is the new-game sheet's answer (variants + seat count), absent
    // for a resume or a deep link — openTable treats a stored match as
    // authoritative over it either way.
    await openTable(packId, setup);
    refreshPartyEntry();
  } catch (err) {
    console.error(err);
    reportTableError(`Could not start that game: ${err.message}`);
    Arcade.ui.toast('Could not start the game.', { kind: 'error', duration: 4000 });
  }
}

/**
 * The joiner's door onto the felt.
 *
 * `goToTable` opens a pack by id and deals or resumes; a joiner does neither.
 * Its table already exists on somebody else's device and arrived as a view, so
 * all this has to do is put the right screen in front of it.
 */
function showSharedTable() {
  hideLobby();
  hideInspector();
  hidePartyScreen();
  document.getElementById('table-screen').hidden = false;
}

/**
 * Where a boot — or a save import — lands.
 *
 * `onStateReplaced` runs this too: §3 says treat a save import as a fresh
 * boot, and the imported save may hold a different set of matches, or none.
 * Going back through the front door is the honest reading of that, and it
 * means the player sees what the imported save actually contains rather than
 * whatever happened to be on screen.
 */
async function route() {
  const deepLink = packOverride(location.search);
  if (deepLink) await goToTable(deepLink);
  else await goToLobby();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function wireLauncherHooks() {
  registerStorageErrorHandler();

  // §6b: the launcher holds teardown ~250 ms for a SYNCHRONOUS flush. Do not
  // start async work here expecting it to finish.
  Arcade.onSuspend(() => flushTable());
  Arcade.onResume(() => { if (isTableOpen()) rerenderTable(); });

  Arcade.onStateReplaced(() => {
    closeTable();
    route().catch(reportBootFailure);
  });

  // Theme, font scale, handedness and reduced motion are applied to <html> by
  // the SDK and handled in CSS (src/ui/table.css). Re-render anyway: the deal
  // stagger and the card-travel animation are JS-driven, so reducedMotion has
  // to reach a render to take hold.
  Arcade.onSettingsChange(() => {
    if (isTableOpen()) rerenderTable();
  });
}

// Written to BOTH screens: at boot there is no telling which one is up, and a
// failure message on the hidden one is a failure message nobody sees.
function reportBootFailure(err) {
  console.error(err);
  reportTableError(`Failed to start: ${err.message}`);
  reportLobbyError(`Failed to start: ${err.message}`);
  Arcade.ui.toast('Could not start the game.', { kind: 'error', duration: 4000 });
}

async function boot() {
  // §2: nothing may read state before this resolves. Framed, a pre-ready read
  // returns empty because the launcher's snapshot has not arrived yet.
  await Arcade.ready;

  wireLauncherHooks();
  // The one floating panel every card and pile shares, plus its global
  // dismissals (scroll, resize, Escape). Created once — see src/ui/inspector.js.
  initInspector();
  initTable({ onExit: () => { goToLobby().catch(reportBootFailure); } });
  initLobby({
    onOpenTable: (packId, setup) => { goToTable(packId, setup).catch(reportBootFailure); },
    // The party door lives on each game tile: choosing the game is the first
    // decision, and this is where games are chosen.
    onHostParty: (packId) => { hostGame(packId).catch(reportBootFailure); },
    canHost,
  });
  // A JOINER OPENS THE TABLE WITHOUT A PACK ID: it is handed a view, not asked
  // for a game, so it goes through showSharedTable rather than goToTable.
  initParty({
    onShowTable: () => showSharedTable(),
    onShowLobby: () => { goToLobby().catch(reportBootFailure); },
  });

  await route();
}

boot().catch(reportBootFailure);
