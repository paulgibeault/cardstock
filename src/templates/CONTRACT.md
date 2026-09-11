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
| `botHeuristic` | `(ctx, move, weights?) -> number` | every non-draw move scores equally |
| `evaluateState` | `(ctx, seat, weights?) -> number` | none — the bot ranks by `botHeuristic` alone |
| `matchStanding` | `(ctx, seat) -> number` | the seat's accumulated score, signed by `scoring.gameOver.winner` — see *What the `hard` bot asks of you*. Asked per SEAT even in a partnership; the engine folds it — see *Partnerships* |
| `actingSeats` | `(ctx) -> seat[]` | `[ctx.turn.seat]`. Say so for a simultaneous-commit phase, or the table will schedule only one of the seats that may act. |
| `enumerateAnnouncements` | `(ctx, seat) -> move[]` | none. Its presence is also what reserves the announce bar's slot on the felt. |
| `applyAnnouncement` | `(ctx, announcement) -> void` | none — the rule-test harness's entry point only |

> **The `weights` member.** A template whose strategy is made of tuned numbers
> gathers them into one frozen object, `weights`, and reads every one of them
> through the third argument of `botHeuristic` and `evaluateState` — which
> defaults to that object, so ordinary play never notices. `rankMoves` passes
> whatever a caller gave it, and a `hard` rollout plays every chair with the
> deciding seat's set. That is what lets `tools/tune.mjs` seat a candidate set
> against the shipped one in the same simulated game: two seats, one template,
> two opinions, and no module-level state changed to do it. The constants keep
> their own comments; the object is the shipped value of each, and tests hold
> it to a frozen bag of finite numbers.

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
> silently resets at the first round change. Trick-taking's is a BAG: a bid is
> this hand's and goes with it, while an overtrick sits on the side's sheet
> until ten of them have cost a hundred points, several hands later.

### Presentation — what the platform asks a template about itself

None of these touch state. Each replaced a `template.id ===` switch in a
platform file.

| Member | Signature | Consumed by | Default |
|---|---|---|---|
| `interactionMode` | `(ctx) -> mode` | `src/ui/interaction.js` | `'tap'` |
| `gathers` | `(ctx, seat) -> boolean` | `interaction.js`, `table.js` | whether the current mode is one that stages |
| `pendingChoice` | `(ctx, move) -> Ask \| null` | `src/ui/table.js` | no question |
| `activeMatch` | `(ctx) -> {address, attr, value, onCard} \| null` | `describe.js`, `table.js` | none |
| `zoneFocus` | `(ctx, address) -> {cards, label, seat?} \| null` | `describe.js`, `zoneRenderer.js` | none |
| `scoreChip` | `(ctx, seat) -> {short, long, label?, aria} \| null` | `table.js` | the SIDE's total (the seat's own, where there are no sides), labelled `Score` |
| `seatCounters` | `(ctx, seat) -> {text, aria, label, kind?}[] \| null` | `table.js` | the hand count, labelled `Cards` |
| `tableCounters` | `(ctx) -> {text, label, aria?}[] \| null` | `table.js` | no strip at all |
| `commitPrompt` | `(ctx, seat) -> {action, staging, waiting, count \| min+max, moveType?} \| null` | `interaction.js`, `table.js` | count and move type read off the enumeration; the button says "Commit" |
| `poseMove` | `(ctx, move) -> boolean` | `src/ui/table.js` | no pose; the felt paints where the move ENDED |
| `zoneReading` | `(ctx, inst) -> {badge, line?} \| null` | `src/ui/describe.js` | the pile's number is its card count |
| `committedSelection` | `(ctx, seat) -> cardId[] \| null` | `table.js` | none |
| `zoneCardOwners` | `(ctx, address) -> (seat\|null)[] \| null` | `src/ui/zoneRenderer.js` | none — a spread zone's cards carry no owner |
| `contractChips` | `(ctx, seat) -> Chip[] \| null` | `src/ui/contractStrip.js` | none — the strip stays hidden |
| `getMeldGroups` | `(ctx, seat) -> Group[]` | `table.js` | `[]` |
| `describeEvent` | `(ev, {seatLabel, seatPossessive, seatVerb, viewerSeat}) -> {text, tone, priority?} \| null` | `table.js` | the engine-effect vocabulary |
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
| `pass` | multi-select exactly N, commit with the action button — N, the button's words and the status line all come from `commitPrompt` |
| `rummy-draw` | tap a pile to draw from it |
| `rummy-meld` | multi-select for a lay-down; one card arms meld chips and the discard |
| `place` | select a card, then tap the pile it goes on |
| `bid` | no card answers a tap; the action button asks a question and the answer is the move |
| `combination` | multi-select **any** number, commit with the action button — which arms only while the selection is a legal play |
| `take-pile` | tap one of several face-down piles to take the **whole** of it; the hand is empty and inert |

A mode this build does not know falls back to `tap`.

`take-pile` is `rummy-draw`'s shape at a different scale, and it is a separate
mode because the two sentences a pile says are different: "draw a card from
this" and "take this as your hand". Thirteen at two seats is the case — three
face-down piles of seventeen, one each, the rest set aside (`rules.offer`) —
and the model is the same one every other pile target uses: a `readyTargets`
entry per enumerated move, keyed by the zone address. Nothing goes in
`handSelectable`, because in this phase there is no hand.

`combination` is the one whose legality is a **live** answer rather than a
count. `pass` commits at exactly N and the button can be armed by counting; a
climbing play is one card, or a pair, or six cards that happen to be three
consecutive pairs, and none of the selections on the way to any of those is a
play. So the button asks `validateMove` on every tap (`selectionLegality`,
`src/ui/interaction.js`), which is the one place the UI does not derive a target
from `enumerateLegalMoves` — deliberately, and the comment there says why: a
climbing enumerator is a shortlist by necessity, and refusing a move the engine
accepts is a worse failure than the one that invariant guards against.

## `commitPrompt` — what a `pass`-mode commit button says and does

`pass` is the gesture for **every** simultaneous commit: pick cards out of the
fan, watch them stage, press the button. What is not shared is the *sentence*
on the button, the *move* it makes, and *how many* cards arm it — and all three
were Hearts' answers written into the platform (`passCards`, "Pass across",
exactly `rules.passing.count`) for as long as Hearts was the only pack that
committed anything.

Pinochle's meld phase is the second, and it shares none of them. It declares a
scoring selection of **any** size — a hand with no meld in it still has to say
so, which is a commit of zero cards — and it moves no card anywhere.

```js
commitPrompt(ctx, seat) {
  if (ctx.turn.phase !== 'meld') return null;   // null takes the default
  return {
    action: 'Declare', moveType: 'declareMeld',
    min: 0, max: ctx.countIn(`hand.${seat}`),
    staging: 'Declare your meld', waiting: 'Waiting for melds…',
  };
}
```

One shape serves both commit phases the repo has (#107's crib discard, #106's
meld) and Hearts' pass:

| Field | Meaning | Default |
|---|---|---|
| `action` | the button's words (under `ACTION_LABEL_MAX_CHARS`) | `Commit` |
| `staging` / `waiting` | the status bar while this seat picks / while it waits for the others | `Pick N` / `Waiting…` |
| `count` | the exact-N shape: a pass, a crib | the enumerated commit's card count |
| `min` / `max` | the ranged shape: a meld of any size | both `count` |
| `moveType` | the move the button makes | read off the enumeration — name it only for a commit that may carry ZERO cards, which has no card-carrying move to read it from |

The button exists only while the enumerator is offering that move, whatever
the template declares: a seat that has already committed gets none.

**Why this rather than a seventh interaction mode.** A mode is a rendering
vocabulary: six downstream surfaces branch on it (`buildUiModel`,
`stagingPhase`, `dropCandidates`, `draggableSources`, the status bar, the
staging tray). Adding one to render an identical gesture would mean teaching
all six a new string, and every one of those branches is a place for the two
commit phases to drift apart. Asking the template what its own button says
costs one hook and leaves every existing pack on the default it already had.

Note `min: 0` is real, and the platform handles it: with nothing picked up
there is no `selection.from` to check, so an empty selection arms the button
only when the floor is zero.

## `gathers` — the question a mode cannot answer

`interactionMode` says how a tap is READ. It cannot say whether a given seat is
still assembling anything, because it is derived from `ctx.turn.phase` — and
`turn.phase` is **one value for the whole table**. While any seat is drawing,
contract-rummy's mode is `rummy-draw` for everybody, the human sitting off-turn
with half a meld in the tray included.

That is not a detail. Gating the off-turn staging tray on the mode switched it
off for the first half of every opponent's turn and back on for the second —
reported from a playtest as the hand and the meld pile being "interrupted" —
and a tray that goes inert while still holding cards is worse than dead: taps
on a staged card fell through to the single-select branch and threw the whole
gathered meld away.

```js
gathers(ctx, seat) {
  return !ctx.playerVar(seat, 'laidDown');
}
```

**Say nothing about `ctx.turn` here.** Gathering is not a phase; it is a
standing fact about that seat's ROUND, which is why it is asked per seat and
why the answer may be `true` for a seat that cannot move a card. The platform
consumes it in three places: the off-turn affordance and hold-to-gather arming
in `buildUiModel`, and — issue #13's rule notwithstanding — whether the staging
row reserves its slot at all (`renderStageTray`). A tray that yields its space
the moment its owner lays down moves the felt once per round, at a moment the
board changed anyway; #13 was about a strip flickering twice a turn all match.

The default is the mode-based answer, which is exactly right for a pack that
gathers for as long as the phase lasts: Hearts' pass tray opens and closes with
the pass. Implement the hook when the seat can be finished before the phase is.

One place the default is deliberately not consulted: the **off-turn** tray is
offered only to a template that implements `gathers`. The default is a
statement about the table, and off-turn the difference between "the table is in
a staging phase" and "this seat is still assembling something" is the whole
question — Hearts' passers commit simultaneously, so a seat that has passed is
off-turn with the staging mode still open and nothing left to arrange.

## `pendingChoice` — the Ask shape

The platform asks in a **loop** until the hook answers `null`, so one move may
owe several answers. A single option is applied **without prompting** — a
question with one answer is not a question.

```js
{
  attr,                 // what is being chosen, in the TEMPLATE's words
  art,                  // what to DRAW: 'suit' | 'color' | 'rank'; defaults to attr
  prompt,               // completes "Choose a …"; defaults to attr
  question,             // a whole sentence, for a step that is not "choose a <noun>"
  status,               // optional: what the status bar says while the dialog is open
  kind: 'value'|'seat', // 'seat' means the platform dresses the options from its roster
  cardId,               // optional: the card shown in the dialog
  options: [{ value, label? }],
  apply(move, value) -> move,   // where the answer goes. The template decides.
}
```

`apply` is the whole point: the platform renders a chooser and knows nothing
about effect schemas, so a pack-defined effect gets one for free.

**`attr` is not `art` and neither is the sentence.** The chooser's pictures come
from a closed platform vocabulary (`src/ui/cardStyles/chooser.js` knows `suit`,
`color` and `rank`); `attr` is whatever the template calls the question. They
were one field, which was invisible for as long as every Ask used a word from
both lists and silently deleted the art the moment one did not: Pinochle's trump
step asked for a tile called `trump`, got null, and drew four word buttons in
the one pack whose entire vocabulary is pips (#125). The art is also looked up
by an option's **`value`**, never its `label` — the value is the pack's own
token, the label is prose about it.

## `contractChips` — the contract strip

One chip per fact the table has to keep saying: what is promised, by whom, and
in what suit. Rendered above the felt's middle (`src/ui/contractStrip.js`);
answer `null` and the row stays hidden and costs no height.

```js
{
  key,     // a slug the stylesheet may dress ('trump', 'bid', 'contract', 'meld')
  label,   // the word in front of the number
  value,   // the number or word itself, already a string
  suit,    // optional: drawn as the pack's own card (art.chooser)
  seat,    // optional: whose it is — drawn with that seat's roster mark
  aria,    // the whole chip as one phrase
}
```

`seat` is the half of an auction a number cannot carry on its own: once two
chairs have both bid, both their plate chips read the same gold and only a name
says which one is ahead.

## `poseMove` — the position a move passes THROUGH

Some moves do two things at once because the rules say they do: the fourth card
of a trick is played and the trick is gathered inside one `applyMove`, and a
replay has to reach the same position at the same move. The felt renders what
the move ENDED in, so that middle position — four cards on the table, before
the seat that won them takes them away — was never on screen at all (#123).

```js
poseMove(ctx, move) -> boolean   // true: this fork is a pose worth holding
```

Called by `src/ui/table.js` on a **throwaway fork of the pre-move state**, the
same copy `takeRoundFinal` advances for a round ending, and never on the live
state: the pose is never logged, saved, published or scored. Answer `false` for
a move with no middle worth showing and the half-applied fork is discarded —
which is the only safe thing to do with a move that has been half made.

Keep it cheap and keep it a subset: a pose that emitted events, ended a round or
moved a card the real move does not move would be a second set of rules living
in the renderer. Trick-taking's is one statement — the card onto the trick —
and it answers `false` for every play but the one that completes it.

## Which cards on a pile are still live — `zoneFocus`

A pile can hold more than the thing you are answering. Thirteen's `pile` holds
every card played this trick, in sequence, on purpose — it *is* the trick, and
everybody watched it happen — but the combination you have to beat is only its
tail, and the felt used to report the whole heap as a count. A `3` on a trick
where three singles have been played is true and useless: the thing to beat is
one card (#122).

```js
zoneFocus(ctx, address) -> { cards: cardId[], label: string, seat?: number } | null
```

`cards` are the ids still in play — the renderer rings those and draws the rest
as history — and `label` is what to call them ("Pair of 4s"), which becomes the
pile's badge, the first line of its inspector and part of its accessible name.
Null for every zone with nothing standing on it, which is every zone in every
pack that does not implement this.

## Saying which event ENDED the move — `priority`

`describeEvent` (and an event's own `say`) may carry `priority`, a number that
defaults to 0. One move may emit two describable events, and the banner shows
ONE: the pass that ends a Thirteen trick emits `passed` and then `trickCleared`.
Highest priority wins, ties fall to the first emitted — so a template that says
nothing about priority keeps the old behaviour exactly.

## Naming a seat in a sentence — `seatLabel` and `seatPossessive`

`describeEvent` is handed both, and a template that narrates a seat should use
them rather than building a name itself. WHAT A SEAT IS CALLED is the table's
business: it depends on the roster, on what the player typed as their name, and
on whether the seat is the one reading the sentence.

| Helper | Answers | Local seat |
|---|---|---|
| `seatLabel(seat)` | the name to put in a sentence | `You` |
| `seatPossessive(seat)` | that name in the possessive | `Your` |

**Do not write `${seatLabel(seat)}'s`.** It is correct for every proper noun at
the table and wrong for the one label that is a pronoun, so it reads perfectly
while you watch an opponent and says **"You's hand is worth 2."** the moment the
sentence is about the reader. That shipped in #107 and is visible in that
issue's own screenshot; `tests/possessive.test.js` is the gate, and it checks
the rule, the sentence, and that no template has started spelling one by hand
again.

`viewerSeat` is still there for the wording that is not a name at all — a
sentence that is *different* in the second person rather than merely inflected
("Skipped — your turn is gone" against "Ada is skipped"). Reach for the helpers
first; reach for `viewerSeat` when the whole clause changes.

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
  return [{ text: String(stock), aria: `${stock} left in stock`, label: 'Stock', kind: 'stock' }];
}
```

Most important first: the first entry is worn as the primary badge and the rest
as smaller marks beside it. `text` is what is printed — keep it to a couple of
characters — and `aria` is the whole truth said in words, because the printed
form is a glyph and a digit. `kind` is an optional slug the stylesheet may use;
it must be a value the TEMPLATE chose, never pack data (§7b).

**`label` is REQUIRED, and it is drawn** (#133). It is the word printed under
the number on an open seat plate — one short noun, sentence case here and
upper-cased by the stylesheet: `Cards`, `Bid`, `Tricks`, `Bags`, `Meld`,
`Stock`, `Pegs`. Before it was drawn, a plate read `Bruno 0 12 150 —` and its
only name was an `aria-label` nobody sighted ever hears; Pinochle's `—` for
"passed" was a dash with no word at all. Minimized faces still show the bare
number — there is no room, and the plate opens on tap — so the label costs
width only where there is width to spend. `tests/seatPlate.test.js` fails a
counter that ships without one.

**These are asked of every seat, open or minimized**, so the badge in a given
spot on the row always means the same quantity. Mark a counter
`minimizedOnly: true` when it is genuinely redundant on an open seat — a rummy
meld count sits directly above the meld chips, and Hearts' points sit above the
won pile that holds them. Do NOT use it for the primary number: a row that read
`20 20 5 20 20`, where the 5 was the open seat showing a hand count while the
rest showed stock, is the bug this rule exists to prevent.

Return `null` or `[]` to take the default.

### A counter that is a POSITION — the track kinds

Most counters are a quantity of things and a pill of digits says them
completely. A few are a place on a road, and a pill throws away the whole
point: a cribbage board is 121 holes with two pegs a side, and "78" is a
fraction of what it tells you.

`kind` is what says which. **The set of kinds that render as a track is the
PLATFORM'S** — a closed list, exported as `COUNTER_TRACK_KINDS` from
`src/ui/counterTrack.js`, exactly like `INTERACTION_MODES` — and which kind a
counter is remains the template's. A kind this build has never heard of gets
the ordinary badge, which is the same fail-soft the mode vocabulary has.

A track counter carries three numbers beyond the usual ones:

| Field | Meaning |
|---|---|
| `value` | where the front marker is now |
| `from` | where it was before this seat's last score — the BACK peg |
| `of` | how long the road is |

```js
seatCounters(ctx, seat) {
  const value = ctx.score(seat);
  return [{
    text: String(value), aria: `${value} of ${ctx.rules.target}`,
    label: 'Pegs', kind: 'peg', value, from: ctx.playerVar(seat, 'backPeg') ?? 0,
    of: ctx.rules.target,
  }];
}
```

`text` is still printed beside the track, so nothing is lost if the geometry
is not readable at a glance; `aria` is still the whole truth in words, and the
track's parts are `aria-hidden` so a screen reader hears one sentence rather
than "peg, peg, 78".

This is what a board that is not a zone looks like. No card is ever in it, so
nothing on the felt could have drawn it, and the two obvious ways to add one —
a `board` hook only one template will ever implement, or a `pack.id ===` in the
seat renderer — are both the thing this file exists to prevent.

## Zone definition fields the platform reads

Beyond `id`/`per`/`visibility`/`layout`/`order`/`facing`/`capacity`/`count`/`label`
(`schema/manifest.schema.json` `$defs.zone`):

| Field | Meaning |
|---|---|
| `interactive` | invisible, but still a control the player taps (a draw pile) |
| `onFelt` | invisible, and FURNITURE rather than a control: drawn as backs with its count, because everybody watched the cards go in (cribbage's crib) |
| `hideWhenEmpty` | not a place on the table until it holds something |
| `table` | a PER-PLAYER zone every seat's copy of which is drawn together in the felt's middle, full size and marked with its owner, instead of one copy in your pile row and a mini copy on each plate — for a per-player pile that is read across the seats (cribbage's `play`) |
| `landing: 'play' \| 'discard' \| 'both'` | where a card lands when the move names no destination |
| `showsHeldValue` | this pile's contents are worth points; the felt shows the running cost |

The middle four are all about WHERE a pile is drawn and none of them about
what may be seen in it — `visibility` remains the only thing that decides
that.

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
| `crib` | cribbage | `none` — including from the DEALER who owns it. A crib its owner could leaf through before the show is a different game. |
| `show` | cribbage | `all`. Where the crib is turned face up to be counted; the MOVE into it is the reveal (see below). |
| `play` | cribbage | `all`, per player. Laid face up in front of you during the count, and taken back for the show — which is why this template never has to remember who played what. |
| `starter` | cribbage | `all`. Cut face up. |
| `offer` | climbing | `none`, two-handed only (`rules.offer`). The other pile nobody may look into, and for a reason the crib does not have: you are about to CHOOSE one of these, and a seat that could read a pile before taking it is not choosing. `interactive`, so the hidden pile stays on the felt as the phase's only control, and `hideWhenEmpty`, so each one leaves as it is taken. |
| `aside` | climbing | `none`, and drawn nowhere at all. The pile nobody took, plus the odd card the split left over — out of play, and hidden rather than discarded, because `discard` is public and `unseenBy` counts it as SEEN: seventeen cards nobody has ever looked at are not that. |

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

## Partnerships

A pack may declare `players.teams: N` and be played in **sides**: seats deal
round-robin into `N` of them, so seat *s* plays for side `s % N` and a partner
sits `seats / N` chairs away — opposite, at the four-seat two-side table this
was built for. `src/engine/sides.js` is the whole vocabulary and every answer is
computed from the pack on demand, so a game whose partners ROTATE grows a shape
there and nothing else moves.

**A template still scores per seat.** `scoreRound` returns `{seat: delta}` as it
always did and the engine folds the seats into their side — so a bids-and-bags
scorer may hand a side's whole 120 to one partner or split it sixty each, and a
scorer that has never heard of partnerships gets the right answer for free.
`state.scores` stays per seat and the side's total is derived; nothing was added
to the match payload, which is why `MATCH_FORMAT_VERSION` did not move.

What the platform folds for you:

| Question | Answered for |
|---|---|
| `scoring.gameOver`'s `anyScore >= N` | the SIDE's total |
| `placements` / `sideStandings` (`src/stats/matchStats.js`) | the SIDE; partners share a place |
| the `hard` bot's terminal signal | the SIDE's change in standing, against the other SIDES |
| the felt's score chip, and one chip per side | `src/ui/seatRing.js` |

**A pack with no `players.teams` has one side per seat**, so every fold above is
the identity and nothing in this table is a new behaviour for it —
`tests/replayIdentity.test.js` holds the five shipped packs to serializing the
same bytes they did before any of it existed.

Two things a template still owns:

* **`matchStanding` is asked per SEAT**, because a chair is all a template can
  see, and the engine sums it over the side. A hook that tries to answer for the
  side itself will be counted twice.
* **`scoreChip`, if you override it,** owes its own fold. The default is the
  side's total; a template that replaces it and reports one partner's half will
  disagree with every other number on the screen.

`state.winner` is a **seat** and stays one — the canonical (lowest-numbered)
member of the winning side. Nothing asks `winner === mySeat` to mean "did I
win"; it asks whether the winner is on your side.

**Which way is up is the pack's, and an evaluator must read it.** The bot's
match standing already signs the accumulated score by
`scoring.gameOver.winner`, and `evaluateState` owes the same reading: Hearts
prices a won pile as a bill because its points are the penalty, and the same
pile at a pack whose `winner` is `highestScore` is an asset. Trick-taking
writes both of its evaluators in the direction the SCORE moves and turns the
answer round once (`prizeSign`), which is why adding a points-are-the-prize
game to it changed no number Hearts was measured on. Get this wrong and the
bot plays to lose while every test stays green.

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
| `bidMade` | trick-taking | `{seat, bid, blind}` |
| `broken` | trick-taking | `{seat, cards, suit, card: {rank, suit}, selector, varName}` — once a hand, on the false→true flip of `rules.breaking.var`. `suit` is what may now be LED (not always the suit of the card: in Hearts the queen of spades breaks hearts) |
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
| `laidToCrib` | cribbage | `{seat, count}` |
| `starterCut` | cribbage | `{cards}` |
| `hisHeels` | cribbage | `{seat}` |
| `pegPlay` | cribbage | `{seat, count, points, parts}` |
| `go` | cribbage | `{seat, closes?}` |
| `pegged` | cribbage | `{seat, points, reason, total}` |
| `showScored` | cribbage | `{seat, isCrib, points, parts, cards}` — each part is `{kind, points, n, at}`, where `at` are POSITIONS in `[...cards, starter]` rather than card ids, so the show card can light a combination's cards without an id crossing the view filter |

An event may carry `say: {text, tone}` to name its own banner sentence; that is
the cheapest seam for an effect the platform has never heard of.

## Setup

Trick-taking's deal writes zone arrays directly rather than going through
`ctx.moveCards`, which means **reactions do not fire during it**. That is
sanctioned *for the initial deal only* — there is nothing for a `zoneEmpty`
reaction to respond to while the deck is being handed out, and the alternative
is a recycle firing mid-deal. Everything after setup goes through `moveCards`.

---

## What a new template actually cost

The claim at the top of this file — *a fifth template is a new file in
`src/templates/` plus one entry in `registry.js`, and nothing else* — was
written from four templates that had all grown up together. Every template
added after it writes down here what it really took, whether or not that
flatters the claim. They are in the order they were built, because the second
one is partly a test of whether the first one's findings were about the
contract or about that one genre.

### Climbing (#102) — six files, not two

The claim above was written from four templates that all predate it, so it was
a description of reverse-engineered code rather than a promise anything had
kept. `climbing` is the first template built against it. **The claim is wrong
as stated**, and it is worth being precise about how, because the shape of the
error is more useful than the headline.

It cost **six files, not two** — and one of them is a genuine platform edit:

| File | What it needed | Fair? |
|---|---|---|
| `src/templates/climbing.js` | the template | promised |
| `src/templates/registry.js` | its row (genre word, card art, playable) | promised |
| `src/templates/index.js` | an import and a map entry | **the contract forgot this one.** It is the module that turns an id into a template; nothing can load without it, and it is not `registry.js`. Two entries, not one. |
| `src/ui/interaction.js` | one new mode in `INTERACTION_MODES`, its `buildUiModel` and `dropCandidates` branches, and `selectionLegality` | **a real platform edit, and the contract already predicted it**: "the vocabulary is the platform's; which phase means which mode is the template's". A genre with a genuinely new input shape has to add one. A genre reusing an existing shape adds nothing. |
| `schema/manifest.schema.json` | the `template` enum, a `$defs.rules-climbing`, a fifth `allOf` clause | mechanical, and the schema is normative, so it is not optional |
| `src/templates/melds.js` | `groupByRank` and `rankWindow` lifted out and shared | a choice, not a cost — the alternative was a second definition of "consecutive" |

And what it did **not** cost is the part that says the contract is mostly
working. **`src/ui/table.js` — three thousand lines, and the file this document
exists because of — needed no edit at all.** Neither did the lobby, the rules
page, the card-style registry, the stats panel, the bot driver, the celebration
banner, or `src/engine/` (not one line: #101 had already made the rank ladder an
engine primitive, which is that policy paying for itself). The hooks carried
everything: a new event vocabulary through `describeEvent`, a new turn shape
through `actingSeats`, a genre's prose through `ruleLines`/`endingLines`, a new
verb through `botVerbs`. `interactionMode` was the seam, and it held.

Three more edits landed in `tests/`, and they are worth listing because they are
the same class of thing and nobody counts them: `tests/interaction.test.js`
keeps its own hardcoded copy of the mode vocabulary, and `tests/view.test.js`,
`tests/simulate.test.js` and `tests/cardStyles.test.js` each keep a hand-written
list of the packs on disk. A fifth PACK, not a fifth template, is what those
cost.

**So the honest sentence is:** a new template is a file in `src/templates/`, two
entries (`registry.js` and `index.js`), a `rules-*` block in the schema — plus
one entry in `INTERACTION_MODES` **only if** its input shape is genuinely new,
which is the one thing the platform cannot infer. Everything else is hooks.

### Cribbage (#107) — two entries, a schema block, and one genuinely new renderer

Climbing's honest sentence above is a hypothesis, and this is the second
measurement of it. It came out **cheaper than climbing on every line it
predicted, and one line more expensive on a line it did not.**

**The claim held for the game itself.** `src/templates/cribbage.js` and its
`registry.js` + `index.js` entries are the whole of the rules: four phases, a running count, a
crib, a show, and a bot. Nothing in `src/engine/` changed. Nothing in the felt,
the lobby, the card-art registry, the stats panel or the rules page needed to
learn that cribbage exists. The `defaultZones`/`setup`/`validateMove`/
`applyMove`/`enumerateLegalMoves`/`isRoundOver` surface carried a genre with a
simultaneous commit, an auto-resolved "go", a second scoring pass over the same
cards, and a match decided mid-hand, without a single new required member.

**Two files beside it, both by choice.** `src/templates/cribbage-score.js` is
the fifteen/pair/run/flush/nobs table as a pure function, split out so the whole
12,994,800-hand distribution can be swept by a test that never loads the engine.
`packs/cribbage/` is a manifest, as every pack is. Neither is a cost the
contract did not predict; the second is the contract working.

**Four edits outside those, and they are the honest part.** Two of them are on
climbing's list already (the schema block; the `tests/` fixture that is really
a fifth-PACK cost). The other two are new information.

1. **A new optional hook, `commitPrompt`** (`src/ui/interaction.js`,
   `src/ui/table.js`). The `pass` interaction mode read `rules.passing.count`
   and `vars.passDirection` — trick-taking's own two parameters, by name, in
   two platform files — and the status bar branched on
   `turn.phase === 'pass'`, one template's word for its own phase. That looked
   harmless while trick-taking was the only template using the mode. Cribbage
   wants two cards and a crib, not three and a direction, and its phase is
   called `discard`. So the mode now asks the template how many cards it wants
   and what to say, and the move type comes from the enumeration. **This was a
   pre-existing leak that a second user of the mode exposed**, not a cost
   cribbage imposed: trick-taking implements the hook and the felt says exactly
   what it said before.
2. **A new platform renderer, `src/ui/counterTrack.js`,** and its stylesheet
   block. A cribbage board is a score drawn long, and it had nowhere to be
   drawn. Keyed on a counter `kind` from a closed platform vocabulary — never
   on a pack or a template id — so it is available to the next genre that
   scores along a road. ~110 lines plus CSS.
3. **A `$defs.rules-cribbage` block and an `allOf` clause** in
   `schema/manifest.schema.json`, plus `cribbage` in the `template` enum. This
   is per-template by construction (see the `rankLadder` note in that file) and
   every template pays it.
4. **A stub in `tests/cardStyles.test.js`'s `MANIFEST_STUBS`**, which is a test
   fixture asserting each pack's card back is its own. Every new PACK pays this,
   not every new template.

**What it did NOT cost, which is the finding.** No engine change. No new
interaction mode — the `pass` mode was reusable once it stopped reading one
template's rules. No `template.id ===` or `pack.id ===` anywhere; the two gates
in `tests/templateContract.test.js` stayed green throughout. No new required
member. And the two genuinely novel demands — a score that moves mid-hand and a
match that ends the instant it does — were met with `ctx.addScore`,
`scoring.gameOver: "template"` and `isGameOver`, all of which already existed.

**What the second measurement says about the first.** Climbing's sentence — a
file, two entries, a `rules-*` block, plus an `INTERACTION_MODES` entry only if
the input shape is genuinely new — held exactly. Cribbage's input shapes are a
multi-select commit and a tap, both of which already existed, and it added no
mode. What the sentence does not yet cover is **output**: a genre can need a way
of DRAWING something the felt has never drawn, without needing a new way of
being played. A board is that, and `src/ui/counterTrack.js` is what it cost. So
the sentence gains a clause — *plus one renderer keyed on a platform-owned
vocabulary, only if the genre displays something the felt has no shape for* —
and the reason both halves are stated the same way is that they are the same
rule: the vocabulary is the platform's, and which entry in it a template wants
is the template's.

**One rule deliberately not modelled as the issue described it.** Cribbage's
`cut` is a step inside the move that completes the discard, not a phase. A
phase in this engine is a state in which somebody has a decision, and cutting
has none — modelling it as one would mean a move type, an interaction mode with
no card to tap, and one unavoidable click per hand, thirty of them in a match.
Reversing that decision is a move type and a mode; it is written up in the file.
## What a template's BOT cost, on the same template (#103, `climbing`)

The section at the top of this file priced a fifth template. This one prices
the other half — giving it an `evaluateState`, a frozen `weights` bag and three
house-rule variants — because the contract makes claims about all three and
only one of them had ever been tested by somebody following it rather than
somebody documenting it.

**It cost one file.** `src/templates/climbing.js` grew a `weights` object of
eight numbers, an `evaluateState`, and the two rules keys the variants needed;
`schema/manifest.schema.json` grew those two keys because the schema is
normative and closed. Nothing in `src/engine/` and nothing in `src/ui/` was
touched. The bot layer, the tuner and the variant machinery all consumed it
without knowing which template had arrived — which is the claim the `weights`
note above makes, now with a second template behind it.

**Two things are worth knowing before you write the fourth one.**

**The fairness gate does not cover the one-ply path.**
`tests/rollouts.test.js` probes the `hard` chooser, and `hard` deals itself an
ignorant world before it reads anything (`src/engine/determinize.js`) — so an
`evaluateState` that reads an opponent's hand is *invisible* to that gate. It
is `medium` where the evaluator sees the real state. A template offering the
hook should carry its own probe (`tests/climbing.test.js`, "the evaluator
judges the position without seeing the hands it is judging against"):
determinize the position and demand `chooseBotMove(state, seat)` — no options,
so no sampling in the way — answers the same. Note also that a read of an
opponent's hand which does not vary with the acting seat's own cards cannot
change a one-ply ranking at all, so a probe has to break something the
candidates actually differ on; a hand-count term is the honest example of the
same shape, and is why this evaluator has none.

**A `startRound`-time end has nothing to end it.** `maybeFinishRound`
(`src/engine/movePipeline.js`) runs after an applied MOVE and nothing else
runs it, so a template that discovers during the deal that the hand is already
decided cannot call `ctx.endRound` there — the round sits unresolved until
somebody plays, and is then scored one card into a hand that had already
started. The shape that works is to leave the fact in a var, offer the seat it
names exactly one legal move, and let the ordinary round boundary do the rest.
Climbing's `instantWins` (tới trắng) is the worked example.
