// WHAT ONE SEAT MAY SEE — the engine state, filtered down to a payload that is
// safe to hand that seat and complete enough to draw the table from.
//
// This is the piece multiplayer could not be built without, and the reason is
// that the existing save format is the WRONG shape for a peer. A match persists
// as seed + event log (src/engine/replay.js), which is exactly right for the
// host and for resume — but the seed reconstructs the entire shuffle, so
// sending it to a joiner hands them every hand at the table. There is no
// redaction of a seed. And a joiner given only its own cards cannot run the
// reducer at all, because `rehydrateMatch` replays every move through the full
// validator and that needs full knowledge.
//
// So a client never runs the reducer. It holds one of these instead: a plain,
// JSON-serialisable snapshot of what its seat can see, replaced wholesale after
// every move. The host stays the only party with a state object.
//
// FAIL CLOSED. Every rule below is written so that a thing nobody thought about
// is HIDDEN rather than shown. Shared vars are an allowlist, not a denylist,
// because the one time this codebase put a card id in a shared var
// (`drawnCardId`, shedding's play-after-draw) a denylist would have had to know
// to exclude it in advance, and the cost of being wrong is the whole point of
// the feature. A fifth template that declares nothing leaks nothing.
//
// VISIBILITY IS A RENDERING VOCABULARY AND HAD TO BE RE-READ AS A FILTERING
// ONE. `visibility` already existed, but only the renderer consumed it, so its
// values meant "draw this face down" rather than "do not tell them". Every zone
// in every template was re-examined for this; the audit table lives in
// src/templates/CONTRACT.md. Two of them do not mean what the name suggests:
// sequencing's personal discards are `all` because PLAYABILITY, not secrecy,
// limits them to the top card, and trick-taking's `won` pile is `none` yet must
// still publish its point total, because everyone at a real table watched those
// tricks being taken.

import { baseId } from './selectors.js';

/** Bump when the payload shape changes. Clients refuse a version they don't know. */
export const VIEW_VERSION = 1;

/** Shared vars every template may publish without declaring them. */
const ALWAYS_PUBLIC_VARS = Object.freeze([]);

/**
 * Is this a per-player var only its owner may see?
 *
 * The `__` prefix is the templates' existing convention for their own private
 * bookkeeping (`__pendingPass`, shedding's `__<id>Called`/`__<id>Seen`), and it
 * is load-bearing here: Hearts' whole passing phase is a simultaneous COMMIT,
 * which stops being a commit the moment another seat can read the selection.
 */
function isSecretPlayerVar(key) {
  return key.startsWith('__');
}

/**
 * A TEMPLATE DECLARES ITS PUBLIC VARS AS A FUNCTION OF ITS RULES, because the
 * names are not always literals. Shedding publishes one `active<Attr>` per
 * attribute the pack matches on (`activeSuit`, `activeColor`, `activeRank`),
 * and trick-taking publishes whichever var the manifest named for "hearts are
 * broken" — neither is knowable without the rules in hand.
 *
 * An array is still accepted for a template with nothing dynamic to say.
 */
function publicVarsOf(template, rules) {
  const declared = typeof template.publicVars === 'function'
    ? template.publicVars(rules || {})
    : template.publicVars;
  return new Set([...ALWAYS_PUBLIC_VARS, ...(Array.isArray(declared) ? declared : [])]);
}

/**
 * What a pile of hidden cards is worth, for a zone that declares
 * `showsHeldValue`.
 *
 * The subtle one. Hearts' `won` pile is `visibility: 'none'` — nobody may look
 * through the tricks, not even their owner — and yet the running point cost is
 * public, because everybody watched each trick being taken. Sending only a
 * count would quietly delete a number the felt has always shown.
 */
function heldValueOf(state, def, address) {
  if (!def.showsHeldValue) return undefined;
  const scoring = state.pack.scoring || state.pack.manifest?.scoring;
  const values = scoring?.cardValues;
  if (!values) return undefined;
  let total = 0;
  for (const id of state.zones.cards(address)) {
    const card = state.pack.cardsById.get(baseId(String(id)));
    if (!card) continue;
    total += Number(values[card.rank] ?? values[card.id] ?? card.value ?? 0) || 0;
  }
  return total;
}

/**
 * One zone, as `seat` may see it.
 *
 * `cards` present means "you may see these, in this order". Its ABSENCE is the
 * redaction — a client cannot tell a hidden pile from a pile it merely was not
 * told about, which is the correct amount of information.
 */
function zoneView(state, address, instance, seat) {
  const def = instance.def;
  const cards = instance.cards;
  const out = {
    id: def.id,
    seat: instance.seat,
    n: instance.n,
    count: cards.length,
  };

  const held = heldValueOf(state, def, address);
  if (held !== undefined) out.heldValue = held;

  switch (def.visibility) {
    case 'all':
      out.cards = cards.slice();
      break;
    case 'owner':
      // The only rule that asks who is looking.
      if (instance.seat === seat) out.cards = cards.slice();
      break;
    case 'top':
      out.top = cards.length ? cards[cards.length - 1] : null;
      break;
    case 'none':
    default:
      // Count only. `none` means nobody — including the pile's own owner, which
      // is what stops a player leafing back through their own won tricks.
      break;
  }
  return out;
}

/**
 * The whole table as one seat sees it.
 *
 * @param seat  the seat this view is for; `null` for a spectator, which sees
 *              exactly the public table and no hand at all
 * @param moves the legal moves to ship with it (design decision D3 — the HOST
 *              enumerates, because enumerating over a partial state is a
 *              soundness trap and `legalMovesFor`'s memo is documented-unsound
 *              off the applyMove path)
 */
export function viewFor(state, seat, { moves = null, announcements = null, deadlines = [], seq = null } = {}) {
  const template = state.pack.template;
  const publicVars = publicVarsOf(template, state.pack.rules);

  const zones = {};
  for (const address of state.zones.allAddresses()) {
    zones[address] = zoneView(state, address, state.zones.get(address), seat);
  }

  // SHARED VARS ARE AN ALLOWLIST. Anything a template did not declare public is
  // treated as this turn's private bookkeeping and goes only to the seat whose
  // move produced it — `drawnCardId` is the live example, and it is a card in
  // somebody's hand.
  const vars = {};
  const privateVars = {};
  for (const [key, value] of Object.entries(state.vars || {})) {
    if (publicVars.has(key)) vars[key] = value;
    else if (seat !== null && state.turn.seat === seat) privateVars[key] = value;
  }

  const playerVars = (state.playerVars || []).map((own, index) => {
    const out = {};
    for (const [key, value] of Object.entries(own || {})) {
      if (!isSecretPlayerVar(key) || index === seat) out[key] = value;
    }
    return out;
  });

  return {
    v: VIEW_VERSION,
    seq,
    seat,
    seats: state.seats,
    packId: state.pack.id,
    packVersion: state.pack.manifest?.version,
    variants: state.pack.activeVariants ?? [],

    turn: { seat: state.turn.seat, phase: state.turn.phase },
    direction: state.direction,
    roundNumber: state.roundNumber,
    scores: state.scores.slice(),
    roundScores: state.roundScores,
    roundEnded: state.roundEnded,
    roundWinner: state.roundWinner,
    gameOver: state.gameOver,
    winner: state.winner,

    vars,
    privateVars,
    playerVars,
    zones,

    moves: moves ? moves.map(cloneMove) : [],
    announcements: announcements ? announcements.map(cloneMove) : [],
    deadlines,
  };
}

/** A defensive copy, so a view can never alias a live move object. */
function cloneMove(move) {
  return JSON.parse(JSON.stringify(move));
}

/**
 * EVERY CARD ID `seat` IS ENTITLED TO KNOW, straight off the zone visibility
 * rules — the same three cases `zoneView` above filters on.
 *
 * Named and exported because it has a second caller now; it was inline in
 * `eventsFor` below. tools/simulate.mjs keeps its OWN copy on purpose and
 * should — its per-move audit is an independent reading of the visibility
 * rules, and an auditor that imports the thing it audits cannot catch it being
 * wrong.
 *
 * The new caller is the bot's lookahead (src/engine/bot.js), which uses it
 * to REFUSE to judge a move: if playing a move out on a fork turns up a card
 * the seat could not see beforehand, then the position it produced is one the
 * seat had no way to predict, and scoring it is reading the deck. That is the
 * same rule this function has always expressed, asked forward in time.
 */
export function visibleCardIds(state, seat) {
  const visible = new Set();
  for (const address of state.zones.allAddresses()) {
    const instance = state.zones.get(address);
    const def = instance.def;
    if (def.visibility === 'all' || (def.visibility === 'owner' && instance.seat === seat)) {
      for (const id of instance.cards) visible.add(id);
    } else if (def.visibility === 'top' && instance.cards.length) {
      visible.add(instance.cards[instance.cards.length - 1]);
    }
  }
  return visible;
}

/**
 * The derived-event window, as one seat may see it.
 *
 * Events drive animation and narration only — the ViewState is what a client
 * actually believes (design decision D2), so a dropped event costs a flourish
 * rather than correctness. That asymmetry is deliberate and it is why this
 * filter is allowed to be blunt: the expensive mistake is leaking, never
 * over-hiding.
 *
 * Card ids appear in exactly two events today and both are already public by
 * the time they are emitted: `trickWon.cards` were face up in the `trick` zone,
 * and contract-rummy's melds are laid face up. They are checked against the
 * seat's own view anyway rather than trusted, so a template that starts putting
 * a hidden card in an event payload is caught by the leak tests instead of
 * shipping.
 */
export function eventsFor(state, seat, events = []) {
  const visible = visibleCardIds(state, seat);

  return events.map((ev) => {
    if (!Array.isArray(ev.cards)) return { ...ev };
    // Keep the SHAPE (the table counts them to size a flight) but drop any id
    // this seat has no business holding.
    const kept = ev.cards.filter((id) => visible.has(id));
    if (kept.length === ev.cards.length) return { ...ev };
    return { ...ev, cards: kept, hiddenCards: ev.cards.length - kept.length };
  });
}

/**
 * Every card id present anywhere in a payload, for the leak tests.
 *
 * Deliberately structural rather than a list of known fields: a test that only
 * looked where ids are supposed to be would pass for exactly as long as nobody
 * put one somewhere new.
 */
export function cardIdsIn(payload, isCardId) {
  const found = new Set();
  const walk = (node) => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (isCardId(node)) found.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(payload);
  return found;
}
