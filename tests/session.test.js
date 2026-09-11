// One open match, one object, one reset point (src/ui/session.js).
//
// THE BUG THIS PINS is not hypothetical. src/ui/table.js carried about
// twenty-five module-level mutables, and two different functions hand-reset
// overlapping subsets of them: `adoptMatch` cleared some on the way in,
// `closeTable` cleared some on the way out — and the two bot-decision caches
// were exactly the ones `closeTable` missed. A persona's "did this bot remember
// to declare?" roll is cached per vulnerability window precisely so it is not
// re-rolled, so an entry surviving into the next match is a bot whose
// forgetfulness was decided by a game that had already finished.
//
// The session object is Node-clean by construction (no DOM, no SDK), which is
// what lets the reset discipline be tested at all — the module it came out of
// cannot be imported outside a browser.
import { test } from "node:test";
import assert from "node:assert";
import { createSession, stopSession } from "../src/ui/session.js";

function fakeSession() {
  return createSession({
    pack: { id: "crazy-eights" },
    state: { seats: 3 },
    seating: [{ seat: 0 }],
    cardArt: {},
    handPrefs: { mode: "auto", order: [] },
  });
}

test("a fresh session carries nothing from anywhere else", () => {
  const s = fakeSession();
  assert.strictEqual(s.selection, null);
  assert.strictEqual(s.ui, null);
  assert.strictEqual(s.pendingRender, null);
  assert.strictEqual(s.peek, null);
  assert.strictEqual(s.dealAnimation, false);
  assert.strictEqual(s.roundSummaryOpen, false);
  assert.strictEqual(s.botTimer, null);
  assert.strictEqual(s.bannerTimer, null);
  assert.deepStrictEqual(s.announceTimers, []);
  assert.deepStrictEqual(s.beatTimers, []);
  assert.strictEqual(s.revealTimer, null);
  assert.strictEqual(s.advanceTimer, null);
  assert.strictEqual(s.botCallDecision.size, 0);
  assert.strictEqual(s.botCatchDecision.size, 0);
  assert.strictEqual(s.shownCardKeys.size, 0);
});

test("two sessions share nothing — a new match cannot inherit the last one's caches", () => {
  const a = fakeSession();
  a.botCallDecision.set(1, true);
  a.shownCardKeys.add("hand:spades-Q");
  a.selection = { from: "hand.0", cardIds: ["spades-Q"] };

  const b = fakeSession();
  assert.strictEqual(b.botCallDecision.size, 0, "a bot's roll survived into a new match");
  assert.strictEqual(b.shownCardKeys.size, 0, "the felt remembered another match's cards");
  assert.strictEqual(b.selection, null);
});

test("stopSession cancels every timer and clears every decision", () => {
  const s = fakeSession();
  const cancelled = [];
  const timer = (name) => ({ cancel: () => cancelled.push(name) });

  s.botTimer = timer("bot");
  s.bannerTimer = timer("banner");
  s.announceTimers = [timer("beat-a"), timer("beat-b")];
  // THE ROUND ENDING'S OWN THREE (#150). The summary now deals itself, so
  // between a round-ending move and the next deal there are up to three live
  // timers: the show's steps, the completed trick's hold, and the countdown on
  // the sheet. Closing the table while any of them is in flight used to leave
  // them to be talked out of acting by an epoch check inside the callback —
  // which is not the same thing as not firing, and a countdown that fires into
  // a closed table is a hand dealt into a match nobody is at.
  s.beatTimers = [timer("step-1"), timer("summary")];
  s.revealTimer = timer("reveal");
  s.advanceTimer = timer("advance");
  s.botCallDecision.set(1, false);
  s.botCatchDecision.set("1>2", true);
  s.selection = { from: "hand.0", cardIds: ["x"] };
  s.peek = { node: null };
  s.pendingRender = { state: {} };

  stopSession(s);

  assert.deepStrictEqual(cancelled.sort(),
    ["advance", "banner", "beat-a", "beat-b", "bot", "reveal", "step-1", "summary"],
    "a timer left running is a table that keeps playing a match nobody is looking at");
  assert.strictEqual(s.botTimer, null);
  assert.strictEqual(s.bannerTimer, null);
  assert.deepStrictEqual(s.announceTimers, []);
  assert.deepStrictEqual(s.beatTimers, []);
  assert.strictEqual(s.revealTimer, null);
  assert.strictEqual(s.advanceTimer, null);
  assert.strictEqual(s.botCallDecision.size, 0);
  assert.strictEqual(s.botCatchDecision.size, 0);
  assert.strictEqual(s.selection, null);
  assert.strictEqual(s.peek, null);
  assert.strictEqual(s.pendingRender, null);
});

test("stopSession is safe on null and safe twice — closeTable may be reached either way", () => {
  assert.doesNotThrow(() => stopSession(null));
  const s = fakeSession();
  assert.doesNotThrow(() => { stopSession(s); stopSession(s); });
});
