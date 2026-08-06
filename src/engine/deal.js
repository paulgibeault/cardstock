// Dealing primitives shared by every template: how many cards a `countOrByPlayers`
// spec means at this table, the "pop the top of a pile into a zone, N times" loop
// that every setup() was writing out by hand, and the recycle reaction that two
// templates and two manifests each declared their own copy of.

/**
 * A `countOrByPlayers` spec (schema/manifest.schema.json) resolved for a table
 * of `seats`: a bare number, or `{ default, byPlayers: { "2": 7 } }`.
 *
 * Copy-pasted into shedding and sequencing and re-implemented WITHOUT the
 * byPlayers branch in contract-rummy, where Milestones' flat `deal: 10` hid the
 * omission — any pack that dealt by player count would have been silently dealt
 * its default. One implementation is the fix; the third copy is why.
 */
export function resolveByPlayers(spec, seats) {
  if (typeof spec === 'number') return spec;
  if (!spec) return 0;
  return spec.byPlayers?.[String(seats)] ?? spec.default ?? 0;
}

/**
 * The default "when the draw pile runs out, shuffle the discard back into it,
 * keeping the card on top" reaction.
 *
 * Shedding and contract-rummy each wrote this object out, and the Milestones
 * and Stockpile manifests wrote their own copies on top of the template's —
 * registering the same reaction twice, harmless only because a no-op recycle
 * returns false and the sweep reaches its fixed point anyway.
 *
 * Frozen and cloned per call: reactions live on state, and a shared mutable
 * object between two matches is a landmine for no benefit.
 */
export function recycleDiscardIntoDraw() {
  return { when: 'zoneEmpty:draw', do: 'recycle', from: 'discard', keepTop: true, shuffle: true };
}
