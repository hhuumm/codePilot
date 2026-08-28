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
  assert.equal(result.createPullRequest, false);
});

test("parses explicit GitHub pull request publication", () => {
  const result = parseArgs(["run", "ship the feature", "--create-pr"]);
  assert.equal(result.createPullRequest, true);
  assert.equal(result.integrate, true);
  assert.equal(result.dryRun, false);
});
