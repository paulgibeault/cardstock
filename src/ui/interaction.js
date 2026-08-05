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

export function handAddress(seat) {
  return `hand.${seat}`;
}

/**
 * How the human's taps are interpreted for the open pack — derived from the
 * template and the current phase, never stored:
 *   'tap'        one tap plays the card; the destination is implicit
 *                (shedding's discard, a trick).
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
  return 'tap';
}

export function selectedIds(selection) {
  return selection ? selection.cardIds : [];
}

export function isSelected(selection, from, cardId) {
  return !!selection && selection.from === from && selection.cardIds.includes(cardId);
}

/**
 * Drop a selection the state has moved out from under (rerender, resume).
 * Returns the selection to keep — `null` when it no longer describes real cards.
 */
export function pruneSelection(state, selection) {
  if (!selection) return null;
  if (!state.zones.has(selection.from)) return null;
  const inZone = state.zones.cards(selection.from);
  return selection.cardIds.every((id) => inZone.includes(id)) ? selection : null;
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
  if (!acts) return ui;

  const hand = state.zones.cards(handAddr);
  const sel = selectedIds(selection);

  if (mode === 'tap') {
    for (const move of moves) {
      if (move.type === 'playCard') ui.handSelectable.add(move.cards[0]);
    }
    // Drawing is offered only when there is nothing legal to play, which is
    // the rule these packs share — so the pile lighting up is itself the hint
    // that you are stuck, and no separate prompt has to say so.
    if (ui.handSelectable.size === 0) {
      const draw = moves.find((m) => m.type === 'draw');
      if (draw) ui.readyTargets.set('draw', draw);
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
    for (const id of hand) ui.handSelectable.add(id);
    ui.handMulti = !laidDown;

    if (!laidDown) {
      const contract = state.pack.rules.contracts?.[(state.playerVars[seat]?.phase ?? 1) - 1] || [];
      ui.hint = `Contract: ${contract.map(describeContractItem).join(' + ')} — select cards to lay down, or discard`;
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
          ui.readyMelds.set(`${move.choice.seat}:${move.choice.meld}`, move);
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

  if (mode === 'tap') {
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
