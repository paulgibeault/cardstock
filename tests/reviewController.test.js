/**
 * THE REVIEW LENS, DRIVEN (#223, seam 5).
 *
 * What a review IS — the timeline, a position, the map's model, the reel's
 * label — has been pure and pinned in tests/timeline.test.js since phase 2.
 * What could not be asked was the other half: when a review may open, where it
 * stands when it does, which lens it looks through, what the reel's buttons
 * say, which door a tap on each of the three maps goes through, and what
 * leaving puts back. All of it lived in src/ui/table.js, which resolves 43
 * element ids at import and so cannot be loaded here.
 *
 * src/ui/reviewController.js takes its elements and the panel doors in, so
 * these stand it up over a real Hearts match played by the house bot, with a
 * document just big enough for src/ui/review.js to draw a map into, and ask.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";
import { createReviewController } from "../src/ui/reviewController.js";
import { createState } from "../src/engine/state.js";
import { makeCtx } from "../src/engine/context.js";
import { applyMove } from "../src/engine/movePipeline.js";
import { chooseBotMove } from "../src/engine/bot.js";
import { createRng } from "../src/engine/rng.js";
import { serializeMatch } from "../src/engine/replay.js";
import { matchTimeline, seekTargets } from "../src/stats/timeline.js";
import { beatMoment, reviewMapModel } from "../src/ui/review.js";
import { baseId } from "../src/engine/selectors.js";
import { loadPackFromDiskSync } from "../tools/lib/packs.mjs";
import { installArcade } from "./fixtures/arcade.js";
import { actingSeats } from "./fixtures/engine.js";

/* ------------------------------------------------------------------ *
 * A match, and a screen to review it on
 * ------------------------------------------------------------------ */

const label = (seat) => ["You", "Nell", "Ada", "Bo"][seat] ?? `Seat ${seat + 1}`;

/** Hearts, four seats, played by the house bot to `stopAt` moves (or the end). */
function played({ stopAt = null } = {}) {
  const pack = loadPackFromDiskSync("hearts");
  const state = createState({ pack, seats: 4, seed: 5 });
  pack.template.setup(makeCtx(state));
  const rng = createRng(5);
  for (let guard = 0; guard < 6000 && !state.gameOver; guard++) {
    if (stopAt !== null && state.log.length >= stopAt) break;
    const seat = actingSeats(state)[0] ?? state.turn.seat;
    const move = chooseBotMove(state, seat, { difficulty: "easy", random: rng.next });
    if (!move) break;
    applyMove(state, move);
  }
  return state;
}
// Played once each: a full game of Hearts is the slow part of this file.
const LIVE = played({ stopAt: 70 });
const OVER = played();

/**
 * Just enough of a document for src/ui/review.js's `renderReviewMap` (and
 * src/ui/dom.js's `line` and `svgNode`): nodes with a class, a dataset,
 * children, attributes, click listeners and a template's cloned markup.
 * Anything else it reached for would throw.
 */
function fakeDocument() {
  const make = (tag) => {
    const classes = () => new Set(String(node.className).split(/\s+/).filter(Boolean));
    const node = {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      dataset: {},
      attrs: {},
      children: [],
      listeners: {},
      // A <template> (src/ui/dom.js's svgNode): the parsed markup, cloned.
      content: { cloneNode: () => ({ className: "", children: [], markup: node.innerHTML }) },
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      classList: {
        contains: (c) => classes().has(c),
        toggle: (c, on) => {
          const s = classes();
          if (on ?? !s.has(c)) s.add(c); else s.delete(c);
          node.className = [...s].join(" ");
        },
      },
    };
    return node;
  };
  return { createElement: make };
}

// What Node had before any harness stood a document up: every restore goes
// back to this, whichever order a test's after-hooks run in.
const ORIGINAL = { document: globalThis.document, window: globalThis.window };

const findAll = (node, className) => {
  const out = String(node.className).split(/\s+/).includes(className) ? [node] : [];
  for (const child of node.children || []) out.push(...findAll(child, className));
  return out;
};
const click = (node) => { for (const fn of node.listeners.click) fn({}); };
const froms = (node, className) => findAll(node, className).map((n) => Number(n.dataset.from));

/**
 * The controller over `state`, with a spy on every door it reaches back
 * through. Every spy writes its name into one ordered `calls` list: what a
 * door into review closes, and in what order, is most of what it is.
 *
 * `wide` answers the window's (min-width: 900px) question — the drawer beside
 * the felt when true, the sheet over it when not.
 */
function harness(state, { wide = false, session: extra = {} } = {}) {
  installArcade({ state: true });
  globalThis.document = fakeDocument();
  globalThis.window = { matchMedia: () => ({ matches: wide }) };

  const calls = [];
  const rendered = [];
  const spy = (name) => (...args) => { calls.push(name); return args; };
  const map = { open: false, drawer: false, node: null, title: null };
  const button = () => ({ disabled: false });
  const el = {
    log: { textContent: "" },
    reviewBar: { hidden: true },
    reviewPrevHand: button(),
    reviewPrevTurn: button(),
    reviewNextTurn: button(),
    reviewNextHand: button(),
    reviewPosition: { textContent: "" },
  };
  const session = {
    state,
    pack: state.pack,
    review: null,
    roundSummaryOpen: false,
    reopenSummary: null,
    roundBeat: false,
    trickBeat: false,
    seatFit: "fitted",
    handFit: "fitted",
    ending: null,
    ...extra,
  };
  const slot = { session };
  const paints = [];
  const shown = [];

  const reviewer = createReviewController({
    el,
    session: () => slot.session,
    roundEnding: {
      cancelRoundBeat: spy("cancelRoundBeat"),
      cancelAutoAdvance: spy("cancelAutoAdvance"),
      paceView: (level) => ({ level: level.id, autoMs: 4000 }),
    },
    liveState: () => (slot.session ? slot.session.state : null),
    // table.js's own reading, verbatim: the review's state outranks the
    // beats' poses, and they outrank the live state.
    feltState: () => {
      const session = slot.session;
      return (session?.review && session.review.state)
        || (session?.trickBeat && session.trickPoseState)
        || (session?.roundBeat && session.roundFinalState)
        || (session ? session.state : null);
    },
    render: (s) => { calls.push("render"); rendered.push(s); },
    seatLabel: label,
    mySeat: () => 0,
    // table.js's own, verbatim: the pack's card table, by base id.
    cardById: (s, id) => s.pack.cardsById.get(baseId(id)),
    // A renderer whose "markup" names the card it was handed — so a face on
    // the map says which card `cardOf` resolved, and through which state.
    art: () => ({ face: (card) => `<svg card="${card.id}"/>` }),
    cancelBotTurn: spy("cancelBotTurn"),
    cancelAnnouncementBeats: spy("cancelAnnouncementBeats"),
    scheduleNextTurn: spy("scheduleNextTurn"),
    scheduleAnnouncementBeats: spy("scheduleAnnouncementBeats"),
    hideBanner: spy("hideBanner"),
    hideShowCard: spy("hideShowCard"),
    showGameOver: (s, ending) => { calls.push("showGameOver"); shown.push(ending); },
    hideGameOver: spy("hideGameOver"),
    hideScoreboard: spy("hideScoreboard"),
    hideRoundSummary: spy("hideRoundSummary"),
    paintRoundPace: (view) => { calls.push("paintRoundPace"); paints.push(view); },
    showReviewMap: (node, { drawer, title }) => {
      calls.push(drawer ? "showReviewMap(drawer)" : "showReviewMap(sheet)");
      Object.assign(map, { open: true, drawer, node, title });
    },
    hideReviewMap: () => { calls.push("hideReviewMap"); Object.assign(map, { open: false, drawer: false, node: null }); },
    isReviewMapOpen: () => map.open,
    isReviewDrawerOpen: () => map.open && map.drawer,
    reviewMapNode: () => null,
  });

  return {
    reviewer, el, slot, session, calls, rendered, map, paints, shown,
    timeline: matchTimeline(state.pack, serializeMatch(state), { labelOf: label }),
    reset() { calls.length = 0; rendered.length = 0; },
    restore() {
      globalThis.document = ORIGINAL.document;
      globalThis.window = ORIGINAL.window;
    },
  };
}

const at = (h) => h.session.review && h.session.review.index;

/* ------------------------------------------------------------------ *
 * When a review may open
 * ------------------------------------------------------------------ */

test("a review opens only on a live, logged felt with no beat holding it — or from the sheet that can put itself back", (t) => {
  const h = harness(LIVE);
  t.after(h.restore);
  assert.equal(h.reviewer.reviewOffered(), true, "a hand in progress can be reviewed");

  h.session.roundBeat = true;
  assert.equal(h.reviewer.reviewOffered(), false, "not while a count is up — it has a timer or a tap waiting");
  h.session.roundBeat = false;
  h.session.trickBeat = true;
  assert.equal(h.reviewer.reviewOffered(), false, "not while a trick is held");
  h.session.trickBeat = false;

  // THE SHEET: between hands the beat holds at the summary, and a review may
  // open from it only if the sheet knows how to put itself back.
  h.session.roundSummaryOpen = true;
  h.session.roundBeat = true;
  assert.equal(h.reviewer.reviewOffered(), false, "a sheet with no way back is not a door");
  h.session.reopenSummary = () => {};
  assert.equal(h.reviewer.reviewOffered(), true, "a sheet that can reopen itself is");
  h.session.roundSummaryOpen = false;
  h.session.roundBeat = false;
  h.session.reopenSummary = null;

  h.session.review = { index: 0 };
  assert.equal(h.reviewer.reviewOffered(), false, "one review at a time");
  h.session.review = null;

  h.slot.session = { ...h.session, state: { ...LIVE, isView: true } };
  assert.equal(h.reviewer.reviewOffered(), false, "a joiner's view has no log of its own to replay");
  h.slot.session = { ...h.session, state: { ...LIVE, log: [] } };
  assert.equal(h.reviewer.reviewOffered(), false, "nothing has happened yet");
  h.slot.session = null;
  assert.equal(h.reviewer.reviewOffered(), false, "no table");

  h.reset();
  h.reviewer.enterReview();
  assert.deepEqual(h.calls, [], "enterReview with no review on offer touches nothing");
});

/* ------------------------------------------------------------------ *
 * Opening, standing, stepping
 * ------------------------------------------------------------------ */

test("a review opens at the start of the last turn, through the seat's own lens, with the reel painted", (t) => {
  const h = harness(LIVE);
  t.after(h.restore);
  h.reviewer.enterReview();

  assert.deepEqual(h.calls.slice(0, 5),
    ["cancelBotTurn", "cancelAnnouncementBeats", "hideBanner", "hideGameOver", "hideScoreboard"],
    "the bots stop and every overlay steps aside before the felt moves");
  const start = seekTargets(h.timeline, h.timeline.length).prevTurn;
  assert.equal(at(h), start, "the position a player most wants is the one just before what just happened");
  assert.equal(h.session.review.lens, "own", "a live match is reviewed through the seat's own eyes");
  assert.equal(h.session.review.state.isView, true,
    "the own lens renders a VIEW — a card face down then must not be face up now");
  assert.equal(h.rendered.at(-1), h.session.review.state, "the felt draws the position, not the live state");
  assert.equal(h.el.reviewBar.hidden, false, "the reel comes up");
  assert.match(h.el.reviewPosition.textContent, /^Hand 2 · /, "the reel says where the felt stands — 70 moves is the second hand");
  const led = h.timeline.moves[start - 1];
  assert.equal(h.el.log.textContent, `${led.text}.`, "the live region reads the move that led here");
  assert.equal(h.map.open, false, "no map unless asked");
  assert.ok(!h.calls.includes("hideRoundSummary"), "no sheet was open, so none is hidden");
  assert.equal(h.session.state, LIVE, "the LIVE state is never touched");
});

test("a finished match is reviewed whole, and stepping walks the reel with its buttons disabled at the ends", (t) => {
  const h = harness(OVER);
  t.after(h.restore);
  h.reviewer.enterReview({ at: 0 });
  assert.equal(h.session.review.lens, "open", "a finished match hides nothing");
  assert.notEqual(h.session.review.state.isView, true, "the open lens renders the position whole");
  assert.equal(h.el.log.textContent, "The deal.", "position 0 is the deal");
  assert.equal(h.el.reviewPrevTurn.disabled, true, "nothing before the deal");
  assert.equal(h.el.reviewPrevHand.disabled, true);
  assert.equal(h.el.reviewNextTurn.disabled, false);

  const targets = seekTargets(h.timeline, 0);
  h.reviewer.stepReview("nextTurn");
  assert.equal(at(h), targets.nextTurn, "next turn");
  h.reviewer.stepReview("nextHand");
  assert.equal(at(h), seekTargets(h.timeline, targets.nextTurn).nextHand, "next hand");
  h.reviewer.stepReview("prevHand");
  h.reviewer.stepReview("prevHand");
  assert.equal(at(h), 0, "back to the deal");
  h.reset();
  h.reviewer.stepReview("prevTurn");
  assert.deepEqual(h.calls, [], "a step with nowhere to go does nothing at all");

  // Clamped both ways: a stale index cannot stand the felt off the end.
  h.reviewer.seekReview(h.timeline.length + 50);
  assert.equal(at(h), h.timeline.length);
  assert.equal(h.el.reviewNextTurn.disabled, true, "nothing after the end");
  h.reviewer.seekReview(-3);
  assert.equal(at(h), 0);
});

/* ------------------------------------------------------------------ *
 * The three maps: one builder, three doors
 * ------------------------------------------------------------------ */

test("the three maps are one builder — the same plays, standing where each door says", (t) => {
  // The round sheet's needs the sheet open; the review's needs a review.
  const h = harness(LIVE, { session: { roundSummaryOpen: true, reopenSummary: () => {} } });
  t.after(h.restore);
  const results = h.reviewer.gameOverMapNode();
  const sheet = h.reviewer.roundMapNode();
  h.reviewer.enterReview({ at: 5 });
  h.reviewer.openReviewMap();
  const review = h.map.node;

  const plays = froms(results, "review-play");
  assert.ok(plays.length > 10, "the map lists the plays");
  assert.deepEqual(froms(sheet, "review-play"), plays, "the sheet's map is the same map");
  assert.deepEqual(froms(review, "review-play"), plays, "and so is the review's");

  const inBeat = (node) => findAll(node, "review-beat--current")
    .map((n) => [Number(n.dataset.from), Number(n.dataset.to)]);
  const end = h.timeline.length;
  const prevTurn = seekTargets(h.timeline, end).prevTurn;
  const holds = (i) => ([from, to]) => from <= i && i < to;
  assert.ok(inBeat(results).some(([, to]) => to === end), "the results' map stands at the end");
  assert.ok(inBeat(sheet).some(holds(prevTurn)), "the sheet's map stands at the last turn");
  assert.ok(inBeat(review).some(holds(5)), "the review's map stands where the felt does");
  // AND THE PLAY: a beat is a whole trick, and the last turn and the end are
  // usually in the same one — the highlighted row is what tells them apart.
  assert.deepEqual(froms(results, "review-play--current"), [], "at the end no play is under way");
  assert.deepEqual(froms(sheet, "review-play--current"), [prevTurn], "the sheet's map lights the last turn's play");
  assert.deepEqual(froms(review, "review-play--current"), [h.timeline.turns.find((turn) => turn.from <= 5 && 5 < turn.to).from],
    "the review's lights the turn the felt stands in");
  // Every face is DRAWN, through the renderer and the match's own card table:
  // none fell back to a name, which is what an unresolved id does.
  assert.equal(findAll(results, "review-card--named").length, 0, "every card on the map resolved");
  const drawn = findAll(results, "review-card").map((n) => n.children[0].markup);
  assert.ok(drawn.length > 10 && drawn.every((m) => /^<svg card="[^"]+"\/>$/.test(m)), "and was drawn by the pack's renderer");
});

test("the results' map: a play closes the results and opens the review there — with the drawer when there is room", (t) => {
  for (const wide of [false, true]) {
    const h = harness(OVER, { wide, session: { ending: { winner: 1 } } });
    t.after(h.restore);
    const node = h.reviewer.gameOverMapNode();
    const row = findAll(node, "review-play")[7];
    h.reset();
    click(row);
    assert.equal(h.calls[0], "hideGameOver", "the results close first");
    assert.equal(at(h), Number(row.dataset.from), "the review opens at the play");
    assert.equal(h.map.open, wide, wide ? "beside the felt the map opens with it" : "on a phone the felt is the thing to see");
    if (wide) assert.equal(h.map.title, "The whole game");

    // AND BACK: leaving a review of a finished game puts the results up again.
    h.reset();
    h.reviewer.leaveReview();
    assert.deepEqual(h.shown, [{ winner: 1 }], "the results come back with the ending they had");
    assert.ok(!h.calls.includes("scheduleNextTurn"), "a finished game schedules nothing");
  }
  const bare = harness({ ...OVER, log: [] });
  t.after(bare.restore);
  assert.equal(bare.reviewer.gameOverMapNode(), null, "nothing to map");
});

test("the sheet's map stops the countdown; a play in it takes the sheet down and leaving puts it back", (t) => {
  let reopened = 0;
  // Where the round ENDED — the pose the felt holds under the sheet while the
  // live state already has the next deal (table.js's feltState).
  const pose = { pose: "where the round ended" };
  const h = harness(LIVE, {
    session: {
      roundSummaryOpen: true, roundBeat: true, roundFinalState: pose,
      reopenSummary: () => { reopened += 1; },
    },
  });
  t.after(h.restore);
  const node = h.reviewer.roundMapNode();
  assert.deepEqual(h.calls, ["cancelAutoAdvance", "paintRoundPace"],
    "opening the map is reading, not waiting to deal: the countdown stops before anything is built");
  assert.equal(h.paints[0].autoMs, null, "and the control stops showing one");
  assert.equal(h.paints[0].level, "manual", "at the rung storage holds (the default here)");

  const row = findAll(node, "review-play")[3];
  h.reset();
  click(row);
  assert.deepEqual(h.calls.slice(0, 7), [
    "cancelBotTurn", "cancelAnnouncementBeats", "hideBanner", "hideGameOver", "hideScoreboard",
    "cancelRoundBeat", "hideRoundSummary",
  ], "the sheet steps aside and its beat stops");
  assert.equal(h.session.roundSummaryOpen, true, "we are still between hands");
  assert.equal(at(h), Number(row.dataset.from));

  h.reset();
  h.reviewer.leaveReview();
  assert.equal(reopened, 1, "the sheet comes back, its countdown restarted");
  assert.deepEqual(h.calls, ["hideReviewMap", "render"], "the ending on the felt, then the sheet — and the bots wait on it");
  assert.equal(h.rendered[0], pose, "the felt goes back to the ending's pose, not the next deal");

  h.session.roundSummaryOpen = false;
  h.reset();
  assert.equal(h.reviewer.roundMapNode(), null, "no sheet, no sheet's map");
  assert.deepEqual(h.calls, [], "and the countdown it does not have is left alone");
});

// Two tests, not one: where the map goes is the WINDOW's answer, and the
// harness installs one window per test.
test("the review's own map as a sheet: a play closes it to show the felt, a beat's head only opens", (t) => {
  const h = harness(LIVE);
  t.after(h.restore);
  h.reviewer.enterReview({ at: 4 });
  h.reviewer.openReviewMap();
  assert.ok(h.calls.includes("showReviewMap(sheet)"));
  assert.equal(h.map.title, "The game so far", "a live match is 'so far'");
  const row = findAll(h.map.node, "review-play")[9];
  click(row);
  assert.equal(h.map.open, false, "the sheet closes to show the felt");
  assert.equal(at(h), Number(row.dataset.from));

  // Over the felt, a beat's head only opens the beat: the felt is behind the
  // sheet, and moving it there would be a move nobody sees.
  const before = at(h);
  h.reviewer.openReviewMap();
  const closed = findAll(h.map.node, "review-beat").find((n) => !n.classList.contains("review-beat--open"));
  assert.ok(closed, "a closed beat to open");
  click(findAll(closed, "review-beat__head")[0]);
  assert.ok(closed.classList.contains("review-beat--open"), "the head opened it");
  assert.equal(at(h), before, "over the felt a beat's head moves nothing");
});

test("the review's own map as a drawer: it stays, the felt follows it, and the label toggles it shut", (t) => {
  const h = harness(LIVE, { wide: true });
  t.after(h.restore);
  h.reviewer.enterReview({ at: 4 });
  h.session.seatFit = "fitted";
  h.reviewer.openReviewMap();
  assert.ok(h.calls.includes("showReviewMap(drawer)"));
  assert.equal(h.session.seatFit, null, "the felt is measured again once the drawer takes its width");
  const row = findAll(h.map.node, "review-play")[9];
  click(row);
  assert.equal(h.map.open, true, "the drawer stays");
  assert.equal(at(h), Number(row.dataset.from));

  // THE SAME CONTROL CLOSES IT, and the felt gets its width back.
  h.reset();
  h.reviewer.openReviewMap();
  assert.deepEqual(h.calls, ["hideReviewMap", "render"], "the position label toggles the map shut and refits");
  assert.equal(h.map.open, false);
});

test("a beat's head beside the felt stands it at that beat's moment, on the way open only", (t) => {
  const h = harness(OVER, { wide: true });
  t.after(h.restore);
  h.reviewer.enterReview({ at: 0 });
  h.reviewer.openReviewMap();
  const nodes = findAll(h.map.node, "review-beat");
  const k = nodes.findIndex((n) => !n.classList.contains("review-beat--open") && Number(n.dataset.from) > 20);
  assert.ok(k >= 0, "a closed beat to open");
  const from = Number(nodes[k].dataset.from);
  const beat = reviewMapModel(h.timeline, { index: 0, labelOf: label })
    .hands.flatMap((hand) => hand.beats).find((b) => b.from === from);
  const head = findAll(nodes[k], "review-beat__head")[0];
  click(head);
  assert.equal(at(h), beatMoment(beat), "the felt stands at the beat's moment (review.js's beatMoment)");
  assert.notEqual(at(h), 0);
  // Closing it again is not a seek.
  h.reviewer.seekReview(0);
  click(head);
  assert.equal(nodes[k].classList.contains("review-beat--open"), false);
  assert.equal(at(h), 0, "a beat closing leaves the felt where it is");
});

/* ------------------------------------------------------------------ *
 * Leaving, and the keyboard
 * ------------------------------------------------------------------ */

test("leaving a live review hands the felt back and re-arms the turn", (t) => {
  const h = harness(LIVE);
  t.after(h.restore);
  h.reviewer.enterReview();
  h.reset();
  h.reviewer.leaveReview();
  assert.equal(h.session.review, null);
  assert.equal(h.el.reviewBar.hidden, true);
  assert.equal(h.session.seatFit, null, "the fits are measured again for the live felt");
  assert.equal(h.session.handFit, null);
  assert.deepEqual(h.calls, ["hideReviewMap", "render", "scheduleNextTurn", "scheduleAnnouncementBeats"],
    "the live felt, then the bots — a review is a pause the player opened");
  assert.equal(h.rendered[0], LIVE);

  h.reset();
  h.reviewer.leaveReview();
  assert.deepEqual(h.calls, [], "leaving twice is leaving once");
});

test("the reel from the keyboard: arrows step, Shift steps a hand, Escape closes the map and then the review", (t) => {
  const h = harness(LIVE);
  t.after(h.restore);
  const key = (k, shiftKey = false) => {
    const ev = { key: k, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
    return { took: h.reviewer.onKey(ev), prevented: ev.prevented };
  };
  assert.deepEqual(key("ArrowLeft"), { took: false, prevented: false }, "not reviewing: the key is not the reel's");

  h.reviewer.enterReview();
  const start = at(h);
  assert.deepEqual(key("ArrowLeft"), { took: true, prevented: true });
  assert.equal(at(h), seekTargets(h.timeline, start).prevTurn, "left is a turn back");
  const one = at(h);
  key("ArrowRight");
  assert.equal(at(h), seekTargets(h.timeline, one).nextTurn, "right is a turn on");
  key("ArrowLeft", true);
  assert.equal(at(h), h.timeline.hands.at(-1).from, "shift-left is the start of this hand");
  assert.deepEqual(key("Enter"), { took: false, prevented: false },
    "Enter and Space are the held beat's, not the reel's");

  h.reviewer.openReviewMap();
  h.reset();
  assert.deepEqual(key("Escape"), { took: true, prevented: false });
  assert.deepEqual(h.calls, ["hideReviewMap", "render"], "Escape closes the map first, and the felt refits");
  assert.ok(h.session.review, "the review is still open");
  key("Escape");
  assert.equal(h.session.review, null, "the second Escape leaves");
  assert.ok(h.calls.includes("scheduleNextTurn"));
});

test("refitFelt measures again and draws what the felt is showing", (t) => {
  const h = harness(LIVE);
  t.after(h.restore);
  h.reviewer.enterReview({ at: 3 });
  h.reset();
  h.reviewer.refitFelt();
  assert.equal(h.session.seatFit, null);
  assert.equal(h.session.handFit, null);
  assert.equal(h.rendered[0], h.session.review.state, "mid-review, the felt is the position");
  h.slot.session = null;
  h.reset();
  h.reviewer.refitFelt();
  assert.deepEqual(h.calls, [], "no table, nothing to fit");
});

/* ------------------------------------------------------------------ *
 * The wiring only table.js can do
 * ------------------------------------------------------------------ */

// A GREP, because table.js resolves its element ids at import: the reel's
// buttons, the window's keydown and the panels' doors are wired there.
test("table.js hands the reel, the keyboard and the panels' doors to the controller", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/table.js"), "utf8");
  assert.match(src, /reviewer = createReviewController\(\{/, "initTable builds the controller");
  for (const [button, call] of [
    ["reviewPrevHand", "reviewer.stepReview('prevHand')"],
    ["reviewPrevTurn", "reviewer.stepReview('prevTurn')"],
    ["reviewNextTurn", "reviewer.stepReview('nextTurn')"],
    ["reviewNextHand", "reviewer.stepReview('nextHand')"],
    ["reviewPosition", "reviewer.openReviewMap()"],
    ["reviewDone", "reviewer.leaveReview()"],
  ]) {
    assert.ok(src.includes(`el.${button}.addEventListener('click', () => ${call});`), `${button} is wired to ${call}`);
  }
  assert.match(src, /if \(reviewer\.onKey\(event\)\) return;/, "the keydown asks the reel first");
  for (const door of [
    "onReview: () => reviewer.enterReview()",
    "onReviewMapClosed: () => reviewer.refitFelt()",
    "onGameOverMap: () => reviewer.gameOverMapNode()",
    "onRoundMap: () => reviewer.roundMapNode()",
  ]) assert.ok(src.includes(door), `initPanels is handed ${door}`);
  // The builder is gone from table.js: one copy, over there.
  assert.doesNotMatch(src, /renderReviewMap\(|reviewMapModel\(|matchTimeline\(/,
    "the map is built in src/ui/reviewController.js and nowhere else");
});
