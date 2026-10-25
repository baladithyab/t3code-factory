import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectCoordinatorError,
  ProviderInstanceId,
  ThreadId,
  type AuthMcpClientAccess,
  type OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Factory from "../../../factory/FactoryIssueService.ts";
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
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Target",
              workspaceRoot: binding.intent.workspaceRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt,
              updatedAt: createdAt,
              deletedAt: null,
            }),
          ),
      }),
      Layer.mock(Receipts.CommandReceiptStoreV2)({
        getByCommandId: () => Effect.succeed(Option.none()),
      }),
      Layer.mock(Bindings.ProjectCoordinators)({
        getByRequest: () => Effect.succeed(Option.some(binding)),
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
