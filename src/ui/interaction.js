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
 * How the human's taps are interpreted for the open pack — derived from the
 * template and the current phase, never stored:
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
 */
export function interactionMode(state) {
  const id = state.pack.template.id;
  if (id === 'trick-taking') return state.turn.phase === 'pass' ? 'pass' : 'tap';
  if (id === 'contract-rummy') return state.turn.phase === 'draw' ? 'rummy-draw' : 'rummy-meld';
  if (id === 'sequencing') return 'place';
  if (id === 'shedding' && state.turn.phase === 'playDrawn') return 'play-drawn';
  return 'tap';
}

/**
 * Could ANYBODY be gathering cards in this phase?
 *
 * Deliberately not "may the human gather cards right now" — that is
 * `ui.handMulti`, and it flips as the turn moves. This is the question the
 * staging tray's SLOT is reserved on, so it has to be stable across a turn
 * change or the felt moves under the hand every time one happens (#13). A
 * rummy turn is draw-then-meld, so both of its modes answer yes; a trick game
 * only stages while the pass is open; a shedding game never does.
 */
export function stagingPhase(state) {
  const mode = interactionMode(state);
  return mode === 'pass' || mode === 'rummy-draw' || mode === 'rummy-meld';
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

export function describeContractItem(item) {
  const m = /^(\w+)\((\d+)\)$/.exec(item || '');
  if (!m) return item;
  if (m[1] === 'set') return `set of ${m[2]}`;
  if (m[1] === 'run') return `run of ${m[2]}`;
  if (m[1] === 'colorGroup') return `${m[2]} of one color`;
  return item;
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
  const letter = { set: 'S', run: 'R', colorGroup: 'C' }[m[1]];
  return letter ? `${letter}${m[2]}` : String(item);
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

/**
 * How long a hint may be before it costs the felt a line.
 *
 * The action bar reserves TWO lines of text (src/ui/table.css) and the table
 * below it is laid out around that reservation, so a hint that wraps to three
 * pushes the deck, the discard and the hand down the screen — the shift #13
 * fixed, coming back through the words rather than through the box (#17).
 *
 * Two budgets because the action button eats the width the words would have
 * used: a hint standing beside a "Lay down" gets barely two thirds of the row.
 * Both are MEASURED at 360x780, the narrowest phone the felt is designed for —
 * at 66 and 90 the sample sentences fill two lines, a few characters further
 * they spill onto a third.
 *
 * Characters are a proxy for pixels and a coarse one: they hold because every
 * hint is ordinary lower-case prose, and the numbers above are set below the
 * widths actually measured to absorb the difference between an `i` and a `W`.
 * A hint that wants capitals or digits en masse should be measured in a
 * browser rather than counted.
 *
 * Enforced by tests/interaction.test.js over every pack, because the one hint
 * that interpolates PACK DATA — the contract sentence — is the one a future
 * pack could lengthen without anyone touching this file.
 */
export const HINT_MAX_CHARS = 66;
/** …and what a hint gets when it has the row to itself. */
export const HINT_MAX_CHARS_BARE = 90;

/**
 * Everything a render needs to know about what is tappable, derived in one
 * place from the enumerated legal moves so the pile builders stay dumb:
 *   handSelectable  Set of hand card ids that respond to a tap
 *   handMulti       whether hand taps toggle membership or replace
 *   sourceTops      Map zoneAddress -> top card id, for piles whose top can
 *                   be picked up as a source (Stockpile's stock/discards)
 *   readyTargets    Map zoneAddress -> move to apply when that pile is tapped
 *   readyMelds      Map "seat:index" -> hit move for that meld chip
 *   action          { label, makeMove() } for the action button, or null
 *   hint            the action bar's text
 */
export function buildUiModel(state, { seat, moves = [], acts = false, selection = null } = {}) {
  const mode = interactionMode(state);
  const handAddr = handAddress(seat);
  const ui = {
    mode,
    handSelectable: new Set(),
    handMulti: false,
    sourceTops: new Map(),
    readyTargets: new Map(),
    readyMelds: new Map(),
    action: null,
    hint: '',
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
  if (!acts) {
    if (mode === 'rummy-meld' && !state.playerVars[seat]?.laidDown) {
      for (const id of meldStageable(state, seat, hand)) ui.handSelectable.add(id);
      ui.handMulti = true;
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
      // the bar that already holds exactly one hint and one button. No timeout,
      // no auto-pass — and the pass is a real move, so tapping it is logged and
      // replays (src/templates/shedding.js).
      ui.hint = 'Play the card you drew, or keep it';
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
    ui.hint = 'Your turn';
    return ui;
  }

  if (mode === 'pass') {
    const count = state.pack.rules.passing?.count ?? 3;
    const direction = { left: 'to the left', right: 'to the right', across: 'across' }[state.vars.passDirection] || '';
    for (const id of hand) ui.handSelectable.add(id);
    ui.handMulti = true;
    ui.hint = `Pick ${count} cards to pass ${direction}`.trim();
    if (sel.length === count && selection.from === handAddr) {
      ui.action = {
        label: `Pass ${count} cards`,
        makeMove: () => ({ actor: seat, type: 'passCards', cards: sel.slice() }),
      };
    }
    return ui;
  }

  if (mode === 'rummy-draw') {
    for (const move of moves) {
      if (move.type === 'draw') ui.readyTargets.set(move.from ?? 'draw', move);
    }
    ui.hint = ui.readyTargets.has('discard')
      ? 'Draw from the deck or the discard pile'
      : 'Draw from the deck';
    return ui;
  }

  if (mode === 'rummy-meld') {
    const ctx = makeCtx(state);
    const laidDown = state.playerVars[seat]?.laidDown;
    for (const id of laidDown ? hand : meldStageable(state, seat, hand)) ui.handSelectable.add(id);
    ui.handMulti = !laidDown;

    if (!laidDown) {
      const contract = state.pack.rules.contracts?.[(state.playerVars[seat]?.phase ?? 1) - 1] || [];
      // TWO CLAUSES, BOTH EARNING THEIR WORDS. The contract is what a
      // contract-rummy player most needs on screen — it is the whole shape of
      // the turn — and the hold is the fastest way to build a meld with
      // nothing else on the felt to say it is there. What went is the padding
      // around them: this used to run "tap cards to gather them, hold one to
      // gather its whole meld, or discard", which wrapped to FOUR lines on a
      // 360px phone and grew the action bar by ~30px on most Milestones turns
      // — the table-shifting bug of #13 surviving inside the fix for it (#17).
      // The discard clause is the one that went: the discard pile lights up as
      // a target on its own, so it was the sentence explaining the affordance
      // the felt was already showing.
      // Keep it inside two lines — see the reserved slot in src/ui/table.css
      // and the budget test in tests/interaction.test.js.
      ui.hint = `Contract: ${describeContract(contract)} — tap to gather, hold for a meld`;
      if (sel.length && selection.from === handAddr && state.pack.template.arrangeContract) {
        const melds = state.pack.template.arrangeContract(ctx, seat, sel);
        if (melds) {
          ui.action = {
            label: 'Lay down',
            makeMove: () => ({ actor: seat, type: 'layDown', choice: { melds } }),
          };
        }
      }
    } else {
      ui.hint = 'Hit any meld with a matching card, or discard to end your turn';
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
  if (!sel.length) ui.hint = 'Play from your stock, hand, or discard piles';
  else if (selection.from === handAddr) ui.hint = 'Tap a build pile to play it — or one of your discard piles to end your turn';
  else ui.hint = 'Tap a build pile to play it';
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
 * optional), for a seat that has already laid down, and when nothing in hand
 * fits — the caller's cue to do nothing rather than to guess.
 */
export function smartSelection(state, seat, cardId, selection) {
  const template = state.pack.template;
  if (typeof template.suggestMeld !== 'function') return null;
  if (state.playerVars[seat]?.laidDown) return null;

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
 */
export function implicitLandingZone(state, move) {
  if (move.to) return move.to;
  if (move.type === 'discard' && state.zones.has('discard')) return 'discard';
  if (state.zones.has('trick')) return 'trick';
  if (state.zones.has('discard')) return 'discard';
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
