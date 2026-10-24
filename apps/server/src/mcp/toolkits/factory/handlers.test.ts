import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AuthMcpClientAccess,
  type OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Factory from "../../../factory/FactoryIssueService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
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
