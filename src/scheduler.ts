export interface SchedulableTask {
  id: string;
  dependencies: string[];
}

export async function runTaskDag<T extends SchedulableTask, R>(
  tasks: T[],
  execute: (task: T) => Promise<R>,
): Promise<R[]> {
  const pending = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const results: R[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((task) =>
      task.dependencies.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) throw new Error("Task graph contains a cycle or missing dependency.");
    const levelResults = await Promise.all(ready.map(execute));
    results.push(...levelResults);
    for (const task of ready) {
      pending.delete(task.id);
      completed.add(task.id);
    }
  }
  return results;
}
