// READING A PACK OFF DISK, ONCE, FOR EVERY HARNESS THAT NEEDS ONE.
//
// This was twelve copies: tools/pack-test.mjs and tools/simulate.mjs each held a
// `loadPackFromDisk` and a pack-id lister (tools/tune.mjs imports both files, so
// one process carried both copies), and ten tests opened `packs/<id>/manifest.json`
// by hand. Every copy has to know the same three things — where `packs/` is, that
// `deck.json` is optional, and that `loadPack` PATCHES the manifest it is handed —
// and a copy that forgets the third quietly lets a variant test contaminate the
// plain one after it.
//
// Two loaders, sync and async, because the split is real and not a preference:
// the CLI tools are already async and read with `fs/promises`; `node --test`
// helpers are called from synchronous test bodies, and making them async would
// rewrite ten files' worth of call sites to buy nothing.

import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../../src/templates/loadPack.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKS_DIR = path.join(REPO_ROOT, 'packs');

/**
 * Every pack id on disk. One source of truth for the CLIs and tests/packs.test.js.
 *
 * Directories only — `packs/` also holds index.json, the list the browser
 * lobby fetches because nothing client-side can read a directory. Without the
 * isDirectory filter that file reads as a pack named "index.json" and every
 * caller here tries to load a manifest out of it.
 */
export function listPackIds() {
  return fs.readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

export async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

export function readJsonSync(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * A pack's raw JSON: its manifest, and its deck if it ships one.
 *
 * `deck.json` is OPTIONAL — a pack over a built-in deck has none — and every
 * hand-written copy of this had to remember the existsSync branch.
 */
export function readPackJsonSync(packId) {
  const dir = path.join(PACKS_DIR, packId);
  const manifest = readJsonSync(path.join(dir, 'manifest.json'));
  const deckPath = path.join(dir, 'deck.json');
  const deckJson = fs.existsSync(deckPath) ? readJsonSync(deckPath) : undefined;
  return { manifest, deckJson };
}

/**
 * `variants` is the id list to switch on, or undefined for the pack's own
 * defaults — the same contract src/ui/packSource.js hands the browser, so a
 * rule test, a simulation and a real table are loading the pack the same way.
 *
 * Cloned, because loadPack patches the manifest it is given and this one is
 * re-read per variant set — a patch leaking into the next load would make a
 * variant test contaminate the plain one after it.
 */
export async function loadPackFromDisk(packId, variants) {
  const dir = path.join(PACKS_DIR, packId);
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  let deckJson;
  try {
    deckJson = await readJson(path.join(dir, 'deck.json'));
  } catch {
    deckJson = undefined;
  }
  return loadPack(structuredClone(manifest), { deckJson, variants });
}

/** The same load, for a synchronous test body. */
export function loadPackFromDiskSync(packId, variants) {
  const { manifest, deckJson } = readPackJsonSync(packId);
  return loadPack(structuredClone(manifest), { deckJson, variants });
}
