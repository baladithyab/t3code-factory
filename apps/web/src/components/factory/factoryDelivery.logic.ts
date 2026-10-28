import { FactoryDeliveryError, type FactoryDeliveryIntent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { describeFactoryFailure } from "./factoryIssues.logic";

const isFactoryDeliveryError = Schema.is(FactoryDeliveryError);

export function factoryDeliveryFailureMessage(error: unknown, fallbackMessage?: string): string {
  if (isFactoryDeliveryError(error)) {
    switch (error.reason) {
      case "head-moved":
      case "acceptance-stale":
        return "The head moved since acceptance. Re-accept, then prepare again.";
      case "payload-changed":
        return "The title or body changed since the preview. Prepare again.";
      case "already-delivering":
        return "A pull request is already being published for this task.";
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
    }
  }
  return describeFactoryFailure(error, fallbackMessage).message;
}

export function isLiveFactoryDelivery(intent: Pick<FactoryDeliveryIntent, "status">): boolean {
  // Confirmed still owns the single publication slot for this task.
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
