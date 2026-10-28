import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderError,
  SourceControlProviderKind,
  ThreadId,
  type FactoryDeliveryPayload,
} from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as GitManager from "../git/GitManager.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as AcceptanceStore from "../persistence/FactoryAcceptanceStore.ts";
import * as DeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import { type FactoryLaunchIntent } from "../persistence/FactoryIssueLaunches.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Acceptance from "./FactoryAcceptanceService.ts";
import * as Delivery from "./FactoryDeliveryService.ts";
import { githubIssueOriginKey } from "./FactoryOriginKey.ts";

const at = "2026-10-27T00:00:00.000Z";
const environmentId = EnvironmentId.make("claim-holder");
const projectId = ProjectId.make("project");
const claimed = ThreadId.make("claimed");
const unclaimed = ThreadId.make("unclaimed");
const first = "1".repeat(40);
const second = "2".repeat(40);
const base = "b".repeat(40);
const payload: FactoryDeliveryPayload = { title: "Fix the thing", body: "Details", draft: false };
const pullRequest = { number: 12, url: "https://github.com/owner/repo/pull/12" };

const intent: FactoryLaunchIntent = {
  repository: {
    provider: "github",
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
  baseRef: "main",
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

const harness = (options: { readonly seedSending?: boolean } = {}) => {
  const state = {
    head: first,
    open: Option.none<typeof pullRequest>(),
    push: "ok" as "ok" | "fail",
    create: "ok" as "ok" | "definite" | "ambiguous",
    calls: [] as string[],
    links: [] as unknown[],
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
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: (input) => {
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
        revision === "HEAD^{commit}" ? state.head : revision === "main^{commit}" ? base : null;
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
  const dependencies = Layer.mergeAll(
    Sqlite.layerMemory,
    git,
    NodeCrypto.layer,
    NodeServices.layer,
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(GitManager.GitManager)({
      findOpenPullRequestForHead: () =>
        Effect.succeed({ headSelector: "feature", open: state.open }),
      invalidateStatus: () => Effect.void,
    }),
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
      resolve: () => Effect.succeed(provider),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          ...liveThreadShell(id),
          projectId,
          worktreePath: id === unclaimed ? null : "/worktree",
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
    Acceptance.layer.pipe(Layer.provide(AcceptanceStore.layer)),
  ).pipe(Layer.provideMerge(dependencies));
  // Seeded after the stores exist and before the service is built, the order startup recovery
  // relies on.
  const seed = Layer.effectDiscard(
    Effect.gen(function* () {
      if (options.seedSending !== true) return;
      const store = yield* DeliveryStore.FactoryDeliveryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key)
        VALUES (${claimed}, ${intent.repository.canonicalKey}, 7, ${intent.requestCommandId}, ${JSON.stringify(intent)},
          ${githubIssueOriginKey(intent.repository.canonicalKey, 7)})`;
      yield* store.grant(
        {
          id: "delivery:seeded",
          originKey: githubIssueOriginKey(intent.repository.canonicalKey, 7),
          threadId: claimed,
          projectId,
          kind: "publish-pr",
          acceptanceId: "acceptance:seeded",
          repository: intent.repository,
          baseRef: "main",
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
  const layer =
    options.seedSending === true ? recovering : Delivery.layer.pipe(Layer.provideMerge(stores));
  return { state, layer };
};

const seedClaim = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key)
    VALUES (${claimed}, ${intent.repository.canonicalKey}, 7, ${intent.requestCommandId}, ${JSON.stringify(intent)},
      ${githubIssueOriginKey(intent.repository.canonicalKey, 7)})`;
});
const accept = Effect.gen(function* () {
  yield* seedClaim;
  return yield* (yield* Acceptance.FactoryAcceptanceService).acceptCommit({
    projectId,
    threadId: claimed,
    expectedHeadSha: first,
    evidenceRefs: [],
  });
});
const prepare = (threadId: ThreadId = claimed) =>
  Effect.flatMap(Delivery.FactoryDeliveryService, (service) =>
    service.prepare({ projectId, threadId, kind: "publish-pr", payload }),
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
      yield* seedClaim;
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
      assert.equal(prepared.baseRef, "main");
      assert.equal(prepared.existing, null);
      assert.equal(
        prepared.payloadDigest,
        Delivery.deliveryPayloadDigest({
          kind: "publish-pr",
          repository: intent.repository,
          baseRef: "main",
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
        baseRef: "main",
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
  "reconciling an unknown intent releases the origin, then adopts the PR once it shows",
  () => {
    const { state, layer } = harness();
    return Effect.gen(function* () {
      yield* accept;
      const service = yield* Delivery.FactoryDeliveryService;
      state.create = "ambiguous";
      const granted = yield* executeGranted();
      state.calls.length = 0;

      // The forge answered and showed nothing: the send did not land, so the intent fails instead
      // of staying `unknown` forever. A failed intent is still reconcilable once the PR shows.
      const released = yield* service.reconcile({ projectId, intentId: granted.id });
      assert.equal(released.status, "failed");
      assert.equal(released.failure, "no open pull request found for this head");

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

it.effect("a reconciled-away unknown intent frees the origin for a new grant", () => {
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
    const regrant = yield* grant({ commandId: "grant-after-release" });
    assert.equal(regrant.status, "pending");
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
