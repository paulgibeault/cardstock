// Drawing a pile, and drawing a meld.
//
// RENDERING IS ZONE-DRIVEN (design doc §3). Nothing here knows what a draw pile
// or a trick or a stock IS: every shared zone the pack declares gets a pile in
// the centre row, every per-player zone beyond the hand gets one in the human's
// row and a compact copy on each opponent's plate, and the zone DEFINITION
// carries the layout, label, facing and capacity the renderer needs.
//
// A pile is always a <button>. Whether it does anything this render is decided
// by the UI model — a ready target applies its move, a source top picks itself
// up, and a pile that does neither is simply disabled. Same element, same
// geometry, no relayout when a pile wakes up.
//
// LATE-BOUND HANDLERS, and that is the performance story. A pile asks the
// CURRENT UI model what it does at the moment it is clicked, instead of closing
// over the move that happened to be ready when it was built — which is what
// lets a selection change re-arm every pile in place (paintPileState) rather
// than rebuilding the whole table to change which ones glow (issue #6 §3).
//
// The pile's WORDS live in its accessible name and its inspector panel; what is
// printed on the felt is a count badge. src/ui/describe.js explains why the
// split is that way round and not the other.

import { line, svgNode } from './dom.js';
import { safeCssColor } from './css.js';
import { isSelected, describeContractItem } from './interaction.js';
import { describeZone, zoneAriaLabel, zoneBadge, cardName } from './describe.js';
import { handValue } from '../engine/scoring.js';
import { makeCtx } from '../engine/context.js';

/** How many discards stay visible under the top one. Enough to read as a pile. */
const DISCARD_DEPTH = 3;

/** §7b: this value reaches a class name, so it is an allow-list, not a passthrough. */
const OVERLAP_MODES = new Set(['horizontal', 'vertical']);

/**
 * How a zone's visible cards are laid out, from the pack's `ui.zoneOverlap`.
 *
 * PRESENTATION, so it lives in `ui` rather than in the engine's zone def: how
 * far a discard pile fans says nothing about the rules, and putting it in `ui`
 * means a variant can change it with a one-line manifest patch
 * (`"ui.zoneOverlap.discard": "vertical"`) instead of restating a whole zone
 * definition. Allow-listed on the way out — the value reaches a class name.
 */
function overlapFor(state, def) {
  const declared = state.pack.manifest.ui?.zoneOverlap?.[def.id];
  return OVERLAP_MODES.has(declared) ? declared : null;
}

// A stable pseudo-random tilt per card. Seeded from the id rather than
// Math.random() so a re-render — a resize, a settings change, a resumed match —
// puts every card back exactly where it was. A discard pile that reshuffles its
// own scatter on every repaint looks broken.
function tiltFor(cardId, spread) {
  let h = 0;
  for (let i = 0; i < cardId.length; i++) h = (h * 31 + cardId.charCodeAt(i)) | 0;
  return ((h % 1000) / 1000) * spread * 2 - spread;
}

/**
 * @param me          the seat lens (src/players/seats.js) — whose melds read as "Your"
 * @param session     () => the open session (selection and the live UI model)
 * @param art         () => the open match's card renderer
 * @param cardById    (state, id) => card
 * @param markEntry   (node, key) => node — the settle-in opt-in
 * @param onTarget    (move, node) => void — a pile that offers a move was tapped
 * @param onPickUp    (address, cardId) => void — a source top was tapped
 * @param onMeld      (meldKey, node) => void — a meld chip was tapped
 * @param attachInspector (node, describe, opts) => void
 * @param attachDrag  (node, handle) => void
 * @param isBusy      () => true while a drag owns the pointer
 * @param identityOf  (seat) => roster identity
 */
export function createZoneRenderer({
  me, session, art, cardById, markEntry,
  onTarget, onPickUp, onMeld, attachInspector, attachDrag, isBusy, identityOf,
}) {
  /**
   * Paint what a pile currently OFFERS: a place to put the selected card, a top
   * card to pick up, or nothing.
   *
   * Split out of buildPileNode because this is the only part of a pile that a
   * selection changes. Everything else about it — the cards, the depth cue, the
   * badge — is the same before and after, so re-running it in place is what lets
   * a tap on a hand card stop rebuilding the table (renderSelection).
   *
   * Reads the label off the node rather than the state: the accessible name's
   * subject is fixed by the zone, and only the verb in front of it moves.
   */
  function paintPileState(stack, ui) {
    const address = stack.dataset.zone;
    const ariaLabel = stack.dataset.zoneLabel || '';
    const target = ui.readyTargets.get(address) || null;
    const sourceTop = !target && ui.sourceTops.has(address) ? ui.sourceTops.get(address) : null;

    stack.classList.toggle('pile-stack--ready', !!target);
    stack.classList.toggle('pile-stack--source', !!sourceTop);
    stack.classList.toggle('pile-stack--picked', !!sourceTop && isSelected(session().selection, address, sourceTop));
    // The hint's pile — where the suggested move reaches for a card, or puts
    // one — painted here so a selection change re-arms it with the rest.
    stack.classList.toggle('pile-stack--hinted', !!session().hint?.zones?.has(address));

    if (target) {
      const verb = target.type === 'draw' ? 'Draw a card from'
        : target.type === 'discard' ? 'Discard to'
          : 'Play your selected card onto';
      stack.disabled = false;
      stack.setAttribute('aria-label', `${verb} ${ariaLabel}`);
    } else if (sourceTop) {
      stack.disabled = false;
      stack.setAttribute('aria-label', `${ariaLabel} Pick up the top card to play it.`);
    } else {
      stack.disabled = true;
      stack.setAttribute('aria-label', ariaLabel);
    }
  }

  /** The same, for a meld chip: whether the selected card extends this meld. */
  function paintMeldState(chip, ui) {
    const move = ui.readyMelds.get(chip.dataset.meld) || null;
    const label = chip.dataset.meldLabel || '';
    chip.classList.toggle('meld-chip--ready', !!move);
    chip.classList.toggle('meld-chip--hinted', session().hint?.meldKey === chip.dataset.meld);
    chip.disabled = !move;
    chip.setAttribute('aria-label', move ? `${label} Add your selected card.` : label);
  }

  /**
   * One pile on the felt, for any zone. Always a <button>: whether it does
   * anything this render is decided by the UI model (a ready target applies its
   * move, a source top picks itself up), and a pile that does neither is simply
   * disabled — same element, same geometry, no relayout when a pile wakes up.
   *
   * The pile's WORDS live in its accessible name and its inspector panel; what
   * is printed on the felt is a count badge (src/ui/describe.js explains why the
   * split is that way round and not the other).
   */
  function buildPileNode(state, inst, ui, { mini = false, draggableTop = null } = {}) {
    const { def, address } = inst;
    const cards = state.zones.cards(address);
    const count = cards.length;
    const wrap = document.createElement('div');
    wrap.className = `pile ${mini ? 'pile--mini' : ''}`;

    const stack = document.createElement('button');
    stack.type = 'button';
    stack.className = 'pile-stack';
    stack.dataset.zone = address;

    const target = ui.readyTargets.get(address) || null;
    const sourceTop = !target && ui.sourceTops.has(address) ? ui.sourceTops.get(address) : null;
    const isSpread = def.layout === 'spread';
    const faceDown = def.facing === 'down' || def.visibility === 'none';
    // A pile whose contract is "only the top card is public" must not leak the
    // ones under it. It used to draw DISCARD_DEPTH real faces for depth, which
    // showed Stockpile players the next three cards of everybody's discards.
    const secretUnder = def.visibility === 'top';
    const overlap = mini ? null : overlapFor(state, def);

    stack.classList.toggle('pile-stack--deep', count > 2);
    stack.classList.toggle('pile-stack--spread', isSpread && !mini);
    if (overlap) {
      stack.classList.add(`pile-stack--overlap-${overlap === 'vertical' ? 'v' : 'h'}`);
      // How many card-widths the slot RESERVES — a constant, not the count on
      // hand. See .pile-stack--overlap-v in table.css: a pile that resized as it
      // filled re-centred every other pile in its row on every discard.
      stack.style.setProperty('--overlap-slots', String(DISCARD_DEPTH - 1));
    }

    /** Place one card in the stack, carrying its index for the overlap offsets. */
    const placeCard = (markup, i, visibleCount, cardId, isTop) => {
      const node = svgNode(markup, `pile-stack__card ${isTop ? 'pile-stack__top' : ''}`);
      // Keyed by zone as well as card: the same card arriving in a DIFFERENT
      // pile has entered that pile, which is the moment worth animating.
      markEntry(node, `${address}:${cardId}`);
      node.style.setProperty('--stack-index', String(i - (visibleCount - 1) / 2));
      node.style.setProperty('--overlap-index', String(i));
      if (cardId) node.style.setProperty('--stack-tilt', `${tiltFor(cardId, isTop ? 2 : 5).toFixed(2)}deg`);
      stack.appendChild(node);
      return node;
    };

    let topNode = null;
    if (faceDown) {
      topNode = svgNode(count > 0
        ? art().back()
        : '<div class="card-face card-face--empty"></div>', 'pile-stack__top');
      // A face-down pile is one node whatever its depth, so the thing that
      // "enters" is the pile going from empty to not.
      markEntry(topNode, `${address}:down:${count > 0}`);
      stack.appendChild(topNode);
    } else if (isSpread && !mini) {
      // A trick is not a pile: every card in it is live information about who
      // played what, so it spreads and shows the whole trick.
      const visible = cards.slice(-state.seats);
      visible.forEach((cardId, i) => {
        const card = cardById(state, cardId);
        if (!card) return;
        const isTop = i === visible.length - 1;
        const node = placeCard(art().face(card), i, visible.length, cardId, isTop);
        node.style.setProperty('--stack-tilt', `${tiltFor(cardId, 7).toFixed(2)}deg`);
        if (isTop) topNode = node;
      });
      if (!visible.length) stack.appendChild(svgNode('<div class="card-face card-face--empty"></div>', 'pile-stack__top'));
    } else {
      // A face-up pile keeps a few cards of HISTORY under the top one, stacked —
      // a pile that only ever shows one card reads as a slide viewer. On a
      // top-visible pile that history is drawn as BACKS: the depth is public,
      // the cards are not.
      const depth = mini ? 1 : DISCARD_DEPTH;
      const visible = cards.slice(-depth);
      visible.forEach((cardId, i) => {
        const isTop = i === visible.length - 1;
        const card = cardById(state, cardId);
        if (!card) return;
        const markup = (!isTop && secretUnder) ? art().back() : art().face(card);
        const node = placeCard(markup, i, visible.length, cardId, isTop);
        if (isTop) topNode = node;
      });
      if (!visible.length) stack.appendChild(svgNode('<div class="card-face card-face--empty"></div>', 'pile-stack__top'));
    }

    stack.dataset.zoneLabel = zoneAriaLabel(state, inst);

    // LATE-BOUND, and bound unconditionally. The handler asks the current UI
    // model what this pile does at the moment it is clicked instead of closing
    // over the move that happened to be ready when it was built — which is what
    // lets a selection change re-arm every pile in place (paintPileState) rather
    // than rebuilding the whole table to change which ones glow.
    stack.addEventListener('click', () => {
      const ui = session()?.ui;
      if (!ui) return;
      const move = ui.readyTargets.get(address);
      if (move) {
        onTarget(move, stack);
        return;
      }
      const top = ui.sourceTops.get(address);
      if (top !== undefined) onPickUp(address, top);
    });
    paintPileState(stack, ui);

    // Any face-up top card the human owns lifts, whether or not it has anywhere
    // to go — a refused drop simply snaps home. That is the "cards on felt"
    // feel, and it is also how a player LEARNS what is legal.
    if (draggableTop && topNode) {
      attachDrag(topNode, { kind: 'pile', from: address, cardId: draggableTop });
    }

    attachInspector(stack, () => (session()?.state ? describeZone(session()?.state, inst) : null),
      { isBusy });

    wrap.appendChild(stack);
    if (!mini) {
      const badge = document.createElement('div');
      badge.className = 'pile-count';
      // The words moved to the accessible name and the inspector; what is left
      // on the felt is the number you actually watch.
      const { text: badgeText, kind, suit } = zoneBadge(state, inst);
      badge.textContent = badgeText;
      if (kind === 'match') {
        // THE SUIT IN FORCE IS NOT A PILE LABEL, so it does not get a pile
        // label's voice. It is the rule every hand at the table is playing to,
        // and after an eight it is the ONLY place that rule is written — the
        // card underneath shows the suit it was, not the suit it chose. Big
        // glyph, suit-inked, no pill. See .pile-count--match.
        badge.classList.add('pile-count--match');
        // dataset, and only for a suit describe.js recognised: a pack's own var
        // never reaches an attribute the stylesheet then matches on (§7b).
        if (suit) badge.dataset.suit = suit;
      }
      // The badge already carries the suit or the word for an active colour
      // (zoneBadge); this adds the swatch, and only in the case a card cannot
      // show for itself. Said aloud by describeZone's note, which reaches the
      // pile's own name.
      const active = activeMatchTint(state, address);
      if (active) {
        badge.classList.add('pile-count--active-match');
        if (active.tint) badge.style.setProperty('--active-tint', active.tint);
      }
      badge.setAttribute('aria-hidden', 'true');
      wrap.appendChild(badge);
    }
    return wrap;
  }

  /**
   * The colour the table is matching on when the top card cannot say it itself.
   *
   * There is exactly one case and it is the most consequential card in the game:
   * a wild sits on the discard showing no colour at all, while what every hand
   * now has to match is a value living in a var. zoneBadge already writes
   * the WORD there (describe.js) — this is what turns that word into something
   * readable at a glance, which for a colour is a swatch.
   *
   * Returns null when the top card carries the attribute itself, so the badge
   * stays a plain word on an ordinary play and the swatch means "a wild chose
   * this" rather than merely "this pile is a discard".
   */
  function activeMatchTint(state, address) {
    // The template answers what the table is matching on and whether the top card
    // can show it for itself (`onCard`) — this file used to rebuild the
    // `active${Attr}` var name and probe the discard by name.
    const match = state.pack.template.activeMatch?.(makeCtx(state));
    if (!match || match.address !== address || match.onCard) return null;
    // Through the pack's palette and safeCssColor: pack data reaching a style
    // property (§7b). A pack with no palette entry for this value still gets
    // the word, just without the dot.
    //
    // `cardArt.theme.palette`, not `cardArt.palette` — the renderer exposes its
    // resolved theme, and the shorter spelling was undefined, so this swatch
    // never once appeared. Same typo, same silent nothing, in flashFelt.
    return { attr: match.attr, value: match.value, tint: safeCssColor(art().theme.palette?.[match.value]) };
  }

  // The template's own grouping, asked for rather than re-derived: this used to
  // be a copy of contract-rummy's getMeldGroups fallback whose comment admitted
  // it was a copy, which is exactly how two answers to "what are this seat's
  // melds" start to disagree.
  function meldGroupsOf(state, seat) {
    return state.pack.template.getMeldGroups?.(makeCtx(state), seat) || [];
  }

  /**
   * How a card in a laid-down meld reads.
   *
   * A wild on the felt is not a wild any more — it is the card it was played
   * as, and the meld records which (`group.wilds`). Saying so is the difference
   * between a run a player can read and one they have to reconstruct, and it is
   * the only place the frozen value is visible: the card art still shows a wild,
   * because that is the card that will go back in the box.
   */
  function meldCardName(group, cardId, card) {
    const pinned = group.wilds?.[cardId];
    const value = pinned?.rank ?? pinned?.color;
    return value === undefined ? cardName(card) : `${cardName(card)} — played as ${value}`;
  }

  /**
   * A seat's laid-down melds as chips — the hit targets, and the single most
   * useful piece of public information on the table.
   *
   * Each chip carries the cards AND a caption naming the requirement they
   * satisfied. The cards alone cannot say that: three 7s and three 7s are two
   * different rungs of the ladder depending on the contract that asked for them,
   * and an opponent's laid-down phase is exactly what you plan your own turn
   * around.
   */
  function buildMeldStrip(state, seat, ui, { mini = false } = {}) {
    const strip = document.createElement('div');
    strip.className = `meld-strip ${mini ? 'meld-strip--mini' : ''}`;
    strip.dataset.zone = `melds.${seat}`;
    const groups = meldGroupsOf(state, seat);
    const owner = me.holds(seat) ? 'Your' : `${identityOf(seat).name}'s`;

    groups.forEach((group, i) => {
      const meldKey = `${seat}:${i}`;
      const move = ui.readyMelds.get(meldKey) || null;
      const what = group.item ? describeContractItem(group.item) : 'meld';

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'meld-chip';
      chip.dataset.meld = meldKey;

      const cards = document.createElement('span');
      cards.className = 'meld-chip__cards';
      for (const cardId of group.cards) {
        const card = cardById(state, cardId);
        if (card) cards.appendChild(svgNode(art().face(card), 'meld-chip__card'));
      }
      chip.appendChild(cards);
      chip.appendChild(line('meld-chip__label', what));

      chip.dataset.meldLabel = `${owner} ${what}, ${group.cards.length} cards.`;
      // Late-bound for the same reason the piles are — see paintPileState.
      chip.addEventListener('click', () => onMeld(meldKey, chip));
      paintMeldState(chip, ui);

      // Reading a meld card by card is the thing a squeezed strip made
      // impossible, so the inspector spells the whole thing out.
      attachInspector(chip, () => ({
        title: `${owner} ${what}`,
        lines: group.cards
          .map((cardId) => ({ cardId, card: cardById(state, cardId) }))
          .filter((entry) => entry.card)
          .map((entry, n) => ({
            label: `Card ${n + 1}`,
            value: meldCardName(group, entry.cardId, entry.card),
          })),
        notes: move ? ['Your selected card extends this meld — tap to play it.'] : [],
      }), { isBusy });

      strip.appendChild(chip);
    });
    return strip;
  }
  return { buildPileNode, buildMeldStrip, paintPileState, paintMeldState, meldGroupsOf };
}
