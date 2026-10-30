import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryIssueTask, FactoryRepository } from "./factory.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const FactoryFeedSourceId = Schema.String.pipe(Schema.brand("FactoryFeedSourceId"));
export type FactoryFeedSourceId = typeof FactoryFeedSourceId.Type;

/** Bounds a reviewer can rely on: anything larger is stored as unreviewable, never truncated. */
export const FACTORY_FEED_TITLE_MAX_CHARS = 1024;
export const FACTORY_FEED_CONTENT_MAX_CHARS = 64 * 1024;
export const FACTORY_FEED_INSTRUCTIONS_MAX_CHARS = 4096;
export const FACTORY_FEED_DISMISSAL_NOTE_MAX_CHARS = 1024;

export const FactoryFeedSource = Schema.Struct({
  id: FactoryFeedSourceId,
  projectId: ProjectId,
  // The URL the user bound. A redirect target is never written back here.
  locator: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  // `suspended` is the unbound state. Items and launches survive it; rebinding reuses the id.
  status: Schema.Literals(["active", "suspended"]),
  createdAt: IsoDateTime,
  lastCheckedAt: Schema.NullOr(IsoDateTime),
  // Server-side refresh floor derived from the last fetch and any Retry-After header.
  nextAllowedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type FactoryFeedSource = typeof FactoryFeedSource.Type;

/** A feed item that normalizes to a forge issue URL. Own-repository issues are never admissible. */
export const FactoryFeedForgeReference = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  issueNumber: PositiveInt,
});
export type FactoryFeedForgeReference = typeof FactoryFeedForgeReference.Type;

export const FactoryFeedCandidateDisposition = Schema.Literals([
  "open",
  "dismissed",
  // Only an RFC 6721 `at:deleted-entry` retracts; absence from the feed window never does.
  "retracted",
  // Missing stable identity or over the size bounds. Visible, never admissible.
  "unreviewable",
]);
export type FactoryFeedCandidateDisposition = typeof FactoryFeedCandidateDisposition.Type;

export const FactoryFeedCandidate = Schema.Struct({
  sourceId: FactoryFeedSourceId,
  // `atom:` + exact atom:id, `guid:` + RSS guid, or `link:` + absolute link. Never a content hash.
  itemKey: Schema.String.check(Schema.isMinLength(1)),
  title: Schema.NullOr(Schema.String),
  // Verbatim as published, markup included. Clients render it as text, never as HTML.
  content: Schema.NullOr(Schema.String),
  link: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(IsoDateTime),
  // Opaque SHA-256 token over the source, item key and the exact title/content/link. Compare it;
  // never parse it. Timestamps, author and categories can change without invalidating a review.
  revision: TrimmedNonEmptyString,
  ordinal: PositiveInt,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  inWindow: Schema.Boolean,
  disposition: FactoryFeedCandidateDisposition,
  dismissalNote: Schema.NullOr(Schema.String),
  forgeReference: Schema.NullOr(FactoryFeedForgeReference),
  task: Schema.NullOr(FactoryIssueTask),
});
export type FactoryFeedCandidate = typeof FactoryFeedCandidate.Type;

export const FactoryFeedSourceListInput = Schema.Struct({ projectId: ProjectId });
export type FactoryFeedSourceListInput = typeof FactoryFeedSourceListInput.Type;
export const FactoryFeedSourceListResult = Schema.Struct({
  sources: Schema.Array(FactoryFeedSource),
});
export type FactoryFeedSourceListResult = typeof FactoryFeedSourceListResult.Type;

export const FactoryFeedSourceBindInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  url: TrimmedNonEmptyString,
});
export type FactoryFeedSourceBindInput = typeof FactoryFeedSourceBindInput.Type;
export const FactoryFeedSourceUnbindInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  sourceId: FactoryFeedSourceId,
});
export type FactoryFeedSourceUnbindInput = typeof FactoryFeedSourceUnbindInput.Type;
export const FactoryFeedSourceRefreshInput = Schema.Struct({
  projectId: ProjectId,
  sourceId: FactoryFeedSourceId,
});
export type FactoryFeedSourceRefreshInput = typeof FactoryFeedSourceRefreshInput.Type;
/** Bind, unbind and refresh all answer with the source as it is after the operation. */
export const FactoryFeedSourceResult = Schema.Struct({
  source: FactoryFeedSource,
  // Items observed by this fetch: new revisions plus unchanged items still in the window.
  observed: NonNegativeInt,
  // True when the server answered from validators (304) and no item changed.
  notModified: Schema.Boolean,
});
export type FactoryFeedSourceResult = typeof FactoryFeedSourceResult.Type;

export const FactoryFeedCandidateListInput = Schema.Struct({
  projectId: ProjectId,
  sourceId: Schema.optional(FactoryFeedSourceId),
  disposition: Schema.optional(Schema.Literals(["open", "dismissed", "all"])),
});
export type FactoryFeedCandidateListInput = typeof FactoryFeedCandidateListInput.Type;
export const FactoryFeedCandidateListResult = Schema.Struct({
  repository: Schema.NullOr(FactoryRepository),
  candidates: Schema.Array(FactoryFeedCandidate),
  fetchedAt: IsoDateTime,
});
export type FactoryFeedCandidateListResult = typeof FactoryFeedCandidateListResult.Type;

export const FactoryFeedCandidateReadInput = Schema.Struct({
  projectId: ProjectId,
  sourceId: FactoryFeedSourceId,
  itemKey: FactoryFeedCandidate.fields.itemKey,
});
export type FactoryFeedCandidateReadInput = typeof FactoryFeedCandidateReadInput.Type;
export const FactoryFeedCandidateReadResult = Schema.Struct({
  repository: Schema.NullOr(FactoryRepository),
  source: FactoryFeedSource,
  candidate: FactoryFeedCandidate,
  fetchedAt: IsoDateTime,
});
export type FactoryFeedCandidateReadResult = typeof FactoryFeedCandidateReadResult.Type;

export const FactoryFeedCandidateDismissInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  sourceId: FactoryFeedSourceId,
  itemKey: FactoryFeedCandidate.fields.itemKey,
  // A dismissal binds to the reviewed revision; a later edit reopens the candidate.
  expectedRevision: FactoryFeedCandidate.fields.revision,
  dismissed: Schema.Boolean,
  note: Schema.optional(
    Schema.String.check(Schema.isMaxLength(FACTORY_FEED_DISMISSAL_NOTE_MAX_CHARS)),
  ),
});
export type FactoryFeedCandidateDismissInput = typeof FactoryFeedCandidateDismissInput.Type;
export const FactoryFeedCandidateDismissResult = Schema.Struct({
  candidate: FactoryFeedCandidate,
});
export type FactoryFeedCandidateDismissResult = typeof FactoryFeedCandidateDismissResult.Type;

export const FactoryFeedCandidateAdmitInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  expectedRepositoryKey: TrimmedNonEmptyString,
  sourceId: FactoryFeedSourceId,
  itemKey: FactoryFeedCandidate.fields.itemKey,
  // The full-content revision the reviewer saw. New and restarted tasks require it to match the
  // stored current revision; an existing saved task resumes its original snapshot and ignores it.
  expectedRevision: FactoryFeedCandidate.fields.revision,
  // Reviewer-authored requirements, frozen into the task and kept apart from the untrusted item.
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(FACTORY_FEED_INSTRUCTIONS_MAX_CHARS)),
  ),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  restartDeleted: Schema.optional(Schema.Boolean),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type FactoryFeedCandidateAdmitInput = typeof FactoryFeedCandidateAdmitInput.Type;
export const FactoryFeedCandidateAdmitResult = Schema.Struct({
  repository: FactoryRepository,
  sourceId: FactoryFeedSourceId,
  itemKey: FactoryFeedCandidate.fields.itemKey,
  projectId: ProjectId,
  threadId: ThreadId,
  task: FactoryIssueTask,
  resumed: Schema.Boolean,
});
export type FactoryFeedCandidateAdmitResult = typeof FactoryFeedCandidateAdmitResult.Type;

export class FactoryFeedError extends Schema.TaggedError<FactoryFeedError>()("FactoryFeedError", {
  reason: Schema.Literals([
    "missing-project",
    "missing-repository",
    "unsupported-provider",
    "repository-changed",
    "invalid-url",
    "unsafe-host",
    "missing-source",
    "source-suspended",
    "source-exists",
    "refresh-throttled",
    "feed-unavailable",
    "feed-too-large",
    "invalid-feed",
    "missing-candidate",
    "candidate-changed",
    "candidate-dismissed",
    "candidate-retracted",
    "candidate-unreviewable",
    "forge-issue-source",
    "deleted-task",
    "invalid-base-ref",
    "launch-failure",
    "launch-authority",
    "provider-unavailable",
    "origin-conflict",
    "persistence-failure",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "missing-project":
        return "The selected project no longer exists.";
      case "missing-repository":
        return "The project has no usable repository remote.";
      case "unsupported-provider":
        return "The project's repository is not supported. Factory tasks require a GitHub remote.";
      case "repository-changed":
        return "The repository changed since this candidate was reviewed or reserved. Refresh before admitting new work; restore the original remote to resume an unfinished reservation.";
      case "invalid-url":
        return "Enter an absolute https:// feed URL without credentials.";
      case "unsafe-host":
        return "Feeds on loopback, private or link-local hosts cannot be bound from this environment.";
      case "missing-source":
        return "This feed source no longer exists for the project.";
      case "source-suspended":
        return "This feed source is unbound. Bind it again to refresh or admit its items.";
      case "source-exists":
        return "This feed is already bound to the project.";
      case "refresh-throttled":
        return "This feed was checked recently. Wait before checking it again.";
      case "feed-unavailable":
        return "The feed could not be fetched. Check the URL and connectivity, then check again.";
      case "feed-too-large":
        return "The feed document exceeds the size this environment will read.";
      case "invalid-feed":
        return "The response is not a supported RSS 2.0 or Atom 1.0 document.";
      case "missing-candidate":
        return "This item is no longer recorded for the feed.";
      case "candidate-changed":
        return "The item title, content or link no longer matches the reviewed content. Review the current item before admitting new work; existing tasks are unaffected.";
      case "candidate-dismissed":
        return "This item is dismissed. Restore it before admitting work.";
      case "candidate-retracted":
        return "The publisher retracted this item. It cannot be admitted.";
      case "candidate-unreviewable":
        return "This item has no stable identity or exceeds the size bounds, so it cannot be reviewed for admission.";
      case "forge-issue-source":
        return "This item points at one of this project's own GitHub issues. Start it from the Issues inbox instead.";
      case "deleted-task":
        return "The linked thread or its owning project was deleted. Confirm a new attempt to restart this item.";
      case "invalid-base-ref":
        return "The base ref does not resolve to a local commit. Choose an existing branch, tag, or commit.";
      case "launch-authority":
        return "This reserved launch exceeds the caller's runtime authority. Resume it from an authorized client.";
      case "launch-failure":
        return "The task launch was interrupted. Retry to resume the same reserved task.";
      case "provider-unavailable":
        return "The selected provider is unavailable or disabled for this project. Enable it or select an enabled provider before admitting the item.";
      case "origin-conflict":
        return "This item is claimed more than once by older records in this environment. Review the conflicting tasks before admitting it again; nothing is merged automatically.";
      case "persistence-failure":
        return "The environment could not read or save the feed records.";
    }
  }
}
