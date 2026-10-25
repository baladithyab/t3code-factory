import {
  OrchestratorMcpFailure,
  type FactoryIssueError,
  type ProjectCoordinatorError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Factory from "../../../factory/FactoryIssueService.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as Coordinators from "../../../project/ProjectCoordinatorService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { FactoryToolkit } from "./tools.ts";

const failure = (error: FactoryIssueError | ProjectCoordinatorError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "launch-authority" ? "runtime_mode_escalation_denied" : "invalid_request",
    message: error.message,
  });
export const layer = McpToolAccess.toLayer(FactoryToolkit, {
  factory_list_issues: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const factory = yield* Factory.FactoryIssueService;
      return yield* factory.list(input).pipe(Effect.mapError(failure));
    }),
  ),
  factory_read_issue: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const factory = yield* Factory.FactoryIssueService;
      return yield* factory.read(input).pipe(Effect.mapError(failure));
    }),
  ),
  factory_start_issue: McpToolAccess.startsThreads(
    (input) => input,
    (input, modes) =>
      Effect.gen(function* () {
        const caller = yield* readCaller();
        if (!caller.scope.capabilities.has("worktree"))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Starting an issue task requires worktree authority.",
          });
        const factory = yield* Factory.FactoryIssueService;
        // A retry replays the stored modes, not these request modes. Carry the caller's ceiling
        // through the service and the orchestration command lock as well as checking new input.
        return yield* factory
          .start({ ...input, ...modes, creationSource: "mcp" })
          .pipe(Effect.provideService(DispatchModeLimit, caller.limits), Effect.mapError(failure));
      }),
  ),
  factory_get_orchestrator: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const coordinators = yield* Coordinators.ProjectCoordinatorService;
      return yield* coordinators.get(input).pipe(Effect.mapError(failure));
    }),
  ),
  factory_start_orchestrator: McpToolAccess.startsThreads(
    (input) => input,
    (input, modes) =>
      Effect.gen(function* () {
        const caller = yield* readCaller();
        const coordinators = yield* Coordinators.ProjectCoordinatorService;
        // Resuming uses frozen launch modes; the service must enforce the caller's current ceiling.
        return yield* coordinators
          .ensure({ ...input, ...modes, creationSource: "mcp" })
          .pipe(Effect.provideService(DispatchModeLimit, caller.limits), Effect.mapError(failure));
      }),
  ),
});
