import type {
  GitHubCopilotSettings,
  ModelCapabilities,
  ProviderOptionSelection,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import { normalizeAcpAvailableCommands } from "../acp/AcpRuntimeModel.ts";

const PROVIDER = ProviderDriverKind.make("githubCopilot");
const GITHUB_COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const GITHUB_COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const GITHUB_COPILOT_ACP_MODEL_CAPABILITY_TIMEOUT = "4 seconds";
const GITHUB_COPILOT_ACP_MODEL_DISCOVERY_CONCURRENCY = 4;
export const GITHUB_COPILOT_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export function buildInitialGitHubCopilotProviderSnapshot(
  githubCopilotSettings: GitHubCopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getGitHubCopilotFallbackModels(githubCopilotSettings);

    if (!githubCopilotSettings.enabled) {
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GITHUB_COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking GitHub Copilot CLI availability...",
      },
    });
  });
}

interface GitHubCopilotSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

interface GitHubCopilotAcpDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<GitHubCopilotSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies GitHubCopilotSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies GitHubCopilotSessionSelectOption,
        ),
  );
}

function normalizeGitHubCopilotReasoningValue(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function findGitHubCopilotModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

function getGitHubCopilotConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isGitHubCopilotEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findGitHubCopilotEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isGitHubCopilotEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getGitHubCopilotConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getGitHubCopilotConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function isGitHubCopilotContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isGitHubCopilotFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function isGitHubCopilotThinkingConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "thinking" || name.includes("thinking");
}

function isBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") {
    return true;
  }
  if (option.type !== "select") {
    return false;
  }
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) => entry.value.trim().toLowerCase()),
  );
  return values.has("true") && values.has("false");
}

function getBooleanCurrentValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): boolean | undefined {
  if (!option) {
    return undefined;
  }
  if (option.type === "boolean") {
    return option.currentValue;
  }
  if (option.type !== "select") {
    return undefined;
  }
  const normalized = option.currentValue?.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

export function buildGitHubCopilotCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const reasoningConfig = findGitHubCopilotEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeGitHubCopilotReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeGitHubCopilotReasoningValue(reasoningConfig.currentValue) ===
              normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isGitHubCopilotContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => {
          if (contextOption.currentValue === entry.value) {
            return {
              value: entry.value,
              label: entry.name,
              isDefault: true,
            };
          }
          return {
            value: entry.value,
            label: entry.name,
          };
        })
      : [];

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isGitHubCopilotFastConfigOption(option),
  );
  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isGitHubCopilotThinkingConfigOption(option),
  );
  const fastCurrentValue = getBooleanCurrentValue(fastOption);
  const thinkingCurrentValue = getBooleanCurrentValue(thinkingOption);
  const optionDescriptors = [
    ...(reasoningEffortLevels.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: reasoningConfig?.name?.trim() || "Reasoning",
            options: reasoningEffortLevels,
          }),
        ]
      : []),
    ...(contextWindowOptions.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "contextWindow",
            label: contextOption?.name?.trim() || "Context Window",
            options: contextWindowOptions,
          }),
        ]
      : []),
    ...(fastOption && isBooleanLikeConfigOption(fastOption)
      ? [
          typeof fastCurrentValue === "boolean"
            ? buildBooleanOptionDescriptor({
                id: "fastMode",
                label: fastOption.name?.trim() || "Fast Mode",
                currentValue: fastCurrentValue,
              })
            : buildBooleanOptionDescriptor({
                id: "fastMode",
                label: fastOption.name?.trim() || "Fast Mode",
              }),
        ]
      : []),
    ...(thinkingOption && isBooleanLikeConfigOption(thinkingOption)
      ? [
          typeof thinkingCurrentValue === "boolean"
            ? buildBooleanOptionDescriptor({
                id: "thinking",
                label: thinkingOption.name?.trim() || "Thinking",
                currentValue: thinkingCurrentValue,
              })
            : buildBooleanOptionDescriptor({
                id: "thinking",
                label: thinkingOption.name?.trim() || "Thinking",
              }),
        ]
      : []),
  ];

  return createModelCapabilities({
    optionDescriptors,
  });
}

function buildGitHubCopilotDiscoveredModels(
  discoveredModels: ReadonlyArray<GitHubCopilotAcpDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discoveredModels.flatMap((model) => {
    if (!model.slug || seen.has(model.slug)) {
      return [];
    }
    seen.add(model.slug);
    return [
      {
        slug: model.slug,
        name: model.name,
        isCustom: false,
        capabilities: model.capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

function buildGitHubCopilotDiscoveredModelsFromModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }

  const currentModelCapabilities = buildGitHubCopilotCapabilitiesFromConfigOptions(configOptions);

  return buildGitHubCopilotDiscoveredModels(
    modelState.availableModels.map((model) => ({
      slug: model.modelId.trim(),
      name: model.name.trim() || model.modelId.trim(),
      capabilities:
        modelState.currentModelId.trim() === model.modelId.trim()
          ? currentModelCapabilities
          : EMPTY_CAPABILITIES,
    })),
  );
}

function hasGitHubCopilotModelCapabilities(
  model: Pick<ServerProviderModel, "capabilities">,
): boolean {
  return (model.capabilities?.optionDescriptors?.length ?? 0) > 0;
}

export function buildGitHubCopilotDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const modelOption = findGitHubCopilotModelConfigOption(configOptions);
  const modelChoices = flattenSessionConfigSelectOptions(modelOption);
  if (!modelOption || modelChoices.length === 0) {
    return [];
  }

  const currentModelValue =
    modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
  const currentModelCapabilities = buildGitHubCopilotCapabilitiesFromConfigOptions(configOptions);

  return buildGitHubCopilotDiscoveredModels(
    modelChoices.map((modelChoice) => ({
      slug: modelChoice.value.trim(),
      name: modelChoice.name.trim(),
      capabilities:
        currentModelValue === modelChoice.value.trim()
          ? currentModelCapabilities
          : EMPTY_CAPABILITIES,
    })),
  );
}

export function buildGitHubCopilotDiscoveredModelsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const modelsFromState = buildGitHubCopilotDiscoveredModelsFromModelState(
    sessionSetupResult.models,
    sessionSetupResult.configOptions ?? [],
  );
  if (modelsFromState.length > 0) {
    return modelsFromState;
  }
  return buildGitHubCopilotDiscoveredModelsFromConfigOptions(
    sessionSetupResult.configOptions ?? [],
  );
}

const makeGitHubCopilotAcpProbeRuntime = (
  githubCopilotSettings: GitHubCopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: githubCopilotSettings.binaryPath,
          args: ["--acp"],
          cwd: process.cwd(),
          env: {
            ...environment,
            ...(githubCopilotSettings.homePath
              ? { COPILOT_HOME: githubCopilotSettings.homePath }
              : {}),
          },
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        authMethodId: "github_copilot_login",
        clientCapabilities: GITHUB_COPILOT_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

const withGitHubCopilotAcpProbeRuntime = <A, E, R>(
  githubCopilotSettings: GitHubCopilotSettings,
  useRuntime: (acp: AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  makeGitHubCopilotAcpProbeRuntime(githubCopilotSettings, environment).pipe(
    Effect.flatMap(useRuntime),
    Effect.scoped,
  );

function normalizeGitHubCopilotConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findGitHubCopilotSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: GitHubCopilotSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findGitHubCopilotBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findGitHubCopilotSelectOptionValue(
    configOption,
    (option) => normalizeGitHubCopilotConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveGitHubCopilotAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "default";
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveGitHubCopilotAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{
    readonly configId: string;
    readonly value: string | boolean;
  }> = [];

  const reasoningOption = findGitHubCopilotEffortConfigOption(configOptions);
  const requestedReasoning = normalizeGitHubCopilotReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (reasoningOption && requestedReasoning) {
    const value = findGitHubCopilotSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeGitHubCopilotReasoningValue(option.value);
      const normalizedName = normalizeGitHubCopilotReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isGitHubCopilotContextConfigOption(option),
  );
  const requestedContextWindow = getProviderOptionStringSelectionValue(selections, "contextWindow");
  if (contextOption && requestedContextWindow) {
    const value = findGitHubCopilotSelectOptionValue(
      contextOption,
      (option) =>
        normalizeGitHubCopilotConfigOptionToken(option.value) ===
          normalizeGitHubCopilotConfigOptionToken(requestedContextWindow) ||
        normalizeGitHubCopilotConfigOptionToken(option.name) ===
          normalizeGitHubCopilotConfigOptionToken(requestedContextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isGitHubCopilotFastConfigOption(option),
  );
  const requestedFastMode = getProviderOptionBooleanSelectionValue(selections, "fastMode");
  if (fastOption && typeof requestedFastMode === "boolean") {
    const value = findGitHubCopilotBooleanConfigValue(fastOption, requestedFastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isGitHubCopilotThinkingConfigOption(option),
  );
  const requestedThinking = getProviderOptionBooleanSelectionValue(selections, "thinking");
  if (thinkingOption && typeof requestedThinking === "boolean") {
    const value = findGitHubCopilotBooleanConfigValue(thinkingOption, requestedThinking);
    if (value !== undefined) {
      updates.push({ configId: thinkingOption.id, value });
    }
  }

  return updates;
}

export const discoverGitHubCopilotModelsViaAcp = (
  githubCopilotSettings: GitHubCopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  withGitHubCopilotAcpProbeRuntime(
    githubCopilotSettings,
    (acp) =>
      Effect.map(acp.start(), (started) =>
        buildGitHubCopilotDiscoveredModelsFromSessionSetup(started.sessionSetupResult),
      ),
    environment,
  );

export const discoverGitHubCopilotModelCapabilitiesViaAcp = (
  githubCopilotSettings: GitHubCopilotSettings,
  existingModels: ReadonlyArray<ServerProviderModel>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  withGitHubCopilotAcpProbeRuntime(
    githubCopilotSettings,
    (acp) =>
      Effect.gen(function* () {
        const started = yield* acp.start();
        const initialConfigOptions = started.sessionSetupResult.configOptions ?? [];
        const modelOption = findGitHubCopilotModelConfigOption(initialConfigOptions);
        const modelChoices = flattenSessionConfigSelectOptions(modelOption);
        if (!modelOption || modelChoices.length === 0) {
          return [];
        }

        const currentModelValue =
          modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
        const capabilitiesBySlug = new Map<string, ModelCapabilities>();
        if (currentModelValue) {
          capabilitiesBySlug.set(
            currentModelValue,
            buildGitHubCopilotCapabilitiesFromConfigOptions(initialConfigOptions),
          );
        }

        const targetModelSlugs = new Set(
          existingModels
            .filter((model) => !model.isCustom && !hasGitHubCopilotModelCapabilities(model))
            .map((model) => model.slug),
        );
        if (targetModelSlugs.size === 0) {
          return buildGitHubCopilotDiscoveredModels(
            modelChoices.map((modelChoice) => ({
              slug: modelChoice.value.trim(),
              name: modelChoice.name.trim(),
              capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
            })),
          );
        }

        const probedCapabilities = yield* Effect.forEach(
          modelChoices,
          (modelChoice) => {
            const modelSlug = modelChoice.value.trim();
            if (
              !modelSlug ||
              !targetModelSlugs.has(modelSlug) ||
              capabilitiesBySlug.has(modelSlug)
            ) {
              return Effect.void.pipe(
                Effect.as<readonly [string, ModelCapabilities] | undefined>(undefined),
              );
            }

            return withGitHubCopilotAcpProbeRuntime(
              githubCopilotSettings,
              (probeAcp) =>
                Effect.gen(function* () {
                  const probeStarted = yield* probeAcp.start();
                  const probeConfigOptions = probeStarted.sessionSetupResult.configOptions ?? [];
                  const probeModelOption = findGitHubCopilotModelConfigOption(probeConfigOptions);
                  const probeCurrentModelValue =
                    probeModelOption?.type === "select"
                      ? probeModelOption.currentValue?.trim() || undefined
                      : undefined;
                  yield* Effect.annotateCurrentSpan({
                    "githubCopilot.acp.model.value": modelSlug,
                    "githubCopilot.acp.model.currentValue": probeCurrentModelValue,
                    "githubCopilot.acp.config_option_id": probeModelOption?.id ?? modelOption.id,
                  });
                  const nextConfigOptions =
                    probeCurrentModelValue === modelSlug
                      ? probeConfigOptions
                      : yield* probeAcp
                          .setConfigOption(probeModelOption?.id ?? modelOption.id, modelSlug)
                          .pipe(
                            Effect.map((response) => response.configOptions ?? probeConfigOptions),
                          );
                  return [
                    modelSlug,
                    buildGitHubCopilotCapabilitiesFromConfigOptions(nextConfigOptions),
                  ] as const;
                }),
              environment,
            ).pipe(
              Effect.timeout(GITHUB_COPILOT_ACP_MODEL_CAPABILITY_TIMEOUT),
              Effect.retry({ times: 3 }),
              Effect.withSpan("githubCopilot-acp-model-capability-probe"),
              Effect.catchCause((cause) =>
                Effect.logWarning("GitHubCopilot ACP capability probe failed", {
                  modelSlug,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          },
          { concurrency: GITHUB_COPILOT_ACP_MODEL_DISCOVERY_CONCURRENCY },
        );

        for (const entry of probedCapabilities) {
          if (!entry) {
            continue;
          }
          capabilitiesBySlug.set(entry[0], entry[1]);
        }

        return buildGitHubCopilotDiscoveredModels(
          modelChoices.map((modelChoice) => ({
            slug: modelChoice.value.trim(),
            name: modelChoice.name.trim(),
            capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
          })),
        );
      }).pipe(Effect.withSpan("githubCopilot-acp-model-capability-discovery", {})),
    environment,
  );

export function getGitHubCopilotFallbackModels(
  githubCopilotSettings: Pick<GitHubCopilotSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [],
    PROVIDER,
    githubCopilotSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export interface GitHubCopilotAboutResult {
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts = messages
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function buildGitHubCopilotProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly githubCopilotSettings: GitHubCopilotSettings;
  readonly parsed: GitHubCopilotAboutResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: GITHUB_COPILOT_PRESENTATION,
    enabled: input.githubCopilotSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      PROVIDER,
      input.githubCopilotSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    slashCommands: input.slashCommands ?? [],
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

export function parseGitHubCopilotVersionOutput(result: CommandResult): string | null {
  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(/GitHub Copilot CLI\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  return match?.[1] ?? null;
}

export function parseGitHubCopilotHelpCommandsOutput(
  result: CommandResult,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands: EffectAcpSchema.AvailableCommand[] = [];
  const combined = `${result.stdout}\n${result.stderr}`;

  for (const line of combined.split(/\r?\n/u)) {
    const match = line.match(/^\s+\/([A-Za-z0-9][A-Za-z0-9_-]*)\s{2,}(.+?)\s*$/u);
    if (!match) {
      continue;
    }
    const name = match[1]!.trim();
    const description = match[2]!.trim();
    commands.push({
      name,
      description,
    });
  }

  return normalizeAcpAvailableCommands(commands);
}

const runGitHubCopilotCommand = (
  githubCopilotSettings: GitHubCopilotSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env = {
      ...environment,
      ...(githubCopilotSettings.homePath ? { COPILOT_HOME: githubCopilotSettings.homePath } : {}),
    };
    const command = ChildProcess.make(githubCopilotSettings.binaryPath, [...args], {
      env,
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runGitHubCopilotVersionCommand = (
  githubCopilotSettings: GitHubCopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => runGitHubCopilotCommand(githubCopilotSettings, ["version"], environment);

const runGitHubCopilotHelpCommandsCommand = (
  githubCopilotSettings: GitHubCopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => runGitHubCopilotCommand(githubCopilotSettings, ["help", "commands"], environment);

export const checkGitHubCopilotProviderStatus = Effect.fn("checkGitHubCopilotProviderStatus")(
  function* (
    githubCopilotSettings: GitHubCopilotSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = getGitHubCopilotFallbackModels(githubCopilotSettings);

    if (!githubCopilotSettings.enabled) {
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    const versionProbe = yield* runGitHubCopilotVersionCommand(
      githubCopilotSettings,
      environment,
    ).pipe(Effect.timeoutOption(8_000), Effect.result);

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: githubCopilotSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
            : `Failed to execute GitHub Copilot CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: githubCopilotSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "GitHub Copilot CLI is installed but timed out while running `copilot version`.",
        },
      });
    }

    const version = parseGitHubCopilotVersionOutput(versionProbe.success.value);
    let parsed: GitHubCopilotAboutResult = {
      version,
      status: "ready",
      auth: { status: "unknown", type: "github-copilot" },
    };
    let slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [];
    let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
    let discoveryWarning: string | undefined;
    if (parsed.auth.status !== "unauthenticated") {
      const helpCommandsExit = yield* Effect.exit(
        runGitHubCopilotHelpCommandsCommand(githubCopilotSettings, environment).pipe(
          Effect.timeoutOption(8_000),
        ),
      );
      if (Exit.isSuccess(helpCommandsExit) && Option.isSome(helpCommandsExit.value)) {
        slashCommands = parseGitHubCopilotHelpCommandsOutput(helpCommandsExit.value.value);
      } else if (Exit.isFailure(helpCommandsExit)) {
        yield* Effect.logWarning("GitHubCopilot slash command discovery failed", {
          cause: Cause.pretty(helpCommandsExit.cause),
        });
      }

      const discoveryExit = yield* Effect.exit(
        discoverGitHubCopilotModelsViaAcp(githubCopilotSettings, environment).pipe(
          Effect.timeoutOption(GITHUB_COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
        ),
      );
      if (Exit.isFailure(discoveryExit)) {
        const prettyCause = Cause.pretty(discoveryExit.cause);
        yield* Effect.logWarning("GitHubCopilot ACP model discovery failed", {
          cause: prettyCause,
        });
        if (
          /auth|login|token|credential|unauthorized|forbidden|copilot requests/i.test(prettyCause)
        ) {
          parsed = {
            version,
            status: "error",
            auth: { status: "unauthenticated", type: "github-copilot" },
            message: "GitHub Copilot CLI is not authenticated. Run `copilot login` and try again.",
          };
        } else {
          discoveryWarning =
            "GitHub Copilot ACP model discovery failed. Check server logs for details.";
        }
      } else if (Option.isNone(discoveryExit.value)) {
        discoveryWarning = `GitHub Copilot ACP model discovery timed out after ${GITHUB_COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
      } else if (discoveryExit.value.value.length === 0) {
        discoveryWarning = "GitHub Copilot ACP model discovery returned no built-in models.";
      } else {
        discoveredModels = discoveryExit.value;
      }
    }
    return buildGitHubCopilotProviderSnapshot({
      checkedAt,
      githubCopilotSettings,
      parsed,
      slashCommands,
      discoveredModels: Option.getOrElse(
        Option.filter(discoveredModels, (models) => models.length > 0),
        () => [] as const,
      ),
      ...(discoveryWarning ? { discoveryWarning } : {}),
    });
  },
);

export function hasUncapturedGitHubCopilotModels(
  snapshot: Pick<ServerProvider, "models">,
): boolean {
  return snapshot.models.some(
    (model) => !model.isCustom && !hasGitHubCopilotModelCapabilities(model),
  );
}

/**
 * Background capability enrichment for a GitHubCopilot snapshot.
 *
 * Used by `GitHubCopilotDriver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: runs the slow ACP per-model capability probe, and republishes the
 * snapshot through `publishSnapshot` when new capabilities arrive. Skips
 * the probe when the provider is disabled, unauthenticated, or has no
 * uncaptured models. Keeps `EMPTY_CAPABILITIES` and the `PROVIDER` literal
 * private to this module.
 */
export const enrichGitHubCopilotSnapshot = (input: {
  readonly settings: GitHubCopilotSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  const enrichVersionAdvisory = enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    input.maintenanceCapabilities,
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("GitHubCopilot version advisory enrichment failed", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(snapshot)),
    ),
  );

  return enrichVersionAdvisory.pipe(
    Effect.flatMap((baseSnapshot) => {
      if (
        !settings.enabled ||
        baseSnapshot.auth.status === "unauthenticated" ||
        !hasUncapturedGitHubCopilotModels(baseSnapshot)
      ) {
        return Effect.void;
      }

      return discoverGitHubCopilotModelCapabilitiesViaAcp(
        settings,
        baseSnapshot.models,
        input.environment,
      ).pipe(
        Effect.flatMap((discoveredModels) => {
          if (discoveredModels.length === 0) {
            return Effect.void;
          }
          return publishSnapshot(
            stampIdentity({
              ...baseSnapshot,
              models: providerModelsFromSettings(
                discoveredModels,
                PROVIDER,
                settings.customModels,
                EMPTY_CAPABILITIES,
              ),
            }),
          );
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("GitHubCopilot ACP background capability enrichment failed", {
            models: baseSnapshot.models.map((model) => model.slug),
            cause: Cause.pretty(cause),
          }).pipe(Effect.asVoid),
        ),
      );
    }),
  );
};
