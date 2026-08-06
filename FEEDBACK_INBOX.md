# Feedback Inbox

Running log of playtest feedback captured as it comes in. Not triaged
against the code yet — that happens when this becomes a plan. Items stay
here in the words they arrived in, with just enough structure to sort them
later.

Previous pass: [FEEDBACK_PLAN.md](FEEDBACK_PLAN.md) (ten items, all shipped
on `feat/playtest-feedback-pass`).

## Round 2 — 2026-08-05

Triaged into two work packages, filed as GitHub issues:

- Item 1 → [#13](https://github.com/paulgibeault/cardstock/issues/13) —
  turn cue reflows the table (action bar toggles `display` in the flex
  column; reserve its space, animate opacity, audit the announce bar).
  **Shipped** in [#16](https://github.com/paulgibeault/cardstock/pull/16);
  the audit found four sites, not one. Tail left open as
  [#17](https://github.com/paulgibeault/cardstock/issues/17): the reserved
  slot is one line, so a *wrapping* hint still grows the bar — Milestones
  shifts ~16px on most turns. Needs a UX call, not just a fix.
- Items 2–4 → [#14](https://github.com/paulgibeault/cardstock/issues/14) —
  implement `playAfterDraw` in the shedding template. The manifests
  already declare `playAfterDraw` / `mustPlayIfAble` but nothing reads
  them; the UI also blocks voluntary draw. Design for #4: a `playDrawn`
  phase plus an explicit `pass` move through the move pipeline, dressed
  as a "Keep it" button in the action bar. **Shipped** in
  [#15](https://github.com/paulgibeault/cardstock/pull/15).

### 1. The your-turn transition shifts the UI vertically

There is a transition that indicates it is my turn to play, but it causes
the UI to shift up and down. Distracting; the cue should not move layout.

- Type: feel / bug
- Note for triage: whatever the cue animates, it needs to be a property
  that does not reflow — the seats and hand should stay put.

### 2. Wildfire: drawing is legal even with a playable card in hand

It is valid for a player to choose to draw even though they hold a playable
card. Especially useful for saving a wild for later. If the UI currently
blocks or discourages the draw when a play exists, that is wrong.

- Type: rules correctness

### 3. Wildfire: the just-drawn card may be played in the same turn

If you draw on your turn and the drawn card is playable (matches color,
number, or symbol of the discard, or is a Wild), you may play it
immediately in that same turn. Full rule as given:

- **Choice to play.** You are not required to play the drawn card. You may
  keep it in hand and end your turn.
- **Draw limit.** Only one card is drawn per turn when searching for a
  playable card. If that drawn card cannot be played, the turn immediately
  passes to the next player.
- **Voluntary drawing.** You may draw even if you already hold a playable
  card. If the drawn card is playable you may play it — but you may *not*
  play a card you held prior to drawing on that turn.
- **Penalty draws (Draw 2 / Wild Draw 4).** Cards drawn because someone
  played a +2 or Wild +4 on you cannot be played that turn. The turn is
  entirely skipped.

- Type: rules correctness
- Note for triage: the "only the drawn card is playable after drawing"
  constraint is the sharp edge — after a voluntary draw the rest of the
  hand goes dead for the remainder of the turn.

### 4. Open question: how does a turn end after a voluntary draw?

What should the mechanic be for playing a just-drawn card — require
placement, or let the player keep it? Leaning toward: they should be able
to keep it. But then how do we know when to end the turn? Wants something
elegant and simple.

- Type: design decision, blocks #3
- Options to weigh at plan time:
  - **Auto-pass unless played.** Drawn card is playable → it is briefly the
    only live card; anything else (tap elsewhere, timeout, tap the drawn
    card's "keep") ends the turn. No explicit button.
  - **Explicit end-turn affordance,** shown only in this state.
  - **Drop target as the only exit.** Play it or tap "Done".
  - If the drawn card is *not* playable, all options collapse to the same
    thing: turn ends on its own, per the draw-limit rule above.

## Round 3 — 2026-08-06

All three shipped together; no issue was filed, the work was small enough
to go straight to the change.

### 5. A Draw 2 / Draw 4 should be seen to leave the deck

When a player — including me — is hit with a draw 2 or 4, the cards should
animate from the draw pile to that player's hand.

- Type: feel
- Shipped: `animatePenaltyDraw` in src/ui/table.js. One flight per card,
  staggered, starting after the card that caused it has landed on the
  discard. Face-up for the human, backs for a bot. The same flight covers a
  missed "Last card!" catch, which costs cards the same way. Capped at six
  copies so a pack that declares a huge penalty cannot buy forty timers.

### 6. The colour / suit chooser looked like a form

Choosing a colour (Wildfire) or a suit (Crazy Eights) should look in
theme — a feature rather than a blemish.

- Type: feel / design
- Shipped: src/ui/cardStyles/chooser.js. Every option is drawn by the
  pack's own renderer, so a colour is the card the discard is about to
  behave like and a suit is the pip you will have to follow; four options
  lay out two-up like the rosette on the wild. The card that asked the
  question sits above them, the panel lights up in the colour under the
  finger, and arrow keys move between the tiles.
- Found on the way: `cardArt.palette` was `undefined` at both call sites
  that read it (the renderer exposes `theme.palette`), so the discard
  badge's colour swatch and the felt's colour wash had silently never
  appeared. Fixed with the rest.

### 7. The end of a match arrived before anyone had seen it

The end game should be acknowledged before the results window is shown, so
players have time to see the final card played and who played it.

- Type: feel
- Shipped: `awaitFinalLook` in src/ui/panels.js. The results panel used to
  open on the same frame the winning card was still flying to the discard.
  It now waits behind a small bar — no scrim, felt still live and still
  inspectable — that names the winner and the last card, and opens the
  panel only when asked. Nothing times out.

### 8. The 7's "colour" menu in the seven-zero variant

Playing a 7 with "Sevens and zeros" switched on asked for a colour. The card
says "Swap hands with a player of your choosing" — it should ask which
player.

- Type: rules correctness / feel
- Root cause was two layers below the menu. `swapHands` declares
  `choose: "player"`, but the shedding template only enumerated a choice for
  WILDS, so a 7 enumerated one choiceless move and `applyEffect` read
  `choice.player` off a move that never had one. **No hand had ever been
  swapped — for bots either.** The chooser was the visible end of a variant
  that did nothing.
- Shipped: `choiceOptions` in src/templates/shedding.js enumerates one move
  per target, and validateMove now demands the choice from every card that
  asks for one (not only a wild) and checks a target is a real seat. The
  table offers the other players, each wearing the mark from their own seat
  plate, and skips the question entirely at a two-hander — a choice with one
  answer is not a choice. 30 headless games now produce ~2100 swaps where
  they produced none.
- Found on the way: `tools/pack-test.mjs` never read the `variants` key its
  own schema has documented since it was written, so every "variant" rule
  test silently ran against the base game and passed for the wrong reason.
  The runner honours it now, and the four new seven-zero cases are the first
  tests in the repo that actually exercise a variant.

<!-- Next items go here. -->
