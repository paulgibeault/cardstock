// The DOM helper every screen in this app was writing out for itself.
//
// `line` in particular: three verbatim copies, in src/ui/table.js,
// src/ui/panels.js and src/ui/lobby.js. It is four lines long, which is exactly
// why nobody extracted it and exactly why all three had to be checked when the
// question "does any of this use innerHTML?" came up (§7b — the answer must
// stay no; every one of these carries a NAME).

/**
 * A span wrapping card markup, PARSED ONCE PER DISTINCT CARD.
 *
 * Card SVG is markup this repo authors, with every card-derived value escaped
 * inside src/ui/cardStyles — so innerHTML on a fresh node is safe here in a way
 * it is NOT for anything carrying a name or a label. Those use `line` below.
 *
 * The renderer already memoizes the markup STRING, but innerHTML still ran the
 * HTML parser every time — and a render rebuilds every card on the table, so a
 * four-handed rummy table paid for 60–100 parses on every tap. A <template>
 * holds the parsed result and cloneNode copies it, which is the same work the
 * browser does for a repeated element and a great deal less than re-reading the
 * text.
 *
 * Keyed by the markup itself, so two cards that look identical (every card back
 * in the deck) share one entry, and a change of card style simply misses the
 * old keys — `clearSvgCache` drops them when a new pack's renderer is built.
 */
const svgTemplates = new Map();

export function svgNode(markup, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  let template = svgTemplates.get(markup);
  if (!template) {
    template = document.createElement('template');
    template.innerHTML = markup;
    svgTemplates.set(markup, template);
  }
  span.appendChild(template.content.cloneNode(true));
  return span;
}

/** Drop the parsed-markup cache — a new pack's cards are new markup. */
export function clearSvgCache() {
  svgTemplates.clear();
}

/** A span with a class and TEXT — never markup. */
export function line(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}
