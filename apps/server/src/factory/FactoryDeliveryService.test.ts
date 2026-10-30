import { assert, it } from "@effect/vitest";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  SourceControlProviderError,
  SourceControlProviderKind,
  ThreadId,
  type FactoryDeliveryPublishPayload,
  type FactoryArtifactDeliveryGrantInput,
  type PullRequestActionInput,
  type PullRequestDetail,
  type ChangeRequest,
} from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  IssueTrackerProviderError,
  type TrackerIssueComment,
} from "@t3tools/source-control-core/server/IssueTrackerProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture digests independently check the bytes the service pins.
import * as NodeCrypto from "node:crypto";
import * as ServerConfig from "../config.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as GitManager from "../git/GitManager.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as AcceptanceStore from "../persistence/FactoryAcceptanceStore.ts";
import * as DeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import * as KnowledgeStore from "../persistence/FactoryKnowledgeStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import { type FactoryLaunchIntent } from "../persistence/FactoryIssueLaunches.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Acceptance from "./FactoryAcceptanceService.ts";
import * as Delivery from "./FactoryDeliveryService.ts";
import * as Knowledge from "./FactoryKnowledgeService.ts";
import { renderArtifactComment, artifactDeliveryMarker } from "./FactoryArtifactDeliveryBody.ts";
import { issueOriginKey, knowledgeBriefOriginKey } from "./FactoryOriginKey.ts";
import { fakeIssueTracker, issueTrackersLayer } from "./IssueTrackerProviderRegistry.testkit.ts";

const at = "2026-10-27T00:00:00.000Z";
const environmentId = EnvironmentId.make("claim-holder");
const projectId = ProjectId.make("project");
const claimed = ThreadId.make("claimed");
const unclaimed = ThreadId.make("unclaimed");
const first = "1".repeat(40);
const second = "2".repeat(40);
const base = "b".repeat(40);
const payload: FactoryDeliveryPublishPayload = {
  title: "Fix the thing",
  body: "Details",
  draft: false,
};
const pullRequest = { number: 12, url: "https://github.com/owner/repo/pull/12" };
const publishedChangeRequest = (overrides: Partial<ChangeRequest> = {}): ChangeRequest => ({
  ...pullRequest,
  provider: SourceControlProviderKind.make("github"),
  title: payload.title,
  baseRefName: "main",
  headRefName: "feature",
  headSha: first,
  state: "open",
  updatedAt: Option.none(),
  ...overrides,
});

const intent: FactoryLaunchIntent = {
  repository: {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: "github.com/owner/repo",
    url: "https://github.com/owner/repo",
  },
  issue: {
    number: 7,
    title: "Task",
    body: null,
    state: "open",
    url: "https://github.com/owner/repo/issues/7",
    labels: [],
    updatedAt: at,
    task: null,
  },
  projectId,
  workspaceRoot: "/repo",
  requestCommandId: CommandId.make("request"),
  commandId: CommandId.make("command"),
  threadId: claimed,
  messageId: MessageId.make("message"),
  baseRef: base,
  baseBranch: "main",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  prompt: "Frozen snapshot",
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  previousThreadId: null,
};

const unsupported = (operation: string) =>
  Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
    never,
    SourceControlProviderError
  >;

const harness = (
  options: {
    readonly seedSending?: boolean;
    readonly trackers?: Parameters<typeof issueTrackersLayer>[0];
    readonly artifactFolder?: string;
    readonly seedArtifactSending?: boolean;
  } = {},
) => {
  const state = {
    head: first,
    origin: "https://github.com/owner/repo.git",
    artifactFolder: options.artifactFolder ?? "/artifact-worktree",
    open: Option.none<typeof pullRequest>(),
    push: "ok" as "ok" | "fail",
    create: "ok" as "ok" | "definite" | "ambiguous",
    calls: [] as string[],
    links: [] as unknown[],
    // The host's view of the published pull request, which a test moves to simulate a push, a
    // conflict or a merge made elsewhere.
    pr: {
      baseBranch: "main",
      headSha: first as string | undefined,
      state: "open" as "open" | "closed" | "merged",
      mergeability: "mergeable" as "mergeable" | "conflicting" | "unknown",
      isDraft: false,
      checks: [
        ...Array.from({ length: 3 }, () => "success"),
        "failure",
        "pending",
        "skipped",
      ] as ReadonlyArray<string>,
    },
    read: "ok" as "ok" | "fail",
    merge: "ok" as "ok" | "definite" | "ambiguous",
    mergeCalls: [] as PullRequestActionInput[],
    invalidations: 0,
    // Every pull request read, cached or fresh: a refused delivery must not reach the host.
    reads: 0,
    headLookups: 0,
    beforeHeadLookup: Effect.void as Effect.Effect<void>,
    publications: null as ReadonlyArray<ChangeRequest> | null,
    publicationRead: "ok" as "ok" | "fail",
    publicationLookups: [] as Parameters<
      SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"]
    >[0][],
    providerDestinationMatches: true,
  };
  const providerFailure = (cwd: string, cause: unknown) =>
    new SourceControlProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation: "createChangeRequest",
      cwd,
      detail: "forge answered",
      cause,
    });
  const provider: SourceControlProvider.SourceControlProvider["Service"] = {
    kind: SourceControlProviderKind.make("github"),
    createsChangeRequestsIn: () => Effect.succeed(state.providerDestinationMatches),
    listChangeRequests: (input) => {
      state.publicationLookups.push(input);
      return state.publicationRead === "fail"
        ? Effect.fail(providerFailure(input.cwd, { _tag: "GitHubApiRequestError" }))
        : Effect.succeed(
            state.publications ?? (Option.isSome(state.open) ? [publishedChangeRequest()] : []),
          );
    },
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: (input) => {
      assert.deepEqual(input.target, { owner: "owner", repository: "repo", refName: "main" });
      assert.equal(input.context?.provider.baseUrl, "https://github.com");
      state.calls.push(`create:${input.baseRefName}:${input.headSelector}:${input.title}`);
      if (state.create === "definite")
        return Effect.fail(
          providerFailure(input.cwd, { _tag: "GitHubApiResponseError", status: 422 }),
        );
      if (state.create === "ambiguous")
        return Effect.fail(providerFailure(input.cwd, { _tag: "GitHubApiRequestError" }));
      state.open = Option.some(pullRequest);
      return Effect.void;
    },
    getRepositoryCloneUrls: () => unsupported("getRepositoryCloneUrls"),
    createRepository: () => unsupported("createRepository"),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
  };
  const git = Layer.mock(Git.GitVcsDriver)({
    execute: ({ args }) => {
      const revision = args[2];
      const stdout =
        args[0] === "remote"
          ? state.origin
          : revision === "HEAD^{commit}"
            ? state.head
            : revision === `${base}^{commit}`
              ? base
              : null;
      if (stdout === null) return Effect.die(`Unexpected git arguments: ${JSON.stringify(args)}`);
      return Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: `${stdout}\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
    pushCurrentBranch: (cwd) => {
      state.calls.push("push");
      return state.push === "ok"
        ? Effect.succeed({ status: "pushed" as const, branch: "feature" })
        : Effect.fail(
            new GitCommandError({
              operation: "push",
              command: "git push",
              cwd,
              detail: "remote rejected",
            }),
          );
    },
  });
  const mergeFailure = (cause: unknown) =>
    new PullRequestOperationError({ operation: "runAction", detail: "host answered", cause });
  const pullRequests = Layer.mock(PullRequests.PullRequestService)({
    invalidate: () => {
      state.invalidations += 1;
      return Effect.void;
    },
    // Only the fields the delivery service reads; the rest of a detail is not its business.
    detail: (ref) => {
      state.reads += 1;
      return state.read === "fail"
        ? Effect.fail(
            new PullRequestOperationError({ operation: "detail", detail: "host unreachable" }),
          )
        : Effect.succeed({
            number: ref.number,
            url: `https://github.com/owner/repo/pull/${ref.number}`,
            state: state.pr.state,
            isDraft: state.pr.isDraft,
            baseBranch: state.pr.baseBranch,
            mergeability: state.pr.mergeability,
            ...(state.pr.headSha === undefined ? {} : { headSha: state.pr.headSha }),
            checks: state.pr.checks.map((status, index) => ({
              name: `check-${index}`,
              status,
              description: null,
              url: null,
            })),
            capabilities: { mergeMethods: ["merge", "squash"] },
          } as unknown as PullRequestDetail);
    },
    runAction: (input) => {
      state.mergeCalls.push(input);
      if (state.merge === "definite")
        return Effect.fail(
          mergeFailure({
            _tag: "PullRequestProviderError",
            reason: "failed",
            cause: { _tag: "GitHubApiResponseError", status: 409 },
          }),
        );
      if (state.merge === "ambiguous")
        return Effect.fail(
          mergeFailure({
            _tag: "PullRequestProviderError",
            reason: "failed",
            cause: { _tag: "GitHubApiRequestError" },
          }),
        );
      return Effect.void;
    },
  });
  const dependencies = Layer.mergeAll(
    pullRequests,
    Sqlite.layerMemory,
    git,
    NodePlatformCrypto.layer,
    NodeServices.layer,
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    issueTrackersLayer(options.trackers),
    ServerConfig.layerTest("/repo", "/delivery-test-home").pipe(Layer.provide(NodeServices.layer)),
    Layer.mock(Folders.ManagedProjectFolders)({
      namedProjectsRoot: "/delivery-test-home/projects",
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(Receipts.CommandReceiptStoreV2)({
      getByCommandId: () => Effect.succeedNone,
    }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                title: "Project",
                workspaceRoot: "/repo",
                defaultModelSelection: null,
                scripts: [],
                createdAt: at,
                updatedAt: at,
                deletedAt: null,
              })
            : Option.none(),
        ),
    }),
    Layer.mock(Identities.RepositoryIdentityResolver)({
      resolve: () =>
        Effect.succeed({
          canonicalKey: "github.com/owner/repo",
          provider: SourceControlProviderKind.make("github"),
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: state.origin },
        }),
      resolveRemote: () =>
        Effect.succeed({
          canonicalKey: state.origin.replace("https://", "").replace(/\.git$/, ""),
          provider: SourceControlProviderKind.make("github"),
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: state.origin },
        }),
    }),
    Layer.mock(GitManager.GitManager)({
      findOpenPullRequestForHead: () =>
        Effect.gen(function* () {
          state.headLookups += 1;
          yield* state.beforeHeadLookup;
          return { headSelector: "feature", open: state.open };
        }),
      invalidateStatus: () => Effect.void,
    }),
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
      resolve: () => Effect.succeed(provider),
      resolveHandle: ({ context }) => Effect.succeed({ provider, context: context ?? null }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          ...liveThreadShell(id),
          projectId,
          worktreePath:
            id === artifactThread ? state.artifactFolder : id === unclaimed ? null : "/worktree",
        }),
      dispatch: (command) => {
        state.links.push(command);
        return Effect.succeed({ sequence: 1, storedEvents: [] });
      },
    }),
  );
  const stores = Layer.mergeAll(
    DeliveryStore.layer,
    AcceptanceStore.layer,
    EffectOutbox.layer,
    KnowledgeStore.layer,
    Knowledge.layer.pipe(Layer.provide(KnowledgeStore.layer)),
    Acceptance.layer.pipe(Layer.provide(AcceptanceStore.layer)),
  ).pipe(Layer.provideMerge(dependencies));
  // Seeded after the stores exist and before the service is built, the order startup recovery
  // relies on.
  const seed = Layer.effectDiscard(
    Effect.gen(function* () {
      if (options.seedArtifactSending === true) {
        const store = yield* DeliveryStore.FactoryDeliveryStore;
        yield* store.grant(
          {
            id: "delivery:artifact-seeded",
            originKey: knowledgeBriefOriginKey("brief:seeded"),
            threadId: artifactThread,
            projectId,
            kind: "publish-artifact",
            acceptanceId: "acceptance:artifact-seeded",
            briefId: "brief:seeded",
            artifactPath: "DELIVERABLE.md",
            artifactSha256: "a".repeat(64),
            artifactBytes: 4,
            repository: intent.repository,
            destinationKey: "comment:github:github.com/owner/repo#7",
            payload: { issueNumber: 7 },
            body: "Body",
            payloadDigest: "d".repeat(64),
            grantedBy: environmentId,
            grantedAt: at,
            requestCommandId: "artifact-seeded",
            status: "pending",
            remote: null,
            failure: null,
            updatedAt: at,
          },
          { recheck: Effect.void, enqueue: Effect.void },
        );
        yield* store.markSending("delivery:artifact-seeded", at);
      }
      if (options.seedSending !== true) return;
      const store = yield* DeliveryStore.FactoryDeliveryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key)
        VALUES (${claimed}, ${intent.repository.canonicalKey}, 7, ${intent.requestCommandId}, ${JSON.stringify(intent)},
          ${issueOriginKey(intent.repository.provider, intent.repository.canonicalKey, 7)})`;
      yield* store.grant(
        {
          id: "delivery:seeded",
          originKey: issueOriginKey(intent.repository.provider, intent.repository.canonicalKey, 7),
          threadId: claimed,
          projectId,
          kind: "publish-pr",
          acceptanceId: "acceptance:seeded",
          repository: intent.repository,
          baseRef: base,
          baseBranch: "main",
          baseSha: base,
          headSha: first,
          payload,
          payloadDigest: "d".repeat(64),
          grantedBy: environmentId,
          grantedAt: at,
          requestCommandId: "seeded",
          status: "pending",
          remote: null,
          failure: null,
          updatedAt: at,
        },
        { recheck: Effect.void, enqueue: Effect.void },
      );
      yield* store.markSending("delivery:seeded", at);
    }),
  ).pipe(Layer.provideMerge(stores));
  const recovering = Delivery.layerWithStartupRecovery.pipe(Layer.provideMerge(seed));
  const deliveryLayer =
    options.seedSending === true || options.seedArtifactSending === true
      ? recovering
      : Delivery.layer.pipe(Layer.provideMerge(stores));
  const executor = Layer.effect(
    EffectWorker.OrchestrationEffectExecutorV2,
    Effect.gen(function* () {
      const service = yield* Delivery.FactoryDeliveryService;
      return EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: (effect) =>
          effect.request.type === "factory.delivery.execute"
            ? service.execute(effect.request.intentId).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectWorker.OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              )
            : Effect.die(`unexpected effect ${effect.request.type}`),
      });
    }),
  ).pipe(Layer.provideMerge(deliveryLayer));
  const layer = EffectWorker.layer.pipe(Layer.provideMerge(executor));
  return { state, layer };
};

const seedClaim = Effect.fn("DeliveryTest.seedClaim")(function* (
  claim: FactoryLaunchIntent = intent,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key)
    VALUES (${claimed}, ${claim.repository.canonicalKey}, 7, ${claim.requestCommandId}, ${JSON.stringify(claim)},
      ${issueOriginKey(claim.repository.provider, claim.repository.canonicalKey, 7)})`;
});
const acceptClaim = Effect.fn("DeliveryTest.acceptClaim")(function* (
  claim: FactoryLaunchIntent = intent,
) {
  yield* seedClaim(claim);
  return yield* (yield* Acceptance.FactoryAcceptanceService).acceptCommit({
    projectId,
    threadId: claimed,
    expectedHeadSha: first,
    evidenceRefs: [],
  });
});
const accept = acceptClaim();
const prepare = (threadId: ThreadId = claimed) =>
  Effect.flatMap(Delivery.FactoryDeliveryService, (service) =>
    service.prepare({ projectId, threadId, kind: "publish-pr", payload }).pipe(
      Effect.filterOrElse(
        (result) => "headSha" in result,
        () => Effect.die("expected commit preparation"),
      ),
    ),
  );
const grant = Effect.fn("DeliveryTest.grant")(function* (
  overrides: {
    readonly commandId?: string;
    readonly expectedHeadSha?: string;
    readonly expectedPayloadDigest?: string;
  } = {},
) {
  const service = yield* Delivery.FactoryDeliveryService;
  const prepared = yield* prepare();
  return yield* service.grant({
    projectId,
    threadId: claimed,
    kind: "publish-pr",
    commandId: overrides.commandId ?? "grant-1",
    expectedHeadSha: overrides.expectedHeadSha ?? prepared.headSha,
    expectedPayloadDigest: overrides.expectedPayloadDigest ?? prepared.payloadDigest,
    payload,
  });
});
const deliveries = Effect.gen(function* () {
  const service = yield* Delivery.FactoryDeliveryService;
  return (yield* service.read({ projectId, threadId: claimed })).intents;
});
const outboxRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT effect_id, effect_type, command_id, thread_id, status
    FROM orchestration_v2_effect_outbox`;
});
const executeGranted = Effect.fn("DeliveryTest.executeGranted")(function* (commandId?: string) {
  const service = yield* Delivery.FactoryDeliveryService;
  const granted = yield* grant(commandId === undefined ? {} : { commandId });
  yield* service.execute(granted.id);
  return granted;
});
const only = Effect.gen(function* () {
  const [latest] = yield* deliveries;
  if (latest === undefined) return yield* Effect.die("expected a delivery");
  return latest;
});

it.effect(
  "prepare returns the exact head and server-computed digest of the accepted commit",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const service = yield* Delivery.FactoryDeliveryService;
      assert.equal((yield* prepare().pipe(Effect.flip)).reason, "not-a-factory-task");
      yield* seedClaim();
      assert.equal((yield* prepare().pipe(Effect.flip)).reason, "not-accepted");
      yield* (yield* Acceptance.FactoryAcceptanceService).acceptCommit({
        projectId,
        threadId: claimed,
        expectedHeadSha: first,
        evidenceRefs: [],
      });
      const prepared = yield* prepare();
      assert.equal(prepared.current, true);
      assert.equal(prepared.headSha, first);
      assert.equal(prepared.baseRef, base);
      assert.equal(prepared.baseBranch, "main");
      assert.equal(prepared.existing, null);
      assert.equal(
        prepared.payloadDigest,
        Delivery.deliveryPayloadDigest({
          kind: "publish-pr",
          repository: intent.repository,
          baseRef: base,
          baseBranch: "main",
          baseSha: base,
          headSha: first,
          payload,
        }),
      );
      assert.equal((yield* prepare(unclaimed).pipe(Effect.flip)).reason, "not-a-factory-task");
      assert.deepEqual(yield* service.read({ projectId, threadId: claimed }), { intents: [] });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("prepare refuses an acceptance whose head has since moved", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    state.head = second;
    assert.equal((yield* prepare().pipe(Effect.flip)).reason, "acceptance-stale");
  }).pipe(Effect.provide(layer));
});

it.effect.each([undefined, null])(
  "legacy launch destination %s is never guessed from its SHA",
  (baseBranch) => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      const { baseBranch: _, ...legacy } = intent;
      yield* acceptClaim(baseBranch === undefined ? legacy : { ...legacy, baseBranch });
      const service = yield* Delivery.FactoryDeliveryService;
      assert.equal((yield* prepare().pipe(Effect.flip)).reason, "missing-base-branch");
      assert.equal(
        (yield* service
          .grant({
            projectId,
            threadId: claimed,
            kind: "publish-pr",
            commandId: "legacy",
            expectedHeadSha: first,
            expectedPayloadDigest: "d".repeat(64),
            payload,
          })
          .pipe(Effect.flip)).reason,
        "missing-base-branch",
      );
      assert.deepEqual(state.calls, []);
      assert.deepEqual(yield* outboxRows, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a destination changed after preview invalidates its digest without moving the accepted head",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const preview = yield* prepare();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_acceptances SET base_branch = 'stable'`;
      yield* sql`UPDATE factory_issue_launches SET intent_json = ${JSON.stringify({ ...intent, baseBranch: "stable" })}`;
      const service = yield* Delivery.FactoryDeliveryService;
      assert.equal(
        (yield* service
          .grant({
            projectId,
            threadId: claimed,
            kind: "publish-pr",
            commandId: "changed-target",
            expectedHeadSha: preview.headSha,
            expectedPayloadDigest: preview.payloadDigest,
            payload,
          })
          .pipe(Effect.flip)).reason,
        "payload-changed",
      );
      assert.deepEqual(state.calls, []);
      assert.deepEqual(yield* outboxRows, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a legacy queued publication refuses before push after an upgrade", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    const granted = yield* grant();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE factory_delivery_intents SET base_branch = NULL WHERE id = ${granted.id}`;
    yield* (yield* Delivery.FactoryDeliveryService).execute(granted.id);
    assert.deepInclude(yield* only, { status: "failed", failure: "missing-base-branch" });
    assert.deepEqual(state.calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("an origin change after grant refuses publication before push", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    const granted = yield* grant();
    state.origin = "https://github.com/other/repo.git";
    yield* (yield* Delivery.FactoryDeliveryService).execute(granted.id);
    assert.deepInclude(yield* only, { status: "failed", failure: "repository-changed" });
    assert.deepEqual(state.calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("a provider destination override cannot redirect a reviewed publication", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    const granted = yield* grant();
    state.providerDestinationMatches = false;
    yield* (yield* Delivery.FactoryDeliveryService).execute(granted.id);
    assert.deepInclude(yield* only, { status: "failed", failure: "repository-changed" });
    assert.deepEqual(state.calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a grant commits one pending intent with exactly one outbox row and wakes the worker",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const granted = yield* grant();
      assert.deepInclude(granted, {
        kind: "publish-pr",
        status: "pending",
        headSha: first,
        baseRef: base,
        baseBranch: "main",
        baseSha: base,
        grantedBy: environmentId,
        requestCommandId: "grant-1",
        remote: null,
      });
      assert.deepEqual(yield* outboxRows, [
        {
          effect_id: `${granted.id}:execute`,
          effect_type: "factory.delivery.execute",
          command_id: "grant-1",
          thread_id: claimed,
          status: "pending",
        },
      ]);
      const queued = Option.getOrThrow(yield* outbox.get(`${granted.id}:execute`));
      assert.deepEqual(queued.request, { type: "factory.delivery.execute", intentId: granted.id });
      // Resolves only because the grant notified the worker after its commit.
      yield* outbox.awaitAvailable;
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "replaying a grant with the same command id returns the same intent and enqueues nothing",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const granted = yield* grant();
      assert.deepEqual(yield* grant(), granted);
      if (granted.kind === "publish-artifact") return yield* Effect.die("expected commit delivery");
      assert.equal(granted.baseBranch, "main");
      const service = yield* Delivery.FactoryDeliveryService;
      assert.equal(
        (yield* service
          .grant({
            projectId,
            threadId: claimed,
            kind: "publish-pr",
            commandId: "grant-1",
            expectedHeadSha: first,
            expectedPayloadDigest: granted.payloadDigest,
            payload: { ...payload, title: "Unreviewed title" },
          })
          .pipe(Effect.flip)).reason,
        "payload-changed",
      );
      assert.lengthOf(yield* outboxRows, 1);
      assert.lengthOf(yield* deliveries, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a grant is refused for a stale head, a changed payload or a live intent", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    const stale = yield* grant({ expectedHeadSha: second }).pipe(Effect.flip);
    assert.equal(stale.reason, "head-moved");
    const changed = yield* grant({ expectedPayloadDigest: "0".repeat(64) }).pipe(Effect.flip);
    assert.equal(changed.reason, "payload-changed");
    assert.lengthOf(yield* outboxRows, 0);

    state.head = second;
    assert.equal((yield* grant().pipe(Effect.flip)).reason, "acceptance-stale");
    state.head = first;

    yield* grant();
    const again = yield* grant({ commandId: "grant-2" }).pipe(Effect.flip);
    assert.equal(again.reason, "already-delivering");
    assert.lengthOf(yield* outboxRows, 1);
    assert.lengthOf(yield* deliveries, 1);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "executing a pending intent pushes, creates the pull request and confirms with its link",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const granted = yield* executeGranted();
      assert.deepEqual(state.calls, ["push", "create:main:feature:Fix the thing"]);
      const settled = yield* only;
      assert.equal(settled.id, granted.id);
      assert.equal(settled.status, "confirmed");
      assert.deepEqual(settled.remote, pullRequest);
      assert.equal(settled.failure, null);
      assert.deepInclude(state.links[0], {
        type: "thread.pull-request.link",
        threadId: claimed,
        number: pullRequest.number,
        url: pullRequest.url,
        source: "created",
      });
      assert.lengthOf(state.links, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("an open pull request for the head is adopted without creating another", () => {
  const { state, layer } = harness();
  state.open = Option.some(pullRequest);
  return Effect.gen(function* () {
    yield* accept;
    yield* executeGranted();
    assert.deepEqual(state.calls, ["push"]);
    const settled = yield* only;
    assert.equal(settled.status, "confirmed");
    assert.deepEqual(settled.remote, pullRequest);
  }).pipe(Effect.provide(layer));
});

it.effect("an existing pull request to another base is never adopted", () => {
  const { state, layer } = harness();
  state.open = Option.some(pullRequest);
  state.pr.baseBranch = "other-base";
  return Effect.gen(function* () {
    yield* accept;
    yield* executeGranted();
    assert.deepInclude(yield* only, { status: "failed", failure: "pull-request-target-mismatch" });
    assert.deepEqual(state.calls, ["push"]);
    assert.deepEqual(state.links, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a retried execution of a sending intent settles unknown without calling the forge",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const service = yield* Delivery.FactoryDeliveryService;
      const sql = yield* SqlClient.SqlClient;
      const granted = yield* grant();
      yield* sql`UPDATE factory_delivery_intents SET status = 'sending' WHERE id = ${granted.id}`;
      yield* service.execute(granted.id);
      const settled = yield* only;
      assert.equal(settled.status, "unknown");
      assert.equal(settled.failure, "response lost");
      assert.deepEqual(state.calls, []);
      // Nothing re-sends once it is unknown, and a repeated effect is a no-op.
      yield* service.execute(granted.id);
      assert.deepEqual(state.calls, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("an ambiguous create error leaves the intent unknown and a definite one fails it", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    state.create = "ambiguous";
    yield* executeGranted();
    const unknown = yield* only;
    assert.equal(unknown.status, "unknown");
    assert.include(unknown.failure ?? "", "response lost");
    assert.equal(
      (yield* grant({ commandId: "grant-2" }).pipe(Effect.flip)).reason,
      "already-delivering",
    );

    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE factory_delivery_intents SET status = 'failed' WHERE id = ${unknown.id}`;
    state.create = "definite";
    // `read` orders by grant time; a later clock makes the second grant the newest row.
    yield* TestClock.adjust("1 second");
    yield* executeGranted("grant-3");
    const failed = yield* only;
    assert.equal(failed.status, "failed");
    assert.include(failed.failure ?? "", "pull request rejected");
    assert.equal(failed.remote, null);
    assert.lengthOf(state.links, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a push failure or a moved head fails the intent before anything is created", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    state.push = "fail";
    yield* executeGranted();
    const pushFailed = yield* only;
    assert.equal(pushFailed.status, "failed");
    assert.include(pushFailed.failure ?? "", "push failed");
    assert.deepEqual(state.calls, ["push"]);

    state.push = "ok";
    state.calls.length = 0;
    const service = yield* Delivery.FactoryDeliveryService;
    yield* TestClock.adjust("1 second");
    const granted = yield* grant({ commandId: "grant-2" });
    state.head = second;
    yield* service.execute(granted.id);
    const moved = yield* only;
    assert.equal(moved.status, "failed");
    assert.equal(moved.failure, "head-moved");
    assert.deepEqual(state.calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "reconciling an unknown publication preserves its slot, then adopts the PR once it shows",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const service = yield* Delivery.FactoryDeliveryService;
      state.create = "ambiguous";
      const granted = yield* executeGranted();
      state.calls.length = 0;

      const released = yield* service.reconcile({ projectId, intentId: granted.id });
      assert.equal(released.status, "unknown");
      assert.isNotNull(released.failure);

      state.open = Option.some(pullRequest);
      const confirmed = yield* service.reconcile({ projectId, intentId: granted.id });
      assert.equal(confirmed.status, "confirmed");
      assert.deepEqual(confirmed.remote, pullRequest);
      assert.deepEqual(state.calls, []);
      assert.lengthOf(state.links, 1);
      assert.equal(
        (yield* service.reconcile({ projectId, intentId: granted.id }).pipe(Effect.flip)).reason,
        "not-reconcilable",
      );
      assert.equal(
        (yield* service.reconcile({ projectId, intentId: "delivery:missing" }).pipe(Effect.flip))
          .reason,
        "intent-not-found",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a replacement granted during PR reconciliation prevents the superseded thread link",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const service = yield* Delivery.FactoryDeliveryService;
      const store = yield* DeliveryStore.FactoryDeliveryStore;
      const first = yield* grant();
      yield* store.settle(first.id, { status: "unknown", failure: "response lost", updatedAt: at });
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      state.beforeHeadLookup = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(released)),
      );
      state.open = Option.some(pullRequest);
      const reconcile = yield* service
        .reconcile({ projectId, intentId: first.id })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* store.settle(first.id, { status: "failed", failure: "absent", updatedAt: at });
      const replacement = { ...first, id: "replacement", requestCommandId: "replacement" };
      yield* store.grant(replacement, { recheck: Effect.void, enqueue: Effect.void });
      yield* Deferred.succeed(released, undefined);
      const settled = yield* Fiber.join(reconcile);
      assert.equal(settled.status, "failed");
      assert.isNull(settled.remote);
      assert.equal(
        settled.failure,
        `Replacement delivery ${replacement.id} already holds the live slot; its remote cannot be attributed to this attempt.`,
      );
      assert.deepEqual(state.links, []);
      assert.deepEqual(Option.getOrThrow(yield* store.get(replacement.id)), replacement);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["publish-pr", "merge-pr"] as const)(
  "a failed %s cannot reconcile against a replacement's pull request",
  (kind) => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const service = yield* Delivery.FactoryDeliveryService;
      const store = yield* DeliveryStore.FactoryDeliveryStore;
      const first = yield* grant();
      if (first.kind === "publish-artifact") return yield* Effect.die("expected commit intent");
      yield* store.settle(first.id, { status: "failed", failure: "absent", updatedAt: at });
      const failed =
        kind === "publish-pr"
          ? first
          : {
              ...first,
              id: "merge-a",
              kind,
              payload: { mergeMethod: "squash" as const },
              remote: pullRequest,
              requestCommandId: "merge-a",
            };
      if (kind === "merge-pr") {
        yield* store.grant(failed, { recheck: Effect.void, enqueue: Effect.void });
        yield* store.settle(failed.id, { status: "failed", failure: "absent", updatedAt: at });
      }
      const replacement = {
        ...failed,
        id: "replacement",
        requestCommandId: "replacement",
        status: "pending" as const,
      };
      yield* store.grant(replacement, { recheck: Effect.void, enqueue: Effect.void });
      state.open = Option.some(pullRequest);
      state.pr.state = "merged";
      const lookups = state.headLookups;
      const reads = state.reads;
      const refused = yield* service
        .reconcile({ projectId, intentId: failed.id })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "not-reconcilable");
      assert.equal(refused.replacementDeliveryId, replacement.id);
      assert.equal(refused.message, "A replacement delivery already holds this slot.");
      assert.equal(state.headLookups, lookups);
      assert.equal(state.reads, reads);
      assert.deepEqual(state.links, []);
      assert.deepEqual(Option.getOrThrow(yield* store.get(replacement.id)), replacement);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a missing publication stays unknown and blocks a replacement grant", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    const service = yield* Delivery.FactoryDeliveryService;
    state.create = "ambiguous";
    const granted = yield* executeGranted();
    assert.equal(
      (yield* grant({ commandId: "grant-while-unknown" }).pipe(Effect.flip)).reason,
      "already-delivering",
    );
    yield* service.reconcile({ projectId, intentId: granted.id });
    const regrant = yield* grant({ commandId: "grant-after-reconcile" }).pipe(Effect.flip);
    assert.equal(regrant.reason, "already-delivering");
  }).pipe(Effect.provide(layer));
});

it.effect.each(["open", "closed", "merged"] as const)(
  "publication reconciliation recovers a %s PR at the frozen destination",
  (prState) => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      const baseBranch = "factory-verification/20261029/base";
      yield* acceptClaim({ ...intent, baseBranch });
      const granted = yield* grant();
      const store = yield* DeliveryStore.FactoryDeliveryStore;
      yield* store.settle(granted.id, {
        status: "unknown",
        failure: "response lost",
        updatedAt: at,
      });
      state.origin = "https://github.com/other/checkout.git";
      state.head = second;
      state.pr.baseBranch = baseBranch;
      state.pr.state = prState;
      state.publications = [publishedChangeRequest({ state: prState, baseRefName: baseBranch })];
      const recovered = yield* (yield* Delivery.FactoryDeliveryService).reconcile({
        projectId,
        intentId: granted.id,
      });
      if (recovered.kind !== "publish-pr") return yield* Effect.die("expected publication");
      assert.equal(recovered.status, "confirmed");
      assert.deepEqual(recovered.remote, pullRequest);
      assert.equal(recovered.headSha, first);
      assert.equal(recovered.baseBranch, baseBranch);
      assert.deepEqual(recovered.repository, intent.repository);
      assert.deepEqual(state.publicationLookups, [
        {
          cwd: "/worktree",
          context: {
            provider: {
              kind: intent.repository.provider,
              name: "github",
              baseUrl: "https://github.com",
            },
            remoteName: "origin",
            remoteUrl: intent.repository.url,
          },
          headSelector: "feature",
          state: "all",
          limit: 100,
        },
      ]);
      assert.deepEqual(state.calls, []);
      assert.lengthOf(state.links, 1);
      assert.deepEqual(Option.getOrThrow(yield* store.get(granted.id)), recovered);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  "missing",
  "ambiguous",
  "truncated",
  "wrong-repository",
  "wrong-host",
  "wrong-provider",
  "wrong-number",
  "wrong-head",
  "missing-head",
  "wrong-base",
  "unreadable",
  "unverifiable",
  "changed-destination",
] as const)("publication reconciliation preserves unknown on %s evidence", (scenario) => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    const granted = yield* grant();
    const store = yield* DeliveryStore.FactoryDeliveryStore;
    yield* store.settle(granted.id, { status: "unknown", failure: "response lost", updatedAt: at });
    const candidate = publishedChangeRequest();
    state.publications = scenario === "missing" ? [] : [candidate];
    if (scenario === "ambiguous")
      state.publications = [
        candidate,
        publishedChangeRequest({
          number: 13,
          url: "https://github.com/owner/repo/pull/13",
        }),
      ];
    if (scenario === "truncated")
      state.publications = [
        candidate,
        ...Array.from({ length: 99 }, (_, index) =>
          publishedChangeRequest({
            number: index + 100,
            url: `https://github.com/owner/repo/pull/${index + 100}`,
            headSha: second,
          }),
        ),
      ];
    if (scenario === "wrong-repository")
      state.publications = [
        publishedChangeRequest({ url: "https://github.com/other/repo/pull/12" }),
      ];
    if (scenario === "wrong-host")
      state.publications = [
        publishedChangeRequest({ url: "https://git.example/owner/repo/pull/12" }),
      ];
    if (scenario === "wrong-provider")
      state.publications = [
        publishedChangeRequest({ provider: SourceControlProviderKind.make("gitlab") }),
      ];
    if (scenario === "wrong-number") state.publications = [publishedChangeRequest({ number: 13 })];
    if (scenario === "wrong-head")
      state.publications = [publishedChangeRequest({ headSha: second })];
    if (scenario === "missing-head")
      state.publications = [publishedChangeRequest({ headSha: undefined })];
    if (scenario === "wrong-base")
      state.publications = [publishedChangeRequest({ baseRefName: "another-base" })];
    if (scenario === "unreadable") state.publicationRead = "fail";
    if (scenario === "unverifiable") state.read = "fail";
    if (scenario === "changed-destination") state.pr.baseBranch = "another-base";
    const recovered = yield* (yield* Delivery.FactoryDeliveryService).reconcile({
      projectId,
      intentId: granted.id,
    });
    if (recovered.kind !== "publish-pr" || granted.kind !== "publish-pr")
      return yield* Effect.die("expected publication");
    assert.equal(recovered.status, "unknown");
    assert.isNotNull(recovered.failure);
    assert.deepEqual(recovered.repository, granted.repository);
    assert.equal(recovered.headSha, granted.headSha);
    assert.equal(recovered.baseBranch, granted.baseBranch);
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.links, []);
    assert.equal(
      (yield* grant({ commandId: "replacement" }).pipe(Effect.flip)).reason,
      "already-delivering",
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "startup recovery settles a sending intent unknown before any worker can claim it",
  () => {
    const { layer } = harness({ seedSending: true });
    return Effect.gen(function* () {
      const store = yield* DeliveryStore.FactoryDeliveryStore;
      const recovered = Option.getOrThrow(yield* store.get("delivery:seeded"));
      assert.equal(recovered.status, "unknown");
      assert.equal(recovered.failure, "server restarted during send");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("publish and merge digests bind the snapshot and host branch separately", () =>
  Effect.sync(() => {
    assert.equal(
      Delivery.deliveryPayloadDigest({
        kind: "publish-pr",
        repository: intent.repository,
        baseRef: base,
        baseBranch: "main",
        baseSha: base,
        headSha: first,
        payload,
      }),
      "f2d9c6fb49a5c8b273f52a140f0d2dd0de334a5e1abafa0511f7012b6c2ed355",
    );
    assert.equal(
      Delivery.deliveryPayloadDigest({
        kind: "merge-pr",
        repository: intent.repository,
        baseRef: base,
        baseBranch: "main",
        baseSha: base,
        headSha: first,
        payload: { mergeMethod: "squash" },
        pullRequestNumber: pullRequest.number,
      }),
      "e54180caacae54008dee61df828215d86b1e3abdd9f793b080ae26a0d7cd47e0",
    );
  }),
);

type MergeMethod = "merge" | "squash" | "rebase";
const mergePayload = (mergeMethod: MergeMethod = "squash") => ({ mergeMethod });
const prepareMerge = (mergeMethod?: MergeMethod) =>
  Effect.flatMap(Delivery.FactoryDeliveryService, (service) =>
    service
      .prepare({
        projectId,
        threadId: claimed,
        kind: "merge-pr",
        payload: mergePayload(mergeMethod),
      })
      .pipe(
        Effect.filterOrElse(
          (result) => "headSha" in result,
          () => Effect.die("expected merge preparation"),
        ),
      ),
  );
const grantMerge = Effect.fn("DeliveryTest.grantMerge")(function* (
  overrides: {
    readonly commandId?: string;
    readonly mergeMethod?: MergeMethod;
    readonly expectedHeadSha?: string;
  } = {},
) {
  const service = yield* Delivery.FactoryDeliveryService;
  const prepared = yield* prepareMerge(overrides.mergeMethod);
  return yield* service.grant({
    projectId,
    threadId: claimed,
    kind: "merge-pr",
    commandId: overrides.commandId ?? "merge-1",
    expectedHeadSha: overrides.expectedHeadSha ?? prepared.headSha,
    expectedPayloadDigest: prepared.payloadDigest,
    payload: mergePayload(overrides.mergeMethod),
  });
});
const mergeIntent = Effect.gen(function* () {
  const merge = (yield* deliveries).find((delivery) => delivery.kind === "merge-pr");
  if (merge === undefined) return yield* Effect.die("expected a merge delivery");
  return merge;
});
// A confirmed publish is the precondition of every merge; the clock moves on so a merge is the
// newest row, which `read` orders by grant time.
const published = Effect.gen(function* () {
  yield* accept;
  yield* executeGranted();
  yield* TestClock.adjust("1 second");
});

it.effect("prepare merge-pr needs a confirmed publish, then reports the pull request", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* accept;
    assert.equal((yield* prepareMerge().pipe(Effect.flip)).reason, "not-published");
    // A publish that is only pending does not count.
    const service = yield* Delivery.FactoryDeliveryService;
    const granted = yield* grant();
    assert.equal((yield* prepareMerge().pipe(Effect.flip)).reason, "not-published");
    yield* service.execute(granted.id);

    const squash = yield* prepareMerge("squash");
    assert.deepEqual(squash.pullRequest, {
      number: pullRequest.number,
      url: pullRequest.url,
      headSha: first,
      state: "open",
      mergeability: "mergeable",
      isDraft: false,
      checksSummary: "3 passed, 1 failing, 1 pending",
      mergeMethods: ["merge", "squash"],
    });
    assert.equal(squash.headSha, first);
    assert.equal(squash.existing, null);
    assert.deepEqual(squash.payload, { mergeMethod: "squash" });
    assert.equal(
      squash.payloadDigest,
      "e54180caacae54008dee61df828215d86b1e3abdd9f793b080ae26a0d7cd47e0",
    );
    assert.notEqual((yield* prepareMerge("rebase")).payloadDigest, squash.payloadDigest);
    // Advisory reads may use the shared cache; only a grant and a reconcile drop it.
    assert.equal(state.invalidations, 1);

    const mismatched = yield* service
      .prepare({ projectId, threadId: claimed, kind: "merge-pr", payload })
      .pipe(Effect.flip);
    assert.equal(mismatched.reason, "payload-changed");
    state.head = second;
    assert.equal((yield* prepareMerge().pipe(Effect.flip)).reason, "acceptance-stale");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a merge grant is refused for a moved, merged, unmergeable or unreadable pull request",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* published;
      state.pr.baseBranch = "other-base";
      assert.equal((yield* grantMerge().pipe(Effect.flip)).reason, "payload-changed");
      state.pr.baseBranch = "main";
      state.pr.headSha = second;
      assert.equal((yield* grantMerge().pipe(Effect.flip)).reason, "pull-request-head-moved");
      state.pr.headSha = undefined;
      assert.equal((yield* grantMerge().pipe(Effect.flip)).reason, "pull-request-head-moved");
      state.pr.headSha = first;

      state.pr.state = "merged";
      assert.equal((yield* grantMerge().pipe(Effect.flip)).reason, "already-merged");
      state.pr.state = "open";

      state.pr.mergeability = "conflicting";
      assert.equal((yield* grantMerge().pipe(Effect.flip)).reason, "not-mergeable");
      state.pr.mergeability = "mergeable";
      state.pr.isDraft = true;
      assert.equal((yield* grantMerge().pipe(Effect.flip)).reason, "not-mergeable");
      state.pr.isDraft = false;

      state.read = "fail";
      assert.equal((yield* grantMerge().pipe(Effect.flip)).reason, "persistence-failure");
      state.read = "ok";

      const service = yield* Delivery.FactoryDeliveryService;
      const prepared = yield* prepareMerge();
      const changed = yield* service
        .grant({
          projectId,
          threadId: claimed,
          kind: "merge-pr",
          commandId: "merge-changed",
          expectedHeadSha: prepared.headSha,
          expectedPayloadDigest: prepared.payloadDigest,
          payload: mergePayload("rebase"),
        })
        .pipe(Effect.flip);
      assert.equal(changed.reason, "payload-changed");
      // Only the publish row exists: every refusal left the merge out of the database and outbox.
      assert.lengthOf(yield* deliveries, 1);
      assert.lengthOf(yield* outboxRows, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a merge grant stores the pull request at grant and enqueues exactly one effect", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* published;
    const granted = yield* grantMerge();
    assert.deepInclude(granted, {
      kind: "merge-pr",
      status: "pending",
      headSha: first,
      requestCommandId: "merge-1",
    });
    assert.deepEqual(granted.payload, { mergeMethod: "squash" });
    assert.deepEqual(granted.remote, pullRequest);
    // The grant read the host fresh instead of trusting the shared cache.
    assert.isAbove(state.invalidations, 0);

    const rows = yield* outboxRows;
    assert.lengthOf(rows, 2);
    assert.lengthOf(
      rows.filter((row) => row.effect_id === `${granted.id}:execute`),
      1,
    );
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const queued = Option.getOrThrow(yield* outbox.get(`${granted.id}:execute`));
    assert.deepEqual(queued.request, { type: "factory.delivery.execute", intentId: granted.id });

    assert.deepEqual(yield* grantMerge(), granted);
    assert.lengthOf(yield* outboxRows, 2);
    assert.equal(
      (yield* grantMerge({ commandId: "merge-2" }).pipe(Effect.flip)).reason,
      "already-delivering",
    );
    assert.lengthOf(yield* outboxRows, 2);
    assert.deepEqual(yield* mergeIntent, granted);
  }).pipe(Effect.provide(layer));
});

it.effect("executing a merge pins the host to the accepted head and never touches git", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* published;
    const service = yield* Delivery.FactoryDeliveryService;
    state.calls.length = 0;
    state.links.length = 0;
    const granted = yield* grantMerge({ mergeMethod: "rebase" });
    // The worktree has moved on; a merge acts on the pull request alone, so it does not look.
    state.head = second;
    yield* service.execute(granted.id);
    assert.deepEqual(state.mergeCalls, [
      {
        projectId,
        repository: "owner/repo",
        host: "github.com",
        number: pullRequest.number,
        action: "merge",
        mergeMethod: "rebase",
        expectedHeadSha: first,
      },
    ]);
    assert.deepEqual(state.calls, []);
    const settled = yield* mergeIntent;
    assert.equal(settled.status, "confirmed");
    assert.deepEqual(settled.remote, pullRequest);
    assert.equal(settled.failure, null);
    // The pull request is already linked by its publish.
    assert.lengthOf(state.links, 0);
    // A repeated effect is a no-op.
    yield* service.execute(granted.id);
    assert.lengthOf(state.mergeCalls, 1);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a definite host rejection fails the merge and an ambiguous one leaves it unknown",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* published;
      const service = yield* Delivery.FactoryDeliveryService;
      state.merge = "ambiguous";
      const ambiguous = yield* grantMerge();
      yield* service.execute(ambiguous.id);
      const unknown = yield* mergeIntent;
      assert.equal(unknown.status, "unknown");
      assert.include(unknown.failure ?? "", "response lost");
      assert.deepEqual(unknown.remote, pullRequest);
      assert.equal(
        (yield* grantMerge({ commandId: "merge-2" }).pipe(Effect.flip)).reason,
        "already-delivering",
      );

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_delivery_intents SET status = 'failed' WHERE id = ${unknown.id}`;
      state.merge = "definite";
      yield* TestClock.adjust("1 second");
      const definite = yield* grantMerge({ commandId: "merge-3" });
      yield* service.execute(definite.id);
      const failed = yield* mergeIntent;
      assert.equal(failed.id, definite.id);
      assert.equal(failed.status, "failed");
      assert.include(failed.failure ?? "", "merge rejected");
      assert.deepEqual(failed.remote, pullRequest);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("reconciling a merge reads the pull request and never merges again", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    yield* published;
    const service = yield* Delivery.FactoryDeliveryService;
    state.merge = "ambiguous";
    const granted = yield* grantMerge();
    yield* service.execute(granted.id);
    state.mergeCalls.length = 0;
    state.invalidations = 0;

    // A read that fails proves nothing, so the status stays.
    state.read = "fail";
    const unread = yield* service.reconcile({ projectId, intentId: granted.id });
    assert.equal(unread.status, "unknown");
    assert.include(unread.failure ?? "", "could not read pull request");
    state.read = "ok";

    // Readable and not merged: the send did not land, so the origin is released.
    const released = yield* service.reconcile({ projectId, intentId: granted.id });
    assert.equal(released.status, "failed");
    assert.equal(released.failure, "pull request is not merged");
    assert.isAbove(state.invalidations, 0);

    state.pr.state = "merged";
    const confirmed = yield* service.reconcile({ projectId, intentId: granted.id });
    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual(confirmed.remote, pullRequest);
    assert.equal(confirmed.failure, null);
    assert.deepEqual(state.mergeCalls, []);
    assert.equal(
      (yield* service.reconcile({ projectId, intentId: granted.id }).pipe(Effect.flip)).reason,
      "not-reconcilable",
    );
  }).pipe(Effect.provide(layer));
});

const gitlabIntent: FactoryLaunchIntent = {
  ...intent,
  repository: {
    provider: SourceControlProviderKind.make("gitlab"),
    host: "gitlab.com",
    repository: "group/sub/repo",
    canonicalKey: "gitlab.com/group/sub/repo",
    url: "https://gitlab.com/group/sub/repo",
  },
};
it.effect(
  "a GitLab claim's accepted commit is refused publish and merge at prepare and grant before the host is touched",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      const service = yield* Delivery.FactoryDeliveryService;
      yield* acceptClaim(gitlabIntent);
      const refusals = [
        yield* prepare().pipe(Effect.flip),
        yield* prepareMerge().pipe(Effect.flip),
        yield* service
          .grant({
            projectId,
            threadId: claimed,
            kind: "publish-pr",
            commandId: "gitlab-publish",
            expectedHeadSha: first,
            expectedPayloadDigest: "d".repeat(64),
            payload,
          })
          .pipe(Effect.flip),
        yield* service
          .grant({
            projectId,
            threadId: claimed,
            kind: "merge-pr",
            commandId: "gitlab-merge",
            expectedHeadSha: first,
            expectedPayloadDigest: "d".repeat(64),
            payload: mergePayload(),
          })
          .pipe(Effect.flip),
      ];
      assert.deepEqual(
        refusals.map((refusal) => refusal.reason),
        Array.from({ length: 4 }, () => "capability-unsupported"),
      );
      assert.deepInclude(state, { reads: 0, invalidations: 0, calls: [], mergeCalls: [] });
      assert.deepEqual(yield* deliveries, []);
      assert.deepEqual(yield* outboxRows, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a host that publishes without a head-pinned merge is refused only the merge, before the pull request is read",
  () => {
    const github = fakeIssueTracker("github");
    const { state, layer } = harness({
      trackers: [{ ...github, capabilities: { ...github.capabilities, headPinnedMerge: false } }],
    });
    return Effect.gen(function* () {
      yield* published;
      const reads = state.reads;
      assert.equal((yield* only).status, "confirmed");
      assert.equal((yield* prepareMerge().pipe(Effect.flip)).reason, "capability-unsupported");
      const refused = yield* (yield* Delivery.FactoryDeliveryService)
        .grant({
          projectId,
          threadId: claimed,
          kind: "merge-pr",
          commandId: "unpinned-merge",
          expectedHeadSha: first,
          expectedPayloadDigest: "d".repeat(64),
          payload: mergePayload(),
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "capability-unsupported");
      assert.equal(state.reads, reads);
      assert.equal(state.invalidations, 1);
      assert.deepEqual(state.mergeCalls, []);
    }).pipe(Effect.provide(layer));
  },
);

const artifactThread = ThreadId.make("artifact-thread");
const artifactText = "## Findings\n\nThe accepted **markdown**.\n";
const hash = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const artifactHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-artifact-delivery-" });
  const folder = path.join(root, "task");
  yield* fs.makeDirectory(folder);
  const file = path.join(folder, "DELIVERABLE.md");
  const host = {
    reads: [] as number[],
    posts: [] as { cwd: string; host: string; repository: string; number: number; body: string }[],
    pages: [] as number[],
    issue: "ok" as "ok" | "not-found" | "not-an-issue",
    send: "ok" as "ok" | "definite" | "ambiguous",
    listingFailure: null as IssueTrackerProviderError["reason"] | null,
    failPage: 1,
    failRead: null as number | null,
    listings: [] as { comments: readonly TrackerIssueComment[]; nextPage: number | null }[],
    listingResponses: [] as { comments: readonly TrackerIssueComment[]; nextPage: number | null }[],
  };
  const failure = (
    operation: string,
    reason: IssueTrackerProviderError["reason"],
    cause?: unknown,
  ) =>
    new IssueTrackerProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation,
      reason,
      detail: "fixture response",
      ...(cause === undefined ? {} : { cause }),
    });
  const fake = fakeIssueTracker("github", {
    getIssue: (input) => {
      host.reads.push(input.number);
      return host.issue === "ok"
        ? Effect.succeed({
            ...intent.issue,
            number: input.number,
            url: `https://github.com/owner/repo/issues/${input.number}`,
          })
        : Effect.fail(failure("getIssue", host.issue));
    },
    commentOnIssue: (input) => {
      host.posts.push(input);
      if (host.send !== "ok")
        return Effect.fail(
          failure(
            "commentOnIssue",
            "failed",
            host.send === "definite"
              ? { _tag: "GitHubApiResponseError", status: 422 }
              : { _tag: "GitHubApiRequestError" },
          ),
        );
      return Effect.succeed({
        id: 91,
        body: input.body,
        url: `https://github.com/owner/repo/issues/${input.number}#issuecomment-91`,
      });
    },
    listIssueComments: ({ page }) => {
      host.pages.push(page);
      return host.listingFailure !== null &&
        (host.failRead === null ? page === host.failPage : host.pages.length === host.failRead)
        ? Effect.fail(failure("listIssueComments", host.listingFailure))
        : Effect.succeed(
            host.listingResponses.shift() ??
              host.listings[page - 1] ?? { comments: [], nextPage: null },
          );
    },
  });
  const tracker = { ...fake, capabilities: { ...fake.capabilities } };
  const h = harness({ artifactFolder: folder, trackers: [tracker] });
  return { ...h, fs, file, folder, host, tracker };
});

type ArtifactTestServices =
  | Delivery.FactoryDeliveryService
  | Knowledge.FactoryKnowledgeService
  | KnowledgeStore.FactoryKnowledgeStore
  | DeliveryStore.FactoryDeliveryStore
  | EffectWorker.OrchestrationEffectWorkerV2
  | EffectOutbox.EffectOutboxV2
  | SqlClient.SqlClient;
const withArtifact = <A, E>(
  body: (h: Effect.Success<typeof artifactHarness>) => Effect.Effect<A, E, ArtifactTestServices>,
) =>
  Effect.gen(function* () {
    const h = yield* artifactHarness;
    return yield* body(h).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const acceptArtifact = Effect.fn("DeliveryTest.acceptArtifact")(function* (
  h: Effect.Success<typeof artifactHarness>,
  text: string | Uint8Array = artifactText,
) {
  const knowledge = yield* Knowledge.FactoryKnowledgeService;
  const brief = yield* knowledge.createBrief({
    projectId,
    commandId: CommandId.make("create-artifact"),
    title: "Protocol survey",
    question: "What changed?",
    inputs: [],
    acceptanceCriteria: "Cites sources",
  });
  const store = yield* KnowledgeStore.FactoryKnowledgeStore;
  yield* store.reserve({
    briefId: brief.id,
    briefRevision: brief.revision,
    title: brief.title,
    projectId,
    workspaceRoot: "/repo",
    requestCommandId: CommandId.make("start-artifact"),
    commandId: CommandId.make("launch-artifact"),
    threadId: artifactThread,
    messageId: MessageId.make("artifact-message"),
    modelSelection: intent.modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    prompt: "Brief",
    createdBy: "user",
    creationSource: "web",
    createdAt: at,
    previousThreadId: null,
  });
  yield* store.accept(artifactThread);
  yield* h.fs.writeFile(h.file, typeof text === "string" ? new TextEncoder().encode(text) : text);
  const accepted = yield* knowledge.accept({
    projectId,
    briefId: brief.id,
    expectedSha256: hash(text),
  });
  return { brief, accepted };
});

const prepareArtifact = Effect.fn("DeliveryTest.prepareArtifact")(function* (issueNumber = 7) {
  const prepared = yield* (yield* Delivery.FactoryDeliveryService).prepare({
    projectId,
    threadId: artifactThread,
    kind: "publish-artifact",
    payload: { issueNumber },
  });
  if (!("artifactSha256" in prepared)) return yield* Effect.die("expected artifact preparation");
  return prepared;
});

const grantArtifact = Effect.fn("DeliveryTest.grantArtifact")(function* (
  overrides: Partial<FactoryArtifactDeliveryGrantInput> = {},
) {
  const prepared = yield* prepareArtifact(overrides.payload?.issueNumber);
  return yield* (yield* Delivery.FactoryDeliveryService).grant({
    projectId,
    threadId: artifactThread,
    kind: "publish-artifact",
    commandId: "artifact-grant",
    expectedArtifactSha256: prepared.artifactSha256,
    expectedPayloadDigest: prepared.payloadDigest,
    attempt: prepared.attempt,
    payload: prepared.payload,
    ...overrides,
  });
});

const drain = Effect.gen(function* () {
  return yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
});

it.effect(
  "artifact prepare renders accepted bytes and pins the origin issue, acceptance and exact body",
  () =>
    withArtifact((h) =>
      Effect.gen(function* () {
        const { brief, accepted } = yield* acceptArtifact(h);
        const prepared = yield* prepareArtifact();
        assert.isNotEmpty(prepared.attempt);
        const acceptance = accepted.acceptance;
        assert.isNotNull(acceptance);
        if (acceptance === null) return yield* Effect.die("expected acceptance");
        assert.deepEqual(prepared.acceptance, acceptance);
        assert.equal(prepared.current, true);
        assert.equal(prepared.repository.canonicalKey, "github.com/owner/repo");
        assert.equal(prepared.destinationKey, "comment:github:github.com/owner/repo#7");
        assert.deepEqual(prepared.destination, {
          number: 7,
          title: "Task",
          state: "open",
          url: "https://github.com/owner/repo/issues/7",
        });
        assert.equal(prepared.artifactSha256, hash(artifactText));
        assert.equal(prepared.artifactBytes, new TextEncoder().encode(artifactText).byteLength);
        assert.equal(
          prepared.body,
          renderArtifactComment({
            briefTitle: brief.title,
            deliverablePath: brief.deliverablePath,
            text: artifactText,
            artifactSha256: hash(artifactText),
            acceptanceId: acceptance.id,
            attempt: prepared.attempt,
          }),
        );
        assert.equal(
          prepared.payloadDigest,
          hash(
            JSON.stringify([
              "publish-artifact",
              prepared.destinationKey,
              acceptance.id,
              hash(artifactText),
              prepared.body,
            ]),
          ),
        );
        assert.deepEqual(h.host.reads, [7]);
        assert.deepEqual(h.host.posts, []);
        assert.equal(prepared.existing, null);
        assert.lengthOf(yield* outboxRows, 0);
      }),
    ),
);

it.effect(
  "artifact prepare and grant refuse a tracker without issueComment before any host call",
  () =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        h.tracker.capabilities.issueComment = false;
        assert.equal((yield* prepareArtifact().pipe(Effect.flip)).reason, "capability-unsupported");
        const refused = yield* (yield* Delivery.FactoryDeliveryService)
          .grant({
            projectId,
            threadId: artifactThread,
            kind: "publish-artifact",
            commandId: "unsupported",
            expectedArtifactSha256: hash(artifactText),
            expectedPayloadDigest: "d".repeat(64),
            attempt: "unused-attempt",
            payload: { issueNumber: 7 },
          })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "capability-unsupported");
        assert.deepEqual(h.host.reads, []);
        assert.deepEqual(h.host.posts, []);
        assert.deepEqual(h.host.pages, []);
      }),
    ),
);

it.effect.each(["not-found", "not-an-issue"] as const)(
  "artifact prepare maps a $0 destination to destination-not-found",
  (reason) =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        h.host.issue = reason;
        assert.equal((yield* prepareArtifact().pipe(Effect.flip)).reason, "destination-not-found");
        assert.deepEqual(h.host.reads, [7]);
        assert.deepEqual(h.host.posts, []);
      }),
    ),
);

it.effect.each([
  { name: "oversize body", text: "x".repeat(65536), reason: "artifact-too-large" },
  { name: "truncated preview", text: "x".repeat(256 * 1024 + 1), reason: "artifact-too-large" },
  { name: "invalid UTF-8", text: new Uint8Array([0xc3, 0x28]), reason: "artifact-not-text" },
])("artifact prepare refuses $name without truncation or a host call", ({ text, reason }) =>
  withArtifact((h) =>
    Effect.gen(function* () {
      yield* acceptArtifact(h, text);
      assert.equal((yield* prepareArtifact().pipe(Effect.flip)).reason, reason);
      assert.deepEqual(h.host.reads, []);
      assert.deepEqual(h.host.posts, []);
    }),
  ),
);

it.effect("artifact grant refuses changed bytes, reviewer hash, body digest and destination", () =>
  withArtifact((h) =>
    Effect.gen(function* () {
      yield* acceptArtifact(h);
      const service = yield* Delivery.FactoryDeliveryService;
      const prepared = yield* prepareArtifact();
      const input: FactoryArtifactDeliveryGrantInput = {
        projectId,
        threadId: artifactThread,
        kind: "publish-artifact",
        commandId: "changed",
        expectedArtifactSha256: prepared.artifactSha256,
        expectedPayloadDigest: prepared.payloadDigest,
        attempt: prepared.attempt,
        payload: prepared.payload,
      };
      assert.equal(
        (yield* service
          .grant({ ...input, expectedArtifactSha256: "b".repeat(64) })
          .pipe(Effect.flip)).reason,
        "artifact-changed",
      );
      assert.equal(
        (yield* service
          .grant({ ...input, expectedPayloadDigest: "b".repeat(64) })
          .pipe(Effect.flip)).reason,
        "payload-changed",
      );
      assert.equal(
        (yield* service.grant({ ...input, attempt: "another-attempt" }).pipe(Effect.flip)).reason,
        "payload-changed",
      );
      assert.equal(
        (yield* service.grant({ ...input, payload: { issueNumber: 8 } }).pipe(Effect.flip)).reason,
        "payload-changed",
      );
      yield* h.fs.writeFileString(h.file, "changed");
      assert.equal((yield* service.grant(input).pipe(Effect.flip)).reason, "artifact-changed");
      assert.lengthOf(yield* outboxRows, 0);
      assert.deepEqual(h.host.posts, []);
    }),
  ),
);

it.effect(
  "artifact grants are single-live per destination, and command replay ignores later file changes",
  () =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        const prepared = yield* prepareArtifact();
        const first = yield* grantArtifact({
          expectedPayloadDigest: prepared.payloadDigest,
          attempt: prepared.attempt,
        });
        assert.deepEqual((yield* prepareArtifact()).existing, first);
        assert.equal(
          (yield* grantArtifact({ commandId: "duplicate" }).pipe(Effect.flip)).reason,
          "already-delivering",
        );
        yield* TestClock.adjust("1 second");
        const second = yield* grantArtifact({ commandId: "second", payload: { issueNumber: 8 } });
        assert.notEqual(second.id, first.id);
        const service = yield* Delivery.FactoryDeliveryService;
        assert.deepEqual((yield* service.read({ projectId, threadId: artifactThread })).intents, [
          second,
          first,
        ]);
        yield* h.fs.writeFileString(h.file, "changed after grant");
        const replay = yield* service.grant({
          projectId,
          threadId: artifactThread,
          kind: "publish-artifact",
          commandId: "artifact-grant",
          expectedArtifactSha256: prepared.artifactSha256,
          expectedPayloadDigest: prepared.payloadDigest,
          attempt: prepared.attempt,
          payload: prepared.payload,
        });
        assert.deepEqual(replay, first);
        assert.lengthOf(yield* outboxRows, 2);
        assert.deepEqual(h.host.posts, []);
      }),
    ),
);

it.effect(
  "the effect worker sends the frozen artifact body once and confirms its comment remote",
  () =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        const granted = yield* grantArtifact();
        if (granted.kind !== "publish-artifact")
          return yield* Effect.die("expected artifact intent");
        yield* h.fs.remove(h.folder, { recursive: true });
        h.state.origin = "https://github.com/other/repo.git";
        assert.equal(yield* drain, 1);
        assert.deepEqual(h.host.posts, [
          {
            cwd: "/repo",
            host: "github.com",
            repository: "owner/repo",
            number: 7,
            body: granted.body,
          },
        ]);
        const store = yield* DeliveryStore.FactoryDeliveryStore;
        const settled = Option.getOrThrow(yield* store.get(granted.id));
        assert.equal(settled.status, "confirmed");
        assert.deepEqual(settled.remote, {
          commentId: 91,
          url: "https://github.com/owner/repo/issues/7#issuecomment-91",
        });
        assert.equal(settled.failure, null);
        assert.equal(yield* drain, 0);
        yield* (yield* Delivery.FactoryDeliveryService).execute(granted.id);
        assert.lengthOf(h.host.posts, 1);
        assert.deepEqual(h.state.calls, []);
        assert.deepEqual(h.state.links, []);
        const queued = Option.getOrThrow(
          yield* (yield* EffectOutbox.EffectOutboxV2).get(`${granted.id}:execute`),
        );
        assert.equal(queued.status, "succeeded");
      }),
    ),
);

it.effect.each([
  { send: "definite", status: "failed" },
  { send: "ambiguous", status: "unknown" },
] as const)(
  "the artifact worker settles $send errors as $status without retry",
  ({ send, status }) =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        h.host.send = send;
        const granted = yield* grantArtifact();
        assert.equal(yield* drain, 1);
        const store = yield* DeliveryStore.FactoryDeliveryStore;
        assert.equal(Option.getOrThrow(yield* store.get(granted.id)).status, status);
        yield* TestClock.adjust("1 hour");
        assert.equal(yield* drain, 0);
        yield* (yield* Delivery.FactoryDeliveryService).execute(granted.id);
        assert.lengthOf(h.host.posts, 1);
      }),
    ),
);

it.effect("startup recovery changes a sending artifact to unknown before execution", () => {
  const { layer, state } = harness({ seedArtifactSending: true });
  return Effect.gen(function* () {
    const store = yield* DeliveryStore.FactoryDeliveryStore;
    const recovered = Option.getOrThrow(yield* store.get("delivery:artifact-seeded"));
    assert.equal(recovered.status, "unknown");
    assert.equal(recovered.failure, "server restarted during send");
    yield* (yield* Delivery.FactoryDeliveryService).execute(recovered.id);
    assert.deepEqual(state.calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "artifact reconciliation walks all pages, preserves failed reads and confirms the whole body without a folder",
  () =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        h.host.send = "ambiguous";
        const granted = yield* grantArtifact();
        if (granted.kind !== "publish-artifact")
          return yield* Effect.die("expected artifact intent");
        yield* drain;
        yield* h.fs.remove(h.folder, { recursive: true });
        const service = yield* Delivery.FactoryDeliveryService;
        const request = { projectId, intentId: granted.id };
        const unknown = Option.getOrThrow(
          yield* (yield* DeliveryStore.FactoryDeliveryStore).get(granted.id),
        );
        h.host.listings = [
          {
            comments: [{ id: 1, body: "unrelated", url: "https://github.com/comment/1" }],
            nextPage: 2,
          },
        ];
        h.host.failPage = 2;
        h.host.listingFailure = "truncated-response";
        const truncated = yield* service.reconcile(request);
        assert.equal(truncated.status, unknown.status);
        assert.equal(truncated.failure, "github failed in listIssueComments: fixture response");
        assert.deepEqual(h.host.pages, [1, 2]);
        h.host.pages.length = 0;
        h.host.listingFailure = "failed";
        const unread = yield* service.reconcile(request);
        assert.equal(unread.status, unknown.status);
        assert.equal(unread.failure, "github failed in listIssueComments: fixture response");
        h.host.listingFailure = null;
        h.host.listings = [];
        h.host.pages.length = 0;
        const released = yield* service.reconcile(request);
        assert.equal(released.status, "failed");
        assert.deepEqual(h.host.pages, [1]);
        h.host.pages.length = 0;
        // The host stores the comment with CRLF line endings and trailing whitespace.
        h.host.listings = [
          {
            comments: [{ id: 3, body: "unrelated", url: "https://github.com/comment/3" }],
            nextPage: 2,
          },
          {
            comments: [
              {
                id: 92,
                body: `${granted.body.replaceAll("\n", "  \r\n")}\r\n\r\n`,
                url: "https://github.com/owner/repo/issues/7#issuecomment-92",
              },
            ],
            nextPage: null,
          },
        ];
        const confirmed = yield* service.reconcile(request);
        assert.equal(confirmed.status, "confirmed");
        assert.deepEqual(confirmed.remote, {
          commentId: 92,
          url: "https://github.com/owner/repo/issues/7#issuecomment-92",
        });
        assert.deepEqual(h.host.pages, [1, 2]);
        assert.lengthOf(h.host.posts, 1);
        assert.deepEqual(h.state.calls, []);
      }),
    ),
);

it.effect.each([
  "shifted-marker",
  "shifted-ids",
  "later-marker",
  "interior-ids",
  "stable",
] as const)(
  "artifact reconciliation verifies prefix pages after a multi-page walk: %s",
  (scenario) =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        h.host.send = "ambiguous";
        const granted = yield* grantArtifact();
        if (granted.kind !== "publish-artifact")
          return yield* Effect.die("expected artifact intent");
        yield* drain;
        const comment = (id: number, body = "unrelated"): TrackerIssueComment => ({
          id,
          body,
          url: `https://github.com/owner/repo/issues/7#issuecomment-${id}`,
        });
        const page1 = { comments: [comment(1), comment(2)], nextPage: 2 };
        const page2 = { comments: [comment(4), comment(5), comment(7)], nextPage: 3 };
        // Deleting comment 1 shifts comment 3 left, out of page 2 before it is read.
        h.host.listingResponses = [
          page1,
          page2,
          { comments: [comment(8)], nextPage: null },
          scenario !== "shifted-marker" && scenario !== "shifted-ids"
            ? page1
            : {
                comments: [
                  comment(2),
                  comment(3, scenario === "shifted-marker" ? granted.body : "unrelated"),
                ],
                nextPage: 2,
              },
          scenario === "later-marker"
            ? { ...page2, comments: [comment(4), comment(5, granted.body), comment(7)] }
            : scenario === "interior-ids"
              ? { ...page2, comments: [comment(4), comment(6), comment(7)] }
              : page2,
        ];
        const reconciled = yield* (yield* Delivery.FactoryDeliveryService).reconcile({
          projectId,
          intentId: granted.id,
        });
        assert.equal(
          reconciled.status,
          scenario === "shifted-marker" || scenario === "later-marker"
            ? "confirmed"
            : scenario === "shifted-ids" || scenario === "interior-ids"
              ? "unknown"
              : "failed",
        );
        assert.equal(
          reconciled.failure,
          scenario === "shifted-marker" || scenario === "later-marker"
            ? null
            : scenario === "shifted-ids" || scenario === "interior-ids"
              ? "Comment listing changed during reconciliation; reconcile again."
              : "no matching artifact comment found",
        );
        assert.deepEqual(
          reconciled.remote,
          scenario === "shifted-marker"
            ? { commentId: 3, url: comment(3).url }
            : scenario === "later-marker"
              ? { commentId: 5, url: comment(5).url }
              : null,
        );
        assert.deepEqual(
          h.host.pages,
          scenario === "shifted-marker" || scenario === "shifted-ids"
            ? [1, 2, 3, 1]
            : [1, 2, 3, 1, 2],
        );
        assert.lengthOf(h.host.posts, 1);
      }),
    ),
);

it.effect.each([1, 2])(
  "artifact reconciliation confirms an exact marker despite an unreliable next page: %s",
  (nextPage) =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        h.host.send = "ambiguous";
        const granted = yield* grantArtifact();
        if (granted.kind !== "publish-artifact")
          return yield* Effect.die("expected artifact intent");
        yield* drain;
        const remote = {
          commentId: 92,
          url: "https://github.com/owner/repo/issues/7#issuecomment-92",
        };
        h.host.listings = [
          {
            comments: [{ id: remote.commentId, url: remote.url, body: granted.body }],
            nextPage,
          },
        ];
        h.host.failPage = 2;
        h.host.listingFailure = "failed";
        const reconciled = yield* (yield* Delivery.FactoryDeliveryService).reconcile({
          projectId,
          intentId: granted.id,
        });
        assert.equal(reconciled.status, "confirmed");
        assert.deepEqual(reconciled.remote, remote);
        assert.deepEqual(h.host.pages, [1]);
      }),
    ),
);

it.effect.each([
  "empty-page",
  "backward-page",
  "skipped-page",
  "reversed-ids",
  "duplicate-ids",
  "overlapping-ids",
  "verification-error",
] as const)("artifact reconciliation preserves unknown on an inconclusive %s", (scenario) =>
  withArtifact((h) =>
    Effect.gen(function* () {
      yield* acceptArtifact(h);
      h.host.send = "ambiguous";
      const granted = yield* grantArtifact();
      yield* drain;
      h.host.listings = [
        {
          comments: (scenario === "reversed-ids"
            ? [2, 1]
            : scenario === "duplicate-ids"
              ? [1, 1]
              : [1]
          ).map((id) => ({ id, body: "unrelated", url: `https://github.com/comment/${id}` })),
          nextPage: scenario === "skipped-page" ? 3 : 2,
        },
        {
          comments:
            scenario === "empty-page"
              ? []
              : [
                  {
                    id: scenario === "overlapping-ids" ? 1 : 2,
                    body: "unrelated",
                    url: "https://github.com/comment/2",
                  },
                ],
          nextPage: scenario === "backward-page" ? 1 : null,
        },
      ];
      if (scenario === "verification-error") {
        h.host.listingFailure = "failed";
        h.host.failRead = 3;
      }
      const reconciled = yield* (yield* Delivery.FactoryDeliveryService).reconcile({
        projectId,
        intentId: granted.id,
      });
      assert.equal(reconciled.status, "unknown");
      assert.isNull(reconciled.remote);
      if (scenario === "verification-error") {
        assert.equal(reconciled.failure, "github failed in listIssueComments: fixture response");
        assert.deepEqual(h.host.pages, [1, 2, 1]);
      } else {
        assert.equal(
          reconciled.failure,
          "Comment listing did not advance cleanly; reconcile again.",
        );
      }
    }),
  ),
);

it.effect.each(["pending", "confirmed"] as const)(
  "late artifact discovery preserves a %s replacement and records the old comment",
  (status) =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        h.host.send = "ambiguous";
        const first = yield* grantArtifact({ commandId: "grant-a" });
        if (first.kind !== "publish-artifact") return yield* Effect.die("expected artifact intent");
        yield* drain;
        const service = yield* Delivery.FactoryDeliveryService;
        const store = yield* DeliveryStore.FactoryDeliveryStore;
        assert.equal(
          (yield* service.reconcile({ projectId, intentId: first.id })).status,
          "failed",
        );
        h.host.send = "ok";
        const replacement = yield* grantArtifact({ commandId: "grant-b" });
        if (status === "confirmed") yield* drain;
        const before = Option.getOrThrow(yield* store.get(replacement.id));
        assert.equal(before.status, status);
        const remote = {
          commentId: 92,
          url: "https://github.com/owner/repo/issues/7#issuecomment-92",
        };
        h.host.listings = [
          {
            comments: [{ id: remote.commentId, url: remote.url, body: first.body }],
            nextPage: null,
          },
        ];
        const reconciled = yield* service.reconcile({ projectId, intentId: first.id });
        assert.equal(reconciled.status, "failed");
        assert.deepEqual(reconciled.remote, remote);
        assert.equal(
          reconciled.failure,
          `Remote delivery found, but replacement delivery ${replacement.id} already holds the live slot.`,
        );
        assert.deepEqual(Option.getOrThrow(yield* store.get(first.id)), reconciled);
        assert.deepEqual(Option.getOrThrow(yield* store.get(replacement.id)), before);
        assert.deepEqual(
          Option.getOrThrow(yield* store.getLiveArtifact(first.originKey, first.destinationKey)),
          before,
        );
      }),
    ),
);

it.effect(
  "artifact reconciliation adopts an edited comment by its marker line but not a quoted marker",
  () =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        h.host.send = "ambiguous";
        const granted = yield* grantArtifact();
        if (granted.kind !== "publish-artifact")
          return yield* Effect.die("expected artifact intent");
        yield* drain;
        const service = yield* Delivery.FactoryDeliveryService;
        const marker = artifactDeliveryMarker(granted.body.match(/attempt=(\S+) -->/)![1]!);
        assert.include(granted.body, marker);
        const quoted = {
          id: 5,
          body: `> quoting someone: ${marker}`,
          url: "https://github.com/owner/repo/issues/7#issuecomment-5",
        };
        h.host.listings = [{ comments: [quoted], nextPage: null }];
        const unmatched = yield* service.reconcile({ projectId, intentId: granted.id });
        assert.equal(unmatched.status, "failed");
        assert.isNull(unmatched.remote);
        // A maintainer appended a note to the real comment; the delivery is still that comment.
        h.host.listings = [
          {
            comments: [
              quoted,
              {
                id: 6,
                body: `${granted.body}\n\nEdited by a maintainer.`,
                url: "https://github.com/owner/repo/issues/7#issuecomment-6",
              },
            ],
            nextPage: null,
          },
        ];
        const adopted = yield* service.reconcile({ projectId, intentId: granted.id });
        assert.equal(adopted.status, "confirmed");
        assert.deepEqual(adopted.remote, {
          commentId: 6,
          url: "https://github.com/owner/repo/issues/7#issuecomment-6",
        });
        assert.lengthOf(h.host.posts, 1);
      }),
    ),
);

it.effect("artifact reconciliation ignores public markers quoted by the accepted artifact", () =>
  withArtifact((h) =>
    Effect.gen(function* () {
      const copiedMarker = artifactDeliveryMarker("previous-delivery");
      yield* acceptArtifact(h, `## Findings\n\nQuoted delivery:\n${copiedMarker}`);
      h.host.send = "ambiguous";
      const granted = yield* grantArtifact();
      if (granted.kind !== "publish-artifact") return yield* Effect.die("expected artifact intent");
      yield* drain;
      const service = yield* Delivery.FactoryDeliveryService;
      const oldComment = {
        id: 5,
        body: copiedMarker,
        url: "https://github.com/owner/repo/issues/7#issuecomment-5",
      };
      h.host.listings = [{ comments: [oldComment], nextPage: null }];
      const absent = yield* service.reconcile({ projectId, intentId: granted.id });
      assert.equal(absent.status, "failed");
      assert.isNull(absent.remote);
      h.host.listings = [
        {
          comments: [
            oldComment,
            {
              id: 6,
              body: granted.body,
              url: "https://github.com/owner/repo/issues/7#issuecomment-6",
            },
          ],
          nextPage: null,
        },
      ];
      const present = yield* service.reconcile({ projectId, intentId: granted.id });
      assert.equal(present.status, "confirmed");
      assert.deepEqual(present.remote, {
        commentId: 6,
        url: "https://github.com/owner/repo/issues/7#issuecomment-6",
      });
      assert.lengthOf(h.host.posts, 1);
    }),
  ),
);

it.effect("a failed artifact grant cannot reuse its prepared attempt under a new command", () =>
  withArtifact((h) =>
    Effect.gen(function* () {
      yield* acceptArtifact(h);
      const prepared = yield* prepareArtifact();
      const input = {
        projectId,
        threadId: artifactThread,
        kind: "publish-artifact" as const,
        commandId: "first-attempt-command",
        expectedArtifactSha256: prepared.artifactSha256,
        expectedPayloadDigest: prepared.payloadDigest,
        attempt: prepared.attempt,
        payload: prepared.payload,
      };
      const service = yield* Delivery.FactoryDeliveryService;
      h.host.send = "ambiguous";
      const first = yield* service.grant(input);
      yield* drain;
      const failed = yield* service.reconcile({ projectId, intentId: first.id });
      assert.equal(failed.status, "failed");
      assert.deepEqual(yield* service.grant(input), failed);
      const rejected = yield* service
        .grant({ ...input, commandId: "second-attempt-command" })
        .pipe(Effect.flip);
      assert.equal(rejected.reason, "already-delivering");
      assert.equal(yield* drain, 0);
      const fresh = yield* grantArtifact({ commandId: "fresh-attempt-command" });
      assert.notEqual(fresh.id, first.id);
    }),
  ),
);

it.effect(
  "reconciling a failed grant never confirms it against a later grant's comment for the same destination",
  () =>
    withArtifact((h) =>
      Effect.gen(function* () {
        yield* acceptArtifact(h);
        const service = yield* Delivery.FactoryDeliveryService;
        const store = yield* DeliveryStore.FactoryDeliveryStore;
        h.host.send = "ambiguous";
        const grantedA = yield* grantArtifact({ commandId: "grant-a" });
        yield* drain;
        assert.equal(
          (yield* service.reconcile({ projectId, intentId: grantedA.id })).status,
          "failed",
        );

        h.host.send = "ok";
        const grantedB = yield* grantArtifact({ commandId: "grant-b" });
        if (grantedA.kind !== "publish-artifact" || grantedB.kind !== "publish-artifact")
          return yield* Effect.die("expected artifact intents");
        assert.notEqual(grantedB.body, grantedA.body);
        assert.equal(grantedB.acceptanceId, grantedA.acceptanceId);
        assert.equal(grantedB.destinationKey, grantedA.destinationKey);
        assert.equal(yield* drain, 1);
        assert.equal(Option.getOrThrow(yield* store.get(grantedB.id)).status, "confirmed");
        assert.lengthOf(h.host.posts, 2);

        h.host.listings = [
          {
            comments: [
              {
                id: 91,
                body: h.host.posts[1]!.body,
                url: "https://github.com/owner/repo/issues/7#issuecomment-91",
              },
            ],
            nextPage: null,
          },
        ];
        const reconciled = yield* service.reconcile({ projectId, intentId: grantedA.id });
        assert.equal(reconciled.status, "failed");
        assert.isNull(reconciled.remote);
        const stored = Option.getOrThrow(yield* store.get(grantedA.id));
        assert.equal(stored.status, "failed");
        assert.isNull(stored.remote);
      }),
    ),
);
