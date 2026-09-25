// The table screen: one open match, rendered and driven.
//
// Extracted from src/main.js when the lobby arrived, which left main.js as
// boot plus a two-screen router. The contract that came with it:
//
//   THE OPEN TABLE IS THE ONLY MATCH THAT ADVANCES.
//
// That is structural, not policed. There is exactly one hydrated `liveState`;
// bot turns are scheduled only by scheduleNextTurn against it; and every path
// that closes a table cancels the pending timer and bumps `epoch`, so a
// callback already in flight drops its turn instead of applying it. A match
// that is not on screen is DATA — a seed and a log in storage — not a process.
// Nothing is running for it to pause.
//
// Solo only, deliberately. Session timers freeze with the frame (§6c), which
// is right for one player and wrong for a shared table: a game that stopped
// while one player glanced at another tab would desync every peer. Phase 8
// replaces them with host-wall-clock timeout events (docs/plans/ARCADE_ENHANCEMENTS §8.2).
//
// RENDERING IS ZONE-DRIVEN. The table no longer hard-codes "a draw pile and a
// center pile": every shared zone the pack declares (draw, discard, trick,
// build.1..N) gets a pile in the center row, every per-player zone beyond the
// hand (stock, discard.N, melds, won) gets one in the human's own row and a
// compact copy on each opponent's seat plate. The zone definitions
// (template defaults, overridable per pack — see src/engine/state.js) carry
// the layout/label/facing the renderer needs, which is what the design doc §3
// always said they were for.
//
// INPUT IS MOVE-DRIVEN, IN TWO DRESSINGS. enumerateLegalMoves is the single
// source of what the human may do; the UI's job is to dress those moves as
// taps AND as drops. Both ask src/ui/interaction.js the same question and get
// moves that already enumerated as legal, so a dragged card can no more
// construct an illegal play than a tapped one could. Tap-only remains a
// complete path (design doc §12) — drag is an enhancement layered over it,
// which is why no tap handler changed when it arrived.
//
// WHAT THIS MODULE NO LONGER DOES. The pure "what may I do" model lives in
// src/ui/interaction.js, the overlays in src/ui/panels.js, the pointer
// choreography in src/ui/dragController.js, who-is-who in
// src/players/roster.js, THE OPPONENT ROW — the fit ladder, the seat plate,
// the view toggle, the edge fades, the height reserve and the counters and chips
// a plate wears — in src/ui/seatRow.js (#223 seam 1), and THE ROUND ENDING —
// the pre-move fork, the completed trick's held beat, the show's counts, how
// fast the table moves between hands, the three timer APIs and the doors out of
// the sheet — in src/ui/roundEnding.js (#223 seam 2), and THE HAND — the fan,
// its fit and its second row, the gathered-card tray, the observer that re-fans
// on a width change, the reorder a drop implies and the sort toggle — in
// src/ui/handFan.js (#223 seam 3), and THE DOORS — every way a match arrives
// on the felt (a solo open or resume, the daily run, "Play again", the host's
// deal and its way back, a joiner's view) and the one way it leaves — in
// src/ui/matchDoors.js (#223 seam 4), and THE REVIEW LENS — the felt at any
// turn of the match, the reel, the map beside or over it and the two maps the
// results and the round sheet open onto it — in src/ui/reviewController.js
// (#223 seam 5). What is left here is the rest of the
// felt: piles, what a tap on a card means, and the loop that turns a move into
// sound, motion and a save.
//
// THE MOVE LOOP STILL DECIDES WHEN A ROUND ENDING HAPPENS, which is the boundary
// between this file and that one: `afterMove` reads the event window, asks
// `roundEnding.beginRoundEnding` for the whole schedule, and hands the beat its
// `resume`. What the beat then DOES — what it stamps, what it holds, what a tap
// during it means — is entirely over there.
//
// THE CARVED MODULES TAKE `el` AND `session` AS PARAMETERS, and that is not a
// style preference. The element table below resolves 43 ids at import time, so
// anything sharing a file with it cannot be loaded by `node --test` and can only
// be tested by a regex over this source. A seam that takes its elements in
// escapes that, and every gate that used to grep for its lines imports it
// instead — see the header of src/ui/seatRow.js. `initTable` is where they are
// constructed and handed what they read.

import { makeCtx, actingSeats, announcementsFor as enumerateAnnouncementsFor } from '../engine/context.js';
import { validateMove, applyMove, legalMovesFor } from '../engine/movePipeline.js';
import { baseId } from '../engine/selectors.js';
import { handValue } from '../engine/scoring.js';
import { hasSides } from '../engine/sides.js';
import { opponentRing, scoreBearers, seatSideMarks } from './seatRing.js';
// THE OPPONENT ROW (#223, seam 1). Everything the row decides that a Node test
// can be asked about is over there now, importable, because src/ui/seatRow.js
// takes its elements as parameters instead of resolving them — see its header.
import {
  createSeatRow, showsScores, scoreChipFor, seatCountersFor,
} from './seatRow.js';
// THE ROUND ENDING (#223, seam 2), for the same reason — src/ui/roundEnding.js
// takes `el`, `session` and `epoch` in, so the rules of the held beat and the
// show are importable. `currentPace` and `posedForShow` are pure and come across
// as functions; everything that paints or schedules is behind the factory.
import { createRoundEnding, currentPace, posedForShow } from './roundEnding.js';
// THE HAND (#223, seam 3). The fan's DOM side — the tray, the fit, the row
// split and the observer that re-asks it — takes `el` and `session` in the same
// way; the math it measures for is in src/ui/handOrder.js.
import { createHandFan } from './handFan.js';
// THE DOORS (#223, seam 4). The slots they write — the session, the epoch, the
// joiner's client — stay in this file; the doors are handed setters for them.
import { createMatchDoors } from './matchDoors.js';
// THE REVIEW LENS (#223, seam 5). `session.review` stays on the session, which
// is this file's slot; where a review opens, what it draws and what leaving it
// puts back are over there.
import { createReviewController } from './reviewController.js';
import { makeCardRenderer } from './cardStyles/index.js';
import { fetchPack } from './packSource.js';
import {
  flyCard, landOn, motionAllowed, flightLayer, rectOf, cardSizedRect,
  scrollCorrectedRect, flightDurationMs,
} from './flight.js';
// NOTHING FROM src/ui/session.js IS IMPORTED HERE ANY MORE. The felt's own
// Node-clean decisions over there are imported by the seams that need them:
// `normalizeSeatView` and `seatToShow` by src/ui/seatRow.js, `inputEndsHeldBeat`
// — "is this input a NEW gesture, or the one that opened the beat?" — by
// src/ui/roundEnding.js, and `createSession`/`stopSession` by
// src/ui/matchDoors.js, which is where a session is born and ends.
import { createBotDriver, botVerb } from './botDriver.js';
import { suggestMove } from './hint.js';
import { schedule } from './clock.js';
import { line } from './dom.js';
import { promptChoice, closeChoiceDialog } from './choiceDialog.js';
import { createCelebrations, TRICK_BANNER_PRIORITY, dealEvents } from './celebrations.js';
import { renderShowCard } from './showCard.js';
import { createContractLadder } from './contractLadder.js';
import { createContractStrip } from './contractStrip.js';
import { createSeatLens } from '../players/seats.js';
import { feltClock } from '../match/clock.js';
import { createMatchRecord } from './matchRecord.js';
import { watchHandGestures } from './handGestures.js';
import { createZoneRenderer } from './zoneRenderer.js';
import { renderCounterTrack } from './counterTrack.js';
import { sharedBoard, renderSharedBoard, updateSharedBoard } from './sharedBoard.js';
import { closeConfirm, confirmAction } from './confirm.js';
import { createDragController } from './dragController.js';
import { attachInspector, hideInspector } from './inspector.js';
import {
  cardName, possessive, agrees,
} from './describe.js';
import {
  interactionMode, buildUiModel, dropCandidates, draggableSources,
  commitPromptFor,
  pruneSelection, toggleHandSelection, isSelected, handAddress, implicitLandingZone,
} from './interaction.js';
import { classifyHandGesture } from './handOrder.js';
import {
  initPanels, showRoundSummary, hideRoundSummary, paintRoundPace,
  showScoreboard, showGameOver, hideAllPanels, showRules, awaitFinalLook,
  showReviewMap, hideReviewMap, isReviewMapOpen, isReviewDrawerOpen, reviewMapNode,
  hideGameOver, hideScoreboard,
} from './panels.js';
import { packRules } from './rules.js';
import { trickRevealPlan, finalShowPlan } from './roundBeat.js';
import { lastHandSentence } from './scoreDirection.js';
import { speedLevel, speedForDelay, nextSpeed } from './speed.js';
import {
  loadSettings, saveSettings, saveMatch,
} from '../arcade/storage.js';
import {
  playCardPlayed, playDraw, playShuffle, playInvalid, playWin, playAnnouncement,
} from '../arcade/audio.js';

// WHICH SEAT AM I, AND IS THIS ONE MINE — asked through the match's ownership
// table (src/players/seats.js) rather than answered by a constant.
//
// It was `const HUMAN_SEAT = 0`, read from about fifty places here and captured
// once into six other modules at init(). Both halves of that are assumptions a
// shared table breaks: a seat index is not a player, and the seat that is mine
// is not knowable before the match exists. The lens is read at call time and
// falls back to seat 0 while there is no session, so the empty felt behind the
// lobby draws exactly as it always did.
const me = createSeatLens(() => session?.seats ?? null);
const mySeat = () => me.seat();
const isMySeat = (seat) => me.holds(seat);

const el = {
  screen: document.getElementById('table-screen'),
  table: document.getElementById('table'),
  status: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  lobbyButton: document.getElementById('lobby-button'),
  speedChip: document.getElementById('speed-chip'),
  speedChipLabel: document.getElementById('speed-chip-label'),
  scoreChip: document.getElementById('score-chip'),
  scoreChipTrack: document.getElementById('score-chip-track'),
  scoreChipValue: document.getElementById('score-chip-value'),
  tableCounters: document.getElementById('table-counters'),
  tablePlay: document.getElementById('table-play'),
  tableZones: document.getElementById('table-zones'),
  tableBoard: document.getElementById('table-board'),
  // Review (REVIEW_PLAN.md phase 3): the reel under the felt.
  reviewBar: document.getElementById('review-bar'),
  reviewPrevHand: document.getElementById('review-prev-hand'),
  reviewPrevTurn: document.getElementById('review-prev-turn'),
  reviewNextTurn: document.getElementById('review-next-turn'),
  reviewNextHand: document.getElementById('review-next-hand'),
  reviewPosition: document.getElementById('review-position'),
  reviewDone: document.getElementById('review-done'),
  opponentsTop: document.getElementById('opponents-top'),
  feltMiddle: document.getElementById('felt-middle'),
  centerPiles: document.getElementById('center-piles'),
  playerPiles: document.getElementById('player-piles'),
  announceBar: document.getElementById('announce-bar'),
  contractLadder: document.getElementById('contract-ladder'),
  tableContract: document.getElementById('table-contract'),
  handRail: document.getElementById('hand-rail'),
  actionButton: document.getElementById('action-button'),
  helpButton: document.getElementById('help-button'),
  helpSheet: document.getElementById('help-sheet'),
  helpRules: document.getElementById('help-rules'),
  helpHint: document.getElementById('help-hint'),
  helpHintNote: document.getElementById('help-hint-note'),
  stageRow: document.getElementById('stage-row'),
  stageTray: document.getElementById('stage-tray'),
  handRow: document.getElementById('hand-row'),
  hand: document.getElementById('hand'),
  handSort: document.getElementById('hand-sort'),
  log: document.getElementById('log'),
  eventBanner: document.getElementById('event-banner'),
  showCard: document.getElementById('show-card'),
};

// ONE OPEN MATCH, ONE OBJECT (src/ui/session.js). Everything a match owns —
// its state, its seating, its card art, the selection, the timers, the bot
// decision caches — lives on `session`, created by adoptMatch and nulled by
// closeTable. It replaced twenty-five module-level mutables that two different
// functions hand-reset in overlapping subsets.
//
// `epoch` stays a module counter because its whole job is to OUTLIVE a session:
// scheduleNextTurn's callback checks its own epoch is still current before
// touching anything, so "Play again", a save import (onStateReplaced) and
// leaving for the lobby all bump it to drop a turn already in flight.
let session = null;
let epoch = 0;

// THE CLIENT, when this device is a joiner rather than the host.
//
// Null in solo and null on the host, and both of those are the SAME null: a
// host holds a real state and moves through the ordinary pipeline, exactly as
// a solo player does. Only a joiner has to ask somebody else, which is why
// every branch that consults this is guarded on `state.isView` rather than on
// the presence of this object — the state knows what it is, and one test for
// it beats two that can disagree.
let sharedTable = null;

// THE HOST'S EAR ON THIS TABLE, when this device is publishing to a party.
//
// Set by src/ui/party.js and null the rest of the time. Every move this device
// applies itself — a tap, a bot's turn, a timeout, an announcement — has to
// become a new view for everybody else, and this is the one notification that
// makes that happen. It is a LISTENER rather than a rerouted apply path on
// purpose: solo is the overwhelming majority of play and the way to keep it
// safe is to leave its pipeline exactly as it was, with hosting as something
// that watches rather than something that intercepts.
let onLocalMove = null;

// The screen's own furniture, not the match's.
//
// THERE IS DELIBERATELY NO COPY OF THE PREFERENCES BLOB HERE (#203). The felt
// used to keep one — see `currentDelayMs` for the story — and by the end every
// consumer read storage instead, so the snapshot was write-only.
let exitToLobby = () => {};
// Pointer choreography for lifting a card (src/ui/dragController.js), created
// once at init and reused by every match.
let drag = null;
// A renderer with no pack behind it, for the moment before the first match.
const EMPTY_ART = makeCardRenderer({});

/* ------------------------------------------------------------------ *
 * State questions
 * ------------------------------------------------------------------ */

/**
 * The player's own display name, from the arcade-wide identity — the same one
 * a peer will see when Phase 8 lands (§17.4), which is why it is read here
 * rather than invented. Never interpolated into markup; it reaches the DOM
 * only as textContent, through the roster.
 */
function humanName() {
  try {
    return (window.Arcade && Arcade.player && Arcade.player.name()) || '';
  } catch {
    return '';
  }
}

function identityOf(seat) {
  return session?.seating[seat] || { seat, name: `Seat ${seat}`, icon: '', color: '#6b7280', isBot: !isMySeat(seat) };
}

/** The name to put in a sentence about a seat. */
function seatLabel(seat) {
  const identity = identityOf(seat);
  return isMySeat(seat) ? 'You' : identity.name;
}

/**
 * The same name in the POSSESSIVE — "Your hand", "Delphine's hand".
 *
 * It lives here, beside `seatLabel`, because it is the other half of one fact:
 * this table calls the local player "You", and "You" is the one label in the
 * vocabulary that does not take an apostrophe-s. A template that builds
 * `${seatLabel(seat)}'s hand` gets "You's hand" — which shipped, and is visible
 * in #107's own screenshot.
 *
 * Owned by the platform for exactly the reason `seatLabel` is: WHAT A SEAT IS
 * CALLED is the table's business (it depends on the roster, on whether the seat
 * is mine, and on what the player typed as their name), and no template can
 * answer it. Every template that narrates a seat's possession gets the right
 * answer without knowing the rule.
 *
 * Deliberately not a general English pluraliser: a name ending in `s` takes a
 * plain apostrophe by most style guides and `'s` by others, and picking a side
 * for names players type themselves is a worse bet than the one rule that is
 * unambiguous — second person is "Your".
 */
function seatPossessive(seat) {
  return possessive(seatLabel(seat));
}

/**
 * The same rule for a VERB — "You peg 3", "Nell pegs 3".
 *
 * Owned here for the reason `seatPossessive` is: whether a seat is second
 * person is the table's fact, not a template's, and cribbage's narration got it
 * wrong in exactly the way #107's possessive did (`${seatLabel(seat)} pegs`
 * reads perfectly for every opponent and says "You pegs 3" to the player).
 */
function seatVerb(seat, verb) {
  return agrees(seatLabel(seat), verb);
}

/**
 * THE THREE HELPERS AND THE READER, AS ONE BAG — the voice a template is handed
 * whenever it has a sentence to write (src/templates/CONTRACT.md, *Naming a seat
 * in a sentence*). `describeEvent` has taken it whole since #124; `commitPrompt`
 * takes it too, because "Nell is bidding…" is a name and a name is this table's
 * to know (#219).
 */
function voiceOf() {
  return { seatLabel, seatPossessive, seatVerb, viewerSeat: mySeat() };
}

/**
 * Who may act right now — the engine's rule (src/engine/context.js), under the
 * felt's name so the dozen call sites below read as they always did. This is
 * what un-stalls the pass phase: the bot driver schedules whichever bot may
 * act, not whoever nominally holds the turn.
 */
const actingSeatsOf = actingSeats;

function cardById(state, cardId) {
  return state.pack.cardsById.get(baseId(cardId));
}

/**
 * Cards this seat has already committed to a simultaneous phase — drawn as
 * chosen, and no longer choosable.
 *
 * Trick-taking keeps them in a double-underscore-PRIVATE player var, which this
 * file read directly in three places. Asking the template is the difference
 * between the platform knowing that Hearts has a passing phase and the platform
 * knowing that some genres commit a selection before playing it.
 */
function committedSelectionOf(state, seat) {
  return state.pack.template.committedSelection?.(makeCtx(state), seat) ?? null;
}

/** What a seat may SAY right now, out of turn (§E2). Never enumerated as a play. */
function announcementsFor(state, seat) {
  // A CLIENT IS TOLD, IT DOES NOT WORK IT OUT. The host ships the acting
  // seat's options with the view (design decision D3); enumerating here would
  // mean running the template over a state with other people's hands missing.
  if (state.isView) return state.announcements;
  return enumerateAnnouncementsFor(state, seat);
}

/**
 * The legal moves for a seat — enumerated locally when we hold the whole
 * table, taken from the host's view when we do not.
 *
 * The memo behind `legalMovesFor` is only sound while state changes solely
 * through applyMove, which is true of a host and vacuous on a client (whose
 * state never changes at all — it is replaced).
 */
function movesFor(state, seat) {
  return state.isView ? state.moves : legalMovesFor(state, seat);
}


/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** The open match's card art, or an empty renderer before there is one. */
function art() {
  return session ? session.cardArt : EMPTY_ART;
}

/**
 * The open match, or null. Functions rather than fields because "is a table
 * open" is asked all over this file as a truthiness check, and a session that
 * has been nulled has to answer it honestly from every one of them.
 */
function liveState() {
  return session ? session.state : null;
}

function livePack() {
  return session ? session.pack : null;
}

/**
 * WHAT THE FELT IS SHOWING, which is the live state except during a round beat.
 *
 * Between a round-ending move and the summary being dismissed, the table paints
 * where the round ENDED while `session.state` already holds the next deal (see
 * runRoundBeat). Anything that repaints in that window for a reason of its own —
 * a resume, a settings change, a seat being claimed — has to repaint the same
 * thing, or the new hand appears early and the hold is undone by a rotation of
 * the phone.
 */
function feltState() {
  // The trick reveal is the same idea one move smaller (#123): for one beat the
  // felt holds the four cards of a completed trick while the engine has already
  // given them to the seat that won them.
  // AND REVIEW IS THE SAME IDEA FOR THE WHOLE MATCH (REVIEW_PLAN.md phase
  // 3): the felt stands at a position the engine moved past long ago, and it
  // outranks the beats because a review is opened only when no beat is up.
  return (session?.review && session.review.state)
    || (session?.trickBeat && session.trickPoseState)
    || (session?.roundBeat && session.roundFinalState)
    || liveState();
}

/**
 * Which cards were on the felt at the end of the last render.
 *
 * `.card-face--fresh` is opt-in per card because the table rebuilds its DOM
 * wholesale: without this every card is a new element every render and replays
 * the settle-in, so one bot move makes the whole table twitch. This started as
 * a hand-only set, which fixed the loudest case but not the only one: a pile's
 * top card, an opponent's fan and a laid-down meld are rebuilt on exactly the
 * same schedule and were all still replaying it. One set of keys now covers
 * every card the table draws.
 *
 * Keys are strings the renderers make up, not bare card ids, because not
 * everything that arrives is a card with an id: an opponent's nth face-down
 * back is `back:2:7`, and the same card in a different pile has genuinely
 * arrived somewhere and should say so.
 */
/** Note `key` as present, and mark `node` as fresh if it was not before. */
function markEntry(node, key) {
  if (!session || !session.enteringKeys) return node;
  session.enteringKeys.add(key);
  if (session.shownCardKeys.has(key)) return node;
  const face = node.querySelector('.card-face') || node.firstElementChild;
  if (face) face.classList.add('card-face--fresh');
  return node;
}


/**
 * Flash a seat — good or bad — as the thing that just happened to it.
 *
 * The three-line ritual (remove both classes, force a reflow so the animation
 * restarts, add one back) was written out verbatim three times: a trick landing,
 * an action card landing, and the winner at game over. Forgetting the reflow is
 * a pulse that silently does not play the second time.
 *
 * A seat is `el.hand` when it is yours and a plate otherwise, which is the other
 * half of what all three copies had in common.
 */
function pulseSeat(seat, tone = 'good') {
  const node = isMySeat(seat)
    ? el.hand
    : el.opponentsTop.querySelector(`[data-seat="${seat}"]`);
  if (!node) return;
  node.classList.remove('zone-celebrate', 'zone-lament');
  void node.offsetWidth;
  node.classList.add(tone === 'bad' ? 'zone-lament' : 'zone-celebrate');
}

/** The consistent "it is this player's turn" token, worn by seats and the action bar. */
function turnToken() {
  const token = document.createElement('span');
  token.className = 'turn-token';
  token.setAttribute('aria-hidden', 'true');
  return token;
}

/**
 * A SIMULTANEOUS PHASE IS NOT A TURN, and marking it with the turn token said
 * the one thing that cannot be true: three seats "on turn" at once.
 *
 * Every seat that has not committed yet may act while a pass or a meld is open
 * (`actingSeats`), which is the rule and is right — it is what un-stalls the
 * phase and what the bot driver schedules against. What was wrong is that the
 * felt spent the platform's ONE turn marker on all of them: a gold ▶ chip that
 * everywhere else in the app means "it is this player's go, and nobody else's".
 * Pinochle's meld phase lit three opponents with it simultaneously (#125 item
 * 48) and Hearts' pass had always done the same.
 *
 * So the mark for "still to commit" is its own: same chip, no gold, no arrow,
 * no pulse — a quiet ⋯ that says these seats are still choosing. The turn token
 * keeps meaning exactly one thing.
 *
 * ASKED OF THE MODE, NOT THE PHASE NAME, the same way statusTextFor asks: the
 * phase is called `pass` in Hearts, `meld` in Pinochle and `discard` in
 * cribbage, and a platform file naming any of them is a platform file knowing
 * one template's vocabulary.
 */
function committingToken() {
  const token = document.createElement('span');
  token.className = 'turn-token turn-token--waiting';
  token.setAttribute('aria-hidden', 'true');
  return token;
}

/* ------------------------------------------------------------------ *
 * Finite pulses — replay, and the idle re-nudge
 * ------------------------------------------------------------------ */

/*
 * WHY THIS EXISTS AT ALL. Every emphasis animation on the table is bounded by
 * `--arcade-pulse-count` now (GAME_INTEGRATION §6d, issue #24) so that a game
 * that is visible and waiting for input lets the display pipeline reach 0 fps.
 * The cost of that is a new obligation on the render path: a finite animation
 * only plays when it is CREATED, so whether a cue fires is now a question
 * about DOM churn rather than about CSS.
 *
 * Three cases, and all three are already covered:
 *
 *   - Rebuilt per render. renderSeats builds the opponent row from scratch, so
 *     the acting seat's name glow, its turn token and its Catch! ring replay
 *     whenever anything moves — and renderSelection deliberately does NOT call
 *     it, so merely tapping a card in hand does not re-cue the turn. Same for
 *     the announce buttons, which renderAnnounceBar replaceChildren()s.
 *     Arcade.onResume -> rerenderTable is a full render, so returning to a
 *     suspended game re-states whose turn it is. That is a state change from
 *     the player's side even though the state did not move, and re-cueing it
 *     is the point rather than a spurious replay.
 *   - Toggled in place. paintPileState / paintMeldState / paintSeatTargets flip
 *     `--ready` and `--target` classes on nodes they keep, so those rings fire
 *     on the genuine transition into "ready" and stay quiet across renders that
 *     do not change the answer.
 *   - Neither. The rail's turn token is static markup in index.html
 *     (`#hand-rail > .turn-token`). Left alone its three pulses would run out
 *     while the game was still booting and never fire again, so renderRail
 *     replays it on the transition into the human's turn.
 */

/**
 * Restart a finished CSS pulse by re-creating the animation.
 *
 * Removing the class that declares the animation cancels it; the forced reflow
 * makes the browser adopt that state; re-adding it starts a NEW one. All three
 * happen in one task, so nothing is painted in between and the node never
 * appears unstyled. Same idiom as pulseSeat above.
 *
 * The class is re-applied rather than a separate "replay" class being toggled
 * because only a change to `animation-name` reliably restarts an animation that
 * has already finished — a rule that merely changes iteration-count does not.
 */
function replayPulse(node, className) {
  if (!node || !node.classList.contains(className)) return;
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

/**
 * Is the player asking us to spend less battery?
 *
 * GUARDED, and it has to be: this repo loads the evergreen `/arcade-sdk.js`,
 * so it can be talking to an SDK older than 3.13.0 where `powerSaver` simply
 * does not exist — and `Arcade.settings.powerSaver()` on one of those throws.
 * This is read from a render, and renders run from onSettingsChange, so an
 * unguarded call would be a throw on every settings write the launcher makes,
 * not merely a bad boot. An older SDK degrades to "not saving", which is the
 * same answer standalone gives (§5).
 */
function powerSaving() {
  const sdk = typeof window !== 'undefined' ? window.Arcade : null;
  const s = sdk && sdk.settings;
  return !!(s && s.powerSaver && s.powerSaver());
}

/** How long the human may sit on their own turn before the table clears its throat. */
const IDLE_NUDGE_MS = 10000;

/**
 * ONE more pulse if the human's turn has gone quiet, and never more than one.
 *
 * A finite pulse solves the battery problem and introduces a human one: a
 * player who looks away for a minute comes back to a table with no motion on
 * it at all, and the resting treatments — an accent ring, a gold token — are
 * meant to be read, not noticed. So after ~10s of the human's own turn the
 * affordances replay their pulse once, and then the table goes quiet again.
 *
 * The rules this must not break:
 *   - Never during a bot turn. Nothing is being asked of the player then, and
 *     a nudge would be motion for its own sake.
 *   - Never looping. The timer is one-shot and is not rescheduled when it
 *     fires; only the next render arms it again.
 *   - Never under power saver. The re-nudge is emphasis nobody asked for,
 *     which makes it exactly the "ambient effect" §5 says to gate off. It is
 *     re-evaluated on every settings change for free, because main.js
 *     re-renders on onSettingsChange.
 *   - Frozen while hidden. schedule() is the session clock when the SDK is
 *     there (src/ui/clock.js onto src/match/clock.js), so a suspended frame
 *     does not wake up owing itself a nudge, and stopSession cancels whatever
 *     is in flight.
 */
function scheduleIdleNudge(humanActs) {
  if (!session) return;
  if (session.nudgeTimer) {
    session.nudgeTimer.cancel();
    session.nudgeTimer = null;
  }
  if (!humanActs || powerSaving()) return;
  session.nudgeTimer = schedule(() => {
    if (session) session.nudgeTimer = null;
    replayIdleNudge();
  }, IDLE_NUDGE_MS);
}

/**
 * The affordances a waiting player is being asked to act on: a pile that will
 * take the selected card, a meld it extends, a collapsed seat hiding one of
 * those, and the announce button whose window is measured in seconds. The turn
 * token is not in the list — it says whose turn it is, which the player who has
 * been sitting on that turn for ten seconds already knows.
 */
function replayIdleNudge() {
  if (!session || !liveState()) return;
  for (const stack of el.screen.querySelectorAll('.pile-stack--ready')) replayPulse(stack, 'pile-stack--ready');
  for (const chip of el.screen.querySelectorAll('.meld-chip--ready')) replayPulse(chip, 'meld-chip--ready');
  for (const seat of el.screen.querySelectorAll('.seat--target')) replayPulse(seat, 'seat--target');
  for (const button of el.screen.querySelectorAll('.announce-button')) replayPulse(button, 'announce-button');
}

/** Zone instances of a definition: 'build' with count 4 -> build.1..build.4. */
function instancesOf(def, seat) {
  const numbers = def.count ? Array.from({ length: def.count }, (_, i) => i + 1) : [null];
  return numbers.map((n) => {
    let addr = n != null ? `${def.id}.${n}` : def.id;
    if (seat != null) addr = `${addr}.${seat}`;
    return { def, n, address: addr };
  });
}

function sharedZoneInstances(state) {
  const out = [];
  // WHETHER A ZONE IS ON THE TABLE RIGHT NOW, which the three flags below
  // cannot answer because all three are properties of the DEFINITION and a
  // definition does not change with the phase. `hideWhenEmpty` is the near
  // miss and it is the wrong question for a pile that is empty for ordinary
  // reasons: Thirteen's `pile` is empty at the start of every trick and is
  // the drop target for the lead, so hiding it while empty would take the
  // target away and reflow the felt once a trick.
  //
  // Asked ONCE per render rather than per zone — `makeCtx` walks the state —
  // and only for a template that has an opinion; `false` is the only answer
  // that does anything, so a hook can take a zone away for a phase and never
  // conjure one the definition already excluded.
  const opinion = state.pack.template.zoneOnFelt;
  const ctx = opinion ? makeCtx(state) : null;
  for (const def of state.zones.defs.values()) {
    if (def.per === 'player') continue;
    // Hidden shared zones (Stockpile's `recycled`) stay off the table; a
    // hidden zone that is ALSO a control says so with `interactive` in its
    // definition, which is how the draw pile keeps its place without this line
    // knowing that a draw pile is called "draw".
    //
    // `onFelt` is the other reason a hidden pile belongs on the table: it is
    // FURNITURE — nobody may look through it, but everybody can see that it is
    // there and how deep it is. Cribbage's crib is the case (#124, item 37):
    // four cards go into it in front of both players, it decides the hand, and
    // it was not drawn at all. What the felt showed instead was the `show`
    // zone, empty, wearing the label "The crib" for the whole hand while the
    // real crib was invisible.
    if (def.visibility === 'none' && !def.interactive && !def.onFelt) continue;
    // ...and `hideWhenEmpty` is the same question from the other side: a zone
    // that exists only for a moment is not a place on the table until it has
    // something in it. The crib's reveal pile is empty from the deal until the
    // dealer turns it over, and an empty dashed box captioned "The crib"
    // sitting beside the real crib is the felt saying the crib is empty.
    for (const inst of instancesOf(def, null)) {
      if (def.hideWhenEmpty && state.zones.count(inst.address) === 0) continue;
      if (opinion && opinion(ctx, inst.address) === false) continue;
      out.push(inst);
    }
  }
  // The deck reads best on the left, whatever order the template declared.
  return out.sort((a, b) => (b.def.id === 'draw') - (a.def.id === 'draw'));
}

function perPlayerZoneInstances(state, seat) {
  const out = [];
  for (const def of state.zones.defs.values()) {
    if (def.per !== 'player' || def.id === 'hand') continue;
    out.push(...instancesOf(def, seat));
  }
  return out;
}

/**
 * A per-player zone that is drawn in the MIDDLE for every seat at once (#138).
 *
 * The third answer to "where is a pile drawn", beside `interactive` and
 * `onFelt`, and like both of them it says nothing about what may be SEEN in
 * the pile — `visibility` remains the only thing that decides that. What it
 * says is that the zone is read ACROSS the seats: cribbage's play is one
 * sequence that both players add to and that both of them score runs and pairs
 * off, and drawing it as a full spread above your own hand plus a 24px pile on
 * the opponent's plate made the one thing the phase is about the one thing you
 * could not read (#133 items 3–4).
 */
function isTableZone(def) {
  return def.per === 'player' && def.table === true;
}

/** The per-player zones a SEAT still draws for itself — its plate, your row. */
function ownZoneInstances(state, seat) {
  return perPlayerZoneInstances(state, seat).filter((inst) => !isTableZone(inst.def));
}

/**
 * Every seat's instance of every `table` zone, in the order they are drawn.
 *
 * RING ORDER WITH THE HUMAN LAST, which is the board's rule (#136) and the
 * seat row's: the row sits above the hand, so "nearest the hand" is the end of
 * it, and your own cards are the ones you look down at.
 */
function tableZoneInstances(state) {
  const seat = mySeat();
  const order = [...opponentRing(state.seats, seat), seat]
    .filter((s) => Number.isInteger(s) && s >= 0 && s < state.seats);
  const out = [];
  for (const s of order) {
    for (const inst of perPlayerZoneInstances(state, s)) {
      if (isTableZone(inst.def)) out.push({ ...inst, seat: s });
    }
  }
  return out;
}

function zoneStackNode(address) {
  return el.screen.querySelector(`[data-zone="${CSS.escape(address)}"]`);
}

function meldChipNode(meldKey) {
  return el.screen.querySelector(`[data-meld="${CSS.escape(meldKey)}"]`);
}


/**
 * What a pile has cost so far, for a pile whose contents are worth points.
 *
 * `def.showsHeldValue` rather than `def.id === 'won'`: a hidden pile holding
 * scoring cards is a fact about the zone, so it is declared beside the zone
 * (trick-taking's defaultZones). Hearts is the game that made it worth showing;
 * it is not the rule.
 */
function heldValueText(state, def, address) {
  if (!def.showsHeldValue || !state.zones.has(address) || !state.pack.scoring?.cardValues) return null;
  const cards = state.zones.cards(address).map((id) => cardById(state, id)).filter(Boolean);
  const pts = handValue(cards, state.pack.scoring);
  return pts > 0 ? `${pts} pts` : null;
}

function renderCenterZones(state, ui, draggable) {
  el.centerPiles.replaceChildren();
  for (const inst of sharedZoneInstances(state)) {
    el.centerPiles.appendChild(zones.buildPileNode(state, inst, ui, {
      draggableTop: draggable.piles.get(inst.address) || null,
    }));
  }
}

/**
 * THE SEQUENCE THE WHOLE TABLE IS PLAYING, drawn once (#138).
 *
 * Every seat's instance of every `table` zone, side by side in the middle of
 * the felt, full size, each under the mark and the name of the seat it belongs
 * to. The zone stays per player — cribbage's count, its "go" and its show all
 * read a seat's own pile, and none of that is touched — but the two piles are
 * one sequence to READ, so they are drawn as one thing. Before this, yours was
 * a full spread above your hand and theirs was a 24px mini pile on their plate
 * 270px away showing only its top card, with the count between them.
 *
 * THE ROW IS NOT A PLACE ON THE TABLE UNTIL SOMETHING IS IN IT, which is
 * `hideWhenEmpty`'s rule asked of the row rather than of one pile. Cribbage's
 * play piles are empty through the deal and the whole discard, and a row of
 * empty slots there costs a phase that already struggles for height on a
 * desktop (#137) a line it has nothing to put in. Once ANY seat has played, all
 * of them are drawn — including the one that has not yet — so the row's shape
 * does not move underneath the player for the rest of the hand.
 *
 * @returns whether any spread was drawn
 */
function renderTableZones(state, ui, draggable) {
  const insts = tableZoneInstances(state);
  el.tableZones.replaceChildren();
  const live = insts.some((inst) => state.zones.count(inst.address) > 0);
  if (!live) return false;

  for (const inst of insts) {
    const { seat } = inst;
    const identity = identityOf(seat);
    const marks = seatSideMarks(state.pack, state.seats, mySeat(), seat);
    const wrap = document.createElement('div');
    wrap.className = `table-zone ${isMySeat(seat) ? 'table-zone--mine' : ''} `
      + `${marks.partner ? 'table-zone--partner' : ''}`;

    const head = document.createElement('div');
    head.className = 'table-zone__head';
    const mark = document.createElement('span');
    mark.className = 'table-zone__mark';
    // A number the STYLESHEET may dress, chosen by the engine and never by
    // pack data (§7b) — the same attribute the plate and the trick tag carry.
    if (marks.side !== null) mark.dataset.side = String(marks.side);
    // Own value from the roster, never a manifest one — inline style (§7b).
    mark.style.background = identity.color;
    mark.textContent = identity.icon || identity.initials || String(seat + 1);
    head.appendChild(mark);
    head.appendChild(line('table-zone__name', seatLabel(seat)));
    // Decorative: the pile's own accessible name is possessive below, so a
    // reader that spoke both would hear the owner twice per pile.
    head.setAttribute('aria-hidden', 'true');
    wrap.appendChild(head);

    const pile = zones.buildPileNode(state, inst, ui, {
      draggableTop: isMySeat(seat) ? (draggable.piles.get(inst.address) || null) : null,
    });
    // WHOSE PILE THIS IS, IN ITS NAME. `describeZone`'s title is the zone's
    // label — "Played" — and two spreads side by side both called "Played, 3
    // cards" are one pile as far as a screen reader is concerned. The caption
    // beside them is the visual answer; this is the spoken one, and it has to
    // be re-painted because paintPileState builds the name from this dataset.
    const stack = pile.querySelector('.pile-stack');
    if (stack) {
      const said = stack.dataset.zoneLabel || '';
      stack.dataset.zoneLabel = `${seatPossessive(seat)} ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
      zones.paintPileState(stack, ui);
    }
    wrap.appendChild(pile);
    el.tableZones.appendChild(wrap);
  }
  return true;
}

/**
 * The play row and the number that belongs to it, as one line of the middle.
 *
 * WHY THEY SHARE A SLOT. The count is the running total of the sequence beside
 * it — "why are three of my four cards greyed out" is answered by the cards and
 * the number together — and #124 had put it beside the STARTER, which is the
 * one card in the play it has nothing to do with. Once the spreads are in the
 * middle the count belongs with them, and a wrapper is what keeps the pair on
 * one line of a wrapping middle whatever the width: two flex items with their
 * own bases get separated the moment the line is tight, which at 375px is
 * every time.
 *
 * FULL WIDTH ONLY WHEN THERE ARE SPREADS. `table-play--zoned` is what gives the
 * wrapper a whole line; without it the wrapper is the content-sized slot beside
 * the piles that `#table-counters` has always been, so a pack with a table
 * counter and no `table` zone keeps the felt it had. And with neither, the
 * wrapper is `hidden` — no slot, no gap, no child in handSlack's measurement.
 */
function renderTablePlay(state, ui, draggable) {
  const zoned = renderTableZones(state, ui, draggable);
  el.tablePlay.classList.toggle('table-play--zoned', zoned);
  el.tablePlay.hidden = !zoned && el.tableCounters.hidden;
  // The middle wraps for a table that HAS a full-width line to wrap, and for
  // no other — the same rule and the same reason as the board's (#136): a
  // permanently wrapping middle would let Milestones' contract ladder fall
  // under the piles on a narrow window.
  el.feltMiddle.classList.toggle('felt-middle--tabled', zoned);
}

/**
 * Your side of the table's own numbers, as a row of labelled chips.
 *
 * Labelled, unlike a plate's badges, because there is room: the plates carry
 * bare numbers whose meaning is learned from position, and this row is read
 * once a hand rather than glanced at every turn.
 *
 * WHY THE STRIP EXISTS. Every seat but one wears its numbers on a plate, and the
 * one that does not is yours: the human's seat is the hand, the rail and the
 * piles, and there is no plate anywhere on the felt with your name on it. So a
 * bid — the thing you promised, which the whole hand is then played against — was
 * shown for all three opponents and nowhere at all for you (#123, item 28: "not
 * on the status bar, not on any seat plate, not in the round summary". In a
 * partnership the contract is your bid plus your partner's, and half of it was
 * unreadable).
 *
 * WHICH COUNTERS, THOUGH, IS THE TEMPLATE'S (#219). This was a list of counter
 * KINDS — `['bid', 'bags']`, two of trick-taking's own slugs, in a platform file
 * — read as a closed platform vocabulary like `COUNTER_TRACK_KINDS`. It is not
 * one: a kind says how a counter is DRAWN, and whether a number is worth
 * repeating for the seat with no plate is a fact about the genre. `mine: true` on
 * the counter is that fact, and it is opt-in, so a template that says nothing
 * gets no strip — which is what every pack but Spades and Pinochle had anyway.
 *
 * What is NOT marked is as deliberate, and it is still enforced here: a hand
 * count (the fan is right there), and anything `minimizedOnly` (redundant when a
 * seat is open, and yours always is — the won pile beside this strip is the trick
 * count in as many words).
 */
function buildMySeatStrip(state) {
  const counters = seatCountersFor(state, mySeat(), { minimized: false })
    .filter((counter) => counter.mine);
  if (!counters.length) return null;

  const strip = document.createElement('div');
  strip.className = 'my-seat';
  strip.id = 'my-seat-strip';
  for (const counter of counters) {
    const chip = document.createElement('span');
    chip.className = 'my-seat__chip';
    chip.dataset.counter = counter.kind;
    // ONE ACCESSIBLE NAME for the pair, the counter's own sentence ("bid 3
    // tricks", "2 bags"), with the halves hidden: a screen reader reading
    // "Bid, 3, bid 3 tricks" is worse than either.
    chip.setAttribute('role', 'img');
    chip.setAttribute('aria-label', counter.aria || `${counter.label}: ${counter.text}`);
    chip.appendChild(line('my-seat__name', counter.label || ''));
    chip.appendChild(line('my-seat__value', counter.text));
    strip.appendChild(chip);
  }
  return strip;
}

function renderPlayerZones(state, ui, draggable) {
  el.playerPiles.replaceChildren();
  // FIRST IN THE ROW, so it reads as this seat's — the piles that follow are
  // yours too. `#player-piles` collapses when it is empty and this is a child
  // of it rather than a row of its own, so a pack with nothing to say here
  // costs no vertical space on a phone.
  const mine = buildMySeatStrip(state);
  if (mine) el.playerPiles.appendChild(mine);
  // ...and not a `table` zone, which is drawn in the middle with everybody
  // else's copy of it (renderTableZones).
  for (const inst of ownZoneInstances(state, mySeat())) {
    if (inst.def.id === 'melds') {
      el.playerPiles.appendChild(zones.buildMeldStrip(state, mySeat(), ui));
    } else if (inst.def.visibility === 'none') {
      // The human's own hidden pile (a Hearts won pile): a face-down pile with
      // its count — and its cost, when the pack scores what it holds.
      const pts = heldValueText(state, inst.def, inst.address);
      const pile = zones.buildPileNode(state, inst, ui);
      if (pts) pile.querySelector('.pile-count').textContent = pts;
      el.playerPiles.appendChild(pile);
    } else {
      el.playerPiles.appendChild(zones.buildPileNode(state, inst, ui, {
        draggableTop: draggable.piles.get(inst.address) || null,
      }));
    }
  }
}

/**
 * The out-of-turn bar: what the human may declare or call out right now.
 *
 * Rendered from `enumerateAnnouncements` exactly as the action bar is rendered
 * from `enumerateLegalMoves` — the UI never invents an announcement, and a
 * pack that declares none simply gets an empty bar. "Uno" is only the first
 * customer of this surface (§E2).
 */
function humanAnnouncements(state) {
  return announcementsFor(state, mySeat());
}

/**
 * Can this pack ever fill the announce bar?
 *
 * A PROPERTY OF THE PACK, not of the moment — the same question
 * `announcementsFor` asks, asked once so the bar's slot can be reserved for
 * the whole match rather than appearing with the button in it (see the bar's
 * note in src/ui/css/moments.css).
 *
 * The TEMPLATE's hook, deliberately, rather than the rules block a particular
 * template reads: Crazy Eights is a shedding pack with no last-card rule, so
 * it pays a strip of felt for a bar it can never fill. That is the safe way to
 * be wrong. Asking the pack instead would reserve nothing for the next kind of
 * announcement somebody adds, and the table would silently start jumping again
 * — which is the bug this whole surface is here to have fixed (#13).
 */
function packAnnounces(state) {
  return !!state.pack.template.enumerateAnnouncements;
}

function renderAnnounceBar(state) {
  const options = humanAnnouncements(state).filter((a) => a.type === 'announce');
  // `hidden` is now the PACK's answer and nothing else; whether there is
  // anything to say right now is a class, so the bar keeps its slot in the
  // felt's column either way — the same bug and the same fix as the row that
  // used to stand above the hand, which is now the rail beside it (#13).
  el.announceBar.hidden = !packAnnounces(state);
  el.announceBar.classList.toggle('announce-bar--empty', options.length === 0);
  // The buttons are left standing while the bar fades out, so `inert` is what
  // stops a keyboard or a screen reader reaching a call whose window has
  // already closed — `visibility: hidden` only lands when the fade ends.
  el.announceBar.inert = options.length === 0;
  if (options.length === 0) return;
  el.announceBar.replaceChildren();
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'announce-button';
    // The keyphrase is PACK DATA — a pirate-themed pack says "Avast!" and
    // this code never learns the word.
    button.textContent = option.label || 'Last card!';
    button.addEventListener('click', () => liveState() && performAnnouncement(liveState(), option));
    el.announceBar.appendChild(button);
  }
}

/** Is this card part of the hint on the bar right now? */
function hintedCard(cardId) {
  return !!session?.hint?.cardIds?.has(cardId);
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
  session.hint = hint;
  session.hintsTaken += 1;
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

/** What the Hint line says about itself when it cannot be taken. */
const HINT_OFFER = Object.freeze({
  turn: 'Only while it is your turn',
  view: 'A joined table holds a view, not the cards',
  over: 'The game is over',
  showing: 'The hint is on the felt',
  forced: 'There is only one play',
  ready: 'What a player at this level would do',
});

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

/**
 * The rail beside the hand: the turn token, the fan's sort toggle, the action
 * button (index.html says why it is a rail and not a bar).
 *
 * TWO INVARIANTS, AND NEITHER IS THIS FUNCTION'S TO BREAK.
 *
 * The rail's WIDTH is what the felt pays for it: the row centres the fan and
 * the rail as a group and layoutHand subtracts the rail from the room the fan
 * may use, so a rail that changed width would re-fan the hand under the
 * player's finger — #13 in the inline axis. That is held in CSS by a fixed
 * width, and held here by nothing in the stack ever being laid out to its own
 * label.
 *
 * The rail's HEIGHT costs the felt nothing — its own box is zero-height, so
 * #hand-row is the fan's height whatever goes in the stack — but the stack
 * still has to be STILL, because these are controls under a thumb that is
 * already reaching for them. That is why every rung is toggled by class and
 * keeps its slot, rather than by `hidden`.
 *
 * THE SORT TOGGLE AND THE ACTION BUTTON NO LONGER SHARE A SLOT (#154). They
 * did, and the cost was that a bid, a Hearts pass, a cribbage crib discard or
 * a staged Thirteen combination took the sort control off the felt for the
 * whole phase — which is exactly the phase a player spends arranging their
 * hand to decide. The lamp that used to stand between them went to the help
 * mark in the felt's corner (#155), so the third rung was already paid for:
 * the stack is the same three rungs tall and the rail the same 5rem wide as
 * before, measured, and both controls are reachable at once.
 */
function renderRail(state, ui, humanActs) {
  // A SUGGESTION IS A HIGHLIGHT NOW, NOT A SENTENCE. What the hint touches is
  // ringed on the felt and its wording goes to #log for anyone who cannot see
  // a ring (showHint); the rail itself only has to stop offering a hint whose
  // answer is already showing. It lasts exactly as long as the position does —
  // every applied move clears it (applyStateChange).
  const suggestion = humanActs && session?.hint ? session.hint : null;
  // THE ONE TOKEN NOBODY REBUILDS. The rail's turn token is static markup in
  // index.html, so its finite pulse would have run itself out during boot and
  // never fired again (see "Finite pulses" above). Replayed on the transition
  // INTO the human's turn — the single moment it has something new to say —
  // and not on the renders that follow within the same turn.
  if (session && humanActs && !session.humanActing) {
    replayPulse(el.handRail.querySelector('.turn-token'), 'turn-token');
  }
  if (session) session.humanActing = humanActs;
  el.handRail.classList.toggle('hand-rail--acting', humanActs);

  // The offer that used to be a lamp in this stack is a line in the help sheet
  // now (#155), and it is repainted from here because this is the function
  // both render paths run — renderSelection repaints the rail without
  // rebuilding the fan, and "is there a hint to be had" changes on a tap.
  renderHelpOffer(state, humanActs, suggestion);

  // THE TWO CONTROLS, AND NEITHER OF THEM IN THE OTHER'S WAY (#154). Both
  // conditions are answered here rather than half of them in renderHand:
  // renderSelection repaints the rail without rebuilding the fan, so a state
  // written from there would outlive the render that set it.
  //
  // A CLASS, NOT `hidden`, for the same reason the token uses one: a control
  // with nothing to say keeps its slot and only loses `visibility`, so the
  // stack is one height from the first deal to the last card and nothing in it
  // ever shifts under the thumb. `visibility: hidden` takes it out of the tab
  // order and off the screen reader too, which `hidden` was doing before.
  const acting = !!(ui.action && humanActs);
  // A REFUSED COMMIT IS STILL THE COMMIT'S SLOT. The button stays, disabled,
  // carrying the engine's own sentence for why — because the alternative,
  // measured on the felt, was the Pass pill disappearing under the thumb and
  // the sort toggle appearing in its place the moment a card was tapped
  // (#122, round-5 item 19). `disabled` and not `hidden`: same box, same
  // height, and the reason reaches a screen reader through the name.
  const refused = acting && !!ui.action.disabled;
  el.handRail.classList.toggle('hand-rail--committing', acting);
  el.actionButton.disabled = refused;
  el.actionButton.classList.toggle('action-button--refused', refused);
  // A hand of one card has nothing to arrange, so the toggle goes quiet — and
  // keeps its rung, because the button below it may not move while it does.
  el.handRail.classList.toggle('hand-rail--sortable',
    state.zones.cards(handAddress(mySeat())).length >= 2);
  if (acting) {
    el.actionButton.textContent = ui.action.label;
    if (refused) {
      const why = ui.action.refusal || 'That is not a play.';
      el.actionButton.setAttribute('aria-label', `${ui.action.label} — ${why}`);
      el.actionButton.title = why;
      el.actionButton.onclick = null;
    } else {
      el.actionButton.removeAttribute('aria-label');
      el.actionButton.removeAttribute('title');
      el.actionButton.onclick = () => {
        if (!liveState()) return;
        const move = ui.action.makeMove();
        // The button is the third tap that was launching cards from the wrong
        // place: "Lay down" and "Pass 3 left" both carry cards that are sitting
        // in the tray, and the flight was starting from the button.
        performHumanMove(liveState(), move, tapOrigin(move));
      };
    }
  } else {
    // EMPTIED, not left holding the last phase's word. The button keeps its
    // rung when there is nothing to commit and only loses `visibility` — which
    // hides it from the eye, the tab order and the screen reader, but would
    // leave "Your crib" sitting in the DOM for anything that reads the felt
    // rather than looks at it. Its box is held by a min-height in the sheet,
    // not by the text, so emptying it moves nothing.
    el.actionButton.textContent = '';
    el.actionButton.removeAttribute('aria-label');
    el.actionButton.removeAttribute('title');
    el.actionButton.onclick = null;
  }
}

function renderStatusBar(state, acting) {
  el.statusText.textContent = statusTextFor(state, acting);
  // Repainted on every render rather than only when it is tapped, because the
  // new-game sheet can change this between two hands and the chip has to agree
  // with the felt it is sitting above.
  paintSpeedChip();
  // `session.roundBeat` for the same reason `render` reads it: while the felt
  // holds a finished hand, nobody is on turn and the bar must not say so. A
  // trick reveal is the same claim for one beat (#123).
  const humanActs = acting.some(isMySeat) && !session?.roundBeat && !session?.trickBeat && !session?.review;
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
    const board = session?.board
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
function currentDelayMs() {
  return loadSettings().botDelayMs;
}

/** The rung to put a name on: the chip's word, and the sheet's lit button. */
function currentSpeed() {
  return speedForDelay(currentDelayMs());
}

/**
 * ONE DURATION FOR THE WHOLE TABLE, at the rung in force the moment a card
 * launches. Asked rather than cached for the reason above, and asked at every
 * call site rather than once per match because the status bar's chip can move
 * the rung mid-hand.
 */
function currentFlightMs() {
  return flightDurationMs(currentDelayMs());
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
  session.board = model;
  el.tableBoard.hidden = !model;
  // The middle only wraps for a table that HAS a board. A permanently wrapping
  // middle would let Milestones' contract ladder fall under the piles on a
  // narrow window, which is a layout for a problem nobody has.
  el.feltMiddle.classList.toggle('felt-middle--boarded', !!model);
  if (!model) {
    el.tableBoard.replaceChildren();
    session.boardHandle = null;
    return;
  }
  if (session.boardHandle && updateSharedBoard(session.boardHandle, model)) return;
  session.boardHandle = renderSharedBoard(model);
  el.tableBoard.replaceChildren(session.boardHandle.node);
}

function statusTextFor(state, acting) {
  // REVIEWING IS NOBODY'S TURN. The reel under the felt says where in the
  // match this is; the bar says only that the table is not waiting on anyone.
  if (session?.review) return 'Reviewing';
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
  if (session?.roundBeat) {
    return session.beatResume ? 'Round over. Tap to go on.' : 'Round over.';
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
  if (session?.trickBeat) {
    const whose = `${seatPossessive(session.trickBeat.seat)} trick.`;
    return session.trickBeat.waits ? `${whose} Tap to go on.` : whose;
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

/**
 * A SELECTION changed, and nothing else did.
 *
 * Picking a card up in your own hand moves no cards, scores nothing and ends
 * no turn. What it changes is which things are lit: the card itself, the piles
 * and melds that would accept it, and the action button. Everything else on
 * the felt — every opponent's fan, every pile, the contract ladder — is
 * identical before and after, and rebuilding it was the single most expensive
 * thing a tap did (issue #6 §3): every card's SVG re-parsed, every listener
 * re-attached, every animation restarted, and the fan re-measured.
 *
 * So this repaints the three things that moved and leaves the DOM alone. It is
 * the same UI model a full render would have built — the model is pure and
 * cheap; it was only ever the DOM that was expensive.
 *
 * NOT for anything that changes what the hand CONTAINS. Cards leaving or
 * entering the fan change its child count, and the fan has to be rebuilt and
 * re-measured for that; those paths still call render().
 */
function renderSelection(state) {
  if (drag && drag.isDragging()) {
    session.pendingRender = { state };
    return;
  }
  session.selection = pruneSelection(state, session.selection);
  const acting = actingSeatsOf(state);
  const humanActs = acting.some(isMySeat);
  const humanMoves = humanActs ? movesFor(state, mySeat()) : [];
  const ui = buildUiModel(state, { seat: mySeat(), moves: humanMoves, acts: humanActs, selection: session.selection });
  session.ui = ui;

  const handAddr = handAddress(mySeat());
  const committedPass = committedSelectionOf(state, mySeat()) || [];
  // The fan's cards, not the fan's ROWS: `.hand` holds a `.hand__row` per row
  // of the fan now (#134), so its children are containers with no card id.
  for (const wrapper of el.hand.querySelectorAll('.card-face-wrap')) {
    const cardId = wrapper.dataset.cardId;
    const selected = isSelected(session.selection, handAddr, cardId) || committedPass.includes(cardId);
    wrapper.classList.toggle('card-face-wrap--selected', selected);
    wrapper.classList.toggle('card-face-wrap--hinted', hintedCard(cardId));
    wrapper.setAttribute('aria-pressed', String(selected));
  }
  for (const node of el.stageTray.querySelectorAll('.stage-card[data-card-id]')) {
    node.classList.toggle('card-face-wrap--hinted', hintedCard(node.dataset.cardId));
  }
  for (const stack of el.screen.querySelectorAll('.pile-stack[data-zone]')) zones.paintPileState(stack, ui);
  for (const chip of el.screen.querySelectorAll('.meld-chip[data-meld]')) zones.paintMeldState(chip, ui);
  seatRow.paintSeatTargets(state, ui);
  renderRail(state, ui, humanActs);
  // A selection change is the player acting, so the idle clock starts over.
  scheduleIdleNudge(humanActs);
}

function render(state, message) {
  // A render mid-drag would replace the very node the pointer is holding.
  // Deferred, then replayed by the controller's settle callback.
  if (drag && drag.isDragging()) {
    session.pendingRender = { state, message };
    return;
  }
  // Collected as the sub-renderers run; swapped in at the end so the NEXT
  // render knows what was already on the felt (see markEntry above).
  session.enteringKeys = new Set();
  session.selection = pruneSelection(state, session.selection);
  const acting = actingSeatsOf(state);
  // NOBODY ACTS DURING THE ROUND BEAT. The felt is holding the position the
  // round ended in while the engine has already dealt the next one (see
  // runRoundBeat), so a card offered here would belong to a position that no
  // longer exists and tapping it would fail validation against the live state.
  // The beat is a second or two and it ends in the summary, which is nobody's
  // turn either. A trick reveal (#123) is the same claim for one beat: the
  // posed position still has the fourth player on turn because the trick has
  // not been resolved on that copy, and their hand must not answer a tap.
  const humanActs = acting.some(isMySeat) && !session.roundBeat && !session.trickBeat && !session.review;
  // A remote seat's move, a resumed match, a view swapped in: none of them
  // pass through applyStateChange, so the hint is dropped here as well the
  // moment the human is no longer the one acting.
  if (!humanActs) session.hint = null;
  const humanMoves = humanActs ? movesFor(state, mySeat()) : [];
  const ui = buildUiModel(state, { seat: mySeat(), moves: humanMoves, acts: humanActs, selection: session.selection });
  const draggable = draggableSources(state, { seat: mySeat(), acts: humanActs });
  const stagger = session.dealAnimation && motionAllowed();

  session.ui = ui;

  // THE BOARD GOES FIRST, and the order is load-bearing: both the status bar's
  // score chip and every seat plate ask `session.board` whether the felt is
  // already drawing this road, and draw their own small track only if it is
  // not (#136).
  renderSharedBoardRow(state);
  renderStatusBar(state, acting);
  seatRow.renderSeats(state, stagger, acting, ui);
  if (ladder) ladder.render(state);
  // The contract in force — trump, the bid and whose it is, your own meld.
  // Above the middle of the felt, so it is drawn before the piles under it.
  if (contractStrip) contractStrip.render(state);
  renderCenterZones(state, ui, draggable);
  renderPlayerZones(state, ui, draggable);
  // AFTER the status bar, which is where renderTableCounters runs: the count
  // shares this row and whether it is on screen decides whether the row exists
  // at all for a pack that has one and no `table` zone.
  renderTablePlay(state, ui, draggable);
  // The two bars go BEFORE the hand, and the order is load-bearing: renderHand
  // ends by measuring how much room the fan has. Measured with the previous
  // render's bars still showing, the fan was laid out against a row of the
  // wrong height — and if that flipped a scrollbar, against the wrong width
  // too. The ResizeObserver then corrected it a frame later, which the player
  // saw as the hand re-fanning itself.
  // Neither bar changes height with the turn any more (#13), so the ordinary
  // turn no longer costs a re-measure at all — but the announce bar still
  // leaves the column entirely for a pack that cannot announce, and a hint
  // long enough to wrap is still a taller bar. The order stays.
  renderAnnounceBar(state);
  renderRail(state, ui, humanActs);
  handFan.renderHand(state, ui, stagger, draggable);
  session.dealAnimation = false;
  session.shownCardKeys = session.enteringKeys;
  session.enteringKeys = null;

  // A game-ending move can arrive with no message (the human's own winning play) or a
  // stale one from the mover ("Bot 2 played" right before Bot 2's own hand emptied) —
  // gameOver always wins the log line over whatever was passed in.
  if (state.gameOver) {
    el.log.textContent = winnerSentence(state);
  } else if (message) {
    el.log.textContent = message;
  }

  // Every pulse this render started is finite, so the table will be still in a
  // few seconds. Arm the one re-nudge that is allowed to break that stillness.
  // (A finished match acts on nobody: actingSeatsOf returns [] once gameOver.)
  scheduleIdleNudge(humanActs);
}

/** Re-render after a drag settles, replaying whatever was deferred. */
function onDragSettled() {
  const deferred = session.pendingRender;
  session.pendingRender = null;
  if (!liveState()) return;
  render(deferred ? deferred.state : liveState(), deferred ? deferred.message : undefined);
}

/* ------------------------------------------------------------------ *
 * Dragging
 * ------------------------------------------------------------------ */

/**
 * A card has been lifted: what does it look like, and where may it land?
 *
 * The targets come from src/ui/interaction.js, which derives them from the
 * SAME enumerated legal moves the tap path uses — so this function cannot
 * offer a drop the engine would refuse, and an empty target list (a card with
 * nothing to do) is a perfectly ordinary answer that ends in a snap-back.
 */
/**
 * Which seat's plate would hold this drop candidate, or null for a shared one.
 *
 * Asked only of candidates whose node is not on screen, so the answer is
 * always "the collapsed seat that is hiding it" or nothing.
 */
function seatOfCandidate(state, candidate) {
  if (candidate.kind === 'meld') {
    const seat = Number(String(candidate.meldKey).split(':')[0]);
    return Number.isInteger(seat) ? seat : null;
  }
  for (let seat = 0; seat < state.seats; seat++) {
    if (isMySeat(seat)) continue;
    for (const inst of perPlayerZoneInstances(state, seat)) {
      if (inst.address === candidate.address) return seat;
    }
  }
  return null;
}

/**
 * Open a collapsed seat's plate mid-drag and offer what is inside it.
 *
 * NOT a render: renders are deferred while a drag is live (they would replace
 * the node the pointer is holding), so this builds the one thing that has to
 * change and hands the new nodes straight to the drag controller.
 *
 * `session.openSeat` is set as well as drawn, so the plate is still open after
 * the drag settles and the ordinary render runs. That is what makes a release
 * over the face useful rather than a dead end when the seat has more than one
 * meld the card could go on: the plate stays up and the player finishes by tap.
 */
function revealSeatForDrag(state, seat, candidates) {
  if (!session || session.openSeat === seat) return;
  session.openSeat = seat;
  seatRow.buildPlateFor(state, seat, identityOf(seat), false, session.ui);
  seatRow.placeOpenPlate();

  // zoneStackNode and meldChipNode both look inside el.screen, and the plate
  // layer lives there — so the same lookups that found nothing a moment ago
  // now find the real chips, and no second way of addressing them is needed.
  const revealed = [];
  for (const candidate of candidates) {
    const node = candidate.kind === 'zone'
      ? zoneStackNode(candidate.address)
      : meldChipNode(candidate.meldKey);
    if (node) revealed.push({ node, onDrop: () => performHumanMove(state, candidate.move, node) });
  }
  if (drag) drag.revealTargets(revealed);
}

function onDragLift(handle) {
  const state = liveState();
  if (!state) return null;
  const card = cardById(state, handle.cardId);
  if (!card) return null;
  hideInspector();
  // The drag owns the gesture from here; the peek raise would fight the ghost
  // for the same card, and the hand's own pointerup may never arrive.
  if (gestures) gestures.clearPeek();

  const acting = actingSeatsOf(state);
  const humanActs = acting.some(isMySeat);
  const targets = [];

  if (humanActs) {
    const moves = movesFor(state, mySeat());
    // Candidates whose target is real but not on screen, because the seat
    // holding it is collapsed. Grouped by seat: the face is one drop target
    // that opens onto however many the seat actually has.
    const behindAFace = new Map();
    for (const candidate of dropCandidates(state, {
      seat: mySeat(),
      moves,
      source: { from: handle.from, cardId: handle.cardId },
    })) {
      const node = candidate.kind === 'zone'
        ? zoneStackNode(candidate.address)
        : meldChipNode(candidate.meldKey);
      if (node) {
        targets.push({ node, onDrop: () => performHumanMove(state, candidate.move, node) });
        continue;
      }
      const seat = seatOfCandidate(state, candidate);
      if (seat === null) continue;
      if (!behindAFace.has(seat)) behindAFace.set(seat, []);
      behindAFace.get(seat).push(candidate);
    }

    // DRAGGING ONTO A SEAT THAT IS PUT AWAY.
    //
    // The face is the target while the plate is shut, and hovering it opens
    // the plate — so a card can be carried to a collapsed opponent and dropped
    // on the exact meld it extends, without the row ever having had to show
    // every meld at once. Releasing on the face itself plays the move when
    // there is only one it could mean, and otherwise leaves the plate open so
    // the choice can be made by tap.
    for (const [seat, candidates] of behindAFace) {
      const node = el.opponentsTop.querySelector(`.seat--collapsed[data-seat="${seat}"]`);
      if (!node) continue;
      targets.push({
        node,
        onHoverIn: () => revealSeatForDrag(state, seat, candidates),
        onDrop: () => {
          if (candidates.length === 1) performHumanMove(state, candidates[0].move, node);
        },
      });
    }
  }

  // Dropping a hand card back into the hand is REARRANGING, and it is always
  // available — including on an opponent's turn, which is exactly when a
  // player tidies their cards.
  if (handle.kind === 'hand') {
    targets.push({
      node: el.hand,
      onDrop: (event) => handFan.reorderHandAt(handle.cardId, event.clientX, event.clientY),
    });
  }

  return { markup: art().face(card), targets };
}

/* ------------------------------------------------------------------ *
 * Geometry for card travel — the parts that need the table's own elements.
 * `rectOf` and `cardSizedRect` moved to src/ui/flight.js, which already owns
 * the flying and where dragController's verbatim copy of rectOf now points too.
 * ------------------------------------------------------------------ */

/** A node's rect, corrected for a seat row that is still gliding under it. */
function liveRect(node) {
  return scrollCorrectedRect(rectOf(node), seatRow.pendingSeatShift(node));
}

/** Where a seat's cards live on screen — the source or target of a card in flight. */
function seatRect(seat) {
  if (isMySeat(seat)) return rectOf(el.hand);
  const plate = el.opponentsTop.querySelector(`[data-seat="${seat}"]`);
  if (!plate) return null;
  const mini = plate.querySelector('.mini-hand');
  // The fan's last child is the one genuinely rendered card; the rest are the
  // cheap edge boxes renderSeats draws instead of real SVG. Preferring it gives
  // a card-shaped rect where the row is a squat strip, which is what a card
  // leaving this seat should be seen to launch from.
  //
  // FALLING BACK TO THE PLATE IS THE POINT, not a tidy-up. A seat whose fan is
  // put away — collapsed to its face, or merely `display: none` at a compact
  // table — has no rect at all (rectOf answers null for a zero-width node), and
  // this returned null with it: every card that seat drew or played crossed the
  // felt from nowhere, silently, on exactly the crowded tables where watching
  // WHO acted matters most. The face is where the player is looking anyway.
  //
  // Which NODE won matters as much as its rect now: every one of these lives
  // inside the scrolling row, and liveRect has to be told what it measured to
  // know whether the row's unfinished scroll applies to it.
  const node = firstSized([mini?.lastElementChild, mini, plate.querySelector('.seat__avatar'), plate]);
  return liveRect(node);
}

/** The first of `nodes` that has a rect — the fallback ladder, as a node. */
function firstSized(nodes) {
  for (const node of nodes) if (rectOf(node)) return node;
  return null;
}

function zoneRect(address) {
  const node = zoneStackNode(address);
  if (!node) return null;
  // Corrected like a seat's, and for the same reason: an opponent's meld strip
  // carries `data-zone="melds.N"` and is drawn INSIDE the seat row, so a hit
  // aimed at one mid-scroll landed on the neighbour's melds.
  return liveRect(node.querySelector?.('.pile-stack__top') || node) || liveRect(node);
}

/**
 * Send a copy of the moved card across the table, then reveal where it landed.
 *
 * Called after the reducer and the re-render, with `from` captured before
 * them — by which point the source card is already gone, which is exactly why
 * a copy flies instead of the card itself.
 */
function animateMove(state, move, from) {
  if (!from) return;
  // ONE DURATION FOR THE WHOLE TABLE, and it is the player's own speed setting
  // rather than a distinction between their cards and a bot's — see
  // flightDurationMs.
  const duration = currentFlightMs();
  if (move.type === 'draw' || move.type === 'takeHand') {
    // A draw has no single landing slot in a fanned hand, so it dissolves on
    // arrival rather than pretending to become a particular card. The human's
    // own draw is face-up because they are about to see it anyway.
    //
    // A WHOLE PILE TAKEN AS A HAND (#157) rides the same flight, and always
    // face down: seventeen cards left that pile at once, nobody had seen any of
    // them, and one back travelling from the pile to the seat says "that pile
    // is now theirs" without picking one of the seventeen to stand for the
    // rest.
    const to = cardSizedRect(seatRect(move.actor), from.width);
    const card = move.type === 'draw' && isMySeat(move.actor)
      ? cardById(state, state.zones.cards(handAddress(mySeat())).at(-1) || '')
      : null;
    flyCard(card ? art().face(card) : art().back(), from, to, { fade: true, duration });
    return;
  }
  if (move.type === 'hit') {
    const card = cardById(state, move.cards?.[0]);
    if (!card) return;
    // IT USED TO DISSOLVE. `fade: true` was right while the destination was a
    // whole meld strip with no slot to land on; the chip's card nodes are a
    // stable target, so the copy now lands ON the card it is a copy of and the
    // real one is held invisible underneath until it does — the same deal a
    // played card gets, and the difference between "a card arrived here" and
    // "a card evaporated near here".
    const seat = move.choice?.seat;
    const landing = meldCardNode(state, seat, move.cards[0]);
    const to = liveRect(landing) || cardSizedRect(zoneRect(`melds.${seat}`), from.width);
    if (!to) return;
    landOn(landing, flyCard(art().face(card), from, to, { duration }));
    return;
  }
  if (move.type === 'layDown') { animateLayDown(state, move, from, duration); return; }
  if (move.type !== 'playCard' && move.type !== 'discard') return;
  const card = cardById(state, move.cards && move.cards[0]);
  if (!card) return;
  const address = implicitLandingZone(state, move);
  if (!address) return;
  const node = zoneStackNode(address);
  const topNode = node ? node.querySelector('.pile-stack__top') : null;
  landOn(topNode, flyCard(art().face(card), from, liveRect(topNode) || zoneRect(address), { duration }));
}

/**
 * How many cards of a lay-down are worth watching arrive.
 *
 * PENALTY_FLIGHT_MAX's reasoning (src/ui/celebrations.js) applied to the other
 * end: a contract is three to six cards in every pack shipped, but the contract
 * ladder is pack data and one that asks for four sets of four would buy sixteen
 * timers and sixteen SVG copies for a moment that has stopped reading as a
 * single event long before that. Cards past the cap are simply already there.
 */
const LAYDOWN_FLIGHT_MAX = 8;

/** The beat between one laid-down card and the next. */
const LAYDOWN_STAGGER_MS = 80;

/**
 * A contract, laid down and SEEN to be laid down.
 *
 * THE BIGGEST EVENT IN A MILESTONES ROUND HAD NO ANIMATION AT ALL. animateMove
 * handled draw, hit, playCard and discard and returned for everything else, so
 * a bot completing its contract put three to six cards on the felt between two
 * frames — the one moment in the game where you most need to know who did what
 * and it happened without a single pixel moving. tests/flight.test.js now
 * derives the move vocabulary from the templates themselves and fails on any
 * type that is neither animated nor deliberately silent, because a hardcoded
 * list of four is exactly what let this sit unnoticed.
 *
 * Staggered card by card, in meld order, because the count is half the news:
 * three cards arriving together are one event, three arriving in turn are three.
 * Same judgement as animatePenaltyDraw's, for the same reason.
 */
function animateLayDown(state, move, from, duration) {
  // BEFORE ANYTHING IS HIDDEN. Every card below is held invisible until its
  // copy lands, and with motion off no copy is ever launched — so an early
  // return here is the difference between "no animation" and "the meld you just
  // laid down is blank". flyCard's own gate is too late to help.
  if (!motionAllowed()) return;
  const seat = move.actor;
  const cardIds = (move.choice?.melds || []).flatMap((meld) => meld.cards || []);
  const fallback = cardSizedRect(zoneRect(`melds.${seat}`), from.width);
  const myEpoch = epoch;

  cardIds.slice(0, LAYDOWN_FLIGHT_MAX).forEach((cardId, i) => {
    const card = cardById(state, cardId);
    const landing = meldCardNode(state, seat, cardId);
    const to = liveRect(landing) || fallback;
    if (!card || !to) return;
    landOn(landing, new Promise((resolve) => {
      // A PLAIN setTimeout, NOT `schedule` — which is the session clock, and
      // what the rest of this file staggers with. The session clock stops with a
      // suspended frame, and a stagger that never fires here is not a missing
      // flight — it is a meld card left at opacity 0 for the rest of the round.
      // Same rule as animationSettled's backstop: the honest timer is the one
      // that still runs in the background.
      setTimeout(() => {
        if (myEpoch !== epoch) { resolve(); return; }
        flyCard(art().face(card), from, to, { duration }).then(resolve);
      }, i * LAYDOWN_STAGGER_MS);
    }));
  });
}

/**
 * Where a card that has just joined a meld now sits, as a node.
 *
 * The chip draws its cards in READING order rather than the order the engine
 * stored them (the template's `meldCardOrder` — a run held `6 3 W 5` reads
 * `3 W 5 6`), so the slot a card landed in cannot be inferred from its position
 * in the move. The group is found by searching for the card rather than by
 * trusting the move's meld index, so this answers for a hit onto somebody else's
 * meld and for a lay-down's own fresh groups without knowing which it was asked
 * about.
 */
function meldCardNode(state, seat, cardId) {
  if (!zones || seat === undefined || seat === null) return null;
  const groups = zones.meldGroupsOf(state, seat) || [];
  const index = groups.findIndex((group) => group.cards?.includes(cardId));
  if (index < 0) return null;
  const chip = meldChipNode(`${seat}:${index}`);
  const cards = chip?.querySelector('.meld-chip__cards');
  if (!cards) return null;
  // Filtered exactly as buildMeldStrip filters, or a card the renderer skipped
  // would shift every slot after it by one.
  const ordered = zones.meldCardOrder(state, groups[index])
    .filter((id) => cardById(state, id));
  return cards.children[ordered.indexOf(cardId)] || null;
}

/* ------------------------------------------------------------------ *
 * Table moments — src/ui/celebrations.js owns the banners, the trick
 * gather, the action-card narration and the penalty flight. These are the
 * thin wrappers that hand it the open session.
 * ------------------------------------------------------------------ */

let moments = null;
let ladder = null;
let contractStrip = null;
let gestures = null;
let zones = null;
let record = null;
// The opponent row (src/ui/seatRow.js), handed this screen's elements by
// initTable rather than resolving any of its own.
let seatRow = null;
// The round ending (src/ui/roundEnding.js), the same way: the pre-move fork, the
// trick's held beat, the show's counts, the three timer APIs and the doors out
// of the sheet.
let roundEnding = null;
// The human's own hand (src/ui/handFan.js): the fan, the gathered-card tray,
// the width observer, the reorder a drop implies and the sort toggle.
let handFan = null;
// The doors onto the felt (src/ui/matchDoors.js): every open, resume and deal,
// and the way out. The exported door functions ("Match lifecycle", below)
// hand straight to it.
let doors = null;
// The review lens (src/ui/reviewController.js): the felt at a past position,
// the reel, the map, and the doors in from the scoreboard, the results and the
// round sheet.
let reviewer = null;

// THE BANNER AND THE SHOW CARD ARE ONE SLOT. The card replaces the banner for
// a scoring step (#152) and they must never be on the felt together — so every
// door that puts one up or takes one down goes through here and clears the
// other. That is also the card's whole teardown story: it is torn down exactly
// where the banner would have been, which is every path that already called
// `hideBanner` (leaving the table, a new deal, a closed session).
function hideBanner() {
  hideShowCard();
  if (moments) moments.hideBanner(session);
}
function showBanner(text, tone) {
  hideShowCard();
  if (moments) moments.showBanner(session, text, tone);
}

/** Put one scoring step's card on the felt, over the middle. */
function showShowCard(model) {
  if (!el.showCard) return;
  const node = renderShowCard(model, { art });
  if (!node) return;
  if (moments) moments.hideBanner(session);
  el.showCard.replaceChildren(node);
  el.showCard.hidden = false;
}

function hideShowCard() {
  if (!el.showCard) return;
  el.showCard.hidden = true;
  el.showCard.replaceChildren();
}
function celebrateTrick(state, ev) { return moments ? moments.celebrateTrick(session, state, ev) : null; }
// THE TWO HALVES OF THAT, for the beat that now has room between them (#180):
// what the table SAYS when the hold opens, and what it DOES when the hold ends.
function announceTrick(state, ev, opts) { return moments ? moments.announceTrick(session, state, ev, opts) : null; }
function gatherTrick(state, ev) { if (moments) moments.gatherTrick(state, ev); }
function releaseBanner() { if (moments) moments.releaseBanner(session); }
function celebrateAction(state, events, opts) { return moments ? moments.celebrateAction(session, state, events, opts) : null; }
function animatePenaltyDraw(state, seat, count, delay) { if (moments) moments.animatePenaltyDraw(state, seat, count, delay); }

/**
 * WHAT THE DEAL ITSELF SAID — the event window a hand is BORN with, celebrated
 * at the moment that hand becomes visible. `dealEvents` is the seam and carries
 * the argument for it (src/ui/celebrations.js).
 *
 * TWO CALLERS, BOTH OF THEM "the new hand is on the screen now": `adoptMatch`
 * for the first hand of a match, and `dismissRoundSummary` for every hand after
 * it — the engine deals the next hand inside the round-ending move, but the
 * felt holds the ending position until the summary is dismissed, so the deal's
 * own sentence has to wait there too.
 */
function celebrateDeal(state) {
  const dealt = dealEvents(state?.events || []);
  if (dealt.length) celebrateAction(state, dealt);
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Write the match. §17.3 says a match-critical write must CHECK its result, and
 * this one did not: a quota-full or otherwise refused save returned false and
 * the table carried on as if the game were safe, so the loss only surfaced when
 * the player came back to a lobby tile that had forgotten their game.
 *
 * Said once per session, not once per move: a storage backend that has started
 * refusing writes will refuse the next forty too, and forty identical banners
 * is not information.
 */
let saveFailureReported = false;

function persistMatch() {
  const state = liveState();
  if (!state) return;
  // A JOINER STORES NOTHING. It holds a view rather than a match, the log is
  // the host's, and a rejoin re-asks for a snapshot rather than resuming from
  // whatever it happened to be holding (src/match/client.js).
  if (state.isView) return;
  // NEITHER DOES A HOST, HERE. Its match is persisted by src/ui/party.js under
  // `mpMatch.<tableId>`, which is the copy the party comes back to. Writing the
  // solo slot as well made a second, diverging copy of the same game — and gave
  // the lobby tile a "Start over" that dealt a private hand beside a table
  // other people were still sitting at.
  if (session?.shared) return;
  // A DAILY RUN GOES IN ITS OWN SLOT. Writing it to `match.<packId>` would
  // silently overwrite whatever casual game was waiting on the lobby tile —
  // the same mistake one shared slot per device made about two hosted tables.
  const ok = saveMatch(state, {
    hints: session.hintsTaken,
    slot: session.daily ? 'daily' : 'match',
  });
  if (ok !== false || saveFailureReported) return;
  saveFailureReported = true;
  reportTableError('This game could not be saved — it may not be here when you come back.');
}

/**
 * Synchronous by construction — onSuspend calls this directly (§6b).
 *
 * This used to be `if (matchDirty) persistMatch()`, and `matchDirty` was never
 * once set true: every assignment in the file wrote `false`. So the flush wired
 * to Arcade.onSuspend was a provable no-op, and the comment claiming the
 * opening deal reached storage through it was wrong. It reached storage because
 * every mutation path calls persistMatch() synchronously — which is also why
 * deleting the flag costs nothing. persistMatch is idempotent and a match log
 * is a few KB, so the honest flush is simply to write.
 */
export function flushTable() {
  persistMatch();
}

/* ------------------------------------------------------------------ *
 * Stats and the record
 * ------------------------------------------------------------------ */

/**
 * Who won, in the sentence the felt says it in.
 *
 * One phrasing, three former callers: the status bar said "Game over — You
 * win!", the log line said the same thing built a different way, and this said
 * a third. `seatLabel` already falls back to a plate name, so the extra
 * `session.seating[winner] ? … : …` here was a fourth spelling of the same
 * lookup.
 */
function winnerSentence(state) {
  return isMySeat(state.winner) ? 'You win!' : `${seatLabel(state.winner)} wins.`;
}

/**
 * The move that ended it, named.
 *
 * The winner and the last card are NOT always the same person's business — a
 * pack that plays to a points threshold can be won by somebody who did not make
 * the final play — so this is a second line rather than a clause in the first.
 * Empty when the ending was not a card (a match that ends on a pass, or a round
 * that tipped the totals), because a caption with nothing to caption is noise.
 */
function finalPlaySentence(state, move) {
  if (!move || (move.type !== 'playCard' && move.type !== 'discard')) return '';
  const card = cardById(state, move.cards && move.cards[0]);
  if (!card) return '';
  const who = isMySeat(move.actor) ? 'you' : seatLabel(move.actor);
  return `Last card: ${cardName(card)}, played by ${who}.`;
}

/**
 * Leave the ending on the felt until the player has had their look at it.
 *
 * Delayed by a beat so the final card has landed on the discard before anything
 * asks to be read — the bar arriving mid-flight would be the same interruption
 * the panel used to be, only smaller. The winner's seat pulses underneath, so
 * the answer to "who?" is on the table and not only in the sentence.
 *
 * THE BEAT IS MEASURED AGAINST THE FLIGHT, not against the 700 it used to be.
 * That number was a comfortable margin over a fixed 260ms flight and became a
 * dead heat the moment the flight could scale to 700 with the bot-speed
 * setting — the one case where "the final card has landed" stopped being true.
 * Floored at the old value so nobody waits longer than they already did unless
 * they have asked for a slower table.
 */
function offerFinalLook(state, move, ending, { ended = null, now = false } = {}) {
  const myEpoch = epoch;
  pulseSeat(state.winner, 'good');
  const ask = async () => {
    if (myEpoch !== epoch) return;
    const acknowledged = await awaitFinalLook(
      winnerSentence(state),
      finalPlaySentence(state, move),
      lastHandSentence(state.pack, state.seats, ended, seatLabel),
    );
    // Closed under it, or a new game started while it was up — either way these
    // results belong to a match that is no longer the one on screen.
    if (!acknowledged || myEpoch !== epoch) return;
    // THE LAST COUNT COMES DOWN WITH THE RESULTS GOING UP (#189), not with the
    // bar: the bar exists so the cards can be read, and the show card is the
    // reading. A no-op at every ending that had no show.
    hideShowCard();
    showGameOver(state, ending);
  };
  // NOW is the path a final show has already held (runFinalShow, #189): the
  // deciding count was on the felt until the player dismissed it, so the flight
  // this beat waits out landed three taps ago.
  if (now) { ask(); return; }
  const beat = Math.max(700, currentFlightMs() + 280);
  schedule(ask, beat);
}

function openScoreboard() {
  if (!liveState()) return;
  showScoreboard(liveState(), session.seating, record.safeStats(liveState()));
}

/* ------------------------------------------------------------------ *
 * Applying moves
 * ------------------------------------------------------------------ */

// The one place a move reaches the engine, so the sound of a move cannot drift
// from the fact of it. `far` is the opponent-vs-you signal the pack carries in
// space rather than timbre (js/soundpack.js).
//
// A reshuffle is no longer inferred from pile counts: the engine's reactions
// announce themselves on state.events (src/engine/state.js), and 'recycled'
// during a move IS the shuffle, whoever's move surfaced it.
function applyStateChange(state, move, { far }) {
  // BEFORE the engine sees it: if this move turns out to have ended the round,
  // the position it ended in is gone the instant `applyMove` returns.
  roundEnding.notePreMove(state);
  applyMove(state, move);
  // A hint is advice about the position that was; this move made it a
  // different one. Cleared before the render so nothing stale is painted.
  if (session) session.hint = null;
  // Keeping a drawn card moves nothing, so it makes no sound. A card-on-felt
  // slap for a turn where no card was played is the table lying about what
  // happened — and the drawn card's own sound already played a beat ago.
  if (move.type === 'draw') playDraw();
  else if (move.type !== 'pass') playCardPlayed({ far });
  soundReactions(state);
}

/**
 * The sounds a move's REACTIONS make, whatever kind of move surfaced them.
 *
 * A reshuffle is not inferred from pile counts: the engine's reactions announce
 * themselves on state.events (src/engine/state.js), and 'recycled' during a move
 * IS the shuffle. Split out of applyStateChange because an ANNOUNCEMENT can
 * surface one too — a challenge penalty-draw that empties the pile recycles it —
 * and the announcement path skipped this entirely, so that shuffle was silent.
 */
function soundReactions(state) {
  if (state.events.some((e) => e.type === 'recycled')) playShuffle();
}

// Every applied move funnels through here, whoever made it. Keeping the
// render/persist/schedule trio in one place is what stops a new move type from
// silently skipping the save — and it is where the move's event window
// (state.events) becomes table moments: a trick gathered, a round scored.
function afterMove(state, move, from, message, { publish = true } = {}) {
  const events = state.events;

  // FIRST, and before anything that can throw or animate. A remote seat
  // waiting on this move should not be waiting on this device's render.
  // `publish: false` is the remote path, where the move was already published
  // by the host module that applied it — publishing again would burn a `seq`
  // and make every client ask for a snapshot it does not need.
  if (publish) onLocalMove?.(state, move, events.slice());
  const trick = events.find((e) => e.type === 'trickWon');
  const passed = events.find((e) => e.type === 'cardsPassed');

  // FOUR CARDS ON THE TABLE, claimed FIRST: `takeRoundFinal` consumes the
  // pre-move snapshot, and the last trick of a hand wants both poses off it.
  const trickPose = trick ? roundEnding.takeTrickPose(move) : null;
  // WHERE THE ROUND ENDED, and the whole schedule for it — the one builder
  // `performAnnouncement` shares (#202). It consumes the pre-move snapshot
  // whether or not it is wanted, so a fork is never left behind to be re-used
  // by the next move.
  const { ended, finalState, plan, shown } = roundEnding.beginRoundEnding(state, move);
  const reveal = trick ? trickRevealPlan(events, {
    flightMs: currentFlightMs(),
    posed: !!trickPose,
    // Read HERE, on the move that completed the trick, for the same reason the
    // round beat reads it when the round ends: a rung changed on the last sheet
    // is the rung this beat runs at.
    pace: currentPace().id,
    // OTHER PEOPLE ARE AT THIS TABLE, so the hold gets a ceiling whatever the
    // rung says (SHARED_TRICK_HOLD_MS). `posed` already covers the remote path;
    // this covers a LOCAL move made at a shared table, which poses like any
    // other and is the only way an indefinite gate could ever be reached here.
    shared: !!session?.shared,
  }) : null;

  // WHAT THE TABLE SAYS ABOUT THE TRICK, AND WHEN (#180).
  //
  // `announce` is non-null exactly when there is a hold with reading time in it
  // to say it on, and `runTrickReveal` then runs it as the hold OPENS. Note that
  // a `reveal` at all implies `trickPose` — `trickRevealPlan` is handed
  // `posed: !!trickPose` and returns null without one — so `announce` being set
  // is also the guarantee that the reveal path below is the one taken.
  //
  // THE PATHS WITH NO SUCH HOLD ARE UNTOUCHED, and that is what `closeTrick`
  // below is for: the multiplayer path where the felt could not pose the trick,
  // and the Instant rung, whose hold is the fourth card's flight and has no
  // reading time in it. Both still announce and gather in one breath.
  const announce = (trick && reveal?.reads)
    ? () => announceTrick(shown, trick, { held: reveal.holdMs == null })
    : null;
  // What a resume still owes the trick.
  const closeTrick = (st) => {
    if (!trick) return;
    if (announce) gatherTrick(st, trick);
    else celebrateTrick(st, trick);
  };

  if (state.gameOver) {
    // Recorded before the render, so the panel that is eventually built can
    // show the updated record — this game's counters are ours to display (§4:
    // `stats` is the surface whose formatting the game owns). The PANEL itself
    // waits: the last card is the thing worth watching, and it is still in the
    // air on this frame.
    const ending = record.concludeMatch(state, { hints: session.hintsTaken });
    // Kept so the results can be put back after a review of the finished
    // game (leaveReview, src/ui/reviewController.js).
    session.ending = ending;
    // THE LAST TRICK IS STILL A TRICK, and it is the one most worth seeing
    // whole: the card that ends a match is the card that won it. The match is
    // over either way, so nothing here races the hold — `offerFinalLook` waits
    // for the player anyway.
    //
    // AND IT SPLITS LIKE EVERY OTHER TRICK (#180). This resume is a different
    // one, but the HOLD is the same hold: the same four cards, held the same
    // length by the same rung, with the same player looking at them. The trick
    // that ends a match is if anything the one most worth naming while it is
    // still on the felt, and a last trick that announced itself differently
    // from the twelve before it would read as the table losing its place. What
    // is special about this path is what comes AFTER the gather — the win cue
    // and the final look — and both of those still wait for the hold.
    //
    // AND THE HAND THAT ENDS THE MATCH ENDS LIKE EVERY OTHER HAND (#189). A
    // cribbage match ends INSIDE a show — the deciding count is in this move's
    // event window — and until this plan existed that count was never played:
    // the felt went from the last pegging card to the final-look bar in a
    // frame. `finalShowPlan` is null for every pack that ends on a card, so
    // the path below is exactly what it was for all of them.
    const show = finalShowPlan(events, {
      flightMs: currentFlightMs(),
      narrate: !!finalState,
      pace: currentPace().id,
      shared: !!session?.shared,
    });
    const look = (now) => {
      playWin();
      offerFinalLook(state, move, ending, { ended, now });
    };
    const finish = () => {
      if (show && finalState) {
        roundEnding.runFinalShow(state, show, finalState, posedForShow(finalState, show), {
          message, move, from, reveal, closeTrick, done: () => look(true),
        });
        return;
      }
      render(state, message);
      if (!reveal) animateMove(state, move, from);
      closeTrick(state);
      look(false);
    };
    if (reveal && trickPose) roundEnding.runTrickReveal(trickPose, move, from, reveal, finish, announce);
    else finish();
    return;
  }

  if (passed && !message) message = 'Cards passed. Play!';
  // BEFORE ANY ANIMATION, and no longer behind one: what is saved is the live
  // state, which the beats below deliberately are not showing yet.
  persistMatch();

  // Everything the completed trick CAUSES — the gather, the sentence, the next
  // turn, a round ending underneath it. Held for one beat behind the four cards
  // when the felt could pose them (#123), and run straight through otherwise.
  const settle = () => {
    roundEnding.holdRoundEnding(plan, finalState, shown);
    render(shown, message);
    // The played card has already flown onto the posed trick; flying it again
    // here would be the same card arriving twice.
    if (!reveal) animateMove(shown, move, from);
    closeTrick(shown);
    // After the card has been seen to land. A show's own steps are the
    // narration, so nothing competes with them — the first `showScored` banner
    // firing here would say pone's count over the last pegging card.
    //
    // A GATHERED TRICK NO LONGER SILENCES THIS OUTRIGHT; it raises the bar.
    // "Two celebrations at once is neither" is still the rule and
    // TRICK_BANNER_PRIORITY is still where almost everything falls under it,
    // but the card that breaks a suit is very often the fourth card of a trick,
    // and suppressing that banner suppressed the only time the felt ever
    // mentioned the rule (#151). See celebrations.js for the scale.
    const action = plan?.steps.length
      ? null
      : celebrateAction(shown, events, { floor: trick ? TRICK_BANNER_PRIORITY : -1 });
    // The action is the better sentence: "Rook played." says less than nothing
    // next to "You draw 4 and lose your turn", and the log is the live region a
    // screen reader hears.
    if (action) el.log.textContent = action.text;

    if (plan) {
      // The engine has already dealt the next round beneath this move. The felt
      // is holding the position it ended in; the summary opens over that, and the
      // deal does not become visible until the summary is dismissed
      // (dismissRoundSummary). Bot play already waits on `roundSummaryOpen`.
      cancelAnnouncementBeats();
      roundEnding.runRoundBeat(state, plan, finalState || state);
      return;
    }

    scheduleNextTurn();
    scheduleAnnouncementBeats();
  };

  if (reveal && trickPose) {
    // No bot is scheduled and nothing is announced until `settle` runs: the
    // beat is a pause in the game, not a pause the game plays through.
    cancelAnnouncementBeats();
    roundEnding.runTrickReveal(trickPose, move, from, reveal, settle, announce);
    return;
  }
  settle();
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

/**
 * How many questions one move may owe. A ceiling, not a budget: the loop below
 * is driven by the template answering null, and this only stops a hook that
 * never stops asking from hanging the table.
 */
const MAX_PENDING_CHOICES = 6;

/**
 * Fill in everything `move` still owes, asking the player where the answer is
 * genuinely theirs.
 *
 * ONE HOOK, ASKED IN A LOOP, INSTEAD OF THREE HARDCODED EFFECT SCHEMAS. This
 * used to be: a `choose: 'player'` branch, a colour/suit branch with the four
 * French suits written out (wrong for any nonstandard deck), a call to the
 * contract-rummy-specific `wildChoice`, and a
 * `effect.type === 'skipTarget' && effect.on === 'discard'` special case — four
 * pieces of effect-schema knowledge in the platform's move gate. The template
 * now names the question and says where the answer goes; this renders it.
 *
 * A QUESTION WITH ONE ANSWER IS NOT A QUESTION. At a two-hander there is exactly
 * one other player, and a dialog confirming the only living opponent is a tax on
 * every seven you play — so a single option is applied without asking, which is
 * the same judgement contract-rummy makes about a set (one possible value, never
 * asked).
 *
 * @returns the completed move, or null if the player backed out.
 */
/**
 * The Ask's context rows, with the seats dressed.
 *
 * A SEAT IS A NUMBER THE TEMPLATE CANNOT DRESS — the same rule its `kind:
 * 'seat'` options follow, one rung up: the name is the roster's
 * (src/players/roster.js) and who is partnered with whom is the pack's
 * (src/engine/sides.js), and a template that had to know either would be a
 * template that had to know what a player is called.
 *
 * `you` and `partner` are marks rather than words in the label because the
 * dialog draws them, and because "You" as a name is already this table's
 * convention everywhere else (seatLabel).
 */
function dressedContext(state, rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.map((row) => {
    if (!Number.isInteger(row.seat)) return { label: row.label ?? '', value: String(row.value ?? '') };
    const marks = seatSideMarks(state.pack, state.seats, mySeat(), row.seat);
    return {
      label: seatLabel(row.seat),
      value: String(row.value ?? ''),
      mine: isMySeat(row.seat),
      partner: marks.partner,
    };
  });
}

async function fillPendingChoices(state, move, myEpoch) {
  const template = state.pack.template;
  if (!template.pendingChoice) return move;
  for (let asked = 0; asked < MAX_PENDING_CHOICES; asked++) {
    const ask = template.pendingChoice(makeCtx(state), move);
    if (!ask || !ask.options?.length) return move;

    // A seat is a number the template cannot dress: its name and mark belong to
    // the roster (src/players/roster.js), which is the platform's business.
    const options = ask.options.map((o) => {
      if (ask.kind !== 'seat') return { value: o.value, label: o.label ?? String(o.value) };
      const identity = identityOf(o.value);
      return { value: o.value, label: o.label ?? identity.name, icon: identity.icon || null };
    });

    let picked;
    if (options.length === 1) {
      picked = options[0].value;
    } else {
      // TWO STRINGS, NOT ONE, and passing the same one for both is what left
      // Pinochle's trump step as four word buttons reading "Choose a suit to
      // play it in". `art` is the drawing vocabulary the chooser tiles are
      // keyed by; `prompt`/`question` is the words. See the Ask table in
      // src/templates/CONTRACT.md.
      const drawn = ask.art || ask.attr;
      const sentence = ask.question || `Choose a ${ask.prompt || ask.attr}`;
      // The bar behind an open dialog is still saying whatever the step BEFORE
      // this one said. Repainted for as long as the question is up, and put
      // back by the render that follows whichever way it is answered.
      if (ask.status) el.statusText.textContent = ask.status;
      picked = await promptChoice(art(), drawn, options, {
        card: ask.cardId ? cardById(state, ask.cardId) : null,
        sentence,
        // #123: the auction's rows, dressed from the roster.
        context: dressedContext(state, ask.context),
      });
      if (ask.status && liveState()) renderStatusBar(state, actingSeatsOf(state));
      // Backed out, or the table closed while the prompt was open — either way
      // this move belongs to a match that is no longer the one on screen.
      if (picked === null || myEpoch !== epoch) return null;
    }
    move = ask.apply(move, picked);
  }
  return move;
}

/**
 * The single gate between a human gesture and the engine, whatever dressed the
 * move up — a hand card, a pile, a meld chip, the action button, or a card
 * dropped onto a pile. Fills in any choice the move still owes (a wild asks
 * its colour; a discard that skips a player asks who), validates, and hands
 * off to the shared apply/render/persist path.
 *
 * The wild prompt used to live in the tap handler alone, which meant a dropped
 * wild would have bypassed it. Asking HERE is what lets both dressings stay
 * one code path.
 *
 * `sourceNode` is WHERE THE CARD IS COMING FROM, which for a drop is the node
 * the finger released over and for a tap is emphatically not the node that was
 * tapped — see tapOrigin.
 */
async function performHumanMove(state, move, sourceNode) {
  const myEpoch = epoch;

  const completed = await fillPendingChoices(state, move, myEpoch);
  if (completed === null || myEpoch !== epoch) return;
  move = completed;

  // A CLIENT ASKS; IT DOES NOT DECIDE. Running validateMove here would run the
  // template over a state missing everybody else's hands — the soundness trap
  // D3 exists to avoid — and it would be answering a question that is not ours:
  // the host owns legality, and its answer arrives as the next view or as a
  // reject. The move already came from the host-shipped list, so the affordance
  // has been honoured; nothing here is a rule being checked.
  if (state.isView) {
    sharedTable?.propose(move);
    return;
  }

  const check = validateMove(state, move);
  if (!check.legal) {
    playInvalid();
    render(state, `Can't do that: ${check.reason}`);
    return;
  }
  const from = liveRect(sourceNode) || (move.from ? zoneRect(move.from) : null) || seatRect(mySeat());
  // NOT `selection = null`. The render inside afterMove prunes it per card
  // (pruneSelection), which drops exactly what this move consumed and leaves
  // the rest staged. Clearing wholesale is what made a Milestones meld
  // impossible to build across turns: every turn ends in a discard, and the
  // discard took the tray with it.
  applyStateChange(state, move, { far: false });
  afterMove(state, move, from);
}

/**
 * Where a TAPPED move leaves from, as a node — or null to let performHumanMove
 * fall back through the move's own source zone.
 *
 * THE HUMAN'S OWN PLAYS DID NOT TRAVEL AT ALL, and this is why. A tap hands
 * performHumanMove the node that was tapped, which for a drag is where the
 * finger let go and is therefore honest, and for a tap is THE DESTINATION: the
 * discard pile, the meld chip. Measured live in a browser, discarding by
 * tapping the discard pile animated a card travelling `translate(0px, -1.75px)`
 * over 260ms — a real flight, from the pile to the pile. Every complaint that
 * the animation is "too fast to notice" was, for the player's own cards, a
 * complaint that there was no animation.
 *
 * The card is where the player last saw it: staged in the tray, or still in the
 * fan. Failing both — Stockpile taps a pile top onto another pile, and there is
 * no hand card involved at all — null is the RIGHT answer rather than a
 * shrugging fallback to the tapped node, because `move.from` names the source
 * zone and gives the true origin.
 *
 * Only the tap sites call this. The drop handlers keep passing their own node.
 */
function tapOrigin(move) {
  const cardId = (move?.cards && move.cards[0])
    // A lay-down or a pass carries its cards in `choice`/`cards` shapes this
    // module does not read; the selection is the same cards and is the platform's
    // own record of what the player gathered to make this move.
    || session?.selection?.cardIds?.[0]
    || null;
  if (!cardId) return null;
  const selector = `[data-card-id="${CSS.escape(cardId)}"]`;
  return el.stageTray.querySelector(selector) || el.hand.querySelector(selector) || null;
}

/** A tap on one of the human's own hand cards, interpreted per the UI model. */
function onHandCard(state, cardId, card, sourceNode, ui) {
  const handAddr = handAddress(mySeat());

  if (ui.mode === 'tap' || ui.mode === 'play-drawn') {
    // One tap plays it — the destination is implicit, and the wild's question
    // is asked by performHumanMove, the same place a drop asks it. In
    // 'play-drawn' only the drawn card is in ui.handSelectable, and this is
    // reached only through a selectable card.
    performHumanMove(state, { actor: mySeat(), type: 'playCard', cards: [cardId] }, sourceNode);
    return;
  }

  // Selection modes: toggle membership (multi) or replace (single). The rule
  // itself lives in interaction.js, where it can be pinned without a pointer —
  // including the part that says a single-select tap may never discard more
  // than the card it landed on.
  if (session.selection && session.selection.from !== handAddr) session.selection = null;
  const held = session.selection ? session.selection.cardIds.length : 0;
  session.selection = toggleHandSelection(session.selection, {
    from: handAddr, cardId, multi: ui.handMulti,
  });
  if (ui.handMulti) {
    // The card moves between the fan and the tray, so the fan's child count
    // changes and it has to be rebuilt and re-measured — the fast path below
    // deliberately does neither. The flight covers the rebuild.
    const from = rectOf(sourceNode);
    render(state);
    handFan.flyToStage(state, cardId, from);
    return;
  }
  // Nothing moved — repaint what is lit rather than rebuilding the table. The
  // exception is a tap that arrives while several cards are staged, which no
  // longer collapses the tray to nothing but does empty a slot in it, so the
  // two rows have to be rebuilt.
  if (held > 1) render(state);
  else renderSelection(state);
}

/* ------------------------------------------------------------------ *
 * Announcements (§E2)
 * ------------------------------------------------------------------ */

/**
 * Apply an announcement — the player's, or a bot's.
 *
 * Deliberately NOT routed through afterMove: an announcement never changes
 * whose turn it is, so re-entering the turn scheduler would cancel and restart
 * a bot's think time every time somebody spoke.
 */
function performAnnouncement(state, move, myEpoch = epoch) {
  if (myEpoch !== epoch || !liveState()) return;
  const check = validateMove(state, move);
  // The window closed while the timer ran — somebody else got there first, or
  // the target played. That is an ordinary outcome, not an error.
  if (!check.legal) return;

  // An announcement can be the thing that ends the round (see the roundOver
  // branch at the foot of this function), and if it is, the position it ended
  // in is gone the instant applyMove returns.
  roundEnding.notePreMove(state);
  applyMove(state, move);
  // An announcement IS a move — it has an actor, it goes through applyMove, it
  // lands in the log — so a party has to be told about it too. This path
  // deliberately does not re-enter afterMove (re-scheduling the turn would
  // restart a bot's think time every time anybody spoke), which is exactly why
  // it has to publish for itself.
  onLocalMove?.(state, move, state.events.slice());
  soundReactions(state);
  const caught = state.events.find((e) => e.type === 'caught');
  const announced = state.events.find((e) => e.type === 'announced');
  playAnnouncement({ caught: !!caught });

  let message = '';
  if (announced) {
    const who = isMySeat(announced.seat) ? 'You' : identityOf(announced.seat).name;
    message = `${who}: “${announced.label}”`;
    showBanner(message, isMySeat(announced.seat) ? 'good' : 'neutral');
  } else if (caught) {
    const catcher = isMySeat(caught.seat) ? 'You' : identityOf(caught.seat).name;
    const victim = isMySeat(caught.target) ? 'you' : identityOf(caught.target).name;
    message = `${catcher} caught ${victim} — ${caught.drew} card${caught.drew === 1 ? '' : 's'}.`;
    showBanner(message, isMySeat(caught.target) ? 'bad' : 'good');
  }

  // An announcement can end a round — a challenge penalty that empties the
  // draw pile, a declaration that is the last thing before somebody goes out —
  // and the summary is `afterMove`'s job, which this path deliberately does not
  // re-enter (re-scheduling the turn would restart a bot's think time every
  // time anybody spoke). So the ONE thing it has to notice for itself is that.
  //
  // THROUGH THE SAME BUILDER `afterMove` USES (#202). This was a second copy of
  // it, and the copy had lost `shared`: a round ended by an announcement at a
  // hosted table then counted its show with no clock on it and gated this
  // device's queue on taps nobody else could make.
  const { finalState, plan, shown } = roundEnding.beginRoundEnding(state, move);
  roundEnding.holdRoundEnding(plan, finalState, shown);

  render(shown, message);
  // After the render, so the hand the cards are flying INTO is the one on
  // screen. A catch costs cards exactly the way a Draw 2 does, and it is the
  // same flight for the same reason — the number in the banner is the whole
  // point of the rule, and a number is not a thing you watch happen.
  if (caught) animatePenaltyDraw(state, caught.target, caught.drew, 120);
  persistMatch();

  if (plan) {
    cancelAnnouncementBeats();
    roundEnding.runRoundBeat(state, plan, finalState || state);
    return;
  }
  scheduleAnnouncementBeats();
}

/* ------------------------------------------------------------------ *
 * The bot driver — src/ui/botDriver.js owns the timers and the persona rolls.
 * These are its four seams back into the felt.
 * ------------------------------------------------------------------ */

let bots = null;
let paused = false;

function cancelBotTurn() { if (bots) bots.cancelTurn(session); }
function cancelAnnouncementBeats() { if (bots) bots.cancelBeats(session); }
function scheduleNextTurn() {
  // Bots run HOST-SIDE, and only there: a joiner scheduling one would be a
  // second device trying to move the same seat.
  if (liveState()?.isView) return;
  // PAUSED IS A REAL STATE, and it is the host player's answer to a seat that
  // dropped for good: hold the hand exactly as it stands rather than let the
  // bots play on around an empty chair. Nothing is torn down, so resuming is
  // one call and the table picks up mid-turn.
  if (paused) return;
  // A REVIEW IS A PAUSE THE PLAYER OPENED: the felt is standing at a past
  // position and a bot moving the live one underneath would be a move nobody
  // saw. `leaveReview` (src/ui/reviewController.js) re-arms the turn.
  if (session?.review) return;
  if (bots) bots.scheduleNextTurn(session, epoch);
}

/** Hold or release the table's own clock. The host's "wait for them" answer. */
export function setTablePaused(on) {
  paused = !!on;
  if (!paused) scheduleNextTurn();
}
function scheduleAnnouncementBeats() { if (bots) bots.scheduleAnnouncementBeats(session, epoch); }

/* ------------------------------------------------------------------ *
 * Match lifecycle — the doors are src/ui/matchDoors.js (#223, seam 4)
 * ------------------------------------------------------------------ */

// EXPORTED FROM HERE, BUILT OVER THERE. main.js and party.js import the felt's
// surface from this file, so every door keeps its name on it and hands straight
// through to the seam `initTable` builds. The slots the doors write — the
// session, the epoch, the joiner's client — stay here, behind the setters
// initTable hands over; the doors' own `openToken` went with them.
export function openTable(packId, setup) { return doors.openTable(packId, setup); }
export function closeTable() { doors.closeTable(); }
export function rerenderTable() { doors.rerenderTable(); }
export function dealHostedTable(deal) { return doors.dealHostedTable(deal); }
export function resumeHostedTable(table) { return doors.resumeHostedTable(table); }
export function adoptSharedView(frame) { doors.adoptSharedView(frame); }

/** Stop being a joiner. The felt is torn down by the caller's ordinary exit. */
export function leaveSharedTable() {
  sharedTable = null;
}

/* ------------------------------------------------------------------ *
 * The host's seams — src/ui/party.js owns the protocol; these are the
 * four places it touches the felt.
 * ------------------------------------------------------------------ */

/**
 * Be told about every move this device applies. Pass null to stop.
 *
 * The listener is called with `(state, move, events)` AFTER the engine has
 * applied it and BEFORE the render, which is the order a remote seat wants:
 * the frame leaves while the animation is still starting here.
 */
export function setLocalMoveListener(fn) {
  onLocalMove = typeof fn === 'function' ? fn : null;
}

/**
 * What is on this felt right now — the host's half of the handshake.
 *
 * Returns live references on purpose. `createTableHost` takes `liveState` as a
 * function and reads the seat table every time it publishes, because a table
 * that handed over a snapshot would be publishing the game as it was when
 * hosting started.
 */
export function tableContext() {
  if (!session) return null;
  return { state: session.state, seats: session.seats, pack: session.pack, seating: session.seating };
}

/**
 * A move the HOST MODULE applied on our behalf — a joiner's accepted proposal.
 *
 * The state has already changed; what has not happened is everything the felt
 * does about it. `publish: false` because the host published it as it applied
 * it, and a second publish would burn a `seq` for a move nobody made.
 */
export function afterRemoteMove(move) {
  const state = liveState();
  if (!state || state.isView) return;
  // `far` is unconditional: by definition this move was made on another device.
  if (move.type === 'draw') playDraw();
  else if (move.type !== 'pass') playCardPlayed({ far: true });
  soundReactions(state);
  afterMove(state, move, seatRect(move.actor), '', { publish: false });
}

/**
 * Replace who the felt believes is at each seat.
 *
 * A SEATING IS BUILT ONCE AT DEAL TIME AND FROZEN, which is right for solo —
 * the opponents come from the seed and cannot change — and wrong the moment a
 * person can sit down mid-hand. Without this, a joiner who took a bot's seat
 * kept the bot's name, face and colour on every surface that names players:
 * the opponent row, the scoreboard, the round summary.
 */
export function setSeating(seating) {
  if (!session || !Array.isArray(seating)) return;
  session.seating = seating;
  if (liveState()) render(feltState());
}

export function isTableOpen() {
  return liveState() !== null;
}

export function initTable({ onExit }) {
  exitToLobby = onExit;

  // THE ROW IS CONSTRUCTED BEFORE ANYTHING LISTENS. `placeOpenPlate` is handed
  // to two listeners below as a reference rather than called, so the object it
  // hangs off has to exist by then; `zones`, `drag` and the session are reached
  // through the thunks above and may still be null at this moment.
  seatRow = createSeatRow({
    el,
    session: () => session,
    zones: () => zones,
    liveState,
    render,
    mySeat,
    isMySeat,
    identityOf,
    art,
    markEntry,
    turnToken,
    committingToken,
    humanAnnouncements,
    heldValueText,
    ownZoneInstances,
    perPlayerZoneInstances,
    performAnnouncement,
    isBusy: () => !!drag && drag.isDragging(),
  });

  // AND THE ROUND ENDING, BEFORE ANYTHING LISTENS FOR THE SAME REASON: the felt's
  // tap and the window's keydown both reach for `roundEnding.endHeldBeat` below,
  // and `initPanels` is handed the two doors out of the sheet.
  //
  // The panel doors go IN rather than being imported over there, because
  // src/ui/panels.js and src/ui/confirm.js resolve their own element ids at
  // import time — see the note at the head of src/ui/roundEnding.js.
  roundEnding = createRoundEnding({
    el,
    session: () => session,
    epoch: () => epoch,
    liveState,
    feltState,
    render,
    animateMove,
    renderStatusBar,
    seatLabel,
    seatPossessive,
    mySeat,
    voiceOf,
    cardById,
    zoneStackNode,
    pulseSeat,
    showBanner,
    showShowCard,
    hideShowCard,
    releaseBanner,
    celebrateDeal,
    currentFlightMs,
    powerSaving,
    scheduleNextTurn,
    cancelBotTurn,
    cancelAnnouncementBeats,
    exitToLobby: () => exitToLobby(),
    showRoundSummary,
    hideRoundSummary,
    paintRoundPace,
    confirmAction,
  });

  // AND THE HAND, BEFORE THE FIRST RENDER AND BEFORE THE SORT TOGGLE'S LISTENER
  // below. `drag` and `gestures` are built further down this function, which is
  // why they go in as thunks: the fan asks for them at the moment a card is
  // drawn, by which time both exist.
  handFan = createHandFan({
    el,
    session: () => session,
    drag: () => drag,
    gestures: () => gestures,
    mySeat,
    liveState,
    livePack,
    render,
    cardById,
    art,
    hintedCard,
    markEntry,
    committedSelectionOf,
    onHandCard,
  });

  // AND THE DOORS, BEFORE ANYTHING CAN OPEN A MATCH: main.js calls `initTable`
  // before it routes, and the panels' "Play again" below reaches for
  // `doors.startGame`. They are the only writers of the session and the epoch,
  // which is why they are handed setters rather than the slots themselves.
  doors = createMatchDoors({
    el,
    session: () => session,
    setSession: (next) => { session = next; },
    bumpEpoch: () => { epoch += 1; },
    sharedTable: () => sharedTable,
    setSharedTable: (client) => { sharedTable = client; },
    drag: () => drag,
    ladder: () => ladder,
    contractStrip: () => contractStrip,
    roundEnding,
    fetchPack,
    render,
    liveState,
    feltState,
    humanName,
    celebrateDeal,
    persistMatch,
    flushTable,
    scheduleNextTurn,
    scheduleAnnouncementBeats,
    cancelBotTurn,
    cancelAnnouncementBeats,
    hideBanner,
    setHelpOpen,
    reportTableError,
    hideAllPanels,
    closeChoiceDialog,
    closeConfirm,
  });

  // AND THE REVIEW, BEFORE ANYTHING LISTENS: the window's keydown hands its
  // event to `reviewer.onKey` below, and `initPanels` is handed the three doors
  // into review and the two maps. The panel doors go in for the same reason
  // they go into the round ending — src/ui/panels.js resolves its element ids
  // at import time.
  reviewer = createReviewController({
    el,
    session: () => session,
    roundEnding,
    liveState,
    feltState,
    render,
    seatLabel,
    mySeat,
    cardById,
    art,
    cancelBotTurn,
    cancelAnnouncementBeats,
    scheduleNextTurn,
    scheduleAnnouncementBeats,
    hideBanner,
    hideShowCard,
    showGameOver,
    hideGameOver,
    hideScoreboard,
    hideRoundSummary,
    paintRoundPace,
    showReviewMap,
    hideReviewMap,
    isReviewMapOpen,
    isReviewDrawerOpen,
    reviewMapNode,
  });

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
  // A tap anywhere else closes it, the way the seat plate below answers the
  // same gesture. Capturing, so the tap still reaches whatever it was aimed
  // at: this closes a sheet, it does not swallow a move.
  document.addEventListener('pointerdown', (event) => {
    if (!helpOpen()) return;
    if (el.helpSheet.contains(event.target) || el.helpButton.contains(event.target)) return;
    setHelpOpen(false);
  }, true);

  // AN OPEN SEAT PLATE IS DISMISSIBLE, by the two gestures every other overlay
  // on this screen already answers to. Wired once here rather than per render,
  // because renderSeats rebuilds the row wholesale and would otherwise stack a
  // fresh pair of window listeners on every bot move.
  //
  // Capturing, and BEFORE the plate's own handlers rather than after: a tap
  // that lands inside the plate is a tap on a meld chip and must reach it.
  document.addEventListener('pointerdown', (event) => {
    if (!session || !seatRow.openPlateSeat()) return;

    // THE WHOLE OPPONENT ROW, not merely the seat that happens to be open.
    //
    // This handler runs on pointerdown, in the CAPTURE phase, so it beats the
    // click that follows it — and re-rendering here throws away the very node
    // that click was travelling to. Guarding only the open seat therefore made
    // switching plates a two-tap operation: the first tap on another face
    // dismissed the open one and rebuilt the row, and the button the player
    // had aimed at no longer existed to receive the click. Every control in
    // this row already knows what a tap on it means; none of them wants this
    // one deciding first.
    if (el.opponentsTop.contains(event.target)) return;

    // The plate is a separate element in its own layer, and a tap on a meld
    // chip in there has to reach the chip.
    const plate = document.getElementById('seat-plate-layer');
    if (plate && plate.contains(event.target)) return;

    // A PRESS ON A CARD IS NOT A DISMISSAL, it is the start of a play.
    //
    // Pressing a hand card either selects it or begins a drag, and both of
    // those are the opening move of "put this on that opponent's meld" — so
    // closing the plate here shut the drop target before the card had left the
    // hand. Whether the gesture turns out to be a tap or a drag is not known
    // until it has travelled (src/ui/dragController.js), and by then the plate
    // would already be gone.
    if (event.target.closest?.('.draggable, .card-face-wrap')) return;

    seatRow.dismissPlate();
    if (liveState()) render(liveState());
  }, true);

  // A TAP ON THE FELT ENDS WHATEVER BEAT THE FELT IS HOLDING (#176, #181).
  //
  // ASKED OF THE GATE, NOT OF THE BEAT. It read `session.trickBeat` while a
  // completed trick was the only thing that ever waited for a person; the counts
  // of a cribbage show wait at the same rung now, and they are not a trick.
  // `session.beatResume` is the one field either of them sets and the one thing
  // this listener actually needs — there is something standing on the felt
  // asking to be dismissed — so it needs no list of what kinds there are. The
  // show card is inside #table, which is what makes a tap on the thing being
  // READ the tap that continues.
  //
  // ON THE FELT, NOT ON THE SCREEN. #status-bar is outside #table, so the Lobby
  // button and the score chip are exempt by construction — they are not on the
  // felt and a tap on them is a player going somewhere, not a player saying
  // "yes, I saw it". What IS inside #table is the chrome standing on it, and
  // every item below already knows what a tap on it means: the help mark and its
  // sheet, the opponent row (a seat plate, the view toggle), the out-of-turn
  // announcement and emote bars, and the rail's own two buttons. `closest`
  // rather than a comparison to `target`, the way the round panel does it, so a
  // tap landing on a label inside one of them still counts as that control's.
  //
  // NOTHING ELSE ON THE FELT WANTS THIS TAP. `render` builds its UI model with
  // `acts: false` for the whole beat (the `humanActs` line reads `trickBeat`,
  // and `roundBeat` for a show), so no card, pile or meld chip has a handler
  // armed on it — this cannot swallow a move, because while a beat is being held
  // there is no move to swallow.
  el.table.addEventListener('click', (event) => {
    if (!session?.beatResume) return;
    if (event.target.closest?.(
      '#help-button, #help-sheet, .opponent-row, #announce-bar, #emote-bar, #hand-sort, #action-button',
    )) return;
    // AND NOT THE TAP THAT OPENED THE BEAT IT FINDS. `#hand` is inside `#table`,
    // so the tap that plays the fourth card arrives here too — after the card's
    // own handler has already run the move and opened the beat, in the same
    // dispatch — and this listener was ending the hold it had just watched open.
    // The player only ever saw the beat on tricks a bot finished. A show stacks
    // three of those dispatches in a row, each count opening inside the tap that
    // dismissed the last, which is the same bug three times over and would end a
    // whole hand in one gesture. See endHeldBeat.
    roundEnding.endHeldBeat(event);
  });

  // The plate is anchored to a seat's rect, so anything that moves that rect
  // has to move the plate with it — the row scrolling under it most of all.
  el.opponentsTop.addEventListener('scroll', seatRow.placeOpenPlate, { passive: true });
  window.addEventListener('resize', seatRow.placeOpenPlate, { passive: true });

  window.addEventListener('keydown', (event) => {
    if (!session) return;
    // THE SAME DOOR, WITHOUT A POINTER (#176, #181). At the Manual rung the
    // trick hold is indefinite and so is every count of a show, so a beat only a
    // tap could end would strand anyone playing this from a keyboard or a screen
    // reader in a table that never moves again. Enter and Space, because that is
    // what "activate" already means everywhere on this screen and it is what the
    // felt's own sentence promises. The gate is the condition here for the same
    // reason it is on the felt's click: what a key means during a held beat does
    // not depend on which kind of beat it is.
    //
    // THE REEL FROM THE KEYBOARD (REVIEW_PLAN.md phase 3): arrows step a turn,
    // with Shift a hand; Escape closes the map, then the review — see
    // `onKey` in src/ui/reviewController.js.
    if (reviewer.onKey(event)) return;
    // NOT WHEN THE KEY IS AIMED AT A CONTROL. Focus sitting on Lobby and a press
    // of Enter is a player leaving; this must not read it as "go on".
    if (session.beatResume && (event.key === 'Enter' || event.key === ' ')
        && !event.target?.closest?.('button, a[href], input, select, textarea')) {
      // AND NOT THE KEY PRESS THAT OPENED IT, for the reason the felt's click
      // gives: a hand card is a `role="button"` div and not a `<button>`, so it
      // does not match the opt-out above — Enter on the card that ends a trick
      // plays it, opens the hold, and then arrives here as an ordinary key.
      //
      // Space scrolls the page otherwise, which on a short felt moves the very
      // cards the hold exists to show — but only swallow the key if there was
      // actually a hold to end, which is what `endHeldBeat` comes back with.
      if (roundEnding.endHeldBeat(event)) event.preventDefault();
      return;
    }
    if (event.key !== 'Escape') return;
    // The sheet is the innermost thing open, so it is the first thing closed.
    if (helpOpen()) {
      setHelpOpen(false);
      return;
    }
    const node = seatRow.openPlateSeat();
    if (!node) return;
    const seat = node.dataset.seat;
    seatRow.dismissPlate();
    if (liveState()) render(liveState());
    // Focus goes back to the face it came from, or Escape is a dead end for
    // anyone playing this from the keyboard.
    el.opponentsTop.querySelector(`[data-seat="${seat}"] .seat__head`)?.focus();
  });

  drag = createDragController({
    layer: flightLayer,
    onLift: onDragLift,
    onSettle: onDragSettled,
    // Only a hand card can be scrubbed along; a pile top has no row to read.
    classifyGesture: ({ dx, dy, handle }) => (
      handle.kind === 'hand' ? classifyHandGesture({ dx, dy }) : 'drag'
    ),
  });

  // Every extracted module takes its seams rather than reaching for this file's
  // state. The zone renderer draws the piles and melds; the table tells it what
  // a tap on one MEANS.
  zones = createZoneRenderer({
    me,
    session: () => session,
    art,
    cardById,
    markEntry,
    // `node` is the pile that was tapped — the card's DESTINATION — so it is
    // dropped in favour of wherever the card actually is. See tapOrigin.
    onTarget: (move) => { if (liveState()) performHumanMove(liveState(), move, tapOrigin(move)); },
    onPickUp: (address, top) => {
      session.selection = isSelected(session.selection, address, top)
        ? null
        : { from: address, cardIds: [top] };
      renderSelection(liveState());
    },
    onMeld: (meldKey) => {
      const ready = session?.ui?.readyMelds.get(meldKey);
      // The chip is the target, not the origin — same as onTarget above.
      if (ready && liveState()) performHumanMove(liveState(), ready, tapOrigin(ready));
    },
    attachInspector,
    attachDrag: (node, handle) => { if (drag) drag.attach(node, handle); },
    isBusy: () => !!drag && drag.isDragging(),
    identityOf,
  });

  record = createMatchRecord({
    me,
    seating: () => session.seating,
    art,
    // The record is written on the way out of a match, so the timers stop
    // first — a bot turn landing after the books are closed would reopen it.
    onConclude: () => { cancelBotTurn(); cancelAnnouncementBeats(); },
    // Which books this match's ending goes into. Asked at conclusion time,
    // like `seating` above, because this object outlives any one match.
    daily: () => session?.daily || null,
  });

  ladder = createContractLadder({
    el: el.contractLadder,
    me,
    identityOf,
    attachInspector,
    isBusy: () => !!drag && drag.isDragging(),
  });

  contractStrip = createContractStrip({
    el: el.tableContract,
    me,
    identityOf,
    art,
  });

  moments = createCelebrations({
    seatPossessive,
    me,
    seatLabel,
    currentEpoch: () => epoch,
    el,
    art,
    zoneRect,
    seatRect,
    pulseSeat,
    cardById,
  });

  // Per §10/§17.5 this runs host-side when Phase 8 lands — see src/ui/botDriver.js.
  //
  // THE SESSION CLOCK IS THE SOLO ANSWER, and naming it here rather than
  // reaching for `Arcade.session` inside the driver is what lets a shared
  // table hand it the host wall clock instead (src/match/clock.js).
  //
  // WHICH ONE IS A PER-MATCH QUESTION, AND THIS IS BUILT ONCE (#71). The driver
  // outlives every match the tab plays, so the clock is chosen when a turn is
  // scheduled rather than here: session time for solo, the host's wall clock
  // for a table other people are sitting at, whose hand does not stop because
  // the host pocketed their phone.
  bots = createBotDriver({
    clock: feltClock({ shared: () => !!session?.shared }),
    currentEpoch: () => epoch,
    // READ FRESH, NOT OFF THE SNAPSHOT — both of these. `settings` is loaded
    // when the table is initialised and refreshed on a re-render, and the
    // new-game sheet can change either between the two: deal a Sharp game
    // straight after a Steady one, or a Slow one after a Brisk one, and the
    // snapshot would still say Steady and Brisk. The driver asks at fire time
    // (src/ui/botDriver.js) precisely so both can be answered late.
    botDelayMs: () => currentDelayMs(),
    difficulty: () => loadSettings().botDifficulty,
    me,
    identityOf,
    actingSeatsOf,
    announcementsFor,
    playMove: (state, move, seat) => {
      const from = move.type === 'draw'
        ? (zoneRect(move.from ?? 'draw') || seatRect(seat))
        : seatRect(seat);
      applyStateChange(state, move, { far: true });
      afterMove(state, move, from, `${identityOf(seat).name} ${botVerb(state.pack.template, move.type)}.`);
    },
    playAnnouncement: (state, move, myEpoch) => performAnnouncement(state, move, myEpoch),
    onError: reportTableError,
  });

  initPanels({
    onReview: () => reviewer.enterReview(),
    onReviewMapClosed: () => reviewer.refitFelt(),
    onGameOverMap: () => reviewer.gameOverMapNode(),
    onRoundMap: () => reviewer.roundMapNode(),
    onContinueRound: () => roundEnding.dismissRoundSummary(),
    onPlayAgain: () => livePack() && doors.startGame(livePack(), liveState()?.seats),
    onLobby: () => exitToLobby(),
    onEndMatch: () => roundEnding.endMatchFromSummary(),
    onRules: () => livePack() && showRules(packRules(livePack())),
    onCloseScoreboard: () => {},
    onCyclePace: () => roundEnding.cyclePace(),
  });

  // The fan's spacing is the one thing that depends on how much room the row
  // has, and it is a custom property rather than a re-render — so reacting to
  // a width change costs two measurements, not a repaint of the table.
  handFan.watchHandWidth();
  seatRow.watchSeatRowWidth();
  seatRow.watchSeatRowEdges();
  ladder.watch(liveState);
  gestures = watchHandGestures({
    hand: el.hand,
    session: () => session,
    me,
    cardById,
    onSelect: onHandCard,
    // A full render: the gathered cards leave the fan for the tray.
    onGathered: (state, count) => render(state, `Gathered ${count} cards.`),
  });

  el.lobbyButton.addEventListener('click', () => exitToLobby());
  el.speedChip.addEventListener('click', () => cycleSpeed());
  el.scoreChip.addEventListener('click', () => openScoreboard());

  // The reel's own buttons (index.html #review-bar).
  el.reviewPrevHand.addEventListener('click', () => reviewer.stepReview('prevHand'));
  el.reviewPrevTurn.addEventListener('click', () => reviewer.stepReview('prevTurn'));
  el.reviewNextTurn.addEventListener('click', () => reviewer.stepReview('nextTurn'));
  el.reviewNextHand.addEventListener('click', () => reviewer.stepReview('nextHand'));
  el.reviewPosition.addEventListener('click', () => reviewer.openReviewMap());
  el.reviewDone.addEventListener('click', () => reviewer.leaveReview());
  // The bar is on screen before the first render, so the chip needs its word
  // now rather than at the first `renderStatusBar` — an empty pill in the
  // chrome reads as a bug, not as a control waiting for a state.
  paintSpeedChip();
  el.handSort.addEventListener('click', () => handFan.cycleHandSort());
}

/** Surface a boot/open failure on the table's own log line. */
export function reportTableError(message) {
  el.log.textContent = message;
}
