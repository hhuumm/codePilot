import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentTask } from "../src/domain.js";
import { isolatedAgentEnvironment, runJsonLinesProcess } from "../src/providers/process.js";
import { codexArguments } from "../src/providers/codex.js";

test("removes parent conversation identifiers from agent environments", () => {
  const isolated = isolatedAgentEnvironment({
    PATH: "tools",
    CODEX_HOME: "codex-home",
    CODEX_THREAD_ID: "parent-thread",
    CODEX_SESSION_TOKEN: "parent-session",
    CLAUDE_CONVERSATION_ID: "parent-conversation",
    GITHUB_TOKEN: "do-not-forward",
    OPENAI_API_KEY: "worker-auth",
  });
  assert.deepEqual(isolated, { PATH: "tools", CODEX_HOME: "codex-home", OPENAI_API_KEY: "worker-auth" });
});

test("frames JSON lines across arbitrary process chunks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codepilot-process-"));
  const task = {
    id: "split-json",
    provider: "codex",
    workspace,
  } as AgentTask;
  const result = await runJsonLinesProcess(
    process.execPath,
    ["-e", `process.stdout.write('{\"kind\":'); setTimeout(() => process.stdout.write('\"ok\"}\\n'), 10)`],
    task,
    () => undefined,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.events.map((event) => event.payload), [{ kind: "ok" }]);
});

test("bounds a worker output line", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codepilot-process-"));
  const task = { id: "large-line", provider: "codex", workspace } as AgentTask;
  const result = await runJsonLinesProcess(
    process.execPath,
    ["-e", `process.stdout.write('x'.repeat(300000) + '\\n')`],
    task,
    () => undefined,
  );
  assert.equal(result.events.length, 1);
  assert.match(String(result.events[0]?.payload), /codePilot truncated/);
  assert.ok(Buffer.byteLength(String(result.events[0]?.payload)) < 270_000);
});

test("Codex worker sessions are ephemeral", () => {
  const task = { workspace: "repo", objective: "work", reportPath: "report.json" } as Parameters<typeof codexArguments>[0];
  const args = codexArguments(task);
  assert.ok(args.includes("--ephemeral"));
  if (process.platform === "win32") assert.match(args.at(-1)!, /WriteAllText/);
});

test("Codex worker model can be configured independently", () => {
  const task = { workspace: "repo", objective: "work", reportPath: "report.json" } as Parameters<typeof codexArguments>[0];
  const args = codexArguments(task, { CODEPILOT_WORKER_MODEL: "cheap-coder" });
  assert.deepEqual(args.slice(0, 5), ["exec", "--ephemeral", "--model", "cheap-coder", "--json"]);
});

test("Codex workers default to the low-cost model", () => {
  const task = { workspace: "repo", objective: "work", reportPath: "report.json" } as Parameters<typeof codexArguments>[0];
  const args = codexArguments(task, {});
  assert.deepEqual(args.slice(0, 5), ["exec", "--ephemeral", "--model", "gpt-5.6-luna", "--json"]);
});

test("Codex worker checkout instructions use the manager-provided command", () => {
  const task = {
    id: "worker-one",
    workspace: "repo",
    objective: "work",
    reportPath: "report.json",
    coordinationRepo: "C:\\projects\\app",
    checkoutCommand: 'node "C:\\codePilot\\dist\\src\\cli.js"',
  } as Parameters<typeof codexArguments>[0];
  const prompt = codexArguments(task, {}).at(-1)!;
  assert.match(prompt, /node "C:\\codePilot\\dist\\src\\cli\.js" checkout acquire/);
  assert.doesNotMatch(prompt, /\ncodepilot checkout acquire/);
});
