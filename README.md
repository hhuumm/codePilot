# codePilot

codePilot is a local control plane for coordinating Codex and Claude Code across Git repositories. It gives each coding agent an isolated checkout, persists its handoff in Git commits, integrates eligible commits on a review branch, validates the combined result, and produces a pull-request description—without silently changing your primary branch.

> **Public preview (v0.1):** the local execution path works end to end and is covered by integration tests. This is still developer tooling for trusted repositories, not a hardened sandbox for hostile code or unattended production use.

## Why it exists

Coding agents are effective inside one task and one checkout. The harder problem is coordination: parallel work, overlapping files, failed attempts, durable history, combined validation, and a reviewable delivery boundary. codePilot makes those concerns manager-owned and provider-neutral.

## What works today

- Codex CLI and Claude Code adapters behind one task contract
- independent, temporary Git checkouts pinned to an immutable base commit
- dependency-aware concurrent scheduling and clean-checkout retries
- cooperative, atomic file leases with expiry and manager cleanup
- bounded JSONL event ingestion and SQLite-backed run history
- manager-owned commits retained under `refs/codepilot/runs/...`
- collision detection, integration branches, repository validation, and deterministic review
- Git-native task provenance and generated GitHub pull-request descriptions
- an Electron desktop control plane with local/remote Git onboarding, project-scoped PM threads, task queues, knowledge, and live agent events

## Trust boundary

Workers can run commands from a repository inside their temporary checkout. Validation commands are also user-configured shell commands. Use codePilot only with repositories and objectives you trust.

codePilot filters parent conversation identifiers and common unrelated secrets from worker environments and bounds stored events and validation output. Remote delivery is disabled unless a run explicitly requests `--create-pr`. These are guardrails, not a security sandbox. Read the [threat model](docs/threat-model.md) before live use.

## Requirements

- Node.js 22+
- Git
- Codex CLI and/or Claude Code, already installed and authenticated
- Windows, macOS, or Linux for the CLI; the packaged desktop flow is currently Windows-first

## Quick start

```powershell
git clone https://github.com/hhuumm/codePilot.git
cd codePilot
npm install
npm run check

# Inspect the plan without launching a worker
npm run dev -- run "inspect this repository and propose a small improvement" `
  --repo C:\path\to\repo `
  --agents codex `
  --dry-run
```

Run live work only in a trusted repository:

```powershell
npm run dev -- run "implement the requested change" `
  --repo C:\path\to\repo `
  --agents codex `
  --retry 1 `
  --timeout 900 `
  --validate "npm run check"
```

Repeat `--validate` to run multiple commands. Without explicit validation, codePilot discovers `check`, or `test`, `build`, and `lint` package scripts. Use `--no-integrate` to retain task commits and evidence without assembling a review branch.

Successful changed runs create `codepilot/<run-id>`. Each task becomes a manager-owned commit containing its agent outcome, claimed checks, concerns, follow-ups, and codePilot provenance. The combined run handoff is returned as `pullRequestBody`; no standalone Markdown draft is written to the project.

Add `--create-pr` to explicitly push the integration branch and create a GitHub pull request using that generated description. Runs needing review are opened as drafts. Without this flag, codePilot does not contact GitHub.

## Desktop app

```powershell
npm --prefix desktop install
npm run desktop:dev
```

Build the Windows package with `npm run desktop:build`; output is written under `desktop/out/`. Automatic task deployment is off by default.

The Projects screen can register an existing local Git checkout or clone an HTTPS/SSH remote into the configured projects directory. Credentials are never accepted in repository URLs; Git's configured credential helper or SSH agent owns authentication. After registration, onboarding asks the operator to review the App Core start command, repository-relative working directory, and local URL before Project Manager begins; this step saves configuration but never launches the app. Each registered repository has its own Project Manager thread, conversation, backlog, knowledge, and run database. Turns are serialized within one project while different projects can think and execute concurrently, even as the desktop switches between them. Removing a project only unregisters it from the workspace; its repository and `.codepilot` data remain on disk so it can be onboarded again later.

The older local Next.js dashboard is deliberately absent from the public tree because it contains a separately licensed UI kit. Electron is the supported public UI.

## Worker configuration

The desktop project manager and Codex workers have independent model settings:

```powershell
$env:CODEPILOT_PM_MODEL = "gpt-5.6-terra"
$env:CODEPILOT_WORKER_MODEL = "gpt-5.6-luna"
$env:CODEPILOT_CLAUDE_WORKER_MODEL = "your-claude-model"
```

The manager normally discovers its built CLI for cooperative checkouts. Packaged or relocated installs can set an explicit command:

```powershell
$env:CODEPILOT_CHECKOUT_COMMAND = 'node "C:\tools\codePilot\dist\src\cli.js"'
```

Run records, project-manager tasks, leases, and artifacts live under the target repository's ignored `.codepilot/` directory.

## Project map

- `src/manager.ts` — run lifecycle, retries, integration, validation, and review
- `src/providers/` — provider adapters and bounded process protocol
- `src/checkouts.ts` — cooperative SQLite file leases
- `src/database.ts` — versioned project database bootstrap
- `desktop/` — Electron control plane
- `test/` — unit and end-to-end Git workflow tests
- `docs/architecture.md` — system boundaries and data flow
- `docs/roadmap.md` — the path from public preview to v1

The included Docker worker is an experimental protocol seam; the manager does not yet launch or credential containers. See the roadmap before relying on it.

## Contributing

Issues and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Security-sensitive reports should follow [SECURITY.md](SECURITY.md).

Licensed under the [MIT License](LICENSE).
