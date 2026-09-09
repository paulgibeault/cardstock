// The contract strip: what was promised, by whom, in what suit — kept on screen.
//
// A trick game with an auction has three facts that govern every decision at
// the table and lived nowhere on the felt (#125): the standing high bid and who
// holds it, the trump suit once it is named, and — for the seat doing the
// looking — its own meld. Every one of them was in the state the whole time.
// Trump was the worst of the three: on any hand the player did not win the
// auction the suit was never said out loud at all, in a game whose play rule is
// follow-and-beat with mandatory over-trump.
//
// DATA-DRIVEN, like the contract ladder beside it: the template answers
// `contractChips` and this draws whatever comes back, so nothing here knows
// what an auction is. A pack whose template returns null keeps the row hidden
// and loses no felt height to it.
//
// WHY NOT THE LADDER. `#contract-ladder` is contract-rummy's race — a rung per
// phase with a pip for every player standing on it — and it is driven by
// `rules.contracts`, which Pinochle does not have. Overloading it would have
// meant one widget answering two unrelated questions ("how far along is
// everyone" and "what is trump") from two unrelated declarations. This is a
// strip of chips; it costs one row and says three things.

import { line, svgNode } from './dom.js';
import { makeCtx } from '../engine/context.js';

/**
 * @param el          the #table-contract element
 * @param me          the seat lens (src/players/seats.js) — whose meld is "yours"
 * @param identityOf  (seat) => roster identity
 * @param art         () => the open match's card renderer
 */
export function createContractStrip({ el, me, identityOf, art }) {
  function render(state) {
    const chips = state.pack.template.contractChips?.(makeCtx(state), me.seat()) ?? null;
    if (!Array.isArray(chips) || !chips.length) {
      hide();
      return;
    }

    el.replaceChildren();
    for (const chip of chips) {
      const node = document.createElement('div');
      // The key is a TEMPLATE-chosen slug, never pack data reaching an
      // attribute the stylesheet matches on (§7b) — hence the scrub.
      node.className = 'contract-chip';
      if (chip.key) node.dataset.chip = String(chip.key).replace(/[^a-z0-9-]/gi, '');

      // THE PACK'S OWN CARD, not a glyph this file draws. `art.chooser` is the
      // renderer round-3 item 6 built for the wild's suit question
      // (src/ui/cardStyles/chooser.js) — the same picture, at strip size, so
      // the suit in force and the suit you were offered are one vocabulary.
      // Null for anything it has no tile for, which is the right answer rather
      // than a wrong picture.
      const face = chip.suit ? art().chooser('suit', chip.suit) : null;
      if (face) {
        const pic = svgNode(face, 'contract-chip__art');
        pic.setAttribute('aria-hidden', 'true');
        node.appendChild(pic);
      }

      const body = document.createElement('div');
      body.className = 'contract-chip__body';
      body.appendChild(line('contract-chip__label', chip.label || ''));
      body.appendChild(line('contract-chip__value', String(chip.value ?? '')));
      node.appendChild(body);

      // WHOSE IT IS, in the mark that seat wears everywhere else on the felt
      // (src/players/roster.js). This is the half of "the auction gives no
      // context" that a number alone cannot fix: once two seats have both bid,
      // both their chips read the same gold and only a name says who is ahead.
      if (Number.isInteger(chip.seat)) {
        const identity = identityOf(chip.seat);
        const who = document.createElement('span');
        who.className = 'contract-chip__who';
        const mark = document.createElement('span');
        mark.className = 'contract-chip__mark';
        // Own value from the roster, never a manifest one — inline style (§7b).
        mark.style.background = identity.color;
        mark.textContent = identity.icon || identity.initials;
        mark.setAttribute('aria-hidden', 'true');
        who.appendChild(mark);
        // textContent, never interpolation: a name can arrive from a peer.
        const named = document.createElement('span');
        named.textContent = me.holds(chip.seat) ? 'You' : identity.name;
        who.appendChild(named);
        node.appendChild(who);
      }

      // The visible parts are a word and a number in two elements plus a
      // picture; said outright so it is one phrase rather than three fragments.
      node.setAttribute('aria-label', `${chip.aria || `${chip.label}: ${chip.value}`}`
        + (Number.isInteger(chip.seat)
          ? `, ${me.holds(chip.seat) ? 'yours' : identityOf(chip.seat).name}` : ''));
      el.appendChild(node);
    }
    el.hidden = false;
  }

  function hide() {
    el.hidden = true;
    el.replaceChildren();
  }

  return { render, hide };
}
