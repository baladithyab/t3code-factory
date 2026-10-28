import {
  OrchestratorMcpFailure,
  FactoryResearchError,
  type FactoryAcceptanceError,
  type FactoryDeliveryError,
  type FactoryIssueError,
  type FactoryFeedError,
  type ProjectCoordinatorError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Factory from "../../../factory/FactoryIssueService.ts";
import * as Relations from "../../../factory/FactoryIssueRelations.ts";
import * as Feeds from "../../../factory/FactoryFeedService.ts";
import * as Research from "../../../factory/FactoryResearchService.ts";
import * as Claims from "../../../factory/FactoryClaimsService.ts";
import * as Acceptance from "../../../factory/FactoryAcceptanceService.ts";
import * as Delivery from "../../../factory/FactoryDeliveryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as Coordinators from "../../../project/ProjectCoordinatorService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { FactoryToolkit } from "./tools.ts";

const failure = (
  error:
    | FactoryIssueError
    | FactoryFeedError
    | FactoryResearchError
    | FactoryAcceptanceError
    | FactoryDeliveryError
    | ProjectCoordinatorError,
) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "launch-authority" ? "runtime_mode_escalation_denied" : "invalid_request",
    message: error.message,
  });
export const layer = McpToolAccess.toLayer(FactoryToolkit, {
  factory_list_research_protocols: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Research.FactoryResearchService)
        .listProtocols(input)
        .pipe(Effect.mapError(failure));
    }),
  ),
  factory_read_research_protocol: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Research.FactoryResearchService)
        .readProtocol(input)
        .pipe(Effect.mapError(failure));
    }),
  ),
  factory_launch_research_run: McpToolAccess.startsThreads(
    (input) => input,
    (input, modes) =>
      Effect.gen(function* () {
        const caller = yield* readCaller();
        if (input.role === "verify")
          return yield* failure(new FactoryResearchError({ reason: "verify-requires-user" }));
        if (!caller.scope.capabilities.has("worktree"))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Research runs require worktree authority.",
          });
        // The launcher is recorded so a verify run it or its descendants start is refused as not
        // independent; a client outside a thread has no identity to record.
        const { thread } = yield* McpInvocationContext.requireThreadScope(
          caller.scope,
          "This tool",
        );
        return yield* (yield* Research.FactoryResearchService)
          .launchRun({
            ...input,
            ...modes,
            creationSource: "mcp",
            launchedByThreadId: thread.threadId,
          })
          .pipe(Effect.provideService(DispatchModeLimit, caller.limits), Effect.mapError(failure));
      }),
  ),
  factory_record_research_evidence: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* Research.FactoryResearchService)
        .recordEvidence(input, caller.thread?.threadId)
        .pipe(Effect.mapError(failure));
    }),
  ),
  factory_list_feed_candidates: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const feeds = yield* Feeds.FactoryFeedService;
      return yield* feeds.listCandidates(input).pipe(Effect.mapError(failure));
    }),
  ),
  factory_read_feed_candidate: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const feeds = yield* Feeds.FactoryFeedService;
      return yield* feeds.readCandidate(input).pipe(Effect.mapError(failure));
    }),
  ),
  factory_admit_feed_candidate: McpToolAccess.startsThreads(
    (input) => input,
    (input, modes) =>
      Effect.gen(function* () {
        const caller = yield* readCaller();
        if (!caller.scope.capabilities.has("worktree"))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Admitting a feed task requires worktree authority.",
          });
        const feeds = yield* Feeds.FactoryFeedService;
        return yield* feeds
          .admitCandidate({ ...input, ...modes, creationSource: "mcp" })
          .pipe(Effect.provideService(DispatchModeLimit, caller.limits), Effect.mapError(failure));
      }),
  ),
  factory_list_claims: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Claims.FactoryClaimsService).list(input).pipe(Effect.mapError(failure));
    }),
  ),
  factory_read_acceptance: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Acceptance.FactoryAcceptanceService)
        .read(input)
        .pipe(Effect.mapError(failure));
    }),
  ),
  factory_prepare_delivery: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Delivery.FactoryDeliveryService)
        .prepare(input)
        .pipe(Effect.mapError(failure));
    }),
  ),
  factory_read_deliveries: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Delivery.FactoryDeliveryService)
        .read(input)
        .pipe(Effect.mapError(failure));
    }),
  ),
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
  factory_read_issue_readiness: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const relations = yield* Relations.FactoryIssueRelations;
      return yield* relations.read(input).pipe(Effect.mapError(failure));
    }),
  ),
  factory_read_issue_frontier: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const relations = yield* Relations.FactoryIssueRelations;
      return yield* relations.readFrontier(input).pipe(Effect.mapError(failure));
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
