// The chooser: a card asking a question, and the answer coming back.
//
// A self-contained modal — its own element lookups, its own roving focus, its
// own cancellation — extracted from src/ui/table.js because none of it is about
// the felt. It is now the generic RENDERER for whatever a template's
// `pendingChoice` hook asks (src/templates/CONTRACT.md): the template names the
// question and says where the answer goes, this draws the buttons, and nothing
// here knows what a wild is.
//
// Cancellable on purpose. Tapping a wild used to be an irreversible commitment
// to a modal with no way out, and closing the table under an open prompt left
// the awaiting handler holding a promise that could still resolve into a match
// that was no longer on screen. `closeChoiceDialog()` is what the table calls
// on its way out.

import { svgNode } from './dom.js';
import { safeCssColor } from './css.js';

const el = {
  modal: document.getElementById('choice-modal'),
  dialog: document.getElementById('choice-dialog'),
  card: document.getElementById('choice-card'),
  prompt: document.getElementById('choice-prompt'),
  panel: document.getElementById('choice-options'),
  cancel: document.getElementById('choice-cancel'),
};

// Resolves a pending prompt with null when the table closes under it, so the
// awaiting move handler unwinds instead of applying a move to a match nobody is
// looking at.
let cancelPending = null;

/**
 * One option of a card's question, as a button.
 *
 * THE PICTURE IS THE TARGET AND THE WORD IS THE CAPTION, and both are always
 * there. The art is what makes the choice quick — you aim at the red one, not
 * at the four-letter word that starts with r — and the word is what makes it
 * possible at all for a player who cannot separate the colours, which in a
 * game whose entire rule IS colour is not a minor audience.
 *
 * Three kinds of option, in the order they are tried: a card the pack's own
 * renderer can draw (a colour, a suit, a rank); a PLAYER, which is not a card
 * and gets the mark that seat wears everywhere else instead; and a bare word
 * for anything a template invents that is neither.
 *
 * `label` is pack data on two paths and is handled as such on both: textContent
 * for the caption, and a lookup key for the art, which is generated inside
 * src/ui/cardStyles/chooser.js with everything escaped. `value` is what the
 * template gets back, and is NOT necessarily a string — a seat is a number.
 */
function buildChoiceOption(art, attr, { label, icon = null }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const face = art.chooser(attr, label);
  btn.className = `choice-option ${face ? 'choice-option--card'
    : icon ? 'choice-option--seat' : 'choice-option--word'}`;
  // Named outright rather than left to name-from-content. The caption below is
  // the name either way, but the picture beside it is a whole card's worth of
  // markup for the computation to walk past, and the one thing this button
  // must never be is unlabelled.
  btn.setAttribute('aria-label', label);
  if (face) {
    btn.appendChild(svgNode(face, 'choice-option__art'));
  } else if (icon) {
    // The seat's own mark, the same one on its plate and in the score sheet
    // (src/players/roster.js) — one vocabulary for "this is a player",
    // wherever they turn up. Decorative: the name below carries the meaning.
    const mark = document.createElement('span');
    mark.className = 'choice-option__icon';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = icon;
    btn.appendChild(mark);
  }
  const caption = document.createElement('span');
  caption.className = 'choice-option__name';
  caption.textContent = label;
  btn.appendChild(caption);
  return btn;
}

/**
 * Ask for a suit or colour (or a player, for targeted effects), or null if
 * the player backs out.
 *
 * Cancellable on purpose. Tapping a wild used to be an irreversible commitment
 * to a modal with no way out, and closing the table under an open prompt left
 * the awaiting handler holding a promise that could still resolve into a match
 * that was no longer on screen.
 *
 * `options` are `{ value, label, icon }`. The promise resolves with the raw
 * `value`, which is whatever the template put there — a colour name, a rank, or
 * a SEAT NUMBER — while `label` is what is drawn and read out. Keeping those
 * two apart is what let the seat prompt stop round-tripping a player's name
 * back into a seat index by searching the option list for it.
 *
 * `card` is the card that asked — shown at the top of the panel, because "what
 * does this become" is a question about a specific object and the answer reads
 * better next to it. Optional: a wild already lying in somebody's meld has no
 * single card to show.
 */
export async function promptChoice(art, attr, options, { card = null } = {}) {
  const choices = options.map((o) => ({ icon: null, ...o, label: o.label ?? String(o.value) }));
  el.prompt.textContent = `Choose a ${attr}`;
  el.panel.replaceChildren();
  el.card.replaceChildren();
  if (card) el.card.appendChild(svgNode(art.face(card), 'choice-dialog__face'));
  el.card.hidden = !card;
  // Four options are the rosette on the wild itself, so they are laid out as
  // one — two by two — rather than as a row that wraps differently per width.
  el.panel.className = `choice-grid ${choices.length === 4 ? 'choice-grid--quad' : ''}`;
  el.modal.hidden = false;

  return new Promise((resolve) => {
    const buttons = [];
    const close = (value) => {
      cancelPending = null;
      el.modal.removeEventListener('keydown', onKey);
      el.modal.hidden = true;
      el.dialog.style.removeProperty('--choice-tint');
      resolve(value);
    };

    // Roving focus, because the four colours are a GRID and Tab through a grid
    // is the wrong gesture: on a 2x2 the arrow key you press is the direction
    // you meant. Escape backs out, same as Cancel — this dialog is one of the
    // few in the app where changing your mind is a legitimate move.
    const move = (step) => {
      const at = buttons.indexOf(document.activeElement);
      const next = buttons[((at === -1 ? 0 : at) + step + buttons.length) % buttons.length];
      if (next) next.focus({ preventScroll: true });
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(null); return; }
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
      if (step === undefined) return;
      ev.preventDefault();
      move(step);
    };
    el.modal.addEventListener('keydown', onKey);

    cancelPending = () => close(null);
    el.cancel.onclick = () => close(null);

    for (const opt of choices) {
      const btn = buildChoiceOption(art, attr, opt);
      // The panel takes the colour of whatever is under the finger, so the
      // answer is visible before it is committed — and the felt then washes in
      // that same colour when it is (flashFelt). §7b: through safeCssColor,
      // because a pack value is reaching a style property.
      const tint = safeCssColor(art.chooserTint(attr, opt.label));
      const light = () => {
        if (tint) el.dialog.style.setProperty('--choice-tint', tint);
        else el.dialog.style.removeProperty('--choice-tint');
      };
      btn.addEventListener('focus', light);
      btn.addEventListener('pointerenter', light);
      btn.addEventListener('click', () => close(opt.value));
      buttons.push(btn);
      el.panel.appendChild(btn);
    }
    // preventScroll: the dialog is fixed, but focusing into it still scrolls
    // the felt behind it — the same trap the rules panel documents.
    if (buttons[0]) buttons[0].focus({ preventScroll: true });
  });
}

/** Shut an open prompt without answering it — a screen change under it. */
export function closeChoiceDialog() {
  if (cancelPending) cancelPending();
  el.modal.hidden = true;
}
