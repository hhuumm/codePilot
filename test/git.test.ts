import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createDetachedWorktree, inspectWorktree, removeWorktree, repositoryContext, resolveHead } from "../src/git.js";

const execFileAsync = promisify(execFile);

test("creates an isolated self-contained checkout at the requested commit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-git-"));
  const repo = join(root, "repo");
  const workspace = join(root, "worktrees", "task-1");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test User"]);
  await writeFile(join(repo, "tracked.txt"), "base\n");
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);
  const commit = await resolveHead(repo);

  context.after(async () => removeWorktree(repo, workspace));
  await createDetachedWorktree(repo, workspace, commit);
  await writeFile(join(workspace, "tracked.txt"), "worker change\n");

  assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "base\n");
  assert.equal(await readFile(join(workspace, "tracked.txt"), "utf8"), "worker change\n");
  const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"]);
  assert.equal(stdout.trim(), commit);
  const { stdout: gitDirectory } = await execFileAsync("git", ["-C", workspace, "rev-parse", "--git-dir"]);
  assert.equal(gitDirectory.trim(), ".git");
  const inspection = await inspectWorktree(workspace, commit);
  assert.equal(inspection.resultCommit, undefined);
  assert.deepEqual(inspection.dirtyPaths, ["tracked.txt"]);
});

test("loads only published project knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "codepilot-knowledge-"));
  await execFileAsync("git", ["init", root]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test User"]);
  await writeFile(join(root, "README.md"), "fixture\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "base"]);
  const directory = join(root, ".codepilot", "knowledge");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "public.json"), JSON.stringify({ title: "Convention", content: "Use focused tests.", tags: ["testing"], published: true }));
  await writeFile(join(directory, "private.json"), JSON.stringify({ title: "Scratch", content: "Do not publish.", tags: [], published: false }));
  const context = await repositoryContext(root, await resolveHead(root));
  assert.deepEqual(context.curatedKnowledge, [{ title: "Convention", content: "Use focused tests.", tags: ["testing"] }]);
});
