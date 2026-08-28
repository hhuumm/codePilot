# Threat model

## Scope

codePilot v0.1 is local developer tooling for repositories, objectives, provider CLIs, and validation commands the operator trusts. It is not designed to execute hostile repositories or untrusted prompts safely.

## Assets

- source code and Git history in registered repositories
- provider credentials and local environment secrets
- files and processes accessible to the current operating-system user
- run evidence stored in `.codepilot/`

## Trust boundaries

- The manager is trusted and owns commits, integration, persistence, and policy.
- Provider processes are semi-trusted: they may edit and execute inside a temporary checkout, but their reports are advisory.
- Repository code and configured validation commands are trusted by the operator.
- Remote Git hosting is contacted only when the operator explicitly clones a repository or requests pull-request creation for a run.

## Existing mitigations

- one self-contained temporary checkout per task, outside the source repository
- retries recreated from an immutable base commit
- no automatic primary-branch mutation, push, merge, or PR creation
- independent Git verification and durable task refs
- cooperative leases plus post-run collision checks
- provider subprocesses launched without a shell
- parent conversation metadata and common unrelated secrets removed from child environments
- bounded process lines, event counts, database event history, validation output, artifact count, and artifact size
- timeouts on providers and validation commands
- Electron context isolation and a typed preload bridge
- explicit project IDs on desktop PM, task, agent, knowledge, run, and runtime operations
- HTTPS/SSH-only remote onboarding without embedded URL credentials; authentication stays with Git's credential helper or SSH agent
- GitHub browser authentication is delegated to the official `gh` CLI; tokens never cross the Electron preload bridge or enter codePilot state
- remote writes require a persisted global opt-in plus an explicit per-run pull-request request

## Known risks

- A worker or repository command runs with the current user's operating-system permissions and may access paths outside its checkout.
- Provider authentication must still reach the selected CLI; a malicious child could attempt to exfiltrate it if network access is available.
- Validation commands use a shell and can execute arbitrary operator-supplied text.
- Cooperative file leases do not prevent a provider from ignoring the protocol.
- SQLite state is local and is not tamper-evident.
- The experimental Docker files do not yet represent an enforced manager-owned sandbox.
- Explicit GitHub publication uses the current user's authenticated `gh` and Git credentials to push the generated branch and open a pull request. Repository permissions are enforced by GitHub, not codePilot.
- Explicit repository cloning runs Git with the current user's network access and credentials; the cloned repository remains untrusted until the operator reviews it.

## Operator guidance

- Run codePilot only against repositories you trust and review objectives before launch.
- Keep `.codepilot/` ignored and do not publish run databases or retained artifacts without inspection.
- Use least-privilege provider and Git credentials.
- Review the integration branch and generated pull-request description before publication; review the resulting draft before merging when a run needs review.
- Do not treat a `ready` verdict as a security review.

Security issues in codePilot itself should be reported through the process in [`SECURITY.md`](../SECURITY.md).
