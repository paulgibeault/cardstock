// THE DOORS ONTO THE FELT: every way a match arrives on this screen, and the
// one way it leaves.
//
// Carved out of src/ui/table.js (#223, seam 4), which resolves 43 DOM ids at
// import time and therefore cannot be loaded by `node --test`. That is why this
// file takes `el`, the session slot and the rest as PARAMETERS: which door
// narrates its deal, which one resumes instead of dealing, what a superseded
// open leaves behind and what leaving the table resets are questions a Node
// test should be able to ask, and for as long as they lived beside that element
// table the only answer was a regex (tests/matchDoors.test.js now drives them).
//
// THE DOORS, and who comes through each:
//
//   - `openTable`          a lobby tap, a `?pack=` deep link, a save import,
//                          and the daily button — resume what storage holds
//                          for the pack, or deal fresh (`startGame`).
//   - `dealHostedTable`    the host's party deal: a new hand, never storage.
//   - `resumeHostedTable`  the host's way back to a table that outlived the
//                          felt (#48): a state handed in, nothing dealt.
//   - `adoptSharedView`    a joiner: a view from the host, drawn by the same
//                          renderer.
//   - `startGame`          "Play again", and the fresh half of `openTable`.
//   - `closeTable`         the way out, and the one reset point.
//
// All of them but the joiner's end in `adoptMatch`, THE ONLY PLACE A SOLO OR
// HOSTED SESSION IS BORN.
//
// WHO OWNS THE SLOTS. table.js keeps `session`, `epoch` and `sharedTable` —
// the felt reads the session in well over a hundred places and hands it to
// three other seams as a thunk, and the move loop compares the epoch on every
// scheduled turn — and this file writes them through `setSession`,
// `bumpEpoch` and `setSharedTable`. Every write of the first two is in here,
// which is what a setter makes visible. `openToken` is the one slot nothing
// outside the doors reads, so it lives here outright.

import { createState } from '../engine/state.js';
import { makeCtx } from '../engine/context.js';
import { rehydrateMatch, packVersionChanged } from '../engine/replay.js';
import { buildSeating } from '../players/roster.js';
import { sidesOf } from '../engine/sides.js';
import { makeCardRenderer } from './cardStyles/index.js';
import { createSession, stopSession } from './session.js';
import { clearSvgCache } from './dom.js';
import { hideInspector } from './inspector.js';
import {
  soloSeatTable, createSeatTable, LOCAL_DEVICE as LOCAL_VIEWER,
} from '../players/seats.js';
import { modelFromView } from './tableModel.js';
import { rememberPack, loadMatch, clearMatch, loadHandPrefs } from '../arcade/storage.js';
import { dailyRunFor, applyDailyLadder } from '../templates/contract-rummy-daily.js';
import { playDeal } from '../arcade/audio.js';

// Where the star sits at a table with no peers. Solo play has always dealt the
// player seat 0 and the roster paints them there; this names that fact instead
// of spelling it as a bare literal in the two places that still need one.
const SOLO_HUMAN_SEAT = 0;

// The last resort when nothing asks for anything else AND the pack declines to
// say — a manifest with no `players.best`. The new-game sheet
// (src/ui/newGame.js) is what usually decides this, and the pack's own
// recommendation is what decides it when nothing else does.
const SEAT_COUNT = 3;

/**
 * Clamp a requested seat count to what the pack says it can seat.
 *
 * NO REQUEST MEANS THE PACK'S OWN RECOMMENDATION (#156). This used to fall
 * through to a flat 3, which is the seat count a deep link (`?pack=thirteen`)
 * and a resume-with-no-saved-setup got — so the table the playtester opened
 * from a link was a three-handed Thirteen while the manifest's `players.best`
 * said four, and the new-game sheet preselected four (newGame.js reads `best`
 * for exactly this). Two surfaces answering the same question differently is
 * how "the deal is wrong" reports arrive against a pack that is right at the
 * table it was designed for.
 */
export function seatsFor(pack, requested) {
  const players = pack.manifest.players || {};
  const min = players.min ?? 2;
  const max = players.max ?? 8;
  const want = Number.isFinite(requested) ? requested : (players.best ?? SEAT_COUNT);
  return Math.max(min, Math.min(max, want));
}

/**
 * The doors, handed what they read and the setters for what they write.
 *
 * `session`, `drag`, `ladder`, `contractStrip` and `sharedTable` are THUNKS,
 * not values: the session is replaced on every door and nulled on the way out,
 * and the other three are built by `initTable` after this is constructed. The
 * round ending goes in as the object itself, because it is built first.
 *
 * The panel, dialog and confirm doors go IN rather than being imported here:
 * src/ui/panels.js, src/ui/choiceDialog.js and src/ui/confirm.js resolve their
 * own element ids at import time, like table.js (see src/ui/roundEnding.js).
 * `fetchPack` goes in because it is the one network edge — a test hands in a
 * pack from disk.
 *
 * @param deps.el               table.js's element table; this reads `statusText`
 * @param deps.session          () => the live session, or null
 * @param deps.setSession       (session | null) => void — the only writer
 * @param deps.bumpEpoch        () => void — drop any turn already in flight
 * @param deps.sharedTable      () => the joiner's table client, or null
 * @param deps.setSharedTable   (client | null) => void
 * @param deps.render           the whole-felt render every door ends in
 * @param deps.persistMatch     table.js's save, unchanged (#225 reworks it)
 */
export function createMatchDoors({
  el, session, setSession, bumpEpoch, sharedTable, setSharedTable, drag, ladder,
  contractStrip, roundEnding, fetchPack, render, liveState, feltState, humanName,
  celebrateDeal, persistMatch, flushTable, scheduleNextTurn, scheduleAnnouncementBeats,
  cancelBotTurn, cancelAnnouncementBeats, hideBanner, setHelpOpen, reportTableError,
  hideAllPanels, closeChoiceDialog, closeConfirm,
}) {
  // openTable() awaits a fetch, and the player can be back in the lobby before it
  // lands. `epoch` cannot cover that gap — it is bumped when the match is ADOPTED,
  // which is the thing we are trying not to do. So opening carries its own token:
  // whoever bumps it last owns the screen, and a superseded open returns quietly.
  let openToken = 0;

  /**
   * Take over the screen for `state`. THE ONLY PLACE A SESSION IS BORN.
   *
   * A fresh object rather than a field-by-field reset, which is what this used to
   * be — and the two bot-decision caches are exactly the ones the other half of
   * the ritual (closeTable) forgot, so a persona's "did they remember to declare?"
   * roll could survive into a match that had not been dealt when it was made.
   */
  function adoptMatch(pack, state, message, {
    dealing = false, seats = null, seating = null, shared = false, hints = 0, daily = null,
  } = {}) {
    bumpEpoch();
    // NOTHING ABOUT THE PREFERENCES BLOB IS SNAPSHOTTED HERE (#184, then #203).
    // #184 refreshed the felt's copy of it on this line, because a match opening is
    // the moment the new-game sheet's answers exist. Every reader has since moved
    // to a live storage read — `currentDelayMs`, `currentPace`, the driver's
    // `difficulty` — which is the stronger version of the same fix, so #203 deleted
    // the copy and this line with it. `hands` goes through `loadHandPrefs`, which
    // `createSession` just below calls fresh for this pack.
    stopSession(session());
    // A pre-move copy belongs to the match it was taken in, and this is a
    // different one (src/ui/roundEnding.js's notePreMove).
    roundEnding.forgetPreMove();
    if (drag()) drag().cancel();
    setSession(createSession({
      pack,
      state,
      // WHO OWNS EACH SEAT, before who they are. Solo is one human on this device
      // and bots in the rest — which is the whole reason ownership is a table
      // rather than the number zero, because a HOSTED deal arrives with its
      // seats already decided in the party panel and passes them in.
      // `sides` is which chairs are a pair (src/engine/sides.js) — the pack's
      // declaration, handed to the table that answers "whose seat is it" so the
      // two never disagree about who is partnering whom.
      seats: seats || soloSeatTable(state.seats, {
        humanSeat: SOLO_HUMAN_SEAT, sides: sidesOf(pack, state.seats),
      }),
      // Who is at this table — derived from the match SEED, so a resumed game
      // re-seats the same opponents and a fresh deal brings new ones. A hosted
      // deal overrides it: some of those chairs hold people, and a seed knows
      // nothing about people.
      seating: seating || buildSeating(state.seed, state.seats, { humanSeat: SOLO_HUMAN_SEAT, humanName: humanName() }),
      // From the PACK rather than the manifest alone: the deck is what tells a
      // style which colours it actually has to draw. Built once per match rather
      // than per render — resolving a theme walks the whole deck.
      cardArt: makeCardRenderer(pack.manifest, pack.cardsById),
      handPrefs: loadHandPrefs(pack.id),
      shared,
      // Handed in with the session rather than patched on afterwards, because
      // this function persists the match before it returns and a count set
      // after that write is a count the next reload has already lost.
      hintsTaken: hints,
      // `{ date, seed }` when this is a daily run, null when it is an ordinary
      // game. It decides which slot the match is written to and which record its
      // ending goes into — both of which happen before the first render, so it
      // has to arrive WITH the session rather than be set on it afterwards.
      daily,
    }));
    // Set on the NEW session, not before it exists: a fresh deal staggers its
    // cards in, a resumed match must not (the cards have been there all along).
    session().dealAnimation = dealing;
    // The parsed-SVG cache is keyed by markup the OLD renderer produced, so it is
    // dead weight from here on — and left alone it would accumulate one entry per
    // card per pack for as long as the tab is open.
    clearSvgCache();
    hideAllPanels();
    setHelpOpen(false);
    hideBanner();
    render(state, message);
    // ONLY ON A FRESH DEAL. A resume arrives here having REPLAYED its log
    // (src/engine/replay.js), so `state.events` is the last move of a hand that
    // has been going for twenty turns — narrating it would open the table on a
    // sentence about something the player did yesterday.
    if (dealing) celebrateDeal(state);
    persistMatch();
    scheduleNextTurn();
    scheduleAnnouncementBeats();
  }

  /* ------------------------------------------------------------------ *
   * What every door that waits for a pack does first, and the fresh deal
   * ------------------------------------------------------------------ */

  /**
   * CLAIM THE SCREEN for an open that has to wait for a pack.
   *
   * Bumps the token, so any open still in flight finds it has been superseded
   * when its own fetch lands, and silences the table that is still up: its bot
   * turn, its announcement beats and any choice it was asking. Returns the
   * question to ask once the fetch is back — is this open still the one that
   * owns the screen?
   *
   * ONE COPY FOR THE THREE DOORS THAT FETCH. `openTable`, `dealHostedTable`
   * and `resumeHostedTable` each spelled this out (#223's "hosted-door
   * preamble").
   */
  function claimScreen() {
    const myToken = ++openToken;
    cancelBotTurn();
    cancelAnnouncementBeats();
    closeChoiceDialog();
    return () => myToken === openToken;
  }

  /**
   * The pack has landed and the screen is still ours: remember the pack for
   * the lobby, put `title` in the launcher's bar, and clear any sheet the last
   * table left up.
   */
  function takeScreen(packId, title) {
    rememberPack(packId);
    Arcade.ui.setTitle(title);
    hideAllPanels();
  }

  /**
   * A hosted door's whole preamble: claim, fetch, and — unless a later open
   * superseded this one while the pack was in flight — take the screen under
   * the pack's own name. Null when superseded.
   */
  async function hostedPack(packId, variants) {
    const stillMine = claimScreen();
    const pack = await fetchPack(packId, variants);
    if (!stillMine()) return null;
    takeScreen(packId, pack.manifest.name);
    return pack;
  }

  /**
   * A NEW HAND: the state, the template's own setup, and the sound of the deal.
   *
   * ONE COPY FOR THE TWO DOORS THAT DEAL (#223's "fresh-deal triple"): the
   * host's party deal and `startGame`. The seed is the caller's, because the
   * two disagree about where it comes from — a daily run hands its own in.
   */
  function dealFresh(pack, seatCount, seed) {
    const state = createState({ pack, seats: seatCount, seed });
    pack.template.setup(makeCtx(state));
    playDeal(seatCount);
    return state;
  }

  /**
   * DEAL A TABLE THAT WAS BUILT BEFORE IT WAS DEALT — the host's half of the
   * party flow.
   *
   * The difference from `openTable` is entirely in what it refuses to do. It
   * does not consult storage, because a party deal is a new hand by definition
   * and resuming somebody's solo save into a room full of people is nonsense. It
   * does not derive the seating, because the seats were decided in the party
   * panel by the people sitting in them.
   *
   * @param seats    the seat table the party agreed on (src/players/seats.js)
   * @param seating  who those seats are, from the host's own lobby roster
   */
  async function dealHostedTable({ packId, variants, seats, seating, message = '' }) {
    const pack = await hostedPack(packId, variants);
    if (!pack) return null;

    const state = dealFresh(pack, seats.count, Date.now());
    adoptMatch(pack, state, message || `Playing ${pack.manifest.name}.`,
      { dealing: true, seats, seating, shared: true });
    return state;
  }

  /**
   * Put an ALREADY RUNNING hosted table back on the felt.
   *
   * The counterpart to `dealHostedTable`, and the door that was missing: since
   * the session inversion (#48) a hosted game outlives the felt, so there has to
   * be a way back to one. It deals nothing and consults no storage — the state is
   * handed in, because the session has been holding it the whole time.
   *
   * @param state    the host's live engine state, from its TableSession
   * @param seats    that table's seat table, likewise
   * @param seating  who those seats are, from the host's own roster
   */
  async function resumeHostedTable({ packId, variants, state, seats, seating, message = '' }) {
    const pack = await hostedPack(packId, variants);
    if (!pack) return null;

    adoptMatch(pack, state, message || `Back at ${pack.manifest.name}.`, { seats, seating, shared: true });
    return state;
  }

  /**
   * Draw the table from a view the host sent us.
   *
   * The joiner's counterpart to adoptMatch. It builds a state-shaped model
   * (src/ui/tableModel.js) and hands it to exactly the same render path, which is
   * the whole design: one felt, drawn by one renderer, whether the cards are in
   * front of us or being described to us.
   *
   * `seating` IS A PARAMETER rather than derived here, and that is the one real
   * difference from a solo table. Solo seating comes from the match SEED — a
   * seeded shuffle of the bot roster — and a joiner has no seed and should not
   * have one. Who is at a shared table is a fact the host publishes in its lobby
   * frame, so the caller that read that frame is the one that knows.
   *
   * @param client  the table client (src/match/client.js), for proposing moves
   */
  function adoptSharedView({ view, pack, seating, client, message = '' }) {
    setSharedTable(client || sharedTable());
    const model = modelFromView(view, pack);

    const seats = createSeatTable({
      seats: view.seats, localDeviceId: LOCAL_VIEWER, sides: sidesOf(pack, view.seats),
    });
    if (view.seat !== null && view.seat !== undefined) {
      seats.claim(view.seat, { deviceId: LOCAL_VIEWER });
    }

    if (!session() || session().pack?.id !== pack.id) {
      bumpEpoch();
      stopSession(session());
      if (drag()) drag().cancel();
      setSession(createSession({
        pack, state: model, seats, seating, cardArt: makeCardRenderer(pack.manifest, pack.cardsById),
        handPrefs: loadHandPrefs(pack.id),
      }));
      clearSvgCache();
      hideAllPanels();
      hideBanner();
    } else {
      // AN ORDINARY VIEW IS A REPLACEMENT, NOT A NEW MATCH (design decision D2).
      // Swapping the model in place is what lets a card animate from where it
      // was to where it is, instead of the table blinking on every move.
      session().state = model;
      session().seats = seats;
      session().seating = seating;
    }
    render(model, message);
  }

  function startGame(pack, seats, { seed, daily = null } = {}) {
    cancelBotTurn();
    cancelAnnouncementBeats();
    const seatCount = seatsFor(pack, seats);
    // Date.now() is only the entropy source. The seed itself is persisted with
    // the match from the first write, which is what makes the log replayable
    // (src/engine/replay.js) rather than merely re-runnable — and, since the
    // seating is derived from it, what rotates the opponents per game.
    //
    // A DAILY RUN HANDS ITS OWN SEED IN, and that is the whole of what makes the
    // day shared: `milestones|2026-09-10` deals the same cards and seats the same
    // opponents on every device, because both are derived from it.
    const state = dealFresh(pack, seatCount, seed ?? Date.now());
    adoptMatch(state.pack, state, daily
      ? `${pack.manifest.name} daily — ${daily.date}.`
      : `Playing ${pack.manifest.name}.`, { dealing: true, daily });
  }

  /**
   * The day's run for `pack`, with the pack rewritten to play it.
   *
   * The ladder is DERIVED, never stored: everything about the day comes back out
   * of `<packId>|<YYYY-MM-DD>`, so a resume re-derives it from the seed the save
   * already carries rather than trusting ten contracts that were written to disk
   * (src/templates/contract-rummy-daily.js says why that matters). The pack object is the
   * private clone `fetchPack` just handed us, so rewriting its rules affects this
   * table and nothing else.
   */
  function openDailyRun(pack) {
    const run = dailyRunFor(pack);
    applyDailyLadder(pack, run.ladder);
    return { date: run.date, seed: run.seed };
  }

  /**
   * How many chairs a daily run is played at.
   *
   * FIXED PER PACK, and read from the manifest rather than from the table's own
   * default seat count: a daily everybody gets the same of cannot depend on a
   * default that moves, and the seating is derived from the seed, so the seat
   * count is the other half of "the same table everywhere".
   */
  function dailySeats(pack) {
    const players = pack.manifest.players || {};
    return seatsFor(pack, players.best ?? players.min);
  }

  /**
   * Open `packId`'s table: resume its saved match when there is one, deal a
   * fresh game when there is not.
   *
   * Every entry to the table goes through here — a lobby tap, a `?pack=` deep
   * link, and a save import (`onStateReplaced` is a fresh boot by contract, §3).
   */
  async function openTable(packId, { variants, seats, daily = false } = {}) {
    const stillMine = claimScreen();

    el.statusText.textContent = 'Dealing…';
    // WHICH OF THE PACK'S TWO SOLO GAMES THIS IS. A casual save and today's daily
    // sit in different slots (src/arcade/storage.js), so opening one never
    // disturbs the other — the whole point of the second key.
    const slot = daily ? 'daily' : 'match';

    // A stored match pins the variant set: the same pack loaded with different
    // variants is a different rule set, and replaying a log against it diverges.
    // A stored match wins over anything the caller asked for: its log was
    // recorded under ITS rule set and seating, and replaying it under another is
    // divergence, not a preference.
    let stored = loadMatch(packId, { slot });
    const pack = await fetchPack(packId, stored ? stored.variants : variants);
    if (!stillMine()) return; // the player left before the pack landed

    // TODAY'S LADDER, BEFORE ANYTHING IS DEALT OR REPLAYED. A stored daily has to
    // be replayed under the rules its log was recorded against, which for a daily
    // means the ladder its seed names — so the pack is rewritten first.
    const run = daily ? openDailyRun(pack) : null;
    if (run && stored && stored.seed !== run.seed) {
      // Yesterday's unfinished run. A daily is not a game to come back to a week
      // later — the puzzle it was is gone — so the slot is dropped and today's is
      // dealt instead. Nothing is recorded: an abandoned daily was never a result.
      clearMatch(packId, { slot });
      stored = null;
    }

    // The variant's name ALONE, and only in the launcher's title bar. At a table
    // the game you are playing is the only name that means anything, and saying
    // it twice — once in the launcher bar, once in our own — cost the status bar
    // the room it needed to stay on one line. The lobby restores the wordmark
    // (src/main.js).
    //
    // A DAILY SAYS WHICH DAY, and this bar is where it says it: the felt has no
    // room for a second name — which is what the paragraph above is about — and a
    // ladder being unfamiliar is not a label. This is the surface that answers
    // "what am I looking at", so it is the one that carries the date.
    takeScreen(packId, run ? `${pack.manifest.name} — daily ${run.date}` : pack.manifest.name);

    if (stored) {
      // Asked BEFORE the replay, because a version bump is the one cause of a
      // failed replay we can name. Reordering two entries in a deck file changes
      // cardsById's insertion order, which changes the seeded shuffle, which
      // deals every stored match a different hand — so the log replays into a
      // state its own moves are illegal in. "The rules changed" is the honest
      // sentence; "could not replay" is not one a player can do anything with.
      const rulesMoved = packVersionChanged(pack, stored);
      try {
        if (rulesMoved) throw new Error(`pack version changed: ${stored.packVersion} → ${pack.manifest.version}`);
        const state = rehydrateMatch(pack, stored);
        if (!state.gameOver) {
          adoptMatch(pack, state, run
            ? `Back on the ${pack.manifest.name} daily — ${run.date}.`
            : `Resumed ${pack.manifest.name}.`,
          { hints: Number(stored.hints) || 0, daily: run });
          return;
        }
      } catch (err) {
        // A pack whose rules moved under a stored log. Losing one match is the
        // right cost; resuming into a state the current rules could never have
        // produced is not.
        console.warn('[cardstock] could not replay the stored match, starting fresh', err);
        if (rulesMoved) reportTableError(`${pack.manifest.name}'s rules have changed — dealing a fresh game.`);
      }
      clearMatch(packId, { slot });
    }
    startGame(pack, run ? dailySeats(pack) : seats, run ? { seed: run.seed, daily: run } : {});
  }

  /**
   * Leave the table. The match keeps its place in storage; nothing about it
   * keeps running.
   */
  function closeTable() {
    openToken += 1;          // abandon any open still in flight
    bumpEpoch();              // and any bot turn already scheduled
    cancelBotTurn();
    cancelAnnouncementBeats();
    closeChoiceDialog();
    closeConfirm();
    hideInspector();
    if (drag()) drag().cancel();
    flushTable();
    // ONE RESET POINT. Everything a match owned — its timers, its selection, its
    // bot decisions, its idea of which cards were already on the felt — goes with
    // the object. There is no longer a list here to fall out of date with the one
    // in adoptMatch.
    hideBanner();
    stopSession(session());
    roundEnding.forgetPreMove();
    setSession(null);
    hideAllPanels();
    setHelpOpen(false);
    if (ladder()) ladder().hide();
    if (contractStrip()) contractStrip().hide();
  }

  /** Re-render in place — onResume, and after a settings change. */
  function rerenderTable() {
    if (liveState()) render(feltState());
  }

  return {
    openTable,
    closeTable,
    rerenderTable,
    dealHostedTable,
    resumeHostedTable,
    adoptSharedView,
    // "Play again" (initTable's `onPlayAgain`): the same pack and seat count,
    // dealt fresh — the fresh half of `openTable` without the storage.
    startGame,
  };
}
