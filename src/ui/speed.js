// HOW FAST A CARD CROSSES THE FELT — the player's own answer.
//
// "The current gameplay flashes cards too fast for me to see properly"
// (#175, from a playtest). The number behind that sentence is `botDelayMs`,
// and from the day it shipped it has been a millisecond count in storage with
// no control anywhere: reachable by hand-editing a save, and by nothing else.
// src/ui/pace.js names the reason it never grew one — "how many milliseconds
// should a card take" is not a question anybody has an answer to — and the
// conclusion that follows from that reason is not "no control". It is named
// rungs, which is exactly what SKILL_LEVELS and PACE_LEVELS already are for
// the two settings sitting beside it on the same sheet.
//
// ONE SETTING, NOT TWO. `botDelayMs` drives both halves of how fast a card
// moves — the pause before a bot commits (`thinkTimeMs`, src/players/roster.js)
// and the flight that follows it (`flightDurationMs`, src/ui/flight.js) — and
// flight.js argues the case for keeping them joined better than this file
// could: "slower bots" already means "I want longer to watch this", and
// spending all of it on think time is a bot that sits there for a second and
// then teleports its card. So these rungs are values OF THAT ONE NUMBER.
// There is no second key, the stored shape is unchanged, and nothing in the
// arithmetic moved.
//
// A NUMBER ON DISK THAT RUNGS POINT AT, which is the one place this differs in
// shape from `pace` and `botDifficulty` and the difference is deliberate.
// `botDelayMs` is read by two modules that do arithmetic on it, and neither
// should have to learn that this list exists. So the rungs carry numbers, and
// `speedForDelay` reads a number back to the rung it belongs to — which is
// what keeps a hand-edited 700, or a save written before these rungs were
// chosen, working and still lighting a button.
//
// A DATA MODULE, for the reason src/ui/difficulty.js and src/ui/pace.js are
// both one: everything that renders this list (src/ui/newGame.js for the
// sheet's row, src/ui/table.js for the status bar's chip) reaches for
// `document` at import time, so no Node test can load one and ask what the
// game offers. The list is the part worth pinning — add a rung and
// tests/speed.test.js fails until a player can actually pick it.
//
// ORDERED FASTEST TO SLOWEST, which is the opposite direction to the pace row
// beside it, and the reason is the status bar's chip rather than the sheet.
// That chip cycles forward on a tap, and the player who reaches for it has
// just watched a card they could not follow. The rung after the one they are
// on has to be the SLOWER one, or the first tap answers the complaint
// backwards.

import { flightDurationMs } from './flight.js';

/**
 * `delayMs` is the whole of the setting: it is what gets written to
 * `botDelayMs`, and every consequence is arithmetic somebody else does on it.
 *
 * THE FLIGHT DURATION IS NOT STORED HERE, because two copies of one piece of
 * arithmetic is one copy too many — ask `flightDurationMs` (it is re-exported
 * below as `flightMsFor` so a caller need not import two modules to label a
 * rung). What the four rungs come to today is 260 / 420 / 595 / 700 ms, and
 * tests/speed.test.js pins each one against the real function.
 *
 * THE TWO ENDS LAND ON FLIGHT.JS'S OWN FLOOR AND CEILING, on purpose: 350
 * clamps to FLIGHT_MIN_MS, the 260 the playtest set as "too fast to notice but
 * right behind a fast bot", and 1100 clamps to FLIGHT_MAX_MS. So the ladder
 * walks the entire scale that module already declares is worth having, rather
 * than stopping short of both ends of it. 600 is untouched in the middle —
 * today's behaviour, byte for byte, for anyone who never taps this.
 *
 * The prose is about THE CARD rather than about the opponent, even though the
 * same number moves both: what is being chosen here is how long you get to
 * watch. "The opponent thinks harder" is the Opponents row's promise
 * (src/ui/difficulty.js) and must not be made twice.
 */
export const SPEED_LEVELS = Object.freeze([
  Object.freeze({
    id: 'snappy',
    label: 'Snappy',
    delayMs: 350,
    description: 'Cards snap across the felt. Nothing sits still between moves.',
  }),
  Object.freeze({
    id: 'brisk',
    label: 'Brisk',
    delayMs: 600,
    description: 'A card crosses quickly, with enough of a trip to see who played it.',
  }),
  Object.freeze({
    id: 'gentle',
    label: 'Gentle',
    delayMs: 850,
    description: 'Every card takes a longer trip, and the table waits a beat before each one.',
  }),
  Object.freeze({
    id: 'slow',
    label: 'Slow',
    delayMs: 1100,
    description: 'The slowest the felt goes. Nothing crosses it faster than you can follow.',
  }),
]);

/** The shipped rung. Its `delayMs` is SETTINGS_DEFAULTS.botDelayMs, exactly. */
export const DEFAULT_SPEED = 'brisk';

/**
 * The rung `id` names, or the default one.
 *
 * Tolerant exactly like `paceLevel` and `skillLevel`, and for the same reason:
 * this is handed ids that came off a saved setting by way of `speedForDelay`,
 * or straight out of the new-game sheet's own state, and a rung that was
 * rolled back must render as the default rather than as a blank row.
 */
export function speedLevel(id) {
  return SPEED_LEVELS.find((level) => level.id === id)
    || SPEED_LEVELS.find((level) => level.id === DEFAULT_SPEED);
}

/**
 * The rung a stored `botDelayMs` belongs to.
 *
 * NEAREST, NOT EXACT, and that is the point of storing a number at all: a save
 * hand-edited to 700, or written by a build whose ladder had different treads,
 * still lights a button and still plays at exactly the speed it says. The rung
 * is a label for what is already happening, and the value only snaps to a tread
 * when the player actually taps. A tie goes to the faster rung, which is the
 * earlier one in the list and so falls out of the reduce below.
 *
 * DEFENDED THE WAY `flightDurationMs` AND `thinkTimeMs` ARE, because this reads
 * the same value out of the same storage: a non-number, a zero, a negative and
 * a NaN are not slow tables, they are nonsense, and nonsense means the shipped
 * rung rather than a card that never arrives or one that never leaves.
 */
export function speedForDelay(botDelayMs) {
  const ms = Number(botDelayMs);
  if (!Number.isFinite(ms) || ms <= 0) return speedLevel(DEFAULT_SPEED);
  return SPEED_LEVELS.reduce((best, level) => (
    Math.abs(level.delayMs - ms) < Math.abs(best.delayMs - ms) ? level : best));
}

/** The rung a tap on the status bar's chip moves to, wrapping round. */
export function nextSpeed(id) {
  const i = SPEED_LEVELS.indexOf(speedLevel(id));
  return SPEED_LEVELS[(i + 1) % SPEED_LEVELS.length].id;
}

/**
 * How long a card flies at this rung — the one arithmetic, asked rather than
 * copied. Here so that a surface labelling a rung imports one module, not two.
 */
export function flightMsFor(level) {
  return flightDurationMs(level?.delayMs);
}
