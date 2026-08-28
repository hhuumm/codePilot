import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent, AgentTask, RunStatus, RunSummary, TaskStatus, WorkerResult } from "./domain.js";
import { initializeDatabase } from "./database.js";

const MAX_EVENTS_PER_TASK = 5_000;

export class RunStore implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    initializeDatabase(this.#database);
  }

  addTask(task: AgentTask): void {
    this.#database
      .prepare(`
        INSERT INTO tasks (
          id, run_id, external_id, provider, objective, base_commit, workspace,
          dependencies, attempts, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.runId,
        task.externalId ?? null,
        task.provider,
        task.objective,
        task.baseCommit,
        task.workspace,
        JSON.stringify(task.dependencies),
        task.attempts,
        task.status,
        task.createdAt,
        task.updatedAt,
      );
  }

  addRun(id: string, objective: string, repo: string, baseCommit: string): void {
    const now = new Date().toISOString();
    this.#database
      .prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, objective, repo, baseCommit, "running", null, now, now);
  }

  finishRun(id: string, status: RunStatus, summary: RunSummary): void {
    this.#database
      .prepare("UPDATE runs SET status = ?, summary = ?, updated_at = ? WHERE id = ?")
      .run(status, JSON.stringify(summary), new Date().toISOString(), id);
  }

  setStatus(taskId: string, status: TaskStatus): void {
    this.#database
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), taskId);
  }

  setAttempt(taskId: string, attempts: number): void {
    this.#database
      .prepare("UPDATE tasks SET attempts = ?, updated_at = ? WHERE id = ?")
      .run(attempts, new Date().toISOString(), taskId);
  }

  addEvent(event: AgentEvent): void {
    this.#database
      .prepare("INSERT INTO events (task_id, provider, timestamp, stream, payload) VALUES (?, ?, ?, ?, ?)")
      .run(event.taskId, event.provider, event.timestamp, event.stream, JSON.stringify(event.payload));
    this.#database.prepare(`
      DELETE FROM events
      WHERE task_id = ? AND id <= (
        SELECT COALESCE(MAX(id) - ?, 0) FROM events WHERE task_id = ?
      )
    `).run(event.taskId, MAX_EVENTS_PER_TASK, event.taskId);
  }

  addWorkerResult(result: WorkerResult): void {
    this.#database
      .prepare("INSERT OR REPLACE INTO worker_results (task_id, result, created_at) VALUES (?, ?, ?)")
      .run(result.taskId, JSON.stringify(result), new Date().toISOString());
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
