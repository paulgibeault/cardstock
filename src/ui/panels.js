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
  hideRoundSummary();
  hideScoreboard();
}

/**
 * Wire the panels' buttons once. Every callback belongs to the table, which
 * owns the match — these overlays only ask.
 */
export function initPanels({ onContinueRound, onPlayAgain, onLobby, onCloseScoreboard, onEndMatch }) {
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
