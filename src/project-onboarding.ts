import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const remoteUrl = /^(?:https:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[\w.-]+:[^\s]+)$/i;

export function canonicalGitRepository(path: string): string {
  const requested = resolve(path);
  const root = execFileSync(
    "git",
    ["-C", requested, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  return realpathSync(root);
}

export function repositoryNameFromRemote(url: string): string {
  assertRemoteGitUrl(url);
  const clean = url.trim().replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  const candidate = clean.split(/[\\/:]/).pop()?.replace(/\.git$/i, "") ?? "";
  const name = candidate.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("Could not derive a project name from the Git URL");
  return name;
}

export async function cloneGitRepository(input: {
  url: string;
  projectsDirectory: string;
  directoryName?: string;
}): Promise<string> {
  const url = input.url.trim();
  assertRemoteGitUrl(url);
  const root = resolve(input.projectsDirectory);
  mkdirSync(root, { recursive: true });
  const requestedName = input.directoryName?.trim() || repositoryNameFromRemote(url);
  const safeName = requestedName
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safeName || safeName === "." || safeName === "..")
    throw new Error("A valid destination directory name is required");
  const destination = resolve(root, safeName);
  const rel = relative(root, destination);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== destination)
    throw new Error("The clone destination must be inside the projects directory");
  if (existsSync(destination))
    throw new Error(`The clone destination already exists: ${destination}`);

  try {
    await new Promise<void>((done, fail) => {
      execFile("git", ["clone", "--", url, destination], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, _stdout, stderr) => error
        ? fail(new Error(stderr.trim() || error.message, { cause: error }))
        : done());
    });
    return canonicalGitRepository(destination);
  } catch (cause) {
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not clone the Git repository: ${detail}`, { cause });
  }
}

export function suggestedProjectName(path: string): string {
  return basename(resolve(path));
}

function assertRemoteGitUrl(url: string): void {
  const value = url.trim();
  if (!remoteUrl.test(value) || value.includes("\0"))
    throw new Error("Use an HTTPS or SSH Git repository URL");
  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    const parsed = new URL(value);
    if (parsed.password || (parsed.protocol === "https:" && parsed.username))
      throw new Error("Do not embed credentials in the Git URL; use your configured Git credential helper");
  }
}
