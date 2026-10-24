import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const FactoryRepository = Schema.Struct({
  provider: Schema.Literal("github"),
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  canonicalKey: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type FactoryRepository = typeof FactoryRepository.Type;

export const FactoryIssueTask = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  status: Schema.Literals([
    "launching",
    "preparing",
    "running",
    "idle",
    "failed",
    "archived",
    "missing",
  ]),
  baseRef: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type FactoryIssueTask = typeof FactoryIssueTask.Type;

export const FactoryIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  url: Schema.String,
  labels: Schema.Array(Schema.String),
  updatedAt: IsoDateTime,
  task: Schema.NullOr(FactoryIssueTask),
});
export type FactoryIssue = typeof FactoryIssue.Type;

export const FactoryIssueListInput = Schema.Struct({
  projectId: ProjectId,
  state: Schema.optional(Schema.Literals(["open", "closed", "all"])),
  page: Schema.optional(PositiveInt),
});
export type FactoryIssueListInput = typeof FactoryIssueListInput.Type;
export const FactoryIssueListResult = Schema.Struct({
  repository: FactoryRepository,
  issues: Schema.Array(FactoryIssue),
  nextPage: Schema.NullOr(PositiveInt),
  fetchedAt: IsoDateTime,
});
export type FactoryIssueListResult = typeof FactoryIssueListResult.Type;

export const FactoryIssueStartInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  expectedRepositoryKey: TrimmedNonEmptyString,
  issueNumber: PositiveInt,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  restartDeleted: Schema.optional(Schema.Boolean),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type FactoryIssueStartInput = typeof FactoryIssueStartInput.Type;
export const FactoryIssueStartResult = Schema.Struct({
  repository: FactoryRepository,
  issueNumber: PositiveInt,
  projectId: ProjectId,
  threadId: ThreadId,
  task: FactoryIssueTask,
  resumed: Schema.Boolean,
});
export type FactoryIssueStartResult = typeof FactoryIssueStartResult.Type;

export class FactoryIssueError extends Schema.TaggedError<FactoryIssueError>()(
  "FactoryIssueError",
  {
    reason: Schema.Literals([
      "unsupported-provider",
      "missing-project",
      "missing-repository",
      "repository-changed",
      "closed-issue",
      "deleted-task",
      "invalid-base-ref",
      "launch-failure",
      "launch-authority",
      "persistence-failure",
      "authentication",
      "rate-limited",
      "remote-failure",
      "invalid-response",
      "not-an-issue",
      "provider-unavailable",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-provider":
        return "The project's intake repository is not supported. Factory issue intake requires GitHub.";
      case "missing-project":
        return "The selected project no longer exists.";
      case "missing-repository":
        return "The project has no usable repository remote.";
      case "repository-changed":
        return "The repository changed since this issue was selected or reserved. Refresh the inbox before starting new work; restore the original remote to resume an unfinished reservation.";
      case "authentication":
        return "GitHub authentication is required. Check the environment's GitHub credentials.";
      case "rate-limited":
        return "GitHub's request limit was reached. Retry after the limit resets.";
      case "remote-failure":
        return "GitHub could not read the issues. Check repository access and connectivity.";
      case "invalid-response":
        return "GitHub returned an invalid or incomplete issue response.";
      case "not-an-issue":
        return "This GitHub item is a pull request, not an issue.";
      case "closed-issue":
        return "Closed issues cannot start new tasks. An existing task can still be opened.";
      case "deleted-task":
        return "The linked thread or its owning project was deleted. Confirm a new attempt to restart this issue.";
      case "invalid-base-ref":
        return "The base ref does not resolve to a local commit. Choose an existing branch, tag, or commit.";
      case "launch-authority":
        return "This reserved launch exceeds the caller's runtime authority. Resume it from an authorized client.";
      case "launch-failure":
        return "The issue launch was interrupted. Retry Start to resume the same reserved task.";
      case "provider-unavailable":
        return "The selected provider is unavailable or disabled for this project. Enable it or select an enabled provider before starting the issue.";
      case "persistence-failure":
        return "The environment could not read or save the issue association.";
    }
  }
}
