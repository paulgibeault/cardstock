# Feedback Pass Plan

Playtest feedback from 2026-08-05, triaged against the code. Ten items,
organized into three workstreams: **correctness bugs** (small, independent,
do first), **game feel** (the experience improvements), and **platform
features** (house rules, rules dialog, many-player layout). Each item below
records the root cause found in code, the fix approach, and tests.

## Triage summary

| # | Item | Type | Size | Phase |
|---|------|------|------|-------|
| 1 | Wildfire: Call doesn't re-trigger at one card | Bug | S | 1 |
| 2 | Wildfire: wild starter allowed (reflip instead) | Bug | S | 1 |
| 3 | Milestones: skip cards accepted in melds | Bug | S | 1 |
| 4 | All: bot card lands low, then snaps | Bug | S | 1 |
| 5 | Wildfire: celebrate reverse/skip/draw cards | Feel | M | 2 |
| 6 | Milestones: meld tray persists across turns | Feel | M | 2 |
| 7 | All: leave option at end of game / pacing | Feel | S | 2 |
| 8 | All: rules dialog generated from the pack | Platform | M | 3 |
| 9 | Wildfire: house rules / variants UI | Platform | M–L | 3 |
| 10 | All: single-bar hand, minimized seats | Platform | M | 3 |

Three findings adjusted the framing:

- **The match does end** — Wildfire deals hands until someone crosses 500
  (`evaluateGameOver`, `src/engine/scoring.js:116`), and there is already a
  game-over panel with **Play again** and **Lobby** buttons
  (`src/ui/panels.js:187`). The real complaints underneath "continues
  indefinitely" are (a) 500 points is a *long* session, and (b) there is no
  way to leave or end a match from the table mid-match (the Forfeit button
  was removed in the chrome pass). Item 7 addresses both.
- **The hand already never wraps** — it's a single-row fan that compresses
  (`layoutHand`, `src/ui/table.js:1187`). Item 10 is really about the
  *opponent* seats, and only bites once seat count is configurable (it is
  hard-coded to 3 at `src/ui/table.js:84`), so it rides with the new-game
  sheet in phase 3.
- **The house-rules machinery already exists** — manifests declare variants
  with patches, the loader applies them, and persistence/replay pin them
  (`src/engine/packLoader.js:10`, `src/engine/replay.js:66`). What's missing
  is the lobby UI to pick them (the deferred "L4 new-game sheet",
  `LOBBY_PLAN.md:256`) and template support for two declared flags.

---

## Phase 1 — Correctness bugs

Small, independent, each shippable as its own commit with a rule test.

### 1. Call ("Last card!") doesn't re-arm — reproduced

**Root cause.** `refreshCallFlags` (`src/templates/shedding.js:151-161`)
clears a seat's `__last-card-callCalled` flag only when the hand grows
**above** `callCount + 1` (i.e. above 2). Wildfire's `drawWhenStuck: 1`
makes the 1 → 2 → 1 cycle common, and 2 is not > 2, so the flag survives.
After one declaration a player is immune to challenges for the rest of the
round, and `enumerateAnnouncements` never re-offers the button.

**Fix.** The `count+1` window exists so a legitimate pre-emptive
declaration isn't wiped the instant it's acted on (see the comment at
`shedding.js:136-150`) — don't just lower the threshold. Instead record
the hand size at declaration time (or a monotonic "descent id") and
invalidate the flag whenever the hand *grows* while the flag is held.
Growth means the declaration's descent ended; the next descent to one card
must re-declare.

**Tests.** Add the 1→2→1 cycle to
`packs/wildfire/tests/rules.test.json`: after draw-back-to-2 and
play-back-to-1, the seat must be vulnerable again and `announce` must be
offered. Keep the existing "declaration lapses at 3" test green.

**Follow-on (optional, same file):** `isVulnerable` never expires on a turn
boundary, contra `UX_PASS_PLAN.md:344` ("vulnerable until their next turn
begins"). Decide whether to implement the classic expiry while in here.

### 2. Wild starter — reflip until non-wild

**Root cause.** `setup()` (`src/templates/shedding.js:296-303`) flips the
top card with no guard; the comment acknowledges it. Measured over 400
deals: **7% start on a wild**, which leaves `activeColor` undefined and
makes every non-wild card illegal — the table grinds through draws until
someone finds another wild. Additionally **18% start on an action card**
whose effect silently doesn't fire.

**Fix.** In `setup()`, flip-and-bury until a non-wild appears (bury the
wild back into the draw pile at a random position via the seeded RNG so
replay stays deterministic). Decide separately whether action-card
starters should fire their effect (classic Uno: yes) — cheapest is to
also reflip on *any* effect card; truest to the source game is to apply
the starter's effect. Either is fine; pick one and test it.

**Also while in `setup()`:** it never resets `turn.seat` or
`state.direction`, so a re-deal inherits both from the previous round
(round N+1 starts on the seat that just won, in whatever direction the
last reverse left). Reset both.

**Tests.** Seeded deal where the top of the deck is a wild → assert the
starter is non-wild and `activeColor` is defined; assert direction/turn
reset on round 2.

### 3. Milestones: skips must not enter melds

**Root cause — three layers, all currently open:**

1. **Validation hole:** `checkMeldValues`' set branch
   (`src/templates/contract-rummy.js:203-208`) only requires equal
   `meldValue`s, and a skip's meld value is the *string* `"skip"` — so
   three skips are a **legal set(3)** today, and `assignWilds` will even
   pin a wild to rank "skip".
2. **No pack vocabulary:** nothing in the manifest/schema can say "this
   card can't be melded" (`discardPickupForbidden` is the only skip rule).
3. **No UI gate:** in `rummy-meld` mode every hand card is selectable
   (`src/ui/interaction.js:177`), so skips tap into the tray and the only
   feedback is that "Lay down" silently never appears.

**Fix, in the same order:** make the set branch require real (numeric or
domain) ranks; add a pack-level rule (e.g. `rules.meldForbidden:
["tag:skip"]` mirroring `discardPickupForbidden`) enforced in
`checkMeldQuota`/`findMeldForItem` and the `layDown`/`hit` validators;
filter ineligible cards out of `ui.handSelectable` so they can't be staged
at all. The engine-side rule is the load-bearing one (bots use
`findContractLayDown` and must not lay skip-sets either).

**Tests.** Three skips + contract 1 → `layDown` rejected; hit onto any
meld with a skip → rejected; bot search never emits a skip meld.

### 4. Bot play flight lands low, then snaps

**Root cause.** For bot plays, `animateMove`'s `from` rect is the seat's
`.mini-hand` **row** (`src/ui/table.js:1706-1709, 2336-2338`) — ~118×39px
— but the flying clone renders at width×1.4 aspect (~165px tall). The
centre-to-centre math in `flyCard` (`src/ui/flight.js:105-107`) uses the
row's 39px height, so the clone's true centre flies ~60px low; the real
card was already rendered in place, so when the clone lands and is
removed the card "snaps" up. The codebase already has the corrective
helper — `cardSizedRect` (`src/ui/table.js:1717-1726`, with a comment
describing exactly this failure) — applied to `to` rects for draws, hits,
and trick gathers, but never to `from` in the playCard/discard branch
(`src/ui/table.js:1760-1767`).

**Fix.** Normalize `from` through `cardSizedRect` in that branch. Two
cheap hardening guards while there: `landOn` holds a reference to a pile
node that a mid-flight re-render can detach (`src/ui/flight.js:132-135`) —
re-query or no-op safely; and fast bot cadences can start a second flight
inside the first (min think 240ms vs 260ms flight,
`src/players/roster.js:66`) — either floor the bot delay above flight
duration or let a new flight cancel the prior one's `landOn` cleanly.

**Tests.** Visual — verify in the browser preview (bot plays from top
seats land square on the discard).

---

## Phase 2 — Game feel

### 5. Celebrate action cards (reverse / skip / draw 2/4)

**Root cause.** `applyEffect` (`src/templates/shedding.js:163-203`) emits
**no events** — the shedding template only ever emits `announced`/`caught`
— so the UI has nothing to react to. All action cards get the same
generic flight, generic sound, and the log line "\<Name\> played."
There is also no direction-of-play indicator and no active-colour chip
anywhere on the table.

**Plan.**

1. **Engine:** emit derived events from `applyEffect` — `skipped {seat}`,
   `reversed {direction}`, `drewPenalty {seat, n}`, `wildPlayed {color}`.
   This is the established channel (`state.events`, transient, replay-safe
   — see `IMPLEMENTATION_NOTES.md:171`), and `laidDown`/`hit` from contract
   rummy already sit there un-consumed, so the consumer below picks those
   up for Milestones for free.
2. **UI consumer:** extend `afterMove` (`src/ui/table.js:1979`) alongside
   `trickWon`: banner via `showBanner` (already themed), a distinct sound
   cue per effect family, `.zone-celebrate`-style pulse on the affected
   seat (skipped seat, penalized seat), and per-effect log verbs. The
   prose already exists in `effectText` (`src/ui/describe.js:49-63`).
3. **Persistent chrome:** a direction indicator (flips on `reversed`) and
   an active-colour chip near the discard (updates on `wildPlayed`) —
   today the only colour signal is the discard art itself.
4. **Pack background effects — yes, the seam exists.** `ui.felt` is
   declared in the schema and *set by two packs* (Wildfire and Hearts)
   but read by nothing. Honor it through the existing CSS-variable felt
   (`--felt`, `--felt-sheen` etc., `src/ui/table.css:20-27`), funneled
   through the `safeCssColor` allow-list (`src/ui/css.js`). Then add a
   small event-driven flourish layer (e.g. a brief felt pulse tinted by
   the played card's colour on draw-4) driven by the same events from
   step 1. Keep it CSS-only; respect the arcade's reduced-motion setting.

### 6. Milestones: meld tray persists; Lay down gating

**Root cause.** The staged meld is a module-global UI `selection` in
`table.js`, cleared on **every** applied human move
(`src/ui/table.js:2134`) — and since every turn ends with a discard, the
tray empties every turn. The tray is also hidden entirely when it's not
your turn (`handMulti` false → `renderStageTray` hides,
`src/ui/table.js:1063-1093`), and a drag-to-discard silently wipes the
staged set.

**Plan.**

1. Stop clearing `selection` on moves that don't consume the staged cards
   — clear staged ids only when those cards actually leave the hand
   (`pruneSelection` in `src/ui/interaction.js:58-63` already handles the
   cards-left-the-zone case; the blanket `selection = null` at
   `table.js:2134` is the thing to remove/narrow).
2. Keep the tray **visible off-turn** (read-only styling), so you can
   arrange your meld while bots play. `buildUiModel`'s early return when
   `acts === false` (`src/ui/interaction.js:129`) currently forces
   `handMulti: false` — let the staging affordance survive off-turn while
   keeping move affordances turn-gated.
3. **"Lay down" gating is already correct** — it appears only when it's
   your turn *and* `arrangeContract` says the staged cards exactly satisfy
   the contract (`src/ui/interaction.js:186-194`). No change needed; just
   verify it stays turn-gated after (2).
4. Optional polish: `arrangeContract` returns only `melds | null`, so the
   UI can't say *why* a staged set doesn't qualify. A richer return
   (per-item satisfied / unusable cards) would let the tray show progress
   instead of a button that silently doesn't exist. Nice-to-have; ship
   1–3 first.
5. If persistence across app restarts matters (it likely does — matches
   resume), store staged ids in the per-match UI state that already
   round-trips through `src/arcade/storage.js`.

### 7. End-of-match: a way out, and pacing

The game-over panel already offers **Lobby** vs **Play again**. What's
missing:

1. **A mid-match exit with intent.** Closing the table keeps the match
   resumable (that's the lobby invariant, working as designed), but
   there's no "I'm done with this match" on the table since Forfeit was
   removed. Add **"End match"** to the round-summary overlay
   (`src/ui/panels.js:72`) and/or the table menu — confirm-gated through
   the same `confirmAction` + `recordResult` contract the lobby's "Start
   over" uses (`src/ui/lobby.js:157-190`).
2. **Session length as a house rule.** Wildfire's 500-point target is the
   real "indefinite" feeling. Add a `target-score` (or
   `fixed-hand-count`) variant to the packs — the variant system already
   patches `rules.scoring` cleanly — so short sessions are a lobby choice
   once the phase-3 variants sheet lands. Cheap interim: surface "first
   to 500" in the round-summary header so the horizon is visible.

---

## Phase 3 — Platform features

### 8. Rules dialog, generated from the pack

**Today:** no help/rules surface exists at all. The generation
ingredients do: `effectText`/`describeZone` (`src/ui/describe.js`)
synthesize prose from pack structure, `describeContract`
(`src/ui/interaction.js`) explains contracts, manifests carry `tagline`
and per-variant `name`/`description` prose.

**Plan.**

1. Add an optional `howToPlay` prose section to the manifest schema
   (short markdown: objective, turn shape, scoring) — authored per pack.
2. Build the dialog as a sixth overlay panel following the `panels.js`
   pattern; compose it from: pack tagline + `howToPlay`, then
   **generated** sections — objective/scoring from `rules.scoring`, turn
   shape from the template, card effects from `effectText` over the deck's
   effect cards, contracts from `describeContract`, active variants (they
   are part of the match, `pack.activeVariants`).
3. Entry points: a "?" in the table chrome and on the lobby tile.
4. While in there: the overlay group has no focus trap or Esc handling
   (`index.html` hidden-div pattern) — worth a shared fix for all six
   panels.

### 9. House rules (Wildfire first)

**What exists:** the full variant pipeline — schema
(`schema/manifest.schema.json:229-244`), loader patches
(`src/engine/packLoader.js:10-39`), persistence + replay determinism
(`src/engine/replay.js:66-73`), and four declared Wildfire variants
(`stacking`, `jump-in`, `seven-zero`, `draw-to-match`) of which only the
last two are actually implemented by the template.

**What "house rules" looks like here:**

1. **The L4 new-game sheet** (`LOBBY_PLAN.md:256`): tapping "New game" on
   a lobby tile opens a sheet with variant toggles (from
   `manifest.variants`, with their `name`/`description` prose) and a seat
   count picker (from `manifest.players.min/max` — today `SEAT_COUNT = 3`
   is hard-coded at `src/ui/table.js:84`). Pass the selection through
   `fetchPack(packId, variants)` (`src/ui/packSource.js:68`) — the
   parameter already exists and is simply never supplied.
2. **Show active variants on the table** (a chip row in the overlay —
   promised in `CARD_PLATFORM_DESIGN.md:491`), and in the rules dialog.
3. **Implement the dead flags:** `rules.stacking.drawN` and
   `rules.jumpIn` are declared, schema'd, and read by nothing. Implement
   stacking first (most-loved variant, purely template-side); jump-in
   needs an out-of-turn input surface — the announcement pipeline
   ("announcements are moves", `IMPLEMENTATION_NOTES.md:233`) is the
   precedent. Also either implement or un-declare `challengeable` on the
   wild-draw-4, and fix the latent `swapHands choose:"player"` crash in
   `promptChoice` (`src/ui/table.js:2089`) before any variant exposes it.
4. New house rules then become one-line manifest patches: target score
   (item 7), draw-to-match, seven-zero — the sheet renders whatever the
   pack declares.

### 10. Seat layout: single bar, minimized inactive seats

**Today:** the human hand is already a strict single row (compressing
fan, floor `0.17 × card width`, then breakpoint shrink — it cannot wrap).
Opponent seats render full plates in a wrapping flex row
(`src/ui/table.css:325`), which with >3 seats would stack rows and eat
felt — but >3 seats is unreachable until item 9's seat picker lands, so
this ships with/after it.

**Plan.**

1. Keep the hand's single-row guarantee as-is; if the compression floor
   is hit with huge hands (Milestones round 10), lean on the existing
   peek/scrub affordance rather than wrapping.
2. Add a **compact seat mode**: when seats × plate width exceeds the row,
   collapse non-active seats to avatar + name + count badge (no mini-hand
   fan, no pile strip), keeping the active seat full-size. Pure
   CSS-class switch driven by a container query or the existing
   `ResizeObserver` pattern (`src/ui/table.js:1223`).
3. Seats with table presence (Milestones melds, Stockpile personal piles)
   need their pile strip reachable when compacted — tap-to-expand a
   compacted seat, reusing the inspector pattern.

---

## Suggested sequencing

- **Phase 1** is four independent S-sized fixes — one PR each, or one PR
  with four commits; each carries a rule test (except the visual flight
  fix, verified in preview).
- **Phase 2** items are independent of each other; item 5 (events) first
  since its event vocabulary is reused by celebrations everywhere and by
  the Milestones `laidDown`/`hit` reactions that are already emitted.
- **Phase 3**: item 8 (rules dialog) is independent and can go any time;
  item 9 unlocks item 7's pacing variant and item 10's many-player case,
  in that order: new-game sheet → variant chips → stacking → jump-in.
