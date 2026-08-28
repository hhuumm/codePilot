export type PMWorkflowStatus =
  | "backlog"
  | "blocked"
  | "ready"
  | "launched"
  | "done"
  | "committed";

export interface DependencyTask {
  id: string;
  dependencies: string[];
  status: PMWorkflowStatus;
}

export function validateTaskGraph(tasks: DependencyTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id) throw new Error("Every PM task must have an id.");
    if (ids.has(task.id)) throw new Error(`Duplicate PM task id: ${task.id}`);
    ids.add(task.id);
  }

  for (const task of tasks) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (dependency === task.id)
        throw new Error(`Task "${task.id}" cannot depend on itself.`);
      if (!ids.has(dependency))
        throw new Error(
          `Task "${task.id}" depends on missing task "${dependency}".`,
        );
      if (dependencies.has(dependency))
        throw new Error(
          `Task "${task.id}" lists dependency "${dependency}" more than once.`,
        );
      dependencies.add(dependency);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string, path: string[]) => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id].join(" -> ");
      throw new Error(`PM task dependency cycle: ${cycle}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const task = byId.get(id)!;
    for (const dependency of task.dependencies)
      visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id, []);
}

export function reconcileTaskStatuses<T extends DependencyTask>(tasks: T[]): T[] {
  validateTaskGraph(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => {
    if (
      task.status === "launched" ||
      task.status === "done" ||
      task.status === "committed"
    )
      return task;
    const ready = task.dependencies.every(
      (dependency) =>
        ["done", "committed"].includes(byId.get(dependency)?.status ?? ""),
    );
    return { ...task, status: ready ? "ready" : "blocked" };
  });
}

export function assertTaskLaunchable(
  taskId: string,
  tasks: DependencyTask[],
): void {
  validateTaskGraph(tasks);
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("Task not found");
  if (task.status === "launched") throw new Error("Task is already running");
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const incomplete = task.dependencies.filter(
    (dependency) =>
      !["done", "committed"].includes(byId.get(dependency)?.status ?? ""),
  );
  if (incomplete.length)
    throw new Error(
      `Task is blocked by incomplete dependencies: ${incomplete.join(", ")}`,
    );
  if (task.status !== "ready" && task.status !== "done")
    throw new Error(`Task cannot launch while its status is "${task.status}".`);
}

export function topologicallySortTasks<T extends DependencyTask>(tasks: T[]): T[] {
  validateTaskGraph(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const emitted = new Set<string>();
  const sorted: T[] = [];
  const emit = (task: T) => {
    if (emitted.has(task.id)) return;
    for (const dependency of task.dependencies) emit(byId.get(dependency)!);
    emitted.add(task.id);
    sorted.push(task);
  };
  for (const task of tasks) emit(task);
  return sorted;
}

export function cycleTasksOut<T extends DependencyTask>(
  tasks: T[],
  taskIds: Iterable<string>,
): T[] {
  const archived = new Set(taskIds);
  return reconcileTaskStatuses(
    tasks
      .filter((task) => !archived.has(task.id))
      .map((task) => ({
        ...task,
        dependencies: task.dependencies.filter(
          (dependency) => !archived.has(dependency),
        ),
      })),
  );
}

/**
 * Removes dependency edges that are already satisfied or were deliberately
 * removed. Unknown dependency ids are intentionally left in place so graph
 * validation still catches model mistakes and corrupted state.
 */
export function omitTaskDependencies<T extends DependencyTask>(
  tasks: T[],
  taskIds: Iterable<string>,
): T[] {
  const omitted = new Set(taskIds);
  return tasks.map((task) => ({
    ...task,
    dependencies: task.dependencies.filter((dependency) => !omitted.has(dependency)),
  }));
}
