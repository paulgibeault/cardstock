# The review plan (v1 — 2026-09-21)

Paul, 2026-09-21: *"The end of game passes too quickly. Sometimes the last
hand isn't even shown. I want an easy way to ensure the final card of the
hand/game is held for user dismissal. Better yet I'd like a full mechanic for
exploring the entire game plays, being able to return to the beginning of any
turn in the game using a well designed scrollable map. We should also be able
to simulate alternate endings with all cards in view for training purposes."*

Three asks, in rising order of size, and they nest: the hold is the smallest
case of the map (a map with one position in it), and the sandbox is the map
with a "play from here" on every position. So this is one workstream in six
phases rather than three features, and each phase is a PR that stands on its
own. Tracking issue: **#188**. Label: `review`.

## What the code already says (findings, 2026-09-21)

**The engine is event-sourced and the log is the match.** `serializeMatch`
is seed + log, `rehydrateMatch` is `setup()` plus `applyMove` per entry
([src/engine/replay.js](src/engine/replay.js)), and the file's own header
names "a future replay/review UI → step the same reducer one move at a time"
as a reason the format is not a state dump. `forkState`
([src/engine/fork.js](src/engine/fork.js)) is a throwaway copy of a live
state that every engine entry point accepts as-is, and `determinizeState`
([src/engine/determinize.js](src/engine/determinize.js)) resamples what a
seat cannot see. `computeMatchStats`
([src/stats/matchStats.js](src/stats/matchStats.js)) already replays a log
once and reads the event windows on the way past — it is the shape the
timeline model below has, minus the per-move record.

**Seeking is free.** Measured on this machine, a scratch script replaying a
full bot-vs-bot match through `rehydrateMatch`:

| pack | moves | hands | whole-match replay | per move | one `forkState` |
|---|---|---|---|---|---|
| Hearts | 660 | 12 | 3.2 ms | 0.005 ms | 0.010 ms |
| Milestones | 740 | 15 | 2.8 ms | 0.004 ms | 0.017 ms |
| Thirteen | 757 | 16 | 2.3 ms | 0.003 ms | 0.009 ms |
| Crazy Eights | 129 | 3 | 0.8 ms | 0.007 ms | 0.006 ms |
| Cribbage | 80 | 8 | 0.5 ms | 0.007 ms | 0.004 ms |

So "the position at move N" is `replay the first N moves`, every time, with
no checkpoints, no cache and no cleverness. That decides the shape of Phase 2:
the timeline is DATA about the log (who moved, what happened, what the score
was) and a position is computed on demand from the seed. Nothing is stored
per position, which is also what keeps the truncate-and-regrow trap
`invalidateLogCache` guards against ([replay.js:44](src/engine/replay.js))
out of the picture — a branch gets a fresh log array rather than a truncated
one.

**The endings today.** With PR #179 (issues #176, #180, #181) on top of main —
Paul's playtest build, and the base every code phase here stacks on:

| beat | what holds it | who ends it |
|---|---|---|
| a completed trick | `runTrickReveal`, four cards posed | a tap at Manual (the shipped rung), a clock at the others; capped at 2s on a shared table |
| a count of cribbage's show | `runShowSequence` | a tap at Manual, a clock otherwise |
| the score sheet between hands | `showRoundSummary` | a tap at Manual; deals itself at Relaxed/Quick; skipped at Instant |
| the trick that ends the match | the same `runTrickReveal` | the same |
| the end of the match | `awaitFinalLook` — a low bar, no scrim, felt live | the player only; nothing times out |

**Where "the last hand isn't even shown" comes from.** `roundBeatPlan`
([src/ui/roundBeat.js](src/ui/roundBeat.js)) returns null for a `roundOver`
carrying `over: true`, by design and with a test saying so ("the round that
ends the match belongs to offerFinalLook"). That was right for the SHEET —
there is no next deal to hold back — and wrong for the SHOW: at cribbage the
count that wins the match (pone's, the dealer's, or the crib's) is emitted
inside the match-ending move and then never played, so the deciding count
flashes past into the final-look bar. Every other pack ends on a card the
existing hold already covers, so this is cribbage's bug specifically, and it
is the "sometimes".

Three smaller things the ending also does not do:

- The final-look bar names the last card and nothing about the last hand's
  numbers; the results panel opens with "Round by round" collapsed. For a
  shedding or rummy pack the hand's damage is the thing that just happened
  and it is two taps away.
- Every opponent's hand stays face down at the end. There is no open-table
  lens anywhere: visibility is per zone in [src/engine/view.js](src/engine/view.js)
  (`all | owner | top | none`, fail-closed) and the seat plates draw a fan of
  backs ([src/ui/table.js](src/ui/table.js) `buildSeatBody`).
- A joiner at a shared table holds a view and no log
  ([src/match/client.js](src/match/client.js)); [src/ui/party.js](src/ui/party.js)
  has no game-over path of its own. Not verified live this pass.

**Nothing exists above the substrate.** No history, replay, rewind, undo,
scrub or timeline UI anywhere; `#log` is a one-line live region; the
`matchArchive` in [src/arcade/storage.js](src/arcade/storage.js) is a stub
that throws. Bots are pausable (`setTablePaused`) but not steppable.

## Design

### The vocabulary

- **Move**: one log entry. `{ seq, actor, type, ... }`.
- **Turn**: a maximal run of consecutive moves by one actor inside one hand.
  A rummy turn is draw + discard; a Hearts pass phase is three turns of one
  commit each; a trick-taking turn is one card. "The beginning of a turn" is
  the position before its first move, which is what Paul asked to return to.
- **Hand**: the moves between two `roundOver` events (the engine's round).
- **Position**: the state after the first N moves. Position 0 is the deal.
- **Line**: a log. The original match is one line; a sandbox branch is
  another line that shares a prefix with it.

### Phase 1 — the ending is held (PR on #179's branch)

The match-ending hand ends like every other hand, and then the final look.

1. `finalShowPlan(events, opts)` in roundBeat.js: the steps a match-ending
   `roundOver` owes, laid out exactly as `roundBeatPlan` lays out a live
   round's (first count on the hold, then a sequence at the rung that waits
   or a timeline at the rungs that count, the shared cap replacing the null).
   Null when there is nothing to narrate — no `showScored` in the window,
   Instant, or a remote move with no position to pose. `roundBeatPlan` is
   untouched: the sheet still belongs to the live match.
2. `afterMove`'s game-over branch runs that plan through the same show
   machinery (`runShowSequence` / `beatTimer`) with the final look as what
   the last count is followed by, instead of the sheet. The felt holds the
   ending position (`session.roundBeat` + `roundFinalState`, so a rotation
   repaints the ending) and the crib is posed face down until its step
   (`posedForShow`). The show card stays up under the final-look bar — the
   cards are what the bar exists to let you read — and comes down with the
   results.
3. The final-look bar says what the last hand did: one line, per side,
   "Last hand: You +12 · Ada +26 · Bo +0", from the final `roundOver`'s
   `scores`. Absent when the hand scored nothing at the boundary (cribbage
   pegs live).
4. The status bar promises the tap during a final show ("Round over. Tap to
   go on." comes before the game-over sentence while the beat is up).

Acceptance: at Manual, a cribbage match that ends on the crib's count ends in
three taps (pone, dealer, crib) and then the final-look bar, with the crib
still face down until its count; a match that ends by pegging is unchanged;
a shedding match's final-look bar names the hand's scores; no rung is one
millisecond slower at a non-cribbage ending; a shared table's final show is
finite at every rung.

### Phase 2 — the timeline model (pure, Node-tested)

`src/stats/timeline.js` — `matchTimeline(pack, snapshot)` replays the log
once and returns:

```
{
  hands: [{ round, from, to, scores, totals }],        // move index ranges
  turns: [{ hand, seat, from, to }],                    // maximal runs
  moves: [{ index, seat, type, hand, turn, text, marks }],
}
```

`text` is the one-line sentence the map lists (the describe layer, given a
seat-label function; never "playCard" raw); `marks` is the event summary
worth a glyph — `trickWon`, `announced`, `caught`, `showScored`, `roundOver`.
`positionAt(pack, snapshot, index)` is `rehydrateMatch` over
`log.slice(0, index)` — a fresh state with a fresh log. `turnStart(timeline,
index)` and `handStart` are the two seek targets the reel's buttons use.

Tests: every pack, a full simulated match; every move belongs to exactly one
turn and one hand; turn boundaries change actor or hand; `positionAt(n)`
equals the state `computeMatchStats` would have seen after `n` moves (turn,
scores, zone counts); the whole-match cost stays under a budget (the table
above, with headroom), so a future template cannot quietly make seeking slow.

### Phase 3 — review mode on the felt

**State.** `session.review = { snapshot, timeline, index, lens }` or null.
`feltState()` returns the review position ahead of every other claim; render
offers nothing (`acts: false`, same gate the round beat uses); the bots are
paused (`setTablePaused`) if the match is live; the status bar reads
"Reviewing · Hand 3 · Ada's turn" and `#log` narrates the current move's
sentence.

**The reel** (the scrubber): a strip above `#log`, in the band the hand rail
does not use. Five controls — ⏮ hand, ◀ turn, the position label, turn ▶,
hand ⏭ — and under them the map's spine: one band per hand, one tick per
turn, ticks coloured by seat with the same seat colours the plates use,
marks (a trick taken, a declaration, a hand scored) as glyphs on the tick.
The current position is a cursor; tap a tick to go to that turn's start,
drag to scrub, arrow keys step turns, Shift+arrows step hands. The strip
scrolls horizontally when the match is longer than the felt is wide (a
Milestones match is 15 hands) and keeps the cursor in view.

**The map** (the scrollable list): a panel like the scoreboard's, opened
from the reel's position label. One section per hand with its score line;
one row per turn — seat cell, the turn's sentence(s), and a score chip on
the turn that changed a total. Tap a row to seek there and close. This is
the "well designed scrollable map": readable as a record of the game without
scrubbing, and every row is a door.

**The lens.** What review shows of hidden cards is a rule, not a rendering
choice: (a) a finished solo match, or a sandbox — everything (Phase 4's open
lens); (b) a live match reviewed mid-play — the seat's own view of that
position (`viewFor(state, mySeat)` through `modelFromView`), so review can
never be a peek; (c) a finished shared match — everything, once the host has
shipped the log (Phase 6).

**Doors.** The results panel grows "Review the game"; the help sheet grows
"Review so far" on a solo table; the lobby tile offers "Review last game"
for a pack whose finished match is kept. Leaving review returns to exactly
the live position (the live state was never touched) and resumes the bots.
`stopSession` drops the review with everything else.

**Persistence.** `concludeMatch` today clears the resumable slot; Phase 3
also writes the finished payload to a `last` slot per pack (`saveMatch(state,
{ slot: 'last' })`, same seed + log). One per pack, overwritten by the next
finish, a few KB. The `Arcade.store` archive the storage stubs describe is
the long-term home and is out of scope here.

Acceptance: from the results panel, every turn of the match can be reached
in two taps or one drag; the reel's cursor and the map's highlighted row
always agree; reviewing a live match mid-hand shows only what the player
could see at that position and the bots do not move while it is open; the
felt after leaving review is pixel-identical to the felt before entering it.

### Phase 4 — the open lens

`session.open = true` renders every `owner` zone face up for every seat.
`none` stays a count (Hearts' won pile is nobody's to read; the rules say
so); `top` is unchanged. The seat plate draws a real fan of faces — the same
renderer the human's hand uses, at a legible step — in the plate's body and
its popup; the mini fan of backs is what a plate wears when the lens is
closed. `viewFor` gains `{ open }` so a host can ship an open view (used by
Phase 6). Bots are untouched: they already read the whole state and the
honest-rollout guard in [src/engine/bot.js](src/engine/bot.js) stays.

Used by: Phase 3's review of a finished match, and Phase 5's sandbox, where
it is a toggle on the felt ("Cards: open / hidden").

### Phase 5 — the sandbox ("play from here")

From any review position of a solo or finished match: **Play from here**.
`positionAt(index)` becomes a NEW live session — its own log, its own RNG
positioned where the original's was at that move, so a redeal in the branch
deals what the original would have; an alternate ending differs only by the
choices made. The human plays their seat, the bots play theirs at the chosen
difficulty; hints are offered and not counted.

Rules a branch obeys, all of them "the real game is untouched":

- never persisted as the resumable match, never recorded (`concludeMatch`'s
  record and daily writes are skipped; the results panel says "Sandbox —
  not recorded"), never published to a party;
- the map shows it as a second lane leaving the original at the fork point,
  with the same reel; "Back to the game" returns to the original line and
  discards the branch. One branch at a time in v1.
- `session.open` is a toggle on the sandbox felt, on by default: "all cards
  in view for training".

Deferred with reasons: playing every seat yourself (a different interaction
model: the felt assumes one human seat); "reshuffle what I couldn't see"
via `determinizeState` (a fair what-if rather than a replay of the real
deal — worth doing, second); keeping several branches.

### Phase 6 — shared tables

The host ships `serializeMatch(state)` to every device when the match ends
(the `snapshot` payload already exists in the protocol for resync); each
device rehydrates locally (it has the pack) and reviews with the open lens.
Mid-match review at a shared table stays off: a joiner has no log and the
host's felt cannot hold a live table for one person's scrubbing.

## Build order

| phase | issue | base | size |
|---|---|---|---|
| 1 | #189 | PR #179's branch (`playtest/176-trick-transition`) | S |
| 2 | #190 | main | M |
| 3 | #191 | after 2 (and 1 for the results-panel door) | L |
| 4 | #192 | after 3 | M |
| 5 | #193 | after 4 | L |
| 6 | #194 | after 3 | M |

Phase 1 stacks on #179 because it edits the same functions; the stacked-PR
rule from the polish workstream applies — merge #179 first, then retarget.
Phases 2 and 4 are pure/rendering work that can run in parallel with 3 once
its seams are named (`session.review`, `feltState`, the `open` option).

## Acceptance for the whole

A player finishing a match at the defaults sees the last card, the last
count and the last hand's numbers, each waiting for them; can open the game
as a map, step to the start of any turn, see what everyone held, play the
hand out differently with every card face up, and come back to the real
result — which is exactly what it was.
