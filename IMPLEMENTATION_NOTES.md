# Implementation notes (milestone 1)

Status snapshot after the first implementation pass, per `CARD_PLATFORM_DESIGN.md`
§15 milestone 1 ("Engine core + shedding + Crazy Eights", expanded here to cover
all four templates and all five launch packs in one pass).

## What's built

- **Engine core** (`src/engine/`): seeded RNG, card/deck model with `forEach`
  expansion, selector matching, the zone/state container with cascading
  zone-lifecycle reactions, the move pipeline (validate/apply/announce),
  scoring strategies, the pack loader (manifest + deck + variant patches +
  `cardTags` + `rules.effects` overrides), and a generic bot (enumerate via
  the template, score via `botHeuristic`, play the best).
- **All four genre templates** (`src/templates/`): shedding, trick-taking,
  contract-rummy, sequencing.
- **All five rule-test files pass**: `node tools/pack-test.mjs --all` — 38/38
  assertions across crazy-eights, wildfire, hearts, milestones, stockpile.
- **Headless bot-vs-bot simulation** (`tools/simulate.mjs`), scoped to
  round-completion (not full multi-round matches — see below).
- **A minimal vanilla table UI** (`index.html`, `src/main.js`,
  `src/ui/`) — playable solo vs. bots, verified end-to-end with a real
  headless Chromium session (Playwright) driving a full Crazy Eights hand
  to completion with zero console errors.
- **Arcade integration (added 2026-08-04, `ARCADE_ENHANCEMENTS.md` v2
  Phases 0–7)** — SDK boot behind `await Arcade.ready`; all state under
  `arcade.v1.cardstock.*` through one adapter (`src/arcade/storage.js`);
  a resumable match persisted as **seed + event log** and re-hydrated by
  reducer replay (`src/engine/replay.js`); managed lifecycle and session
  timers; launcher theme / font scale / handedness / reduced motion; the
  fleet CI caller, staging and artifact verification; a PWA; and a
  graph-cue sound pack. All 12 automated §13 acceptance checks pass.
  Multiplayer is not built — see the note at the end.

## Process note: three templates were built by parallel agents

Trick-taking, contract-rummy, and sequencing were implemented by three
agents working concurrently against the already-proven engine core and
the shedding template as a reference pattern, each targeting their pack's
rule-test file as the acceptance bar. All three came back with every
assertion green and no engine-core edits. Integration afterward surfaced
and fixed three real cross-cutting bugs the isolated rule-tests couldn't
catch (see below) — this is exactly the value headless simulation is for.

## Bugs found and fixed via simulation (not caught by rule tests)

1. **Reaction cascades didn't propagate** (`src/engine/state.js`). The
   original `checkReactions` only re-evaluated the single zone a `moveCards`
   call had just touched. A `moveAll` reaction (build pile completes →
   dumps into `recycled`) never triggered a re-check of `zoneEmpty:draw`
   watching a *different* zone, even though `recycled` gaining cards is
   exactly what that reaction needs to know. Stockpile would permanently
   deadlock with `draw: 0, recycled: 12` and no way to notice. Fixed by
   replacing the single-zone check with a fixed-point sweep: after every
   mutation, re-check every reaction against every zone until nothing
   fires. Cheap at this scale (a handful of zones and reactions per pack).
2. **`contract-rummy`'s `botHeuristic` crashed on `layDown` moves** —
   it unconditionally read `move.cards[0]`, which `layDown` moves don't
   have (they carry `choice.melds` instead). Trivial once simulation
   exercised the path the rule tests never did (rule tests never ask a
   bot to choose among enumerated moves).
3. **Hearts' passing phase could stall a bot-driven table.** Passing is a
   simultaneous-commit phase (design doc §4): `turn.seat` doesn't advance
   until every seat has submitted a pass, so a driver that only ever asks
   `state.turn.seat` for its next move gets stuck asking a seat that has
   already committed. Fixed generally, not by special-casing "pass phase"
   in the driver: templates may now export an optional `actingSeats(ctx)`
   hook (defaults to `[turn.seat]`) that `simulate.mjs` consults instead.
   `trick-taking.js` uses it for the pass phase.

Also added (integration-level, after the parallel agents' work landed):
`contract-rummy`'s bot didn't lay down or hit at all — draws/discards
only. Added a greedy contract-satisfying meld search
(`findContractLayDown`) and a validateMove-backed hit enumerator
(`findHits`), plus a discard heuristic that keeps rank/color-mates instead
of just dumping high-value cards. `sequencing` (Stockpile) got a `pass` move
type for the one legitimate case where a seat has zero cards playable
anywhere and an empty hand — not a bug, just Stockpile's real "nobody can go"
edge case needing a defined action.

## Known limitation: `1000-sims-zero-stalls` bar is not met by two packs

The design doc's bar (§11) is that a pack "isn't done until 1,000 headless
simulations complete without a stall." At 1000 games, 4 seats:

| Pack | Completed | Notes |
|------|-----------|-------|
| crazy-eights | 1000/1000 | clean |
| wildfire | 1000/1000 | clean |
| hearts | 1000/1000 | clean |
| stockpile | 910/1000 | see below |
| milestones | 306/1000 (12,000-move cap) | see below |

**Stockpile (91%)**: traced one stalled seed directly. All four hands were
empty, `draw` and `recycled` were both genuinely exhausted, and none of
the four stock-tops or discard-tops matched any build pile's required next
card. This is a real, if rare, property of the pack's rules as specified —
Stockpile's manifest only recycles completed build piles back into the
shared pool; personal discard piles never feed back in. It is not an
engine or template bug (confirmed by direct trace). A house-rule fix
(reshuffle discard piles too, once draw+recycled are both empty) would be
a manifest-level design decision, not something to patch silently into the
engine.

> **TODO (issue #20, WS5.6) — the house rule is not yet expressible.** The
> intended fix is a default-on variant on `packs/stockpile/manifest.json` that
> recycles the personal discard piles once `draw` and `recycled` are both
> exhausted. The reaction vocabulary cannot say it today: `do: recycle` takes a
> single literal `from` zone, and the piles in question are `discard.<n>.<seat>`
> — four per seat, at a seat count the manifest does not know. A glob is
> supported in a reaction's `when` pattern but not in its `from`.
>
> Two honest ways forward, neither of them a silent engine patch: teach `from`
> the same glob `when` already understands (a small, general change to
> `applyReaction` in `src/engine/state.js`), or wait for the `logic.js` hook
> wiring §7 specifies. Until then Stockpile's completion rate is floored rather
> than gated — see `tests/simulate.test.js`.

**Milestones (31%)**: also traced directly — the hit mechanism itself is
correct (verified with a hand-constructed scenario: a matching card is
found and offered). The slowness is structural to greedy bot play: a
laid-down seat's hand only shrinks via a *hit* (a rank/color match onto an
existing meld); plain draw+discard is net-zero every turn. Early in a
round only a few melds exist on the table, so hit opportunities are
genuinely scarce, and a seat that can't complete its own contract (bad
luck on a 10-card hand, no reshuffle until next round) just cycles
forever. This is a bot-strategy quality gap, not a rules defect — real
contract-rummy groups experience slow first-contract rounds too, and normally shrug it
off because there's always a next round. My `simulate.mjs` deliberately
scopes to *one round* (see its header comment for why), which is the
right scope for catching rules deadlocks but understates how forgiving
the full multi-round game is.

**Recommended follow-up** (not done in this pass): a materially smarter
contract-rummy bot — discard toward what opponents' melds need, not just
what's isolated in your own hand — or extend the harness to simulate
several rounds per "game" so one unlucky round doesn't read as a stall.
Neither is a rules-correctness concern, so it was left for a dedicated
pass rather than rushed here.

## Arcade platform enhancements — shipped

The four additive `Arcade.peer` changes this repo was waiting on (E0–E3:
capability flags, targeted send, peer roster, message meta) are all in the
launcher SDK's documented capability list, alongside a later `peer.party`.
`ARCADE_ENHANCEMENTS.md` was rewritten as the Cardstock-side
implementation plan; its Appendix B keeps the E-labels resolvable for the
design doc's references.

## Multiplayer, and then tables (2026-08)

Phase 8 shipped, and then #43 rebuilt what it assumed. Both are designed in
full elsewhere — `MULTIPLAYER_PLAN.md` for the wire, `TABLES_PLAN.md` for
concurrency and lifetime — so this records only what a reader of the code
would otherwise get wrong.

**The host holds the only state.** Everything a client sends is a request; a
`propose` that is structurally perfect and arrives from the right seat is
still only a request, because legality is a question about a state the client
does not have. The host answers with the new view or a targeted reject —
there is no separate ack.

**A table is no longer the thing on screen.** This is the inversion worth
knowing about. `createTableHost` used to be handed
`liveState: () => tableContext()?.state`, so a hosted game existed only while
it was being drawn. It now belongs to a `TableSession`
(`src/match/tableSession.js`) held in a registry, and the felt *binds* to
whichever session is open and unbinds without ending it. A hosted table
nobody is watching keeps arbitrating, keeps playing bots headlessly, and is
persisted under `mpMatch.<tableId>`.

**Nothing a client says goes to the room (protocol v3).** `emote` and a joiner's
`bye` used to be broadcast, and a fellow joiner heard them only because the
launcher's hub forwarded frames between spokes. That forwarding is being removed
fleet-wide — these two frames were the entire fleet's use of it — so both are
targeted at the host now, which re-announces the emote (stamped with the
emoter's **seat**, resolved from the authenticated `fromDeviceId`, because after
mediation the *sender* of every emote a client sees is the host) and lets the
departure ride the `lobby` frame it already re-broadcasts on every seat change.
Two things fell out. `emote` and `bye` joined `HOST_FRAMES`, so a client holds
them to the same authenticity test as a view — before this, an emote was the one
frame a client took from a fellow joiner, and anybody in the party could burst
an emoji on somebody else's screen. And `src/match/client.js` lost its
`broadcast` door: a client speaks to exactly one device now, which is what §5 of
the plan always claimed. The version log is at the top of
`src/match/protocol.js`.

**A connection is not a table, so the game asks.** The launcher's parties are
gone and what replaced them is per-connection, per-game consent: two devices
stay paired forever, and a game between them is live only while both ends have
agreed to play *it*. So `peers()` can be empty with three devices connected, and
something has to propose. `knock()` (`src/ui/party.js`) is that something — one
function behind two doors. "Play together" calls it and hears the answer;
mounting the game calls it once, quietly, because a joiner has nothing to tap
(a table becomes visible only *after* a scope is open) and no deviceId to aim at
(with nothing open the roster is empty, which is exactly why
`Arcade.peer.invite()` takes no target). It self-guards on the roster, so
neither door can pester somebody already here, and it is feature-detected on
`peer.invite` — a launcher without the cap gets a sentence, never a hand-rolled
proposal of our own (`src/match/peerPort.js` explains why at length). There is
nothing to retry on afterwards: a game nobody has opened with us receives no
roster and no status change, so a device paired *after* the mount arrives as
silence and the tile's door is the answer for it.

What the pre-Phase-8 version of this section listed as missing:

- **Seat identity** is `(deviceId, localIndex)` now (`src/players/seats.js`),
  not a bare index. `SOLO_HUMAN_SEAT` and `SEAT_COUNT` survive in
  `src/ui/table.js` as *solo defaults* only.
- **Bot timers**: partly. An **unbound** hosted table drives its bots on the
  host's wall clock (`src/ui/party.js` → `createBotDriver`), which is what
  lets a backgrounded table keep playing. The felt's own driver reaches the
  same answer by a different road (#71): it is built once, before any match
  exists, so it takes `feltClock` and asks per timer — session time for solo,
  the host's wall clock for a shared table. Until that landed, a shared table
  the host was *looking at* scheduled its bots on a clock that freezes when the
  frame suspends, and the turn timer was no help because `waitsOn` never waits
  on a bot.

**Where the coverage is, and is not.** `src/match/` is well covered headlessly
(`tests/protocol.test.js`, `tests/twoSessions.test.js`, `tests/twoTables.test.js`).
`src/ui/party.js`, `table.js` and `lobby.js` have **no unit coverage** — every
bug the tables work turned up was found by driving the real thing, so changes
there want `npm run mp-acceptance` (three real launchers, nine scenarios) or a
browser probe against the live modules, not a green unit run.

## The preview packs became playable (2026-08)

The table learned the three genres it used to only display, and the engine
grew the two layers that work exposed:

- **A derived-event channel.** `state.events` is cleared per `applyMove`
  and carries what happened *inside* the move — `trickWon` (with the
  trick's point cost), `cardsPassed`, `laidDown`, `hit`, `recycled`,
  `pileCleared`, `roundOver`, `roundStart`. It is never persisted;
  replay regenerates it, so it cannot drift from the log. The UI drives
  celebration, sound, and the round summary from it instead of diffing
  zone counts.
- **The round boundary.** `maybeFinishRound` (movePipeline) runs after
  every applied move: score the round, apply totals, then either end the
  match (`scoring.gameOver` / the template's own call) or clear zones and
  redeal — inside the pipeline, because the redeal consumes seeded RNG and
  replay must cross the boundary at the same move. Templates with
  meta-state that outlives a round implement `startRound` (contract-rummy
  keeps `phase`, resets `laidDown`/`melds`, rotates the opening seat).
  Shedding packs therefore now play to their declared thresholds — which
  their manifests always claimed (`accumulate`, `anyScore >= N`).
- **Zone-driven rendering and move-driven input.** Every shared zone gets
  a center pile, every per-player zone beyond the hand gets a pile on the
  human's own row and a compact copy on the opponent seats; what is
  tappable is derived from `enumerateLegalMoves` (tap-source →
  tap-destination for Stockpile, multi-select + one button for Hearts'
  pass and Milestones' lay-down, meld chips as hit targets). The bot
  driver consults `actingSeats`, which un-stalled Hearts' pass phase at
  the table the same way it did in the simulator.
- **One turn token.** The same gold chip marks whoever may act — on a
  bot's name plate, on the action bar when the turn is yours — identical
  across all packs.

`tests/rounds.test.js` pins the boundary and the event window.
`tools/simulate.mjs` still simulates exactly one round per game: it now
detects the boundary by the `roundOver` event, since `isRoundOver` is
already false again once the pipeline has redealt. Milestones/Stockpile
stall rates under simulation are unchanged from the pre-round baseline
(slow bot convergence, documented above — not a rules deadlock).

## The UX pass (2026-08)

A twelve-item pass over how the table FEELS, planned in `UX_PASS_PLAN.md`
and shipped in five phases. Almost every item landed on a seam that
already existed, so the pass added exactly one new subsystem (drag) and
otherwise dressed existing contracts differently.

New modules, each with one job:

| Module | What it owns |
|---|---|
| `src/players/roster.js` | who is in seat N — names, faces, personas |
| `src/ui/interaction.js` | the pure "what may I do" model, DOM-free |
| `src/ui/dragController.js` | pointer choreography, game-agnostic |
| `src/ui/inspector.js` + `describe.js` | what a card or pile IS, in words |
| `src/ui/handOrder.js` | the fan's arrangement (presentation only) |
| `src/ui/panels.js` | round summary, scoreboard, game over |
| `src/ui/confirm.js` | the shared confirmation dialog |
| `src/stats/matchStats.js` | match stats, replayed out of the log |

Load-bearing decisions, in case they look arbitrary later:

- **Opponents are derived from the match seed**, not stored. A new deal
  brings new faces, a resumed game re-seats the same ones, and the save
  format did not change by a byte.
- **A drag is a second dressing of the same moves.** Both taps and drops
  ask `src/ui/interaction.js` for candidates that came out of
  `enumerateLegalMoves`, so neither can construct a move the engine would
  refuse. Tap-only remains a complete path.
- **Stats are derived, never tallied.** `computeMatchStats` replays the
  log at the end; nothing counts anything during play, so the numbers
  cannot drift from the game.
- **Announcements are moves.** "Uno" reaches state through the ordinary
  validate → apply → LOG pipeline, because the log IS the saved match — an
  announcement applied around the pipeline would be forgotten on resume.
- **Hand order never reaches the engine.** It is a permutation applied at
  render time, kept in settings, pruned against the real hand every pass.

Three corrections the work forced, each a genuine bug rather than a
preference:

1. **`animation.finished` is not a reliable completion signal.** Both the
   flight layer and the drag ghost used it to make a card visible again,
   and a document that is not being painted has no animation timeline — a
   table backgrounded mid-drag came back with a hole in the hand. Both now
   go through `animationSettled()` (`src/ui/flight.js`), which races the
   animation against a timeout.
2. **A top-visible pile was drawing its buried cards face up.** Any zone
   with `visibility: 'top'` now renders its history as backs. In the same
   breath, sequencing's per-player `discard` moved to `visibility: 'all'`,
   which is what it always was at a real table — the piles are face up and
   fanned, and it is *playability* that is limited to the top card.
3. **The last-card window was too narrow.** Declaring is legal at the
   count *or one card above it*, because the classic rule is that you say
   it as you play your second-to-last card. Enumeration still offers the
   button only in the narrower window where forgetting costs you.

Both of the last two are visible in `packs/wildfire/tests/rules.test.json`,
which grew five assertions covering the announcement window, the penalty,
double-jeopardy, and the lapse.

## Next steps

Multiplayer (Phase 8), per-pack UI polish (per-pack `theme.css`, custom
card faces), and the contract-rummy bot improvement noted above. The UX
pass left two seams pointed at Phase 8 on purpose: head-to-head records
are keyed `bot:<id>` / `peer:<deviceId>` from the first write, and the
forfeit path is where a `bye` frame will go.
