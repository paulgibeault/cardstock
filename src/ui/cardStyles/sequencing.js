// Milestones and its genre: numbers you collect into sets and runs.
//
// The read here is different from Wildfire's. A shedding player asks "can I
// play this?" and needs colour first; a contract player is scanning ten cards
// for MATCHING NUMBERS, so the numeral has to be the loudest thing on the card
// and the colour has to be present without competing with it. Hence a white
// card with a heavy coloured border and a numeral filling the middle, rather
// than Wildfire's edge-to-edge paint.
//
// The ghost numeral behind the real one is not decoration for its own sake: at
// 28px in a mini-hand the offset shadow is what keeps the digit from
// disappearing into the white, and at full size it gives the card some depth.

import {
  actionIcon, blend, cardAriaLabel, cardBase, cardKind, colorDots, mirrored,
  openSvg, shade, text, wedgeDisc,
} from './shared.js';

const PAPER = '#fdfdfa';
const SLATE = '#475569';

export function face(card, theme) {
  const kind = cardKind(card);
  const wild = kind === 'wild' || kind === 'wildDrawN';
  const skip = kind === 'skip';
  const colors = theme.order.map((name) => theme.palette[name]).filter(Boolean).slice(0, 4);
  const border = wild || skip ? SLATE : (theme.palette[card.color] || colors[0] || SLATE);
  const rank = card.rank == null ? '' : String(card.rank).slice(0, 3);

  const parts = [
    cardBase(border),
    `<rect x="7" y="7" width="86" height="126" rx="5" fill="${PAPER}" />`,
    `<rect x="10.5" y="10.5" width="79" height="119" rx="3.5" fill="none" stroke="${blend(PAPER, border, 0.55)}" stroke-width="1" />`,
  ];

  if (wild) {
    // No number to shout, so the card says "any of them" instead — the pack's
    // whole palette in one mark, which is also what makes it findable at 28px.
    parts.push(`<circle cx="50" cy="70" r="33" fill="${shade(SLATE, 0.85)}" />`);
    parts.push(wedgeDisc(50, 70, 29, colors.length >= 2 ? colors : [SLATE, shade(SLATE, 0.4)]));
    parts.push(`<circle cx="50" cy="70" r="29" fill="none" stroke="${PAPER}" stroke-width="2" />`);
    parts.push(`<circle cx="50" cy="70" r="9" fill="${PAPER}" />`);
    parts.push(mirrored(colorDots(15, 23, 4.4, 3.2, colors)));
  } else if (skip) {
    parts.push(actionIcon('skip', 50, 70, 24, SLATE));
    parts.push(mirrored(actionIcon('skip', 15, 23, 8, SLATE)));
  } else {
    // The numeral is inked a step darker than the border it matches. The
    // border can be as bright as the pack likes — it is a band of colour, not
    // something to read — but Milestones' yellow at full strength is about
    // 2.2:1 on white, and a digit is the one thing on this card that has to be
    // read. -0.35 is what puts the WORST pack colour over 4.5:1 rather than
    // over the 3:1 large-text line, because the corner index is the same ink
    // and is nowhere near large text once a card is 70px wide. The ghost
    // behind the numeral keeps the pack's actual colour.
    const ink = shade(border, -0.35);
    const size = rank.length > 1 ? 52 : 60;
    // The ghost is the pack's colour at 16% on PAPER, blended rather than
    // faded (no-alpha rule, shared.js). It carries `cs-ghost` so that what is
    // decoration and what is the readable numeral stays tellable apart now
    // that they no longer differ by an `opacity` attribute — the contrast test
    // in tests/cardStyles.test.js reads that class.
    parts.push(text(rank, { x: 52, y: 92, size, fill: blend(PAPER, border, 0.16), weight: 800, cls: 'cs-text cs-ghost' }));
    parts.push(text(rank, { x: 50, y: 89, size, fill: ink, weight: 800 }));
    parts.push(mirrored(text(rank, { x: 16, y: 27, size: 18, fill: ink })));
  }

  return openSvg('card-face card-face--sequencing', cardAriaLabel(card)) + parts.join('') + '</svg>';
}

export const defaults = {
  accent: '#1f7a63',
  order: ['red', 'blue', 'green', 'yellow'],
  palette: { red: '#c0392b', blue: '#2f6fb0', green: '#27ae60', yellow: '#d9a520' },
  back: { pattern: 'rings' },
};
