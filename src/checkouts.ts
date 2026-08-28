import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "./database.js";

export interface FileCheckout {
  path: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AcquireOptions {
  waitMs?: number;
  leaseMs?: number;
  pollMs?: number;
  priority?: number;
  signal?: AbortSignal;
}

export class CheckoutTimeoutError extends Error {
  constructor(readonly blockedPaths: string[]) {
    super(`Timed out waiting for checkout: ${blockedPaths.join(", ")}`);
  }
}

/** A project-scoped, cooperative file lease registry backed by SQLite. */
export class FileCheckoutStore implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    initializeDatabase(this.#database);
  }

  async acquire(owner: string, paths: string[], options: AcquireOptions = {}): Promise<FileCheckout[]> {
    if (!owner.trim()) throw new Error("Checkout owner is required.");
    const requested = normalizePaths(paths);
    if (requested.length === 0) throw new Error("At least one path is required.");
    const waitMs = options.waitMs ?? 0;
    const priority = Math.max(0, Math.min(100, options.priority ?? 50));
    const initialPollMs = Math.max(50, Math.round((options.pollMs ?? 250) * (1.5 - priority / 100)));
    let pollMs = initialPollMs;
    const deadline = Date.now() + waitMs;
    while (true) {
      options.signal?.throwIfAborted();
      const result = this.#tryAcquire(owner, requested, options.leaseMs ?? 30 * 60_000);
      if (result.checkouts) return result.checkouts;
      if (Date.now() >= deadline) throw new CheckoutTimeoutError(result.blockedPaths);
      await abortableDelay(Math.min(pollMs, Math.max(1, deadline - Date.now())), options.signal);
      pollMs = Math.min(5_000, pollMs * 2);
    }
  }

  renew(owner: string, leaseMs = 30 * 60_000): number {
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    return Number(this.#database.prepare("UPDATE file_checkouts SET expires_at = ? WHERE owner = ?").run(expiresAt, owner).changes);
  }

  release(owner: string, paths?: string[]): number {
    if (!paths?.length)
      return Number(this.#database.prepare("DELETE FROM file_checkouts WHERE owner = ?").run(owner).changes);
    const requested = normalizePaths(paths);
    const placeholders = requested.map(() => "?").join(",");
    return Number(
      this.#database
        .prepare(`DELETE FROM file_checkouts WHERE owner = ? AND path IN (${placeholders})`)
        .run(owner, ...requested).changes,
    );
  }

  list(): FileCheckout[] {
    this.#purgeExpired();
    return this.#database
      .prepare("SELECT path, owner, acquired_at AS acquiredAt, expires_at AS expiresAt FROM file_checkouts ORDER BY path")
      .all() as unknown as FileCheckout[];
  }

  #tryAcquire(
    owner: string,
    paths: string[],
    leaseMs: number,
  ): { checkouts?: FileCheckout[]; blockedPaths: string[] } {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#purgeExpired();
      const placeholders = paths.map(() => "?").join(",");
      const conflicts = this.#database
        .prepare(`SELECT path FROM file_checkouts WHERE path IN (${placeholders}) AND owner <> ?`)
        .all(...paths, owner) as Array<{ path: string }>;
      if (conflicts.length) {
        this.#database.exec("ROLLBACK");
        return { blockedPaths: conflicts.map(({ path }) => path).sort() };
      }
      const acquiredAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      const statement = this.#database.prepare(`
        INSERT INTO file_checkouts(path, owner, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET expires_at = excluded.expires_at
        WHERE file_checkouts.owner = excluded.owner
      `);
      for (const path of paths) statement.run(path, owner, acquiredAt, expiresAt);
      this.#database.exec("COMMIT");
      return {
        blockedPaths: [],
        checkouts: paths.map((path) => ({ path, owner, acquiredAt, expiresAt })),
      };
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Transaction did not start. */ }
      throw error;
    }
  }

  #purgeExpired(): void {
    this.#database.prepare("DELETE FROM file_checkouts WHERE expires_at <= ?").run(new Date().toISOString());
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

export function checkoutDatabasePath(repo: string): string {
  return resolve(repo, ".codepilot", "codepilot.db");
}

export function normalizeCheckoutPath(repo: string, path: string): string {
  const root = resolve(repo);
  const absolute = resolve(root, path);
  const projectPath = relative(root, absolute);
  if (!projectPath || projectPath === ".." || projectPath.startsWith(`..\\`) || projectPath.startsWith("../") || (isAbsolute(projectPath)))
    throw new Error(`Checkout path must be a file inside the project: ${path}`);
  return posix.normalize(projectPath.replaceAll("\\", "/"));
}

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => posix.normalize(path.replaceAll("\\", "/").trim())).filter(Boolean))].sort();
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
