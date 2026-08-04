// Untrusted-input gates (GAME_INTEGRATION §7b, ARCADE_COMPLIANCE.md C1–C4).
//
// Card fields are pack-supplied. Today every pack is ours, but the design's own
// roadmap points at pack SHARING (§7d config exchange) and Phase 8 puts card
// ids on the wire — at which point every field in a pack is an attacker's
// input. The §13 acceptance checklist names this exact payload.
import { test } from "node:test";
import assert from "node:assert";
import { renderCardFaceSvg, renderCardBackSvg } from "../src/ui/renderCard.js";
import { isValidPackId } from "../src/arcade/storage.js";

const PAYLOAD = '"><img src=x onerror=alert(1)>';

// The only markup this renderer is allowed to emit. An escaped payload leaves
// `onerror=` sitting in the output as TEXT, which is inert and fine — what is
// never fine is a `<` that opens a tag we did not write, so the assertion is
// about tags rather than about scary-looking substrings.
const OWN_TAGS = /<\/?(svg|rect|text)[\s/>]/g;

function foreignTags(svg) {
  return (svg.match(/<[^]/g) || []).length - (svg.match(OWN_TAGS) || []).length;
}

test("a hostile card id renders inertly", () => {
  // No rank and no suit, so cardAriaLabel falls through to card.id — the path
  // that used to interpolate raw into the aria-label attribute.
  const svg = renderCardFaceSvg({ id: PAYLOAD });

  assert.strictEqual(foreignTags(svg), 0, "the payload opened a tag:\n" + svg);
  assert.ok(!svg.includes(PAYLOAD), "the payload survived verbatim, so it was never escaped");
  assert.ok(svg.includes("&quot;&gt;&lt;img"), "expected entity-escaped output, got:\n" + svg);
});

test("a hostile rank/suit/colour renders inertly", () => {
  const svg = renderCardFaceSvg({ rank: PAYLOAD, suit: PAYLOAD, color: PAYLOAD });
  assert.strictEqual(foreignTags(svg), 0, "the payload opened a tag:\n" + svg);
  assert.ok(!svg.includes(PAYLOAD));
});

test("a hostile colour cannot break out of the class attribute", () => {
  // cardFaceColor returns card.color verbatim, and it lands in class="…".
  const svg = renderCardFaceSvg({ rank: "3", color: '" onload="alert(1)' });
  assert.ok(!svg.includes('onload="'), "escaped the class attribute:\n" + svg);
});

test("every quote in the rendered face is one we opened", () => {
  // A structural check rather than a payload check: an odd number of quotes
  // means something interpolated one, which is the whole bug class.
  for (const card of [{ id: PAYLOAD }, { rank: '"', suit: "hearts" }, { rank: "A", color: '"' }]) {
    const quotes = (renderCardFaceSvg(card).match(/"/g) || []).length;
    assert.strictEqual(quotes % 2, 0, `unbalanced quotes for ${JSON.stringify(card)}`);
  }
});

test("the card back is a constant, with nothing to inject into", () => {
  assert.strictEqual(renderCardBackSvg(), renderCardBackSvg());
  assert.ok(!renderCardBackSvg().includes("${"));
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
