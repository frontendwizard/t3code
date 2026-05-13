import type { UserInputQuestion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const GitHubCopilotAskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const GitHubCopilotAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(GitHubCopilotAskQuestionOption),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const GitHubCopilotAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(GitHubCopilotAskQuestion),
});

const GitHubCopilotTodoStatus = Schema.String;

const GitHubCopilotTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(GitHubCopilotTodoStatus),
});

const GitHubCopilotPlanPhase = Schema.Struct({
  name: Schema.String,
  todos: Schema.Array(GitHubCopilotTodo),
});

export const GitHubCopilotCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(GitHubCopilotTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(GitHubCopilotPlanPhase)),
});

export const GitHubCopilotUpdateTodosRequest = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(GitHubCopilotTodo),
  merge: Schema.Boolean,
});

export function extractAskQuestions(
  params: typeof GitHubCopilotAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function extractPlanMarkdown(params: typeof GitHubCopilotCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(GitHub Copilot did not supply plan text.)";
}

export function extractTodosAsPlan(params: typeof GitHubCopilotUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  const plan = params.todos.flatMap((todo) => {
    const step = todo.content?.trim() ?? todo.title?.trim() ?? "";
    if (step === "") {
      return [];
    }
    const status: "pending" | "inProgress" | "completed" =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
  return { plan };
}
