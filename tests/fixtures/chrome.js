// THE FELT'S CHROME, STOOD UP WITHOUT A BROWSER: the status bar and the help
// sheet (#223 seam 7), each built from its factory over stub elements.
//
// Both modules take their elements as parameters, so all a test needs is an
// element small enough to read: text, `hidden`, `disabled`, a class list,
// attributes, children, listeners and focus. `document` is installed on
// globalThis only for the three things the moved bodies still reach for at
// call time — `createElement` (the table's counters, the shared board, the
// score chip's track), `activeElement` (where the sheet hands focus back) and
// the capturing `pointerdown` that closes the sheet.

import { installArcade } from './arcade.js';
import { createStatusBar } from '../../src/ui/statusBar.js';
import { createHelpSheet } from '../../src/ui/helpSheet.js';

/** An element: enough of one for the chrome's bodies and nothing more. */
export function stubNode(tag = 'div', id = '') {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  const node = {
    tag,
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    dataset: {},
    children: [],
    parentNode: null,
    style: { setProperty(name, value) { this[name] = String(value); } },
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      for (const c of String(value).split(/\s+/)) if (c) classes.add(c);
    },
    classList: {
      add: (...names) => names.forEach((c) => classes.add(c)),
      remove: (...names) => names.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle(c, force) {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    append(...kids) { for (const k of kids) node.appendChild(k); },
    replaceChildren(...kids) { node.children = []; node.append(...kids); },
    contains(other) {
      for (let n = other; n; n = n.parentNode) if (n === node) return true;
      return false;
    },
    focus() { globalThis.document.activeElement = node; },
    addEventListener(type, fn, capture) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, capture: !!capture });
    },
    /** Fire every listener of `type` on this node, with `target` defaulting to it. */
    fire(type, event = {}) {
      for (const { fn } of listeners.get(type) || []) fn({ target: node, ...event });
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    /** Every text under this node, depth first — what a screen reader walks. */
    text() { return [node.textContent, ...node.children.map((c) => c.text())].join(' ').trim(); },
  };
  return node;
}

/** `globalThis.document`, as much of it as the chrome touches at call time. */
export function installDocument() {
  const doc = stubNode('#document');
  doc.activeElement = null;
  doc.createElement = (tag) => stubNode(tag);
  globalThis.document = doc;
  return doc;
}

const NAMES = ['You', 'Fig', 'Wren', 'Bruno'];

/** The table's own seat answers, for a solo table where this device is seat 0. */
export function seatAnswers() {
  return {
    isMySeat: (seat) => seat === 0,
    mySeat: () => 0,
    identityOf: (seat) => ({ seat, name: NAMES[seat] || `Seat ${seat}`, initials: NAMES[seat]?.[0] || '?', icon: '', color: '#6b7280', isBot: seat !== 0 }),
    seatLabel: (seat) => (seat === 0 ? 'You' : NAMES[seat]),
    seatPossessive: (seat) => (seat === 0 ? 'Your' : `${NAMES[seat]}'s`),
    voiceOf: () => ({}),
  };
}

/** The per-match slots the chrome reads, as the felt's session carries them. */
export function chromeSession(extra = {}) {
  return {
    roundBeat: false,
    beatResume: null,
    trickBeat: null,
    review: null,
    board: null,
    boardHandle: null,
    hint: null,
    hintsTaken: 0,
    ...extra,
  };
}

/**
 * The status bar over stub elements, with storage installed.
 * `h.session` may be replaced; the bar reads it through the thunk.
 */
export function statusBarHarness(overrides = {}) {
  const { store } = installArcade({ state: true });
  const doc = installDocument();
  const el = {};
  for (const key of ['status', 'statusText', 'scoreChip', 'scoreChipTrack', 'scoreChipValue',
    'speedChip', 'speedChipLabel', 'tableCounters', 'tableBoard', 'feltMiddle', 'log']) {
    el[key] = stubNode(key === 'speedChip' || key === 'scoreChip' ? 'button' : 'div', key);
  }
  const h = { store, doc, el, session: chromeSession(), winner: 'You win.' };
  h.bar = createStatusBar({
    el,
    session: () => h.session,
    ...seatAnswers(),
    winnerSentence: () => h.winner,
    ...overrides,
  });
  return h;
}

/**
 * The help sheet over stub elements, with storage installed and every table
 * seam it calls recorded in `h.calls`, in order.
 */
export function helpSheetHarness(overrides = {}) {
  const { store } = installArcade({ state: true });
  const doc = installDocument();
  const el = {
    helpButton: stubNode('button', 'help-button'),
    helpSheet: stubNode('div', 'help-sheet'),
    helpRules: stubNode('button', 'help-rules'),
    helpHint: stubNode('button', 'help-hint'),
    helpHintNote: stubNode('span', 'help-hint-note'),
    log: stubNode('div', 'log'),
  };
  el.helpSheet.hidden = true;
  el.helpSheet.append(el.helpRules, el.helpHint);
  el.helpHint.appendChild(el.helpHintNote);
  const calls = [];
  const h = { store, doc, el, calls, session: chromeSession(), state: null, pack: null, moves: 2 };
  h.sheet = createHelpSheet({
    el,
    session: () => h.session,
    liveState: () => h.state,
    livePack: () => h.pack,
    isMySeat: (seat) => seat === 0,
    mySeat: () => 0,
    movesFor: () => Array.from({ length: h.moves }, (_, i) => ({ type: 'noop', i })),
    renderSelection: (state) => calls.push(['renderSelection', state]),
    persistMatch: () => calls.push(['persistMatch']),
    showRules: (rules) => calls.push(['showRules', rules]),
    ...overrides,
  });
  return h;
}
