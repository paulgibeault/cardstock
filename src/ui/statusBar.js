// THE CHROME ABOVE THE FELT: the status line, the score chip, the card-speed
// chip, the strip of what the table itself is counting, and the shared board
// every seat's peg runs along.
//
// Carved out of src/ui/table.js (#223, seam 7), which resolves 43 DOM ids at
// import time and therefore cannot be loaded by `node --test`. That is why this
// file takes `el` and the rest as PARAMETERS. What the bar says over a held
// trick, a bid or a round's end, and whether the speed chip persists and
// announces what it was tapped to, are questions a Node test should be able to
// ask — for as long as they lived beside that element table the only test of
// them was a regex over table.js (tests/speed.test.js and
// tests/statusBar.test.js drive them now).
//
// THE THREE SPEED READERS ARE MODULE FUNCTIONS, NOT FACTORY ONES. They read
// storage and nothing else, and they are asked from everywhere a card flies or
// a bot thinks: moveFlight.js and roundEnding.js are handed `currentFlightMs`
// before this factory is built, and botSeams.js hands `currentDelayMs` to both
// bot drivers. A closure over `el` would have made all of them wait for it.
//
// `session` comes in as a thunk, the same as every other seam: the doors swap
// it on every open, and it is read at the moment the bar is painted. The
// names a sentence needs (`seatLabel`, `seatPossessive`, `voiceOf`,
// `winnerSentence`) stay in table.js, where the rest of the felt asks them too.

import { makeCtx } from '../engine/context.js';
import { legalMovesFor } from '../engine/movePipeline.js';
import { hasSides } from '../engine/sides.js';
import { loadSettings, saveSettings } from '../arcade/storage.js';
import { opponentRing, scoreBearers, seatSideMarks } from './seatRing.js';
import { showsScores, scoreChipFor, seatCountersFor } from './seatRow.js';
import { renderCounterTrack } from './counterTrack.js';
import { sharedBoard, renderSharedBoard, updateSharedBoard } from './sharedBoard.js';
import { flightDurationMs } from './flight.js';
import { speedLevel, speedForDelay, nextSpeed } from './speed.js';
import { interactionMode, commitPromptFor } from './interaction.js';

/* ------------------------------------------------------------------ *
 * How fast a card crosses the felt (#175)
 * ------------------------------------------------------------------ */

/**
 * The number behind the rung, read LIVE — from storage, every single time.
 *
 * THE FELT KEEPS NO COPY OF IT, and that is a decision rather than an omission.
 * It used to: a module-level snapshot of the preferences blob, assigned in
 * exactly two places — at boot, and on a re-render after a resume or a change to
 * the SDK's own settings. THE NEW-GAME SHEET IS NEITHER: src/ui/lobby.js writes
 * the chosen rung to storage and then opens the table. So a snapshot read handed
 * the first match of a session the rung from before the sheet, and a table dealt
 * at Slow flew at Brisk until the tab was reloaded. The bot driver's
 * `difficulty` was moved to a live read for this in #91, this number in #184 and
 * `currentPace` in #181 — which left the snapshot with no readers at all, so
 * #203 deleted it.
 *
 * THE STORED NUMBER, NOT THE TREAD IT LIGHTS. `speedForDelay` snaps to the
 * NEAREST rung on purpose, so a save hand-edited to 700 lights Brisk while
 * still flying at 700 (src/ui/speed.js). Everything that does arithmetic on the
 * setting comes through here rather than through the rung, so that stays true.
 */
export function currentDelayMs() {
  return loadSettings().botDelayMs;
}

/** The rung to put a name on: the chip's word, and the sheet's lit button. */
export function currentSpeed() {
  return speedForDelay(currentDelayMs());
}

/**
 * ONE DURATION FOR THE WHOLE TABLE, at the rung in force the moment a card
 * launches. Asked rather than cached for the reason above, and asked at every
 * call site rather than once per match because the status bar's chip can move
 * the rung mid-hand.
 */
export function currentFlightMs() {
  return flightDurationMs(currentDelayMs());
}

export function createStatusBar({
  el, session, isMySeat, mySeat, identityOf, seatLabel, seatPossessive, voiceOf, winnerSentence,
}) {
  function renderStatusBar(state, acting) {
    el.statusText.textContent = statusTextFor(state, acting);
    // Repainted on every render rather than only when it is tapped, because the
    // new-game sheet can change this between two hands and the chip has to agree
    // with the felt it is sitting above.
    paintSpeedChip();
    // `session.roundBeat` for the same reason `render` reads it: while the felt
    // holds a finished hand, nobody is on turn and the bar must not say so. A
    // trick reveal is the same claim for one beat (#123).
    const humanActs = acting.some(isMySeat) && !session()?.roundBeat && !session()?.trickBeat && !session()?.review;
    el.status.classList.toggle('status-bar--your-turn', humanActs);
    el.status.classList.toggle('status-bar--thinking', !state.gameOver && !humanActs);

    const scored = showsScores(state);
    el.scoreChip.hidden = !scored;
    if (scored) {
      // ONE READING, TWO RENDERINGS. The digits and the spoken label used to be
      // computed separately — the chip through `scoreChipFor` and the aria off
      // `state.scores` — which agreed for as long as nothing folded. In a
      // partnership they are two different numbers and the screen reader gets the
      // wrong one.
      const chip = scoreChipFor(state, mySeat());
      // THE HUMAN GETS THE SAME BOARD THE OPPONENT HAS. Every seat plate draws
      // its primary counter as a track where the template says it is one — and
      // the human's own seat is not a plate, so at a cribbage table there was
      // exactly one `.seat__track` in the document and it belonged to the bot
      // (#124, item 39). The player's own peg, the thing the whole game is read
      // off, was a bare number in the chrome.
      //
      // The same renderer, the same numbers, the same accessible sentence — this
      // is `renderCounterTrack` being DOM-parameterised for the second time and
      // not a second board. A pack whose primary counter is an ordinary quantity
      // renders nothing here and keeps the plain pill.
      //
      // AND WHERE THE FELT DRAWS THE SHARED BOARD (#136), NOT HERE EITHER. The
      // chip's track is 90px in the top-right corner, which is the one place on
      // the felt the eye never goes mid-hand; once your own lane is on the road
      // in the middle of the table, this goes back to being the plain pill it
      // was before #124 and says the number once.
      const board = session()?.board
        ? null
        : renderCounterTrack(seatCountersFor(state, mySeat(), { minimized: false })[0]);
      el.scoreChipTrack.replaceChildren(...(board ? [board] : []));
      // The track prints the number itself; two of them in one pill is the same
      // score twice.
      el.scoreChipValue.hidden = !!board;
      if (!board) el.scoreChipValue.textContent = chip.long;
      el.scoreChip.setAttribute('aria-label',
        `Your ${hasSides(state.pack, state.seats) ? "side's score" : 'score'}: `
        + `${board ? board.getAttribute('aria-label') : chip.long}. `
        + 'Open the scoreboard.');
    }
    renderTableCounters(state);
  }

  /**
   * The chip: one short word, and the sentence behind it on `aria-label`.
   *
   * THE LABEL IS THE RUNG, NOT THE NUMBER. A chip reading "600ms" would be the
   * text field src/ui/speed.js exists to avoid, in a smaller font.
   */
  function paintSpeedChip() {
    const level = currentSpeed();
    el.speedChipLabel.textContent = level.label;
    el.speedChip.setAttribute('aria-label',
      `Card speed: ${level.label}. ${level.description} Tap to change.`);
  }

  /**
   * Move to the next rung, on the tap that asked for it.
   *
   * STORAGE IS THE ONLY WRITE, BECAUSE STORAGE IS THE ONLY READ. The next flight
   * is precisely the one the player is watching for — the reason they reached for
   * this is that the last one went past too fast — and it picks the new rung up
   * without a settings event coming back round through main.js, because
   * `currentDelayMs` asks storage as the card launches. There is deliberately no
   * snapshot to update in the same breath: a second copy of this number is a
   * second thing to forget, and forgetting it is the bug this control shipped on
   * top of. (#203 removed the felt's last snapshot entirely; this was already the
   * rule here.)
   *
   * NOTHING IN FLIGHT IS RESTARTED. Unlike the pace control, which cancels and
   * re-arms a countdown it may have shortened, this changes nothing that has
   * already been scheduled: a card mid-air keeps the duration it launched with,
   * and a bot already sitting on its think timer plays when it was always going
   * to. Both are over in well under a second, and a card that changed speed
   * halfway across the table would be the opposite of legible.
   *
   * ANNOUNCED IN #log, the felt's live region, because otherwise the only
   * evidence the tap did anything is the chip's own word changing — which is
   * nothing at all to a screen reader, and easy to miss with eyes on the felt.
   */
  function cycleSpeed() {
    const level = speedLevel(nextSpeed(currentSpeed().id));
    const stored = loadSettings();
    saveSettings({ ...stored, botDelayMs: level.delayMs });
    paintSpeedChip();
    el.log.textContent = `Card speed: ${level.label}. ${level.description}`;
  }

  /**
   * WHAT THE TABLE ITSELF IS COUNTING — the running count in cribbage, and
   * nothing at all for every pack that declares none.
   *
   * `seatCounters` one rung out. Some facts a felt has to keep on screen are not
   * any seat's: the count in the play is the table's, it changes with every card
   * from either hand, and a player who cannot see it is doing arithmetic off two
   * piles to find out why three of their four cards are greyed out (#124, item
   * 38). It was already in the state — cribbage publishes `count` in its
   * `publicVars` — and simply not drawn.
   *
   * A hook rather than a `pack.id ===`, for the reason every row of the
   * presentation table in src/templates/CONTRACT.md is a hook: the question
   * "what is this table counting" has an answer in more games than this one, and
   * the default — no strip at all — costs a pack that has nothing to say nothing.
   */
  function renderTableCounters(state) {
    const declared = state.pack.template.tableCounters?.(makeCtx(state)) || [];
    el.tableCounters.replaceChildren();
    el.tableCounters.hidden = !declared.length;
    for (const counter of declared) {
      const chip = document.createElement('div');
      chip.className = 'table-counter';
      const label = document.createElement('span');
      label.className = 'table-counter__label';
      label.textContent = counter.label;
      const value = document.createElement('span');
      value.className = 'table-counter__value';
      value.textContent = counter.text;
      chip.append(label, value);
      // One name for the pair, for the same reason the track carries one: "Count
      // 17" read as two unrelated things is worse than the sentence.
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', counter.aria || `${counter.label} ${counter.text}`);
      el.tableCounters.appendChild(chip);
    }
  }

  /**
   * EVERY SEAT'S BOARD, AS ONE BOARD (#136).
   *
   * `seatCounters` one rung the other way from `tableCounters`: not a number the
   * table owns, but the same number from every seat drawn on one picture. A
   * cribbage board is one object with both players on it, and the reason it is
   * one object is that the only question worth asking of it is comparative —
   * am I ahead, by how much, and did that hand close the gap. Two 88px tracks
   * in the two corners of the felt the eye never goes (the opponent's plate and
   * the status bar's own chip) made that a subtraction; #124 shipped them and
   * round 5 came back with "where is my board and pegs?".
   *
   * WHICH SEATS GET A LANE is the table's question and not the component's, so
   * it is answered here: ring order from the chair on your left (seatRing.js),
   * with your own lane last so it lands nearest your hand, and one lane per
   * SIDE rather than per seat — `scoreBearers` is the same rule the score chips
   * use, and for the same reason. A partnership has one score and drawing it
   * twice reads as two scores that happen to be equal.
   *
   * WHICH seats have a board at all is nobody's question here either: a lane
   * exists where `counterTrack()` says the seat's primary counter is a position
   * on a road, and a pack whose seats count things gets no board and no row.
   */
  function sharedBoardFor(state) {
    const seat = mySeat();
    const bearers = scoreBearers(state.pack, state.seats, seat);
    const order = [...opponentRing(state.seats, seat), seat]
      .filter((s) => Number.isInteger(s) && s >= 0 && s < state.seats && bearers.has(s));
    return sharedBoard(order.map((s) => {
      const identity = identityOf(s);
      const marks = seatSideMarks(state.pack, state.seats, seat, s);
      return {
        seat: s,
        counter: seatCountersFor(state, s, { minimized: false })[0],
        name: seatLabel(s),
        // The roster's mark, exactly as the plate and the trick's owner tags
        // wear it — never a manifest value reaching the felt (§7b).
        mark: identity.icon || identity.initials || String(s + 1),
        color: identity.color,
        mine: isMySeat(s),
        partner: marks.partner,
        side: marks.side,
      };
    }));
  }

  /**
   * The board on the felt, repainted rather than rebuilt.
   *
   * THE PEGS ONLY MOVE IF THE NODES SURVIVE. A render rebuilds the felt, and an
   * element created fresh at 37% has never been anywhere else — its transition
   * on `left` has no old value to run from, so a rebuilt board teleports and the
   * one piece of motion this component is allowed never happens. So the handle
   * from the last render is offered the new model first, and a full rebuild is
   * what happens when the seats or the road actually change (a new match).
   *
   * `session.board` is the model, and it is what the seat plate and the status
   * chip read to know their own small track is now redundant — which is why
   * this runs FIRST in `render`.
   */
  function renderSharedBoardRow(state) {
    const model = sharedBoardFor(state);
    session().board = model;
    el.tableBoard.hidden = !model;
    // The middle only wraps for a table that HAS a board. A permanently wrapping
    // middle would let Milestones' contract ladder fall under the piles on a
    // narrow window, which is a layout for a problem nobody has.
    el.feltMiddle.classList.toggle('felt-middle--boarded', !!model);
    if (!model) {
      el.tableBoard.replaceChildren();
      session().boardHandle = null;
      return;
    }
    if (session().boardHandle && updateSharedBoard(session().boardHandle, model)) return;
    session().boardHandle = renderSharedBoard(model);
    el.tableBoard.replaceChildren(session().boardHandle.node);
  }

  function statusTextFor(state, acting) {
    // REVIEWING IS NOBODY'S TURN. The reel under the felt says where in the
    // match this is; the bar says only that the table is not waiting on anyone.
    if (session()?.review) return 'Reviewing';
    if (state.gameOver) return `Game over — ${winnerSentence(state)}`;
    // THE ROUND BEAT IS NOBODY'S TURN. The felt is holding the position the hand
    // ended in (runRoundBeat) and this state's `turn` is whatever the template
    // left it on — cribbage's show leaves it on the last player, so the bar read
    // "Your turn" over a table where the player's hand was empty and nothing was
    // tappable. It is not a turn; it is the end of the hand.
    //
    // AND WHAT CONTINUES IT, WHEN THE COUNT IS WAITING FOR A PERSON (#181). The
    // gate is the tell rather than the rung: `session.beatResume` is set during
    // the round beat by exactly one thing, a count of a show that has no clock on
    // it (runShowSequence), so this promises the tap at precisely the moments a
    // tap is the only thing there is. Three motionless counts read as a hang
    // otherwise — the same sentence the trick hold says below, for the same
    // reason, and #log carries the whole of it.
    if (session()?.roundBeat) {
      return session().beatResume ? 'Round over. Tap to go on.' : 'Round over.';
    }
    // THE TRICK BEAT IS NOBODY'S TURN EITHER (#123). The posed position's `turn`
    // is still on whoever played the fourth card — the trick has not been
    // resolved on this copy — so the bar would read "Your turn" over four cards
    // that are about to be swept and a hand that cannot be played from. It says
    // who is taking them instead, which is the question the beat exists to
    // answer.
    //
    // AND WHAT ENDS IT, AT THE RUNG WHERE NOTHING ELSE WILL (#176). A hold with a
    // clock on it needs no instructions — it is over before the sentence has been
    // read. The Manual rung's hold has no clock, and "North's trick." over a table
    // that will never move again on its own reads as a frozen game rather than as
    // a beat. `waits` is the plan's own `holdMs == null`, carried here by
    // runTrickReveal, so the felt promises a tap exactly when a tap is the only
    // thing there is. The same sentence goes to #log, which is the announced half.
    if (session()?.trickBeat) {
      const whose = `${seatPossessive(session().trickBeat.seat)} trick.`;
      return session().trickBeat.waits ? `${whose} Tap to go on.` : whose;
    }
    // A BID IS THE OTHER SENTENCE THIS BAR ASKS FOR RATHER THAN WRITES. It goes
    // round the table one seat at a time, so "whose turn" is already the right
    // shape — what it adds is WHICH KIND of turn, which is the whole difference
    // between a phase where you tap a card and one where the only live control is
    // a button in the rail.
    //
    // ASKED OF THE MODE, NOT THE PHASE NAME (#219), exactly as the commit below
    // is: `turn.phase === 'bid'` was trick-taking's word for its own phase, seven
    // lines under the comment that follows. The words are the template's
    // (`commitPrompt`), and the voice goes with the question because "Nell is
    // bidding…" is a NAME, which is this table's to know and not a template's.
    if (interactionMode(state) === 'bid') {
      const mine = acting.some(isMySeat);
      const seat = mine ? mySeat() : state.turn.seat;
      const prompt = commitPromptFor(state, seat, legalMovesFor(state, seat), voiceOf());
      return mine ? prompt.staging : prompt.waiting;
    }
    // HOW MANY, HERE, because nothing else says it in time. The commit button
    // only appears once exactly that many cards are staged, so its label cannot
    // be where a player learns the number — and the sentence that used to say it
    // stood in a bar above the hand that no longer exists
    // (src/ui/interaction.js). This slot is 122px at 375px, which is why the
    // count replaces "your pick" rather than joining it.
    //
    // ASKED OF THE MODE, NOT THE PHASE NAME. `turn.phase === 'pass'` was a
    // platform file knowing one template's word for its own phase; cribbage's is
    // `discard`, Pinochle's is `meld`, and both mean the same thing to this bar.
    // Every sentence comes from the template's `commitPrompt` now (#107, #106).
    if (interactionMode(state) === 'pass') {
      const mine = acting.some(isMySeat);
      const seat = mine ? mySeat() : state.turn.seat;
      const prompt = commitPromptFor(state, seat, legalMovesFor(state, seat), voiceOf());
      return mine ? prompt.staging : prompt.waiting;
    }
    return acting.some(isMySeat) ? 'Your turn' : `${seatPossessive(state.turn.seat)} turn`;
  }

  return {
    renderStatusBar,
    renderSharedBoardRow,
    paintSpeedChip,
    cycleSpeed,
    // Returned for tests only: table.js reaches these through the two above.
    statusTextFor,
    renderTableCounters,
    sharedBoardFor,
  };
}
