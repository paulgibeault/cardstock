# Arcade compliance — evaluation and remediation plan

Evaluated against the launcher repo's `GAME_INTEGRATION.md` (SDK major **v3**),
`ARCADE_PLATFORM.md`, `catalog.json`, and `.github/workflows/fleet-ci.yml`, plus
the shipped fleet apps as reference implementations (`cozy-solitaire` is the
closest analogue). Cross-checked against this repo's own
`CARD_PLATFORM_DESIGN.md` §17, which anticipated most of this contract and is
mostly still right — the places it has drifted are called out in
[Appendix A](#appendix-a--stale-statements-in-our-own-docs).

---

## Verdict

**Cardstock has zero arcade integration today, and that is by design** —
`src/main.js:1` says so, and `IMPLEMENTATION_NOTES.md` records it as a
deliberate milestone-1 deferral. The engine, templates, and packs are in good
shape; nothing in the compliance work below requires touching engine logic
except one RNG swap.

What that means concretely: of the 14 items on the §13 acceptance checklist,
**2 pass today** (standalone works; no console errors), **1 is unverifiable**
(no SDK loaded), and **11 fail**. The game cannot be listed in the launcher at
all, because it has no catalog entry, no icon, and no CI pipeline.

There is also one **non-technical blocker** that gates catalog registration
regardless of how much code lands: three of the five packs carry Mattel
trademarks and this repo's own README says to rename them before any public
release. Listing in `catalog.json` *is* that public release. See
[Decision 1](#decision-1--trademarked-packs-blocking).

---

## Scorecard

| § | Requirement | Status | Where |
|---|---|---|---|
| 1 | Hosted at `/<gameId>/`, id matches repo slug | ⚠️ partial | repo renamed to `cardstock`; local remote + README still say `card-game` |
| 1 | Entry in `catalog.json` | ❌ absent | launcher repo |
| 1 / 11 | `icon.png` ≥ 512×512 in this repo | ❌ absent | — |
| 2 | SDK loaded + `Arcade.init` | ❌ absent | `index.html` |
| 2 | `await Arcade.ready` before state reads | ❌ absent | `src/main.js:213` |
| 3 | State under `arcade.v1.cardstock.*` | ❌ no persistence at all | — |
| 3 | `onStateReplaced` re-hydrate | ❌ absent | — |
| 3a | `Arcade.store` / `files` for bulky data | ⏸ not needed yet | design §17.3 plans it |
| 3b | Sync opt-in on player-facing keys | ⏸ follows from §3 | — |
| 3c | `migrate` / `adopt` | ✅ n/a | greenfield, no legacy keys |
| 4 | Player name, scores/records/stats | ❌ absent | — |
| 5 | `fontScale` | ⚠️ mostly | chrome is `rem`; card SVG text is `px` — defensible, needs documenting |
| 5 | `theme` | ❌ absent | `src/ui/table.css` — fixed green felt, no `[data-theme]` |
| 5 | `reducedMotion` | ⚠️ partial | CSS covered free by SDK kill-switch; JS deal stagger is not gated |
| 5 | `handedness` | ❌ absent | — |
| 5 | `Arcade.audio` | ❌ no audio | optional, but see [Phase 7](#phase-7--audio-optional) |
| 6a | `onSuspend` / `onResume` | ❌ absent | — |
| 6a | Managed timers | ❌ bare `setTimeout` | `src/main.js:188` |
| 6b | Survive eviction | ❌ all state in memory | `src/main.js:36` `liveState` |
| 7 | `Arcade.ui.setTitle` / `toast` | ❌ raw `document.title` | `src/main.js:215` |
| 7a | Multiplayer | ⏸ out of scope | optional by contract |
| 7b | Escape untrusted strings | ❌ **latent hole** | `src/ui/renderCard.js:33`, `src/main.js:88` |
| 7b | Validate ids against a charset | ❌ absent | `src/main.js:14`, `:51` |
| 7c | Vendor `arcade-rng.js` | ❌ hand-rolled fork | `src/engine/rng.js` |
| 8 | Standalone works | ✅ pass | — |
| 9 | Sandbox-safe (no `localStorage`, no top-level nav) | ✅ pass (vacuously) | must stay true once §3 lands |
| 10 | `manifest.json` + `sw.js` | ❌ neither | — |
| 12 | Dev via launcher `dev.sh` | ⚠️ own `serve.mjs` sends no CORS header | `tools/serve.mjs:36` |
| 13 | `npm run acceptance` passes | ❌ never run | — |
| 13a | Fleet CI thin caller | ❌ absent | no `.github/` at all |
| 13a | Node ≥ 24 | ❌ declares `>=20` | `package.json:14` |
| 13a | `test` script gating deploy, suites in `tests/` | ❌ suites live in `tools/`, no `test` script | `package.json:7-12` |
| 13a | `stage.mjs` / `verify-artifact.mjs` / `inject-precache.mjs` | ❌ none | — |
| 13a | Pages source = GitHub Actions | ❓ verify | likely "deploy from branch" today |

---

## Findings in detail

### A. Blocking — cannot list in the launcher without these

**A1. No catalog entry, no icon.** §1 registration is two steps and neither is
done. `catalog.json` needs `id: "cardstock"`, `name`, `subtitle` (design §17.1
already picked **"Card games"**, 10 chars, well under the ≤ 20 guidance), `icon:
"/cardstock/icon.png"`, `url: "/cardstock/"`, and an optional `profile` block
for the portfolio page. The icon is served from *this* repo and must survive
staging into `dist/`.

**A2. No CI/CD.** There is no `.github/` directory. Every fleet app deploys
through the shared `fleet-ci.yml` via a thin `pages.yml` caller, and the
pipeline's `deploy` job hard-fails without either a `build` script or
`tools/stage.mjs`. Today's "deploys automatically from `main`" (README) is
almost certainly GitHub's branch-based Pages build — §13a requires the Pages
source be set to **GitHub Actions**, otherwise Jekyll races the real pipeline.

**A3. Identity is half-renamed.** `gh` reports the GitHub repo as
`paulgibeault/cardstock`, but `git remote -v` still points at
`.../card-game.git` (working only via GitHub's redirect) and `README.md` links
players at `https://paulgibeault.github.io/card-game/`, which is not where the
site lives after a rename. §1 requires gameId == repo slug == catalog id ==
manifest scope == `sw.js` `GAME_ID`.

**A4. Trademarked pack names.** See [Decision 1](#decision-1--trademarked-packs-blocking).

### B. Structural — the acceptance checklist fails without these

**B1. The SDK is never loaded.** `index.html` has no `<script
src="/arcade-sdk.js">` and no `Arcade.init`. Use the **evergreen** alias, not
the major-pinned path — §2 states this is the deliberate fleet posture and all
nine local fleet apps use `/arcade-sdk.js`. (Note the launcher's
`tools/templates/starter-app/index.html` comment argues for `/sdk/v3/…`; it
contradicts §2 and the shipped fleet. Follow §2.)

**B2. Nothing persists.** There is no storage of any kind, so three acceptance
items fail outright: "at least one key matches `arcade.v1.<gameId>.*`", the
Save→Load round-trip, and "re-launching after eviction restores user-visible
progress". The whole match lives in `liveState` (`src/main.js:36`) and dies with
the frame. Note also that the pack selector is a **query param**
(`?pack=`, `src/main.js:14`) — launcher deep links are `#app=cardstock` only, so
the chosen pack cannot survive a relaunch by that route either. Last-played pack
must move into `Arcade.state`.

**B3. Lifecycle is unmanaged.** No `onSuspend`/`onResume`, and bot turns are
scheduled with a bare `setTimeout` (`src/main.js:188`) that keeps firing into a
hidden frame — exactly the §6c "forgotten timers are the #1 battery drain"
case. `Arcade.session.setTimeout` freezes while suspended and self-cancels on a
save import. The existing `epoch` guard is still needed for "Play again", but
`session` timers make the state-import leg free.

**B4. No `onStateReplaced`.** A launcher save import while the table is open
leaves the UI showing a match that no longer exists in storage.

### C. Security — real latent holes, worth fixing before packs become shareable

The design doc's own roadmap (§17.3, §7d config exchange) points at
pack *sharing*. The moment a pack can arrive from another device, every field in
it is hostile input. Two of these are already wrong today:

**C1. Unescaped `aria-label`** — `src/ui/renderCard.js:33` interpolates
`cardAriaLabel(card)` directly into an HTML attribute, and that function
(`:50-54`) returns raw `card.rank`, `card.suit`, `card.color`, `card.id`. The
neighbouring text nodes *are* escaped via `escapeXml`, so this reads as an
oversight rather than a decision. With a shared pack, `"` in a card id breaks
out of the attribute. §7b calls this out as a class that has shipped twice in
this fleet.

**C2. Unvalidated pack id in a fetch path** — `src/main.js:14` takes `?pack=`
straight from the URL and `:51` splices it into `packs/${packId}/manifest.json`.
§7b requires ids used in paths, selectors, or attributes to be validated against
a charset (`/^[\w-]+$/`).

**C3. `innerHTML` on the opponent row** — `src/main.js:88` builds markup with
`seatLabel(seat)` interpolated. Literal today; the instant it becomes
`Arcade.player.name()` or a peer name it is the shipped-twice bug verbatim.
Convert to `textContent` / `Arcade.html` now, while it costs nothing.

**C4. Pack-derived value into an inline style** — `src/main.js:146` assigns
`btn.style.background = opt` from pack colour values. Low severity, same fix
shape: validate against a charset.

### D. Determinism — one clean swap, cheapest now

`src/engine/rng.js` is a hand-rolled mulberry32 with a **custom seed hash**,
while the platform ships `/arcade-rng.js` using FNV-1a. §7c is explicit that the
platform owns this and games vendor a byte-identical copy (importable as a plain
ES module, so `node --test` and the browser both resolve it). The two produce
**different streams from the same string seed**, so this is a save-compat break
once seeds are persisted — and B2 is about to persist seeds. Do it in the same
pass.

Risk is low: rule tests place every card explicitly
(`packs/*/tests/rules.test.json`), so only `unlisted` fill and recycle shuffles
touch the RNG. Re-run `pack-test.mjs --all` to confirm 38/38 still green, and
pin the algorithm with the known-answer vectors §7c supplies
(`makeRng(42)` → `0.6011037519201636, 0.44829055899754167, 0.8524657934904099`).

Also `startGame` seeds with `Date.now()` (`src/main.js:202`); a resumable or
replayable match needs the seed stored alongside the state.

### E. Settings & accessibility

- **`theme`** is the one real design decision here — see
  [Decision 2](#decision-2--theme-support).
- **`reducedMotion`**: the CSS side is free (the SDK injects a kill-switch rule
  keyed on `data-reduced-motion`, and we set no `data-arcade-keep-motion`
  opt-out). The `@media (prefers-reduced-motion)` block at
  `src/ui/table.css:145` reads the *OS* setting, not the launcher's — keep it
  for standalone, but the JS-driven deal stagger (`src/main.js:85,112`) must
  gate on `Arcade.settings.reducedMotion()`.
- **`fontScale`**: chrome is already `rem`. The `px` sizes at
  `src/ui/table.css:171-174` are inside an SVG `viewBox`, so they scale with the
  card, not with text — that matches design §17.7 ("card faces scale with
  layout, not font size") and is fine, but §5 wants it stated deliberately.
- **`handedness`**: nothing keys off it. The hand fan and the Draw button are
  the natural anchors (design §17.7 already committed to this).

### F. PWA / service worker

Neither `manifest.json` nor `sw.js` exists. Design §17.9 calls this optional,
but the fleet posture in §10 is that six of seven catalog apps ship both, and
pack assets under `/cardstock/packs/**` are exactly the kind of thing that makes
solo play fully offline. Recommend shipping both, starting from the launcher's
`tools/templates/game-sw.js`, which already encodes every §10 rule: scope-guarded
fetch, `cardstock-` prefixed cleanup (**never** origin-wide — that's the
incident §10 documents), the CI-owned `const APP_VERSION = '0.0.0';` line shape,
generated precache markers, per-asset `add()`, `ignoreSearch`, and the
`arcade:sw.skipWaiting` handler (omit it and the worker waits forever).

### G. Staging details that will bite

- The fleet's default `isDevOnly` only excludes **top-level** directories, so
  `packs/*/tests/rules.test.json` and `schema/` will publish. Either exclude
  them in `stage.mjs` or name them in `PRECACHE_EXCLUDE` — `verify-artifact.mjs`
  fails the build on any published file that is neither cached nor listed.
- `tools/` is excluded, so `pack-test.mjs` / `simulate.mjs` / `serve.mjs` won't
  ship. Good — but they import from `src/`, which does ship. No conflict.
- `.nojekyll` publishes and needs the same treatment (harmless either way once
  Pages is on Actions).
- `tools/serve.mjs:36` sends no `Access-Control-Allow-Origin`, so it cannot
  serve a framed test — opaque-origin frames need CORS for module and `fetch`
  loads. Framed dev must go through the launcher's `./dev.sh ../cardstock`.

---

## Decisions — resolved 2026-08-04

All five are decided; the analysis below is retained as the record of the
options. The decision-resolved implementation plan lives in
`ARCADE_ENHANCEMENTS.md` (v2).

### Decision 1 — trademarked packs (BLOCKING)

`README.md` states: *"Uno, Phase 10, and Skip-Bo are Mattel trademarks. The
packs describe public gameplay for personal use; replace names and art before
any public release."* Adding an entry to `catalog.json` **is** that public
release, and the current mitigation (only Crazy Eights is linked from the UI) is
convention, not enforcement — `packs/uno/`, `packs/phase-10/`, and
`packs/skip-bo/` are published files reachable by `?pack=uno`, and any
tracked-file staging publishes their manifests with the trademarked names
inside.

Options:

1. **Rename the packs** (mechanics are not protected; names and art are). Keeps
   all five playable and is the only option that lets the catalog entry say
   "Card games" honestly.
2. **Exclude the three packs from the artifact** in `stage.mjs` — ship
   Crazy Eights (public domain) plus Hearts (public domain), keep the other
   three as engine fixtures that never deploy. Cheapest, and rule tests still
   run in CI.
3. **Delay listing** until renamed.

Recommendation: **(2) now, (1) as a follow-up.** It unblocks the whole
integration immediately at the cost of two packs, and it makes the constraint
mechanical instead of conventional.

**Resolved: option (1) — rename now.** All five packs stay published; no
stage-time exclusions. Rename map and tasks: `ARCADE_ENHANCEMENTS.md`
Phase 0.

### Decision 2 — theme support

§5 permits opting out of `theme` when the game has a single mandatory aesthetic,
*provided the README documents it*. The green felt table is arguably that.
Design §17.7, however, committed to keying chrome and the vanilla renderer off
`[data-theme]` and made "`theme.css` must style both themes" a pack rule.

- **Honor it**: more work now, but the pack-theming rule stays coherent and a
  light-mode player isn't blinded.
- **Opt out**: one README paragraph, zero code. Revisit when packs ship their
  own `theme.css`.

Recommendation: **opt out for now with a documented note**, and keep the
pack-level "must style both themes" rule for when per-pack theming actually
lands. Shipping a half-themed table is worse than a deliberate fixed one.

**Resolved: honor it.** Full `[data-theme]` light/dark support for chrome
and the vanilla renderer; the pack rule stays. Tasks:
`ARCADE_ENHANCEMENTS.md` Phase 3.

### Decision 3 — how much storage to build

Design §17.3 maps match logs and replays onto `Arcade.store`. §3a warns those
surfaces are **available but not yet exercised by any catalog app** — first
consumer should budget extra verification. Compliance needs only `Arcade.state`.

Recommendation: **`Arcade.state` only** for this pass (last pack, prefs,
resumable match snapshot, per-pack stats). Defer `Arcade.store` to the replay
work, and expect to spend real time proving it when you get there.

**Resolved: `Arcade.state` only, with `Arcade.store` stubbed** — a storage
adapter pins the store-shaped surface and key names now so the replay work
swaps implementations without touching call sites. Details:
`ARCADE_ENHANCEMENTS.md` Phase 2 step 3.

### Decision 4 — `inDevelopment` flag

The catalog supports `"inDevelopment": true`, which stamps an *In Development*
ribbon on the card. Given one polished pack and no multiplayer, recommend
**listing with the flag** and dropping it when pack coverage and polish land.

**Resolved: yes, list with the flag.** Drop it when multiplayer
(`ARCADE_ENHANCEMENTS.md` Phase 8) and pack polish land.

### Decision 5 — multiplayer scope

Out of scope for compliance (§7a: "multiplayer is a bonus, never a
requirement"). Worth noting that `ARCADE_ENHANCEMENTS.md`'s premise is now
satisfied — `peer.sendTo`, `peer.roster`, and `peer.meta` are all in the SDK's
documented capability list, plus `peer.party` arrived after that doc was
written. That doc can be retired or folded into design §17.5.

**Resolved: multiplayer is a primary feature, implemented in its own later
phase — planned in full now.** Rather than being retired,
`ARCADE_ENHANCEMENTS.md` was rewritten (v2) as the canonical
implementation plan; its Phase 8 is the multiplayer work breakdown,
including the seams earlier phases must preserve for it.

---

## Plan

> **Superseded (2026-08-04).** The canonical, decision-resolved plan is
> `ARCADE_ENHANCEMENTS.md` (v2) — implement from there, not from here. It
> carries these phases forward with the resolutions applied (a new Phase 0
> renames the trademarked packs instead of excluding them in `stage.mjs`;
> Phase 3 implements full theme support instead of the opt-out; Phase 2
> adds the `Arcade.store` stub seam) and adds Phase 8, the multiplayer
> work breakdown. The text below is retained as the evaluation-time draft.

Seven phases. Phases 1–6 are the compliance path; Phase 7 is optional polish.
Phases 1 and 2 are independent and can run in parallel.

### Phase 1 — repo and CI foundation

*No gameplay change. Gets the deploy pipeline correct before anything depends
on it.*

1. `git remote set-url origin https://github.com/paulgibeault/cardstock.git`; fix
   the two `card-game` URLs in `README.md`.
2. `package.json`: `"engines": { "node": ">=24" }`; add
   `"test": "node tools/verify-artifact.mjs && node --test 'tests/*.test.js'"`.
3. Move the rule-test and simulation harnesses under `tests/`:
   - `tests/packs.test.js` — wraps `runPackTests` for all five packs as
     `node:test` cases (keep `tools/pack-test.mjs` as the CLI entry point;
     have the test import it rather than duplicating).
   - `tests/repo-gates.test.js` — copy from `cozy-solitaire`; every tracked
     JS/JSON parses. This is the floor gate.
4. Copy **byte-identical** from the launcher repo: `tools/verify-artifact.mjs`,
   `tools/inject-precache.mjs`. Never edit these copies.
5. Write `tools/stage.mjs` (the only per-app part): export `ROOT`, `stage(outDir)`,
   `PRECACHE_EXCLUDE`. Start from `cozy-solitaire`'s and add cardstock's
   specifics — exclude `packs/*/tests/`, `schema/`, and (per Decision 1) the
   trademarked packs; call `injectPrecache` last.
6. Add `.github/workflows/pages.yml` — the thin caller from §13a, with
   `version_bump: true` and `contents: write` (we will have an `sw.js` by
   Phase 5).
7. Switch the GitHub repo's Pages source to **GitHub Actions**.

**DoD:** `npm test` green locally; a push to `main` deploys via Actions and the
site still serves at `https://paulgibeault.github.io/cardstock/`.

### Phase 2 — SDK boot, storage, lifecycle

*The bulk of the acceptance checklist.*

1. `index.html` `<head>`, before the module script:
   ```html
   <script src="/arcade-sdk.js"></script>
   <script>Arcade.init({ gameId: 'cardstock' });</script>
   ```
2. Restructure `boot()` (`src/main.js:213`) around `await Arcade.ready` before
   any state read.
3. Vendor `src/engine/arcade-rng.js` (byte-identical copy of the launcher's
   `/arcade-rng.js`); rewrite `src/engine/rng.js` as a thin adapter over
   `makeRng` preserving the current `{ next, int, shuffle }` shape so no engine
   call site changes. Add known-answer vectors to `tests/`. Re-run
   `pack-test.mjs --all` and confirm 38/38.
4. Storage, all under `arcade.v1.cardstock.*`:
   - `lastPack` — replaces `?pack=` as the source of truth (keep the query param
     as an override).
   - `settings` via `Arcade.state.getOrInit('settings', DEFAULTS)`.
   - `activeMatch` — seed + zone contents + turn + vars, written after each
     applied move, so a relaunch resumes. Store the RNG state via
     `getState()`, not just the seed.
   - `Arcade.stats.update('<packId>', …)` for games played/won.
   - Mark player-facing keys `{ sync: true }`.
5. `Arcade.onStateReplaced(...)` → discard `liveState`, re-hydrate from storage,
   re-render. Treat it as a fresh boot; do not assume the current screen is valid.
6. `Arcade.onSuspend` → flush the pending match write **synchronously** (§6b:
   the launcher holds teardown ~250 ms for a sync flush only).
   `Arcade.onResume` → re-render.
7. Replace the bot `setTimeout` (`src/main.js:188`) with
   `Arcade.session.setTimeout`.
8. `Arcade.ui.setTitle(...)` instead of `document.title` (`src/main.js:215`);
   `Arcade.ui.toast` for the boot-failure path (`src/main.js:223`).

**DoD:** `arcade.v1.cardstock.*` keys visible in DevTools; Save→Load round-trips;
*Open Games* = 1, launch another game, come back → the match resumes.

### Phase 3 — settings and accessibility

1. Gate the JS deal stagger on `Arcade.settings.reducedMotion()`.
2. `Arcade.onSettingsChange(...)` → re-render.
3. `[data-handedness="left"]` rules for the hand fan and Draw button.
4. Theme per Decision 2 — either `[data-theme]` rules or a documented README
   opt-out plus a note on why card-face `px` sizes are correct.

**DoD:** changing font scale in the launcher resizes chrome text with no reload;
handedness flips the action side.

### Phase 4 — security hardening

1. Escape `cardAriaLabel` output before it enters the `aria-label` attribute
   (`src/ui/renderCard.js:33`) — reuse the local `escapeXml`.
2. Validate the pack id against `/^[\w-]+$/` before it enters a fetch path
   (`src/main.js:14,51`).
3. Convert the opponent-row `innerHTML` (`src/main.js:88`) to `textContent` /
   `Arcade.html`.
4. Validate the choice colour before it reaches `btn.style.background`
   (`src/main.js:146`).
5. Add a test asserting a card id of `"><img src=x onerror=alert(1)>` renders
   inertly — this is a named acceptance item.

**DoD:** the §13 XSS-inertness check passes.

### Phase 5 — PWA

1. `manifest.json` with `"scope": "/cardstock/"` and `"start_url":
   "./index.html?v=0.0.0"` (CI rewrites the version).
2. `sw.js` at the **repo root** from `tools/templates/game-sw.js`:
   `const APP_VERSION = '0.0.0';` exactly as written, `CACHE_PREFIX =
   'cardstock-'`, precache markers, `arcade:sw.skipWaiting` handler, fetch
   guard on `/cardstock/`, cleanup filtered to the owned prefix.
3. Register it loopback-guarded and fire-and-forget with a `.catch`.
4. Add `icon.png` (≥ 512×512, square) and confirm it lands in `dist/`.

**DoD:** `verify-artifact.mjs` green; standalone works offline after one visit;
no `[Arcade SDK]` cache warning in the console.

### Phase 6 — catalog registration and acceptance

1. Add the `cardstock` entry to the launcher repo's `catalog.json` —
   `subtitle: "Card games"`, `icon: "/cardstock/icon.png"`, `url: "/cardstock/"`,
   `inDevelopment: true` per Decision 4, plus a `profile` block for the
   portfolio page.
2. Run the full checklist:
   ```bash
   cd ../paulgibeault.github.io && ./dev.sh ../cardstock
   ```
   then in another shell:
   ```bash
   npm run acceptance -- http://127.0.0.1:4791/cardstock/
   ```
3. Consider `launcher: true` in `pages.yml` so acceptance runs in CI on every push.
4. Update `README.md` and `IMPLEMENTATION_NOTES.md` to reflect the integration;
   update design §17 per Appendix A.

**DoD:** all 14 §13 items pass; the game appears in the launcher grid and boots
from `#app=cardstock`.

### Phase 7 — audio (optional)

Not required by the checklist, but §5 makes it cheap and a card game without
sound feels unfinished. Use graph cues, not spec cues: load `/arcade-audio.js`,
build `js/soundpack.js`, register via `ArcadeAudioElements.registerPack`, and
audition offline with the launcher's `tools/soundpack/`. The element library
gained `flex` in SDK 3.10.0 explicitly for *"a thin springy sheet bent and
released: paper, cardstock, a flag"* — it is a near-literal match for card
handling. Connect any custom nodes to `Arcade.audio.bus()`, never
`ctx.destination`.

---

## Appendix A — stale statements in our own docs

`CARD_PLATFORM_DESIGN.md` §17 was verified against the arcade docs on
2026-07-10 and has drifted in four places. §17 itself says the arcade docs win.

1. **§17.1 sandbox flags** — states `allow-scripts allow-same-origin
   allow-downloads`. The launcher now mounts games **without**
   `allow-same-origin` (§9). Consequence: the frame runs opaque-origin,
   `localStorage` / `indexedDB` / `caches` property access *throws* rather than
   being empty, and all storage is bridged over postMessage. This does not
   change the plan (we go through the SDK regardless) but it invalidates any
   direct-probe fallback.
2. **§17.1 catalog registration** — says to add cover art at
   `images/cardstock.png` in the *launcher* repo and edit the `#view-launcher`
   grid in `index.html` plus the `#games` section in `profile.html`. All three
   are obsolete: registration is one `catalog.json` entry, and the icon lives in
   **this** repo at `/cardstock/icon.png`.
3. **§17.2 / §17.5 multiplayer gate** — written when E0–E3 were still being
   specced in `ARCADE_ENHANCEMENTS.md`. `peer.sendTo`, `peer.roster`, and
   `peer.meta` all ship in the SDK's documented cap list now, alongside a later
   `peer.party`. The "launcher update required" notice is still correct as a
   defensive path but is no longer the expected case.
4. **§17.9 PWA "optional"** — §10's fleet posture is stronger: a manifest
   implies a worker, and six of seven catalog apps ship both.

Also worth reconciling: the launcher's own
`tools/templates/starter-app/index.html` recommends the major-pinned
`/sdk/v3/arcade-sdk.js`, while `GAME_INTEGRATION.md` §2 mandates the evergreen
`/arcade-sdk.js` and every shipped fleet app uses it. Worth an issue in the
launcher repo; follow §2 here.
