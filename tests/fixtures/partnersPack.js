// A TWO-SIDE TRICK-TAKING PACK THAT DOES NOT SHIP.
//
// Partnerships (#104) are engine surface — scoring, standings, the felt, the
// bot — built before either game that needs them (Team Spades #105, Pinochle
// #106). Testing them against a real pack would mean shipping a game to test a
// primitive, and testing them against Hearts would mean giving Hearts sides it
// does not have. So the fixture lives here, in the test tree, and is loaded
// through the ordinary `loadPack` door so that everything it exercises is the
// same code a shipped pack runs through.
//
// IT IS DELIBERATELY THE SIMPLEST PARTNERSHIP GAME THAT CAN EXIST: follow suit,
// highest card of the suit led wins the trick, and every card in the trick
// COSTS the side that took it a point. There is no trump, no bidding and no
// bags — all three are #105's, and putting them here would mean this file had
// to be right about them before anything read it.
//
// POINTS ARE A PENALTY, which is a choice about the TEMPLATE rather than about
// partnerships. `trick-taking`'s `evaluateState` is written for the game the
// template actually ships (Hearts): it prices a won pile as a bill. Declaring
// `highestScore` here would hand the bot an evaluator pointed the wrong way and
// every bot assertion below would be measuring that instead of the fold. Points
// as the prize is #105's — it arrives with `bids-and-bags`, which is the
// scorer that means it.
//
// The arithmetic is what makes it a good probe. Fifty-two cards at a point each
// is fifty-two points a hand, twenty-six to a side if the sides break even, so
// a target of thirty is reached in the second hand BY A SIDE and in the fourth
// or fifth BY A SEAT. A game-over test that folds the wrong way does not fail
// subtly here; it plays twice as long.

/**
 * The manifest. A plain object rather than a file on disk: `packs/` is the
 * lobby's own directory (`packs/index.json` mirrors it, and a repo gate says
 * so), and a fixture in there would be a sixth game on the shelf.
 */
export const PARTNERS_MANIFEST = Object.freeze({
  id: 'fixture-partners',
  name: 'Partners',
  version: '0.0.1',
  players: { min: 4, max: 4, best: 4, teams: 2 },
  deck: 'standard-52',
  template: 'trick-taking',
  tagline: 'Two chairs, one score.',
  accent: '#2f6f4f',
  heroCards: [
    { rank: 'A', suit: 'spades' },
    { rank: 'K', suit: 'hearts' },
    { rank: 'Q', suit: 'clubs' },
  ],
  rules: {
    followSuit: 'must',
    firstLead: 'clubs-2',
  },
  scoring: {
    // Every card costs a point to whoever took the trick it was in, so a side's
    // score is simply how many cards its two chairs won between them.
    cardValues: { '*': 1 },
    defaultValue: 1,
    roundScore: 'penalty-cards-taken',
    accumulate: true,
    gameOver: { when: 'anyScore >= 30', winner: 'lowestScore' },
  },
});

/** The same manifest with its sides removed — the teamless control. */
export const SOLO_MANIFEST = Object.freeze({
  ...PARTNERS_MANIFEST,
  id: 'fixture-solo',
  name: 'Every seat for itself',
  players: { min: 4, max: 4, best: 4 },
});
