# Architecture

## Execution flow

1. The manager resolves the target repository's current commit and creates a durable run in `.codepilot/codepilot.db`.
2. Each task receives an independent temporary checkout pinned to that base commit.
3. The scheduler runs dependency-ready tasks concurrently. Workers may atomically lease intended paths through the project database.
4. A provider adapter launches Codex or Claude Code and normalizes bounded JSONL output into structured events.
5. The trusted manager commits successful workspace changes, independently inspects Git state, retains a run ref, and removes the temporary checkout.
6. Eligible task commits are cherry-picked onto `codepilot/<run-id>` based on the latest primary head. Repository-wide validation runs there.
7. Deterministic policy combines process, report, Git, collision, and validation evidence into a review verdict.
8. codePilot writes a local pull-request draft. Remote push, PR creation, and primary-branch mutation remain human actions.

## Boundaries

### Manager

The manager owns authoritative orchestration state: scheduling, attempts, timeouts, lease cleanup, commits, integration, validation, and delivery artifacts. Model output is advisory and cannot directly change persisted manager state.

Runs targeting the same repository are serialized in one manager process. Tasks within a run may execute concurrently when their dependency graph permits it.

### Provider adapters

Adapters translate the stable `AgentTask` contract into official CLI arguments. Authentication remains owned by each provider CLI. Parent conversation identifiers and common unrelated credential variables are removed from child environments; the selected provider's authentication variable may be forwarded.

Process output is line-framed across arbitrary stream chunks, capped per line, capped by event count, and persisted as structured events.

### Worker workspaces

Each task starts from an immutable base commit in a self-contained temporary Git checkout outside the source repository. A retry destroys the failed workspace and recreates it from that base so partial files or commits cannot contaminate the next attempt.

Workers write an advisory `.codepilot-result.json`. The manager independently records process exit, ancestry, changed paths, dirty paths, result commit, and report validity before deciding whether a result can be integrated.

### Cooperative file leases

File checkouts are project-relative SQLite leases. Multi-path acquisition is atomic, leases expire after crashes, and release is owner-scoped. The manager supplies workers with the repository and checkout command and releases all leases owned by a task when it exits.

Leases are cooperative rather than operating-system locks. Independent filesystems and integration-time collision detection remain the hard backstops.

### Integration and delivery

Task commits are retained under durable Git refs. The manager assembles eligible commits on a dedicated integration branch, runs validation, and creates a PR draft. It does not stash, reset, fast-forward, push, or merge the user's primary branch.

### Persistence

One SQLite database owns runs, tasks, attempts, bounded events, worker results, leases, and desktop project-manager records. Initialization is centralized and schema version is recorded with SQLite `user_version`. Interrupted running tasks are marked failed and their runs require review on desktop restart; automatic resume is not yet implemented.

## Current limitations

- Task planning is still thin; CLI multi-provider runs duplicate an objective unless explicit work items are supplied.
- File leases depend on worker cooperation.
- Local workers are process-isolated, not container-sandboxed.
- Validation discovery is Node-centric and custom commands intentionally use a shell.
- Review is deterministic policy, not an independent semantic reviewer.
- The Docker worker protocol is not yet controlled by the manager.
- Remote delivery and crash-safe resume are intentionally out of scope for v0.1.
