// THE HELP MARK, ITS SHEET AND THE HINT BEHIND IT, DRIVEN (#155, #223 seam 7).
//
// src/ui/helpSheet.js came out of src/ui/table.js, where the order the Hint
// line ran in and the five reasons it could be refused were a regex over the
// source (tests/handRail.test.js kept the markup and CSS half). Asked here of
// the real module over stub elements (tests/fixtures/chrome.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../tools/stage.mjs';
import { createState } from '../src/engine/state.js';
import { makeCtx } from '../src/engine/context.js';
import { loadPackFromDisk } from '../tools/pack-test.mjs';
import { packRules } from '../src/ui/rules.js';
import { HINT_OFFER } from '../src/ui/helpSheet.js';
import { helpSheetHarness, stubNode } from './fixtures/chrome.js';

async function dealt(packId, seats) {
  const pack = await loadPackFromDisk(packId);
  const state = createState({ pack, seats, seed: `chrome:${packId}` });
  pack.template.setup(makeCtx(state));
  return state;
}

/* ------------------------------------------------------------------ *
 * The sheet
 * ------------------------------------------------------------------ */

test('the sheet opens onto its first line and hands focus back only if it had it', () => {
  const h = helpSheetHarness();
  const { el, sheet, doc } = h;
  assert.equal(sheet.helpOpen(), false);

  sheet.setHelpOpen(true);
  assert.equal(el.helpSheet.hidden, false);
  assert.equal(el.helpButton.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.activeElement, el.helpRules, 'opening moves focus to the first line');

  sheet.setHelpOpen(false);
  assert.equal(el.helpSheet.hidden, true);
  assert.equal(el.helpButton.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, el.helpButton, 'closing from inside returns focus to the mark');

  // A close that fires because the player tapped a card must not steal focus.
  sheet.setHelpOpen(true);
  const card = stubNode('div', 'card');
  card.focus();
  sheet.setHelpOpen(false);
  assert.equal(doc.activeElement, card);

  // Asking for the state it is already in does nothing — no focus move.
  el.helpButton.setAttribute('aria-expanded', 'untouched');
  sheet.setHelpOpen(false);
  assert.equal(el.helpButton.getAttribute('aria-expanded'), 'untouched');
});

test('the mark toggles it, and a tap anywhere else closes it without swallowing the tap', () => {
  const h = helpSheetHarness();
  const { el, sheet, doc } = h;
  sheet.wire();
  assert.equal(doc.listenerCount('pointerdown'), 1, 'one capturing listener, wired once');

  el.helpButton.fire('click');
  assert.equal(sheet.helpOpen(), true);
  // The mark's own pointerdown must not close what its click is about to toggle.
  doc.fire('pointerdown', { target: el.helpButton });
  assert.equal(sheet.helpOpen(), true);
  doc.fire('pointerdown', { target: el.helpHintNote });
  assert.equal(sheet.helpOpen(), true, 'a tap inside the sheet is a tap on a line');
  doc.fire('pointerdown', { target: stubNode('div', 'felt') });
  assert.equal(sheet.helpOpen(), false, 'a tap on the felt closes it');

  el.helpButton.fire('click');
  el.helpButton.fire('click');
  assert.equal(sheet.helpOpen(), false, 'the mark closes what it opened');
});

test('How to play opens the rules panel, and closes the sheet behind it', async () => {
  const h = helpSheetHarness();
  h.sheet.wire();
  h.pack = await loadPackFromDisk('hearts');
  h.sheet.setHelpOpen(true);
  h.el.helpRules.fire('click');
  assert.equal(h.sheet.helpOpen(), false);
  assert.deepEqual(h.calls, [['showRules', packRules(h.pack)]],
    'the same panel the scoreboard opens, with this pack\'s rules');

  h.calls.length = 0;
  h.pack = null;
  h.sheet.setHelpOpen(true);
  h.el.helpRules.fire('click');
  assert.equal(h.sheet.helpOpen(), false);
  assert.deepEqual(h.calls, [], 'with no pack on the felt there is nothing to open');
});

test('Hint closes the sheet FIRST, then rings the cards, then saves the count', async () => {
  const h = helpSheetHarness({
    renderSelection: (state) => h.calls.push(['renderSelection', state, h.el.helpSheet.hidden]),
  });
  h.sheet.wire();
  h.state = await dealt('crazy-eights', 4);
  h.store.set('settings', { botDifficulty: 'hard' });
  h.sheet.setHelpOpen(true);
  h.el.helpHint.fire('click');

  assert.equal(h.sheet.helpOpen(), false);
  assert.deepEqual(h.calls.map((c) => c[0]), ['renderSelection', 'persistMatch'],
    'the ring first, and the count saved after it — a resume brings it back');
  assert.equal(h.calls[0][1], h.state);
  assert.equal(h.calls[0][2], true,
    'THE ORDER IS THE POINT: a sheet left standing over the ring hides the answer');
  assert.ok(h.session.hint, 'the suggestion is what the felt rings');
  assert.equal(h.session.table.hintsTaken, 1);
  assert.match(h.el.log.textContent, /^Sharp would /,
    'THE SAME DIAL THE OPPONENTS ARE ON, read fresh from storage — and #log is the only wording');
  const [card] = h.session.hint.cardIds;
  assert.equal(h.sheet.hintedCard(card), true);
  assert.equal(h.sheet.hintedCard('no-such-card'), false);
});

test('a hint is never taken where the felt does not hold the position or the turn', async () => {
  const state = await dealt('crazy-eights', 4); // seat 0 on turn
  const cases = {
    'no match': null,
    'a joiner\'s view': { ...state, isView: true },
    'a finished match': { ...state, gameOver: true },
    'somebody else\'s turn': { ...state, turn: { ...state.turn, seat: 1 } },
  };
  for (const [why, live] of Object.entries(cases)) {
    const h = helpSheetHarness();
    h.state = live;
    h.sheet.showHint();
    assert.equal(h.session.hint, null, `${why}: no hint`);
    assert.equal(h.session.table.hintsTaken, 0, `${why}: nothing counted`);
    assert.deepEqual(h.calls, [], `${why}: nothing rendered or saved`);
  }
});

/* ------------------------------------------------------------------ *
 * The Hint line: offered, or saying why not
 * ------------------------------------------------------------------ */

test('the hint line is offered or explained, never simply missing', async () => {
  const h = helpSheetHarness();
  const state = await dealt('crazy-eights', 4);
  const offer = (s, humanActs, suggestion = null) => h.sheet.hintOffer(s, humanActs, suggestion);

  assert.deepEqual(offer(null, true), { ready: false, why: HINT_OFFER.view });
  assert.deepEqual(offer({ ...state, isView: true }, true), { ready: false, why: HINT_OFFER.view });
  assert.deepEqual(offer({ ...state, gameOver: true }, true), { ready: false, why: HINT_OFFER.over });
  assert.deepEqual(offer(state, false), { ready: false, why: HINT_OFFER.turn });
  assert.deepEqual(offer(state, true, { text: 'x' }), { ready: false, why: HINT_OFFER.showing },
    'once its answer is showing it steps aside — the same question is not counted twice');
  h.moves = 1;
  assert.deepEqual(offer(state, true), { ready: false, why: HINT_OFFER.forced }, 'one legal move is not a hint');
  h.moves = 2;
  assert.deepEqual(offer(state, true), { ready: true, why: HINT_OFFER.ready });
  assert.equal(new Set(Object.values(HINT_OFFER)).size, 6, 'every branch has its own sentence');

  // Disabled rather than hidden, with the reason in the button's name.
  h.sheet.renderHelpOffer(state, false, null);
  assert.equal(h.el.helpHint.disabled, true);
  assert.equal(h.el.helpHintNote.textContent, HINT_OFFER.turn);
  h.sheet.renderHelpOffer(state, true, null);
  assert.equal(h.el.helpHint.disabled, false);
  assert.equal(h.el.helpHintNote.textContent, HINT_OFFER.ready);
});

/* ------------------------------------------------------------------ *
 * The wiring, which only table.js can do
 * ------------------------------------------------------------------ */

test('table.js builds the sheet before the seams it hands it to, and wires it once', () => {
  const table = fs.readFileSync(path.join(ROOT, 'src/ui/table.js'), 'utf8');
  const init = table.slice(table.indexOf('export function initTable('));
  assert.ok(init.indexOf('helpSheet = createHelpSheet(') < init.indexOf('createHandFan('),
    'the hand is handed hintedCard by reference');
  assert.ok(init.indexOf('helpSheet = createHelpSheet(') < init.indexOf('createMatchDoors('),
    'the doors are handed setHelpOpen by reference');
  assert.match(table, /hintedCard: helpSheet\.hintedCard,/);
  assert.match(table, /setHelpOpen: helpSheet\.setHelpOpen,/);
  assert.equal((init.match(/helpSheet\.wire\(\);/g) || []).length, 1, 'the listeners go on once');
  // Escape: the sheet is the innermost thing open, so it closes first.
  assert.match(init, /if \(event\.key !== 'Escape'\) return;[\s\S]{0,160}if \(helpSheet\.helpOpen\(\)\) \{\s*helpSheet\.setHelpOpen\(false\);\s*return;/);
  for (const name of ['showHint', 'hintOffer', 'renderHelpOffer', 'setHelpOpen', 'helpOpen', 'hintedCard']) {
    assert.doesNotMatch(table, new RegExp(`\\nfunction ${name}\\(`), `table.js grew its own ${name} again`);
  }
});
