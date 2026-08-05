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
import { fetchPackIndex, fetchPackManifest } from './packSource.js';
import { safeAccent } from './css.js';
import { listMatchSummaries, readStats, lastPlayedPack, clearMatch, recordResult } from '../arcade/storage.js';
import { buildSeating } from '../players/roster.js';
import { confirmAction } from './confirm.js';
import { FULLY_PLAYABLE_TEMPLATES } from './table.js';

const el = {
  screen: document.getElementById('lobby'),
  grid: document.getElementById('lobby-grid'),
  note: document.getElementById('lobby-note'),
  confirmModal: document.getElementById('confirm-modal'),
};

const GENRE = {
  shedding: 'Shedding',
  'trick-taking': 'Trick-taking',
  'contract-rummy': 'Rummy',
  sequencing: 'Sequencing',
};

const DEFAULT_ACCENT = '#3d7a5a';

let openTable = () => {};

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

function line(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function buildTile(manifest, summary, { featured }) {
  const preview = !FULLY_PLAYABLE_TEMPLATES.has(manifest.template);
  const tile = document.createElement('div');
  tile.className = `tile ${summary ? 'tile--in-progress' : ''} ${featured ? 'tile--featured' : ''} ${preview ? 'tile--preview' : ''}`;
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

  const genre = document.createElement('span');
  genre.className = 'tile__genre';
  genre.appendChild(line('', GENRE[manifest.template] || 'Card game'));
  // Said here rather than left for the player to discover at the table. A
  // preview pack deals and displays but has no controls for its genre's own
  // moves yet — see FULLY_PLAYABLE_TEMPLATES in src/ui/table.js.
  if (preview) genre.appendChild(line('tile__badge', 'Preview'));
  open.appendChild(genre);

  open.appendChild(line('tile__tagline', manifest.tagline || ''));

  const foot = document.createElement('span');
  foot.className = 'tile__foot';
  foot.appendChild(line('tile__record', recordText(manifest.id)));
  foot.appendChild(line('tile__cta', summary ? 'Resume' : (preview ? 'Take a look' : 'Deal me in')));
  open.appendChild(foot);

  open.addEventListener('click', () => openTable(manifest.id));
  tile.appendChild(open);

  // A separate hit target rather than a long-press: long-press is
  // undiscoverable, and on iOS Safari it fights the OS text-selection gesture.
  if (summary) {
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
        const seating = buildSeating(summary.seed, summary.seats, { humanSeat: 0 });
        recordResult(manifest.id, {
          won: false,
          forfeit: true,
          opponents: seating
            .filter((identity) => identity.isBot)
            .map((identity) => ({ key: identity.opponentKey, beaten: false })),
        });
      }
      clearMatch(manifest.id);
      openTable(manifest.id);
    });
    tile.appendChild(restart);
  }

  return tile;
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

export function hideLobby() {
  el.screen.hidden = true;
  el.confirmModal.hidden = true;
}

export function reportLobbyError(message) {
  el.grid.replaceChildren();
  el.note.textContent = message;
}

export function initLobby({ onOpenTable }) {
  openTable = onOpenTable;
}
