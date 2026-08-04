// Untrusted-input gates (GAME_INTEGRATION §7b, ARCADE_COMPLIANCE.md C1–C4).
//
// Card fields are pack-supplied. Today every pack is ours, but the design's own
// roadmap points at pack SHARING (§7d config exchange) and Phase 8 puts card
// ids on the wire — at which point every field in a pack is an attacker's
// input. The §13 acceptance checklist names this exact payload.
import { test } from "node:test";
import assert from "node:assert";
import { STYLE_IDS, makeCardRenderer } from "../src/ui/cardStyles/index.js";
import { isValidPackId } from "../src/arcade/storage.js";
import { safeCssColor, safeAccent } from "../src/ui/css.js";

const PAYLOAD = '"><img src=x onerror=alert(1)>';

// The only markup these renderers are allowed to emit. An escaped payload leaves
// `onerror=` sitting in the output as TEXT, which is inert and fine — what is
// never fine is a `<` that opens a tag we did not write, so the assertion is
// about tags rather than about scary-looking substrings.
//
// This list grew when the card styles arrived (src/ui/cardStyles). It is an
// ALLOW-list and has to stay one: a style that starts emitting `<foreignObject>`
// or `<script>` should fail here rather than quietly widen what a card can be.
const OWN_TAGS = /<\/?(svg|g|rect|text|circle|ellipse|line|path|polygon)[\s/>]/g;

function foreignTags(svg) {
  return (svg.match(/<[^]/g) || []).length - (svg.match(OWN_TAGS) || []).length;
}

/**
 * Every style, because a pack picks which one draws it.
 *
 * Before the registry there was one renderer and one set of these cases. The
 * escaping now lives in shared.js and the styles all route through it, which is
 * exactly the shape that rots: a style that hand-rolls one interpolation
 * reintroduces the whole bug class for its own pack only, and nothing else
 * would catch it.
 */
const RENDERERS = STYLE_IDS.map((id) => [id, makeCardRenderer({ ui: { cardStyle: id } })]);

test("a hostile card id renders inertly, in every style", () => {
  // No rank and no suit, so cardAriaLabel falls through to card.id — the path
  // that used to interpolate raw into the aria-label attribute.
  for (const [id, renderer] of RENDERERS) {
    const svg = renderer.face({ id: PAYLOAD });
    assert.strictEqual(foreignTags(svg), 0, `${id}: the payload opened a tag:\n` + svg);
    assert.ok(!svg.includes(PAYLOAD), `${id}: the payload survived verbatim, so it was never escaped`);
    assert.ok(svg.includes("&quot;&gt;&lt;img"), `${id}: expected entity-escaped output, got:\n` + svg);
  }
});

test("a hostile rank/suit/colour renders inertly, in every style", () => {
  for (const [id, renderer] of RENDERERS) {
    const svg = renderer.face({ rank: PAYLOAD, suit: PAYLOAD, color: PAYLOAD, tags: [PAYLOAD] });
    assert.strictEqual(foreignTags(svg), 0, `${id}: the payload opened a tag:\n` + svg);
    assert.ok(!svg.includes(PAYLOAD), `${id}: the payload survived verbatim`);
  }
});

test("a hostile effect cannot smuggle anything through a draw count", () => {
  // `effect.n` is printed onto the card as "+n". It is pack-supplied and is the
  // one number on a face that comes straight out of a manifest.
  for (const [id, renderer] of RENDERERS) {
    const svg = renderer.face({ rank: "d", color: "red", effect: { type: "drawN", n: PAYLOAD } });
    assert.strictEqual(foreignTags(svg), 0, `${id}: a hostile draw count opened a tag:\n` + svg);
    assert.ok(!svg.includes(PAYLOAD), `${id}: a hostile draw count survived`);
  }
});

test("a hostile colour cannot break out of the class attribute", () => {
  // The vanilla style puts the card's colour into class="…" verbatim.
  for (const [id, renderer] of RENDERERS) {
    const svg = renderer.face({ rank: "3", color: '" onload="alert(1)' });
    assert.ok(!svg.includes('onload="'), `${id}: escaped the class attribute:\n` + svg);
  }
});

test("every quote in a rendered face is one we opened", () => {
  // A structural check rather than a payload check: an odd number of quotes
  // means something interpolated one, which is the whole bug class.
  for (const [id, renderer] of RENDERERS) {
    for (const card of [{ id: PAYLOAD }, { rank: '"', suit: "hearts" }, { rank: "A", color: '"' },
                        { rank: '"', effect: { type: "drawN", n: '"' } }]) {
      const quotes = (renderer.face(card).match(/"/g) || []).length;
      assert.strictEqual(quotes % 2, 0, `${id}: unbalanced quotes for ${JSON.stringify(card)}`);
    }
  }
});

test("a hostile back emblem renders inertly", () => {
  // The emblem is the one pack-authored STRING on the back, and the back is the
  // most-drawn card on the table — every opponent's whole hand.
  const svg = makeCardRenderer({ ui: { cardBack: { emblem: PAYLOAD } } }).back();
  assert.strictEqual(foreignTags(svg), 0, "the payload opened a tag:\n" + svg);
  assert.ok(!svg.includes("<img"), "the payload survived:\n" + svg);
});

test("a card back has nothing left to interpolate into", () => {
  for (const [id, renderer] of RENDERERS) {
    assert.strictEqual(renderer.back(), renderer.back(), `${id}: the back is not stable`);
    assert.ok(!renderer.back().includes("${"), `${id}: an unresolved template literal reached the markup`);
    assert.strictEqual(foreignTags(renderer.back()), 0, `${id}: the back emitted a foreign tag`);
  }
});

test("no style can be talked into emitting a colour it did not generate", () => {
  // Every fill/stroke on a card is either a literal this repo wrote or a value
  // that came back from safeAccent, so the set of shapes that can appear in one
  // is closed. Anything else means a pack string reached a paint attribute.
  const hostile = {
    accent: "url(https://evil.example/x)",
    ui: { cardPalette: { red: "javascript:alert(1)", blue: "#2f6fb0; background: url(x)" },
          cardBack: { color: "var(--panel-bg)" } },
  };
  for (const styleId of STYLE_IDS) {
    const renderer = makeCardRenderer({ ...hostile, ui: { ...hostile.ui, cardStyle: styleId } });
    const cards = [{ rank: "3", color: "red" }, { rank: "wild", tags: ["wild"] },
                   { rank: "5", color: "blue" }, { rank: "A", suit: "spades" }];
    for (const svg of [renderer.back(), ...cards.map((c) => renderer.face(c))]) {
      for (const [, value] of svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)) {
        assert.ok(/^(?:#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|none|inherit)$/.test(value),
          `${styleId}: "${value}" is not a colour this repo generated`);
      }
    }
  }
});

// The lobby paints each tile with `manifest.accent`, which lands in an inline
// style. An inline style is a real sink: url() fetches, var() reads values the
// pack was never given, and a stray `;` opens the whole declaration block.
test("a pack's tile accent cannot smuggle anything into a style", () => {
  for (const good of ["#c0392b", "#FFD166", "#000000"]) {
    assert.strictEqual(safeAccent(good, "#fallback"), good);
  }
  for (const bad of [
    "red", "#fff",                                  // shapes color-mix() can't be trusted with here
    "url(https://evil.example/x.png)",
    "var(--panel-bg)",
    "#c0392b; background-image: url(x)",
    "#c0392b/**/;position:fixed",
    "expression(alert(1))", PAYLOAD, "", null, undefined, 42, {},
  ]) {
    assert.strictEqual(safeAccent(bad, "#3d7a5a"), "#3d7a5a",
      `${JSON.stringify(bad)} should have fallen back`);
  }
});

test("a wild's colour choice cannot smuggle anything into a swatch", () => {
  // These are pack-derived card colours, painted onto the choice buttons.
  for (const good of ["red", "blue", "#e1b12c"]) {
    assert.strictEqual(safeCssColor(good), good);
  }
  for (const bad of ["url(x)", "var(--x)", "red;position:fixed", "rgb(1,2,3)",
                     "a".repeat(21), PAYLOAD, "", null, 42]) {
    assert.strictEqual(safeCssColor(bad), null, `${JSON.stringify(bad)} should have been refused`);
  }
});

test("pack ids are charset-validated before reaching a fetch path", () => {
  for (const good of ["crazy-eights", "wildfire", "milestones", "stockpile", "hearts", "a_b-9"]) {
    assert.ok(isValidPackId(good), `${good} should be accepted`);
  }
  for (const bad of ["../../etc/passwd", "a/b", "a b", "", null, undefined, 42,
                     "pack?x=1", "pack#frag", "https://evil.example/p", PAYLOAD,
                     "x".repeat(65)]) {
    assert.ok(!isValidPackId(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});
