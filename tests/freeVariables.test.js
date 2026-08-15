// A NAME THAT IS NEITHER IMPORTED NOR DECLARED IS A CRASH WAITING FOR A CODE PATH.
//
// This exists because the table.js decomposition shipped two of them. Moving a
// function into a new module leaves its callees behind: `celebrations.js` called
// `handAddress` and `matchRecord.js` called `clearMatch`, neither imported.
// Nothing caught either one —
//
//   - `node --check` passes: a free variable is valid syntax;
//   - the test suite passes: these modules touch `document` at import time, so
//     no Node test can load them at all;
//   - the browser is silent until the exact line runs. `handAddress` needed a
//     penalty draw against the human; `clearMatch` needed a match to actually
//     END. One reached a playthrough; the other was still sitting there.
//
// So the check has to be STATIC and it has to run over source the tests cannot
// import. It is deliberately crude — a real scope analyser needs a parser this
// repo has no dependency for — and crude in the safe direction: it only looks at
// CALL position (`foo(`), and it treats every identifier declared ANYWHERE in a
// file as in scope, so it under-reports rather than crying wolf. A name declared
// in no scope at all and called anyway is exactly the bug it is for, and that is
// what it catches.
import { test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";

// Language keywords that are followed by `(`, plus the platform globals this
// codebase legitimately reaches for. Anything genuinely new belongs here with
// a reason, not silently.
const AMBIENT = new Set([
  // keywords and syntax that read as `name(`
  "if", "for", "while", "switch", "catch", "return", "typeof", "function", "await",
  "new", "do", "else", "of", "in", "void", "delete", "yield", "instanceof", "case",
  "throw", "try", "super", "async", "import", "this",
  // literals
  "true", "false", "null", "undefined", "Infinity", "NaN",
  // ECMAScript
  "Array", "ArrayBuffer", "BigInt", "Boolean", "DataView", "Date", "Error", "JSON",
  "Map", "Math", "Number", "Object", "Promise", "Proxy", "Reflect", "RegExp", "Set",
  // `new TypeError(...)` — the one a required argument throws when it is
  // missing (src/ui/party.js, #73). `Error` was already here; this is its
  // sibling and arrives for the same reason.
  "TypeError",
  "String", "Symbol", "WeakMap", "WeakSet", "isFinite", "isNaN", "parseFloat",
  "parseInt", "structuredClone", "Intl", "Uint8Array", "Int32Array", "Float64Array",
  // host: browser + the launcher SDK + Node's shared subset
  "Arcade", "CSS", "ResizeObserver", "TextDecoder", "TextEncoder", "URL",
  "URLSearchParams", "atob", "btoa", "cancelAnimationFrame", "clearInterval",
  "clearTimeout", "console", "crypto", "document", "fetch", "getComputedStyle",
  "globalThis", "performance", "process", "queueMicrotask", "requestAnimationFrame",
  "setInterval", "setTimeout", "window",
]);

/**
 * Comments only, for the checks that need string literals intact — an import's
 * module path is a string, and blanking it leaves nothing to resolve. That was
 * this gate's own first bug: it passed on the very import it was written for.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Comments and every kind of string literal, blanked so their contents cannot
 *  read as code. Template literals matter most: "follow suit (${led})" and a CSS
 *  `translate(...)` both look like calls otherwise. */
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * Every name BOUND anywhere in the file, over-approximated on purpose: imports,
 * declarations, object methods, and anything that looks like a parameter or a
 * destructured binding. Over-approximating is what keeps this from flagging a
 * name that is in scope somewhere the regex cannot see.
 */
function boundNames(code) {
  const names = new Set();
  const add = (raw) => {
    const name = String(raw).split(":").pop().split("=")[0].replace(/[.[\]]/g, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
  };

  for (const m of code.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) add(part.trim().split(/\s+as\s+/).pop());
  }
  for (const m of code.matchAll(/import\s+(\w+)\s*(?:,|from)/g)) add(m[1]);
  for (const m of code.matchAll(/import\s*\*\s*as\s+(\w+)/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+(\w+)/g)) add(m[1]);
  // destructuring: const { a, b: c } = …
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(",")) add(p);
  }
  // parameter lists — function decls, object methods, and arrow heads alike
  for (const m of code.matchAll(/(?:function\s*\w*|\b\w+)\s*\(([^()]*)\)\s*(?:\{|=>)/g)) {
    for (const p of m[1].replace(/[{}[\]]/g, ",").split(",")) add(p);
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].replace(/[{}[\]]/g, ",").split(",")) add(p);
  }
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // A DESTRUCTURED PARAMETER OBJECT, which is how every module extracted from
  // table.js takes its seams — `createDragController({ layer, onLift, … })`.
  // These routinely span lines, so they need their own pass rather than the
  // single-line parameter regex above.
  for (const m of code.matchAll(/[(,]\s*\{([\s\S]*?)\}\s*(?:,|=|\))/g)) {
    for (const p of m[1].split(",")) add(p);
  }
  // object-literal methods: `foo(a, b) {`
  //
  // ONE LEVEL OF NESTING, because a default that calls something is ordinary
  // JS — `sight(frame, { at = now() } = {})`. With a parameter list the regex
  // could not span, the method never entered the bound set and its own
  // DEFINITION then read as a call in the pass below: a free-variable report
  // for a name declared two characters to the left. Widening what counts as a
  // binding is the safe direction for this file (see the header) — it can only
  // ever make the check quieter, never louder.
  for (const m of code.matchAll(/(\w+)\s*\((?:[^()]|\([^()]*\))*\)\s*\{/g)) add(m[1]);
  return names;
}

const tracked = execSync("git ls-files src", { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".js"));

/**
 * A NAMED IMPORT THAT DOES NOT EXIST IS THE SAME BUG ONE STEP EARLIER.
 *
 * The check below catches a name nothing declares. This catches a name the
 * OTHER file does not export — which is worse, because it is not a crash on
 * some rare code path, it is a module that will not load at all, taking the
 * whole screen with it.
 *
 * It shipped the moment there was something to catch: #75 moved
 * `seatingFromRoster` into src/ui/partyModel.js and party.js imported it by
 * name before the `export` keyword was on it. Every unit test passed —
 * party.js touches `document` at import time, so no Node test can load it — and
 * the failure surfaced only in the three-launcher acceptance run, as three
 * pageerrors and a timeout twenty seconds later.
 *
 * RELATIVE, IN-REPO IMPORTS ONLY. A bare specifier is somebody else's package
 * and a URL is somebody else's server; neither is this gate's business.
 */
test("every named import resolves to something the other module exports", () => {
  const offenders = [];
  const exportsOf = new Map();
  const exportedNames = (code) => {
    const names = new Set();
    for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+(\w+)/g)) {
      names.add(m[1]);
    }
    // `export { a, b as c }` — the renamed half is what the importer sees.
    for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
    if (/export\s+\*/.test(code)) names.add("*"); // re-export: cannot resolve cheaply, so do not try
    return names;
  };

  for (const file of tracked) {
    const dir = path.dirname(file);
    // STRINGS INTACT HERE — the module path is one.
    const code = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
    for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g)) {
      const target = path.normalize(path.join(dir, m[2]));
      if (!tracked.includes(target)) {
        offenders.push(`${file}: imports from ${m[2]}, which is not a tracked file`);
        continue;
      }
      if (!exportsOf.has(target)) {
        exportsOf.set(target, exportedNames(
          stripComments(fs.readFileSync(path.join(ROOT, target), "utf8"))));
      }
      const available = exportsOf.get(target);
      if (available.has("*")) continue;
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (!name || available.has(name)) continue;
        offenders.push(`${file}: imports { ${name} } from ${m[2]}, which does not export it`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    "a missing named export is not a bad code path, it is a module that will not load");
});

test("every function a module calls is one it imports or declares", () => {
  const offenders = [];
  for (const file of tracked) {
    const code = stripNonCode(fs.readFileSync(path.join(ROOT, file), "utf8"));
    const bound = boundNames(code);
    const seen = new Set();
    // Call position only, and never a method call (`.foo(`) or a property
    // shorthand — those resolve against an object, not against scope.
    for (const m of code.matchAll(/(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const name = m[2];
      if (AMBIENT.has(name) || bound.has(name) || seen.has(name)) continue;
      seen.add(name);
      offenders.push(`${file}: calls ${name}() — not imported, not declared`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    "a free variable is valid syntax and a runtime crash; see this file's header");
});
