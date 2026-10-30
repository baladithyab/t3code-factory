import {
  FACTORY_DELIVERY_BODY_MAX_CHARS,
  FactoryDeliveryError,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryPrepareResult,
  type FactoryCommitDeliveryIntent,
  type FactoryCommitDeliveryPrepareResult,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPrepareResult,
  type PullRequestMergeMethod,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { describeFactoryFailure } from "./factoryIssues.logic";

const isFactoryDeliveryError = Schema.is(FactoryDeliveryError);

/** Reasons whose copy differs when the subject is an accepted artifact instead of a commit. */
function artifactDeliveryFailureMessage(reason: FactoryDeliveryError["reason"]): string | null {
  switch (reason) {
    case "head-moved":
    case "acceptance-stale":
    case "artifact-changed":
      return "The artifact changed since acceptance. Re-accept it, then prepare again.";
    case "payload-changed":
      return "The comment changed since the preview. Prepare again.";
    case "already-delivering":
      return "A comment is already posted, or being posted, to this issue.";
    case "not-accepted":
      return "Accept the artifact, then prepare again.";
    case "worktree-unavailable":
      return "Restore the task folder, then prepare again.";
    case "artifact-too-large":
      return `The deliverable is larger than one comment can hold (${FACTORY_DELIVERY_BODY_MAX_CHARS.toLocaleString("en-US")} characters). It is never truncated or split.`;
    case "artifact-not-text":
      return "The deliverable is not UTF-8 text, so it cannot be posted as a comment.";
    case "destination-not-found":
      return "That issue does not exist in this project's repository, or it is a pull request.";
    case "capability-unsupported":
      return "This project's issue tracker cannot receive comments from the Factory yet.";
    default:
      return null;
  }
}

export function factoryDeliveryFailureMessage(
  error: unknown,
  displayName: string,
  fallbackMessage?: string,
  kind: FactoryDeliveryIntent["kind"] = "publish-pr",
): string {
  if (isFactoryDeliveryError(error)) {
    if (kind === "publish-artifact") {
      const artifactMessage = artifactDeliveryFailureMessage(error.reason);
      if (artifactMessage !== null) return artifactMessage;
    }
    // Reasons an artifact delivery has no copy for share the messages below.
    switch (error.reason) {
      case "head-moved":
      case "acceptance-stale":
        return "The head moved since acceptance. Re-accept, then prepare again.";
      case "payload-changed":
        return kind === "merge-pr"
          ? "The merge details changed since the preview. Prepare again."
          : "The title or body changed since the preview. Prepare again.";
      case "already-delivering":
        return kind === "merge-pr"
          ? "A merge has already been granted for this task."
          : "A pull request is already being published for this task.";
      case "not-published":
        return "Publish the pull request first.";
      case "pull-request-head-moved":
        return "The pull request head is not the accepted commit. Re-accept and refresh.";
      case "already-merged":
        return "This pull request is already merged.";
      case "not-mergeable":
        return `${displayName} reports the pull request cannot be merged right now.`;
      case "not-accepted":
        return "Accept the current commit, then prepare again.";
      case "not-reconcilable":
        if (error.replacementDeliveryId !== undefined) return error.message;
        return "This delivery can no longer be reconciled. Refresh its status.";
      case "intent-not-found":
        return "This delivery is no longer available. Refresh its status.";
      case "unknown-thread":
        return "This thread is no longer available.";
      case "not-a-factory-task":
        return "This thread is not a claimed Factory task.";
      case "worktree-unavailable":
        return "Restore the worktree, then prepare again.";
      case "capability-unsupported":
        return kind === "merge-pr"
          ? `Merging from ${displayName} is not supported yet.`
          : factoryPublishUnsupportedMessage(displayName);
    }
  }
  return describeFactoryFailure(error, fallbackMessage).message;
}

/** The whole delivery section for a host that cannot publish an exact accepted commit. */
export function factoryPublishUnsupportedMessage(displayName: string): string {
  return `Publishing from ${displayName} is not supported yet.`;
}

export function isLiveFactoryDelivery(intent: Pick<FactoryDeliveryIntent, "status">): boolean {
  // Confirmed still owns the single delivery slot for this task and kind.
  return intent.status !== "failed";
}

type GrantConditions = {
  readonly acceptanceCurrent: boolean;
  readonly existing: Pick<FactoryDeliveryIntent, "status"> | null;
  readonly hasPermission: boolean;
};

export function factoryDeliveryGrantDisabledReason(conditions: GrantConditions): string | null {
  if (!conditions.acceptanceCurrent) {
    return "The head moved since acceptance. Re-accept, then prepare again.";
  }
  if (conditions.existing !== null && isLiveFactoryDelivery(conditions.existing)) {
    return conditions.existing.status === "confirmed"
      ? "A pull request has already been published for this task."
      : "A pull request is already being published for this task.";
  }
  if (!conditions.hasPermission) {
    return "Publishing needs operate and source-control write permissions on this environment.";
  }
  return null;
}

export function canGrantFactoryDelivery(conditions: GrantConditions): boolean {
  return factoryDeliveryGrantDisabledReason(conditions) === null;
}

export function mergeGrantDisabledReason(
  conditions: GrantConditions & {
    readonly displayName: string;
    readonly prepared: Pick<
      FactoryCommitDeliveryPrepareResult,
      "current" | "headSha" | "pullRequest"
    > | null;
    readonly mergeMethod?: PullRequestMergeMethod;
  },
): string | null {
  if (!conditions.acceptanceCurrent || conditions.prepared?.current === false) {
    return "The head moved since acceptance. Re-accept, then prepare again.";
  }
  if (conditions.existing !== null && isLiveFactoryDelivery(conditions.existing)) {
    return conditions.existing.status === "confirmed"
      ? "This pull request is already merged."
      : "A merge has already been granted for this task.";
  }
  if (!conditions.hasPermission) {
    return "Merging needs operate and source-control write permissions on this environment.";
  }
  const prepared = conditions.prepared;
  const pullRequest = prepared?.pullRequest;
  if (prepared === null || pullRequest == null) {
    return "Prepare the merge before granting it.";
  }
  if (pullRequest.state === "merged") {
    return "This pull request is already merged.";
  }
  if (pullRequest.headSha !== prepared.headSha) {
    return "The pull request head is not the accepted commit. Re-accept and refresh.";
  }
  if (pullRequest.isDraft) {
    return "Mark the pull request ready for review before merging.";
  }
  if (pullRequest.mergeability === "conflicting" || pullRequest.state === "closed") {
    return `${conditions.displayName} reports the pull request cannot be merged right now.`;
  }
  if (
    conditions.mergeMethod !== undefined &&
    !pullRequest.mergeMethods.includes(conditions.mergeMethod)
  ) {
    return `The repository does not allow ${conditions.mergeMethod} merges. Choose another method.`;
  }
  return null;
}

const DELIVERY_STATUS_LABELS = {
  "publish-pr": { active: "Publishing…", done: "Published", failed: "Publication failed." },
  "merge-pr": { active: "Merging…", done: "Merged", failed: "Merge failed." },
  "publish-artifact": {
    active: "Posting comment…",
    done: "Comment posted",
    failed: "Posting the comment failed.",
  },
} as const satisfies Record<
  FactoryDeliveryIntent["kind"],
  { readonly active: string; readonly done: string; readonly failed: string }
>;

export function describeDeliveryStatus(
  intent: Pick<FactoryDeliveryIntent, "kind" | "status" | "failure">,
  displayName: string,
): string {
  const labels = DELIVERY_STATUS_LABELS[intent.kind];
  switch (intent.status) {
    case "pending":
    case "sending":
      return labels.active;
    case "confirmed":
      return labels.done;
    case "unknown":
      if (intent.kind === "publish-artifact" && intent.failure?.trim())
        return `${intent.failure} Reconcile to check ${displayName}.`;
      return `The server lost the response. Reconcile to check ${displayName}.`;
    case "failed":
      return intent.failure ?? labels.failed;
  }
}

export function isArtifactDeliveryIntent(
  intent: FactoryDeliveryIntent,
): intent is FactoryArtifactDeliveryIntent {
  return intent.kind === "publish-artifact";
}

export function isCommitDeliveryIntent(
  intent: FactoryDeliveryIntent,
): intent is FactoryCommitDeliveryIntent {
  return intent.kind !== "publish-artifact";
}

/** The artifact result is the only member that carries the artifact digest. */
export function artifactDeliveryPrepareResult(
  result: FactoryDeliveryPrepareResult | null,
): FactoryArtifactDeliveryPrepareResult | null {
  return result !== null && "artifactSha256" in result ? result : null;
}

export function commitDeliveryPrepareResult(
  result: FactoryDeliveryPrepareResult | null,
): FactoryCommitDeliveryPrepareResult | null {
  return result !== null && !("artifactSha256" in result) ? result : null;
}

/** A destination issue number as a person types it: `12` or `#12`, never a partial number. */
export function parseFactoryIssueNumber(text: string): number | null {
  const match = /^#?(\d+)$/.exec(text.trim());
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function artifactGrantDisabledReason(
  conditions: GrantConditions & {
    readonly prepared: Pick<FactoryArtifactDeliveryPrepareResult, "current"> | null;
  },
): string | null {
  if (!conditions.acceptanceCurrent || conditions.prepared?.current === false) {
    return "The artifact changed since acceptance. Re-accept it, then prepare again.";
  }
  if (conditions.existing !== null && isLiveFactoryDelivery(conditions.existing)) {
    return conditions.existing.status === "confirmed"
      ? "A comment has already been posted to this issue."
      : "A comment is already being posted to this issue.";
  }
  if (!conditions.hasPermission) {
    return "Posting a comment needs operate and source-control write permissions on this environment.";
  }
  if (conditions.prepared === null) return "Prepare the comment before granting it.";
  return null;
}

export interface FactoryArtifactDeliveryFailure {
  readonly message: string;
  readonly unsupported: boolean;
}

/**
 * A failure does not name the host, so the copy says "the issue tracker". A capability refusal is
 * flagged so the panel can show it as a quiet notice instead of an error.
 */
export function factoryArtifactDeliveryFailure(
  error: unknown,
  fallbackMessage?: string,
): FactoryArtifactDeliveryFailure {
  return {
    message: factoryDeliveryFailureMessage(
      error,
      "the issue tracker",
      fallbackMessage,
      "publish-artifact",
    ),
    unsupported: isFactoryDeliveryError(error) && error.reason === "capability-unsupported",
  };
}
