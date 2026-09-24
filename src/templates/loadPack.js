// THE COMPOSITION ROOT: the one place the engine's pack loader is tied to the
// template registry.
//
// src/engine/packLoader.js does the loading and takes its template resolver as
// an argument (#210), so src/engine imports nothing from src/templates and
// `templates → engine → templates/index` is no longer a cycle. That leaves
// exactly one line that knows both halves, and it is this one.
//
// EVERY CALLER GOES THROUGH HERE rather than passing `getTemplate` by hand:
// there are twenty of them (the felt's pack source, tools/pack-test.mjs,
// tools/simulate.mjs and the suites that build a manifest inline), and twenty
// copies of the same wiring is the duplication the injection was meant to end,
// not a shape to spread. Something that genuinely wants a different registry —
// a fixture template, a future pack studio — calls
// `engine/packLoader.js`'s `loadPack` directly with its own resolver.

import { loadPack as loadPackWith } from '../engine/packLoader.js';
import { getTemplate } from './index.js';

/** `loadPack(manifest, { deckJson, variants })`, with the shipped templates bound. */
export function loadPack(manifest, options = {}) {
  return loadPackWith(manifest, { ...options, resolveTemplate: options.resolveTemplate ?? getTemplate });
}
