# Lobby & multi-table plan

The plan for a game-select lobby, resumable per-game tables, and the visual
pass that goes with it. This is the **solo** lobby — pick a pack, walk away
from a table, come back to it. It is deliberately not the Phase 8 multiplayer
lobby (ARCADE_ENHANCEMENTS.md §8.2), but §"Relationship to Phase 8" below
records where the two touch.

**Status: implemented** (branch `lobby-and-visual-refresh`). What the
build changed from this plan is recorded in §"What changed in the build"
at the end — the plan above is left as written so the two can be compared.

## What exists today

- One resumable match, stored under a single `activeMatch` key
  (src/arcade/storage.js). Starting any other pack silently discards it —
  `openFromStorage` treats a stored match for a *different* pack as
  non-resuming and `startGame` overwrites the key.
- No game-select UI at all. The pack comes from `?pack=` → stored
  `lastPack` → default, and boot drops you straight onto the table.
- The table UI is functional but visually spare: flat felt, text-only seat
  labels, no travel animation when a card is played, a bare text log.

## Goals

1. **A lobby is the front door.** Boot lands on a screen that shows every
   pack, and the player chooses.
2. **Walking away from a solo game is safe.** Leaving the table (to the
   lobby, or closing the app) freezes the match; re-entering resumes it
   exactly where it left off.
3. **Multiple solo games in flight** — one per pack. A Hearts table and a
   Crazy Eights table can both be waiting.
4. **Only the open table advances.** A match that is not on screen is data,
   not a process. No bot plays a card in a game you are not looking at.
5. **The whole thing should look like somewhere you'd want to sit down.**

## Non-goals (this pass)

- Multiple simultaneous tables *of the same pack*. See §"Storage model" for
  why one-per-pack is the right v1 and how the design extends.
- A variant/seat-count picker on "new game" (Phase L4 below).
- Multiplayer anything.

---

## Storage model

### Decision: one saved table per pack, in `Arcade.state`

Replace the single `activeMatch` key with a **per-pack key**:

```
arcade.v1.cardstock.match.<packId>
```

payload unchanged — the `serializeMatch()` seed+log form
(src/engine/replay.js), which already records `packId`, `variants`,
`savedAt`, and whose `log.length` gives a move count for free.

Why not `Arcade.store` (the stubbed `matchArchive` seam)?
ARCADE_ENHANCEMENTS.md Decision 3 still holds: `Arcade.state` is synchronous
— which the onSuspend flush contract (§6b) effectively requires — and no
catalog app has exercised `Arcade.store` end-to-end yet. Five packs × a
few KB of log is nothing against the state quota. The `matchArchive` stub
stays exactly as it is; if "several tables of the same pack" or a replay
browser ever becomes real, that work adopts the store and inherits these
key names (`STORE_NAMES.matches`).

One-per-pack also matches the lobby's mental model: each game has *its*
table, either fresh or waiting. A saved-games file manager is a much worse
screen than "your Hearts game is where you left it."

### storage.js changes

- `saveMatch(state)` / `loadMatch(packId)` / `clearMatch(packId)` become
  per-pack (key = `match.<packId>`; `packId` already charset-validated).
- New `listMatchSummaries()`: for each known pack id, read the key and
  return `{ packId, savedAt, moves: log.length, seats }` or null. Reading
  five small keys synchronously at lobby-open is fine; **no replay happens
  in the lobby** — rehydration stays a table-entry cost.
- **Migration**, one-shot at boot: if legacy `activeMatch` holds a
  replayable payload, write it to `match.<payload.packId>` and remove the
  legacy key. Ship the fallback read for one release, then delete.
- `registerStorageErrorHandler` currently special-cases the `activeMatch`
  key for its toast copy; switch to a `match.` prefix test.
- `lastPack` survives, but demoted: it no longer auto-launches a table, it
  only tells the lobby which card to feature (§UX). Still `sync: true` —
  "what I was playing" should follow the player across devices. Whether the
  match payloads themselves should sync is a real question (they'd make
  cross-device resume work) — leave them local this pass, matching today's
  behaviour, and revisit with quota numbers in hand.

## Screen flow

Two screens in one document, toggled by a tiny router in `src/main.js` —
no URL routing (launcher deep links are `#app=cardstock` and can't carry a
query; there is nothing to deep-link *to*).

```
boot ── ?pack= present ──────────────► TABLE (that pack; resume-or-new)
  │
  └─ otherwise ───────────────────────► LOBBY
                                          │ tap a game card
                                          ▼
                     ┌────────────────► TABLE
                     │                    │ back button / game over → "Lobby"
                     └────────────────────┘
```

- **`?pack=` keeps its straight-to-table meaning.** It is the dev/test/CI
  entry (§13 acceptance, tools/serve.mjs workflows) and existing behaviour;
  a plain visit gets the lobby.
- **Entering a table:** if `match.<packId>` exists and rehydrates, resume
  it (existing `openFromStorage` logic, now parameterized by pack); else
  deal fresh. The corrupt-log fallback (clear and start fresh) is unchanged.
- **Leaving a table** (back button, or game over → "Lobby"):
  `cancelBotTurn()`, `flushMatch()`, drop `liveState`, bump `epoch`, show
  the lobby with summaries re-read. The epoch bump is what guarantees a
  bot-turn timer already in flight cannot touch a match after its table
  closes — same mechanism "Play again" uses today.
- **Game-over overlay** gains a second button: *Play again* / *Lobby*.

### The "only the open table advances" invariant

This is structural, not policed: there is exactly one hydrated `liveState`,
bot turns are scheduled only by `scheduleNextTurn` against it, and both
table-exit paths cancel the timer and bump the epoch. While the frame is
suspended, `Arcade.session` timers freeze (§6c), so a backgrounded table
doesn't advance either. A match saved mid-bot-turn is not a special case:
the save lands after every applied move, and `adoptMatch` re-schedules the
bot on resume — the bot simply takes its turn when the table reopens.

State it in a comment where the router lives, because Phase 8 will need the
opposite for shared tables (host-wall-clock timers) and the difference must
stay deliberate.

## Lobby UX

### Layout

A single responsive grid of five **game cards** on the same felt as the
table — the lobby is the card room, not a separate app. Header: a
hand-authored SVG wordmark ("CARDSTOCK", drawn in-repo like everything
else — a webfont would be a third-party asset and the README forbids those).

Each game card is styled as a physical object on the felt — a table mat
with the pack's accent colour — carrying:

- **A fan of 3 real cards** from that pack's deck, rendered by
  `renderCardFaceSvg`. Real assets, zero new art, and each pack instantly
  looks like itself (Hearts fans court cards, Wildfire fans its colours).
  Picks are deterministic (manifest-listed or first-N of the deck) so the
  lobby doesn't shimmer between visits.
- **Name + genre chip** (genre label derived from `manifest.template`:
  Shedding / Trick-taking / Rummy / Sequencing) + a one-line **tagline**.
- **Record line** from `readStats`: "won 4 of 11".
- **State ribbon** when `match.<packId>` exists: "In progress · 23 moves ·
  2h ago" (relative time from `savedAt`).

### Interaction

- **Tap the card** → the one obvious action: resume if in progress, deal
  fresh if not. The whole card is one `<button>` with an aria-label that
  carries the state ("Hearts — in progress, resume").
- **In-progress cards** get a small secondary "Start over" affordance
  (distinct hit target, not a long-press — long-press is undiscoverable and
  fights iOS Safari). It confirms before discarding, because it destroys a
  live match: "Abandon your game? 23 moves will be lost."
- **The last-played in-flight game is the featured card** — first in the
  grid with an accent glow, so the "I opened the app to keep playing" path
  is one tap on the biggest target. Grid order is otherwise fixed
  (catalog order), because a grid that reshuffles itself punishes muscle
  memory.
- Launcher settings apply as on the table: theme (both palettes), font
  scale (all chrome in rem), reduced motion (no fan/hover animation).
  Handedness has no side to flip in a centered grid.

### Discoverability of "the lobby exists"

The table's status bar gets a **Lobby button** (house glyph, left side;
flips with handedness like the Draw button). Game-over offers it too. Those
two plus lobby-first boot cover every path.

## Pack manifest additions

Additive, optional fields (schema/manifest.schema.json):

- `tagline` — the one-liner on the game card ("Shed your hand, eights are
  wild").
- `accent` — a CSS colour for the mat/ribbon, validated by the same
  conservative colour regex main.js already uses for choice buttons (§7b:
  manifest values reaching styles stay constrained).
- `heroCards` — optional array of card ids to fan; defaults to first three
  of the deck.

The lobby needs to enumerate packs, and nothing client-side can list a
directory: add **`packs/index.json`** (bare array of pack ids), plus a
repo-gates test asserting it matches the `packs/` directory exactly — the
same pattern that keeps other repo facts honest. The five manifests are
fetched in parallel at lobby-open (small, SW-precached; a manifest that
fails to fetch renders a card that says so rather than sinking the lobby).

## Table visual refresh

The complaint is fair: the table reads as a wireframe on green. The pass,
in rough order of effect per effort — all colours through the existing
custom-property vocabulary, all motion behind the existing reduced-motion
gates, both themes:

1. **A wood rail.** A rounded border-frame around the play area (CSS
   gradients, no assets). This one change makes it a table instead of a
   viewport.
2. **Card flight.** A played card travels from the hand to the discard
   pile (clone-and-animate on the already-rendered SVG, ~250ms). Draws
   travel from the pile to the hand. This is the single highest-value
   animation in a card game and we currently have none of it.
3. **A discard pile with history.** Render the top 3 discards fanned with
   small rotations, seeded from the card's log seq so re-renders are
   stable. The pile stops looking like a slide viewer.
4. **Seat presence.** Replace the bare "Bot 1 (5)" text with a chip:
   generated SVG avatar (initial on an accent disc — drawn in-repo),
   name, count badge; active seat gets a ring plus the existing glow, and
   a subtle "thinking" pulse while the bot's timer runs.
5. **Draw pile depth** — two offset card-back edges behind the top card,
   so a full pile looks full.
6. **Status bar as scoreboard** — the game name moves in here from dead
   air; log line restyled as a transient toast row rather than a floating
   sentence.
7. **Game-over moment** — the overlay gets the winner's cards fanned
   behind the message; a win plays a small card-cascade (motion-gated).

Nothing here touches the card *faces* — the fixed-across-themes rule and
the px-inside-viewBox sizing both stand.

## Implementation phases

**L1 — storage (invisible).** Per-pack keys + migration + summaries in
storage.js; error-toast prefix; tests for migration and summary reading
(Arcade.state stubbed with a Map, as the storage seam permits). Ship dark.

**L2 — the lobby, functionally.** `packs/index.json` + repo-gate;
`src/ui/lobby.js` (render + interactions) and lobby DOM/CSS; router in
main.js; table controller extracted to `src/ui/table.js` mostly verbatim
so main.js is boot + router; Lobby buttons (status bar, game over);
`Arcade.ui.setTitle` per screen. **Verification gate:** `npm test` plus
`npm run acceptance` against the real launcher — the §13 runner's
save/resume and suspend checks must pass with lobby-first boot; if the
runner assumes plain-URL boot lands in a match, the fix is discussed with
the launcher repo, not hacked around here.

**L3 — the look.** Manifest `tagline`/`accent`/`heroCards` + schema;
lobby art direction (mats, fans, ribbons, wordmark); table refresh items
1–7; sound: entering a table plays the existing deal/shuffle cues, the
lobby itself stays quiet.

**L4 — later, explicitly out of scope now.** New-game sheet (variants,
seat count — the first UI for variants, which today only tests exercise);
`Arcade.store` adoption for multi-table-per-pack and a replay browser
(the `matchArchive` seam exists for exactly this); syncing match payloads
for cross-device resume.

L1 and L2 land together or not at all from the player's view; L3 can ship
in slices.

## Relationship to Phase 8

The solo lobby becomes the natural place a future "host / join" affordance
lives, and per-pack keys were chosen partly because a multiplayer match
will *not* live under `match.<packId>` (it has a party id). Nothing in
this plan pre-builds Phase 8, but two seams are kept honest: the table
controller keeps its single-entry move funnel (`afterMove`), and the
router comment records the solo-only timer assumption §8.2 will replace.

## Test impact summary

- New: migration test, summary-listing test, `packs/index.json` repo-gate.
- Updated: none of the engine/replay/pack suites — the payload shape is
  untouched (`MATCH_FORMAT_VERSION` stays 1).
- Acceptance: re-run required at L2 (see gate above); the §13 checklist
  itself is launcher-owned and not edited here.


---

## What changed in the build

The plan survived contact largely intact. Five things moved:

1. **`heroCards` are display descriptors, not deck card ids.** The plan had
   the lobby fan real cards from each pack's deck, which meant loading five
   decks to draw a grid. They are instead inline `{rank, suit, color, effect}`
   objects in the manifest, drawn straight by `renderCardFaceSvg` — so the
   lobby renders from manifests alone and never loads a deck. Same picture,
   none of the cost.

2. **`packs/index.json` is `{ "packs": [...] }`, not a bare array**, and
   `tools/pack-test.mjs`'s `listPackIds()` had to start filtering to
   directories — a file in `packs/` had until then always been a pack, and
   without the filter `index.json` read as a sixth pack and broke every
   suite that enumerates them.

3. **Four of the five packs were not safe to offer.** Hearts threw
   `Unknown zone address: draw` the moment the lobby let anyone open it: the
   table assumed a shedding-shaped board. `renderPiles` now asks the state
   which zones exist, hides the draw slot when there is no stock, and renders
   a `trick` (spread, not stacked) when there is no discard. The three
   templates the table still cannot play to completion are labelled
   **Preview** in the lobby via `FULLY_PLAYABLE_TEMPLATES`, which lives in
   `src/ui/table.js` because it is a fact about the UI, not about the packs.

4. **The Draw button moved onto the draw pile.** Reaching for the stock is
   how drawing works at a table, the pile lighting up is a better "you are
   stuck" cue than a button enabling in the corner, and the card's flight now
   starts from the thing the player actually pressed.

5. **Three pre-existing rendering bugs were fixed on the way**, all of them
   newly obvious once cards were shown large on lobby tiles:
   `.card-face svg` matched a nested `<svg>` that never existed, so no card
   on the table had its drop shadow; `.card-face--red` painted *every* heart
   and diamond in a standard deck as a solid red slab, because suited cards
   carry a colour too (now gated on `--painted`); and a card whose only
   identity was "wild" rendered as a blank white rectangle in Milestones and
   Stockpile.

The `?pack=` deep link keeping its straight-to-table meaning turned out to
matter more than expected: it is what lets the §13 acceptance runner reach a
table at all. All 12 checks pass with lobby-first boot.
