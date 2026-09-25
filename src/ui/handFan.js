// THE HUMAN'S OWN HAND: the fan, the tray the gathered cards sit in, and the
// arrangement the player has chosen for both.
//
// Carved out of src/ui/table.js (#223, seam 3), which resolves 43 DOM ids at
// import time and therefore cannot be loaded by `node --test`. That is the whole
// reason this file takes `el`, `session` and the rest as PARAMETERS: where a
// card dropped on a two-row fan lands, what leaving the manual order keeps, and
// how much of the row the fan may spend are decisions a Node test should be able
// to ask about, and for as long as they lived beside that element table nothing
// could call them (tests/handFan.test.js now does).
//
// THE PURE MATH IS NOT HERE. How far apart the cards sit, how many rows a hand
// takes, which cards go in which row and what a sort puts first are all in
// src/ui/handOrder.js and are tested there. This file is the DOM side of those
// answers — it takes the three measurements they are decided on, moves the
// cards, and writes two custom properties — plus the listeners that ask again
// when the room changes.
//
// So the split runs along "does this need the screen":
//
//   - MODULE SCOPE, pure: how coarsely the felt's spare height is read
//     (`SLACK_STEP`), which row a release point belongs to (`nearestRow`), and
//     the Enter/Space activation both rows of cards share (`activateOnKey`).
//   - `createHandFan(deps)`: everything that builds, measures or rearranges —
//     the tray, the fan, the fit, the row split, the width observer, the
//     reorder a drop implies, the sort toggle, and the flight between the fan
//     and the tray.
//
// WHAT THE FAN OWNS ON SCREEN, which is what the observer and the listeners are
// about: `#hand` and its `.hand__row`s, `#stage-tray` and its row, and the
// word on `#hand-sort`. Whether the sort toggle is SHOWN is the rail's
// (`renderRail`, still in table.js), and so is the repaint that only relights a
// selection (`renderSelection`), which reaches into both rows without
// rebuilding either.

import { rankLadderOf } from '../engine/cards.js';
import { svgNode } from './dom.js';
import { attachInspector } from './inspector.js';
import { describeCard, cardAriaLabel } from './describe.js';
import { gathers, stagedSelection, isSelected, handAddress } from './interaction.js';
import {
  orderHand, reorder, nextMode, isSortMode, fanStep, fanWidth, liftGap,
  fanLayout, handRows, resolveCardWidth, SORT_LABELS,
} from './handOrder.js';
import { flyCard, motionAllowed, rectOf } from './flight.js';
import { saveHandPrefs } from '../arcade/storage.js';

/**
 * How coarsely the felt's spare height is read when deciding the row count.
 *
 * Fine enough that gaining or losing a row of cards (70-odd px) is always a new
 * answer, coarse enough that a score chip growing a digit is not.
 */
const SLACK_STEP = 16;

/** The row `clientY` is in, or — above or below the fan — the closest one. */
export function nearestRow(rows, clientY) {
  let best = rows[0];
  let gap = Infinity;
  for (const row of rows) {
    const distance = clientY < row.rect.top ? row.rect.top - clientY
      : clientY > row.rect.bottom ? clientY - row.rect.bottom : 0;
    if (distance < gap) { gap = distance; best = row; }
  }
  return best;
}

/**
 * Enter or Space on a focused card does what a tap on it does.
 *
 * ONE COPY FOR BOTH ROWS. The tray and the fan each spelled this out (#223's
 * "keyboard activation" pair), and the default is prevented whether or not the
 * card acts — Space on a card you cannot play must not scroll the felt out from
 * under the focus ring either. What a key press MEANS stays the caller's: the
 * fan passes an `activate` that checks the card is selectable first.
 */
export function activateOnKey(node, activate) {
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  });
}

/**
 * The fan and the tray, handed what they read.
 *
 * `session`, `drag` and `gestures` are THUNKS, not values: all three are
 * reassigned by table.js after this is constructed (a match opens, `initTable`
 * builds the drag controller and the gesture watcher further down), so each is
 * read at the moment it is needed, the way src/ui/seatRow.js reads `session`.
 *
 * @param deps.el                    table.js's element table; this reads
 *                                   `hand`, `handRow`, `handRail`, `handSort`,
 *                                   `stageRow`, `stageTray`, `feltMiddle`,
 *                                   `screen` and `log`
 * @param deps.session               () => the live session, or null
 * @param deps.drag                  () => the drag controller, or null
 * @param deps.gestures              () => the hand-gesture watcher, or null
 * @param deps.onHandCard            what a tap on a card in either row does
 *                                   (table.js's, because it can play a move)
 * @param deps.render                the whole-felt render a reorder or a sort
 *                                   ends in
 */
export function createHandFan({
  el, session, drag, gestures, mySeat, liveState, livePack, render, cardById,
  art, hintedCard, markEntry, committedSelectionOf, onHandCard,
}) {
  /** The tray's contents for the seat at this device — the rule is in interaction.js. */
  function stagedIds(state) {
    return stagedSelection(state, mySeat(), session().selection);
  }

  /**
   * The gathered cards, at readable size, in the order they were picked.
   *
   * This is the answer to "assembling a meld on a phone is too cramped": a
   * ten-card fan gives each card a strip about as wide as a fingertip is
   * accurate, and picking a fourth card out of it after three are already
   * chosen means hitting a sliver whose neighbours look the same. Staged cards
   * LEAVE the fan, so every pick makes the next one easier — the fan re-fans
   * wider on its own — and the meld you have built so far is shown as cards
   * rather than as highlights buried in the row you are trying to read.
   *
   * The tray owns no state. It renders `selection`, and tapping a card in it
   * runs the same toggle a tap in the fan runs.
   */
  function renderStageTray(state, ui) {
    const staged = stagedIds(state);
    // THE SLOT BELONGS TO THE SEAT'S STANDING IN THE ROUND, the contents to the
    // human. Gating the row itself on `ui.handMulti` meant it left the felt's
    // flex column every time the answer changed — twice a turn in contract rummy,
    // once the bots start drawing and melding — and took a card's height of table
    // with it (#13). A pack that never stages still gets no row at all.
    //
    // `gathers` moves the felt ONCE PER ROUND, at the moment the player lays
    // down, and that is not the case #13 was about: the bug there was a strip
    // flickering twice a turn for a whole match. Holding the slot after a
    // lay-down bought nothing — the row is `opacity: 0; visibility: hidden` and
    // inert (src/ui/css/felt.css) — while a card's height of dead felt sat between
    // the meld chips and the hand for the rest of the round, which is what a
    // playtester saw. The board has just changed underneath the player anyway:
    // their melds have arrived in #player-piles, and this is the space they take.
    el.stageRow.hidden = !gathers(state, mySeat());
    // Empty and inert follow WHAT IS IN THE TRAY, not what mode the turn is in.
    // Keyed on `ui.handMulti` these disagreed with the tray's own contents the
    // moment stagedIds stopped asking that question — the row would go inert
    // while still holding cards the player could tap to put back.
    el.stageRow.classList.toggle('stage-row--empty', !staged.length);
    el.stageRow.inert = !staged.length;
    el.stageTray.replaceChildren();
    if (!staged.length) {
      el.stageTray.classList.remove('stage-tray--refused');
      el.stageTray.setAttribute('aria-label', 'Gathered cards appear here.');
      return;
    }
    // THE TRAY SAYS NO. A selection the engine will not take used to sit here
    // looking exactly like one it would — same dashed tray, same cards, no
    // commit, no sentence (#122, round-5 item 19). The refusal is drawn on the
    // tray itself, spoken in the tray's own name, and written to #log, which is
    // the live region this table already uses for the words that are not on the
    // felt (see showHint).
    const refusal = ui.action?.disabled ? (ui.action.refusal || 'That is not a play.') : null;
    el.stageTray.classList.toggle('stage-tray--refused', !!refusal);
    if (refusal && session().lastRefusal !== refusal) el.log.textContent = refusal;
    session().lastRefusal = refusal;
    el.stageTray.setAttribute('aria-label', refusal
      ? `Gathered: ${staged.length} cards. ${refusal} Tap one to put it back.`
      : `Gathered: ${staged.length} cards. Tap one to put it back.`);
    for (const cardId of staged) {
      const card = cardById(state, cardId);
      if (!card) continue;
      const node = svgNode(art().face(card), `stage-card ${hintedCard(cardId) ? 'card-face-wrap--hinted' : ''}`);
      node.dataset.cardId = cardId;
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      node.setAttribute('aria-label', `${cardAriaLabel(card, state.pack)} Gathered. Tap to put it back.`);
      const putBack = () => onHandCard(state, cardId, card, node, ui);
      node.addEventListener('click', putBack);
      activateOnKey(node, putBack);
      attachInspector(node, () => describeCard(card, state.pack),
        { isBusy: () => !!drag() && drag().isDragging() });
      el.stageTray.appendChild(node);
    }
  }

  function renderHand(state, ui, stagger, draggable) {
    // ONE ROW TO BUILD INTO, and layoutHand splits it if the fan needs splitting
    // (#134). Deciding the row count here would mean measuring before the cards
    // exist; deciding it there means one place owns the answer, and because both
    // run in the same task nothing is painted in between.
    const firstRow = document.createElement('div');
    firstRow.className = 'hand__row';
    el.hand.replaceChildren(firstRow);
    const handAddr = handAddress(mySeat());
    const engineHand = state.zones.cards(handAddr);
    // The engine's order is dealing order and stays that way; what the player
    // sees is their own arrangement (src/ui/handOrder.js).
    session().displayedHand = orderHand(engineHand, (id) => cardById(state, id), session().handPrefs.mode, session().handPrefs.order, rankLadderOf(state.pack));
    const committedPass = committedSelectionOf(state, mySeat());

    // Gathered cards are drawn in the tray instead, so the fan holds only what
    // is still to be chosen from. handPrefs.order is NOT touched — a card put
    // back returns to the exact slot it left, because it never left the order.
    const staged = new Set(stagedIds(state));
    const fanned = staged.size ? session().displayedHand.filter((id) => !staged.has(id)) : session().displayedHand;

    fanned.forEach((cardId, i) => {
      const card = cardById(state, cardId);
      const selectable = ui.handSelectable.has(cardId);
      const selected = isSelected(session().selection, handAddr, cardId) || (committedPass || []).includes(cardId);
      // A card you cannot play is DRAWN as one — grey stock, deeper ink, baked
      // into the art (src/ui/cardStyles/shared.js). It used to be the live card
      // under `opacity: 0.78`, which cost a composited layer per unplayable card
      // per frame and faded the rank you are reading to find out why it is
      // unplayable. Only the hand does this: a pile or an opponent's card is not
      // yours to play, so there is nothing for it to say there.
      const wrapper = svgNode(art().face(card, !selectable),
        `card-face-wrap ${selectable ? '' : 'card-face--disabled'} ${stagger ? 'card-deal' : ''} ${selected ? 'card-face-wrap--selected' : ''} ${hintedCard(cardId) ? 'card-face-wrap--hinted' : ''}`);
      markEntry(wrapper, `hand:${cardId}`);
      wrapper.dataset.cardId = cardId;
      if (stagger) wrapper.style.animationDelay = `${i * 35}ms`;
      const svg = wrapper.querySelector('svg');
      svg.classList.toggle('card-face--disabled', !selectable);

      // Every hand card is reachable by keyboard, playable or not: a card that
      // cannot be focused cannot be inspected, and "why can't I play this?" is
      // a question the disabled ones are the whole reason for.
      wrapper.setAttribute('role', 'button');
      wrapper.tabIndex = 0;
      // "Playable" is the wrong word in a gathering mode — a tap there stages
      // the card, it does not commit it — and off-turn it would be an outright
      // lie, now that a meld can be arranged while the bots think.
      const affordance = !selectable ? ''
        : (ui.handMulti ? ' Tap to gather.' : ' Playable.');
      wrapper.setAttribute('aria-label',
        `${cardAriaLabel(card, state.pack, { position: i + 1, of: fanned.length })}${affordance}`);
      wrapper.setAttribute('aria-pressed', String(!!selected));

      const activate = () => onHandCard(state, cardId, card, wrapper, ui);
      if (selectable) {
        wrapper.classList.add('card-face-wrap--playable');
        wrapper.addEventListener('click', activate);
      }
      activateOnKey(wrapper, () => { if (selectable) activate(); });

      if (draggable.hand.has(cardId) && drag()) {
        drag().attach(wrapper, { kind: 'hand', from: handAddr, cardId });
      }
      // Where a hold gathers a meld, it cannot also open the inspector — two
      // things on one gesture, and the one that changes the board must win.
      // The card's description is still on its accessible name, and everywhere
      // outside a rummy lay-down the long press means "what is this?" as before.
      attachInspector(wrapper, () => describeCard(card, state.pack),
        { isBusy: () => (!!drag() && drag().isDragging()) || !!gestures()?.smartSelectArmed() });

      firstRow.appendChild(wrapper);
    });

    el.handSort.textContent = SORT_LABELS[session().handPrefs.mode] || SORT_LABELS.auto;
    el.handSort.setAttribute('aria-label', `Hand order: ${SORT_LABELS[session().handPrefs.mode]}. Change it.`);
    // Whether it is SHOWN is renderRail's: the toggle shares its slot with the
    // action button, and renderSelection reaches the rail without coming through
    // here — so a `hidden` set from this side would survive the action that
    // displaced it and the toggle would never come back.
    renderStageTray(state, ui);
    layoutHand();
  }

  /**
   * Tighten the fan until the hand fits the felt.
   *
   * A hand is the one thing on the table whose size the layout cannot choose:
   * the pack decides how many cards you hold, and Milestones deals ten while a
   * phone is 375px wide. Fixed spacing therefore has exactly two failure modes —
   * a hand that runs off both edges, or cards so small they cannot be read — and
   * the fix for both is the same one a real player uses: close the fan.
   *
   * So the SPACING is what flexes, never the card size. Each card keeps its full
   * width and slides further under its neighbour, which is why a squeezed hand
   * still shows every card's rank corner rather than shrinking into unreadable
   * confetti. The floor stops it closing past the point where those corners
   * disappear.
   *
   * AND WHEN CLOSING IS NOT ENOUGH, THE FAN TAKES A SECOND ROW. A thirteen-card
   * hand on a 375px phone closed to 14.5px a card, which is under anything anyone
   * can choose from (#133 items 1–2). `fanLayout` says how many rows it takes to
   * get back above that floor and what each row's step then is; this function
   * supplies the three measurements it decides on and moves the cards.
   *
   * Cheap enough to run on every render and every resize: four measurements, two
   * custom properties, and DOM work only when the row count actually changes.
   */
  function layoutHand() {
    const cards = [...el.hand.querySelectorAll('.card-face-wrap')];
    const count = cards.length;
    if (count < 2) {
      el.hand.style.removeProperty('--fan-step');
      el.hand.style.removeProperty('--lift-gap');
      return;
    }

    // A row with no width has not been laid out yet — the table screen is still
    // `hidden` at boot, and a suspended launcher frame reports zero for
    // everything. Measuring anyway would compute "no room at all" and pin the
    // fan shut until something else forced a relayout, so the honest move is to
    // leave the CSS fallback in place and wait for the observer below to say the
    // row has a size.
    const rowWidth = el.handRow.clientWidth;
    if (!rowWidth) return;

    const styles = getComputedStyle(el.hand);
    // THE CARD AS DRAWN, not the property it was drawn from. `--hand-card-w` is
    // `clamp(70px, 8.6vh, 104px)` on a tall window and `parseFloat` reads that as
    // 70 — so every desktop fan was spaced for a card 34px narrower than the one
    // on the felt (#135, whose one-line fix this is; the overseer unifies the
    // two). A rendered card cannot be wrong about its own width.
    //
    // OFF THE COMPUTED STYLE, NOT OFF A RECT. `getBoundingClientRect` reports the
    // VISUAL box, so a card measured during the deal — which is exactly when this
    // runs, renderHand calls it — comes back scaled by whatever frame of
    // `card-deal` is on screen, and the whole fan is then spaced for a card 2.5%
    // too small. The used width is a layout fact and no transform touches it.
    const cardStyles = getComputedStyle(cards[0]);
    // The measurement goes through `resolveCardWidth` (#135) so the order —
    // rendered, then declared, then 70 — is the one its test pins.
    const cardWidth = resolveCardWidth({
      rendered: parseFloat(cardStyles.width),
      declared: styles.getPropertyValue('--hand-card-w'),
      fallback: 70,
    });
    // The wrapper, not the card art: the inline svg sits on a line box, so the
    // few px under its baseline are part of what a row of these actually costs.
    const cardHeight = parseFloat(cardStyles.height) || cardWidth * 1.4;
    const padding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    // The rail shares the row, so the fan may not have all of it — UNLESS it has
    // stood down into its own band above the fan, which is what it does on a
    // portrait phone (#134, `.hand-rail` in table.css). Which shape it is in is
    // measured rather than re-derived from the media query: a band is as wide as
    // the row, and a rail beside the fan is not.
    //
    // Beside the fan, the RAIL is what is measured and not whichever control
    // happens to be standing in it: its width is fixed in CSS precisely so this
    // number does not move when the turn token lights, the Hint lamp appears, or
    // the action button takes the thumb slot — a reserve that changed mid-turn
    // would re-fan the hand under the player's finger (#13, in the inline axis).
    const railBeside = el.handRail.offsetWidth < rowWidth;
    const reserved = railBeside ? el.handRail.offsetWidth + 12 : 0;
    const available = Math.max(cardWidth, rowWidth - reserved - padding - 4);

    const rowGap = parseFloat(styles.rowGap) || 0;
    const slack = handSlack(cardHeight + rowGap);
    // THE ROW COUNT IS CACHED THE WAY THE SEAT ROW'S RUNG IS (see renderSeats),
    // and for the same reason: it is an answer to a MEASUREMENT that the answer
    // itself changes. `handSlack` already hands back the one-row figure so the
    // feedback loop cannot close, but the felt's middle still breathes by a
    // fraction of a pixel as counters and badges change width — and a fan that
    // flipped between one row and two on alternate turns because a chip grew by
    // half a pixel is the worst version of this feature. Quantised, so only a
    // real change of room is a change of key.
    const key = `${count}:${Math.round(cardWidth)}:${Math.round(cardHeight)}`
      + `:${Math.round(available)}:${Math.round(slack / SLACK_STEP)}`;
    // The shape it is in NOW is an input, not just a cache: a fan re-joins later
    // than it split, so that staging one card out of thirteen does not drop the
    // hand back to one row and take 20px off every card's strip (fanLayout).
    const current = session()?.handFit?.rows || 1;
    const rows = session()?.handFit?.key === key
      ? session().handFit.rows
      : fanLayout({ count, cardWidth, cardHeight, available, rowGap, slack, current }).rows;
    if (session()) session().handFit = { key, rows };

    const perRow = placeHandRows(cards, rows);
    const step = fanStep({ count: perRow, cardWidth, available });

    // HOW FAR THE FAN OPENS UNDER A LIFTED CARD, out of the room it did not need.
    // The shift is a transform and moves no layout, so nothing else would stop
    // the rightmost card sliding under the rail — this is what keeps it on the
    // felt. `liftGap` is the whole overlap, which is the only shift that actually
    // uncovers the neighbour's rank corner; whatever of that the row cannot spare
    // is not taken, and a fan already closed to fit its row opens by nothing at
    // all rather than tightening further to buy the animation room.
    //
    // Measured off the LONGEST row, because one `--lift-gap` serves them all and
    // the row with the least room to give is the one that decides.
    const spare = available - fanWidth({ count: perRow, cardWidth, step });
    const gap = Math.max(0, Math.min(liftGap({ cardWidth, step }), spare));
    el.hand.style.setProperty('--fan-step', `${step.toFixed(2)}px`);
    el.hand.style.setProperty('--lift-gap', `${gap.toFixed(2)}px`);
  }

  /**
   * How much height the felt's middle has going spare, in units of one hand row.
   *
   * A SECOND ROW OF CARDS IS PAID FOR OUT OF THE FELT, so the question is not
   * "is this a phone" but "is there room". The middle (`#felt-middle`) is the
   * band that absorbs the column's slack — it is the one `flex: 1` in the stack —
   * so what it has beyond what its contents need is exactly what the hand may
   * take. Everything else in the column is already sized to its own content.
   *
   * MEASURED, NEVER LISTED. The middle holds the contract ladder, the centre
   * piles and the table counters today, and #136 is adding a shared cribbage
   * board to it in parallel; #137 will trim what a staging phase reserves. Asking
   * the children how tall they are stays right under both, where a hardcoded
   * "minus the piles" would quietly go wrong the day the middle grew a row.
   *
   * NORMALISED TO ONE ROW, which is what keeps this from oscillating. The slack
   * measured with a two-row hand on the felt is smaller BY the second row — so
   * feeding it back in would say "no room", the hand would drop to one row, the
   * slack would reappear, and the fan would flip on alternate renders. What is
   * returned is the slack a one-row hand would see, whatever the hand is wearing
   * right now.
   *
   * @param rowCost what one extra row of cards costs in height
   */
  function handSlack(rowCost) {
    const middle = el.feltMiddle;
    if (!middle || !middle.clientHeight) return 0;
    // `offsetTop`/`offsetHeight`, not rects: a pile mid-deal is carrying a
    // transform, and what is being asked here is how much room its layout needs.
    // THE UNION OF THE CHILDREN, NOT THE TALLEST ONE: the middle WRAPS for a
    // table with a shared board (#136, `felt-middle--boarded`), so its content
    // is the piles' line plus the board's line under it, and the tallest child
    // alone would hand the fan a second row's worth of room the board is
    // already standing in.
    let top = Infinity;
    let bottom = -Infinity;
    for (const child of middle.children) {
      if (child.hidden) continue;
      top = Math.min(top, child.offsetTop);
      bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
    }
    const content = bottom > top ? bottom - top : 0;
    // AND WHAT THE FELT IS ALREADY OVER BY. The middle's spare room is the answer
    // only while the column fits the screen; a felt that has outgrown it has
    // taken height it did not have, and a second row would take more. Without
    // this term the middle simply grows to whatever it is asked for, the spare
    // reads as zero however far the hand has pushed the table off the bottom, and
    // the gate never closes — which is exactly what a probe that ate the felt's
    // middle showed it doing.
    const over = Math.max(0, el.screen.scrollHeight - el.screen.clientHeight);
    const extraRows = Math.max(0, el.hand.querySelectorAll('.hand__row').length - 1);
    return middle.clientHeight - content - over + extraRows * rowCost;
  }

  /**
   * Deal the fan's cards into `rows` row containers, left to right, top to bottom.
   *
   * ONLY WHEN THE SHAPE CHANGES. Re-parenting a card restarts its animations and
   * drops any pointer capture on it, and this runs on every render and every
   * resize notification — so the common case, which is the same hand in the same
   * shape, must touch nothing at all.
   *
   * @returns how many cards the longest row holds
   */
  function placeHandRows(cards, rows) {
    const plan = handRows({ count: cards.length, rows });
    const existing = [...el.hand.querySelectorAll('.hand__row')];
    const same = existing.length === plan.length
      && plan.every((n, i) => existing[i].childElementCount === n);
    if (same) return plan[0];

    const built = plan.map(() => {
      const row = document.createElement('div');
      row.className = 'hand__row';
      return row;
    });
    let at = 0;
    built.forEach((row, i) => {
      for (let n = 0; n < plan[i]; n++) row.appendChild(cards[at++]);
    });
    el.hand.replaceChildren(...built);
    return plan[0];
  }

  /**
   * Re-fan whenever the row's width changes, whatever changed it.
   *
   * A ResizeObserver rather than a window `resize` listener because the width
   * that matters is the ROW's, and it moves for reasons the window never hears
   * about: the launcher's font scale, the table screen going from `hidden` to
   * shown at boot, a suspended frame waking up with real geometry. All three
   * previously left the fan at whatever it guessed the first time.
   */
  function watchHandWidth() {
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', () => { if (liveState()) layoutHand(); });
      return;
    }
    // Observing the ROW, not the hand: the hand's own width is what layoutHand
    // changes, so watching it would be a feedback loop.
    new ResizeObserver(() => { if (liveState()) layoutHand(); }).observe(el.handRow);
  }

  /* ------------------------------------------------------------------ *
   * The player's own arrangement: a drop back into the fan, and the toggle
   * ------------------------------------------------------------------ */

  /** Every row of the fan, in order, with its box and its cards. */
  function handRowNodes() {
    return [...el.hand.querySelectorAll('.hand__row')]
      .map((row) => ({ rect: row.getBoundingClientRect(), nodes: [...row.querySelectorAll('[data-card-id]')] }))
      .filter((row) => row.nodes.length);
  }

  /**
   * Drop `cardId` where the pointer left it.
   *
   * Rearranging by hand IMPLIES "my order" — a player who has just moved a card
   * has said what they want more clearly than any toggle could, so the mode
   * follows the gesture rather than making them find a control first.
   *
   * THE ROW COMES FIRST, THEN THE PLACE IN IT. A two-row fan (#134) has two cards
   * under any given x, so x alone would drop a card carried down to the second
   * row into the first row's version of the same position — the one place it
   * visibly was not. Picking the row by y and only then the index by x is the
   * order the player's own gesture is in.
   */
  function reorderHandAt(cardId, clientX, clientY) {
    const rows = handRowNodes();
    if (!rows.length) return;
    // The row the pointer is in, or the nearest one: a card released just above
    // the fan or just below it belongs to the row it was closest to, not to
    // nothing at all.
    const picked = nearestRow(rows, clientY);
    // Where that row starts in the fan as a whole — the index `reorder` works in
    // is a position in the HAND, not a position in a row.
    const before = rows.slice(0, rows.indexOf(picked)).reduce((n, row) => n + row.nodes.length, 0);
    let within = picked.nodes.length;
    for (let i = 0; i < picked.nodes.length; i++) {
      const rect = picked.nodes[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        within = i;
        break;
      }
    }
    const index = before + within;
    if (!livePack() || !liveState()) return;
    session().handPrefs = { mode: 'manual', order: reorder(session().displayedHand, cardId, index) };
    saveHandPrefs(livePack().id, session().handPrefs);
    render(liveState());
  }

  function cycleHandSort() {
    if (!liveState() || !livePack()) return;
    const mode = nextMode(session().handPrefs.mode);
    session().handPrefs = {
      // Switching AWAY from manual keeps the permutation: the player gets their
      // arrangement back when they cycle round to it, instead of being punished
      // for glancing at a sorted view.
      mode: isSortMode(mode) ? mode : 'auto',
      order: session().handPrefs.mode === 'manual' ? session().displayedHand.slice() : session().handPrefs.order,
    };
    saveHandPrefs(livePack().id, session().handPrefs);
    render(liveState());
  }

  /**
   * Carry a card between the fan and the tray, so the two rows read as one
   * gesture rather than as the card vanishing from one place and appearing in
   * another. `from` is measured BEFORE the render that moved it.
   */
  function flyToStage(state, cardId, from) {
    if (!from || !motionAllowed()) return;
    const landed = el.stageTray.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)
      || el.hand.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    const to = rectOf(landed);
    if (!to) return;
    const card = cardById(state, cardId);
    if (!card) return;
    // Held invisible under the copy and revealed when it lands — the same
    // clone-and-animate deal a played card gets. flyCard always resolves, so the
    // card cannot be left permanently hidden.
    landed.style.visibility = 'hidden';
    flyCard(art().face(card), from, to, { duration: 180 })
      .then(() => { landed.style.visibility = ''; });
  }

  return {
    renderHand,
    watchHandWidth,
    reorderHandAt,
    cycleHandSort,
    flyToStage,
    // NOT CALLED FROM src/ui/table.js — renderHand ends in both. They are out
    // here because they are what tests/handFan.test.js has questions about:
    // what the fan subtracts for the rail, when a relayout may re-parent cards,
    // and what the tray says when the engine will not take its contents. Each
    // of those was a playwright measurement or nothing for as long as the only
    // way in was a whole render.
    renderStageTray,
    layoutHand,
    handSlack,
    placeHandRows,
  };
}
