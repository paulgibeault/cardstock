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

## Known limitation: `1000-sims-zero-stalls` bar is not met by one pack

The design doc's bar (§11) is that a pack "isn't done until 1,000 headless
simulations complete without a stall." At 1000 games, 4 seats:

| Pack | Completed | Notes |
|------|-----------|-------|
| crazy-eights | 1000/1000 | clean |
| wildfire | 1000/1000 | clean |
| hearts | 1000/1000 | clean |
| milestones | 1000/1000 | clean since the bot learned to turn the deck — see below |
| stockpile | 925/1000 | see below |

**Stockpile (~92%)**: traced one stalled seed directly. All four hands were
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

**Milestones — fixed (issue #89, phase 1), and the old diagnosis here was
wrong.** This section used to record 31% and explain it as structural slowness
in greedy bot play: a laid-down seat's hand only shrinks via a *hit*, hit
opportunities are scarce early, so an unlucky seat cycles for a long time. The
hit reasoning is true and the conclusion was not. The rounds were not converging
slowly; they were not converging.

`botHeuristic` scored a draw as `from === 'discard' ? 0.5 : -1` — a flat,
unconditional preference for the face-up pile. Four seats obeying that never
touch the deck: the pile stays one card deep, the same forty dealt cards
circulate between the hands forever, and a seat that was not dealt the makings
of its contract can never be dealt them. Every "stall" was that closed system
running out the move cap, which is why the stalled hands all looked the same
(one or two seats frozen at ten cards for six thousand moves).

The fix is in `src/templates/contract-rummy-bot.js`: grade the pile top before
taking it, read the contract the seat actually owes (four of Milestones' ten
rungs are runs or a colour group, where the old rank-mate count was scoring
duplicates as the best cards in the hand), and price a discard by what it gives
away as well as what it costs — opponents' laid-down melds and their recent
pile pickups are both public. Result at 4 seats: **1000/1000, 53 moves a round**,
against 306/1000 and a 12,000-move cap before; 100/100 at every seat count from
two to six. The per-template move cap in `tools/simulate.mjs` is gone with it —
the worst round out of five thousand now finishes in 147 moves.

Still open, and deliberately: the harness simulates *one round* (see its header
comment), so it says nothing about full-match bot skill; and Phases 2 and 3 of
issue #89 (fork-and-evaluate, determinized rollouts, a difficulty dial) are the
lookahead this heuristic pass stops short of.

## Known limitation: `hard` is a real gain at Hearts, a modest one at shedding, and none at Milestones

> The Milestones numbers in this section are ROUND wins measured before #92,
> under a heuristic that could live-lock late rounds. The section after this
> one re-measures them at match level and says which of these still stand.

Phase 3 of issue #89 adds the difficulty dial — `easy` is the heuristic,
`medium` is Phase 2's one ply, `hard` deals itself worlds it is entitled to
believe in (`src/engine/determinize.js`) and plays every candidate out in each
of them. The fairness half of the acceptance held everywhere:
`tests/rollouts.test.js` moves cards the seat may not see and the decision does
not budge, in all five packs.

The strength half did not reach its bar. The issue asked for hard to win **≥
60% of head-to-head rounds on at least crazy-eights and milestones**; measured,
it wins neither at that margin. `tools/simulate.mjs <pack> --vs=hard,easy`
seats the two against each other, alternating chairs so dealing order cancels,
and counts hands won:

| pack | seats | rounds | hard's share of decisive rounds |
|---|---|---|---|
| hearts | 4 | 60 | **76.6%** (13 ties) |
| crazy-eights | 2 | 200 | 57.0% |
| wildfire | 2 | 120 | 54.3% |
| milestones | 2 | 100 | 41.0% |

Crazy Eights is worth a caution about sample size, because the smaller runs
looked better than the truth: 65% over 60 rounds, 60.0% over 120, 57.0% over
200. The standard error at 200 rounds is about 3.5 points, so the honest
statement is "hard wins somewhere around 57%", not "hard cleared 60% once".

Hearts is where determinization pays for itself, and the reason is the one the
issue predicted: Phase 2's guard has to REFUSE to score the pass commit and
every draw off a face-down pile, because playing them out on a fork reveals
cards the seat may not see. A sampled world has no such problem, so the moves a
Hearts player thinks hardest about are the ones only `hard` can judge at all.

Milestones is not a budget problem, and that is worth recording because it is
the first thing anyone will assume. Re-run with the wall clock lifted and ten
times the simulated-move cap — about a second of thinking per decision instead
of 120 ms — hard scores 43.3% over 30 rounds. More samples do not help because
samples are not what is missing.

The likelier reading is that **round-winning in two-handed Milestones is close
to skill-blind at this level of play**, and the control says so: `medium` versus
`easy`, which shares none of Phase 3's machinery, is 49.5% over 200 rounds at
two seats and 44.0% over 200 at four. Phase 2's `evaluateState` does not beat
the Phase 1 heuristic head-to-head either. Both search layers demonstrably
CHANGE what contract-rummy plays — the ranking tests pin that — and neither
changes who goes out first. Contract rummy's race is decided mostly by whether
the deal contains the contract, and a rollout policy that plays greedily cannot
see far enough past a discard to alter that.

What would move the packs that fall short, in rough order of expected value,
none of it attempted here:

* **A rollout policy that plays contract rummy properly.** Flat Monte Carlo
  inherits its judgement from the policy, and ours is the cheap heuristic in
  both seats. Using `medium` as the policy costs about ten times as much per
  rollout, which the think window cannot pay for at this template's enumeration
  cost — a worker (explicitly out of scope in #89) is the way that becomes
  affordable.
* **A terminal signal closer to what Milestones is actually about.** The search
  steers by `scoreRound`, which is leftover hand value — a proxy for "did I go
  out". The real objective is the contract ladder, which one round cannot see.
  Multi-round simulation is called out as a separate question in
  `tools/simulate.mjs`'s header and this is a second reason to want it.
* **Opponent modelling.** The determinizer pools every unknown card uniformly.
  "They have passed on the pile twice, so they are not collecting reds" is
  information a human uses and this deliberately does not.

## Milestones is a ladder, and the harness could not see one (#92)

Everything above about Milestones bot strength was measured on ROUND wins —
`tools/simulate.mjs --vs` played one hand per game and counted who was caught
holding less. That is the wrong bar for this pack twice over, and #92 is
where both halves came out.

**The ladder is the match.** A round advances whoever laid their contract
down, and the match ends the moment somebody lays the tenth one down. The
round score is a scoreboard the winner is never read from, so a bot that
"leaves fewer points in hand" while losing the lay-down race is optimising
nothing. `--match` plays whole matches to the pack's own game-over rule and
counts MATCHES won; `matchStanding` is a new optional template hook
(`src/templates/CONTRACT.md`) that says how far along the match a seat is, and
a finished `hard` rollout is graded by the CHANGE in it across the hand —
contract-rummy prices a rung above anything a round's points can amount to,
with the points behind it as a tie-break. A template without the hook is
graded by the change in accumulated score, which is exactly the round score
it always was; `tests/matchStanding.test.js` proves the equivalence by
installing a hook that says the same thing and one that says the opposite.

**Round one was hiding a second live-lock.** Round one's contract is two sets.
The runs and the colour group are rungs four to eight, and with a run(8) owed
nearly every pile top has a neighbour in hand, so two seats took each other's
discards every turn and the deck never turned — the closed system phase 1
had fixed for round one, back in round six. Round one measured 1000/1000 the
whole time; **more than half of two-seat matches never finished** (22 of 40
at easy against easy), and the first tournament numbers this section was
going to report were inflated by exactly that: `medium` "won" 73.5% of the
matches that finished, because the ones that did not were the ones easy was
cycling in. Three changes in `src/templates/contract-rummy-bot.js`, each of
which the two-seat match run found on its own:

* the pile is graded by the SWAP GAIN — the hand's total keep value with the
  top card in and the card the seat would actually throw out, valued on the
  final hand — rather than by the top card alone. A swap that changes nothing
  is worth nothing, which sends the seat to the deck; and because the total is
  bounded and a take must raise it, a round cannot circulate the pile forever;
* the card that leaves is the one `scoreDiscard` would choose, opponent terms
  included, not the least valuable one — a seat that will not feed the pile
  throws a better card instead, and a gain computed as if it had thrown the
  worst one is a gain it never gets;
* under a run contract a card is valued by the fullest run-length window it
  sits in rather than by its immediate neighbours, and a duplicate rank is dead
  weight — a seat holding eight tens under run(9) valued every ten and every
  fresh card at nothing and threw the fresh card each turn to avoid feeding
  the opponent, forever; a seat holding five wilds with a 4 and a 5 threw away
  every 8, 9 and 11 the wilds could have bridged to.

`PILE_PICKUP_BAR` was re-swept from 0 to 5 over three hundred two-seat matches
each: every setting finishes every match at the same length now, because it
is the swap gain being measured on the final hand that stops the cycle, not
the bar. Completion after the fix: 500/500 two-seat matches, 100/100 at three,
60/60 at four and six; round one unchanged at 53 moves. `tests/simulate.test.js`
gates twelve two-seat matches at 100%, and fails on the code before this.

**The numbers, on the right bar.** Two seats, `--match`, the reproducible
move budget for `hard`:

| contenders | matches | first contender's share |
|---|---|---|
| medium vs easy | 300 | 48.0% |
| medium vs easy, four seats | 100 | 52.0% |
| medium vs easy, rounds (for comparison) | 300 | 51.3% |
| hard vs easy | 80 | 41.3% |
| hard vs easy, matchStanding removed | 40 | 32.5% (30.0% with it, same seeds) |
| hard vs easy, draw phase left to the heuristic | 40 | 45.0% |
| hard vs medium | 40 | 52.5% |

Read plainly: **with a heuristic that converges, neither search layer beats
`easy` at Milestones matches.** Medium is a coin flip on every bar; hard is
somewhat worse than easy at matches (41% over 80, standard error about 5.5
points) and level with medium. The first 40 of those 80 came out at 30% and
the next 40 at 52%, which is what a sample that size looks like, so the number
to carry is the 80.

Three things this run rules out, so the next one does not repeat them:

* **The terminal signal is not what is holding hard back.** Removing
  `matchStanding` moves hard by two points on the same seeds. That is what the
  design predicted — a rollout is cut off at sixteen moves and graded by
  `evaluateState`, so the terminal value only speaks in the last third of a
  hand — and the hook stays because it is the right currency for the tail,
  not because it measured as a gain.
* **The run-valuation terms are not what is holding anyone back.** Duplicates
  at 0 rather than −0.5, the window worth capped at the old neighbour ceiling,
  both: identical round-level numbers (round one is two sets, so those terms
  never fire there) and 48–53% for medium at match level, all noise.
* **The sampled draw is not demonstrably the cause.** Hard's one decision
  that easy and medium do not share is deck-or-pile, sampled in determinized
  worlds; handing that to the heuristic gives 45% over 40, inside the noise
  of the 41%.

The old numbers this section replaces were not comparable and should not be
quoted against these: under the old heuristic `easy` could cycle the pile in a
late round indefinitely while `hard`'s sampling eventually turned the deck, so
hard "won" those rounds by default (67% of 30 matches, 0 unfinished, while
easy against easy left a quarter of matches unfinished). Fixing the live-lock
took that away, which is correct, and is why hard measures lower now than it
did in a broken game.

What is left is the note above already said: the rollout policy is the cheap
heuristic in both seats, `evaluateState` shares its vocabulary with it, and
contract rummy's race is decided mostly by whether the deal contains the
contract. A search that cannot out-think its own heuristic about which card to
throw has nothing to add over it, and a rollout policy that plays properly is
the only lever this pass has not pulled — priced, in the previous section, at
a worker.


## The weights are a parameter now, and a tuner found nothing to move

Every number a template's bot is made of used to be a module constant, chosen
by hand and swept by hand against whatever metric was to hand at the time.
Each template with an evaluator now gathers them into a frozen `weights`
object and reads every one through the third argument of `botHeuristic` and
`evaluateState` (`src/templates/CONTRACT.md`), so two seats in one simulated
game can hold two different opinions without any module-level state changing
to do it — `tests/weights.test.js` pins that the default is the template's own,
that every declared weight is actually read, and that nothing leaks between
seats.

`tools/tune.mjs` is the loop that made worth doing: coordinate search, each
weight perturbed ±50% and seated against the incumbent in the same seeded
games, accepted only when it wins by two standard errors, and the final set
re-measured against the shipped one on a seed family the search never saw.
Run over every tunable pack at `medium`, on the bar each pack is decided by:

| pack | trials | best candidate | accepted |
|---|---|---|---|
| milestones, 200 matches per trial | 30 | RUN_WINDOW_WORTH 2 → 1, 54.5% ± 3.5 | none |
| hearts, 300 rounds at four seats | 18 | HELD_LIABILITY_WORTH 1.2 → 0.6, 53.0% ± 3.2 | none |
| wildfire, 300 rounds | 10 | DEADWOOD_WORTH 0.05 → 0.025, 54.2% ± 2.9 | none |
| crazy-eights, 300 rounds | 10 | DEADWOOD_WORTH 0.05 → 0.025, 50.7% ± 2.9 | none |

So the hand sweeps sit at local optima at this step size, and the tool's
other half is what the table does not show: the shipped values are also
sharply *right* where they matter. Milestones' PROGRESS_WORTH raised by half
wins 1.5% of matches; LAID_DOWN_WORTH halved wins 9%; CARD_IN_HAND halved wins
35%. That is a strategy with real structure, not a flat plateau, and it is
the strongest evidence yet for the reading in the previous section: there is
no headroom left in the numbers, so a stronger Milestones bot is a stronger
rollout policy or nothing. The worker that would pay for one stays out of
scope by decision, and the tuner stays so the next weight anybody adds can be
asked the same question in a minute rather than a week.

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

## The rank ladder (#101)

What outranks what is now DECLARED per pack (`rankLadder` at the root of a
manifest, `suitLadder` beside it) and resolved once in `src/engine/cards.js`,
because the two places that used to guess were both wrong on the deck four of
the five packs ship. The guesses and what they cost:

- `rankOrder` put `Number(card.rank)` and the position in `RANKS` on one number
  line, so the jack scored 9 and tied the nine, the queen tied the ten, and the
  TEN OUTRANKED THE JACK. In Hearts, ♥10 played before ♥J took the trick — now
  pinned in `packs/hearts/tests/rules.test.json`.
- `rankDomain` (`src/templates/melds.js`) scanned `Number(card.rank)` alone, so
  a standard 52's run window was {2 … 10} and no run could hold a face card.
  Invisible only because Milestones ships a deck ranked 1–12.

**Nothing about the five packs on disk moved except Hearts.** Milestones,
Stockpile and Wildfire are all numerically ranked with word-ranked action
cards, and the deck-derived default puts them exactly where they were: numbers
ascending, then the ranks the standard ladder names, then the words in deck
order. Milestones' run window is the same twelve ranks, now counted as ladder
positions rather than as the numbers 1–12. Hearts' rule tests all still pass
and its simulate run still completes 40/40 rounds, so no floor moved; what did
change is the trick-taking bot's *arithmetic*, since `rankOrder` now returns a
position on the ladder (the two is 0) rather than a face value.

### One thing the fix exposed, in the sampler rather than in the ladder

`separated()` in `src/engine/bot.js` asked `gap > confidence * error`, and
those two are the SAME NUMBER whenever one sweep of n separates the top two
candidates and the other n−1 tie them — the ordinary shape of an endgame. The
algebra is exact: with n rows, one difference D and the rest zero, the mean is
D/n and the standard error is also D/n. With the default confidence of 1 a bare
`>` therefore handed those turns to whichever way the last bit of the z-scores
rounded, which is how a change of *units* in `evaluateState` — something
`tests/rollouts.test.js` exists to say no bot may feel — reached a different
card. It is settled deterministically now, and settled toward *separated*: at
exactly one standard error the sampler has an opinion and says so, because
answering the other way makes it decline in the commonest endgame there is.

This was latent, not introduced: the base tree flips the same way on the same
Hearts hand under a different rescaling. The ladder fix only moved which
decision sits on the knife edge, and the test happened to be pointed at it.

## Trump, a bid and bags — Team Spades (#105)

The design doc listed `trump` as a trick-taking parameter (§13.1) and named
bidding as "the template's first planned extension". Neither existed: the word
`trump` appeared nowhere in `src/templates/trick-taking.js`. Both are there
now, declared rather than coded, and `packs/team-spades/` is a manifest and a
rule-test file with no code of its own.

- **Trump** is two keys, deliberately. `rules.trump` names the suit (`none`, a
  suit, or `chosen` — a round that names its own, in the `trumpSuit` var);
  `rules.trickWinner: "highest-trump-else-led"` says the trick resolution reads
  it. Resolution puts a trump on a SHELF above the pack's rank ladder, so the
  loop that finds the winner stays the single "highest wins" it always was.
- **The bid** is a sequential phase before the first lead: `turn.seat` walks the
  table, `actingSeats` takes the platform default (which is what "sequential"
  meant, against the pass phase's simultaneous commit), and the move is
  `{type: 'bid', choice: {bid: n}}`. The felt needed **one new interaction mode
  and no new dialog**: `bid` puts a "Bid" button in the rail's thumb slot, and
  the number is asked with the existing `pendingChoice` Ask (`kind: 'value'`,
  options Nil…13), which the platform's own chooser renders.
- **Bags** are the one piece of state that outlives a hand, so trick-taking now
  implements `startRound` — see the trap in `CONTRACT.md`. They live on the
  side's canonical seat, which the score fold makes exact.

### Two bot findings, both measured, both invisible to every other bar

**The seat that spoke last bid nil on three hands in ten.** `evaluateState`
declines the bid phase — every candidate bid leaves the identical table, so
there is no position to judge — but the LAST bid finishes the bidding inside
its own move, so the fork it leaves is in the `play` phase and the phase check
alone did not catch it. What the lookahead then judged was the contract the bid
had just created, with nothing taken yet: promising nothing scored best, every
time. The honest test is that nothing has been PLAYED, which is true exactly
once a hand. With it, the nil rate over 300 deals fell from 28.1% to 4.1% and
the table's total bid rose from 6.9 to 11.7 of the thirteen tricks.

**A bag is worth nine points, not three.** `BAG_COST` started at 0.35 of a
contract trick, reasoning that an overtrick is worth a point now and a tenth of
a hundred-point penalty later. The arithmetic is nearer −9 against the +10 a
contract trick pays, and the difference shows up only at a table where the two
sides play differently: against opponents who take fewer tricks than they
should, the strong side is HANDED tricks it never bid, four or five a hand, and
pays a hundred every second hand. A medium-against-easy match sat in a 370–450
band for a dozen hands at 0.35 and reached 527 by the tenth hand at 1. A table
where everybody plays alike barely notices (13.6 rounds a match against 13.4),
which is why no same-difficulty bar could have found it.

### What `--vs --match` says, including the part that is not flattering

Matches, not hands: a Spades hand always completes, so round completion says
nothing about whether the bidding is any good — the match bar is the one that
bites (`tests/simulate.test.js`).

| Contest | Result |
|---|---|
| `--vs=medium,easy --match --games=40` | **medium 36, easy 4** (90% of decisive matches), 0 unfinished, 11.3 rounds a match |
| `--vs=hard,easy --match --games=60 --budget-moves=600` | **hard 10, easy 45**, 5 unfinished, 29.1 rounds a match |
| `--vs=hard,easy hearts --games=60 --budget-moves=600` (control) | **hard 38, easy 21** — the same budget, the same rollout layer, at the pack it was measured on |

The move-capped budget is the one an A/B may quote: two runs of it sample
identically on a busy laptop and an idle one. The shipped-clock version of the
Spades row (`--vs=hard,easy --match --games=20`, no cap) costs about ninety
seconds a match at 120 ms a decision, which is why the cap is what is tabulated
here.

The first is the number this issue's work is answerable for: `medium` is the
one-ply search over the new `evaluateContract`, and it beats the cheap
heuristic nine matches in ten. The second is `hard` — the flat Monte Carlo
layer, which is generic and was not touched here — and it is **worse than easy
at this pack**.

The diagnosis, and it is not the budget: the same 600-move cap at Hearts still
has `hard` beating `easy` on 64.4% of decisive rounds (60 rounds, three seats),
which is the gain this file has always recorded for it. What differs is what a
rollout MEANS. **The rollout policy is the cheap heuristic**, and trick-taking's
cheap heuristic at a pack with no card values is "play your lowest card" — a
policy that has never heard of a contract. In Hearts that is roughly the right
idea, because the points come from the cards you are made to take and playing
low avoids taking them, so where a rolled-out hand ENDS is informative about the
move that began it. In Spades the same policy plays out a hand nobody is trying
to win, and the final score — which is entirely about promises kept — is close
to orthogonal to the candidate being scored. Sampling harder samples noise.
Choosing the rollout path also means the one-ply evaluator `medium` wins with is
never consulted at all (`rankMoves`: a rollout answer, however noisy, wins over
the lookahead).

The felt's default difficulty is `medium`, so this is not what a player meets —
but "hard is the difficulty that loses" is a real defect, it belongs to the
rollout layer rather than to this template, and a bidding game is the first pack
in the repo to expose it. Worth its own issue: the fix is a rollout policy that
consults `evaluateState`, or a template-declared policy hook, not a bigger
budget.

### Two rule readings written down rather than left to be discovered

- **A trick a nil bidder is forced to take counts toward its partner's
  contract.** At some tables it is a bag that leaves the partner short. The two
  differ only when the partner would have been set without it; the forgiving
  reading is the commoner one at a kitchen table, and a variant can differ.
- **Blind nil is modelled as the wager, not the ritual.** The cards are dealt
  before any bid is possible and a seat's own hand is in its view, so "without
  looking" cannot be enforced; what is enforced is the entry condition (a side
  at least `blindNil.behind` points down) and the doubled stakes. A felt that
  wanted the ritual would have to bid before the deal.

## Pinochle — a doubled deck, an auction in points, and a meld that scores (#106)

The eighth pack, and the third thing `trick-taking` has grown rather than the
sixth template. Three parameters carry all of it:

| Declared | What it does |
|---|---|
| `rules.followSuit: "must-beat"` | follow the led suit AND beat the winning card if you hold one; void, trump, and over-trump when somebody already has |
| `rules.bidding.unit: "points"` | the seats compete for ONE contract instead of each making their own — `increment`, `namesTrump`, and the last speaker stuck with the floor |
| `rules.melds` | a declared meld vocabulary, whose presence creates the `meld` phase between the auction and the first lead |

plus `scoring.roundScore: "meld-and-tricks"` and `scoring.tricks.lastTrick`.

### The meld is a DECLARATION, and that decided the privacy question

Contract rummy's meld leaves the hand. Pinochle's does not: you show the table
a marriage, it is worth two, and you still have to win tricks with the king and
the queen. So the phase is the PASS's shape (a simultaneous commit, `turn.seat`
frozen, `actingSeats` answering per seat) with none of its consequences — no
card changes zone, and the size is whatever the hand happens to hold, from
nothing to the lot.

**What is published is the record, not the cards.** `meld` is a public per-seat
var carrying `{ points, melds: [{id, label, points, suit?}] }` and no card ids
at all, which is what a player calls out at a table. The cards stay in a hand
that is still `visibility: 'owner'`. That is not squeamishness — at a real
table those cards genuinely are shown — it is that the platform's whole privacy
invariant is "a hidden zone's ids do not reach another device", and the sweeps
enforce it structurally. Publishing the ids trips `tests/view.test.js` and the
per-move audit in `tools/simulate.mjs`, and it should: the same ids are in a
hand nobody else may read for the rest of the round. Carving a per-pack
exception into a security gate to be faithful to a flourish is the wrong trade.
The reversible version if the felt ever wants the cards face up is a real
`meld` ZONE with `visibility: 'all'` that the cards return from before the first
lead — a bigger change, and one the declaration record does not block.

The felt shows the number on every seat's badge (`seatCounters`, `kind: 'meld'`)
with the meld names in the aria text, for every seat, open or minimized.

### `commitPrompt`, so the second commit phase did not cost a sixth mode

`pass` is the gesture for every simultaneous commit. What was Hearts-specific
was the button: `passCards`, "Pass across", exactly `rules.passing.count`. Those
three moved onto a template hook (`src/templates/CONTRACT.md`), so a meld
commits at any size — zero included, which the platform now handles — under a
button that says "Declare". Adding a mode instead would have meant teaching six
downstream surfaces a new string to render an identical gesture.

### The auction, and the two numbers in it that were measured

Bids run 100 to 300 in tens; a seat passes with 0; a bid must beat the standing
one; the winner names trump (`trumpSuit`, the `trump: "chosen"` hook #105 left
unfilled). `pendingChoice` asks twice — the number, then the suit — which is the
first time any template has used the platform's Ask LOOP for real.

**`TRICK_CONFIDENCE = 0.55` is measured, and the honest part of this pack.**
`expectedTricks` prices a card by its distance from the top of the ladder, which
over-counts badly on a deck with two of everything: a rank step is eight cards
rather than four, and "I hold an ace, that is a trick" is wrong twice over when
there are eight aces. Taken at face value the four seats counted about twice the
twelve tricks that exist, bid 228 into a 250-point deck, and were set on 98% of
hands. Damped:

| damping | winning bid | contract made | hands nobody opened |
|---|---|---|---|
| 0.75 | 170 | 18% | 0% |
| 0.65 | 150 | 47% | 0% |
| **0.55** | **130** | **72%** | **36%** |
| 0.45 | 106 | 87% | 74% |

(160-hand samples per row; the shipped 0.55 row re-measured over 400 hands at
the shipped floor and ceiling — mean bid 130, median 130, highest 230, contract
made 72%, and the bidding side averaging 75 a hand against the other side's
118.)

The right fix one day is a trick count that reads the deck's own copy count.
That is a change to a function Spades depends on and was measured against, so it
was not made here.

**The bid floor is 100, and the classic minimum is 250.** A floor these bots
cannot clear is a floor that makes every hand the stuck-dealer game — at 250
nobody opened and every contract was set. 100 is where the auction is a
contest: somebody volunteers on about two hands in three, and makes the
contract about seven times in ten. It is one line of the manifest to raise when
the play improves.

**The ceiling is 300 for the felt's sake, and it is a real cap too.** At 500 the
bid dialog was 42 buttons and filled the screen; nothing in 200 measured hands
bid above 230, and a side reaching 300 needs 250 in cards plus fifty of meld.

### The evaluator cashed its aces, and the measurement is what found it

The first cut of `evaluatePointsContract` made the bot WORSE than no evaluator
at all: `medium` — which is the one-ply lookahead over it, and the thing this
issue is answerable for — took **22.5% of decisive matches** against `easy`.
Since a bid is scored by `botHeuristic` at both difficulties, that gap was
entirely in the play.

The diagnosis, and it is a mistake worth writing down because the same shape
will recur in any pack where the cards carry the points. Every term in the
first cut was about points that had **already moved** — melded, banked, or
provisionally won on the table. Within a single trick that is blind in one very
specific way: whichever card I win with, the trick lands in the same pile, so
the only difference the banked total can see is the value of the card I spent —
and an ace therefore scored eleven better than a ten *for taking the identical
trick*. The bot cashed its aces at the first opportunity and had nothing left
to take the counters with at the end of the hand.

Two things were tried first and both were wrong, which is why they are recorded
rather than quietly dropped:

- **Discounting the trick on the table once per seat still to play** (`holds`
  raised to the number of seats behind you) made it *worse*, 41.4% → 37.5%.
  Over-confidence about a half-won trick was not the problem.
- **Reshaping the contract cliff** — dropping it, and replacing it with the
  normalised shortfall `evaluateContract` uses — changed the outcome *not at
  all*, byte for byte over 300 rounds. That is not a null result, it is a fact
  about a two-sided game: within one trick a side's gain and its rival's are
  perfectly anti-correlated, so **every positive-weighted combination of the
  two has the same argmax**. The cliff can only change a decision at a table
  with three or more sides.

The fix is the missing term: **what is still in this seat's own hand.** A card
kept can still take a trick, and a high card can take a trick full of somebody
else's counters — so a held card is worth its face value plus its rank
(`HELD_PRIZE_WORTH = 1`, `HELD_RANK_WORTH = 4`, both measured on a grid).
"Win with the cheapest card that wins" falls out of that rather than being
written as a rule. It reads only the seat's own hand, never the partner's.

| medium vs easy | before | after |
|---|---|---|
| decisive rounds (200, same seeds) | 41.1% | 46.5% |
| decisive rounds (600) | — | 47.7% (mean round score 47.96 against easy's 47.10) |
| decisive **matches** (80) | 22.5% | **47.5%** (mean final total 420.25 against 413.94) |

So `medium` is at parity with `easy` at this pack rather than behind it — a
weaker claim than Spades' nine-in-ten, and an honest one. Pinochle is a harder
game for a one-ply evaluator than Spades is: the currency is points rather than
tricks, so a position's value depends on cards nobody can see, and the
difference between a good and a bad discard is often only visible three tricks
later.

### Measured

```
node tools/simulate.mjs pinochle --games=500      500/500 rounds, 0 stalled, 0 errored, 56.0 moves/game
node tools/simulate.mjs pinochle --games=200 --match
                                                  200/200 matches, 8.9 rounds/match
pinochle: medium vs easy (4 seats, 600 rounds)    medium 47.7% of decisive rounds (mean 47.96)
                                                  easy   52.3%                    (mean 47.10)
pinochle: medium vs easy (4 seats, 80 matches)    medium 47.5% of decisive matches (mean total 420.25)
                                                  easy   52.5%                     (mean total 413.94)
pinochle: hard vs easy (4 seats, 200 rounds)      hard   50.5% of decisive rounds (mean 44.13)
                                                  easy   49.5%                    (mean 45.42)
```

**`hard` is at parity here rather than losing, and that is the evaluator's doing
rather than a contradiction of #114.** Before the held-in-hand term it took
44.0% of decisive rounds — the same shape as the Spades finding filed as #114,
where the rollout policy is the cheap heuristic and plays out a hand nobody is
trying to win. What changed is that a depth-limited rollout ends at
`evaluateState`, so a better evaluator improves `hard` as well as `medium`. The
underlying defect #114 names is untouched and was deliberately not worked on
here: the rollout POLICY is still the cheap heuristic, and the fix for that is a
policy that consults `evaluateState`, not a bigger budget and not anything in
this pack.

### Rule readings written down rather than left to be discovered

- **The last trick is worth 10, not 1.** The issue said "cards taken + last
  trick 1" and also "the classic 250-point deck". Those disagree: A 11 · 10 10 ·
  K 4 · Q 3 · J 2 · 9 0 across a doubled deck is 240, and it is the last trick's
  ten that makes the 250 the deck is named for. The checkable claim won. It is
  declared (`scoring.tricks.lastTrick`), so a table that plays it differently
  changes one number.
- **A card may be counted in melds of different GROUPS but never twice in one.**
  This is the classic rule stated exactly ("not twice in melds of the same
  class"), and the pack's grouping is what makes the two familiar consequences
  fall out: the queen of spades counts in a marriage AND in a pinochle
  (different groups), while the trump king-queen inside a run is not paid for
  again as a royal marriage (the pack puts `run` and both marriages in
  `marriage`). It also makes the arithmetic decompose group by group instead of
  needing a search.
- **One circuit of bidding, not an auction that goes round until three pass.**
  Each seat speaks once, in order, hearing everything said before it. A seat
  with a monster hand therefore gets one chance to name its number rather than
  climbing a ladder against a rival. The multi-round auction is a bigger change
  to the phase — it needs a "still in" state per seat and a variable number of
  turns — and the single circuit is the smaller reversible choice.
- **The last seat may not pass out an empty auction.** Every table has this
  rule; here it is also load-bearing, because a passing seat names no trump.
  Letting it pass left one deal in twenty at the first lead with `trumpSuit`
  null (caught by the new meld bar in `tests/simulate.test.js`, not by any rule
  test).
- **The non-bidding side always banks what it made**, set or not. It promised
  nothing and cannot fail. The consequence is measurable and is the real
  incentive shape of the game: over 200 hands the bidding side averaged 73 a
  hand and the other side 118.

### A gate that only the browser was enforcing

`manifest.deck` is a filename the FELT fetches by name
(`src/ui/packSource.js`), while every headless caller reads
`packs/<id>/deck.json` unconditionally and never looks at the field. So a pack
naming its deck by the deck's own id passed the whole suite and failed on the
felt with "Cannot read properties of undefined (reading 'cards')" and no game.
Pinochle did exactly that. `validatePackFiles` (`tools/pack-test.mjs`) now
checks the field against what is on disk in both directions.

## Next steps

Multiplayer (Phase 8), per-pack UI polish (per-pack `theme.css`, custom
card faces), and the contract-rummy bot improvement noted above. The UX
pass left two seams pointed at Phase 8 on purpose: head-to-head records
are keyed `bot:<id>` / `peer:<deviceId>` from the first write, and the
forfeit path is where a `bye` frame will go.
