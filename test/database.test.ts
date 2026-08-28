import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DATABASE_VERSION, initializeDatabase } from "../src/database.js";

test("upgrades the legacy task schema and records its database version", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-database-"));
  const path = join(root, "codepilot.db");
  using database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      objective TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      workspace TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  initializeDatabase(database);

  const columns = new Set(
    (database.prepare("PRAGMA table_info(tasks)").all() as Array<Record<string, unknown>>)
      .map((row) => String(row.name)),
  );
  assert.ok(columns.has("external_id"));
  assert.ok(columns.has("dependencies"));
  assert.ok(columns.has("attempts"));
  const tables = new Set(
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<Record<string, unknown>>
    ).map((row) => String(row.name)),
  );
  assert.ok(tables.has("app_sessions"));
  assert.ok(tables.has("app_events"));
  const version = database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  assert.equal(Number(version.user_version), DATABASE_VERSION);
});
