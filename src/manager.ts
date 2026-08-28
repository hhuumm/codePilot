import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { detectPathCollisions } from "./collision.js";
import { clearAgentGuidance, clearAgentInterrupt, drainAgentGuidance, registerAgentInterrupt } from "./control.js";
import { buildPullRequestBody, createGitHubPullRequest } from "./delivery.js";
import type {
  AgentEvent,
  AgentTask,
  ProviderName,
  RunRequest,
  RunStatus,
  RunSummary,
  WorkerResult,
} from "./domain.js";
import {
  assertGitRepository,
  cherryPick,
  commitWorkspaceChanges,
  createBranchWorktree,
  createDetachedWorktree,
  inspectWorktree,
  preserveTaskCommit,
  removeWorktree,
  repositoryContext,
  resolveHead,
} from "./git.js";
import { checkoutDatabasePath, FileCheckoutStore } from "./checkouts.js";
import { ClaudeAdapter } from "./providers/claude.js";
import { CodexAdapter } from "./providers/codex.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { readWorkerReport } from "./result.js";
import { reviewRun } from "./review.js";
import { runTaskDag } from "./scheduler.js";
import { RunStore } from "./store.js";
import { discoverValidationCommands, runValidation } from "./validation.js";

const repositoryRunTails = new Map<string, Promise<void>>();
const MAX_RETAINED_ARTIFACTS = 20;
const MAX_RETAINED_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_RETAINED_ARTIFACT_TOTAL_BYTES = 500 * 1024 * 1024;

async function retainWorkerArtifacts(task: AgentTask, repo: string, paths: string[]): Promise<{ paths: string[]; warnings: string[] }> {
  const retained: string[] = [];
  const warnings: string[] = [];
  let retainedBytes = 0;
  const workspace = await realpath(task.workspace);
  for (const requested of paths.slice(0, MAX_RETAINED_ARTIFACTS)) {
    try {
      if (!requested.trim() || isAbsolute(requested)) throw new Error("path must be workspace-relative");
      const source = await realpath(resolve(workspace, requested));
      const fromWorkspace = relative(workspace, source);
      if (!fromWorkspace || fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) throw new Error("path escapes the workspace");
      const facts = await stat(source);
      if (!facts.isFile()) throw new Error("path is not a file");
      if (facts.size > MAX_RETAINED_ARTIFACT_BYTES) throw new Error("file exceeds the 100 MiB retention limit");
      if (retainedBytes + facts.size > MAX_RETAINED_ARTIFACT_TOTAL_BYTES) throw new Error("artifacts exceed the 500 MiB total retention limit");
      const destination = join(repo, ".codepilot", "artifacts", task.runId, task.id, fromWorkspace);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      retained.push(destination);
      retainedBytes += facts.size;
    } catch (error) {
      warnings.push(`Could not retain artifact ${JSON.stringify(requested)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (paths.length > MAX_RETAINED_ARTIFACTS) warnings.push(`Only the first ${MAX_RETAINED_ARTIFACTS} reported artifacts were considered.`);
  return { paths: retained, warnings };
}

async function withRepositoryRunLock<T>(repo: string, operation: () => Promise<T>): Promise<T> {
  const previous = repositoryRunTails.get(repo) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  repositoryRunTails.set(repo, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repositoryRunTails.get(repo) === tail) repositoryRunTails.delete(repo);
  }
}

export class Manager {
  readonly #providers: Map<ProviderName, ProviderAdapter>;

  constructor(providers: ProviderAdapter[] = [new CodexAdapter(), new ClaudeAdapter()]) {
    this.#providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  async run(
    request: RunRequest,
    onEvent: (event: AgentEvent) => void = () => undefined,
  ): Promise<RunSummary> {
    const repo = await assertGitRepository(request.repo);
    return await withRepositoryRunLock(repo, () => this.#run({ ...request, repo }, onEvent));
  }

  async #run(request: RunRequest, onEvent: (event: AgentEvent) => void): Promise<RunSummary> {
    const repo = request.repo;
    const baseCommit = await resolveHead(repo);
    const runId = randomUUID();
    const stateDirectory = join(repo, ".codepilot");
    using store = new RunStore(join(stateDirectory, "codepilot.db"));
    store.addRun(runId, request.objective, repo, baseCommit);

    // Worker clones must not be nested inside the source repository. Codex's
    // Windows sandbox treats an outer repo plus an inner clone as split
    // writable roots and refuses native file edits.
    const worktreeRoot = join(tmpdir(), "codepilot-workers", runId);
    const context = await repositoryContext(repo, baseCommit);
    const workItems = request.workItems ?? request.providers.map((provider, index) => ({
      id: `${provider}-${index}`,
      objective: request.objective,
      provider,
    }));
    const tasks = workItems.map((workItem): AgentTask => {
      const now = new Date().toISOString();
      const id = randomUUID();
      const checkoutCommand = resolveCheckoutCommand();
      return {
        id,
        ...(request.workItems ? { externalId: workItem.id } : {}),
        runId,
        objective: `${workItem.objective}\n\nRepository context at ${context.baseCommit}:\n${context.trackedPaths
          .slice(0, 200)
          .join("\n")}${context.curatedKnowledge.length ? `\n\nPublished project knowledge:\n${context.curatedKnowledge.map((entry) => `## ${entry.title}\n${entry.content}`).join("\n\n")}` : ""}`,
        provider: workItem.provider,
        baseCommit,
        workspace: join(worktreeRoot, id.slice(0, 8)),
        reportPath: join(worktreeRoot, id.slice(0, 8), ".codepilot-result.json"),
        coordinationRepo: repo,
        checkoutLeaseMs: request.timeoutMs ?? 30 * 60_000,
        ...(checkoutCommand ? { checkoutCommand } : {}),
        dependencies: [],
        attempts: 0,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
    });
    for (const task of tasks) store.addTask(task);

    if (request.dryRun) {
      const review = { verdict: "needs_review" as const, findings: ["Dry run; no workers were started."] };
      const summary: RunSummary = {
        version: 0,
        runId,
        status: "needs_review",
        baseCommit,
        taskResults: [],
        collisions: [],
        validations: [],
        review,
      };
      store.finishRun(runId, summary.status, summary);
      process.stdout.write(`${JSON.stringify({ ...summary, tasks }, null, 2)}\n`);
      return summary;
    }

    const results: WorkerResult[] = [];
    try {
      for (const task of tasks) await createDetachedWorktree(repo, task.workspace, baseCommit);
      const settled = await runTaskDag(tasks, async (task) => {
        store.setStatus(task.id, "leased");
        try {
          return await this.#executeTask(task, request, store, onEvent);
        } finally {
          using checkouts = new FileCheckoutStore(checkoutDatabasePath(repo));
          checkouts.release(task.id);
        }
      });
      results.push(...settled);
      for (const result of results) {
        if (result.verification.resultCommit) {
          const task = tasks.find((candidate) => candidate.id === result.taskId)!;
          await preserveTaskCommit(repo, runId, result.taskId, result.verification.resultCommit, task.workspace);
        }
      }
    } finally {
      await Promise.allSettled(tasks.map((task) => removeWorktree(repo, task.workspace)));
    }

    const collisions = detectPathCollisions(results);
    // Assemble and validate technically sound commits even when a worker
    // honestly reports partial work. Completion still gates delivery below.
    const integrationCandidates = results.filter(
      (result) =>
        result.verification.processExitCode === 0 &&
        result.verification.resultCommit &&
        result.verification.commitDescendsFromBase &&
        result.verification.dirtyPaths.length === 0 &&
        !result.verification.changedPaths.includes(".codepilot-result.json"),
    );
    const eligibleChanges = integrationCandidates.filter((result) => result.report?.status === "completed");
    const eligibleNoChanges = results.filter(
      (result) =>
        result.verification.processExitCode === 0 &&
        !result.verification.resultCommit &&
        result.verification.headCommit === result.verification.baseCommit &&
        result.verification.changedPaths.length === 0 &&
        result.verification.dirtyPaths.length === 0 &&
        result.verification.commitDescendsFromBase &&
        result.report?.status === "completed" &&
        Boolean(result.report.noChangeReason?.trim()),
    );
    const acceptedTaskIds = new Set(
      [...eligibleChanges, ...eligibleNoChanges].map((result) => result.taskId),
    );
    const ineligible = results.filter((result) => !acceptedTaskIds.has(result.taskId));
    const validations = [];
    let integrationBranch: string | undefined;
    let integrationFailure: string | undefined;
    if ((request.integrate ?? true) && integrationCandidates.length > 0) {
      integrationBranch = `codepilot/${runId}`;
      const integrationWorkspace = join(stateDirectory, "i", runId.slice(0, 8));
      try {
        // Workers retain their immutable starting commit, but delivery is
        // assembled on the latest primary head. This safely absorbs unrelated
        // commits (for example a PM task-bin commit) made while workers ran.
        const integrationBaseCommit = await resolveHead(repo);
        await createBranchWorktree(repo, integrationWorkspace, integrationBranch, integrationBaseCommit);
        for (const result of integrationCandidates) await cherryPick(integrationWorkspace, result.verification.resultCommit!);
        const commands = request.validationCommands ?? (await discoverValidationCommands(integrationWorkspace));
        for (const command of commands) validations.push(await runValidation(command, integrationWorkspace));
      } catch (error) {
        integrationFailure = error instanceof Error ? error.message : String(error);
      } finally {
        await removeWorktree(repo, integrationWorkspace).catch(() => undefined);
      }
    }

    // Shared changed paths are candidates for a conflict, not proof of one.
    // The serialized cherry-pick above is authoritative: if Git can combine
    // the commits cleanly, the overlap was resolved by the coordinator.
    const overlapsResolved = Boolean(integrationBranch) && !integrationFailure;
    const review = reviewRun(results, overlapsResolved ? [] : collisions, validations);
    if (integrationFailure) {
      review.verdict = "rejected";
      review.findings.push(`Integration failed: ${integrationFailure}`);
    } else if (results.length === 0 || acceptedTaskIds.size === 0) {
      review.verdict = "needs_review";
      review.findings.push("No worker result was eligible for automatic integration.");
    } else if (ineligible.length > 0) {
      review.verdict = "needs_review";
      review.findings.push(
        `${ineligible.length} worker result(s) were not eligible for automatic integration.`,
      );
    }
    if (review.verdict === "ready" && eligibleChanges.length > 0 && !integrationBranch) {
      review.verdict = "needs_review";
      review.findings.push("No validated integration branch was available for delivery.");
    }
    let status: RunStatus = review.verdict === "ready" ? "completed" : review.verdict === "rejected" ? "failed" : "needs_review";
    const summary: RunSummary = {
      version: 0,
      runId,
      status,
      baseCommit,
      ...(integrationBranch ? { integrationBranch } : {}),
      taskResults: results,
      collisions,
      validations,
      review,
    };
    summary.pullRequestBody = buildPullRequestBody(request.objective, summary);
    if (request.createPullRequest) {
      if (!integrationBranch) {
        review.verdict = "needs_review";
        review.findings.push("A pull request was requested, but no integration branch was available.");
      } else {
        try {
          summary.pullRequestUrl = await createGitHubPullRequest(
            repo,
            integrationBranch,
            request.objective,
            summary.pullRequestBody,
            status !== "completed",
          );
        } catch (error) {
          review.verdict = "needs_review";
          review.findings.push(`GitHub pull request creation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      status = review.verdict === "ready" ? "completed" : review.verdict === "rejected" ? "failed" : "needs_review";
      summary.status = status;
      summary.pullRequestBody = buildPullRequestBody(request.objective, summary);
    }
    store.finishRun(runId, status, summary);
    return summary;
  }

  async #executeTask(
    task: AgentTask,
    request: RunRequest,
    store: RunStore,
    onEvent: (event: AgentEvent) => void,
  ): Promise<WorkerResult> {
    const provider = this.#providers.get(task.provider);
    let processExitCode = 1;
    let failure: unknown;
    const maxAttempts = 1 + (request.retries ?? 0);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      task.attempts = attempt;
      store.setAttempt(task.id, attempt);
      try {
        if (attempt > 1) {
          store.addEvent({
            taskId: task.id,
            provider: task.provider,
            timestamp: new Date().toISOString(),
            stream: "system",
            payload: { type: "retry", attempt, text: "Retrying from a clean checkout of the original base commit." },
          });
          await removeWorktree(request.repo, task.workspace).catch(() => undefined);
          await createDetachedWorktree(request.repo, task.workspace, task.baseCommit);
        }
        if (!provider) throw new Error(`No adapter registered for ${task.provider}`);
        await provider.checkAvailability();
        store.setStatus(task.id, "running");
        const userInterrupt = new AbortController();
        registerAgentInterrupt(task.id, () => {
          store.addEvent({ taskId: task.id, provider: task.provider, timestamp: new Date().toISOString(), stream: "system", payload: { type: "agent_message", text: "Interrupt received. I’m stopping now. codePilot will preserve completed changes and report the available handoff evidence." } });
          userInterrupt.abort(new Error("Interrupted by user"));
        });
        const signal = AbortSignal.any([userInterrupt.signal, AbortSignal.timeout(request.timeoutMs ?? 30 * 60_000)]);
        let result = await provider.run(task, (event) => {
          store.addEvent(event);
          onEvent(event);
        }, signal);
        for (let guidancePass = 0; guidancePass < 3; guidancePass += 1) {
          const guidance = drainAgentGuidance(task.id);
          if (guidance.length === 0 || result.exitCode !== 0) break;
          const followUpTask = {
            ...task,
            objective: `Continue working in the same workspace. The user sent this guidance while you were working:\n\n${guidance.map((message) => `- ${message}`).join("\n")}\n\nInspect the work already completed, apply this guidance, rerun relevant checks, and replace the worker report with your final result.`,
          };
          result = await provider.run(followUpTask, (event) => {
            store.addEvent(event);
            onEvent(event);
          }, signal);
        }
        processExitCode = result.exitCode;
        if (result.exitCode !== 0) throw new Error(`${task.provider} exited with ${result.exitCode}`);
        failure = undefined;
        clearAgentInterrupt(task.id);
        break;
      } catch (error) {
        failure = error;
        clearAgentInterrupt(task.id);
      }
    }
    store.setStatus(task.id, failure ? "failed" : "completed");

    const parsed = await readWorkerReport(task.reportPath);
    // The manager owns Git. Preserve every successful worker process's changes;
    // the report outcome still controls whether that commit is eligible to ship.
    if (!failure) {
      await commitWorkspaceChanges(task.workspace, task, parsed.report);
    }
    const inspected = await inspectWorktree(task.workspace, task.baseCommit);
    const gitFacts = {
      ...inspected,
      dirtyPaths: inspected.dirtyPaths.filter((path) => path !== ".codepilot-result.json"),
    };
    const warnings = [...parsed.warnings];
    const retained = parsed.report?.artifacts
      ? await retainWorkerArtifacts(task, request.repo, parsed.report.artifacts)
      : { paths: [], warnings: [] };
    warnings.push(...retained.warnings);
    if (failure) warnings.push(`Worker execution failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    if (gitFacts.changedPaths.includes(".codepilot-result.json")) warnings.push("Worker committed its report file.");
    if (gitFacts.dirtyPaths.length > 0) warnings.push("Worker left uncommitted changes.");
    if (!gitFacts.commitDescendsFromBase) warnings.push("Worker HEAD does not descend from its base commit.");
    if (parsed.report?.status === "completed" && !gitFacts.resultCommit && !parsed.report.noChangeReason) {
      warnings.push("Worker reported completion without a commit or a no-change reason.");
    }
    const result: WorkerResult = {
      version: 0,
      taskId: task.id,
      provider: task.provider,
      ...(task.externalId ? { externalId: task.externalId } : {}),
      ...(parsed.report ? { report: parsed.report } : {}),
      verification: { processExitCode, baseCommit: task.baseCommit, ...gitFacts },
      warnings,
      ...(retained.paths.length ? { retainedArtifacts: retained.paths } : {}),
    };
    store.addWorkerResult(result);
    if (failure && String(failure).toLowerCase().includes("interrupt")) {
      store.addEvent({ taskId: task.id, provider: task.provider, timestamp: new Date().toISOString(), stream: "system", payload: { type: "agent_message", text: `Stopped by request. Preserved ${gitFacts.changedPaths.length} committed file change(s); ${gitFacts.dirtyPaths.length} uncommitted path(s) were detected. Review this session before rerunning the remaining work.` } });
    }
    clearAgentGuidance(task.id);
    clearAgentInterrupt(task.id);
    return result;
  }
}

export function resolveCheckoutCommand(
  environment: NodeJS.ProcessEnv = process.env,
  runtime: { cwd: string | undefined; entrypoint: string | undefined } = {
    cwd: process.cwd(),
    entrypoint: process.argv[1],
  },
): string | undefined {
  const configured = environment.CODEPILOT_CHECKOUT_COMMAND?.trim();
  if (configured) return configured;
  const starts = [
    environment.INIT_CWD,
    runtime.cwd,
    runtime.entrypoint ? dirname(resolve(runtime.entrypoint)) : undefined,
  ].filter((value): value is string => Boolean(value));
  const visited = new Set<string>();
  for (const start of starts) {
    let directory = resolve(start);
    for (let depth = 0; depth < 8 && !visited.has(directory); depth += 1) {
      visited.add(directory);
      const packagePath = join(directory, "package.json");
      const cliPath = join(directory, "dist", "src", "cli.js");
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (packageJson.name === "codepilot" && existsSync(cliPath)) {
          return `node ${JSON.stringify(cliPath)}`;
        }
      } catch {
        // Keep walking toward a codePilot package root.
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
}
