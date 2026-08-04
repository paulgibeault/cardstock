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

## Known gap: multiplayer is designed, not built

`ARCADE_ENHANCEMENTS.md` Phase 8 is the full work breakdown — caps boot
gate, lobby over `onReady`, the frame/routing table, per-seat presence,
`overflowed` → snapshot resync, the `relayed:true` spoof check, and the
two- and three-launcher test scenarios. It is deliberately a later pass.

What this pass owed it, and delivered:

- `activeMatch` persists as **seed + event log**, re-hydrated by replaying
  the reducer — the identical payload a multiplayer `snapshot` frame and
  the resync path consume. `tests/replay.test.js` pins this for all five
  packs, so a regression to a bare state dump fails CI rather than quietly
  making Phase 8 expensive.
- The RNG is the platform's vendored `arcade-rng.js`, so every device
  replays the same stream from the same seed.
- The escaping/validation pass (`tests/security.test.js`) is the
  peer-input hardening Phase 8 builds frame-shape validation on top of.

Two seams are NOT yet in place and Phase 8 must add them: seat identity is
still a bare index (`HUMAN_SEAT`/`SEAT_COUNT` in `src/main.js`) rather than
`(deviceId, localIndex)`, and bot turns run on `Arcade.session` timers,
which freeze on suspend and must become host-wall-clock timeout events at a
shared table.

## Next steps

Multiplayer (Phase 8), per-pack UI polish (per-pack `theme.css`, custom
card faces), and the contract-rummy bot improvement noted above.
