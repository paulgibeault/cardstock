# The new-games feedback plan

Playtest feedback from 2026-09-07 (round 5 in
[FEEDBACK_INBOX.md](FEEDBACK_INBOX.md), items 18–54), triaged against the
code. The four packs that shipped in the games workstream (#100) — Thirteen,
Team Spades, Cribbage, Pinochle — went out with no playtest pass at all, so
this is the first one. Two playtesters, one per pair of packs, each playing
many hands through the real felt (not reading source) and screenshotting
every claim.

**The headline: the rules engines are solid.** Follow-suit, lead
constraints, must-beat, trump resolution, scoring, bags, melds — every one
of these checked out correct under play. Almost everything found is about
*reading the table*: the felt tells you what your opponents are doing and
stays quiet about your own hand's half of the story. That is a narrower,
more tractable problem than "the new games have bugs," and it clusters into
six pieces of work below — two platform fixes worth doing first because
each closes the same gap in three or four packs at once, and four per-pack
passes.

## Triage summary

| Cluster | Items | Packs | Size | Root cause found | Status |
|---|---|---|---|---|---|
| A — Round summary arrives after the next round is dealt | 21, 32, 36 | Thirteen, Spades, Cribbage | S | yes — `awaitFinalLook` only wraps match end | open |
| B — Scoring narration assumes points are bad | 20, 30, 45 | Thirteen, Spades, Pinochle | S | yes — two functions read raw score, never `gameOver.winner` | open |
| C — Thirteen: the pile is unlabeled, staging is silent | 18, 19, 22, 23, 24, 26 | Thirteen | M | yes — reproduced live | open |
| D — Team Spades: the trick vanishes, your own numbers don't exist | 27, 28, 29, 31, 33, 34 | Team Spades | M | yes — reproduced live | open |
| E — Cribbage: the board, the crib and the count are invisible | 37, 38, 39, 40, 41, 42, 43, 44 | Cribbage | L | yes — one confirmed bug (item 40), rest reproduced live | open |
| F — Pinochle: trump, meld and the side score are invisible | 46, 47, 48, 49, 50, 51, 52, 53, 54 | Pinochle | L | yes — reproduced live | open |

Clusters A and B are platform code shared by every pack that uses it — fix
each once, it likely helps Hearts and Milestones too (not verified this
round; worth a quick audit while in the file). C through F are independent
of each other and of A/B in principle, but each touches at least one file A
or B also touches (`celebrations.js`, the round-panel code), so land A and B
first and let C–F rebase.

## A — The round summary arrives after the next round is already dealt

Three packs, same shape, one root cause. Confirmed against the source:
`offerFinalLook` (`src/ui/table.js:2789`) wraps *match* end in a beat —
`awaitFinalLook`, measured against the flight duration, so the winning card
is seen before the results panel opens (round-3 item 7). Round end has no
equivalent: `showRoundSummary` sets `el.roundOverlay.hidden = false`
(`src/ui/panels.js:102`) straight off the round-ending move, with nothing
holding back the *next* deal. By the time a player reads "Round 4 over,"
their new hand is already on the felt behind the panel and the button
("Deal round 5") is promising something that already happened.

- **Thirteen** (item 21): the round-over panel sits over a freshly dealt
  hand and an already-advanced turn indicator.
- **Team Spades** (item 32): same shape, more visible — the status bar
  behind the panel already reads "Bruno is bidding…".
- **Cribbage** (item 36): the sharpest case. The whole show — pone's hand,
  dealer's hand, the crib, three separate score reveals — resolves in
  under 140ms and the next hand is dealt before a player can read any of
  it. This is the one item the playtesters flagged as the single biggest
  finding of the round.

The fix is one mechanism, reused: hold the round-ending move behind a beat
(or a sequence of beats, for Cribbage's three-part show) the way
`offerFinalLook` already does for the match, and don't advance `roundNumber`
/ redeal until it's acknowledged or timed out. Cribbage's show needs the
richest version — pone, then dealer, then crib, each with its own pause,
matching the order the rules doc already specifies, not just one combined
beat.

**Acceptance:** all three packs' round transitions leave the ending hand's
final state on screen for a beat before the next deal is visible;
Cribbage's show reveals in three readable steps, not one flash; a quick
pass confirms Hearts and Milestones either already do this or get the same
fix.

## B — Scoring narration assumes points are bad

Two functions, one assumption, three symptoms:

- `targetSentence` (`src/ui/panels.js:114`) computes the match's leader
  with `Math.max(...sideScores(...))` and reports "First to N wins — X to
  go" unconditionally. For a `lowestScore` pack (Thirteen's `anyScore >=
  50`, and Hearts' `anyScore >= 100` shares the function, not verified
  live) the *leader* by raw score is the seat closest to **losing** — so
  the sentence tells a player racing toward 50 that they're making
  progress, when 50 is how the match ends with them behind (item 20).
- The trick-taken banner (`src/ui/celebrations.js:157`) hardcodes
  `` ev.points > 0 ? `You take the trick — N points against you` : 'Trick
  is yours — no points' `` — written for Hearts, where taking points is
  bad, and applied unconditionally to every trick-taking pack. Team Spades
  (item 30) and Pinochle (item 45) both score tricks as the *goal*, and
  Pinochle's version renders in the alarm-red `event-banner--bad` tone on
  every trick the human wins.

Both places already have the fact they need close by: `scoring.gameOver`
declares `winner: "lowestScore" | "highestScore"`, and #105's bot work
built exactly this direction-read once already (`prizeSign` in
`src/templates/trick-taking.js`, "which way is up is the pack's, and an
evaluator must read it" — CONTRACT.md). The UI narration never got the
equivalent. This is a correctness bug, not a feel nit: the sentence is
flatly false for three shipped packs.

**Acceptance:** `targetSentence` and the trick-taken banner both read
`scoring.gameOver.winner` (or an equivalent per-pack signal) and describe
progress in the direction that pack actually plays; a rule test or two
pins the sentence for a `lowestScore` and a `highestScore` pack each; Hearts
and Milestones checked to still read correctly.

## C — Thirteen: the pile is unlabeled, staging is silent

Six items, most of them different faces of "the table doesn't say what
state you're reacting to":

- **The pile you must beat has no label and the wrong contents** (item 18):
  the live-trick stack accumulates every card played, not the current
  combination, and both piles lose their names the instant they hold a
  card. The hint already ring-highlights the exact card being beaten
  (item 25) — doing that unprompted, or labelling the last combination
  directly, is the fix.
- **The Pass button is silently replaced** (item 19): selecting a card
  swaps `#action-button` for `#hand-sort` in the same rail slot, so a tap
  aimed at "Pass" reshuffles the hand instead. An illegal selection (a
  non-combination) offers no feedback of any kind — no commit button, no
  refusal, no Pass.
- **No lead/win signal** (item 22): the only evidence a trick ended and
  play returned to you is the pile emptying; the event banner can go stale
  for several of your own turns.
- **Hand spacing and z-order at both densities** (item 23): a five-card
  hand still uses the thirteen-card overlap with a thousand pixels of
  unused felt on either side, and a lifted card buries its neighbour; at
  375px the exposed strip per card is 14px.
- **375px layout** (item 24): ~480px of empty felt between the seats and
  the hand; the direction badge overlaps a seat plate; score and
  cards-left pills are visually identical.
- **Smaller** (item 26): results panel leads with move-count trivia
  instead of the scores that decided the match; every card's aria-label
  says "worth 1" regardless of value; the `seats=` URL param may not seat
  four players (worth confirming); no bomb was observed in ten dealt
  rounds, so that path is still unverified live.

**Acceptance:** the pile you're answering is named and shows only the
current combination; the rail's action slot never silently changes meaning
under a selected card, and an illegal selection says so; a trick win is
announced before the pile clears; the five-card hand and the 375px layout
are re-measured and no longer clamp/overlap unnecessarily.

**Out of scope:** the enumeration/bomb mechanics themselves — this is
presentation only, per #102/#103's existing coverage of the rules.

## D — Team Spades: the trick vanishes, your own numbers don't exist

Six items:

- **The fourth card of a trick never renders** (item 27): traced
  frame-by-frame across six tricks, the pile goes 1→2→3→0 and sweeps
  before the deciding card is ever shown; a card also briefly renders
  blank (`card-face--fresh`) or twice during landing.
- **Your own bid is displayed nowhere** (item 28): not on your seat area,
  not in the round summary, not in the scoreboard — checked against the
  full rendered page text.
- **"Won N" is a card count wearing a trick count's clothes** (item 29):
  it climbs in fours next to a bid that's in tricks.
- **Bags are invisible** (item 31): they accumulate correctly (verified
  against the score deltas) but the word never appears on the table, only
  in the How-to-play text two clicks away.
- **The bid dialog on a phone** (item 33): the hand you're bidding on sits
  behind the dialog as unreadable slivers, and the partner/third seat are
  clipped by the carousel with no visible way to check them before
  committing to a number.
- **The hand desaturates for 3 of every 4 turns** (item 34): correct
  legality signal, but it's the *only* one, and at 375px it's nearly
  unreadable.

**Acceptance:** a completed trick is visible with all four cards for a
beat before it sweeps; the human's own bid is shown somewhere on the felt
and in the round/scoreboard; the won-pile counter reads in tricks or is
clearly labelled as cards; bags have a visible running count; the bid
dialog is reachable at 375px with the partner and third seat checkable
before committing.

**Out of scope:** the bidding heuristic and the `hard` rollout weakness —
that's #114, already filed and already known to be a separate, deeper
problem in the bot layer, not the felt.

## E — Cribbage: the board, the crib and the count are invisible

The largest cluster, and it contains the one item confirmed as a hard
rendering bug rather than a missing affordance:

- **The peg walks off the board** (item 40) — **confirmed math error**:
  the peg's `left` is a percentage of the whole track container, which
  includes the printed score number after the rail, rather than a
  percentage of the rail itself. At 118/121 the peg sits on top of the
  "118" text, past every hole on the rail. This is the one item in the
  whole round that is unambiguously a bug and not a design gap.
- **The crib zone renders as permanently empty** (item 37) — also a
  correctness bug: the zone's own accessible name says "0 cards" while the
  engine (confirmed against `packs/cribbage/tests/rules.test.json`) has
  put four cards there. Whatever the felt is binding to, it isn't the
  `crib` zone.
- **The human has no board at all** (item 39): the opponent's seat plate
  carries the peg rail (with a genuinely good aria label: "46 of 121, up
  2"); the human gets a bare number in the status bar.
- **No running count anywhere** (item 38): reaching 17 mid-play means
  doing the arithmetic in your head; the played-card piles fade older
  cards toward invisibility, so even reconstructing it by eye is hard.
- **Narration says how much but not what or who** (item 41): a peg score
  never says whether it was a fifteen, a run or a thirty-one; the crib's
  own score is never announced at all; "his nobs" never appears despite
  being in the tagline; "You pegs 3" should be "You peg 3".
- **Whose crib arrives too late to matter** (item 42): only appears on the
  confirm button, after both cards are already picked.
- **The round panel's mystery column** (item 43): an unlabeled number that
  read 0 for both players in every round observed.
- **Smaller** (item 44): a pile's label is replaced by its count as soon
  as it holds a card, so "Starter" becomes "1"; the match observed ending
  122–118 though the target is 121; hand overlap stays at ~40% even down
  to three cards in a row with plenty of width to spare.

**Acceptance:** the peg position is computed against the rail's own
dimensions and stays on the board at every score; the crib zone visibly
holds and reveals its cards; the human's own peg is visible somewhere on
the table; the running count is shown during play; the show (once cluster
A's timing fix lands) narrates each score with what it was, including the
crib and his-heels/his-nobs; whose crib it is is known before the discard
is made, not after.

**Out of scope:** the scoring math itself (`cribbage-score.js`) — already
swept over the full hand distribution in #107 and not in question here.

## F — Pinochle: trump, meld and the side score are invisible

Nine items, all variations on "the engine knows and the felt doesn't say":

- **Trump is never displayed** (item 46): no text, no badge, no aria
  attribute anywhere on the table after the suit is named; when a bot wins
  the auction the suit is never announced in the log at all.
- **Your own meld is never shown** (item 47): a single "Declare" button
  with no feedback either way — a hand with real meld and a hand with none
  produce the identical experience.
- **Three seats show the turn token at once during melding** (item 48) —
  a cosmetic bug, presumably from the simultaneous-commit phase reusing a
  single-actor turn indicator.
- **Seat plates are unlabeled number rows** (item 49): score/hand/bid/meld
  distinguishable only through aria-labels, and the plates don't even line
  up with each other since the score appears on one seat per side.
- **The partnership score is credited to one seat** (item 50): a partner
  shows "0" every round while the total climbs — the felt's own numbers
  contradict each other on screen. A side going −100 on a set bid is
  announced nowhere.
- **The auction gives no context** (item 51): no visible current-high-bid,
  no visible leader once two seats have both gone gold; the trump chooser
  reads "Choose a suit to play it in" (broken referent) and uses plain
  text buttons instead of the pack's own card rendering (the same debt
  round-3 item 6 paid off for the wild/suit chooser, not yet paid here);
  the status bar still says "Your bid" through the whole trump step.
- **The trick has no owner attribution and the gather covers the banner**
  (item 52): can't tell who played what without remembering play order; the
  gather animation draws over the event banner mid-message.
- **375px drops the third opponent off-screen entirely** (item 53): a
  four-seat partnership game needs all three other seats reachable, and
  the carousel doesn't guarantee it.
- **Low-confidence balance signal** (item 54): a deliberately-bad-play side
  still won 682–153 across four hands — not evidence on its own, but worth
  a `--vs --match` measurement before anyone tunes the bot further.

**Acceptance:** trump is visible on the table from the moment it's named,
whoever named it; the human's own meld declaration is shown, including the
"nothing to declare" case; the meld phase's turn indicator doesn't mark
three seats at once; the partnership score reads as one number per side,
not four numbers where two are always zero; the auction shows the current
high bid and its holder; the trump chooser uses the pack's card rendering
and a complete sentence; the trick shows who played what.

**Out of scope:** re-tuning the bot — item 54 is a flag for measurement,
not a request to touch weights; #106 already recorded Pinochle's bot as at
parity with `easy` rather than ahead of it, and this cluster doesn't change
that finding either way.

## What's deliberately left out of every cluster above

- **Item 26's `seats=` URL param** and **item 44's 121-vs-122 scoring
  question** are noted as "not confirmed against source" by the
  playtesters — worth a five-minute look when in the relevant file, not
  worth their own issue.
- **The harness artifact** (a Playwright actionability timeout mistaken
  for a dropped tap, Team Spades round) is explicitly not a finding —
  recorded in the inbox only so it isn't rediscovered and chased again.
- **#114** (Team Spades' `hard` bot losing to `easy`) is a known, already-filed,
  separate problem in the rollout layer. Nothing in this plan touches it,
  and nothing here should be read as covering it.
