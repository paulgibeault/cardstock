// Fetching packs from the server: the one place that builds a URL out of a
// pack id, for both screens.
//
// The lobby needs five manifests and no decks; the table needs one pack fully
// loaded. Splitting those is the whole reason this module exists — drawing a
// lobby tile must not cost a deck parse, or opening the front door would get
// slower every time a pack ships.

import { loadPack } from '../engine/packLoader.js';
import { isValidPackId } from '../arcade/storage.js';

// Relative, not root-relative — this must work whether the page sits at the
// origin root, under a subpath (GitHub Pages project site: /cardstock/), or
// inside the launcher's dev.sh staging (/<gameId>/). Resolves against the
// document's own URL either way.
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

function assertPackId(packId) {
  // §7b: this id lands in a fetch path. Re-checked here rather than trusted
  // from the caller, because the callers now include a JSON file's contents.
  if (!isValidPackId(packId)) throw new Error(`Invalid pack id: ${String(packId)}`);
  return packId;
}

/**
 * The pack ids the lobby offers, in the order it shows them.
 *
 * A browser cannot list a directory, so `packs/index.json` is the catalog and
 * tests/repo-gates.test.js keeps it honest against what is actually on disk.
 * Its ORDER is editorial — the grid is drawn in it — so it is preserved here.
 */
export async function fetchPackIndex() {
  const doc = await fetchJson('packs/index.json');
  const ids = Array.isArray(doc && doc.packs) ? doc.packs.filter(isValidPackId) : [];
  if (ids.length === 0) throw new Error('packs/index.json listed no usable packs');
  return ids;
}

// Manifests are small, immutable for the life of the page, and wanted by both
// screens — the lobby reads all five, then the table re-reads whichever one
// the player picked. Caching the PROMISE (not the value) also collapses the
// five parallel lobby fetches if anything asks twice mid-flight.
const manifestCache = new Map();

export function fetchPackManifest(packId) {
  assertPackId(packId);
  if (!manifestCache.has(packId)) {
    const pending = fetchJson(`packs/${packId}/manifest.json`);
    // A failed fetch must not be remembered as the answer: the player can go
    // back to the lobby and try again, and offline-then-online is the ordinary
    // case for a PWA.
    pending.catch(() => manifestCache.delete(packId));
    manifestCache.set(packId, pending);
  }
  return manifestCache.get(packId);
}

/**
 * A pack loaded and ready to play.
 *
 * `variants` pins the rule set; a resumed match passes the set its log was
 * recorded against, because replaying a log against different rules diverges.
 */
export async function fetchPack(packId, variants) {
  const manifest = await fetchPackManifest(packId);

  // `deck` is either a BUILT-IN name (standard-52, standard-54, standard-52x<n>
  // — resolved in src/engine/cards.js) or a relative deck file. Ask only when
  // it names a file: speculatively probing for deck.json and swallowing the
  // failure cost a 404 on every crazy-eights and hearts boot, which is a real
  // console error and fails §13's "loads with no console errors".
  //
  // The name is manifest-supplied and lands in a fetch path, so it is
  // constrained to a plain filename in this directory — no slashes, no
  // traversal (§7b).
  let deckJson;
  if (/^[\w-]+\.json$/.test(manifest.deck || '')) {
    deckJson = await fetchJson(`packs/${packId}/${manifest.deck}`);
  }

  // Clone: the cache hands the same manifest object to every caller, and
  // loadPack only clones it for itself when variants patch it. A live pack
  // sharing an object with the lobby's tile data is a bug waiting for the
  // first line of code that edits a manifest in place.
  return loadPack(structuredClone(manifest), { deckJson, variants });
}
