// THE HELP MARK AND ITS SHEET (#155): two questions about the game — how is
// this played, and what would a player at this level do here — behind one `?`
// in the felt's corner, and the hint the second of them asks for.
//
// Carved out of src/ui/table.js (#223, seam 7), which resolves 43 DOM ids at
// import time and therefore cannot be loaded by `node --test`. That is why this
// file takes `el` and the rest as PARAMETERS. Whether the Hint line is offered
// or says why not, and that the sheet closes BEFORE a hint rings the cards it
// would be standing over, were a regex over table.js (tests/handRail.test.js);
// they are driven now (tests/helpSheet.test.js).
//
// THE LISTENERS CAME WITH IT. `wire()` is what initTable used to do inline for
// the mark, the two lines and the tap outside, so the order the Hint line runs
// in is this file's to keep. Escape stays in table.js's one keydown listener,
// which asks `helpOpen()` first because the sheet is the innermost thing open.
//
// `session` comes in as a thunk, like every other seam's. `showRules` is a
// parameter because src/ui/panels.js resolves its own element ids at import.
// `renderSelection`, `persistMatch` and `movesFor` stay in table.js: the rest
// of the felt calls them too.

import { suggestMove } from './hint.js';
import { packRules } from './rules.js';
import { loadSettings } from '../arcade/storage.js';
import { actingSeats as actingSeatsOf } from '../engine/context.js';

/** What the Hint line says about itself when it cannot be taken. */
export const HINT_OFFER = Object.freeze({
  turn: 'Only while it is your turn',
  view: 'A joined table holds a view, not the cards',
  over: 'The game is over',
  showing: 'The hint is on the felt',
  forced: 'There is only one play',
  ready: 'What a player at this level would do',
});

export function createHelpSheet({
  el, session, liveState, livePack, isMySeat, mySeat, movesFor, renderSelection, persistMatch,
  showRules,
}) {
  /** Is this card part of the hint on the bar right now? */
  function hintedCard(cardId) {
    return !!session()?.hint?.cardIds?.has(cardId);
  }

  /**
   * The Hint button: what a player at the chosen difficulty would do, from this
   * exact position (src/ui/hint.js).
   *
   * THE SAME DIAL THE OPPONENTS ARE ON. The new-game sheet's difficulty is read
   * fresh here, as the bot driver reads it, so "what would a Sharp player do" is
   * a question about the bot the player is actually up against — and asking it
   * at Easy gets Easy's answer, which is the honest one for a game being learnt.
   *
   * NOTHING IS LOGGED. A hint changes no state and a replay never learns one
   * was asked for. The ranking happens synchronously on the tap: `hard` is
   * capped at its think budget (src/engine/bot.js), so the longest a tap can
   * stall for is the budget the bots already spend on every turn.
   */
  function showHint() {
    const state = liveState();
    if (!state || state.isView || state.gameOver || !actingSeatsOf(state).some(isMySeat)) return;
    const hint = suggestMove(state, mySeat(), { difficulty: loadSettings().botDifficulty });
    if (!hint) return;
    session().hint = hint;
    session().hintsTaken += 1;
    // THE SENTENCE OUTLIVED THE BAR THAT SHOWED IT. What a sighted player gets
    // is the ring on the felt — the cards, the pile, the meld the suggestion
    // touches — and a ring says nothing to a screen reader. #log is the live
    // region, it sits below the felt where it costs the hand no room, and this
    // is exactly the kind of thing it exists to say. It is the ONLY place the
    // wording appears now, which is why suggestionText still exists.
    el.log.textContent = hint.text;
    renderSelection(state);
    // Counted, and the count is part of what a resume brings back.
    persistMatch();
  }

  /* ------------------------------------------------------------------ *
   * The help mark, and the two questions behind it (#155)
   * ------------------------------------------------------------------ */

  /**
   * Whether a ranking can be asked for, and what to say when it cannot.
   *
   * THE SAME FIVE CONDITIONS THE LAMP IN THE RAIL WAS SHOWN UNDER, moved rather
   * than rewritten: the hint asks the engine to rank the position, so it is
   * offered only where the felt HOLDS the position — a joiner's view has no
   * opponents' hands to fork and gets a reason rather than a guess
   * (src/ui/hint.js) — and only where there is a choice to make. One legal move
   * is not a hint. It also steps aside once its answer is showing, so a player
   * cannot ask the same question twice and have it counted twice.
   *
   * WHAT CHANGED IS THAT A REFUSAL NOW SAYS SOMETHING. In the rail the offer
   * simply went invisible, which is the right treatment for an icon in a column
   * of controls and the wrong one for a line in a sheet somebody has just opened
   * looking for help: they would find a hint that had disappeared and learn
   * nothing. Disabled, with the reason on it, is both answers at once.
   */
  function hintOffer(state, humanActs, suggestion) {
    if (!state || state.isView) return { ready: false, why: HINT_OFFER.view };
    if (state.gameOver) return { ready: false, why: HINT_OFFER.over };
    if (!humanActs) return { ready: false, why: HINT_OFFER.turn };
    if (suggestion) return { ready: false, why: HINT_OFFER.showing };
    if (movesFor(state, mySeat()).length <= 1) return { ready: false, why: HINT_OFFER.forced };
    return { ready: true, why: HINT_OFFER.ready };
  }

  /** Repaint the sheet's Hint line. Called from renderRail, open sheet or not. */
  function renderHelpOffer(state, humanActs, suggestion) {
    const offer = hintOffer(state, humanActs, suggestion);
    el.helpHint.disabled = !offer.ready;
    // The note is part of the button's accessible NAME rather than a description
    // beside it: "Hint, only while it is your turn" is one thing to hear, and a
    // disabled control's description is the half a screen reader may skip.
    el.helpHintNote.textContent = offer.why;
  }

  function helpOpen() {
    return !el.helpSheet.hidden;
  }

  /**
   * Open or close the sheet.
   *
   * FOCUS GOES IN AND COMES BACK. Opening moves it to the first line, so the
   * sheet is usable from a keyboard at all; closing returns it to the mark, but
   * only when it is still inside the sheet — a close that fires because the
   * player tapped a card must not steal the focus off that card.
   */
  function setHelpOpen(open) {
    if (open === helpOpen()) return;
    el.helpSheet.hidden = !open;
    el.helpButton.setAttribute('aria-expanded', String(open));
    if (open) {
      el.helpRules.focus({ preventScroll: true });
    } else if (el.helpSheet.contains(document.activeElement)) {
      el.helpButton.focus({ preventScroll: true });
    }
  }

  /** The mark, the sheet's two lines, and a tap anywhere else. Once, from initTable. */
  function wire() {
    // THE HELP MARK (#155). Two questions about the game — how is this played,
    // and what would a good player do here — behind one `?` in the felt's
    // corner, instead of the rules two taps deep in the scoreboard and the hint
    // in among the buttons that commit.
    el.helpButton.addEventListener('click', () => setHelpOpen(!helpOpen()));
    el.helpRules.addEventListener('click', () => {
      setHelpOpen(false);
      if (livePack()) showRules(packRules(livePack()));
    });
    // CLOSED FIRST, AND THAT IS THE POINT OF THE ORDER: what a hint produces is
    // a ring round cards on the felt, and a sheet standing over them answers the
    // question with the answer hidden behind it.
    el.helpHint.addEventListener('click', () => {
      setHelpOpen(false);
      showHint();
    });
    // A tap anywhere else closes it, the way the seat plate (initTable) answers the
    // same gesture. Capturing, so the tap still reaches whatever it was aimed
    // at: this closes a sheet, it does not swallow a move.
    document.addEventListener('pointerdown', (event) => {
      if (!helpOpen()) return;
      if (el.helpSheet.contains(event.target) || el.helpButton.contains(event.target)) return;
      setHelpOpen(false);
    }, true);
  }

  return {
    hintedCard,
    showHint,
    renderHelpOffer,
    helpOpen,
    setHelpOpen,
    wire,
    // Returned for tests only: renderHelpOffer is how table.js asks it.
    hintOffer,
  };
}
