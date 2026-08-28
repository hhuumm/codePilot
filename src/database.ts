import { DatabaseSync } from "node:sqlite";

export const DATABASE_VERSION = 3;

/**
 * Own the complete project-control schema in one place. Every process may open
 * the database, but schema changes must be added here and guarded by
 * `user_version` so existing projects remain readable.
 */
export function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      repo TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      external_id TEXT,
      provider TEXT NOT NULL,
      objective TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      workspace TEXT NOT NULL,
      dependencies TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      stream TEXT NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS events_task_id_idx ON events(task_id, id);
    CREATE TABLE IF NOT EXISTS worker_results (
      task_id TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS file_checkouts (
      path TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS file_checkouts_owner ON file_checkouts(owner);
    CREATE TABLE IF NOT EXISTS app_sessions (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      url TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER,
      stop_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS app_sessions_started_at_idx
      ON app_sessions(started_at DESC);
    CREATE TABLE IF NOT EXISTS app_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      stream TEXT NOT NULL CHECK(stream IN ('stdout', 'stderr', 'system')),
      payload TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES app_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS app_events_session_id_idx
      ON app_events(session_id, id);
    CREATE TABLE IF NOT EXISTS pm_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      queue_id TEXT NOT NULL,
      queue_title TEXT NOT NULL,
      dependencies TEXT NOT NULL,
      summary TEXT,
      last_run_status TEXT,
      failure_history TEXT NOT NULL DEFAULT '[]',
      recommended_provider TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pm_task_bins (
      hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      task_ids TEXT NOT NULL,
      task_titles TEXT NOT NULL,
      tasks_json TEXT NOT NULL DEFAULT '[]',
      commit_sha TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pm_tasks_status_idx ON pm_tasks(status);
    CREATE INDEX IF NOT EXISTS pm_task_bins_created_at_idx ON pm_task_bins(created_at DESC);
    CREATE TABLE IF NOT EXISTS pm_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  ensureColumn(database, "tasks", "external_id", "TEXT");
  ensureColumn(database, "tasks", "dependencies", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "tasks", "attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "pm_tasks", "summary", "TEXT");
  ensureColumn(database, "pm_tasks", "failure_history", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "pm_task_bins", "tasks_json", "TEXT NOT NULL DEFAULT '[]'");
  database.exec(`PRAGMA user_version = ${DATABASE_VERSION}`);
}

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
      .map((row) => String(row.name)),
  );
  if (!columns.has(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
