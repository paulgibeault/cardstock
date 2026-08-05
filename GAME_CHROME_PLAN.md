# Game Chrome Plan (v1 — 2026-08-05) — **SHIPPED**

> **Status: implemented.** All three phases landed together. The plan below is
> kept as written so the reasoning stays legible next to the outcome; three
> things reality added on top of it:
>
> 1. `showGameOver`'s `forfeited` parameter in `src/ui/panels.js` was dead the
>    moment the table's Forfeit button went — `concludeMatch` was its only
>    caller and it can no longer pass true. Removed there too, not just in
>    `table.js`.
> 2. Verifying the re-themed scoreboard turned up a **pre-existing** layout
>    bug the white panel had been hiding: `.round-scores` was
>    `grid-template-columns: 1fr auto auto`, and the scoreboard puts a bot's
>    whole persona line in that `auto` middle track. It claimed its max-content
>    width, squeezed the `1fr` name column down to the width of its icon, and
>    the player's name spilled out across the persona text. Now
>    `auto minmax(0, 1fr) auto`, so the decorative line truncates and the name
>    never does.
> 3. `.choice-option` hard-coded `background: #eee; color: #1a1a1a`, which
>    became a pale blob on the new dark panel. Re-themed off `--panel-text`
>    the way `.stat-card` already was.
>
> One loose end left deliberately: `--button-bg` / `--button-text` now have no
> consumers, since the `#status-bar button` rule was their only one. They are
> left in place because the file header frames these custom properties as the
> override vocabulary a pack's own `theme.css` writes against — removing them
> is an API change, not a cleanup.

Four player-facing complaints, one small pass over the table chrome. The theme
throughout: **the status bar is doing too much, and the one thing that looks
broken (the white "95") is literally a CSS specificity accident, not a design.**

The complaints, verbatim:

1. The header wraps during gameplay and the whole board shifts under the player.
2. Forfeit should move to the lobby for in-progress games (but every game must
   still have a way back to the lobby).
3. "CARDSTOCK — WILDFIRE" (launcher bar) and "Wildfire" (status bar) say the
   same thing twice. In a game, the launcher title should be just the variant
   name and the status-bar copy should go.
4. The white box with "95" is unstyled and unexplained — and it matches the
   plain white of the inspector popups and modal panels, none of which look
   like they belong on this table.

## What the code actually says (findings)

- **The "95" is the score chip, and its white coat is a bug.**
  `#status-bar button { background: var(--button-bg) }` ([table.css:198](src/ui/table.css:198))
  is an ID+element selector (1-0-1) and beats `.score-chip`'s themed pill
  (0-1-0) at [table.css:237](src/ui/table.css:237). The ghost buttons were
  rescued with a `#status-bar .ghost-button` override at
  [table.css:254](src/ui/table.css:254); the score chip never was. The chip
  *already has* a themed design — translucent pill, `--chip-bg`, gold hover,
  matching the seat-score pills — it just never gets to wear it.

- **The wrap is `flex-wrap: wrap` doing its job on too much content.**
  `#status-bar` ([table.css:160](src/ui/table.css:160)) wraps, and on a phone
  the right side (status text + chip + Forfeit) drops to a second line whenever
  the text lengthens ("Delphine's turn" vs "Your turn"). The table screen is a
  `100dvh` flex column, so a taller bar shoves the whole felt down mid-game.

- **Forfeit already lives in the lobby.** The resume tile's "Start over"
  button ([lobby.js:157–190](src/ui/lobby.js:157)) confirm-gates and records a
  forfeit through the *same* `recordResult` contract as the table's button —
  the code comment there says explicitly the two doors must not disagree.
  Removing the table button loses nothing, and it makes the table's entire
  `forfeited` flag machinery dead code (the flag's only setter is
  `forfeitMatch`, [table.js:1962](src/ui/table.js:1962)).

- **Both titles are ours.** The launcher bar shows what
  `Arcade.ui.setTitle('Cardstock — ' + pack.manifest.name)` sets
  ([table.js:2464](src/ui/table.js:2464)); the status bar repeats the name in
  `#game-name` ([index.html:53](index.html:53)). The lobby sets plain
  `'Cardstock'` ([main.js:38](src/main.js:38)) — that stays.

- **Back-to-lobby is already universal.** The ← Lobby button is never hidden
  by any state ([index.html:50](index.html:50), wired at
  [table.js:2559](src/ui/table.js:2559)), and the game-over overlay has its own
  Lobby button. Nothing to add — just don't break it.

- **Every plain-white surface routes through two variables.**
  `--panel-bg`/`--panel-text` are `#ffffff`/near-black **in both themes**
  ([table.css:38](src/ui/table.css:38), [table.css:87](src/ui/table.css:87)).
  Consumers: the card/pile/seat inspector ([table.css:967](src/ui/table.css:967)),
  all five modal panels ([table.css:1783](src/ui/table.css:1783)), and the
  event banner ([table.css:1366](src/ui/table.css:1366)). Re-value the two
  variables and every popup re-themes at once — no per-surface work. Panel
  primary buttons use `--action-bg` (blue) and ghost buttons borrow
  `--panel-text`, so both survive a dark panel untouched.

---

## Phase A — One-line status bar (complaints 1, 2, 3)

The bar ends up: `← Lobby · <status text> · <score chip>`. Three items,
one line, fixed height.

### A1. Remove the Forfeit button and its dead machinery — table.js, index.html

- Delete `#forfeit-button` from [index.html:63](index.html:63) and its lookup
  ([table.js:111](src/ui/table.js:111)), listener
  ([table.js:2561](src/ui/table.js:2561)), and visibility line
  ([table.js:1502](src/ui/table.js:1502)).
- Delete `forfeitMatch()` ([table.js:1962](src/ui/table.js:1962)) and the
  `forfeited` flag plus every `|| forfeited` guard and the
  `'Game forfeited.'` status line — with no setter left they are all
  unreachable (lines ~207–210, 273, 286, 1491, 1506, 1963–1972, 2278, 2342,
  2392, 2510).
- Simplify `concludeMatch` / `opponentOutcomes`
  ([table.js:1897–1952](src/ui/table.js:1897)): drop the `forfeit` parameter
  (its only truthy caller was `forfeitMatch`). **Keep** the `forfeit`/`won`
  fields in the `recordResult` payload — that storage contract is shared with
  the lobby's forfeit path and covered by `tests/stats.test.js`.
- Delete the Forfeit CSS: `.ghost-button--quiet`
  ([table.css:228–234](src/ui/table.css:228)) and its "Forfeit lives in the
  chrome" comment — the comment's claim moves to the lobby tile, where the
  code already documents it.
- Lobby check: the tile's "Start over" already covers abandonment. Optional
  copy nudge — its confirm text already says "counts as a forfeit"; leave the
  button label as "Start over" (it reads as what the player wants: a fresh
  deal), no rename needed.

### A2. One name, in the launcher bar — table.js, index.html, main.js

- [table.js:2464](src/ui/table.js:2464):
  `Arcade.ui.setTitle(pack.manifest.name)` — the launcher bar reads
  "WILDFIRE", full stop. The lobby's `setTitle('Cardstock')`
  ([main.js:38](src/main.js:38)) is untouched, so the wordmark identity
  survives everywhere except at a live table, where the variant is the only
  name that matters.
- Delete `#game-name` ([index.html:53](index.html:53)), its lookup and both
  writes ([table.js:107](src/ui/table.js:107), 2454, 2465), and
  `.status-bar__game` ([table.css:180](src/ui/table.css:180)).

### A3. The bar can no longer change height — table.css

- `#status-bar`: `flex-wrap: wrap` → `nowrap`
  ([table.css:167](src/ui/table.css:167)).
- `#status-text`: `flex: 1; min-width: 0; white-space: nowrap; overflow:
  hidden; text-overflow: ellipsis;` — the one elastic item. Status strings are
  short ("Delphine's turn"); ellipsis is a fallback, not the normal state.
- The `.status-bar__side` wrappers already carry `min-width: 0`; with three
  items total, consider flattening to direct children — but only if the
  handedness rule (`[data-handedness="left"] #status-bar { flex-direction:
  row-reverse }`, [table.css:275](src/ui/table.css:275)) still flips cleanly.
  If the two-sides structure makes that simpler, keep it. Simplicity over
  novelty.

## Phase B — The score chip earns its keep (complaint 4, the "95")

- **Delete the `#status-bar button { … }` block**
  ([table.css:198–211](src/ui/table.css:198)). After Phase A the bar holds only
  the ghost Lobby button and the score chip, both of which style themselves;
  the white-button default serves nothing. This one deletion un-breaks the
  chip — it immediately renders as the translucent themed pill it was written
  to be, twin to the seat-score pills. The `#status-bar .ghost-button` rescue
  at [table.css:254](src/ui/table.css:254) also becomes redundant — fold what
  it sets into `.ghost-button` if nothing else needed the escape hatch.
- **Say what it is.** "I don't even know why it is there" is a discoverability
  bug: it's *your* score, and tapping it opens the score sheet. Prefix the
  value with a quiet label so it reads `You 95` (in `renderStatusBar`,
  [table.js:1494–1501](src/ui/table.js:1494) — the Phase-10 packs already
  render `Ph 4 · 95` there, so a short prefix is established vocabulary). The
  `aria-label` already explains the rest.

## Phase C — Panels that belong on the table (complaint 4, the popups)

All in the two `:root` palette blocks plus one shared rule — no per-surface
edits, and card faces stay fixed (design rule §2 at the top of table.css).

- **Dark theme** ([table.css:38](src/ui/table.css:38)): `--panel-bg: #16281f`
  (the existing `--tile-bg` — the lobby tiles already prove this surface),
  `--panel-text: #f0ede3` (warm off-white, matching the gold accent family).
- **Light theme** ([table.css:87](src/ui/table.css:87)): `--panel-bg: #f7f4ec`
  (warm paper, not device-white), `--panel-text: #14261c` (unchanged).
- **One shared framing rule**: add `border: 1px solid var(--tile-border)` to
  the panel selector group ([table.css:1778](src/ui/table.css:1778)) and the
  inspector ([table.css:961](src/ui/table.css:961)) so the surfaces read as
  the same material as the lobby tiles — chrome of this game, not a browser
  default. The event banner ([table.css:1366](src/ui/table.css:1366)) inherits
  the new colours automatically and needs no border (it's a floating pill).
- Sweep the panel's dependents once: `.panel .ghost-button` borrows
  `--panel-text` (fine on both new surfaces), primary buttons are `--action-bg`
  blue (fine), `.round-history` row tint uses `color-mix` off `--panel-text`
  ([table.css:1902](src/ui/table.css:1902)) (fine). Check contrast in both
  themes at the end, nothing else should need touching.

## What deliberately does NOT change

- The lobby screen, its wordmark, and its `setTitle('Cardstock')`.
- The `recordResult` storage contract and stats semantics of a forfeit.
- Card faces, seat plates, pile badges — already themed, already consistent.
- No new components, no new files: this pass deletes more than it adds.

## Verification

1. `npm test` — repo gates, stats, and card-style suites must stay green
   (stats.test.js exercises the forfeit *recording* contract, which survives).
2. `npm run serve`, then at a phone-width viewport (~390px), in Wildfire:
   - Bar shows `← Lobby | Delphine's turn | You 95` on one line; play several
     turns — the felt must not shift vertically as the status text changes.
   - No Forfeit in the bar; lobby tile "Start over" still confirm-gates and
     records a forfeit; ← Lobby works mid-game; game-over overlay's Lobby
     button works.
   - Launcher bar reads the variant name in a game, "Cardstock" in the lobby.
   - Tap the score chip → score sheet; tap a pile and a seat → inspector; both
     surfaces are the new themed panel in dark AND light themes.
3. `[data-handedness="left"]`: bar mirrors, still one line.
