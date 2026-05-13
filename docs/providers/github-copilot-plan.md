# GitHub Copilot Provider Plan

This plan tracks the remaining work to bring the GitHub Copilot CLI provider closer to Codex and
Cursor parity.

## Current State

GitHub Copilot is wired as an ACP provider through `copilot --acp`.

Implemented:

- Provider registration, settings, model defaults, and model picker metadata.
- ACP session startup, resume cursor, cancellation, permission requests, user-input requests, plan
  updates, todo updates, tool-call events, and text deltas.
- Dynamic model discovery from ACP session setup so the model list follows the authenticated
  subscription.
- Background model capability enrichment from ACP config options.
- Context window indicator from ACP `usage_update`.
- Provider slash commands from `copilot help commands`.
- ACP `available_commands_update` parsing and normalization into T3 provider slash command
  metadata. Live updates are logged today; wiring them into active provider snapshots is still open.
- Git text generation through Copilot ACP.

Known limitation:

- Copilot skills are exposed today as the interactive `/skills` command. They are not mapped into
  T3 `$skill` entries because the inspected CLI surface does not expose a structured skill list.

## 1. Use ACP Command Updates

Status: partially implemented.

Problem:

- The current slash command list is scraped from `copilot help commands`.
- ACP has a structured `available_commands_update` session notification that should be more
  accurate for custom commands, plugin commands, and runtime-specific command availability.

Plan:

1. Done: extend `AcpRuntimeModel` to parse `available_commands_update`.
2. Done: normalize ACP commands into `ServerProviderSlashCommand`.
3. Done: deduplicate against T3-owned commands: `/model`, `/plan`, `/default`.
4. Still open: decide how live session command updates should update provider status:
   - Short term: emit a provider runtime event that the web app can use for the active composer.
   - Better long term: allow provider snapshots to receive live capability updates from running
     sessions.
5. Done: keep `copilot help commands` as a provider-status fallback for cold start, using the same
   normalizer as ACP command updates.

Acceptance:

- Custom Copilot commands shown by ACP are parsed and logged.
- Built-in T3 commands are not duplicated.
- Tests cover parsing, dedupe, and fallback behavior.
- Remaining: live session command updates appear in the active composer slash menu without waiting
  for provider status refresh.

## 2. Verify Command Execution Semantics

Problem:

- The composer currently inserts `/skills`, `/review`, and similar commands into the prompt.
- We need to confirm Copilot ACP interprets those strings as commands rather than plain prompt text.

Plan:

1. Capture native ACP logs for a prompt that starts with `/skills`, `/review`, and one custom
   command.
2. Check whether ACP exposes a dedicated command execution request or only prompt text.
3. If there is a dedicated command path, route provider slash command selections through it instead
   of prompt insertion.
4. If prompt insertion is the intended ACP behavior, document that explicitly and keep the current
   UI path.

Acceptance:

- Slash command execution has a testable implementation contract.
- The web app does not silently send commands as normal text if ACP expects a different method.

## 3. Real Rollback/Rewind

Problem:

- Codex supports native `thread/rollback`.
- The Cursor and Copilot ACP adapters currently trim only T3's local turn cache on rollback.
- Copilot CLI exposes `/rewind`, but the ACP surface still needs investigation.

Plan:

1. Inspect Copilot ACP traffic when `/rewind` is used in the native CLI.
2. Check whether ACP exposes a session rewind, rollback, or timeline mutation request.
3. If available, implement rollback against the provider session.
4. If not available, mark ACP rollback as local-only in code and UX so expectations are clear.

Acceptance:

- Rewind either mutates the Copilot session state or is explicitly presented as unsupported beyond
  local display cache.
- Tests cover rollback behavior and resume-after-rollback behavior.

## 4. Adapter Integration Test Parity

Problem:

- Copilot mostly mirrors Cursor's ACP adapter, but it needs the same fake-ACP coverage before the
  provider can be treated as reliable.

Plan:

1. Add a Copilot fake ACP harness based on the Cursor adapter tests.
2. Cover:
   - new session startup
   - resume cursor loading
   - model and option application
   - plan mode and default mode selection
   - approval requests
   - user-input requests
   - plan and todo updates
   - token usage updates
   - interruption and process exit
3. Add regression tests for GitHub Copilot extension request names:
   - `githubCopilot/ask_question`
   - `githubCopilot/create_plan`
   - `githubCopilot/update_todos`

Acceptance:

- Copilot adapter behavior is covered at the same risk level as Cursor.
- Process failure and pending request cleanup are deterministic.

## 5. Auth And Account Detail

Status: investigated, no stable non-interactive command found yet.

Problem:

- Provider status mainly reports installed, ready, and inferred unauthenticated states.
- Codex and Claude provide more useful account detail when available.

Plan:

1. Done: inspect `copilot status`, `copilot auth`, and `copilot env`.
   - Current CLI returns "Invalid command format" and suggests interactive mode for these names.
2. Still open: inspect ACP initialization metadata for:
   - GitHub username or email
   - auth source
   - subscription or plan status
   - quota, rate-limit, or disabled-model warnings
3. Add structured status parsing where stable.
4. Avoid relying on fragile text parsing for sensitive account state unless there is no ACP or JSON
   alternative.

Acceptance:

- Settings can show which GitHub account a Copilot provider instance is using when the CLI exposes
  it.
- Auth failures produce actionable messages.

## 6. First-Class Skills

Problem:

- T3 has `$skill` UX, but Copilot currently exposes skills through `/skills`.

Plan:

1. Continue treating `/skills` as the supported path.
2. Investigate whether Copilot stores or reports installed skills in a structured format.
3. If a stable list exists, map it into `ServerProvider.skills`.
4. Preserve `/skills` even if `$skill` entries are later added, because `/skills` also manages
   install/update flows.

Acceptance:

- If a structured skill list exists, Copilot skills appear in `$skill` search.
- If no structured list exists, the limitation is documented and `/skills` remains available.

## 7. Mode And Permission Trace Validation

Problem:

- Copilot mode selection currently uses ACP mode aliases such as `plan`, `ask`, `code`, `copilot`,
  `default`, `chat`, and `implement`.
- Permission mapping is generic ACP logic.

Plan:

1. Capture native logs for:
   - plan turns
   - default implementation turns
   - approval-required turns
   - command execution approvals
   - file edit approvals
2. Verify mode IDs and fallback ordering against real Copilot ACP payloads.
3. Add fixture tests for the observed payloads.
4. Tighten aliases only where the real payloads justify it.

Acceptance:

- Plan/default/approval behavior is backed by real Copilot traces.
- Permission request titles and decisions match the Copilot CLI behavior.

## Suggested Order

1. ACP command updates.
2. Command execution semantics.
3. Adapter integration test parity.
4. Real rollback/rewrite support.
5. Auth and account detail.
6. First-class skills.
7. Mode and permission trace validation.
