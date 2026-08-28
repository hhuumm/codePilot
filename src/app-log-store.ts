import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "./database.js";

export type AppLogStream = "stdout" | "stderr" | "system";

export type AppLogEntry = {
  id: number;
  sessionId: string;
  timestamp: string;
  stream: AppLogStream;
  payload: string;
};

export type AppSessionInput = {
  command: string;
  workingDirectory: string;
  url: string;
  startedAt?: string;
};

export type AppLogStoreOptions = {
  maxEvents?: number;
  maxSessions?: number;
  maxPayloadCharacters?: number;
};

const DEFAULT_MAX_EVENTS = 20_000;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_PAYLOAD_CHARACTERS = 64 * 1024;

export class AppLogStore implements Disposable {
  readonly #database: DatabaseSync;
  readonly #maxEvents: number;
  readonly #maxSessions: number;
  readonly #maxPayloadCharacters: number;

  constructor(path: string, options: AppLogStoreOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    initializeDatabase(this.#database);
    this.#maxEvents = positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS);
    this.#maxSessions = positiveInteger(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
    );
    this.#maxPayloadCharacters = positiveInteger(
      options.maxPayloadCharacters,
      DEFAULT_MAX_PAYLOAD_CHARACTERS,
    );
  }

  startSession(input: AppSessionInput): string {
    const id = randomUUID();
    this.#database
      .prepare(`
        INSERT INTO app_sessions (
          id, command, working_directory, url, started_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.command,
        input.workingDirectory,
        input.url,
        input.startedAt ?? new Date().toISOString(),
      );
    this.#pruneSessions();
    return id;
  }

  append(
    sessionId: string,
    stream: AppLogStream,
    payload: string,
    timestamp = new Date().toISOString(),
  ): void {
    if (!payload) return;
    const insert = this.#database.prepare(`
      INSERT INTO app_events (session_id, timestamp, stream, payload)
      VALUES (?, ?, ?, ?)
    `);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (let offset = 0; offset < payload.length; ) {
        const next = payload.slice(
          offset,
          offset + this.#maxPayloadCharacters,
        );
        insert.run(sessionId, timestamp, stream, next);
        offset += next.length;
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#pruneEvents();
  }

  endSession(
    sessionId: string,
    input: {
      exitCode?: number;
      reason: string;
      endedAt?: string;
    },
  ): void {
    this.#database
      .prepare(`
        UPDATE app_sessions
        SET ended_at = COALESCE(ended_at, ?),
            exit_code = COALESCE(exit_code, ?),
            stop_reason = COALESCE(stop_reason, ?)
        WHERE id = ?
      `)
      .run(
        input.endedAt ?? new Date().toISOString(),
        input.exitCode ?? null,
        input.reason,
        sessionId,
      );
  }

  recent(limit = 500): AppLogEntry[] {
    const boundedLimit = Math.min(5_000, positiveInteger(limit, 500));
    return (
      this.#database
        .prepare(`
          SELECT id,
                 session_id AS sessionId,
                 timestamp,
                 stream,
                 payload
          FROM app_events
          ORDER BY id DESC
          LIMIT ?
        `)
        .all(boundedLimit) as AppLogEntry[]
    ).reverse();
  }

  close(): void {
    this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #pruneEvents(): void {
    this.#database
      .prepare(`
        DELETE FROM app_events
        WHERE id <= COALESCE((
          SELECT id
          FROM app_events
          ORDER BY id DESC
          LIMIT 1 OFFSET ?
        ), 0)
      `)
      .run(this.#maxEvents);
  }

  #pruneSessions(): void {
    this.#database
      .prepare(`
        DELETE FROM app_sessions
        WHERE id IN (
          SELECT id
          FROM app_sessions
          ORDER BY started_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(this.#maxSessions);
  }
}

export function formatAppLogEntry(
  entry: Pick<AppLogEntry, "timestamp" | "stream" | "payload">,
): string {
  const stream = entry.stream === "stdout" ? "" : `[${entry.stream}] `;
  const line = `[${entry.timestamp}] ${stream}${entry.payload}`;
  return line.endsWith("\n") ? line : `${line}\n`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
