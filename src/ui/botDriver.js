// WHOSE TURN IT IS, AND WHEN THEY TAKE IT.
//
// Extracted from src/ui/table.js ahead of the rest of the felt, because this is
// the part that stops being UI. Per design §10/§17.5, when Phase 8 lands the
// bot driver runs HOST-SIDE: the host schedules a bot's turn, applies its move,
// and broadcasts it, while every other peer just receives the move. Extracting
// it now is a move of two functions; extracting it after Phase 8 would be
// surgery on load-bearing multiplayer code.
//
// It owns three things and nothing else: the pending-turn timer, the
// announcement beats, and the persona rolls behind them. Everything it needs
// from the table — who is in a seat, what a move looks like when it lands, how
// to report a failure — is injected, so this module never touches the DOM.
//
// TIMERS, NOT A LOOP. Every timer here is `Arcade.session.setTimeout`, which
// freezes while the frame is suspended (§6c — forgotten timers are the fleet's
// number one battery drain) and cancels itself when a save import replaces the
// state. The `epoch` guard is still needed on top of that, for "Play again" and
// for leaving to the lobby, which the SDK knows nothing about.

import { chooseBotMove } from '../engine/bot.js';
import { thinkTimeMs } from '../players/roster.js';

/**
 * @param currentEpoch  () => the table's epoch, read at fire time
 * @param botDelayMs    () => the player's bot-speed setting
 * @param me            the seat lens (src/players/seats.js); the driver never
 *                      plays a seat this device holds
 * @param identityOf    (seat) => roster identity (name, persona)
 * @param actingSeatsOf (state) => seats that may act right now
 * @param announcementsFor (state, seat) => what that seat may declare/call
 * @param playMove      (state, move, seat) => void — apply, render, persist,
 *                      and schedule whatever comes next. The table's own path.
 * @param playAnnouncement (state, move, myEpoch) => void
 * @param onError       (message) => void, for a move that throws
 */
export function createBotDriver({
  currentEpoch,
  botDelayMs,
  me,
  identityOf,
  actingSeatsOf,
  announcementsFor,
  playMove,
  playAnnouncement,
  onError,
}) {
  function cancelTurn(session) {
    if (session?.botTimer) session.botTimer.cancel();
    if (session) session.botTimer = null;
  }

  function cancelBeats(session) {
    if (!session) return;
    for (const timer of session.announceTimers) timer.cancel();
    session.announceTimers = [];
  }

  function scheduleNextTurn(session, myEpoch) {
    // Cancel first: an announcement or a re-entry could otherwise leave two
    // timers racing to move the same bot.
    cancelTurn(session);
    if (!session) return;
    const state = session.state;
    if (state.gameOver) return;
    const seat = actingSeatsOf(state).find((s) => !me.holds(s));
    if (seat === undefined) return;

    session.botTimer = Arcade.session.setTimeout(() => {
      session.botTimer = null;
      if (myEpoch !== currentEpoch()) return; // superseded — drop the stale turn
      // WRAPPED, BECAUSE A BOT'S MOVE REACHES THE ENGINE FROM INSIDE A TIMER.
      // If the enumerator and the validator ever drift, applyMove throws with
      // nobody to catch it: the exception escapes into the timer callback, the
      // table freezes mid-turn, and the player is given no reason at all. A
      // caught one at least says so on the log line and leaves the felt usable.
      try {
        const actingNow = actingSeatsOf(state).find((s) => !me.holds(s));
        if (actingNow === undefined) return; // the human became the only one who may act
        const move = chooseBotMove(state, actingNow, { persona: identityOf(actingNow).persona });
        if (!move) return;
        playMove(state, move, actingNow);
      } catch (err) {
        console.error('[cardstock] a bot move failed', err);
        onError('Something went wrong on a bot’s turn. The game is paused here.');
      }
    }, thinkTimeMs(identityOf(seat), botDelayMs()));
  }

  /**
   * Decide, once per window, whether each bot remembers to declare and whether
   * each notices somebody who did not — then schedule what they decided.
   *
   * THIS IS WHERE THE MECHANIC BECOMES A GAME. A bot that always declares makes
   * the catch button decorative; one that always catches makes forgetting an
   * instant loss. Persona weights (`callReliability`, `catchAttention`) and a
   * deliberate delay before a catch are what leave room for a player to declare
   * late and get away with it — which is exactly the tension the rule has at a
   * real table.
   *
   * The decision is CACHED per vulnerability window (on the session, so it dies
   * with the match). Re-rolling on every render would hand a forgetful bot a
   * fresh chance every time anybody moved, and `callReliability: 0.5` would
   * behave like 1.
   */
  function scheduleAnnouncementBeats(session, myEpoch) {
    cancelBeats(session);
    if (!session) return;
    const state = session.state;
    if (state.gameOver || !state.pack.template.enumerateAnnouncements) return;

    const beat = (fn, ms) => {
      session.announceTimers.push(Arcade.session.setTimeout(() => {
        if (myEpoch !== currentEpoch()) return;
        fn();
      }, ms));
    };

    for (let seat = 0; seat < state.seats; seat++) {
      if (me.holds(seat)) continue;
      const identity = identityOf(seat);
      const persona = identity.persona;
      if (!persona) continue;
      const options = announcementsFor(state, seat);

      const own = options.find((a) => a.type === 'announce');
      if (!own) {
        session.botCallDecision.delete(seat);
      } else {
        if (!session.botCallDecision.has(seat)) {
          session.botCallDecision.set(seat, Math.random() < persona.callReliability);
        }
        if (session.botCallDecision.get(seat)) {
          // They say it as they put the card down, near enough.
          beat(() => playAnnouncement(state, own, myEpoch),
            Math.round(thinkTimeMs(identity, botDelayMs()) * 0.4));
        }
      }

      for (const option of options) {
        if (option.type !== 'challenge') continue;
        const key = `${seat}>${option.target}`;
        if (!session.botCatchDecision.has(key)) {
          session.botCatchDecision.set(key, Math.random() < persona.catchAttention);
        }
        if (!session.botCatchDecision.get(key)) continue;
        // The grace is the whole fairness of it: a sharp bot pounces in under a
        // second, a dreamy one takes three, and either way you had a moment to
        // say it yourself.
        const grace = 700 + (1 - persona.catchAttention) * 2600 + Math.random() * 500;
        beat(() => playAnnouncement(state, option, myEpoch), Math.round(grace));
      }
    }

    // Windows that have closed leave no stale decision behind to be reused by
    // the next one.
    for (const key of [...session.botCatchDecision.keys()]) {
      const [watcher, target] = key.split('>').map(Number);
      const stillOpen = announcementsFor(state, watcher)
        .some((a) => a.type === 'challenge' && a.target === target);
      if (!stillOpen) session.botCatchDecision.delete(key);
    }
  }

  return { scheduleNextTurn, scheduleAnnouncementBeats, cancelTurn, cancelBeats };
}

/**
 * What a bot did, in the log line.
 *
 * The four every genre has live here; anything a template invents it names
 * itself (`template.botVerbs`), which is what stops a fifth template's move
 * types from all reading "played". Falling back to 'played' rather than to the
 * raw move type is deliberate: a log line is prose, and `layDown` is not a word.
 */
const BOT_VERBS = {
  draw: 'drew',
  playCard: 'played',
  discard: 'discarded',
  pass: 'passed the turn',
};

export function botVerb(template, moveType) {
  return template.botVerbs?.[moveType] || BOT_VERBS[moveType] || 'played';
}
