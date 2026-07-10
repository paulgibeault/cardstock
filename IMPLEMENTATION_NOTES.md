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
  assertions across crazy-eights, uno, hearts, phase-10, skip-bo.
- **Headless bot-vs-bot simulation** (`tools/simulate.mjs`), scoped to
  round-completion (not full multi-round matches — see below).
- **A minimal vanilla table UI** (`index.html`, `src/main.js`,
  `src/ui/`) — playable solo vs. bots, verified end-to-end with a real
  headless Chromium session (Playwright) driving a full Crazy Eights hand
  to completion with zero console errors.
- **Zero arcade integration yet** — `Arcade.init()` etc. (design doc §17) is
  deliberately not wired up in this pass; the UI is a bare standalone
  prototype for proving the engine.

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
   exactly what that reaction needs to know. Skip-Bo would permanently
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
of just dumping high-value cards. `sequencing` (Skip-Bo) got a `pass` move
type for the one legitimate case where a seat has zero cards playable
anywhere and an empty hand — not a bug, just Skip-Bo's real "nobody can go"
edge case needing a defined action.

## Known limitation: `1000-sims-zero-stalls` bar is not met by two packs

The design doc's bar (§11) is that a pack "isn't done until 1,000 headless
simulations complete without a stall." At 1000 games, 4 seats:

| Pack | Completed | Notes |
|------|-----------|-------|
| crazy-eights | 1000/1000 | clean |
| uno | 1000/1000 | clean |
| hearts | 1000/1000 | clean |
| skip-bo | 910/1000 | see below |
| phase-10 | 306/1000 (12,000-move cap) | see below |

**Skip-Bo (91%)**: traced one stalled seed directly. All four hands were
empty, `draw` and `recycled` were both genuinely exhausted, and none of
the four stock-tops or discard-tops matched any build pile's required next
card. This is a real, if rare, property of the pack's rules as specified —
Skip-Bo's manifest only recycles completed build piles back into the
shared pool; personal discard piles never feed back in. It is not an
engine or template bug (confirmed by direct trace). A house-rule fix
(reshuffle discard piles too, once draw+recycled are both empty) would be
a manifest-level design decision, not something to patch silently into the
engine.

**Phase 10 (31%)**: also traced directly — the hit mechanism itself is
correct (verified with a hand-constructed scenario: a matching card is
found and offered). The slowness is structural to greedy bot play: a
laid-down seat's hand only shrinks via a *hit* (a rank/color match onto an
existing meld); plain draw+discard is net-zero every turn. Early in a
round only a few melds exist on the table, so hit opportunities are
genuinely scarce, and a seat that can't complete its own contract (bad
luck on a 10-card hand, no reshuffle until next round) just cycles
forever. This is a bot-strategy quality gap, not a rules defect — real
Phase 10 groups experience slow phase-1 rounds too, and normally shrug it
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

## Arcade platform enhancements (concurrent, separate session)

`ARCADE_ENHANCEMENTS.md` specs four additive `Arcade.peer` changes (E0-E3)
being implemented in the arcade repo concurrently. Nothing in this
implementation pass depends on them yet — no multiplayer/SDK wiring has
started. Re-verify against the arcade repo's actual state before starting
milestone 2 (P2P, design doc §15).

## Next steps (design doc §15 milestone 2+)

Arcade SDK integration (§17), P2P sync protocol, per-pack UI polish
(themes, custom card faces), and the contract-rummy bot improvement noted
above.
