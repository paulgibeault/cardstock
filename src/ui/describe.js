// Saying what a card or a pile IS, in words.
//
// One place, because the same sentence is needed in three registers and they
// must not drift apart: the inspector panel reads it on hover, the screen
// reader reads it from an aria-label, and the pile's own badge is what is left
// when the words move off the felt.
//
// THAT LAST POINT IS THE UX ASK, AND IT HAS A TRAP IN IT. "Card stats on hover
// replacing the need for draw/discard labels" is right about the visual noise —
// a table that spells out "Draw (24)" under every pile is louder than a real
// one — but hover DOES NOT EXIST on touch, and a tooltip is invisible to a
// screen reader. So what actually moves into the inspector is the WORDS; the
// count stays on the felt as a badge, and the full sentence stays in the
// accessible name. Nothing is only-on-hover.
//
// Pure and DOM-free: these return data, callers render it with textContent.

import { cardValue } from '../engine/scoring.js';
import { makeCtx } from '../engine/context.js';
import { winDirection } from './scoreDirection.js';

const SUIT_GLYPH = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };

/**
 * "hearts" → "Hearts". Exported because src/ui/rules.js had a second copy, and
 * it lives HERE rather than in a DOM helper module because this file is
 * deliberately DOM-free (see the header) and the rules page is its only other
 * reader.
 */
/**
 * What this table calls the seat the person reading it is sitting in.
 *
 * A literal in `seatLabel` (src/ui/table.js) until it needed a second reader.
 * Exported so the possessive rule below and the table agree by construction
 * rather than by both happening to spell it the same way.
 */
export const SECOND_PERSON = 'You';

/**
 * A seat label in the POSSESSIVE — "Your hand", "Delphine's hand".
 *
 * THE ONE IRREGULAR CASE IS THE ONE THAT MATTERS. Every seat label at this
 * table is a proper noun and takes an apostrophe-s, except the local player's,
 * which is the pronoun "You" and takes "Your". A template building
 * `${seatLabel(seat)}'s hand` therefore reads correctly for every opponent and
 * says "You's hand is worth 2." to the person actually playing — which shipped
 * in #107 and is visible in that issue's own screenshot.
 *
 * Deliberately NOT a general English pluraliser. A name ending in `s` takes a
 * bare apostrophe by some style guides and `'s` by others, and players type
 * their own names; guessing there would trade a bug that is always wrong for
 * one that is sometimes wrong and much harder to see. This handles the case
 * that has a single right answer and leaves proper nouns alone.
 */
export function possessive(label) {
  return label === SECOND_PERSON ? 'Your' : `${label}'s`;
}

/**
 * A verb that AGREES with a seat label — "You peg 3", "Nell pegs 3".
 *
 * The same irregularity as `possessive`, one part of speech over, and it
 * shipped the same way: cribbage's `describeEvent` wrote `${seatLabel(seat)}
 * pegs ${n}`, which is right for every opponent at the table and says "You pegs
 * 3" to the person playing (#124, item 41). Every seat label here is a proper
 * noun and takes the third-person -s except the local player's, which is the
 * pronoun "You" and takes the bare form.
 *
 * Deliberately not a conjugator. It appends `s`, which is right for every verb
 * a felt has said out loud so far (peg, score, lead, win); a verb that inflects
 * any other way should be written out at both call sites rather than guessed at
 * here — the same bet `possessive` makes about names ending in `s`.
 */
export function agrees(label, verb) {
  return label === SECOND_PERSON ? verb : `${verb}s`;
}

export function titleCase(word) {
  const s = String(word || '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const RANK_WORD = {
  A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack',
};

/** "Queen of Spades", "Red 7", "Wild" — what a player would call it out loud. */
export function cardName(card) {
  if (!card) return 'Card';
  const rank = card.rank == null ? '' : String(card.rank);
  const spoken = RANK_WORD[rank] || rank;
  if (card.suit) return `${spoken || 'Card'} of ${titleCase(card.suit)}`;
  if (card.color) return `${titleCase(card.color)} ${spoken}`.trim();
  return titleCase(spoken) || 'Card';
}

/** What an effect does, in one sentence, or null when the card is plain. */
export function effectText(effect) {
  if (!effect) return null;
  const type = typeof effect === 'string' ? effect : effect.type;
  const n = (typeof effect === 'object' && effect.n) || 0;
  const choose = (typeof effect === 'object' && effect.choose) || 'suit';
  if (type === 'skip') return 'Skips the next player.';
  if (type === 'reverse') return 'Reverses the direction of play.';
  if (type === 'drawN') return `The next player draws ${n} and loses their turn.`;
  if (type === 'wild') return `Wild — you choose the ${choose} to continue with.`;
  if (type === 'wildDrawN') return `Wild — choose the ${choose}; the next player draws ${n}.`;
  if (type === 'skipTarget') return 'Choose a player to skip.';
  if (type === 'swapHands') return 'Swap hands with a player of your choosing.';
  if (type === 'rotateHands') return 'Every hand moves round in the direction of play.';
  return 'Has a special effect.';
}

/**
 * Everything worth knowing about one card, for the inspector.
 *
 * The point value is THIS PACK's — resolved through the same selector map the
 * round scorer uses — so a Queen of Spades reads 13 in Hearts and 10 in Crazy
 * Eights without either pack writing help text.
 *
 * @returns { title, lines: [{label, value}], notes: [string] }
 */
export function describeCard(card, pack) {
  const lines = [];
  const notes = [];
  if (!card) return { title: 'Card', lines, notes };

  if (card.suit) lines.push({ label: 'Suit', value: titleCase(card.suit) });
  if (card.color && !card.suit) lines.push({ label: 'Colour', value: titleCase(card.color) });
  if (card.rank != null) lines.push({ label: 'Rank', value: String(card.rank) });

  const scoring = pack?.scoring;
  if (scoring) {
    const points = cardValue(card, scoring);
    lines.push({ label: 'Points', value: String(points) });
  }

  const effect = effectText(card.effect);
  if (effect) notes.push(effect);
  const tags = Array.isArray(card.tags) ? card.tags.filter((t) => t !== 'wild') : [];
  if (tags.length) notes.push(`Tagged ${tags.join(', ')}.`);

  return { title: cardName(card), lines, notes };
}

/**
 * The full sentence a screen reader hears for a card.
 *
 * "WORTH 1" IS A CLAIM ABOUT WHICH WAY IS UP, and at a penalty-scored pack it is
 * the wrong way round: nothing in Thirteen is worth anything until you are
 * caught holding it, and every card in the hand announcing itself as worth
 * something reads as a prize (#122, round-5 item 26). Which way is up is
 * `winDirection`'s answer and nobody else's (#121) — and it deliberately
 * declines to answer for a pack whose template owns the ending, so those keep
 * the neutral wording rather than being guessed at.
 */
export function cardAriaLabel(card, pack, { position, of } = {}) {
  const { title, lines, notes } = describeCard(card, pack);
  const where = position ? `, position ${position}${of ? ` of ${of}` : ''}` : '';
  const points = lines.find((l) => l.label === 'Points');
  const n = points ? Number(points.value) : 0;
  const worth = !points ? ''
    : winDirection(pack) === 'lowestScore'
      ? `, ${points.value} penalty point${n === 1 ? '' : 's'} if you are caught with it`
      : `, worth ${points.value}`;
  return `${title}${worth}${where}.${notes.length ? ` ${notes.join(' ')}` : ''}`;
}

/**
 * What a pile is and what is true of it right now.
 *
 * `reactions` is read straight off the state so the draw pile can say that it
 * recycles from the discard — the manifest already declares that (design doc
 * §3) and nobody should have to learn it by watching the pile run out.
 */

/**
 * The value the whole table is playing to, if the open pack has one.
 *
 * ASKED OF THE TEMPLATE (`activeMatch`), because the `activeSuit`/`activeColor`
 * var convention belongs to shedding and this file used to reverse-engineer it:
 * it read `state.vars.activeSuit || state.vars.activeColor` by name, then
 * derived an attribute back OUT of a var name to find out whether the top card
 * could show the value for itself. Three files spelled that convention three
 * different ways.
 */
function activeMatchOf(state) {
  return state.pack.template.activeMatch?.(makeCtx(state)) ?? null;
}

/**
 * The LIVE part of a pile, where a template has one: which of the cards in it
 * are the thing being answered, and what that thing is called.
 *
 * Asked of the template rather than derived here, for the same reason
 * `activeMatch` is: a pile that accumulates a whole trick is a rules fact, and
 * only the rules know which tail of it is still standing (climbing's `combo`).
 * Every other zone in every other pack answers null and is unaffected.
 */
export function zoneFocusOf(state, address) {
  const focus = state.pack.template.zoneFocus?.(makeCtx(state), address) ?? null;
  if (!focus || typeof focus.label !== 'string' || !focus.label) return null;
  return { label: focus.label, cards: Array.isArray(focus.cards) ? focus.cards : [], seat: focus.seat };
}

export function describeZone(state, { def, n, address }) {
  const count = state.zones.count(address);
  const title = `${def.label || titleCase(def.id)}${n != null ? ` ${n}` : ''}`;
  const lines = [{ label: 'Cards', value: String(count) }];
  const notes = [];

  // The standing combination goes FIRST and in words: on a pile holding a whole
  // trick, "Cards: 4" is true and useless, and the shape is the only thing a
  // player is reading the pile for.
  const focus = zoneFocusOf(state, address);
  if (focus) {
    lines.unshift({ label: 'To beat', value: focus.label });
    notes.push(`${focus.label} is standing — beat it or pass.`);
  }

  if (def.capacity != null) lines.push({ label: 'Holds', value: `${count} of ${def.capacity}` });
  if (def.visibility === 'top') notes.push('Only the top card is face up.');
  else if (def.visibility === 'none' || def.facing === 'down') notes.push('Face down.');

  for (const reaction of state.reactions || []) {
    if (reaction.do !== 'recycle') continue;
    const pattern = reaction.when.slice(reaction.when.indexOf(':') + 1);
    if (pattern !== def.id && pattern !== address) continue;
    notes.push(`Refilled from the ${reaction.from} pile when it runs out.`);
  }

  const match = activeMatchOf(state);
  if (match && match.address === address) {
    lines.push({ label: 'Active', value: titleCase(match.value) });
    // A wild leaves the table matching on something its own face does not
    // show, so that becomes a NOTE rather than only a line — notes are what
    // reach the pile's accessible name (zoneAriaLabel), and a player who
    // cannot see the swatch on the badge has no other way to learn it.
    if (!match.onCard) notes.push(`Now matching ${titleCase(match.value)}.`);
  }

  return { title, lines, notes };
}

/**
 * The compact badge left on the felt once the words move to the inspector.
 *
 * A PILE WITH CARDS IN IT INTRODUCES ITSELF; AN EMPTY ONE CANNOT. That was the
 * whole rule, and it went one step too far: the name was DROPPED the instant a
 * card landed, so a table with two spread piles in the middle showed one wearing
 * `2` and one wearing `28` and nothing saying which was which (#122, round-5
 * item 18 — the same complaint Cribbage's "Starter" makes in #124). "You can see
 * what it is" holds for a draw pile and not for a row of look-alike stacks.
 *
 * So the name STAYS and the count joins it: `name` beside the number, the name
 * first, because the name is what tells you which pile you are looking at and
 * the number is what changes. A pile whose count IS its identity is untouched —
 * a capacity pile still reads `3/4`, and an active-suit badge is still the rule
 * in force drawn big, with no name in front of it.
 *
 * A pile with a FOCUS — a standing combination the rest of it is history to
 * (`zoneFocus`) — wears the focus's own words instead of a count, because on
 * that pile the count is the trick and the words are the play.
 *
 * Returns `{ text, kind, suit, name }` rather than a bare string. `kind` is how
 * loud the badge should be — 'count' and 'name' are labels, 'focus' is the thing
 * the pile is currently asking of you, 'match' is the suit or colour the table
 * is playing to — `suit` is the four-suit name behind a 'match' glyph when there
 * is one, and `name` is the pile's own word to set beside a count.
 */
export function zoneBadge(state, { def, n, address }) {
  const count = state.zones.count(address);
  const name = `${def.label || titleCase(def.id)}${n != null ? ` ${n}` : ''}`;
  const named = () => ({ text: name, kind: 'name' });
  if (count === 0) {
    // The empty slot already reads as zero; the word is the missing half.
    return named();
  }
  const focus = zoneFocusOf(state, address);
  if (focus) return { text: focus.label, kind: 'focus', name };
  if (def.capacity != null) return { text: `${count}/${def.capacity}`, kind: 'count', name };
  // ONE CARD IS NOT A COUNT WORTH PRINTING. The rule above is that a pile with
  // cards in it introduces itself — you can see what it is — and that rule
  // stops being true at the bottom of the range: a badge reading "1" under a
  // single card says nothing the card has not already said, and it costs the
  // pile its name. Cribbage's cut card is the case that made it visible (#124,
  // item 44): "Starter" — the one word explaining why that card is face up
  // beside the deck and counted in everybody's hand — became "1" the instant it
  // was turned, and stayed "1" for the rest of the hand.
  //
  // BELOW the match check on purpose: a Crazy Eights discard holds exactly one
  // card on the opening lead, and the suit in force is the loudest thing on the
  // felt at that moment. The name only wins where there is no rule to print.
  const match = activeMatchOf(state);
  if (match && match.address === address) {
    // `kind: 'match'` is what lets the caller draw this one BIG. Everywhere else
    // the badge is a number you glance at; here it is the rule in force — what
    // the whole table must play to — and a 0.72rem pill said that in the same
    // voice as a card count. Own the glyph, hand the styling decision over
    // rather than making it here: this module stays DOM-free (see the header).
    //
    // hasOwn, not a bare lookup: the value comes from a PACK's own var, and on
    // a plain object a pack setting it to "constructor" would resolve to a
    // function and stringify the whole thing into the badge.
    const suit = Object.hasOwn(SUIT_GLYPH, match.value) ? match.value : null;
    return { text: suit ? SUIT_GLYPH[suit] : titleCase(match.value), kind: 'match', suit };
  }
  if (count === 1) return named();
  return { text: String(count), kind: 'count', name };
}

/** The accessible name for a pile — the words the badge no longer shows. */
export function zoneAriaLabel(state, inst) {
  const { title, lines, notes } = describeZone(state, inst);
  const count = Number(lines.find((l) => l.label === 'Cards')?.value ?? 0);
  return `${title}, ${count} ${count === 1 ? 'card' : 'cards'}.`
    + (notes.length ? ` ${notes.join(' ')}` : '');
}
