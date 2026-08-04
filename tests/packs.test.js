// The rule-test corpus, as the CI gate.
//
// This is a thin wrapper, not a second runner: tools/pack-test.mjs stays the
// CLI entry point and owns every assertion primitive, and this file just
// discovers the packs and turns each one into a node:test case. Duplicating
// the runner is how the CLI and the gate drift until only one of them is
// telling the truth.
import { test } from "node:test";
import assert from "node:assert";
import { listPackIds, runPackTests } from "../tools/pack-test.mjs";

const packIds = listPackIds();

test("every pack directory has rule tests to run", () => {
  assert.ok(packIds.length >= 5, `expected the five launch packs, found ${packIds.length}`);
});

for (const packId of packIds) {
  test(`${packId} rule tests`, async () => {
    const { passed, failures } = await runPackTests(packId, { log: null });
    assert.deepStrictEqual(
      failures.map((f) => `${f.name}\n${f.problems.join("\n")}`), [],
      `${packId} has failing rule tests`);
    assert.ok(passed > 0, `${packId} ran no assertions`);
  });
}
