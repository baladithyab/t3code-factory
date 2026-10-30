import * as Effect from "effect/Effect";
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
import { SourceControlProviderKind } from "./sourceControl.ts";

export const FactoryRepository = Schema.Struct({
  provider: SourceControlProviderKind,
  /** Request authority, including any HTTP(S) port; canonical keys omit the port. */
  host: TrimmedNonEmptyString,
  // Host path below the origin: `owner/name`, or `group/subgroup/project` on GitLab.
  repository: TrimmedNonEmptyString,
  canonicalKey: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type FactoryRepository = typeof FactoryRepository.Type;

/**
 * A provider's static ceiling for Factory work on its issues. A declared capability says the host
 * API can express the observation; it is never authority to run, publish or merge anything.
 * Absent support degrades: readiness stays `unknown`, delivery is refused.
 */
export const FactoryIssueCapabilities = Schema.Struct({
  provider: SourceControlProviderKind,
  displayName: TrimmedNonEmptyString,
  blockedBy: Schema.Literals(["none", "listing", "listing-with-total"]),
  subIssues: Schema.Boolean,
  closeAcceptance: Schema.Literals(["none", "close-reason"]),
  publish: Schema.Boolean,
  headPinnedMerge: Schema.Boolean,
  // Servers before artifact delivery sent no such flag and could not comment; absent means no.
  issueComment: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type FactoryIssueCapabilities = typeof FactoryIssueCapabilities.Type;

// Servers older than the issue-tracker port only ever served GitHub and sent no capabilities; a
// newer client must keep decoding their results, so an absent field means that GitHub ceiling.
const LegacyGitHubCapabilities: FactoryIssueCapabilities = {
  provider: SourceControlProviderKind.make("github"),
  displayName: "GitHub",
  blockedBy: "listing-with-total",
  subIssues: true,
  closeAcceptance: "close-reason",
  publish: true,
  headPinnedMerge: true,
  issueComment: false,
};
const CapabilitiesOrLegacyGitHub = FactoryIssueCapabilities.pipe(
  Schema.withDecodingDefault(Effect.succeed(LegacyGitHubCapabilities)),
);

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
  // Absent on legacy launches and snapshots without an origin branch destination.
  baseBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
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
  // Opaque SHA-256 token over the repository and the exact issue title/body. Compare it; never
  // parse it. Labels, state, URL and timestamps can change without invalidating a review.
  revision: TrimmedNonEmptyString,
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
  capabilities: CapabilitiesOrLegacyGitHub,
  issues: Schema.Array(FactoryIssue),
  nextPage: Schema.NullOr(PositiveInt),
  fetchedAt: IsoDateTime,
});
export type FactoryIssueListResult = typeof FactoryIssueListResult.Type;
export const FactoryIssueReadInput = Schema.Struct({
  projectId: ProjectId,
  issueNumber: PositiveInt,
});
export type FactoryIssueReadInput = typeof FactoryIssueReadInput.Type;
export const FactoryIssueReadResult = Schema.Struct({
  repository: FactoryRepository,
  capabilities: CapabilitiesOrLegacyGitHub,
  issue: FactoryIssue,
  fetchedAt: IsoDateTime,
});
export type FactoryIssueReadResult = typeof FactoryIssueReadResult.Type;

export const FactoryIssueStartInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  expectedRepositoryKey: TrimmedNonEmptyString,
  issueNumber: PositiveInt,
  // The full-content revision the caller reviewed. New and restarted tasks require it to match the
  // live issue; an existing saved task resumes its original snapshot and ignores this value.
  expectedIssueRevision: FactoryIssue.fields.revision,
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
      "issue-changed",
      "readiness-changed",
      "override-not-allowed",
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
        return "The project's intake repository is on a host this environment cannot read issues from. Factory issue intake supports GitHub and GitLab.";
      case "missing-project":
        return "The selected project no longer exists.";
      case "missing-repository":
        return "The project has no usable repository remote.";
      case "repository-changed":
        return "The repository changed since this issue was selected or reserved. Refresh the inbox before starting new work; restore the original remote to resume an unfinished reservation.";
      case "authentication":
        return "The issue host requires authentication. Check the environment's credentials for this repository's host.";
      case "rate-limited":
        return "The issue host's request limit was reached. Retry after the limit resets.";
      case "remote-failure":
        return "The issue host could not read the issues. Check repository access and connectivity.";
      case "invalid-response":
        return "The issue host returned an invalid or incomplete issue response.";
      case "not-an-issue":
        return "This item is a change request, not an issue.";
      case "closed-issue":
        return "Closed issues cannot start new tasks. An existing task can still be opened.";
      case "deleted-task":
        return "The linked thread or its owning project was deleted. Confirm a new attempt to restart this issue.";
      case "issue-changed":
        return "The issue title or body no longer matches the reviewed content. Refresh and review the current issue before starting new work; existing tasks are unaffected.";
      case "readiness-changed":
        return "The blocker resolution changed since you reviewed it. Refresh and review the current evidence before setting an override.";
      case "override-not-allowed":
        return "This override is not allowed for the current blocker evidence. Re-observe it; only accepted blockers can be disputed and unresolved tombstones can be waived.";
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
