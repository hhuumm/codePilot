import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AppLogStore,
  formatAppLogEntry,
} from "../src/app-log-store.js";

test("persists structured app sessions and output across store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-app-logs-"));
  const path = join(root, "codepilot.db");
  const startedAt = "2026-08-28T12:00:00.000Z";
  const endedAt = "2026-08-28T12:00:01.000Z";

  const first = new AppLogStore(path);
  const sessionId = first.startSession({
    command: "npm start",
    workingDirectory: ".",
    url: "http://localhost:3000",
    startedAt,
  });
  first.append(sessionId, "stdout", "ready\n", startedAt);
  first.append(sessionId, "stderr", "warning", endedAt);
  first.endSession(sessionId, { exitCode: 0, reason: "process-exit", endedAt });
  first.close();

  using second = new AppLogStore(path);
  assert.deepEqual(
    second.recent().map(({ stream, payload }) => ({ stream, payload })),
    [
      { stream: "stdout", payload: "ready\n" },
      { stream: "stderr", payload: "warning" },
    ],
  );
  using sessionDatabase = new DatabaseSync(path, { readOnly: true });
  const session = sessionDatabase
    .prepare(
      "SELECT ended_at, exit_code, stop_reason FROM app_sessions WHERE id = ?",
    )
    .get(sessionId) as Record<string, unknown>;
  assert.equal(session.ended_at, endedAt);
  assert.equal(session.exit_code, 0);
  assert.equal(session.stop_reason, "process-exit");
});

test("bounds retained history while preserving chunked payload data", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-app-retention-"));
  const path = join(root, "codepilot.db");
  using store = new AppLogStore(path, {
    maxEvents: 3,
    maxSessions: 2,
    maxPayloadCharacters: 4,
  });
  const first = store.startSession({
    command: "one",
    workingDirectory: ".",
    url: "http://localhost:3000",
  });
  store.append(first, "stdout", "abcdefgh");
  const second = store.startSession({
    command: "two",
    workingDirectory: ".",
    url: "http://localhost:3001",
  });
  store.append(second, "stdout", "middle");
  const third = store.startSession({
    command: "three",
    workingDirectory: ".",
    url: "http://localhost:3002",
  });
  store.append(third, "system", "stopped");

  assert.deepEqual(
    store.recent().map((entry) => entry.payload),
    ["le", "stop", "ped"],
  );
  using database = new DatabaseSync(path, { readOnly: true });
  const row = database
    .prepare("SELECT COUNT(*) count FROM app_sessions")
    .get() as Record<string, unknown>;
  assert.equal(row.count, 2);
});

test("formats persisted streams for the existing App Core output", () => {
  assert.equal(
    formatAppLogEntry({
      timestamp: "2026-08-28T12:00:00.000Z",
      stream: "stderr",
      payload: "warning",
    }),
    "[2026-08-28T12:00:00.000Z] [stderr] warning\n",
  );
});
