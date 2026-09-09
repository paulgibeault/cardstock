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

## Thirteen keeps its shape now, and the numbers say how much that is worth (#103)

#102 shipped the `climbing` template with a bot that plays legally and badly.
"Badly" was not a guess: the overseer, driving the felt by hand, beat it in
round one playing nothing but greedy singles. `botHeuristic` grades a MOVE,
and the losing move in Thirteen does not look like one — answering a lone 7
with the 8 out of `6-7-8-9-10` sheds a cheap card and turns one turn into
four. The damage is in the shape of what stayed, so a move scorer cannot see
it at all.

`evaluateState` grades the position instead (`src/templates/CONTRACT.md`), and
climbing's reads four things about the hand that is left: its size, how many
TURNS it still needs under a greedy cover of the pack's declared combinations,
how many of those turns are bombs, and how many of its cards nothing unplayed
can answer. Four new weights beside #102's four, all eight read through the
third argument, all eight now exercised by `tests/weights.test.js`.

### What it is worth, measured the way the game is decided

`tools/simulate.mjs --match`, four seats, because a Thirteen match is points to
50 and a round win is a proxy for it (#92's lesson). The BEFORE column is the
same tree with `evaluateState` renamed out of the template, which is exactly
the #102 bot — `medium` with no evaluator falls through to `botHeuristic` and
is `easy` with extra steps, and the numbers say so.

| pairing | before (#102) | after (#103) |
|---|---|---|
| medium vs easy, 200 matches | 53.5% ± 3.5 (a coin flip, as predicted) | **99.5%** (199 of 200) |
| hard vs easy, 40 matches | — | **100%** (40 of 40) |
| hard vs medium, 40 matches | — | see below |
| mean final total, medium vs easy | 40.0 against 41.0 | 20.7 against 47.4 |
| moves per hand, all four seats equal | 42.4 | 36.0 |

The last row is the mechanism in one number: the same hands finish in six
fewer moves because a bot that keeps its runs together sheds in fewer turns.
It also broke a test, honestly — `tests/climbing.test.js`'s enumerator sweep
counts MOVES CHECKED and needed twenty-four deals to reach the bar where
twelve had done.

`hard` is unchanged code and is not the point of this issue, but it is worth
saying where it now sits: the rollout layer truncates at depth 16 and asks
`evaluateState` at the cut, so it inherits the same reading.

### The tuner moved nothing at `medium` — and found a great deal at `easy`

`node tools/tune.mjs thirteen --match --seats=4 --games=200`: the coordinate
search over all eight weights at ±50%, accepted at two standard errors, with
the survivors re-measured on a seed family the search never saw. **Nothing was
accepted, and the shipped values are kept.** The table is worth reading for
what it says about which half of the strategy is doing the work:

| weight | ±50% | best candidate |
|---|---|---|
| SHED_WORTH, TOP_COST, CHOP_COST, PASS_WORTH | 50.0–50.5% | — |
| CARD_COST | 1 → 1.5: 49.0%; **→ 0.5: 42.0%** | — |
| PLAY_COST | 2.5 → 3.75: 51.0%; **→ 1.25: 44.5%** | — |
| BOMB_WORTH | 3 → 4.5: 47.5%; → 1.5: 48.0% | — |
| LEAD_WORTH | 2 → 3: 46.5%; → 1: 53.0% ± 3.5 | below the 2 SE bar |

The first row is the finding. At `medium` the four `botHeuristic` numbers are
**inert** — perturbing any of them by half moves the match win rate by half a
percent, because the evaluator has already decided and the cheap heuristic only
orders the moves it could not score. The four evaluator numbers are the
opposite: halving the structure term costs five and a half points of match win
rate, and halving the cost of a card in hand costs eight. That is a strategy
with real structure, and it is where the shipped values are sharply right.

### A tuning result NOT taken, and why it is the maintainer's call

Because the cheap weights are inert at `medium`, they were tuned again at the
tier where they are not — `--difficulty=easy --only=SHED_WORTH,TOP_COST,
CHOP_COST,PASS_WORTH` — and that run found a real, large gain:

```
SHED_WORTH 10 -> 15, TOP_COST 0.35 -> 0.175
validation on unseen deals: tuned 98.8% ± 0.6% of 400 against shipped
```

The two together cut the price of a combination's top card by three relative
to a shed card, so the bot plays its longest combination instead of hoarding
high ones — which is right, and the shipped numbers were wrong about it.
**It is not in this commit**, and the reason is not doubt about the number:

| | shipped | tuned cheap weights |
|---|---|---|
| easy vs easy (tuned as candidate) | — | 98.8% ± 0.6 of 400 |
| medium vs easy, 200 matches | 99.5% | **67.5%** |
| moves per hand, four medium seats | 36.0 | 36.0 |

It makes `easy` a much better bot, which narrows the difficulty ladder from
99.5% to 67.5% and also changes `hard`'s rollout POLICY, since a rollout plays
every chair at `easy` (`src/engine/bot.js`). Both of those are calibration
decisions about the dial rather than about Thirteen, they are measurable
against the personas and the other four packs, and neither is what #103 asked
for. The change is two constants in `src/templates/climbing.js` and the
command that found it is above.

### What the evaluator deliberately does not read

Anybody else's hand — and, unusually, not their hand COUNTS either, which it
would be entitled to (`src/engine/view.js` ships one with every zone). At one
ply every candidate leaves the other seats' counts identical, so a term built
on them is a weight the tuner cannot move; the search layer is what compares
seats.

And the one this game makes tempting: it does not ask whether an opponent can
chop. What it asks instead is whether a bomb could still be ASSEMBLED out of
the cards nobody has played — arithmetic over the discard, the pile and its
own hand — which is why a 2 is worth little in the opening and a trick in the
endgame. **The gate that would have caught the other version did not exist.**
`tests/rollouts.test.js`'s fairness probe drives the `hard` chooser, and
`hard` determinizes before it reads anything, so a peeking `evaluateState` is
invisible to it; the one-ply path is where the evaluator sees the real state.
`tests/climbing.test.js` now carries that probe, and proving it bites turned
up a second thing worth writing down: a peek that does not VARY with the
acting seat's own cards cannot change a one-ply ranking at all, so the first
attempt at breaking it passed. Both are in `CONTRACT.md` for the next template
that offers the hook.

### The three house rules

All three were declared `available: false` by #102 and are switched on now,
with the pack's rule table asserting each (`packs/thirteen/tests/rules.test.json`).

- **`quad-needs-four-pairs`** (D-6's alternative) needed no code and no new
  manifest key: the chopping ladder was already a declaration, so the variant
  patches `rules.bombs` and drops `pair:rank:2` from the quad's list. The
  default is asserted beside it, so the pair of tests is a control and a case.
- **`no-ending-on-two`** (D-4) is `rules.lastCardExcludes`, omitted by
  `enumerateLegalMoves` and refused by `validateMove` with a sentence, because
  the enumerator is a shortlist and a felt that just silently lacks a move
  teaches nobody anything. **It relaxes where it would deadlock** — a seat on
  lead holding nothing but pigs has no pass to fall back on, and a rule that
  stops the table is a stall. That is the platform's existing policy for lead
  constraints (design doc §5), and `simulate.mjs`'s variant floor is what would
  have caught getting it wrong.
- **`instant-wins`** (*tới trắng*, D-8) is a `startRound`-time check on the
  dealt hands, read against the pack's own tables rather than against
  Thirteen: four of the ladder's top rank, `deal`/2 pairs, one card of every
  rank a sequence may contain, the longest strip the `bombs` ladder declares,
  and triples in as many consecutive ranks as a run needs. It fires on about
  one deal in thirty-five at four seats (587 of 20,000), which is why it is off
  by default.

  **It is not an `endRound` at the deal, and that is a decision worth
  flagging.** `maybeFinishRound` runs after an applied MOVE and nothing else
  runs it, so a hand ended during the deal sits unresolved until somebody
  plays and is then scored one card into a hand that had already started. So
  the check leaves a public var, the seat it names is offered exactly one
  legal move — lay the whole hand down — and the ordinary "first empty hand"
  path scores and redeals it inside the boundary that already exists. It is
  also better on the felt: you get to put the dragon on the table. The smaller,
  reversible reading of "ends the hand on the deal"; if the maintainer wants it
  to resolve with no click at all, that is an engine hook (something that runs
  after `setup`), not a template change.

  The pack's rule table can reach the resolution but not the DEAL-TIME check,
  because the harness builds a state instead of dealing one. That half is a
  sweep in `tests/climbing.test.js` with a checker written out longhand from
  the rules doc rather than from the template.

### One thing not done

`seatCounters` still returns one number. #102 expected a bomb count beside the
hand count, and it cannot go there: the hook is asked of EVERY seat and `ctx`
has no notion of who is looking, so the count would publish a fact about a
hidden hand in solo play — and read 0 for the same seat at a joined table,
where the view ships a bare count. It wants a viewer-aware hook, which is a
platform change and its own issue.

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
pinochle: hard vs easy (4 seats, 8 matches)       hard   37.5% of decisive matches (mean total 408.94)
                                                  easy   62.5%                     (mean total 415.06)
```

**That last line is eight matches and proves nothing** — three wins against
five, on a sample whose standard error is about seventeen points. It is
recorded because it was run, not because it says anything. A `hard` MATCH run
at a useful size did not fit: 24 matches was still going after twenty-five
minutes and was killed unfinished, which is a fact about the Monte Carlo layer's
cost at a twelve-trick four-seat game rather than about this pack. The
round-level bar above it (200 rounds) is the number to read for `hard`, and
`--vs --match` at a size worth quoting is the medium-vs-easy pair.

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
## Cribbage, and a board that is not a zone (#107)

The fifth template, and the second test of `CONTRACT.md`'s "one file plus one
registry entry" claim. What it cost is written up in that file rather than here;
this is what the measurements said.

### The bot, measured the only way a cribbage bot can be

A cribbage match is first to 121 and takes about nine hands, so counting round
wins measures almost nothing — a hand is ten moves and the pone leads every
one of them. `--match` is the bar.

```
$ node tools/simulate.mjs cribbage --vs=hard,easy --match --games=200

=== cribbage: hard vs easy (2 seats, 200 matches, shipped clock) ===
  hard     121 wins   60.5% of decisive matches   (mean final total 117.52)
  easy      79 wins   39.5% of decisive matches   (mean final total 111.06)
  ties: 0   unfinished: 0   rounds per match: 8.9
```

Recorded whichever way it came out, and it came out the right way: the search
layer is worth about ten points of match win rate over the plain heuristic.
That is a smaller edge than Hearts gets from its evaluator and a larger one
than shedding gets, which is about what the genre suggests — a good deal of
cribbage is the cards you were dealt, and the two decisions a hand actually
contains (what to throw, and what to lay) are both shallow.

Completion, at the same time:

```
$ node tools/simulate.mjs cribbage
=== cribbage (2 seats, 1000 games) ===
  completed: 1000  stalled: 0  errored: 0

$ node tools/simulate.mjs cribbage --match --games=100
=== cribbage (2 seats, 100 matches) ===
  completed: 100  stalled: 0  errored: 0   avg rounds/match: 8.8
```

### Two bugs the harness found that no rule test would have

**A count that reopened on an empty seat.** 23 games in the first thousand
stalled with "no legal move for seat 1, phase play". Thirty-one and a go both
close the count and open a new one on the seat after whoever closed it — and
when that seat has run out of cards while the other still holds some, the turn
landed on a player with nothing to play and the table stopped. Roughly one hand
in forty-three, which is common enough to meet in an evening and rare enough
that a forty-game bar could have missed it. `openNextCount` walks on to the
next seat that still holds something; the round bar in `tests/simulate.test.js`
is gated at 100% rather than floored because of it.

**Card ids leaking one level down.** The protocol run refused every game:
"seat 1 was sent clubs-8, which it may not see". Three separate causes, all the
same mistake in different clothes:

* the crib was scored where it lay, in a `visibility: 'none'` pile, and its ids
  went out in the event that scored it. A card is revealed by MOVING it
  somewhere everyone can see — which is also what the dealer physically does —
  so the crib is turned into a `show` zone before it is counted.
* `showScored` named the starter in a field called `starter`, and `starterCut`
  named the cut card in a field called `card`. `eventsFor` filters an event's
  top-level `cards` array and nothing else, so both sailed past it.
* the score breakdown carried the cards that made each part, one level down
  inside `parts[]`. Same gap.

The last one is worth a note for whoever adds the sixth template: **the round
boundary runs inside the same move as the hand's last scoring step**, so by the
time a show's payload is delivered its cards have been shuffled into the next
deal and the ids name somebody's fresh hand. Teaching `eventsFor` to walk
nested structures would not have helped — post-redeal every one of those ids is
invisible and would be stripped anyway. What ships is a breakdown of *what*
scored and *how much*, with a count where the cards were. The cost is that a
REMOTE client narrates "the crib is worth eight" without being able to light up
the eight cards; a local table reads `state.events` directly and can. The
honest fix is a show that is its own move rather than the tail of the last
card, which is bigger than this issue was buying.

### The board

`seatCounters` with `kind: 'peg'` and three numbers — where the front peg is,
where the back one was, how long the road is. `src/ui/counterTrack.js` draws it
and knows nothing about cribbage; the set of kinds that render as a track is
the platform's closed vocabulary, the same shape as `INTERACTION_MODES`. No
keyframe animation anywhere on the component: the pegs move on a one-shot
transition and then sit still, so there is nothing for `--arcade-pulse-count`
to cap.

## Which way is up, in the sentences the table says (#121)

Two narration surfaces assumed points are a penalty, because both were written
while Hearts was the only pack that had any. They were not unpolished; they were
false, for three shipped packs, with every test green.

* the round summary's target line read the HIGHEST score as the leader —
  `First to 50 wins — 17 to go.` — so Thirteen, whose lowest score wins, told a
  playtester that the pile they were losing with was progress. They finished on
  53 having been promised "17 to go" for most of the match. Hearts shared the
  function and the bug.
* the trick banner said `N points against you` or `no points`. Pinochle showed
  every trick the human won — the object of the game — in the alarm-red
  `event-banner--bad`, and Team Spades announced a trick that was exactly what
  the player had bid for as "no points".

The fact both were missing is declared per pack and read everywhere else:
`scoring.gameOver.winner`. `evaluateGameOver` reads it to pick a winner, the
bot's match standing signs its accumulated score by it, and trick-taking turns
both of its evaluators round on it once (`prizeSign`) — "which way is up is the
pack's, and an evaluator must read it" (`src/templates/CONTRACT.md`). The
narration was the one layer that never got the reading.

**`src/ui/scoreDirection.js`** is that reading plus the two sentences, and it is
pure and DOM-free on purpose: `src/ui/panels.js` resolves its element table on
its first line and `src/ui/celebrations.js` imports the audio and flight layers,
so no Node test can load either, and the text that was wrong for three packs is
exactly what wants pinning. Both call sites keep their own subjects and delegate
the wording. `prizeSign` was deliberately left alone — it is the bot's read, it
is correct, and the point was to make the UI agree with it, not to refactor the
evaluator underneath it.

**The distance was never the wrong number.** `anyScore >= N` fires on the first
side to REACH N whichever way the pack scores, so the side nearest the end is
the highest one either way and `Math.max` stands. What was wrong was the claim
attached to it. A penalty-scored race reads:

> Match ends when anyone reaches 50 — 17 away. Lowest score wins.

The first clause is the fact a player wants (how much longer), the second is the
direction, and neither says the number going up is progress. It names no seat:
the sheet directly above it already shows every name against its total, and a
name here would be the third copy of the same fact. `First to N wins — X to go.`
is untouched for `highestScore`, and a pack whose template owns the ending
(Cribbage, Milestones) still says nothing at all.

**The trick banner** now spends one direction read four ways — text, tone, cue
and seat pulse — because those four disagreeing is what made it read as a bug
rather than a wording nit. At a points-are-the-prize pack a trick the human won
is `good`, and:

* Team Spades counts it against the bid — `Trick is yours — 3 of your 5`. The
  contract is the SIDE's (partners' bids add up, which is the rule that makes
  overtaking your partner pointless), and past it every trick is a bag, so the
  count keeps running and says what it has turned into: `6 of your 5, that's a
  bag`. Both numbers are cheap at the moment of `trickWon` — a won pile's depth
  is public even at a remote seat, and `bid` is a public playerVar.
* Pinochle bids POINTS (`rules.bidding.unit`), so "3 of your 250" would be two
  units in one sentence. It gets `Trick is yours — worth 23 points`.
* a broken nil is the mirror image of the bug being fixed, and is called what it
  is — `You take the trick — your nil is broken`, in the bad tone. A table that
  cheered every trick at a highestScore pack would be just as wrong for the seat
  that promised to take none.
* Hearts is byte-identical to what shipped, and so is a bot's trick, which is
  neutral either direction: the felt says what happened and does not
  editorialise about other people's hands.

Unknown direction — `winner: 'template'`, or no threshold at all — is narrated
as the penalty it always was, matching `prizeSign`'s own fallback. A UI that
disagreed with the bot about which way is up is the same bug wearing different
clothes.

`tests/scoreDirection.test.js` pins the text for one `lowestScore` and one
`highestScore` pack for both functions, off packs loaded from disk, and ends
with a source gate in the style of `tests/repo-gates.test.js`: a pure function
nobody calls is green forever, and reverting either call site alone restores the
whole bug with every other assertion passing.
## The round ending, held on the felt (#120)

### What was wrong

`maybeFinishRound` (`src/engine/movePipeline.js`) scores the hand, advances
`roundNumber`, clears every zone and deals the next round — all inside the move
that ended the old one. That is right and it is not negotiable: the redeal
consumes seeded RNG, so a replay has to cross the boundary at exactly the same
move. What was wrong was the FELT taking that move as its cue to repaint.
`afterMove` called `render` on the post-deal state immediately, so the round
summary opened over a hand that had already been dealt and a turn indicator
that had already advanced — Team Spades' status bar read "Bruno is bidding…"
behind the sheet for the hand you had just finished.

Cribbage was the sharp case, and it is worth writing the measurement down. On
unmodified main, driven with playwright: the human plays the last pegging card
at t=0; at t=+144ms the hand is six new cards, both played piles are empty, the
starter is gone and the status bar says "Crib — pick 2". The show — pone's
hand, the dealer's hand, the crib, three separate scores that decide close
games — never reached the screen at all. The banner at that moment still said
"You pegs 2 — the count is 28", because `celebrateAction` takes the FIRST
describable event of a move and the last peg beat all three `showScored`s to it.

### What changed

The felt keeps its own copy of where the round ENDED and paints that; the live
state — still saved, still published, still what the summary reads — waits
behind the summary's Continue.

- `src/ui/table.js` takes a `forkState` copy before every local move
  (`notePreMove`, one per move; the bot makes hundreds per turn) and, only when
  the move turns out to have ended a round, advances that copy with
  `template.applyMove` alone — the pipeline's round boundary deliberately not
  run (`takeRoundFinal`). It is a rendering decision, not a rules one: the fork
  is never logged, saved or published, and the real state crossed the boundary
  for real a moment earlier.
- The deal becomes visible in `dismissRoundSummary`, which already owned
  `playDeal`, the `Round N.` render and `scheduleNextTurn`. So the summary's
  Continue is now the button that deals the next hand.
- `src/ui/roundBeat.js` is the schedule as arithmetic — no DOM, no timers — so
  the one thing that was impossible to check by reading is a function with a
  test (`tests/roundBeat.test.js`): the summary opens after everything it
  covers.
- `session.roundBeat` says the felt is deliberately behind the engine. `render`
  and `renderStatusBar` read it and offer nothing while it is true, because a
  card offered from a position the engine has moved past would fail validation
  if it were tapped. The status bar says "Round over." rather than whatever
  `turn` the template happened to leave behind (cribbage's show leaves it on the
  last player, so the bar read "Your turn" over an empty hand).

### Decisions

**A timed hold, and no second acknowledgement.** The issue asks for the
`awaitFinalLook` pattern, and this deliberately is not a second copy of it. What
that bar buys at match end is that the PLAYER decides when the ending leaves the
screen; here the round summary already is that decision — its Continue is the
deal. A Continue bar in front of it would be two clicks for one choice. So the
hold is timed (700ms, or 900 after a trick, both measured against the flight the
way `offerFinalLook` measures its own beat) and the summary is the
acknowledgement. Nothing of the next hand exists on screen until it is answered.

**Cribbage's three steps are a pose, not a caption.** The crib is turned by the
move itself — the reveal IS `moveCards crib -> show` — so the ending position
already has it face up. `posedForShow` moves those four back to `crib` (which is
`visibility: 'none'` and therefore not drawn at all), and the crib's step
re-renders the true ending. So the third step is an actual turn on the felt, not
a sentence about cards that have been lying there through the other two counts.
Each step gets 1.5s, the pack's own sentence (`describeEvent`, which already
knows to say "Your hand" and not "You's hand"), a pulse on the seat, and a
static ring on the pile being counted (`.pile-stack--counting`). Static, not a
pulse: it is up for four and a half seconds across three steps, and a table
throbbing through all of it reads worse, which is also why it needs no
reduced-motion entry.

**A show that ends the match is untouched.** `peg` returns false the moment
somebody passes the target and every caller checks, so `ctx.endRound` is never
reached and no `roundOver` is emitted — `roundBeatPlan` returns null and the
`state.gameOver` branch and `offerFinalLook` take over exactly as before. There
is no redeal under a finished match to hide, which is why that path never needed
this.

**The multiplayer path degrades rather than lying.** `afterRemoteMove` is
called by the host module AFTER it has applied the move, so there is no pre-move
copy to advance and none can be taken without a pre-apply hook in
`src/match/host.js`. The plan is built with `narrate: false`: the hold still
applies, the step-by-step reveal does not, and the felt repaints the way it
always did. The wire form of `showScored` carries counts rather than card ids
anyway (see the cribbage section above), so a remote client could not light the
cards even with the timing. Nothing in `tests/protocol.test.js`, `twoSessions`,
`twoTables` or `tableSession` changes.

### Verified

Driven live on both builds with the same playwright probe — the worktree on
4820, unmodified main on 4830 — and compared frame by frame. Cribbage after the
change: last card at t=0, pone's count at +698ms, the dealer's at +2.2s, the
crib turned and counted at +3.7s, the summary at +5.2s, and the next hand's six
cards first visible at +6.4s, when Continue was pressed. Before the change, on
the same probe: the next hand was on screen 144ms after the last card and the
summary 369ms after that.

Hearts and Milestones were the audit the issue asked for, and both HAD the gap
rather than being already right — they reach the same `afterMove` branch, and
nothing about them was different. On unmodified main, Hearts put the next
round's passing phase on screen (seventeen new cards, every won pile back to
zero) two seconds after the last trick and opened the summary over it;
Milestones showed both opponents redealt to ten with every meld cleared and the
turn advanced, in the same frame as the discard that ended the hand. Both are
held now. Thirteen and Team Spades were checked the same way: Team Spades'
status bar read "Rook is bidding…" behind the sheet before, and "Round over."
after.

## Pinochle: saying what the engine already knew (#125)

Nine findings from the round-5 playtest, and eight of them are one shape. The
rules were right, the scoring was right, the bot was fine — and the felt did not
say a word about any of it. The worst was **trump**: after the auction named
spades there was no text, badge, aria attribute or data attribute anywhere on
the table that reflected it, and when a bot won the auction the log read only
`Pip bid. Bruno bid. Sable bid.` — so on any hand the player did not win, the
trump suit was never learned at all, in a game whose every play is
follow-and-beat with mandatory over-trump.

**The contract strip** (`src/ui/contractStrip.js`, `#table-contract`) is the
answer to three of them at once, driven by a new presentation hook,
`contractChips(ctx, seat)`. During the auction it carries the standing high bid,
the suit its holder fancied, and — the half a number cannot carry — WHOSE it is,
in that seat's own roster mark: once two chairs have both bid, both their plate
chips read the same gold and only a name says which one is ahead. After it, the
trump suit drawn as the pack's own card, the contract, and **your own meld**.
That last chip is there because there is nowhere else for it: every other seat's
meld is on that seat's plate (`seatCounters`), and the seat doing the looking has
no plate.

*Not the contract ladder, and not a badge on the trick.* `#contract-ladder` is
contract-rummy's race, driven by `rules.contracts`, which Pinochle has none of;
overloading it would be one widget answering two unrelated questions from two
unrelated declarations. A badge on the trick zone was the other candidate and
fails on its own terms: `zoneBadge` only draws one while the pile has cards in
it, and a trick is empty at the start of every trick — trump would blink out
four times a hand.

*And only where trump is a round's answer* (`rules.trump === 'chosen'`). Spades'
trump is in the pack's name and never changes, and a strip repeating the same
word on every hand of every match is the "play goes left" arrow that
`directionBadge` refuses to draw. The gate is also what keeps this off Team
Spades' felt, which is #123's.

**What is said out loud** is `describeEvent` on the trick-taking template, which
had none. `contractSet` announces the winner, the number and the suit —
`Pip won the auction at 140 — Clubs are trump.` — with a separate sentence for
the seat that was stuck with it, since `bidLevels` refuses the last speaker a
pass into an empty auction and being stuck is not the same thing as winning.
`meldDeclared` says the viewer's OWN declaration and returns null for the other
three; that is not only about noise. Four declarations land in one event window
and `celebrateAction` takes the first that yields a sentence, so making the
other three silent is what makes it land on the right one whatever order they
were emitted in. `Nothing to declare — no meld in your hand.` reads distinctly
from a real one, and so does the strip's chip: `None`, not `0`. The playtest
tested that case deliberately, with a hand holding K♥/K♣ and neither queen, and
could not tell it from declaring a run in trump.

**The trump chooser** read `Choose a suit to play it in` — which names no
referent for "it" and describes choosing a suit to play something in rather than
naming trump for the hand — over four plain word buttons, in the one pack whose
whole vocabulary is pips. The buttons are the interesting half. Round 3 item 6
built the chooser's card rendering for exactly this; it was not reaching here
because **`attr` was doing two jobs**. It is the TEMPLATE's word for the question
and it was also the key the platform's art vocabulary is looked up by
(`src/ui/cardStyles/chooser.js` knows `suit`, `color` and `rank` and nothing
else), so an Ask that called its question `trump` asked for a tile named "trump",
got null, and fell back to words. The Ask shape now has `art` beside `attr`, and
`question` beside `prompt` for a step that is not "choose a &lt;noun&gt;". A second
copy of the same conflation was one line further on: `buildChoiceOption` looked
the art up by an option's **label** rather than its **value**, which was
invisible while every chooser let the label default to the value and deleted the
picture the moment one gave its options a readable caption. And the Ask may now
name what the status bar says while it is open, because the bar behind the
dialog was still reading `Your bid` — the step before.

**A simultaneous commit is not a turn.** Three opponents wore the platform's
gold ▶ at once during the meld. `actingSeats` was right — every seat that has
not committed yet may act, which is what un-stalls the phase — and the felt was
spending the one marker that means "it is this player's go, and nobody else's"
on all of them. The seats still choosing get their own quiet mark now
(`committingToken`, `.turn-token--waiting`): same chip, same slot, no gold, no
arrow and no pulse, since four seats thinking at once is a state and not an
event. Asked of the interaction MODE and not the phase name, the way
`statusTextFor` already asks — so Hearts' pass, which had the same bug, is fixed
by the same line.

**One row per side.** The round sheet and the scoreboard listed four players, and
for every partnership pack we ship two of those rows were structurally dead:
both scorers in `src/engine/scoring.js` bank a side's whole result on
`members[0]`, so a partner's delta read `+0` every round beside a total of 682 —
the same 682 as the banker's, because the total was already folded to the side.
One sheet saying both that this player scored nothing and that they have 682.
The previous rule here ("a delta is per seat and a total is per side") was
soundly reasoned and its premise was not true of this platform; the note in
`src/ui/panels.js` says what to check before taking the split back. A teamless
pack is unchanged and not by a branch — `sidesOf` gives it one side per seat, so
every fold is the identity.

**The trick** carries an owner mark per card: the roster's own mark in the seat's
own colour, rimmed in the partner colour for your side. The mark and not the
name, which was the first cut: the fan overlaps by half a card, so a tag may
occupy half a card's width without reaching under its neighbour — 45px on a
desktop and 26 at 375px, which is two letters and an ellipsis. The names are on
the pile's accessible name in play order instead
(`Played: You: Ace of Diamonds, Bruno: 9 of Diamonds.`). Who played which card is
a RULE — which way round a trick goes, and from whom — so it is a template hook
(`zoneCardOwners`) rather than something the platform derives; it is derived from
the public `leader` var rather than stored, the same judgement `contractSeatOf`
makes about who holds the contract.

**The gather covered the banner.** `#fly-layer` was at z-index 9 and
`#event-banner` at 8, so the four copies a trick gather flies through the middle
of the felt drew over the message and cut it in half mid-word — measured before
and after in a browser: `Pip tak▌` against `Juniper takes the trick (+15)`. They
swap. The banner is the sentence and the gather is the decoration that
illustrates it; a decoration does not redact its own caption. Still below the
modals at 10. One more thing showed up while looking: `.pile-stack--deep` was
drawing its grey depth slabs behind a SPREAD trick, and the spread box is 2.11
card widths against three cards' 2.02 — so the third trick of every hand had a
grey card-shaped slab in the gap at the right-hand end that reads as a
face-down fourth card nobody played. A trick has no history under it; the cue is
off there.

**375px, measured rather than judged.** The finding was that the seat carousel
"drops the third opponent off-screen entirely". It does not, and the numbers are
worth writing down because the first probe got them wrong: computing
reachability from `offsetLeft` is computing it against the nearest POSITIONED
ancestor, which is not the scroll container. Scrolling the row to each seat the
way `scrollActingSeatIntoView` does and measuring the rects, all three seats are
wholly visible in bid, meld and play, at 375x812, on both the base build and
this one (client 332px, content 688–758px, max scroll 356–426px, 0px clipped).
The seat-view toggle in the felt's corner ("Minimize player cards") puts all
three on screen at once with no scrolling at all (max scroll 0). So no change
was made here; what the playtest could not see is that the row scrolls, and if
that is the real complaint it wants an affordance, filed on its own.

**Item 54 — measured, no change.** The flag was a deliberately-worst-play side
winning 682–153 across four hands. `tools/simulate.mjs` has no "worst"
difficulty, so the closest bar it can offer is the shipped bot against the cheap
heuristic:

```
pinochle: medium vs easy, --match, 600 matches
  medium  304 wins  50.7%   (mean final total 414.96)
  easy    296 wins  49.3%   (mean final total 417.55)
  ties: 0   unfinished: 0   rounds per match: 8.9
```

Two standard errors is ±4.1 points at n=600, so 50.7% is indistinguishable from
a coin. That is not new: #106 recorded Pinochle's bot at parity with `easy`
rather than ahead of it, and this run confirms it at four times the sample.
**No weights were touched**, which is what this issue is out of scope for. What
the number does say is that item 54's anecdote is consistent with a bot at
parity and is not evidence of anything beyond it: a side playing badly against
opponents that are not playing well either will win about half its matches, and
four hands is four samples. A bot improvement wants its own issue and its own
bar — the useful one would be a genuinely-worst policy added to the tournament,
which does not exist today.
## The trick you never saw, and the bid nobody showed you (#123)

### What was wrong

Five findings from the round-5 playtest, all of them numbers or cards that
existed and were not on screen.

**The fourth card of a trick never rendered.** `applyPlayCard` plays it and
`resolveTrick` moves all four into the winner's pile inside the same
`applyMove` (`src/templates/trick-taking.js`), and the felt paints where a move
ENDED — so the position with four cards on the table existed only inside a
function call. Driven frame by frame against unmodified main on 4833, across
five consecutive Team Spades tricks, the pile went 1, 2, 3, 0 and the peak was
three. Counting VISIBLE cards rather than DOM nodes made it worse: `landOn`
(src/ui/flight.js) holds a card at `opacity: 0` while its flying copy is in the
air, so the third card was usually two, and the deciding card — the one that
settles who wins — was never once on the felt. Hearts on the same probe peaked
at TWO of its three, and Pinochle at three of four.

**Your own bid was displayed nowhere.** Not the status bar, not a seat plate,
not the round summary — searching the whole rendered page text for `/bid/i`
found nothing. The reason is structural: every seat but yours wears a plate,
and yours is the hand, the rail and the piles. In a partnership the contract is
your bid plus your partner's, so half of your own contract was unreadable.

**The won pile counted cards.** "Won 4", "Won 8" — climbing in fours beside a
bid counted in tricks, on the plate and on your own pile, so every comparison
needed dividing by four first.

**Bags never appeared at all.** They accumulate correctly (verified against
score deltas across a twelve-round match) and the word "bag" was not in the
rendered page text anywhere. The only explanation of them was two clicks behind
the score chip.

**The bid dialog knew nothing about the auction.** A bare Nil/1–13 grid. At
375px the partner's plate is clipped mid-word by the seat carousel and the
third opponent is off the screen entirely, so a bid was made without being able
to check either.

### What changed

**The trick beat reuses #120's seam rather than inventing a second one.**
`template.poseMove(ctx, move)` is the position a move passes THROUGH, applied
to a throwaway fork of the pre-move state — the same copy `takeRoundFinal`
advances for a round ending, which is why `takeTrickPose` forks the fork: the
last trick of a hand needs both poses off it. Trick-taking's implementation is
one statement (`placeCard`, split out of `applyPlayCard` with no behaviour
change) and it answers false for every play but the one that completes a trick.
`trickRevealPlan` is the schedule, `session.trickBeat` says the felt is
deliberately behind the engine, and `feltState` paints the pose for anything
that repaints for a reason of its own.

**The hold is measured from when the fourth card LANDS.** The first cut used a
flat 700ms floor and measured 283ms of four visible cards, because the flight
is inside the hold: at the default 420ms pace, most of the beat was spent
watching the card arrive. `READ_AFTER_LANDING_MS` is a separate term for that
reason, and `tests/roundBeat.test.js` asserts the reading time survives every
flight from 0 to 1200ms.

**Nothing is actable during the beat**, for the same reason nothing is actable
during a round beat, and it is not the same reason it looks like: the posed
position still has the fourth player on turn, because the trick has not been
resolved on that copy. If the human played the fourth card, the felt would
otherwise say "Your turn" over four cards about to be swept. It says whose
trick it is instead — "Your trick.", "Cass's trick." — which is the question
the beat exists to answer.

**Your own seat got the plate it never had.** `#player-piles` grows a labelled
strip built from the counters the template already declares. Which counters
belong there is `MY_SEAT_KINDS`, a closed platform vocabulary in the style of
`COUNTER_TRACK_KINDS`: a kind this build has never heard of simply does not
appear, which is the safe direction, since the seat plates still show it. What
is deliberately NOT there is the hand count (the fan is right there) and
anything `minimizedOnly` (redundant when a seat is open, and yours always is).

**`template.zoneReading` is what a pile's number MEANS** when the count of
cards is not it — asked of the genre the way `activeMatch` is, because only
trick-taking knows that four cards are one trick. The badge carries its unit
("3 tricks"), which is a departure from the label diet in `describe.js`, and
deliberately: a bare 3 under a stack of twelve cards is the same ambiguity the
other way round. The inspector keeps both numbers. The seat plate's own pile
chip goes through `zoneBadge` now rather than printing a second opinion of the
same pile.

**Bags are a side's counter**, banked plus the ones being taken this hand — a
trick past a made contract is already a bag, so the number does not sit still
for a whole hand and then jump. Null for a pack that does not declare
`scoring.bids.bags`, so Hearts and Pinochle grow nothing.

**The bid dialog carries the auction.** The Ask gained an optional `context`:
rows the template fills with SEAT NUMBERS and the platform dresses from its
roster (`dressedContext`), exactly as it dresses a `kind: 'seat'` option. Team
Spades sends every seat's bid and the side's running promise; Pinochle's points
auction sends what a bid has to beat. That is the compact form the issue asks
for — the partner and the third seat are checkable without the carousel.

**And the round sheet says what the delta was the arithmetic of** — "Bid 3,
took 2" — read off the ending fork, because the engine wipes every bid crossing
the round boundary and by the time the summary opens the live state's bids are
the next hand's nothing.

### Decisions

**A pose is a strict subset of the move, and the contract says so.** The
temptation is to let `poseMove` do a little more (emit the event early, pulse
the winner) and the answer is no: a pose that scored, gathered or emitted would
be a second set of rules living in the renderer, and it would be the renderer's
version that a player saw. `tests/trickPose.test.js` pins all four halves of
that — no events, no score, no turn change, and the state it was forked from
untouched and still able to apply the real move.

**Every trick-taking pack gets it, and that is the point.** Hearts three-handed
holds three cards, Pinochle four; `ctx.seats` is the only number involved.
Hearts was audited on the felt because its gather is the one #120 measured, and
it still gathers: six gathers seen before, five and six after, with the pile
emptying every time.

**A beat per trick is thirteen beats a hand.** ~920ms at the default flight,
about half of it the flight itself. That is the cost of the issue's own
acceptance criterion ("shows all four cards for a beat before it sweeps") and
it is bounded by the player's pace setting like every other flight in the game.

**Bags on every plate, not only your own.** Bags are a side's number and the
race is between two sides, so a side carrying seven of them is a fact the whole
table is playing to. That is a fourth chip on a seat head; it is one or two
characters wide and it was checked at 375px against the carousel.

### Verified

Both builds driven with the same playwright probe — the worktree on 4823,
`polish/121-score-direction` on 4833 — and compared frame by frame with a
`requestAnimationFrame` loop counting cards in the trick zone that are actually
VISIBLE (computed opacity, not DOM presence).

| | before | after |
|---|---|---|
| Team Spades, peak cards visible on a trick | 3 | 4 |
| frames with four visible / longest stretch | 0 / 0ms | 146 / 484ms |
| Hearts (3-handed), peak visible | 2 | 3 |
| Pinochle, peak visible | 3 | 4 |
| `/bag/i` in the rendered page text during a hand | no match | `BAGS 0` |
| `/bid/i` in the rendered page text during a hand | no match | `BID 3` |
| the human's own won pile | `4` | `1 trick` |
| an opponent's plate chip | `Won 4` | `Won 1 trick` |

The bid dialog was photographed at 1280x860 and 375x812 on both builds: before,
the dialog is a bare grid and behind it the partner's plate ends at x=424 on a
375px screen with the third opponent at 434–574, entirely off it; after, all
three opponents' bids and the side's running promise are inside the dialog and
fit on one line at 375px.

The round summary was photographed after a full thirteen-trick hand: four rows
reading "Bid 3, took 2", "Bid 5, took 6", "Bid 1, took 2", "Bid 4, took 3"
against deltas of +40, +90, 0, 0 — and #120's hold behind it intact, the felt
still showing the ending position rather than the deal.

### Not done

**Item 34, the hand desaturating for three turns in four**, is untouched. It is
correct as the only legal/illegal signal and the playtest says so; what makes
it unreadable is the 14px sliver a thirteen-card hand becomes at 375px, which
is the hand's own layout and not this issue's. Sized separately.

**The `card-face--fresh` "blank first frame" is not a bug and was measured as
one.** The newest card on a pile is held at `opacity: 0` by `landOn` for
exactly as long as its flying copy is in the air, so a frame counter sees a
card in the DOM that nobody can see, and a DOM counter sees the same card
twice — the "double render" of the playtest's item 27 is the copy and the
original, correctly ordered (`flyCard` removes the copy before `landOn`
restores the card; the reveal cannot precede the removal because it chains off
the same promise). The practical complaint underneath it — that the newest card
is not legible while it matters — is what the beat fixes.
## The board, the crib and the count, made visible (#124)

Round 5 played cribbage and found that almost nothing the game is actually read
off was on the screen. Eight items, all presentation, and one of them a
straightforward rendering bug.

**The peg walked off the board.** `left` in percent is a percentage of the
containing block, and `renderCounterTrack` parented both pegs to the
`.seat__track` WRAP — which is the rail *plus the printed score beside it*. At
119 the rail spanned x=663–720 and the peg drew at x=750: past every hole, on
top of its own number. At 0 the two origins coincide, which is why every
screenshot of a fresh deal looked right and the bug survived a whole playtest.
The pegs are children of the rail now; the geometry `counterTrack()` computes
did not change. The pure model could never have caught this — the fraction was
always correct — so `tests/counterTrack.test.js` gained the assertion the
geometry cannot make: which element the percentage is *of*.

**The crib was not drawn at all.** `sharedZoneInstances` leaves every
`visibility: 'none'` shared zone off the felt unless it is `interactive`, so the
crib — four cards both players watched go in, and the thing the entire discard
decision is about — was invisible. What the felt showed instead was the `show`
zone: empty, captioned "The crib", from the deal to the reveal. Two new zone-def
flags, both about WHERE a pile is drawn and neither about what may be seen in it
(`visibility` is still the only thing that decides that): `onFelt`, a hidden
pile that is furniture, drawn as backs with its count; and `hideWhenEmpty`, a
pile that is not a place on the table until it holds something. The crib carries
both, so it appears with the first card thrown, grows to four, and disappears at
the moment its cards move to `show` and come up face up.

**The human had no board.** Every seat plate draws its primary counter as a
track where the template says it is one — and the human's own seat is not a
plate, so there was exactly one `.seat__track` in the document and it belonged
to the bot. The status bar's score chip renders the same track through the same
`renderCounterTrack`, narrower because that bar may never wrap. A pack whose
primary counter is a quantity renders nothing there and keeps the plain pill.

**The count was in the state and nowhere on the felt.** `count` has been in
cribbage's `publicVars` since the template shipped. New `tableCounters` hook —
`seatCounters` one rung out, for a number that belongs to the table rather than
to a seat — rendered as a chip beside the piles, during the play only. A stale
count sitting beside a hand being counted at the show is a different number's
worth of confusion.

**The narration said how much and never what.** Both scoring events carried
their breakdown from the day they shipped; the felt printed the total, so a
fifteen, a pair and a run all read "pegs 2". They are named now — including "his
nobs", which is in this pack's own tagline and its manifest and had never once
appeared on screen. The show's steps narrate through the beat #120 built:
`showSteps` carries `parts` because the sentence is rebuilt from the step.
"You pegs 3" is #107's possessive bug in a verb, fixed the same way — `agrees`
sits beside `possessive` in `describe.js` and reaches templates as `seatVerb`.

**Whose crib, before the decision.** The button said it and the button does not
exist until both cards are staged, which is after the only real choice in the
hand has been made. `dealer` is public from the deal, so the staging sentence
says it: "Your crib — pick 2".

**The zero column.** The round sheet's middle column is what the ROUND BOUNDARY
scored, and a pack that pegs every hole the moment it is earned has no such
number — cribbage's `scoreRound` returns nothing, so the sheet printed `?? 0`
for both seats every round beside a column that moved. The test is whether the
event carries any per-seat entries at all, not whether they are zero: a pack
that genuinely scored nobody still has a delta column and "+0" in it is still
true. The cell stays and is empty, because `.round-scores` is a three-column
grid of `display: contents` rows and a skipped cell shifts every cell after it.

**Two smaller ones.** A spread showed `state.seats` cards because the only
spread that existed was a trick; cribbage's `play` pile is one seat's four laid
down over a hand, so at a two-hander the first two vanished as the third went
down. The floor is four now, which is exactly what the fixed slot width already
holds and leaves every table of four or more untouched. And a pile's count
replaced its label at one card — the one count that says nothing a player cannot
already see — so the cut card's "Starter" became "1" the instant it was turned.
(At merge this branch met #122's fix for the same seam from Thirteen's side —
the name now rides beside the count on every pile, "Starter / 1" — so the
count-of-one special case this branch first shipped was dropped in favour of
the one rule; `tests/zoneBadge.test.js` pins the unified reading.)
The name wins at a count of one, *below* the active-match check, so a one-card
Crazy Eights discard still prints the suit in force.

**Verified on the felt, before and after**, by driving a whole match through the
human seat against two servers — this branch and its unmodified base. 68 peg
samples from 0 to 130, none off the rail, against 44 samples on main of which 17
were off it. The rest is in the same two runs: `tracks=1` → `2`, no counter →
`COUNT 15`, "The crib, 0 cards" → "Crib, 4 cards, face down", "Starter" instead
of "1", `["You","0","8"]` → `["You","","7"]` on the round sheet, and log lines
reading "You peg 2 — fifteen — the count is 15." and "Your crib is worth 3 —
fifteen and his nobs."

**Left alone, deliberately.** The opponent's played cards on their seat plate
still show only the top one: a mini pile is 34px wide and spreading four of them
is a seat-plate layout change, and with the count on screen the arithmetic the
complaint was really about is done. And the 121-vs-122 question from item 44 is
worse than an off-by-one — a match was observed finishing 130–95 against a
target of 121, because `peg` adds the whole score and then asks whether the seat
is out. Whether a seat should stop pegging at the target is a rules question in
`peg`, which this pass was not allowed to touch; it wants its own issue.
## The pile you are answering, named (#122)

### What was wrong

Six findings from the round-5 playtest of Thirteen, and most of them are the
same shape: the felt did not say what state you were reacting to.

The centre of a Thirteen table is two spread piles. `pile` holds every card
played in the current trick, in sequence, which is deliberate — it *is* the
trick, and hiding the cards under the top one would delete public information —
and `discard` holds the tricks already swept. Neither wore its own name once it
held a card: `zoneBadge` replaced the label with a count the moment the pile
stopped being empty. So the two stacks read as `6` and `28`, and the `6` was a
count of the whole trick while the thing to be beaten was a pair. Measured on
main at 1280px: badge `6`, accessible name "Pile, 6 cards.", against
`combo = pair of 2s`.

The rail was worse, because it moved. With nothing staged the thumb slot holds
a blue **Pass** pill; `buildUiModel` set `action: null` for a selection the
engine would refuse, so the instant a card that did not answer the standing
combination was tapped, `#action-button` went `display: none` and `#hand-sort`
appeared in the slot. Measured: Pass at x=890, "Deal order" at x=869 — a tap
aimed at Pass reshuffles the hand. And the refused selection said nothing at
all: no commit, no refusal, no Pass, the tray's own dashed outline unchanged
and `#log` still carrying "Rook played a pair".

Nothing ever announced a trick. `celebrateAction` takes the first describable
event of a move; the pass that ends a trick emits `passed` and then
`trickCleared`, so the banner said "Rook passed" while the lead quietly came
back to you — and `describeEvent` returned null for a single, so a banner with
nothing to replace it stayed put across several turns.

The fan never opened. `fanStep` treated its natural 0.69 spacing as a ceiling,
so five cards on a 1221px row sat in a 268px huddle with a third of every card
buried, and a lifted card came to the front over the one strip its right-hand
neighbour is read by (26px of 74px covered on the desktop; 32px of 46px at
375px). The reverse badge was a permanent lie: it tested `state.direction < 0`,
and Thirteen deals counter-clockwise by rule, so an emblem reading "play has
reversed" sat in the top-right corner of every Thirteen table from the first
card — overlapping the second seat plate at 375px, with an `aria-label` on a
bare `<div>` that no role attaches to. Beside it, a seat's score pill and its
cards-left pill were two identical grey lozenges ("Nell 12 1"), every card's
accessible name said "worth 1", and the results panel led with Moves and Cards
played while the scores that decided the match were a click away.

### What changed

**`zoneFocus`, a new presentation hook** (`src/templates/CONTRACT.md`). A pile
can hold more than the thing you are answering, and only the rules know which
part is still live. `climbing` answers it from `combo`, which already carries
the standing combination's own card ids — the platform re-deriving that from
the pile would be a second rules path. `src/ui/describe.js` asks it the way it
already asks `activeMatch`; `src/ui/zoneRenderer.js` rings the live cards in the
accent and fades the answered ones, which is what the **hint** was already
doing and was the one moment the table explained itself (round-5 item 25 — that
is now the default rather than something you have to ask for).

**The pile's name is back on its badge, for every pack.** "A pile with cards in
it introduces itself" went one step too far: it holds for a draw pile of
eighty-six and not for a row of look-alike stacks. The badge is the name with
the count under it (`Draw / 57`, `Played / 8`), a focused pile wears the
combination instead (`Pile / Pair of As`), and the two badges whose count *is*
their identity are untouched — a capacity pile still reads `3/4` and Wildfire's
active suit is still the glyph drawn big with no name in front of it. Cribbage's
"Starter"→"1" (#124) is the same seam and this is the generic half of it.

**A refused commit keeps the thumb slot.** `buildUiModel` returns
`{ label, disabled: true, refusal }` instead of null, so the button stays in
place, switched off, with the engine's own sentence on its accessible name and
its tooltip; the tray takes a warning edge and the sentence goes to `#log`, the
live region this table already uses for the words that are not on the felt.
`climbing`'s refusals are said with the combination's name now that they are
shown — "Answer a pair of 2 with the same shape" was the kind and the SIZE and
read as a pair of twos.

**`describeEvent` may declare a `priority`.** The banner takes the highest
rather than the first; ties fall to the first emitted, which is every other
pack's behaviour unchanged. `trickCleared` is 2 and says "Everybody passed —
the lead is yours" in the good tone when it comes back to you, and "Nell takes
the trick and leads" when it does not. Singles say something now, which is what
was leaving a three-turn-old pass standing over your own lead.

**The fan opens, and steps aside.** `fanStep` clamps to `OPEN` (0.94 of a card)
when the room is there rather than stopping at `natural`, and everything after
a lifted card slides right by `--lift-gap` — the whole overlap, which is the
only shift that actually uncovers a neighbour's rank corner. It is a transform,
so no layout moves and the ladder in `tests/handZOrder.test.js` now holds two
lists together: every state with a rung has a gap rule. `layoutHand` takes the
gap out of the room the fan did NOT need rather than reserving it: a first cut
reserved it up front and tightened the 375px hand from 14.5px per card to
13.2px, which is a regression on the exact number the playtest complained
about. A phone's 13-card fan is already closed to fit its row, so it opens by
nothing and keeps its spacing; the desktop gets the whole gap.

**The reverse badge compares against the pack's own `rules.direction`**, so it
appears when play departs from what the pack deals and not merely when the
number is negative. Thirteen has no badge at all now, which takes the false
"restart" affordance and the seat-plate overlap with it, and Wildfire's still
lands the instant a reverse card does. `role="img"` is what makes its name
reach a screen reader. Cards-left is drawn as a card — square corners, a thin
edge — beside the score's round pill, so the two numbers on a seat are told
apart by shape at any size and in either theme. A card's accessible name says
"1 penalty point if you are caught with it" where `winDirection` (#121) says
points are the bill, and keeps "worth N" where they are the prize or where the
template owns the ending. The game-over panel leads with the score that decided
the match, labelled in the pack's direction.

### How it was verified

Two dev servers, this branch and its base, driven with the same playwright
probe: every claim above is a measurement taken on both, and the probe throws
rather than reporting an empty result. The pile, the rail, the banner, the fan
at 13 and at 5 cards, and 375px are before/after screenshot pairs.

No bomb arose in the playtest's ten rounds, so that path was planted rather
than waited for: seat 1 leads a lone 2 into a four of a kind with an answered
pair still behind it in the pile. `validateMove` is asked whether the chop is
legal rather than told — the point is the presentation. The pile reads
`Pile / Single 2` with the 2 ringed and the pair faded, staging the quad arms
"Play 4", and after the chop it reads `Pile / Four 7s` with all four ringed.

**Not done, and why.** The 375px felt still has ~377px of empty green between
the seats and the pile and between the pile and the hand (was ~400px), and a
13-card hand still gives each card a ~14px strip. Both are the same problem and
the fix is the felt's shared vertical layout — moving room from the middle into
the hand row, or wrapping the fan — which is a design decision about what that
space is FOR, in a file two sibling issues are also editing. The `13` medallion
on Thirteen's card backs still collides with a seat's card count; that is the
pack's own card-back art (`ui.cardBack.emblem`), visible on every back in the
game, and changing the deck's identity is a bigger call than this issue. The
`seats=` URL parameter is **confirmed not wired to anything**: `packOverride`
(`src/arcade/storage.js`) reads `pack` and nothing else, `src/main.js` passes
only that to `goToTable`, and the seat count comes from the new-game sheet — no
URL plumbing was added, per the issue.

## One board, with everybody on it (#136)

### What was wrong

#124 gave the felt a `peg` counter kind and drew it wherever the seat already
was: 88px on the opponent's plate, and — because the human's own seat is not a
plate — a second copy about 90px wide squeezed into the status bar's YOU chip.
Round 5 played a whole cribbage match on that and the note that came back was
"In cribbage I don't see the board. Is it the small progress-bar-looking thing
on their player card? That is too small. Where is my board and pegs?"

Two tracks that small, in the two corners of the felt the eye never goes
mid-hand, are not a board. They are two progress bars that happen to be about
the same road, and the only question anybody asks of a cribbage board is
comparative — am I ahead, by how much, did that hand close the gap — which two
separate bars at two separate scales in two separate places turn into a
subtraction.

### The component

`src/ui/sharedBoard.js`, on exactly the terms `counterTrack.js` is on and for
the same reasons. A pure `sharedBoard(seats)` that takes no DOM (src/ui/table.js
touches `document` at import time, so a model that can be asserted without a
browser is the only way this geometry is ever checked), and a
`renderSharedBoard(model, doc)` beside it. Nothing in the file knows the word
cribbage: it is handed a list of seats and their primary counters, and the ones
`counterTrack()` says are a POSITION get a lane. A pack whose seats count things
produces no board and no row.

Three things the model owns that two separate tracks could not:

* **One road for every lane.** `counterTrack` computes each seat's position as a
  fraction of its OWN `of`. Here the road is the longest `of` any lane declares
  and every peg is re-measured against it, so two seats playing to different
  targets are drawn where they actually are rather than both at "80% of
  something".
* **A ruler in holes.** The ticks are a repeating gradient whose period is a
  PERCENTAGE computed from the road's length (4.13% for five holes of 121), not
  a pixel rhythm — a mark is five holes at 223px on a phone and at 461px on a
  desktop. Streets every thirty are the same trick painted twice as strong.
  Numbered 30, 60, 90 and then the target: 120 and 121 land five pixels apart
  and shipped, in the first screenshot of this component, as one muddled
  five-digit thing.
* **A repaint rather than a rebuild.** `updateSharedBoard` exists because an
  element created fresh at 37% has never been anywhere else: its one-shot
  transition on `left` has no old value to run from, so a rebuilt board
  teleports its pegs and the one piece of motion this component is allowed
  never happens at all. Proved on the felt, not asserted — the browser reports
  `transitionstart left on peg1 after 0s` / `transitionend left on peg1 after
  0.32s` on the SAME node it tagged before the score, and no animation event of
  any kind (§6d: there is no `@keyframes` on this component).

Ring order with the human's lane nearest the hand, one lane per SIDE rather than
per seat (`scoreBearers`, the same rule the score chips use — a partnership has
one score and drawing it twice reads as two scores that happen to be equal), the
roster's own mark and colour, and one accessible name per lane: "You: 45 of 121,
up 6".

### Where it sits, and why the measurement decided it

The issue proposed a full-width row directly under the piles at every size. The
felt said otherwise, and the numbers are worth keeping:

| | 375x812 | 1280x860 |
|---|---|---|
| middle's width | 332px | 1221px |
| piles + COUNT | 234px | 416px |
| spare HEIGHT during the play | 191px | **33px** |

A row under the piles costs its own height plus `#table`'s 16px gap, so at every
desktop size it pushes `#table-screen` past the window — and "the play does not
scroll" was the one thing this issue had to leave alone (the crib DISCARD
already overflows at 1280x860 by 71px; that is #137 and it is unchanged).
Meanwhile a phone has 98px LESS width than the piles and the count already use,
so there is no room beside them at all.

So the board is a flex item inside `#felt-middle` with a minimum width, and the
middle wraps: beside the piles wherever the row can hold it — which is every
desktop, and is what Paul actually asked for ("can we share a large board next
to the played card slots") — and on its own full-width line directly under them
where it cannot. One rule, no breakpoint, and the awkward middle widths resolve
themselves. Measured across twelve viewports from 1600x900 to 320x690: beside at
1600/1280/1041/900/820/700, under at 768x1024, 600, 414, 375, 360 and 320, and
`scrollHeight === innerHeight` at every one of them.

Two details that rule needed. `flex-wrap` is switched on by a class the renderer
adds only when a board is actually drawn — a permanently wrapping middle would
let Milestones' contract ladder fall under the piles on a narrow window.
`align-content: center`, because the default `stretch` spread the two lines to
fill the middle and left 74px of empty felt between the piles and the board that
belongs to them.

And the lane's columns are FIXED widths, which is what makes the scale honest:
the street numbers are one row under both lanes, positioned as a percentage of
the road, so the box they are a percentage of has to be the box the rails are.
A name column sized to its content would put the "30" half a street away from
hole 30 on the lane with the longer name. What gives way on a cramped board is
the name, through a CONTAINER query rather than a media query — the board's
width is not a function of the viewport's (608px at 1280, 334px at 820 beside
the piles, 608px again at 768x1024 underneath them), so a viewport breakpoint
would dress the wide board as though it were the narrow one. It buys 35px of
road at 375 and 38px at 820.

### The two small tracks

Gone wherever the board is drawn, both through `session.board` — the model, read
by the seat plate's counter loop and the status bar's score chip, which is why
the board renders FIRST. The plate keeps its score pill (the same number, and
the peg counter still counts toward the collapsed head's spoken name); the chip
goes back to the plain pill it was before #124. `renderCounterTrack` itself
stays: it is the fallback for a pack that wants a track and no board, and
`tests/counterTrack.test.js` stays green on it.

### Verified

Driven through the crib discard, the play, the show, a score and the round sheet
at 375x812 and 1280x860 in both themes, against this branch and against an
unmodified v0.1.62 server. `#table-screen.scrollHeight` is exactly `innerHeight`
at every phase and both sizes except the crib discard at 1280x860, which is 931
on both servers. `.seat__track` count 2 -> 0 and `#score-chip-track` 1 child ->
0 in all four runs; the road went from 88px on a plate to 223px at 375 and 461px
at 1280. All nine packs boot headlessly with no page errors and `#table-board`
`display: none`, 0x0, on the eight that are not cribbage; every pack's felt
geometry is byte-identical to main (Pinochle's middle varies by 8px on BOTH
servers — its contract strip wraps or does not depending on the bid).
`node tools/simulate.mjs cribbage --games=150` is 150 completed / 0 stalled /
0 errored / 10.0 moves per game on both trees.
## The numbers on a plate, named — and an edge that says the row goes on (#133)

Round-5 items 49 and 53, the two the research pass left inside #133 after items
1–4 became #134–#138.

### What was wrong

**A seat plate was a row of anonymous digits.** `buildSeatRow` drew a seat's
score, hand count, bid, tricks, bags and meld as six bare numbers whose only
difference was their position in the head — `Bruno 0 12 150 —` on Pinochle,
`Nell 12 4 0` on Team Spades. #122 had already made the CARD COUNT a different
shape from the SCORE (a card, not a pill), and that is as far as shape goes:
four pills in a row are four pills. The human's own seat had been labelled as a
side effect of #123 (`BID`, `BAGS`) and #125 (`YOUR MELD`), so the two halves of
the table said the same fact two different ways.

The badges' one name was an `aria-label` on a roleless `<span>`, which is the
exact shape `directionBadge` grew a `role="img"` to fix in #122: most screen
readers drop it. So the plate had no visible name and, in practice, no spoken
one either.

Pinochle's `—` is what settles the argument. The template draws it twice, for
"passed" and for "has not declared a meld yet". A dash with no word beside it is
not a number that is missing; it is a plate with nothing on it.

**The seat carousel scrolls and nothing said so.** #125 measured item 53 and
found it was never a clipping bug — every seat is reachable, and the toggle
shows all three at once — and flagged the likely real complaint: nobody can see
that the row scrolls. Measured again here at 375×812: the row is 683–741px of
seats in a 332px port, the second plate is cut at the edge with ~91px showing,
and the third is off screen. A cut edge is ambiguous. It reads as a felt that
ends there just as easily as one that continues.

### What changed

**A caption under each number, in the template's own word.**
`fillCounterBadge` (`src/ui/table.js`) builds every badge as a value line plus a
`.seat__count-label` line, and gives the pair `role="img"` with the counter's
sentence as its accessible name — one name, not "12, cards, 12 cards". The word
is `counter.label`, which every template already supplied; `seatCountersFor`'s
platform default and `defaultScoreChip` (`src/ui/seatRing.js`) grew theirs, and
the contract now says `label` is required and DRAWN rather than, as it read
before, filed away for an inspector that no longer exists.

`scoreChip` grew an optional `label` for one pack. Contract rummy's chip is the
contract reached and the points are its tiebreak (that is why it overrides the
hook at all), so `Ph 1` under the word SCORE is wrong twice; Milestones now says
CONTRACT and everything else takes the default.

*Under the number, not beside it, and that was measured rather than argued.*
Both shapes were injected into a live felt during the research pass. Captions
UNDER: Team Spades' seats 209→269px at 375px (+29%), carousel scroll 683→776px,
plate height +1px, and the 1280 row still fits with ~350px to spare. Captions
BESIDE: +50% width, scroll 912–993px. The row already scrolls; making it half
again as long to say the same six words is paying twice. Re-measured after the
fact on the shipped build: Team Spades 375 seats 212/251/172 → 278/280/206 and
scroll 654→783, row height 130→131; Stockpile at six seats 159→159px per plate
(the word is narrower than the pile row above it) with the row 149→151 tall;
Milestones four-handed 167–172 → 203–207 and scroll 528→634 (its plates carry
the longest caption on the platform, CONTRACT, next to a two-character number).

*Faces keep the bare number,* by a stylesheet rule (`.seat--collapsed
.seat__count-label { display: none }`) rather than by building a different DOM.
That is deliberate: which rung the row settles on is MEASURED by the fit loop,
and building the caption conditionally would put the ladder's own output inside
the question it is answering. Collapsed seat widths are unchanged to the pixel —
18px and 15px badges at 375px, 22px and 21px at 1280 — so the crowded-row
collapse other packs rely on is untouched. The open PLATE popup shows no
captions for the simplest possible reason: it has no head. `buildPlateFor` calls
`buildSeatBody`, which is the fan and the seat's piles; the numbers stay on the
face the plate hangs off, where they always were.

**A scroll-edge fade, and only where there is something to scroll to.**
`paintSeatRowEdges` toggles `.opponent-row--more-left` / `--more-right` from the
row's own geometry, and the stylesheet turns them into one `mask-image` gradient
whose two ends are switched independently. Three things drive it and each is a
real hole without the others: a passive `scroll` listener follows the finger;
`renderSeats` repaints after issuing its scroll, because a bot laying a meld
lengthens the row without any scroll event being fired; and the row's
`ResizeObserver` repaints before its width gate, since the same width can hold a
different length.

*A mask rather than two overlay pseudo-elements* — `::before`/`::after` inside a
scrollport scroll WITH the content, so they would slide off the edge they were
drawn for. A mask applies to the element's painted result against its border
box, which stays still. Nothing that overflows on purpose is clipped: the mask
is uniform in the block axis, so `.seat--active`'s 2px lift and its glow (inside
the block padding, inside the border box) are untouched, the open plate is not
in this row at all (`#seat-plate-layer`), and the view toggle is positioned
against `#table`. No animation — the fade is a state, not a pulse (cardstock#24).

### How it was verified

Two servers, the worktree on 4833 and unmodified main on 4843, driven headless
by playwright at 375×812 and 1280×860.

- Team Spades and Pinochle, open plates: every badge's rendered text went from
  `🐺Sable071404` to `🐻Otto0Score9Cards—Bid6Meld`, both viewports, both packs.
- Minimized faces: identical badge widths and row heights before and after
  (42px at 375, 44px at 1280), and the plate still opens on tap.
- Stockpile at six seats and Milestones four-handed (lobby tile → new-game sheet
  → seat count), both views: the ladder still lands on `faces` at 375 and
  `tight` at 1280, and the acting seat's plate still opens.
- The fade at scrollLeft 0 / middle / max on both packs: right only, both, left
  only, with the mask's own computed value read back each time. Cribbage and
  two-handed Thirteen carry no classes and `mask-image: none`.
- Both themes at 375: the caption is `currentColor` at 0.7 opacity, so it is
  ink-on-felt in dark and ink-on-paper in light with no second colour to keep in
  step.
- `npm test` 817/817, `node tools/pack-test.mjs --all` 137/137 across nine
  packs, `node --check src/ui/table.js`, and all nine packs booted headlessly
  with no page errors and a non-empty seat row.

`tests/seatPlate.test.js` is new: a runtime sweep asserting every counter every
shipped pack declares carries a short label (with a floor on the count, so a
renamed hook cannot leave it green over nothing), plus source gates on the two
call sites that draw it, the rule that hides it on a face, and the three drivers
of the edge fade. Each of its eight assertions was proved to bite by breaking
what it watches and restoring from a scratch copy.

### Not done

The felt at 1280×860 scrolls by 5px on a six-handed Stockpile table, where it
scrolled by 3px before. That is #137's measurement, worsened by the 2px the
captions add to the seat row; it is not a new class of problem and #137 owns the
three candidate fixes. Cribbage's peg track carries no caption — it short
circuits the badge branch entirely, and #136 is replacing it.
## The hand takes a second row, and the rail gets out of its way (#134)

### What was wrong

The "not done, and why" paragraph of #122 above, answered. At 375×812 a
thirteen-card hand gave every card a 14.5px strip — the round-5 playtest's
"can't read my own hand" (#133 items 1–2). The arithmetic is short: `#hand-row`
is 332px, the rail took 92px of it (5rem plus a 12px reserve), the hand's own
padding another 20px, so `fanStep` was handed 220px for twelve gaps.

Every alternative was measured live before anything was written (#133's research
comment). Bigger cards make it **worse** — 60px cards give 13.3px, because the
strip is set by the row's width and not the card's. Moving the rail out of the
row buys 22.2px. Two rows with the rail still beside the fan buys 29px. Two rows
with the rail above buys 43px, the fan fully open, and that is the one that
answers the complaint rather than softening it.

### What changed

**The rail leaves the row on a portrait phone.** `(orientation: portrait) and
(max-width: 480px)` only: `#hand-row` wraps and `.hand-rail` becomes a
fixed-height band above the fan with the token, the lamp and the thumb slot in
one line, right-aligned, mirrored for left handedness. The band is 1.9rem
whatever is standing in it and the stack is still absolutely positioned inside
it — the same promise the zero-height box was making, turned through ninety
degrees, so the felt does not step under a reaching thumb when the turn changes
(#13). The slot itself is pinned to the rail's own 5rem so the button and the
sort toggle that share it cannot be different widths; measured with the toggle
in the slot and again with `Play 1` in it, the band, the token, the lamp and the
slot are at identical coordinates. Landscape and desktop keep today's rail, and
were measured to prove it: all nine packs at 812×375 report the same `--fan-step`
and the same `#table-screen.scrollHeight` as main.

**`fanLayout` splits the fan when one row would close past reading.** A sibling
of `fanStep` in `src/ui/handOrder.js`, pure and pinned in tests: one row while
the step clears `READABLE`, else the fewest rows whose per-row step clears it,
and only while the felt's measured slack covers the extra rows. `READABLE` is
half a card, and the window it has to live in is narrow enough that the issue's
own measurements close it: 13 cards on 312px is 22.2px a card, which has to be
judged not good enough (so the floor is above 0.48), and the same hand split in
two on 220px is 29px, which has to be judged good enough or splitting buys
nothing (so it is below 0.63). The card art agrees — the corner index inks the
left 0.24 of a card, so at 0.5 the visible strip is more than twice the ink it
carries.

**It re-joins later than it split**, which is not decoration. A hand shrinks a
card at a time and is judged on the ONE-row step, which crosses the floor while
the fan is still drawn in two — so without hysteresis, staging one card out of
thirteen took the hand from 43px a card to 24px and jumped it 70px up the felt,
as a reward for playing. Splitting asks for `READABLE`; re-joining asks for
`NATURAL`, the spacing a fan sits at when it is not short of room at all. On a
375px phone: split at thirteen, stay split down to ten, one row again at nine.

**Each row is a real container.** `.hand` is a column of `.hand__row`, and that
is what let the rest of the fan's machinery survive: the overlap is a negative
margin on `:not(:first-child)` and a lift opens its gap with a general sibling
combinator, and both mean "within my row" by construction once a row exists.
Written as one flat wrapping list — which is what the fan would have been — a
hover on row 1 shoves row 2 sideways; that was reproduced deliberately (see
below). `handGestures` builds its peek strips per row and picks the row by
`clientY` before the card by `clientX`; `reorderHandAt` takes (x, y) and picks
the row by y, then the index by x, then converts to a position in the whole
hand. `renderSelection` walks `.card-face-wrap` rather than `.hand`'s children,
which are now containers with no card id.

**The slack is measured, and it is not the middle's spare room alone.**
`handSlack` asks `#felt-middle` how much height it has beyond its tallest child
— asked of the children, never a list, because #136 is adding a board row to
that same middle — and then subtracts what the felt is ALREADY over the screen
by. Without that second term the middle simply grows to whatever it is asked
for, its spare reads as zero however far the hand has pushed the table off the
bottom, and the gate never closes: a probe that ate the felt's middle showed
exactly that, and shows the gate closing now. The figure is normalised to what a
ONE-row hand would see, because the slack measured with two rows is smaller by
the second row, and feeding that back in would flip the fan on alternate
renders. The answer is then cached against its inputs the way `seatFit` caches
the seat row's rung, with the slack quantised to 16px so a chip growing a digit
is not a new question.

**`layoutHand` reads the card's width off its computed style.** `--hand-card-w`
is `clamp(70px, 8.6vh, 104px)` on a tall window and `parseFloat` read that as
70, so every desktop fan was spaced for a card 4px narrower than the one on the
felt — #135's root cause, arriving here because the row arithmetic needs the
real number. Off the computed style rather than a rect: `getBoundingClientRect`
reports the visual box, and this runs during the deal, so a card measured
mid-animation comes back 2.5% small and the whole fan is spaced for it (that was
a live bug in the first cut, caught by a step of 42.18 where 43.24 was expected).

### How it was verified

Two dev servers, this branch and main, driven by the same probes. At 375×812
with thirteen cards, Thirteen and Team Spades go from **one row at 14.5px a card
to two rows at 43.3px**, `#table-screen.scrollHeight` 812 on both sides.
Cribbage's crib discard goes 34.8 → 43.2 and Pinochle's meld declaration 15.8 →
24.2, both still one row and both still `scrollHeight === innerHeight` — the
meld phase is the case the slack gate exists for. All nine packs boot clean at
375×812, 812×375 and 1280×860 with no page errors: Hearts 10.9 → 33.3 (two
rows), Milestones 19.3 → 29.6, Wildfire 29.0 → 43.2.

At 1280×860 `#hand-row`'s rect and every band on the felt are byte-identical
before and after, and the cards keep their size and their y. What moves is the
fan's step, 65.80 → 69.52, and that was proved to be the card-width read alone:
reverting that one line and re-running the identical probe reproduces main's
65.80px and main's exact card positions.

Row isolation was measured rather than argued, by reading the computed transform
of every card while one is lit: hovered, hinted and peeked on either row, a
scrub along each row, and a card dragged from row 1 into row 2. In every case
only cards in the lit card's own row move, a scrub along a row lights only that
row's cards, and the drag lands the card in the other row with the hand the same
size. **Proven to bite:** flattening the same two-row fan into one wrapping list
— the shape it would have without `.hand__row` — makes a hover on a row-1 card
shift six row-2 cards. **The slack gate was proven to bite too:** a filler
taller than the felt's middle drops the fan back to one row on its own, and
removing it brings the second row back.

`npm test` 816 pass / 0 fail; `node tools/pack-test.mjs --all` all nine packs
0 failed; `tests/handZOrder.test.js` still refuses a shared rung and a ranked
lift with no gap rule. The new `fanLayout` tests were each broken on purpose and
each went red: the floor lowered to `TIGHTEST` so nothing splits, the slack term
dropped so rows are bought with height that is not there, the pairs cap removed
so a row is left holding one card, `handRows` dealt round-robin instead of left
to right, the loop spread as wide as it was allowed instead of stopping at the
fewest rows, and the hysteresis removed.

**Not done, and why.** The issue's optional last item — `--pile-w` 52 → 68px on
a portrait phone, out of whatever slack is left — is **left out, measured**.
Thirteen, Team Spades, Cribbage's discard and Pinochle's meld all still fit at
68px, but **Stockpile overflows by 211px**: its deck-plus-four-builds row is
5 × 52px plus gaps precisely so it fits one line at 375px (the note on the
`max-width: 420px` block says so), and at 68px it folds onto three lines. The
375px felt therefore keeps its empty green in the middle, which is #136's
question rather than this one's. The left-handed peek order is also unchanged
and still slightly wrong — `cardStripAt` assumes DOM order runs left to right,
which `row-reverse` inverts, so a left-handed scrub reads each card's strip off
the wrong edge. That is pre-existing, it is one row's worth of the same bug it
always was, and fixing it is a change to which strip a finger is answered by
rather than to where the rows are.
## The card width the fan was actually given (#135)

### What was wrong

`layoutHand` measured the row and then read the card off the stylesheet:

```js
const cardWidth = parseFloat(styles.getPropertyValue('--hand-card-w')) || 70;
```

A custom property comes back from `getComputedStyle` as the token stream that
was written — no viewport units resolved, no `clamp()` evaluated — and on a
desktop window `--hand-card-w` is `clamp(70px, 8.6vh, 104px)` (`table.css`).
`parseFloat` read that as `NaN`, the `|| 70` swallowed it, and every desktop
fan was laid out for 70px cards whatever size the cards on screen were. At
375px the property is a plain `46px` and parses, which is why the bug was
invisible on a phone and invisible to `fanStep`'s tests.

The consequence was the round-5 complaint that the hand "keeps a ~40% overlap
between cards even down to three cards in a 1041px-wide row" (item 44c).
`fanStep`'s ceiling is `0.94 × cardWidth`, so the widest any desktop fan could
open was 65.8px — measured at 1041×1200, Cribbage: 103px cards at a 65.8px
step, a 36% overlap with 300px of the row going spare, and the same 65.8px at
six cards and at three. `fanStep` was never wrong; the number going into it
was. #122's "the fan flexes both ways" fix therefore only worked on windows
short enough for the clamp to sit near its floor. `liftGap` and `fanWidth`
share the same `cardWidth`, so the reserve that keeps the rightmost card off
the rail was computed for the wrong card too.

### What changed

A pure `resolveCardWidth({ rendered, declared, fallback })` in
`src/ui/handOrder.js` — a finite positive measurement wins, else the parsed
declaration, else the fallback — and `layoutHand` passes it the first hand
card's width and the property string. The DOM half stays one measurement; the
rule is pinned in `tests/interaction.test.js`.

`offsetWidth` rather than `getBoundingClientRect().width`, which is the one
non-obvious decision here. `layoutHand` runs at the end of `renderHand`, when
freshly dealt cards still carry `card-deal`, whose `deal-in` keyframes open at
`scale(0.85)` with `both` fill — and a client rect includes that transform.
Measured in-page on a 103.19px card: `offsetWidth` 103, the rect 100.33 mid
animation and 87.7 at the "from" keyframe. A layout width is the honest one; a
0.19px rounding loss is not worth a fan that resizes as the deal settles.

The declaration stays as the fallback rather than being dropped: on a phone it
is a real length, and it is all there is before the hand has been laid out.
Nothing else in `src/` parses a custom property — `getPropertyValue(` appears
exactly once outside the CSS — so `--pile-w`, which is also a `clamp()` on
desktop, has no equivalent bug. (The `pileW: null` the research probe saw was
the probe's own `parseFloat`.)

### How it was verified

Playwright against two servers, this branch and unmodified main, same probe.
Cribbage at 1041×1200: `--fan-step` 65.80px → 96.82px against a 103.19px card,
0.638 → 0.938 of the card's width, at six cards and again at three (played
through the crib discard into pegging). Team Spades at 1280×860, thirteen
cards: step 65.80px → 69.56px on 73.95px cards, rightmost card's right edge
1050.3 against the rail's left edge at 1066.3, `#table-screen.scrollWidth ===
clientWidth`, one row — the wider real width opens the fan without pushing it
under the rail. At 375×812 the numbers are byte-identical before and after, all
nine packs: a 13-card hand still fans at 14.50px, Hearts' 17 at 10.88px.

All nine packs boot clean at both viewports with no page errors, and none puts
a card under the rail (Hearts closes to 64.69px at 1280px for its 17 cards).
`npm test` 811/811, `node tools/pack-test.mjs --all` green for all nine packs,
`node --check src/ui/table.js`. The new test was proved to bite three ways:
preferring the declaration over the measurement, returning the measurement
unconditionally, and dropping the positive guard each turned it red, and it
went green again from a scratch copy.

## Next steps

Multiplayer (Phase 8), per-pack UI polish (per-pack `theme.css`, custom
card faces), and the contract-rummy bot improvement noted above. The UX
pass left two seams pointed at Phase 8 on purpose: head-to-head records
are keyed `bot:<id>` / `peer:<deviceId>` from the first write, and the
forfeit path is where a `bye` frame will go.
