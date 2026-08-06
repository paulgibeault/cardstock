// The overlays that sit on top of the table: the round score sheet, the
// scoreboard, and the game-over panel with the match's stats.
//
// Split out of src/ui/table.js in the UX pass. They belong together and apart
// from the felt for one reason: every one of them is a READ-ONLY view of
// things the engine already knows — a score array, a log replayed into
// counters (src/stats/matchStats.js), a stored record — and none of them can
// affect a move. Keeping them here means the table module stays about playing
// and this one stays about reporting.
//
// EVERY NAME COMES FROM THE SEATING (src/players/roster.js) and is rendered
// with textContent. There is no string interpolation of a player name into
// markup anywhere in this file, which is the rule §17.8 exists for.

import { statLinesFor } from '../stats/matchStats.js';

const el = {
  roundOverlay: document.getElementById('round-overlay'),
  roundTitle: document.getElementById('round-title'),
  roundScores: document.getElementById('round-scores'),
  roundContinue: document.getElementById('round-continue'),
  roundTarget: document.getElementById('round-target'),
  roundEndMatch: document.getElementById('round-end-match'),

  scoreOverlay: document.getElementById('scoreboard-overlay'),
  scoreTotals: document.getElementById('scoreboard-totals'),
  scoreHistory: document.getElementById('scoreboard-history'),
  scoreClose: document.getElementById('scoreboard-close'),
  scoreRules: document.getElementById('scoreboard-rules'),

  rulesOverlay: document.getElementById('rules-overlay'),
  rulesTitle: document.getElementById('rules-title'),
  rulesTagline: document.getElementById('rules-tagline'),
  rulesBody: document.getElementById('rules-body'),
  rulesClose: document.getElementById('rules-close'),

  finalLook: document.getElementById('final-look'),
  finalLookResult: document.getElementById('final-look-result'),
  finalLookPlay: document.getElementById('final-look-play'),
  finalLookContinue: document.getElementById('final-look-continue'),

  gameOverOverlay: document.getElementById('game-over-overlay'),
  gameOverFan: document.getElementById('game-over-fan'),
  gameOverMessage: document.getElementById('game-over-message'),
  gameOverRecord: document.getElementById('game-over-record'),
  gameOverStats: document.getElementById('game-over-stats'),
  gameOverRounds: document.getElementById('game-over-rounds'),
  gameOverRoundsToggle: document.getElementById('game-over-rounds-toggle'),
  playAgainButton: document.getElementById('play-again-button'),
  gameOverLobbyButton: document.getElementById('game-over-lobby-button'),
};

function line(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/** A seat's name with its icon in front, as two text nodes — never markup. */
function nameCell(className, identity) {
  const wrap = document.createElement('span');
  wrap.className = className;
  if (identity?.icon) {
    const icon = document.createElement('span');
    icon.className = 'seat-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = identity.icon;
    wrap.appendChild(icon);
  }
  const name = document.createElement('span');
  name.textContent = identity?.name || `Seat ${identity?.seat ?? '?'}`;
  wrap.appendChild(name);
  return wrap;
}

function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

/* ------------------------------------------------------------------ *
 * Round summary
 * ------------------------------------------------------------------ */

/** The score sheet between rounds. Bot turns stay parked until it is dismissed. */
export function showRoundSummary(state, ev, seating) {
  el.roundTitle.textContent = `Round ${ev.round} over`;
  el.roundScores.replaceChildren();
  for (let s = 0; s < state.seats; s++) {
    const delta = ev.scores[s] ?? 0;
    const row = document.createElement('div');
    row.className = `round-scores__row ${seating[s] && !seating[s].isBot ? 'round-scores__row--you' : ''}`;
    row.appendChild(nameCell('round-scores__name', seating[s]));
    row.appendChild(line('round-scores__delta', signed(delta)));
    row.appendChild(line('round-scores__total', `${ev.totals[s]}`));
    el.roundScores.appendChild(row);
  }
  el.roundContinue.textContent = `Deal round ${state.roundNumber}`;
  el.roundTarget.textContent = targetSentence(state, ev);
  el.roundTarget.hidden = !el.roundTarget.textContent;
  el.roundOverlay.hidden = false;
}

/**
 * How much further this match has to run.
 *
 * "The match continues indefinitely" was the complaint, and it was a complaint
 * about not being able to SEE the end rather than about there not being one:
 * Wildfire runs to 500 and nothing on the felt ever said so, so every round
 * summary looked like it could be the first of arbitrarily many. Read from the
 * pack's own declared threshold, so a pack that ends some other way (Milestones
 * on its tenth contract) simply says nothing here.
 */
function targetSentence(state, ev) {
  const when = state.pack.scoring?.gameOver?.when;
  const m = /^anyScore\s*>=\s*(\d+)$/.exec(when || '');
  if (!m) return '';
  const target = Number(m[1]);
  const leader = Math.max(...ev.totals);
  const togo = target - leader;
  if (togo <= 0) return '';
  return `First to ${target} wins — ${togo} to go.`;
}

export function hideRoundSummary() {
  el.roundOverlay.hidden = true;
}

export function isRoundSummaryOpen() {
  return !el.roundOverlay.hidden;
}

/* ------------------------------------------------------------------ *
 * Scoreboard — the same sheet, every round of it
 * ------------------------------------------------------------------ */

function roundHistoryInto(node, rounds, seating, seats) {
  node.replaceChildren();
  if (!rounds.length) {
    node.appendChild(line('round-history__empty', 'No rounds have been scored yet.'));
    return;
  }
  const table = document.createElement('div');
  table.className = 'round-history__grid';
  table.style.setProperty('--history-cols', String(seats));

  table.appendChild(line('round-history__head', ''));
  for (let s = 0; s < seats; s++) {
    table.appendChild(nameCell('round-history__head', seating[s]));
  }
  for (const round of rounds) {
    table.appendChild(line('round-history__label', `R${round.round}`));
    for (let s = 0; s < seats; s++) {
      table.appendChild(line('round-history__cell', signed(round.scores[s] ?? 0)));
    }
  }
  table.appendChild(line('round-history__label round-history__label--total', 'Total'));
  const last = rounds[rounds.length - 1];
  for (let s = 0; s < seats; s++) {
    table.appendChild(line('round-history__cell round-history__cell--total', `${last.totals[s]}`));
  }
  node.appendChild(table);
}

/**
 * Open the scoreboard.
 *
 * `stats` is a computeMatchStats() result, or null when the log could not be
 * replayed — in which case the totals still show, because those come straight
 * off the live state and are never in doubt.
 */
export function showScoreboard(state, seating, stats) {
  el.scoreTotals.replaceChildren();
  for (let s = 0; s < state.seats; s++) {
    const row = document.createElement('div');
    row.className = `round-scores__row ${seating[s] && !seating[s].isBot ? 'round-scores__row--you' : ''}`;
    row.appendChild(nameCell('round-scores__name', seating[s]));
    row.appendChild(line('round-scores__delta', seating[s]?.isBot ? (seating[s].persona?.label || '') : ''));
    row.appendChild(line('round-scores__total', `${state.scores[s]}`));
    el.scoreTotals.appendChild(row);
  }
  roundHistoryInto(el.scoreHistory, stats ? stats.rounds : [], seating, state.seats);
  el.scoreOverlay.hidden = false;
}

export function hideScoreboard() {
  el.scoreOverlay.hidden = true;
}

/* ------------------------------------------------------------------ *
 * The last card, before the results
 * ------------------------------------------------------------------ */

let dismissFinalLook = null;

/**
 * Hold the results back until the player has actually looked at the ending.
 *
 * THIS IS A PAUSE, NOT A PANEL, and the difference is the whole design. A match
 * ends on a card — somebody's last one — and showGameOver used to open on the
 * same frame that card was still flying to the discard, so the one moment the
 * whole game had been building to was covered by a score sheet before anybody
 * saw who played what. The complaint was exactly that: more time to see the
 * final card and who played it.
 *
 * So there is no scrim and nothing over the felt. The bar is pinned low, the
 * table underneath stays live — a card can still be held and inspected — and
 * the only thing that opens the results is the player asking for them. Nothing
 * times out: "I want longer to look" is not a thing to answer with a timer.
 *
 * @param result the sentence that says who won
 * @param play   what the last card was and who played it, or '' when the ending
 *               was not a play (a match that ran out of rounds)
 * @returns a promise that resolves true when acknowledged, false when the table
 *          closed under it — so a caller can decline to open a panel over a
 *          match that is no longer on screen.
 */
export function awaitFinalLook(result, play) {
  el.finalLookResult.textContent = result;
  el.finalLookPlay.textContent = play || '';
  el.finalLookPlay.hidden = !play;
  el.finalLook.hidden = false;
  return new Promise((resolve) => {
    const close = (acknowledged) => {
      dismissFinalLook = null;
      el.finalLookContinue.onclick = null;
      el.finalLook.hidden = true;
      resolve(acknowledged);
    };
    dismissFinalLook = () => close(false);
    el.finalLookContinue.onclick = () => close(true);
    // preventScroll for the same reason the rules panel uses it: the bar is
    // fixed, but focusing into it still scrolls the felt behind it — and the
    // felt is the thing this exists to let people look at.
    el.finalLookContinue.focus({ preventScroll: true });
  });
}

/** Take the bar down without answering it — a screen change under it. */
export function hideFinalLook() {
  if (dismissFinalLook) dismissFinalLook();
  el.finalLook.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Game over
 * ------------------------------------------------------------------ */

function statsInto(node, templateId, stats, seating, seats, winner) {
  node.replaceChildren();
  if (!stats) return;

  for (let s = 0; s < seats; s++) {
    const lines = statLinesFor(templateId, stats.perSeat[s]);
    if (!lines.length) continue;
    const card = document.createElement('div');
    card.className = `stat-card ${s === winner ? 'stat-card--winner' : ''}`;
    card.appendChild(nameCell('stat-card__name', seating[s]));
    const grid = document.createElement('div');
    grid.className = 'stat-card__lines';
    for (const l of lines) {
      grid.appendChild(line('stat-card__label', l.label));
      grid.appendChild(line('stat-card__value', l.value));
    }
    card.appendChild(grid);
    node.appendChild(card);
  }
}

/**
 * The end of a match: who won, what the record now is, and what happened.
 *
 * @param recordText  the pack record + head-to-head sentence, already built by
 *                    the caller (it owns the storage read)
 * @param stats       a computeMatchStats() result, or null
 * @param heroFaces   display-only faces from the manifest
 * @param renderFace  card markup for one face — the open table's own renderer
 */
export function showGameOver(state, {
  seating, stats, recordText, heroFaces = [], renderFace,
}) {
  el.gameOverFan.replaceChildren();
  for (const face of heroFaces) {
    const span = document.createElement('span');
    span.className = 'game-over-fan__card';
    // Card SVG is markup this repo authors, with every card-derived value
    // escaped inside src/ui/cardStyles — unlike anything carrying a name.
    span.innerHTML = renderFace(face);
    el.gameOverFan.appendChild(span);
  }

  // This panel is only ever the ENGINE's ending — a game the player abandons
  // never reaches a table, it is dropped from the lobby (src/ui/lobby.js).
  const winner = state.winner;
  const won = seating[winner] && !seating[winner].isBot;
  el.gameOverMessage.replaceChildren();
  if (won) {
    el.gameOverMessage.textContent = 'You win! \u{1F389}';
  } else {
    el.gameOverMessage.appendChild(nameCell('', seating[winner]));
    el.gameOverMessage.appendChild(document.createTextNode(' wins.'));
  }

  el.gameOverRecord.textContent = recordText || '';
  statsInto(el.gameOverStats, state.pack.template.id, stats, seating, state.seats, winner);

  const rounds = stats ? stats.rounds : [];
  el.gameOverRoundsToggle.hidden = rounds.length === 0;
  el.gameOverRounds.hidden = true;
  el.gameOverRoundsToggle.setAttribute('aria-expanded', 'false');
  roundHistoryInto(el.gameOverRounds, rounds, seating, state.seats);

  el.gameOverOverlay.classList.toggle('game-over--won', won);
  el.gameOverOverlay.hidden = false;
}

export function hideGameOver() {
  el.gameOverOverlay.hidden = true;
}

export function hideAllPanels() {
  hideGameOver();
  hideFinalLook();
  hideRoundSummary();
  hideScoreboard();
  hideRules();
}

/* ------------------------------------------------------------------ *
 * How to play
 * ------------------------------------------------------------------ */

/**
 * Show the rules for a pack. Takes the generated data (src/ui/rules.js), not
 * the pack — the panel's job is to put text on screen, and keeping the
 * derivation out of it is what lets the lobby show a pack's rules without a
 * match existing.
 */
export function showRules(rules) {
  el.rulesTitle.textContent = rules.title;
  el.rulesTagline.textContent = rules.tagline;
  el.rulesTagline.hidden = !rules.tagline;
  el.rulesBody.replaceChildren();
  for (const section of rules.sections) {
    const heading = document.createElement('h3');
    heading.className = 'rules__heading';
    heading.textContent = section.heading;
    el.rulesBody.appendChild(heading);
    const ul = document.createElement('ul');
    ul.className = 'rules__list';
    for (const text of section.lines) {
      const li = document.createElement('li');
      // textContent throughout: a pack's prose is pack-supplied data, and this
      // panel is the one place a whole paragraph of it reaches the screen.
      li.textContent = text;
      ul.appendChild(li);
    }
    el.rulesBody.appendChild(ul);
  }
  el.rulesOverlay.hidden = false;
  // preventScroll: the overlay is fixed, but focusing into it still scrolls
  // the LOBBY behind it, so closing the panel left the player somewhere they
  // never navigated to.
  el.rulesClose.focus({ preventScroll: true });
}

export function hideRules() {
  el.rulesOverlay.hidden = true;
}

/**
 * Wire the panels' buttons once. Every callback belongs to the table, which
 * owns the match — these overlays only ask.
 */
export function initPanels({ onContinueRound, onPlayAgain, onLobby, onCloseScoreboard, onEndMatch, onRules }) {
  el.rulesClose.addEventListener('click', () => hideRules());
  el.scoreRules.addEventListener('click', () => onRules?.());
  el.roundContinue.addEventListener('click', () => onContinueRound());
  el.roundEndMatch.addEventListener('click', () => onEndMatch());
  el.playAgainButton.addEventListener('click', () => onPlayAgain());
  el.gameOverLobbyButton.addEventListener('click', () => onLobby());
  el.scoreClose.addEventListener('click', () => {
    hideScoreboard();
    onCloseScoreboard?.();
  });
  el.gameOverRoundsToggle.addEventListener('click', () => {
    const open = el.gameOverRounds.hidden;
    el.gameOverRounds.hidden = !open;
    el.gameOverRoundsToggle.setAttribute('aria-expanded', String(open));
    el.gameOverRoundsToggle.textContent = open ? 'Hide the rounds' : 'Round by round';
  });
}
