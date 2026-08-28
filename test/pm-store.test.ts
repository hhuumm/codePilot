import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadPMTaskBins,
  loadPMTasks,
  saveCommittedTaskBin,
  savePMTasks,
  type StoredPMTask,
} from "../src/pm-store.js";

function task(
  id: string,
  status: StoredPMTask["status"] = "ready",
): StoredPMTask {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: `Task ${id}`,
    description: `Description ${id}`,
    acceptanceCriteria: ["It works"],
    priority: "medium",
    status,
    queueId: "general",
    queueTitle: "General",
    dependencies: [],
    recommendedProvider: "either",
    createdAt: now,
    updatedAt: now,
  };
}

test("migrates legacy PM task and bin JSON into SQLite once", () => {
  const repo = mkdtempSync(join(tmpdir(), "codepilot-pm-store-"));
  try {
    const directory = join(repo, ".codepilot");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "pm-tasks.json"),
      JSON.stringify([task("legacy")]),
    );
    writeFileSync(
      join(directory, "task-bins.json"),
      JSON.stringify([
        {
          hash: "legacy-bin",
          taskIds: ["legacy"],
          taskTitles: ["Task legacy"],
          commit: "abc123",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ]),
    );

    assert.equal(loadPMTasks(repo)[0]?.id, "legacy");
    assert.deepEqual(loadPMTaskBins(repo)[0], {
      name: "committed",
      hash: "legacy-bin",
      taskIds: ["legacy"],
      taskTitles: ["Task legacy"],
      tasks: [task("legacy")],
      commit: "abc123",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    writeFileSync(
      join(directory, "pm-tasks.json"),
      JSON.stringify([task("should-not-reimport")]),
    );
    assert.equal(loadPMTasks(repo)[0]?.id, "legacy");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cycles an archived task out of active tasks and stores its snapshot", () => {
  const repo = mkdtempSync(join(tmpdir(), "codepilot-pm-store-"));
  try {
    savePMTasks(repo, [task("one"), task("two")]);
    const committed = task("one", "committed");
    saveCommittedTaskBin(
      repo,
      {
        name: "committed",
        hash: "cluster-one",
        taskIds: ["one"],
        taskTitles: ["Task one"],
        tasks: [committed],
        commit: "def456",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      [task("two")],
    );

    assert.equal(loadPMTasks(repo).some(({ id }) => id === "one"), false);
    assert.equal(loadPMTaskBins(repo)[0]?.hash, "cluster-one");
    assert.deepEqual(loadPMTaskBins(repo)[0]?.tasks, [committed]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
