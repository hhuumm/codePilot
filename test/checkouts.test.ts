import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CheckoutTimeoutError,
  FileCheckoutStore,
  normalizeCheckoutPath,
} from "../src/checkouts.js";

test("acquires a set atomically and reports the blocking paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-checkouts-"));
  using store = new FileCheckoutStore(join(root, "state.db"));
  await store.acquire("agent-a", ["src/a.ts", "src/b.ts"]);
  await assert.rejects(
    store.acquire("agent-b", ["src/b.ts", "src/c.ts"]),
    (error) =>
      error instanceof CheckoutTimeoutError &&
      assert.deepEqual(error.blockedPaths, ["src/b.ts"]) === undefined,
  );
  assert.deepEqual(store.list().map(({ path, owner }) => ({ path, owner })), [
    { path: "src/a.ts", owner: "agent-a" },
    { path: "src/b.ts", owner: "agent-a" },
  ]);
});

test("waits for another owner to release before acquiring", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-checkouts-"));
  using first = new FileCheckoutStore(join(root, "state.db"));
  using second = new FileCheckoutStore(join(root, "state.db"));
  await first.acquire("agent-a", ["src/a.ts"]);
  const waiting = second.acquire("agent-b", ["src/a.ts"], { waitMs: 1_000, pollMs: 10 });
  setTimeout(() => first.release("agent-a"), 30);
  const acquired = await waiting;
  assert.equal(acquired[0]?.owner, "agent-b");
});

test("expired leases are recoverable and paths cannot escape the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-checkouts-"));
  using store = new FileCheckoutStore(join(root, "state.db"));
  await store.acquire("dead-agent", ["src/a.ts"], { leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await store.acquire("new-agent", ["src/a.ts"]))[0]?.owner, "new-agent");
  assert.throws(() => normalizeCheckoutPath(root, "../outside.ts"), /inside the project/);
});

test("release is owner-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-checkouts-"));
  using store = new FileCheckoutStore(join(root, "state.db"));
  await store.acquire("agent-a", ["src/a.ts"]);
  assert.equal(store.release("agent-b"), 0);
  assert.equal(store.release("agent-a", ["src/a.ts"]), 1);
  assert.deepEqual(store.list(), []);
});
