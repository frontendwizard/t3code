import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vitest";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildGitHubCopilotDiscoveredModelsFromSessionSetup,
  parseGitHubCopilotHelpCommandsOutput,
} from "./GitHubCopilotProvider.ts";

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });

describe("buildGitHubCopilotDiscoveredModelsFromSessionSetup", () => {
  it("prefers ACP session model state so the list follows the authenticated subscription", () => {
    const sessionSetup = {
      sessionId: "session-1",
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [
          {
            modelId: "auto",
            name: "Auto",
            description: "Let Copilot pick the best model",
          },
          {
            modelId: "claude-sonnet-4.6",
            name: "Claude Sonnet 4.6",
            _meta: {
              copilotUsage: "1x",
              copilotEnablement: "enabled",
            },
          },
          {
            modelId: "gpt-5.5",
            name: "GPT-5.5",
            _meta: {
              copilotUsage: "7.5x",
              copilotEnablement: "enabled",
            },
          },
        ],
      },
      configOptions: [
        {
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "low" },
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
          ],
          category: "thought_level",
          id: "reasoning_effort",
          name: "Reasoning Effort",
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse;

    expect(buildGitHubCopilotDiscoveredModelsFromSessionSetup(sessionSetup)).toEqual([
      {
        slug: "auto",
        name: "Auto",
        isCustom: false,
        capabilities: emptyCapabilities,
      },
      {
        slug: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoning", "Reasoning Effort", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
          ],
        }),
      },
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        isCustom: false,
        capabilities: emptyCapabilities,
      },
    ]);
  });
});

describe("parseGitHubCopilotHelpCommandsOutput", () => {
  it("discovers Copilot slash commands while leaving T3-owned commands local", () => {
    expect(
      parseGitHubCopilotHelpCommandsOutput({
        code: 0,
        stdout: `
Usage: copilot [options] [command]

Commands:
  /init             Generate repository instructions
  /skills           Manage GitHub Copilot skills
  /plugin           Manage GitHub Copilot plugins
  /model            Change Copilot model
  /plan             Switch to plan mode
  /review           Review repository changes
  /custom-command   Run a configured custom command
  /skills           Duplicate entry from another section
        `,
        stderr: "",
      }),
    ).toEqual([
      {
        name: "custom-command",
        description: "Run a configured custom command",
      },
      {
        name: "init",
        description: "Generate repository instructions",
      },
      {
        name: "plugin",
        description: "Manage GitHub Copilot plugins",
      },
      {
        name: "review",
        description: "Review repository changes",
      },
      {
        name: "skills",
        description: "Manage GitHub Copilot skills",
      },
    ]);
  });
});
