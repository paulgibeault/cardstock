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

## Round 4 — 2026-09-03

Two clusters: the meld mechanic, and the player cards along the top.
Triaged against the code in [MELD_SEATS_PLAN.md](MELD_SEATS_PLAN.md).

### 9. The meld pile goes dead while other players take their turns

There are states during gameplay where interacting with my hand and the
meld pile is interrupted. It is frustrating to not be able to add to or
remove from my meld pile while the other players/bots take their turns.

- Type: feel / bug

### 10. The meld pile still takes space after I have laid down

The meld pile still takes up space even after I have already laid down. It
should yield the space to my laid-down cards until the next round.

- Type: feel

### 11. The selected card sometimes sits behind its neighbours

The selected card sometimes pops up behind the other cards, which looks
strange. A z-order issue.

- Type: bug / cosmetic

### 12. Laid-down runs are not in order

When laying down cards, or playing on other laid-down piles, the runs
should be sorted, with the wilds in the correct space. This makes them
easier to follow.

- Type: feel

### 13. On my turn, the next player should scroll into view

When the turn is mine, the next player should scroll into view — I would
likely want to see their played cards when deciding what to do.

- Type: feel

### 14. Two states of player card, not three

Remove the middle option for minimized/maximized player cards.

- Type: feel

### 15. Player cards should default to maximized

Default to maximized player cards, rather than only the current player
being maximized.

- Type: feel

### 16. A card goes for a ride while the player cards scroll

When scrolling between player cards (which works very well already),
sometimes one of the cards appears to go for a ride to the neighbour's
deck. Cosmetic only — the cards never actually change hands.

- Type: bug / cosmetic

### 17. Played cards move too fast to see

When players/bots play their cards, the animation is too fast to notice.
Make it smoother.

- Type: feel

## Round 5 — 2026-09-07

The first playtest pass on the four new packs (Thirteen, Team Spades,
Cribbage, Pinochle), all shipped without one. Two playtesters, one per pair
of packs, each playing many hands through the real felt rather than reading
source. Both were told the same thing: describe the symptom, don't fix it.
Triaged in [NEW_GAMES_FEEDBACK_PLAN.md](NEW_GAMES_FEEDBACK_PLAN.md).

Rules engines held up well everywhere — follow-suit, lead constraints,
must-beat, scoring, bags, melds all checked out correct where verified. The
friction is almost entirely in *reading the table*: what am I beating, what
did I bid, whose turn just ended, what just happened.

### Thirteen

#### 18. The pile I have to beat is an unlabeled heap of the whole trick

The centre has two stacks. The left one is the live trick, the right one is
everything played this round. Neither is named once it has cards in it — the
word "Pile"/"Played" only shows while the box is *empty*, and the moment a
card lands the label is replaced by a bare count chip. So when it matters I
am looking at two near-identical fans of cards, one wearing "2" and one
wearing "28", with nothing to say which is which.

Worse, the left stack accumulates *every* card played in the trick, not the
combination I have to answer. On a trick where three people have played
singles it reads "3" and shows three overlapping cards, only the top two
legible — but the thing I must beat is one single. I spent most of the match
squinting at a stack trying to work out whether I was answering a pair or a
run.

- Type: bug / feel
- Note for triage: the hint already does the right thing — see item 25. It
  ring-highlights the exact card on the pile I'm beating. Doing that
  unprompted, or just labelling the last combination ("Pair of 10s — beat
  it"), would fix this.

#### 19. Selecting a card takes the Pass button away and puts "Deal order" in its place

With nothing staged, the rail beside my hand shows a blue **Pass** pill. The
instant I tap one card, `#action-button` goes `display:none` and
`#hand-sort` takes the same slot — same row, ~20px to the left. So the
button under my thumb silently turns from "Pass" into "Deal order", and if
I tap where Pass was I reshuffle my hand instead of passing.

The staged state is also silent. I selected a 7♣ and an 8♥ against a pair of
10s — not a legal anything — and got no commit button, no "that isn't a
play", and no Pass either. Just two cards floating in a dashed tray and
nothing to press. The only way out is to work out on your own that you have
to un-tap them.

- Type: feel / bug
- Note for triage: the source comment says the shared slot is deliberate
  ("the one action that needs a button... and otherwise the sort"). In
  Thirteen, where you're passing constantly and staging constantly, that
  trade lands badly. Also: when leading a fresh trick the slot is empty
  entirely, so an illegal selection while leading shows nothing anywhere.

#### 20. "First to 50 wins" — 50 is how you lose

Every round-over panel says **"First to 50 wins — 44 to go."** Thirteen's
manifest is `anyScore >= 50` with `winner: "lowestScore"`, and every point
is a card I was caught holding. The panel is telling me to race toward the
number that ends the match with me losing, and framing my penalty as
progress. I finished the match at 53 and lost to Fig on 21 — after eight
rounds of being told I was "17 to go".

- Type: rules correctness
- Note for triage: **confirmed against the source.** `targetSentence`
  (`src/ui/panels.js:114`) reads `Math.max(...sideScores(...))` — the
  *leader* by raw score, unconditionally — and never looks at
  `scoring.gameOver.winner`. For a `lowestScore` pack that leader is
  whoever is closest to losing. Hearts is the other `lowestScore` pack
  (`anyScore >= 100`) and shares this function, so it likely has the same
  bug; not verified live this round.

#### 21. The round summary arrives after the next round has already been dealt

When a round ends, the panel goes up over a table that has already moved
on: my hand is thirteen fresh cards, the piles are empty, the turn line
reads "Nell's turn" and Nell's seat is lit. Meanwhile the panel's button
offers to **"Deal round 2"** — a round that is visibly already dealt behind
it. Play is properly frozen (I watched for 8s, nothing moved), so it isn't a
rules problem, but the last card of the round is gone before I ever see it,
and the button promises something that has already happened.

- Type: feel
- Note for triage: `awaitFinalLook` (round-3 item 7) does exactly the right
  thing at *match* end — confirmed live at `src/ui/table.js:2789`
  (`offerFinalLook`), gated behind a beat measured against the flight
  duration. Round end has no equivalent: `el.roundOverlay.hidden = false`
  (`src/ui/panels.js:102`) fires straight off the round-ending move with no
  delay and no freeze of the *next* deal. Same gap surfaces in Cribbage
  (item 39) and Team Spades (item 32) — one platform fix, three packs.

#### 22. Nothing ever tells me I won the trick and now lead

Across ~70 of my turns I saw exactly four banner shapes: "X played a
run/pair/triple", "X passed", "You passed", "X played." There is no
"everyone passed — the trick is yours" and no "you lead". The only signal
that the trick ended is the left pile silently emptying. Worse, the banner
is stale: on turns where I was leading a brand-new trick it still read "Fig
passed" from three plays ago, sometimes for three of my turns in a row.

Since "am I leading or am I answering?" is the single decision Thirteen is
made of, having to infer it from a pile going to zero is the biggest thing
standing between the game and a first-timer.

- Type: feel
- Note for triage: no screenshot needed — it's an absence. Instrumented turn
  log: on turns with `pile=Pile, 0 cards.` (I lead) the banner still showed
  the previous player's pass and the action slot was empty.

#### 23. My hand won't spread out, and a lifted card buries the one to its right

Down to five cards with a thousand pixels of empty felt on either side, the
hand stays clamped into the same tight overlap it uses for thirteen. And
when a card lifts — hover, or the hint ring — it scales up over its
right-hand neighbour and swallows that card's index entirely. The card
between the lifted one and its other neighbour is unreadable: all you can
see of it is one pip.

At 375px the same geometry gives every card a **14px** exposed strip (46px
wide, 14.5px step) for a 13-card hand, in a hand that only uses 236px of a
332px row. That is a very small thing to hit with a thumb, in a game whose
main mechanic is tapping several cards in a row.

- Type: bug / cosmetic (desktop), feel (phone)

#### 24. At 375px the table is mostly empty green, and the ↺ badge sits on top of a seat

On a phone, the felt from the seats down to the pile and from the pile down
to the hand is about 480px of nothing out of 812, while the hand is crushed
into 220px at the bottom. The counter-clockwise ↺ badge also overlaps the
corner of the second seat plate. That badge is a separate small problem in
its own right: it's a 38px amber circle in the top-right of the table with
no label, no tooltip and no accessible name, and it reads exactly like a
"restart the game" button.

Also on the seat plates: score and cards-left are two identical grey pills
with nothing to distinguish them ("Nell 12 1"), and each seat's fan of card
backs carries a "13" medallion — so a player down to their last card shows
a big "13" right under a pill that says "1".

- Type: feel / cosmetic
- Note for triage: the aria labels on those pills are correct ("-60 points
  for this side", "11 cards", "bid 6 tricks") — it's only the visual that's
  anonymous. And the "13" is presumably just the pack's card-back art; it
  collides badly with a count in a game called Thirteen.

#### 25. Three things that are good and should not be lost

The **hint** is the best thing in the game: press it and it ring-highlights
the card it would play *and* the card on the pile you're beating, in the
same blue. It is the only moment the table explains itself, and it makes
the case for item 18 all by itself. The **match-end final-look bar** ("Fig
wins. Last card: 6 of Hearts, played by Fig. — See the results") is exactly
right and worth copying to round end (item 21); my only nit is that it sits
on top of my remaining hand, hiding the cards that explain why I lost. And
**"Round by round"** is a genuinely clear table with per-round deltas and
totals.

- Type: positive

#### 26. Smaller things

- The results panel leads with **Moves / Cards played / Hints taken** and
  does not show the scores that decided the match. The scores are one click
  away under "Round by round", but the default view is trivia.
- Every card's aria label says **"worth 1"** — a generic template string;
  nothing in Thirteen is worth 1 until you're caught with it.
- I never got a four-handed table. `?pack=thirteen&seats=4` and `&seats=2`
  both gave three seats; THIRTEEN_RULES §D-11 says solo-vs-bots means four
  is what almost everybody will see. May be that the URL param isn't real —
  not confirmed against source.
- I could not get a **bomb** to arise in ten rounds of dealing, so the
  game's signature move went untested this round.
- `prefers-color-scheme: dark` vs `light` produced visually identical
  tables at both widths — flagging only so it's known the theme pass found
  nothing to report.

### Team Spades

The rules engine held up well under everything thrown at it — follow-suit,
the not-leading-spades-until-broken constraint, scoring, bags in the
totals, nil. The problems are all in what the table tells you.

#### 27. You never see the completed trick

The trick pile goes 1 → 2 → 3 → **0**, traced frame-by-frame across six
consecutive tricks. It never reaches four. The fourth card of a four-player
trick is never rendered on the felt before the trick is swept — and that is
usually the card that decided it. All you get is a banner naming the
winner, by which time the cards are gone and the next trick has already
started underneath it.

Even at three cards you can only read two of them: the newest card paints
as a featureless grey slab for its first frames (`card-face--fresh`), and
briefly the same card renders twice while it's landing — the same
double-render family as round-4 item 16.

- Type: bug / feel
- Note for triage: this is round-4 item 17 ("played cards move too fast to
  see") taken to its limit — here the card isn't fast, it's absent.

#### 28. Your own bid is never shown anywhere

I bid **7**. Nothing on the screen says 7. The seat plates carry the other
three players' bids as bare chips (Bruno 1, Cass —, Pip —), the top bar
shows only my side's running score, the scoreboard doesn't have it, the
round summary doesn't have it. Full page text checked: my bid does not
appear anywhere.

In partnership Spades the contract is my bid plus my partner's, and the
round is scored against that sum. Not being able to see half of my own
contract is the sharpest thing in the game. It also made a Nil experiment
unreadable — I bid Nil, Cass's plate showed "nil", and there was no way to
tell whether that was her bid or mine surfacing on the wrong seat.

- Type: bug / feel

#### 29. "Won N" counts cards, not tricks

Each seat plate carries a "Won N" chip. It goes up in fours. It is the
number of *cards* in that player's won pile, sitting an inch below their
bid, which is a number of *tricks*. So the table reads "Cass — bid 4 — Won
16", and you divide by four in your head, every turn, for the one
comparison the entire game is about.

- Type: bug

#### 30. "Trick is yours — no points"

That's the banner when I win a trick. Every trick I win is exactly the
thing I bid for, so being told it's worth "no points" is the opposite of
true. Other players get a clean "Cass takes the trick"; only mine carries
the disclaimer.

- Type: rules correctness / feel
- Note for triage: **confirmed against the source**, `src/ui/celebrations.js:157`:
  `` ev.points > 0 ? `You take the trick — ${ev.points} points against you` : 'Trick is yours — no points' ``.
  Written for a penalty-trick game (Hearts) and applied unconditionally to a
  game where tricks are the goal. Same family as Pinochle's item 53. A
  bids-and-bags pack wants a sentence that counts toward the bid instead —
  "That's 5 of your 7."

#### 31. Bags exist, accumulate, and are never mentioned on the table

The manifest is `bags: { at: 10, penalty: -100 }` and they clearly work —
scored +42 on a 4-contract and +63 on a 6-contract, so overtricks are being
counted and carried correctly. But the word "bag" does not appear anywhere
on the screen — checked by searching the rendered page text for `/bag/i`,
no match at any point in a twelve-round match. The only place it's
explained is the How-to-play text, two clicks behind the score chip.

Ten bags is −100 — bigger than most made contracts — and it arrives with
no warning and no running count.

- Type: feel / rules correctness

#### 32. The round summary tells you the points and nothing else

"Round 4 over — You +63." Not what I bid, not what my side took, not how
many of that +63 were bags. In a bidding game the story of the round is "we
bid 6 and took 9", and none of it is there. It also lists all four seats
with individual deltas against two shared side totals, which reads as
broken arithmetic — the scoreboard is worse, showing Cass with R1 0, R2 0,
Total 122.

- Type: feel
- Note for triage: the same "the next round is already dealt behind the
  panel" problem as Thirteen item 21 applies here and is more visible — the
  panel says "Deal round 5" while the top bar behind it already reads
  "Bruno is bidding…" and my hand is thirteen fresh cards.

#### 33. Bidding on a phone is guesswork

At 375px the bid dialog asks "Choose a number of tricks to bid" while my
thirteen cards sit behind it as greyed-out 15px slivers — the exact thing
I'm supposed to be evaluating, rendered at its least readable. The seat row
is a carousel that clips: Cass's plate is cut mid-word at "PARTNE…" and Pip
is entirely off-screen, so I'm bidding without being able to see my
partner's bid or the third opponent's. The only scroll affordance is a
22×18px "• •" toggle in the corner of the felt.

On desktop the same dialog is a bare grid of Nil/1–13 with no context — no
reminder of what my partner bid, no indication of what our combined promise
would become. Same complaint as round-3 item 6 ("the colour chooser looked
like a form"), for a chooser that hasn't had that pass yet.

- Type: feel
- Also: tapping a card during the bid phase does nothing at all — no
  wobble, no message — while the cards keep `role="button"` and
  `tabindex="0"`.

#### 34. My whole hand greys out on everybody else's turn

Three turns out of four my hand is fully desaturated. It makes the table
feel dead between my plays and makes it harder to plan the next trick while
the bots take theirs — same complaint as round-4 item 9, in a different
place. The disabled tint is also the *only* legal/illegal signal, which
works fine on a spread desktop hand but is nearly unreadable on a phone
where you can only see a 14px sliver of each card.

- Type: feel

#### 35. What's good here

The **PARTNER badge** with the purple underline on the seat opposite is
immediately legible and never confused me once. The **rules enforcement**
is quietly excellent — follow-suit and the you-may-not-lead-spades-until-broken
rule both bit correctly every time, with exactly the right cards greyed.
The **How-to-play copy** is the best writing in either pack (explains bags
and nil in two sentences); it deserves to be reachable from the table
rather than buried under the score chip. The **bot flavour lines** ("plays
it straight", "is counting your cards", "has never read the rules twice")
are lovely. And the table **resumed a half-played hand** correctly across
a reload.

- Type: positive

One thing chased and not reproduced: intermittent taps on playable cards
that seemed ignored. A controlled 10-trial run came back 9 OK / 1 refused,
and the one refusal was Playwright's own actionability check timing out on
a re-render, not the app dropping a click — called a harness artifact, not
a finding.

### Cribbage

Played a full match to 121 plus two more matches, ~25 hands total.

#### 36. The show goes by in one frame

The whole counting phase — pone's hand, dealer's hand, the crib — resolves
in under 140ms and then the next hand is already dealt. Burst-screenshotted
from the instant the last card landed: at 0ms the felt still shows the
pegging, at 140ms the score has jumped, the starter and both played piles
are cleared, and six new cards are flying into the hand. The only trace is
a banner reading "Your hand is worth 8." over an already-empty table. The
opponent's own score change gets no message at all. For the game whose
tagline is "Fifteen two, fifteen four, and one for his nobs," the counting
— the part you play cribbage for — never happens on screen. The biggest
thing found this round.

- Type: feel / bug
- Note for triage: this is round-3 item 7 ("the end of a match arrived
  before anyone had seen it") again, one level down. The show wants its
  own beat the way `awaitFinalLook` gave the match ending one — same
  platform gap as items 21 and 32.

#### 37. The crib is a box that never has anything in it

Two cards go to a slot labelled "The crib" and it stays an empty dashed
rectangle for the entire hand — through the cut, through the whole play,
and then the hand ends. The zone's accessible name is literally "The crib,
0 cards." even after both seats have discarded and the deck has gone
52→40→39. The pack's own rules test asserts `crib: 4` at that point. Four
cards exist and the most prominent slot on the felt shows none of them.

- Type: bug
- Note for triage: four backs would be enough. Whatever it is bound to,
  it isn't the `crib` zone the engine fills.

#### 38. Nothing on the felt says what the count is

The running total never appears anywhere — reaching 17 mid-play meant
adding it in your head off two piles. It's only ever spoken when somebody
scores ("You pegs 3 — the count is 29"), which is exactly when you no
longer need it. Made worse because the play is split in two: your cards go
to a centre "Played" pile, the opponent's sit on their seat plate showing
only the top card, earlier ones ghosted almost to invisibility — so you
cannot read the sequence, cannot see a run forming, and nothing marks the
count resetting after a go. At a count of 30, three of four cards were
correctly greyed out — but with no count on screen the greying has no
explanation, and tapping a greyed card does nothing, not even a nudge.

- Type: feel / bug

#### 39. I do not have a cribbage board

Only the opponent has one. Their seat plate carries a rail with a back peg
and a front peg and a value, and the aria label is a genuinely lovely "46
of 121, up 2" — you can see them move up two. The human gets a chip in the
top bar that says "YOU 44". There is exactly one `.seat__track` in the
document and it is not the human's. In a game where the board *is* the
game, the human is the one player who cannot see their own peg.

- Type: feel

#### 40. The peg walks off the end of the board

The peg is positioned as a percentage of the whole track element — which
includes the number printed after the rail — instead of a percentage of
the rail. At 0 it happens to line up; everywhere else it drifts right, and
by the end of a match it has left the board entirely. At 118 of 121 the
rail spans x=556–613 and the peg is drawn at x=639, sitting on top of the
"118" text with every hole on the rail showing empty.

- Type: bug / cosmetic
- Note for triage: `left: 97.52%` is being applied against an 88px
  container over a 57px rail. Repro is just: play until a seat is past
  ~60.

#### 41. The narration says how much but never what, and skips the crib entirely

Over ten-plus rounds, the complete vocabulary observed was: "X pegs N —
the count is C", "X's hand is worth N", "Two for his heels — X", "Go — one
for X", "X threw to the crib", "X played", "Round N", "X wins". So: a peg
never says *why* — "You pegs 3" might be a run of three or a fifteen or a
thirty-one, all of which sound different at a real table. There is no
message for the crib at any point, in any round — the dealer just silently
gains its points. "His nobs" never appears despite being in the tagline
and the manifest. And "You pegs 3" should be "You peg 3" — the template is
right for "Pip pegs" and wrong for the one name that is second person.

- Type: feel / cosmetic
- Note for triage: the count *is* already threaded into the peg message,
  so the data is there; it's the reason and the crib that are missing.

#### 42. You find out whose crib it is on the confirm button

While choosing which two cards to throw — the one decision that most wants
to know this — nothing on screen says whose crib it is. The status bar
reads "Crib — pick 2" and stays that way even after two are picked. Only
once both cards are in the tray does the action button appear reading
"Your crib" or "Their crib". Also an odd label for a button — reads like a
caption rather than "throw these".

- Type: feel

#### 43. The round panel has a column of zeroes, and the next hand is already on the table

"Round 1 over" shows two unlabeled numbers per player: 0 and 12 for the
human, 0 and 10 for Pip. Whatever the left column is meant to be, it was 0
for both players in every round seen, while the right column moved — so
half the panel is a mystery column of zeroes. Behind it, the next six cards
are already dealt and greyed on the felt while the button still says "Deal
round 2", which makes the button feel like a formality.

- Type: bug / feel

#### 44. Small stuff

Three cosmetics, none worth holding anything up for. (a) A pile's label is
replaced by its count as soon as it has a card in it, so the cut card is
captioned "1" instead of "Starter" — same pattern turns Pinochle's "Trick"
into "3". (b) The match was won 122–118; cribbage stops dead at 121 and
122 is never recorded. (c) The hand keeps a ~40% overlap between cards
even down to three cards in a 1041px-wide row, so a hand that could fan out
completely still hides half of each card. Dark mode and 375×812 both
looked fine for Cribbage — no overflow, nothing clipped, the whole table
fits.

- Type: cosmetic

### Cribbage — what felt good

The **discard tray** is the best interaction in either new pack this round:
tapping a card lifts it into a staging row with "Gathered. Tap to put it
back." — obvious, reversible, the confirm only appears once two are up.
The **peg concept itself** is right — "46 of 121, up 2" is genuinely how
cribbage players talk, it just needs to be bigger, positioned against the
rail (item 40), and given to the human too (item 39). The
**greyed-unplayable treatment** correctly narrows what's legal, it just
never says *why* (item 38). **"Go — one for Pip."** as a felt-centre pill
is exactly the right weight for a pegging event — the treatment item 36's
show wants.

### Pinochle

Played five hands across two auctions won and three passed, both themes,
both desktop and 375×812.

#### 45. Winning a trick is announced as bad news, in red, and only to the human

Every trick taken says "You take the trick — 26 points against you" in a
crimson alarm-coloured pill (`event-banner--bad`). Every trick a bot takes
says "Pip takes the trick (+15)" — same event, credited. In Pinochle
counters are the whole point of playing; there is no "against you". This is
a Hearts idiom leaking into the wrong pack, on every single trick the human
wins — nineteen tricks across three hands, all phrased this way.

- Type: bug / rules correctness / feel
- Note for triage: same root cause as Team Spades item 30, same file
  (`src/ui/celebrations.js:157`). One fix likely closes both.

#### 46. Nothing on the table says what trump is

Spades was named and the felt did not change in any way. No text, no
aria-label, no data attribute, no badge; `#contract-ladder` is empty. The
hand isn't sorted or marked to show trump either. When a bot wins the
auction it's worse: the log says only "Pip bid. Bruno bid. Sable bid." then
straight to melding — the suit is never announced at all, so on any hand
not won, trump is never learned. With must-follow-and-beat and mandatory
over-trumping, this is the one fact needed most.

- Type: bug / feel

#### 47. Declaring meld is one button and you never see your own

"Declare your meld" gives a single blue "Declare" button. Nothing to
choose, nothing to inspect, no result: press it and play starts. The
bots' melds appear as bare numbers on their seat plates — the human's
appears nowhere, ever, because the human has no seat plate. Tested
deliberately with a hand that had no meld at all (K♥ and K♣, neither
queen, nothing else): indistinguishable from declaring a good one, same
button, same silence.

- Type: feel / bug

#### 48. All three seats light up as the current player during melding

In the meld phase every seat plate simultaneously wears the gold turn
token and the gold ring — three current players at once. Presumably
because everyone declares together, but it reads as a glitch.

- Type: bug / cosmetic

#### 49. The seat plates are a row of unlabeled numbers

One plate reads "Bruno 0 12 150 —", another "Sable PARTNER 12 — —",
another "Pip 12 — —" — score, cards in hand, bid, meld — and that's only
knowable because the aria-labels say so; on screen there is nothing but
bare chips, and the count differs between seats because the score only
appears on one seat per side, so the plates don't even line up with each
other. A first-time player cannot decode any of it.

- Type: feel

#### 50. A partnership game scored one seat at a time

The round panel and the scoreboard both list four players individually.
The human's partner shows "0" for the round and "682" for the total —
every round, all four rounds, +0. The whole side's score is credited to
one seat and the totals are shared, which puts a flat contradiction on
screen: a partner who "scored nothing" four times running with 682
points. Should be two rows, one per side.

- Type: feel / bug
- Note for triage: also visible in the same screenshot — one side went
  −100 in round 2, set on a 100 bid, and nothing anywhere announced it, no
  message, no banner, just a negative number in a table you have to go
  looking for.

#### 51. The auction asks a lot and tells you nothing

Bidding opens a grid of up to twenty-one buttons (Pass, then 100 through
300 in tens). It never says what the current high bid is or who holds it
— the only clue is a gold chip on somebody's plate, and once two seats
have bid, *both* their chips are gold, so the leader can't be told. Then,
having won it, the trump prompt reads "Choose a suit to play it in" — "it"
has no antecedent, and this is naming trump, not choosing a suit to play
something in. The four options are plain word buttons — no pips, no
red/black, none of the pack's own card rendering that round-3 item 6 built
for exactly this moment. Through the whole trump step the status bar still
says "Your bid".

- Type: feel / cosmetic / bug

#### 52. You can't tell who played what in a trick, and the gather is a mess

The trick is a fan of cards in the centre with a count badge and no owner
attribution at all — with a partner at the table, "is my side winning
this trick?" is unanswerable without remembering the play order. When the
fourth card lands the trick clears immediately; the four cards are never
held together for a beat. The gather animation that replaces it is a card
scaled to roughly twice hand size with ghost copies trailing down across
the hand, and it draws on top of the event banner, cutting the message in
half mid-word.

- Type: feel / bug / cosmetic

#### 53. At phone width the third opponent is off the table

375×812 turns the seat row into a horizontal carousel (671px of content in
a 332px viewport) and one seat's plate is entirely off-screen — in a
four-handed partnership game you need all three at once. The rest holds up
better than expected: the twelve-card hand compresses to 46px cards on a
16px stride, rank and suit stay readable, playable ones lift clear, and
there's no page overflow. But the trick zone loses its "Trick" caption to
a count, and there's a large empty band of felt between the trick and the
hand at every width.

- Type: feel

#### 54. Low confidence: one side ran away with it while playing badly on purpose

Across four hands the playtester clicked the first legal card every single
time and passed most of the auction; that side still finished 682 to 153.
Four rounds isn't much evidence, but it was consistent — the opposing pair
got set once and never got close otherwise. Worth a `--vs --match`
measurement before anyone tunes anything.

- Type: feel

### Pinochle — what felt good

The **greyed-unplayable treatment** correctly narrowed to a single legal
card under must-beat. **Dark mode** is clean; the table is a table in
either theme and nothing broke. The **How to play** copy is the clearest
rules text in the repo — "the ten between king and ace," "a meld is
scored, not laid down," "make it and your side banks the lot, miss it and
you lose the whole bid instead." It explains everything the felt itself
doesn't (items 46, 47, 49).

<!-- Next items go here. -->

