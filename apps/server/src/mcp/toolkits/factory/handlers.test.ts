import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryDeliveryError,
  FactoryFeedError,
  FactoryIssueError,
  FactoryResearchError,
  FactoryResearchProtocolId,
  FactoryFeedSourceId,
  MessageId,
  ProjectId,
  FactoryOriginKey,
  ProjectCoordinatorError,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type AuthMcpClientAccess,
  type OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Factory from "../../../factory/FactoryIssueService.ts";
import * as Relations from "../../../factory/FactoryIssueRelations.ts";
import * as Feeds from "../../../factory/FactoryFeedService.ts";
import * as Research from "../../../factory/FactoryResearchService.ts";
import * as Claims from "../../../factory/FactoryClaimsService.ts";
import * as Delivery from "../../../factory/FactoryDeliveryService.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Coordinators from "../../../project/ProjectCoordinatorService.ts";
import * as Bindings from "../../../persistence/ProjectCoordinators.ts";
import * as Receipts from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

it.effect.each([
  {
    access: "read-only",
    capabilities: ["orchestration", "worktree"],
    requested: "approval-required",
    code: "capability_denied",
  },
  {
    access: "approval-required",
    capabilities: ["orchestration", "worktree"],
    requested: "full-access",
    code: "runtime_mode_escalation_denied",
  },
  {
    access: "full-access",
    capabilities: ["orchestration"],
    requested: "approval-required",
    code: "capability_denied",
  },
  {
    access: "full-access",
    capabilities: ["worktree"],
    requested: "approval-required",
    code: "capability_denied",
  },
] satisfies ReadonlyArray<{
  access: AuthMcpClientAccess;
  capabilities: ReadonlyArray<Context.McpCapability>;
  requested: "approval-required" | "full-access";
  code: OrchestratorMcpFailure["code"];
}>)(
  "refuses $access launch with $code before service invocation",
  ({ access, capabilities, requested, code }) =>
    Effect.gen(function* () {
      let called = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access },
          capabilities: new Set(capabilities),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({}),
        Layer.mock(Research.FactoryResearchService)({
          launchRun: () => {
            called = true;
            return Effect.die("Unauthorized research launch reached the service");
          },
        }),
        Layer.mock(Feeds.FactoryFeedService)({
          admitCandidate: () => {
            called = true;
            return Effect.die("Unauthorized feed admission reached the service");
          },
        }),
        Layer.mock(Factory.FactoryIssueService)({
          start: () => {
            called = true;
            return Effect.die("Unauthorized factory start reached the service");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_start_issue", {
          commandId: CommandId.make("start"),
          projectId: ProjectId.make("project"),
          issueNumber: 1,
          expectedRepositoryKey: "github.com/owner/repo",
          expectedIssueRevision: "0".repeat(64),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: requested,
          interactionMode: "default",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code });
      assert.isFalse(called);
      const feedOutputs = yield* toolkit
        .handle("factory_admit_feed_candidate", {
          commandId: CommandId.make("feed-admit"),
          projectId: ProjectId.make("project"),
          sourceId: FactoryFeedSourceId.make("feed"),
          itemKey: "atom:item",
          expectedRepositoryKey: "github.com/owner/repo",
          expectedRevision: "reviewed",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: requested,
          interactionMode: "default",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(feedOutputs.at(-1)?.result, { code });
      assert.isFalse(called);
      const researchOutputs = yield* toolkit
        .handle("factory_launch_research_run", {
          commandId: CommandId.make("research-launch"),
          projectId: ProjectId.make("project"),
          protocolId: FactoryResearchProtocolId.make("protocol"),
          expectedRepositoryKey: "github.com/owner/repo",
          expectedProtocolRevision: "reviewed",
          role: "explore",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: requested,
          interactionMode: "default",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(researchOutputs.at(-1)?.result, { code });
      assert.isFalse(called);
    }),
);

it.effect("refuses a focused issue read without orchestration capability before fetching", () =>
  Effect.gen(function* () {
    let called = false;
    const dependencies = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "factory-read-test",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "test", label: "test", access: "full-access" },
        capabilities: new Set<Context.McpCapability>(["worktree"]),
      }),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Coordinators.ProjectCoordinatorService)({}),
      Layer.mock(Factory.FactoryIssueService)({
        read: () => {
          called = true;
          return Effect.die("Unauthorized issue read reached the source");
        },
      }),
    );
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const outputs = yield* toolkit
      .handle("factory_read_issue", {
        projectId: ProjectId.make("project"),
        issueNumber: 1,
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
    assert.isFalse(called);
  }),
);

it.effect.each([true, false])(
  "read-only readiness requires orchestration capability: %s",
  (allowed) =>
    Effect.gen(function* () {
      let called = false;
      const result = {
        repository: {
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          repository: "owner/repo",
          canonicalKey: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        issueNumber: 12,
        readiness: {
          status: "ready" as const,
          reasons: [],
          edges: [],
          basis: "source" as const,
          overrides: [],
          complete: true,
          listedCount: 0,
          summaryTotal: 0,
          observedAt: "2026-10-25T00:00:00.000Z",
        },
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "readiness-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(allowed ? ["orchestration"] : ["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Relations.FactoryIssueRelations)({
          read: () =>
            Effect.sync(() => {
              called = true;
              return result;
            }),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_read_issue_readiness", {
          projectId: ProjectId.make("project"),
          issueNumber: 12,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      if (allowed) assert.deepEqual(outputs.at(-1)?.result, result);
      else assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
      assert.equal(called, allowed);
    }),
);

it.effect.each([
  {
    access: "read-only",
    capabilities: ["orchestration"],
    requestedRuntime: "approval-required",
    requestedInteraction: "default",
    code: "capability_denied",
  },
  {
    access: "approval-required",
    capabilities: ["orchestration"],
    requestedRuntime: "full-access",
    requestedInteraction: "default",
    code: "runtime_mode_escalation_denied",
  },
  {
    access: "full-access",
    capabilities: ["worktree"],
    requestedRuntime: "approval-required",
    requestedInteraction: "default",
    code: "capability_denied",
  },
  {
    access: "full-access",
    capabilities: ["orchestration"],
    requestedRuntime: "approval-required",
    requestedInteraction: "default",
    caller: { runtimeMode: "approval-required", interactionMode: "plan", active: true },
    code: "interaction_mode_escalation_denied",
  },
  {
    access: "full-access",
    capabilities: ["orchestration"],
    requestedRuntime: "approval-required",
    requestedInteraction: "default",
    caller: { runtimeMode: "approval-required", interactionMode: "default", active: false },
    code: "parent_not_active",
  },
] satisfies ReadonlyArray<{
  access: AuthMcpClientAccess;
  capabilities: ReadonlyArray<Context.McpCapability>;
  requestedRuntime: RuntimeMode;
  requestedInteraction: ProviderInteractionMode;
  caller?: {
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
    active: boolean;
  };
  code: OrchestratorMcpFailure["code"];
}>)(
  "denies orchestrator start with $code before reading or mutating its binding",
  ({ access, capabilities, requestedRuntime, requestedInteraction, caller, code }) =>
    Effect.gen(function* () {
      let called = false;
      const callerThreadId = ThreadId.make("caller");
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-orchestrator-denied",
          issuedAt: 0,
          thread:
            caller === undefined
              ? undefined
              : {
                  threadId: callerThreadId,
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  providerSessionId: "session",
                },
          client: caller === undefined ? { sessionId: "test", label: "test", access } : undefined,
          capabilities: new Set(capabilities),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              liveThreadShell(threadId, {
                runtimeMode: caller?.runtimeMode ?? "approval-required",
                interactionMode: caller?.interactionMode ?? "default",
                ...(caller?.active === false ? { activeRunId: null } : {}),
              }),
            ),
        }),
        Layer.mock(Factory.FactoryIssueService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({
          get: () => {
            called = true;
            return Effect.die("Unauthorized orchestrator start read a binding");
          },
          ensure: () => {
            called = true;
            return Effect.die("Unauthorized orchestrator start reached the service");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_start_orchestrator", {
          commandId: CommandId.make("orchestrator-denied"),
          projectId: ProjectId.make("project"),
          expectedThreadId: null,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: requestedRuntime,
          interactionMode: requestedInteraction,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code });
      assert.isFalse(called);
    }),
);

it.effect.each(["read-only", "full-access"] satisfies ReadonlyArray<AuthMcpClientAccess>)(
  "denies orchestrator read by a %s client without orchestration capability",
  (access) =>
    Effect.gen(function* () {
      let called = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-orchestrator-read-denied",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access },
          capabilities: new Set<Context.McpCapability>(["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Factory.FactoryIssueService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({
          get: () => {
            called = true;
            return Effect.die("Unauthorized orchestrator read reached the service");
          },
          ensure: () => {
            called = true;
            return Effect.die("An orchestrator read tried to start work");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_get_orchestrator", { projectId: ProjectId.make("project") })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
      assert.isFalse(called);
    }),
);

it.effect(
  "allows read-only orchestrator inspection without worktree authority or starting work",
  () =>
    Effect.gen(function* () {
      let starts = 0;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-orchestrator-inspect",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(["orchestration"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Factory.FactoryIssueService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({
          get: () => Effect.succeed({ coordinator: null, fetchedAt: "2026-10-24T00:00:00.000Z" }),
          ensure: () => {
            starts += 1;
            return Effect.die("Passive inspection tried to create or resume an orchestrator");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_get_orchestrator", { projectId: ProjectId.make("project") })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { coordinator: null });
      assert.equal(starts, 0);
    }),
);

it.effect(
  "allows root orientation without worktree authority, preserving service preflight denial",
  () =>
    Effect.gen(function* () {
      let admitted = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-orchestrator-root",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "approval-required" },
          capabilities: new Set<Context.McpCapability>(["orchestration"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Factory.FactoryIssueService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({
          ensure: () => {
            admitted = true;
            return Effect.fail(new ProjectCoordinatorError({ reason: "provider-unavailable" }));
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_start_orchestrator", {
          commandId: CommandId.make("orchestrator-root"),
          projectId: ProjectId.make("project"),
          expectedThreadId: null,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.isTrue(admitted);
      assert.deepInclude(outputs.at(-1)?.result, {
        code: "invalid_request",
        message: new ProjectCoordinatorError({ reason: "provider-unavailable" }).message,
      });
    }),
);

it.effect("denies replay of a stored broader launch before any launch or binding mutation", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project");
    const commandId = CommandId.make("reserved-request");
    const createdAt = "2026-10-24T00:00:00.000Z";
    const binding: Bindings.ProjectCoordinatorBinding = {
      intent: {
        projectId,
        workspaceRoot: "/projects/target",
        requestCommandId: commandId,
        commandId: CommandId.make("reserved-launch"),
        threadId: ThreadId.make("reserved-thread"),
        messageId: MessageId.make("reserved-message"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        prompt: "Read-only orientation, then wait.",
        createdBy: "user",
        creationSource: "web",
        createdAt,
        previousThreadId: null,
      },
      accepted: 0,
      superseded: 0,
    };
    let sideEffects = 0;
    const base = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(Context.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "factory-orchestrator-replay",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "test", label: "test", access: "approval-required" },
        capabilities: new Set<Context.McpCapability>(["orchestration"]),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(null),
      }),
      Layer.mock(Factory.FactoryIssueService)({}),
      Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Target",
            workspaceRoot: binding.intent.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
      }),
      Layer.mock(Receipts.CommandReceiptStoreV2)({
        getByCommandId: () => Effect.succeedNone,
      }),
      Layer.mock(Bindings.ProjectCoordinators)({
        getByRequest: () => Effect.succeedSome(binding),
        reserve: () => {
          sideEffects += 1;
          return Effect.die("A denied replay reserved another binding");
        },
        accept: () => {
          sideEffects += 1;
          return Effect.die("A denied replay accepted a launch");
        },
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: () => {
          sideEffects += 1;
          return Effect.die("A supervised caller resumed a stored full-access launch");
        },
      }),
    );
    const dependencies = Layer.merge(base, Coordinators.layer.pipe(Layer.provide(base)));
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const outputs = yield* toolkit
      .handle("factory_start_orchestrator", {
        commandId,
        projectId,
        expectedThreadId: binding.intent.threadId,
        modelSelection: binding.intent.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(outputs.at(-1)?.result, { code: "runtime_mode_escalation_denied" });
    assert.equal(sideEffects, 0);
  }),
);

it.effect("allows read-only feed review without worktree authority or fetching intake", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "feed-review",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "test", label: "test", access: "read-only" },
        capabilities: new Set<Context.McpCapability>(["orchestration"]),
      }),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Feeds.FactoryFeedService)({
        listCandidates: () =>
          Effect.succeed({
            repository: null,
            candidates: [],
            fetchedAt: "2026-10-24T00:00:00.000Z",
          }),
        readCandidate: () => Effect.fail(new FactoryFeedError({ reason: "missing-candidate" })),
        refreshSource: () => Effect.die("MCP cannot fetch intake"),
        admitCandidate: () => Effect.die("Passive review cannot admit work"),
      }),
    );
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const listed = yield* toolkit
      .handle("factory_list_feed_candidates", { projectId: ProjectId.make("project") })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(listed.at(-1)?.result, { candidates: [] });
    const read = yield* toolkit
      .handle("factory_read_feed_candidate", {
        projectId: ProjectId.make("project"),
        sourceId: FactoryFeedSourceId.make("feed"),
        itemKey: "atom:item",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(read.at(-1)?.result, {
      code: "invalid_request",
      message: new FactoryFeedError({ reason: "missing-candidate" }).message,
    });
  }),
);

it.effect(
  "feed admission carries MCP attribution and the caller's mode ceiling to the service",
  () =>
    Effect.gen(function* () {
      let called = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "feed-admit",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "approval-required" },
          capabilities: new Set<Context.McpCapability>(["orchestration", "worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Feeds.FactoryFeedService)({
          admitCandidate: (input) =>
            Effect.gen(function* () {
              called = true;
              assert.equal(input.creationSource, "mcp");
              assert.equal(input.runtimeMode, "approval-required");
              assert.isDefined(yield* DispatchModeLimit);
              return yield* new FactoryFeedError({ reason: "launch-authority" });
            }),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_admit_feed_candidate", {
          commandId: CommandId.make("admit"),
          projectId: ProjectId.make("project"),
          sourceId: FactoryFeedSourceId.make("feed"),
          itemKey: "atom:item",
          expectedRepositoryKey: "github.com/owner/repo",
          expectedRevision: "reviewed",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          creationSource: "web",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code: "runtime_mode_escalation_denied" });
      assert.isTrue(called);
    }),
);

it.effect.each([true, false])(
  "read-only frontier requires orchestration capability: %s",
  (allowed) =>
    Effect.gen(function* () {
      let called = false;
      const result = {
        repository: {
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          repository: "owner/repo",
          canonicalKey: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        parentIssueNumber: 2,
        parentTitle: "Factory map",
        complete: false,
        summaryTotal: 2,
        children: [],
        observedAt: "2026-10-25T00:00:00.000Z",
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "frontier-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(allowed ? ["orchestration"] : ["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Relations.FactoryIssueRelations)({
          readFrontier: () =>
            Effect.sync(() => {
              called = true;
              return result;
            }),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_read_issue_frontier", {
          projectId: ProjectId.make("project"),
          parentIssueNumber: 2,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      if (allowed) assert.deepEqual(outputs.at(-1)?.result, result);
      else assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
      assert.equal(called, allowed);
      assert.notInclude(Object.keys(FactoryToolkit.tools), "factory_set_issue_readiness_override");
      assert.notInclude(
        Object.keys(FactoryToolkit.tools),
        "factory_revoke_issue_readiness_override",
      );
    }),
);

it.effect(
  "research MCP refuses verify, propagates explore caller and mode ceiling, and records only caller evidence",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("research-caller");
      const calls: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "research",
          issuedAt: 0,
          thread: {
            threadId,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set<Context.McpCapability>(["orchestration", "worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(Research.FactoryResearchService)({
          listProtocols: () =>
            Effect.sync(() => {
              calls.push("list");
            }).pipe(
              Effect.andThen(Effect.fail(new FactoryResearchError({ reason: "missing-protocol" }))),
            ),
          readProtocol: () =>
            Effect.sync(() => {
              calls.push("read");
            }).pipe(
              Effect.andThen(Effect.fail(new FactoryResearchError({ reason: "missing-protocol" }))),
            ),
          launchRun: (input) =>
            Effect.gen(function* () {
              calls.push("explore");
              assert.equal(input.role, "explore");
              assert.equal(input.creationSource, "mcp");
              assert.equal(input.launchedByThreadId, threadId);
              assert.isDefined(yield* DispatchModeLimit);
              return yield* new FactoryResearchError({ reason: "budget-exhausted" });
            }),
          recordEvidence: (input, caller) =>
            Effect.sync(() => {
              calls.push("evidence");
              assert.equal(caller, threadId);
              assert.equal(input.threadId, ThreadId.make("other"));
            }).pipe(
              Effect.andThen(Effect.fail(new FactoryResearchError({ reason: "not-run-thread" }))),
            ),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const input = {
        commandId: CommandId.make("research"),
        projectId: ProjectId.make("project"),
        protocolId: FactoryResearchProtocolId.make("protocol"),
        expectedRepositoryKey: "github.com/owner/repo",
        expectedProtocolRevision: "revision",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
      };
      const verify = yield* toolkit
        .handle("factory_launch_research_run", { ...input, role: "verify" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(verify.at(-1)?.result, {
        code: "invalid_request",
        message: new FactoryResearchError({ reason: "verify-requires-user" }).message,
      });
      assert.isEmpty(calls);
      yield* toolkit
        .handle("factory_launch_research_run", { ...input, role: "explore", creationSource: "web" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      yield* toolkit
        .handle("factory_list_research_protocols", { projectId: input.projectId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      yield* toolkit
        .handle("factory_read_research_protocol", {
          projectId: input.projectId,
          protocolId: input.protocolId,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const evidence = yield* toolkit
        .handle("factory_record_research_evidence", {
          projectId: input.projectId,
          threadId: ThreadId.make("other"),
          commit: "C1",
          citations: [{ path: "run.log", line: 2 }],
          missing: [],
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(evidence.at(-1)?.result, {
        code: "invalid_request",
        message: new FactoryResearchError({ reason: "not-run-thread" }).message,
      });
      assert.deepEqual(calls, ["explore", "list", "read", "evidence"]);
      assert.notInclude(Object.keys(FactoryToolkit.tools), "factory_seal_research_protocol");
      assert.notInclude(Object.keys(FactoryToolkit.tools), "factory_admit_research_implementation");
    }),
);

it.effect("research explore launch refuses a client outside a thread before the service", () =>
  Effect.gen(function* () {
    let called = false;
    const dependencies = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "research-threadless",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "test", label: "test", access: "full-access" },
        capabilities: new Set<Context.McpCapability>(["orchestration", "worktree"]),
      }),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Research.FactoryResearchService)({
        launchRun: () => {
          called = true;
          return Effect.die("A threadless client launched research without a recorded launcher");
        },
      }),
    );
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const outputs = yield* toolkit
      .handle("factory_launch_research_run", {
        commandId: CommandId.make("research-threadless"),
        projectId: ProjectId.make("project"),
        protocolId: FactoryResearchProtocolId.make("protocol"),
        expectedRepositoryKey: "github.com/owner/repo",
        expectedProtocolRevision: "revision",
        role: "explore",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        runtimeMode: "approval-required",
        interactionMode: "default",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(outputs.at(-1)?.result, { code: "thread_credential_required" });
    assert.isFalse(called);
  }),
);

it.effect.each([true, false])(
  "read-only claim listing requires orchestration capability: %s",
  (allowed) =>
    Effect.gen(function* () {
      let called = false;
      let refused = false;
      const result = {
        environmentId: EnvironmentId.make("claim-owner"),
        repository: {
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          repository: "owner/repo",
          canonicalKey: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        claims: [],
        fetchedAt: "2026-10-25T00:00:00.000Z",
      };
      const input = { projectId: ProjectId.make("project") };
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "claims-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(allowed ? ["orchestration"] : ["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.succeed(Claims.FactoryClaimsService, {
          list: (received) => {
            called = true;
            assert.deepEqual(received, input);
            return refused
              ? Effect.fail(new FactoryIssueError({ reason: "missing-repository" }))
              : Effect.succeed(result);
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_list_claims", input)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.equal(called, allowed);
      if (allowed) {
        assert.deepEqual(outputs.at(-1)?.result, result);
        refused = true;
        const failure = yield* toolkit
          .handle("factory_list_claims", input)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        assert.deepInclude(failure.at(-1)?.result, { code: "invalid_request" });
      } else assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
    }),
);

it.effect(
  "artifact delivery is proposed and read for a read-only client, and no tool can grant it",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const projectId = ProjectId.make("project");
      const threadId = ThreadId.make("brief-thread");
      const repository = {
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        repository: "owner/repo",
        canonicalKey: "github.com/owner/repo",
        url: "https://github.com/owner/repo",
      };
      const body = "# Findings\n<!-- t3-factory-delivery acceptance=acceptance sha256=abc -->";
      const core = {
        threadId,
        projectId,
        acceptanceId: "acceptance",
        payloadDigest: "digest",
        grantedBy: EnvironmentId.make("person"),
        grantedAt: "2026-10-28T00:00:00.000Z",
        failure: null,
        updatedAt: "2026-10-28T00:00:01.000Z",
      };
      const artifactIntent = {
        ...core,
        id: "artifact-intent",
        originKey: FactoryOriginKey.make("knowledge:brief"),
        kind: "publish-artifact" as const,
        requestCommandId: "grant-artifact",
        status: "confirmed" as const,
        briefId: "brief",
        artifactPath: "deliverable.md",
        artifactSha256: "abc",
        artifactBytes: 10,
        repository,
        destinationKey: "comment:github:github.com/owner/repo#7",
        payload: { issueNumber: 7 },
        body,
        remote: { commentId: 6489487402, url: "https://github.com/owner/repo/issues/7#c" },
      };
      const commitIntent = {
        ...core,
        id: "commit-intent",
        originKey: FactoryOriginKey.make("github:github.com/owner/repo#3"),
        kind: "publish-pr" as const,
        requestCommandId: "grant-pr",
        status: "unknown" as const,
        repository,
        baseRef: "launch-snapshot",
        baseBranch: "main",
        baseSha: "base",
        headSha: "head",
        payload: { title: "Fix", body: "", draft: false },
        remote: null,
      };
      const prepared = {
        acceptance: {
          id: "acceptance",
          originKey: FactoryOriginKey.make("knowledge:brief"),
          briefId: "brief",
          threadId,
          projectId,
          artifactPath: "deliverable.md",
          sha256: "abc",
          bytes: 10,
          acceptedAt: "2026-10-27T00:00:00.000Z",
          acceptedBy: EnvironmentId.make("person"),
        },
        current: true,
        repository,
        destination: {
          number: 7,
          title: "Research question",
          state: "open" as const,
          url: "https://github.com/owner/repo/issues/7",
        },
        destinationKey: artifactIntent.destinationKey,
        attempt: "11111111-1111-4111-8111-111111111111",
        artifactSha256: "abc",
        artifactBytes: 10,
        body,
        payload: artifactIntent.payload,
        payloadDigest: "digest",
        existing: null,
      };
      const prepareInput = {
        projectId,
        threadId,
        kind: "publish-artifact" as const,
        payload: artifactIntent.payload,
      };
      let refusal: FactoryDeliveryError | null = null;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "delivery-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(["orchestration"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        // `grant` and `reconcile` are left unimplemented: reaching either from MCP dies the test.
        Layer.mock(Delivery.FactoryDeliveryService)({
          prepare: (received) => {
            calls.push("prepare");
            assert.deepEqual(received, prepareInput);
            return refusal === null ? Effect.succeed(prepared) : Effect.fail(refusal);
          },
          read: (received) => {
            calls.push("read");
            assert.deepEqual(received, { projectId, threadId });
            return Effect.succeed({ intents: [artifactIntent, commitIntent] });
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const proposed = yield* toolkit
        .handle("factory_prepare_delivery", prepareInput)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepEqual(proposed.at(-1)?.result, prepared);
      const read = yield* toolkit
        .handle("factory_read_deliveries", { projectId, threadId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepEqual(read.at(-1)?.result, { intents: [artifactIntent, commitIntent] });
      refusal = new FactoryDeliveryError({ reason: "destination-not-found" });
      const refused = yield* toolkit
        .handle("factory_prepare_delivery", prepareInput)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(refused.at(-1)?.result, {
        code: "invalid_request",
        message: refusal.message,
      });
      assert.deepEqual(calls, ["prepare", "read", "prepare"]);
      assert.deepEqual(
        Object.keys(FactoryToolkit.tools).filter((name) => /grant|reconcile/.test(name)),
        [],
      );
    }),
);
