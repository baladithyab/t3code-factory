import {
  CommandId,
  EnvironmentId,
  ProjectId,
  FactoryAcceptanceError,
  FactoryFeedError,
  FactoryKnowledgeError,
  FactoryResearchError,
  FactoryResearchProtocolId,
  FactoryIssueError,
  FactoryReadinessOverrideId,
  FactoryFeedSourceId,
  type EnvironmentAuthorizationError,
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  SecretProviderId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers or secret providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("factory authorization", () => {
  const tested = [WS_METHODS.factoryListIssues, WS_METHODS.factoryStartIssue] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const input = {
    commandId: CommandId.make("factory-auth"),
    projectId: ProjectId.make("project"),
    expectedRepositoryKey: "github.com/owner/repo",
    expectedIssueRevision: "0".repeat(64),
    issueNumber: 1,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthOrchestrationOperateScope },
    { scopes: [AuthOrchestrationOperateScope], missing: AuthSourceControlWriteScope },
    { scopes: [AuthSourceControlWriteScope], missing: AuthOrchestrationOperateScope },
  ])("denies issue launch without $missing before invoking the service", ({ scopes, missing }) =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.factoryListIssues, () => Effect.never),
            group.toLayerHandler(WS_METHODS.factoryStartIssue, () =>
              Effect.sync(() => {
                handled = true;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      expect(yield* client[WS_METHODS.factoryStartIssue](input).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
  it.effect("allows read-only issue intake but never starts work", () =>
    Effect.gen(function* () {
      const result = {
        repository: {
          provider: "github" as const,
          host: "github.com",
          repository: "owner/repo",
          canonicalKey: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        issues: [],
        nextPage: null,
        fetchedAt: "2026-10-23T00:00:00.000Z",
      };
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.factoryListIssues, () => Effect.succeed(result)),
            group.toLayerHandler(WS_METHODS.factoryStartIssue, () =>
              Effect.die("read-only launch reached handler"),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      expect(yield* client[WS_METHODS.factoryListIssues]({ projectId: input.projectId })).toEqual(
        result,
      );
    }).pipe(Effect.scoped),
  );
});

describe("factory readiness authorization", () => {
  const method = WS_METHODS.factoryReadIssueReadiness;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
    ),
  );
  it.effect.each([
    { scopes: [], allowed: false },
    { scopes: [AuthOrchestrationReadScope], allowed: true },
  ])("requires only orchestration read scope: $allowed", ({ scopes, allowed }) =>
    Effect.gen(function* () {
      let called = false;
      const result = {
        repository: {
          provider: "github" as const,
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
          complete: true,
          basis: "source" as const,
          overrides: [],
          listedCount: 0,
          summaryTotal: 0,
          observedAt: "2026-10-25T00:00:00.000Z",
        },
      };
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, () =>
              Effect.sync(() => {
                called = true;
                return result;
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      const request = client[method]({ projectId: ProjectId.make("project"), issueNumber: 12 });
      if (allowed) expect(yield* request).toEqual(result);
      else
        expect(yield* request.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationReadScope,
        });
      expect(called).toBe(allowed);
    }).pipe(Effect.scoped),
  );
});

describe("feed factory authorization", () => {
  const cases = [
    { method: WS_METHODS.factoryListFeedSources, scopes: [AuthOrchestrationReadScope] },
    { method: WS_METHODS.factoryListFeedCandidates, scopes: [AuthOrchestrationReadScope] },
    { method: WS_METHODS.factoryReadFeedCandidate, scopes: [AuthOrchestrationReadScope] },
    { method: WS_METHODS.factoryBindFeedSource, scopes: [AuthSettingsWriteScope] },
    { method: WS_METHODS.factoryUnbindFeedSource, scopes: [AuthSettingsWriteScope] },
    { method: WS_METHODS.factoryRefreshFeedSource, scopes: [AuthOrchestrationOperateScope] },
    {
      method: WS_METHODS.factorySetFeedCandidateDismissed,
      scopes: [AuthOrchestrationOperateScope],
    },
    {
      method: WS_METHODS.factoryAdmitFeedCandidate,
      scopes: [AuthOrchestrationOperateScope, AuthSourceControlWriteScope],
    },
  ] as const;
  const input = {
    commandId: CommandId.make("feed-auth"),
    projectId: ProjectId.make("project"),
    sourceId: FactoryFeedSourceId.make("feed"),
    itemKey: "atom:item",
    url: "https://news.example.org/feed",
    expectedRevision: "reviewed",
    dismissed: true,
    expectedRepositoryKey: "github.com/owner/repo",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  const tested = cases.map(({ method }) => method);
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const handlers = group.toLayer({
    [WS_METHODS.factoryListFeedSources]: () =>
      Effect.fail(new FactoryFeedError({ reason: "missing-project" })),
    [WS_METHODS.factoryListFeedCandidates]: () =>
      Effect.fail(new FactoryFeedError({ reason: "missing-project" })),
    [WS_METHODS.factoryReadFeedCandidate]: () =>
      Effect.fail(new FactoryFeedError({ reason: "missing-project" })),
    [WS_METHODS.factoryBindFeedSource]: () =>
      Effect.fail(new FactoryFeedError({ reason: "missing-project" })),
    [WS_METHODS.factoryUnbindFeedSource]: () =>
      Effect.fail(new FactoryFeedError({ reason: "missing-project" })),
    [WS_METHODS.factoryRefreshFeedSource]: () =>
      Effect.fail(new FactoryFeedError({ reason: "missing-project" })),
    [WS_METHODS.factorySetFeedCandidateDismissed]: () =>
      Effect.fail(new FactoryFeedError({ reason: "missing-project" })),
    [WS_METHODS.factoryAdmitFeedCandidate]: () =>
      Effect.fail(new FactoryFeedError({ reason: "missing-project" })),
  });
  it.effect.each(cases)(
    "requires every declared scope for $method before calling the service",
    ({ method, scopes }) =>
      Effect.gen(function* () {
        for (const missing of scopes) {
          const client = yield* RpcTest.makeClient(group).pipe(
            Effect.provide(
              Layer.merge(
                handlers,
                RpcAuthorization.layer(scopes.filter((scope) => scope !== missing)),
              ),
            ),
          );
          const request: Effect.Effect<unknown, FactoryFeedError | EnvironmentAuthorizationError> =
            client[method](input);
          expect(yield* request.pipe(Effect.asVoid, Effect.flip)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: missing,
          });
        }
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(Layer.merge(handlers, RpcAuthorization.layer(scopes))),
        );
        const request: Effect.Effect<unknown, FactoryFeedError | EnvironmentAuthorizationError> =
          client[method](input);
        expect(yield* request.pipe(Effect.asVoid, Effect.flip)).toMatchObject({
          _tag: "FactoryFeedError",
          reason: "missing-project",
        });
      }).pipe(Effect.scoped),
  );
});

describe("knowledge factory authorization", () => {
  const cases = [
    { method: WS_METHODS.factoryListKnowledgeBriefs, scopes: [AuthOrchestrationReadScope] },
    { method: WS_METHODS.factoryReadKnowledgeTask, scopes: [AuthOrchestrationReadScope] },
    { method: WS_METHODS.factoryCreateKnowledgeBrief, scopes: [AuthOrchestrationOperateScope] },
    { method: WS_METHODS.factoryStartKnowledgeTask, scopes: [AuthOrchestrationOperateScope] },
    { method: WS_METHODS.factoryAcceptKnowledgeArtifact, scopes: [AuthOrchestrationOperateScope] },
  ] as const;
  const input = {
    commandId: CommandId.make("knowledge-auth"),
    projectId: ProjectId.make("project"),
    briefId: "brief:one",
    expectedRevision: "reviewed",
    expectedSha256: "a".repeat(64),
    title: "Survey",
    question: "What changed?",
    inputs: [],
    acceptanceCriteria: "",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  };
  const tested = cases.map(({ method }) => method);
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const refused = () => Effect.fail(new FactoryKnowledgeError({ reason: "unknown-brief" }));
  const handlers = group.toLayer({
    [WS_METHODS.factoryListKnowledgeBriefs]: refused,
    [WS_METHODS.factoryReadKnowledgeTask]: refused,
    [WS_METHODS.factoryCreateKnowledgeBrief]: refused,
    [WS_METHODS.factoryStartKnowledgeTask]: refused,
    [WS_METHODS.factoryAcceptKnowledgeArtifact]: refused,
  });
  it.effect.each(cases)(
    "requires every declared scope for $method before calling the service",
    ({ method, scopes }) =>
      Effect.gen(function* () {
        for (const missing of scopes) {
          const client = yield* RpcTest.makeClient(group).pipe(
            Effect.provide(
              Layer.merge(
                handlers,
                RpcAuthorization.layer(scopes.filter((scope) => scope !== missing)),
              ),
            ),
          );
          const request: Effect.Effect<
            unknown,
            FactoryKnowledgeError | EnvironmentAuthorizationError
          > = client[method](input);
          expect(yield* request.pipe(Effect.asVoid, Effect.flip)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: missing,
          });
        }
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(Layer.merge(handlers, RpcAuthorization.layer(scopes))),
        );
        const request: Effect.Effect<
          unknown,
          FactoryKnowledgeError | EnvironmentAuthorizationError
        > = client[method](input);
        expect(yield* request.pipe(Effect.asVoid, Effect.flip)).toMatchObject({
          _tag: "FactoryKnowledgeError",
          reason: "unknown-brief",
        });
      }).pipe(Effect.scoped),
  );
});

describe("project coordinator authorization", () => {
  const tested = [
    WS_METHODS.projectCoordinatorsGet,
    WS_METHODS.projectCoordinatorsList,
    WS_METHODS.projectCoordinatorsEnsure,
    WS_METHODS.factoryStartIssue,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const input = {
    commandId: CommandId.make("coordinator-auth"),
    projectId: ProjectId.make("project"),
    expectedThreadId: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  const coordinator = {
    projectId: input.projectId,
    threadId: ThreadId.make("coordinator"),
    status: "idle" as const,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: "2026-10-24T00:00:00.000Z",
    current: true,
  };
  const fetchedAt = "2026-10-24T00:00:00.000Z";
  const makeClient = (scopes: ReadonlyArray<AuthEnvironmentScope>, handled: Array<string>) =>
    RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.projectCoordinatorsGet, () =>
            Effect.sync(() => {
              handled.push("get");
              return { coordinator, fetchedAt };
            }),
          ),
          group.toLayerHandler(WS_METHODS.projectCoordinatorsList, () =>
            Effect.sync(() => {
              handled.push("list");
              return { coordinators: [coordinator], fetchedAt };
            }),
          ),
          group.toLayerHandler(WS_METHODS.projectCoordinatorsEnsure, () =>
            Effect.sync(() => {
              handled.push("ensure");
              return { coordinator, resumed: false };
            }),
          ),
          group.toLayerHandler(WS_METHODS.factoryStartIssue, () =>
            Effect.die("issue launch must retain its additional source-control grant"),
          ),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );

  it.effect.each([
    { scopes: [] },
    { scopes: [AuthOrchestrationReadScope] },
    { scopes: [AuthSourceControlWriteScope] },
    { scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope] },
  ])("denies coordinator creation with $scopes before any handler side effect", ({ scopes }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(scopes, handled);
      expect(
        yield* client[WS_METHODS.projectCoordinatorsEnsure](input).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("permits read-only get and list without creating a coordinator", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient([AuthOrchestrationReadScope], handled);
      expect(
        yield* client[WS_METHODS.projectCoordinatorsGet]({ projectId: input.projectId }),
      ).toEqual({ coordinator, fetchedAt });
      expect(yield* client[WS_METHODS.projectCoordinatorsList]({})).toEqual({
        coordinators: [coordinator],
        fetchedAt,
      });
      expect(
        yield* client[WS_METHODS.projectCoordinatorsEnsure](input).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
      expect(handled).toEqual(["get", "list"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { scopes: [] },
    { scopes: [AuthSourceControlWriteScope] },
    { scopes: [AuthOrchestrationOperateScope] },
  ])("denies coordinator reads with $scopes before invoking handlers", ({ scopes }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(scopes, handled);
      expect(
        yield* client[WS_METHODS.projectCoordinatorsGet]({
          projectId: input.projectId,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
      expect(yield* client[WS_METHODS.projectCoordinatorsList]({}).pipe(Effect.flip)).toMatchObject(
        { requiredPermission: AuthOrchestrationReadScope },
      );
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "allows operate-only root orientation without granting reads or issue worktree starts",
    () =>
      Effect.gen(function* () {
        const handled: Array<string> = [];
        const client = yield* makeClient([AuthOrchestrationOperateScope], handled);
        expect(yield* client[WS_METHODS.projectCoordinatorsEnsure](input)).toEqual({
          coordinator,
          resumed: false,
        });
        expect(
          yield* client[WS_METHODS.projectCoordinatorsGet]({
            projectId: input.projectId,
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
        expect(
          yield* client[WS_METHODS.factoryStartIssue]({
            commandId: CommandId.make("issue-after-coordinator"),
            projectId: input.projectId,
            expectedRepositoryKey: "github.com/owner/repo",
            expectedIssueRevision: "0".repeat(64),
            issueNumber: 1,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthSourceControlWriteScope });
        expect(handled).toEqual(["ensure"]);
      }).pipe(Effect.scoped),
  );
});

describe("readiness override and frontier authorization", () => {
  const cases = [
    { method: WS_METHODS.factorySetIssueReadinessOverride, scope: AuthOrchestrationOperateScope },
    {
      method: WS_METHODS.factoryRevokeIssueReadinessOverride,
      scope: AuthOrchestrationOperateScope,
    },
    { method: WS_METHODS.factoryReadIssueFrontier, scope: AuthOrchestrationReadScope },
  ] as const;
  const methods = new Set<string>(cases.map(({ method }) => method));
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof cases)[number]["method"]> =>
        !methods.has(tag),
    ),
  );
  const input = {
    projectId: ProjectId.make("project"),
    issueNumber: 12,
    parentIssueNumber: 2,
    commandId: CommandId.make("override-auth"),
    targetHost: "github.com",
    targetId: 70,
    expectedFingerprint: "observed",
    kind: "waive" as const,
    reason: "Deleted blocker.",
    overrideId: FactoryReadinessOverrideId.make("override"),
  };
  it.effect.each(cases)("guards $method before service execution", ({ method, scope }) =>
    Effect.gen(function* () {
      for (const scopes of [[], [AuthOrchestrationReadScope], [AuthOrchestrationOperateScope]]) {
        let calls = 0;
        const fail = () =>
          Effect.sync(() => {
            calls++;
          }).pipe(
            Effect.andThen(Effect.fail(new FactoryIssueError({ reason: "missing-project" }))),
          );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              group.toLayer({
                [WS_METHODS.factorySetIssueReadinessOverride]: fail,
                [WS_METHODS.factoryRevokeIssueReadinessOverride]: fail,
                [WS_METHODS.factoryReadIssueFrontier]: fail,
              }),
              RpcAuthorization.layer(scopes),
            ),
          ),
        );
        const request: Effect.Effect<unknown, FactoryIssueError | EnvironmentAuthorizationError> =
          client[method](input);
        const result = yield* request.pipe(Effect.asVoid, Effect.flip);
        const allowed = scopes.some((granted) => granted === scope);
        expect(result._tag).toBe(allowed ? "FactoryIssueError" : "EnvironmentAuthorizationError");
        expect(calls).toBe(allowed ? 1 : 0);
      }
    }).pipe(Effect.scoped),
  );
});

describe("research factory authorization", () => {
  const cases = [
    { method: WS_METHODS.factoryListResearchProtocols, scopes: [AuthOrchestrationReadScope] },
    { method: WS_METHODS.factoryReadResearchProtocol, scopes: [AuthOrchestrationReadScope] },
    { method: WS_METHODS.factorySealResearchProtocol, scopes: [AuthOrchestrationOperateScope] },
    {
      method: WS_METHODS.factoryLaunchResearchRun,
      scopes: [AuthOrchestrationOperateScope, AuthSourceControlWriteScope],
    },
    {
      method: WS_METHODS.factoryAdmitResearchImplementation,
      scopes: [AuthOrchestrationOperateScope, AuthSourceControlWriteScope],
    },
  ] as const;
  const input = {
    commandId: CommandId.make("research-auth"),
    projectId: ProjectId.make("project"),
    protocolId: FactoryResearchProtocolId.make("protocol"),
    expectedRepositoryKey: "github.com/owner/repo",
    expectedProtocolRevision: "protocol-revision",
    expectedFindingRevision: "finding-revision",
    hypothesis: "Lower loss",
    runCommand: "python train.py",
    evaluatorPaths: ["prepare.py"],
    metric: { name: "loss", linePrefix: "loss:", direction: "lower" as const, minimumEffect: 0.01 },
    budget: { maxRuns: 3, maxRunMinutes: 5, expiresAt: "2099-01-01T00:00:00.000Z" },
    role: "explore" as const,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  const tested = cases.map(({ method }) => method);
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const handlers = group.toLayer({
    [WS_METHODS.factoryListResearchProtocols]: () =>
      Effect.fail(new FactoryResearchError({ reason: "missing-project" })),
    [WS_METHODS.factoryReadResearchProtocol]: () =>
      Effect.fail(new FactoryResearchError({ reason: "missing-project" })),
    [WS_METHODS.factorySealResearchProtocol]: () =>
      Effect.fail(new FactoryResearchError({ reason: "missing-project" })),
    [WS_METHODS.factoryLaunchResearchRun]: () =>
      Effect.fail(new FactoryResearchError({ reason: "missing-project" })),
    [WS_METHODS.factoryAdmitResearchImplementation]: () =>
      Effect.fail(new FactoryResearchError({ reason: "missing-project" })),
  });
  it.effect.each(cases)("requires every research scope for $method", ({ method, scopes }) =>
    Effect.gen(function* () {
      for (const missing of scopes) {
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handlers,
              RpcAuthorization.layer(scopes.filter((scope) => scope !== missing)),
            ),
          ),
        );
        const request: Effect.Effect<
          unknown,
          FactoryResearchError | EnvironmentAuthorizationError
        > = client[method](input);
        expect(yield* request.pipe(Effect.asVoid, Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: missing,
        });
      }
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer(scopes))),
      );
      const request: Effect.Effect<unknown, FactoryResearchError | EnvironmentAuthorizationError> =
        client[method](input);
      expect(yield* request.pipe(Effect.asVoid, Effect.flip)).toMatchObject({
        _tag: "FactoryResearchError",
        reason: "missing-project",
      });
    }).pipe(Effect.scoped),
  );
});

describe("factory claims authorization", () => {
  const method = WS_METHODS.factoryListClaims;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
    ),
  );
  it.effect.each([
    { scopes: [], allowed: false },
    { scopes: [AuthOrchestrationReadScope], allowed: true },
  ])("requires only orchestration read scope: $allowed", ({ scopes, allowed }) =>
    Effect.gen(function* () {
      let called = false;
      const result = {
        environmentId: EnvironmentId.make("owner"),
        repository: {
          provider: "github" as const,
          host: "github.com",
          repository: "owner/repo",
          canonicalKey: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        claims: [],
        fetchedAt: "2026-10-25T00:00:00.000Z",
      };
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, () =>
              Effect.sync(() => {
                called = true;
                return result;
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      const request = client[method]({ projectId: ProjectId.make("project") });
      if (allowed) expect(yield* request).toEqual(result);
      else
        expect(yield* request.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationReadScope,
        });
      expect(called).toBe(allowed);
    }).pipe(Effect.scoped),
  );
});

describe("factory acceptance authorization", () => {
  const cases = [
    { method: WS_METHODS.factoryReadAcceptance, scopes: [AuthOrchestrationReadScope] },
    {
      method: WS_METHODS.factoryAcceptCommit,
      scopes: [AuthOrchestrationOperateScope, AuthSourceControlWriteScope],
    },
  ] as const;
  const input = {
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("thread"),
    expectedHeadSha: "c".repeat(40),
    evidenceRefs: [],
  };
  const tested = cases.map(({ method }) => method);
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const fail = () => Effect.fail(new FactoryAcceptanceError({ reason: "unknown-thread" }));
  const handlers = group.toLayer({
    [WS_METHODS.factoryReadAcceptance]: fail,
    [WS_METHODS.factoryAcceptCommit]: fail,
  });
  it.effect.each(cases)("requires every acceptance scope for $method", ({ method, scopes }) =>
    Effect.gen(function* () {
      for (const missing of scopes) {
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handlers,
              RpcAuthorization.layer(scopes.filter((scope) => scope !== missing)),
            ),
          ),
        );
        const request: Effect.Effect<
          unknown,
          FactoryAcceptanceError | EnvironmentAuthorizationError
        > = client[method](input);
        expect(yield* request.pipe(Effect.asVoid, Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: missing,
        });
      }
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer(scopes))),
      );
      const request: Effect.Effect<
        unknown,
        FactoryAcceptanceError | EnvironmentAuthorizationError
      > = client[method](input);
      expect(yield* request.pipe(Effect.asVoid, Effect.flip)).toMatchObject({
        _tag: "FactoryAcceptanceError",
        reason: "unknown-thread",
      });
    }).pipe(Effect.scoped),
  );
});
