import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryAcceptance } from "./factoryAcceptance.ts";
import { FactoryOriginKey } from "./factoryClaims.ts";
import { FactoryRepository } from "./factory.ts";
import {
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestState,
} from "./pullRequest.ts";

export const FACTORY_DELIVERY_TITLE_MAX_CHARS = 256;
export const FACTORY_DELIVERY_BODY_MAX_CHARS = 65536;

export const FactoryDeliveryKind = Schema.Literals(["publish-pr", "merge-pr"]);
export type FactoryDeliveryKind = typeof FactoryDeliveryKind.Type;

/**
 * `pending` and `sending` are server-driven; `unknown` means a send may or may not have reached
 * the forge and is only ever settled by reading remote state, never by sending again.
 */
export const FactoryDeliveryStatus = Schema.Literals([
  "pending",
  "sending",
  "confirmed",
  "failed",
  "unknown",
]);
export type FactoryDeliveryStatus = typeof FactoryDeliveryStatus.Type;

export const FactoryDeliveryPublishPayload = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(FACTORY_DELIVERY_TITLE_MAX_CHARS)),
  body: Schema.String.check(Schema.isMaxLength(FACTORY_DELIVERY_BODY_MAX_CHARS)),
  draft: Schema.Boolean,
});
export type FactoryDeliveryPublishPayload = typeof FactoryDeliveryPublishPayload.Type;

export const FactoryDeliveryMergePayload = Schema.Struct({
  mergeMethod: PullRequestMergeMethod,
});
export type FactoryDeliveryMergePayload = typeof FactoryDeliveryMergePayload.Type;

/**
 * A stored `publish-pr` row has no `mergeMethod` and a merge payload has no `title`, so each
 * shape decodes as exactly one member and rows written before `merge-pr` existed still decode.
 */
export const FactoryDeliveryPayload = Schema.Union([
  FactoryDeliveryPublishPayload,
  FactoryDeliveryMergePayload,
]);
export type FactoryDeliveryPayload = typeof FactoryDeliveryPayload.Type;

/**
 * A grant-then-execute record. It is committed before the side effect and pinned to an exact
 * `(repository, baseRef, headSha, payloadDigest)`: a head move or a changed payload invalidates
 * the grant, and a lost response leaves it `unknown` rather than retried.
 */
export const FactoryDeliveryIntent = Schema.Struct({
  id: Schema.String,
  originKey: FactoryOriginKey,
  threadId: ThreadId,
  projectId: ProjectId,
  kind: FactoryDeliveryKind,
  acceptanceId: Schema.String,
  repository: FactoryRepository,
  baseRef: Schema.String,
  baseSha: Schema.String,
  headSha: Schema.String,
  payload: FactoryDeliveryPayload,
  // sha256 hex, computed only on the server.
  payloadDigest: Schema.String,
  grantedBy: EnvironmentId,
  grantedAt: IsoDateTime,
  requestCommandId: Schema.String,
  status: FactoryDeliveryStatus,
  remote: Schema.NullOr(Schema.Struct({ number: Schema.Int, url: Schema.String })),
  failure: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type FactoryDeliveryIntent = typeof FactoryDeliveryIntent.Type;

/** Agents may call this (read-only): it proposes the exact payload a person can then grant. */
export const FactoryDeliveryPrepareInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  kind: FactoryDeliveryKind,
  payload: FactoryDeliveryPayload,
});
export type FactoryDeliveryPrepareInput = typeof FactoryDeliveryPrepareInput.Type;

/** What a person is about to merge, as the host reports it now; filled for `merge-pr` only. */
export const FactoryDeliveryPullRequest = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  headSha: Schema.NullOr(Schema.String),
  state: PullRequestState,
  mergeability: PullRequestMergeability,
  isDraft: Schema.Boolean,
  checksSummary: Schema.NullOr(Schema.String),
  /** Methods the repository allows; a grant for a disabled one would be refused by the host. */
  mergeMethods: Schema.Array(PullRequestMergeMethod),
});
export type FactoryDeliveryPullRequest = typeof FactoryDeliveryPullRequest.Type;

export const FactoryDeliveryPrepareResult = Schema.Struct({
  acceptance: FactoryAcceptance,
  current: Schema.Boolean,
  repository: FactoryRepository,
  baseRef: Schema.String,
  headSha: Schema.String,
  payload: FactoryDeliveryPayload,
  // What a grant must echo back; the grant recomputes it and refuses a mismatch.
  payloadDigest: Schema.String,
  existing: Schema.NullOr(FactoryDeliveryIntent),
  pullRequest: Schema.NullOr(FactoryDeliveryPullRequest),
});
export type FactoryDeliveryPrepareResult = typeof FactoryDeliveryPrepareResult.Type;

/**
 * A person's act, never an agent's. `expectedHeadSha` and `expectedPayloadDigest` are only what
 * the grantor saw; the server re-derives both inside the grant transaction.
 */
export const FactoryDeliveryGrantInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  kind: FactoryDeliveryKind,
  commandId: TrimmedNonEmptyString,
  expectedHeadSha: TrimmedNonEmptyString,
  expectedPayloadDigest: TrimmedNonEmptyString,
  payload: FactoryDeliveryPayload,
});
export type FactoryDeliveryGrantInput = typeof FactoryDeliveryGrantInput.Type;

export const FactoryDeliveryReadInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type FactoryDeliveryReadInput = typeof FactoryDeliveryReadInput.Type;

export const FactoryDeliveryReadResult = Schema.Struct({
  // Newest first.
  intents: Schema.Array(FactoryDeliveryIntent),
});
export type FactoryDeliveryReadResult = typeof FactoryDeliveryReadResult.Type;

export const FactoryDeliveryReconcileInput = Schema.Struct({
  projectId: ProjectId,
  intentId: Schema.String,
});
export type FactoryDeliveryReconcileInput = typeof FactoryDeliveryReconcileInput.Type;

export class FactoryDeliveryError extends Schema.TaggedError<FactoryDeliveryError>()(
  "FactoryDeliveryError",
  {
    reason: Schema.Literals([
      "unknown-thread",
      "not-a-factory-task",
      "not-accepted",
      "acceptance-stale",
      "head-moved",
      "payload-changed",
      "already-delivering",
      "not-published",
      "already-merged",
      "pull-request-head-moved",
      "not-mergeable",
      "intent-not-found",
      "not-reconcilable",
      "worktree-unavailable",
      "persistence-failure",
      "capability-unsupported",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unknown-thread":
        return "This thread does not exist in the selected project.";
      case "not-a-factory-task":
        return "This thread is not a claimed Factory task, so it has nothing to deliver.";
      case "not-accepted":
        return "No commit is accepted for this task. Accept the commit before publishing it.";
      case "acceptance-stale":
        return "The worktree head moved since the commit was accepted. Accept the current commit first.";
      case "head-moved":
        return "The worktree head moved since you reviewed it. Review the current commit before publishing.";
      case "payload-changed":
        return "The pull request title or body changed since you reviewed it. Review it again.";
      case "already-delivering":
        return "A pull request is already being published, or was published, for this task.";
      case "not-published":
        return "Publish the pull request first.";
      case "already-merged":
        return "This pull request is already merged.";
      case "pull-request-head-moved":
        return "The pull request head is not the accepted commit. Re-accept and refresh.";
      case "not-mergeable":
        return "The host reports the pull request cannot be merged right now.";
      case "intent-not-found":
        return "This delivery does not exist in the selected project.";
      case "not-reconcilable":
        return "Only a delivery whose outcome is unknown or failed can be reconciled.";
      case "worktree-unavailable":
        return "The task's worktree is no longer available, so its commit cannot be read.";
      case "persistence-failure":
        return "The environment could not read or save the delivery.";
      case "capability-unsupported":
        return "This repository's host does not support that delivery action with the exact-commit guarantee the Factory requires.";
    }
  }
}
