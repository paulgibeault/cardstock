// Who is at the table — the single answer to "who is seat N", for every
// surface that has to say so (seat plates, score sheets, the game-over panel,
// the head-to-head record, and eventually a peer roster).
//
// NOTHING ELSE FORMATS A NAME. That is the whole point: the table used to
// build `Bot ${seat}` inline in three places, and the moment a real name
// arrives — the player's own, or a peer's — an interpolated template string is
// the peer-name XSS this fleet has shipped twice (design doc §17.8). This
// module returns DATA. Every caller renders it with textContent.
//
// WHY THE OPPONENTS ROTATE FOR FREE. The bots at a table are picked by a
// seeded shuffle of the roster, and the seed is the MATCH seed — already
// persisted, already the thing replay re-derives everything else from. So a
// new game deals new opponents, a resumed game re-seats the same ones, and not
// one byte was added to the save format to make that true.
//
// The shuffle runs on its own generator (`bots:<seed>`), never on
// `state.rng` — drawing from the match stream here would shift every card
// dealt after it and desync any log written by a build with a different
// roster length.
//
// DOM-FREE AND NODE-CLEAN. The human's display name is a PARAMETER, not an
// `Arcade.player.name()` call, so this module imports cleanly under
// `node --test` (design doc §17.10) and the tests can pin the seating.

import { createRng } from '../engine/rng.js';

/**
 * How a bot plays, as weights rather than as code.
 *
 * A persona is NOT a second bot. The template's `botHeuristic` stays the whole
 * domain brain — it is the thing that knows what a good Hearts lead is — and
 * these numbers only shape how that brain's own ranking is consumed
 * (src/engine/bot.js). That split is what keeps a personality from being able
 * to make an illegal or nonsensical move.
 *
 *   aggression      tilts scoring toward committing a card rather than
 *                   drawing/passing (1 = the heuristic's own opinion)
 *   patience        the same tilt, in favour of drawing and holding
 *   mistakeRate     chance of taking a near-best move instead of the best
 *   callReliability chance of remembering to declare the last card (§E2)
 *   catchAttention  chance of noticing YOUR missed declaration
 *   tempoMs         how long they sit there thinking, min..max
 *
 * `mistakeRate` and `tempoMs` are consumed OUTSIDE the reducer (a rendered
 * table's bot driver), never inside it, so their randomness cannot desync a
 * replay: replay re-applies the logged move, it never re-runs the chooser.
 */
export const PERSONAS = Object.freeze({
  steady: {
    id: 'steady',
    label: 'plays it straight',
    aggression: 1, patience: 1, mistakeRate: 0.04,
    callReliability: 0.92, catchAttention: 0.6, tempoMs: [550, 1050],
  },
  cautious: {
    id: 'cautious',
    label: 'never wastes a card',
    aggression: 0.7, patience: 1.35, mistakeRate: 0.06,
    callReliability: 0.95, catchAttention: 0.75, tempoMs: [700, 1400],
  },
  aggressive: {
    id: 'aggressive',
    label: 'swings first',
    aggression: 1.45, patience: 0.6, mistakeRate: 0.1,
    callReliability: 0.8, catchAttention: 0.85, tempoMs: [340, 760],
  },
  reckless: {
    id: 'reckless',
    label: 'has never read the rules twice',
    aggression: 1.7, patience: 0.45, mistakeRate: 0.22,
    callReliability: 0.55, catchAttention: 0.4, tempoMs: [240, 620],
  },
  cunning: {
    id: 'cunning',
    label: 'is counting your cards',
    aggression: 1.15, patience: 1.1, mistakeRate: 0.02,
    callReliability: 0.97, catchAttention: 0.95, tempoMs: [620, 1500],
  },
  dreamy: {
    id: 'dreamy',
    label: 'is thinking about something else',
    aggression: 0.85, patience: 1.2, mistakeRate: 0.18,
    callReliability: 0.5, catchAttention: 0.22, tempoMs: [900, 1900],
  },
});

export const DEFAULT_PERSONA = PERSONAS.steady;

/**
 * The cast. Twelve so a three-seat table can be dealt many times before a
 * face repeats, and so the set reads as a room of regulars rather than as
 * "Bot 1, Bot 2".
 *
 * `icon` is an emoji on purpose: zero assets to ship, zero third-party art in
 * the repo, and it renders identically in the seat plate, the score sheet and
 * the stats panel. `color` is an OWN value — it reaches an inline style and
 * must never come from anything a manifest can influence (§7b).
 */
export const BOT_ROSTER = Object.freeze([
  { id: 'juniper', name: 'Juniper', icon: '🦊', persona: 'cunning', color: '#b0603a' },
  { id: 'marlow', name: 'Marlow', icon: '🦉', persona: 'cautious', color: '#4a6b8a' },
  { id: 'pip', name: 'Pip', icon: '🐇', persona: 'reckless', color: '#7a5aa8' },
  { id: 'delphine', name: 'Delphine', icon: '🦢', persona: 'steady', color: '#3a8a8a' },
  { id: 'otto', name: 'Otto', icon: '🐻', persona: 'aggressive', color: '#8a5a2f' },
  { id: 'wren', name: 'Wren', icon: '🐦', persona: 'dreamy', color: '#4a7a4e' },
  { id: 'cass', name: 'Cass', icon: '🐈', persona: 'cunning', color: '#8a3a63' },
  { id: 'bruno', name: 'Bruno', icon: '🦡', persona: 'steady', color: '#5a6a8a' },
  { id: 'nell', name: 'Nell', icon: '🦋', persona: 'dreamy', color: '#a8823a' },
  { id: 'sable', name: 'Sable', icon: '🐺', persona: 'aggressive', color: '#6b4a4a' },
  { id: 'fig', name: 'Fig', icon: '🦔', persona: 'cautious', color: '#5f7a3a' },
  { id: 'rook', name: 'Rook', icon: '🐦‍⬛', persona: 'reckless', color: '#4a4a5f' },
]);

const BOTS_BY_ID = new Map(BOT_ROSTER.map((b) => [b.id, b]));

/** The human's colour, kept beside the bots' so the palette is one list. */
const HUMAN_COLOR = '#2f6fb0';

/** The fallback seat, used only when a stored/unknown bot id turns up. */
const UNKNOWN_BOT = Object.freeze({
  id: 'unknown', name: 'Guest', icon: '🂠', persona: 'steady', color: '#6b7280',
});

/**
 * `count` distinct bot ids for a match, chosen deterministically from its seed.
 *
 * Same seed → same opponents, which is what makes a resumed game re-seat the
 * players it had. Different seed → a different table, which is the rotation.
 */
export function pickBotIds(seed, count) {
  const ids = createRng(`bots:${seed}`).shuffle(BOT_ROSTER.map((b) => b.id));
  const out = [];
  for (let i = 0; i < count; i++) out.push(ids[i % ids.length]);
  return out;
}

/** One bot's static card, or the fallback when the roster no longer has it. */
export function botById(botId) {
  return BOTS_BY_ID.get(botId) || UNKNOWN_BOT;
}

export function personaOf(botId) {
  return PERSONAS[botById(botId).persona] || DEFAULT_PERSONA;
}

/**
 * The opponent id a head-to-head record is filed under.
 *
 * Namespaced from the first write so a peer slots in beside a bot with no
 * migration: `bot:juniper` today, `peer:<deviceId>` when Phase 8 lands
 * (design doc §17.4 — deviceId is the stable identity).
 */
export function opponentKey(identity) {
  if (!identity || !identity.isBot) return null;
  return `bot:${identity.botId}`;
}

/** Two initials, for a face that has no emoji (an unknown bot, or the human). */
export function initialsOf(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim();
  if (!cleaned) return '??';
  const words = cleaned.split(/\s+/);
  return (words.length > 1
    ? words[0][0] + words[1][0]
    : cleaned.slice(0, 2)).toUpperCase();
}

/**
 * Everyone at the table, indexed by seat.
 *
 * @param seed        the match seed — the rotation's only input
 * @param seats       how many seats the match has
 * @param humanSeat   which one is the player (null for an all-bot table)
 * @param humanName   the player's display name, already resolved by the caller
 *                    (`Arcade.player.name()` in the browser; a literal in tests)
 * @returns Array<{ seat, name, shortName, icon, initials, color, isBot,
 *                  botId, persona, tagline, opponentKey }>
 */
export function buildSeating(seed, seats, { humanSeat = 0, humanName = '' } = {}) {
  const botSeats = [];
  for (let s = 0; s < seats; s++) if (s !== humanSeat) botSeats.push(s);
  const botIds = pickBotIds(seed, botSeats.length);

  const out = [];
  for (let seat = 0; seat < seats; seat++) {
    if (seat === humanSeat) {
      const name = String(humanName || '').trim() || 'You';
      out.push(Object.freeze({
        seat,
        name,
        // The status line stays second-person ("Your turn") whatever the name
        // is; sheets and stats use the name itself.
        shortName: 'You',
        // A MARKER, not a face. Wherever players are shown as pips — the
        // contract ladder, a score row — the opponents wear their own emoji
        // and the player needs something equally glanceable. Initials do not
        // work: the fallback name is "You", which abbreviates to the
        // nonsense "YO", and even a real name gives two letters that read as
        // just another opponent. A star is unmistakably "me".
        icon: '★',
        initials: initialsOf(name),
        color: HUMAN_COLOR,
        isBot: false,
        botId: null,
        persona: null,
        tagline: '',
        opponentKey: null,
      }));
      continue;
    }
    const bot = botById(botIds[botSeats.indexOf(seat)]);
    const persona = PERSONAS[bot.persona] || DEFAULT_PERSONA;
    const identity = {
      seat,
      name: bot.name,
      shortName: bot.name,
      icon: bot.icon,
      initials: initialsOf(bot.name),
      color: bot.color,
      isBot: true,
      botId: bot.id,
      persona,
      tagline: `${bot.name} ${persona.label}.`,
      opponentKey: `bot:${bot.id}`,
    };
    out.push(Object.freeze(identity));
  }
  return out;
}

/**
 * A per-turn think time for `identity`, scaled by the player's own bot-speed
 * preference so the setting still means what it always did (600 ms = 1×).
 */
export function thinkTimeMs(identity, baseDelayMs = 600, random = Math.random) {
  const [lo, hi] = identity?.persona?.tempoMs || DEFAULT_PERSONA.tempoMs;
  const scale = Math.max(0.1, (Number(baseDelayMs) || 600) / 600);
  return Math.round((lo + random() * (hi - lo)) * scale);
}
