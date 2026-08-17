# Cardstock Multiplayer — Design & Work Plan

**Status: design, approved for implementation.** This document is the full design for
Phase 8 (multiplayer) and supersedes the protocol sketches in
`CARD_PLATFORM_DESIGN.md` §8 and §17.4–17.5 where they differ (the differences are
listed in §13). Work is organized into GitHub work packages (§12); each issue links
back to the sections it implements.

The framework side is already in place: every `Arcade.peer` enhancement this repo
asked for in `ARCADE_ENHANCEMENTS.md` (E0 caps, E1 targeted sends, E2 roster,
E3 metadata) has shipped in the launcher SDK, plus parties. No launcher change is a
prerequisite for anything in this plan. Two optional launcher work packages exist
(`peer.presence`, `arcade-table`) that simplify — but do not gate — this work.

---

## 1. Scope and non-goals

**In scope (v1):**
- Host-authoritative remote play for all five launch packs, 2+ devices, one party.
- Private hands that are *provably* private on the wire.
- Seat model `(deviceId, localIndex)` — remote seats, bot seats, and (later) hotseat
  share one identity scheme.
- Mid-hand disconnect recovery with no desync: `interrupted` rides the transport's
  exactly-once replay; terminal drops rebind by `deviceId` and resync by snapshot.
- Host-side bot-fill for abandoned seats.
- Host-persisted match state, so a match survives a host reload/restart if the same
  party reconvenes.

**Non-goals (v1):**
- Host migration. If the host is gone terminally, the match pauses; the launcher's
  rendezvous already revives the same host across a full browser restart (6 h window).
- Undo (`CARD_PLATFORM_DESIGN.md` §8's manifest-gated design stays parked; the
  replay-cache guard it needs is already in and tested).
- Hotseat UI (the seat model supports it; the pass-the-device flow is post-v1).
- End-to-end sealing of joiner↔joiner frames and commit-reveal dealing. The host can
  read everything by design — it deals. Accepted for friendly tables, documented.
- Real-time/speed games, bidding templates, wagering (permanently out per
  `CARD_PLATFORM_DESIGN.md` §10).

---

## 2. Architecture

```
HOST DEVICE                                    CLIENT DEVICE (each joiner)
┌────────────────────────────┐                 ┌────────────────────────────┐
│ full engine (state.js,     │                 │ NO engine state            │
│ movePipeline, templates)   │                 │                            │
│  seed • zones • rng • log  │   view frames   │ ViewState (per-seat,       │
│                            │ ──targeted────► │  serializable, §6)         │
│ per-seat view serializer   │                 │ interaction.js + renderer  │
│ botDriver (host-side)      │ ◄──propose───── │ builds moves from the      │
│ seat table + wall clock    │                 │  host-shipped legal list   │
└────────────────────────────┘                 └────────────────────────────┘
```

Three load-bearing decisions, chosen for simplicity and robustness:

**D1 — Clients do not run the reducer.** The engine's determinism story
(seed + log replayed through the full validator) is a *full-information* story: the
seed reconstructs the shuffle, and `rehydrateMatch` cannot run without it. Rather than
invent a partial-information reducer, clients hold a `ViewState` — a plain
serializable object containing exactly what that seat may see. The client still runs
the full cardstock *code* (templates ship with the app); it lacks only *state*.

**D2 — View replacement, not event folding.** After every accepted move, the host
sends each seat its **complete fresh view** (a few KB — trivial for a data channel),
plus the filtered derived events for animation only. The client's authoritative state
is always the last view frame received; derived events are cosmetic. This kills the
entire class of incremental-desync bugs, makes gap recovery free (a snapshot *is* the
next view frame), and means an animation bug can never corrupt a table. If profiling
ever shows view frames are too heavy, delta encoding is a pure optimization behind the
same contract.

**D3 — The host ships each seat its legal moves.** Move legality for your own seat
depends only on your hand plus public state, but running `enumerateLegalMoves` over a
placeholder-filled partial state is a soundness trap (and `legalMovesFor`'s
memoization is documented-unsound off the `applyMove` path). Legal-move lists are
small, `src/ui/interaction.js` already consumes exactly that shape, and shipping them
keeps rules evaluation in one place. Enumeration remains "the prompt"; the host's
`validateMove` remains "the rule" — a remote propose is validated, never checked for
membership in the enumerated list.

---

## 3. The transport contract we build on

What `Arcade.peer` guarantees (and what we must therefore never rebuild):

- **Ordered, reliable, exactly-once delivery per link**, including across
  `interrupted` gaps — sends queue (cap 1000) and replay in order. The move log needs
  no dedup or reordering logic. The only resync path we owe is the overflow case (§8).
- **Targeted sends** `send(payload, {to})` are routing-private: non-addressees never
  receive the frame. There is no other kind of send between two joiners — the
  transport carries a frame along a direct link and never forwards it to another.
- **Authenticated attribution**: `fromDeviceId` on `onMessage` is bound by the
  launcher's identity handshake and cannot be spoofed by payload content. Authority
  checks key on it, never on payload fields.
- **`meta.relayed`** marks frames that arrived via the hub bridge rather than the
  direct link — the spoof check for host-role frames (§9). The launcher has removed
  transport relay outright, so on a current build it is always `false`; the flag
  stays in the SDK contract, the check stays as defence in depth, and `peer.meta`
  stays one of the three caps we require.
- **Open games, not parties.** A device holds durable **connections**; a game is
  *open* on some of them, by mutual consent, for as long as the link and the game
  last. `peers()`/`onPeersChange` are the devices with cardstock open — **every
  entry direct, and there may be more than one**. That is the shape this repo was
  already built for: a party could contain two hosts long before the launcher
  changed, which is why `discoverHost` (`src/match/client.js`) takes the table's
  host from the *caller* rather than assuming a single direct peer, and why the
  sighting rule (`src/ui/tableSightings.js`) is "direct sender, not relayed"
  rather than "the one direct sender". Neither needs a line changed.
  Fellow joiners are **not reachable — and nothing here ever needed them to be.**
  Seat presence rides *our* lobby frames (§4); protocol v3 (§5) moved the last two
  frames that did not — `emote` and a joiner's `bye` — onto the same road.
- **`onReady`** fires when the remote device has *this game* mounted, re-fires on
  reconnect, idempotent by contract. The lobby rebroadcast hangs off it — no
  hand-rolled hello/echo.

**Caps gate (unchanged from `ARCADE_ENHANCEMENTS.md` §8.1):** multiplayer UI renders
only when `Arcade.peer.status() !== 'unavailable'`, never cached at init. Require
`peer.sendTo` + `peer.roster`; use `peer.meta` for the spoof check. Older launcher →
one "launcher update required" notice; no fallback protocol.

---

## 4. Identity, seats, and lobby

**Seat identity is `(deviceId, localIndex)`.** `localIndex` is 0 for every remote
seat in v1 and exists so hotseat needs no schema change. Bots occupy seats with
`deviceId: null` and the existing `bot:<id>` roster identity. Head-to-head records
already reserve `peer:<deviceId>` keys (`src/arcade/storage.js`,
`OPPONENT_KEY_RE`).

**The host is discovered, never self-declared:** joiners identify the host as the
roster entry with `direct: true`.

**Lobby flow:**
1. Host opens a pack's table in "host" mode. There is nothing to attach to: the
   game is already open on whichever connections consented to it, and `peers()`
   is that set. (v1 read `Arcade.peer.party()` here to label the screen; the
   launcher has no parties, so the label went with them — §10.)
2. Host broadcasts `lobby` on every `onReady` firing and on every seat change.
3. Joiners render the seat grid and send `claim-seat`. The host arbitrates
   (first-come), rebinding a returning `deviceId` to its previous seat automatically.
4. Host fills remaining seats with bots (or waits), then deals — the `start` is just
   the first view frames going out.

**The `lobby` frame carries the compatibility contract:** protocol version, pack id +
pack version, active variant set, seat roster (with per-seat presence), host device
id. Any mismatch → that client is prompted to reload (the evergreen service worker
converges versions); a mismatched client is never allowed to play. `deck.json` entry
order is part of the rule set (it becomes the shuffled array), which is why
`packVersion` is in the handshake, same as the save-compat rule in
`src/engine/replay.js`.

Names come from `Arcade.player.name()` and pass through `Arcade.html.escape`
(Phase 4's rule; peer names are the fleet's shipped-twice XSS shape).

---

## 5. Wire protocol

All frames ride `Arcade.peer.send`. Clients speak only to the host — since
protocol v3 that is literally true, not nearly true. Every inbound frame is
shape-validated before use (§9). Frame kinds:

| Frame | Direction | Delivery | Contents |
|---|---|---|---|
| `lobby` | host → all | broadcast | protocol v, packId, packVersion, variants, seats[], hostDeviceId, graceMs? |
| `claim-seat` | client → host | **targeted** | requested seat, localIndex |
| `propose` | client → host | **targeted** | `pid` (client-local id), move object |
| `view` | host → each seat | **targeted** | seq, ViewState, events[], yourMoves?, turn, deadlines |
| `reject` | host → proposer | **targeted** | pid, reason (from `validateMove`) |
| `snapshot-req` | client → host | **targeted** | last seq seen |
| `snapshot` | host → client | **targeted** | identical payload to `view` (D2 makes them the same thing) |
| `emote` | client → host, then host → every other link | **targeted** both ways | index into a fixed emoji set — no free text; the host's re-announcement adds the emoter's `seat` |
| `bye` | client → host; host → all (`closed`) or one (`replaced`) | **targeted** / broadcast | reason (leave / replaced / closed) |

**Protocol v3: announcements are host-mediated.** `emote` and a joiner's `bye`
were the last two frames a client said to the *room* rather than to its host,
and they reached fellow joiners only because the hub forwarded between spokes.
The launcher has deleted transport relay, so both are targeted at the host, which
re-announces the emote itself and lets the departure travel in the `lobby` frame
it already re-broadcasts on every seat change. This makes the authority model
*more* consistent, not less: everything a fellow joiner knows now comes from the
host, as views and rosters already did. Two consequences worth stating:

- The host stamps the emoter's **seat**, resolved from the authenticated
  `fromDeviceId` and never from the frame — after mediation the *sender* of every
  emote a client receives is the host, so `fromDeviceId` alone would credit the
  host with all of them.
- `emote` and `bye` join `HOST_FRAMES`, so a client holds them to the same
  authenticity test as a `view` (§9.3). Before v3 an emote was the one frame a
  client accepted from a fellow joiner, which meant anybody in the party could
  burst an emoji on somebody else's screen.

Nothing negotiates: a mismatched build gets the existing reload prompt and the
service worker converges everyone, the same call `TABLES_PLAN.md` §4 made for v2.
No compatibility shims. `src/match/protocol.js` carries the version log.

Rules:
- **`send()` returning `false` on a targeted frame is an error path** — surface it
  (toast + seat marked unreachable), never silently broadcast a private frame.
- `seq` is the host's log length after the applied move. Clients use it only to
  detect gaps (a gap → `snapshot-req`); they never reorder.
- A `propose` is answered by either a `view` (whose `ViewState` reflects the applied
  move — the accept *is* the new view) or a targeted `reject` carrying the proposer's
  `pid`. No separate ack frame.
- Announcements and challenges ("Last card!", "Catch!") are ordinary logged moves and
  flow as ordinary proposals — the log is the saved match, so nothing may apply
  around the pipeline (`applyAnnouncementUnlogged` remains test-only).
- Hearts' simultaneous passing needs no protocol support: `actingSeats()` already
  returns every uncommitted seat; each seat's `passCards` is an ordinary propose, and
  commits stay hidden because `__pendingPass` lives in host state and is redacted
  from views (§6).
- Shared replay files (post-v1) use `sendBlob`/`onBlob`, which honours `{to}` like an
  ordinary send, and are untrusted input: schema-validate before load. What blob
  transfer cannot do cheaply is fan ONE file to a subset of seats — that is N
  transfers, re-chunked under N ids — so a per-seat payload belongs in a `view`
  frame, not a blob.

---

## 6. Hidden information — the per-seat view layer

This is the new engineering. Today zone `visibility` (`owner|all|none|top`) is
consumed **only by the renderer**; every client holds real card ids for every hand,
and `serializeMatch` contains the seed, which reconstructs the entire shuffle.

**The seed and the full log never leave the host.** Multiplayer saves are host-only
(§8). No frame ever contains the seed, another seat's hand ids, or a facedown pile's
order.

**`viewFor(state, seat) -> ViewState`** — a new serializer in `src/engine/`:
- Zones with `visibility: 'all'` → real card ids, real order.
- `visibility: 'owner'` → real ids for the owner's copy; `{count}` for everyone else.
- `visibility: 'top'` → top card id + `{count}` beneath.
- `visibility: 'none'` (decks) → `{count}` for everyone, host included in the frame
  (the host reads its own engine state, not a view).
- `playerVars`: double-underscore vars (`__pendingPass`, `__lastCardCalled`, …) are
  secret — included only in their owner's view, and only where the template marks
  them viewable at all. Everything else (scores, turn, phase, direction, public vars,
  roundNumber) is public.
- The `ViewState` mirrors the field shapes the renderer and `src/ui/interaction.js`
  actually read, so the table code consumes either an engine state (solo/host) or a
  ViewState (client) through one narrow accessor seam.

**Prerequisite audit (part of WP-C3):** `visibility` today has *rendering*-shaped
semantics (e.g. sequencing's personal discards were deliberately moved `top` → `all`
because playability, not visibility, limits them to the top card). Every zone in all
four templates gets an explicit filtering decision, recorded in a table in
`src/templates/CONTRACT.md`. Likewise every `pendingChoice` Ask must be derivable
from the seat's own view (today's Asks — wild suit, discard target, meld targets —
read only own-hand + public data; the audit pins that with a test).

**Filtered events:** `eventsFor(seat, events)` maps the derived-event window the same
way (a deal event → ids for the addressee, counts for others). Events drive animation
and narration only (D2), so an imperfect filter is cosmetic — but it still must not
*leak* (test: serialize every event frame for seat B across a scripted game; assert
zero card ids from any other hand or facedown pile).

**Legal moves:** the acting seat's `view` frame carries
`enumerateLegalMoves(state, seat)` output verbatim (plus enumerated announcements).
Non-acting seats get none. The host validates every propose with `validateMove`
regardless — the shipped list is UI affordance, not authority.

---

## 7. Timing: one clock, the host's

Session timers freeze with the frame (§6c of the platform contract) — right for solo,
wrong for a shared table. In multiplayer:

- **All deadlines are host wall clock.** Turn timeouts, bot "thinking" delays, and
  challenge windows are computed host-side from `Date.now()` deadlines (checked on
  wake — never accumulated ticks, so host suspend/resume stays correct).
- **A timeout is a logged event**: when a turn expires the host applies the timeout
  consequence through the normal pipeline (e.g. auto-pass or bot takeover move), so
  replay and saves stay honest. Clients receive deadlines in `view` frames and render
  countdowns only — a client clock can never change game state.
- `Arcade.session.setTimeout` remains solo-only. `src/ui/botDriver.js` (already
  extracted for exactly this) gets a scheduler seam: session-clock in solo,
  host-wall-clock in multiplayer. Bot moves flow through the same pipeline either way
  — bot-fill is a scheduling change, not an engine change.

---

## 8. Persistence and recovery

> **Superseded in part (2026-08, issue #43):** the one-live-match rule and the single
> `mpMatch` slot below are superseded by `TABLES_PLAN.md` — multiple concurrent
> tables, slots keyed `mpMatch.<tableId>` plus a small index, and joiner-held seat
> stubs (`mpSeats`). Two further clauses below no longer hold: **"on the host the
> shared table *is* the open table"** (a hosted table outlives the felt and keeps
> playing unwatched — §3 there), and the host's grace is no longer a constant, but
> chosen per table and carried on the `lobby` frame so a joiner counts down against
> the host's rule (§7 there). Deadlines are still never persisted; a resumed table
> arms fresh.
>
> The recovery ladder, the host-only-save rule, and the lifecycle edges in this
> section carry forward unchanged.

**Host-only save.** The host persists `{formatVersion, packId, packVersion, variants,
seed, log, seatBindings, savedAt}` after every applied move — the existing
seed+log discipline plus the seat↔`(deviceId, localIndex)` map — under a new
multiplayer slot (`arcade.v1.cardstock.mpMatch`, distinct from `match.<packId>`
exactly as `LOBBY_PLAN.md` reserved). One live multiplayer match at a time in v1.
"Only the open table advances" stays true on clients; on the host the shared table
*is* the open table.

**Recovery ladder (per seat, from `peers()`/`onPeersChange` status):**
- `connected` → normal play; safe to send immediately on transition.
- `interrupted` → keep playing. Quiet "reconnecting…" chip. Outbound frames queue
  with exactly-once replay. Do **not** reset state, free the seat, or bot-fill.
- terminal (`idle` after grace) → host offers: fill with bot / pause / end match. The
  seat stays bound to its `deviceId`; if that device returns (fresh ceremony or
  rendezvous), `onReady` fires, the client sends `snapshot-req`, and the host
  restores the seat — evicting the stand-in bot at the next turn boundary.
- On any recovery, check `Arcade.peer.queue().overflowed`: if true, replay can't be
  trusted → `snapshot-req` (D2 makes the answer identical to a view frame — cheap and
  mandatory).

**Host restart:** if the host reloads, on boot it finds `mpMatch`, and when the party
reconvenes (rendezvous auto-reconnect or fresh ceremony) it rehydrates from seed+log
and re-broadcasts `lobby` + fresh views. Clients never assume in-memory state
survives anything.

**Client restart:** rejoin is just `onReady` → `claim-seat` (auto-rebound by
deviceId) → snapshot. Nothing client-side is persisted for multiplayer.

**Lifecycle edges:** `Arcade.onStateReplaced` while seated → send `bye`, then
rehydrate as a fresh boot (host: match ends or bots fill; client: seat freed).
Suspended-but-mounted (`Arcade.context.suspended`, never `document.visibilityState`)
→ keep ingesting frames and updating the ViewState, skip all rendering.

---

## 9. Security checklist

On top of Phase 4's hardening (`tests/security.test.js`), all peer input is hostile:

1. Shape-validate every inbound frame before use; unknown frame kinds are dropped
   (with a diagnostic), never dispatched.
2. Every remote `propose` goes through the full `validateMove` pipeline. The host
   never trusts a client's claim of legality, and a rejected propose must leave state
   bit-identical (engine test: illegal frames through the pipeline, assert no
   mutation).
3. Authority check: clients accept `lobby`/`view`/`reject`/`snapshot` — and, from
   protocol v3, `emote` and `bye` — only from the host `deviceId` **and** only when
   `meta.relayed !== true` (a host-role frame via the relay path is a spoof attempt
   — needs cap `peer.meta`). Host-mediating the announcements is what let the last
   two frames join that list; before it, an emote from a fellow joiner was
   legitimate and therefore uncheckable.
4. Attribution: the host keys every propose/claim on the transport's `fromDeviceId`,
   never on payload fields.
5. Wire ids (deviceIds, seat indexes, zone/card ids, pack ids) are validated against
   the existing `/^[\w-]+$/` discipline before touching selectors, attributes, or
   Map keys; card ids are additionally checked against the loaded pack's card table.
6. Bounds: seat index < seat count; `cards` arrays capped at hand-size max; emote is
   an index into the fixed set; propose rate per seat is throttled (a misbehaving
   client can't spin the validator).
7. Privacy invariants are tested, not asserted: the three-launcher suite (§11) proves
   seat B's traffic never contains seat A's hand.

---

## 10. UX flows (summary — full treatment in WP-C5)

- **Lobby:** the panel names the table it is showing — "Your party" for ours,
  "{hostName}'s table" for a neighbour's, and "Playing together" when it is
  showing none. (It used to fall back to a party label read from
  `Arcade.peer.party()`; the launcher has no parties and no leaders, so that
  sentence could no longer be true of anything.) Seat grid with claim/bot toggles
  (host) and claim buttons (joiners), pack + variant summary from the handshake.
- **Presence:** per-seat chips driven by the host's lobby/seat roster (transport
  status where known; the optional `peer.presence` cap upgrades fellow-joiner
  fidelity when present).
- **Interruptions:** quiet chip, table stays live; terminal drop surfaces the host's
  three-way choice; rejoining is silent.
- **Emotes:** fixed emoji set, small burst animation, never logged, rate-limited.
- **Errors:** reload prompt on version mismatch; "launcher update required" on
  missing caps; targeted-send failure surfaces as seat-unreachable.

---

## 11. Testing plan

- **Engine (no network):** view serializer leak tests per template ("seat B's
  serialized view/events contain zero foreign hand or facedown ids", run across
  scripted games); remote-proposer rejection-without-mutation; choice-Asks
  derivable-from-view; visibility-audit table pinned.
- **Protocol (stubbed peer):** the storage-test pattern (`tests/storage.test.js`
  stubs `Arcade.state` with a Map) is copied for `Arcade.peer` — a scriptable stub
  drives lobby/claim/propose/reject/snapshot through the real table code, headless.
- **Acceptance (real transport):** in the style of the launcher's
  `tools/p2p-acceptance.mjs` (real Chromium, real `RTCPeerConnection`, two+ headless
  launchers). The three-launcher privacy scenario is the Definition of Done:
  1. Host + 2 joiners play a scripted Crazy Eights hand end-to-end.
  2. Each joiner receives only its own hand frames; joiner→host proposes are not
     seen by the other joiner.
  3. `send(…, {to: unknownDeviceId})` surfaces the error path.
  4. Kill one joiner's network mid-hand: seat shows `interrupted`, table keeps
     playing, queued frames arrive exactly once on recovery.
  5. Force `overflowed`: assert `snapshot-req` → `snapshot` restores an identical
     view + seq.
  6. Caps-stripped harness shows the "launcher update required" notice.

  > **Grown since (2026-08).** The suite runs nine scenarios, not six: 7 adds
  > hostile peer names and scripted presence transitions, 8 leaving and coming
  > back, and 9 the two-table case `TABLES_PLAN.md` §10 asked for — one device
  > hosting two packs, a joiner seated at both, a move at one table reaching
  > only that table. Items 4 and 5 remain SKIP with a stated reason: cutting a
  > live data channel and forcing `overflowed` need a transport hook neither the
  > SDK nor the launcher harness exposes, and both behaviours are covered
  > headlessly in `tests/protocol.test.js`.
- **Simulation:** `tools/simulate.mjs` gains a mode that runs host + N scripted
  clients over the stub transport for all five packs (bot-vs-bot through the full
  protocol), keeping the completion-rate bars.

---

## 12. Work packages

Cardstock (this repo) — sequenced:

| WP | Title | Depends on | Sections |
|---|---|---|---|
| C1 | Seat identity: retire `HUMAN_SEAT = 0` for `(deviceId, localIndex)` | — | §4 |
| C2 | Host-clock scheduling: timers and bot turns as wall-clock logged events | — | §7 |
| C3 | Per-seat views: visibility audit, `viewFor`/`eventsFor`, shipped legal moves | — | §6 |
| C4 | Protocol: lobby/seats/propose/view/snapshot over `Arcade.peer` | C1–C3 | §3–5, §8, §9 |
| C5 | Multiplayer UX: party lobby, presence, recovery flows, emotes | C4 | §10 |
| C6 | Acceptance: three-launcher privacy + recovery suite; protocol sim mode | C4 | §11 |
| C7 | Doc refresh: stale refs + §8 alignment with this plan | — | §13 |

Launcher (`paulgibeault/paulgibeault.github.io`) — optional, parallel:

| WP | Title | Notes |
|---|---|---|
| L1 | `peer.presence`: hub-relayed party member presence and departure | Upgrades C5 chips; retires p2p-chat's `isLive()` heuristic |
| L2 | `arcade-table`: optional vendored helper for host-authoritative turn games | C4 consumes it if it lands first; C4 does not wait for it |
| L3 | Doc refresh: stale rendezvous-ratchet claims; roster/presence semantics | Findings from the 2026-08-10 review |

C1–C3 are independent of each other and of the launcher WPs; all three land before
C4. If L2 lands before C4 starts, C4 builds on it; otherwise C4 implements the frame
loop locally and migrates when L2 ships (the frame vocabulary is identical by
construction — L2's design was extracted from §5).

---

## 13. Deltas from CARD_PLATFORM_DESIGN.md §8 / §17

Recorded so the older sketch can't mislead an implementer (WP-C7 adds a pointer
banner there):

1. **Clients no longer replay the log.** §8 implied the snapshot payload is the same
   seed+log shape as the save file. It is not: seed+log is full-information and the
   seed must never leave the host. Snapshots and per-move frames are per-seat
   ViewStates (D1/D2).
2. **`event` frames became `view` frames** (view replacement, D2). The frame table in
   §8.3 is superseded by §5 here.
3. **Legal moves ship with the acting seat's view** (D3) — new, not in §8.
4. **Host persistence** moved from "open question" to the `mpMatch` slot design (§8
   of this doc).
5. Everything else in §8 (caps gate, onReady lobby rebroadcast, spoof check,
   send()===false handling, host-wall-clock timers, three-launcher DoD) carries
   forward unchanged.
