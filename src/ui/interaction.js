// What the human may do right now, as data — no DOM, no rendering, no engine
// mutation.
//
// Extracted from src/ui/table.js when drag-and-drop arrived, and the reason is
// the whole design of this pass:
//
//   A DRAG IS A SECOND DRESSING OF THE SAME MOVES, NOT A SECOND PATH.
//
// Taps already had the invariant that "the selection can never construct a
// move the engine would refuse — every tap target is derived from a move that
// already enumerated as legal". Dropping a card has to inherit that invariant
// rather than re-implement it, so both dressings ask THIS module the same
// question and get moves that came out of `enumerateLegalMoves`.
//
// Being DOM-free is what makes the answer testable: `dropCandidates` is a pure
// function of (state, selection, the card under the finger), so the model
// behind the choreography can be pinned under `node --test` while the pointer
// mechanics get a manual pass.

import { makeCtx } from '../engine/context.js';
import { selectorMatches } from '../engine/selectors.js';

export function handAddress(seat) {
  return `hand.${seat}`;
}

/**
 * THE MODE VOCABULARY IS THE PLATFORM'S; WHICH PHASE MEANS WHICH MODE IS THE
 * TEMPLATE'S.
 *
 * Every gesture surface downstream keys off these strings — the per-mode
 * branches in buildUiModel, stagingPhase, dropCandidates and draggableSources.
 * That is fine, and deliberate: they are a closed set of INPUT SHAPES a table
 * knows how to render. What was not
 * fine was the map from template id to mode living here, because it made
 * `interactionMode` the root of the whole coupling — a fifth template had to be
 * added to this file before any of the six downstream surfaces could see it.
 *
 *   'tap'        one tap plays the card; the destination is implicit
 *                (shedding's discard, a trick).
 *   'play-drawn' the same tap, but only the card just drawn answers to it;
 *                the action button keeps it and ends the turn.
 *   'pass'       multi-select exactly N cards, commit with the action button.
 *   'rummy-draw' tap the deck or the discard pile to draw from it.
 *   'rummy-meld' multi-select for a lay-down; a single selected card arms
 *                meld chips (hit) and the discard pile (end of turn).
 *   'place'      select one card from hand/stock/discard top, then tap a
 *                build pile (play) or an own discard pile (end of turn).
 *
 * And the question a mode must NEVER be asked: whether a given SEAT may be
 * assembling something. A mode is derived from the table-wide `turn.phase`, so
 * that answer is `gathers` below.
 */
export const INTERACTION_MODES = Object.freeze([
  'tap', 'play-drawn', 'pass', 'rummy-draw', 'rummy-meld', 'place',
]);

/**
 * How the human's taps are interpreted right now — asked of the template,
 * never stored.
 *
 * A template that names a mode this build has never heard of gets 'tap', which
 * is the one shape every table can render: one card, one implicit destination.
 * Failing soft rather than throwing is right here because the alternative is a
 * blank table.
 */
export function interactionMode(state) {
  const mode = state.pack.template.interactionMode?.(makeCtx(state));
  return INTERACTION_MODES.includes(mode) ? mode : 'tap';
}

/**
 * Could ANYBODY be gathering cards in this phase?
 *
 * Deliberately not "may the human gather cards right now" — that is
 * `ui.handMulti`, and it flips as the turn moves. What the staging tray's SLOT
 * is reserved on has to be stable across a turn change, or the felt moves under
 * the hand every time one happens (#13). A rummy turn is draw-then-meld, so
 * both of its modes answer yes; a trick game only stages while the pass is
 * open; a shedding game never does.
 *
 * Now reached through `gathers` below, which is the same answer for a template
 * with no opinion and a better one for a template that has finished gathering
 * before the phase has.
 */
export function stagingPhase(state) {
  const mode = interactionMode(state);
  return mode === 'pass' || mode === 'rummy-draw' || mode === 'rummy-meld';
}

/**
 * MAY THIS SEAT BE ASSEMBLING SOMETHING RIGHT NOW? — asked of the template, per
 * seat, never stored.
 *
 * The question `interactionMode` cannot answer, and the bug that says why:
 * `turn.phase` is ONE value for the whole table (src/engine/state.js), so while
 * any seat is drawing, contract-rummy's mode is 'rummy-draw' for everybody —
 * including the human sitting off-turn with half a meld in the tray. Gating the
 * off-turn tray on the mode therefore switched it off for the first half of
 * every bot's turn and back on for the second, which is the intermittent
 * deadness a playtester reported as "interacting with my hand and the meld pile
 * is interrupted". Worse, a tray that goes dead is not merely inert: taps on a
 * staged card kept working, fell through to the single-select branch, and threw
 * the whole gathered meld away.
 *
 * Gathering is not a phase. It is a standing fact about the seat's ROUND — in
 * contract-rummy, whether it has laid its contract down — so the answer has to
 * come from the template, per seat, and must not mention whose turn it is.
 *
 * The default is today's mode-based answer, which is right for every pack that
 * gathers without ever finishing: Hearts' pass tray is open for exactly as long
 * as the pass phase is.
 */
export function gathers(state, seat) {
  const template = state.pack.template;
  if (typeof template.gathers !== 'function') return stagingPhase(state);
  return !!template.gathers(makeCtx(state), seat);
}

/**
 * Whether a HOLD on a hand card gathers the group it belongs to, as opposed to
 * meaning "what is this card?" (src/ui/inspector.js).
 *
 * Two conditions, and both are about capability rather than about the turn: the
 * seat is still assembling, and the pack can answer "what goes with this one".
 * Hearts stages a pass into the same tray and has no such answer, so a hold
 * there keeps opening the inspector — the platform does not offer a gesture a
 * template cannot serve (src/templates/CONTRACT.md).
 */
function holdGathers(state, seat) {
  return typeof state.pack.template.suggestMeld === 'function' && gathers(state, seat);
}

/**
 * The same question, asked off-turn — where the platform's DEFAULT is not good
 * enough to answer it.
 *
 * The default is a statement about the TABLE ("the mode is one that stages"),
 * and off-turn the difference between that and "this seat is still assembling
 * something" is the entire question. Hearts is the live case: everyone commits
 * their pass at once, so a seat that has passed sits off-turn while the pass
 * phase — and with it the staging mode — is still open, with nothing left to
 * arrange and no business re-opening its tray.
 *
 * So the off-turn tray is offered only to a template that answers PER SEAT. A
 * pack that has not implemented the hook keeps exactly the behaviour it had.
 */
function gathersOffTurn(state, seat) {
  return typeof state.pack.template.gathers === 'function' && gathers(state, seat);
}

/**
 * The selection after a tap on a hand card — the one place the toggle rule
 * lives, so it can be pinned without a pointer.
 *
 * `multi` adds or removes the tapped card, which is how a meld is gathered.
 *
 * SINGLE-SELECT MUST NEVER DISCARD MORE THAN THE CARD THAT WAS TAPPED. It used
 * to answer a tap on an already-selected card with `null`, which is the right
 * answer for the one card it was written for and a catastrophe for a tray
 * holding five: one tap on a staged card while the model said single-select
 * threw the entire gathered meld away. The model no longer says single-select
 * while cards are staged (see `gathers` above), and this is the belt to that
 * pair of braces — a future mode that gets the pairing wrong loses one card
 * instead of the meld.
 */
export function toggleHandSelection(selection, { from, cardId, multi = false } = {}) {
  const ids = selection && selection.from === from ? selection.cardIds.slice() : [];
  const at = ids.indexOf(cardId);
  if (at === -1) {
    if (!multi) return { from, cardIds: [cardId] };
    ids.push(cardId);
    return { from, cardIds: ids };
  }
  ids.splice(at, 1);
  return ids.length ? { from, cardIds: ids } : null;
}

/**
 * Which of a seat's picked cards are waiting in the STAGING TRAY rather than
 * lifted out of the fan.
 *
 * Only where several cards are gathered before anything is committed — laying a
 * contract down, choosing a pass. Everywhere else a selection is a single card
 * about to be played, and lifting it out of the fan would be motion for a card
 * that is leaving anyway.
 *
 * ASKED OF THE SEAT'S STANDING, NOT OF THE MOMENT. This used to gate on
 * `ui.handMulti`, and that flips partway through a turn — a rummy turn is draw,
 * then meld, then discard, and only the middle of those gathers. So the SAME
 * picked cards were drawn two different ways depending on when you looked:
 * sitting in the tray while gathering, and lifted out of the fan on either side
 * of it. Nothing about the cards had changed; the display bounced because the
 * mode had.
 *
 * `gathers` is the stable question — stable across a turn change, because it
 * asks the template about this SEAT's round rather than about the table's
 * phase, and a pack with no opinion falls back to the mode, which is stable
 * too. A pack that never gathers (shedding) still shows its single selection in
 * the fan, which is the only place it has.
 *
 * Asking the PHASE had one more consequence, seen live: after the human laid
 * down, a single selection was drawn in the TRAY by a full render and LIFTED IN
 * THE FAN by the fast path (renderSelection), so tapping a card raised it in
 * the fan and the next bot's move silently teleported it into the tray. Once
 * the contract is down there is nothing to gather, so the selection stays in
 * the fan — where the hit and discard gestures expect to find it.
 */
export function stagedSelection(state, seat, selection) {
  if (!gathers(state, seat)) return [];
  if (!selection || selection.from !== handAddress(seat)) return [];
  return selection.cardIds;
}

export function selectedIds(selection) {
  return selection ? selection.cardIds : [];
}

export function isSelected(selection, from, cardId) {
  return !!selection && selection.from === from && selection.cardIds.includes(cardId);
}

/**
 * Drop the parts of a selection the state has moved out from under it
 * (rerender, resume, a card played from under a staged meld).
 *
 * PER CARD, not all-or-nothing. A staged meld is built over several turns —
 * you gather what you have, discard, and come back to it — and every turn ends
 * in a discard, so a rule of "if any card left, forget the whole thing" meant
 * the tray could never survive one. The cards that left are the ones the move
 * consumed; the rest are still in your hand and still where you put them.
 *
 * Returns null once nothing real is left, so callers can keep treating a
 * spent selection as absent.
 */
export function pruneSelection(state, selection) {
  if (!selection) return null;
  if (!state.zones.has(selection.from)) return null;
  const inZone = state.zones.cards(selection.from);
  const kept = selection.cardIds.filter((id) => inZone.includes(id));
  if (!kept.length) return null;
  return kept.length === selection.cardIds.length ? selection : { ...selection, cardIds: kept };
}

/**
 * The hand cards that may enter the staging tray.
 *
 * A card the pack bars from melds (a Milestones skip) stays in hand and stays
 * discardable, but it never stages: the engine would refuse the lay-down
 * anyway, and the only feedback that gives is a Lay down button that
 * mysteriously fails to appear.
 */
function meldStageable(state, seat, hand) {
  const forbidden = state.pack.rules.meldForbidden;
  if (!forbidden?.length) return hand;
  const ctx = makeCtx(state);
  return hand.filter((id) => !forbidden.some((sel) => selectorMatches(ctx.cardById(id), sel)));
}

/**
 * THE ONE PLACE A CONTRACT ITEM IS NAMED.
 *
 * `letter` is what fits on a ladder rung, `long` is the sentence the inspector
 * gives, and `key` is the word in the ladder's legend. They used to be three
 * separate literals in two files — the letters here, the legend string spelled
 * out in src/ui/table.js — which is one edit away from a ladder whose key does
 * not match its rungs.
 */
export const CONTRACT_ITEM_KINDS = Object.freeze({
  set: { letter: 'S', key: 'set', long: (n) => `set of ${n}` },
  run: { letter: 'R', key: 'run', long: (n) => `run of ${n}` },
  colorGroup: { letter: 'C', key: 'colour', long: (n) => `${n} of one color` },
});

/** "S set · R run · C colour" — derived, so it can never disagree with the rungs. */
export const CONTRACT_LADDER_KEY = Object.values(CONTRACT_ITEM_KINDS)
  .map((k) => `${k.letter} ${k.key}`)
  .join(' · ');

export function describeContractItem(item) {
  const m = /^(\w+)\((\d+)\)$/.exec(item || '');
  if (!m) return item;
  const kind = CONTRACT_ITEM_KINDS[m[1]];
  return kind ? kind.long(m[2]) : item;
}

/**
 * The same requirement, short enough to fit on a ladder rung: `S3`, `R7`, `C7`.
 *
 * A ten-rung ladder cannot carry "set of 3 + set of 3" ten times over, and
 * dropping the requirement entirely would leave a row of numbers that says
 * nothing about the race. So the rung carries the initial and the count, the
 * ladder carries a one-line key, and hovering any rung gives the full sentence
 * from describeContractItem() — the same split the pile badges use.
 */
export function shortContractItem(item) {
  const m = /^(\w+)\((\d+)\)$/.exec(item || '');
  if (!m) return String(item || '');
  const kind = CONTRACT_ITEM_KINDS[m[1]];
  return kind ? `${kind.letter}${m[2]}` : String(item);
}

/** A whole contract, short: "S3+R4". */
export function shortContract(items) {
  return (items || []).map(shortContractItem).join('+');
}

/** A whole contract, spelled out: "set of 3 + run of 4". */
export function describeContract(items) {
  return (items || []).map(describeContractItem).join(' + ');
}

/* ------------------------------------------------------------------ *
 * The per-render UI model
 * ------------------------------------------------------------------ */

/* THERE IS NO HINT SENTENCE ANY MORE, and the budget that policed it is gone
   with it. This model used to carry a line of phase guidance — "Draw from the
   deck or the discard pile" — for a bar that stood between the felt and the
   hand, and the bar's two reserved lines were the reason for HINT_MAX_CHARS
   and HINT_MAX_CHARS_BARE: prose that wrapped to a third line pushed the whole
   table down (#13, then #17).
   The bar is now a rail at the fan's edge (index.html), and the words did not
   fit anywhere that did not cost the felt height it does not have — a phone's
   status bar gives a sentence 122px, and the shortest of these needed 166. So
   the sentence was dropped rather than moved or truncated: what a player may
   do is said by the cards and piles that light up, which is the same answer
   the sentence was describing.
   If guidance ever comes back, it needs a measured home before it needs
   words. */

/**
 * How long an action button's label may be — the one piece of prose the felt
 * still has, and now the only one with a layout to break.
 *
 * ONE LINE, NOT TWO, and this number was measured rather than reasoned. The
 * button stands in the rail's thumb slot beside the turn token and the Hint
 * lamp, and the rail may not grow taller than the fan or #hand-row grows with
 * it and the felt shifts — #13 arriving through the words rather than the box,
 * the same way HINT_MAX_CHARS used to be breached (#17). The first cut of this
 * budgeted two lines and let "Pass 3 across" through; in a browser at 375px
 * that wrapped, took the rail from 74px to 89px against a fan 84px tall, and
 * pushed the row out by 14px. A one-line label leaves 10px of headroom on the
 * same measurement.
 *
 * The slot is 5rem wide with 0.25rem of padding each side, so a label has
 * ~74px at 0.72rem semibold — eleven characters of ordinary mixed-case text,
 * set below the width actually measured to absorb the difference between an
 * `i` and a `W`.
 *
 * The label that interpolates PACK DATA is the passing one — the direction the
 * pack rotates — so this is enforced over every pack in
 * tests/interaction.test.js rather than eyeballed here.
 */
export const ACTION_LABEL_MAX_CHARS = 11;

/**
 * Everything a render needs to know about what is tappable, derived in one
 * place from the enumerated legal moves so the pile builders stay dumb:
 *   handSelectable  Set of hand card ids that respond to a tap
 *   handMulti       whether hand taps toggle membership or replace
 *   gathering       this seat is assembling a meld, so a HOLD on a hand card
 *                   gathers the group it belongs to. Deliberately narrower than
 *                   `handMulti`: Hearts' pass multi-selects into the same tray,
 *                   but no group stands behind a held card there, so the hold
 *                   keeps meaning "what is this card?"
 *   sourceTops      Map zoneAddress -> top card id, for piles whose top can
 *                   be picked up as a source (Stockpile's stock/discards)
 *   readyTargets    Map zoneAddress -> move to apply when that pile is tapped
 *   readyMelds      Map "seat:index" -> hit move for that meld chip
 *   action          { label, makeMove() } for the action button, or null
 */
export function buildUiModel(state, { seat, moves = [], acts = false, selection = null } = {}) {
  const mode = interactionMode(state);
  const handAddr = handAddress(seat);
  const ui = {
    mode,
    handSelectable: new Set(),
    handMulti: false,
    gathering: false,
    sourceTops: new Map(),
    readyTargets: new Map(),
    readyMelds: new Map(),
    action: null,
  };

  const hand = state.zones.cards(handAddr);
  const sel = selectedIds(selection);

  // OFF-TURN, ONE AFFORDANCE SURVIVES: arranging a meld you have not laid down.
  //
  // Everything else here answers "what may I do with my turn", and off-turn the
  // answer is nothing. Staging is not one of those things — it commits nothing,
  // touches no zone, and is the one job a contract-rummy player genuinely wants
  // to do while the bots think. Withdrawing it between turns also made the tray
  // flicker: the staged cards fell back into the fan the moment the turn passed
  // and jumped out again when it came back.
  //
  // `action` stays null, so Lay down remains a turn-only button (and is
  // re-checked against humanActs where it is rendered).
  //
  // ASK `gathers`, NOT THE MODE. The mode is derived from `turn.phase`, which is
  // the TABLE's phase and not this seat's, so "am I still assembling a meld?"
  // used to be answered with "is somebody, somewhere, past their draw?" — and
  // the affordance blinked out for the first half of every opponent's turn.
  if (!acts) {
    if (gathersOffTurn(state, seat)) {
      for (const id of meldStageable(state, seat, hand)) ui.handSelectable.add(id);
      ui.handMulti = true;
      ui.gathering = holdGathers(state, seat);
    }
    return ui;
  }

  if (mode === 'tap' || mode === 'play-drawn') {
    // Both dressings read the same enumerated moves; in 'play-drawn' the
    // template has already narrowed them to the one card that is live, so
    // nothing here has to know the rule to obey it.
    for (const move of moves) {
      if (move.type === 'playCard') ui.handSelectable.add(move.cards[0]);
    }

    if (mode === 'play-drawn') {
      // The whole answer to "how does a turn end after a draw": one button, in
      // the rail's thumb slot. No timeout, no auto-pass — and the pass is a
      // real move, so tapping it is logged and replays
      // (src/templates/shedding.js).
      const pass = moves.find((m) => m.type === 'pass');
      if (pass) ui.action = { label: 'Keep it', makeMove: () => ({ actor: seat, type: 'pass' }) };
      return ui;
    }

    // DRAWING IS A TURN OPTION, NOT A CONFESSION OF BEING STUCK. It used to be
    // offered only when nothing in hand was playable, which read as a helpful
    // hint and was in fact a missing rule: `mustPlayIfAble: false` — what both
    // shedding packs declare — means you may draw while holding a perfectly
    // good card, which is how you keep a wild for the turn it matters. The old
    // gate survives for a pack that really does compel a play, where the pile
    // lighting up IS the news that you have nothing.
    const draw = moves.find((m) => m.type === 'draw');
    if (draw && (state.pack.rules.mustPlayIfAble !== true || ui.handSelectable.size === 0)) {
      ui.readyTargets.set('draw', draw);
    }
    return ui;
  }

  if (mode === 'pass') {
    const count = state.pack.rules.passing?.count ?? 3;
    // WHICH WAY, ON THE BUTTON — AND THE COUNT MOVED TO THE STATUS BAR.
    // The dropped phase sentence ("Pick 3 cards to pass to the left") was
    // carrying both, and only one of them still needs saying HERE. Nothing on
    // the felt says the direction: the seats are drawn as a row, not a circle,
    // so it is not something a player can read off the table, and the button
    // is the last place it can live. The COUNT is different — this button only
    // exists once exactly that many cards are staged, and the tray beside it is
    // showing them — so what a player needs the count for is BEFORE the button
    // appears, which is why statusTextFor says "Passing — pick 3" instead
    // (src/ui/table.js).
    // Dropping it is also what makes the label fit: "Pass 3 across" wraps to
    // two lines in the rail and grows it past the fan; "Pass across" does not.
    const direction = { left: 'left', right: 'right', across: 'across' }[state.vars.passDirection] || '';
    for (const id of hand) ui.handSelectable.add(id);
    ui.handMulti = true;
    if (sel.length === count && selection.from === handAddr) {
      ui.action = {
        label: `Pass ${direction}`.trim(),
        makeMove: () => ({ actor: seat, type: 'passCards', cards: sel.slice() }),
      };
    }
    return ui;
  }

  if (mode === 'rummy-draw') {
    for (const move of moves) {
      if (move.type === 'draw') ui.readyTargets.set(move.from ?? 'draw', move);
    }
    return ui;
  }

  if (mode === 'rummy-meld') {
    const ctx = makeCtx(state);
    // A seat that is done gathering is not in a lesser version of this mode: its
    // whole hand is live (anything can hit a meld or be discarded) and a tap
    // means "this one", not "and this one too". Which of the two it is belongs
    // to the template — this used to read the `laidDown` playerVar, a
    // contract-rummy rule spelled out in platform code.
    const gathering = gathers(state, seat);
    for (const id of gathering ? meldStageable(state, seat, hand) : hand) ui.handSelectable.add(id);
    ui.handMulti = gathering;
    ui.gathering = gathering && holdGathers(state, seat);

    if (gathering) {
      // THE LAST SENTENCE TO GO, and the only one that was carrying two
      // things: "Contract: set of 3 + run of 4 — tap to gather, hold for a
      // meld". The contract half is on the felt already — the ladder beside
      // the piles draws every rung's requirement and marks the one this player
      // is standing on (src/ui/contractLadder.js) — so it was the felt's own
      // furniture, restated in words, in the row that cost the felt its
      // height. The hold half is a gesture no pixel announces; it is taught by
      // the pack's own "How to play" (src/ui/rules.js) and survives being
      // discovered by holding a card, which is what a long press does
      // everywhere else on this table anyway.
      if (sel.length && selection.from === handAddr && state.pack.template.arrangeContract) {
        const melds = state.pack.template.arrangeContract(ctx, seat, sel);
        if (melds) {
          ui.action = {
            label: 'Lay down',
            makeMove: () => ({ actor: seat, type: 'layDown', choice: { melds } }),
          };
        }
      }
    }

    if (sel.length === 1 && selection.from === handAddr) {
      const cardId = sel[0];
      for (const move of moves) {
        if (move.type === 'discard' && move.cards[0] === cardId && !ui.readyTargets.has('discard')) {
          // Enumerated targeted discards (a skip card) arrive with a concrete
          // choice.target baked in — one variant per victim. The tap must NOT
          // inherit one silently; the move handler sees the bare move and asks.
          ui.readyTargets.set('discard', { actor: move.actor, type: 'discard', cards: move.cards });
        }
        if (move.type === 'hit' && move.cards[0] === cardId) {
          // A wild enumerates once per value it could take on this meld — the
          // low end of a run and the high end are two different moves. Which
          // one the player meant is not something a tap on the meld says, so
          // the target keeps the BARE move and the move handler asks, exactly
          // as a wild's colour is asked for in shedding.
          const key = `${move.choice.seat}:${move.choice.meld}`;
          const already = ui.readyMelds.get(key);
          if (already) {
            ui.readyMelds.set(key, {
              actor: move.actor,
              type: 'hit',
              cards: move.cards.slice(),
              choice: { seat: move.choice.seat, meld: move.choice.meld },
            });
          } else {
            ui.readyMelds.set(key, move);
          }
        }
      }
    }
    return ui;
  }

  // mode === 'place' (sequencing)
  for (const move of moves) {
    if (move.type !== 'playCard' && move.type !== 'discard') continue;
    const from = move.from;
    if (from === handAddr) ui.handSelectable.add(move.cards[0]);
    else if (from) ui.sourceTops.set(from, move.cards[0]);
    if (sel.length === 1 && selection.from === (from ?? handAddr) && move.cards[0] === sel[0]) {
      ui.readyTargets.set(move.to, move);
    }
  }
  return ui;
}

/* ------------------------------------------------------------------ *
 * Fitting the contract ladder on one line
 * ------------------------------------------------------------------ */

/**
 * Which rungs of a contract ladder to draw, and which to collapse.
 *
 * Ten rungs do not fit across a phone, and the ladder wrapping to a second row
 * cost the felt a whole line of height — which is the line the hand needs. So
 * the ladder is TRUNCATED rather than wrapped.
 *
 * What it must still answer decides what is kept, in this order:
 *   - which contract am I on          → `minePhase`, never dropped
 *   - how long is the course          → the last rung
 *   - what am I racing toward next    → the rung after mine
 *   - where is everybody else         → occupied rungs, nearest rival first
 *   - where did we start              → the first rung
 * Everything after that collapses, and a run of collapsed rungs becomes one
 * marker that says how many it stands for.
 *
 * THE BUDGET IS A HARD CAP, because six players can stand on six different
 * rungs and no arrangement of ten rungs fits a phone. Collapsing somebody out
 * of sight is only acceptable because the caller draws the hidden players'
 * pips ON the marker that covers them — so "who is behind me" survives being
 * squeezed, at coarser resolution, instead of disappearing.
 *
 * Pure so the rule can be pinned in tests — same split as fanStep above.
 *
 * @param count     how many contracts the pack declares
 * @param minePhase the human's contract, 1-based, or null before a deal
 * @param occupied  every phase someone is standing on
 * @param maxRungs  how many rungs the felt has room for. Five is what a 375px
 *                  phone holds at the narrow breakpoint, measured rather than
 *                  guessed: a rung is ~40px, a marker ~16px, the flex gap
 *                  ~5px, and the row has ~348px. Five rungs with a marker
 *                  between each pair is the widest the ladder ever gets.
 * @returns [{ kind: 'rung', phase } | { kind: 'gap', from, to }]
 */
export function ladderRungs(count, { minePhase = null, occupied = [], maxRungs = 5 } = {}) {
  if (count <= 0) return [];
  // Room for the whole course: show the whole course. Truncation is a response
  // to a narrow screen, not something the ladder wants to do.
  if (maxRungs >= count) {
    return Array.from({ length: count }, (unused, i) => ({ kind: 'rung', phase: i + 1 }));
  }

  const priority = [];
  const want = (phase) => {
    if (phase >= 1 && phase <= count && !priority.includes(phase)) priority.push(phase);
  };
  if (minePhase) want(minePhase);
  want(count);
  if (minePhase) want(minePhase + 1);
  // Rivals nearest to you first: the player one rung ahead is the one you are
  // actually racing, and the one five behind is a detail.
  const anchor = minePhase || 1;
  [...occupied]
    .filter((phase) => phase !== minePhase)
    .sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor) || a - b)
    .forEach(want);
  want(1);

  const keep = new Set(priority.slice(0, Math.max(1, maxRungs)));

  const out = [];
  let gapFrom = null;
  for (let phase = 1; phase <= count; phase++) {
    if (keep.has(phase)) {
      if (gapFrom !== null) {
        out.push({ kind: 'gap', from: gapFrom, to: phase - 1 });
        gapFrom = null;
      }
      out.push({ kind: 'rung', phase });
    } else if (gapFrom === null) {
      gapFrom = phase;
    }
  }
  // `count` is always kept, so a gap can never be left open at the end.
  return out;
}

/* ------------------------------------------------------------------ *
 * Gathering a meld without tapping every card
 * ------------------------------------------------------------------ */

/**
 * The selection after asking the pack "what goes with this card?".
 *
 * A held card in a rummy hand is a question the RULES can answer — these two
 * other sevens are the set you are reaching for — and making the player pick
 * them out of a fan one sliver at a time is asking them to do by hand what the
 * pack already knows. So a long press gathers the group instead.
 *
 * UNIONED WITH WHAT IS ALREADY CHOSEN, never replacing it: a contract is
 * several items, so holding one card and then another builds "set of 3 + run
 * of 4" a group at a time. And this only ever produces a SELECTION —
 * `arrangeContract` in buildUiModel above is still the only thing that decides
 * a lay-down is legal, so a suggestion the contract cannot use simply leaves
 * the button unarmed rather than offering an illegal move.
 *
 * Pure, and null for every pack whose template has no opinion (the hook is
 * optional), for a seat with nothing left to assemble (`gathers`, which for
 * contract-rummy means it has laid its contract down), and when nothing in hand
 * fits — the caller's cue to do nothing rather than to guess.
 */
export function smartSelection(state, seat, cardId, selection) {
  const template = state.pack.template;
  if (typeof template.suggestMeld !== 'function') return null;
  if (!gathers(state, seat)) return null;

  const from = handAddress(seat);
  const keep = selection && selection.from === from ? selection.cardIds : [];
  // The already-gathered cards are spent: a contract's second item has to be
  // built from what the first left, or holding two cards can reach for the
  // same wild twice and produce a selection that lays down as nothing.
  const suggestion = template.suggestMeld(makeCtx(state), seat, cardId, { exclude: keep });
  if (!suggestion || !suggestion.cards?.length) return null;

  const merged = keep.slice();
  for (const id of suggestion.cards) if (!merged.includes(id)) merged.push(id);
  // Nothing new to show for the press — the group was already gathered.
  if (merged.length === keep.length) return null;
  return { from, cardIds: merged };
}

/* ------------------------------------------------------------------ *
 * Where a card can be dropped
 * ------------------------------------------------------------------ */

/**
 * The zone a played/discarded card visibly lands in when the move does not
 * name one — shedding's discard, a trick. This is the implicit destination
 * that makes one-tap play work, and the same one a dragged card falls onto.
 *
 * READ OFF THE ZONE DEFINITIONS, not probed by name. This used to try
 * 'discard', then 'trick', then 'discard' again, which is a template's layout
 * written out in platform code — and quietly wrong for any pack whose landing
 * pile is called something else. A zone declares `landing: 'play' | 'discard' |
 * 'both'` beside the rest of its definition (see each template's
 * defaultZones); zone-definition order breaks a tie, which is the order the
 * template listed them in.
 */
export function implicitLandingZone(state, move) {
  if (move.to) return move.to;
  const wanted = move.type === 'discard' ? 'discard' : 'play';
  for (const def of state.zones.defs.values()) {
    if (def.per === 'player') continue;
    if (def.landing !== wanted && def.landing !== 'both') continue;
    if (state.zones.has(def.id)) return def.id;
  }
  return null;
}

/**
 * Everywhere `source` could legally be dropped, as concrete moves.
 *
 * @param source { from, cardId } — the zone the card is being lifted out of
 *               and which card it is. `from` is the hand for a hand card, or a
 *               pile address for a pickable pile top.
 * @returns Array<{ kind: 'zone'|'meld', address?, meldKey?, move }> — EMPTY is
 *          a first-class answer, and the common one: a card with nothing legal
 *          to do still lifts and travels, it simply has nowhere to land, and
 *          the caller snaps it home. Exploration is free; commitment is
 *          validated.
 */
export function dropCandidates(state, { seat, moves = [], source }) {
  if (!source || !source.cardId) return [];
  const mode = interactionMode(state);
  const handAddr = handAddress(seat);
  const out = [];

  // 'play-drawn' rides the same branch on purpose: `moves` has already been
  // narrowed to the drawn card, so a dragged pre-draw card finds nothing here
  // and snaps home — the dead hand is enforced once, in the template.
  if (mode === 'tap' || mode === 'play-drawn') {
    for (const move of moves) {
      if (move.type !== 'playCard' || move.cards[0] !== source.cardId) continue;
      const address = implicitLandingZone(state, move);
      if (!address) continue;
      // A wild enumerates once per colour it could choose; the drop must not
      // silently inherit one, so the bare move goes forward and the move
      // handler asks the question a tap would also have asked.
      out.push({ kind: 'zone', address, move: { actor: seat, type: 'playCard', cards: [source.cardId] } });
      break;
    }
    return out;
  }

  // Passing is a commit-by-button phase; dragging inside the hand is
  // rearranging, and there is nowhere on the felt to drop a card yet.
  if (mode === 'pass' || mode === 'rummy-draw') return [];

  // Every other mode already expresses its destinations as readyTargets /
  // readyMelds once a single card is selected — so ask the model the same
  // question with this card standing in as the selection.
  const ui = buildUiModel(state, {
    seat,
    moves,
    acts: true,
    selection: { from: source.from ?? handAddr, cardIds: [source.cardId] },
  });
  for (const [address, move] of ui.readyTargets) {
    out.push({ kind: 'zone', address, move });
  }
  for (const [meldKey, move] of ui.readyMelds) {
    out.push({ kind: 'meld', meldKey, move });
  }
  return out;
}

/**
 * Cards the human may PICK UP, whether or not they have anywhere to go.
 *
 * Deliberately wider than `handSelectable`: the ask is that any face-up card
 * lifts. A card with no legal move is still draggable — it just snaps back —
 * and that is what makes the table feel like cards on felt rather than a form
 * with some fields disabled.
 *
 * @returns { hand: Set<cardId>, piles: Map<zoneAddress, cardId> }
 */
export function draggableSources(state, { seat, acts }) {
  const hand = new Set(state.zones.cards(handAddress(seat)));
  const piles = new Map();
  if (!acts) return { hand, piles };

  const mode = interactionMode(state);
  if (mode === 'place') {
    // Sequencing's own playable-from piles: the top card of each is a physical
    // card the player can pick up, so it drags even on a turn where nothing
    // will accept it.
    for (const kind of state.pack.rules.playableFrom || []) {
      if (kind === 'hand') continue;
      for (const address of state.zones.allAddresses()) {
        const zone = state.zones.get(address);
        if (zone.def.id !== kind || zone.seat !== seat) continue;
        const top = state.zones.top(address);
        if (top !== undefined) piles.set(address, top);
      }
    }
  }
  return { hand, piles };
}
