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
- Remote Git hosting is outside the v0.1 execution path.

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

## Known risks

- A worker or repository command runs with the current user's operating-system permissions and may access paths outside its checkout.
- Provider authentication must still reach the selected CLI; a malicious child could attempt to exfiltrate it if network access is available.
- Validation commands use a shell and can execute arbitrary operator-supplied text.
- Cooperative file leases do not prevent a provider from ignoring the protocol.
- SQLite state is local and is not tamper-evident.
- The experimental Docker files do not yet represent an enforced manager-owned sandbox.

## Operator guidance

- Run codePilot only against repositories you trust and review objectives before launch.
- Keep `.codepilot/` ignored and do not publish run databases or retained artifacts without inspection.
- Use least-privilege provider and Git credentials.
- Review the integration branch and PR draft before manually pushing or merging.
- Do not treat a `ready` verdict as a security review.

Security issues in codePilot itself should be reported through the process in [`SECURITY.md`](../SECURITY.md).
