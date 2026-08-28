import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTaskLaunchable,
  cycleTasksOut,
  omitTaskDependencies,
  reconcileTaskStatuses,
  topologicallySortTasks,
  validateTaskGraph,
} from "../src/pm-graph.js";

const task = (
  id: string,
  dependencies: string[] = [],
  status: "backlog" | "blocked" | "ready" | "launched" | "done" | "committed" =
    "backlog",
) => ({ id, dependencies, status });

test("dependency statuses release only tasks whose prerequisites are done", () => {
  const initial = reconcileTaskStatuses([
    task("foundation"),
    task("api", ["foundation"]),
    task("ui", ["foundation"]),
    task("integration", ["api", "ui"]),
  ]);
  assert.deepEqual(
    initial.map(({ id, status }) => [id, status]),
    [
      ["foundation", "ready"],
      ["api", "blocked"],
      ["ui", "blocked"],
      ["integration", "blocked"],
    ],
  );

  const released = reconcileTaskStatuses([
    task("foundation", [], "done"),
    task("api", ["foundation"]),
    task("ui", ["foundation"]),
    task("integration", ["api", "ui"]),
  ]);
  assert.equal(released.find(({ id }) => id === "api")?.status, "ready");
  assert.equal(released.find(({ id }) => id === "ui")?.status, "ready");
  assert.equal(
    released.find(({ id }) => id === "integration")?.status,
    "blocked",
  );
});

test("committed tasks stay archived and satisfy dependencies", () => {
  const tasks = reconcileTaskStatuses([
    task("foundation", [], "committed"),
    task("api", ["foundation"]),
  ]);
  assert.equal(tasks[0]?.status, "committed");
  assert.equal(tasks[1]?.status, "ready");
});

test("cycling tasks out removes them and releases their dependents", () => {
  const tasks = cycleTasksOut(
    [task("foundation", [], "done"), task("api", ["foundation"], "blocked")],
    ["foundation"],
  );
  assert.deepEqual(tasks, [task("api", [], "ready")]);
});

test("omits satisfied or deleted dependencies without hiding unknown ids", () => {
  const tasks = omitTaskDependencies(
    [task("integration", ["committed", "deleted", "unknown"])],
    ["committed", "deleted"],
  );
  assert.deepEqual(tasks[0]?.dependencies, ["unknown"]);
  assert.throws(() => validateTaskGraph(tasks), /missing task "unknown"/);
});

test("invalid dependency graphs are rejected", () => {
  assert.throws(
    () => validateTaskGraph([task("a", ["missing"])]),
    /missing task/,
  );
  assert.throws(
    () => validateTaskGraph([task("a", ["b"]), task("b", ["a"])]),
    /dependency cycle/,
  );
  assert.throws(() => validateTaskGraph([task("a", ["a"])]), /itself/);
});

test("launch checks cannot bypass unfinished dependencies", () => {
  const tasks = [task("foundation", [], "ready"), task("api", ["foundation"], "blocked")];
  assert.throws(() => assertTaskLaunchable("api", tasks), /blocked/);
  assert.doesNotThrow(() =>
    assertTaskLaunchable("foundation", tasks),
  );
});

test("topological order places dependencies before their consumers", () => {
  const sorted = topologicallySortTasks([
    task("integration", ["api", "ui"]),
    task("ui", ["foundation"]),
    task("foundation"),
    task("api", ["foundation"]),
  ]);
  const positions = new Map(sorted.map(({ id }, index) => [id, index]));
  assert.ok(positions.get("foundation")! < positions.get("api")!);
  assert.ok(positions.get("foundation")! < positions.get("ui")!);
  assert.ok(positions.get("api")! < positions.get("integration")!);
  assert.ok(positions.get("ui")! < positions.get("integration")!);
});
