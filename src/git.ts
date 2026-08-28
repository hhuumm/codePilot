import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentTask, WorkerReport } from "./domain.js";

const execFileAsync = promisify(execFile);

export async function assertGitRepository(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

export async function resolveHead(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function createDetachedWorktree(
  repo: string,
  workspace: string,
  commit: string,
): Promise<void> {
  await mkdir(dirname(workspace), { recursive: true });
  // A self-contained clone keeps the agent's writable Git metadata inside its
  // sandbox. Linked worktrees point `.git` outside the workspace, which the
  // Codex Windows sandbox correctly refuses to make writable.
  await execFileAsync("git", ["clone", "--no-checkout", "--no-local", repo, workspace]);
  await execFileAsync("git", ["-C", workspace, "checkout", "--detach", commit]);
}

export async function createBranchWorktree(
  repo: string,
  workspace: string,
  branch: string,
  commit: string,
): Promise<void> {
  await mkdir(dirname(workspace), { recursive: true });
  await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", branch, workspace, commit]);
}

export async function preserveTaskCommit(repo: string, runId: string, taskId: string, commit: string, workspace: string): Promise<void> {
  await execFileAsync("git", ["-C", repo, "fetch", "--no-tags", workspace, commit]);
  await execFileAsync("git", ["-C", repo, "update-ref", `refs/codepilot/runs/${runId}/tasks/${taskId}`, commit]);
}

export async function commitWorkspaceChanges(
  workspace: string,
  task: AgentTask,
  report?: WorkerReport,
): Promise<boolean> {
  // Normalize whatever the worker did into one manager-owned commit. This
  // preserves the complete base-to-workspace diff while making the durable
  // branch history independent of whether an agent created its own commits.
  await execFileAsync("git", ["-C", workspace, "reset", "--soft", task.baseCommit]);
  await execFileAsync("git", ["-C", workspace, "add", "--all"]);
  await execFileAsync("git", ["-C", workspace, "reset", "--", ".codepilot-result.json"]);
  try {
    await execFileAsync("git", ["-C", workspace, "diff", "--cached", "--quiet"]);
    return false;
  } catch {
    await execFileAsync("git", [
      "-C",
      workspace,
      "-c",
      "user.name=codePilot",
      "-c",
      "user.email=codepilot@local",
      "commit",
      "-m",
      `codepilot: task ${task.externalId ?? task.id}`,
      "-m",
      taskCommitBody(task, report),
    ]);
    return true;
  }
}

function taskCommitBody(task: AgentTask, report?: WorkerReport): string {
  const list = (items: string[]): string => items
    .slice(0, 20)
    .map((item) => `- ${item.replaceAll("\0", "").trim().slice(0, 500)}`)
    .join("\n");
  const sections = [
    report?.summary?.replaceAll("\0", "").trim().slice(0, 4_000) || "Worker changes captured by the codePilot manager.",
    report?.claimedTests.length
      ? `Claimed validation:\n${list(report.claimedTests)}`
      : "Claimed validation:\n- Not reported",
    report?.concerns.length
      ? `Concerns:\n${list(report.concerns)}`
      : undefined,
    report?.followUps.length
      ? `Follow-ups:\n${list(report.followUps)}`
      : undefined,
    `CodePilot-Run: ${task.runId}\nCodePilot-Task: ${task.externalId ?? task.id}\nCodePilot-Provider: ${task.provider}\nCodePilot-Outcome: ${report?.status ?? "unreported"}`,
  ];
  return sections.filter((section): section is string => Boolean(section)).join("\n\n");
}

export async function cherryPick(workspace: string, commit: string): Promise<void> {
  await execFileAsync("git", ["-C", workspace, "cherry-pick", commit]);
}

export async function repositoryContext(repo: string, baseCommit: string): Promise<{
  baseCommit: string;
  trackedPaths: string[];
  recentCommits: string[];
  curatedKnowledge: Array<{ title: string; content: string; tags: string[] }>;
}> {
  const [{ stdout: paths }, { stdout: commits }] = await Promise.all([
    execFileAsync("git", ["-C", repo, "ls-tree", "-r", "--name-only", baseCommit]),
    execFileAsync("git", ["-C", repo, "log", "-5", "--format=%h %s", baseCommit]),
  ]);
  const curatedKnowledge: Array<{ title: string; content: string; tags: string[] }> = [];
  try {
    const directory = resolve(repo, ".codepilot", "knowledge");
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(await readFile(resolve(directory, file), "utf8")) as Record<string, unknown>;
        if (entry.published === true && typeof entry.title === "string" && typeof entry.content === "string") {
          curatedKnowledge.push({
            title: entry.title,
            content: entry.content,
            tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
          });
        }
      } catch { /* Ignore malformed knowledge entries and retain usable entries. */ }
    }
  } catch { /* A project does not need curated knowledge. */ }
  return {
    baseCommit,
    trackedPaths: paths.split(/\r?\n/).filter(Boolean),
    recentCommits: commits.split(/\r?\n/).filter(Boolean),
    curatedKnowledge,
  };
}

export async function removeWorktree(repo: string, workspace: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", workspace]);
  } catch {
    // Agent workspaces are self-contained clones; integration workspaces are
    // manager-owned linked worktrees. Removal supports both shapes.
  } finally {
    // Git normally removes the directory. This also clears a partially-created worktree.
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function inspectWorktree(
  workspace: string,
  baseCommit: string,
): Promise<{
  headCommit: string;
  resultCommit?: string;
  changedPaths: string[];
  dirtyPaths: string[];
  commitDescendsFromBase: boolean;
}> {
  const headCommit = await resolveHead(workspace);
  const { stdout: changed } = await execFileAsync("git", [
    "-C",
    workspace,
    "diff",
    "--name-only",
    `${baseCommit}..${headCommit}`,
  ]);
  const { stdout: dirty } = await execFileAsync("git", [
    "-C",
    workspace,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  let commitDescendsFromBase = true;
  try {
    await execFileAsync("git", ["-C", workspace, "merge-base", "--is-ancestor", baseCommit, headCommit]);
  } catch {
    commitDescendsFromBase = false;
  }

  const dirtyPaths = dirty
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
  const common = {
    headCommit,
    changedPaths: changed.split(/\r?\n/).filter(Boolean),
    dirtyPaths,
    commitDescendsFromBase,
  };
  return headCommit === baseCommit ? common : { ...common, resultCommit: headCommit };
}
