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
import { baseId } from '../engine/selectors.js';

const SUIT_GLYPH = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };

function titleCase(word) {
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

/** The short form that fits in a corner or a chip: "Q♠", "7". */
export function cardShortName(card) {
  if (!card) return '';
  const rank = card.rank == null ? '' : String(card.rank);
  return card.suit ? `${rank}${SUIT_GLYPH[card.suit] || ''}` : rank;
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

/** The full sentence a screen reader hears for a card. */
export function cardAriaLabel(card, pack, { position, of } = {}) {
  const { title, lines, notes } = describeCard(card, pack);
  const where = position ? `, position ${position}${of ? ` of ${of}` : ''}` : '';
  const points = lines.find((l) => l.label === 'Points');
  const worth = points ? `, worth ${points.value}` : '';
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
 * True when the top card of `address` carries none of the attributes the given
 * active-vars stand for — i.e. the active value outlived the card that set it,
 * which is what a wild does and nothing else does.
 */
function topCardLacks(state, address, ...activeVarNames) {
  const topId = state.zones.top(address);
  if (!topId) return false;
  const card = state.pack.cardsById.get(baseId(topId));
  if (!card) return false;
  return activeVarNames.every((varName) => {
    const attr = varName.slice('active'.length);
    const key = attr[0].toLowerCase() + attr.slice(1);
    return card[key] === null || card[key] === undefined;
  });
}

export function describeZone(state, { def, n, address }) {
  const count = state.zones.count(address);
  const title = `${def.label || titleCase(def.id)}${n != null ? ` ${n}` : ''}`;
  const lines = [{ label: 'Cards', value: String(count) }];
  const notes = [];

  if (def.capacity != null) lines.push({ label: 'Holds', value: `${count} of ${def.capacity}` });
  if (def.visibility === 'top') notes.push('Only the top card is face up.');
  else if (def.visibility === 'none' || def.facing === 'down') notes.push('Face down.');

  for (const reaction of state.reactions || []) {
    if (reaction.do !== 'recycle') continue;
    const pattern = reaction.when.slice(reaction.when.indexOf(':') + 1);
    if (pattern !== def.id && pattern !== address) continue;
    notes.push(`Refilled from the ${reaction.from} pile when it runs out.`);
  }

  if (def.id === 'discard' && def.per !== 'player') {
    const active = state.vars.activeSuit || state.vars.activeColor;
    if (active) lines.push({ label: 'Active', value: titleCase(active) });
    // A wild leaves the table matching on something its own face does not
    // show, so that becomes a NOTE rather than only a line — notes are what
    // reach the pile's accessible name (zoneAriaLabel), and a player who
    // cannot see the swatch on the badge has no other way to learn it.
    if (active && topCardLacks(state, address, 'activeSuit', 'activeColor')) {
      notes.push(`Now matching ${titleCase(active)}.`);
    }
  }

  return { title, lines, notes };
}

/**
 * The compact badge left on the felt once the words move to the inspector.
 *
 * A PILE WITH CARDS IN IT INTRODUCES ITSELF; AN EMPTY ONE CANNOT. That is the
 * whole rule, and it is what stops the label diet from going too far. Stripping
 * "Draw" off a pile of eighty-six cards loses nothing — you can see what it is.
 * Stripping "Trick" off an empty dashed rectangle leaves a box with `0` under
 * it and no way to know what the box is for, which is worse than the noise the
 * diet was meant to cut. So the count is the badge while there are cards, and
 * the name is the badge while there are none.
 */
export function zoneBadgeText(state, { def, n, address }) {
  const count = state.zones.count(address);
  if (count === 0) {
    // The empty slot already reads as zero; the word is the missing half.
    return `${def.label || titleCase(def.id)}${n != null ? ` ${n}` : ''}`;
  }
  if (def.capacity != null) return `${count}/${def.capacity}`;
  if (def.id === 'discard' && def.per !== 'player') {
    const active = state.vars.activeSuit || state.vars.activeColor;
    if (active) return `${SUIT_GLYPH[active] || titleCase(active)}`;
  }
  return String(count);
}

/** The accessible name for a pile — the words the badge no longer shows. */
export function zoneAriaLabel(state, inst) {
  const { title, lines, notes } = describeZone(state, inst);
  const count = Number(lines.find((l) => l.label === 'Cards')?.value ?? 0);
  return `${title}, ${count} ${count === 1 ? 'card' : 'cards'}.`
    + (notes.length ? ` ${notes.join(' ')}` : '');
}
