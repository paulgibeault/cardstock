# Meld & Seat Row Plan

Playtest feedback from 2026-09-03 (round 4 in
[FEEDBACK_INBOX.md](FEEDBACK_INBOX.md), items 9–17), triaged against the
code. Nine items in two workstreams: **the meld mechanic** — what the
Milestones player can do with the tray and what a laid-down meld looks
like — and **the player cards** along the top of the felt.

**Status: all nine implemented** on the working tree, `npm test` green at 613
(from a 563 baseline). What each change actually did is in the code and its
comments; the sections below are the plan as written, kept for the root-cause
analysis. Five things the implementation found that the plan did not — each
noted in place: `smartSelectArmed` had never once armed, a `stagingPhase`
default breaks Hearts' simultaneous pass, `reserveSeatRowSpace` skipping the
carousel was a live reflow bug, the reserve adopted the outgoing view's floor,
and `zoneRect` was a second stale-landing site. Two blemishes are left open at
the end of this document.

Each item records the root cause found in code, the fix, and the test that
would have caught it. Four of the nine were reproduced in the browser
against a live Milestones table; the rest are read off the source and say
so.

## Triage summary

| # | Item | Type | Size | Root cause found | Status |
|---|------|------|------|------------------|--------|
| 9 | Meld pile goes dead on other players' turns | Bug | S | yes — `interactionMode` reads the *global* turn phase | done |
| 11 | Selected card sits behind its neighbours | Bug | S | yes — reproduced, `z-index` tie | done |
| 16 | A card goes for a ride while the row scrolls | Bug | S | yes — flight rect measured mid-scroll | done |
| 10 | Meld pile still takes space after laying down | Feel | S | yes — reproduced, 97px held | done |
| 12 | Laid-down runs are not sorted | Feel | M | yes — melds render in the order they were built | done |
| 17 | Played cards move too fast to see | Feel | M | yes — 260ms, and three moves that do not animate at all | done |
| 13 | On my turn, scroll the next player into view | Feel | S | yes — the scroller only follows `.seat--active` | done |
| 14 | Two states of player card, not three | Feel | S | n/a — `SEAT_VIEWS` is a three-item list | done |
| 15 | Default to maximized player cards | Feel | S | n/a — `seatView: 'auto'` in session defaults (now `'all'`, moved to session.js) | done |

Phase 1 is the three bugs, all independent and small. Phase 2 is the three
that change how the felt reads. Phase 3 is the seat-view triple, which is
one decision and three edits and should land together.

## Two findings that reframe the list

**The meld tray and the selected card are still the same variable.** This
is the tail deliberately left open by the last pass (FEEDBACK_PLAN.md,
footnote 1): "Separating *the meld I am building* from *the card I have
selected* is the real fix, and is an interaction change worth deciding on
its own." Items 9, 10 and 11 are all standing on it. The plan below fixes
each of them at its own site — none of them needs the split — but if a
fourth symptom turns up, the split is the answer rather than a fourth
patch.

**Nothing the human plays by tapping a destination ever flies.**
`performHumanMove` takes the tapped node as the flight's origin
(`src/ui/table.js:2618`), and for a pile tap or a meld-chip tap that node
*is the destination*. Recorded live: discarding by tapping the discard pile
animates a card travelling `translate(0px, -1.75px)`. So the only card
motion on a Milestones table today is a bot's 260ms hop — which is exactly
the complaint in item 17, arriving from a direction the item did not name.

---

# Workstream A — the meld mechanic

## 9. The meld pile goes dead while others take their turns

**Root cause.** `interactionMode(state)` asks the template, and
contract-rummy answers off `ctx.turn.phase` (`src/templates/contract-rummy.js:303`),
which is **global** state — one `turn.phase` for the whole table
(`src/engine/state.js:149`). So while any seat is in its *draw* phase, the
mode is `'rummy-draw'` **for everyone**, including the human watching. The
off-turn affordance in `buildUiModel` is gated on the mode being
`'rummy-meld'` (`src/ui/interaction.js:254`), so it switches off for the
first half of every bot's turn and back on for the second. Three surfaces
go with it:

- taps on the fan — `handSelectable` is empty, so `renderHand` attaches no
  click listener at all;
- hold-to-gather — `smartSelectArmed()` requires
  `ui.mode === 'rummy-meld' && ui.handMulti` (`src/ui/handGestures.js:104`);
- **and the tray eats the meld.** A tray card keeps its click listener
  whatever the model says (`src/ui/table.js:1512`), and with `handMulti`
  false `onHandCard` falls into the single-select branch, where tapping an
  already-selected card sets `session.selection = null`
  (`src/ui/table.js:2657`). One tap on a staged card during a bot's draw
  phase discards the *entire* gathered meld.

**Why the test did not catch it.** `tests/interaction.test.js:228` sets
`state.turn.phase = "meld"` by hand before asking the question — it pins
the one value where the affordance works. A green run here means nothing;
the missing case is `turn.phase = "draw"`.

**Fix.** Stop asking a whose-turn-is-it question to answer a what-may-I-do
question. Add a template hook — `gathers(ctx, seat)`, "may this seat be
assembling something right now" — defaulting to `stagingPhase(state)` for
templates that do not implement it. Contract-rummy answers
`!ctx.playerVar(seat, 'laidDown')`, with no reference to `turn.phase`.
Then:

- `buildUiModel`'s off-turn branch sets `handSelectable` / `handMulti` from
  `gathers`, not from the mode string;
- `ui.staging` is published on the model, and `smartSelectArmed()` reads
  that instead of comparing mode strings;
- `stagingPhase` keeps its current job (reserving the row's slot) and stays
  mode-based, because the slot must not come and go (#13).

This also retires the three places the platform reads a template's
`laidDown` playerVar directly (`src/ui/interaction.js:254`, `:322`,
`:511`), which is a template's rule living in platform code.

**Belt and braces.** In `onHandCard`, the single-select branch should never
be reachable with a multi-card selection in hand; make it clear only the
tapped card, not the whole selection.

**Tests.** `tests/interaction.test.js`: the off-turn staging test runs for
`turn.phase` of *both* `"draw"` and `"meld"`. A new test asserts that
toggling one card out of a three-card off-turn selection leaves two.
Break-check per the house rule: revert the `gathers` hook and confirm the
draw-phase case goes red.

## 10. The meld pile still takes space after laying down

**Reproduced.** After a Milestones lay-down, `#stage-row` reports
`min-height: 97.2px`, `display: flex`, `hidden: false` — invisible
(`.stage-row--empty` sets `opacity: 0; visibility: hidden`), inert, and
holding a card's height of felt for the rest of the round. On screen it is
a visible gap between the meld chips and the hand.

**Root cause.** The row's slot is reserved on `stagingPhase(state)`
(`src/ui/table.js:1487`), which is a question about the *mode* and knows
nothing about whether this player still has anything to gather. The
reservation is right — it is the fix for #13 — but its condition is one
term short.

**Fix.** The same `gathers(ctx, seat)` hook from item 9: reserve the slot
while *this seat* could still be gathering, not merely while the phase
allows gathering. Once the human lays down, the row goes `hidden` and the
meld strip in `#player-piles` takes the space back until the next round
(`laidDown` is reset per round at `src/templates/contract-rummy.js:47`, so
nothing needs to undo it).

**Note on #13.** This *does* move the felt — once per round, at the moment
the player laid down and the board changed underneath them anyway. That is
the case #13's rule was never about: the bug there was a strip flickering
twice per turn for the whole match.

**Bonus, and it is the fix for half of item 11.** `stagedIds` currently
returns the selection whenever `stagingPhase` is true, *including after the
lay-down* — so a post-lay-down single selection is drawn in the tray by a
full render and lifted in the fan by the fast path (`renderSelection`).
Observed live: tapping a card lifted it in the fan; the next full render
moved the same card out of the fan and into the tray, unprompted. Gating
the tray on `gathers` makes `stagedIds` return `[]` after the lay-down, and
the selection stays in the fan where the hit/discard gesture expects it.

**Tests.** `tests/tableModel.test.js` (or a new felt-level assertion):
after `laidDown`, `stagedIds` is empty and the row is hidden; before it,
neither.

## 11. The selected card sits behind its neighbours

**Reproduced.** Select a hand card, then move the pointer onto the card to
its right: the neighbour paints over the selected card's raised edge.

**Root cause.** The hand has one z-index rung shared by two states:

```
.hand .card-face-wrap:hover,
.hand .card-face-wrap--selected { z-index: 2; }   /* table.css:1451 */
.hand .card-face-wrap--peek     { z-index: 3; }   /* table.css:1489 */
```

A hovered neighbour ties with the selected card at 2, and the tie is broken
by DOM order — so any hovered card to the *right* of the selection wins.
`--hinted` (`table.css:1838`) lifts a card 8px with no z-index at all and
loses to everything.

**Fix — one principle, four rungs: z-order follows lift height.** Every one
of these states is a `translateY`, and the card that is lifted furthest is
the one that must be on top:

| state | lift | z |
|---|---|---|
| `--playable` | −4px | auto |
| `:hover` | −10px | done |
| `--hinted` | −8px | done |
| `--selected` | −14px | done |
| `--peek` | −20px | 4 |

Peek stays top (its own comment is the reason: the card under the finger
has to be the one you can see), and a selected card now outranks a hovered
neighbour, which is what the report asks for.

**Test.** `tests/cardStyles.test.js` has no DOM, so this is a stylesheet
assertion: parse `src/ui/table.css` and assert the four rungs are strictly
ordered — the same shape as the existing repo gates, and it bites if
somebody adds a fifth lift state without a rung.

## 12. Laid-down runs are not sorted

**Root cause.** A meld group stores its cards in whatever order they were
assembled and never re-orders them:

- lay-down keeps the bot search's order —
  `groups.push({ item, cards: meld.cards.slice(), ... })`
  (`src/templates/contract-rummy.js:232`);
- a hit **appends** — `const cards = [...group.cards, ...cardIds]`
  (`src/templates/melds.js`, `resolveHit`), so a 4 played onto a
  `3,5,6` run lands at the end and stays there;
- the chip renders in stored order (`src/ui/zoneRenderer.js:369`), and so
  does the inspector's card-by-card listing.

A wild is worse than out of order: it is drawn as a wild, and the only
thing that says what it *became* is the inspector line "played as 7". A run
that reads `3 5 W 6` gives the player no way to see that the W is the 4.

**Fix — order it where it is read, not where it is stored.** Add
`meldDisplayOrder(ctx, group, kind)` to `src/templates/melds.js`: sort by
`meldValue()` — the function that already resolves a wild through
`group.wilds` — ascending for a run, naturals-then-wilds for a set or a
colour group. `buildMeldStrip` and the chip inspector both render through
it.

Rendering rather than storing, deliberately: `group.cards` is match state
that a replay rebuilds and the wire ships, and re-ordering it would mean
`move.choice.meld` indices and stored arrays changing shape for a purely
visual property. A pure function over the group has neither problem and
fixes melds in matches that are already saved.

**Then say what the wild is.** Sorting alone puts the wild in the right
slot but still shows a wild face. Add a small rank pip to the wild's chip
card carrying its frozen value — it is already computed
(`meldCardName`, `src/ui/zoneRenderer.js:334`) and today reaches only the
inspector.

**Tests.** New unit tests in `tests/` over `meldDisplayOrder`: a run laid
`6,3,W,5` renders `3,W,5,6`; a hit appended to the end sorts into place; a
set is unchanged; a colour group puts wilds last. The engine's own
ordering stays untested because it stays unchanged.

---

# Workstream B — the player cards

## 13. On my turn, scroll the next player into view

**Root cause.** `scrollActingSeatIntoView` (`src/ui/table.js:1374`) centres
`.seat--active`. On the human's turn the acting seat is the human's own,
which is not in the opponent row at all — so there is no `.seat--active` to
find, the function returns, and the row stays wherever the last bot left
it.

**Fix.** When no opponent is acting and the human is, scroll to
`ctx.nextSeat(mySeat(), state.direction)` — the seat that plays after this
turn, whose melds are the ones worth reading before deciding. `nextSeat`
already exists (`src/engine/context.js:92`) and honours a reversed
direction. Skip effects are deliberately not modelled here: the seat after
you is the right answer for the ordinary turn, and a plan that guesses at
pending skips would be wrong more often than the simple rule.

**Test.** `tests/tableModel.test.js` cannot see scroll offsets; the
testable half is a pure `seatToShow(state, mySeat, acting)` helper — acting
opponent when there is one, next seat when it is my turn, null in a
simultaneous phase. Assert that over a reversed direction too.

## 14 + 15. Two states, defaulting to maximized

These are one change. Today: `SEAT_VIEWS = ['minimized', 'auto', 'all']`
(`src/ui/table.js:947`) with `seatView: 'auto'` as the default
(`src/ui/session.js:111`). After: `['minimized', 'all']`, defaulting to
`'all'`, and the toggle becomes a two-state control.

**What comes with it:**

- **The dots.** `SEAT_VIEW_COPY` drops its middle entry; the button shows
  one dot or two. Its accessible name still names the rung and what a tap
  does next. With two states it *could* become `aria-pressed`, and the
  current comment explains the boolean was rejected because there were
  three — worth revisiting when the code is open.
- **`showToggle`.** It reads `carousel || opponents >= CAROUSEL_FROM_SEATS`
  (`src/ui/table.js:1251`). With `'all'` as the default, `carousel` is
  almost always true and the toggle would appear at a two-hander where it
  has nothing useful to do. Reduce it to `opponents >= CAROUSEL_FROM_SEATS`.
- **The fit ladder loses two rungs.** `'all'` runs no fit loop, and
  `'minimized'` floors at `TIER_COLLAPSED` — so `'compact'` and `'tight'`
  become unreachable. See D1 below; the recommendation is to keep them and
  keep `'auto'` as an internal fallback, not to delete them.
- **`reserveSeatRowSpace` stops applying.** It returns early in carousel
  mode, which is now the default. That is correct — the carousel scrolls
  rather than reflowing — but it means the #13 protection now rests
  entirely on every seat being the same size in carousel mode. Worth a
  look on a phone before this ships.

**Tests.** `tests/interaction.test.js` and `tests/tableModel.test.js` do
not cover `seatView`; a small unit test over the view cycle (`'all'` →
`'minimized'` → `'all'`) and the `showToggle` predicate is new coverage,
and cheap.

## 16. A card goes for a ride while the player cards scroll

**Mechanism (strong hypothesis — not yet reproduced live).** The order of
operations in `afterMove` is: `render(state, message)` then
`animateMove(state, move, from)` (`src/ui/table.js:2492`). `render` calls
`renderSeats`, which calls `scrollActingSeatIntoView`, which issues a
**smooth** scroll (`src/ui/table.js:1387`). `animateMove` then measures its
rectangles — `seatRect(seat)` for the launch point — *while that scroll is
still gliding*. The rect is a viewport rectangle of a node that is moving,
so the flying copy launches from where the seat **was**, which after a
few hundred milliseconds of scrolling is over a neighbour's plate. The
card is a throwaway clone in a fixed layer (`flight.js`); nothing has
changed hands, which is exactly what the report says.

Consistent with the report in two ways: it only happens in the carousel
(the one view that scrolls), and only sometimes (only when the row actually
had somewhere to scroll to).

**Confirming it before fixing it.** Log `row.scrollLeft` at flight launch
and again at `animationSettled`; a ride is a launch where the two differ.

**Fix.** Measure after the scroll settles. `scrollActingSeatIntoView`
returns a promise that resolves on `scrollend` with a `setTimeout` backstop
— the same reasoning as `animationSettled` in `src/ui/flight.js`, which
already exists because a compositor you do not control is not something to
wait on forever — and `afterMove` awaits it before `animateMove`. When
motion is off, the scroll is instant and the promise resolves immediately.

## 17. Played cards move too fast to see

Three separate reasons a card is hard to follow, in the order they matter:

**(a) The human's own plays do not travel at all.** `performHumanMove`
uses the tapped node as the origin (`src/ui/table.js:2618`), and for a pile
tap (`:3226`) or a meld chip tap (`:3235`) that node is the *destination*.
Measured live: a discard animates `translate(0px, -1.75px)` over 260ms.
**Fix:** pass the origin, not the tapped node — the selected card's node in
the fan or the tray. The tapped node stays the fallback for a drag, where
it genuinely is where the finger started.

**(b) A lay-down is not animated at all.** `animateMove` handles `draw`,
`hit`, `playCard` and `discard` and returns for everything else
(`src/ui/table.js:2233`) — so a bot completing a contract puts three to
six cards on the felt with no motion whatever. It is the single biggest
event in a Milestones round. **Fix:** a `layDown` branch that flies each
card from the actor's seat to the meld strip, staggered ~80ms, meld by
meld. A hit currently fades out on arrival (`fade: true`, `:2230`) rather
than landing on the chip; give it `landOn` now that the chip is a stable
target.

**(c) 260ms is short.** `flyCard`'s default (`src/ui/flight.js`) is a
quarter of a second for a card crossing the whole felt. **Fix:** raise the
default to ~420ms, and scale a bot's flight with the bot-speed setting the
player already has (`botDelayMs`, default 600 —
`src/arcade/storage.js:116`) so that "slower bots" also means "watchable
cards": `clamp(260, 420 * botDelayMs/600, 700)`. Reduced motion still
skips the flight entirely; nothing here changes that.

**Tests.** `flight.js` is DOM-heavy and untested today. The testable part
is the duration function — a pure `flightDurationMs(botDelayMs)` with its
clamp — plus a `tests/` assertion that `animateMove` handles every move
type a template can emit, which is the gate that would have caught (b).

---

## Decisions to make before phase 3

**D1 — what happens to `'compact'` and `'tight'` once the middle view is
gone?** They become unreachable rungs. *Recommendation:* keep them, and
keep `'auto'` as an internal fallback the *player* cannot select — when
`'all'` is on and the row still cannot scroll usefully (a very narrow
phone), fall back through the ladder rather than shipping a row that runs
off both edges. Deleting the rungs is a one-way door and the phone case is
the one this repo keeps rediscovering.

**D2 — sort melds in the renderer or in the engine?** *Recommendation:*
renderer, as above. The engine's order is state that replays and ships on
the wire; the complaint is about reading a meld.

**D3 — after the lay-down, does a single selected card belong in the fan or
the tray?** *Recommendation:* the fan. The tray is gone once you have laid
down (item 10), and the hit/discard gesture is a single card that is about
to leave — which is the case `stagedIds`' own comment says the fan is the
only sensible place for.

## The order it was built in

1. **Phase 1** (items 9, 11, 16) — three bugs, independent.
2. **Phase 2** (items 10, 12, 17) — item 10 rode on item 9's `gathers` hook.
3. **Phase 3** (items 13, 14, 15) — one seat-row commit.

Built as four packages with disjoint file ownership rather than three phases:
the z-order (table.css), the meld order (melds.js + zoneRenderer.js) and the
`gathers` hook (interaction.js + table.js + the template) ran concurrently,
then the seat row and the flight work in series, both wanting `table.js` and
both rewriting `scrollActingSeatIntoView`.

---

# Closed (#97)

Both blemishes below are fixed. Neither fix was the one the issue proposed,
and the reasons are worth keeping:

- **The 13px overflow was paid for by deleting a row rather than by shaving
  the seats.** The bar that used to stand between the felt and the hand — the
  turn token, a sentence of phase guidance, the action button, the Hint offer
  — reserved 53px of a 812px phone for the whole match whether or not it had
  anything to say. Those controls are a rail at the fan's edge now and the
  sentence is gone, which returns the 53px to `#felt-middle`. Measured after:
  `#table-screen` overflows by 0, and the opponent row can grow to **332px**
  before the middle hits its floor at 160px — 169px of headroom above the
  carousel's 163px worst case, where there used to be a 13px deficit.

- **The toggle's corner is reserved in the BLOCK axis, not the inline one.**
  The issue suggested `scroll-padding-inline`; measurement says no inline
  reservation can work here. The row genuinely scrolls (scrollWidth 517 against
  a 332px client), so inline padding only holds the corner open at the two
  scroll extremes — every seat passes under the toggle on its way past in
  between, which is the case the 22x7px measurement happened to catch. A
  `padding-top` of `0.9rem` puts the seats below the toggle's box at *every*
  scroll position, and block padding on a horizontal scroller adds nothing to
  its scrollable length, which was the objection to the inline fix in the first
  place. Verified at 21 scroll positions across four root font sizes (14-20px):
  no overlap anywhere, 3-4px of clearance throughout, `scrollWidth` unchanged.

  It is `rem` rather than pixels because the toggle's height is its font's, and
  the launcher scales the root font — a pixel constant would have held at the
  default scale and failed at the large one.

<details>
<summary>What was measured before the fix</summary>

Two cosmetic blemishes measured at 375x812 with a full table in `'all'`, both
found by the narrow-phone spike after the packages had landed:

- **Milestones overflows `#table-screen` by 13px** once melds appear. Stockpile
  overflows by 0. It is a consequence of the carousel row being taller than the
  `'auto'` row it replaced as the default (41px -> 163px), and the row's height
  is bounded (`.seat__zones` is `nowrap`), so this is a fixed 13px rather than
  something that grows.
- **`.opponent-row--carousel` overrides the row's `2.9rem` toggle padding to
  `0`**, so the 22x18px view toggle grazes a seat's top border by about 22x7px.
  No seat CHILD element falls inside it, so nothing is unclickable — it reads
  as carelessness rather than breaking anything.

Neither was introduced by a package in this pass; both were pre-existing in the
`'all'` view and only reach players now that `'all'` is the default.

</details>
