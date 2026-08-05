# Card Platform Design (working name: "Cardstock")

A single dynamic platform, delivered as one game in Paul's Arcade, that plays
many different card games. Each game is a **card-pack**: a folder of
configuration, optional logic, styles, and assets that fully aligns the
gameboard to that game's needs. The platform supplies everything card games
have in common; the pack supplies only what makes its game *that* game.

**Scope**: games played exclusively with cards. No chips, boards, dice, or
bank (multiplayer poker is explicitly out of scope for now).

**Launch validation set** — four games chosen because each stresses a
different part of the engine:

| Game     | Genre           | What it stresses                                      |
|----------|-----------------|-------------------------------------------------------|
| Hearts   | Trick-taking    | Follow-suit rules, simultaneous passing, penalty scoring, shoot-the-moon |
| Uno      | Shedding        | Custom deck, card effects, direction reversal, out-of-turn announcements ("Uno!", challenges) |
| Phase 10 | Contract rummy  | Melds, per-player contract progression across rounds, hitting |
| Skip-Bo  | Sequencing/race | Shared build piles, per-player stock racing, zone recycling |

If the engine handles all four cleanly, most of the pure-card-game space
follows.

**Integration note**: the platform is one entry in the arcade catalog, loads
`arcade-sdk.js`, and uses `Arcade.peer.*` as its only multiplayer transport
and `Arcade` storage for saves/stats. §17 is the full integration contract,
aligned with the arcade docs at protocol **v2** (SDK surface, transport
semantics, lifecycle, settings, security checklist) as of 2026-07-10.

---

## 1. Architecture: three layers

```
┌────────────────────────────────────────────────────────────┐
│ Layer 3 — PACK HOOKS (escape hatch)                        │
│  logic.js: validateMove, scoreRound, onMoveApplied, …      │
│  Overrides/extends any decision point. Plain JavaScript.   │
├────────────────────────────────────────────────────────────┤
│ Layer 2 — GENRE TEMPLATES (shipped with the platform)      │
│  trick-taking · shedding · contract-rummy · sequencing     │
│  Each is a parameterized implementation built on Layer 1.  │
│  A pack picks one template and configures it.              │
├────────────────────────────────────────────────────────────┤
│ Layer 1 — ENGINE PRIMITIVES                                │
│  cards/decks · zones · turn/phase machine · move pipeline  │
│  event log + seeded RNG · scoring · sync · table UI · bots │
└────────────────────────────────────────────────────────────┘
```

**Design principle — JSON describes, JavaScript decides.** The manifest is
data: it names the template, sets parameters, declares variants, and lists
assets. Anything the template's parameters can't express goes in `logic.js`
as an ordinary function. We deliberately do **not** build a Turing-complete
rules DSL: the moment a rule is awkward to express as data, it belongs in a
hook. This keeps the declarative layer honest (and machine-generatable) and
keeps the ceiling unlimited.

Packs are first-party trusted code living in this repo. No sandboxing
gymnastics; `logic.js` is an ES module imported by the engine. (If
URL-loaded third-party packs ever happen, revisit this — see §14.)

---

## 2. Card & deck model

A card is data. The engine never hard-codes "52 cards, 4 suits."

```json
{
  "id": "hearts-Q",
  "rank": "Q",
  "suit": "hearts",
  "color": "red",
  "value": 13,
  "sortOrder": 37,
  "tags": ["penalty"],
  "effect": null,
  "face": "auto"
}
```

- `id` — unique within the deck *definition*. When multiple copies exist,
  instances get `id#n` at deal time.
- `rank` / `suit` / `color` — display and matching attributes. Any may be
  null (Skip-Bo cards have rank + color only; a wild has neither).
- `value` — default point value used by the scoring engine (overridable).
- `sortOrder` — default hand-sort position.
- `tags` — arbitrary strings for rules to query (`"penalty"`, `"wild"`).
- `effect` — optional reference into the effects library (§7).
- `face` — `"auto"` (vanilla renderer draws it) or an asset key.

A **deck file** is a list of card definitions with counts:

```json
{
  "id": "uno-108",
  "cards": [
    { "def": { "rank": "0", "color": "red", "value": 0 }, "count": 1 },
    { "def": { "rank": "1", "color": "red", "value": 1 }, "count": 2 },
    { "def": { "rank": "skip", "color": "red", "value": 20, "effect": "skip" }, "count": 2 },
    { "def": { "rank": "wild", "value": 50, "effect": { "type": "wild", "choose": "color" } }, "count": 4 }
  ]
}
```

**Built-in decks**: `standard-52`, `standard-54` (two jokers),
`standard-52xN` (multi-deck). Card ids follow `<suit>-<rank>` (`clubs-2` …
`spades-A`); built-in cards carry `value: null` — point values come from the
pack's `scoring` section (§6). Packs may ship their own deck file or compose
built-ins.

**Deck expansion**: a `cards` entry may carry a `forEach` map for Cartesian
expansion — one entry emits a whole color/rank family, with `$<var>`
substituted into def string values (`"value": "$rank"` coerces numerically).
The Uno-style deck is 7 entries instead of 54. When multiple physical copies
of one definition exist, instances are addressed `<id>`, `<id>#2`, `<id>#3`, …

**Vanilla renderer**: composes any card face in SVG from rank/suit/color —
rank corners, suit glyphs or color panel, proper red/black (or four-color
mode, §12). A pack with zero art still looks clean. Card backs likewise have
a vanilla design, overridable per pack.

---

## 3. Zones

Every card is in exactly one zone at all times. Zones are the universal
spatial vocabulary; all game structure is "cards move between zones."

```json
{
  "id": "hand",
  "per": "player",
  "visibility": "owner",
  "layout": "fan",
  "order": "sorted",
  "facing": "up",
  "capacity": null,
  "label": "Hand"
}
```

| Field        | Values | Notes |
|--------------|--------|-------|
| `per`        | `player` \| `shared` | `player` creates one instance per seat |
| `visibility` | `owner` \| `all` \| `none` \| `top` | `top` = top card public, rest hidden (discard piles). Drives per-player state filtering (§8) — not just rendering |
| `layout`     | `fan` \| `stack` \| `row` \| `grid` \| `spread` | Vanilla table renderer handles all |
| `order`      | `stack` (LIFO) \| `sorted` \| `free` | `sorted` uses card `sortOrder` |
| `facing`     | `up` \| `down` | Default card orientation in this zone |
| `capacity`   | number \| null | Engine fires `onZoneFull` when reached |

Standard zone ids the templates expect (packs can add more): `hand`,
`draw`, `discard`, `trick` (current trick in play), `won` (tricks taken),
`melds`, `stock`, `build.N`.

**Zone lifecycle events** the engine emits: `onZoneEmpty`, `onZoneFull`,
`onCardEnter`, `onCardLeave`. Declarative reactions cover the common cases:

```json
"reactions": [
  { "when": "zoneEmpty:draw", "do": "recycle", "from": "discard", "keepTop": true, "shuffle": true },
  { "when": "zoneFull:build.*", "do": "moveAll", "to": "recycled" }
]
```

Anything fancier is a `logic.js` hook.

---

## 4. Turn & phase engine

A hierarchical state machine: **game → rounds → turns → phases**.

```json
"flow": {
  "rounds": { "endWhen": "template", "dealer": "rotate" },
  "turn": {
    "order": "clockwise",
    "phases": ["draw", "play", "discard"]
  },
  "roundPhases": [
    { "id": "pass", "type": "simultaneous", "when": "roundStart",
      "config": { "count": 3, "direction": ["left", "right", "across", "none"] } }
  ]
}
```

- **Direction of play** is engine state; effects can flip it (Uno's
  Reverse) or the manifest can fix it.
- **Turn phases** are sequential steps within one player's turn; each phase
  declares which move types are legal in it. Templates preset these
  (shedding: `play-or-draw`; contract rummy: `draw → meld/hit → discard`).
- **Round phases** run outside individual turns. Two types:
  - `sequential` — one player at a time (a bidding round, later).
  - `simultaneous` — **all players act privately, then reveal together.**
    Hearts' passing phase requires this. Implemented as commit-then-reveal:
    each client submits its committed action to the host; the host reveals
    all at once when everyone has committed.
- **Skips, extra turns, reversals** are engine operations exposed to
  effects and hooks (`ctx.actions.skipNext()`, `ctx.actions.reverse()`).

### Announcements (out-of-turn actions)

Some actions are legal *outside* strict turn order. These are first-class,
not bolted on — Uno alone requires them:

```json
"announcements": [
  { "id": "uno-call", "who": "self", "window": "whenHandCount:1",
    "missed": { "challengeBy": "anyone", "penalty": { "draw": 2 } } },
  { "id": "wd4-challenge", "who": "victim", "window": "afterEffect:wildDraw4",
    "resolve": "hook:resolveWd4Challenge" }
]
```

An announcement declares who may make it, the window in which it's valid,
and what happens when it's made / missed / challenged. The engine handles
the racing (claims are ordered by the host's event log, §8). Templates use
this for "declare last card" mechanics; hooks can define bespoke ones
(jump-in Uno as a variant).

---

## 5. Move pipeline

Every player action is a `Move`:

```json
{ "actor": 2, "type": "playCard", "cards": ["hearts-Q"], "from": "hand", "to": "trick", "choice": null }
```

Pipeline: **propose → validate → apply → log → broadcast**.

Validation is layered, cheapest first:

1. **Engine**: is it this actor's turn/window? Are the cards actually in
   `from`? Does the phase allow this move type?
2. **Template rules**: parameterized genre logic (must follow suit; card
   must match discard on color-or-rank; meld must satisfy the contract).
3. **Pack hook**: `validateMove(ctx, move)` — final say.

Each validator returns `true` or `{ legal: false, rule: "follow-suit",
reason: "You must follow suit — you still hold a club." }`.

Two platform features fall out of this design for free:

- **Legal-move highlighting.** The engine enumerates candidate moves and
  runs the validator over them; playable cards glow, playable zones
  highlight on drag. This is also the bot's move generator (§10) and the
  hint system's source (§12).
- **"Why not?" explanations.** A rejected move surfaces its failing rule's
  reason as a toast. Every pack becomes self-teaching without writing help
  text.

**Constraint relaxation.** Declarative lead/play constraints relax
automatically when they would leave the player with *zero* legal moves —
Hearts' "no leading hearts until broken" yields when the hand is all hearts.
The engine guarantees every player always has at least one legal move (or an
explicit draw/pass path); the simulation harness treats any counterexample
as a stall bug.

---

## 6. Scoring & match structure

```json
"scoring": {
  "cardValues": { "suit:hearts": 1, "hearts-Q": null, "spades-Q": 13 },
  "roundScore": "penalty-cards-taken",
  "accumulate": true,
  "gameOver": { "when": "anyScore >= 100", "winner": "lowestScore" }
}
```

- `cardValues` — selector → points map (selectors: exact id, `suit:`,
  `rank:`, `color:`, `tag:`, `*`; most specific match wins). Effective value
  precedence: `cardValues` match → the card's deck-file `value` if non-null →
  `defaultValue` → 0. `defaultValue` accepts a number or `"faceValue"`
  (numeric rank as value — Crazy Eights scores 2–10 at pip value with three
  overrides).
- `roundScore` — a template-provided strategy name or `hook:scoreRound`.
  Round-scoring and game-over strategies are configured *here*, not in the
  template's `rules` block — one home, no duplication.
- `gameOver` — small expression vocabulary (`anyScore >= N`,
  `rounds == N`, `template`) with `hook:isGameOver` as the escape hatch.
- Shoot-the-moon and similar inversions are exactly what the `scoreRound`
  hook is for; the trick-taking template also ships a built-in `sweepBonus`
  parameter since the pattern recurs.

The platform owns the scoreboard UI, per-round score history, and match
persistence (save/resume via Arcade storage).

---

## 7. Effects library

Built-in card effects, primarily for shedding games but usable anywhere:

| Effect | Config | Behavior |
|--------|--------|----------|
| `skip` | — | Next player loses their turn |
| `reverse` | — | Flip direction (acts as skip in 2-player) |
| `drawN` | `n` | Next player draws N, loses turn; `stackable` variant flag |
| `wild` | `choose: suit\|color` | Player picks the active suit/color |
| `wildDrawN` | `n`, `challengeable` | Wild + drawN; optional challenge via announcement |
| `skipTarget` | — | Player picks who is skipped (Phase 10's Skip) |
| `swapHands` | `choose: player` | Exchange hands (crazy-Uno variants) |
| `rotateHands` | — | All hands rotate in play direction |

An effect config may set `on: "play" | "discard"` (default `play`) — Phase
10's Skip does nothing in the hand and fires only when discarded.

Effects are engine operations sequenced through the event log, so they
compose with turn order, direction, and announcements correctly. A pack can
define new effects in `logic.js` (`export const effects = { myEffect(ctx, move) {...} }`)
and reference them from its deck file by name.

---

## 8. State, determinism, and P2P sync

**The keystone decision: the game is event-sourced.** Game state is the
result of a deterministic reducer over an ordered event log, with all
randomness drawn from a seeded PRNG whose seed is in the log. One decision,
many payoffs: reconnect resync, undo, replays, spectators, headless
simulation, and trivially correct sync.

```
Event: { seq, actor, type, payload }
State = reduce(initialState(seed), events)
```

**Authority model: host-authoritative.** The player who creates the table
is the host (authority). Clients send *proposals*; the host validates,
applies, assigns `seq`, and broadcasts. Rationale: serverless P2P among
friends; simplest model that is actually correct for hidden information.

**Hidden information — per-player views, delivered honestly.** The host
computes a filtered view of every event per seat, according to zone
visibility (§3):

- Deal event → seat B's view contains the card ids dealt *to B*; other
  seats' views carry only counts. Face-down piles are counts everywhere
  but the host.
- A card enters a player's view only when it enters a zone visible to
  them (played to the table, passed to their hand, discard top).

Delivery uses the arcade's targeted-send enhancement (E1,
`ARCADE_ENHANCEMENTS.md` — implementation underway in the arcade repo):
private frames go out as `Arcade.peer.send(payload, { to: deviceId })` and
the platform routes them so **non-addressee clients never receive them**;
public events broadcast plainly. Two caveats, both accepted:

- Joiner↔joiner targeted frames transit the host bridge readable —
  inherent to the star topology and irrelevant here: the host is the
  authority and knows the full state anyway.
- End-to-end sealing plus commit-reveal dealing (so even the host can't
  peek) is the one deferred anti-cheat upgrade, kept possible by the
  abstract dealing interface. Not in scope at friend-scale.

**Sync protocol** — kinds: `lobby`, `claim-seat`, `propose`, `event`,
`reject`, `snapshot-req`, `snapshot`, `emote`, `bye`; clients speak only to
the host (targeted), and the host targets each seat's private view while
broadcasting public events. The full mapping to `Arcade.peer.*` — status machine,
replay-queue handling, lobby-over-`onReady`, resync triggers — is the
integration contract in **§17.5**. Key transport gifts the protocol leans
on: the channel is ordered + reliable per link, and sends made during an
`'interrupted'` repair are queued and replayed **exactly-once**, so the
event log needs no dedup/reorder logic in normal operation; host log `seq`
exists for resync after terminal drops or queue overflow.

Host disconnect: clients hold through `'interrupted'` (the transport is
self-repairing — rendezvous auto-reconnect can heal even a total loss);
only a terminal `'idle'` pauses the match. The host's log is persisted
(§17.3), so the table resumes when the host returns via one-tap reconnect
or Call. Host migration is explicitly deferred — document the limitation,
don't build it yet.

**Undo**: replay log minus last event(s). Allowed only where the manifest
permits (`"undo": "own-turn-until-committed"` | `"none"`) — trick-taking
generally forbids it once information is revealed.

---

## 9. Table UI (platform-owned)

Packs get all of this without writing UI code:

- **Auto-seating** for 2–8 players around the table; local seat always at
  bottom; layouts adapt to portrait/landscape and screen size.
- **Opponent displays**: card backs with counts, name, turn indicator,
  score, last action ticker ("Dana drew 2").
- **Input**: drag-and-drop *and* tap-to-select → tap-destination (mobile
  first-class); long-press to inspect a card; multi-select for multi-card
  moves (melds, passing).
- **Hand tools**: sort (by the deck's `sortOrder` or by suit/rank toggle),
  auto-arrange, pinch/spread fan density.
- **Animations**: deal, flip, slide, gather-trick, shuffle, fan — engine
  events map to animations automatically. Respect the arcade's
  reduced-motion setting.
- **Overlays**: scoreboard, round summary, rules reference (generated from
  the manifest, or the pack's `rules.md`), variant list in effect.
- **Social**: lightweight emotes/reactions over P2P; turn timers optional
  per manifest (`"turnTimer": null | seconds`).
- Honors arcade settings through the SDK's DOM hooks: rem-sized text
  (font scale is free), `[data-theme]`, the reduced-motion CSS kill-switch,
  `[data-handedness]`, `--audio-volume` — concrete wiring in §17.7. The
  table renderer is an event-driven dirty-flag renderer on `Arcade.loop`
  (§17.6), so hidden/suspended tables cost nothing.

**Pack styling**: `theme.css` with a documented set of CSS custom
properties (table felt, card back, accent colors, fonts) plus asset keys in
the manifest (card faces sprite/SVG, back image, table texture, sound map).
Rich packs may register **custom zone renderers** in `logic.js` for
signature moments (Phase 10's phase-progress tracker; Hearts' trick-gather
flourish) without taking over the whole table.

---

## 10. Bots

The legal-move enumerator (§5) makes a baseline bot nearly free:

```
candidates = enumerateLegalMoves(state, seat)
scored     = candidates.map(m => heuristic(ctx, m))   // pack hook or default
play(argmax)
```

- **Default heuristic** per template (shedding: dump highest-value playable
  card; trick-taking: duck when losing is good, etc. — deliberately simple).
- Packs may export `botHeuristic(ctx, move) -> number` and optionally
  named **personalities** (`{ "cautious": {...weights}, "aggressive": {...} }`).
- Bots fill empty seats at start and power **hints** ("what would the bot
  play?") and the **simulation harness** (§11). Disconnect takeover keys off
  the transport's status machine (§17.5): during `'interrupted'` the session
  is self-repairing and sends replay exactly-once — the table shows
  "reconnecting…" and **waits**; only a terminal `'idle'` (grace expired)
  frees the seat for host-controlled bot-fill / pause / end.
- Bots run on the host, act through the same propose/validate pipeline as
  humans — no special paths.

---

## 11. Pack format, testing, and dev workflow

### Layout

```
packs/<pack-id>/
  manifest.json        required — everything declarative
  deck.json            optional — omit if using a built-in deck
  logic.js             optional — hooks, custom effects, renderers, bot heuristic
  theme.css            optional — CSS custom properties + extra styling
                       (must style BOTH [data-theme] values — §17.7)
  rules.md             optional — hand-written rules; else generated from manifest
  assets/              optional — cards.svg | faces/*.png, back.svg, table.jpg, sounds/*
  tests/rules.test.json  strongly encouraged — see below
```

### Manifest skeleton

```json
{
  "id": "hearts",
  "name": "Hearts",
  "version": "1.0.0",
  "players": { "min": 3, "max": 6, "best": 4 },
  "deck": "standard-52",
  "template": "trick-taking",
  "rules": { /* template parameters, §13 */ },
  "flow": { /* overrides of template defaults, §4 */ },
  "zones": [ /* additions/overrides of template defaults, §3 */ ],
  "cardTags": { /* selector → extra tags — tags cards in built-in decks (Hearts' penalty cards) */ },
  "reactions": [ /* zone lifecycle reactions, §3 */ ],
  "scoring": { /* §6 */ },
  "announcements": [ /* §4 */ ],
  "variants": [
    { "id": "jack-of-diamonds", "name": "Jack of Diamonds (−10)",
      "default": false, "patch": { "scoring.cardValues.diamonds-J": -10 } }
  ],
  "undo": "none",
  "turnTimer": null,
  "ui": { "back": "assets/back.svg", "felt": "#1b5e3a", "sounds": {} },
  "credits": "…", "license": "…"
}
```

**Variants are first-class.** Each variant is a named, defaultable JSON
patch against the manifest (and may reference hook flags). The lobby host
toggles variants before deal; active variants are shown in the table
overlay and recorded in the event log (they're part of determinism).

### Hook API (`logic.js`)

All hooks are optional. `ctx` exposes read-only state queries
(`ctx.zone(id)`, `ctx.hand(seat)`, `ctx.score(seat)`, `ctx.var(name)`,
`ctx.turn`, `ctx.direction`, …) and, in lifecycle hooks, command emitters
(`ctx.actions.move(cards, from, to)`, `ctx.actions.setVar()`,
`ctx.actions.skipNext()`, `ctx.actions.endRound()`, …) that append events —
hooks never mutate state directly, preserving determinism and sync.

```js
export function setup(ctx) {}                    // after deal, before first turn
export function validateMove(ctx, move) {}       // final legality gate
export function onMoveApplied(ctx, move) {}      // react: triggers, chains
export function isRoundOver(ctx) {}              // override template's default
export function scoreRound(ctx) {}               // return {seat: points} — shoot-the-moon lives here
export function isGameOver(ctx) {}
export function botHeuristic(ctx, move) {}       // return number
export const effects = { /* custom card effects, §7 */ }
export const renderers = { /* custom zone renderers, §9 */ }
```

### Rule tests — the highest-leverage feature of the format

Packs ship table-driven tests: *given this exact state, this move is
legal/illegal, this round scores N*. This is how rules get implemented
confidently (by humans or by AI) without playing fifty hands.

```json
{
  "name": "must follow suit when able",
  "setup": {
    "seats": 4, "turn": { "seat": 2, "phase": "play" },
    "zones": { "trick": ["clubs-5"], "hand.2": ["clubs-9", "hearts-A"] },
    "vars": { "led": "clubs", "heartsBroken": false }
  },
  "assert": [
    { "move": { "actor": 2, "type": "playCard", "cards": ["hearts-A"] },
      "legal": false, "rule": "follow-suit" },
    { "move": { "actor": 2, "type": "playCard", "cards": ["clubs-9"] },
      "legal": true }
  ]
}
```

Assertion kinds: **legality** (`{move, legal, rule?}` — non-mutating),
**apply** (`{apply: move}` — advance state within a test), **announce**
(make an announcement or challenge), **score** (run the round scorer,
compare per seat), and **expect** (partial state match: zone contents or
counts, vars, turn, direction, gameOver/winner). Setup's `unlisted` field
says where unplaced deck cards go (shuffled into `draw`, or `void`).

Runner: `tools/pack-test.mjs <pack-id>` — loads the pack headless, builds
each setup state directly (no play-through needed), runs assertions. Also
validates the manifest against the schema and checks asset references.

The JSON Schemas in `schema/` (`manifest.schema.json`, `deck.schema.json`,
`rules-test.schema.json`) are **normative** for these formats; this document
explains intent, the schemas define the shapes.

### Simulation harness

`tools/simulate.mjs --pack hearts --games 1000 --seed 42 [--variants ...]`

Runs bot-vs-bot games headless at full speed. Reports: completion rate,
deadlocks/stalls (no legal move and no recovery reaction — the classic
"draw pile empty" bug), average game length, score distributions, effect
frequency. Run in CI for every pack. A pack isn't done until 1,000 sims
complete without a stall.

### Dev mode

In-platform developer panel (query param or arcade dev flag):

- Hot-reload manifest/theme/logic on file change.
- **State inspector**: full unfiltered state tree, event log with
  time-travel scrubbing (event-sourcing makes this cheap).
- **Scenario builder**: construct an exact hand/board ("set up this weird
  situation") and export it as a rule-test `setup` block — bugs become
  regression tests in one click.
- Seat-switcher to play all seats locally; bot step-through with heuristic
  scores visible.

---

## 12. Teaching, accessibility, replays

- **Generated rules reference**: template + parameters + variants render a
  readable rules card. Packs can replace it with `rules.md`.
- **Hints**: "show me a move" surfaces the bot's top choice; "why can't I
  play this?" surfaces the failing rule's reason (§5). Both toggleable per
  table (host may disable for competitive play).
- **First-game coach** (rich packs): optional scripted tutorial —
  a sequence of constrained scenarios with narration, defined in the pack.
- **Accessibility**: four-color deck mode (built into the vanilla
  renderer), high-contrast card faces, large-print mode via arcade font
  scale, full tap-only input path (no drag required), screen-reader labels
  on zones and cards ("Queen of Spades, hand, position 3").
- **Replays & kibitz**: the event log *is* the replay. "Watch last hand"
  scrubber post-round; spectator seats receive the public view live.
  Replays saved via Arcade storage, shareable as JSON.

---

## 13. Genre templates

Templates are platform code. Each declares default zones and flow, its
parameter schema, its move types and validators, a default bot heuristic,
and its round/game-over defaults. Parameters listed here are the initial
target surface; each ships with sensible defaults.

### 13.1 `trick-taking` (validates with Hearts)

Zones: `hand`, `trick` (shared, all-visible), `won` (per player, face-down count).

| Parameter | Values / example | Hearts |
|-----------|------------------|--------|
| `followSuit` | `must` \| `free` | `must` |
| `trump` | `none` \| suit \| `chosen` | `none` |
| `trickWinner` | `highest-of-led` \| `highest-trump-else-led` | `highest-of-led` |
| `firstLead` | card id \| `left-of-dealer` \| `winner` | `"clubs-2"` |
| `leadConstraints` | e.g. `{ "suit:hearts": "untilBroken" }` | hearts until broken |
| `playConstraints` | e.g. no penalty cards on trick 1 | `{ "tag:penalty": "notTrick1" }` |
| `breaking` | `{ "var": "heartsBroken", "when": "tag:penalty played" }` | as shown |
| `passing` | `{ count, schedule: [left,right,across,none] }` | 3, rotating |
| `dealAll` | boolean (deal entire deck) | true |
| `dealAdjust` | player count → card ids removed so hands divide evenly | 3p: −2♦; 5p: −2♦ 2♠; 6p: −2♦ 3♦ 2♠ 3♠ |
| `sweepBonus` | `{ "if": "tookAll:<sel>", "award": "others-gain-sum" \| "self-lose-sum" \| hook }` | shoot the moon, manifest-only |

Round over: hands empty. Default scoring: `penalty-cards-taken`.
Future games covered: Spades (trump + bidding needs a `sequential` round
phase — bidding is the template's first planned extension), Oh Hell, Euchre
(with hook help).

### 13.2 `shedding` (validates with Uno, Crazy Eights)

Zones: `hand`, `draw` (shared, face-down), `discard` (shared, top-visible).

| Parameter | Values / example | Uno |
|-----------|------------------|-----|
| `matchOn` | attribute list, OR-matched | `["color", "rank"]` |
| `deal` | number | 7 |
| `drawWhenStuck` | `n` \| `"until-playable"` | 1 (variant: until-playable) |
| `playAfterDraw` | boolean | true |
| `mustPlayIfAble` | boolean | false |
| `stacking` | `{ "drawN": true/false }` | variant |
| `winner` | `first-empty-hand` | same |
| `roundScore` | `hand-values-to-winner` \| `hand-values-against-holders` | to winner |
| `lastCardCall` | announcement config (§4) | "Uno!", 2-card penalty |
| `jumpIn` | boolean (identical-card out-of-turn play) | variant |

Effects come from the deck file (§7). Crazy Eights is this template with
`standard-52` and one wild effect on the 8s — the canonical ~40-line pack.

### 13.3 `contract-rummy` (validates with Phase 10)

Zones: `hand`, `draw`, `discard`, `melds` (per player, all-visible).

| Parameter | Values / example | Phase 10 |
|-----------|------------------|----------|
| `contracts` | ordered list of requirements | the 10 phases |
| `contractItem` vocabulary | `set(n)`, `run(n)`, `colorGroup(n)` | e.g. `["set(3)","set(3)"]` |
| `progression` | `advance-on-complete` \| `all-play-all` | advance-on-complete (per player!) |
| `wilds` | `{ tag, minNaturals: 1, maxPerMeld: null }` | Wild cards, ≥1 natural per meld |
| `layDown` | `once-per-round-when-complete` | same |
| `hitting` | `own-and-others-after-laydown` \| `none` | own and others |
| `turn` | phases | `draw → meld/hit → discard` |
| `drawFrom` | subset of `[draw, discard]` | both |
| `discardPickupForbidden` | selectors barred from discard pickup | `tag:skip` |
| `goingOut` | `discard-last` \| `play-or-discard-last` | play-or-discard-last |
| `roundScore` | leftover card values | 5/10/25 by rank |
| `gameOver` | `first-past-contract(10)` tiebreak lowest score | same |

A wild is wild **in the hand only**. The moment it is played it takes one
concrete value — a rank for a set or a run, a colour for a colour group — and
that value is frozen for the rest of the round, recorded per card on the meld
(`melds` playerVar: `{ item, cards, wilds: { cardId: { rank | color } } }`).
Every later check reads a wild through that value, so a run laid as
`3, wild, wild, 6` **is** 3-4-5-6 and a 4 can no longer be hit onto it. A move
may name the values (`layDown` melds carry `wilds`; a `hit` carries
`choice.wilds`); anything left unsaid is derived — the shared rank or colour
for a set or colour group, and for a run the window's gaps, extending up from
the lowest card and sliding down only as far as the top of the deck forces. A
value already on the table always wins over one a later move names.

The per-player contract progression is per-player **meta-state persisting
across rounds** — an engine capability (`ctx.playerVar`), not a hack.
Future games covered: Contract Rummy, Liverpool Rummy; plain Rummy/Gin with
`contracts: none` mode (planned extension).

### 13.4 `sequencing` (validates with Skip-Bo)

Zones: `stock` (per player, top-visible), `hand`, `discard.1-4` (per
player, top-visible), `build.1-4` (shared, top-visible), `recycled`
(shared, hidden).

| Parameter | Values / example | Skip-Bo |
|-----------|------------------|---------|
| `buildRule` | `ascending(1..12, wrap: false)` | same |
| `buildStart` | selectors playable on an empty pile | `["rank:1", "tag:wild"]` |
| `playableFrom` | subset of `[stock, hand, discard]` (tops only for piles) | all three |
| `wilds` | tag, playable-as-any | Skip-Bo cards |
| `stockSize` | by player count | 30 (20 for 5+) |
| `handRefill` | `to(5)` at turn start; refill-on-empty mid-turn | both |
| `turnEnd` | `discard-to-own-pile` | same |
| `winner` | `first-empty-stock` | same |
| `reactions` | build-pile-full → recycle (§3) | 12 completes → recycled |

Future games covered: Spite & Malice, and (with parameter work) it shares
DNA with solitaire-family foundation building.

### Template extension policy

When a target game needs something its template lacks, prefer, in order:
(1) a hook in that pack; (2) if a *second* game needs it, promote it to a
template parameter; (3) if multiple templates need it, promote it to an
engine primitive. This keeps templates from speculatively bloating.

---

## 14. Explicit decisions & deferred items

**Decided:**
- Event-sourced deterministic core, seeded RNG, host-authoritative.
- Per-player filtered views for hidden information, delivered as targeted
  platform sends (`Arcade.peer.send(payload, { to })`, enhancement E1) —
  non-addressee clients never receive private frames; host-visible by
  design, since the host is the authority (§8, §17.5).
- Multiplayer boot-gates on launcher caps `peer.sendTo` + `peer.roster`:
  an older launcher gets a "launcher update required" notice, never a
  degraded second protocol.
- Seat identity is the arcade's stable `deviceId` plus a local index
  (hotseat + remote mixes at one table); display names via
  `Arcade.player.name()`, always escaped when rendered.
- Bot takeover only on terminal `'idle'`, never during `'interrupted'`.
- Manifest-as-data + JS hooks; **no rules DSL**.
- Templates as the middle layer; four at launch.
- Packs are trusted first-party code in this repo.
- Bots via legal-move enumeration + heuristic; bots run on host through the
  normal move pipeline.
- Rule tests + headless simulation are part of the pack format from day one.

**Deferred (deliberately, with the seam left open):**
- End-to-end sealing + commit-reveal dealing (so even the host can't peek;
  acceptable at friend-scale; the dealing interface stays abstract so it
  can slot in later).
- ~~Arcade enhancements E0–E3~~ — **shipped** (2026-08-04). `peer.sendTo`,
  `peer.roster` and `peer.meta` are all in the SDK's documented capability
  list, alongside a later `peer.party` that postdates this section. The
  boot-time caps gate below is still correct as a defensive path, but an
  older launcher is no longer the expected case. `ARCADE_ENHANCEMENTS.md`
  is now the Cardstock-side implementation plan rather than a platform
  spec; its Appendix B keeps the E-labels resolvable.
- Host migration on host loss (log persistence + resume covers the common
  case).
- URL-loaded third-party packs (would require sandboxing `logic.js`).
- Bidding round-phase (needed for Spades — first template extension).
- Chips/wagering (poker family), dice, boards, simultaneous-speed games
  (Spit/Speed — the real-time input model is a different beast).

---

## 15. Implementation roadmap

Each milestone ends in something playable; the validation game proves the
layer beneath it.

1. **Engine core + shedding + Crazy Eights** — cards/decks/zones, move
   pipeline, event log + reducer, seeded RNG, vanilla renderer, local
   hotseat + baseline bot, pack loader, `pack-test.mjs`. Includes the
   **arcade scaffold**: SDK boot (§17.2), storage map + solo autosave
   (§17.3), suspend/resume with `Arcade.loop` (§17.6), settings hooks
   (§17.7) — and the launcher's automated acceptance runner green
   (§17.10) is part of this milestone's definition of done. *Playable
   solo against bots, inside the launcher and standalone.*
2. **P2P** — the §17.5 protocol: caps boot gate, lobby over `onReady`,
   targeted per-seat sends (E1) + roster-driven seat status (E2),
   propose/reject/event flow, per-seat status machine (`interrupted`
   hold, `idle` bot-fill), `overflowed`-triggered snapshot resync, late
   join/spectate; two-headless-launcher smoke test in the style of
   `tools/p2p-acceptance.mjs`. *Crazy Eights with friends.*
3. **Uno** — custom deck file, effects library, direction/skip, wild color
   choice, announcements ("Uno!" + WD4 challenge), variants system, first
   themed pack (custom faces + theme.css). *Proves effects & announcements.*
4. **Trick-taking + Hearts** — simultaneous passing phase, follow-suit
   validation layer, trick gather, penalty scoring, shoot-the-moon hook,
   `simulate.mjs`. *Proves round phases & scoring hooks.*
5. **Contract rummy + Phase 10** — melds, contracts, per-player
   progression, hitting, multi-select UX. *Proves per-player meta-state.*
6. **Sequencing + Skip-Bo** — shared build piles, zone reactions/recycling,
   stock racing. *Proves zone lifecycle.*
7. **Polish pass** — replays/kibitz UI, hints/coach, accessibility audit,
   dev-mode scenario builder, generated rules references, sim-in-CI.

---

## 16. v0.2 — findings from the paper dry-run

All five launch packs (Crazy Eights, Uno, Hearts, Phase 10, Skip-Bo) were
drafted on paper in `packs/`, with rule tests, against the schemas in
`schema/`. Writing them surfaced these format changes, now integrated above:

- **`deal` / `stockSize` accept `{ default, byPlayers }`** — Crazy Eights
  deals 7 in two-player, Skip-Bo stocks 20 for 5–6 players.
- **`dealAdjust`** (trick-taking) — Hearts removes cards at 3/5/6 players so
  the deck divides evenly.
- **`cardTags`** (manifest, top-level) — attach tags to built-in-deck cards;
  Hearts tags its penalty cards without shipping a deck file.
- **Effects can trigger `on: "discard"`** — Phase 10's Skip.
- **Constraint relaxation** is an engine guarantee (§5) — all-hearts hands
  may lead hearts; no state may leave a player with zero moves.
- **`forEach` deck expansion** with `$var` substitution (§2) — keeps the
  108-card Uno-style deck to 7 entries.
- **Scoring precedence** pinned down (§6): `cardValues` → deck value →
  `defaultValue` (may be `"faceValue"`) → 0; `roundScore`/`gameOver` live
  only in `scoring`.
- **New template parameters**: `drawFrom` + `discardPickupForbidden` +
  `minNaturals` (contract-rummy); `buildStart`/`playableFrom` as selectors
  (sequencing); `sweepBonus` concrete shape (trick-taking).
- **Test format** gained `apply` / `announce` / `expect` assertion kinds and
  the `unlisted` setup field (§11).

Result worth stating: **all five launch packs are manifest-only** — zero
`logic.js` among them (shoot-the-moon became the built-in `sweepBonus`).
That's a strong claim about the template layer; implementation should treat
any forced retreat from it as a design-review trigger, not a local hack.

---

## 17. Arcade integration contract (v0.3 — aligned to arcade protocol v2)

Verified against the current `ARCADE_PLATFORM.md`, `GAME_INTEGRATION.md`,
and the transport source (`arcade-p2p.js`, `p2p/p2p-core.js`) on
2026-07-10. This section is the implementer's bridge between the engine
design above and the arcade's actual SDK; where the two documents ever
disagree, the arcade docs win and this section gets updated.

### 17.1 Identity & hosting

- **gameId: `cardstock`**, hosted at `paulgibeault.github.io/cardstock/`,
  entry `index.html` at repo root. The integration checklist requires the
  gameId to match the GitHub repo slug — so the repo is
  `paulgibeault/cardstock` (this design repo's directory can be renamed
  when implementation starts, or keep `card-game` locally and name the
  GitHub repo `cardstock`; the slug is what matters).
- One catalog entry, one gameId. Individual games are an **in-app pack
  picker**, not separate launcher entries — the launcher's per-game
  storage namespace, score categories, and peer routing all key off the
  single `cardstock` id, with the pack id as a second-level key.
- Launcher card art: `icon.png` (square, ≥ 512×512) lives in **this**
  repo and is served at `/cardstock/icon.png`; subtitle ≤ 20 chars
  (**"Card games"**). Registration is ONE `catalog.json` entry in the
  launcher repo and no HTML edits at all — the launcher grid and the
  portfolio page both render from the catalog. *(Corrected 2026-08-04: an
  earlier draft called for cover art in the launcher repo plus hand edits
  to `#view-launcher` in `index.html` and `#games` in `profile.html`. All
  three are obsolete.)*
- Iframe sandbox (`allow-scripts allow-downloads` — **no
  `allow-same-origin`**): no top-level navigation, no `window.open` —
  rules reference and help are in-app overlays. Fullscreen only on user
  gesture, targeting our root element. `<a download>` works (replay export
  uses it). *(Corrected 2026-08-04: an earlier draft listed
  `allow-same-origin`.)* The consequence is load-bearing: the frame runs
  **opaque-origin**, so `localStorage` / `indexedDB` / `caches` property
  access **throws** rather than returning empty, and all storage is
  bridged over postMessage. Every direct-probe fallback is therefore
  invalid — go through `Arcade.state` / `store` / `files`, always.

### 17.2 Boot

```html
<script src="/arcade-sdk.js"></script>            <!-- root-relative, per checklist -->
<script>Arcade.init({ gameId: 'cardstock' });</script>
```

- `await Arcade.ready` before reading state at boot (framed handshake or
  immediate standalone resolution).
- **Standalone is first-class**: solo + bots + hotseat fully work at the
  GitHub Pages URL; multiplayer UI renders only when
  `Arcade.peer.status() !== 'unavailable'`. Never gate core play on
  `Arcade.context.framed`.
- Never cache `peer.status()` at init — a table mounted mid-session gets
  `'connected'` in its welcome; live transitions arrive via `onStatus`.
- **Multiplayer boot gate**: `Arcade.peer.caps()` must include
  `peer.sendTo` and `peer.roster` (E0–E2). On an older launcher the
  Multiplayer panel shows one "launcher update required" notice — there
  is deliberately no fallback protocol path in the game.

### 17.3 Storage map

| Data | Where | Why |
|------|-------|-----|
| Active-match pointer, per-pack prefs, last table config | `Arcade.state` (sync) | small + hot; keys `arcade.v1.cardstock.*` |
| Match event logs + snapshots (autosave) | `Arcade.store.open('matches')` | grows beyond comfort in the shared ~5 MB localStorage budget; async is fine here |
| Finished-match replays | `Arcade.store.open('replays')` | ride the schema-v2 save bundle automatically |
| Pack-dev scratch assets (dev mode) | `Arcade.files` | binary blobs |
| Diagnostics / telemetry buffers | `Arcade.state.set(k, v, { exportable: false })` | never inflate save files |

- Autosave: append event-batch to the match log on every applied move;
  **flush pending writes in `onSuspend`** (eviction can follow at any
  moment). `Arcade.state.set()` returns `false` on quota — check it for
  match-critical writes, and register `Arcade.onStorageError` once to
  toast "storage full".
- Because `store` rides the save bundle, an in-progress **solo match
  travels across devices** via launcher Save/Load for free.
- `Arcade.onStateReplaced` = treat as a fresh boot: discard in-memory
  match state, re-hydrate from storage. If seated at a live multiplayer
  table when it fires, send `bye` (bot fills per §17.5) and then
  re-hydrate — never assume the current screen survived the import.
- No legacy keys exist (greenfield) — no `migrate`/`adopt` at launch; the
  event-log format itself is versioned from day one instead.

### 17.4 Identity, seats, lobby

- **Seat = `(deviceId, localIndex)`** — supports hotseat players and
  remote players mixed at one table. `deviceId` comes from
  `Arcade.peer.self()` / `remote()` / the `fromPeer` argument of
  `onMessage`; it is stable across sessions and reconnects, which is what
  makes seat re-binding after a drop trivial.
- Display names: `Arcade.player.name()` (shared arcade-wide), plus a
  per-seat label for hotseat extras. **Every rendered name passes through
  `Arcade.html.escape`** (§17.8).
- **Lobby rides `Arcade.peer.onReady`** — it fires when the remote device
  has *this game* mounted and listening (and again on reconnects; it is
  explicitly idempotent). The host re-broadcasts the `lobby` frame on
  every firing. No hand-rolled hello/echo handshake.
- The `lobby` frame carries: protocol version, pack id + pack version,
  active variant set, seat roster. The host never self-declares — joiners
  identify it as the roster entry with `direct: true` (E2). A version
  mismatch (one player on a stale cached deploy) prompts that client to
  reload rather than desyncing mid-hand.

### 17.5 Multiplayer mapping — the §8 protocol on the real transport

Transport facts the protocol is built on (verified in source):

1. Channel per link is **ordered + reliable**; payloads must be
   JSON-serializable; keep them small and frequent (ours are tiny events).
2. Private frames use targeted sends — `Arcade.peer.send(payload,
   { to: deviceId })` (E1): the platform routes them and non-addressees
   never receive them. Public frames (`lobby`, shared `event` views,
   `emote`) broadcast plainly. Clients speak only to the host; the host
   targets each seat's private view and broadcasts the rest.
3. Per-seat presence and status come from `Arcade.peer.peers()` /
   `onPeersChange` (E2); the aggregate `onStatus` only shows/hides the
   multiplayer UI. `onMessage` meta (E3) exposes the `relayed` flag.
4. Sends during `'interrupted'` **queue and replay exactly-once** (cap
   1000, visible via `Arcade.peer.queue()` / `onQueue`) — the event log
   needs no dedup or reordering in normal operation.
5. Frame kinds: `lobby`, `claim-seat`, `propose`, `event`, `reject`,
   `snapshot-req`, `snapshot`, `emote`, `bye`. `event` and `snapshot`
   payloads are per-seat views (§8). Snapshots are small JSON (a few
   KB) — normal sends; **replay files** shared between friends use
   `Arcade.peer.sendBlob` / `onBlob` instead.

Status machine — evaluated **per seat** from the roster (`onPeersChange`);
the aggregate `onStatus` merely gates the multiplayer UI as a whole:

| Status | Table behavior |
|--------|----------------|
| `connected` | Normal play; safe to send immediately on the transition. |
| `interrupted` | **Keep playing.** Show a quiet "reconnecting…" chip on the affected seat; sends queue with exactly-once replay; do NOT reset state, free the seat, or bot-fill. Auto-reconnect (rendezvous) means even a total loss can surface as a long `interrupted`. |
| `idle` (after grace) | The player is genuinely gone: host offers bot-fill / pause / end-match. Seat re-binds by `deviceId` if they return. |
| `unavailable` | Standalone — multiplayer UI hidden entirely. |

- On recovery, check `queue().overflowed`: `true` means the replay queue
  dropped oldest messages — do not trust replay; the affected client sends
  `snapshot-req` and the host answers with that seat's full view + log
  seq. (At card-game message rates this is nearly unreachable, but the
  handler is cheap and mandatory.)
- Turn timers in multiplayer are **host-wall-clock authoritative** —
  timeout events enter the log like any other event; clients only render
  countdowns. A suspended client must not stall the table, and
  `Arcade.session` timers (which freeze on suspend) are therefore only
  for **solo** play.

### 17.6 Lifecycle & performance

- Rendering: an event-driven **dirty-flag renderer** on `Arcade.loop` —
  `loop.kick()` per applied event batch; the managed loop auto-cancels on
  suspend and never leaks suspended time into deltas.
- `onSuspend`: flush the match-log tail to `store`, suspend the
  `AudioContext`, cancel any decorative timers. `onResume`: re-render,
  verify sync state.
- **Suspended but still mounted** (user peeked at another game): keep
  applying incoming peer events to the log — cheap and keeps the table
  current — but skip all rendering. Check `Arcade.context.suspended`, not
  `document.visibilityState` (a hidden iframe's stays `"visible"`).
- **Evicted** (pool cap): next launch is a fresh page load. Solo matches
  restore from `store`; multiplayer clients rejoin via `onReady` →
  `snapshot-req`. No in-memory state is assumed to survive, ever.
- Resource hygiene per the checklist: no orphaned intervals, one shared
  canvas/DOM tree (no stray WebGL contexts — the table is DOM/SVG), heap
  must not grow across launch/quit cycles (DevTools heap-snapshot test).

### 17.7 Settings & accessibility wiring

| Setting | Wiring |
|---------|--------|
| `fontScale` | All UI text in `rem` — free via the SDK's injected root rule. Card faces scale with layout (viewport-based), not font size. |
| `theme` | Table chrome + vanilla renderer keyed off `[data-theme="dark|light"]`. **Pack rule**: `theme.css` must style both themes (added to the pack checklist, §11). |
| `reducedMotion` | Accept the SDK's default CSS kill-switch — DOM updates land in final state, so instant transitions are *correct*, not broken. JS-driven animation (FLIP moves, dealing) gates on `Arcade.settings.reducedMotion()`. No `data-arcade-keep-motion` opt-out at launch. |
| `handedness` | Hand fan + action bar anchor side via `[data-handedness]`. |
| `audioVolume` | One master `GainNode` multiplied by `--audio-volume`. |

`Arcade.onSettingsChange` → relayout + `loop.kick()`.

### 17.8 Security checklist (the fleet's shipped-then-fixed bug classes)

- **Escape every off-device string** — peer names, table names, seat
  labels — via `Arcade.html.escape` / `textContent` (peer-id XSS shipped
  in p2p-chat; treat it as precedent, not theory).
- **Emotes are a fixed emoji set** at launch — no free-text channel to
  moderate or escape.
- Validate any id used in selectors/attributes (`/^[\w-]+$/`): pack ids,
  deviceIds, zone/card ids arriving over the wire.
- Shape-validate every inbound frame before use; remote `propose` frames
  go through the full move validator regardless of source — the host
  never trusts a client's claim of legality.
- Authority frames must arrive on the direct link: a client rejects any
  host-role frame whose `onMessage` meta says `relayed: true` (E3) — a
  relayed "host" frame is a spoof by definition.
- Imported replays (file or `onBlob`) are untrusted input: schema-validate
  like any rule-test file before loading.
- Never cache `/arcade-sdk.js` or launcher assets; never enumerate-delete
  origin-wide caches or service workers (the moon-lit incident) — see
  §17.9.

### 17.9 PWA / service worker (shipped; enables offline solo)

*(Corrected 2026-08-04: this section said "optional". The fleet posture in
GAME_INTEGRATION §10 is stronger — a manifest implies a worker, and six of
seven catalog apps ship both. Cardstock ships both.)*

Start from the launcher repo's `tools/templates/game-sw.js`;
`manifest.json` scope + `start_url` = `/cardstock/`; SW registered with
`{ scope: '/cardstock/' }`; fetch handler ignores anything outside
`/cardstock/`; caches version-keyed `cardstock-*` only; pack assets under
`/cardstock/packs/**` are cacheable, which makes solo play fully offline.

### 17.10 Dev & acceptance workflow

- Local: `./dev.sh ../cardstock` from the launcher repo stages both
  same-origin on `127.0.0.1:4791`; `?dev=1` traces the postMessage
  handshake when "did the welcome arrive?" is a live question.
- **Engine core stays browser-free**: `pack-test.mjs` and `simulate.mjs`
  run in plain Node with no arcade dependency — the reducer, templates,
  and bots must import cleanly outside a DOM.
- Integration DoD (milestone 1): the launcher's automated checklist passes
  — `npm run acceptance -- http://127.0.0.1:4791/cardstock/` — covering
  framed/standalone boot, namespaced storage, save/load round-trip,
  font-scale, suspend/resume, eviction-survival, and XSS-inertness.
- Multiplayer DoD (milestone 2): a two-headless-launcher smoke test in
  the style of `tools/p2p-acceptance.mjs` — real `RTCPeerConnection`, two
  staged launchers, scripted Crazy Eights hand end-to-end.

---

*Prepared 2026-07-10 for implementation; §17 alignment verified against
the arcade docs (protocol v2) and transport source the same day. Companion
docs: the arcade's `ARCADE_PLATFORM.md` (SDK/P2P surface) and
`GAME_INTEGRATION.md` (catalog integration checklist).*
