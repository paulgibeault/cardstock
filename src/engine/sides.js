// WHICH SEATS SHARE A SCORE — the one question partnerships add to the engine.
//
// Nothing in this repo knew the word `team` until Spades (#105) and Pinochle
// (#106) needed it. Scoring was seat-keyed end to end, `matchStanding` asked
// "how good for this seat", `placements` ranked seats, and the felt drew a score
// chip per chair. Every one of those is right for four players playing for
// themselves and wrong for two pairs.
//
// THE VOCABULARY IS ONE NUMBER: `players.teams`. Seats are dealt round-robin
// into that many sides, so seat s belongs to side `s % teams`. That is the
// smallest declaration that covers the game this was built for — four seats,
// two sides, partners across the table — and the round-robin is what makes
// "across" fall out rather than being a second declaration: with the sides
// equal in size, a seat's partner is always exactly `seats / teams` chairs
// away, which for the 4/2 case is the chair opposite.
//
// IT LIVES UNDER `players`, NOT UNDER `rules`. Two reasons, and the second is
// the load-bearing one. It is a fact about the TABLE — how many chairs, how
// they pair — in the same family as `min`/`max`/`best`, not a parameter of the
// trick-taking template (Pinochle and Spades share it; a future partnership
// shedding game would too). And the lobby's seat picker has to know which
// chairs are a pair while showing a tile, and the lobby NEVER loads a pack: it
// reads manifests alone (`src/ui/lobby.js`, and the repo gate that says so). A
// key under `rules` would be invisible there.
//
// ROOM FOR PARTNERS THAT ROTATE, deliberately left rather than built. Every
// answer below is computed from the pack and the seat count on demand — there
// is no table baked at load time and no field on the state — so a game whose
// partners change each hand grows a `teams: { rotate: … }` shape here and a
// round number in the signature, and every call site keeps working. Building
// that today would be a vocabulary with no consumer.
//
// A TEAMLESS PACK IS THE SAME CODE PATH, not a branch around it: it has as many
// sides as seats and each side holds one seat, so `sidesOf` returns
// `[[0],[1],[2],[3]]` and every fold below is the identity. That is what lets
// scoring, the bot's standing and `placements` be rewritten in terms of sides
// without a single existing pack changing what it does.

/**
 * Memoized per (pack, seat count). `sidesOf` is asked inside the rollout loop —
 * `terminalValue` calls `standingOf` twice per seat per sample — and the answer
 * is a fact about the manifest, not about the position.
 */
const tables = new WeakMap();

/**
 * How many sides a pack declares, or null for a pack that declares none.
 *
 * NOT DIVISIBLE, NOT PARTNERSHIPS. A pack seated at a count its sides cannot
 * divide evenly has no honest pairing to offer, and the alternative — a side
 * with three seats in a game written for two — is worse than playing it as a
 * free-for-all. `players.min`/`max` is what stops that arising: Spades declares
 * 4 and 4. Returning null here rather than throwing keeps a mis-seated table
 * playable instead of crashing the felt on the deal.
 */
export function teamCount(pack, seats) {
  // A LOADED PACK OR A BARE MANIFEST, because the lobby only ever has the
  // second: it draws every tile and every seat picker from manifests alone and
  // never loads a pack (that is its cost ceiling). One reader for both keeps
  // the felt and the seat picker from pairing the chairs differently.
  const declared = (pack?.manifest?.players ?? pack?.players)?.teams;
  if (!Number.isInteger(declared) || declared < 2) return null;
  if (!Number.isInteger(seats) || seats < declared) return null;
  if (seats % declared !== 0) return null;
  return declared;
}

/** Does this pack score in sides at all? */
export function hasSides(pack, seats) {
  return teamCount(pack, seats) !== null;
}

/**
 * THE PAIRING RULE ITSELF, from the raw declaration — round-robin, so seat s
 * plays for side `s % teams`.
 *
 * Exported because the lobby's seat picker (`src/ui/partyModel.js`) has a
 * `teams` number out of a manifest and no pack at all, and a second copy of
 * this loop there is a second place for the felt and the picker to disagree
 * about who is partnering whom. `teams` null, or one that does not divide the
 * seats, means every seat plays for itself — see `teamCount`.
 */
export function sidesFor(teams, seats) {
  const count = Number.isInteger(seats) && seats > 0 ? seats : 0;
  const valid = Number.isInteger(teams) && teams >= 2 && teams <= count && count % teams === 0;
  const built = !valid
    ? Array.from({ length: count }, (_, seat) => [seat])
    : Array.from({ length: teams }, (_, side) => {
      const members = [];
      for (let seat = side; seat < count; seat += teams) members.push(seat);
      return members;
    });
  return Object.freeze(built.map((members) => Object.freeze(members)));
}

/**
 * The seats on each side, side index order.
 *
 * ALWAYS AN ANSWER. A teamless pack gets one side per seat, which is what makes
 * every caller below able to speak sides and nothing else.
 */
export function sidesOf(pack, seats) {
  if (!pack || typeof pack !== 'object') return sidesFor(null, seats);
  let byCount = tables.get(pack);
  if (!byCount) {
    byCount = new Map();
    tables.set(pack, byCount);
  }
  const cached = byCount.get(seats);
  if (cached) return cached;
  const built = sidesFor(teamCount(pack, seats), seats);
  byCount.set(seats, built);
  return built;
}

/** Which side a seat plays for. A teamless seat is its own side. */
export function sideOfSeat(pack, seats, seat) {
  const teams = teamCount(pack, seats);
  return teams === null ? seat : ((seat % teams) + teams) % teams;
}

/** The OTHER seats on this seat's side — empty for a teamless pack. */
export function partnersOf(pack, seats, seat) {
  return sidesOf(pack, seats)[sideOfSeat(pack, seats, seat)].filter((s) => s !== seat);
}

/** Are these two seats on the same side? False for a seat and itself's absence. */
export function arePartners(pack, seats, a, b) {
  if (a === b) return false;
  return sideOfSeat(pack, seats, a) === sideOfSeat(pack, seats, b);
}

/**
 * A per-seat quantity folded into its side's total.
 *
 * THE FOLD IS A SUM, and that is the whole scoring decision (see
 * `src/engine/scoring.js`): a template still returns per-seat deltas, the seats
 * still accumulate them, and a side's score is what its seats add up to. So a
 * bids-and-bags scorer may hand the side's whole 120 to one partner or split it
 * sixty each — the side's total is 120 either way — and a penalty-cards scorer
 * that knows nothing about partnerships gets the right answer for free.
 *
 * @param values a per-seat array (state.scores, or a per-seat standing)
 */
export function foldToSides(values, sides) {
  return sides.map((members) => members.reduce((sum, seat) => sum + (Number(values[seat]) || 0), 0));
}

/** Every side's score, in side index order. */
export function sideScores(pack, seats, scores) {
  return foldToSides(scores, sidesOf(pack, seats));
}

/** The score of the side `seat` plays for — a teamless seat's own score. */
export function sideScoreOf(pack, seats, scores, seat) {
  return sidesOf(pack, seats)[sideOfSeat(pack, seats, seat)]
    .reduce((sum, s) => sum + (Number(scores[s]) || 0), 0);
}

/**
 * The seat that stands for a side wherever the platform needs ONE.
 *
 * `state.winner` is a seat and stays one. Changing it to a side index would
 * make the same field mean two different things depending on the pack, and it
 * is read as a seat by the roster, the celebration, the head-to-head record and
 * every stored match — so the smaller, reversible choice is to keep the seat
 * and name a canonical member. Callers asking "did MY side win" ask
 * `arePartners` or `sideOfSeat`, never `winner === mySeat`.
 */
export function representativeSeat(pack, seats, side) {
  return sidesOf(pack, seats)[side]?.[0] ?? 0;
}
