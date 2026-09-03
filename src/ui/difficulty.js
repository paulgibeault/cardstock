// WHAT THE THREE SETTINGS MEAN, IN A PLAYER'S WORDS.
//
// The dial itself is `DIFFICULTIES` in src/engine/bot.js and it is described
// there in the engine's own terms: easy is the heuristic the game shipped with,
// medium adds a ply of lookahead, hard samples worlds consistent with what the
// seat knows and plays each candidate out in them. None of that is a sentence
// anybody wants to read before a card game, so the felt's names for the same
// three things live here.
//
// A DATA MODULE RATHER THAN MARKUP, and the reason is testability. The sheet
// that renders this (src/ui/newGame.js) reaches for `document` at import time,
// so no Node test can load it — the same wall tests/repo-gates.test.js
// documents for src/ui/table.js. The LIST is the part worth pinning, so it
// lives in a file a test can import: add a fourth difficulty to the engine and
// tests/difficulty.test.js fails until the sheet can offer it, rather than the
// setting existing with no way for anybody to pick it.
//
// Easy first, because the row reads as a ramp and the engine's own order says
// the same thing.

/**
 * The `id` is the engine's, verbatim — it is what reaches `chooseBotMove` and
 * what is persisted as `botDifficulty` (src/arcade/storage.js).
 *
 * The prose is deliberately about WHAT THE OPPONENT DOES rather than about
 * search: "thinks about the hand it cannot see" is a promise a player can
 * check against how the game feels, and "flat Monte Carlo over determinized
 * worlds" is not.
 */
export const SKILL_LEVELS = Object.freeze([
  Object.freeze({
    id: 'easy',
    label: 'Easy',
    description: 'Plays the first good card it sees. Kind to a game you are still learning.',
  }),
  Object.freeze({
    id: 'medium',
    label: 'Steady',
    description: 'Looks one move ahead and picks the position it likes best.',
  }),
  Object.freeze({
    id: 'hard',
    label: 'Sharp',
    description: 'Plays the hand out in its head first — guessing at your cards, never reading them.',
  }),
]);

/** The level `id` names, or the default one, so a stale saved value cannot render a blank row. */
export function skillLevel(id) {
  return SKILL_LEVELS.find((level) => level.id === id) || SKILL_LEVELS[1];
}
