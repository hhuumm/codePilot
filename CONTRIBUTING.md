# Contributing

Thanks for helping improve codePilot. The project is in public preview, so focused changes with explicit safety boundaries are the easiest to review.

## Development setup

```powershell
npm install
npm --prefix desktop install
npm run check
npm --prefix desktop run typecheck
```

Use Node.js 22 or newer. Tests create temporary Git repositories and require Git on `PATH`.

## Pull requests

- Open an issue first for large architecture or product changes.
- Keep provider-specific behavior behind an adapter.
- Add tests for orchestration, persistence, Git, or process-protocol behavior.
- Preserve the rule that codePilot does not mutate or push a user's primary branch without a future explicit policy gate.
- Update the threat model when a change expands filesystem, credential, process, network, or remote-hosting access.
- Run the root check and desktop typecheck before submitting.

Do not add the legacy licensed dashboard or generated build output to commits.
