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
| `evaluateState` | `(ctx, seat) -> number` | none — the bot ranks by `botHeuristic` alone |
| `matchStanding` | `(ctx, seat) -> number` | the seat's accumulated score, signed by `scoring.gameOver.winner` — see *What the `hard` bot asks of you* |
| `actingSeats` | `(ctx) -> seat[]` | `[ctx.turn.seat]`. Say so for a simultaneous-commit phase, or the table will schedule only one of the seats that may act. |
| `enumerateAnnouncements` | `(ctx, seat) -> move[]` | none. Its presence is also what reserves the announce bar's slot on the felt. |
| `applyAnnouncement` | `(ctx, announcement) -> void` | none — the rule-test harness's entry point only |

> **⚠ The `evaluateState` contract.** `botHeuristic` grades a **move**;
> `evaluateState` grades the **position** a move would leave behind — "how good
> is this for `seat`", higher is better. Offering it turns on the generic
> one-ply search in `src/engine/bot.js`: every legal move is played out on a
> `forkState` copy (`src/engine/fork.js`) and the resulting position scored.
> Three rules make it usable:
>
> * **The scale is yours**, per-template, and only ever compared against
>   itself — but it must be **seat-symmetric**. `evaluateState(ctx, s)` has to
>   mean the same thing for every `s`, or the bot prefers positions merely
>   because of who was asked about them.
> * **Read only what that seat is entitled to see** — public zones, its own
>   hand, declared public vars. A bot is handed the whole state, opponents'
>   hands and stock order included; reading them here is a bot that always knew
>   you had the queen, and nothing would catch it. Say in the comment what the
>   evaluator deliberately does not read. The search layer helps: it refuses to
>   judge any move whose fork turned up a card the seat could not see
>   beforehand (drawing off a face-down deck, completing a simultaneous pass),
>   and falls back to `botHeuristic` for that whole turn.
> * **Return `null`** for a position you cannot judge; the turn falls back to
>   `botHeuristic`. Rounds that END inside the move are never passed to you at
>   all — the pipeline has already dealt the next hand by then.

> **⚠ What the `hard` bot asks of you, which is nothing new.** The rollout
> layer (`src/engine/bot.js`) plays a hand out to its end and grades the result
> with hooks you already implement, so no template has to know it exists:
>
> * **The change in `matchStanding` across the hand is the terminal signal.**
>   A finished rollout is graded by how much further along the match it left
>   the seat, against how much further along it left everyone else. Without
>   the hook the standing is the accumulated score, so the difference across
>   one hand is exactly `scoreRound`'s answer — and a template whose
>   `scoreRound` returns `{}` (Stockpile) gives every rollout the same value.
>   The chooser detects that — every candidate tied means the scorer has no
>   opinion — and drops back to one ply for that turn rather than ranking by
>   enumeration order.
> * **Export `matchStanding` when the match is not decided by points.**
>   Contract-rummy does: a Milestones match is won by laying the last contract
>   down, and the round score never decides it, so its standing is the rung
>   reached, priced above anything a round's points can amount to, with the
>   points behind it as a tie-break (#92). The rules are `evaluateState`'s:
>   your own scale, seat-symmetric, public information only — and one more,
>   because it is **differenced across a round boundary**: it must mean the
>   same thing before and after the redeal. A standing that reads a per-round
>   var the redeal resets is a signal that says every hand was a catastrophe.
> * **The pack's manifest says which way is up**, via
>   `scoring.gameOver.winner`: `highestScore` means points are the prize,
>   anything else (including `"template"`) means they are the penalty. A pack
>   that gets this wrong gets a bot that plays to lose, and nothing else in the
>   codebase would notice. A `matchStanding` of your own is not read through
>   it — higher is better, full stop.
> * **`isRoundOver` has to be reachable from mid-hand under greedy play.** A
>   rollout that never finishes is thrown away, so a template that can only end
>   a hand through a move no heuristic would choose gets no search at all.

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
| `seatCounters` | `(ctx, seat) -> {text, aria, kind?}[] \| null` | `table.js` | the hand count |
| `committedSelection` | `(ctx, seat) -> cardId[] \| null` | `table.js` | none |
| `getMeldGroups` | `(ctx, seat) -> Group[]` | `table.js` | `[]` |
| `describeEvent` | `(ev, {seatLabel, viewerSeat}) -> {text, tone} \| null` | `table.js` | the engine-effect vocabulary |
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

## `seatCounters` — what a minimized seat is worth showing

A crowded opponent row minimizes the seats that cannot act to a face
(`src/ui/table.js`, SEAT_TIERS). That face has room for a name and one or two
small numbers, and **which numbers those should be is a fact about the genre**,
not about the platform.

The platform's default is the hand count, which is right wherever the hand is
the race — shedding empties it, and a rummy contract is finished by going out.
It is exactly wrong for sequencing: Stockpile tops every hand back up to five
at the end of a turn, so a minimized row read "5 cards" five times over while
the stock count — the thing the entire game is a race on — was the number it
had put away.

```js
seatCounters(ctx, seat) {
  const stock = ctx.countIn(`stock.${seat}`);
  return [{ text: String(stock), aria: `${stock} left in stock`, kind: 'stock' }];
}
```

Most important first: the first entry is worn as the primary badge and the rest
as smaller marks beside it. `text` is what is printed — keep it to a couple of
characters — and `aria` is the whole truth said in words, because the printed
form is a glyph and a digit. `label` names it in the inspector. `kind` is an
optional slug the stylesheet may use; it must be a value the TEMPLATE chose,
never pack data (§7b).

**These are asked of every seat, open or minimized**, so the badge in a given
spot on the row always means the same quantity. Mark a counter
`minimizedOnly: true` when it is genuinely redundant on an open seat — a rummy
meld count sits directly above the meld chips, and Hearts' points sit above the
won pile that holds them. Do NOT use it for the primary number: a row that read
`20 20 5 20 20`, where the 5 was the open seat showing a hand count while the
rest showed stock, is the bug this rule exists to prevent.

Return `null` or `[]` to take the default.

## Zone definition fields the platform reads

Beyond `id`/`per`/`visibility`/`layout`/`order`/`facing`/`capacity`/`count`/`label`
(`schema/manifest.schema.json` `$defs.zone`):

| Field | Meaning |
|---|---|
| `interactive` | invisible, but still a control the player taps (a draw pile) |
| `landing: 'play' \| 'discard' \| 'both'` | where a card lands when the move names no destination |
| `showsHeldValue` | this pile's contents are worth points; the felt shows the running cost |

## `visibility` as a FILTERING vocabulary — the per-seat audit

`visibility` predates multiplayer and, until `src/engine/view.js`, only the
renderer read it. Its values therefore meant "draw this face down" rather than
"do not tell them", and the two are not the same claim: a renderer that hides a
pile still has the cards in memory, and a peer that is sent them has them for
good.

Every zone in every template was re-read against the filtering question. The
rule the view layer applies:

| `visibility` | What a peer is sent |
|---|---|
| `all` | every id, in order |
| `owner` | every id **to its owner**; a bare count to everyone else |
| `top` | the top id and a count; the pile beneath stays hidden |
| `none` | a count, to everybody — **including the owner** |

And the audit itself, which is the part worth keeping:

| Zone | Template | Filtering decision |
|---|---|---|
| `hand` | all four | `owner`. The one that matters. |
| `draw` | shedding, contract-rummy, sequencing | `none` — this pile IS the remaining shuffle; publishing its order publishes every future draw. |
| `discard` | shedding, contract-rummy | `top`. Not merely taste: shedding RECYCLES the discard back into the draw pile, so its order is the future deck. |
| `discard` | sequencing | `all`, and deliberately not `top` — **playability**, not secrecy, is what limits these to the top card. Everyone can see what you have thrown. |
| `melds` | contract-rummy | `all`. Laid face up on the table. |
| `trick` | trick-taking | `all`. Face up in the middle. |
| `won` | trick-taking | `none` **plus `heldValue`**. The subtlest one: nobody may leaf back through the tricks, yet the running point cost is public, because everyone watched them being taken. A count alone would have deleted a number the felt has always shown. |
| `stock` | sequencing | `top`. The count is the whole race and is public anyway. |
| `build` | sequencing | `top` + capacity. |
| `recycled` | sequencing | `none`. Feeds the draw pile. |

### Vars

Per-player vars use the `__` prefix the templates already had for their own
bookkeeping (`__pendingPass`, shedding's `__<id>Called`/`__<id>Seen`): a
`__` var reaches **only its owner**. Hearts' passing phase is a simultaneous
commit, and a commit anybody else can read is not one.

Shared vars are an **allowlist**: `publicVars` below. Anything a template does
not declare is treated as this turn's private bookkeeping and reaches only the
seat whose turn produced it.

**This is fail-closed on purpose.** The live example is shedding's
`drawnCardId`, which holds a card sitting in a player's hand — in a SHARED
var. A denylist would have had to know to exclude it in advance; an allowlist
simply never published it. A fifth template that declares nothing leaks nothing.

| Member | Signature | Notes |
|---|---|---|
| `publicVars` | `string[] \| (rules) -> string[]` | Optional. A FUNCTION when the names come from the rules: shedding publishes one `active<Attr>` per attribute the pack matches on, and trick-taking publishes whichever var the manifest named for "hearts are broken". |

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
