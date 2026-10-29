import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { FactoryIssueCapabilities, SourceControlProviderKind } from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

export class IssueTrackerProviderError extends Schema.TaggedError<IssueTrackerProviderError>()(
  "IssueTrackerProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals([
      "missing-tool",
      "unauthenticated",
      "rate-limited",
      "not-found",
      "not-an-issue",
      "invalid-response",
      "truncated-response",
      "failed",
    ]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * One issue as the host reports it, normalized across forges. `number` is the project-local
 * identifier a person types and sees in the URL (GitHub number, GitLab iid, Gitea index); it is what
 * origin keys and launch rows carry. Change requests never appear here: `listIssues` drops them
 * and `getIssue` fails with `not-an-issue`.
 */
export interface TrackerIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly url: string;
  readonly labels: ReadonlyArray<string>;
  readonly updatedAt: string;
}

export interface TrackerRepositoryRef {
  /** A checkout of the repository; CLI-backed hosts resolve credentials from it. */
  readonly cwd: string;
  readonly host: string;
  /** Host path below the origin, as `FactoryRepository.repository`. */
  readonly repository: string;
}

export interface TrackerIssuePage {
  readonly issues: ReadonlyArray<TrackerIssue>;
  readonly nextPage: number | null;
}

export interface TrackerIssueComment {
  readonly id: number;
  readonly body: string;
  readonly url: string;
}

export interface TrackerIssueCommentPage {
  readonly comments: ReadonlyArray<TrackerIssueComment>;
  readonly nextPage: number | null;
}

/**
 * The provider's static ceiling. `publish` and `headPinnedMerge` describe what the Factory delivery
 * path can guarantee through this host's change-request adapter; they sit beside the tracker
 * because delivery grants are keyed by issue origin. When `expectedHeadSha` is threaded through
 * every adapter, the pin guarantee moves onto `PullRequestCapabilities` and is derived here.
 */
export type IssueTrackerCapabilities = Omit<FactoryIssueCapabilities, "provider">;

export interface IssueTrackerProviderApi {
  readonly kind: SourceControlProviderKind;
  readonly capabilities: IssueTrackerCapabilities;
  /**
   * The intake path for a canonical key's path component, or null when the host cannot address
   * it (a mount prefix on Forgejo, too few segments anywhere).
   */
  readonly repositoryPath: (path: string) => string | null;
  readonly listIssues: (
    input: TrackerRepositoryRef & {
      readonly state: "open" | "closed" | "all";
      readonly page: number;
    },
  ) => Effect.Effect<TrackerIssuePage, IssueTrackerProviderError>;
  readonly getIssue: (
    input: TrackerRepositoryRef & { readonly number: number },
  ) => Effect.Effect<TrackerIssue, IssueTrackerProviderError>;
  /**
   * Present exactly when `capabilities.issueComment` is true. The caller composed `body` from
   * bytes a person reviewed; the adapter posts it verbatim and returns the host's comment identity.
   */
  readonly commentOnIssue?: (
    input: TrackerRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<TrackerIssueComment, IssueTrackerProviderError>;
  /** Oldest first, so a reconcile walks the whole list without a clock. */
  readonly listIssueComments?: (
    input: TrackerRepositoryRef & { readonly number: number; readonly page: number },
  ) => Effect.Effect<TrackerIssueCommentPage, IssueTrackerProviderError>;
}
