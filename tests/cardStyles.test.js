// The card art: which style a pack gets, what a theme lets a manifest say, and
// whether every card in every shipped deck actually draws.
//
// The injection cases live next door in security.test.js, which now runs its
// payloads through EVERY style rather than through the one renderer there used
// to be. This file is about the other half: that the art is right, and that a
// pack cannot end up with a card that renders as nothing.
import { test } from "node:test";
import assert from "node:assert";
import {
  STYLE_IDS, buildTheme, makeCardRenderer, resolveStyleId,
} from "../src/ui/cardStyles/index.js";
import { face as vanillaFace } from "../src/ui/cardStyles/vanilla.js";
import { listPackIds, loadPackFromDisk } from "../tools/pack-test.mjs";

/* ------------------------------------------------------------------ *
 * Which style a pack gets
 * ------------------------------------------------------------------ */

test("a manifest's own declaration decides its style", () => {
  for (const id of STYLE_IDS) {
    assert.strictEqual(resolveStyleId({ ui: { cardStyle: id } }), id);
  }
});

test("a standard deck is checked before the template", () => {
  // Crazy Eights is the case this exists for: a SHEDDING game played with a
  // 52-card deck. Reading the template first would paint it like Wildfire —
  // flat colour, no pips — which is wrong for a deck everyone already knows.
  assert.strictEqual(resolveStyleId({ deck: "standard-52", template: "shedding" }), "classic");
  assert.strictEqual(resolveStyleId({ deck: "standard-54", template: "trick-taking" }), "classic");
  assert.strictEqual(resolveStyleId({ deck: "standard-52x2", template: "contract-rummy" }), "classic");
  assert.strictEqual(resolveStyleId({ deck: "deck.json", template: "shedding" }), "shedding");
});

test("an unrecognised or hostile style name falls back rather than throwing", () => {
  // `constructor` and `toString` are the ones that matter: STYLES is looked up
  // by a manifest-supplied key, and a plain `in` check would find them on the
  // prototype and hand back a function to call as a renderer.
  for (const bad of ["constructor", "toString", "__proto__", "hasOwnProperty",
                     "photoreal", "", null, 42, {}]) {
    assert.strictEqual(resolveStyleId({ ui: { cardStyle: bad } }), "vanilla",
      `${JSON.stringify(bad)} should not have resolved to a style`);
  }
});

test("a pack that says nothing gets the vanilla renderer", () => {
  assert.strictEqual(resolveStyleId({}), "vanilla");
  assert.strictEqual(resolveStyleId({ template: "contract-rummy", deck: "deck.json" }), "vanilla");
});

/* ------------------------------------------------------------------ *
 * The theme, which is where a manifest's values are gated
 * ------------------------------------------------------------------ */

test("a colour that is not six hex digits never reaches the theme", () => {
  const theme = buildTheme({
    accent: "url(https://evil.example/x.png)",
    ui: {
      cardStyle: "shedding",
      cardPalette: { red: "red", yellow: "#e1b12c", green: "#fff;position:fixed", blue: "var(--x)" },
      cardBack: { color: "expression(alert(1))" },
    },
  });
  assert.match(theme.accent, /^#[0-9a-f]{6}$/i, "a junk accent survived");
  assert.match(theme.back.color, /^#[0-9a-f]{6}$/i, "a junk back colour survived");
  assert.strictEqual(theme.palette.yellow, "#e1b12c", "the one good value should have been kept");
  for (const hex of Object.values(theme.palette)) {
    assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is not a hex literal`);
  }
});

test("a card colour cannot reach up the prototype chain", () => {
  // The palette is looked up by the card's OWN `color` field. On a plain
  // object, `{"color": "constructor"}` resolves to Object.prototype.constructor
  // and stringifies an entire function into a fill attribute.
  const theme = buildTheme({ ui: { cardStyle: "shedding" } });
  for (const key of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
    assert.strictEqual(theme.palette[key], undefined, `${key} resolved to something`);
  }
  const svg = makeCardRenderer({ ui: { cardStyle: "shedding" } }).face({ rank: "3", color: "constructor" });
  assert.ok(!svg.includes("function"), "a prototype member was painted onto the card:\n" + svg);
  assert.ok(!svg.includes("native code"));
});

test("an unknown back pattern falls back to the style's own", () => {
  const good = buildTheme({ ui: { cardBack: { pattern: "rings" } } });
  assert.strictEqual(good.back.pattern, "rings");
  for (const bad of ["hologram", "constructor", "", null, 7]) {
    assert.strictEqual(buildTheme({ ui: { cardBack: { pattern: bad } } }).back.pattern, "lattice");
  }
});

test("a back emblem is capped at two characters, counted properly", () => {
  assert.strictEqual(buildTheme({ ui: { cardBack: { emblem: "ABCDEFG" } } }).back.emblem, "AB");
  // Sliced by code point: cutting "🂡🂢🂣" with String#slice(0,2) would leave half
  // a surrogate pair, which is a lone unpaired code unit in the markup.
  assert.strictEqual([...buildTheme({ ui: { cardBack: { emblem: "🂡🂢🂣" } } }).back.emblem].length, 2);
  assert.strictEqual(buildTheme({ ui: { cardBack: { emblem: 42 } } }).back.emblem, "");
});

test("the back colour defaults to the pack's accent", () => {
  assert.strictEqual(buildTheme({ accent: "#123456" }).back.color, "#123456");
});

test("a theme survives a manifest that is missing, empty, or the wrong shape", () => {
  for (const junk of [undefined, null, {}, 42, "manifest", [], { ui: "nope" }, { ui: { cardPalette: 7 } }]) {
    const theme = buildTheme(junk);
    assert.ok(theme.style, `no style for ${JSON.stringify(junk)}`);
    assert.ok(theme.order.length > 0, `no colours for ${JSON.stringify(junk)}`);
    assert.doesNotThrow(() => makeCardRenderer(junk).face({ rank: "3" }));
    assert.doesNotThrow(() => makeCardRenderer(junk).back());
  }
});

test("a deck's own colours are used when the manifest declares no palette", () => {
  const cardsById = new Map([
    ["a", { id: "a", rank: "1", color: "amber" }],
    ["b", { id: "b", rank: "2", color: "teal" }],
    ["c", { id: "c", rank: "3", color: "amber" }],
  ]);
  const theme = buildTheme({ ui: { cardStyle: "shedding" } }, cardsById);
  assert.deepStrictEqual([...theme.order], ["amber", "teal"], "deck order, deduplicated");
  // A colour the palette has never heard of still has to be drawn as something
  // distinct rather than collapsing onto its neighbour.
  assert.match(theme.palette.amber, /^#[0-9a-f]{6}$/i);
  assert.notStrictEqual(theme.palette.amber, theme.palette.teal);
});

test("a declared palette wins over the deck, so a lobby tile matches its table", () => {
  const cardsById = new Map([["a", { id: "a", rank: "1", color: "red" }]]);
  const declared = { ui: { cardStyle: "shedding", cardPalette: { red: "#abcdef" } } };
  assert.strictEqual(buildTheme(declared, cardsById).palette.red, "#abcdef");
  assert.strictEqual(buildTheme(declared, null).palette.red, "#abcdef");
});

/* ------------------------------------------------------------------ *
 * Vanilla, which must not have moved
 * ------------------------------------------------------------------ */

// Vanilla is the fallback every style-less pack lands on, and it was extracted
// verbatim from the renderer that shipped before the registry existed. These
// are its exact bytes from that version. A change here is only ever legitimate
// as a deliberate one — adopting richer art must be something a pack opts into,
// never something that happens to it.
const VANILLA_PIN = [
  [{ rank: "10", suit: "hearts" },
    '\n    <svg viewBox="0 0 100 140" class="card-face card-face--red" role="img" aria-label="10 of hearts">\n'
    + '      <rect x="1" y="1" width="98" height="138" rx="8" class="card-face__bg" />\n'
    + '      <text x="8" y="22" class="card-face__corner card-face__corner--sm">10 ♥</text>\n'
    + '      <text x="92" y="128" class="card-face__corner card-face__corner--br card-face__corner--sm">10 ♥</text>\n'
    + '      <text x="50" y="80" class="card-face__pip">♥</text>\n      \n    </svg>'],
  [{ rank: "wild", tags: ["wild"] },
    '\n    <svg viewBox="0 0 100 140" class="card-face card-face--neutral" role="img" aria-label="wild">\n'
    + '      <rect x="1" y="1" width="98" height="138" rx="8" class="card-face__bg" />\n'
    + '      <text x="8" y="22" class="card-face__corner"></text>\n'
    + '      <text x="92" y="128" class="card-face__corner card-face__corner--br"></text>\n'
    + '      \n      <text x="50" y="80" class="card-face__badge">✱</text>\n    </svg>'],
];

test("the vanilla style still draws exactly what it always drew", () => {
  for (const [card, expected] of VANILLA_PIN) {
    assert.strictEqual(vanillaFace(card), expected, `vanilla moved for ${JSON.stringify(card)}`);
  }
});

test("a pack with no style declaration is rendered by vanilla, unchanged", () => {
  const renderer = makeCardRenderer({ template: "contract-rummy", deck: "deck.json" });
  assert.strictEqual(renderer.face(VANILLA_PIN[0][0]), VANILLA_PIN[0][1]);
});

/* ------------------------------------------------------------------ *
 * Classic: the thing a standard deck was missing
 * ------------------------------------------------------------------ */

const classic = makeCardRenderer({ deck: "standard-52" });

/** Centre pips are the only glyphs drawn at 17px; the two indices are smaller. */
function pipCount(svg) {
  return (svg.match(/font-size="17"/g) || []).length;
}

test("a number card shows one pip per rank, not one pip full stop", () => {
  // The whole point of the classic style. A hand is read by counting pips, and
  // before this every 2 through 10 was the same card with a different index.
  for (let rank = 2; rank <= 10; rank++) {
    assert.strictEqual(pipCount(classic.face({ rank: String(rank), suit: "hearts" })), rank,
      `the ${rank} of hearts should have ${rank} pips`);
  }
});

test("pips in the lower half of the card are turned around", () => {
  // A real card reads the same held either way up. Every layout with a bottom
  // row has at least one rotated pip; the 2 has exactly one.
  assert.ok(classic.face({ rank: "2", suit: "spades" }).includes("rotate(180"));
  const threes = classic.face({ rank: "3", suit: "spades" }).match(/rotate\(180 50 102\)/g) || [];
  assert.strictEqual(threes.length, 1, "only the bottom pip of a 3 should be rotated");
});

test("court cards get a panel and an ornament rather than a bare letter", () => {
  for (const rank of ["J", "Q", "K"]) {
    const svg = classic.face({ rank, suit: "diamonds" });
    assert.ok(svg.includes('<rect x="21" y="27"'), `${rank} has no court panel`);
    assert.ok(/<polygon|<path/.test(svg), `${rank} has no ornament`);
    assert.strictEqual(pipCount(svg), 0, `${rank} should not be laid out as pips`);
  }
  assert.notStrictEqual(classic.face({ rank: "K", suit: "diamonds" }),
    classic.face({ rank: "Q", suit: "diamonds" }), "the three courts must differ from each other");
});

test("the ace of spades keeps its flourish", () => {
  assert.ok(classic.face({ rank: "A", suit: "spades" }).includes("<ellipse"));
  assert.ok(!classic.face({ rank: "A", suit: "hearts" }).includes("<ellipse"));
});

test("a joker still renders as something", () => {
  const svg = classic.face({ rank: "joker", suit: null, tags: ["joker"] });
  assert.ok(svg.includes("joker"), "the joker lost its own name:\n" + svg);
});

test("red and black suits are inked differently", () => {
  assert.ok(classic.face({ rank: "5", suit: "hearts" }).includes("#b91c1c"));
  assert.ok(classic.face({ rank: "5", suit: "spades" }).includes("#141414"));
});

/* ------------------------------------------------------------------ *
 * The pack-specific styles
 * ------------------------------------------------------------------ */

test("a wild is drawn in the pack's own colours, not four hardcoded ones", () => {
  const palette = { red: "#aa1111", yellow: "#bb2222", green: "#cc3333", blue: "#dd4444" };
  const renderer = makeCardRenderer({ ui: { cardStyle: "shedding", cardPalette: palette } });
  const svg = renderer.face({ rank: "wild", effect: { type: "wild", choose: "color" } });
  for (const hex of Object.values(palette)) {
    assert.ok(svg.includes(hex), `the wild is missing ${hex}:\n` + svg);
  }
});

/** Only what a player SEES — the aria-label still says "skip", and must. */
function visibleText(svg) {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(" ");
}

test("an action card is an icon, at both sizes, not a word that has to shrink", () => {
  // The rank words these packs author — "skip", "reverse", "draw2" — are five
  // to seven characters in a 16px corner, which is why the old renderer kept
  // stepping the font down to stop them running off the card.
  const renderer = makeCardRenderer({ ui: { cardStyle: "shedding" } });
  for (const [card, kind] of [
    [{ rank: "skip", color: "red", effect: "skip" }, "skip"],
    [{ rank: "reverse", color: "red", effect: "reverse" }, "reverse"],
  ]) {
    const svg = renderer.face(card);
    assert.ok(!visibleText(svg).includes(kind), `"${kind}" is still printed as a word:\n` + svg);
    assert.ok(svg.includes(`aria-label="red ${kind}"`), `${kind} lost its accessible name`);
    assert.ok(/<circle|<path/.test(svg), `${kind} has no icon`);
  }
  const draw = renderer.face({ rank: "draw2", color: "blue", effect: { type: "drawN", n: 2 } });
  assert.ok(visibleText(draw).includes("+2"), "a draw card should say +2");
  assert.ok(!visibleText(draw).includes("draw2"), "a draw card should not print its rank word");
});

test("a draw card says how many it actually draws", () => {
  const renderer = makeCardRenderer({ ui: { cardStyle: "shedding" } });
  assert.ok(renderer.face({ rank: "draw5", color: "red", effect: { type: "drawN", n: 5 } }).includes("+5"));
  // A nonsense count falls back rather than printing itself onto the card.
  for (const n of [-1, 0, 1e9, "4", null, 2.5]) {
    const svg = renderer.face({ rank: "d", color: "red", effect: { type: "drawN", n } });
    assert.ok(svg.includes("+2"), `n=${JSON.stringify(n)} should have fallen back to +2`);
  }
});

test("stockpile's colour bands sort the run into low, middle and high", () => {
  // The deck is colourless — every card is a bare rank — so the band is derived.
  // It is the only thing that lets a hand be read without reading each digit.
  const renderer = makeCardRenderer({ ui: {
    cardStyle: "rankrun",
    cardPalette: { band1: "#111111", band2: "#222222", band3: "#333333" },
  } }, new Map([["hi", { id: "hi", rank: "12" }]]));
  const bandOf = (rank) => {
    const svg = renderer.face({ rank: String(rank) });
    return ["#111111", "#222222", "#333333"].find((hex) => svg.includes(hex));
  };
  assert.deepStrictEqual([1, 2, 3, 4].map(bandOf), Array(4).fill("#111111"));
  assert.deepStrictEqual([5, 6, 7, 8].map(bandOf), Array(4).fill("#222222"));
  assert.deepStrictEqual([9, 10, 11, 12].map(bandOf), Array(4).fill("#333333"));
});

test("the sequencing style keeps the numeral as the loudest thing on the card", () => {
  const renderer = makeCardRenderer({ ui: { cardStyle: "sequencing" } });
  const svg = renderer.face({ rank: "7", color: "red" });
  const sizes = [...svg.matchAll(/font-size="(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));
  assert.strictEqual(Math.max(...sizes), 60, "the centre numeral is not the largest element");
});

/* ------------------------------------------------------------------ *
 * Legibility
 * ------------------------------------------------------------------ */

const PAPER = "#fdfdfa";

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4))
    .reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i] * v, 0);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The card's headline: its biggest text, and whatever actually inks it. */
function headline(svg) {
  let best = null;
  for (const m of svg.matchAll(/<text[^>]*>/g)) {
    // A faded layer is depth, not something anyone reads — sequencing draws its
    // numeral twice, once as a 16% ghost offset behind the real one.
    if (/opacity="/.test(m[0])) continue;
    const size = Number((/font-size="([\d.]+)"/.exec(m[0]) || [])[1]);
    if (!Number.isFinite(size) || (best && size <= best.size)) continue;
    // An outlined numeral is carried by its STROKE — that is the whole reason
    // a bright fill is legible on a bright card (see paint-order in table.css).
    const stroke = (/stroke="(#[0-9a-fA-F]{6})"/.exec(m[0]) || [])[1];
    const fill = (/fill="(#[0-9a-fA-F]{6})"/.exec(m[0]) || [])[1];
    best = { size, ink: stroke || fill };
  }
  return best;
}

test("the number on a card is legible against the card it is printed on", () => {
  // The rank is also in the aria-label, so this is not the only way to read a
  // card — but a hand is scanned visually, and Milestones' yellow at full
  // strength was 2.2:1 on white. The styles below all print their numeral on
  // white paper or on a white panel, so that is what it is measured against.
  for (const [styleId, card] of [
    ["sequencing", { rank: "12", color: "yellow" }],
    ["sequencing", { rank: "7", color: "green" }],
    ["rankrun", { rank: "6" }],
    ["rankrun", { rank: "11" }],
    ["shedding", { rank: "9", color: "yellow" }],
    ["classic", { rank: "A", suit: "hearts" }],
  ]) {
    const renderer = makeCardRenderer({ ui: { cardStyle: styleId } });
    const head = headline(renderer.face(card));
    assert.ok(head, `${styleId} drew no text for ${JSON.stringify(card)}`);
    const ratio = contrast(head.ink, PAPER);
    assert.ok(ratio >= 4.5,
      `${styleId} ${JSON.stringify(card)}: ${head.ink} is ${ratio.toFixed(2)}:1 on paper, needs 4.5`);
  }
});

test("a white corner index is legible on the colour band behind it", () => {
  // rankrun prints its index in white ON the coloured cap, which is the one
  // place a pack's own hue is the background rather than the ink.
  const theme = buildTheme({ ui: { cardStyle: "rankrun" } });
  for (const key of ["band1", "band2", "band3"]) {
    const ratio = contrast(theme.palette[key], "#ffffff");
    assert.ok(ratio >= 4.5, `${key} (${theme.palette[key]}) is ${ratio.toFixed(2)}:1 under white text`);
  }
});

/* ------------------------------------------------------------------ *
 * Backs
 * ------------------------------------------------------------------ */

test("a back is a constant for its theme, and differs between packs", () => {
  const wildfire = makeCardRenderer({ accent: "#d2601a", ui: { cardBack: { pattern: "sunburst", emblem: "✱" } } });
  const hearts = makeCardRenderer({ accent: "#b03048", ui: { cardBack: { pattern: "lattice", emblem: "♥" } } });
  assert.strictEqual(wildfire.back(), wildfire.back(), "the same pack's back is not stable");
  assert.notStrictEqual(wildfire.back(), hearts.back(), "two packs share a back");
  assert.ok(!wildfire.back().includes("${"), "an unresolved template literal reached the markup");
});

test("every back pattern draws something inside the card", () => {
  for (const pattern of ["lattice", "sunburst", "rings", "pinstripe", "weave"]) {
    const svg = makeCardRenderer({ ui: { cardBack: { pattern } } }).back();
    assert.ok(/<line|<circle/.test(svg), `${pattern} drew no pattern`);
    // Clipped in JS because there is no clip path to lean on — see backs.js.
    for (const [, v] of svg.matchAll(/(?:x1|x2|cx)="(-?[\d.]+)"/g)) {
      assert.ok(Number(v) >= 4.9 && Number(v) <= 95.1, `${pattern} drew past the paper at x=${v}`);
    }
    for (const [, v] of svg.matchAll(/(?:y1|y2)="(-?[\d.]+)"/g)) {
      assert.ok(Number(v) >= 4.9 && Number(v) <= 135.1, `${pattern} drew past the paper at y=${v}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * The structural invariants, checked against every shipped card
 * ------------------------------------------------------------------ */

test("no style emits an SVG id, which is the bug that would be invisible", () => {
  // Card SVGs are inlined into one document by the dozen — a mini-hand is one
  // per card, and the lobby shows five packs at once. Ids are DOCUMENT-scoped,
  // so two cards declaring the same one make every url(#x) on the page resolve
  // to whichever rendered first: one pack silently painted in another's colours.
  // Nothing about that fails loudly, so it is asserted here instead.
  for (const styleId of STYLE_IDS) {
    const renderer = makeCardRenderer({ ui: { cardStyle: styleId } });
    for (const svg of [renderer.back(), ...SAMPLE_CARDS.map((c) => renderer.face(c))]) {
      assert.ok(!/\sid="/.test(svg), `${styleId} emitted an id:\n` + svg);
      assert.ok(!svg.includes("url(#"), `${styleId} referenced an id:\n` + svg);
      assert.ok(!/<(defs|pattern|clipPath|use)[\s/>]/.test(svg), `${styleId} used a defs-scoped element`);
    }
  }
});

const SAMPLE_CARDS = [
  { rank: "A", suit: "spades" }, { rank: "7", suit: "hearts" }, { rank: "K", suit: "clubs" },
  { rank: "3", color: "red" }, { rank: "wild", tags: ["wild"] },
  { rank: "skip", color: "green", effect: "skip" },
  { rank: "draw2", color: "blue", effect: { type: "drawN", n: 2 } },
  { rank: "12" }, { id: "bare" }, {},
];

const packIds = listPackIds();

for (const packId of packIds) {
  test(`every card in ${packId} renders as a real card`, async () => {
    const pack = await loadPackFromDisk(packId);
    const renderer = makeCardRenderer(pack.manifest, pack.cardsById);
    let count = 0;
    for (const card of pack.cardsById.values()) {
      const svg = renderer.face(card);
      count += 1;
      for (const rot of ["undefined", "NaN", "null", "${", "[object Object]"]) {
        assert.ok(!svg.includes(rot), `${card.id} rendered "${rot}":\n` + svg);
      }
      assert.ok(svg.startsWith("<svg") || svg.trimStart().startsWith("<svg"), `${card.id} is not an svg`);
      assert.ok(svg.includes('class="card-face'), `${card.id} lost the class the stylesheet sizes it by`);
      assert.ok(/aria-label="[^"]+"/.test(svg), `${card.id} has no accessible name`);
      assert.ok(svg.length > 200, `${card.id} rendered as an almost-empty card:\n` + svg);
    }
    assert.ok(count > 30, `${packId} rendered only ${count} cards`);
    assert.ok(!renderer.back().includes("${"));
  });
}

test("each pack is visually distinguishable from the others", () => {
  // The acceptance criterion for the whole change: five packs that look like
  // five games rather than one renderer with five names.
  const backs = new Set();
  for (const packId of packIds) {
    backs.add(makeCardRenderer(JSON.parse(JSON.stringify(MANIFEST_STUBS[packId] || {}))).back());
  }
  assert.strictEqual(backs.size, packIds.length, "two packs share a card back");
});

// The `ui` blocks the shipped manifests carry, restated so this assertion fails
// when a pack's identity is dropped rather than when the file is reformatted.
const MANIFEST_STUBS = {
  wildfire: { accent: "#d2601a", ui: { cardStyle: "shedding", cardBack: { pattern: "sunburst", color: "#d2601a", emblem: "✱" } } },
  milestones: { accent: "#1f7a63", ui: { cardStyle: "sequencing", cardBack: { pattern: "rings", color: "#1f7a63", emblem: "M" } } },
  stockpile: { accent: "#6b4fa8", ui: { cardStyle: "rankrun", cardBack: { pattern: "weave", color: "#6b4fa8", emblem: "S" } } },
  hearts: { accent: "#b03048", deck: "standard-52", ui: { cardBack: { pattern: "lattice", color: "#8c2740", emblem: "♥" } } },
  "crazy-eights": { accent: "#2f6fb0", deck: "standard-52", ui: { cardBack: { pattern: "pinstripe", color: "#2f6fb0", emblem: "8" } } },
};

test("the shipped manifests still declare the identity the stubs describe", async () => {
  for (const packId of packIds) {
    const pack = await loadPackFromDisk(packId);
    const stub = MANIFEST_STUBS[packId];
    assert.ok(stub, `${packId} has no stub — add one when a pack ships`);
    assert.strictEqual(resolveStyleId(pack.manifest), resolveStyleId(stub),
      `${packId} resolves to a different style than its stub`);
    assert.deepStrictEqual(
      { ...buildTheme(pack.manifest).back }, { ...buildTheme(stub).back },
      `${packId}'s card back drifted from what the stub records`);
  }
});
