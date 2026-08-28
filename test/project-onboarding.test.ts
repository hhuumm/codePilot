import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalGitRepository,
  repositoryNameFromRemote,
} from "../src/project-onboarding.js";

test("canonicalizes an existing Git checkout from a nested directory", () => {
  const root = mkdtempSync(join(tmpdir(), "codepilot-onboard-"));
  try {
    execFileSync("git", ["init", root]);
    mkdirSync(join(root, "nested"));
    assert.equal(canonicalGitRepository(join(root, "nested")), realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derives safe project names from HTTPS and SSH remotes", () => {
  assert.equal(repositoryNameFromRemote("https://github.com/hhuumm/codePilot.git"), "codePilot");
  assert.equal(repositoryNameFromRemote("git@github.com:hhuumm/codePilot.git"), "codePilot");
  assert.throws(() => repositoryNameFromRemote("file:///private/repo"), /HTTPS or SSH/);
  assert.throws(() => repositoryNameFromRemote("https://token@github.com/hhuumm/codePilot.git"), /credential helper/);
  assert.throws(() => repositoryNameFromRemote("ssh://git:secret@github.com/hhuumm/codePilot.git"), /credential helper/);
});
