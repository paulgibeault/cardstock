# Card Game Platform ("Cardstock")

**▶ [Play now](https://paulgibeault.github.io/card-game/)** — Crazy Eights
solo vs. bots, hosted straight from this repo via GitHub Pages. Works on
iPhone Safari for on-device testing; no install needed.

A single dynamic platform that plays many card games, each delivered as a
**card-pack** (config + optional logic + styles + assets). Runs as one game
inside [Paul's Arcade](https://paulgibeault.github.io), using its SDK for
storage and serverless P2P multiplayer.

**Status: milestone 1 implemented.** Engine core, all four genre templates,
and all five launch packs pass their rule tests; a minimal standalone UI
plays Crazy Eights solo against bots. See
**[IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md)** for what's built,
what simulation caught and fixed, and known limitations. Arcade SDK
integration and P2P sync (design doc §15 milestone 2+) haven't started.

## Running it

```sh
node tools/serve.mjs          # dev server at http://localhost:4780
node tools/pack-test.mjs --all      # rule-test suite (38 assertions, 5 packs)
node tools/simulate.mjs --all --games=1000   # bot-vs-bot stall detection
```

Open `http://localhost:4780/` to play Crazy Eights solo against bots
(`?pack=<id>` selects another pack, though only Crazy Eights has UI
polish so far). The [hosted version](https://paulgibeault.github.io/card-game/)
deploys automatically from `main` — no server needed, useful for testing
on a phone.

## Layout

- **[CARD_PLATFORM_DESIGN.md](CARD_PLATFORM_DESIGN.md)** — the design
  document: architecture, engine primitives, genre templates, pack format,
  sync model, roadmap. Start here.
- **[IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md)** — milestone 1
  status: what's built, bugs simulation caught, known limitations.
- **[ARCADE_ENHANCEMENTS.md](ARCADE_ENHANCEMENTS.md)** — spec for four
  additive `Arcade.peer` enhancements (capability flags, targeted send,
  peer roster, message meta), being implemented concurrently in the
  arcade repo. The design assumes they're available: multiplayer
  boot-gates on the caps, with no fallback protocol paths in the game.
- **`schema/`** — JSON Schemas for the pack manifest, deck files, and rule
  tests. Normative for those formats.
- **`packs/`** — the five launch packs: `crazy-eights`, `uno`, `hearts`,
  `phase-10`, `skip-bo`. Each has a manifest, a deck file where needed,
  and table-driven rule tests. All five are manifest-only (no `logic.js`).
- **`src/engine/`** — card/deck/zone/state model, move pipeline, scoring,
  pack loader, bot.
- **`src/templates/`** — the four genre templates (shedding, trick-taking,
  contract-rummy, sequencing).
- **`src/ui/`, `src/main.js`, `index.html`** — the standalone vanilla
  table UI (no arcade integration yet).
- **`tools/`** — `pack-test.mjs` (rule-test runner), `simulate.mjs`
  (headless bot-vs-bot simulation), `serve.mjs` (zero-dependency dev
  server).

## Notes

- Companion docs live in the arcade repo: `ARCADE_PLATFORM.md` (SDK/P2P
  surface) and `GAME_INTEGRATION.md` (catalog integration). The design's
  §17 is the full integration contract, aligned with those docs at arcade
  protocol v2 and verified against the transport source (2026-07-10);
  planned gameId: `cardstock`.
- Uno, Phase 10, and Skip-Bo are Mattel trademarks. The packs describe
  public gameplay for personal use; replace names and art before any public
  release. The hosted build above serves Crazy Eights only (public domain)
  for this reason — the other four packs are engine-complete but not
  linked from the UI's default view.
