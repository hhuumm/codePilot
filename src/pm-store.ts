import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "./database.js";

export interface StoredPMTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: "low" | "medium" | "high";
  status: "backlog" | "blocked" | "ready" | "launched" | "done" | "committed";
  queueId: string;
  queueTitle: string;
  dependencies: string[];
  summary?: string;
  lastRunStatus?: string;
  failures?: Array<{ timestamp: string; summary: string }>;
  recommendedProvider?: "codex" | "claude" | "either";
  createdAt: string;
  updatedAt: string;
}

export interface StoredTaskBin {
  name: "committed";
  hash: string;
  taskIds: string[];
  taskTitles: string[];
  tasks: StoredPMTask[];
  commit: string;
  createdAt: string;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function databasePath(repo: string): string {
  return join(repo, ".codepilot", "codepilot.db");
}

function insertTask(database: DatabaseSync, task: StoredPMTask): void {
  database.prepare(`
    INSERT OR REPLACE INTO pm_tasks (
      id, title, description, acceptance_criteria, priority, status,
      queue_id, queue_title, dependencies, summary, last_run_status,
      failure_history, recommended_provider, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.title,
    task.description,
    JSON.stringify(task.acceptanceCriteria),
    task.priority,
    task.status,
    task.queueId,
    task.queueTitle,
    JSON.stringify(task.dependencies),
    task.summary ?? null,
    task.lastRunStatus ?? null,
    JSON.stringify(task.failures ?? []),
    task.recommendedProvider ?? null,
    task.createdAt,
    task.updatedAt,
  );
}

function insertBin(database: DatabaseSync, bin: StoredTaskBin): void {
  database.prepare(`
    INSERT OR REPLACE INTO pm_task_bins (
      hash, name, task_ids, task_titles, tasks_json, commit_sha, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    bin.hash,
    bin.name,
    JSON.stringify(bin.taskIds),
    JSON.stringify(bin.taskTitles),
    JSON.stringify(bin.tasks),
    bin.commit,
    bin.createdAt,
  );
}

function transaction(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

function rowToTask(row: Record<string, unknown>): StoredPMTask {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    acceptanceCriteria: JSON.parse(String(row.acceptance_criteria)) as string[],
    priority: String(row.priority) as StoredPMTask["priority"],
    status: String(row.status) as StoredPMTask["status"],
    queueId: String(row.queue_id),
    queueTitle: String(row.queue_title),
    dependencies: JSON.parse(String(row.dependencies)) as string[],
    ...(row.summary ? { summary: String(row.summary) } : {}),
    ...(row.last_run_status
      ? { lastRunStatus: String(row.last_run_status) }
      : {}),
    ...(() => {
      const failures = row.failure_history ? JSON.parse(String(row.failure_history)) as Array<{ timestamp: string; summary: string }> : [];
      return failures.length ? { failures } : {};
    })(),
    ...(row.recommended_provider
      ? {
          recommendedProvider: String(
            row.recommended_provider,
          ) as NonNullable<StoredPMTask["recommendedProvider"]>,
        }
      : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function openPMDatabase(repo: string): DatabaseSync {
  const path = databasePath(repo);
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  initializeDatabase(database);

  const migrated = database
    .prepare("SELECT value FROM pm_metadata WHERE key = 'json_migration_v1'")
    .get();
  if (!migrated) {
    const directory = join(repo, ".codepilot");
    const tasksPath = join(directory, "pm-tasks.json");
    const binsPath = join(directory, "task-bins.json");
    const tasks = existsSync(tasksPath)
      ? readJson<StoredPMTask[]>(tasksPath, [])
      : [];
    const bins = existsSync(binsPath)
      ? readJson<Array<Omit<StoredTaskBin, "name" | "tasks"> & { name?: "committed"; tasks?: StoredPMTask[] }>>(
          binsPath,
          [],
        )
      : [];
    transaction(database, () => {
      for (const task of tasks) insertTask(database, task);
      for (const bin of bins)
        insertBin(database, { ...bin, name: "committed", tasks: bin.tasks ?? [] });
      database
        .prepare(
          "INSERT INTO pm_metadata (key, value) VALUES ('json_migration_v1', ?)",
        )
        .run(new Date().toISOString());
    });
  }
  const emptyBins = database
    .prepare("SELECT hash, task_ids FROM pm_task_bins WHERE tasks_json = '[]'")
    .all() as Array<Record<string, unknown>>;
  if (emptyBins.length) {
    const tasks = (
      database.prepare("SELECT * FROM pm_tasks").all() as Array<
        Record<string, unknown>
      >
    ).map(rowToTask);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    transaction(database, () => {
      const update = database.prepare(
        "UPDATE pm_task_bins SET tasks_json = ? WHERE hash = ?",
      );
      for (const bin of emptyBins) {
        const taskIds = JSON.parse(String(bin.task_ids)) as string[];
        const snapshots = taskIds.flatMap((id) => {
          const task = byId.get(id);
          return task ? [task] : [];
        });
        if (snapshots.length)
          update.run(JSON.stringify(snapshots), String(bin.hash));
      }
    });
  }
  return database;
}

export function loadPMTasks(repo: string): StoredPMTask[] {
  using database = openPMDatabase(repo);
  return (
    database
      .prepare("SELECT * FROM pm_tasks ORDER BY created_at, id")
      .all() as Array<Record<string, unknown>>
  ).map(rowToTask);
}

export function loadPMTaskBins(repo: string): StoredTaskBin[] {
  using database = openPMDatabase(repo);
  return (
    database
      .prepare("SELECT * FROM pm_task_bins ORDER BY created_at DESC LIMIT 100")
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({
    name: "committed",
    hash: String(row.hash),
    taskIds: JSON.parse(String(row.task_ids)) as string[],
    taskTitles: JSON.parse(String(row.task_titles)) as string[],
    tasks: JSON.parse(String(row.tasks_json)) as StoredPMTask[],
    commit: String(row.commit_sha),
    createdAt: String(row.created_at),
  }));
}

export function savePMTasks(repo: string, tasks: StoredPMTask[]): void {
  using database = openPMDatabase(repo);
  transaction(database, () => {
    database.exec("DELETE FROM pm_tasks");
    for (const task of tasks) insertTask(database, task);
  });
}

export function saveCommittedTaskBin(
  repo: string,
  bin: StoredTaskBin,
  tasks: StoredPMTask[],
): void {
  using database = openPMDatabase(repo);
  transaction(database, () => {
    insertBin(database, bin);
    database.exec("DELETE FROM pm_tasks");
    for (const task of tasks) insertTask(database, task);
    database.prepare(`
      DELETE FROM pm_task_bins
      WHERE hash NOT IN (
        SELECT hash FROM pm_task_bins ORDER BY created_at DESC LIMIT 100
      )
    `).run();
  });
}
