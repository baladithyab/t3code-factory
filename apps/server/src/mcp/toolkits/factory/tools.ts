import {
  FactoryIssueListInput,
  FactoryIssueListResult,
  FactoryIssueReadInput,
  FactoryIssueReadResult,
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
const read = Tool.make("factory_read_issue", {
  ...shared,
  description:
    "Read one complete GitHub issue snapshot and its content revision from a registered project's server-resolved origin. Reading never starts work. Review the full title and body before explicitly authorizing a new task. Do not authorize from a truncated result; this tool has no partial-content paging. Returns existing task ownership separately from the live issue.",
  parameters: FactoryIssueReadInput,
  success: FactoryIssueReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const start = Tool.make("factory_start_issue", {
  ...shared,
  description:
    "Explicitly start an isolated worktree task for an open GitHub issue, or return/resume its existing saved task. First read the complete issue with factory_read_issue (or an untruncated factory_list_issues entry), review its title/body, and pass repository.canonicalKey as expectedRepositoryKey and issue.revision as expectedIssueRevision. New admissions and confirmed deleted-task restarts reject changed content; refresh and review again rather than silently substituting a new revision. Existing reservations keep their original prompt, base, model and modes; live revision is not revalidated on resume, and resumed:true can return another caller's already-admitted task. Requires orchestration and worktree authority. Reuse commandId when retrying the same request. restartDeleted requires explicit user confirmation. A revision is not proof of human approval. Does not authorize publication, push, PR creation, merge, release, or secret disclosure.",
  parameters: FactoryIssueStartInput,
  success: FactoryIssueStartResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const FactoryToolkit = Toolkit.make(list, read, start);
