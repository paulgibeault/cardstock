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
import { describeZone, zoneAriaLabel, zoneBadge, zoneFocusOf, cardName } from './describe.js';
import { seatSideMarks } from './seatRing.js';
import { handValue } from '../engine/scoring.js';
import { makeCtx } from '../engine/context.js';
// A ui/ file reaching into templates/ the way lobby.js and cardStyles/ already
// reach for templates/registry.js: melds.js is leaf logic (it imports only
// engine/), so there is no cycle, and the alternative — hanging a display hook
// off the template object — would put a purely visual concern in the rules
// surface every future melding pack has to implement.
import { meldDisplayOrder } from '../templates/melds.js';

/** How many discards stay visible under the top one. Enough to read as a pile. */
const DISCARD_DEPTH = 3;

/**
 * The fewest cards a SPREAD shows, whatever the table's size.
 *
 * A spread used to show `state.seats` cards, because the only spread that
 * existed was a trick and a trick is one card per seat. Cribbage's `play` pile
 * is a spread that is not a trick: it is one seat's four cards, laid down over
 * a whole hand, and at a two-handed table `slice(-2)` hid the first two of them
 * the moment the third went down — so the sequence you are supposed to be
 * counting to thirty-one off was unreadable by the time it mattered (#124,
 * item 38).
 *
 * Four rather than "all of them": `.pile-stack--spread` reserves a fixed box
 * (2.11 card widths, which is exactly four cards at the 0.51 overlap) and a
 * pile that grew its own slot would shove every neighbour sideways each time a
 * card landed — the same rule the overlap slots are fixed for. Climbing's
 * shared `pile` is a spread with no bound at all, and it keeps the old
 * behaviour because `Math.max` leaves any table of four or more exactly where
 * it was.
 */
const SPREAD_MIN = 4;

/** The most cards a spread pile draws at once — the slot is a fixed place. */
const SPREAD_MAX = 6;

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
      // THE VERB IS THE MOVE'S, NOT THE MODE'S — a pile says what tapping it
      // does. `takeHand` takes the whole pile as your hand, which is the one
      // target here that is not about a card you are already holding, so
      // "Play your selected card onto Hand 2" would have been exactly wrong.
      const verb = target.type === 'draw' ? 'Draw a card from'
        : target.type === 'discard' ? 'Discard to'
          : target.type === 'takeHand' ? 'Take'
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
   * Who played each of the cards currently visible in a spread zone, or null
   * where the template does not say (which is every zone but a trick, and every
   * template but trick-taking).
   *
   * Aligned to the SLICE the fan is drawing, not to the zone: the fan shows the
   * last `seats` cards and the hook answers for the whole zone, so the tail has
   * to be taken from both or a five-card zone would label card 0 with card 1's
   * player. There is no such zone today; getting it right costs one line.
   */
  function ownersOf(state, address, cards, visibleCount) {
    const all = state.pack.template.zoneCardOwners?.(makeCtx(state), address) ?? null;
    if (!Array.isArray(all) || all.length !== cards.length) return null;
    return all.slice(-visibleCount);
  }

  /**
   * The tag under one card in the trick — whose card it is.
   *
   * THE ROSTER'S MARK, the same one the seat plate wears and the chooser's seat
   * options use, in the same colour — so "this is a player" is one vocabulary
   * wherever it turns up and the tag is read by matching it to a chair rather
   * than by reading anything.
   *
   * THE MARK AND NOT THE NAME, which was the first cut and does not fit. The
   * fan overlaps by half a card, so the strip each tag may occupy without
   * reaching under its neighbour is half a card wide — 45px on a desktop and 26
   * at 375px. A name in that is two letters and an ellipsis, which identifies
   * nobody; the coloured mark identifies everybody at every width. The NAME is
   * on the pile's accessible name in play order (see buildPileNode).
   *
   * AND WHICH SIDE, because that is the question actually being asked. A tag
   * that only said which player would leave a partnership player one lookup
   * short of "is my side winning this" — so the rim carries the partner colour
   * the seat plate's bottom rule already uses (seatSideMarks), and the accent
   * for their own card.
   *
   * A SIBLING OF THE CARDS, not a child of one: the card nodes carry a small
   * random rotation (--stack-tilt) and a caption inside one would inherit it,
   * so a trick of four would be four tags at four angles.
   */
  function ownerTag(state, seat, i, visibleCount) {
    const identity = identityOf(seat);
    const marks = seatSideMarks(state.pack, state.seats, me.seat(), seat);
    const tag = document.createElement('span');
    tag.className = `trick-owner ${me.holds(seat) ? 'trick-owner--mine' : ''} `
      + `${marks.partner ? 'trick-owner--partner' : ''}`;
    tag.style.setProperty('--stack-index', String(i - (visibleCount - 1) / 2));
    // A number the STYLESHEET may dress, chosen by the engine and never by pack
    // data (§7b) — the same attribute the seat plate carries.
    if (marks.side !== null) tag.dataset.side = String(marks.side);
    // Own value from the roster, never a manifest one — inline style (§7b).
    tag.style.background = identity.color;
    tag.textContent = identity.icon || identity.initials;
    // Decorative: the pile's own accessible name says who played what, in play
    // order, and a second rendering of it here would read every trick twice.
    tag.setAttribute('aria-hidden', 'true');
    return tag;
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
    // Who played which card in a spread zone, and the same fact as a sentence
    // for the pile's accessible name — set inside the spread branch below,
    // because it is the only one where "who played this" is a question.
    let owners = null;
    let spokenOrder = null;
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
      //
      // BUT NOT EVERY CARD IN IT IS STILL LIVE. Where the template names a focus
      // — climbing's standing combination — the cards that are no longer the
      // thing to answer are drawn as history behind it, and the ones that are
      // get the same ring the hint uses to point at them. The hint was already
      // the only thing on the felt that said which cards you were beating
      // (#122, round-5 item 25); this makes that the default rather than
      // something you have to ask for.
      const focus = zoneFocusOf(state, address);
      const live = focus ? new Set(focus.cards) : null;
      // Enough room for one card per seat, and never less than the standing
      // combination itself — a five-consecutive-pairs bomb is ten cards, and the
      // pile that is asking you to beat it may not be showing half of it.
      // Capped, because the slot is a fixed place on the table (see
      // .pile-stack--spread) and not a box that grows.
      // ...and never fewer than SPREAD_MIN, which is what a cribbage play pile
      // needs at a two-handed table (#124) — the two bounds compose.
      const visible = cards.slice(-Math.min(SPREAD_MAX, Math.max(state.seats, SPREAD_MIN, live ? live.size : 0)));
      // AND IT SAYS WHO, WHICH IT DID NOT. "Live information about who played
      // what" was half true: the cards were all there and the WHO was nowhere,
      // so reading the trick meant remembering the play order — and at a
      // partnership table the question is not "who is winning" but "is my SIDE
      // winning", which is one step further from anything on screen (#125 item
      // 52). The template answers it (`zoneCardOwners`); this draws it.
      owners = ownersOf(state, address, cards, visible.length);
      spokenOrder = owners ? visible.map((id, i) => {
        const card = cardById(state, id);
        const seat = owners[i];
        if (!card || !Number.isInteger(seat)) return null;
        return `${me.holds(seat) ? 'You' : identityOf(seat).name}: ${cardName(card)}`;
      }).filter(Boolean) : null;
      // THE TAGS GO ON LAST, all of them, and that is not tidiness. Every child
      // of .pile-stack is absolutely placed at the same z-index, so paint order
      // is source order: a tag appended beside its own card is painted UNDER
      // the next card, and in a fan that overlaps by half that is every tag but
      // the last one buried.
      const tags = [];
      visible.forEach((cardId, i) => {
        const card = cardById(state, cardId);
        if (!card) return;
        const isTop = i === visible.length - 1;
        const node = placeCard(art().face(card), i, visible.length, cardId, isTop);
        node.style.setProperty('--stack-tilt', `${tiltFor(cardId, 7).toFixed(2)}deg`);
        if (live) node.classList.add(live.has(cardId) ? 'pile-stack__card--live' : 'pile-stack__card--spent');
        const owner = owners ? owners[i] : null;
        if (Number.isInteger(owner)) tags.push(ownerTag(state, owner, i, visible.length));
        if (isTop) topNode = node;
      });
      for (const tag of tags) stack.appendChild(tag);
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

    // THE TAGS ON THE FELT ARE aria-hidden, so this is where the same fact
    // reaches a screen reader: the pile's own name, in play order, which is the
    // order it is read out in. Without it the trick's owners would be a purely
    // visual answer to a question the felt is being asked to stop hiding.
    stack.dataset.zoneLabel = zoneAriaLabel(state, inst)
      + (spokenOrder?.length ? ` Played: ${spokenOrder.join(', ')}.` : '');

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
      // THE NAME STAYS, and the number joins it. A pile that dropped its own
      // word the moment a card landed left two spread stacks in the middle of a
      // Thirteen table wearing nothing but `2` and `28` (#122 item 18) — so the
      // badge is now the pile's word with the count after it, and a pile the
      // template gives a FOCUS to wears the focus's words instead, because there
      // the number is the trick and the words are the play.
      const { text: badgeText, kind, suit, name } = zoneBadge(state, inst);
      if (name && (kind === 'count' || kind === 'focus')) {
        badge.appendChild(line('pile-count__name', name));
        badge.appendChild(line('pile-count__value', badgeText));
      } else {
        badge.textContent = badgeText;
      }
      if (kind === 'focus') badge.classList.add('pile-count--focus');
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

      // Sorted for reading, once, and used by BOTH the chip and its inspector
      // below — a run drawn `3 W 5 6` whose inspector still numbered it `6 3 W 5`
      // would make "Card 2" name a card that is not second on the felt, which is
      // worse than either order on its own. See meldDisplayOrder: the stored
      // array is match state and is deliberately left as the engine wrote it.
      const ordered = meldDisplayOrder(makeCtx(state), group);

      const cards = document.createElement('span');
      cards.className = 'meld-chip__cards';
      for (const cardId of ordered) {
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
        lines: ordered
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
