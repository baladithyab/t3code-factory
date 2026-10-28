import {
  FactoryDeliveryError,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPrepareResult,
  type PullRequestMergeMethod,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { describeFactoryFailure } from "./factoryIssues.logic";

const isFactoryDeliveryError = Schema.is(FactoryDeliveryError);

export function factoryDeliveryFailureMessage(
  error: unknown,
  displayName: string,
  fallbackMessage?: string,
  kind: FactoryDeliveryIntent["kind"] = "publish-pr",
): string {
  if (isFactoryDeliveryError(error)) {
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
      FactoryDeliveryPrepareResult,
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

export function describeDeliveryStatus(
  intent: Pick<FactoryDeliveryIntent, "kind" | "status" | "failure">,
  displayName: string,
): string {
  switch (intent.status) {
    case "pending":
    case "sending":
      return intent.kind === "merge-pr" ? "Merging…" : "Publishing…";
    case "confirmed":
      return intent.kind === "merge-pr" ? "Merged" : "Published";
    case "unknown":
      return `The server lost the response. Reconcile to check ${displayName}.`;
    case "failed":
      return (
        intent.failure ?? (intent.kind === "merge-pr" ? "Merge failed." : "Publication failed.")
      );
  }
}
