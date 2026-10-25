import {
  EnvironmentAuthorizationError,
  ProjectCoordinatorError,
  type ProjectCoordinatorStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export function coordinatorPresentation(status: ProjectCoordinatorStatus) {
  switch (status) {
    case "launching":
      return {
        label: "Launch pending",
        detail:
          "The launch has not finished. Resume uses the same thread and original orientation request.",
      };
    case "preparing":
      return { label: "Preparing", detail: "The orchestrator thread is being prepared." };
    case "running":
      return {
        label: "Running",
        detail: "The agent is running in the existing orchestrator thread.",
      };
    case "idle":
      return { label: "Idle", detail: "The orchestrator is waiting for your next request." };
    case "failed":
      return {
        label: "Failed",
        detail:
          "Open the existing thread to inspect the failure and use its retry controls. No replacement is created.",
      };
    case "archived":
      return {
        label: "Archived",
        detail: "Open the existing thread to inspect or unarchive it. Opening sends no message.",
      };
    case "missing":
      return {
        label: "Unavailable",
        detail:
          "The saved orchestrator is missing or its startup cannot finish. Creating a replacement requires a new confirmation.",
      };
  }
}

export interface CoordinatorFailure {
  readonly title: string;
  readonly message: string;
  readonly requiresReview: boolean;
}

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isCoordinatorError = Schema.is(ProjectCoordinatorError);

export function coordinatorFailure(error: unknown): CoordinatorFailure {
  if (isAuthorizationError(error)) {
    return {
      title: "Permission required",
      message: "This connection does not have permission for this orchestrator request.",
      requiresReview: true,
    };
  }
  if (isCoordinatorError(error)) {
    switch (error.reason) {
      case "missing-project":
        return {
          title: "Project unavailable",
          message:
            "The selected project no longer exists. Close this dialog and choose an available checkout.",
          requiresReview: true,
        };
      case "provider-unavailable":
        return {
          title: "Provider unavailable",
          message:
            "The selected provider or model is unavailable. Close this dialog and review the provider settings.",
          requiresReview: true,
        };
      case "retired-coordinator":
      case "binding-changed":
        return {
          title: "Orchestrator binding changed",
          message:
            "Close this dialog and review the refreshed orchestrator before confirming another request.",
          requiresReview: true,
        };
      case "command-conflict":
        return {
          title: "Request conflict",
          message:
            "This request cannot be reused for this destination. Close the dialog and review a new request.",
          requiresReview: true,
        };
      case "launch-authority":
        return {
          title: "Launch mode not permitted",
          message:
            "This connection cannot launch with the requested modes. Close the dialog and review the modes and permissions.",
          requiresReview: true,
        };
      case "launch-failed":
        return {
          title: "Launch did not finish",
          message:
            "The orientation launch did not finish. Retry the same request to recover its existing thread without sending another orientation.",
          requiresReview: false,
        };
      case "persistence-failure":
        return {
          title: "Could not save the orchestrator",
          message:
            "The environment could not persist this request. Retry the same request or reconnect before reviewing its state.",
          requiresReview: false,
        };
    }
  }
  return {
    title: "Orchestrator request failed",
    message:
      "The environment could not complete the request. Check the connection, then refresh or retry the same request.",
    requiresReview: false,
  };
}
