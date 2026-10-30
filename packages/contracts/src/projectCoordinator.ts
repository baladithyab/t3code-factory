import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const ProjectCoordinatorStatus = Schema.Literals([
  "launching",
  "preparing",
  "running",
  "idle",
  "failed",
  "archived",
  "missing",
]);
export type ProjectCoordinatorStatus = typeof ProjectCoordinatorStatus.Type;

export const ProjectCoordinator = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  status: ProjectCoordinatorStatus,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  current: Schema.Boolean,
});
export type ProjectCoordinator = typeof ProjectCoordinator.Type;

export const ProjectCoordinatorGetInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectCoordinatorGetInput = typeof ProjectCoordinatorGetInput.Type;

export const ProjectCoordinatorGetResult = Schema.Struct({
  coordinator: Schema.NullOr(ProjectCoordinator),
  fetchedAt: IsoDateTime,
});
export type ProjectCoordinatorGetResult = typeof ProjectCoordinatorGetResult.Type;

export const ProjectCoordinatorListResult = Schema.Struct({
  coordinators: Schema.Array(ProjectCoordinator),
  fetchedAt: IsoDateTime,
});
export type ProjectCoordinatorListResult = typeof ProjectCoordinatorListResult.Type;

export const ProjectCoordinatorEnsureInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  expectedThreadId: Schema.NullOr(ThreadId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  replaceRetired: Schema.optional(Schema.Boolean),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type ProjectCoordinatorEnsureInput = typeof ProjectCoordinatorEnsureInput.Type;

export const ProjectCoordinatorEnsureResult = Schema.Struct({
  coordinator: ProjectCoordinator,
  resumed: Schema.Boolean,
});
export type ProjectCoordinatorEnsureResult = typeof ProjectCoordinatorEnsureResult.Type;

export class ProjectCoordinatorError extends Schema.TaggedError<ProjectCoordinatorError>()(
  "ProjectCoordinatorError",
  {
    reason: Schema.Literals([
      "missing-project",
      "provider-unavailable",
      "retired-coordinator",
      "binding-changed",
      "command-conflict",
      "launch-authority",
      "launch-failed",
      "persistence-failure",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing-project":
        return "The selected project no longer exists.";
      case "provider-unavailable":
        return "The selected provider is unavailable or disabled for this project. Enable it or select an enabled provider before starting the orchestrator.";
      case "retired-coordinator":
        return "The project orchestrator is missing. Review its binding and explicitly confirm a replacement.";
      case "binding-changed":
        return "The project orchestrator binding changed. Refresh and review the current binding before starting a replacement.";
      case "command-conflict":
        return "This request was already used for another project. Start a new request for the selected project.";
      case "launch-authority":
        return "This reserved launch exceeds the caller's runtime authority. Resume it from an authorized client.";
      case "launch-failed":
        return "The project orchestrator launch was interrupted. Retry to resume the same reserved thread.";
      case "persistence-failure":
        return "The environment could not read or save the project orchestrator association.";
    }
  }
}
