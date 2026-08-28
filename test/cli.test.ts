import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.js";

test("parses a dry run with multiple providers", () => {
  const result = parseArgs([
    "run",
    "implement the feature",
    "--repo",
    ".",
    "--agents",
    "codex,claude",
    "--dry-run",
  ]);

  assert.equal(result.objective, "implement the feature");
  assert.deepEqual(result.providers, ["codex", "claude"]);
  assert.equal(result.dryRun, true);
});
