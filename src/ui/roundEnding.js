// THE ROUND ENDING, HELD ON THE FELT: what the table does with the move that
// finished a hand, from the four cards still on it to the sheet that deals the
// next one.
//
// WHY A SNAPSHOT AT ALL. The engine deals the next round inside the move that
// ends the old one (movePipeline's maybeFinishRound) and that is not
// negotiable — the redeal consumes seeded RNG, so a replay has to cross the
// boundary at exactly the same move. By the time `afterMove` runs there is no
// longer a position on the state that shows the hand that just finished: the
// zones are cleared, the turn has advanced, six new cards are in the hand. So
// the felt keeps its own copy of where the round ENDED and paints that, and the
// real state — which is the one that is saved, published and played on — waits
// behind the summary's Continue. WHEN THE FELT SHOWS THE DEAL, not when the
// engine makes it (issue #120).
//
// Carved out of src/ui/table.js (#223, seam 2), which resolves 43 DOM ids at
// import time and therefore cannot be loaded by `node --test`. That is the whole
// reason this file takes `el`, `session`, `epoch` and the rest as PARAMETERS:
// the beat the felt holds after a trick, the order a show is counted in, and
// what a tap during either of them means are decisions a Node test should be
// able to ask about, and for as long as they lived beside that element table the
// only way to ask was a regex over the source. Seven of those regexes are now
// imports (tests/eventBanner, tests/roundBeat, tests/pace, tests/handReveal).
//
// So the split runs along "does this need the screen":
//
//   - MODULE SCOPE, pure and exported: how a template wants one count of its
//     show staged (`showStepOf`) and the player's rung read live
//     (`currentPace`). Neither touches `document` at all.
//   - `createRoundEnding(deps)`: everything that paints, stamps or schedules —
//     the pre-move fork, the trick pose and its held beat, the hand held open
//     (the plates turned over, the counts on the docked sheet — see
//     src/ui/inspection.js), the pace view, the three timer APIs, and the doors
//     out of the sheet.
//
// THE THREE TIMER APIS, because they are the thing to be careful with here and
// they are deliberately not one:
//
//   - `session.beatTimers[]` — the sheet's own opening, one beat after the last
//     card lands, armed by `beatTimer` and swept by `cancelRoundBeat`.
//   - `session.revealTimer` — the completed trick's hold, one at a time, armed
//     in `runTrickReveal` and cancelled by the tap that beats it.
//   - `session.advanceTimer` — the sheet dealing the next hand by itself, armed
//     by `armAutoAdvance` and cancelled by `cancelAutoAdvance`.
//
// EVERY ONE OF THEM IS EPOCH-GUARDED AS WELL AS HELD. The handle is what lets
// `stopSession` stop a timer firing at all; the epoch check is what stops one
// that has already fired from doing damage to the match that replaced it. Both,
// always — `epoch()` is read into `myEpoch` at arming time and compared at fire
// time, and the same pair guards the two held-beat resumes, which have no timer
// at the rung that waits for a person.

import { makeCtx, actingSeats as actingSeatsOf } from '../engine/context.js';
import { forkState } from '../engine/fork.js';
import { poseTrick, poseRoundEnd } from '../engine/poses.js';
import { sidesOf, sideScores, sideScoreOf } from '../engine/sides.js';
import { schedule } from './clock.js';
import { motionAllowed } from './flight.js';
import { heldBeatLine } from './celebrations.js';
import { showCardModel } from './showCard.js';
// "Is this input a NEW gesture, or the one that opened the beat?" is a question
// about two numbers, and the answer to it is the whole of why a human-played
// fourth card no longer sweeps itself (#176) and why one tap does not run a
// whole cribbage show off the felt (#181). It lives in session.js because a
// Node test can reach it there; this file is now reachable too, and the rule
// still belongs beside the session fields it is about.
import { inputEndsHeldBeat } from './session.js';
import { roundBeatPlan } from './roundBeat.js';
import { inspectionOf, plateReveal, countCardIds, partCardIds } from './inspection.js';
import { partPhrase } from '../engine/scoring.js';
import { revealSentence } from './scoreDirection.js';
import { paceLevel, nextSummaryPace } from './pace.js';
// NOT IMPORTED, ALTHOUGH THEY ARE THE SHEET: `showRoundSummary`,
// `hideRoundSummary`, `paintRoundPace` (src/ui/panels.js) and `confirmAction`
// (src/ui/confirm.js) are handed in as parameters instead, because those two
// modules resolve their own element ids at import time — importing either one
// here would put this file back behind the wall it was carved out to get past.
// They are the same kind of dependency as `render`: the felt's, not this
// module's, and this module only says when.
import { playDeal } from '../arcade/audio.js';
import {
  loadSettings, saveSettings, recordForfeit, recordDailyResult,
} from '../arcade/storage.js';
import { concludeTable } from '../arcade/persist.js';

/**
 * HOW A TEMPLATE WANTS ONE COUNT OF ITS SHOW STAGED, or null (#219).
 *
 * `showStep` answers where the cards being counted are, which card is the shared
 * cut, what the pile is called and whether the position has to be posed back
 * first — the four things this file used to know about cribbage by name (four
 * zone ids and two nouns). Every reader below treats a missing answer as "the
 * platform's own reveal", which is what every other pack's round ending is.
 */
export function showStepOf(state, step) {
  if (!state || !step) return null;
  try {
    return state.pack.template.showStep?.(makeCtx(state), step) || null;
  } catch {
    return null;
  }
}

/**
 * The player's rung, read LIVE — and now actually live (#181).
 *
 * IT READ THE FELT'S SNAPSHOT OF THE PREFERENCES BLOB, AND THE SNAPSHOT WAS NOT
 * REFRESHED BY THE ONE SHEET THAT SETS THIS. That copy was loaded at boot and
 * again on a re-render, which runs on a resume or an SDK settings change — and
 * the NEW-GAME SHEET is neither. So a player who opened the lobby, picked Quick
 * and dealt got a table still running at whatever rung the tab booted on, for
 * the whole match: `botDriver`'s `difficulty` already read fresh for exactly
 * this reason and says so in its own comment ("deal a Sharp game straight after
 * a Steady one and the snapshot would still say Steady"), and the pace never got
 * the same treatment (that one is #91).
 *
 * FOUND BY TRYING TO WATCH THE TIMED RUNG COUNT ITSELF. #181's acceptance is
 * that Quick is paced exactly as it always was, and a browser at Quick sat there
 * waiting for a tap — because the rung reaching the arithmetic was Manual, the
 * rung the tab had booted on. The mid-match control was never affected, which is
 * why this survived: `cyclePace` wrote storage AND the snapshot in one breath,
 * so the dial appeared to work everywhere it was watched.
 *
 * ONE READ PER ROUND ENDING is what this costs, which is one `JSON.parse` of a
 * small object per hand — the same price `difficulty` pays per bot turn.
 *
 * AND IT STAYED A STORAGE READ ONCE THE ROOT CAUSE WAS FIXED (#184), which was a
 * decision rather than an oversight, so here is the reasoning. #184 refreshed the
 * snapshot where a match opens, so the snapshotted pace would have been as fresh
 * as this is at every call site the felt has — the two really were the same
 * value, and one of them was redundant. The redundant one was kept HERE, because
 * the two are not the same KIND of correct: a value read at the instant it is
 * used cannot go stale by construction, while a snapshot is only as fresh as the
 * last person to remember the line that refreshes it, and this fault was found
 * twice by watching a rung fail to do anything. `difficulty` and the card-speed
 * number made the same trade next door for the same reason — and once all three
 * had, nothing read the snapshot at all, so #203 removed it.
 */
export function currentPace() {
  return paceLevel(loadSettings().pace);
}

/**
 * The round ending, bound to one table screen.
 *
 * `session` and `epoch` are THUNKS for the same reason src/ui/zoneRenderer.js
 * and src/ui/seatRow.js take them that way: both are replaced wholesale by
 * `adoptMatch` and `closeTable`, so a captured value would be a closure over a
 * match that has gone. Everything else is a function of table.js's that this
 * one calls — the render, the flight, the banners, the bot driver's two
 * cancels — handed in rather than imported, because they are the felt's and
 * this file is not the felt.
 */
export function createRoundEnding({
  el, session, epoch, liveState, feltState, render, animateMove, renderStatusBar,
  seatLabel, seatPossessive, mySeat, cardById, pulseSeat,
  releaseBanner, celebrateDeal,
  // The felt's pointer: light these card ids, or none (src/ui/inspection.js).
  focusCards,
  currentFlightMs, powerSaving, scheduleNextTurn, cancelBotTurn,
  cancelAnnouncementBeats, exitToLobby,
  showRoundSummary, hideRoundSummary, paintRoundPace, confirmAction,
  // The sheet closed and the next hand is on the felt — the moment a shared
  // table's guests are let out of theirs (#283).
  onSummaryClosed = () => {},
}) {
  /**
   * The position as it was before the move now being applied.
   *
   * Taken before EVERY local move rather than only the ones that end a round,
   * because "does this move end the round" is a question only the engine can
   * answer and only after the fact. A fork is array copies and a 52-entry Map
   * (src/engine/fork.js); the bot makes hundreds of them per turn.
   */
  let preMoveFork = null;

  function notePreMove(state) {
    preMoveFork = state ? forkState(state) : null;
  }

  /**
   * Where the round ENDED: the pre-move position with `move` applied to it and
   * the round boundary deliberately not run.
   *
   * `template.applyMove` rather than the pipeline's `applyMove` is the whole
   * trick, and it is a RENDERING decision rather than a rules one — the fork is a
   * throwaway the engine has never heard of, it is never logged, saved or
   * published, and the live state has already crossed the boundary for real.
   * What comes back is the felt as the last card left it: the card on the pile it
   * landed on, the trick still there to be gathered, cribbage's four hands and
   * its crib turned face up in `show`.
   *
   * Null on the multiplayer path, where the host module applied the move before
   * this device heard about it and there is no pre-move copy to advance. That
   * degrades to what the felt did before: the hold still happens, the repaint
   * still shows the fresh deal underneath it.
   */
  function takeRoundFinal(move) {
    const fork = preMoveFork;
    preMoveFork = null;
    return poseRoundEnd(fork, move);
  }

  /**
   * The position the move passes THROUGH, when the template says it has one.
   *
   * The trick reveal's half of the pre-move fork (#123), and deliberately a fork
   * OF the fork: `takeRoundFinal` still wants the untouched pre-move copy a line
   * later, because the last trick of a hand needs both — the four cards on the
   * table, and then the position the round ended in.
   *
   * `template.poseMove` answering false means there is nothing to hold and the
   * half-applied copy is dropped on the floor, which is the only safe thing to do
   * with it: it is a move that has been half made.
   */
  function takeTrickPose(move) {
    return poseTrick(preMoveFork, move);
  }

  /**
   * Hold the completed trick on the felt, then let the move finish arriving.
   *
   * The fourth card lands on a trick that KEEPS it — `animateMove` flies it onto
   * the posed position, so the copy that lands is the card the player then reads
   * — and everything the SWEEP is (the gather flight, the next turn, a round
   * ending underneath it) waits behind `resume`.
   *
   * WHAT NO LONGER WAITS IS THE ANNOUNCEMENT (#180). The banner naming the winner,
   * the live region, the trick cue and the seat pulse run at the TOP of the hold,
   * while the four cards are whole and the player is looking at them — `announce`
   * is that half, handed in by `afterMove` so this function owns WHEN and the
   * caller owns what. It used to run with the gather, which was defensible while
   * the hold was a fixed ~920ms and became the main thing wrong with the beat as
   * soon as the hold waited for a tap: the player sat in front of four cards with
   * nothing saying who had won them, tapped, and the answer flashed past as the
   * cards flew away.
   *
   * TWO THINGS CAN END IT, AND ONLY ONE OF THEM IS A CLOCK (#176). A tap on the
   * felt or a key press runs the same `resume` immediately, and at the Manual rung
   * (`reveal.holdMs == null`) it is the only thing that ever will — no timer is
   * armed at all, exactly as `armAutoAdvance` arms none for that rung's sheet.
   *
   * BUT NOT THE TAP THAT OPENED IT. The player's own fourth card is played by a
   * tap on a card inside `#table`, and this whole function runs before that click
   * has finished bubbling to the felt — so the hold was opening and closing on one
   * gesture, and the beat was missing for exactly the tricks the player finished.
   * The moment the hold opens is stamped below and `endHeldBeat` compares every
   * input against it; `inputEndsHeldBeat` in src/ui/session.js is the rule and
   * the long version of this paragraph.
   */
  function runTrickReveal(poseState, move, from, reveal, resume, announce) {
    // `waits` is what the felt SAYS about itself: a hold with no clock on it
    // reads as a frozen table unless the bar tells the player what moves it.
    session().trickBeat = { seat: reveal.trick.seat, waits: reveal.holdMs == null };
    // STAMPED FIRST, and on `performance.now()` rather than the session clock,
    // because that is the origin `Event.timeStamp` is measured against. Before the
    // render and the flight so that nothing between here and the input handlers
    // can land inside the hold's own opening.
    session().beatOpenedAt = performance.now();
    session().trickPoseState = poseState;
    render(poseState);
    animateMove(poseState, move, from);

    // AFTER the render and the flight, so the banner is measured against the felt
    // it is about — `placeBanner` looks for the highest card in the middle, and on
    // this frame that is the posed trick the sentence must not cover.
    const said = announce ? announce() : null;

    const myEpoch = epoch();
    // ONE WAY OUT, TAKEN ONCE, whichever end it is asked from.
    //
    // The epoch guard is the one this function has always carried — a hold whose
    // table has been closed, replaced or re-dealt must not resume into it. What is
    // new is the identity check: the session points at the resume for the hold
    // that is CURRENTLY running, so a stale closure (a tap landing after the timer
    // fired, a second tap, a tap arriving after the next trick armed its own) sees
    // that it is no longer the one being held and does nothing.
    const release = () => {
      if (myEpoch !== epoch() || !session() || session().beatResume !== release) return;
      session().beatResume = null;
      session().beatOpenedAt = null;
      // The tap is beating a clock that is still running. Nothing else cancels it
      // at this point — `stopSession` is for a table going away, not for a beat
      // ending early — so a hold ended by hand would otherwise fire a second time
      // into the next position.
      if (session().revealTimer) session().revealTimer.cancel();
      session().revealTimer = null;
      session().trickBeat = null;
      session().trickPoseState = null;
      // AND THE SENTENCE COMES DOWN WITH THE CARDS (#180). A held pill has no
      // clock of its own; this is the clock. A no-op at every rung whose banner
      // was given an ordinary lifetime, and a no-op if a louder event has since
      // raised its own — see releaseBanner.
      releaseBanner();
      resume();
    };
    // BEFORE THE TIMER IS ARMED, because for the Manual rung there is no timer:
    // the hold is over the moment this is reachable and not a moment before.
    session().beatResume = release;

    if (reveal.holdMs == null) {
      // THE LIVE REGION CARRIES THE INSTRUCTION, not just the status bar (#176).
      // #status-text is not announced — it is a label that changes — and a hold
      // that only a sighted pointer user can discover is a hold a screen-reader
      // player is stuck in. #log is `role="status"`, it is the surface every other
      // beat on this felt speaks through, and it has room for the whole sentence
      // where the bar's 122px slot ellipsises.
      //
      // AND IT CARRIES THE ANNOUNCEMENT IN THE SAME WRITE (#180). The announcement
      // half wants this surface too, and two writes in one frame is one sentence
      // announced and one lost — the one at risk being the instruction, which is
      // the whole accessibility net for a pause with no end on it. `heldBeatLine`
      // is the join; the bare possessive is the fallback for a hold that somehow
      // had no narration to announce.
      el.log.textContent = heldBeatLine(
        said ? said.text : `${seatPossessive(reveal.trick.seat)} trick`,
      );
      return;
    }

    // A TIMED HOLD SAYS ITS HALF NOW TOO. `settle` may still overwrite this with
    // a louder action's sentence when the hold ends, exactly as it always has.
    if (said) el.log.textContent = said.text;

    // HELD ON THE SESSION (#150), not merely epoch-checked. The epoch guard stops
    // a timer that has already fired from doing damage; a handle is what lets
    // `stopSession` stop it firing at all — and now also what a tap cancels.
    session().revealTimer = schedule(() => {
      if (myEpoch !== epoch() || !session()) return;
      session().revealTimer = null;
      release();
    }, reveal.holdMs);
  }

  /**
   * End the beat the felt is holding, if `event` is an input that is allowed to.
   * True when there WAS such a beat and this input ended it.
   *
   * The felt's tap handler and the keyboard both come through here rather than
   * reaching for `session.beatResume` themselves, so "what a tap during a held
   * beat does" is one function rather than two that can drift.
   *
   * AND IT IS EVERY SUCH BEAT, NOT ONLY THE TRICK'S (#181). A completed trick's
   * hold and each count of a cribbage show both wait for a person at the rung that
   * waits, they are never on the felt at the same time, and what a tap means is
   * identical for both: dismiss what is being read and put up whatever is next. So
   * they share the handle, the stamp and this door — one gesture, one beat, at
   * whichever of them is standing.
   *
   * AND THE INPUT ITSELF IS PART OF THE QUESTION (#176). A tap that plays the
   * fourth card is also a tap on the felt, and the hold is opened inside that same
   * dispatch — so without this the player's own last card opened a hold and swept
   * it away in one gesture, and the beat existed only for tricks the bots ended.
   * The show is the same shape stacked three deep: each count opens inside the
   * dispatch of the tap that dismissed the one before it, so without the stamp one
   * gesture would run the whole ending off the screen. `inputEndsHeldBeat` in
   * src/ui/session.js is the rule, with the full account of why it is a moment
   * rather than a list of exempt elements.
   */
  function endHeldBeat(event) {
    const resume = session()?.beatResume;
    if (!resume) return false;
    if (!inputEndsHeldBeat(session().beatOpenedAt, event?.timeStamp)) return false;
    resume();
    return true;
  }

  /**
   * EVERYTHING A MOVE THAT ENDED A ROUND DECIDES, IN ONE PLACE (#202).
   *
   * Two paths apply a move that can end a round — `afterMove`, and
   * `performAnnouncement`, which deliberately does not re-enter it (re-scheduling
   * the turn would restart a bot's think time every time anybody spoke). Both
   * then owe the round ending the same four answers, and they were two copies of
   * them that drifted: the announcement's plan was built without `shared`, so a
   * round ended by Wildfire's last-card call at a HOSTED table walked the Manual
   * rung's held count with no clock on it and gated that device's queue while
   * three other players kept playing — the exact thing #181 put the cap there to
   * stop. One builder is the fix; `tests/pace.test.js` pins it as the only one.
   *
   * SIDE EFFECT, hence the name: `takeRoundFinal` CONSUMES the pre-move fork,
   * whether or not this move ended anything, so no fork is ever left behind for
   * the next move to re-use. Call it after `takeTrickPose`, which forks the same
   * snapshot and does not consume it.
   *
   * @returns { ended, roundOver, finalState, plan, shown } where `ended` is the
   *   round boundary either way and `roundOver` only the one the match survives
   *   (#189), `plan` is null unless there is a sheet to hold back, and `shown` is
   *   what the felt paints — the ending posed for its first count, or the live
   *   state when there is nothing to pose.
   */
  function beginRoundEnding(state, move) {
    const events = state.events;
    // THE ROUND THAT ENDED, and whether the match survived it. `roundOver` is
    // the live match's — the sheet's — and null for the hand that ends the match;
    // `ended` is either, because the ending position is wanted both ways (#189).
    const ended = events.find((e) => e.type === 'roundOver');
    const roundOver = ended && !ended.over ? ended : null;
    // WHERE THE ROUND ENDED, claimed before anything can throw.
    const finalState = takeRoundFinal(ended ? move : null);
    const plan = roundOver ? roundBeatPlan(events, {
      flightMs: currentFlightMs(),
      // The rung is read HERE, when the round ends, so a pace changed on the last
      // sheet is the pace this one runs at.
      pace: currentPace().id,
    }) : null;
    // What the felt paints. The LIVE state everywhere else: it is what is saved,
    // what the summary reads, and what the next deal is already in.
    const shown = (plan && finalState) ? finalState : state;
    return { ended, roundOver, finalState, plan, shown };
  }

  /**
   * Hold the felt on the ending while the beat runs.
   *
   * SET BEFORE THE RENDER, because `render` reads it: while the felt is showing a
   * position the engine has already moved past, nothing on it is actable. The
   * kept copy is what anything that repaints for a reason of its own during the
   * beat repaints (`feltState`) — null on the path with no snapshot, where the
   * felt is already the live state.
   */
  function holdRoundEnding(plan, finalState, shown) {
    if (!session() || !plan) return;
    session().roundBeat = true;
    session().roundFinalState = finalState ? shown : null;
  }

  /** Let the ending go: the felt goes back to painting the live state. */
  function releaseRoundEnding() {
    if (!session()) return;
    session().roundBeat = false;
    session().roundFinalState = null;
    session().inspection = null;
    focusCards?.(null);
  }

  /** Forget the sheet — it is closed, and nothing is owed to putting it back. */
  function closeRoundSummary() {
    if (!session()) return;
    session().roundSummaryOpen = false;
    session().reopenSummary = null;
  }

  /**
   * The round's counts as the sheet draws them: whose, the cards, and what each
   * part came to — with the ids the felt lights when one is picked.
   *
   * THE EXTRA CARD IS READ OFF THE POSITION, not off the event — cribbage's cut,
   * named by `showStep`'s `starterId` (#219). It is a shared zone with
   * `visibility: 'all'` and it is right there in the ending fork, so putting its
   * id on the wire would be a second copy of a public fact. The ending fork is
   * also the only state that still HAS it by now: the engine crossed the round
   * boundary inside this same move and the live state holds the next deal's cut.
   *
   * The positions in a count's `parts` are relative to `[...cards, starter]`,
   * which is the order `theShow` scored them in (src/ui/inspection.js).
   */
  function countModels(finalState, counts) {
    return (counts || []).map((count) => {
      const staging = showStepOf(finalState, count);
      const starterId = staging?.starterId ?? null;
      const ids = countCardIds(count, starterId);
      const faces = ids
        .map((id) => ({ id, card: cardById(finalState, id), starter: id === starterId }))
        .filter((face) => face.card);
      const model = showCardModel({
        whose: seatPossessive(count.seat),
        isCrib: count.isCrib,
        points: count.points,
        parts: count.parts,
        // A reveal's count is titled for what it shows and says "nothing" for a
        // zero; "nineteen" is cribbage's joke and stays on cribbage's counts.
        what: count.reason === 'taken' ? 'penalty cards' : (staging?.what || null),
        zeroLabel: count.reason ? 'nothing' : undefined,
      });
      const said = revealSentence(count, { label: seatLabel, possessive: seatPossessive, viewerSeat: mySeat() });
      // The pile alone — "Hand", "Crib", "Penalty cards" — for a block that sits
      // inside its own seat's card on the sheet, where the possessive is the card.
      return {
        seat: count.seat,
        title: model.title,
        label: count.reason === 'taken' ? 'Penalty cards' : capitalise(staging?.what || 'hand'),
        points: count.points,
        zero: model.zero,
        zeroLabel: model.zeroLabel,
        faces,
        ids,
        parts: (count.parts || [])
          .map((part) => ({ label: partPhrase(part), points: part.points ?? 0, ids: partCardIds(count, part, starterId) }))
          .filter((part) => part.label),
        tone: said?.tone || 'neutral',
        aria: said?.text || model.aria,
      };
    });
  }

  /**
   * What a seat's plate turns over while the hand is held, dressed with the chip
   * it wears — or null. src/ui/seatRow.js asks this of every opponent it draws.
   *
   * The chip is the seat's own counts summed, in the tone the reveal's sentence
   * uses. A won pile already wears its points (`hiddenPileChip`), so a plate
   * showing what it TOOK carries no second number — unless the take was the
   * moon, which is the one fact the pile chip has no words for.
   */
  function capitalise(word) {
    return word ? word[0].toUpperCase() + word.slice(1) : word;
  }

  function revealOf(state, seat) {
    const inspection = session()?.inspection;
    // A REVIEW IS ITS OWN LENS (src/ui/reviewController.js): a position scrubbed
    // to from the sheet is drawn as that position, not as the hand that ended.
    if (!inspection || session().review) return null;
    const reveal = plateReveal(state, inspection, seat);
    if (!reveal) return null;
    const lead = reveal.counts.find((c) => c.reason) || reveal.counts[0] || null;
    const said = lead ? revealSentence(lead, { label: seatLabel, possessive: seatPossessive, viewerSeat: mySeat() }) : null;
    const moon = reveal.counts.find((c) => c.sweep);
    let chip = null;
    if (moon) {
      chip = { text: 'Shot the moon', tone: said?.tone || 'neutral', aria: said?.text };
    } else if (reveal.points != null && reveal.kind !== 'taken') {
      chip = {
        text: `${reveal.points} ${reveal.points === 1 ? 'point' : 'points'}`,
        tone: said?.tone || 'neutral',
        aria: said?.text,
      };
    }
    return { ...reveal, chip };
  }

  /**
   * WHAT EACH SEAT PROMISED AND WHAT IT TOOK, for the sheet that shows what that
   * was worth — one phrase per seat, or null for a pack with nothing to say.
   *
   * Read off the ENDING position rather than the live one, and that is the whole
   * reason it is asked here: by the time the summary opens, the engine has
   * crossed the round boundary and wiped every bid (src/engine/movePipeline.js),
   * so `state.playerVars[seat].bid` is already the next hand's nothing. The fork
   * #120 keeps for the felt still has them. Null on the multiplayer path too,
   * where there is no fork.
   *
   * THE SENTENCE IS THE TEMPLATE'S (#219, `roundLines`). This used to read the
   * counters whose `kind` is `'bid'` and `'tricks'` and compose "Bid 4, took 5"
   * out of them — two of one template's slugs and two of its words, in a platform
   * file, deciding on that template's behalf that the two numbers belong in one
   * sentence in that order. What is left here is the one thing the felt owns: the
   * position the phrase is true of, and the row it is drawn in
   * (src/ui/panels.js's `showRoundSummary`).
   */
  function roundContractLines(finalState) {
    if (!finalState) return null;
    const declared = finalState.pack.template.roundLines?.(makeCtx(finalState));
    if (!Array.isArray(declared)) return null;
    // A sparse array is the shape: one entry per seat that has something to say,
    // and the sheet skips the seats with nothing (`contract?.[s]`). Anything that
    // is not a string is dropped rather than printed as "undefined".
    const rows = [];
    let any = false;
    for (let seat = 0; seat < finalState.seats; seat++) {
      const line = declared[seat];
      if (typeof line !== 'string' || !line) continue;
      any = true;
      rows[seat] = line;
    }
    return any ? rows : null;
  }

  /* ------------------------------------------------------------------ *
   * How fast the table moves between hands (#150)
   * ------------------------------------------------------------------ */

  /**
   * What `paintRoundPace` needs to draw: a name, a duration, and whether the
   * duration may be animated.
   *
   * REDUCED MOTION AND THE POWER SAVER TAKE THE ANIMATION, NOT THE TIMER. A
   * player who has asked for less movement has not asked the table to stop
   * dealing — they have asked for the countdown to be a mark rather than a
   * moving one. The sheet still deals itself at exactly the same moment.
   */
  function paceView(level) {
    return {
      label: level.label,
      autoMs: level.autoMs,
      animate: motionAllowed() && !powerSaving(),
    };
  }

  /**
   * THE SHEET'S OWN CLOCK, STOPPED — one spelling of it (#223).
   *
   * Four places want this and they had four spellings of it between them: the
   * arming re-check, the ending-wide sweep, the pace control restarting the
   * countdown, and the sheet's map putting Manual in the control while it is
   * open. Three said `cancel()` and left the field holding a spent handle,
   * which is only harmless because every reader re-checks it; one nulled it.
   * Cancelling and forgetting are the same act, so they are one function.
   */
  function cancelAutoAdvance() {
    if (!session()) return;
    if (session().advanceTimer) session().advanceTimer.cancel();
    session().advanceTimer = null;
  }

  /**
   * Deal the next hand by ourselves, once the sheet has been up for its rung.
   *
   * THROUGH `dismissRoundSummary` AND NOTHING ELSE. That function is the single
   * door: it clears `roundSummaryOpen`, paints the deal, and only then calls
   * `scheduleNextTurn`. A timer that reached for `scheduleNextTurn` directly
   * would let a bot play its first card into a felt still showing the last hand.
   *
   * `null` IS MANUAL and arms nothing: the sheet waits for a tap, forever.
   *
   * ZERO IS NOT "DEAL IMMEDIATELY" HERE — IT IS A BUG (#174). The rung that deals
   * with no pause is `instant`, and `instant` never opens a sheet at all:
   * `runRoundBeat` sees `plan.instant` and dismisses through the door before
   * `showRoundSummary` is ever called. So there is no honest way for a sheet to
   * be on screen with a delay of 0 to serve, and a `setTimeout(…, 0)` from here
   * can only be a summary closing itself on the next tick — which is exactly how
   * the pace control used to delete itself the first time it was tapped. The same
   * guard takes a negative or a NaN, for the reason any arithmetic on a rung's
   * `autoMs` could produce one: a countdown that is not a wait is not a countdown.
   */
  function armAutoAdvance(ms) {
    if (ms == null) return;
    if (!(ms > 0)) return;
    const myEpoch = epoch();
    cancelAutoAdvance();
    session().advanceTimer = schedule(() => {
      if (myEpoch !== epoch() || !session()) return;
      session().advanceTimer = null;
      dismissRoundSummary();
    }, ms);
  }

  /**
   * Everything a round ending has in flight, stopped. Safe with no session.
   *
   * A SHOW THAT WAITS IS "IN FLIGHT" TOO (#181), and it is the one part of an
   * ending with no timer to cancel: at the rung that waits, a count sits behind
   * `session.beatResume` and nothing but a person will ever come for it. A gate
   * left open here outlives the ending it belongs to — the sheet's own tap would
   * find a count's resume still standing and advance a beat of the hand before it.
   * This is only ever reached with the felt's OTHER held beat already released:
   * the trick hold's resume is what leads into a round ending, and it clears
   * itself before `settle` runs.
   */
  function cancelRoundBeat() {
    if (!session()) return;
    for (const timer of session().beatTimers) timer.cancel();
    session().beatTimers = [];
    session().beatResume = null;
    session().beatOpenedAt = null;
    cancelAutoAdvance();
  }

  /** A beat timer that cancels with the session rather than only checking its epoch. */
  function beatTimer(fn, at) {
    const myEpoch = epoch();
    const handle = schedule(() => {
      if (myEpoch !== epoch() || !session()) return;
      session().beatTimers = session().beatTimers.filter((t) => t !== handle);
      fn();
    }, at);
    session().beatTimers.push(handle);
    return handle;
  }

  /**
   * The round's result as ONE SENTENCE, for the rung that shows no sheet.
   *
   * Instant is not "the summary, faster" — it is the summary traded away, and a
   * round whose score went nowhere at all would be a rule change rather than a
   * pace. So the totals still arrive, in #log, which is the live region a screen
   * reader hears and the one surface on this felt that is a record rather than a
   * moment.
   *
   * PER SIDE, like the sheet it stands in for (#125): a partnership pack banks a
   * side's whole result on one seat, so a per-seat list would read as one partner
   * carrying the team and the other scoring nothing all match.
   *
   * IT ENDS WITH THE NEW ROUND because it IS the deal's message: `#log` carries
   * one sentence, and `dismissRoundSummary`'s own "Round 4." would otherwise
   * overwrite this one in the same frame it was written.
   */
  function roundResultLine(state, ev) {
    const sides = sidesOf(state.pack, state.seats);
    const totals = sideScores(state.pack, state.seats, ev.totals || []);
    const parts = sides.map((members, i) => {
      const who = members.map((seat) => seatLabel(seat)).join(' & ');
      return `${who} ${totals[i] ?? 0}`;
    });
    return `Round ${ev.round} over — ${parts.join(', ')}. Round ${state.roundNumber}.`;
  }

  function cyclePace() {
    const level = paceLevel(nextSummaryPace(currentPace().id));
    const stored = loadSettings();
    // STORAGE IS THE ONLY WRITE, BECAUSE STORAGE IS THE ONLY READ (#203).
    // `currentPace` asks storage as the round ends, so the NEXT round reads the
    // new rung without waiting for a settings event to come back round through
    // main.js — and without a second copy of the answer to keep in step.
    saveSettings({ ...stored, pace: level.id });
    paintRoundPace(paceView(level));
    // RESTARTED, NOT RESUMED, and the ring is redrawn to match: a player who
    // reaches for this at 2.4s of a 2.5s countdown is asking for more time, and
    // handing them a tenth of a second of Relaxed would be the opposite.
    cancelAutoAdvance();
    if (session()?.roundSummaryOpen) armAutoAdvance(level.autoMs);
  }

  /**
   * Run a round ending: hold the felt on it, then open the hand.
   *
   * ONE BEAT, THEN EVERYTHING AT ONCE. The last card lands (`holdMs`, measured
   * against its flight); then every plate turns face up, every count goes on
   * the docked sheet, and the table waits for the deal. It used to walk the
   * counts one floating card at a time — a tap per seat at the rung that waits,
   * a clock per seat at the rungs that count — and the board under them never
   * showed a card. src/ui/inspection.js has the long version.
   *
   * NO SECOND ACKNOWLEDGEMENT. The sheet IS the acknowledgement here — its
   * Continue is the button that deals the next hand — so the felt holds, the
   * sheet asks, and the new hand does not exist on screen until it is dealt.
   *
   * @param state      the LIVE state — the one the summary reads its round number
   *                   and totals from, and the one the next deal is already in
   * @param finalState what the felt is showing: where the round ended
   */
  function runRoundBeat(state, plan, finalState) {
    // Nothing from a previous ending may still be in flight under this one.
    cancelRoundBeat();
    // WHO WON THE HAND, on the table rather than only on the sheet. A shedding
    // pack names the seat that went out (`ctx.endRound(winner)`, still on the
    // fork because the round boundary was not run over it); a trick-taking round
    // names nobody and its closing trick has already pulsed the seat that took
    // it (celebrateTrick).
    if (finalState.roundEnded && finalState.roundWinner != null) {
      pulseSeat(finalState.roundWinner, 'good');
    }
    const open = () => {
      if (!session()?.roundBeat && !plan.instant) return;
      session().roundSummaryOpen = true;
      // THE RUNG THAT SHOWS NO SHEET (#150). Instant does not open the summary
      // and then race it away — it never opens one. `roundSummaryOpen` is still
      // set first, because `dismissRoundSummary` is the door and the door checks
      // that flag; what is skipped is the panel, not the transition through it.
      if (plan.instant) {
        dismissRoundSummary(roundResultLine(state, plan.roundOver));
        return;
      }
      // THE HAND OPENS: every plate turns over on this render.
      openInspection(state.events, finalState);
      // KEPT AS A CLOSURE, so a review opened from the sheet can put it back
      // exactly as it was (leaveReview) — countdown restarted, not resumed.
      const counts = countModels(finalState, session().inspection.counts);
      session().reopenSummary = () => {
        showRoundSummary(
          state, plan.roundOver, session().table.seating, roundContractLines(finalState),
          paceView(paceLevel(plan.pace)),
          { counts, focus: focusCards },
        );
        armAutoAdvance(plan.autoAdvanceMs);
      };
      session().reopenSummary();
      renderStatusBar(feltState(), actingSeatsOf(feltState()));
    };
    beatTimer(open, plan.summaryAt);
  }

  /**
   * Turn the ended hand face up on the felt (src/ui/inspection.js): set what the
   * plates are to show, then repaint the position the felt is holding.
   *
   * `events` are the move's — the reveals ride on them — and `shown` is what
   * the felt paints. Both the hand between rounds and the hand that ended the
   * match come through here, which is what makes them one experience.
   */
  function openInspection(events, shown, { final = false } = {}) {
    if (!session()) return;
    session().inspection = inspectionOf(events, { final });
    render(shown);
  }

  /**
   * A TOUCH ON THE TABLE STOPS THE CLOCK. The rungs that deal by themselves are
   * a guess about how long a hand takes to read, and the moment a player starts
   * poking at the board the guess is wrong — so the countdown stops where it is
   * and the sheet waits for the button, as Manual's does. True when there was a
   * countdown to stop.
   */
  function pauseAutoAdvance() {
    if (!session()?.roundSummaryOpen || !session().advanceTimer) return false;
    cancelAutoAdvance();
    paintRoundPace({ ...paceView(currentPace()), autoMs: null, paused: true });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * The doors out of the sheet
   * ------------------------------------------------------------------ */

  /**
   * Stop here, between rounds, without playing the match out.
   *
   * The door that was missing. A match runs to its pack's threshold — Wildfire's
   * is 500 points, which is a long evening — and the only way out was to close
   * the table, which by design does NOT end anything: the game keeps its place
   * and sits in the lobby waiting. That is right for "I'll come back to this"
   * and wrong for "I'm done with this one", and there was no way to say the
   * second.
   *
   * Recorded as a forfeit through the same contract the lobby's Start over uses.
   * The two doors out of an unfinished match must not disagree about what a loss
   * is — leaving while behind is not a way to avoid the loss appearing.
   */
  async function endMatchFromSummary() {
    if (!liveState()) return;
    const state = liveState();
    const myEpoch = epoch();
    // BEFORE THE QUESTION IS ASKED, not after it is answered (#150). The sheet
    // deals itself now, and a confirm dialog is a pause of the player's own
    // length — so a countdown left running would have dealt the next hand out
    // from under "are you sure?", and the answer would have arrived at a match
    // that had moved on. If they keep playing, it is re-armed below.
    const held = paceLevel(currentPace().id);
    cancelRoundBeat();
    paintRoundPace({ ...paceView(held), autoMs: null });
    // AHEAD IS A SIDE'S QUESTION. Walking away while your partner is carrying the
    // score is not walking away from a loss, and the sentence has to say so.
    const totals = sideScores(state.pack, state.seats, state.scores);
    const leader = Math.max(...totals);
    const ahead = sideScoreOf(state.pack, state.seats, state.scores, mySeat()) >= leader;
    const ok = await confirmAction(
      `End this ${state.pack.manifest.name} match after ${state.roundNumber - 1} `
      + `${state.roundNumber - 1 === 1 ? 'round' : 'rounds'}?`
      + (ahead ? '' : ' It counts as a forfeit.'),
      { okLabel: 'End match', cancelLabel: 'Keep playing' },
    );
    if (!ok || myEpoch !== epoch() || liveState() !== state) {
      // "Keep playing" puts the countdown back exactly as it was, restarted —
      // the player has just spent an unknown amount of time in a dialog.
      if (myEpoch === epoch() && session()?.roundSummaryOpen) {
        paintRoundPace(paceView(held));
        armAutoAdvance(held.autoMs);
      }
      return;
    }

    cancelBotTurn();
    cancelAnnouncementBeats();
    // The sheet was counting down to a deal when the player asked to leave.
    cancelRoundBeat();
    // WALKING OUT OF THE DAILY IS THIS DAY'S RESULT, not a forfeit against the
    // pack's own record: there is one run per day and no second attempt, so
    // abandoning it is losing it, and the streak has to end. The pack's casual
    // record is left alone for the reason src/arcade/storage.js gives — the
    // daily's ladder is not the ladder that record is about.
    //
    // CONCLUDED, NOT MERELY CLEARED (#166). Clearing the slot here was undone a
    // moment later: `exitToLobby` closes the table, closing flushes, and the
    // flush wrote the match straight back — so the lobby offered to resume a
    // game whose forfeit had already been recorded. Marking the table is what
    // the flush reads (src/arcade/persist.js).
    //
    // A SOLO TABLE ONLY. At a table the player is hosting, walking out of the
    // summary leaves the lobby and nothing else: the game goes on for the people
    // still sitting at it, so its save must too — ending it for everybody is
    // "Stop hosting". (This used to clear `match.<packId>` there as well, which
    // was the host's unrelated solo game of the same pack.)
    const table = session().table;
    if (table.local()) concludeTable(table);
    if (table.daily) {
      recordDailyResult(state.pack.id, table.daily.date, {
        won: false, hands: state.roundNumber,
      });
    } else {
      recordForfeit(state.pack.id, table.seating);
    }
    closeRoundSummary();
    releaseRoundEnding();
    hideRoundSummary();
    exitToLobby();
  }

  /**
   * @param message what #log says as the deal lands. The default names the new
   *   round; the Instant rung (#150) passes the round's RESULT instead, because
   *   at that rung there is no sheet and this line is the only place the score
   *   change is ever said — and it has to be this one line, since the render
   *   below would overwrite anything written just before it.
   */
  function dismissRoundSummary(message) {
    // The SESSION says whether we are between rounds; the panel merely shows it.
    // This used to branch on `!el.roundOverlay.hidden` (panels.isRoundSummaryOpen),
    // which made a DOM attribute the only record of a game-state fact — and one
    // that any other code path hiding the overlay would silently erase.
    if (!session() || !session().roundSummaryOpen || !liveState()) return;
    closeRoundSummary();
    onSummaryClosed();
    // A TAP BEATS THE CLOCK, and the clock must not fire behind it. This is also
    // what makes the door idempotent under the panel's two listeners: the second
    // call finds `roundSummaryOpen` false and returns above.
    cancelRoundBeat();
    // THIS IS WHERE THE NEXT HAND BECOMES VISIBLE. The engine dealt it inside the
    // round-ending move; until this line the felt has been showing where the
    // round ended (runRoundBeat), which is why the render below is the first
    // sight of the new cards and why it deals them with the full stagger.
    releaseRoundEnding();
    hideRoundSummary();
    session().dealAnimation = true;
    playDeal(liveState().seats);
    render(liveState(), message || `Round ${liveState().roundNumber}.`);
    // The hand the engine dealt inside the round-ending move is only now on the
    // screen, so this is where anything it announced gets said (`celebrateDeal`).
    celebrateDeal(liveState());
    scheduleNextTurn();
  }

  /**
   * A pre-move copy belongs to the match it was taken in.
   *
   * `adoptMatch` and `closeTable` each spelled `preMoveFork = null` for
   * themselves while the slot was a module variable in table.js; now that it is
   * this module's, they ask for it by name.
   */
  function forgetPreMove() {
    preMoveFork = null;
  }

  return {
    notePreMove,
    forgetPreMove,
    takeTrickPose,
    runTrickReveal,
    endHeldBeat,
    beginRoundEnding,
    holdRoundEnding,
    runRoundBeat,
    openInspection,
    countModels,
    revealOf,
    pauseAutoAdvance,
    cancelRoundBeat,
    // The sheet's map stops the countdown and puts Manual in the control while
    // it is open (roundMapNode, src/ui/reviewController.js), which is the
    // fourth site of the cancel the three above share — so it asks for it here
    // rather than spelling it again.
    cancelAutoAdvance,
    paceView,
    cyclePace,
    dismissRoundSummary,
    endMatchFromSummary,
    // NOT CALLED FROM src/ui/table.js. These are the pieces the tests have a
    // direct question about, and every one of those questions was a regex over
    // this function's source for as long as there was no way to call it: that a
    // beat timer is held as well as
    // epoch-guarded (`beatTimer`), that Manual arms nothing and a delay which is
    // not a wait arms nothing either (`armAutoAdvance`), what the hold raises and
    // lets go of (`holdRoundEnding`/`releaseRoundEnding`), what a closed sheet
    // forgets (`closeRoundSummary`), and the one sentence the rung with no sheet
    // leaves behind (`roundResultLine`). See tests/roundBeat.test.js,
    // tests/pace.test.js and tests/eventBanner.test.js.
    beatTimer,
    armAutoAdvance,
    releaseRoundEnding,
    closeRoundSummary,
    roundResultLine,
  };
}
