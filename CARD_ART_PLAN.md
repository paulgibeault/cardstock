# Card Art Plan — detailed faces and themed backs, per game type

Status: **implemented**. What the build changed from this plan is recorded in
§"What changed in the build" at the end — the plan above is left as written so
the two can be compared.
Prereqs: lobby + resumable tables (shipped in #2)

## 1. Problem

Every card in every pack renders through the same minimal template in
`src/ui/renderCard.js`: one background rect, two corner labels, and a single
center glyph. The back is two flat blue rectangles shared by all five packs.

Concretely:

- **Wildfire** (shedding, Uno-genre): a "red 7" is a flat red rectangle with a
  small white "7" in two corners and nothing in the middle. Skip/reverse/draw2
  are the same rectangle with a unicode character. Wilds are a white card with
  a `✱`.
- **Milestones** (sequencing, Phase-10-genre) and **Stockpile** (rank-run,
  Skip-Bo-genre): same story — flat paint, corner text, no center identity.
- **Hearts / Crazy Eights** (standard 52): a 7♥ shows *one* large heart, not
  seven pips; J/Q/K have no court treatment at all.
- **Backs**: identical for all packs, no relationship to the pack's accent
  color or felt.

Goal: every pack gets a face design that reads as *that game's* cards at a
glance, and a back themed to the pack — with the visual identity declared in
the pack (manifest), not hardcoded in the renderer.

## 2. Constraints (all inherited from the design doc + existing tests)

1. **Zero bitmap/image assets.** Everything stays generated SVG + CSS
   (design doc §2 "vanilla renderer", PWA precache stays tiny, offline works).
   No `<image>`, no `url(...)`, no external fonts.
2. **Security invariants** (`tests/security.test.js`): every card-derived
   string is escaped; no pack value ever lands in an attribute unescaped; any
   pack-supplied color passes the `safeCssColor` / `safeAccent` allow-lists in
   `src/ui/css.js`. New manifest fields (`ui.cardStyle`, `ui.cardBack`,
   `ui.cardPalette`) are **enum / allow-list gated**, never free-form.
3. **Determinism.** Rendering the same card twice yields identical markup
   (the back-stability test asserts this). No randomness in art generation.
4. **Trademark-safe originals.** The packs were already renamed away from
   trademarked names (#1). The art must follow: *evoke the genre, copy no
   trade dress*. No Uno red-oval-with-tilted-white-ellipse clone, no Phase 10
   trade dress, no Skip-Bo logotype. Original geometry specified in §5.
5. **Small sizes stay legible.** The same SVG renders at 28px (mini-hand),
   54px (lobby fan), 60px (game-over fan), 90–110px (piles/hand). Corner
   indices must carry identity at 28px; center art is the large-size payoff.
6. **Reduced motion / a11y untouched.** `aria-label`s keep their current
   text; art layers are presentational.

## 3. Architecture

### 3.1 Style registry, not one mega-function

```
src/ui/cardStyles/
  index.js          // registry: STYLES = { vanilla, classic, shedding, sequencing, rankrun }
                    // + resolveStyle(manifest) and makeCardRenderer(manifest, deck)
  shared.js         // escapeXml, cardAriaLabel, corner-index builder, size classes,
                    // effect glyph helpers (moved out of renderCard.js)
  vanilla.js        // today's renderer, extracted verbatim (fallback, zero-config packs)
  classic.js        // standard 52: pip layouts + court cards
  shedding.js       // Wildfire genre
  sequencing.js     // Milestones genre
  rankrun.js        // Stockpile genre
  backs.js          // back pattern library (§6)
```

Each style module exports:

```js
export function face(card, theme) -> svg string
export function back(theme)       -> svg string   // usually delegates to backs.js
```

`theme` is a plain frozen object built once per table/tile from the manifest:

```js
{
  style: 'shedding',                    // resolved style id
  palette: { red:'#c0392b', ... },      // deck color -> hex, allow-list gated
  accent: '#d2601a',                    // manifest.accent via safeAccent
  back: { pattern:'lattice', color:'#...', emblem:'W' },  // resolved back config
}
```

### 3.2 Renderer factory replaces the bare functions

`renderCard.js` currently exports free functions with no pack context, called
from `table.js` (6 sites), `lobby.js` (heroFan), and `flight.js` indirectly.
Replace with:

```js
// src/ui/cardStyles/index.js
export function makeCardRenderer(manifest, deck) {
  const theme = buildTheme(manifest, deck);   // pure, validated
  const style = STYLES[theme.style] ?? STYLES.vanilla;
  return {
    face: (card) => style.face(card, theme),
    back: () => style.back(theme),            // memoize: back is theme-constant
  };
}
```

- `table.js`: build the renderer once in table setup (it already has the
  manifest + deck), store alongside `el`, and swap all
  `renderCardFaceSvg(card)` / `renderCardBackSvg()` calls to
  `renderer.face(card)` / `renderer.back()`. The fly-card call at
  `table.js:387` and the deal animation at `:206` use the same renderer, so
  animated cards match their piles automatically.
- `lobby.js` `heroFan(manifest)`: call `makeCardRenderer(manifest, null)` —
  hero cards are authored literals, and the theme builder must tolerate a
  null deck (fall back to the style's default palette).
- Keep `src/ui/renderCard.js` as a thin re-export shim
  (`export { makeCardRenderer } ...` plus the legacy functions delegating to
  the vanilla style) so tests and any stragglers don't break mid-migration;
  delete the shim in the final phase.

### 3.3 Style resolution order

1. `manifest.ui.cardStyle` if present and in the registry enum.
2. Else by template: `shedding → shedding`, `sequencing → sequencing`,
   `trick-taking → classic`, `contract-rummy → classic`.
3. Special case: `deck === "standard-52"` always defaults to `classic`
   (Crazy Eights is a shedding *template* on a standard deck — it must get
   pips, not Wildfire paint). Manifest override still wins.
4. Else `vanilla`.

Stockpile's manifest sets `"ui": { "cardStyle": "rankrun" }` explicitly since
its template doesn't imply it.

## 4. Manifest schema additions (`schema/manifest.schema.json`)

Extend the existing `$defs.ui` object (which already has `felt`):

```jsonc
"ui": {
  "felt":        { "type": "string" },
  "cardStyle":   { "enum": ["vanilla", "classic", "shedding", "sequencing", "rankrun"] },
  "cardPalette": {                      // deck color name -> hex
    "type": "object",
    "additionalProperties": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" }
  },
  "cardBack": {
    "type": "object",
    "properties": {
      "pattern": { "enum": ["lattice", "sunburst", "rings", "pinstripe", "weave"] },
      "color":   { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
      "emblem":  { "type": "string", "maxLength": 2 }   // 1–2 chars, escaped
    },
    "additionalProperties": false
  }
}
```

Runtime still re-validates every value through `safeCssColor`/`safeAccent`
(schema validation is a repo gate, not a runtime guarantee once sharing
ships — §7b). `emblem` is rendered through `escapeXml` like every other
pack string.

## 5. Face style specs

All faces keep `viewBox="0 0 100 140"`, `rx="8"` outer rect, and the existing
`aria-label` text. Colors go through CSS classes + a small number of inline
`fill` values that come only from the gated palette. Layered structure per
face: background → frame → center art → corner indices → effect badge.

### 5.1 `classic` — standard 52 (Hearts, Crazy Eights)

- **Corner indices**: rank *above* suit glyph, stacked vertically, top-left
  and bottom-right (bottom-right rotated 180° via
  `transform="rotate(180 50 70)"` on a group — gives authentic upside-down
  index). Red suits `#b91c1c`, black `#111` (existing classes).
- **Pip layouts for A,2–10**: a coordinate table in `classic.js`, columns at
  x = 30 / 50 / 70, rows at y = 28 / 55 / 70 / 85 / 112 (tune visually).
  Standard arrangements:

  | Rank | Pips | Layout |
  |------|------|--------|
  | A    | 1    | single large center pip |
  | 2    | 2    | center column, top + bottom |
  | 3    | 3    | center column |
  | 4    | 4    | corners of pip grid |
  | 5    | 5    | 4 + center |
  | 6    | 6    | two columns of 3 |
  | 7    | 7    | 6 + one upper-middle |
  | 8    | 8    | 6 + upper- and lower-middle |
  | 9    | 9    | two columns of 4 + center |
  | 10   | 10   | two columns of 4 + two middles |

  Pips in the lower half render rotated 180° (real-deck convention). Pip
  glyph reuses `SUIT_GLYPH` as `<text>` at ~18px — no path data needed.
- **Court cards (J/Q/K)**: no figurative portraits (that's a real art
  project and a licensing trap). Original geometric treatment: a bordered
  inner panel (rect inset 14,24→86,116, 2px stroke in suit color) containing
  a large mirrored ornament built from the suit glyph — e.g. a 40px suit pip
  flanked by two 20px pips rotated ±30°, plus a crown motif for K (three
  triangles on a bar), a diadem for Q (arc + dot), a single chevron for J,
  drawn as 3–4 `<path>`/`<polygon>` elements in the suit color. Reads as
  "court card" at a glance without pretending to be a Bicycle deck.
- **Ace of spades** gets the traditional oversize ornamented pip (40px glyph
  inside a thin double-ring ellipse) — free flourish, no trademark issue.

### 5.2 `shedding` — Wildfire (Uno genre)

Original geometry (deliberately not the Uno tilted-ellipse):

- **Background**: full-bleed card in the deck color (palette-gated), plus an
  8px darker border band (`color-mix` in CSS or a precomputed darker hex in
  the palette table) — gives cards a chunky "game card" frame.
- **Center panel**: a **rounded-diamond** (squircle rotated 45°, i.e.
  `<rect x=30 y=45 width=40 height=40 rx=10 transform="rotate(45 50 70)">`)
  in white at 92% opacity. This is the signature shape — distinct from any
  existing trade dress.
- **Number cards**: large rank numeral (44px, weight 800) centered in the
  panel, filled in the card color, with a 1.5px darker outline
  (`paint-order: stroke`) for pop. Small numerals in the corners (existing
  corner classes) in white with dark outline.
- **Skip**: circle + 45° slash (two SVG primitives, 6px stroke, card color)
  centered in the panel; corners show the same icon at 10px instead of the
  word "skip" (fixes the current xs-text squeeze).
- **Reverse**: two chevron-arrows chasing each other point-to-tail around the
  panel center (two `<path>` elements, mirrored via `rotate(180 50 70)`).
- **Draw 2**: two overlapping mini-card rects (10×14, offset 4,4) in the
  panel + "+2" beneath; corners show "+2".
- **Wild**: dark charcoal card (`#26262b`), center rounded-diamond split into
  four color quadrants using the deck's actual palette (four `<path>` wedges
  clipped to the diamond via `<clipPath>` — or simpler: four rotated rects
  inside the diamond group). Corners show a 4-dot cluster (one dot per
  color).
- **Wild Draw 4**: same dark card + quadrant diamond, plus four mini-card
  rects fanned across the center (one per color) and "+4" corners.
- Palette source: `deck.colors` order + `manifest.ui.cardPalette` override;
  defaults `red #c0392b, yellow #e1b12c, green #27ae60, blue #2f6fb0`
  (already in table.css — move to the theme).

### 5.3 `sequencing` — Milestones (Phase 10 genre)

- **Background**: white card, thick (6px) rounded border in the card color,
  plus a thin inner pinstripe.
- **Number cards**: huge numeral (48px) in the card color filling the center,
  with a subtle 20% opacity oversized "ghost" numeral behind it offset
  (2,2) for depth. Corner numerals top-left/bottom-right (rotated), in the
  card color on white — high contrast at 28px.
- **Wild**: border drawn as a four-color gradient ring (four arc strokes,
  one per deck color), center shows "W" at 48px over a subtle four-color
  quadrant disc; corners "W".
- **Skip**: neutral slate border, center circle-slash icon (same primitive
  as shedding but slate `#475569`), corners show the mini icon.

### 5.4 `rankrun` — Stockpile (Skip-Bo genre)

- **Rank-band coloring** computed from rank (no per-card color in the deck):
  ranks 1–4 → blue, 5–8 → green, 9–12 → red (band hexes in the style's
  default palette, overridable via `ui.cardPalette` keys `band1/band2/band3`).
- **Face**: white card, colored top and bottom caps (two rounded-corner
  paths hugging the short edges), huge center numeral (52px) in the band
  color with dark outline, corner numerals inside the caps in white.
- **Wild**: all three band colors as diagonal ribbons across the center +
  "★" numeral slot; corners "★". (18 of 162 cards are wild — they should
  look exciting.)

### 5.5 `vanilla`

Unchanged, still the fallback for style-less / future packs. Extraction to
`vanilla.js` must be byte-identical output (existing tests pin its behavior).

## 6. Card backs (`backs.js`)

One generator, five patterns, all parameterized by `{ color, emblem }`:

- Structure: outer rect (dark shade of `color`), 4px white inner border
  inset (classic playing-card look), pattern fill inside, centered emblem
  disc (24px circle, white ring, 1–2 char emblem text or a generic pip
  cluster when emblem is absent).
- Patterns are `<defs><pattern>` tiles of 2–3 primitives each:
  - `lattice` — 45° crosshatch lines
  - `sunburst` — rays from center (no `<pattern>`; 24 rotated wedge lines)
  - `rings` — concentric circles
  - `pinstripe` — diagonal stripes
  - `weave` — offset dashes in two directions
- Per-pack defaults (written into each manifest in phase 4):

  | Pack | pattern | color | emblem |
  |------|---------|-------|--------|
  | wildfire | sunburst | accent `#d2601a` | ✱ (rendered glyph, not text field) |
  | milestones | rings | accent | "M" |
  | stockpile | weave | accent | "S" |
  | hearts | lattice | `#7f1d2d` | ♥ |
  | crazy-eights | pinstripe | `#274b8c` | "8" |

- `back(theme)` output is memoized per renderer instance (it's called once
  per face-down card in every mini-hand re-render — dozens per frame today).
- Determinism test updates from "no-arg calls are identical" to "same theme →
  identical markup; different theme → different markup".

## 7. CSS changes (`src/ui/table.css`)

- Move hardcoded painted-color hexes (`.card-face--painted.*`, lines
  ~558-561) into the shedding style's default palette; keep the classes one
  release for the shim, delete with it.
- New shared classes: `.card-art` (presentational group), `.card-face__panel`
  (center shape), `.card-face__outline-text` (`paint-order: stroke;
  stroke-linejoin: round`), per-style modifiers `.card-face--classic` etc.
- Corner-size logic mostly disappears for the new styles (icons replace long
  words); `cornerSizeClass` stays in `shared.js` for vanilla only.
- Nothing pack-supplied is ever interpolated into a stylesheet — palette
  hexes go into SVG `fill` attributes after `safeCssColor`, matching the
  existing `css.js` discipline.

## 8. Phases (each lands green: `npm test` + visual check via launch.json preview)

### Phase 1 — plumbing (no visual change)
1. Create `src/ui/cardStyles/` with `shared.js`, `vanilla.js` (verbatim
   extraction), `index.js` registry + `makeCardRenderer` + `buildTheme`.
2. Thread the renderer through `table.js` and `lobby.js`; leave
   `renderCard.js` as the delegating shim.
3. Schema: add `ui.cardStyle` / `ui.cardPalette` / `ui.cardBack`.
4. Tests: `tests/cardStyles.test.js` — resolution order (§3.3), theme
   gating (bad hex → fallback, unknown style → vanilla, null deck
   tolerated), vanilla extraction produces byte-identical output for a
   sample of cards vs. the legacy functions.

### Phase 2 — themed backs
1. `backs.js` with the five patterns; wire `back()` through the theme;
   memoize.
2. Write `ui.cardBack` defaults into all five manifests.
3. Update the back-determinism security test as described in §6; add
   injection tests for `emblem` (payload emblem → escaped output).

### Phase 3 — `shedding` style (highest visual payoff)
1. Implement §5.2; set Wildfire's `ui.cardStyle` (or rely on template
   default) and palette.
2. Tests: every Wildfire deck card renders (expand deck via `packLoader`,
   render all 108, assert no `undefined`/`NaN`/`${` in output — cheap
   full-coverage smoke); injection tests with hostile rank/color/effect;
   wild renders all four palette colors.
3. Visual pass at 28 / 54 / 90 px in the preview browser.

### Phase 4 — `sequencing` + `rankrun`
Same shape as phase 3 for Milestones (§5.3) and Stockpile (§5.4), including
Stockpile's explicit `ui.cardStyle`. Verify the sequencing per-player discard
rows and Stockpile's build piles in the preview (these are the dense layouts).

### Phase 5 — `classic` pips + courts
1. Implement §5.1 with the pip coordinate table; standard-52 default (§3.3
   item 3) kicks in for Hearts and Crazy Eights automatically.
2. Tests: pip count per rank (parse `<text class="card-face__pip">`
   occurrences: 7♥ → exactly 7), court cards contain the ornament group,
   A♠ special case present, red/black classing unchanged.
3. Visual pass on a full Hearts trick and a 13-card hand.

### Phase 6 — cleanup + polish
1. Delete the `renderCard.js` shim; update the two imports and
   `tests/security.test.js` imports to the registry.
2. Delete dead CSS (painted classes, xs-corner sizing if unused).
3. Lobby hero fans now themed — screenshot check that all five tiles look
   right and distinct.
4. Run `tools/acceptance.mjs` + full test suite; bump precache manifest via
   `tools/inject-precache.mjs` if the file list changed (new JS modules!).
   **Note:** new `src/ui/cardStyles/*.js` files must be added to whatever
   the SW precache derives from — check `tools/inject-precache.mjs` early,
   not at the end.

## 9. Acceptance criteria

- All five packs are visually distinguishable from a lobby screenshot alone.
- A Wildfire draw2/skip/reverse/wild is identifiable with the rank text
  covered (icon carries the identity).
- 7♥ shows seven heart pips; Q♠ reads as a court card at 90px.
- Every back differs per pack and matches the pack accent.
- `npm test` green, including unchanged aria-labels, injection tests
  extended to every new style, and back determinism per theme.
- No new network requests, no bitmap assets, no font downloads; `sw.js`
  precache covers the new modules (offline reload still renders art).
- Rendering all cards of all five packs produces no string containing
  `undefined`, `NaN`, `${`, or an unescaped pack value.

## What changed in the build

Six things. Two were plan errors that would have shipped the wrong art; two
were bugs the plan's own approach would have created; two are judgement calls.

### 1. The template → style map was backwards for two packs (§3.3)

The plan mapped `sequencing → sequencing` and `contract-rummy → classic`. But
**Milestones' template is `contract-rummy`** and **Stockpile's is
`sequencing`** — so that map would have given Milestones the standard-deck pip
treatment (it has no suits) and Stockpile the Phase-10 art (it has no colours).

Fixed by narrowing what is inferred to the two things that are actually
reliable, and having the packs say the rest:

```js
manifest.ui.cardStyle                     // wins outright
deck matches /^standard-5[24]/  → classic // BEFORE the template: Crazy Eights
manifest.template === 'shedding' → shedding
otherwise                        → vanilla
```

Milestones and Stockpile declare `ui.cardStyle` in their manifests. A template
does not know what a deck looks like, so it is no longer asked.

### 2. No SVG ids, `<defs>`, `<pattern>` or `url(#…)` anywhere (§5.2, §6)

The plan reached for `<pattern>` tiles for the backs and a `<clipPath>` for the
wild's colour quadrants. **Ids are document-scoped, and these SVGs are inlined
by the dozen** — a mini-hand is one per card, and the lobby has five packs on
screen at once. Two cards declaring `id="lattice"` make every `url(#lattice)`
on the page resolve to whichever rendered first, so one pack silently paints
another pack's cards, with nothing failing.

Everything is explicit geometry instead. The back patterns are unrolled and
**clipped in JS** (Liang–Barsky, `backs.js`) because the other thing
`<pattern>` would have done for free is stop the tiling at the paper's edge —
and on a card with rounded corners there is nothing to clip against but the
shape itself. `tests/cardStyles.test.js` asserts no style emits an id, and that
no pattern draws past the printed area.

### 3. The palette is a null-prototype object

Not in the plan, and load-bearing. The palette is looked up by the card's own
`color` field, which is pack-supplied: on a plain object a card claiming
`"color": "constructor"` resolves to `Object.prototype.constructor` and
stringifies an entire function into a `fill` attribute. Same reason
`resolveStyleId` uses `Object.hasOwn` rather than `in`.

### 4. `renderPiles` already had a local `cards`

The table's renderer is held in `cardArt`, not `cards`. A module-level `cards`
is shadowed by `renderPiles`'s existing `const cards = state.zones.cards(...)`
for the whole function — including the lines above it, where it is in the
temporal dead zone. That is a `ReferenceError` on the first render of every
table, and no unit test reaches it: it only showed up in the browser.

### 5. Icons are sized to the diamond, not to a circle

The plan sized Wildfire's action icons by eye. The white centre panel is a
diamond, so its usable half-width at a given height is `31 - |dy|`, not 31 — a
mark that clears a circle can still poke out through the corners, which the
reverse arrows did. The two arrows were also overlapping through the middle
(the plan's "chasing each other point-to-tail"); at 40px they merged into one
unreadable blob and at 8px into a dot. Each arrow now sits in its own half.

### 6. Contrast is a test, not an opinion

The plan said nothing about it, and two colours failed. Milestones' yellow
numeral was **2.2:1** on white and Stockpile's middle band **2.9:1** under its
white corner index. The sequencing numeral is now inked at `shade(border,
-0.35)`, which is what puts the worst pack colour over 4.5:1 rather than over
the 3:1 large-text line — the corner index shares that ink and is nowhere near
large text once a card is 70px wide. `tests/cardStyles.test.js` measures the
headline text of a rendered card and fails under 4.5:1.

### Smaller notes

- **`makeCardRenderer(manifest, cardsById)`**, not `(manifest, deck)`:
  `loadPack` does not carry the deck's `colors` array through to runtime, so
  the palette is derived from the cards themselves. A deck colour with no
  palette entry borrows the style's *n*th default rather than collapsing onto
  the first.
- **The `renderCard.js` shim was skipped.** The plan kept it through phase 5;
  since all phases landed together it was deleted outright and the two
  importers plus `tests/security.test.js` moved to the registry.
- **The precache needed nothing** (§8 phase 6 worried about it): `stage.mjs`
  builds from `git ls-files`, so the new modules are covered as soon as they
  are tracked. They are invisible to the artifact until `git add`, which is
  worth knowing but is not a code change.
- **`OWN_TAGS` in `tests/security.test.js`** grew to
  `svg|g|rect|text|circle|ellipse|line|path|polygon`, and every injection case
  now runs through **all five styles** rather than the one renderer. A new case
  covers `effect.n`, which is the one number on a face that comes straight out
  of a manifest, and one asserts that every `fill`/`stroke` on every card is a
  shape this repo generated.
