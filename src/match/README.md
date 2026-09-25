# src/match/ — the table kit

Host-authoritative, turn-based tables over the launcher's peer transport:
one device holds the state and arbitrates, every other device proposes and
draws the views it is sent. Nothing in this directory knows the rules of the
game being played. It imports nothing from `src/engine/` or `src/ui/`, and
`tests/repo-gates.test.js` ("src/match/ reaches into neither the engine nor the
UI") fails on the first file that does (#50).

This is *extraction-ready*, not extracted: vendoring it into the launcher
(`MULTIPLAYER_PLAN.md` §12, WP-L2 `arcade-table`) waits for a second game.

## What a game supplies

**A rules object**, handed to `createTableHost({ rules, … })` and
`createTableClient({ rules, … })`. Neither has a default; both throw without
one. Cardstock's is `src/engine/tableRules.js`, where every member is an
existing engine export passed through unchanged:

| member | used by | shape |
| --- | --- | --- |
| `validate(state, move)` | host | `{ legal: true }` or `{ legal: false, rule, reason }`; never throws |
| `apply(state, move)` | host | mutates `state`, leaves the move's events in `state.events` |
| `enumerateMoves(state, seat)` | host | the moves shipped with an acting seat's view |
| `actingSeats(state)` | host | the seats that may move now |
| `announcementsFor(state, seat)` | host | what a seat may say out of turn |
| `viewFor(state, seat, opts)` | host | the JSON-safe payload one seat may see, carrying `v` |
| `eventsFor(state, seat, events)` | host | a move's events, redacted for that seat |
| `cardExists(state, id)` | host | does a wire id name a real piece? checked before `validate` |
| `viewVersion` | client | the `v` this build draws; a view of any other `v` is refused |

The state is opaque to the kit except in two places: the host fans out
`state.events` after `apply`, and the turn timer stops on `state.gameOver`.

**A renderer** that draws a view. In cardstock that is the felt
(`src/ui/table.js`) bound to a `TableSession`; the kit never touches the DOM.

**The construction site** that wires the two together — cardstock's is
`src/ui/party.js` (hosted and joined tables); `tools/simulate.mjs`'s
`--protocol` mode is a second one in miniature, over the stub transport.

## What a game inherits

- **Identity and transport** — `peerPort.js` (the launcher's `Arcade.peer`, or
  `tools/peer-stub.mjs` in tests), authenticated sender ids, the replay queue.
- **Seats** — ownership is `src/players/seats.js`, injected as `seats`.
- **Sessions** — `tableSession.js` owns one table's state/view, host or client,
  timer and lobby frame; `sessionRegistry.js` holds the live ones and the
  may-I-host policy; `tableDirectory.js` logs every table this device has seen.
- **The protocol** — `protocol.js` (frame kinds, the validator) and
  `frames.js` (the builders), rate limiting, seq/snapshot recovery, byes.
- **Timers** — `turnTimer.js` and `clock.js`: host-clock deadlines, a timeout
  is a move.
- **Persistence discipline** — the host is the only party with a state; a
  client holds a view and never runs the reducer.

## What a non-card game would swap in protocol.js

`protocol.js` validates the *wire*, not the rules, and most of it is generic:
the envelope, frame kinds, `SAFE_ID`, seat indices, names, grace limits. The
`propose` payload, though, is shaped for card games, and a game whose moves are
not "an actor, a type and some cards" would replace these:

- `cleanMove`'s fields — `cards`, `from` / `to` (zone addresses), `id`,
  `target`, `label`, `choice`.
- `SAFE_CARD_ID` (a card id with an optional `#n` copy suffix) and
  `SAFE_ADDRESS` (a zone address like `hand.2`).
- `cleanChoice`, `cleanWilds`, `cleanMeldGroup` and `SAFE_ITEM` (contract items
  like `run(7)`, copied from `src/templates/melds.js`'s grammar).
- `LIMITS.cards`, `LIMITS.melds`, `LIMITS.wildAttrs`, `LIMITS.index`.

The host's `cardExists` check reads `move.cards`, so it goes with them.
