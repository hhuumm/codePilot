import assert from "node:assert/strict";
import test from "node:test";
import { assertGitHubPublicationAllowed, parseGitHubAuthStatus } from "../src/github-auth.js";

test("parses a connected GitHub CLI account without retaining the token", () => {
  const result = parseGitHubAuthStatus(`github.com
  ✓ Logged in to github.com account hhuumm (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_secret
  - Token scopes: 'repo', 'read:org', 'workflow'`);
  assert.deepEqual(result, {
    authenticated: true,
    host: "github.com",
    account: "hhuumm",
    gitProtocol: "https",
    scopes: ["read:org", "repo", "workflow"],
  });
  assert.equal(JSON.stringify(result).includes("gho_secret"), false);
});

test("reports a disconnected GitHub CLI", () => {
  assert.deepEqual(parseGitHubAuthStatus("You are not logged into any GitHub hosts."), {
    authenticated: false,
    host: "github.com",
    scopes: [],
    error: "GitHub CLI is not authenticated",
  });
});

test("requires both authentication and an explicit write opt-in", () => {
  const connected = { installed: true, authenticated: true, host: "github.com" as const, account: "hhuumm", scopes: ["repo"] };
  assert.doesNotThrow(() => assertGitHubPublicationAllowed(true, connected));
  assert.throws(() => assertGitHubPublicationAllowed(false, connected), /disabled/i);
  assert.throws(() => assertGitHubPublicationAllowed(true, { ...connected, authenticated: false }), /Connect GitHub/i);
});
