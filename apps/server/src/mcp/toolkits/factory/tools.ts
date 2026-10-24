import {
  FactoryIssueListInput,
  FactoryIssueListResult,
  FactoryIssueStartInput,
  FactoryIssueStartResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Factory from "../../../factory/FactoryIssueService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Factory.FactoryIssueService,
    Threads.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
const list = Tool.make("factory_list_issues", {
  ...shared,
  description:
    "Read one bounded page of GitHub issues from a registered project's server-resolved origin repository. Reading never starts work. Returns the actual intake repository and existing task links.",
  parameters: FactoryIssueListInput,
  success: FactoryIssueListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const start = Tool.make("factory_start_issue", {
  ...shared,
  description:
    "Explicitly start an isolated worktree task for an open GitHub issue, or return its existing thread. First call factory_list_issues and pass its repository.canonicalKey as expectedRepositoryKey; a changed remote is refused, never silently retargeted. Requires orchestration and worktree authority. Reuse commandId when retrying. restartDeleted requires explicit user confirmation for a new attempt after thread deletion. Does not authorize publication, push, PR creation, merge, release, or secret disclosure.",
  parameters: FactoryIssueStartInput,
  success: FactoryIssueStartResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const FactoryToolkit = Toolkit.make(list, start);
