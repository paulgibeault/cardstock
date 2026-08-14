# Cardstock Tables — Design & Work Plan

**Status: design, approved for implementation.** This document is the full design for
issue #43 (multiple concurrent tables, and games that last). It supersedes
`MULTIPLAYER_PLAN.md` §8's "one live multiplayer match at a time" rule and the single
`mpMatch` slot; everything else in that plan — the recovery ladder, host-only saves,
the view/propose protocol, the security checklist — carries forward unchanged and is
assumed here. Work is organized into GitHub work packages (§9), sequenced so each is
shippable on its own.

---

## 1. Product decisions

Settled in the #43 discussion; recorded here so no work package has to re-ask:

- **A device may host more than one table, but at most one per pack.** Playing two
  hands of the same game at once is not a thing this product wants to mean.
- **A device may hold seats at several tables, at most one per pack**, and may switch
  between them. Only one felt is visible at a time.
- **Turn timer:** the grace timeout is per-table and host-controlled. When a seat's
  grace runs out, the house plays a move for it — the seat stays bound, and the
  player gets a fresh grace window every turn. Removal from the table remains the
  host's explicit decision, never the timer's.
- **Tables expire.** A table nobody has seen for a week rolls off — host slots and
  joiner seat stubs both.
- **A table whose host is offline says "offline"** on its tile. One word, honest,
  and it does not editorialize about where the host went.
- **There is still no server.** "Long-lasting" means *resumable*, not *available*:
  state survives on the host, and the table comes back when the host does. The
  launcher's rendezvous relays signaling, not game state, deliberately.

---

## 2. Table identity

**A `tableId` is minted when a table is created** — random, `SAFE_ID` charset,
generated at `hostGame` — and carried in every frame (§4). It identifies the table
across time: across host reloads, across dormancy, in persistence slot names, and in
joiner seat stubs.

**`(hostDeviceId, packId)` is the uniqueness constraint for *live* tables**, not the
identity. The distinction matters at exactly one moment: a host ends Tuesday's Hearts
and deals a fresh one. Same pair, different table — and a joiner's persisted seat at
the old table must not silently re-claim into the new one. The pair is the dedup
rule; the minted id is the name.

---

## 3. The session inversion

Today the felt owns the engine state: `createTableHost` is handed
`liveState: () => tableContext()?.state`, so a hosted game exists only while it is
the thing on screen. Every product decision in §1 breaks on that — a background
table must keep running (bots playing, proposals validated, timers ticking) while
the felt shows a different one.

**`TableSession` owns everything one table needs to exist:**

- the engine state (host) or the last ViewState (joiner),
- the seat table (`src/players/seats.js`),
- the turn timer (host) and its per-table grace,
- the `createTableHost` / `createTableClient` instance,
- its persistence slot (§6).

**A registry — `Map<tableId, session>` — holds the live sessions** and enforces the
two §1 invariants at the door: one hosted table per pack, one held seat per pack.
All policy in one place, and it should stay about twenty lines.

**Bots are the part that is easy to miss.** A background hosted table has to keep
*playing* — its bots take their turns whether or not anybody is looking at the
felt — and `scheduleNextTurn` lives in `src/ui/table.js`, bound to the visible
session. `createBotDriver` is already instance-shaped and takes its seams by
injection, so a background session can hold a driver of its own whose `playMove`
is `host.applyLocal` rather than the felt's animation pipeline. The felt keeps
driving the session it is bound to, exactly as it does today; only an *unbound*
hosted table runs headless. That split is what keeps solo play — the
overwhelming majority — on a pipeline this work never touches.

**The felt becomes a renderer.** It binds to whichever session is open and unbinds
without destroying it. `host.js`, `client.js`, `turnTimer.js`, and `seats.js` are
already instance-shaped factories with no module state; the singletons live entirely
in `src/ui/party.js` and `src/ui/table.js`'s module-level `session`. The pieces were
built right; they are wired to a one-table frame.

**One timer rule changes.** `waitsOn` currently exempts the host player's own seat —
right when the host is looking at the table, wrong when the host is playing a
different one, where their unwatched seat would stall the game for everybody. The
rule becomes: the timer waits on any device-held seat whose device is not actively
viewing this table. For the host that means: exempt my seat only at the table my
felt is showing.

---

## 4. Wire: protocol v2

**`tableId` goes on every frame**, not just `lobby` and `claim-seat`. Once a device
can sit at (or host) two tables, all frames from all tables arrive through one
`port.onMessage`, and `hostDeviceId` stops disambiguating the moment one host runs
two tables. `emote` and `bye` need it most — "the host closed the table" has to say
which.

This is a clean `PROTOCOL_VERSION` bump to 2. §5's no-negotiation rule holds: a
mismatched build gets the existing reload prompt and the service worker converges
everyone. No compatibility shims.

**A frame router replaces per-role subscription.** One `onMessage` subscription
validates the envelope, reads `tableId`, and dispatches to the registered session.
A lobby frame whose `tableId` no session claims is a *sighting* and feeds the
directory (§5). The authenticity rules are unchanged: host-role frames only from
the direct link, never relayed; attribution from the transport's `fromDeviceId`.

---

## 5. The table directory

`Map<tableId, {frame, lastSeenAt, hostStatus}>` — every table this device knows
about, whether or not it holds a seat. Fed by sighted lobby frames; pruned when a
host sends `bye 'closed'`, drops off the roster, or ages past the §1 expiry. Pure
data: no DOM, no engine imports. The Tables tile row (§8) renders from it, and it
is the natural first extraction for reuse (§10).

Stage one of #43 — replacing the `invitation` singleton with a map keyed by
`hostDeviceId` — is this directory in embryo, shipped before the wire carries a
`tableId` at all. A device hosts at most one table today, so `hostDeviceId` *is*
the table identity until protocol v2 lands; the directory re-keys by `tableId`
when it does.

---

## 6. Persistence

**Host:** `saveHostMatch` / `loadHostMatch` exist in `src/arcade/storage.js` and are
tested — and nothing calls them yet; the §8 recovery ladder is designed but unwired.
The slot becomes **`mpMatch.<tableId>`** plus a small index of live slots. `savedAt`
is already in the payload; the weekly roll-off is a sweep at boot. Save after every
applied move, clear on match end, rehydrate on boot: seed + log through the full
validator, seat bindings restored via `deserializeSeatTable`, then re-broadcast
`lobby` and fresh views when the party reconvenes.

**Joiner:** a new **`mpSeats`** slot — an array of
`{tableId, hostDeviceId, packId, seat, savedAt, lastSeenAt}` — the first thing a
joiner has ever persisted about multiplayer. `lastSeenAt` refreshes whenever the
host is sighted, so expiry means "a week since anyone saw this table," not "a week
since I sat down." The stub is enough to draw "Your seat at Dana's Hearts —
offline" before Dana is back. Nothing about game state persists on joiners;
`MULTIPLAYER_PLAN.md` §8's "clients never assume in-memory state survives
anything" holds exactly.

---

## 7. Timers and dormancy

- **Deadlines are never persisted.** They are derived state. A host that rehydrates
  arms fresh, so every seat gets a full grace window on resume — which is §1's
  "each turn the user gets the grace timeout" falling out naturally, and it is what
  prevents an overnight clock from timing everybody out on the first frame.
- **The grace duration is per-table host configuration** (replacing the module
  constant `TURN_TIMEOUT_MS`), carried in the `lobby` frame so joiners render
  honest countdowns.
- A dormant table runs no timers at all, because the host — the only clock — is
  not there. Dormancy needs no code; it is what a missing host already is.

---

## 8. UX

- **A "Tables" row above the games** in the lobby, drawn from the directory plus
  the joiner's own seat stubs — no pack loading, so the lobby's cost ceiling
  (manifests only) is untouched. Tile states: *waiting to deal · in progress ·
  your seat · table full · offline*.
- **The party panel takes a table** as an argument and stops being a singleton.
  Tapping a table tile opens the panel for that table.
- The per-game "Play together" door stays: it is how a table gets created, and
  choosing the game is still the first decision.
- Peer-supplied strings keep reaching the DOM through `textContent` only.

---

## 9. Work packages

Sequenced; each shippable alone. T1 fixes the reported annoyance by itself.

| WP | Issue | Title | Depends on | Sections |
|---|---|---|---|---|
| T1 | #45 | Table directory: many tables known, one seat taken | — | §5 |
| T2 | #46 | Tables as tiles; the party panel takes a table | T1 | §8 |
| T3a | #47 | Stub-transport tests for two concurrent sessions | — (lands before T3) | §10 |
| T3·1 | #48 | Protocol v2: `tableId` on every frame, minted per table | T1, T3a | §2, §4 |
| T3·2 | #48 | Session inversion, headless bots and timers, host persistence | T3·1 | §3, §6 |
| T4 | #49 | Long-lasting tables: seat stubs, dormant tiles, resume, grace config, roll-off | T2, T3 | §1, §6–§8 |
| T5 | #50 | Rules injected, not imported: `src/match/` as a game-agnostic kit | T3 | §10 |

---

## 10. Testing and reuse

**The net goes under before the inversion.** `src/ui/table.js`'s session ownership
is the one code path in the repo with no unit coverage, and T3 rewires it. T3a
extends the stub-transport protocol tests (the `tests/storage.test.js` pattern
applied to `Arcade.peer`) to drive **two concurrent sessions headlessly** — two
hosts on one device, a device seated at two tables, frames interleaved — before T3
lands. The three-launcher acceptance suite gains a two-table scenario after T3.

**Reuse is the point of the shape, not a separate deliverable.** Other games will
need the same session management. Two moves make `src/match/` a complete
game-agnostic kit for host-authoritative turn games: T5 inverts `host.js`'s direct
engine imports (`validateMove` / `applyMove` / `viewFor` / `enumerateLegalMoves`
become an injected `rules` object), and the frame router, directory, registry,
timer, and seats modules stay import-clean of `src/engine` and `src/ui`. That kit
is the launcher's parked WP-L2 (`arcade-table`). It gets built *here* first and
vendored out when a second game wants it — extracting before a second consumer
exists generalizes the wrong seams.
