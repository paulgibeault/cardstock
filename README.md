# Card Game Platform ("Cardstock") — design phase

A single dynamic platform that plays many card games, each delivered as a
**card-pack** (config + optional logic + styles + assets). Runs as one game
inside [Paul's Arcade](https://paulgibeault.github.io), using its SDK for
storage and serverless P2P multiplayer.

**Status: design only — no engine code yet, by intent.** Implementation is a
separate later phase.

## Layout

- **[CARD_PLATFORM_DESIGN.md](CARD_PLATFORM_DESIGN.md)** — the design
  document: architecture, engine primitives, genre templates, pack format,
  sync model, roadmap. Start here.
- **`schema/`** — JSON Schemas for the pack manifest, deck files, and rule
  tests. Normative for those formats.
- **`packs/`** — the five launch packs drafted *on paper* as a dry run of
  the format: `crazy-eights`, `uno`, `hearts`, `phase-10`, `skip-bo`. Each
  has a manifest, a deck file where needed, and table-driven rule tests.
  All five are manifest-only (no `logic.js`) — a deliberate stress test of
  the template layer (design doc §16).

## Notes

- Companion docs live in the arcade repo: `ARCADE_PLATFORM.md` (SDK/P2P
  surface) and `GAME_INTEGRATION.md` (catalog integration).
- Uno, Phase 10, and Skip-Bo are Mattel trademarks. The packs describe
  public gameplay for personal use; replace names and art before any public
  release.
