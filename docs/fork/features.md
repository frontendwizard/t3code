# Fork Features

Track fork-only features here after they land.

## GitHub Copilot ACP Provider

Status: PR 0002.

Reason: I want Copilot CLI support in this fork.

Upstreaming posture: keep it isolated unless upstream starts accepting provider contributions.

Conflict risk: medium.

Primary areas:

- provider settings and model metadata
- server provider driver, adapter, and ACP runtime support
- web provider metadata and model picker UI

Current capabilities:

- ACP runtime through `copilot --acp`
- dynamic model discovery from the authenticated Copilot subscription
- context window usage from ACP `usage_update`
- permission and user-input request bridging
- slash commands from `copilot help commands`
- ACP `available_commands_update` parsing for runtime command metadata

Known gaps:

- publishing live ACP command updates into active provider snapshots
- verified `/skills`, `/review`, and custom command behavior
- richer account/auth status if Copilot exposes it

Required checks:

```bash
bun fmt
bun lint
bun typecheck
```

Focused tests:

```bash
bun run --cwd apps/server test src/provider/Layers/GitHubCopilotProvider.test.ts
bun run --cwd apps/server test src/provider/acp/AcpRuntimeModel.test.ts
```
