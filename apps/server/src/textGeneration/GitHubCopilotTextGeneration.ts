import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type GitHubCopilotSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
import { type ThreadTitleGenerationResult, type TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import {
  applyGitHubCopilotAcpModelSelection,
  makeGitHubCopilotAcpRuntime,
} from "../provider/acp/GitHubCopilotAcpSupport.ts";

const GITHUB_COPILOT_TIMEOUT_MS = 180_000;

function mapGitHubCopilotAcpError(
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
  detail: string,
  cause: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

/**
 * Build a GitHubCopilot text-generation closure bound to a specific `GitHubCopilotSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeGitHubCopilotTextGeneration = Effect.fn("makeGitHubCopilotTextGeneration")(
  function* (
    githubCopilotSettings: GitHubCopilotSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const runGitHubCopilotJson = <S extends Schema.Top>({
      operation,
      cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
    }: {
      operation:
        | "generateCommitMessage"
        | "generatePrContent"
        | "generateBranchName"
        | "generateThreadTitle";
      cwd: string;
      prompt: string;
      outputSchemaJson: S;
      modelSelection: ModelSelection;
    }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const outputRef = yield* Ref.make("");
        const runtime = yield* makeGitHubCopilotAcpRuntime({
          githubCopilotSettings,
          environment,
          childProcessSpawner: commandSpawner,
          cwd,
          clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        });

        yield* runtime.handleSessionUpdate((notification) => {
          const update = notification.update;
          if (update.sessionUpdate !== "agent_message_chunk") {
            return Effect.void;
          }
          const content = update.content;
          if (content.type !== "text") {
            return Effect.void;
          }
          return Ref.update(outputRef, (current) => current + content.text);
        });

        const promptResult = yield* Effect.gen(function* () {
          yield* runtime.start();
          yield* Effect.ignore(runtime.setMode("ask"));
          yield* applyGitHubCopilotAcpModelSelection({
            runtime,
            model: modelSelection.model,
            selections: modelSelection.options,
            mapError: ({ cause, configId, step }) =>
              mapGitHubCopilotAcpError(
                operation,
                step === "set-config-option"
                  ? `Failed to set GitHub Copilot ACP config option "${configId}" for text generation.`
                  : "Failed to set GitHub Copilot ACP base model for text generation.",
                cause,
              ),
          });

          return yield* runtime.prompt({
            prompt: [{ type: "text", text: prompt }],
          });
        }).pipe(
          Effect.timeoutOption(GITHUB_COPILOT_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation,
                    detail: "GitHub Copilot CLI request timed out.",
                  }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
          Effect.mapError((cause) =>
            isTextGenerationError(cause)
              ? cause
              : mapGitHubCopilotAcpError(operation, "GitHub Copilot ACP request failed.", cause),
          ),
        );

        const rawResult = (yield* Ref.get(outputRef)).trim();
        if (!rawResult) {
          return yield* new TextGenerationError({
            operation,
            detail:
              promptResult.stopReason === "cancelled"
                ? "GitHub Copilot ACP request was cancelled."
                : "GitHub Copilot CLI returned empty output.",
          });
        }

        const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
        return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
          Effect.catchTag("SchemaError", (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "GitHub Copilot CLI returned invalid structured output.",
                cause,
              }),
            ),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : mapGitHubCopilotAcpError(
                operation,
                "GitHub Copilot ACP text generation failed.",
                cause,
              ),
        ),
        Effect.scoped,
      );

    const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
      "GitHubCopilotTextGeneration.generateCommitMessage",
    )(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const generated = yield* runGitHubCopilotJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

    const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
      "GitHubCopilotTextGeneration.generatePrContent",
    )(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const generated = yield* runGitHubCopilotJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

    const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
      "GitHubCopilotTextGeneration.generateBranchName",
    )(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runGitHubCopilotJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

    const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
      "GitHubCopilotTextGeneration.generateThreadTitle",
    )(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runGitHubCopilotJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies ThreadTitleGenerationResult;
    });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGenerationShape;
  },
);
