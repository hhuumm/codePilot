import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { AgentEvent, AgentResult, AgentTask } from "../src/domain.js";
import { Manager, resolveCheckoutCommand } from "../src/manager.js";
import type { ProviderAdapter } from "../src/providers/provider.js";

const execFileAsync = promisify(execFile);

class FixtureProvider implements ProviderAdapter {
  readonly name = "codex" as const;
  lastTask?: AgentTask;
  async checkAvailability(): Promise<void> {}
  async run(task: AgentTask, _onEvent: (event: AgentEvent) => void): Promise<AgentResult> {
    this.lastTask = task;
    await writeFile(join(task.workspace, "result.txt"), "implemented\n");
    await execFileAsync("git", ["-C", task.workspace, "add", "result.txt"]);
    await execFileAsync("git", [
      "-C",
      task.workspace,
      "-c",
      "user.name=Fixture Worker",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "worker result",
    ]);
    await writeFile(
      task.reportPath,
      JSON.stringify({
        version: 0,
        status: "completed",
        summary: "Added the fixture result.",
        claimedTests: [],
        concerns: [],
        followUps: [],
      }),
    );
    return { taskId: task.id, exitCode: 0, events: [] };
  }
}

class CleanRetryProvider implements ProviderAdapter {
  readonly name = "codex" as const;
  calls = 0;
  async checkAvailability(): Promise<void> {}
  async run(task: AgentTask, _onEvent: (event: AgentEvent) => void): Promise<AgentResult> {
    this.calls += 1;
    if (this.calls === 1) {
      await writeFile(join(task.workspace, "contaminated.txt"), "first attempt\n");
      return { taskId: task.id, exitCode: 1, events: [] };
    }
    await assert.rejects(access(join(task.workspace, "contaminated.txt")));
    await writeFile(join(task.workspace, "retry.txt"), "clean retry\n");
    await writeFile(task.reportPath, JSON.stringify({
      version: 0, status: "completed", summary: "Completed on a clean retry.",
      claimedTests: [], concerns: [], followUps: [],
    }));
    return { taskId: task.id, exitCode: 0, events: [] };
  }
}

class NoChangeProvider implements ProviderAdapter {
  readonly name = "codex" as const;
  async checkAvailability(): Promise<void> {}
  async run(task: AgentTask, _onEvent: (event: AgentEvent) => void): Promise<AgentResult> {
    await writeFile(
      task.reportPath,
      JSON.stringify({
        version: 0,
        status: "completed",
        summary: "The requested state is already present.",
        claimedTests: ["git status --short"],
        concerns: [],
        followUps: [],
        noChangeReason: "The base commit already satisfies the task.",
      }),
    );
    return { taskId: task.id, exitCode: 0, events: [] };
  }
}

class PartialArtifactProvider implements ProviderAdapter {
  readonly name = "codex" as const;
  async checkAvailability(): Promise<void> {}
  async run(task: AgentTask, _onEvent: (event: AgentEvent) => void): Promise<AgentResult> {
    await writeFile(join(task.workspace, "partial.txt"), "review me\n");
    await writeFile(join(task.workspace, "release.zip"), "retained artifact\n");
    await writeFile(task.reportPath, JSON.stringify({
      version: 0, status: "partial", summary: "Implementation needs review.",
      claimedTests: [], concerns: ["Needs review"], followUps: [], artifacts: ["release.zip"],
    }));
    return { taskId: task.id, exitCode: 0, events: [] };
  }
}

class BatchFixtureProvider implements ProviderAdapter {
  readonly name = "codex" as const;
  active = 0;
  maxActive = 0;
  async checkAvailability(): Promise<void> {}
  async run(task: AgentTask, _onEvent: (event: AgentEvent) => void): Promise<AgentResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const name = `${task.externalId}.txt`;
    await writeFile(join(task.workspace, name), `${task.externalId}\n`);
    await writeFile(task.reportPath, JSON.stringify({
      version: 0, status: "completed", summary: `Completed ${task.externalId}.`,
      claimedTests: [], concerns: [], followUps: [],
    }));
    this.active -= 1;
    return { taskId: task.id, exitCode: 0, events: [] };
  }
}

class SharedPathFixtureProvider implements ProviderAdapter {
  readonly name = "codex" as const;
  async checkAvailability(): Promise<void> {}
  async run(task: AgentTask, _onEvent: (event: AgentEvent) => void): Promise<AgentResult> {
    const shared = join(task.workspace, "shared.txt");
    const lines = (await import("node:fs/promises")).readFile(shared, "utf8").then((value) => value.split("\n"));
    const next = await lines;
    next[task.externalId === "first" ? 1 : 10] = `${task.externalId}=done`;
    await writeFile(shared, next.join("\n"));
    await writeFile(task.reportPath, JSON.stringify({
      version: 0, status: "completed", summary: `Completed ${task.externalId}.`,
      claimedTests: [], concerns: [], followUps: [],
    }));
    return { taskId: task.id, exitCode: 0, events: [] };
  }
}

class PrimaryMovingFixtureProvider implements ProviderAdapter {
  readonly name = "codex" as const;
  constructor(private readonly repo: string) {}
  async checkAvailability(): Promise<void> {}
  async run(task: AgentTask, _onEvent: (event: AgentEvent) => void): Promise<AgentResult> {
    await writeFile(join(task.workspace, "delivered.txt"), "worker result\n");
    await execFileAsync("git", ["-C", this.repo, "commit", "--allow-empty", "-m", "concurrent metadata commit"]);
    await writeFile(task.reportPath, JSON.stringify({
      version: 0, status: "completed", summary: "Completed after primary moved.",
      claimedTests: [], concerns: [], followUps: [],
    }));
    return { taskId: task.id, exitCode: 0, events: [] };
  }
}

test("runs a worker, preserves its commit, and builds a Git-native delivery handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-manager-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await writeFile(join(repo, ".gitignore"), ".codepilot/\n");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);

  const provider = new FixtureProvider();
  const summary = await new Manager([provider]).run({
    objective: "add a result",
    repo,
    providers: ["codex"],
    dryRun: false,
    validationCommands: [],
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.review.verdict, "ready");
  assert.match(summary.integrationBranch!, /^codepilot\//);
  assert.equal(summary.taskResults[0]?.verification.changedPaths[0], "result.txt");
  assert.match(summary.pullRequestBody ?? "", /Added the fixture result/);
  assert.match(summary.pullRequestBody ?? "", /result\.txt/);
  const { stdout } = await execFileAsync("git", ["-C", repo, "show", `${summary.integrationBranch}:result.txt`]);
  assert.equal(stdout, "implemented\n");
  const { stdout: commitMessage } = await execFileAsync("git", ["-C", repo, "log", "-1", "--format=%B", summary.integrationBranch!]);
  assert.match(commitMessage, /CodePilot-Run:/);
  assert.match(commitMessage, /CodePilot-Provider: codex/);
  const { stdout: commitCount } = await execFileAsync("git", ["-C", repo, "rev-list", "--count", `HEAD..${summary.integrationBranch}`]);
  assert.equal(commitCount.trim(), "1");
  await assert.rejects(access(join(repo, ".codepilot", "runs", summary.runId, "pull-request.md")));
  await assert.rejects(execFileAsync("git", ["-C", repo, "show", "HEAD:result.txt"]));
  assert.equal(resolve(provider.lastTask?.coordinationRepo ?? ""), resolve(repo));
  assert.ok(provider.lastTask?.checkoutCommand);
});

test("dry runs never report verified completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-dry-run-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await execFileAsync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
  const summary = await new Manager([new FixtureProvider()]).run({ objective: "plan only", repo, providers: ["codex"], dryRun: true });
  assert.equal(summary.status, "needs_review");
});

test("runs distinct batch work items concurrently and delivers them through one integration", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-batch-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await writeFile(join(repo, ".gitignore"), ".codepilot/\n");
  await execFileAsync("git", ["-C", repo, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);
  const provider = new BatchFixtureProvider();
  const summary = await new Manager([provider]).run({
    objective: "coordinated batch",
    repo,
    providers: ["codex"],
    workItems: [
      { id: "first", objective: "write first", provider: "codex" },
      { id: "second", objective: "write second", provider: "codex" },
    ],
    dryRun: false,
    validationCommands: [],
  });
  assert.equal(provider.maxActive, 2);
  assert.equal(summary.status, "completed");
  assert.deepEqual(summary.taskResults.map((result) => result.externalId).sort(), ["first", "second"]);
  await execFileAsync("git", ["-C", repo, "show", `${summary.integrationBranch}:first.txt`]);
  await execFileAsync("git", ["-C", repo, "show", `${summary.integrationBranch}:second.txt`]);
  await assert.rejects(access(join(repo, "first.txt")));
});

test("serializes clean shared-path overlaps through the integration workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-overlap-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await writeFile(join(repo, ".gitignore"), ".codepilot/\n");
  await writeFile(join(repo, "shared.txt"), Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n"));
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);
  const summary = await new Manager([new SharedPathFixtureProvider()]).run({
    objective: "resolve clean overlap",
    repo,
    providers: ["codex"],
    workItems: [
      { id: "first", objective: "change the top", provider: "codex" },
      { id: "second", objective: "change the bottom", provider: "codex" },
    ],
    dryRun: false,
    validationCommands: [],
  });
  assert.equal(summary.collisions.length, 1);
  assert.equal(summary.collisions[0]?.path, "shared.txt");
  assert.equal(summary.status, "completed");
  const { stdout } = await execFileAsync("git", ["-C", repo, "show", `${summary.integrationBranch}:shared.txt`]);
  assert.match(stdout, /first=done/);
  assert.match(stdout, /second=done/);
});

test("delivers worker commits on top of a primary head that moved while workers ran", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-moving-primary-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await writeFile(join(repo, ".gitignore"), ".codepilot/\n");
  await execFileAsync("git", ["-C", repo, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);
  const summary = await new Manager([new PrimaryMovingFixtureProvider(repo)]).run({
    objective: "survive a metadata commit",
    repo,
    providers: ["codex"],
    dryRun: false,
    validationCommands: [],
  });
  assert.equal(summary.status, "completed");
  const { stdout: history } = await execFileAsync("git", ["-C", repo, "log", "--format=%s", "-1"]);
  assert.match(history, /concurrent metadata commit/);
  const { stdout: integrationHistory } = await execFileAsync("git", ["-C", repo, "log", "--format=%s", "-2", summary.integrationBranch!]);
  assert.match(integrationHistory, /codepilot: task/);
  await assert.rejects(access(join(repo, "delivered.txt")));
});

test("retries from a clean base checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-clean-retry-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await writeFile(join(repo, ".gitignore"), ".codepilot/\n");
  await execFileAsync("git", ["-C", repo, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);
  const provider = new CleanRetryProvider();
  const summary = await new Manager([provider]).run({
    objective: "retry cleanly",
    repo,
    providers: ["codex"],
    dryRun: false,
    retries: 1,
    validationCommands: [],
  });
  assert.equal(provider.calls, 2);
  assert.equal(summary.status, "completed");
  assert.equal(summary.taskResults[0]?.verification.changedPaths.includes("contaminated.txt"), false);
  assert.equal(summary.taskResults[0]?.verification.changedPaths.includes("retry.txt"), true);
});

test("completes a clean verified no-change run without an integration branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-no-change-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await writeFile(join(repo, ".gitignore"), ".codepilot/\n");
  await execFileAsync("git", ["-C", repo, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);

  const summary = await new Manager([new NoChangeProvider()]).run({
    objective: "verify existing state",
    repo,
    providers: ["codex"],
    dryRun: false,
    validationCommands: [],
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.review.verdict, "ready");
  assert.equal(summary.integrationBranch, undefined);
  assert.equal(summary.taskResults[0]?.verification.resultCommit, undefined);
  assert.match(summary.taskResults[0]?.report?.noChangeReason ?? "", /already satisfies/);
});

test("validates partial commits and retains reported ignored artifacts without delivering them", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-partial-artifact-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await writeFile(join(repo, ".gitignore"), ".codepilot/\n*.zip\n");
  await execFileAsync("git", ["-C", repo, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);

  const summary = await new Manager([new PartialArtifactProvider()]).run({
    objective: "retain a release candidate for review",
    repo,
    providers: ["codex"],
    dryRun: false,
    validationCommands: ["node -e \"process.exit(0)\""],
  });

  assert.equal(summary.status, "needs_review");
  assert.match(summary.integrationBranch!, /^codepilot\//);
  assert.equal(summary.validations[0]?.exitCode, 0);
  const artifact = summary.taskResults[0]?.retainedArtifacts?.[0];
  assert.ok(artifact);
  assert.equal(await readFile(artifact, "utf8"), "retained artifact\n");
  await assert.rejects(access(join(repo, "partial.txt")));
});

test("checkout command resolution tolerates missing Electron path inputs", () => {
  assert.doesNotThrow(() =>
    resolveCheckoutCommand({}, { cwd: undefined, entrypoint: undefined }),
  );
  assert.equal(
    resolveCheckoutCommand(
      { CODEPILOT_CHECKOUT_COMMAND: 'node "C:\\tools\\codepilot.js"' },
      { cwd: undefined, entrypoint: undefined },
    ),
    'node "C:\\tools\\codepilot.js"',
  );
});
