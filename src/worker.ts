#!/usr/bin/env node
import type { AgentEvent, WorkerRequest, WorkerResult } from "./domain.js";
import { inspectWorktree } from "./git.js";
import { ClaudeAdapter } from "./providers/claude.js";
import { CodexAdapter } from "./providers/codex.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { readWorkerReport } from "./result.js";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input) as WorkerRequest;
const adapters: ProviderAdapter[] = [new CodexAdapter(), new ClaudeAdapter()];
const provider = adapters.find((adapter) => adapter.name === request.task.provider);
if (!provider) throw new Error(`Unsupported provider ${request.task.provider}`);
await provider.checkAvailability();
const agentResult = await provider.run(request.task, (event: AgentEvent) => {
  process.stdout.write(`${JSON.stringify({ type: "event", event })}\n`);
});
const report = await readWorkerReport(request.task.reportPath);
const facts = await inspectWorktree(request.task.workspace, request.task.baseCommit);
const result: WorkerResult = {
  version: 0,
  taskId: request.task.id,
  ...(report.report ? { report: report.report } : {}),
  verification: {
    processExitCode: agentResult.exitCode,
    baseCommit: request.task.baseCommit,
    ...facts,
  },
  warnings: report.warnings,
};
process.stdout.write(`${JSON.stringify({ type: "result", version: 0, result })}\n`);
