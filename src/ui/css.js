// Pack-supplied values that reach a CSS declaration, gated in one place.
//
// §7b: a manifest is untrusted the moment pack sharing ships (design §7d), and
// an inline style is a real sink — `url(...)` fetches, `var(...)` reads values
// the pack was never given, and a stray `;` opens the whole declaration block.
// Both gates below are ALLOW-lists of shapes a pack has any honest reason to
// send, not deny-lists of things that look dangerous.

/** Colour keyword or hex literal — what a choice button paints itself with. */
const CSS_COLOR_RE = /^(?:[a-zA-Z]{3,20}|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;

/** Six-digit hex only. Tile accents are mixed with `color-mix()`, which wants a real colour. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function safeCssColor(value, fallback = null) {
  return typeof value === 'string' && CSS_COLOR_RE.test(value) ? value : fallback;
}

export function safeAccent(value, fallback) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value : fallback;
}
