// The table's stylesheet, as the browser sees it.
//
// It is eleven files now (#221), and a test that greps the sheet for a rule
// wants the whole cascade rather than whichever file the rule happens to live
// in today. The order comes from index.html — the `<link>` sequence IS the
// cascade order, so reading it here means a test can never be looking at a
// different sheet from the one the page loads. That the sequence is the RIGHT
// one is a separate question, pinned by the link-order gate in
// tests/repo-gates.test.js.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../tools/stage.mjs";

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/** The stylesheet hrefs in index.html, in link order. */
export const LINKED_CSS = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
  .map((m) => (m[0].match(/href="([^"]+)"/) || [])[1])
  .filter(Boolean);

/**
 * Every linked stylesheet concatenated in cascade order, with a marker comment
 * between files so a failure can still say which one a rule came from.
 */
export function tableCss() {
  return LINKED_CSS
    .map((rel) => `/* ${rel} */\n` + fs.readFileSync(path.join(ROOT, rel), "utf8"))
    .join("\n");
}
