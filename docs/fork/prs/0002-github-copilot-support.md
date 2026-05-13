Target: `fork/maintenance-workflow`.

Source branch:

```text
fork/github-copilot-support
```

## Summary

Adds GitHub Copilot CLI as a T3 Code provider through ACP.

## What Changed

- Adds a `githubCopilot` provider driver.
- Starts Copilot sessions through `copilot --acp`.
- Adds provider settings for binary path, `COPILOT_HOME`, and custom models.
- Discovers available models dynamically from ACP session setup.
- Applies model and provider option selections through ACP.
- Parses ACP `available_commands_update` notifications and shares normalization with cold-start
  `copilot help commands` discovery.
- Bridges assistant output, tool calls, permission requests, user-input requests, plan updates, todo
  updates, and token usage into T3 provider runtime events.
- Adds Git text generation through Copilot ACP.
- Enables GitHub Copilot in provider settings and model picker UI.
- Shows the existing GitHub Copilot icon in provider/model picker surfaces.
- Adds slash commands from `copilot help commands`.
- Documents remaining Copilot parity work.

## Why

GitHub Copilot CLI is a useful coding-agent backend, but upstream is not currently accepting broad
provider feature contributions. This fork will carry the provider while keeping it isolated enough
to maintain across upstream syncs.

## Validation

Required checks:

```bash
bun fmt
bun lint
bun typecheck
```

Focused checks:

```bash
bun run --cwd apps/server test src/provider/Layers/GitHubCopilotProvider.test.ts
bun run --cwd apps/server test src/provider/acp/AcpRuntimeModel.test.ts
```

Manual smoke:

- Add a GitHub Copilot provider instance.
- Confirm model list follows the authenticated subscription.
- Start a Copilot thread.
- Confirm assistant output streams.
- Confirm context window usage appears after `usage_update`.
- Confirm `/skills` and `/review` appear in the slash command menu.

## Known Follow-Up

Tracked in [GitHub Copilot Provider Plan](../../providers/github-copilot-plan.md).
