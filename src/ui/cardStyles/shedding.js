// Wildfire and its genre: colour IS the card, and the action cards are icons.
//
// Two things were wrong with drawing these through the vanilla renderer. The
// flat one: a "red 7" was a plain red rectangle with a small 7 in two corners
// and nothing in the middle, so a hand of them read as a colour swatch chart.
// The sharp one: the action cards printed their pack-authored RANK WORD in the
// corner — "reverse", "draw2" — which is five to seven characters in a 16px
// corner, so the renderer had to keep stepping the font down to stop it running
// off the card. A word that has to shrink to fit is a picture that hasn't been
// drawn yet. Here the corner and the centre are the same icon at two sizes.
//
// The centre mark is a ROUNDED DIAMOND, chosen partly because it reads well at
// 28px and partly because it is deliberately not the tilted ellipse the
// best-known game in this genre uses. This pack was already renamed away from
// that trademark; copying its trade dress back in through the art would give
// the rename nothing to do.

import {
  actionIcon, blend, cardAriaLabel, cardBase, cardKind, colorDots, diamondRosette,
  drawCount, dullInk, dullPaper, mirrored, openSvg, roundedDiamond as diamond, shade, text,
} from './shared.js';

/** A wild belongs to no colour, so it gets the one colour no suit can claim. */
const WILD_BODY = '#26262b';
const PANEL = '#fdfdfa';

function cornerMark(kind, card, body) {
  if (kind === 'number') {
    const rank = card.rank == null ? '' : String(card.rank).slice(0, 2);
    return text(rank, { x: 14, y: 26, size: 17, fill: '#ffffff', outline: shade(body, -0.45), outlineWidth: 2.6 });
  }
  if (kind === 'drawN') return text(`+${drawCount(card)}`, { x: 15, y: 25, size: 15, fill: '#ffffff' });
  return actionIcon(kind === 'reverse' ? 'reverse' : 'skip', 15, 22, 8, '#ffffff');
}

export function face(card, theme, muted = false) {
  const kind = cardKind(card);
  const wild = kind === 'wild' || kind === 'wildDrawN';
  // Grey stock, deeper body — see the muting note in shared.js. This is the one
  // style with no white card to grey: the PANEL is its paper and the painted
  // body is its ink, which is why the body darkens rather than washing out.
  // Wildfire plays by colour, so a muted card that had lost its hue would have
  // lost the only thing you sort your hand by.
  const deepen = (hex) => (muted ? dullInk(hex) : hex);
  const panel = muted ? dullPaper(PANEL) : PANEL;
  const body = deepen(wild ? WILD_BODY : (theme.palette[card.color] || theme.palette[theme.order[0]] || '#4b5563'));
  const rim = shade(body, wild ? 0.22 : -0.3);
  const parts = [
    cardBase(rim),
    `<rect x="6" y="6" width="88" height="128" rx="5" fill="${body}" />`,
  ];

  if (wild) {
    // Every colour at once, which is exactly what the card lets you do. Drawn
    // from the pack's OWN palette rather than four hardcoded hues, so a pack
    // that renames or recolours its suits gets a wild that still matches.
    const colors = theme.order.map((name) => theme.palette[name]).filter(Boolean).slice(0, 4).map(deepen);
    const drawFour = kind === 'wildDrawN';
    const cy = drawFour ? 60 : 70;
    const half = drawFour ? 26 : 31;
    // The white diamond is drawn a little larger than the rosette inside it,
    // because its corners are rounded: a rosette sized to the full half-diagonal
    // would have its four tips poke out past the rounding.
    parts.push(diamond(50, cy, half + 4, panel));
    parts.push(diamondRosette(50, cy, half - 2, colors.length >= 2 ? colors : [body, shade(body, 0.3), shade(body, -0.3), shade(body, 0.5)]));
    if (drawFour) parts.push(text('+4', { x: 50, y: 118, size: 30, fill: '#ffffff', weight: 800, outline: shade(WILD_BODY, -0.5), outlineWidth: 3.5 }));
    parts.push(mirrored(colorDots(15, 22, 4.2, 3, colors)));
  } else {
    // Icons and numerals sit on the WHITE panel, not on the card, so they take
    // a darkened body colour. Wildfire's yellow is the case that forces it:
    // #e1b12c on white is around 1.8:1, which is a shape you can see only
    // because you already know what it is.
    const ink = shade(body, -0.28);
    // The panel is a hair short of white so the card's colour bleeds through
    // it. That used to be `opacity="0.95"`; it is the same colour blended
    // against the body it sits on (no-alpha rule, shared.js).
    parts.push(diamond(50, 70, 31, blend(body, panel, 0.95)));
    if (kind === 'number') {
      const rank = card.rank == null ? '' : String(card.rank).slice(0, 2);
      parts.push(text(rank, {
        x: 50, y: 86, size: rank.length > 1 ? 40 : 46, weight: 800,
        fill: body, outline: shade(body, -0.45), outlineWidth: 2.8,
      }));
    } else if (kind === 'drawN') {
      parts.push(actionIcon('draw', 50, 62, 13, ink));
      parts.push(text(`+${drawCount(card)}`, { x: 50, y: 94, size: 20, fill: ink, weight: 800 }));
    } else {
      // Sized to stay INSIDE the diamond, which is a tighter box than it looks:
      // the usable half-width at a given height is PANEL_HALF minus the drop
      // from the centre, so a mark that clears a circle can still poke out of
      // the corners. The reverse arrows are wide and were doing exactly that.
      parts.push(actionIcon(kind, 50, 70, kind === 'reverse' ? 16.5 : 21, ink));
    }
    parts.push(mirrored(cornerMark(kind, card, body)));
  }

  return openSvg(`card-face card-face--shedding${muted ? ' card-face--muted' : ''}`, cardAriaLabel(card)) + parts.join('') + '</svg>';
}

export const defaults = {
  accent: '#d2601a',
  order: ['red', 'yellow', 'green', 'blue'],
  palette: { red: '#c0392b', yellow: '#e1b12c', green: '#27ae60', blue: '#2f6fb0' },
  back: { pattern: 'sunburst' },
};
