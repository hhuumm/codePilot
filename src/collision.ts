import type { PathCollision, WorkerResult } from "./domain.js";

export function detectPathCollisions(results: WorkerResult[]): PathCollision[] {
  const owners = new Map<string, Set<string>>();
  for (const result of results) {
    for (const path of result.verification.changedPaths) {
      const tasks = owners.get(path) ?? new Set<string>();
      tasks.add(result.taskId);
      owners.set(path, tasks);
    }
  }
  return [...owners]
    .filter(([, tasks]) => tasks.size > 1)
    .map(([path, tasks]) => ({ path, taskIds: [...tasks].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
