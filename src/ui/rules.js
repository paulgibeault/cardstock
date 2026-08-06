// "How to play", derived from the pack rather than written per game.
//
// THE PACK IS ALREADY THE RULES. Every fact a player needs is declared
// somewhere in the manifest — how many cards are dealt, what a turn consists
// of, what an action card does, what ends the match — and a hand-written help
// page for each game would be a second copy of all of it, free to drift the
// moment a variant is toggled or a value is retuned. So this reads the same
// declarations the engine obeys, which means a pack that changes its rules
// changes its rules page, and a pack nobody has written help for still has one.
//
// The one thing that cannot be derived is why a game is fun, or the sentence
// that makes an unusual rule click. `manifest.howToPlay` is for that: optional
// prose, shown first, never a substitute for the generated sections below.
//
// Output is data — { title, tagline, sections: [{ heading, lines }] } — so the
// panel renders text nodes and nothing here can put markup on screen.

import { effectText } from './describe.js';
import { describeContract } from './interaction.js';

function titleCase(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

function list(items, conjunction = 'and') {
  const kept = items.filter(Boolean);
  if (kept.length <= 1) return kept.join('');
  if (kept.length === 2) return `${kept[0]} ${conjunction} ${kept[1]}`;
  return `${kept.slice(0, -1).join(', ')} ${conjunction} ${kept.at(-1)}`;
}

// Deck ranks are identifiers ("draw2", "wild-draw4"); this is what they are
// called out loud. Not a lookup table: a pack invents its own ranks, so the
// rule has to be about the shape of the string rather than its contents.
function rankLabel(rank) {
  return titleCase(
    String(rank)
      .replace(/-/g, ' ')
      .replace(/([a-z])(\d)/gi, '$1 $2'),
  );
}

function dealCount(rules) {
  const deal = rules.deal;
  if (deal === undefined || deal === null) return null;
  if (typeof deal === 'number') return `${deal} cards each`;
  const by = deal.byPlayers || {};
  const exceptions = Object.entries(by).map(([n, count]) => `${count} with ${n} players`);
  return `${deal.default} cards each${exceptions.length ? ` (${list(exceptions)})` : ''}`;
}

/**
 * What ends the match: the part every pack states the same way (a points
 * threshold), plus whatever the template has to add about its own genre.
 *
 * The genre half used to be four `if (template.id === …)` clauses here. It is
 * the template's `endingLines(pack)` hook now — see src/templates/CONTRACT.md.
 */
function endingLines(pack) {
  const out = [];
  const over = pack.scoring?.gameOver;
  const m = /^anyScore\s*>=\s*(\d+)$/.exec(over?.when || '');
  if (m) {
    const highest = over.winner === 'highestScore';
    out.push(`Play rounds until somebody reaches ${m[1]} points.`);
    out.push(highest
      ? 'The highest score at that point wins.'
      : 'The LOWEST score at that point wins — points are what you are trying to avoid.');
  }
  out.push(...(pack.template?.endingLines?.(pack) || []));
  return out;
}

/**
 * The shape of a turn, which is a property of the template — so the template
 * says it (`ruleLines(rules)`), and this file no longer has to know four games.
 */
function turnLines(pack) {
  return pack.template?.ruleLines?.(pack.rules || {}) || [];
}

/** Every card that does something, said once each. */
function effectLines(pack) {
  const seen = new Map();
  for (const card of pack.cardsById.values()) {
    if (!card.effect) continue;
    const text = effectText(card.effect);
    if (!text) continue;
    // Keyed by what it DOES, so four coloured skips are one line, not four.
    if (!seen.has(text)) seen.set(text, new Set());
    seen.get(text).add(String(card.rank ?? card.id));
  }
  return [...seen.entries()].map(([text, ranks]) => {
    const names = [...ranks].map(rankLabel);
    // effectText already opens with the card's own word for some effects
    // ("Wild — you choose the colour"), and "Wild draw 4 — Wild — choose the
    // colour" is how a generated page starts to read like one. Drop the echo
    // and keep the fuller name.
    const firstWord = names[0].split(' ')[0].toLowerCase();
    const echo = new RegExp(`^${firstWord}\\s*—\\s*`, 'i');
    const said = names.length === 1 ? text.replace(echo, '') : text;
    return `${list(names)} — ${said}`;
  });
}

function announcementLines(pack) {
  const call = pack.rules?.lastCardCall;
  if (!call) return [];
  const at = call.atHandCount ?? 1;
  const penalty = call.penalty?.draw;
  const out = [
    `When you are down to ${at === 1 ? 'your last card' : `${at} cards`}, `
    + `you must declare it — the "${call.label || 'Last card!'}" button.`,
  ];
  if (penalty) {
    out.push(`Stay quiet and anyone may catch you, which costs you ${penalty} cards.`);
  }
  out.push('A declaration covers one descent: draw back up and you have to say it again.');
  return out;
}

/**
 * The rules of `pack`, as renderable data.
 *
 * @param pack a loaded pack (packLoader) — manifest, rules, scoring, template,
 *             cardsById, and the resolved activeVariants.
 */
export function packRules(pack) {
  const manifest = pack.manifest || {};
  const rules = pack.rules || {};
  const sections = [];

  const push = (heading, lines) => {
    const kept = (lines || []).filter(Boolean);
    if (kept.length) sections.push({ heading, lines: kept });
  };

  if (manifest.howToPlay) {
    push('The idea', Array.isArray(manifest.howToPlay) ? manifest.howToPlay : [manifest.howToPlay]);
  }

  push('Winning', endingLines(pack));

  const players = manifest.players || {};
  push('The deal', [
    players.min && players.max ? `${players.min} to ${players.max} players.` : null,
    dealCount(rules) ? `Deal ${dealCount(rules)}.` : null,
  ]);

  push('Your turn', turnLines(pack));

  if (rules.contracts) {
    push('The contracts', rules.contracts.map((items, i) => `${i + 1}. ${describeContract(items)}`));
  }

  push('Cards that do something', effectLines(pack));
  push('Calling your last card', announcementLines(pack));

  if (rules.wilds?.tag) {
    push('Wilds', [
      'A wild becomes one specific card the moment it is played, and stays that card.',
      rules.wilds.minNaturals
        ? `Every meld needs at least ${rules.wilds.minNaturals} ordinary card${rules.wilds.minNaturals === 1 ? '' : 's'}.`
        : null,
    ]);
  }

  // What is actually switched on for THIS match — the house rules in force.
  const active = pack.activeVariants || [];
  const variants = manifest.variants || [];
  const on = variants.filter((v) => active.includes(v.id));
  push('House rules in play', on.length
    ? on.map((v) => `${v.name} — ${v.description}`)
    : ['None — the standard rules.']);

  return { title: manifest.name || pack.id, tagline: manifest.tagline || '', sections };
}
