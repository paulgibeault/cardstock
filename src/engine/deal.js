// Dealing primitives shared by every template: how many cards a `countOrByPlayers`
// spec means at this table, and the "pop the top of a pile into a zone, N times"
// loop that every setup() was writing out by hand.

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
