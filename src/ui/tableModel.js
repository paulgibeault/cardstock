// THE TABLE READS ONE SHAPE, whether it is the host holding a real match or a
// joiner holding nothing but the last view it was sent.
//
// A client has no engine state and cannot be given one (src/engine/view.js: the
// seed reconstructs every hand, and a joiner cannot run the reducer anyway). So
// something has to stand in for `state` on the read path — and the choice is
// between two render paths or one.
//
// IT IS ONE, and the reason is arithmetic rather than taste. The renderer
// touches state in about seventeen places. Two paths means seventeen pairs to
// keep in step forever, and the second of each pair is the one nobody looks at
// because it only runs when two devices are paired. A view model that answers
// the same questions means the felt is drawn by the same code for everybody,
// and a bug in it is a bug the host sees too.
//
// `modelFromState` IS THE IDENTITY FUNCTION, deliberately. The host and the
// solo table pass their real state through untouched, so this file cannot
// regress single-player play at all — there is no wrapper to be subtly wrong.
// All the work is in `modelFromView`, and `tests/tableModel.test.js` pins that
// it answers everything a real state does for the reads the UI actually makes.
//
// WHAT A HIDDEN CARD LOOKS LIKE. A pile whose contents are secret still has a
// DEPTH, and the felt draws it: a face-down pile is one back node sized by its
// count, and a top-visible pile draws a few backs under the real top card so it
// reads as a pile rather than a slide viewer. So the model hands out opaque
// placeholder ids — enough of them, in the right places — and resolves them to
// a single shared face-down card. The placeholders never touch the wire and
// cannot collide with a real id, because `~` is not in the `[\w-]` charset every
// real card id is held to.

import { ZoneSet, zoneAddress } from '../engine/state.js';

/** Prefix for a card this seat may not see. Not a wire value; never persisted. */
const HIDDEN_PREFIX = '~h';

export function isHiddenCardId(cardId) {
  return typeof cardId === 'string' && cardId.startsWith(HIDDEN_PREFIX);
}

/**
 * The one card every hidden id resolves to.
 *
 * It exists because the renderer skips a card it cannot look up (`if (!card)
 * return`), and a skipped card is a pile that draws with the wrong depth. It is
 * never passed to `art().face()` — the paths that reach a hidden id are the
 * ones that draw `art().back()` — but it carries a name anyway, because
 * `cardAriaLabel` reads it and a screen reader should hear something true.
 */
const FACE_DOWN_CARD = Object.freeze({
  id: HIDDEN_PREFIX,
  name: 'Face-down card',
  hidden: true,
});

/**
 * The host's and the solo table's model: the state itself.
 *
 * Named rather than inlined so the two call sites read as a pair, and so the
 * one place that decides "which model am I" is greppable.
 */
export function modelFromState(state) {
  return state;
}

/**
 * A read-only, state-shaped view of what this seat was sent.
 *
 * @param view the ViewState from the host (src/engine/view.js)
 * @param pack the loaded pack — the CLIENT'S OWN copy. Packs ship with the app;
 *             the host sends card ids, never card definitions, so a client
 *             renders from the same manifest it would use solo. That is also
 *             why the lobby handshake refuses a pack-version mismatch: two
 *             builds drawing the same id differently is the failure this
 *             arrangement trades for the bandwidth it saves.
 */
export function modelFromView(view, pack) {
  const zones = buildZones(view, pack);
  const cardsById = wrapCardTable(pack.cardsById);

  return {
    // A marker, so a caller that genuinely must know can ask instead of
    // sniffing for a missing method.
    isView: true,
    view,

    pack: { ...pack, cardsById },
    seats: view.seats,
    zones,

    turn: { seat: view.turn?.seat ?? 0, phase: view.turn?.phase ?? null },
    direction: view.direction ?? 1,
    scores: (view.scores || []).slice(),
    playerVars: (view.playerVars || []).map((own) => ({ ...own })),
    // The seat's own private bookkeeping is merged over the public vars, so a
    // template reading `vars.drawnCardId` finds it exactly where it always was.
    vars: { ...(view.vars || {}), ...(view.privateVars || {}) },

    roundNumber: view.roundNumber ?? 1,
    roundScores: view.roundScores ?? null,
    roundEnded: !!view.roundEnded,
    roundWinner: view.roundWinner ?? null,
    gameOver: !!view.gameOver,
    winner: view.winner ?? null,

    // A CLIENT HAS NO LOG AND MUST NOT PRETEND TO. The log is the match, and
    // the host owns it; an empty array here is the honest answer, and anything
    // that needs the log (persisting, replaying) is host-only by design.
    log: [],
    events: [],

    // Shipped by the host with the view (design decision D3): enumerating over
    // a partial state is a soundness trap.
    moves: (view.moves || []).slice(),
    announcements: (view.announcements || []).slice(),
    deadlines: (view.deadlines || []).slice(),
  };
}

/**
 * Rebuild a ZoneSet from the view.
 *
 * The real class rather than a look-alike: `interaction.js` reads `zones.get()`
 * for a zone's `def`, and the defs are the pack's own, so the cheapest correct
 * thing is to define the zones exactly as `createState` would and then fill
 * them from the view.
 */
function buildZones(view, pack) {
  const zones = new ZoneSet();
  const defsById = new Map();
  for (const def of pack.template.defaultZones(pack.rules, view.seats)) defsById.set(def.id, def);
  for (const def of pack.manifest.zones || []) defsById.set(def.id, def);
  for (const def of defsById.values()) zones.define(def, view.seats);

  let counter = 0;
  const hiddenId = () => `${HIDDEN_PREFIX}${++counter}`;

  for (const address of zones.allAddresses()) {
    const seen = view.zones?.[address];
    const instance = zones.get(address);
    if (!seen) continue;

    if (Array.isArray(seen.cards)) {
      // Fully visible: the real ids, in the real order.
      instance.cards.push(...seen.cards);
      continue;
    }

    const count = Number(seen.count) || 0;
    if (seen.top !== undefined && seen.top !== null) {
      // Top-visible: the depth is public, the cards under it are not. Fill with
      // placeholders and put the one real card where the renderer looks for it.
      for (let i = 0; i < Math.max(0, count - 1); i++) instance.cards.push(hiddenId());
      instance.cards.push(seen.top);
    } else {
      for (let i = 0; i < count; i++) instance.cards.push(hiddenId());
    }
  }
  return zones;
}

/**
 * The pack's card table, plus an answer for every placeholder.
 *
 * A Map-shaped wrapper rather than a copy: the real table is built once per
 * match and holds every card in the deck, and rebuilding it per view frame
 * would be the one genuinely hot thing in this file.
 */
function wrapCardTable(real) {
  return {
    get(id) {
      if (isHiddenCardId(id)) return FACE_DOWN_CARD;
      return real.get(id);
    },
    has(id) {
      return isHiddenCardId(id) ? true : real.has(id);
    },
    keys: () => real.keys(),
    values: () => real.values(),
    entries: () => real.entries(),
    get size() { return real.size; },
    [Symbol.iterator]: () => real[Symbol.iterator](),
  };
}

export { zoneAddress, FACE_DOWN_CARD };
