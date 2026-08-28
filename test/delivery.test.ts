import assert from "node:assert/strict";
import test from "node:test";
import type { RunSummary } from "../src/domain.js";
import { buildPullRequestBody } from "../src/delivery.js";

test("builds a pull request body from worker, Git, validation, and review evidence", () => {
  const summary: RunSummary = {
    version: 0,
    runId: "run-1",
    status: "completed",
    baseCommit: "base-commit",
    integrationBranch: "codepilot/run-1",
    taskResults: [{
      version: 0,
      taskId: "task-1",
      provider: "codex",
      report: {
        version: 0,
        status: "completed",
        summary: "Implemented the feature.",
        claimedTests: ["npm test"],
        concerns: [],
        followUps: ["Monitor the rollout."],
      },
      verification: {
        processExitCode: 0,
        baseCommit: "base-commit",
        headCommit: "result-commit",
        resultCommit: "result-commit",
        changedPaths: ["src/feature.ts"],
        dirtyPaths: [],
        commitDescendsFromBase: true,
      },
      warnings: [],
    }],
    collisions: [],
    validations: [{ command: "npm test", exitCode: 0, durationMs: 42, stdout: "", stderr: "" }],
    review: { verdict: "ready", findings: [] },
  };

  const body = buildPullRequestBody("Ship the feature", summary);
  assert.match(body, /Ship the feature/);
  assert.match(body, /Implemented the feature/);
  assert.match(body, /src\/feature\.ts/);
  assert.match(body, /npm test/);
  assert.match(body, /Monitor the rollout/);
});

test("neutralizes unintended mentions and issue-closing directives in generated prose", () => {
  const summary: RunSummary = {
    version: 0,
    runId: "run-2",
    status: "needs_review",
    baseCommit: "base",
    taskResults: [],
    collisions: [],
    validations: [],
    review: { verdict: "needs_review", findings: ["Ask @maintainer; fixes #123"] },
  };
  const body = buildPullRequestBody("Notify @team and closes #9", summary);
  assert.doesNotMatch(body, /@team/);
  assert.doesNotMatch(body, /closes #9/i);
  assert.doesNotMatch(body, /fixes #123/i);
});
