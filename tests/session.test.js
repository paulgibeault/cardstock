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
import { createSession, stopSession, inputEndsTrickHold } from "../src/ui/session.js";

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
  assert.strictEqual(s.trickResume, null);
  assert.strictEqual(s.trickHoldAt, null);
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
  s.trickResume = () => {};
  s.trickHoldAt = 1234.5;
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
  assert.strictEqual(s.trickResume, null);
  assert.strictEqual(s.trickHoldAt, null,
    "a stamp left on a stopped session dates a hold that no longer exists");
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

/* ------------------------------------------------------------------ *
 * Which input may end a trick hold (#176)
 * ------------------------------------------------------------------ */

// THE BUG, IN THE TERMS IT WAS REPORTED IN: "this works when I am not the last
// to lay down a card. When I am the last one to lay the card play immediately
// resumes to the next hand." The trick hold appeared for every trick a bot
// finished and never for one the player finished.
//
// The felt is one surface and `#hand` is inside `#table`, so the tap that plays
// the fourth card is also a tap on the felt; the move runs, `runTrickReveal`
// opens the hold, and the SAME click then bubbles into the listener that ends
// holds. The keyboard does it too, because a hand card is a `role="button"` div
// that the window listener's `button` opt-out does not match.
//
// The DOM half of that is three lines in src/ui/table.js and no Node test can
// call it (tests/roundBeat.test.js greps for them). The decision is two numbers
// and it is here.

const HOLD_AT = 5_000;

test("the input that opened a trick hold does not end it", () => {
  // A click is stamped when the pointer went up; the hold opens later, inside
  // the dispatch of that very click. So the opening gesture always carries a
  // stamp from BEFORE the hold — by a whole gesture's worth or by a hair.
  assert.strictEqual(inputEndsTrickHold(HOLD_AT, HOLD_AT - 0.4), false,
    "the tap that played the fourth card swept the trick it had just posed");
  assert.strictEqual(inputEndsTrickHold(HOLD_AT, HOLD_AT - 180), false,
    "a slow dispatch is still the same gesture, not a second one");
});

test("an input from after the hold opened does end it", () => {
  // The tap the beat is FOR. At the Manual rung nothing else will ever end the
  // hold, so a predicate that refused this would be a table that never moves.
  assert.strictEqual(inputEndsTrickHold(HOLD_AT, HOLD_AT + 0.1), true);
  assert.strictEqual(inputEndsTrickHold(HOLD_AT, HOLD_AT + 900), true);
});

test("an input stamped at the exact moment of the hold is the opening gesture", () => {
  // The boundary is decided in favour of the bug this fixes. Timestamps are
  // clamped by the browser for fingerprinting reasons, so "the same number" is
  // a thing that can genuinely happen to the opening click — and it cannot
  // happen to a human's second tap, which is tens of milliseconds away at the
  // very least. Equal reads as "still the tap that opened it".
  assert.strictEqual(inputEndsTrickHold(HOLD_AT, HOLD_AT), false);
});

test("an unreadable timestamp ends the hold rather than trapping the player in it", () => {
  // FAILS OPEN, on purpose. The Manual rung arms no timer at all, so an input
  // is the only door out; a predicate that answered "no" to an event it could
  // not read would hang the match. Guessing wrong this way costs one trick
  // swept a beat early, which is the bug above and is survivable.
  for (const stamp of [undefined, null, NaN, "1500", Infinity]) {
    assert.strictEqual(inputEndsTrickHold(HOLD_AT, stamp), true,
      `an event stamped ${String(stamp)} must not be able to freeze the table`);
  }
  // And the other end of it: a hold with no stamp recorded is a hold this rule
  // knows nothing about, so it must not be the thing that keeps it shut.
  for (const opened of [undefined, null, NaN]) {
    assert.strictEqual(inputEndsTrickHold(opened, 6_000), true,
      `a hold opened at ${String(opened)} must still be endable`);
  }
});
