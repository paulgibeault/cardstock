# The template contract

A **template** is a genre of card game — trick-taking, shedding, contract-rummy,
sequencing — expressed once, in code, and parameterised by every pack that uses
it (`CARD_PLATFORM_DESIGN.md` §13). A **pack** is a manifest: declarations only,
no code, no `pack.id ===` branch anywhere in `src/`.

This file is the interface between the two halves of the platform. It exists
because it did not: the contract was reverse-engineerable from six call sites
and nowhere written down, so per-genre knowledge kept accumulating in platform
files behind `template.id ===` switches, and adding a fifth template meant
editing the UI, the lobby, the card-style registry, the stats panel and the
rules page before a single card could be dealt.

**The rule this file enforces: templates DECLARE, the platform CONSUMES.** A
fifth template is a new file in `src/templates/` plus one entry in
`registry.js`, and nothing else.

`tests/templateContract.test.js` checks every template against what follows.

---

## Required — called unconditionally

The engine calls these without guarding; a template missing one is a crash, not
a degradation.

| Member | Signature | Notes |
|---|---|---|
| `id` | `string` | Matches its key in `index.js` and `registry.js`. |
| `defaultZones` | `(rules, seats) -> ZoneDef[]` | **Both parameters, always** — `state.js` passes both, and three of the four templates used to declare neither. Pack `zones` override these by id. |
| `setup` | `(ctx) -> void` | Round 1's deal. May write zones directly (see *Setup* below). |
| `validateMove` | `(ctx, move) -> {legal, rule?, reason?}` | Through `ctx.ok()` / `ctx.fail(rule, reason)`. The pipeline still accepts a bare `true`; do not write one. |
| `applyMove` | `(ctx, move) -> void` | Mutates only through `ctx`. |
| `enumerateLegalMoves` | `(ctx, seat) -> move[]` | The single source of what anybody may do. Bots pick from it; every tap target the table lights up is derived from it. **A move it omits must be one `validateMove` refuses**, or a bot will be offered a move that throws. |
| `isRoundOver` | `(ctx) -> boolean` | Usually `ctx.state.roundEnded` (see *Ending a round*). |

## Optional — every call site is guarded

Absent means "the platform's default", which is always a real behaviour rather
than an error.

### Engine

| Member | Signature | Default |
|---|---|---|
| `defaultReactions` | `(rules) -> Reaction[]` | none |
| `startRound` | `(ctx) -> void` | **⚠ see the trap below** |
| `scoreRound` | `(ctx) -> {seat: delta}` | `runRoundScore(ctx)` — the pack's declared strategy, or `{}` when it declares none |
| `isGameOver` | `(ctx) -> boolean` | `false`. Only consulted when the pack's `scoring.gameOver` is absent or says `"template"`. |
| `botHeuristic` | `(ctx, move) -> number` | every non-draw move scores equally |
| `actingSeats` | `(ctx) -> seat[]` | `[ctx.turn.seat]`. Say so for a simultaneous-commit phase, or the table will schedule only one of the seats that may act. |
| `enumerateAnnouncements` | `(ctx, seat) -> move[]` | none. Its presence is also what reserves the announce bar's slot on the felt. |
| `applyAnnouncement` | `(ctx, announcement) -> void` | none — the rule-test harness's entry point only |

> **⚠ The `startRound` trap.** A template without `startRound` gets the default
> round boundary, which **wipes every `playerVars` entry** before re-running
> `setup`. Any template with meta-state that outlives a round — contract-rummy's
> `phase` is the whole game — **must** implement `startRound`, or that state
> silently resets at the first round change.

### Presentation — what the platform asks a template about itself

None of these touch state. Each replaced a `template.id ===` switch in a
platform file.

| Member | Signature | Consumed by | Default |
|---|---|---|---|
| `interactionMode` | `(ctx) -> mode` | `src/ui/interaction.js` | `'tap'` |
| `pendingChoice` | `(ctx, move) -> Ask \| null` | `src/ui/table.js` | no question |
| `activeMatch` | `(ctx) -> {address, attr, value, onCard} \| null` | `describe.js`, `table.js` | none |
| `scoreChip` | `(ctx, seat) -> {short, long, aria} \| null` | `table.js` | the plain total |
| `committedSelection` | `(ctx, seat) -> cardId[] \| null` | `table.js` | none |
| `getMeldGroups` | `(ctx, seat) -> Group[]` | `table.js` | `[]` |
| `describeEvent` | `(ev, {seatLabel, humanSeat}) -> {text, tone} \| null` | `table.js` | the engine-effect vocabulary |
| `ruleLines` | `(rules) -> string[]` | `src/ui/rules.js` | none |
| `endingLines` | `(pack) -> string[]` | `src/ui/rules.js` | none |
| `statLines` | `(seatStats) -> {label, value, always?}[]` | `src/stats/matchStats.js` | moves + cards played |
| `botVerbs` | `{moveType: string}` | `table.js` | draw/playCard/discard/pass |

Plus three UI affordances that are genuinely per-genre and have no default —
the platform simply does not offer the gesture when they are absent:
`arrangeContract`, `suggestMeld` (contract-rummy's staging tray and hold-to-gather).

### Registry metadata

`genreLabel`, `defaultCardStyle` and `playable` are stamped onto the template
object by `index.js` from `registry.js`. They live in a table that **imports
nothing** because the lobby and the card-art registry read them from a manifest
string alone — the lobby's cost ceiling is that it never loads a pack.

---

## The interaction-mode vocabulary

The *vocabulary* is the platform's (a closed set of input shapes a table knows
how to render, exported as `INTERACTION_MODES` from `src/ui/interaction.js`).
*Which phase means which mode* is the template's.

| Mode | Gesture |
|---|---|
| `tap` | one tap plays the card; destination implicit |
| `play-drawn` | as `tap`, but only the just-drawn card answers; the action button keeps it |
| `pass` | multi-select exactly N, commit with the action button |
| `rummy-draw` | tap a pile to draw from it |
| `rummy-meld` | multi-select for a lay-down; one card arms meld chips and the discard |
| `place` | select a card, then tap the pile it goes on |

A mode this build does not know falls back to `tap`.

## `pendingChoice` — the Ask shape

The platform asks in a **loop** until the hook answers `null`, so one move may
owe several answers. A single option is applied **without prompting** — a
question with one answer is not a question.

```js
{
  attr,                 // 'suit' | 'color' | 'rank' | 'player' | anything
  prompt,               // completes "Choose a …"; defaults to attr
  kind: 'value'|'seat', // 'seat' means the platform dresses the options from its roster
  cardId,               // optional: the card shown in the dialog
  options: [{ value, label? }],
  apply(move, value) -> move,   // where the answer goes. The template decides.
}
```

`apply` is the whole point: the platform renders a chooser and knows nothing
about effect schemas, so a pack-defined effect gets one for free.

## Zone definition fields the platform reads

Beyond `id`/`per`/`visibility`/`layout`/`order`/`facing`/`capacity`/`count`/`label`
(`schema/manifest.schema.json` `$defs.zone`):

| Field | Meaning |
|---|---|
| `interactive` | invisible, but still a control the player taps (a draw pile) |
| `landing: 'play' \| 'discard' \| 'both'` | where a card lands when the move names no destination |
| `showsHeldValue` | this pile's contents are worth points; the felt shows the running cost |

## Ending a round

`ctx.endRound(winnerSeat)` — **this hand is finished**. Whether the *match* is
finished is not the template's call: it is the pack's `scoring.gameOver`, or
`template.isGameOver` where the pack says the template decides.

`ctx.setGameOver(winner)` means the match is over and nothing else. Templates
used to say "round over" with it and read it back out of `state.gameOver` in
their own `isRoundOver`, which is why the pipeline had to reset the flag.

## Derived events

`ctx.emit(type, payload)` writes to `state.events`, a **transient, never
persisted** channel the table animates and narrates from. `applyMove` clears it
per move, so a replay regenerates exactly the same stream.

The vocabulary in use today:

| Event | Emitted by | Payload |
|---|---|---|
| `roundOver` | pipeline | `{round, scores, totals, over}` |
| `roundStart` | pipeline | `{round}` |
| `recycled` | state reactions | `{from, to, count}` |
| `pileCleared` | state reactions | `{zone, to, count}` |
| `trickWon` | trick-taking | `{seat, cards, points, trickNumber}` |
| `cardsPassed` | trick-taking | `{direction}` |
| `skipped` | shedding effects | `{by, seat}` |
| `reversed` | shedding effects | `{by, direction}` |
| `penalty` | shedding effects | `{by, seat, drew, asked}` |
| `handsSwapped` | shedding effects | `{by, seat}` |
| `handsRotated` | shedding effects | `{by, direction}` |
| `wildPlayed` | shedding | `{seat, chose}` |
| `drewPlayable` | shedding | `{seat}` |
| `announced` | shedding | `{seat, id, label}` |
| `caught` | shedding | `{seat, target, drew, label}` |
| `laidDown` | contract-rummy | `{seat, contract, melds}` |
| `hit` | contract-rummy | `{seat, targetSeat, meld}` |

An event may carry `say: {text, tone}` to name its own banner sentence; that is
the cheapest seam for an effect the platform has never heard of.

## Setup

Trick-taking's deal writes zone arrays directly rather than going through
`ctx.moveCards`, which means **reactions do not fire during it**. That is
sanctioned *for the initial deal only* — there is nothing for a `zoneEmpty`
reaction to respond to while the deck is being handed out, and the alternative
is a recycle firing mid-deal. Everything after setup goes through `moveCards`.
