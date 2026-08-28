import assert from "node:assert/strict";
import test from "node:test";
import { detectPathCollisions } from "../src/collision.js";
import type { WorkerResult } from "../src/domain.js";
import { runTaskDag } from "../src/scheduler.js";

test("runs dependency levels in order", async () => {
  const order: string[] = [];
  await runTaskDag(
    [
      { id: "child", dependencies: ["parent"] },
      { id: "parent", dependencies: [] },
    ],
    async (task) => {
      order.push(task.id);
    },
  );
  assert.deepEqual(order, ["parent", "child"]);
});

test("detects changed-path collisions", () => {
  const makeResult = (taskId: string, changedPaths: string[]): WorkerResult => ({
    version: 0,
    taskId,
    verification: {
      processExitCode: 0,
      baseCommit: "base",
      headCommit: taskId,
      resultCommit: taskId,
      changedPaths,
      dirtyPaths: [],
      commitDescendsFromBase: true,
    },
    warnings: [],
  });
  assert.deepEqual(detectPathCollisions([makeResult("a", ["same.ts"]), makeResult("b", ["same.ts"])]), [
    { path: "same.ts", taskIds: ["a", "b"] },
  ]);
});
