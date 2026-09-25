// THE CHROME ABOVE THE FELT, DRIVEN (#223 seam 7).
//
// src/ui/statusBar.js came out of src/ui/table.js, which resolves its element
// ids at import and so could only ever be grepped. The bar's sentences, its two
// classes, the score chip, the card-speed chip, the table's own counters and
// the shared board are asked here of the real module, over stub elements
// (tests/fixtures/chrome.js) and real dealt states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../tools/stage.mjs';
import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { legalMovesFor } from '../src/engine/movePipeline.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';
import { commitPromptFor } from '../src/ui/interaction.js';
import { flightDurationMs } from '../src/ui/flight.js';
import { SPEED_LEVELS } from '../src/ui/speed.js';
import { currentDelayMs, currentFlightMs, currentSpeed } from '../src/ui/statusBar.js';
import { statusBarHarness } from './fixtures/chrome.js';

async function dealt(packId, seats) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed: `chrome:${packId}` });
  pack.template.setup(makeCtx(state));
  return state;
}

const setDelay = (h, botDelayMs) => h.store.set('settings', { ...(h.store.get('settings') || {}), botDelayMs });

/* ------------------------------------------------------------------ *
 * What the bar says
 * ------------------------------------------------------------------ */

test('the bar names whose turn it is, and nobody during a beat', async () => {
  const h = statusBarHarness();
  const state = await dealt('crazy-eights', 4); // seat 0 is on turn
  const say = (acting, s = state) => h.bar.statusTextFor(s, acting);

  assert.equal(say([0]), 'Your turn');
  assert.equal(say([1], { ...state, turn: { ...state.turn, seat: 1 } }), "Fig's turn");

  // THE ROUND BEAT IS NOBODY'S TURN, and it promises the tap exactly while a
  // count is waiting for one (#181) — three motionless counts read as a hang.
  h.session.roundBeat = true;
  h.session.beatResume = () => {};
  assert.equal(say([0]), 'Round over. Tap to go on.');
  h.session.beatResume = null;
  assert.equal(say([0]), 'Round over.');
  h.session.roundBeat = false;

  // THE TRICK BEAT names who is taking the cards, and promises the tap only
  // where the hold has no clock on it (#123, #176).
  h.session.trickBeat = { seat: 2, waits: true };
  assert.equal(say([0]), "Wren's trick. Tap to go on.");
  h.session.trickBeat = { seat: 0, waits: false };
  assert.equal(say([0]), 'Your trick.');
  h.session.trickBeat = null;

  // Reviewing outranks everything, the end of the match included.
  h.session.review = { at: 3 };
  assert.equal(say([0], { ...state, gameOver: true }), 'Reviewing');
  h.session.review = null;
  assert.equal(say([], { ...state, gameOver: true }), 'Game over — You win.');
});

test('a pass and a bid ask the template for their sentence, in the mode and not the phase name', async () => {
  const h = statusBarHarness();
  const hearts = await dealt('hearts', 4); // everybody passes at once
  const mine = commitPromptFor(hearts, 0, legalMovesFor(hearts, 0), {});
  assert.equal(h.bar.statusTextFor(hearts, [0, 1, 2, 3]), mine.staging,
    'the pass phase must say what the HUMAN is staging, from the template');
  assert.notEqual(mine.staging, 'Your turn');

  const spades = await dealt('team-spades', 4); // seat 1 bids first
  const theirs = commitPromptFor(spades, 1, legalMovesFor(spades, 1), {});
  assert.equal(h.bar.statusTextFor(spades, [1]), theirs.waiting,
    'a bid round the table says who is bidding, from the template');
  assert.notEqual(theirs.waiting, "Fig's turn");
});

/* ------------------------------------------------------------------ *
 * The bar as painted
 * ------------------------------------------------------------------ */

test('renderStatusBar paints the sentence and the two classes, and a beat is never your turn', async () => {
  const h = statusBarHarness();
  const state = await dealt('crazy-eights', 4);
  const { el } = h;

  h.bar.renderStatusBar(state, [0]);
  assert.equal(el.statusText.textContent, 'Your turn');
  assert.ok(el.status.classList.contains('status-bar--your-turn'));
  assert.ok(!el.status.classList.contains('status-bar--thinking'));

  for (const beat of [{ roundBeat: true }, { trickBeat: { seat: 1, waits: true } }, { review: { at: 1 } }]) {
    Object.assign(h.session, beat);
    h.bar.renderStatusBar(state, [0]);
    assert.ok(!el.status.classList.contains('status-bar--your-turn'),
      `${Object.keys(beat)[0]}: a held felt must not light the bar as the player's turn`);
    assert.ok(el.status.classList.contains('status-bar--thinking'));
    Object.assign(h.session, { roundBeat: false, trickBeat: null, review: null });
  }

  h.bar.renderStatusBar({ ...state, gameOver: true }, []);
  assert.ok(!el.status.classList.contains('status-bar--thinking'), 'a finished match is not thinking');
});

test('the score chip is one reading in two renderings, and gives way to the shared board', async () => {
  const h = statusBarHarness();
  const { el } = h;

  // A points race: the plain pill, and the same number in its name.
  const hearts = await dealt('hearts', 4);
  h.bar.renderStatusBar(hearts, [0, 1, 2, 3]);
  assert.equal(el.scoreChip.hidden, false);
  assert.equal(el.scoreChipValue.hidden, false);
  assert.equal(el.scoreChipTrack.children.length, 0);
  assert.equal(el.scoreChip.getAttribute('aria-label'),
    `Your score: ${el.scoreChipValue.textContent}. Open the scoreboard.`);

  // A road: the player's own peg, and the pill's number gives way to it.
  const crib = await dealt('cribbage', 2);
  h.bar.renderStatusBar(crib, [0, 1]);
  assert.equal(el.scoreChipTrack.children.length, 1, 'your own peg belongs in the chip (#124)');
  assert.equal(el.scoreChipValue.hidden, true, 'the track prints the number; two is one too many');
  assert.match(el.scoreChip.getAttribute('aria-label'),
    new RegExp(`^Your score: ${el.scoreChipTrack.children[0].getAttribute('aria-label')}\\. `));

  // ...unless the felt already draws the shared board (#136).
  h.session.board = { lanes: [] };
  h.bar.renderStatusBar(crib, [0, 1]);
  assert.equal(el.scoreChipTrack.children.length, 0);
  assert.equal(el.scoreChipValue.hidden, false);
});

test("the table's own counters are the template's, and a pack with none gets no strip", () => {
  const h = statusBarHarness();
  const { el } = h;
  const counting = { pack: { template: { tableCounters: () => [{ label: 'Count', text: '17' }] } } };
  h.bar.renderTableCounters(counting);
  assert.equal(el.tableCounters.hidden, false);
  assert.equal(el.tableCounters.children.length, 1);
  const chip = el.tableCounters.children[0];
  assert.equal(chip.getAttribute('role'), 'img');
  assert.equal(chip.getAttribute('aria-label'), 'Count 17', 'one name for the pair');
  assert.equal(chip.text(), 'Count 17');

  h.bar.renderTableCounters({ pack: { template: {} } });
  assert.equal(el.tableCounters.hidden, true);
  assert.equal(el.tableCounters.children.length, 0, 'the last strip must not outlive its pack');
});

test('the shared board is one lane per side, yours last, and repainted rather than rebuilt', async () => {
  const h = statusBarHarness();
  const { el } = h;
  const crib = await dealt('cribbage', 2);

  const model = h.bar.sharedBoardFor(crib);
  assert.deepEqual(model.lanes.map((l) => [l.seat, l.mine]), [[1, false], [0, true]],
    'ring order from your left, with your own lane nearest your hand');

  h.bar.renderSharedBoardRow(crib);
  assert.ok(h.session.board, 'the model is what the plate and the chip read to stand down');
  assert.equal(el.tableBoard.hidden, false);
  assert.ok(el.feltMiddle.classList.contains('felt-middle--boarded'));
  const node = el.tableBoard.children[0];
  h.bar.renderSharedBoardRow(crib);
  assert.equal(el.tableBoard.children[0], node, 'THE PEGS ONLY MOVE IF THE NODES SURVIVE');

  const hearts = await dealt('hearts', 4);
  h.bar.renderSharedBoardRow(hearts);
  assert.equal(h.session.board, null);
  assert.equal(h.session.boardHandle, null);
  assert.equal(el.tableBoard.hidden, true);
  assert.equal(el.tableBoard.children.length, 0);
  assert.ok(!el.feltMiddle.classList.contains('felt-middle--boarded'));
});

/* ------------------------------------------------------------------ *
 * Card speed (#175)
 * ------------------------------------------------------------------ */

test('the speed readers ask storage every time, and flights take the raw number', () => {
  const h = statusBarHarness();
  setDelay(h, 1100);
  assert.equal(currentDelayMs(), 1100);
  assert.equal(currentSpeed().id, 'slow');
  setDelay(h, 350);
  assert.equal(currentDelayMs(), 350, 'a rung written after the first read must be the next answer');
  // THE STORED NUMBER, NOT THE TREAD IT LIGHTS: 700 lights Brisk and flies at 700.
  setDelay(h, 700);
  assert.equal(currentSpeed().id, 'brisk');
  assert.equal(currentFlightMs(), flightDurationMs(700));
  assert.notEqual(currentFlightMs(), flightDurationMs(600));
});

test('the chip cycles every rung, persists it, announces it, and the very next flight uses it', () => {
  const h = statusBarHarness();
  h.store.set('settings', { botDelayMs: 600, botDifficulty: 'hard', pace: 'quick' });
  h.bar.paintSpeedChip();
  assert.equal(h.el.speedChipLabel.textContent, 'Brisk');

  const seen = [];
  for (let i = 0; i < SPEED_LEVELS.length; i++) {
    h.bar.cycleSpeed();
    const stored = h.store.get('settings');
    const level = SPEED_LEVELS.find((l) => l.delayMs === stored.botDelayMs);
    assert.ok(level, `cycling stored ${stored.botDelayMs}, which is not a rung`);
    seen.push(level.id);
    assert.equal(stored.botDifficulty, 'hard', 'cycling must not touch the other settings');
    assert.equal(stored.pace, 'quick');
    assert.equal(h.el.speedChipLabel.textContent, level.label, 'the chip repaints on the tap');
    assert.equal(h.el.speedChip.getAttribute('aria-label'),
      `Card speed: ${level.label}. ${level.description} Tap to change.`);
    assert.equal(h.el.log.textContent, `Card speed: ${level.label}. ${level.description}`,
      '#log is the live region — a chip word changing is nothing to a screen reader');
    assert.equal(currentFlightMs(), flightDurationMs(level.delayMs),
      'the next card must fly at the rung just tapped, with nothing to refresh');
  }
  assert.equal(new Set(seen).size, SPEED_LEVELS.length, 'every rung, once');
  assert.equal(seen.at(-1), 'brisk', 'and back round to where it started');
});

test('renderStatusBar repaints the chip, so the new-game sheet cannot leave it stale', async () => {
  const h = statusBarHarness();
  const state = await dealt('crazy-eights', 4);
  setDelay(h, 1100);
  h.bar.renderStatusBar(state, [0]);
  assert.equal(h.el.speedChipLabel.textContent, 'Slow');
  setDelay(h, 350);
  h.bar.renderStatusBar(state, [0]);
  assert.equal(h.el.speedChipLabel.textContent, 'Snappy');
});

/* ------------------------------------------------------------------ *
 * The wiring, which only table.js can do
 * ------------------------------------------------------------------ */

test('table.js builds the bar first, repaints it from render, and wires the chip', () => {
  const table = fs.readFileSync(path.join(ROOT, 'src/ui/table.js'), 'utf8');
  const init = table.slice(table.indexOf('export function initTable('));
  assert.ok(init.indexOf('statusBar = createStatusBar(') < init.indexOf('createRoundEnding('),
    'the round ending is handed renderStatusBar by reference, so the bar must exist first');
  assert.match(table, /renderStatusBar: statusBar\.renderStatusBar,/);
  assert.match(table, /statusBar\.renderSharedBoardRow\(state\);\n\s*statusBar\.renderStatusBar\(state, acting\);/,
    'render draws the board FIRST: the chip reads session.board to stand down');
  assert.match(table, /el\.speedChip\.addEventListener\('click', \(\) => statusBar\.cycleSpeed\(\)\)/,
    'the chip must be wired, or it is a pill that does nothing');
  assert.match(init, /statusBar\.paintSpeedChip\(\);/, 'the chip needs its word before the first render');
  // No second copy left behind in the felt.
  for (const name of ['renderStatusBar', 'statusTextFor', 'cycleSpeed', 'paintSpeedChip',
    'renderTableCounters', 'sharedBoardFor', 'renderSharedBoardRow', 'currentDelayMs', 'currentFlightMs']) {
    assert.doesNotMatch(table, new RegExp(`\\nfunction ${name}\\(`), `table.js grew its own ${name} again`);
  }
});
