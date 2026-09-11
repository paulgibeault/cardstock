# Thirteen (Tiến lên) — rules, and what a pack of it needs

The source of truth for the rules a `thirteen` pack implements, written
before the manifest so the arguments happen here rather than in JSON. Section
1 is the game. Section 2 is every rule real tables disagree about, each with
the default this pack takes. Section 3 is the honest part: **this game does
not fit any of the four templates**, and says what the fifth one owes.
Section 5 reads all of that back against the rest of the roadmap —
Pinochle, team Spades, cribbage and poker — and moves two decisions
because of them.

Nothing here is code yet. `packs/thirteen/` deliberately does not exist —
`tests/repo-gates.test.js` holds `packs/index.json` to set-equality with the
directories on disk, so a pack folder appears the day its manifest does.

---

## 0. Which game this is

**Tiến lên** ("go forward"), the Vietnamese national card game, known in
English as **Thirteen**, **VC**, or **Killer 13**. Thirteen cards each, four
players, a standard 52 — the deck comes out exactly even, which is why the
name is the hand size.

It is a **climbing** (or shedding-by-combination) game: the same family as
Big Two / Choi Dai Di, President / Scum / Asshole, and Zheng Shangyou. That
family matters — see §3, where the case for building a template rather than a
pack rests on it.

Not to be confused with **Thirteen** the solitaire (a Pyramid variant). If
somebody says "13" at a table with four chairs, it is this.

---

## 1. The game

### 1.1 Deck, deal, seating

* Standard 52. No jokers.
* Four players, thirteen cards each, whole deck dealt.
* Play passes **counter-clockwise** (see D-1).

### 1.2 The ladder — the rule everything else is built on

Rank, low to high:

```
3  4  5  6  7  8  9  10  J  Q  K  A  2
```

The **2 is the highest card in the game** (the "pig", *heo*), and the 3 is the
lowest. This is not the standard-52 ladder, and it is not a rotation of it
either — the ace sits below the two, so the sequence is the usual ladder with
the 2 lifted from the bottom to the top.

**Suits break every tie**, low to high:

```
♠ spades  <  ♣ clubs  <  ♦ diamonds  <  ♥ hearts
```

So the ordering over the whole deck is **total**: 3♠ is the single lowest
card and 2♥ the single highest, and no two cards are equal. That totality is
load-bearing. "Higher, or pass" is the only rule in the game, and a tie would
be a position with no legal answer and no legal refusal.

> Suit-as-tiebreak is new to this codebase. `rankOrder` in
> [src/engine/cards.js](src/engine/cards.js) is rank-only and, on standard-52,
> not even injective — see §3.4.

### 1.3 Combinations

A play is one of these. Nothing else is a play.

| Combination | Shape | Compared by |
|---|---|---|
| **Single** | 1 card | the card |
| **Pair** (*đôi*) | 2 of a rank | the higher of the two cards |
| **Triple** (*sám cô*) | 3 of a rank | the highest of the three |
| **Run** (*sảnh*) | 3+ cards in consecutive rank, suits mixed | the highest card |
| **Four of a kind** (*tứ quý*) | 4 of a rank | the rank |
| **Consecutive pairs** (*đôi thông*) | 3+ pairs in consecutive rank | the highest card |

Two rules about runs carry all the weight:

* **A 2 may never appear in a run**, or in consecutive pairs. The ladder ends
  at the ace for sequence purposes. `Q-K-A` is a run; `K-A-2` is not, and
  `A-2-3` is not (there is no wrap — the 3 is the bottom). The two halves of
  that sentence are separate rules at a real table, and the pack now states
  them separately (D-13): `rules.runExcludes` for runs, `rules.stripExcludes`
  for consecutive pairs.
* **A run only beats a run of the same length.** A five-card run does not beat
  a four-card run; it is simply not a legal answer to it.

The same "same shape, same size" rule governs everything: a pair answers a
pair, a triple answers a triple, a four-card run answers a four-card run.
The one exception is the bomb, which is the whole flavour of the game.

### 1.4 Bombs (*chặt* — "to chop")

A bomb is a combination that may be played **out of shape**, on somebody
else's turn-to-answer, to kill a 2. This is the game's signature move, and
the reason holding a 2 is not the free win the ladder suggests.

The chopping ladder, low to high:

```
three consecutive pairs  <  four of a kind  <  four consecutive pairs  <  five consecutive pairs
```

What each may chop:

| Bomb | Beats out of shape |
|---|---|
| Three consecutive pairs | a single 2 |
| Four of a kind | a single 2, a pair of 2s, three consecutive pairs |
| Four consecutive pairs | a single 2, a pair of 2s, three of the above and any four of a kind |
| Five consecutive pairs | all of the above, and four consecutive pairs |

Two things follow that people get wrong at the table:

* **A bomb played as a chop can itself be chopped.** Chopping a pig with a
  four of a kind does not end the trick; the next player may chop your chop
  with four consecutive pairs, or with a higher four of a kind.
* **A bomb may also just be led**, as an ordinary combination of its own
  shape. Led that way it is answered by the same shape, higher — a four of a
  kind led is answered by a higher four of a kind, not by three consecutive
  pairs. The chopping ladder is only the out-of-shape ladder.

Consecutive pairs, like runs, **may not contain a 2**: `A-A K-K Q-Q` is three
consecutive pairs, `2-2 A-A K-K` is not a bomb at all.

### 1.5 A trick

1. The leader plays any legal combination.
2. In turn, each other player either **passes** or plays a strictly higher
   combination of the same shape and size — or a legal bomb (§1.4).
3. **A pass.** Two tables, two rules, and the pack ships the weaker one on by
   default (D-12): a pass only skips your turn and you are asked again when
   the play comes back round. Switch off "Passing keeps you in the trick" for
   the strict rule, where a pass puts you out of that trick for good and you
   may not re-enter even if the play comes back around below you.
4. When everybody else has passed, the last player to have played takes the
   trick, clears the table, and leads the next one, free to lead anything.

A player with no cards left is simply skipped; the trick continues among
whoever still has cards and has not passed.

### 1.6 The first lead, and later ones

* **First hand of a match:** the holder of the **lowest card in play** leads,
  and the combination they lead **must contain it** (see D-2). It may be the
  bare single, or that card inside a pair, a run, anything legal. At a full
  table the lowest card in play is the 3♠ and this is the rule everybody
  states; short-handed the deal leaves a third or a half of the deck out of
  play (D-11) and the 3♠ is frequently not among the cards dealt at all, so
  the rule has to be written as what it means rather than as the card it
  usually names. The manifest says `firstLead.card: "lowest"`.
* **Later hands:** see D-3.

### 1.6a Two-handed: three hands on offer

Two players do not deal thirteen each — that would leave twenty-six of the
fifty-two cards unseen by anybody, which is half the pigs and half the bombs
simply not turning up. Instead the whole pack goes into **three face-down
hands of seventeen**, with the odd card set aside, and each player **takes
one**; the third hand sits out (D-14). Thirty-four cards in play instead of
twenty-six, and the deal becomes a decision rather than something that happens
to you.

The player who **lost the previous hand picks first**, which is the other half
of D-3's bargain: the winner gets the lead, the loser gets first choice of
pile. The first hand of a match is a coin toss, because at that point nobody
is holding anything for a rule to be written over. Once both hands are
chosen the ordinary first-lead rule applies to them — the lowest card of the
thirty-four in play leads, and it is the 3♠ about two thirds of the time.

### 1.7 Winning

The first player to shed all thirteen cards has *tiến lên* — gone forward —
and wins. Play continues among the rest for second, third, and last; the
player left holding cards is the loser, and in the social game that is the
position everybody is actually playing to avoid.

---

## 2. Every rule tables disagree about

Tiến lên is a folk game and its rules are regional. Each decision below gets
this pack's **default**, and the ones worth offering become manifest
`variants` — a named JSON patch the host toggles before the deal
(`schema/manifest.schema.json` `$defs.variant`). A variant whose rule the
template does not implement yet ships `available: false`, which declares the
intent without offering a switch that changes nothing.

| # | Question | Default here | Why |
|---|---|---|---|
| **D-1** | Turn direction | **counter-clockwise** | The traditional Vietnamese direction. Cosmetic for solo-vs-bots, but it is a real fact about the game and the seat ring should honour it. |
| **D-2** | Must the first lead contain the lowest card? | **yes** | Removes the whole first-lead decision from hand one and is the near-universal rule. Worth a variant for the casual "lead anything" table. The card is named as `"lowest"` rather than as `spades-3`, because at 2 and 3 seats (D-11) the 3♠ is often not dealt — half the deck is never dealt at two seats and a quarter of it at three, and the card is out of play in 50.7% and 25.8% of deals over 400 seeded deals each — and a nominated card that is out of play names no seat, so the lead fell to the rotating opening seat, which on hand one is the human. |
| **D-3** | Who leads later hands | **the previous hand's winner** | The alternative — the holder of 3♠ leads every hand — is played, but rewards the deal rather than the play. |
| **D-4** | Can you win by playing a 2? | **yes** | The "no ending on a pig" rule is a real house rule and a good variant, but it turns a won position into a trap in a way that needs the UI to warn about it. |
| **D-5** | Pair/triple comparison | **by highest card, suit included** | `9♥9♦` beats `9♣9♠`. Follows from the total order (§1.2); the alternative (rank only, ties impossible in practice for triples) is a special case nobody needs. |
| **D-6** | Does four of a kind beat a **pair** of 2s? | **yes** | The commonest Southern rule. Some tables require four consecutive pairs for a pair of pigs; a variant. |
| **D-7** | Do runs of unequal length compare? | **no** | Same-length only. Universal enough to be a rule, not a variant. |
| **D-8** | Instant wins on the deal (*tới trắng*) | **off, shipped as a variant** | Four 2s; six pairs; a 3-to-A dragon run; five consecutive pairs; three consecutive triples. Fun, but it ends a hand before anybody plays — which is the wrong first impression from the lobby. Off by default, on by switch. |
| **D-9** | Scoring | **one point per card left, paid to the winner** | The simplest thing that is really played, and it maps onto the existing `scoring` block. See below. |
| **D-10** | Pig/bomb penalties (*thúi heo*) | **off, deferred** | Being caught holding a 2 or an unspent bomb costs extra. Real, but it is a second scoring vocabulary; it should follow the first playable build, not lead it. |
| **D-11** | Player counts other than 4 | **2 and 3 supported; 3 deals 13 each with the remainder out of play, 2 deals for the pick (D-14)** | 3 players leaves 13 cards unseen, which is genuinely how it is played short-handed. Solo-vs-bots means 4 is what almost everybody will see. |
| **D-12** | Passing out of a trick | **you stay in, shipped as a variant that is ON** | §1.5.3. Somebody asked. The strict rule is still the pack's `rules.passIsFinal: true`; the variant `pass-stays-in` patches it to `false`, ships `default: true`, and is what a new table gets — a pass skips your turn and the play comes back round to you. The strict rule is one toggle away, and a resumed match keeps whichever it was dealt under. |
| **D-13** | Can a 2 end a run? | **no, shipped as a variant that is OFF** | §1.3. `Q-K-A-2` is a widely played house rule; `2-2 A-A K-K` as a bomb-eligible strip is not, and neither is a 3-to-2 dragon. One exclusion list could not tell those apart, so the pack declares `runExcludes` and `stripExcludes` separately and the variant `two-tops-runs` empties only the first. The run still never wraps (`A-2-3` is not a run), the strip is untouched, and the instant-win dragon is measured against the ranks *both* lists allow, so it stays 3-to-A under either reading. |
| **D-14** | The two-handed deal | **three face-down hands of 17, pick one each; loser picks first** | §1.6a. A flat thirteen each leaves 26 of the 52 unseen, and at two seats that is the difference between a game of Thirteen and a shuffle. `rules.offer: { atSeats: 2, piles: 3 }`; the pile size is derived (deck ÷ piles) so it cannot disagree with the deck, and the odd card plus the pile nobody takes go face down and out of play — hidden rather than discarded, because a discard is public and the bot reads it. Hand one's pick order is a **coin toss** off the match's own seed: "the player who does not hold the lowest card picks first" reads well and cannot be built, since at hand one the pick happens before anybody holds a card, and the rotating opening seat is seat 0 on round one, which is the human. The compensation is D-2's, which already exists: whichever pile you take, the lowest card in play leads. |

### Scoring, concretely

`scoring.defaultValue: 1` per card, `roundScore: "hand-values-to-winner"` —
the strategy Crazy Eights already uses — with `accumulate: true` and a
`gameOver` threshold. Two things to settle when the manifest is written:

* **The threshold.** Crazy Eights plays to 100 with `winner: "highestScore"`
  (points are the prize). Here points are the **penalty**, so `gameOver`
  wants `winner: "lowestScore"` — and per `src/templates/CONTRACT.md`, that
  choice is also what tells the `hard` bot which way is up. Getting it
  backwards ships a bot that plays to lose and nothing else in the repo
  notices.
* **Whether a hand is a match.** A single deal is a satisfying game of
  Thirteen on its own. A first build that plays one hand to a winner and
  stops is honest; the accumulating match is the second step.

---

## 3. What the platform does not have yet

### 3.1 None of the four templates fit

`shedding` is the near miss, and it is not close. Its whole model is *one
card, matched against the top of the discard on an attribute* —
`matchOn: ["suit", "rank"]`, `getActiveValue`, `cardMatchesActive`. Thirteen
plays **sets of cards compared as a unit against the previous set**, with no
attribute matching anywhere in it. Parameterising `shedding` into this would
mean a second, disjoint code path behind a flag, sharing the word "discard"
and nothing else.

`trick-taking` is the second-nearest and is wrong in the ways that matter:
its tricks are fixed-length (one card per seat), everybody plays, and follow-
suit is the constraint. Thirteen's tricks are variable-length, a pass is
permanent, and the seats that act shrink as the trick goes on.

So: **a fifth template, `climbing`.** Per the extension policy in
`CARD_PLATFORM_DESIGN.md` §13, a whole genre is the case where a new template
is right rather than a parameter — and the genre is real, not a template of
one game. Big Two, President/Scum and Zheng Shangyou are the same engine with
different combination tables and different ladders.

Per `src/templates/CONTRACT.md`, a fifth template is **a new file in
`src/templates/` plus one entry in `registry.js`**, and nothing else. It
starts life absent from `TEMPLATE_INFO`, which gets it the neutral genre
word, vanilla card art and a Preview badge — which is exactly the right way
in.

### 3.2 The four hard parts, named in advance

* **A total card order with a suit tiebreak.** New to the codebase (§1.2,
  §3.4). **This belongs in the ENGINE, not in this template** — see §5.
  The first draft of this file put it in `climbing` as a `rankLadder` /
  `suitLadder` parameter, on the strength of Big Two wanting the same
  mechanism with a different suit order. That was too small a claim. Pinochle
  ranks the ten between the king and the ace, poker needs the ace at both ends,
  cribbage needs it at the bottom — four games across three templates, plus
  the two live bugs in §3.4 and §5.2. By the §13 policy's own third step,
  something multiple templates need is an engine primitive.

* **Enumerating legal moves without exploding.** `enumerateLegalMoves` is the
  contract's single source of what anybody may do — bots pick from it and
  every tap target is derived from it. From a thirteen-card hand the space of
  *subsets* is 8,191. The space of **legal combinations** is far smaller and
  is what must be enumerated: group by rank for pairs/triples/quads, scan
  sorted distinct ranks for run and consecutive-pair windows. `trick-taking`
  already faced this and wrote down its budget (see the "thirteen-choose-
  three is 286 moves" note at [src/templates/trick-taking.js:153](src/templates/trick-taking.js:153));
  the same discipline applies, and the answer for an *answering* seat is much
  smaller still, because the led shape and size fix it.

* **The interaction mode.** Thirteen is multi-select-then-commit. The
  vocabulary in `src/ui/interaction.js` has `pass` (select exactly N, commit)
  and `rummy-meld`; neither is it — the count is not fixed and the legality
  of a selection is a live question the felt should answer as cards go in. A
  new mode, and the CONTRACT is explicit that the *vocabulary* is the
  platform's while *which phase means which mode* is the template's.

* **A trick where seats drop out.** `actingSeats` exists on the contract for
  exactly this shape of problem. A passed seat is out until the trick clears,
  and the felt's turn token has to agree with that, not with a plain
  round-robin.

### 3.3 What the bot needs, in the contract's terms

`botHeuristic` alone gets a bot that plays legally and badly. Thirteen's
whole skill is in shape preservation — breaking a run to answer a single is
how you lose — so `evaluateState` is where the game lives: hand size, minus
the value of the structure the position destroyed, plus control (holding the
last 2). Seat-symmetric and public-information-only, per the contract's
rules; the deliberate blindness to say out loud is that it must not read
whether an opponent can chop.

`matchStanding` can stay unimplemented: the match is decided by points, so
the default (accumulated score, signed by `scoring.gameOver.winner`) is
right — provided D-9's `lowestScore` is set correctly.

### 3.4 A bug this game walks straight into

`rankOrder` ([src/engine/cards.js:186](src/engine/cards.js:186)) tries numeric
rank first, then the position in `RANKS`. On standard-52 those two branches
produce overlapping numbers:

| Card | `rankOrder` |
|---|---|
| 9 | 9 |
| 10 | 10 |
| J | 9 |
| Q | 10 |
| K | 11 |
| A | 12 |

The jack ties with the nine and the queen ties with the ten — and the ten
outranks the jack. The comment at
[src/templates/trick-taking.js:365](src/templates/trick-taking.js:365) says
"within the led suit, every rank ladder agrees", and this is the case where
they do not: in Hearts, ♥10 played before ♥J takes the trick.

That is a Hearts bug rather than a Thirteen one, but it is the same seam.
A climbing template must not build on `rankOrder`; it needs its own total
order from a declared ladder, which is §3.2's first bullet.

---

## 4. The shape of the pack, once the template exists

```
packs/thirteen/
  manifest.json          declarations only — no logic.js
  tests/rules.test.json  the given-state/this-move-is-legal table
```

No `deck.json` — `standard-52` is the deck, unmodified. No `logic.js`: if the
template is right, there is nothing left for a hook to do, and a pack with
code in it is the smell that a template parameter is missing.

Sketch of the `rules` block, to be schema'd against a new
`$defs.rules-climbing`:

```json
{
  "rankLadder": ["3","4","5","6","7","8","9","10","J","Q","K","A","2"],
  "suitLadder": ["spades", "clubs", "diamonds", "hearts"],
  "deal": 13,
  "combinations": ["single", "pair", "triple", "run(3+)", "consecutive-pairs(3+)", "quad"],
  "runExcludes": ["rank:2"],
  "matchShape": "same-type-same-size",
  "bombs": [
    { "shape": "consecutive-pairs(3)", "beats": ["single:rank:2"] },
    { "shape": "quad",                 "beats": ["single:rank:2", "pair:rank:2", "consecutive-pairs(3)"] },
    { "shape": "consecutive-pairs(4)", "beats": ["single:rank:2", "pair:rank:2", "consecutive-pairs(3)", "quad"] },
    { "shape": "consecutive-pairs(5)", "beats": ["*"] }
  ],
  "passIsFinal": true,
  "firstLead": { "card": "spades-3", "mustInclude": true },
  "laterLead": "trick-winner",
  "winner": "first-empty-hand"
}
```

**Every key in there has to be read by something in `src/`.** The gate in
`tests/repo-gates.test.js` greps for exactly that, and it exists because
`playAfterDraw` and eleven others sat in manifests describing behaviour that
was hardcoded elsewhere, for a whole playtest cycle. A declared parameter
nobody reads is a lie the schema tells.

### Rule tests to write first

The ones that would catch a wrong build, in the order they are worth writing:

1. `K-A-2` is not a run; `Q-K-A` is.
2. A four-card run is not a legal answer to a three-card run.
3. `9♥9♦` beats `9♣9♠`; `9♣9♠` does not beat `9♥9♦`.
4. Three consecutive pairs chops a single 2 and does **not** chop a pair of 2s.
5. Four of a kind chops the three consecutive pairs that just chopped a pig.
6. A seat that passed is offered no moves for the rest of the trick.
7. The first lead of hand one is refused unless it contains 3♠.
8. A trick clears and the last player to have played leads next.

---

## 5. What the rest of the roadmap does to this plan

Pinochle, team Spades, cribbage and poker are on the list behind this. Three
of the four want things Thirteen also wants, which moves two decisions.

### 5.1 What each game actually asks the platform for

| Game | Template | What does not exist yet |
|---|---|---|
| **Thirteen** | new `climbing` | total ladder · combination compare · multi-select-commit mode · a trick seats drop out of |
| **Team Spades** | existing `trick-taking` | **trump** · **teams** · **bidding** · bags |
| **Pinochle** | existing `trick-taking` | trump · teams · bidding · a 48-card double deck · the 9-J-Q-K-10-A ladder · must-beat-if-able · a meld-scoring phase |
| **Cribbage** | new `cribbage` | running total to 31 · a combination *scoring* vocabulary · the crib · a board that is not cards · two-handed play |
| **Poker** | new | **chips and wagering** · pot and side pots · betting rounds · a hand evaluator · moves that move no cards |

Verified against the tree, not assumed: `trump` appears **nowhere** in
`src/templates/trick-taking.js` despite its row in the design doc's §13.1
table — the template is no-trump today. `team`, `partner`, `bid` and `chip`
appear nowhere in `src/` at all. Scoring is seat-keyed end to end
(`{seat: delta}`, `src/engine/scoring.js`). Multi-copy card definitions
already work (Milestones ships `count: 2`), so Pinochle's double deck is the
one thing on that table the platform can already do.

### 5.2 The ladder is an engine primitive

Four of the five games want a declared rank order, and it is a *different*
order in each:

| | Ladder |
|---|---|
| Thirteen | `3 … A 2` |
| Pinochle | `9 J Q K 10 A` |
| Poker | `2 … A`, and the ace low again in a wheel |
| Cribbage | `A 2 … K`, ace low |

It also fixes two live bugs rather than only serving future work: `rankOrder`
collides J with 9 and Q with 10 (§3.4), and `rankDomain`
([src/templates/melds.js:77](src/templates/melds.js:77)) builds its run domain
from `Number(card.rank)` alone, so **face cards are not in any run window** —
invisible today only because Milestones ships a deck ranked 1–12.

So: one declared order per pack, resolved once in `src/engine/cards.js`, with
suits as an optional tiebreak. It is the piece to build first, it is small,
and it is the only part of the Thirteen work anything else on the list reuses.

### 5.3 Teams and bidding are trick-taking's, and Spades should buy them

Spades and Pinochle both need teams, trump and bidding, and **both sit on the
template that already exists**. By the §13 policy that is two games needing
the same thing on one template — template parameters, in `trick-taking`, not
a new genre. The design doc already predicted the bidding half: "*bidding is
the template's first planned extension*" (§13.1).

Teams are the one that reaches further than its template: seat-keyed scoring,
`matchStanding`, the view layer's per-seat filtering, the seat ring's
placement of a partner opposite you, and a bot that must play *with* somebody
without reading their hand. That is engine surface, and it is worth doing
once, deliberately, rather than twice.

**Build Spades before Pinochle.** Pinochle is then Spades plus a meld phase,
a ladder value and a `count: 2` deck — rather than a first pack carrying
three new capabilities and a scoring phase at once.

### 5.4 Thirteen still goes first, for a reason that is not sentiment

`src/templates/CONTRACT.md` claims a fifth template costs "a new file in
`src/templates/` plus one entry in `registry.js`, and nothing else." **That
claim has never been tested.** All four templates predate the contract that
describes them, so it is a statement about code that was reverse-engineered,
not a promise anything has kept.

Two of the five games on the roadmap need new templates. Finding out what a
fifth one really costs is worth more now, on the game whose rules are already
written down, than it will be later underneath cribbage.

### 5.5 Poker is the outlier, and should be priced as one

Everything else here is a card game the platform nearly plays. Poker is a
**wagering** game: the cards are the smaller half, and the half that decides
it — chips, a pot, blinds, raise/call/fold, all-in and side pots — has no
analogue anywhere in the repo, and nothing else on the roadmap would reuse
it. It also wants per-seat state that survives the hand, which today only
contract-rummy's per-player contract does.

The variant matters more than for any other game on the list. **Five-card
draw** is close to the existing shape (deal, discard, redraw, showdown) and
its only genuinely new pieces are the evaluator and the betting. **Texas
hold'em** adds community-card zones, dealer-button rotation and positional
blinds, and its betting rounds are a phase machine of their own. Those are
not the same project.

Two things to settle before it is scheduled at all, neither of them
technical: whether bots that bet make a good solo game (a weak Hearts bot is
still a game; a weak poker bot is a slot machine), and whether a wagering
game belongs on the arcade's shelf next to Crazy Eights.

### 5.6 The order this argues for

1. **The ladder primitive**, standalone — small, and it lands two bug fixes.
2. **Thirteen** — tests the fifth-template claim while its rules are fresh.
3. **Team Spades** — buys trump, teams and bidding on a template that exists.
4. **Pinochle** — spends all three again, and adds only the meld phase.
5. **Cribbage** — a template of one; worth it, but priced honestly as that.
6. **Poker** — after the variant question is answered, and the two above it.

---

## Credits

Traditional Vietnamese game, public domain. The rules above are the mainstream
Southern (*Tiến lên Miền Nam*) ruleset; regional differences are §2.
