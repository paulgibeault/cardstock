// The lobby: the front door, and the only screen that knows every pack.
//
// Drawn from MANIFESTS ALONE — five small JSON files, no decks, no pack
// loading, no match replay. That is a deliberate cost ceiling: opening the
// lobby must not get slower as packs ship or as saved games pile up. The
// in-progress ribbons come from storage.listMatchSummaries(), which reads and
// shape-checks the stored logs without replaying them.
//
// Each tile is one physical object on the felt: a mat in the pack's own
// accent, a fan of three of its faces, and — when a game is waiting — the
// ribbon that says so. The fan is drawn by the same renderer the table uses
// (src/ui/cardStyles), so a pack looks like itself here with no art to
// commission and no third-party asset in the repo.

import { makeCardRenderer } from './cardStyles/index.js';
import { fetchPackIndex, fetchPackManifest, fetchPack } from './packSource.js';
import { safeAccent } from './css.js';
import { listMatchSummaries, readStats, lastPlayedPack, clearMatch, recordForfeit, loadSettings, saveSettings, dailyStatus } from '../arcade/storage.js';
import { buildSeating } from '../players/roster.js';
import { confirmAction, closeConfirm } from './confirm.js';
import { showRules } from './panels.js';
import { packRules } from './rules.js';
import { askNewGame, hasChoices, closeNewGame } from './newGame.js';
import { speedLevel } from './speed.js';
import { templateInfo } from '../templates/registry.js';
import { line } from './dom.js';

const el = {
  screen: document.getElementById('lobby'),
  grid: document.getElementById('lobby-grid'),
  note: document.getElementById('lobby-note'),
};

const DEFAULT_ACCENT = '#3d7a5a';

let openTable = () => {};   // (packId, setup?) — set by initLobby
// What this pack's PARTY situation is, and the door into it. Both set by
// initLobby; both no-ops before src/ui/party.js has wired itself up.
let partyStateFor = () => null;
let enterParty = () => false;
// Set by initLobby too. The lobby does not import src/ui/party.js: party.js
// already imports the table, and the lobby's whole cost ceiling is that opening
// it stays cheap (manifests only, no pack loading, no protocol).
let canHostParty = () => false;
let hostParty = () => {};

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "2h ago" — coarse on purpose. The player is deciding which game to go back
 * to, and to-the-minute precision on a solo card game is noise that also makes
 * the grid look busier than it is.
 */
function relativeTime(savedAt) {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  const delta = Date.now() - savedAt;
  if (delta < 0) return 'just now';           // a clock that moved backwards
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 2 * DAY) return 'yesterday';
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  return 'a while ago';
}

function ribbonText(summary) {
  const when = relativeTime(summary.savedAt);
  const moves = `${summary.moves} ${summary.moves === 1 ? 'move' : 'moves'}`;
  return when ? `In progress · ${moves} · ${when}` : `In progress · ${moves}`;
}

/* ------------------------------------------------------------------ *
 * The daily run
 * ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 10" — the date on the control, short enough to sit beside the label. */
function shortDate(dateStr) {
  const [, month, day] = String(dateStr).split('-');
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${Number(day)}` : String(dateStr);
}

/** What today's run has come to, in the one line the tile has room for. */
function dailyStateText(status) {
  const streak = status.streak > 1 ? ` · ${status.streak}-day streak` : '';
  if (status.finished) {
    const how = status.hands > 0
      ? ` in ${status.hands} ${status.hands === 1 ? 'hand' : 'hands'}` : '';
    return `${shortDate(status.date)} · ${status.won ? `won${how}` : 'lost'}${streak}`;
  }
  if (status.inProgress) {
    const moves = status.inProgress.moves;
    return `${shortDate(status.date)} · ${moves} ${moves === 1 ? 'move' : 'moves'} in${streak}`;
  }
  return `${shortDate(status.date)}${streak}`;
}

/**
 * The line a player copies out: "Milestones daily 2026-09-10 — won in 7 hands".
 *
 * PLAIN TEXT, AND NO CODE. `shareEncode` exists for a payload somebody else has
 * to decode — a puzzle to hand over, a table to join — and there is nothing here
 * to decode: the date IS the whole of the state, and whoever reads this line can
 * open their own daily and get the same ten contracts. A base64 blob after the
 * sentence would be noise the reader has no use for.
 */
function dailyShareLine(manifestName, status) {
  const how = status.won
    ? (status.hands > 0 ? `won in ${status.hands} ${status.hands === 1 ? 'hand' : 'hands'}` : 'won')
    : 'lost';
  const streak = status.streak > 1 ? ` · ${status.streak}-day streak` : '';
  return `${manifestName} daily ${status.date} — ${how}${streak}`;
}

/**
 * Copy `text`, through the async clipboard when the browser has one and through
 * a throwaway textarea when it does not.
 *
 * The fallback is not superstition: `navigator.clipboard` is absent on an
 * insecure origin, which is exactly how this game is served on a phone pointed
 * at a laptop's dev server, and it rejects when the document is not focused.
 */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the old way
  }
  try {
    const pad = document.createElement('textarea');
    pad.value = text;
    pad.setAttribute('readonly', '');
    pad.style.position = 'fixed';
    pad.style.opacity = '0';
    document.body.appendChild(pad);
    pad.select();
    const ok = document.execCommand('copy');
    pad.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * The daily-run control, for a pack whose manifest declares `daily: true`.
 *
 * GATED BY THE MANIFEST so the lobby stays pack-agnostic: it knows there is
 * such a thing as a daily run and nothing whatsoever about ladders, seeds or
 * contracts. A finished day is a STATEMENT rather than a dead button — there is
 * no second attempt, so offering something to press would be offering a door
 * that does not open.
 */
function buildDailyControl(manifest) {
  const status = dailyStatus(manifest.id);
  if (!status) return [];
  const state = dailyStateText(status);

  if (!status.finished) {
    const open = document.createElement('button');
    open.className = 'tile__daily';
    open.type = 'button';
    open.appendChild(line('tile__daily-label', status.inProgress ? 'Back to today\'s run' : 'Daily run'));
    open.appendChild(line('tile__daily-state', state));
    open.setAttribute('aria-label', status.inProgress
      ? `Back to today's ${manifest.name} daily run, ${state}`
      : `Play today's ${manifest.name} daily run, ${state}`);
    open.addEventListener('click', () => openTable(manifest.id, { daily: true }));
    return [open];
  }

  const done = document.createElement('div');
  done.className = 'tile__daily tile__daily--done';
  done.appendChild(line('tile__daily-label', 'Today\'s run'));
  done.appendChild(line('tile__daily-state', state));

  const share = document.createElement('button');
  share.className = 'tile__daily-share';
  share.type = 'button';
  share.textContent = 'Copy result';
  share.setAttribute('aria-label', `Copy your ${manifest.name} daily result`);
  share.addEventListener('click', async () => {
    const ok = await copyToClipboard(dailyShareLine(manifest.name, status));
    Arcade.ui.toast(ok ? 'Result copied.' : 'Could not copy the result.',
      { kind: ok ? 'info' : 'error', duration: 2500 });
  });
  return [done, share];
}

function recordText(packId) {
  const record = readStats(packId);
  if (!record.played) return 'Not played yet';
  const streak = record.streak > 1 ? ` · ${record.streak} in a row` : '';
  return `Won ${record.won} of ${record.played}${streak}`;
}

/* ------------------------------------------------------------------ *
 * Tiles
 * ------------------------------------------------------------------ */

function heroFan(manifest) {
  const fan = document.createElement('span');
  fan.className = 'tile__fan';
  // Decorative: the tile's accessible name already says which game this is,
  // and three card names read out before it would bury that.
  fan.setAttribute('aria-hidden', 'true');
  // Manifest only — no deck. The lobby's whole cost ceiling is that it never
  // loads one (see the header), so a pack whose art needs its real colours
  // declares them as `ui.cardPalette`, which is read on this path too.
  const renderer = makeCardRenderer(manifest);
  const faces = Array.isArray(manifest.heroCards) ? manifest.heroCards.slice(0, 3) : [];
  faces.forEach((face, i) => {
    const card = document.createElement('span');
    card.className = 'tile__fan-card';
    // The card styles escape every card-derived value they emit; this is markup
    // this repo authors, unlike anything carrying a name (§7b).
    card.innerHTML = renderer.face(face);
    card.style.setProperty('--fan-index', String(i - 1));
    fan.appendChild(card);
  });
  return fan;
}

function buildTile(manifest, summary, { featured }) {
  // Manifest string in, presentation facts out — src/templates/registry.js
  // imports nothing, so the lobby still loads no template and no engine.
  const genre = templateInfo(manifest.template);
  const preview = !genre.playable;
  const tile = document.createElement('div');
  tile.className = `tile ${summary ? 'tile--in-progress' : ''} ${featured ? 'tile--featured' : ''} ${preview ? 'tile--preview' : ''}`;
  // Named so src/ui/party.js can find this tile when a party forms on it. The
  // lobby does not know about parties and should not have to: it publishes an
  // anchor and a slot, and something else fills them in.
  tile.dataset.packId = manifest.id;

  // A LIVE PARTY, said where "in progress" is already said. The ribbon above
  // means "you have a saved game here"; this means "somebody is playing this
  // one right now, and there is a chair". Empty and hidden until there is.
  const party = document.createElement('span');
  party.className = 'tile__party';
  party.hidden = true;
  tile.appendChild(party);
  // §7b: a manifest value reaching an inline style. safeAccent takes a
  // six-digit hex and nothing else — no url(), no var(), no stray semicolon.
  tile.style.setProperty('--tile-accent', safeAccent(manifest.accent, DEFAULT_ACCENT));

  const open = document.createElement('button');
  open.className = 'tile__open';
  open.type = 'button';
  // The whole tile is one target, and its accessible name carries the state —
  // a sighted player reads the ribbon, everyone else needs it in the label.
  const previewNote = preview ? ' Preview: not yet playable to the end.' : '';
  open.setAttribute('aria-label', summary
    ? `${manifest.name} — game in progress, ${summary.moves} moves. Resume.${previewNote}`
    : `${manifest.name} — deal a new game.${previewNote}`);

  if (summary) open.appendChild(line('tile__ribbon', ribbonText(summary)));
  open.appendChild(heroFan(manifest));
  open.appendChild(line('tile__name', manifest.name));

  const genreNode = document.createElement('span');
  genreNode.className = 'tile__genre';
  genreNode.appendChild(line('', genre.genreLabel));
  // Said here rather than left for the player to discover at the table. A
  // preview pack deals and displays but has no controls for its genre's own
  // moves yet — see `playable` in src/templates/registry.js.
  if (preview) genreNode.appendChild(line('tile__badge', 'Preview'));
  open.appendChild(genreNode);

  open.appendChild(line('tile__tagline', manifest.tagline || ''));

  // THE PARTY WINS THE HEADLINE. A table with other people at it and a clock
  // running is what "what is happening in this game" means; a solo save is
  // still reachable below, demoted rather than hidden.
  const atTable = partyStateFor(manifest.id);

  const foot = document.createElement('span');
  foot.className = 'tile__foot';
  foot.appendChild(line('tile__record', atTable ? partyRecordText(atTable) : recordText(manifest.id)));
  foot.appendChild(line('tile__cta', atTable
    ? (atTable.kind === 'hosting' ? 'Back to the table' : 'Back to your seat')
    : (summary ? 'Resume' : (preview ? 'Take a look' : 'Deal me in'))));
  open.appendChild(foot);

  // A game already in progress is resumed under the rules it was dealt with —
  // there is nothing to ask, and asking would imply the answer could change
  // something it cannot. Only a NEW game gets the sheet, and only when the
  // pack actually offers a choice.
  open.addEventListener('click', async () => {
    // Into the party table, not into a private copy of it.
    if (atTable && enterParty(atTable.tableId)) return;
    if (summary || !hasChoices(manifest)) {
      openTable(manifest.id);
      return;
    }
    const setup = await askNewGame(manifest);
    if (!setup) return;
    rememberPreferences(setup);
    openTable(manifest.id, setup);
  });
  tile.appendChild(open);

  // TODAY'S RUN, for a pack that declares one. Above "How to play" because on
  // the packs that have it, it is the second reason somebody opened the lobby —
  // and it is its own door rather than an option on the new-game sheet: the
  // whole offer is that there is nothing to choose.
  if (manifest.daily && genre.playable) {
    for (const node of buildDailyControl(manifest)) tile.appendChild(node);
  }

  // "How to play" before you commit to a game, which is when the question is
  // actually asked. The pack is loaded on demand — the lobby holds manifests
  // only, and the rules page needs the deck to say what the action cards do.
  const how = document.createElement('button');
  how.className = 'tile__rules';
  how.type = 'button';
  how.textContent = 'How to play';
  how.setAttribute('aria-label', `How to play ${manifest.name}`);
  how.addEventListener('click', async () => {
    try {
      showRules(packRules(await fetchPack(manifest.id)));
    } catch {
      // A pack whose deck will not load cannot be played either; the tile's
      // own error state is the honest place for that, not a half-empty panel.
    }
  });
  tile.appendChild(how);

  // THE PARTY DOOR, ON THE GAME. Hosting used to start from the felt — you
  // dealt a solo hand and then invited people into it, which meant a joiner's
  // only way in was to take a seat off a bot that was already holding cards.
  // Choosing the game is the first decision either way, and this is where games
  // are chosen, so the table is now built here and dealt once everybody is in.
  //
  // Hidden unless a party exists AND the launcher can carry the frames — the
  // gate is asked at click time too, because a party can form while this
  // screen is open (src/match/peerPort.js).
  const together = document.createElement('button');
  together.className = 'tile__together';
  together.type = 'button';
  together.textContent = 'Play together';
  together.hidden = !canHostParty();
  together.setAttribute('aria-label', `Play ${manifest.name} with your party`);
  together.addEventListener('click', () => hostParty(manifest.id));
  tile.appendChild(together);

  // A separate hit target rather than a long-press: long-press is
  // undiscoverable, and on iOS Safari it fights the OS text-selection gesture.
  // BOTH AT ONCE IS A REAL CASE: an old solo Hearts save and a Hearts table you
  // are sitting at. The table takes the tile's face; the solo game keeps a door
  // of its own rather than becoming unreachable.
  if (atTable && summary) {
    const solo = document.createElement('button');
    solo.className = 'tile__solo';
    solo.type = 'button';
    solo.textContent = 'Your solo game';
    solo.setAttribute('aria-label', `Open your solo ${manifest.name} game`);
    solo.addEventListener('click', () => openTable(manifest.id));
    tile.appendChild(solo);
  }

  // NOT WHILE A PARTY TABLE EXISTS FOR THIS PACK. Two destructive controls on
  // one tile pointing at two different games is the confusion this whole change
  // is removing — and the one that surprised somebody was this one, dealing a
  // private hand beside a table other people were still playing at.
  if (summary && !atTable) {
    const restart = document.createElement('button');
    restart.className = 'tile__restart';
    restart.type = 'button';
    restart.textContent = 'Start over';
    restart.setAttribute('aria-label', `Abandon the game in progress in ${manifest.name} and deal a new one`);
    restart.addEventListener('click', async () => {
      // A dealt-but-unplayed game has nothing to lose, and telling someone
      // "0 moves will be lost" is a warning about nothing.
      const played = summary.moves > 0;
      const ok = await confirmAction(played
        ? `Abandon your ${manifest.name} game? ${summary.moves} ${summary.moves === 1 ? 'move' : 'moves'} will be lost, and it counts as a forfeit.`
        : `Re-deal ${manifest.name}? You'll get a new hand.`,
      { okLabel: played ? 'Abandon it' : 'Re-deal', cancelLabel: 'Keep playing' });
      if (!ok) return;
      // Walking away from a game with moves in it IS a forfeit, and it is
      // recorded exactly as the table's own Forfeit button records one — the
      // two doors out of a match must not disagree about what a loss is. A
      // dealt-but-untouched hand had no stakes, so it costs nothing.
      if (played) {
        recordForfeit(manifest.id, buildSeating(summary.seed, summary.seats, { humanSeat: 0 }));
      }
      clearMatch(manifest.id);
      // Re-dealing is a NEW game, so it gets the same choices a new game gets.
      const setup = hasChoices(manifest) ? await askNewGame(manifest) : {};
      if (!setup) { renderLobby(); return; }   // backed out after abandoning
      rememberPreferences(setup);
      openTable(manifest.id, setup);
    });
    tile.appendChild(restart);
  }

  return tile;
}

/**
 * Remember everything the new-game sheet asked that is a PREFERENCE rather
 * than part of the deal: how hard the bots play, how long the table waits
 * between hands (#150), and how fast a card crosses the felt (#175).
 *
 * RENAMED FROM `rememberDifficulty`, because it stopped being about difficulty
 * two issues ago and a function whose name lists one of the three things it
 * writes is a function the next row gets added outside of.
 *
 * WRITTEN HERE RATHER THAN IN THE SHEET, so that backing out of the sheet
 * changes nothing — the answers are only kept by the gesture that actually
 * deals. They are preferences and they outlive the match: the drivers read
 * them at fire time (src/ui/botDriver.js), so the next hand plays at whatever
 * was last chosen without anything having to be told.
 */
function rememberPreferences(setup) {
  const difficulty = setup?.difficulty;
  const pace = setup?.pace;
  const speed = setup?.speed;
  if (!difficulty && !pace && !speed) return;
  const settings = loadSettings();
  // THE SAME RULE, ONE ROW DOWN, TWICE OVER (#150, #175). How long the table
  // waits between hands and how fast a card crosses it are preferences exactly
  // like how hard the bots play: none of the three reaches the reducer, each is
  // read at the moment it matters, and backing out of the sheet must leave all
  // of them alone. So all three are written here, by the gesture that deals,
  // and nowhere else in this file. An older sheet that answers with only some
  // of them leaves the rest exactly as they were.
  //
  // THE SPEED ROW ANSWERS WITH A RUNG AND THE SETTING IS A NUMBER, which is the
  // one translation on this road: `botDelayMs` is arithmetic that two other
  // modules do (src/ui/flight.js, src/players/roster.js) and neither of them
  // should have to know the ladder exists. `speedLevel` is tolerant, so a rung
  // rolled back between builds writes the shipped default rather than NaN.
  const next = {
    ...settings,
    botDifficulty: difficulty || settings.botDifficulty,
    pace: pace || settings.pace,
    botDelayMs: speed ? speedLevel(speed).delayMs : settings.botDelayMs,
  };
  if (next.botDifficulty === settings.botDifficulty && next.pace === settings.pace
      && next.botDelayMs === settings.botDelayMs) return;
  saveSettings(next);
}

/** A pack whose manifest would not load still gets a tile, saying so. */
function buildBrokenTile(packId) {
  const tile = document.createElement('div');
  tile.className = 'tile tile--broken';
  tile.style.setProperty('--tile-accent', DEFAULT_ACCENT);
  tile.appendChild(line('tile__name', packId));
  tile.appendChild(line('tile__tagline', 'Could not load this game.'));
  return tile;
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

/**
 * Draw the grid from scratch. Called every time the lobby is shown, never
 * incrementally patched — the ribbons are relative times and the records
 * change under it, and a five-tile grid is not worth a diffing strategy.
 */
export async function renderLobby() {
  el.note.textContent = '';
  const packIds = await fetchPackIndex();

  // All five in parallel, each settling on its own: one unreachable manifest
  // costs its own tile, not the lobby.
  const manifests = await Promise.all(packIds.map((id) =>
    fetchPackManifest(id).then((m) => ({ id, manifest: m }), () => ({ id, manifest: null }))));

  const summaries = listMatchSummaries(packIds);

  // The last game played, if it is still in progress, leads — that is the "I
  // came back to keep playing" path, and it should be the biggest target on
  // screen. Everything else keeps the catalog order from packs/index.json:
  // a grid that reshuffles itself punishes muscle memory.
  const featured = lastPlayedPack();
  const ordered = summaries.has(featured)
    ? [...manifests].sort((a, b) => (b.id === featured) - (a.id === featured))
    : manifests;

  el.grid.replaceChildren();
  for (const { id, manifest } of ordered) {
    el.grid.appendChild(manifest
      ? buildTile(manifest, summaries.get(id) || null, { featured: id === featured && summaries.has(id) })
      : buildBrokenTile(id));
  }

  const waiting = summaries.size;
  el.note.textContent = waiting
    ? `${waiting} ${waiting === 1 ? 'game is' : 'games are'} waiting for you.`
    : 'Pick a game to start.';
}

export function showLobby() {
  el.screen.hidden = false;
}

/**
 * Leave the lobby, taking anything it opened with it.
 *
 * Both sheets are closed through their OWN modules rather than by poking their
 * elements from here: confirm.js and newGame.js each own a hidden flag and a
 * pending promise, and a screen change that hid the element without telling
 * them left an unresolved `askNewGame` behind — the next answer resolved a
 * dialog for a game the player had already left.
 */
export function hideLobby() {
  el.screen.hidden = true;
  closeConfirm();
  closeNewGame();
}

export function reportLobbyError(message) {
  el.grid.replaceChildren();
  el.note.textContent = message;
}


/** What a tile says about a table, in the place a solo record would go. */
function partyRecordText(party) {
  if (party.kind === 'hosting') {
    if (!party.seatsOpen) return 'At your table · table full';
    return `At your table · ${party.seatsOpen} ${party.seatsOpen === 1 ? 'seat' : 'seats'} open`;
  }
  return `Your seat at ${party.hostName}'s table`;
}


export function initLobby({ onOpenTable, onHostParty, canHost, partyState, onEnterParty }) {
  if (typeof canHost === 'function') canHostParty = canHost;
  if (typeof onHostParty === 'function') hostParty = onHostParty;
  if (typeof partyState === 'function') partyStateFor = partyState;
  if (typeof onEnterParty === 'function') enterParty = onEnterParty;
  openTable = onOpenTable;
}
