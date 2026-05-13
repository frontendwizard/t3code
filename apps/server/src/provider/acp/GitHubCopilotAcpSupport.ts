import { type GitHubCopilotSettings, type ProviderOptionSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  GITHUB_COPILOT_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveGitHubCopilotAcpBaseModelId,
  resolveGitHubCopilotAcpConfigUpdates,
} from "../Layers/GitHubCopilotProvider.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type GitHubCopilotAcpRuntimeGitHubCopilotSettings = Pick<
  GitHubCopilotSettings,
  "binaryPath" | "homePath"
>;

export interface GitHubCopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly githubCopilotSettings: GitHubCopilotAcpRuntimeGitHubCopilotSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface GitHubCopilotAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildGitHubCopilotAcpSpawnInput(
  githubCopilotSettings: GitHubCopilotAcpRuntimeGitHubCopilotSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  return {
    command: githubCopilotSettings?.binaryPath || "copilot",
    args: ["--acp"],
    cwd,
    env: {
      ...environment,
      ...(githubCopilotSettings?.homePath ? { COPILOT_HOME: githubCopilotSettings.homePath } : {}),
    },
  };
}

export const makeGitHubCopilotAcpRuntime = (
  input: GitHubCopilotAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGitHubCopilotAcpSpawnInput(
          input.githubCopilotSettings,
          input.cwd,
          input.environment,
        ),
        authMethodId: "github_copilot_login",
        clientCapabilities: GITHUB_COPILOT_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

interface GitHubCopilotAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyGitHubCopilotAcpModelSelection<E>(input: {
  readonly runtime: GitHubCopilotAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: GitHubCopilotAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* input.runtime.setModel(resolveGitHubCopilotAcpBaseModelId(input.model)).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    const configUpdates = resolveGitHubCopilotAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.selections,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}
