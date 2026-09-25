// WHAT A PLAYER AT THE CHOSEN DIFFICULTY WOULD DO — the hint system, as data.
//
// `rankMoves` (src/engine/bot.js) was exported for this and nothing called it
// (#93). Now that the difficulty is something a player picks on the new-game
// sheet (#91), "show me what a Sharp player would do" has a coherent meaning:
// rank the legal moves exactly as the house would at that setting, with no
// persona — a hint has a skill and no character — and hand back the top one
// with a sentence that fits the action bar.
//
// A HINT IS NOT A MOVE. Nothing here touches state, nothing is logged, and a
// replay never learns a hint was asked for. The `hard` ranking samples with
// the caller's `random`, which is Math.random by default — the same door the
// bot driver's coin flips use, outside the reducer (src/engine/bot.js).
//
// DOM-FREE, so the felt can be pinned under `node --test`: the suggestion is
// always one of the enumerated legal moves, the sentence always fits, and the
// dial reaches it — tests/hint.test.js.
//
// ONLY WHERE THE STATE IS. `rankMoves` reads the whole state, and a joiner at a
// shared table holds a VIEW: opponents' hands are gone and there is nothing to
// fork. So a hint is offered where the felt is playing from its own state —
// solo, and the host's seat at a shared table — and declined, not faked, on a
// view. The host giving hints to joiners is a protocol question for later.

import { rankMoves } from '../engine/bot.js';
import { makeCtx } from '../engine/context.js';
// What a declared meld is called, and what the round's trump is — the same two
// readings the meld phase's own plate and sentence use (src/templates/
// trick-meld.js), so a suggested declaration names its melds in their words.
import { detectDeclaredMelds, meldNames } from '../templates/melds.js';
import { trumpSuitOf } from '../templates/trick-shared.js';
import { cardName, titleCase } from './describe.js';
import { describeContract, implicitLandingZone, handAddress } from './interaction.js';
import { skillLevel } from './difficulty.js';

/**
 * How long a suggestion may be.
 *
 * THIS SENTENCE IS NO LONGER ON THE FELT. It used to stand in the bar above
 * the hand, in italics, beside the action button, and the budget was that
 * row's two reserved lines. The bar is gone (index.html), the ring on the
 * felt is what a sighted player reads, and the wording now goes only to #log
 * — the live region below the table, for the player a hint is most for.
 *
 * So the budget is #log's line: 30rem wide at most, 0.8rem type, and at 375px
 * the narrower of the two is the phone's own width. 56 characters of ordinary
 * prose measure ~358px there, inside a 375px line, so a suggestion still says
 * itself in one breath instead of wrapping mid-thought.
 *
 * Characters are a proxy for pixels and a coarse one; it holds because these
 * are lower-case sentences carrying one proper noun and one card name.
 * Enforced by tests/hint.test.js over every pack and every difficulty.
 */
export const SUGGESTION_MAX_CHARS = 56;

const MELD_WORD = { set: 'set', run: 'run', colorGroup: 'colour group' };

/** "run(4)" -> "run"; anything unparseable -> "meld". */
function meldWord(item) {
  const kind = /^(\w+)\(/.exec(item || '')?.[1];
  return MELD_WORD[kind] || 'meld';
}

function nameOf(state, cardId) {
  return cardName(state.pack.cardsById.get(cardId));
}

/** "the Red 7", "the Queen of Spades, the 5 of Clubs and the Wild". */
function listOf(state, cardIds) {
  const names = cardIds.map((id) => `the ${nameOf(state, id)}`);
  if (names.length <= 1) return names[0] || 'a card';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "build 3" for `build.3`, "your stock" for `stock.0`; null for the hand. */
function pileWord(state, seat, address) {
  if (!address || address === handAddress(seat)) return null;
  const [id, ...rest] = String(address).split('.');
  if (id === 'build') return `build ${rest[0] ?? ''}`.trim();
  if (rest[rest.length - 1] === String(seat)) return `your ${id}`;
  return `the ${id}`;
}

/**
 * The words the template's own chooser puts on this move's answers, in the
 * order it asks them — `["250", "Hearts"]` for a Pinochle bid, `["Nil"]` or
 * `["Blind nil"]` for a Spades one, `["Pass"]` for a pass.
 *
 * A bid is built on the felt from a bare `{type}` by `pendingChoice`, one
 * question at a time, until the template has nothing left to ask; the labels
 * on the options chosen are what the player read in that dialog. So a
 * suggested bid is said by replaying those questions against the move the
 * bot ranked and reading the label of the option that yields it — the
 * template's vocabulary, never spelled out a second time here.
 */
function answerLabels(state, move) {
  const ask = state.pack.template.pendingChoice;
  if (typeof ask !== 'function') return [];
  const ctx = makeCtx(state);
  const want = move.choice || {};
  const labels = [];
  let built = { actor: move.actor, type: move.type };
  for (let step = 0; step < 4; step++) {
    const question = ask(ctx, built);
    if (!question?.options?.length) break;
    // The option whose answer agrees with the move on every key it sets, and
    // of those the one that sets the most: a blind nil is `{bid: 0, sight}`,
    // and the plain Nil above it in the list agrees with it on `bid` alone.
    let pick = null;
    let best = -1;
    for (const option of question.options) {
      const set = Object.entries(question.apply(built, option.value).choice || {});
      if (set.length > best && set.every(([k, v]) => want[k] === v)) { pick = option; best = set.length; }
    }
    if (!pick) break;
    labels.push(String(pick.label));
    built = question.apply(built, pick.value);
  }
  return labels;
}

/**
 * The move as a verb phrase, in the second person, plus a shorter form for
 * when the full one will not fit. Both are plain prose: the card's name and
 * the contract's words come from the same describers the rest of the felt
 * uses, so a hint never calls a card something the inspector would not.
 */
function phrasesFor(state, seat, move) {
  const cards = move.cards || [];
  switch (move.type) {
    case 'draw': {
      if ((move.from ?? 'draw') === 'discard') {
        const top = state.zones.cards('discard').at(-1);
        return [`take the ${top ? nameOf(state, top) : 'top card'} from the pile`, 'take the pile'];
      }
      return ['draw from the deck', 'draw from the deck'];
    }
    case 'takeHand': {
      // The one move in the repo whose cards are a secret from the player
      // making it, so the sentence names the pile and never its contents.
      const n = move.from ? String(move.from).split('.')[1] : null;
      return [n ? `take hand ${n}` : 'take one of the hands on offer', 'take the hand lit up'];
    }
    case 'discard':
      return [`discard ${listOf(state, cards)}`,
        cards.length > 1 ? `discard the ${cards.length} cards lit up` : 'discard the card lit up'];
    case 'layDown': {
      const items = (move.choice?.melds || []).map((m) => m.item);
      return [`lay down ${describeContract(items)}`, 'lay your contract down'];
    }
    case 'hit': {
      const target = move.choice?.seat;
      const item = state.playerVars?.[target]?.melds?.[move.choice?.meld]?.item;
      const whose = target === seat ? 'your' : 'their';
      return [`add ${listOf(state, cards)} to ${whose} ${meldWord(item)}`, `add the card lit up to ${whose} ${meldWord(item)}`];
    }
    case 'playCard': {
      const from = pileWord(state, seat, move.from);
      const to = pileWord(state, seat, move.to);
      const call = move.choice?.color || move.choice?.suit;
      let full = `play ${listOf(state, cards)}`;
      if (from) full += ` from ${from}`;
      if (to) full += ` to ${to}`;
      if (call) full += ` and call ${titleCase(call)}`;
      return [full, `play the card lit up${to ? ` to ${to}` : ''}`];
    }
    case 'bid': {
      // "bid 250 in Hearts", "bid 4", "bid nil", "bid blind nil" — or, where
      // the dialog's own word for a bid of nothing is Pass, just "pass".
      const [amount, trump] = answerLabels(state, move);
      if (!amount) {
        const n = move.choice?.bid;
        return Number.isInteger(n) ? [`bid ${n}`, `bid ${n}`] : ['make your bid', 'make your bid'];
      }
      if (/^pass$/i.test(amount)) return ['pass', 'pass'];
      const said = /^\d+$/.test(amount) ? amount : amount.toLowerCase();
      return [trump ? `bid ${said} in ${trump}` : `bid ${said}`, `bid ${said}`];
    }
    case 'declareMeld': {
      // What the declaration would score, named the way the plate and the
      // "You meld" sentence name it once it is made.
      const ctx = makeCtx(state);
      const declared = detectDeclaredMelds(ctx, cards, trumpSuitOf(ctx));
      if (!declared.points) return ['declare no meld', 'declare no meld'];
      return [`meld ${declared.points}: ${meldNames(declared.melds).join(', ')}`, `meld ${declared.points}`];
    }
    case 'passCards':
      return [`pass ${listOf(state, cards)}`, `pass the ${cards.length} cards lit up`];
    case 'pass':
      return state.vars?.drawnCardId || state.turn?.phase === 'playDrawn'
        ? ['keep the card you drew', 'keep the card you drew']
        : ['pass', 'pass'];
    default:
      return [`${move.type}`, `${move.type}`];
  }
}

/** "Sharp would take the Red 7 from the pile" — or the short form if that is too long. */
export function suggestionText(state, seat, move, level) {
  const [full, short] = phrasesFor(state, seat, move);
  const lead = `${level.label} would `;
  const sentence = lead + full;
  return sentence.length <= SUGGESTION_MAX_CHARS ? sentence : lead + short;
}

/**
 * What to light on the felt for this move: the cards it moves, the pile it
 * reaches for or lands on, the meld it extends, the seat it targets. Every
 * key here is one the table already paints (readyTargets by zone address,
 * readyMelds by "seat:index"), so the hint rides the same hooks.
 */
export function highlightsFor(state, seat, move) {
  const cardIds = new Set(move.cards || []);
  // A lay-down carries its cards inside the melds it proposes, not on the
  // move; it is the one move here that lights half a hand at once.
  for (const meld of move.choice?.melds || []) {
    for (const id of meld.cards || []) cardIds.add(id);
  }
  const zones = new Set();
  if (move.type === 'takeHand') {
    if (move.from) zones.add(move.from);
  } else if (move.type === 'draw') {
    const from = move.from ?? 'draw';
    zones.add(from);
    if (from === 'discard') {
      const top = state.zones.cards('discard').at(-1);
      if (top) cardIds.add(top);
    }
  } else if (move.type === 'discard' || move.type === 'playCard') {
    if (move.from && move.from !== handAddress(seat)) zones.add(move.from);
    const landing = implicitLandingZone(state, move);
    if (landing && state.zones.has(landing)) zones.add(landing);
  }
  const meldKey = move.type === 'hit' ? `${move.choice?.seat}:${move.choice?.meld}` : null;
  const target = move.choice?.target;
  const targetSeat = Number.isInteger(target) && target !== seat ? target : null;
  return { cardIds, zones, meldKey, targetSeat };
}

/**
 * The move a player at `difficulty` would make from `seat`, or null.
 *
 * @param opts.difficulty 'easy' | 'medium' | 'hard' — the saved botDifficulty;
 *                        anything else is medium, as it is for the bots
 * @param opts.random     the `hard` sampler's randomness; Math.random on the
 *                        felt, a seeded rng in tests
 * @param opts            everything else goes to `rankMoves` — a test passes
 *                        the reproducible budget through here
 * @returns { move, level, text, cardIds, zones, meldKey, targetSeat } or null
 *          when there is nothing to suggest: no state, a view, no legal move.
 */
export function suggestMove(state, seat, { difficulty, random = Math.random, ...opts } = {}) {
  if (!state || state.isView) return null;
  const ranked = rankMoves(state, seat, { difficulty, random, persona: null, ...opts });
  if (ranked.length === 0) return null;
  const move = ranked[0].move;
  const level = skillLevel(difficulty);
  return {
    move,
    level,
    text: suggestionText(state, seat, move, level),
    ...highlightsFor(state, seat, move),
  };
}
