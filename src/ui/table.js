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
// replaces them with host-wall-clock timeout events (ARCADE_ENHANCEMENTS §8.2).
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
// choreography in src/ui/dragController.js, and who-is-who in
// src/players/roster.js. What is left here is the felt itself: piles, seats,
// the hand, and the loop that turns a move into sound, motion and a save.

import { createState } from '../engine/state.js';
import { makeCtx } from '../engine/context.js';
import { validateMove, applyMove, legalMovesFor } from '../engine/movePipeline.js';
import { rehydrateMatch, packVersionChanged } from '../engine/replay.js';
import { baseId } from '../engine/selectors.js';
import { handValue } from '../engine/scoring.js';
import { buildSeating } from '../players/roster.js';
import { makeCardRenderer } from './cardStyles/index.js';
import { fetchPack } from './packSource.js';
import { flyCard, landOn, motionAllowed, flightLayer, rectOf, cardSizedRect } from './flight.js';
import { createSession, stopSession } from './session.js';
import { createBotDriver, botVerb } from './botDriver.js';
import { schedule } from './clock.js';
import { line, svgNode, clearSvgCache } from './dom.js';
import { promptChoice, closeChoiceDialog } from './choiceDialog.js';
import { createCelebrations } from './celebrations.js';
import { createContractLadder } from './contractLadder.js';
import {
  createSeatLens, soloSeatTable, createSeatTable, deserializeSeatTable,
  LOCAL_DEVICE as LOCAL_VIEWER,
} from '../players/seats.js';
import { modelFromView } from './tableModel.js';
import { sessionClock } from '../match/clock.js';
import { createMatchRecord } from './matchRecord.js';
import { watchHandGestures } from './handGestures.js';
import { createZoneRenderer } from './zoneRenderer.js';
import { closeConfirm, confirmAction } from './confirm.js';
import { createDragController } from './dragController.js';
import { attachInspector, hideInspector } from './inspector.js';
import {
  describeCard, cardAriaLabel, cardName,
} from './describe.js';
import {
  interactionMode, stagingPhase, buildUiModel, dropCandidates, draggableSources, pruneSelection,
  isSelected, handAddress, implicitLandingZone,
} from './interaction.js';
import {
  orderHand, reorder, nextMode, isSortMode, fanStep, classifyHandGesture, SORT_LABELS,
} from './handOrder.js';
import {
  initPanels, showRoundSummary, hideRoundSummary,
  showScoreboard, showGameOver, hideAllPanels, showRules, awaitFinalLook,
} from './panels.js';
import { packRules } from './rules.js';
import {
  rememberPack, loadSettings, saveMatch, loadMatch, clearMatch, recordForfeit,
  loadHandPrefs, saveHandPrefs,
} from '../arcade/storage.js';
import {
  playDeal, playCardPlayed, playDraw, playShuffle, playInvalid, playWin, playAnnouncement,
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

// Where the star sits at a table with no peers. Solo play has always dealt the
// player seat 0 and the roster paints them there; this names that fact instead
// of spelling it as a bare literal in the two places that still need one.
const SOLO_HUMAN_SEAT = 0;

// The table's own default when nothing asks for anything else — a deep link,
// a resumed match with its own seat count, a pack whose minimum is higher.
// The new-game sheet (src/ui/newGame.js) is what usually decides this now.
const SEAT_COUNT = 3;

/** Clamp a requested seat count to what the pack says it can seat. */
function seatsFor(pack, requested) {
  const players = pack.manifest.players || {};
  const min = players.min ?? 2;
  const max = players.max ?? 8;
  const want = Number.isFinite(requested) ? requested : SEAT_COUNT;
  return Math.max(min, Math.min(max, want));
}

const el = {
  screen: document.getElementById('table-screen'),
  table: document.getElementById('table'),
  status: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  lobbyButton: document.getElementById('lobby-button'),
  scoreChip: document.getElementById('score-chip'),
  scoreChipValue: document.getElementById('score-chip-value'),
  opponentsTop: document.getElementById('opponents-top'),
  centerPiles: document.getElementById('center-piles'),
  playerPiles: document.getElementById('player-piles'),
  announceBar: document.getElementById('announce-bar'),
  contractLadder: document.getElementById('contract-ladder'),
  actionBar: document.getElementById('action-bar'),
  actionHint: document.getElementById('action-hint'),
  actionButton: document.getElementById('action-button'),
  stageRow: document.getElementById('stage-row'),
  stageTray: document.getElementById('stage-tray'),
  handRow: document.getElementById('hand-row'),
  hand: document.getElementById('hand'),
  handSort: document.getElementById('hand-sort'),
  log: document.getElementById('log'),
  eventBanner: document.getElementById('event-banner'),
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
let settings = null;
let exitToLobby = () => {};
// Pointer choreography for lifting a card (src/ui/dragController.js), created
// once at init and reused by every match.
let drag = null;
// A renderer with no pack behind it, for the moment before the first match.
const EMPTY_ART = makeCardRenderer({});

// openTable() awaits a fetch, and the player can be back in the lobby before it
// lands. `epoch` cannot cover that gap — it is bumped when the match is ADOPTED,
// which is the thing we are trying not to do. So opening carries its own token:
// whoever bumps it last owns the screen, and a superseded open returns quietly.
let openToken = 0;

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
 * Who may act right now. Usually just turn.seat; a simultaneous-commit phase
 * (Hearts' passing) is every seat that has not committed yet — the template
 * says so via actingSeats, the same hook tools/simulate.mjs consults. This is
 * what un-stalls the pass phase: the bot driver below schedules whichever
 * bot may act, not whoever nominally holds the turn.
 */
function actingSeatsOf(state) {
  if (state.gameOver) return [];
  const template = state.pack.template;
  if (template.actingSeats) return template.actingSeats(makeCtx(state));
  return [state.turn.seat];
}

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
  const template = state.pack.template;
  if (!template.enumerateAnnouncements) return [];
  return template.enumerateAnnouncements(makeCtx(state), seat) || [];
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
 *   - Neither. The action bar's turn token is static markup in index.html
 *     (`#action-bar > .turn-token`). Left alone its three pulses would run out
 *     while the game was still booting and never fire again, so renderActionBar
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
 *   - Frozen while hidden. schedule() is Arcade.session.setTimeout when the
 *     SDK is there (src/ui/clock.js), so a suspended frame does not wake up
 *     owing itself a nudge, and stopSession cancels whatever is in flight.
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
  for (const def of state.zones.defs.values()) {
    if (def.per === 'player') continue;
    // Hidden shared zones (Stockpile's `recycled`) stay off the table; a
    // hidden zone that is ALSO a control says so with `interactive` in its
    // definition, which is how the draw pile keeps its place without this line
    // knowing that a draw pile is called "draw".
    if (def.visibility === 'none' && !def.interactive) continue;
    out.push(...instancesOf(def, null));
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

/** Does this pack keep a running score worth showing on the felt? */
function showsScores(state) {
  return state.pack.scoring?.accumulate === true
    || state.scores.some((n) => n !== 0);
}

/**
 * What a seat's score chip says — the template's answer, or the plain total.
 *
 * Contract rummy's "score" that matters is the contract you have reached and
 * the points are the tiebreak, which is why a plain total is the wrong default
 * for it and right for everything else. That used to be
 * `typeof playerVars[seat].phase === 'number'`, written out twice in this file,
 * beside three more direct reads of the same private var.
 *
 * @returns { short, long, aria } — `short` fits an opponent's plate, `long` is
 *          the human's own chip, which has room for both numbers.
 */
function scoreChipFor(state, seat) {
  const declared = state.pack.template.scoreChip?.(makeCtx(state), seat);
  if (declared) return declared;
  const score = String(state.scores[seat]);
  return { short: score, long: score, aria: `${score} points` };
}

function seatScoreChip(state, seat) {
  const chip = document.createElement('span');
  chip.className = 'seat__score';
  const { short, aria } = scoreChipFor(state, seat);
  chip.textContent = short;
  chip.setAttribute('aria-label', aria);
  return chip;
}

/**
 * Which way play is going, for packs where that can change.
 *
 * Only rendered once a reverse has actually happened — `state.direction` is 1
 * in every game that never turns round, and a permanent arrow saying "play
 * goes left" on a table that has no other option is chrome that teaches
 * nothing. It appears the moment a reverse lands and then stays, which is
 * exactly when a player needs to be able to check.
 */
function directionBadge(state) {
  if (state.direction >= 0) return null;
  const badge = document.createElement('div');
  badge.className = 'direction-badge';
  badge.textContent = '↺';
  badge.setAttribute('aria-label', 'Play has reversed — it now goes to the right');
  return badge;
}

/**
 * WHAT THE ROW GIVES UP, IN THE ORDER IT GIVES IT UP.
 *
 * Each rung hides more than the one above. Which rung is used is MEASURED, not
 * guessed: renderSeats builds the row, asks whether it overflows, and steps
 * down only if it does — so a wide screen never collapses anything, and a
 * phone collapses exactly as far as it has to and no further.
 *
 * It used to be a set of seat-count thresholds (collapse at 3 opponents, faces
 * at 4), which is the same guess made twice: a count cannot know how wide a
 * name is, how long a score chip has grown, how many melds are laid down, or
 * how big the window is. It collapsed four-handed tables that had room to
 * spare, and still overflowed by 183px when two seats had to stay open at
 * once.
 *
 * The seat that may ACT never gives anything up, at any rung — whose turn it
 * is, and what they are holding, is what the row is read for.
 */
const SEAT_TIERS = [
  // Everything: fan, name, score, counts, melds, piles.
  'full',
  // Waiting seats lose the fan of backs — decoration, and the widest thing on
  // the plate. Melds and piles stay, so every hit target is still on the felt.
  'compact',
  // ...and their names. The face and the count are still a player and how
  // close they are to going out.
  'tight',
  // Waiting seats become a face you open: fan, melds and piles move into the
  // plate behind a tap (or a drag-hover). This is the first rung that puts a
  // legal move behind a gesture, which is why .seat--target exists.
  'collapsed',
  // ...and lose their names and scores too, wearing the card count on the
  // corner of the avatar. The last rung; below this there is nothing left to
  // give and the row scrolls instead.
  'faces',
];
const TIER_COLLAPSED = SEAT_TIERS.indexOf('collapsed');
const TIER_FACES = SEAT_TIERS.indexOf('faces');
/** Offer the "show everyone" toggle from this many opponents up. */
const CAROUSEL_FROM_SEATS = 3;

/**
 * Does this seat hold something the human's selected card can be played onto?
 *
 * A collapsed seat has no visible meld chips, so the glow that would have been
 * on the chip has to move somewhere the player can still see it — onto the
 * avatar, which is then the way in. Without this a legal layoff at a crowded
 * table is a move with no affordance anywhere on screen, which is the one
 * thing the old "never hide .seat__zones" rule existed to prevent.
 */
function seatHasReadyTarget(state, seat, ui) {
  for (const key of ui.readyMelds.keys()) {
    // "1:" cannot match seat 11's "11:0" — the colon is part of the prefix.
    if (key.startsWith(`${seat}:`)) return true;
  }
  for (const inst of perPlayerZoneInstances(state, seat)) {
    if (ui.readyTargets.has(inst.address)) return true;
  }
  return false;
}

/**
 * The numbers a MINIMIZED seat's face is worth wearing — the pack's answer.
 *
 * Every pack still minimizes; what changes per pack is which number survives
 * it. The default is the hand count, which is right wherever the hand is the
 * race (shedding empties it, a rummy contract is finished by going out) and
 * wrong in sequencing, where Stockpile tops every hand back up to five — so a
 * minimized row read "5 cards" five times over while the stock count, the
 * thing the whole game is a race on, was the number it had put away.
 *
 * See `seatCounters` in src/templates/CONTRACT.md.
 */
function seatCountersFor(state, seat, { minimized }) {
  const declared = state.pack.template.seatCounters?.(makeCtx(state), seat);
  const count = state.zones.count(`hand.${seat}`);
  const list = Array.isArray(declared) && declared.length
    ? declared
    : [{ text: String(count), aria: cardsPhrase(count) }];
  // THE PRIMARY NUMBER IS THE SAME WHETHER OR NOT THE SEAT IS MINIMIZED.
  //
  // Counters were once read only off minimized seats, which meant the badge in
  // a given spot on the row silently changed what it MEANT: at a Stockpile
  // table the row read "20 20 5 20 20", and the 5 was not a player whose stock
  // had collapsed — it was the one seat whose turn it was, open, and therefore
  // showing a hand count instead. A number that changes quantity depending on
  // whose turn it is is worse than either quantity alone.
  //
  // `minimizedOnly` is for the counters that are genuinely redundant when the
  // seat is open: a rummy meld count sits directly above the meld chips, and
  // Hearts' points sit above the won pile that holds them.
  return minimized ? list : list.filter((counter) => !counter.minimizedOnly);
}

/**
 * "1 card", not "1 cards".
 *
 * A seat holding one card is the most consequential moment a rummy table has —
 * it is the one everybody is watching, and the sentence a screen reader says
 * about it should not be the one that sounds broken.
 */
function cardsPhrase(count) {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

/** The collapsed head's accessible name, rebuilt from its two stored halves. */
function paintSeatHead(head, targeted) {
  head.setAttribute('aria-label',
    `${head.dataset.seatBase || ''}`
    + `${targeted ? ' Your selected card can be played here.' : ''}`
    + `${head.dataset.seatTail || ''}`);
}

/**
 * Re-light the collapsed seats after a SELECTION changed and nothing else did.
 *
 * The same repaint-don't-rebuild contract renderSelection keeps for piles and
 * meld chips (see its header), and the collapsed row genuinely needs it: the
 * avatar glow IS the layoff affordance once the chips are put away, so a glow
 * that only refreshed on a full render would light up one bot move late and
 * stay lit after the card that earned it was played.
 */
function paintSeatTargets(state, ui) {
  for (const plate of el.opponentsTop.querySelectorAll('.seat--collapsed')) {
    const targeted = seatHasReadyTarget(state, Number(plate.dataset.seat), ui);
    plate.classList.toggle('seat--target', targeted);
    const head = plate.querySelector('.seat__head');
    if (head) paintSeatHead(head, targeted);
  }
}

/**
 * The fan of card backs and the seat's own piles: the BODY of a seat plate.
 *
 * Factored out of renderSeats because a collapsed seat still has to be able to
 * show all of it. The popup its avatar opens is this same body, built by this
 * same code, carrying the same live hit targets — so a meld you can lay off
 * onto is never a different object depending on how much room the row happened
 * to have, and the paint pass in renderSelection finds its chips either way.
 */
function buildSeatBody(state, seat, stagger, ui, into, { compactZones = true } = {}) {
  const count = state.zones.count(`hand.${seat}`);

  // THE OPPONENT'S HAND, DRAWN AS WHAT IS ACTUALLY VISIBLE OF IT.
  //
  // `--mini-step` closes this fan to as little as a fifth of a card, so all
  // but the rightmost back is covered to within a few pixels of its left
  // edge — white paper margin, then the printed panel, and nothing else.
  // Drawing a full back for the covered ones meant rasterising up to ninety
  // vector lines apiece to fill that sliver, for every card in every
  // opponent's hand, on every render. Two opponents holding seventeen cards
  // is a couple of thousand invisible line segments per frame, and it is why
  // a phone dropped frames on a table nothing was even moving on.
  //
  // So the covered ones are a box in the pack's own panel colour (see
  // .mini-hand__edge in table.css) and the one card you can genuinely see is
  // the real thing. Pixel-identical where it counts.
  const mini = document.createElement('div');
  mini.className = 'mini-hand';
  // The count is all the CSS needs to close the fan to a fixed width — see
  // .mini-hand in table.css for why a seat's geometry must not track how
  // many cards it holds. Deliberately not measured here: the card width is a
  // breakpoint-driven custom property, so the arithmetic belongs where that
  // property is defined rather than in a second copy that can drift from it.
  mini.style.setProperty('--mini-count', String(count));
  mini.style.setProperty('--back-panel', art().backPanel);
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const node = last
      ? svgNode(art().back(), stagger ? 'card-deal' : '')
      : document.createElement('span');
    if (!last) {
      if (stagger) node.className = 'card-deal';
      const edge = document.createElement('span');
      edge.className = 'mini-hand__edge';
      node.appendChild(edge);
    }
    markEntry(node, `back:${seat}:${i}`);
    if (stagger) node.style.animationDelay = `${i * 35}ms`;
    mini.appendChild(node);
  }
  // Decorative, and now genuinely unreadable: the covered cards are boxes
  // with nothing to announce. No loss — the fan was announcing "Face-down
  // card" once per card, thirteen times in a row, next to a count badge that
  // already says "13 cards" in one breath.
  mini.setAttribute('aria-hidden', 'true');
  into.appendChild(mini);

  // The seat's own piles, compact: a Stockpile stock and discards, laid-down
  // melds (live hit targets), a Hearts won pile with the points it holds.
  const seatZones = perPlayerZoneInstances(state, seat);
  if (seatZones.length) {
    const strip = document.createElement('div');
    strip.className = 'seat__zones';
    for (const inst of seatZones) {
      if (inst.def.id === 'melds') {
        strip.appendChild(zones.buildMeldStrip(state, seat, ui, { mini: compactZones }));
      } else if (inst.def.visibility === 'none') {
        const pts = heldValueText(state, inst.def, inst.address);
        const chip = line('seat__pilechip', `${inst.def.label || inst.def.id} ${state.zones.count(inst.address)}${pts ? ` · ${pts}` : ''}`);
        chip.dataset.zone = inst.address;
        strip.appendChild(chip);
      } else {
        strip.appendChild(zones.buildPileNode(state, inst, ui, { mini: compactZones }));
      }
    }
    into.appendChild(strip);
  }
}

/**
 * The open seat plate, and where on the screen it sits.
 *
 * FIXED, AND OUTSIDE THE ROW IT BELONGS TO. The obvious build — append it to
 * the seat, position it absolutely — works right up until the row has to
 * scroll, and the row now always can (see .opponent-row's overflow-x): a
 * scrollport clips its own absolutely-positioned children, so the plate would
 * be cut off by the very container the player opened it from. Anchoring it to
 * the seat's rect instead makes it immune to both the row scroller and the
 * carousel, and lets it be clamped to the VIEWPORT rather than to the felt,
 * which is the edge that actually matters.
 *
 * It lives inside el.screen so renderSelection's repaint pass — which walks
 * `el.screen` for `.meld-chip[data-meld]` — keeps finding its chips. That is
 * what makes the melds in here live rather than a picture of live ones.
 */
function plateLayer() {
  let layer = document.getElementById('seat-plate-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'seat-plate-layer';
    el.screen.appendChild(layer);
  }
  return layer;
}

/** Sit under the seat's face, nudged back inside the viewport rather than clipped. */
function positionPlate(plate, anchorNode) {
  const seatRect = anchorNode.getBoundingClientRect();
  const size = plate.getBoundingClientRect();
  const margin = 8;

  let left = seatRect.left + seatRect.width / 2 - size.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - size.width - margin));

  let top = seatRect.bottom + 6;
  // No room below (a short window, or a row pushed down the felt) — flip above.
  if (top + size.height > window.innerHeight - margin) {
    top = Math.max(margin, seatRect.top - size.height - 6);
  }
  plate.style.left = `${Math.round(left)}px`;
  plate.style.top = `${Math.round(top)}px`;
}

/**
 * The seat element whose plate is on screen, or null.
 *
 * Read off the DOM rather than off `session.openSeat`, because the plate may
 * be open without anybody having picked it — the row opens the acting seat's
 * plate by itself. `openSeat` answers "what did the player choose", which is a
 * different question and was the wrong one for the dismiss handlers: with a
 * plate open by turn rather than by tap, they saw `null` and did nothing, so
 * Escape and tapping the felt both stopped closing it.
 */
function openPlateSeat() {
  const plate = document.querySelector('#seat-plate-layer .seat__plate');
  return plate || null;
}

/** Put the open plate away until play moves on. */
function dismissPlate() {
  if (!session) return;
  session.openSeat = null;
  session.plateDismissed = true;
}

/** Take the open plate off the screen. Safe when there is not one. */
function closePlate() {
  const layer = document.getElementById('seat-plate-layer');
  if (layer) layer.replaceChildren();
}

/**
 * Build the open plate for `seat`. NOT positioned here — see placeOpenPlate.
 */
function buildPlateFor(state, seat, identity, stagger, ui) {
  const layer = plateLayer();
  layer.replaceChildren();
  const plate = document.createElement('div');
  plate.className = 'seat__plate';
  plate.dataset.seat = String(seat);
  // A disclosure of the head button, which already names the player and says
  // what this does — so this names only what it contains.
  plate.setAttribute('role', 'group');
  plate.setAttribute('aria-label', `${identity.name}'s cards`);
  // The COMPACT pile and chip builders, scaled up by the plate's own CSS
  // rather than swapped for the full-size ones. Full size looked like the
  // right answer for "magnified" and was not: five 90px Stockpile piles do not
  // fit across a plate, so they wrapped, collided, and made the popup taller
  // than the board behind it. Compact parts at plate scale fit on one line,
  // stay a comfortable drop target, and keep the plate small enough to read
  // the felt around it.
  buildSeatBody(state, seat, stagger, ui, plate, { compactZones: true });
  layer.appendChild(plate);
}

/**
 * Anchor the open plate to its seat, once the row it hangs off actually exists.
 *
 * SEPARATE FROM BUILDING IT, and that is the whole point of the split: the
 * plate is built inside the seat loop, where the seat's own element has not
 * been appended to the row yet. Measured there, the anchor is an unlaid-out
 * node whose rect is all zeros, and the plate pinned itself to the top-left
 * corner of the window instead of to the face that opened it.
 */
function placeOpenPlate() {
  const plate = document.querySelector('#seat-plate-layer .seat__plate');
  if (!plate) return;
  const seat = el.opponentsTop.querySelector(`[data-seat="${plate.dataset.seat}"]`);
  if (seat) positionPlate(plate, seat);
}

/**
 * HOW MUCH OF THE OTHER PLAYERS TO SHOW — the player's own three-way choice.
 *
 * This was a two-state carousel toggle, and two states could not express what
 * a table actually needs. Fitting alone is not the whole question: Stockpile's
 * piles are small enough that five opponents' worth of them technically fit on
 * any desktop, so the automatic rule — give up only what will not fit — meant
 * that table never minimized at ANY width, however cluttered it read. The
 * answer is not a cleverer width threshold; it is that "is this too busy" is a
 * preference, and the player is the one holding it.
 *
 * HOW IT IS DRAWN: one dot, two dots, three dots — how much of each player is
 * on the felt, counted out. The states are ORDERED by that, least to most, and
 * the button cycles through them in order, so the control teaches itself: dots
 * go up, you see more; they wrap round to one, you see least. It replaced a set
 * of invented glyphs (⊞ ⊟ ⇥⇤) that had no relationship to each other and so had
 * to be learned three times over, once per state, with nothing carrying between
 * them.
 *
 *   1 dot   minimized  faces for everyone who cannot act, fit or no fit
 *   2 dots  auto       give up only what will not fit  (the default)
 *   3 dots  all        every plate open, the row scrolls sideways
 *
 * Only offered once there is a crowd, because on a small table every plate is
 * already open and all three states draw the same row.
 */
const SEAT_VIEWS = ['minimized', 'auto', 'all'];
// `label` is the whole of what this control says: it is the button's own
// accessible name, and it names both the rung it is on and what a tap does
// next. There was a `title`/`note` pair here as well, for a hover panel that
// explained the glyphs — the dots need no explaining, and the panel is gone.
const SEAT_VIEW_COPY = {
  minimized: { dots: 1, label: 'Player cards: minimized. Tap to show as much as fits.' },
  auto: { dots: 2, label: 'Player cards: as much as fits. Tap to open every player in full.' },
  all: { dots: 3, label: 'Player cards: all open. Tap to go back to minimized.' },
};

function seatViewOf() {
  const view = session?.seatView;
  return SEAT_VIEWS.includes(view) ? view : 'auto';
}

function seatViewToggle() {
  const view = seatViewOf();
  const copy = SEAT_VIEW_COPY[view];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'opponent-row__toggle';
  button.dataset.view = view;
  // Dots as elements rather than a string of "•" characters: they are drawn by
  // the stylesheet, so they stay round and evenly spaced at any font scale the
  // launcher applies (§5), where punctuation would ride the text metrics.
  for (let i = 0; i < copy.dots; i++) {
    const dot = document.createElement('span');
    dot.className = 'opponent-row__dot';
    button.appendChild(dot);
  }
  // Not aria-pressed: this is a three-way cycle, and a pressed/unpressed
  // boolean would describe two of the states and lie about the third. The
  // label says which one it is in and what tapping does next, which also
  // overrides the dots — they are a picture of what the label already says.
  button.setAttribute('aria-label', copy.label);
  button.addEventListener('click', () => {
    if (!session || !liveState()) return;
    session.seatView = SEAT_VIEWS[(SEAT_VIEWS.indexOf(view) + 1) % SEAT_VIEWS.length];
    // The seat holding an open plate may not be minimized in the next view.
    session.openSeat = null;
    render(liveState());
  });
  // NO INSPECTOR HERE EITHER. It existed to explain three invented glyphs;
  // one, two and three dots are a scale that explains itself, and the button's
  // own accessible name still says which rung it is on and what a tap does
  // next. A panel that opens over the felt to describe a control in the corner
  // is exactly the kind that was in the way.
  return button;
}

/**
 * Draw the opponent row at one rung of SEAT_TIERS. Called more than once per
 * render while renderSeats finds the rung that fits — so it must be a pure
 * rebuild with no side effects outside the row and the plate layer.
 */
function buildSeatRow(state, stagger, acting, ui, { tier, carousel, mustOpen, showToggle, actor }) {
  el.opponentsTop.replaceChildren();
  // The plate lives outside the row, so clearing the row no longer clears it.
  // Dropped here and rebuilt below if its seat is still open, which keeps
  // "what is on screen" a function of this build rather than of the last one.
  closePlate();

  const collapsing = !carousel && tier >= TIER_COLLAPSED;
  const isCollapsed = (seat) => collapsing && !mustOpen(seat);

  // WHOSE PLATE IS SHOWING: the player's own pick if they made one, otherwise
  // whoever's turn it is. Their pick is retired when play moves on (see
  // renderSeats), so this follows the turn again by itself rather than leaving
  // them in a state they have to remember to leave.
  const picked = session?.openSeat;
  const shownSeat = typeof picked === 'number' ? picked
    : (session?.plateDismissed ? null : actor);

  // In carousel mode every rung is off. That is the bargain: the player asked
  // to see everything and the row bought the room by scrolling, so shedding
  // fans on top of it would answer the request by hiding what it asked for.
  el.opponentsTop.classList.toggle('opponent-row--compact', !carousel && tier >= 1);
  el.opponentsTop.classList.toggle('opponent-row--tight', !carousel && tier >= 2);
  el.opponentsTop.classList.toggle('opponent-row--faces', !carousel && tier >= TIER_FACES);
  el.opponentsTop.classList.toggle('opponent-row--carousel', carousel);

  // THE TOGGLE IS NOT IN THE ROW AT ALL — it lives in the felt's top corner
  // (see seatViewToggle). Inside the row it was content like any other, so
  // `justify-content: center` centred the seats-plus-a-control and pushed the
  // faces 29px off centre; balancing it needed a second empty item at the far
  // end, which was two pieces of furniture to solve a problem neither of them
  // needed to have. Out of the row, the row centres seats and nothing else.
  el.table.querySelector('.opponent-row__toggle')?.remove();
  if (showToggle) el.table.appendChild(seatViewToggle());

  const reversed = directionBadge(state);
  if (reversed) el.opponentsTop.appendChild(reversed);
  const scored = showsScores(state);
  const challenges = humanAnnouncements(state).filter((a) => a.type === 'challenge');
  for (let seat = 0; seat < state.seats; seat++) {
    if (isMySeat(seat)) continue;
    const identity = identityOf(seat);
    const count = state.zones.count(`hand.${seat}`);
    const active = acting.includes(seat);
    const collapsed = isCollapsed(seat);
    const open = collapsed && shownSeat === seat;
    // Only worth asking about a collapsed seat, whose chips are not on screen
    // to glow for themselves.
    const targeted = collapsed && seatHasReadyTarget(state, seat, ui);

    const wrap = document.createElement('div');
    wrap.className = `seat ${active ? 'seat--active' : ''} ${collapsed ? 'seat--collapsed' : ''} ${targeted ? 'seat--target' : ''}`;
    wrap.dataset.seat = String(seat);

    // Collapsed, the head IS the way into the plate, so it is a real button —
    // not a div with a click handler. A span-only child list keeps it valid
    // markup; the Catch! button stays a SIBLING below for the same reason.
    const head = document.createElement(collapsed ? 'button' : 'div');
    head.className = 'seat__head';
    if (collapsed) {
      head.type = 'button';
      head.setAttribute('aria-expanded', String(open));
      head.addEventListener('click', () => {
        if (!session || !liveState()) return;
        // Closing the seat the TURN opened is "not this turn" rather than a
        // pick of nobody, so it is recorded as a dismissal — which renderSeats
        // retires the moment play moves on.
        if (open) {
          session.openSeat = null;
          session.plateDismissed = true;
        } else {
          session.openSeat = seat;
          session.plateDismissed = false;
        }
        render(liveState());
      });
    }

    // On a MINIMIZED seat the token is worn on the avatar (absolutely, see the
    // stylesheet) rather than taking a slot in the head. In the head it made
    // the acting seat wider than every other seat, which is the exact shift
    // this layout works to remove — a player would move sideways because their
    // neighbour's turn began. An open seat has room for it inline.
    if (active) {
      const token = turnToken();
      if (collapsed) {
        token.classList.add('turn-token--worn');
        wrap.appendChild(token);
      } else {
        head.appendChild(token);
      }
    }

    const avatar = document.createElement('span');
    avatar.className = 'seat__avatar';
    // Own value from the roster, never a manifest one — this reaches an
    // inline style (§7b).
    avatar.style.background = identity.color;
    // textContent, not innerHTML: the instant a name arrives from a peer,
    // an interpolated template string is the XSS this fleet has shipped
    // twice (GAME_INTEGRATION §7b).
    avatar.textContent = identity.icon || identity.initials;
    avatar.setAttribute('aria-hidden', 'true');
    head.appendChild(avatar);

    const name = document.createElement('span');
    name.className = 'seat__name';
    name.textContent = identity.name;
    // The same string again, for the acting seat's glow: the stylesheet draws
    // it a second time in transparent ink so the halo can be faded on its own
    // layer instead of tweening a text-shadow (see .seat--active .seat__name).
    // A dataset write is data, and CSS attr() inserts a string and never
    // markup, so this is as safe as the textContent above (§7b).
    name.dataset.name = identity.name;
    head.appendChild(name);

    if (scored) head.appendChild(seatScoreChip(state, seat));

    // WHAT SURVIVES BEING MINIMIZED, and it is the pack that decides.
    //
    // An open seat wears the plain hand count and shows its piles below, so
    // there is nothing to choose between. A minimized one has room for a
    // couple of digits and has put every pile away, so the number on the face
    // has to be the one the game is actually read for — see seatCountersFor.
    const counters = seatCountersFor(state, seat, { minimized: collapsed });
    counters.forEach((counter, i) => {
      const badge = document.createElement('span');
      // First is the primary badge; the rest are smaller marks beside it. The
      // kind is a TEMPLATE-chosen slug, never pack data reaching an attribute
      // the stylesheet matches on (§7b) — hence the whitelist-ish shape.
      badge.className = i === 0 ? 'seat__count' : 'seat__count--aux';
      if (counter.kind) badge.dataset.counter = String(counter.kind).replace(/[^a-z0-9-]/gi, '');
      badge.textContent = counter.text;
      // The visible badge is a bare number, which reads as nothing on its own.
      badge.setAttribute('aria-label', `${counter.aria}${i === 0 && active ? '. Their turn.' : ''}`);
      head.appendChild(badge);
    });

    if (collapsed) {
      // The head is a button now, and a button made of badges names itself
      // "🂠 Delphine 42 7 ▤2" if left to name-from-content. Said outright, in
      // the order a player would ask it, with the affordance last.
      //
      // Split into dataset halves for the same reason .meld-chip keeps its
      // label there: the middle clause changes when the SELECTION changes, and
      // paintSeatTargets has to rewrite it without the seat, the counts or the
      // player's name to rebuild it from.
      head.dataset.seatBase = `${identity.name}. ${counters.map((c) => c.aria).join(', ')}.`;
      head.dataset.seatTail = ` ${open ? 'Hide' : 'Show'} their cards.`;
      paintSeatHead(head, targeted);
    }

    wrap.appendChild(head);

    // NO INSPECTOR ON A SEAT. It used to carry the player's name, card count,
    // score and what they had laid down — and every one of those is now
    // printed on the face itself (the name, the score chip, and the counters
    // the pack declares). A panel that repeats the thing it is covering is
    // worse than no panel, and a seat is a big target sitting in the path of
    // ordinary pointer movement, so it was the one that got in the way most.
    //
    // The seat is also the one inspectable that had somewhere better to go:
    // holding it is how you OPEN it, and the plate says all of this at full
    // size with the cards themselves. The tagline is the only thing genuinely
    // lost, and a bot's one-liner is flavour, not information.

    // The fan and the seat's piles: on the plate itself when there is room for
    // it, and inside the popup the avatar opens when there is not. Same
    // builder, same live chips, either way.
    if (!collapsed) {
      buildSeatBody(state, seat, stagger, ui, wrap);
    } else if (open) {
      buildPlateFor(state, seat, identity, stagger, ui);
    }

    // The catch affordance (§E2) lives on the seat it accuses, which is the
    // only place it reads as "you — you never said it".
    const catchMove = challenges.find((a) => a.target === seat);
    if (catchMove) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'seat__catch';
      button.textContent = 'Catch!';
      button.setAttribute('aria-label', `Catch ${identity.name} — they never declared their last card.`);
      button.addEventListener('click', () => liveState() && performAnnouncement(liveState(), catchMove));
      wrap.appendChild(button);
    }

    el.opponentsTop.appendChild(wrap);
  }
}

/** Does the row need more width than it has? The whole fit question. */
function seatRowOverflows() {
  // 1px of tolerance: scrollWidth and clientWidth are integers rounded from
  // fractional layout, so a row that fits exactly can report one pixel over
  // and send the whole ladder down a rung for nothing.
  return el.opponentsTop.scrollWidth > el.opponentsTop.clientWidth + 1;
}

function renderSeats(state, stagger, acting, ui) {
  const opponents = state.seats - 1;
  // Three ways to show a crowd, and the player picks — see seatViewToggle.
  const view = seatViewOf();
  const carousel = view === 'all';

  // WHICH SEATS MAY NOT BE MINIMIZED — and it is no longer "whoever is
  // playing".
  //
  // The acting seat used to be forced open in the row, and that one exception
  // was where the movement came from: an open seat is two to three times the
  // width of a face, so every turn it pushed each seat to its right along by
  // 130-ish pixels. Players who had not done anything moved because somebody
  // ELSE started their turn. Now every seat is the same size and the acting
  // seat's detail opens in the plate below it instead — new information
  // appearing rather than existing information sliding.
  //
  // A seat you can CATCH is still forced open, for a reason that is not about
  // turns: the button is worn across the accused seat's own fan (see
  // .seat__catch) and a face has no fan to wear it across. The window is a
  // couple of seconds, the whole mechanic is noticing in time, and the row
  // lurching is a fair price for an alarm — arguably it IS the alarm.
  //
  // Enumerating announcements builds a fresh engine context, which is why it
  // is asked once for the row rather than once per opponent.
  const accused = new Set(
    humanAnnouncements(state).filter((a) => a.type === 'challenge').map((a) => a.target),
  );
  const mustOpen = (seat) => accused.has(seat);

  // Whose plate the row will open by itself: the opponent whose turn it is.
  // `acting` can name several seats in a simultaneous phase (Hearts' pass), and
  // there is no single actor to follow then — so the plate stays out of it.
  const actingOpponents = acting.filter((seat) => !isMySeat(seat));
  const actor = actingOpponents.length === 1 && !accused.has(actingOpponents[0])
    ? actingOpponents[0]
    : null;
  // Play moving on retires both the player's pick and their dismissal, so the
  // plate goes back to following the turn without them having to undo anything.
  if (session && session.plateActor !== actor) {
    session.plateActor = actor;
    session.openSeat = null;
    session.plateDismissed = false;
  }

  // The toggle is a view control for a crowd; it is not offered on a table
  // where every seat is already open and it would toggle between two identical
  // rows. Its width is part of the row, so it is present for the measuring.
  const showToggle = carousel || opponents >= CAROUSEL_FROM_SEATS;

  const build = (tier) => buildSeatRow(state, stagger, acting, ui, { tier, carousel, mustOpen, showToggle, actor });

  if (carousel) {
    // Nothing is given up and nothing is measured: the row is allowed to be
    // longer than the felt, which is the point of it.
    build(0);
  } else {
    // THE FIT LOOP. Start at the rung that fitted last time — turn to turn the
    // answer is the same, so the common case rebuilds the row exactly once —
    // then step down while it still overflows. It only ever steps DOWN here;
    // stepping back up is what the cache key below is for, so a row cannot
    // oscillate between two rungs on alternating turns.
    //
    // FLOOR, NOT START: 'minimized' means the player has asked for faces, so
    // the ladder begins at the collapsed rung and is still free to go further
    // if even faces do not fit. Beginning at 0 in that mode would just have
    // the fit test hand back the open row it was told not to draw.
    const floor = view === 'minimized' ? TIER_COLLAPSED : 0;
    const cached = session?.seatFit?.key === seatFitKey(state, mustOpen, view)
      ? session.seatFit.tier
      : 0;
    let tier = Math.max(floor, cached);
    build(tier);
    while (tier < SEAT_TIERS.length - 1 && seatRowOverflows()) {
      tier += 1;
      build(tier);
    }
    if (session) session.seatFit = { key: seatFitKey(state, mustOpen, view), tier };
  }

  // A seat the player picked but which is no longer minimized — the row grew
  // enough room for it, or it became the accused — cannot keep a plate it has
  // no face to hang off. Checked against what was actually BUILT rather than
  // recomputed, so this cannot disagree with the row on screen.
  if (session && session.openSeat !== null
      && !el.opponentsTop.querySelector(`.seat--collapsed[data-seat="${session.openSeat}"]`)) {
    session.openSeat = null;
    closePlate();
  }

  reserveSeatRowSpace(state, view, carousel);
  scrollActingSeatIntoView();

  // Every seat is in the DOM now, so the open plate has a rect to hang off.
  placeOpenPlate();
}

/**
 * HOLD THE ROW'S SHAPE STILL ACROSS TURNS.
 *
 * The row is drawn fresh every time anybody moves, and its natural size tracks
 * whoever is playing — a seat that opens for its turn is both taller and wider
 * than the face it replaced. Left alone that costs the player two pieces of
 * re-orientation on EVERY turn, measured on a six-handed Stockpile table:
 *
 *   - the row grew 43px -> 145px, and the whole felt below it moved down with
 *     it. The build piles — the things you are aiming at — sat 103px lower on
 *     a bot's turn than on yours.
 *   - `justify-content: center` re-centred the seats every time that width
 *     changed, so all five avatars slid ~66px sideways. Nothing about those
 *     players had changed; they moved because somebody ELSE's seat opened.
 *
 * So the row reserves the tallest it has been for this configuration and stays
 * there. A HIGH-WATER MARK rather than a computed maximum because the honest
 * maximum depends on the pack, the seat count and the melds laid down — all
 * things the row can measure about itself once it has been drawn, and none of
 * which it can be told up front.
 *
 * HEIGHT ONLY. There was a width reservation here too, a trailing spacer that
 * held the content at its widest so the seats would stop re-centring. It was
 * the right fix for the wrong era: back then the acting seat opened INSIDE the
 * row and was three times the width of a face. Seats are uniform now — the
 * acting seat's detail goes to the plate — so the content width no longer
 * changes and there is nothing to hold still. What the spacer did instead was
 * outlive its own reason: once a transiently wider row had set the high-water
 * mark, every later row was padded on the right and the faces sat visibly left
 * of centre for the rest of the match. Reserving a width that never varies is
 * all cost and no benefit, so it is gone.
 *
 * The reserve is per configuration, so a resize or a change of view starts a
 * fresh one instead of inheriting a stale, too-large floor.
 */
function reserveSeatRowSpace(state, view, carousel) {
  const row = el.opponentsTop;
  // DELIBERATELY COARSER THAN seatFitKey, which counts how many seats have to
  // stay open. That count is the difference between your turn and a bot's —
  // exactly the transition this reservation exists to smooth — so keying off
  // it reset the high-water mark on every turn and the reserve never applied.
  // What the reserve may NOT span is a resize, a seat count, or a view change.
  const key = `${row.clientWidth}:${state.seats}:${view}`;
  const held = session?.seatRowReserve;
  const reserve = held && held.key === key ? held : { key, height: 0 };

  // The carousel is a scroller the player drives; reserving inside it would
  // pad the scrollable length for no one's benefit.
  if (carousel) {
    row.style.minHeight = '';
    if (session) session.seatRowReserve = null;
    return;
  }

  // Measured, not summed: `getBoundingClientRect().height` already includes
  // whatever floor is currently applied, and content taller than the floor
  // still reports its real height — so taking the max is enough to grow the
  // reserve and it can never shrink under its own reservation.
  reserve.height = Math.max(reserve.height, Math.round(row.getBoundingClientRect().height));
  row.style.minHeight = `${reserve.height}px`;
  if (session) session.seatRowReserve = reserve;
}

/**
 * Bring the seat that is playing into view, centred where the row allows it.
 *
 * Carousel only. It is the one view whose whole premise is a row longer than
 * the felt, which means it is the one view where the seat you most need to see
 * can be off the end of it — and a player watching a six-handed table should
 * not have to go looking for whose turn it is.
 *
 * Every other view fits by construction (the fit ladder guarantees it), so
 * there is nothing to scroll and this stays out of the way.
 */
function scrollActingSeatIntoView() {
  const row = el.opponentsTop;
  if (!row.classList.contains('opponent-row--carousel')) return;
  const seat = row.querySelector('.seat--active');
  if (!seat) return;
  const max = row.scrollWidth - row.clientWidth;
  if (max <= 0) return;
  const centred = seat.offsetLeft + (seat.offsetWidth / 2) - (row.clientWidth / 2);
  const left = Math.max(0, Math.min(max, Math.round(centred)));
  // Already there, near enough: re-issuing a smooth scroll every render would
  // restart the animation on each of a turn's several renders and leave the
  // row permanently gliding.
  if (Math.abs(row.scrollLeft - left) < 2) return;
  row.scrollTo({ left, behavior: motionAllowed() ? 'smooth' : 'auto' });
}

/**
 * What the chosen rung depends on, as a string.
 *
 * Only things that change how WIDE the row wants to be, because the whole
 * point is to avoid re-probing from the top on an ordinary turn. Melds
 * accumulating and score chips growing are deliberately NOT in here: they only
 * ever make the row wider, and the fit loop already steps down when it
 * overflows. What is in here is what can make the row need LESS room — a seat
 * count, a resize, or a change in how many seats have to stay open.
 */
function seatFitKey(state, mustOpen, view) {
  let open = 0;
  for (let seat = 0; seat < state.seats; seat++) if (!isMySeat(seat) && mustOpen(seat)) open += 1;
  // `view` is in the key so switching back to 'auto' re-probes from the top
  // rather than inheriting the floor 'minimized' was pinned to.
  return `${el.opponentsTop.clientWidth}:${state.seats}:${open}:${view}`;
}

function renderCenterZones(state, ui, draggable) {
  el.centerPiles.replaceChildren();
  for (const inst of sharedZoneInstances(state)) {
    el.centerPiles.appendChild(zones.buildPileNode(state, inst, ui, {
      draggableTop: draggable.piles.get(inst.address) || null,
    }));
  }
}

function renderPlayerZones(state, ui, draggable) {
  el.playerPiles.replaceChildren();
  for (const inst of perPlayerZoneInstances(state, mySeat())) {
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
 * Which of the hand's cards are waiting in the tray rather than in the fan.
 *
 * Only in the modes that gather several cards before committing them — laying
 * down a contract, choosing a pass. Everywhere else a selection is a single
 * card that is about to be played somewhere, and lifting it out of the fan
 * would be motion for a card that is leaving anyway.
 */
function stagedIds(state) {
  // ASKED OF THE PHASE, NOT OF THE MOMENT.
  //
  // This used to gate on `ui.handMulti`, and that flips partway through a
  // turn — a rummy turn is draw, then meld, then discard, and only the middle
  // of those gathers. So the SAME picked cards were drawn two different ways
  // depending on when you looked: sitting in the tray while gathering, and
  // lifted out of the fan on either side of it. Nothing about the cards had
  // changed; the display bounced because the mode had.
  //
  // `stagingPhase` is the stable question — its own note explains that it has
  // to be, because the tray's SLOT is reserved on it and a slot that comes and
  // goes moves the felt under the hand. Gating the CONTENTS on the same
  // question means a pack that stages always stages, and a pack that never
  // does (shedding) still shows its single selection in the fan, which is the
  // only place it has.
  if (!stagingPhase(state)) return [];
  if (!session.selection || session.selection.from !== handAddress(mySeat())) return [];
  return session.selection.cardIds;
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
  // The SLOT belongs to the phase, the CONTENTS belong to the human. Gating
  // the row itself on `ui.handMulti` meant it left the felt's flex column
  // every time the answer changed — twice a turn in contract rummy, once the
  // bots start drawing and melding — and took a card's height of table with
  // it (#13). A pack that never stages still gets no row at all.
  el.stageRow.hidden = !stagingPhase(state);
  // Empty and inert follow WHAT IS IN THE TRAY, not what mode the turn is in.
  // Keyed on `ui.handMulti` these disagreed with the tray's own contents the
  // moment stagedIds stopped asking that question — the row would go inert
  // while still holding cards the player could tap to put back.
  el.stageRow.classList.toggle('stage-row--empty', !staged.length);
  el.stageRow.inert = !staged.length;
  el.stageTray.replaceChildren();
  if (!staged.length) {
    el.stageTray.setAttribute('aria-label', 'Gathered cards appear here.');
    return;
  }
  el.stageTray.setAttribute('aria-label',
    `Gathered: ${staged.length} cards. Tap one to put it back.`);
  for (const cardId of staged) {
    const card = cardById(state, cardId);
    if (!card) continue;
    const node = svgNode(art().face(card), 'stage-card');
    node.dataset.cardId = cardId;
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.setAttribute('aria-label', `${cardAriaLabel(card, state.pack)} Gathered. Tap to put it back.`);
    const putBack = () => onHandCard(state, cardId, card, node, ui);
    node.addEventListener('click', putBack);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      putBack();
    });
    attachInspector(node, () => describeCard(card, state.pack),
      { isBusy: () => !!drag && drag.isDragging() });
    el.stageTray.appendChild(node);
  }
}

function renderHand(state, ui, stagger, draggable) {
  el.hand.replaceChildren();
  const handAddr = handAddress(mySeat());
  const engineHand = state.zones.cards(handAddr);
  // The engine's order is dealing order and stays that way; what the player
  // sees is their own arrangement (src/ui/handOrder.js).
  session.displayedHand = orderHand(engineHand, (id) => cardById(state, id), session.handPrefs.mode, session.handPrefs.order);
  const committedPass = committedSelectionOf(state, mySeat());

  // Gathered cards are drawn in the tray instead, so the fan holds only what
  // is still to be chosen from. handPrefs.order is NOT touched — a card put
  // back returns to the exact slot it left, because it never left the order.
  const staged = new Set(stagedIds(state));
  const fanned = staged.size ? session.displayedHand.filter((id) => !staged.has(id)) : session.displayedHand;

  fanned.forEach((cardId, i) => {
    const card = cardById(state, cardId);
    const selectable = ui.handSelectable.has(cardId);
    const selected = isSelected(session.selection, handAddr, cardId) || (committedPass || []).includes(cardId);
    // A card you cannot play is DRAWN as one — grey stock, deeper ink, baked
    // into the art (src/ui/cardStyles/shared.js). It used to be the live card
    // under `opacity: 0.78`, which cost a composited layer per unplayable card
    // per frame and faded the rank you are reading to find out why it is
    // unplayable. Only the hand does this: a pile or an opponent's card is not
    // yours to play, so there is nothing for it to say there.
    const wrapper = svgNode(art().face(card, !selectable),
      `card-face-wrap ${selectable ? '' : 'card-face--disabled'} ${stagger ? 'card-deal' : ''} ${selected ? 'card-face-wrap--selected' : ''}`);
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
    wrapper.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (selectable) activate();
    });

    if (draggable.hand.has(cardId) && drag) {
      drag.attach(wrapper, { kind: 'hand', from: handAddr, cardId });
    }
    // Where a hold gathers a meld, it cannot also open the inspector — two
    // things on one gesture, and the one that changes the board must win.
    // The card's description is still on its accessible name, and everywhere
    // outside a rummy lay-down the long press means "what is this?" as before.
    attachInspector(wrapper, () => describeCard(card, state.pack),
      { isBusy: () => (!!drag && drag.isDragging()) || !!gestures?.smartSelectArmed() });

    el.hand.appendChild(wrapper);
  });

  el.handSort.textContent = SORT_LABELS[session.handPrefs.mode] || SORT_LABELS.auto;
  el.handSort.setAttribute('aria-label', `Hand order: ${SORT_LABELS[session.handPrefs.mode]}. Change it.`);
  el.handSort.hidden = engineHand.length < 2;
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
 * Cheap enough to run on every render and every resize: two measurements and
 * one custom property, no relayout of anything else.
 */
function layoutHand() {
  const count = el.hand.childElementCount;
  if (count < 2) {
    el.hand.style.removeProperty('--fan-step');
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
  const cardWidth = parseFloat(styles.getPropertyValue('--hand-card-w')) || 70;
  const padding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  // The sort toggle shares the row, so the fan may not have all of it.
  const reserved = el.handSort.hidden ? 0 : el.handSort.offsetWidth + 12;
  const available = Math.max(cardWidth, rowWidth - reserved - padding - 4);

  const step = fanStep({ count, cardWidth, available });
  el.hand.style.setProperty('--fan-step', `${step.toFixed(2)}px`);
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

/**
 * Re-fit the opponent row when the room it has changes.
 *
 * The same shape, and the same reason, as watchHandWidth above: the width that
 * decides how much the seats have to give up is the ROW's, and it moves for
 * things a window `resize` never hears about — the launcher's font scale, the
 * table screen going from `hidden` to shown at boot, a suspended frame waking
 * with real geometry. Without this the row keeps whichever rung it picked at
 * whatever width it was first measured at, which on a rotated phone is a row
 * still dressed for a screen that is no longer there.
 *
 * Only the seats are rebuilt, not the whole table: nothing else on the felt
 * cares, and a full render here would fight the hand's own observer.
 */
function watchSeatRowWidth() {
  // WIDTH ONLY, and remembered, because this observes the very element it
  // rebuilds. Re-fitting changes the row's HEIGHT — five faces are a third of
  // a row of open plates — so reacting to every box change would answer its
  // own notification: refit, height moves, observer fires, refit again. It
  // would settle (the second pass produces the same DOM) but it would do a
  // wasted rebuild every time, and it is the shape that becomes a real loop
  // the moment anything downstream is less stable. Width is what the fit
  // question is about; height is only ever its answer.
  let lastWidth = -1;
  const refit = () => {
    const state = liveState();
    // A rebuild mid-drag would replace the seat the pointer is carrying a card
    // to — and the drag holds measured rects for nodes this would throw away.
    if (!state || !session || (drag && drag.isDragging())) return;
    const width = el.opponentsTop.clientWidth;
    if (width === lastWidth) return;
    lastWidth = width;
    renderSeats(state, false, actingSeatsOf(state), session.ui || buildUiModel(state, {
      seat: mySeat(), moves: [], acts: false, selection: session.selection,
    }));
  };
  if (typeof ResizeObserver !== 'function') {
    window.addEventListener('resize', refit);
    return;
  }
  new ResizeObserver(refit).observe(el.opponentsTop);
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
 * note in src/ui/table.css).
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
  // felt's column either way. See #action-bar below for the full story — this
  // is the same bug and the same fix (#13).
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

function renderActionBar(state, ui, humanActs) {
  const waitingOnPass = interactionMode(state) === 'pass'
    && !humanActs && !state.gameOver
    && committedSelectionOf(state, mySeat()) !== null;
  const hint = humanActs ? ui.hint : (waitingOnPass ? 'Waiting for the other players to pass…' : '');
  // THE ONE TOKEN NOBODY REBUILDS. This bar's turn token is static markup in
  // index.html, so its finite pulse would have run itself out during boot and
  // never fired again (see "Finite pulses" above). Replayed on the transition
  // INTO the human's turn — the single moment it has something new to say —
  // and not on the renders that follow within the same turn.
  if (session && humanActs && !session.humanActing) {
    replayPulse(el.actionBar.querySelector('.turn-token'), 'turn-token');
  }
  if (session) session.humanActing = humanActs;
  // NOT `hidden`. This bar sits in the felt's flex column, and a bar that
  // leaves the column takes its height with it — which meant the turn cue
  // moved the whole table every time the turn changed hands (#13). It keeps
  // its slot now and only stops being visible; src/ui/table.css holds the
  // reserved height and the reasoning.
  el.actionBar.classList.toggle('action-bar--empty', !hint);
  // Nothing else changes on the way out. The bar keeps its last words and its
  // token while it fades — clearing them first would collapse the pill
  // mid-fade — and `inert` is what makes those leftovers unreachable at once,
  // by keyboard and by screen reader, rather than when the fade ends.
  el.actionBar.inert = !hint;
  if (!hint) {
    el.actionButton.onclick = null;
    return;
  }
  el.actionBar.classList.toggle('action-bar--acting', humanActs);
  el.actionHint.textContent = hint;
  if (ui.action && humanActs) {
    el.actionButton.hidden = false;
    el.actionButton.textContent = ui.action.label;
    el.actionButton.onclick = () => {
      if (!liveState()) return;
      performHumanMove(liveState(), ui.action.makeMove(), el.actionButton);
    };
  } else {
    el.actionButton.hidden = true;
    el.actionButton.onclick = null;
  }
}

function renderStatusBar(state, acting) {
  el.statusText.textContent = statusTextFor(state, acting);
  const humanActs = acting.some(isMySeat);
  el.status.classList.toggle('status-bar--your-turn', humanActs);
  el.status.classList.toggle('status-bar--thinking', !state.gameOver && !humanActs);

  const scored = showsScores(state);
  el.scoreChip.hidden = !scored;
  if (scored) {
    el.scoreChipValue.textContent = scoreChipFor(state, mySeat()).long;
    el.scoreChip.setAttribute('aria-label', `Your score: ${state.scores[mySeat()]}. Open the scoreboard.`);
  }
}

function statusTextFor(state, acting) {
  if (state.gameOver) return `Game over — ${winnerSentence(state)}`;
  if (state.turn.phase === 'pass') {
    return acting.some(isMySeat) ? 'Passing — your pick' : 'Waiting for passes…';
  }
  return acting.some(isMySeat) ? 'Your turn' : `${seatLabel(state.turn.seat)}'s turn`;
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
  for (const wrapper of el.hand.children) {
    const cardId = wrapper.dataset.cardId;
    const selected = isSelected(session.selection, handAddr, cardId) || committedPass.includes(cardId);
    wrapper.classList.toggle('card-face-wrap--selected', selected);
    wrapper.setAttribute('aria-pressed', String(selected));
  }
  for (const stack of el.screen.querySelectorAll('.pile-stack[data-zone]')) zones.paintPileState(stack, ui);
  for (const chip of el.screen.querySelectorAll('.meld-chip[data-meld]')) zones.paintMeldState(chip, ui);
  paintSeatTargets(state, ui);
  renderActionBar(state, ui, humanActs);
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
  const humanActs = acting.some(isMySeat);
  const humanMoves = humanActs ? movesFor(state, mySeat()) : [];
  const ui = buildUiModel(state, { seat: mySeat(), moves: humanMoves, acts: humanActs, selection: session.selection });
  const draggable = draggableSources(state, { seat: mySeat(), acts: humanActs });
  const stagger = session.dealAnimation && motionAllowed();

  session.ui = ui;

  renderStatusBar(state, acting);
  renderSeats(state, stagger, acting, ui);
  if (ladder) ladder.render(state);
  renderCenterZones(state, ui, draggable);
  renderPlayerZones(state, ui, draggable);
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
  renderActionBar(state, ui, humanActs);
  renderHand(state, ui, stagger, draggable);
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
  buildPlateFor(state, seat, identityOf(seat), false, session.ui);
  placeOpenPlate();

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
      onDrop: (event) => reorderHandAt(handle.cardId, event.clientX),
    });
  }

  return { markup: art().face(card), targets };
}

/**
 * Drop `cardId` where the pointer left it.
 *
 * Rearranging by hand IMPLIES "my order" — a player who has just moved a card
 * has said what they want more clearly than any toggle could, so the mode
 * follows the gesture rather than making them find a control first.
 */
function reorderHandAt(cardId, clientX) {
  const nodes = [...el.hand.querySelectorAll('[data-card-id]')];
  let index = nodes.length;
  for (let i = 0; i < nodes.length; i++) {
    const rect = nodes[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      index = i;
      break;
    }
  }
  if (!livePack() || !liveState()) return;
  session.handPrefs = { mode: 'manual', order: reorder(session.displayedHand, cardId, index) };
  saveHandPrefs(livePack().id, session.handPrefs);
  render(liveState());
}

function cycleHandSort() {
  if (!liveState() || !livePack()) return;
  const mode = nextMode(session.handPrefs.mode);
  session.handPrefs = {
    // Switching AWAY from manual keeps the permutation: the player gets their
    // arrangement back when they cycle round to it, instead of being punished
    // for glancing at a sorted view.
    mode: isSortMode(mode) ? mode : 'auto',
    order: session.handPrefs.mode === 'manual' ? session.displayedHand.slice() : session.handPrefs.order,
  };
  saveHandPrefs(livePack().id, session.handPrefs);
  render(liveState());
}

/* ------------------------------------------------------------------ *
 * Geometry for card travel — the parts that need the table's own elements.
 * `rectOf` and `cardSizedRect` moved to src/ui/flight.js, which already owns
 * the flying and where dragController's verbatim copy of rectOf now points too.
 * ------------------------------------------------------------------ */

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
  return (mini && (rectOf(mini.lastElementChild) || rectOf(mini)))
    || rectOf(plate.querySelector('.seat__avatar'))
    || rectOf(plate);
}

function zoneRect(address) {
  const node = zoneStackNode(address);
  if (!node) return null;
  return rectOf(node.querySelector?.('.pile-stack__top') || node) || rectOf(node);
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
  if (move.type === 'draw') {
    // A draw has no single landing slot in a fanned hand, so it dissolves on
    // arrival rather than pretending to become a particular card. The human's
    // own draw is face-up because they are about to see it anyway.
    const to = cardSizedRect(seatRect(move.actor), from.width);
    const card = isMySeat(move.actor)
      ? cardById(state, state.zones.cards(handAddress(mySeat())).at(-1) || '')
      : null;
    flyCard(card ? art().face(card) : art().back(), from, to, { fade: true });
    return;
  }
  if (move.type === 'hit') {
    const card = cardById(state, move.cards?.[0]);
    const to = cardSizedRect(zoneRect(`melds.${move.choice?.seat}`), from.width);
    if (card && to) flyCard(art().face(card), from, to, { fade: true });
    return;
  }
  if (move.type !== 'playCard' && move.type !== 'discard') return;
  const card = cardById(state, move.cards && move.cards[0]);
  if (!card) return;
  const address = implicitLandingZone(state, move);
  if (!address) return;
  const node = zoneStackNode(address);
  const topNode = node ? node.querySelector('.pile-stack__top') : null;
  landOn(topNode, flyCard(art().face(card), from, rectOf(topNode) || zoneRect(address)));
}

/* ------------------------------------------------------------------ *
 * Table moments — src/ui/celebrations.js owns the banners, the trick
 * gather, the action-card narration and the penalty flight. These are the
 * thin wrappers that hand it the open session.
 * ------------------------------------------------------------------ */

let moments = null;
let ladder = null;
let gestures = null;
let zones = null;
let record = null;

function hideBanner() { if (moments) moments.hideBanner(session); }
function showBanner(text, tone) { if (moments) moments.showBanner(session, text, tone); }
function celebrateTrick(state, ev) { if (moments) moments.celebrateTrick(session, state, ev); }
function celebrateAction(state, events) { return moments ? moments.celebrateAction(session, state, events) : null; }
function animatePenaltyDraw(state, seat, count, delay) { if (moments) moments.animatePenaltyDraw(state, seat, count, delay); }

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
  const myEpoch = epoch;
  const leader = Math.max(...state.scores);
  const ahead = state.scores[mySeat()] >= leader;
  const ok = await confirmAction(
    `End this ${state.pack.manifest.name} match after ${state.roundNumber - 1} `
    + `${state.roundNumber - 1 === 1 ? 'round' : 'rounds'}?`
    + (ahead ? '' : ' It counts as a forfeit.'),
    { okLabel: 'End match', cancelLabel: 'Keep playing' },
  );
  if (!ok || myEpoch !== epoch || liveState() !== state) return;

  cancelBotTurn();
  cancelAnnouncementBeats();
  clearMatch(state.pack.id);
  recordForfeit(state.pack.id, session.seating);
  session.roundSummaryOpen = false;
  hideRoundSummary();
  exitToLobby();
}

function dismissRoundSummary() {
  // The SESSION says whether we are between rounds; the panel merely shows it.
  // This used to branch on `!el.roundOverlay.hidden` (panels.isRoundSummaryOpen),
  // which made a DOM attribute the only record of a game-state fact — and one
  // that any other code path hiding the overlay would silently erase.
  if (!session || !session.roundSummaryOpen || !liveState()) return;
  session.roundSummaryOpen = false;
  hideRoundSummary();
  session.dealAnimation = true;
  playDeal(liveState().seats);
  render(liveState(), `Round ${liveState().roundNumber}.`);
  scheduleNextTurn();
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
  const ok = saveMatch(state);
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
 */
function offerFinalLook(state, move, ending) {
  const myEpoch = epoch;
  pulseSeat(state.winner, 'good');
  Arcade.session.setTimeout(async () => {
    if (myEpoch !== epoch) return;
    const acknowledged = await awaitFinalLook(winnerSentence(state), finalPlaySentence(state, move));
    // Closed under it, or a new game started while it was up — either way these
    // results belong to a match that is no longer the one on screen.
    if (!acknowledged || myEpoch !== epoch) return;
    showGameOver(state, ending);
  }, 700);
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
  applyMove(state, move);
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
  const roundOver = events.find((e) => e.type === 'roundOver' && !e.over);

  if (state.gameOver) {
    // Recorded before the render, so the panel that is eventually built can
    // show the updated record — this game's counters are ours to display (§4:
    // `stats` is the surface whose formatting the game owns). The PANEL itself
    // waits: the last card is the thing worth watching, and it is still in the
    // air on this frame.
    const ending = record.concludeMatch(state);
    render(state, message);
    animateMove(state, move, from);
    if (trick) celebrateTrick(state, trick);
    playWin();
    offerFinalLook(state, move, ending);
    return;
  }

  if (passed && !message) message = 'Cards passed. Play!';
  render(state, message);
  animateMove(state, move, from);
  if (trick) celebrateTrick(state, trick);
  // After the card has been seen to land, and only when a trick is not already
  // holding the felt — two celebrations at once is neither.
  const action = trick ? null : celebrateAction(state, events);
  // The action is the better sentence: "Rook played." says less than nothing
  // next to "You draw 4 and lose your turn", and the log is the live region a
  // screen reader hears.
  if (action) el.log.textContent = action.text;
  persistMatch();

  if (roundOver) {
    // The engine has already dealt the next round beneath this move; the
    // summary sits on top of the fresh deal and bot play waits for its
    // dismissal. A beat of delay lets a closing trick's gather land first.
    cancelAnnouncementBeats();
    const myEpoch = epoch;
    Arcade.session.setTimeout(() => {
      if (myEpoch !== epoch) return;
      session.roundSummaryOpen = true;
      showRoundSummary(state, roundOver, session.seating);
    }, trick ? 900 : 250);
    return;
  }

  scheduleNextTurn();
  scheduleAnnouncementBeats();
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
      picked = await promptChoice(art(), ask.prompt || ask.attr, options,
        { card: ask.cardId ? cardById(state, ask.cardId) : null });
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
  const from = rectOf(sourceNode) || (move.from ? zoneRect(move.from) : null) || seatRect(mySeat());
  // NOT `selection = null`. The render inside afterMove prunes it per card
  // (pruneSelection), which drops exactly what this move consumed and leaves
  // the rest staged. Clearing wholesale is what made a Milestones meld
  // impossible to build across turns: every turn ends in a discard, and the
  // discard took the tray with it.
  applyStateChange(state, move, { far: false });
  afterMove(state, move, from);
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

  // Selection modes: toggle membership (multi) or replace (single).
  if (session.selection && session.selection.from !== handAddr) session.selection = null;
  if (ui.handMulti) {
    const ids = session.selection ? session.selection.cardIds.slice() : [];
    const at = ids.indexOf(cardId);
    if (at !== -1) ids.splice(at, 1);
    else ids.push(cardId);
    session.selection = ids.length ? { from: handAddr, cardIds: ids } : null;
    // The card moves between the fan and the tray, so the fan's child count
    // changes and it has to be rebuilt and re-measured — the fast path below
    // deliberately does neither. The flight covers the rebuild.
    const from = rectOf(sourceNode);
    render(state);
    flyToStage(state, cardId, from);
    return;
  }
  session.selection = isSelected(session.selection, handAddr, cardId) ? null : { from: handAddr, cardIds: [cardId] };
  // Nothing moved — repaint what is lit rather than rebuilding the table.
  renderSelection(state);
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

  render(state, message);
  // After the render, so the hand the cards are flying INTO is the one on
  // screen. A catch costs cards exactly the way a Draw 2 does, and it is the
  // same flight for the same reason — the number in the banner is the whole
  // point of the rule, and a number is not a thing you watch happen.
  if (caught) animatePenaltyDraw(state, caught.target, caught.drew, 120);
  persistMatch();
  // An announcement can end a round — a challenge penalty that empties the
  // draw pile, a declaration that is the last thing before somebody goes out —
  // and the summary is `afterMove`'s job, which this path deliberately does not
  // re-enter (re-scheduling the turn would restart a bot's think time every
  // time anybody spoke). So the ONE thing it has to notice for itself is that.
  const roundOver = state.events.find((e) => e.type === 'roundOver' && !e.over);
  if (roundOver) {
    cancelAnnouncementBeats();
    const beatEpoch = epoch;
    Arcade.session.setTimeout(() => {
      if (beatEpoch !== epoch) return;
      session.roundSummaryOpen = true;
      showRoundSummary(state, roundOver, session.seating);
    }, 250);
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
  if (bots) bots.scheduleNextTurn(session, epoch);
}

/** Hold or release the table's own clock. The host's "wait for them" answer. */
export function setTablePaused(on) {
  paused = !!on;
  if (!paused) scheduleNextTurn();
}
function scheduleAnnouncementBeats() { if (bots) bots.scheduleAnnouncementBeats(session, epoch); }

/* ------------------------------------------------------------------ *
 * Match lifecycle
 * ------------------------------------------------------------------ */

/**
 * Take over the screen for `state`. THE ONLY PLACE A SESSION IS BORN.
 *
 * A fresh object rather than a field-by-field reset, which is what this used to
 * be — and the two bot-decision caches are exactly the ones the other half of
 * the ritual (closeTable) forgot, so a persona's "did they remember to declare?"
 * roll could survive into a match that had not been dealt when it was made.
 */
function adoptMatch(pack, state, message, { dealing = false, seats = null, seating = null } = {}) {
  epoch += 1;
  stopSession(session);
  if (drag) drag.cancel();
  session = createSession({
    pack,
    state,
    // WHO OWNS EACH SEAT, before who they are. Solo is one human on this device
    // and bots in the rest — which is the whole reason ownership is a table
    // rather than the number zero, because a HOSTED deal arrives with its
    // seats already decided in the party panel and passes them in.
    seats: seats || soloSeatTable(state.seats, { humanSeat: SOLO_HUMAN_SEAT }),
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
  });
  // Set on the NEW session, not before it exists: a fresh deal staggers its
  // cards in, a resumed match must not (the cards have been there all along).
  session.dealAnimation = dealing;
  // The parsed-SVG cache is keyed by markup the OLD renderer produced, so it is
  // dead weight from here on — and left alone it would accumulate one entry per
  // card per pack for as long as the tab is open.
  clearSvgCache();
  hideAllPanels();
  hideBanner();
  render(state, message);
  persistMatch();
  scheduleNextTurn();
  scheduleAnnouncementBeats();
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
export async function dealHostedTable({ packId, variants, seats, seating, message = '' }) {
  const myToken = ++openToken;
  cancelBotTurn();
  cancelAnnouncementBeats();
  closeChoiceDialog();

  const pack = await fetchPack(packId, variants);
  if (myToken !== openToken) return null;

  rememberPack(packId);
  Arcade.ui.setTitle(pack.manifest.name);
  hideAllPanels();

  const state = createState({ pack, seats: seats.count, seed: Date.now() });
  pack.template.setup(makeCtx(state));
  playDeal(seats.count);
  adoptMatch(pack, state, message || `Playing ${pack.manifest.name}.`, { dealing: true, seats, seating });
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
export async function resumeHostedTable({ packId, variants, state, seats, seating, message = '' }) {
  const myToken = ++openToken;
  cancelBotTurn();
  cancelAnnouncementBeats();
  closeChoiceDialog();

  const pack = await fetchPack(packId, variants);
  if (myToken !== openToken) return null;

  rememberPack(packId);
  Arcade.ui.setTitle(pack.manifest.name);
  hideAllPanels();

  adoptMatch(pack, state, message || `Back at ${pack.manifest.name}.`, { seats, seating });
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
export function adoptSharedView({ view, pack, seating, client, message = '' }) {
  sharedTable = client || sharedTable;
  const model = modelFromView(view, pack);

  const seats = createSeatTable({ seats: view.seats, localDeviceId: LOCAL_VIEWER });
  if (view.seat !== null && view.seat !== undefined) {
    seats.claim(view.seat, { deviceId: LOCAL_VIEWER });
  }

  if (!session || session.pack?.id !== pack.id) {
    epoch += 1;
    stopSession(session);
    if (drag) drag.cancel();
    session = createSession({
      pack, state: model, seats, seating, cardArt: makeCardRenderer(pack.manifest, pack.cardsById),
      handPrefs: loadHandPrefs(pack.id),
    });
    clearSvgCache();
    hideAllPanels();
    hideBanner();
  } else {
    // AN ORDINARY VIEW IS A REPLACEMENT, NOT A NEW MATCH (design decision D2).
    // Swapping the model in place is what lets a card animate from where it
    // was to where it is, instead of the table blinking on every move.
    session.state = model;
    session.seats = seats;
    session.seating = seating;
  }
  render(model, message);
}

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
  if (liveState()) render(liveState());
}

/**
 * Re-answer "which of these seats is me" against a real device id.
 *
 * A SOLO SEAT TABLE CALLS ITSELF `@local` (src/players/seats.js), which is
 * exactly right until the moment somebody else is at the table: the host
 * publishes seat ownership by deviceId, and a roster claiming that seat 0
 * belongs to "@local" names a device no joiner can address. So hosting rebases
 * the table onto the id the transport actually knows us by — the ownership is
 * unchanged, only the name we go by.
 */
export function rebaseSeats(localDeviceId) {
  if (!session || !localDeviceId) return null;
  const payload = session.seats.serialize();
  for (const owner of payload.owners) {
    if (owner.kind === 'device' && owner.deviceId === LOCAL_VIEWER) owner.deviceId = localDeviceId;
  }
  const rebased = deserializeSeatTable(payload, { localDeviceId });
  if (!rebased) return null;
  session.seats = rebased;
  return rebased;
}

function startGame(pack, seats) {
  cancelBotTurn();
  cancelAnnouncementBeats();
  const seatCount = seatsFor(pack, seats);
  // Date.now() is only the entropy source. The seed itself is persisted with
  // the match from the first write, which is what makes the log replayable
  // (src/engine/replay.js) rather than merely re-runnable — and, since the
  // seating is derived from it, what rotates the opponents per game.
  const state = createState({ pack, seats: seatCount, seed: Date.now() });
  pack.template.setup(makeCtx(state));
  playDeal(seatCount);
  adoptMatch(state.pack, state, `Playing ${pack.manifest.name}.`, { dealing: true });
}

/**
 * Open `packId`'s table: resume its saved match when there is one, deal a
 * fresh game when there is not.
 *
 * Every entry to the table goes through here — a lobby tap, a `?pack=` deep
 * link, and a save import (`onStateReplaced` is a fresh boot by contract, §3).
 */
export async function openTable(packId, { variants, seats } = {}) {
  const myToken = ++openToken;
  cancelBotTurn();
  cancelAnnouncementBeats();
  closeChoiceDialog();

  el.statusText.textContent = 'Dealing…';

  // A stored match pins the variant set: the same pack loaded with different
  // variants is a different rule set, and replaying a log against it diverges.
  // A stored match wins over anything the caller asked for: its log was
  // recorded under ITS rule set and seating, and replaying it under another is
  // divergence, not a preference.
  const stored = loadMatch(packId);
  const pack = await fetchPack(packId, stored ? stored.variants : variants);
  if (myToken !== openToken) return; // the player left before the pack landed

  rememberPack(packId);
  // The variant's name ALONE, and only in the launcher's title bar. At a table
  // the game you are playing is the only name that means anything, and saying
  // it twice — once in the launcher bar, once in our own — cost the status bar
  // the room it needed to stay on one line. The lobby restores the wordmark
  // (src/main.js).
  Arcade.ui.setTitle(pack.manifest.name);
  hideAllPanels();

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
        adoptMatch(pack, state, `Resumed ${pack.manifest.name}.`);
        return;
      }
    } catch (err) {
      // A pack whose rules moved under a stored log. Losing one match is the
      // right cost; resuming into a state the current rules could never have
      // produced is not.
      console.warn('[cardstock] could not replay the stored match, starting fresh', err);
      if (rulesMoved) reportTableError(`${pack.manifest.name}'s rules have changed — dealing a fresh game.`);
    }
    clearMatch(packId);
  }
  startGame(pack, seats);
}

/**
 * Leave the table. The match keeps its place in storage; nothing about it
 * keeps running.
 */
export function closeTable() {
  openToken += 1;          // abandon any open still in flight
  epoch += 1;              // and any bot turn already scheduled
  cancelBotTurn();
  cancelAnnouncementBeats();
  closeChoiceDialog();
  closeConfirm();
  hideInspector();
  if (drag) drag.cancel();
  flushTable();
  // ONE RESET POINT. Everything a match owned — its timers, its selection, its
  // bot decisions, its idea of which cards were already on the felt — goes with
  // the object. There is no longer a list here to fall out of date with the one
  // in adoptMatch.
  hideBanner();
  stopSession(session);
  session = null;
  hideAllPanels();
  if (ladder) ladder.hide();
}

export function isTableOpen() {
  return liveState() !== null;
}

/** Re-render in place — onResume, and after a settings change. */
export function rerenderTable() {
  settings = loadSettings();
  if (liveState()) render(liveState());
}

export function initTable({ onExit }) {
  exitToLobby = onExit;
  settings = loadSettings();

  // AN OPEN SEAT PLATE IS DISMISSIBLE, by the two gestures every other overlay
  // on this screen already answers to. Wired once here rather than per render,
  // because renderSeats rebuilds the row wholesale and would otherwise stack a
  // fresh pair of window listeners on every bot move.
  //
  // Capturing, and BEFORE the plate's own handlers rather than after: a tap
  // that lands inside the plate is a tap on a meld chip and must reach it.
  document.addEventListener('pointerdown', (event) => {
    if (!session || !openPlateSeat()) return;

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

    dismissPlate();
    if (liveState()) render(liveState());
  }, true);

  // The plate is anchored to a seat's rect, so anything that moves that rect
  // has to move the plate with it — the row scrolling under it most of all.
  el.opponentsTop.addEventListener('scroll', placeOpenPlate, { passive: true });
  window.addEventListener('resize', placeOpenPlate, { passive: true });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !session) return;
    const node = openPlateSeat();
    if (!node) return;
    const seat = node.dataset.seat;
    dismissPlate();
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
    onTarget: (move, node) => { if (liveState()) performHumanMove(liveState(), move, node); },
    onPickUp: (address, top) => {
      session.selection = isSelected(session.selection, address, top)
        ? null
        : { from: address, cardIds: [top] };
      renderSelection(liveState());
    },
    onMeld: (meldKey, node) => {
      const ready = session?.ui?.readyMelds.get(meldKey);
      if (ready && liveState()) performHumanMove(liveState(), ready, node);
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
  });

  ladder = createContractLadder({
    el: el.contractLadder,
    me,
    identityOf,
    attachInspector,
    isBusy: () => !!drag && drag.isDragging(),
  });

  moments = createCelebrations({
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
  bots = createBotDriver({
    clock: sessionClock(),
    currentEpoch: () => epoch,
    botDelayMs: () => settings.botDelayMs,
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
    onContinueRound: () => dismissRoundSummary(),
    onPlayAgain: () => livePack() && startGame(livePack(), liveState()?.seats),
    onLobby: () => exitToLobby(),
    onEndMatch: () => endMatchFromSummary(),
    onRules: () => livePack() && showRules(packRules(livePack())),
    onCloseScoreboard: () => {},
  });

  // The fan's spacing is the one thing that depends on how much room the row
  // has, and it is a custom property rather than a re-render — so reacting to
  // a width change costs two measurements, not a repaint of the table.
  watchHandWidth();
  watchSeatRowWidth();
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
  el.scoreChip.addEventListener('click', () => openScoreboard());
  el.handSort.addEventListener('click', () => cycleHandSort());
}

/** Surface a boot/open failure on the table's own log line. */
export function reportTableError(message) {
  el.log.textContent = message;
}
