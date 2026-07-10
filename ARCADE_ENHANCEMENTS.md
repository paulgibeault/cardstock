# Arcade platform enhancements for multi-seat games ("Cardstock asks")

A self-contained spec for three additive `Arcade.peer` enhancements to the
arcade platform (`paulgibeault.github.io`), designed against the current
source (`arcade-sdk.js`, `arcade-p2p.js`, `p2p/p2p-core.js`, protocol v2,
reviewed 2026-07-10). Intended to be implemented in the arcade repo,
concurrently with Cardstock's engine work.

**Consumer**: Cardstock (multi-seat card tables, host-authoritative, hidden
information). **Framing**: Cardstock's design assumes these are available —
its multiplayer milestone boot-gates on the E0 capability flags and ships
**no fallback protocol** (solo play, milestone 1, has no dependency). The
caps exist so an out-of-date launcher produces a clean "update required"
notice instead of undefined behavior. The enhancements also benefit every
future multi-peer game in the fleet.

Priority order: **E0 (required by the others) → E1 (highest value) → E2 →
E3 (trivial, rides E1)**.

---

## E0. Capability flags — `welcome.caps`

The SDK and launcher deploy together (same origin, one repo), but a game
must not hard-depend on a launcher feature mid-rollout, and versions
shouldn't bump for additive changes.

- **Wire**: `arcade:welcome` gains `caps: string[]` (e.g.
  `['peer.sendTo', 'peer.roster', 'peer.meta']`). Absent field ⇒ `[]`.
  Protocol version stays 2 — this is additive.
- **SDK**: `Arcade.peer.caps()` → array (frozen), `[]` standalone or on an
  older launcher.
- **Docs**: add to the SDK block in ARCADE_PLATFORM.md and the wire table
  in GAME_INTEGRATION.md §14.

Effort: small (an array literal in the welcome, one SDK getter).

---

## E1. Targeted app messages — `Arcade.peer.send(payload, { to })`

### Problem

`Arcade.peer.send()` broadcasts to every connected peer, and the host's
transport blindly relays every joiner-sent app frame to all other joiners
(`p2p-core.js` — "Host relays APP messages between clients"). For a game
with hidden information (a dealt hand), this means every client receives
every other client's private frames and must cooperatively discard them.
Fixing delivery at the platform layer gives real routing privacy (clients
never *receive* what isn't theirs), cuts bandwidth, and removes a whole
class of game-level envelope logic.

### Design principle — deviceIds live in the bridge, not the transport

The transport knows transient `peerId`s; the *bridge* (`arcade-p2p.js`)
already owns the `deviceId → direct peerId` map (`identityLinks`). So
targeting is resolved in the bridge, and the transport learns exactly two
small, dumb things.

### Transport changes (QRCodeP2P, vendored `p2p/` + upstream)

1. **`sendTo(peerId, text)`** — public single-link send. The internal
   `_sendAppTo(peerId, msg)` already exists and already integrates with
   the per-link outbox (exactly-once replay through `interrupted`);
   this is a thin public wrapper.
2. **`noRelay` flag** — app frames gain an optional boolean. The host's
   relay loop (`peers.forEach … relayed: true`) skips frames marked
   `noRelay`. Sender sets it on every targeted frame.

Both are wire-additive: old peers ignore the flag (worst case: an old
*host* still relays a targeted joiner frame — the recipient-side drop rule
below makes that harmless). Bump transport minor version; update
`PROTOCOL.md`; re-sync the vendored copy via `tools/sync-p2p.sh` and note
the commit in `p2p/VENDORED.md`.

### Bridge changes (`arcade-p2p.js`)

- Envelope gains `to`: `{ arcade: 1, gameId, payload, to?: deviceId }`.
- **Sending** (`send(gameId, payload, to?)`):
  - no `to` → today's broadcast, unchanged.
  - `to` resolves via `identityLinks` to a direct link → `sendTo` that
    link with `noRelay`.
  - `to` known but no direct link (a joiner addressing another joiner) →
    `sendTo` the host link with `noRelay`; the **host bridge forwards**
    (see receiving). Return `false` if `to` is unknown or identity
    exchange hasn't completed — the caller must know a private frame did
    not go out. Never silently fall back to broadcast.
- **Receiving**, before routing to the game:
  - `env.to` absent → deliver (broadcast frame).
  - `env.to === myDeviceId` → deliver.
  - `env.to` is someone else and **I have a direct link to them** (I'm
    the host) → forward via `sendTo(theirLink, env)` with `noRelay`; do
    not deliver locally.
  - otherwise → drop silently (defense in depth against an old-host
    blind relay).
- Replay semantics: targeted frames ride the same per-link outbox and
  session stash as broadcast frames — queued during `interrupted`,
  replayed exactly-once. (Mostly free: `_sendAppTo` already feeds the
  outbox; verify the stash path covers targeted frames too.)

### SDK changes (`arcade-sdk.js`)

- `Arcade.peer.send(payload, opts?)` — `opts.to` (deviceId string).
  Wire: `arcade:peer.send { payload, to? }`.
- Returns `false` when: no live session (today's rule), `to` given but
  launcher lacks the `peer.sendTo` cap, or launcher reports the target
  unknown. (Simplest correct form: SDK checks caps locally and the
  launcher's routing failure is silent-drop; a game that needs stronger
  delivery signals already needs acks at the game layer.)

### Privacy statement (document honestly)

`to` is **routing, not secrecy from the host**: joiner↔joiner targeted
frames transit the host bridge readable (inherent to the star topology,
and correct for host-authoritative games). What E1 guarantees: a
non-addressee **joiner never receives** the frame. End-to-end sealing
against the host remains a game-layer concern (Cardstock v1.5).

### Tests (arcade repo)

Extend the two-launcher harness (`tools/p2p-acceptance.mjs`) with a
**three-launcher scenario** (host + 2 joiners via "Invite another
player"):

1. host → `send(p, {to: A})` — A receives, B does not.
2. joiner A → `send(p, {to: host})` — host receives, B does not
   (the `noRelay` assertion).
3. joiner A → `send(p, {to: B})` — B receives exactly once, host bridge
   forwarded, B's game never saw a duplicate.
4. `send(p, {to: unknownDeviceId})` returns `false`.
5. Kill A's network mid-session; targeted frames sent to A during
   `interrupted` arrive exactly-once after recovery.

### Docs to update

ARCADE_PLATFORM.md SDK block + wire protocol section; GAME_INTEGRATION.md
§7a (rules of the road: when to target, the host-visibility caveat) and
§14 wire table.

Effort: moderate — the transport half is small; the bridge forward/drop
rules and the three-launcher test are most of the work.

---

## E2. Peer roster + per-peer status — `Arcade.peer.peers()`

### Problem

A 4-player table needs to know *who* is connected and *which* seat's
device is `interrupted`, but the SDK exposes only an aggregate status
(`aggregateStatus()` collapses all links) and `remote()` returns just the
most-recently-seen device. The transport already emits per-peer status
(`status` events carry `{ peerId, status }`) and the welcome already
seeds a `peers` array — the plumbing exists; it just isn't surfaced.

### SDK surface

```js
Arcade.peer.peers()        // [{ deviceId, name, status, direct }], [] when none
Arcade.peer.onPeersChange(fn)  // fn(rosterArray) on any join/leave/rename/status change
```

- `status` per entry: `'connected' | 'interrupted' | 'idle'`.
- `direct: true` when this device holds the direct link (for a joiner,
  exactly the host — games can identify the host without a lobby frame).
- One coarse event with the full roster (not fine-grained add/remove
  events) — simpler for games, cheap at this scale.
- `remote()`, `onStatus()` (aggregate), and `arcade:peer.identity` stay
  unchanged for existing games; document `peers()` as the multi-peer API.

### Wire & bridge

- Welcome `peers` entries gain `status` + `direct`.
- New broadcast `arcade:peer.roster { peers: [...] }` on any change; the
  bridge builds it from the transport's per-peer `status` events plus its
  existing identity upserts (`recordPeerIdentity` / `identityLinks`).
- Cap flag: `peer.roster`.

### Tests

Three-launcher scenario: roster shows both joiners on the host and
(host-only) on each joiner; kill one joiner's network → host roster entry
flips to `interrupted` then back, aggregate status meanwhile stays
`connected` for unaffected links (assert the aggregate rule is
documented behavior, whatever it is today — don't change it).

Effort: small-moderate — mostly bridge bookkeeping + wire message +
SDK cache.

---

## E3. Message metadata — `onMessage(payload, fromPeer, meta)`

Third argument `meta = { relayed: boolean, to: 'me' | 'all' }`. The
transport already stamps `relayed: true` on host-relayed frames; the
bridge already has it in hand when routing — it's currently dropped.
Games get a cheap sanity check ("this 'host' frame arrived relayed —
someone is spoofing") and can distinguish broadcast from targeted
delivery without inspecting their own envelopes.

Additive: existing two-argument listeners are unaffected. Cap flag:
`peer.meta`. Effort: trivial (rides E1's envelope work).

---

## Rollout & sequencing

1. **E0** first (minutes, unblocks feature detection).
2. **E2** is independent of E1 — can land in either order.
3. **E1** transport flag + bridge routing + three-launcher test.
4. **E3** rides E1's envelope changes.

No protocol version bump; no behavior change for any existing game
(pi-game, hecknsic, cozy-solitaire, p2p-chat fixtures all use broadcast
sends and aggregate status only). The three-launcher acceptance scenario
is itself a platform asset — it's the first automated coverage of the
multi-joiner star + relay path.

## What Cardstock does with each

Cardstock (CARD_PLATFORM_DESIGN.md §17) assumes E0–E3 exist; there are no
dual-protocol code paths in the game. Its multiplayer boot gate checks
`Arcade.peer.caps()` for `peer.sendTo` + `peer.roster` and shows a
"launcher update required" notice otherwise.

- **E1**: per-seat private frames via `send(payload, { to })` —
  non-addressee clients never receive them.
- **E2**: seat presence chips, per-seat `interrupted`/`idle` handling,
  host identified as the roster entry with `direct: true`.
- **E3**: authority frames arriving `relayed: true` are rejected as
  spoofs.
