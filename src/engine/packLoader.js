// Loads a pack (manifest + optional deck file) into the runtime `pack` object every
// other engine module consumes: { id, manifest, rules, scoring, template, cardsById }.
//
// This loader does no schema validation and must not: it runs in the browser on
// the hot path of opening a table, and the engine stays browser-clean (§17.10).
// The schemas are enforced OFFLINE instead — tools/schema-check.mjs, run by
// tools/pack-test.mjs and gated in tests/repo-gates.test.js, over every pack on
// disk and every available variant patch. Until that existed this comment was a
// claim nothing backed.

import { builtinDeckByName, expandDeckFile, applyCardTags } from './cards.js';
import { resolveSelectorMap } from './selectors.js';
import { getTemplate } from '../templates/index.js';

function applyVariantPatches(manifest, activeVariantIds) {
  if (!activeVariantIds || activeVariantIds.length === 0) return manifest;
  let patched = structuredClone(manifest);
  const byId = new Map((manifest.variants || []).map((v) => [v.id, v]));
  for (const variantId of activeVariantIds) {
    const variant = byId.get(variantId);
    if (!variant) throw new Error(`Unknown variant: ${variantId}`);
    for (const [path, value] of Object.entries(variant.patch)) {
      applyPatch(patched, path, value);
    }
  }
  return patched;
}

function defaultVariantIds(manifest) {
  return (manifest.variants || []).filter((v) => v.default).map((v) => v.id);
}

/**
 * One dotted-path assignment over a manifest ('rules.drawWhenStuck'), null to
 * delete. Exported for the offline gate, which applies each available variant's
 * patch and re-validates the result — a mistyped path vivifies an object here
 * rather than failing, so the schema is what catches it.
 */
export function applyPatch(obj, dottedPath, value) {
  const segments = dottedPath.split('.');
  let cursor = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cursor[seg] === undefined || cursor[seg] === null) cursor[seg] = {};
    cursor = cursor[seg];
  }
  const last = segments[segments.length - 1];
  if (value === null) delete cursor[last];
  else cursor[last] = value;
}

// deckSource: the raw deck.json content when the manifest references a relative file,
// or undefined when the manifest names a built-in deck.
export function loadPack(manifest, { deckJson, variants } = {}) {
  const activeVariants = variants ?? defaultVariantIds(manifest);
  const patchedManifest = applyVariantPatches(manifest, activeVariants);

  const builtin = builtinDeckByName(patchedManifest.deck);
  const deck = builtin ?? expandDeckFile(deckJson);
  if (!deck) {
    throw new Error(`Pack "${patchedManifest.id}" deck "${patchedManifest.deck}" is not built-in and no deck.json was supplied`);
  }

  let cards = applyCardTags(deck.cards, patchedManifest.cardTags);

  // Shedding-style per-selector effect overrides (rules.effects) apply on top of
  // whatever the deck file itself set on the card.
  if (patchedManifest.rules?.effects) {
    cards = cards.map((card) => {
      const override = resolveSelectorMap(card, patchedManifest.rules.effects, undefined);
      return override === undefined ? card : { ...card, effect: override };
    });
  }

  const cardsById = new Map(cards.map((c) => [c.id, c]));
  const template = getTemplate(patchedManifest.template);

  return {
    id: patchedManifest.id,
    manifest: patchedManifest,
    rules: patchedManifest.rules,
    scoring: patchedManifest.scoring || {},
    reactions: patchedManifest.reactions || [],
    activeVariants,
    template,
    cardsById,
  };
}
