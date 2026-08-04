# UX Pass Plan (v1 — 2026-08-04) — **SHIPPED**

> **Status: implemented.** All five phases landed together. What the work
> actually changed, and the three places reality corrected this plan, are
> recorded in `IMPLEMENTATION_NOTES.md` under "The UX pass"; the plan below is
> kept as written so the reasoning stays legible next to the outcome.
>
> The three corrections, in short: `animation.finished` turned out to be an
> unusable completion signal for anything that un-hides a card (a frame-starved
> document never settles it); a `visibility: 'top'` pile was drawing its buried
> cards face up, and sequencing's personal discards were mis-modelled as `top`
> when a real Skip-Bo table has them face up and fanned; and the last-card
> window had to be one card wider than "at the count", because the classic rule
> is that you declare *as* you play your second-to-last card.

Twelve player-facing asks, one pass. This document turns them into five
shippable phases built on seams the codebase already has. The design rule
throughout: **every feature is a new dressing over an existing contract,
never a second path around one.**

The contracts being leaned on (all live today):

| Contract | Where | What it gives this pass |
|---|---|---|
| Legal moves are enumerated, never constructed by the UI | `buildUiModel` / `enumerateLegalMoves` (src/ui/table.js, src/engine/movePipeline.js) | Drag targets, uno buttons, and hints all derive from the same move list taps do |
| The match is an event log + seed | src/engine/replay.js | Detailed stats are *computed from the log*, not counted along the way |
| Zone defs carry layout/facing/visibility | src/engine/state.js, templates | Overlap layouts and face-down secrets are zone-def vocabulary, not per-game UI code |
| Announcements are engine-level | `applyAnnouncement` (movePipeline.js), shedding's `lastCardCall` | The uno mechanic needs UI, not engine work |
| One storage door | src/arcade/storage.js | Stats/head-to-head extend `recordResult`, no new namespace invented |
| Card flight is one module | src/ui/flight.js | Snap-back is `flyCard` home, nothing new |

Requirement → phase map:

| # | Ask | Phase |
|---|---|---|
| 1 | Drag any face-up card; valid drop plays, invalid zooms back; reveals card beneath; secrets stay face-down | B |
| 2 | Bots with names, personalities, icons, rotating per game | A |
| 3 | Scores neatly visible during play | A |
| 4 | Detailed stats after each game | D |
| 5 | Win/loss per opponent (bots now, P2P later) | D |
| 6 | Forfeit a single-player game | D |
| 7 | Trick chime, not a shuffle | E |
| 8 | My name from P2P settings | A |
| 9 | Card/pile stats on hover, replacing always-on labels | C |
| 10 | Horizontal/vertical card overlap per variant | C |
| 11 | Drag-sortable hand | C (uses B's drag layer) |
| 12 | Declare-uno + catching missed calls | E |

---

## Phase A — Who is at the table (identity, scores)

Small, high-visibility, and everything later phases display hangs off it.

### A1. Player & bot roster — `src/players/roster.js` (new)

One module answers "who is seat N" for every surface (table, score sheet,
game-over, stats). Nothing else formats a name again.

```js
// { name, icon, persona, isBot }
seatIdentity(state, seat)
```

- **Human**: `Arcade.player.name()` with fallback `'You'`. Rendered via
  `textContent` everywhere — the shipped-twice peer-name XSS precedent
  (design doc §7b / §17.8) is exactly why this module returns *data* and
  never markup. Status lines stay second-person ("Your turn"); sheets and
  stats use the name.
- **Bots**: a fixed roster of ~10 characters in the repo:
  `{ id: 'juniper', name: 'Juniper', icon: '🦊', persona: 'cautious',
  tagline: 'Never wastes a wild.' }`. Icons are emoji at v1 (zero assets,
  themable later via the cardStyles SVG path if wanted).
- **Rotation**: match creation picks seats by seeded shuffle from the match
  seed — different game, different opponents; same save, same opponents.
- **Persistence**: the picked `botSeats: [{seat, botId}]` are serialized
  with the match (alongside `variants` in `serializeMatch`) so resume and
  replay show the same table. Unknown botId on load (roster edited) falls
  back to a default identity rather than failing the replay.

`seatLabel()` in table.js becomes a thin call into this module; the avatar
span renders `icon` instead of initials.

### A2. Personalities — `src/engine/bot.js` extension

Persona = a named parameter set consumed by `chooseBotMove`, *not* a new
bot. The template's `botHeuristic` stays the domain brain; persona shapes
how it is applied:

```js
{ aggression: 1.2,   // multiplier on offensive move scores
  patience:  0.8,    // multiplier on draw/hold scores
  mistakeRate: 0.1,  // chance of playing 2nd-best
  callReliability: 0.85, // remembers to declare "last card"
  catchAttention: 0.6,   // notices YOUR missed declaration
  tempoMs: [500, 1100] } // per-persona think-time range
```

Key liberty worth stating: **bot randomness may use `Math.random()`**.
Replay replays the *log*, it never re-runs `chooseBotMove` — so persona
noise cannot desync a resume. (Anything inside the reducer still uses
`state.rng`; this is outside it.)

`scheduleNextTurn` reads `tempoMs` from the seat's persona instead of the
single global `botDelayMs`, which alone makes three bots feel like three
players.

### A3. Scores on the table

- Each opponent seat head gains a score chip next to the card-count badge
  (`state.scores[seat]`, plus the per-player phase number for
  contract-rummy — the one genre where "score" is a progression).
- The human gets a matching "you" plate at the hand's corner: icon-free,
  name + score, doubling as the anchor for Phase D's forfeit menu.
- Tapping any score (or the status bar) opens a **scoreboard overlay**:
  per-round history table derived from `roundOver` events in the log —
  same rows `showRoundSummary` already draws, all rounds, reusing its CSS.
- Games with no accumulated score (Crazy Eights single-hand) show no chips
  — the pack's `scoring.accumulate` already says which mode we're in.

---

## Phase B — The drag layer

The one genuinely new subsystem: `src/ui/dragController.js`. Everything
else in this pass consumes it.

### B1. Principle: drag is a second dressing of the same moves

A drag never constructs a move. On pickup, the controller sets the same
`selection` a tap would have set and asks `buildUiModel` for
`readyTargets` — the drop zones ARE that map. Drop on a ready target →
`performHumanMove(state, target)`; drop anywhere else → snap-back. The
invariant taps have ("the selection can never construct a move the engine
would refuse") transfers wholesale.

### B2. What is draggable

Per the ask, *any face-up card the player could ever pick up* — not just
currently-legal ones:

- every card in the human's hand;
- the face-up top of any zone the human plays from (`sourceTops` covers
  the legal ones; extend with tops of the human's own `playableFrom`
  zones even when no move is currently legal).

Cards with no legal move still lift and travel — and every drop snaps them
home. Exploration is free; commitment is validated. Opponent cards and
shared-pile interiors never drag.

### B3. Mechanics (pointer events, one implementation for mouse + touch)

- `pointerdown` on a draggable card arms after a small slop (6px) so taps
  keep working unchanged — **the tap path remains first-class and
  complete**; drag is an enhancement, which is also the accessibility
  posture (design doc §12: "full tap-only input path").
- On lift: the source node gets `visibility: hidden` — *this is the
  "reveals the card underneath" ask for free*, because the pile beneath
  re-exposes its next card — and a clone (same `cardArt` markup the flight
  layer already uses) tracks the pointer in `#fly-layer`.
- Ready targets highlight with the existing `pile-stack--ready` treatment;
  the target under the pointer gets a stronger hover ring.
- Drop on target: commit the move; the clone flies the last few px onto the
  pile via `landOn` — same landing as today.
- Drop elsewhere / Escape / pointercancel: `flyCard(clone, here, home)`
  zoom-back, then unhide the source. Reduced motion (`motionAllowed()`)
  short-circuits both to instant placement.
- Scroll discipline: `touch-action: none` only on card faces, so pans on
  felt still scroll on small screens.

### B4. Secrets stay secret

Two renderer fixes ride along:

- A zone with `visibility: 'top'` (Skip-Bo stock, discards) currently
  shows `DISCARD_DEPTH` *faces* under the top card. The under-cards must
  render as **backs** for zones where only the top is public. Own-hand
  and `visibility: 'all'` zones keep face history.
- While the top card of such a zone is mid-drag, the newly exposed next
  card renders face-down; it flips face-up only when the move commits and
  the re-render makes it the legitimate top. No peeking by half-dragging.

---

## Phase C — Hand & table ergonomics

### C1. Overlap layouts (zone-def vocabulary, not UI switches)

Zone defs gain one field the renderer honors everywhere:

```json
{ "id": "melds", "layout": "row", "overlap": "horizontal" }
```

- `overlap: "horizontal"` — cards stack left→right showing each card's
  top-left rank/pip corner (the vanilla renderer already draws corner
  indices, so the exposed sliver *is* the card's value).
- `overlap: "vertical"` — top→down columns, right for runs (Milestones)
  and won-pile ribbons.
- Set in template `defaultZones` per genre, overridable per pack — and
  since **variants are manifest patches**, a variant can flip a zone's
  overlap with zero new machinery (`"patch": { "zones.melds.overlap": … }`).
- CSS only: negative margins + `--overlap-index`; `buildPileNode` and
  `buildMeldStrip` gain one branch. Mini (seat-plate) copies use the same
  overlap at smaller scale, replacing today's count-only chips where space
  allows.

### C2. Sortable hand

Hand order is **presentation state, never engine state**. The engine's
zone array stays untouched (no event-log pollution, no determinism risk;
in P2P later, your hand arrangement is nobody's business).

- Sort modes per pack, persisted in settings: `auto` (deck `sortOrder`,
  today's behavior) · `suit` · `rank` · `manual`.
- A small sort toggle sits at the hand's edge; switching to any explicit
  sort from manual asks nothing — manual order is kept separately and
  restored when you switch back.
- **Manual = drag within the hand** (Phase B's controller with a second
  drop context: hand indices instead of zone targets). Order persists as a
  cardId permutation under the pack's settings key, pruned against the
  live hand every render (same discipline as `pruneSelection`); new draws
  append at the fan's near end.

### C3. Card & pile inspector (hover / long-press)

New `src/ui/inspector.js`, one floating panel:

- **Cards** (hand, pile tops, melds): name, rank/suit/color, point value
  *as this pack scores it* (via `handValue`'s selector logic on one card),
  effect text ("Wild — choose a color"), and tag notes ("penalty").
- **Piles**: label, count, capacity ("Build 2 · 7/12"), facing, and for
  the draw pile "recycles from discard when empty" when a reaction says so
  — the manifest already knows; the inspector just reads it.
- Triggers: `pointerenter` after 350ms on fine pointers; **long-press on
  touch** (500ms, cancelled by drag-slop so it never fights Phase B).
- **Label diet, honestly handled**: the always-on `pile-count` labels
  shrink to count-only badges; wordy labels move into the inspector on
  hover-capable devices. But hover does not exist on touch and tooltips
  are invisible to screen readers — so badges stay rendered, and every
  `aria-label` keeps carrying the full sentence it does today. The
  inspector *replaces the visual noise*, not the information.

---

## Phase D — Records: stats, head-to-head, forfeit

### D1. Match stats are computed from the log

The event-sourced payoff. New `src/stats/matchStats.js` (pure, node-clean,
testable):

```js
statsFromLog(pack, log) -> {
  perSeat: [{ moves, cardsPlayed, draws, discards,
              tricksWon, pointsTaken,          // trick-taking
              cardsShed, effectsPlayed,        // shedding
              meldsLaid, phaseReached, hits,   // contract-rummy
              stockCleared, buildPlays }],     // sequencing
  rounds: [...roundOver events],
  duration: { moves, rounds }
}
```

One generic counter pass plus a per-template enricher — templates already
know their own event shapes. Nothing is tallied during play, so the
feature cannot drift from the truth and costs zero code in the hot path.

### D2. Post-game stats panel

The game-over overlay grows a second section under the win message:
this game's stat lines (per-template: "Tricks won 5 · Points taken 3" /
"Cards shed 21 · Wilds played 2"), each seat named and iconed via the
roster, winner highlighted. One "More" disclosure shows the full
per-round table (same component as A3's scoreboard overlay).

### D3. Aggregate + head-to-head storage (extend storage.js, one door)

`recordResult` grows, staying inside the existing `Arcade.stats` per-pack
record:

```js
{ played, won, forfeits, streak, bestStreak,
  opponents: { [opponentId]: { played, won } } }   // 'bot:juniper' | 'peer:<deviceId>'
```

- `opponentId` is namespaced now so P2P slots in without a migration:
  bots are `bot:<rosterId>`, future peers `peer:<deviceId>` (the arcade's
  stable device identity, §17.4).
- "won" in `opponents` means *you beat them* (you placed ahead), so a
  multi-seat loss still records per-opponent outcomes.
- Read side: the game-over panel shows "3–1 lifetime vs Juniper 🦊"; the
  lobby tile's record line can later show best-rival flavor. Old records
  lacking new fields merge over `STATS_DEFAULTS` exactly as today.

### D4. Forfeit

- A menu on the table header (or the A3 "you" plate): **Forfeit game** →
  existing confirm-modal pattern → `recordResult(packId, { won: false,
  forfeit: true, opponents })` → `clearMatch` → lobby.
- Honest bookkeeping everywhere abandonment happens: the lobby's "Start
  over" on a match with **any human move made** routes through the same
  forfeit recording (the confirm text already warns; now the record
  agrees). A 0-move re-deal stays free — no stakes, no stat.
- Solo-only by construction today; in P2P the same action becomes the
  `bye` frame with bot-fill per §17.5 — the menu item is the seam.

---

## Phase E — Sound & the uno moment

### E1. Trick chime

Fleet policy holds (audio.js header): no synthesis in the game; the pack
is the sound.

- `js/soundpack.js` gains a `trick` cue — a small bright chime built from
  the existing element library (`pluck` + `cents` detune stack into the
  shared room reads as a bell without a new element; if it doesn't, the
  element belongs in the launcher library like `flex` did).
- `CUE_NAMES` gains `'trick'`; `playTrickTaken` plays it for neutral/good
  tricks and keeps the dull `invalid` thud for eating points — that
  contrast is working, only the shuffle-as-chime is wrong.
- The `shuffle` cue goes back to meaning only actual recycling.

### E2. Declare-uno, and catching those who don't — the mechanism

This is the "how could this be accomplished" item. The answer: **the
announcement system already in the engine, surfaced generically in the
UI, with persona-driven bot behavior.** No new engine concept.

What exists: manifests declare announcements (`wildfire`'s
`lastCardCall: { id, label: "Last card!", atHandCount: 1, penalty: {draw: 2} }`),
`applyAnnouncement` routes them, and the shedding template already
tracks the called/uncalled player var. Missing: any UI, and bot behavior.

**The window model** (all times host-wall-clock in P2P; local timers solo):

1. *Declaring*: when the human's play would leave them at `atHandCount`,
   the action bar shows a pulsing **"Last card!"** button (label straight
   from the manifest — the keyphrase is pack data, so a pirate pack can
   say "Avast!"). Declaring before or within a short grace after the play
   (~2s) sets the called flag via the normal announcement path.
2. *Vulnerability*: an uncalled player at `atHandCount` is vulnerable
   until their next turn begins (classic rule) — the engine var already
   distinguishes called/uncalled.
3. *Catching*: while any opponent is vulnerable, every other player gets a
   **"Catch!"** affordance on that seat's plate. First claim wins; the
   penalty (`draw: 2`) applies through the same announcement pipeline.
4. *Racing*: solo is a single timeline — trivial. In P2P, claims are
   proposals; the host stamps `seq` and the first one in the log wins
   (§8's answer, verbatim — the event log is the arbiter, no clock sync
   needed).

**Bots make it a game** (Phase A personas):

- A bot reaching one card declares with probability `callReliability`
  (the announcement fires with its play, with a banner + cue so the human
  *hears* the declaration and learns the rhythm).
- When a bot forgets, it stays vulnerable — the human's Catch button is
  live. When the *human* forgets, each bot rolls `catchAttention` after a
  persona-scaled delay (0.8–2.5s): fast bots punish, sleepy bots let it
  slide. The grace delay is what makes the mechanic fair rather than
  instant-loss.
- Both directions produce banners via the existing `showBanner` tones:
  catching is `good`, being caught is `bad`.

**Generality**: the UI renders *any* manifest announcement whose window
is open as a labeled button (action bar for self-announcements, seat
plates for targeted claims like WD4 challenges). "Uno" is just the first
customer; the Spades-bidding future gets the surface for free.

---

## Sequencing & why this order

```
A (identity, scores)  → nothing depends on it, everything displays it
B (drag layer)        → the big rock; C2 and E2 consume it
C (ergonomics)        → C2 needs B; C1/C3 independent
D (records)           → D2 displays A's roster; log-stats independent
E (sound, uno)        → E2 needs A's personas; smallest engine surface
```

Each phase ships alone and leaves the game strictly better. B is the only
one with real interaction risk; it lands mid-plan with A already proving
the roster/persona seams.

## Testing per phase

- **A**: roster determinism (same seed → same bots) in `tests/`; persona
  weights unit-tested against a fixed move list.
- **B**: the drag *model* (pickup → candidate targets) is a pure function
  over `buildUiModel` output — unit-test it headless; pointer choreography
  gets a manual pass on touch + mouse + reduced-motion.
- **C**: hand-permutation pruning tests (the `pruneSelection` disciplines,
  applied to order); overlap is CSS, verified visually per pack.
- **D**: `statsFromLog` golden tests replaying stored fixture logs — the
  same fixtures `tests/replay.test.js` uses; storage merge tests for old
  records.
- **E**: announcement windows as pack rule-tests (`announce` assertions
  already exist in the test schema); `simulate.mjs` sanity run confirming
  personas neither stall nor blow up game length.

## Cross-cutting rules (the checklist for every PR in this pass)

1. Names and labels render via `textContent` / roster data, never markup.
2. No UI path constructs a move; drags, buttons, and catches all pass
   through `enumerateLegalMoves`/`validateMove` like taps do.
3. Presentation state (hand order, selection, drag) never enters the
   event log; log-derived data (stats, scoreboards) is never tallied
   shadow-side.
4. Tap-only play remains complete; drag and hover are enhancements.
5. Reduced motion collapses every new animation to instant placement.
6. Anything persisted goes through `src/arcade/storage.js`, inside the
   existing namespace.
