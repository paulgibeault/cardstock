# Cardstock arcade integration — implementation plan (v2)

**This document asks the launcher for nothing.** Despite the filename, v2
is a *Cardstock-side* implementation plan: every task below is work in this
repo. The platform ask-list is **fully satisfied** — read that before
anything else, because the filename and the E-labels scattered through the
other docs both invite the opposite conclusion.

**Status: ready to implement. All open decisions are resolved (2026-08-04).**

**What v1 asked for, and where it went.** v1 of this document specified four
platform-side `Arcade.peer` enhancements — E0 capability flags, E1 targeted
sends, E2 roster + per-peer status, E3 message metadata — as prerequisites
for Cardstock's multiplayer design. **All four shipped in the launcher SDK**,
and a fifth surface the original spec never asked for, `peer.party`, shipped
after them; the documented capability list now carries `peer.sendTo`,
`peer.roster`, `peer.meta`, and `peer.party`. So: nothing here is blocked on,
waiting for, or owed by the launcher, and no launcher change is a
prerequisite for any phase below, Phase 8 included. **Do not re-request any
of it.** The E-labels survive in other docs, so
[Appendix B](#appendix-b--e-label-glossary) keeps them resolvable — it is a
glossary of shipped features, not a backlog.

This is the canonical, self-contained plan for bringing Cardstock into the
arcade launcher fleet (`paulgibeault.github.io`), written to be executed
end-to-end by a later implementation session without needing this
conversation's context.

**Authorities, in order of precedence:**

1. The launcher repo's `GAME_INTEGRATION.md` (SDK major v3) and
   `ARCADE_PLATFORM.md` — the contract. Where anything below disagrees
   with them, they win.
2. `ARCADE_COMPLIANCE.md` (this repo) — the evaluation that produced this
   plan: scorecard, findings A–G with file:line references, and Appendix A
   listing stale statements in our own design doc. Read it first; this
   plan cites its findings by label (A1, B2, C1…) rather than restating
   them.
3. `CARD_PLATFORM_DESIGN.md` §17 (this repo) — the design-side integration
   contract, correct except where `ARCADE_COMPLIANCE.md` Appendix A says
   otherwise.

**Working rules for the implementer:**

- Launcher repo is checked out as a sibling: `../paulgibeault.github.io`.
- Vendored files (`tools/verify-artifact.mjs`, `tools/inject-precache.mjs`,
  `src/engine/arcade-rng.js`, `sw.js` template) are copied
  **byte-identical** from the launcher repo and never edited locally.
- After any engine-adjacent change, re-run the pack suite:
  `node tools/pack-test.mjs --all` must stay green (38/38 today).
- Framed dev runs through the launcher: `cd ../paulgibeault.github.io &&
  ./dev.sh ../cardstock` (our own `tools/serve.mjs` sends no CORS header
  and cannot serve a framed test — finding G).
- Acceptance: `npm run acceptance -- http://127.0.0.1:4791/cardstock/`
  from the launcher repo.

---

## Resolved decisions

| # | Question (ARCADE_COMPLIANCE.md) | Resolution | Where it lands |
|---|---|---|---|
| 1 | Trademarked packs (`uno`, `phase-10`, `skip-bo` — Mattel marks; catalog listing *is* the public release) | **Rename the packs now.** All five stay playable and published; no stage-time exclusions. | [Phase 0](#phase-0--pack-renames-decision-1) |
| 2 | `theme` support — honor design §17.7 or document an opt-out | **Honor it.** Full `[data-theme]` light/dark support for chrome and the vanilla renderer; the pack-level "theme.css must style both themes" rule stays. | [Phase 3](#phase-3--settings-and-accessibility) |
| 3 | How much storage to build (`Arcade.state` vs `Arcade.store`) | **`Arcade.state` only, with `Arcade.store` stubbed.** A storage adapter exposes the store-shaped surface now; match logs live in `state` until the replay work proves `store`. | [Phase 2](#phase-2--sdk-boot-storage-lifecycle) |
| 4 | List with `"inDevelopment": true`? | **Yes.** Drop the flag when multiplayer (Phase 8) and pack polish land. | [Phase 6](#phase-6--catalog-registration-and-acceptance) |
| 5 | Multiplayer scope | **Primary feature, own phase.** Fully planned here, implemented after the compliance phases pass acceptance. Earlier phases must preserve its seams (see [Phase 8 pre-commitments](#pre-commitments-owed-by-earlier-phases)). | [Phase 8](#phase-8--multiplayer-decision-5) |

---

## Phase 0 — pack renames (Decision 1)

*Independent of everything else; do it first so no other phase ships a
trademarked name. Mechanics are not protectable — names and art are. The
packs contain no third-party art (decks are data files, faces are our own
SVG), so this is a names-and-ids pass only.*

Rename map (defaults — mechanically the steps are name-independent, so a
different name choice changes nothing below):

| Today | New id | New display name | Rationale |
|---|---|---|---|
| `packs/uno` | `wildfire` | **Wildfire** | color-matching shedding with wilds |
| `packs/phase-10` | `milestones` | **Milestones** | ten-stage contract progression |
| `packs/skip-bo` | `stockpile` | **Stockpile** | stock-racing sequencing |

Tasks:

1. `git mv` the three pack directories; update each `manifest.json` `id`
   and `name`. Rules, decks, variants, and tests keep their exact
   mechanics — **zero rule changes** in this phase.
2. Sweep internal ids and labels that carry the old names:
   `packs/uno/manifest.json` has `lastCardCall.id: "uno-call"` → rename to
   `last-card-call` and make its announcement text "Last card!". Variant
   ids/names in all three manifests are already generic — verify, don't
   assume.
3. Repo-wide audit: `grep -rni 'uno\|skip.bo\|phase.10\|mattel' --exclude-dir=.git .`
   - Update: `README.md` pack list and the trademark paragraph (replace it
     with a note that the packs implement classic mechanics under original
     names), `tools/simulate.mjs` comments, any test fixtures referencing
     the old pack ids, `IMPLEMENTATION_NOTES.md`.
   - Leave alone: nominative comparisons in `CARD_PLATFORM_DESIGN.md`
     ("a Phase-10-style contract pack") — describing compatibility with a
     named game is lawful and useful; design docs also get excluded from
     the published artifact in Phase 1 regardless.
4. `?pack=` deep links: the default stays `crazy-eights`
   (`src/main.js:14`); old ids simply 404 into the boot-failure path,
   which is acceptable pre-listing (nothing public links to them yet).

**DoD:** `node tools/pack-test.mjs --all` green with the new ids; the
grep in step 3 returns only design-doc nominative mentions.

---

## Phase 1 — repo and CI foundation

*No gameplay change. Findings A2, A3, G. Runs in parallel with Phase 0.*

1. Fix identity remnants (A3): `git remote set-url origin
   https://github.com/paulgibeault/cardstock.git`; fix the two `card-game`
   URLs in `README.md`.
2. `package.json`: `"engines": { "node": ">=24" }`; add
   `"test": "node tools/verify-artifact.mjs && node --test 'tests/*.test.js'"`.
3. Create `tests/`:
   - `tests/packs.test.js` — wraps `runPackTests` for all five packs as
     `node:test` cases (import from `tools/pack-test.mjs`, which stays the
     CLI entry point; do not duplicate the runner).
   - `tests/repo-gates.test.js` — copy the pattern from
     `../cozy-solitaire`: every tracked JS/JSON parses.
4. Copy **byte-identical** from the launcher repo:
   `tools/verify-artifact.mjs`, `tools/inject-precache.mjs`.
5. Write `tools/stage.mjs` (the only per-app staging code): export `ROOT`,
   `stage(outDir)`, `PRECACHE_EXCLUDE`. Start from `cozy-solitaire`'s.
   Exclusions: `packs/*/tests/`, `schema/`, the root `*.md` design docs,
   `.nojekyll`. (Per Decision 1 there is **no pack exclusion** — all five
   ship.) The fleet's default `isDevOnly` only excludes top-level dirs, so
   these need explicit handling; `verify-artifact.mjs` fails on any
   published file neither cached nor listed. Call `injectPrecache` last.
6. Add `.github/workflows/pages.yml` — the thin fleet-CI caller from
   GAME_INTEGRATION.md §13a, with `version_bump: true` and
   `contents: write` (an `sw.js` exists by Phase 5).
7. Switch the GitHub repo's Pages source to **GitHub Actions** (today it
   is almost certainly branch-based, which lets Jekyll race the pipeline).

**DoD:** `npm test` green locally; a push to `main` deploys via Actions;
the site still serves at `https://paulgibeault.github.io/cardstock/`.

---

## Phase 2 — SDK boot, storage, lifecycle

*The bulk of the acceptance checklist. Findings B1–B4, D.*

1. **Boot** (B1): in `index.html` `<head>`, before the module script:
   ```html
   <script src="/arcade-sdk.js"></script>
   <script>Arcade.init({ gameId: 'cardstock' });</script>
   ```
   Use the **evergreen** alias, not `/sdk/v3/…` — §2 of
   GAME_INTEGRATION.md mandates it and all nine fleet apps use it (the
   starter-app template comment saying otherwise is wrong; see
   ARCADE_COMPLIANCE.md Appendix A).
   Restructure `boot()` (`src/main.js:213`) around `await Arcade.ready`
   before any state read. Standalone stays first-class — never gate solo
   play on `Arcade.context.framed`.
2. **RNG swap** (D): vendor `src/engine/arcade-rng.js` byte-identical from
   the launcher's `/arcade-rng.js`; rewrite `src/engine/rng.js` as a thin
   adapter over `makeRng` preserving the `{ next, int, shuffle }` shape so
   no engine call site changes. Add the §7c known-answer vectors to
   `tests/` (`makeRng(42)` → `0.6011037519201636, 0.44829055899754167,
   0.8524657934904099`). Do this **before** any seed is persisted — the
   old hand-rolled stream differs and would be a save-compat break.
3. **Storage adapter** (B2 + Decision 3): new module
   `src/arcade/storage.js`, the only file that touches `Arcade.state` /
   (later) `Arcade.store`. All keys under `arcade.v1.cardstock.*`:
   - `lastPack` — source of truth for the pack; `?pack=` stays as an
     override only (launcher deep links are `#app=cardstock` and can't
     carry the query).
   - `settings` — via `Arcade.state.getOrInit('settings', DEFAULTS)`.
   - `activeMatch` — `{ formatVersion, packId, variants, seed, log,
     savedAt }`, written after each applied move. The engine is already
     event-sourced (`state.log`, `src/engine/movePipeline.js:21`), so
     **persist seed + log and re-hydrate by replaying the reducer** —
     deterministic RNG makes stored RNG state unnecessary, and this exact
     shape is what Phase 8 (multiplayer resync) and the future replay
     feature consume. A match log is a few KB; prune on match end.
   - Stats via `Arcade.stats.update('<packId>', …)` for games
     played/won per pack.
   - Player-facing keys marked `{ sync: true }`.
   - Check `Arcade.state.set()`'s return for match-critical writes
     (`false` = quota); register `Arcade.onStorageError` once → toast
     "storage full".
   - **`Arcade.store` stubs**: the adapter also exports the
     replay-oriented surface (`openMatchArchive()`, `saveReplay(log)`,
     `listReplays()`) with implementations that throw
     `new Error('cardstock: Arcade.store not yet adopted — see ARCADE_ENHANCEMENTS.md Decision 3')`.
     Call sites for these do not exist yet; the stubs pin the seam and the
     key names (`arcade.v1.cardstock.store.matches` / `.replays`) so the
     replay work later swaps implementations without touching callers.
     Note GAME_INTEGRATION.md's warning stands: no catalog app exercises
     `Arcade.store` yet — first consumer budgets extra verification.
4. Seed hygiene: `startGame` currently seeds with `Date.now()`
   (`src/main.js:202`) — fine as an entropy source, but the seed must be
   persisted in `activeMatch` from the first write.
5. **`Arcade.onStateReplaced`** (B4): treat as a fresh boot — discard
   `liveState`, re-hydrate from storage, re-render. Never assume the
   current screen survived the import.
6. **Lifecycle** (B3): `Arcade.onSuspend` → flush the pending
   `activeMatch` write **synchronously** (§6b: the launcher holds
   teardown ~250 ms for a sync flush only). `Arcade.onResume` →
   re-render. Replace the bot-turn `setTimeout` (`src/main.js:188`) with
   `Arcade.session.setTimeout` (freezes while suspended, self-cancels on
   save import; keep the existing `epoch` guard for "Play again").
   Session timers are correct for **solo only** — Phase 8 replaces them
   with host-wall-clock timeout events for multiplayer.
7. **UI bridge**: `Arcade.ui.setTitle(...)` instead of `document.title`
   (`src/main.js:215`); `Arcade.ui.toast` for the boot-failure path
   (`src/main.js:223`).

**DoD:** `arcade.v1.cardstock.*` keys visible in DevTools; launcher
Save→Load round-trips; *Open Games* = 1; launch another game and return →
the match resumes from the replayed log; pack suite still green.

---

## Phase 3 — settings and accessibility

*Findings E. Theme is full support per Decision 2.*

1. **Theme** (Decision 2 — honor design §17.7):
   - Extract every color in `src/ui/table.css` into custom properties on
     `:root` (felt, card face/back, chrome text, buttons, overlay scrim,
     seat chips).
   - Dark palette = today's green-felt look, defined under
     `[data-theme="dark"]` **and** as the `:root` default (standalone
     boots with no `data-theme`; continuity wins).
   - Add a `[data-theme="light"]` palette: lighter baize + light chrome;
     verify WCAG AA contrast for text and the card-highlight states. Card
     *faces* stay white-on-both-themes (they are physical objects, not
     chrome) — only their surroundings change.
   - The pack rule from design §17.7 stays: a pack's `theme.css` must
     style both themes (pack checklist item, enforced when per-pack
     theming ships).
2. **reducedMotion**: gate the JS deal stagger (`src/main.js:85,112`) on
   `Arcade.settings.reducedMotion()`. The CSS side is free via the SDK
   kill-switch (no `data-arcade-keep-motion` opt-out). Keep the
   OS-preference `@media` block (`src/ui/table.css:145`) for standalone.
3. `Arcade.onSettingsChange(...)` → re-render.
4. **handedness**: `[data-handedness="left"]` rules flipping the hand fan
   anchor and the Draw/action button side (design §17.7's chosen anchors).
5. **fontScale**: chrome is already `rem`. Document deliberately (in
   README) that card-face `px` sizes at `src/ui/table.css:171-174` are
   inside an SVG `viewBox` and scale with layout, not font size — §5
   wants that stated, and it is the correct behavior per design §17.7.

**DoD:** launcher theme toggle restyles the table live with no reload;
font-scale changes resize chrome text; handedness flips the action side;
reduced motion deals cards instantly.

---

## Phase 4 — security hardening

*Findings C1–C4. Prerequisite for Phase 8 — every one of these holes
widens once frames and names arrive from peers.*

1. Escape `cardAriaLabel` output before it enters the `aria-label`
   attribute (`src/ui/renderCard.js:33` when this was written; the card art
   pass replaced that file with `src/ui/cardStyles/`, so the escape now
   belongs in every style that opens an `<svg>`) — reuse the local
   `escapeXml`.
2. Validate the pack id against `/^[\w-]+$/` before it enters the fetch
   path (`src/main.js:14,51`).
3. Convert the opponent-row `innerHTML` (`src/main.js:88`) to
   `textContent` / `Arcade.html.escape` — this is the fleet's
   shipped-twice peer-name XSS shape, one rename away from live.
4. Validate the choice colour before `btn.style.background`
   (`src/main.js:146`).
5. Add a test asserting a card id of `"><img src=x onerror=alert(1)>`
   renders inertly — a named acceptance item.

**DoD:** the §13 XSS-inertness check passes.

---

## Phase 5 — PWA

*Finding F. Makes solo play fully offline; pack assets under
`/cardstock/packs/**` are exactly the cacheable case.*

1. `manifest.json`: `"scope": "/cardstock/"`, `"start_url":
   "./index.html?v=0.0.0"` (CI rewrites the version).
2. `sw.js` at the **repo root**, from the launcher's
   `tools/templates/game-sw.js`: keep `const APP_VERSION = '0.0.0';`
   exactly as written (CI-owned line), `CACHE_PREFIX = 'cardstock-'`,
   generated precache markers, per-asset `add()`, `ignoreSearch`, fetch
   guard on `/cardstock/`, cleanup filtered to the owned prefix (**never**
   origin-wide — the moon-lit incident), and the `arcade:sw.skipWaiting`
   handler (omit it and the worker waits forever).
3. Register loopback-guarded, fire-and-forget with a `.catch`.
4. Add `icon.png` (≥ 512×512, square) at repo root; confirm it survives
   staging into `dist/`.

**DoD:** `verify-artifact.mjs` green; standalone works offline after one
visit; no `[Arcade SDK]` cache warning in the console.

---

## Phase 6 — catalog registration and acceptance

*Finding A1. The public release moment — Phase 0 must already be merged.*

1. Add the `cardstock` entry to the launcher repo's `catalog.json`:
   `id: "cardstock"`, `name`, `subtitle: "Card games"` (10 chars, ≤ 20
   guidance), `icon: "/cardstock/icon.png"`, `url: "/cardstock/"`,
   **`"inDevelopment": true`** (Decision 4), plus a `profile` block for
   the portfolio page. Drop the flag when Phase 8 and pack polish land.
2. Run the full checklist:
   ```bash
   cd ../paulgibeault.github.io && ./dev.sh ../cardstock
   ```
   then:
   ```bash
   npm run acceptance -- http://127.0.0.1:4791/cardstock/
   ```
3. Set `launcher: true` in `pages.yml` so acceptance runs in CI on every
   push.
4. Documentation pass: update `README.md` and `IMPLEMENTATION_NOTES.md`
   for the integration; apply ARCADE_COMPLIANCE.md **Appendix A**'s four
   corrections to `CARD_PLATFORM_DESIGN.md` §17 (sandbox flags,
   catalog-registration mechanics, E0–E3 now shipped, PWA posture).

**DoD:** all 14 §13 acceptance items pass; the game appears in the
launcher grid with the *In Development* ribbon and boots from
`#app=cardstock`.

---

## Phase 7 — audio (optional polish)

Not checklist-required; slot anywhere after Phase 2. Use graph cues, not
spec cues: load `/arcade-audio.js`, build `js/soundpack.js`, register via
`ArcadeAudioElements.registerPack`, audition offline with the launcher's
`tools/soundpack/`. The element library's `flex` element (SDK 3.10.0,
*"a thin springy sheet bent and released: paper, cardstock, a flag"*) is a
near-literal match for card handling. Connect custom nodes to
`Arcade.audio.bus()`, never `ctx.destination`.

---

## Phase 8 — multiplayer (Decision 5)

**Multiplayer is a primary feature of Cardstock.** It is deliberately its
own phase, implemented after Phases 0–6 pass acceptance — but it is
planned now, and earlier phases carry obligations toward it (below). The
full protocol design is `CARD_PLATFORM_DESIGN.md` §8 (frames, per-seat
views) and §17.4–§17.5 (mapping onto the real transport); this section is
the work breakdown plus the deltas that postdate the design doc.

### Pre-commitments owed by earlier phases

These are why Phase 8 can be "later" without becoming "expensive":

- **Phase 2** persists `activeMatch` as **seed + event log** and
  re-hydrates by reducer replay — the shape the multiplayer *host* rebuilds
  its table from after a reload. Do not regress this to a bare state
  snapshot. It is not the wire payload, though: seed + log is full
  information and stays host-side, and a `snapshot` frame carries the
  addressed seat's view (MULTIPLAYER_PLAN.md §6).
- **Phase 2**'s vendored `arcade-rng` guarantees every device replays the
  same stream from the same seed — which is what makes the host's own
  rehydrate and every saved match reproducible.
- **Phase 4**'s escaping/validation is the peer-input hardening; Phase 8
  adds frame-shape validation on top, not instead.
- Seat identity is `(deviceId, localIndex)` from day one (design §17.4) —
  hotseat and remote mix at one table; the solo seat model must not bake
  in "seat index == player".
- Bot turns run through the normal move pipeline (already true), so
  host-side bot-fill is a scheduling change, not an engine change.

### 8.1 Boot gate and party context

- Multiplayer UI renders only when `Arcade.peer.status() !==
  'unavailable'`; never cache the status at init (a table mounted
  mid-session gets `'connected'` in its welcome).
- **Caps gate**: require `peer.sendTo` and `peer.roster` in
  `Arcade.peer.caps()`; use `peer.meta` for the spoof check (8.5). On an
  older launcher the Multiplayer panel shows a single "launcher update
  required" notice — there is **no fallback protocol** in the game, by
  design.
- ~~**New since the design doc — `peer.party`**~~ — **retired 2026-08, and
  it was never required.** The ask was to read `Arcade.peer.party()` for a
  lobby label ("Playing with {leaderName}'s party") and to treat the roster
  as party-scoped. The launcher has since deleted the party as a concept: a
  device holds durable **connections**, and a game is *open* on some of
  them. `party()` answers null forever, so both reads are gone
  (`src/match/peerPort.js`, `src/ui/party.js`) and the panel names the table
  it is showing instead. Nothing else moved — `peers()` is still the set of
  devices this game is live with, every entry direct and possibly several,
  and the three caps we gate on never included this one.
- **New 2026-08 — `peer.invite`, asked for and not required.**
  `Arcade.peer.invite()` asks the launcher to offer this game to the
  connections it holds; it is what the party's replacement needs, because a
  connection is no longer permission to play and something has to propose.
  Feature-detected like every other cap (`peerAvailability().canInvite`) and
  deliberately outside the gate: a launcher without it carries every frame we
  send, and had no scope to open in the first place. Without it the door says
  a sentence — the no-fallback rule above, applied to a cap we can live
  without. See MULTIPLAYER_PLAN §4.

### 8.2 Lobby and seats

- Lobby rides `Arcade.peer.onReady` — fires when the remote has *this
  game* mounted and listening, and re-fires on reconnect (idempotent by
  contract). The host re-broadcasts the `lobby` frame on every firing. No
  hand-rolled hello/echo.
- `lobby` carries: protocol version, pack id + pack version, active
  variant set, seat roster. Version mismatch (a stale cached deploy) →
  that client is prompted to reload, never allowed to desync mid-hand.
- The host never self-declares: joiners identify the host as the roster
  entry with `direct: true`.
- Seats claimed via `claim-seat`; re-bind after a drop is by `deviceId`
  (stable across sessions and reconnects).
- Display names via `Arcade.player.name()`, always through
  `Arcade.html.escape` at render.

### 8.3 Frames and routing

Transport facts (verified in launcher source): per-link channel is
ordered + reliable; payloads JSON-serializable, small and frequent;
sends during `'interrupted'` queue and replay **exactly-once** (cap
1000, visible via `Arcade.peer.queue()` / `onQueue`).

| Frame | Direction | Delivery |
|---|---|---|
| `lobby` | host → all | broadcast |
| `claim-seat` | client → host | broadcast (host-addressed by convention) |
| `propose` | client → host | broadcast (host-addressed) |
| `event` | host → each seat | **targeted** `send(view, { to })` for private views; broadcast for shared views |
| `reject` | host → proposer | **targeted** |
| `snapshot-req` | client → host | targeted |
| `snapshot` | host → client | **targeted** (that seat's full view + log seq) |
| `emote` | any → all | broadcast (fixed emoji set — no free text) |
| `bye` | any → all | broadcast |

- Clients speak only to the host; the host targets each seat's private
  view (a dealt hand) and broadcasts the rest. Targeted frames are
  routing-private: non-addressee **joiners never receive them**; they
  remain host-visible, which is correct for a host-authoritative game.
  End-to-end sealing against the host stays a deferred v1.5 item
  (design §14).
- `Arcade.peer.send` returns `false` when the target is unknown or the
  cap is missing — treat any `false` on a private frame as an error path
  (surface it), never silently fall back to broadcast.
- Snapshots are a few KB of JSON — normal sends. Shared **replay files**
  between friends use `Arcade.peer.sendBlob` / `onBlob` (broadcast only),
  and imported replays are untrusted input: schema-validate before load.

### 8.4 Per-seat presence and recovery

Per-seat status comes from `Arcade.peer.peers()` / `onPeersChange` (full
roster on any change); the aggregate `onStatus` only shows/hides the
multiplayer UI as a whole.

| Seat status | Table behavior |
|---|---|
| `connected` | Normal play; safe to send immediately on the transition. |
| `interrupted` | **Keep playing.** Quiet "reconnecting…" chip on that seat; sends queue with exactly-once replay; do NOT reset state, free the seat, or bot-fill (auto-reconnect means even a total loss can surface as a long `interrupted`). |
| `idle` (after grace) | Genuinely gone: host offers bot-fill / pause / end match. Seat re-binds by `deviceId` on return. |
| `unavailable` | Standalone — multiplayer UI hidden entirely. |

- On recovery, check `Arcade.peer.queue().overflowed`: `true` means the
  replay queue dropped oldest frames — do not trust replay; the client
  sends `snapshot-req`, the host answers with that seat's view + log seq.
  Nearly unreachable at card-game rates; the handler is cheap and
  mandatory.
- Eviction/rejoin: a relaunched client comes back through `onReady` →
  `snapshot-req`. No in-memory state is assumed to survive, ever.
- Turn timers are **host-wall-clock authoritative** — timeouts enter the
  log as events; clients only render countdowns. `Arcade.session` timers
  (which freeze on suspend) remain solo-only.
- `Arcade.onStateReplaced` while seated at a live table: send `bye` (bot
  fills per the `idle` row), then re-hydrate as a fresh boot.
- Suspended-but-mounted (user peeking at another game): keep applying
  incoming peer events to the log, skip all rendering; check
  `Arcade.context.suspended`, not `document.visibilityState`.

### 8.5 Security (on top of Phase 4)

- Shape-validate every inbound frame before use; remote `propose` frames
  go through the full move validator regardless of source — the host
  never trusts a client's claim of legality.
- **Spoof check (needs cap `peer.meta`)**: authority frames must arrive
  on the direct link — a client rejects any host-role frame whose
  `onMessage` meta says `relayed: true`; a relayed "host" frame is a
  spoof by definition.
- Validate wire-arriving ids (deviceIds, zone/card ids) against
  `/^[\w-]+$/` before they touch selectors or attributes.

### 8.6 Tests

- **Two-headless-launcher smoke** (design §17.10 DoD): in the style of
  the launcher's `tools/p2p-acceptance.mjs` — real `RTCPeerConnection`,
  two staged launchers, a scripted Crazy Eights hand end-to-end.
- **Three-launcher privacy scenario** (host + 2 joiners — this is v1 of
  this document's test plan, now run at the game layer):
  1. Host deals: each joiner receives its own hand frame; asserts it
     never receives the other's.
  2. Joiner-to-host `propose` is not seen by the other joiner.
  3. `send(…, { to: unknownDeviceId })` surfaces the error path.
  4. Kill one joiner's network mid-hand: seat shows `interrupted`, the
     table keeps playing, queued frames arrive exactly-once on recovery.
  5. Force `overflowed` (or stub it) and assert the `snapshot-req` →
     `snapshot` resync restores an identical view + log seq.
- Engine-level: a "remote proposer" unit test feeding illegal `propose`
  frames through the pipeline asserts rejection without state change.

**DoD:** Crazy Eights plays host + 2 joiners end-to-end with private
hands provably private; a mid-hand disconnect recovers without desync;
the caps gate shows the update notice on a caps-stripped harness; drop
`"inDevelopment"` from the catalog entry when this lands (with Decision 4
review).

---

## Sequencing

```
Phase 0 (renames)  ─┐
Phase 1 (repo/CI)  ─┴─→ Phase 2 (SDK/storage/lifecycle) ─→ Phase 3 (settings/theme)
                                                        ─→ Phase 4 (security)
                        Phase 5 (PWA, after 2) ─→ Phase 6 (catalog + acceptance)
                        Phase 7 (audio) — anywhere after 2
                        Phase 8 (multiplayer) — after 6, gated on Phase 4
```

Phases 0 and 1 are independent and can run in parallel; Phase 6 is the
public-release moment and requires Phase 0 merged; Phase 8 starts only
after the §13 acceptance checklist is green.

---

## Appendix A — where the details live

| Topic | Source |
|---|---|
| Scorecard + findings A–G (file:line) | `ARCADE_COMPLIANCE.md` |
| Stale statements in our design doc | `ARCADE_COMPLIANCE.md` Appendix A |
| Full multiplayer protocol (frames, per-seat views) | `CARD_PLATFORM_DESIGN.md` §8, §17.4–§17.5 |
| SDK surface (peer, state, store, ui, session) | launcher `GAME_INTEGRATION.md` |
| Acceptance checklist (§13) + fleet CI (§13a) | launcher `GAME_INTEGRATION.md` |

## Appendix B — E-label glossary

v1 of this document specified these as platform asks; all shipped in the
launcher SDK (protocol v2, no version bump — feature-detected via caps).
Other docs still reference the labels:

| Label | Was | Shipped as |
|---|---|---|
| E0 | capability flags | `Arcade.peer.caps()` / `welcome.caps` |
| E1 | targeted sends | `Arcade.peer.send(payload, { to })`, cap `peer.sendTo` |
| E2 | roster + per-peer status | `Arcade.peer.peers()` / `onPeersChange`, cap `peer.roster` |
| E3 | message metadata | `onMessage(payload, fromPeer, meta)` with `{ relayed, to }`, cap `peer.meta` |
| — | (postdates v1) | parties: `Arcade.peer.party()` / `parties()` / `attach()`, cap `peer.party` — **since retired by the launcher and unread here** (§8.1) |
