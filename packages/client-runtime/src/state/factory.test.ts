import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  CommandId,
  EnvironmentId,
  FactoryFeedSourceId,
  FactoryIssueError,
  FactoryOriginKey,
  FactoryResearchError,
  FactoryResearchProtocolId,
  FactoryReadinessOverrideId,
  ProjectCoordinatorError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type FactoryAcceptCommitInput,
  type FactoryClaimListInput,
  type FactoryClaimListResult,
  type FactoryFeedCandidate,
  type FactoryFeedCandidateAdmitInput,
  type FactoryFeedCandidateDismissInput,
  type FactoryFeedSource,
  type FactoryFeedSourceBindInput,
  type FactoryFeedSourceRefreshInput,
  type FactoryFeedSourceUnbindInput,
  type FactoryIssueFrontierReadInput,
  type FactoryIssueFrontierReadResult,
  type FactoryIssueReadinessReadInput,
  type FactoryIssueReadinessReadResult,
  type FactoryIssueTask,
  type FactoryReadinessOverrideRevokeInput,
  type FactoryReadinessOverrideSetInput,
  type FactoryResearchFinding,
  type FactoryResearchImplementationAdmitInput,
  type FactoryResearchProtocol,
  type FactoryResearchProtocolListInput,
  type FactoryResearchProtocolReadInput,
  type FactoryResearchProtocolReadResult,
  type FactoryResearchProtocolSealInput,
  type FactoryResearchRunLaunchInput,
  type ProjectCoordinator,
  type ProjectCoordinatorEnsureInput,
  type ProjectCoordinatorGetInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";

import { createFactoryEnvironmentAtoms, factoryIssueReviewText } from "./factory.ts";

describe("Factory source review text", () => {
  it("keeps full source, whitespace and HTML comments beyond row preview limits", () => {
    const source = `  <!-- task data -->\n${"x".repeat(65_536)}\n  `;
    expect(factoryIssueReviewText(source)).toBe(source);
  });

  it("preserves tabs and blank lines while exposing carriage returns", () => {
    expect(factoryIssueReviewText("\t A\r\n\n\n B \t")).toBe("\t A\\u000d\n\n\n B \t");
  });

  it("exposes bidi, astral formatting and lone surrogates without losing code units", () => {
    expect(factoryIssueReviewText("a\u202e\u{e0061}\ud800z")).toBe(
      "a\\u202e\\udb40\\udc61\\ud800z",
    );
  });

  it("distinguishes literal backslash escapes from actual hidden characters", () => {
    expect(factoryIssueReviewText("\\u202e\u202e")).toBe("\\\\u202e\\u202e");
  });
});

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));

const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);
const environmentId = EnvironmentId.make("factory-environment");
const otherEnvironmentId = EnvironmentId.make("other-factory-environment");
const projectId = ProjectId.make("factory-project");
const fetchedAt = "2026-10-24T00:00:00.000Z";

function sessionWith(permissions: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: permissions,
    permissions,
  };
}

function ensureInput(command: string): ProjectCoordinatorEnsureInput {
  return {
    commandId: CommandId.make(command),
    projectId,
    expectedThreadId: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  };
}

const makeEnvironmentHarness = Effect.fn("TestFactory.makeEnvironmentHarness")(function* (
  clientFor: (id: EnvironmentId) => Record<string, unknown>,
  grants: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationOperateScope],
) {
  const makeSupervisor = Effect.fn("TestFactory.makeSupervisor")(function* (id: EnvironmentId) {
    const rpcSession = { client: clientFor(id) } as unknown as RpcSession;
    return EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId: id,
        label: id,
        httpBaseUrl: "https://factory.example.test",
        wsBaseUrl: "wss://factory.example.test",
      }),
      session: yield* SubscriptionRef.make(Option.some(rpcSession)),
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      }),
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  });
  const main = yield* makeSupervisor(environmentId);
  const other = yield* makeSupervisor(otherEnvironmentId);
  const supervisorFor = (id: EnvironmentId) => (id === otherEnvironmentId ? other : main);
  const service = {
    run: (id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisorFor(id)),
    followStream: (id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisorFor(id)),
  } as EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, service));
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  for (const id of [environmentId, otherEnvironmentId]) {
    registry.mount(sessions(id));
    registry.set(sessions(id), AsyncResult.success(sessionWith(grants)));
  }
  return { atoms: createFactoryEnvironmentAtoms(runtime), registry };
});

const makeCoordinatorHarness = Effect.fn("TestFactory.makeCoordinatorHarness")(function* (
  failAfterBinding = false,
) {
  const entered = yield* Queue.unbounded<{
    environmentId: EnvironmentId;
    input: ProjectCoordinatorEnsureInput;
  }>();
  const release = yield* Deferred.make<void>();
  const calls: ProjectCoordinatorEnsureInput[] = [];
  const bindings = new Map<string, ProjectCoordinator>();
  const bindingKey = (id: EnvironmentId, project: ProjectId) => JSON.stringify([id, project]);
  const h = yield* makeEnvironmentHarness((id) => ({
    [WS_METHODS.projectCoordinatorsGet]: (input: ProjectCoordinatorGetInput) =>
      Effect.sync(() => ({
        coordinator: bindings.get(bindingKey(id, input.projectId)) ?? null,
        fetchedAt,
      })),
    [WS_METHODS.projectCoordinatorsList]: () =>
      Effect.sync(() => ({
        coordinators: [...bindings.values()].filter(
          (coordinator) => bindings.get(bindingKey(id, coordinator.projectId)) === coordinator,
        ),
        fetchedAt,
      })),
    [WS_METHODS.projectCoordinatorsEnsure]: (input: ProjectCoordinatorEnsureInput) =>
      Effect.gen(function* () {
        calls.push(input);
        yield* Queue.offer(entered, { environmentId: id, input });
        yield* Deferred.await(release);
        const coordinator: ProjectCoordinator = {
          projectId: input.projectId,
          threadId: ThreadId.make(`thread-${input.commandId}`),
          status: "running",
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdAt: fetchedAt,
          current: true,
        };
        bindings.set(bindingKey(id, input.projectId), coordinator);
        if (failAfterBinding) {
          return yield* new ProjectCoordinatorError({ reason: "launch-failed" });
        }
        return { coordinator, resumed: false };
      }),
  }));
  return { ...h, entered, release, calls };
});

describe("Factory coordinator commands", () => {
  it.effect(
    "coalesces one reviewed binding without conflating environments, projects or generations",
    () =>
      Effect.gen(function* () {
        const h = yield* makeCoordinatorHarness();
        const targets: Array<{
          environmentId: EnvironmentId;
          input: ProjectCoordinatorEnsureInput;
        }> = [
          { environmentId, input: ensureInput("first") },
          {
            environmentId,
            input: { ...ensureInput("duplicate"), runtimeMode: "full-access" },
          },
          { environmentId: otherEnvironmentId, input: ensureInput("other-environment") },
          {
            environmentId,
            input: { ...ensureInput("other-project"), projectId: ProjectId.make("other-project") },
          },
          {
            environmentId,
            input: {
              ...ensureInput("replacement"),
              expectedThreadId: ThreadId.make("reviewed-predecessor"),
              replaceRetired: true,
            },
          },
        ];
        const pending = targets.map((value) => h.atoms.coordinatorsEnsure.run(h.registry, value));
        const dispatched = [];
        for (let index = 0; index < 4; index++) dispatched.push(yield* Queue.take(h.entered));
        expect(dispatched.map(({ input }) => input.commandId).sort()).toEqual(
          ["first", "other-environment", "other-project", "replacement"].sort(),
        );
        yield* Deferred.succeed(h.release, undefined);
        const results = yield* Effect.promise(() => Promise.all(pending));
        expect(results.every(AsyncResult.isSuccess)).toBe(true);
        expect(results[1]).toEqual(results[0]);
        expect(h.calls).toHaveLength(4);
        expect(h.calls.find((input) => input.commandId === "first")?.runtimeMode).toBe(
          "approval-required",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("requires the destination operate grant, but no source-control-write grant", () =>
    Effect.gen(function* () {
      const h = yield* makeCoordinatorHarness();
      h.registry.set(
        sessions(otherEnvironmentId),
        AsyncResult.success(sessionWith([AuthOrchestrationReadScope, AuthSourceControlWriteScope])),
      );
      const command = h.atoms.coordinatorsEnsure;
      expect(h.registry.get(command.permissionAtom(environmentId))).toBe(true);
      expect(h.registry.get(command.permissionAtom(otherEnvironmentId))).toBe(false);
      const denied = yield* Effect.promise(() =>
        command.run(h.registry, {
          environmentId: otherEnvironmentId,
          input: ensureInput("denied"),
        }),
      );
      expect(AsyncResult.isFailure(denied)).toBe(true);
      if (AsyncResult.isFailure(denied)) {
        expect(Cause.squash(denied.cause)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationOperateScope,
        });
      }
      expect(h.calls).toHaveLength(0);
      yield* Deferred.succeed(h.release, undefined);
      const accepted = yield* Effect.promise(() =>
        command.run(h.registry, { environmentId, input: ensureInput("accepted") }),
      );
      expect(AsyncResult.isSuccess(accepted)).toBe(true);
      h.registry.set(sessions(environmentId), AsyncResult.success(sessionWith([])));
      const revoked = yield* Effect.promise(() =>
        command.run(h.registry, { environmentId, input: ensureInput("after-revocation") }),
      );
      expect(AsyncResult.isFailure(revoked)).toBe(true);
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "refreshes mounted reads even if a persisted launch has an ambiguous failure: %s",
    (failAfterBinding) =>
      Effect.gen(function* () {
        const h = yield* makeCoordinatorHarness(failAfterBinding);
        const get = h.atoms.coordinatorsGet({ environmentId, input: { projectId } });
        const list = h.atoms.coordinatorsList({ environmentId, input: {} });
        yield* AtomRegistry.mount(h.registry, get);
        yield* AtomRegistry.mount(h.registry, list);
        const beforeGet = yield* AtomRegistry.getResult(h.registry, get, {
          suspendOnWaiting: true,
        });
        const beforeList = yield* AtomRegistry.getResult(h.registry, list, {
          suspendOnWaiting: true,
        });
        expect(beforeGet.coordinator).toBeNull();
        expect(beforeList.coordinators).toEqual([]);
        const pending = h.atoms.coordinatorsEnsure.run(h.registry, {
          environmentId,
          input: ensureInput("refresh"),
        });
        yield* Queue.take(h.entered);
        yield* Deferred.succeed(h.release, undefined);
        const result = yield* Effect.promise(() => pending);
        expect(AsyncResult.isFailure(result)).toBe(failAfterBinding);
        const afterGet = yield* AtomRegistry.getResult(h.registry, get, { suspendOnWaiting: true });
        const afterList = yield* AtomRegistry.getResult(h.registry, list, {
          suspendOnWaiting: true,
        });
        expect(afterGet.coordinator?.threadId).toBe("thread-refresh");
        expect(afterList.coordinators.map((coordinator) => coordinator.threadId)).toEqual([
          "thread-refresh",
        ]);
      }).pipe(Effect.scoped),
  );
});

type FeedCall = {
  readonly method: string;
  readonly environmentId: EnvironmentId;
  readonly input: unknown;
};

const feedSourceId = FactoryFeedSourceId.make("feed-source");
const feedItemKey = "guid:item-1";
const feedSource: FactoryFeedSource = {
  id: feedSourceId,
  projectId,
  locator: "https://feeds.example.test/tasks.xml",
  title: "Task feed",
  status: "active",
  createdAt: fetchedAt,
  lastCheckedAt: fetchedAt,
  nextAllowedAt: null,
  lastError: null,
};
const feedCandidate: FactoryFeedCandidate = {
  sourceId: feedSourceId,
  itemKey: feedItemKey,
  title: "Add a README",
  content: "<p>Write one.</p>",
  link: "https://feeds.example.test/items/1",
  publishedAt: fetchedAt,
  revision: "revision-1",
  ordinal: 1,
  firstSeenAt: fetchedAt,
  lastSeenAt: fetchedAt,
  inWindow: true,
  disposition: "open",
  dismissalNote: null,
  forgeReference: null,
  task: null,
};

function admitInput(command: string, overrides: Partial<FactoryFeedCandidateAdmitInput> = {}) {
  const input: FactoryFeedCandidateAdmitInput = {
    commandId: CommandId.make(command),
    projectId,
    expectedRepositoryKey: "github.com/example/repo",
    sourceId: feedSourceId,
    itemKey: feedItemKey,
    expectedRevision: "revision-1",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...overrides,
  };
  return input;
}

const makeFeedHarness = Effect.fn("TestFactory.makeFeedHarness")(function* (
  grants: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationOperateScope],
) {
  const entered = yield* Queue.unbounded<FeedCall>();
  const release = yield* Deferred.make<void>();
  const calls: FeedCall[] = [];
  // Reads answer immediately; commands hold until the test releases them so overlap is observable.
  const read =
    (environment: EnvironmentId, method: string, respond: (input: never) => unknown) =>
    (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method, environmentId: environment, input });
        return respond(input as never);
      });
  const held =
    (environment: EnvironmentId, method: string, respond: (input: never) => unknown) =>
    (input: unknown) =>
      Effect.gen(function* () {
        const call = { method, environmentId: environment, input };
        calls.push(call);
        yield* Queue.offer(entered, call);
        yield* Deferred.await(release);
        return respond(input as never);
      });
  const sourceResult = { source: feedSource, observed: 0, notModified: true };
  const h = yield* makeEnvironmentHarness(
    (id) => ({
      [WS_METHODS.factoryListFeedSources]: read(id, WS_METHODS.factoryListFeedSources, () => ({
        sources: [feedSource],
      })),
      [WS_METHODS.factoryListFeedCandidates]: read(
        id,
        WS_METHODS.factoryListFeedCandidates,
        () => ({ repository: null, candidates: [feedCandidate], fetchedAt }),
      ),
      [WS_METHODS.factoryReadFeedCandidate]: read(id, WS_METHODS.factoryReadFeedCandidate, () => ({
        repository: null,
        source: feedSource,
        candidate: feedCandidate,
        fetchedAt,
      })),
      [WS_METHODS.factoryBindFeedSource]: held(
        id,
        WS_METHODS.factoryBindFeedSource,
        () => sourceResult,
      ),
      [WS_METHODS.factoryUnbindFeedSource]: held(
        id,
        WS_METHODS.factoryUnbindFeedSource,
        () => sourceResult,
      ),
      [WS_METHODS.factoryRefreshFeedSource]: held(
        id,
        WS_METHODS.factoryRefreshFeedSource,
        () => sourceResult,
      ),
      [WS_METHODS.factorySetFeedCandidateDismissed]: held(
        id,
        WS_METHODS.factorySetFeedCandidateDismissed,
        () => ({ candidate: feedCandidate }),
      ),
      [WS_METHODS.factoryAdmitFeedCandidate]: held(
        id,
        WS_METHODS.factoryAdmitFeedCandidate,
        (input: FactoryFeedCandidateAdmitInput) => ({ threadId: `thread-${input.commandId}` }),
      ),
    }),
    grants,
  );
  return { ...h, entered, release, calls };
});

describe("Factory feed queries", () => {
  it.effect("reads sources, candidates and one candidate through their own methods", () =>
    Effect.gen(function* () {
      const h = yield* makeFeedHarness();
      const sources = h.atoms.listFeedSources({ environmentId, input: { projectId } });
      const candidates = h.atoms.listFeedCandidates({
        environmentId,
        input: { projectId, sourceId: feedSourceId, disposition: "all" },
      });
      const candidate = h.atoms.readFeedCandidate({
        environmentId,
        input: { projectId, sourceId: feedSourceId, itemKey: feedItemKey },
      });
      yield* AtomRegistry.mount(h.registry, sources);
      yield* AtomRegistry.mount(h.registry, candidates);
      yield* AtomRegistry.mount(h.registry, candidate);
      const sourceList = yield* AtomRegistry.getResult(h.registry, sources, {
        suspendOnWaiting: true,
      });
      const candidateList = yield* AtomRegistry.getResult(h.registry, candidates, {
        suspendOnWaiting: true,
      });
      const single = yield* AtomRegistry.getResult(h.registry, candidate, {
        suspendOnWaiting: true,
      });
      expect(sourceList.sources).toEqual([feedSource]);
      expect(candidateList.candidates).toEqual([feedCandidate]);
      expect(single.candidate.itemKey).toBe(feedItemKey);
      expect(h.calls.map(({ method }) => method).sort()).toEqual(
        [
          WS_METHODS.factoryListFeedSources,
          WS_METHODS.factoryListFeedCandidates,
          WS_METHODS.factoryReadFeedCandidate,
        ].sort(),
      );
      expect(
        h.calls.find(({ method }) => method === WS_METHODS.factoryListFeedCandidates)?.input,
      ).toEqual({
        projectId,
        sourceId: feedSourceId,
        disposition: "all",
      });
    }).pipe(Effect.scoped),
  );
});

const readinessRepository = {
  provider: "github",
  host: "github.com",
  repository: "example/repo",
  canonicalKey: "github.com/example/repo",
  url: "https://github.com/example/repo",
} as const;

const readinessResult = (
  issueNumber: number,
  observedAt: string,
): FactoryIssueReadinessReadResult => ({
  repository: readinessRepository,
  issueNumber,
  readiness: {
    status: "ready",
    reasons: [],
    basis: "source",
    edges: [],
    overrides: [],
    complete: true,
    listedCount: 0,
    summaryTotal: 0,
    observedAt,
  },
});

const frontierResult = (
  parentIssueNumber: number,
  observedAt: string,
): FactoryIssueFrontierReadResult => ({
  repository: readinessRepository,
  parentIssueNumber,
  parentTitle: "Map",
  complete: true,
  summaryTotal: 0,
  children: [],
  observedAt,
});

describe("Factory issue readiness query", () => {
  it.effect(
    "observes each environment and issue through its own request, and again on refresh",
    () =>
      Effect.gen(function* () {
        const calls: FeedCall[] = [];
        // Read access alone must be enough: readiness is evidence, not a guarded command.
        const h = yield* makeEnvironmentHarness(
          (id) => ({
            [WS_METHODS.factoryReadIssueReadiness]: (input: FactoryIssueReadinessReadInput) =>
              Effect.sync(() => {
                calls.push({
                  method: WS_METHODS.factoryReadIssueReadiness,
                  environmentId: id,
                  input,
                });
                // The call count is the observation time (fewer than ten calls), so a refresh is
                // distinguishable from a cache hit.
                return readinessResult(input.issueNumber, `2026-10-25T12:0${calls.length}:00.000Z`);
              }),
          }),
          [AuthOrchestrationReadScope],
        );
        const target = { environmentId, input: { projectId, issueNumber: 12 } };
        const issue = h.atoms.readIssueReadiness(target);
        expect(h.atoms.readIssueReadiness(target)).toBe(issue);
        const otherIssue = h.atoms.readIssueReadiness({
          environmentId,
          input: { projectId, issueNumber: 13 },
        });
        const otherEnvironment = h.atoms.readIssueReadiness({
          environmentId: otherEnvironmentId,
          input: target.input,
        });
        for (const atom of [issue, otherIssue, otherEnvironment]) {
          yield* AtomRegistry.mount(h.registry, atom);
          yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
        }
        expect(calls).toEqual([
          { method: WS_METHODS.factoryReadIssueReadiness, environmentId, input: target.input },
          {
            method: WS_METHODS.factoryReadIssueReadiness,
            environmentId,
            input: { projectId, issueNumber: 13 },
          },
          {
            method: WS_METHODS.factoryReadIssueReadiness,
            environmentId: otherEnvironmentId,
            input: target.input,
          },
        ]);

        const first = yield* AtomRegistry.getResult(h.registry, issue, { suspendOnWaiting: true });
        expect(first.issueNumber).toBe(12);
        expect(calls).toHaveLength(3);
        h.registry.refresh(issue);
        const second = yield* AtomRegistry.getResult(h.registry, issue, { suspendOnWaiting: true });
        expect(calls).toHaveLength(4);
        expect(calls[3]).toEqual(calls[0]);
        expect(second.readiness.observedAt).not.toBe(first.readiness.observedAt);
      }).pipe(Effect.scoped),
  );
});

const claimsResult = (environment: EnvironmentId, observedAt: string): FactoryClaimListResult => ({
  environmentId: environment,
  repository: readinessRepository,
  claims: [
    {
      originKey: FactoryOriginKey.make("github:github.com/example/repo#12"),
      origin: "github-issue",
      projectId,
      workspaceRoot: "/work/repo",
      threadId: ThreadId.make("claim-thread"),
      status: "running",
      baseRef: "main",
      createdAt: fetchedAt,
      creationSource: "web",
      admittedBy: environment,
      originConflict: false,
      acceptance: null,
    },
  ],
  fetchedAt: observedAt,
});

describe("Factory claims query", () => {
  it.effect(
    "reads each environment's claims through its own request with read access alone, and again on refresh",
    () =>
      Effect.gen(function* () {
        const calls: FeedCall[] = [];
        const h = yield* makeEnvironmentHarness(
          (id) => ({
            [WS_METHODS.factoryListClaims]: (input: FactoryClaimListInput) =>
              Effect.sync(() => {
                calls.push({ method: WS_METHODS.factoryListClaims, environmentId: id, input });
                // The call count is the observation time (fewer than ten calls), so a refresh is
                // distinguishable from a cache hit.
                return claimsResult(id, `2026-10-25T12:0${calls.length}:00.000Z`);
              }),
          }),
          [AuthOrchestrationReadScope],
        );
        const target = { environmentId, input: { projectId } };
        const main = h.atoms.listClaims(target);
        expect(h.atoms.listClaims(target)).toBe(main);
        const other = h.atoms.listClaims({
          environmentId: otherEnvironmentId,
          input: { projectId },
        });
        expect(other).not.toBe(main);
        for (const atom of [main, other]) {
          yield* AtomRegistry.mount(h.registry, atom);
          yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
        }
        expect(calls).toEqual([
          { method: WS_METHODS.factoryListClaims, environmentId, input: { projectId } },
          {
            method: WS_METHODS.factoryListClaims,
            environmentId: otherEnvironmentId,
            input: { projectId },
          },
        ]);

        const first = yield* AtomRegistry.getResult(h.registry, main, { suspendOnWaiting: true });
        expect(first.environmentId).toBe(environmentId);
        expect(first.claims[0]?.admittedBy).toBe(environmentId);
        expect(calls).toHaveLength(2);
        h.registry.refresh(main);
        const second = yield* AtomRegistry.getResult(h.registry, main, { suspendOnWaiting: true });
        expect(calls).toHaveLength(3);
        expect(calls[2]).toEqual(calls[0]);
        expect(second.fetchedAt).not.toBe(first.fetchedAt);
      }).pipe(Effect.scoped),
  );
});

const makeReadinessHarness = Effect.fn("TestFactory.makeReadinessHarness")(function* (
  grants: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationOperateScope],
  failCommands = false,
) {
  const entered = yield* Queue.unbounded<FeedCall>();
  const release = yield* Deferred.make<void>();
  const calls: FeedCall[] = [];
  const read =
    (environment: EnvironmentId, method: string, respond: (input: never) => unknown) =>
    (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method, environmentId: environment, input });
        return respond(input as never);
      });
  // Commands hold until the test releases them so overlap is observable.
  const held =
    (environment: EnvironmentId, method: string) =>
    (input: FactoryReadinessOverrideSetInput | FactoryReadinessOverrideRevokeInput) =>
      Effect.gen(function* () {
        const call = { method, environmentId: environment, input };
        calls.push(call);
        yield* Queue.offer(entered, call);
        yield* Deferred.await(release);
        if (failCommands) return yield* new FactoryIssueError({ reason: "remote-failure" });
        return readinessResult(input.issueNumber, fetchedAt);
      });
  const h = yield* makeEnvironmentHarness(
    (id) => ({
      [WS_METHODS.factoryReadIssueReadiness]: read(
        id,
        WS_METHODS.factoryReadIssueReadiness,
        (input: FactoryIssueReadinessReadInput) => readinessResult(input.issueNumber, fetchedAt),
      ),
      [WS_METHODS.factoryReadIssueFrontier]: read(
        id,
        WS_METHODS.factoryReadIssueFrontier,
        (input: FactoryIssueFrontierReadInput) =>
          frontierResult(input.parentIssueNumber, fetchedAt),
      ),
      [WS_METHODS.factorySetIssueReadinessOverride]: held(
        id,
        WS_METHODS.factorySetIssueReadinessOverride,
      ),
      [WS_METHODS.factoryRevokeIssueReadinessOverride]: held(
        id,
        WS_METHODS.factoryRevokeIssueReadinessOverride,
      ),
    }),
    grants,
  );
  return { ...h, entered, release, calls };
});

function overrideSetTarget(
  command: string,
  overrides: Partial<FactoryReadinessOverrideSetInput> = {},
  targetEnvironmentId: EnvironmentId = environmentId,
) {
  const input: FactoryReadinessOverrideSetInput = {
    commandId: CommandId.make(command),
    projectId,
    issueNumber: 12,
    targetHost: "github.com",
    targetId: 7007,
    expectedFingerprint: "fingerprint-1",
    kind: "waive",
    reason: "The blocker was deleted upstream.",
    ...overrides,
  };
  return { environmentId: targetEnvironmentId, input };
}

function overrideRevokeTarget(
  command: string,
  overrides: Partial<FactoryReadinessOverrideRevokeInput> = {},
  targetEnvironmentId: EnvironmentId = environmentId,
) {
  const input: FactoryReadinessOverrideRevokeInput = {
    commandId: CommandId.make(command),
    projectId,
    issueNumber: 12,
    overrideId: FactoryReadinessOverrideId.make("override-1"),
    ...overrides,
  };
  return { environmentId: targetEnvironmentId, input };
}

const readCalls = (calls: ReadonlyArray<FeedCall>, method: string, issueNumber: number) =>
  calls.filter(
    (call) =>
      call.method === method &&
      (call.input as FactoryIssueReadinessReadInput).issueNumber === issueNumber,
  );

describe("Factory readiness override commands", () => {
  it.effect(
    "coalesces one reviewed decision without conflating edges, kinds, fingerprints, issues or environments",
    () =>
      Effect.gen(function* () {
        const h = yield* makeReadinessHarness();
        const targets = [
          overrideSetTarget("first"),
          overrideSetTarget("duplicate", { reason: "Different words, same decision." }),
          overrideSetTarget("other-edge", { targetId: 8008 }),
          overrideSetTarget("other-kind", { kind: "force-not-ready" }),
          overrideSetTarget("other-fingerprint", { expectedFingerprint: "fingerprint-2" }),
          overrideSetTarget("other-issue", { issueNumber: 13 }),
          overrideSetTarget("other-environment", {}, otherEnvironmentId),
        ];
        const pending = targets.map((value) =>
          h.atoms.setIssueReadinessOverride.run(h.registry, value),
        );
        const dispatched: FeedCall[] = [];
        for (let index = 0; index < 6; index++) dispatched.push(yield* Queue.take(h.entered));
        expect(
          dispatched
            .map(({ input }) => (input as FactoryReadinessOverrideSetInput).commandId)
            .sort(),
        ).toEqual([
          "first",
          "other-edge",
          "other-environment",
          "other-fingerprint",
          "other-issue",
          "other-kind",
        ]);
        yield* Deferred.succeed(h.release, undefined);
        const results = yield* Effect.promise(() => Promise.all(pending));
        expect(results.every(AsyncResult.isSuccess)).toBe(true);
        expect(results[1]).toEqual(results[0]);
        expect(h.calls).toHaveLength(6);
        expect(
          h.calls.every(({ method }) => method === WS_METHODS.factorySetIssueReadinessOverride),
        ).toBe(true);
        expect(
          h.calls.find(
            ({ input }) => (input as FactoryReadinessOverrideSetInput).commandId === "first",
          )?.environmentId,
        ).toBe(environmentId);
        expect(
          h.calls.find(
            ({ input }) =>
              (input as FactoryReadinessOverrideSetInput).commandId === "other-environment",
          )?.environmentId,
        ).toBe(otherEnvironmentId);
      }).pipe(Effect.scoped),
  );

  it.effect("coalesces one revocation per override without conflating issues or environments", () =>
    Effect.gen(function* () {
      const h = yield* makeReadinessHarness();
      const targets = [
        overrideRevokeTarget("first"),
        overrideRevokeTarget("duplicate"),
        overrideRevokeTarget("other-override", {
          overrideId: FactoryReadinessOverrideId.make("override-2"),
        }),
        overrideRevokeTarget("other-issue", { issueNumber: 13 }),
        overrideRevokeTarget("other-environment", {}, otherEnvironmentId),
      ];
      const pending = targets.map((value) =>
        h.atoms.revokeIssueReadinessOverride.run(h.registry, value),
      );
      for (let index = 0; index < 4; index++) yield* Queue.take(h.entered);
      yield* Deferred.succeed(h.release, undefined);
      const results = yield* Effect.promise(() => Promise.all(pending));
      expect(results.every(AsyncResult.isSuccess)).toBe(true);
      expect(results[1]).toEqual(results[0]);
      expect(h.calls).toHaveLength(4);
      expect(
        h.calls.every(({ method }) => method === WS_METHODS.factoryRevokeIssueReadinessOverride),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("requires operate to set or revoke an override, and read alone is not enough", () =>
    Effect.gen(function* () {
      const setHarness = yield* makeReadinessHarness();
      setHarness.registry.set(
        sessions(environmentId),
        AsyncResult.success(sessionWith([AuthOrchestrationReadScope])),
      );
      expect(
        setHarness.registry.get(
          setHarness.atoms.setIssueReadinessOverride.permissionAtom(environmentId),
        ),
      ).toBe(false);
      yield* expectGuarded(
        setHarness,
        setHarness.atoms.setIssueReadinessOverride,
        overrideSetTarget("set").input,
        [AuthOrchestrationOperateScope],
      );
      const revokeHarness = yield* makeReadinessHarness();
      yield* expectGuarded(
        revokeHarness,
        revokeHarness.atoms.revokeIssueReadinessOverride,
        overrideRevokeTarget("revoke").input,
        [AuthOrchestrationOperateScope],
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "observes only the changed issue again once a request settles, even a failed one: %s",
    (failCommands) =>
      Effect.gen(function* () {
        const h = yield* makeReadinessHarness([AuthOrchestrationOperateScope], failCommands);
        const changed = h.atoms.readIssueReadiness({
          environmentId,
          input: { projectId, issueNumber: 12 },
        });
        const untouched = h.atoms.readIssueReadiness({
          environmentId,
          input: { projectId, issueNumber: 13 },
        });
        for (const atom of [changed, untouched]) {
          yield* AtomRegistry.mount(h.registry, atom);
          yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
        }
        const reads = (issueNumber: number) =>
          readCalls(h.calls, WS_METHODS.factoryReadIssueReadiness, issueNumber).length;
        expect([reads(12), reads(13)]).toEqual([1, 1]);

        const pending = h.atoms.setIssueReadinessOverride.run(h.registry, overrideSetTarget("set"));
        yield* Queue.take(h.entered);
        yield* Deferred.succeed(h.release, undefined);
        const result = yield* Effect.promise(() => pending);
        expect(AsyncResult.isFailure(result)).toBe(failCommands);
        yield* AtomRegistry.getResult(h.registry, changed, { suspendOnWaiting: true });
        expect([reads(12), reads(13)]).toEqual([2, 1]);

        const revoking = h.atoms.revokeIssueReadinessOverride.run(
          h.registry,
          overrideRevokeTarget("revoke", { issueNumber: 13 }),
        );
        yield* Queue.take(h.entered);
        yield* Effect.promise(() => revoking);
        yield* AtomRegistry.getResult(h.registry, untouched, { suspendOnWaiting: true });
        expect([reads(12), reads(13)]).toEqual([2, 2]);
      }).pipe(Effect.scoped),
  );
});

describe("Factory issue frontier query", () => {
  it.effect("reads each environment and parent through its own request, and again on refresh", () =>
    Effect.gen(function* () {
      // Read access alone must be enough: the frontier is evidence, not a guarded command.
      const h = yield* makeReadinessHarness([AuthOrchestrationReadScope]);
      const target = { environmentId, input: { projectId, parentIssueNumber: 2 } };
      const parent = h.atoms.readIssueFrontier(target);
      expect(h.atoms.readIssueFrontier(target)).toBe(parent);
      const otherParent = h.atoms.readIssueFrontier({
        environmentId,
        input: { projectId, parentIssueNumber: 3 },
      });
      const otherEnvironment = h.atoms.readIssueFrontier({
        environmentId: otherEnvironmentId,
        input: target.input,
      });
      expect(otherParent).not.toBe(parent);
      expect(otherEnvironment).not.toBe(parent);
      for (const atom of [parent, otherParent, otherEnvironment]) {
        yield* AtomRegistry.mount(h.registry, atom);
        yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
      }
      expect(h.calls).toEqual([
        { method: WS_METHODS.factoryReadIssueFrontier, environmentId, input: target.input },
        {
          method: WS_METHODS.factoryReadIssueFrontier,
          environmentId,
          input: { projectId, parentIssueNumber: 3 },
        },
        {
          method: WS_METHODS.factoryReadIssueFrontier,
          environmentId: otherEnvironmentId,
          input: target.input,
        },
      ]);

      const first = yield* AtomRegistry.getResult(h.registry, parent, { suspendOnWaiting: true });
      expect(first.parentIssueNumber).toBe(2);
      expect(h.calls).toHaveLength(3);
      h.registry.refresh(parent);
      yield* AtomRegistry.getResult(h.registry, parent, { suspendOnWaiting: true });
      expect(h.calls).toHaveLength(4);
      expect(h.calls[3]).toEqual(h.calls[0]);
    }).pipe(Effect.scoped),
  );
});

describe("Factory feed admission", () => {
  it.effect(
    "coalesces one reviewed revision without conflating revisions, items or environments",
    () =>
      Effect.gen(function* () {
        const h = yield* makeFeedHarness([
          AuthOrchestrationOperateScope,
          AuthSourceControlWriteScope,
        ]);
        const targets = [
          { environmentId, input: admitInput("first", { instructions: "Keep it short." }) },
          { environmentId, input: admitInput("duplicate", { instructions: "Different text." }) },
          { environmentId, input: admitInput("edited", { expectedRevision: "revision-2" }) },
          { environmentId, input: admitInput("other-item", { itemKey: "guid:item-2" }) },
          { environmentId: otherEnvironmentId, input: admitInput("other-environment") },
        ];
        const pending = targets.map((value) => h.atoms.admitFeedCandidate.run(h.registry, value));
        const dispatched: FeedCall[] = [];
        for (let index = 0; index < 4; index++) dispatched.push(yield* Queue.take(h.entered));
        expect(
          dispatched.map(({ input }) => (input as FactoryFeedCandidateAdmitInput).commandId).sort(),
        ).toEqual(["edited", "first", "other-environment", "other-item"]);
        yield* Deferred.succeed(h.release, undefined);
        const results = yield* Effect.promise(() => Promise.all(pending));
        expect(results.every(AsyncResult.isSuccess)).toBe(true);
        expect(results[1]).toEqual(results[0]);
        expect(h.calls).toHaveLength(4);
        const first = h.calls.find(
          ({ input }) => (input as FactoryFeedCandidateAdmitInput).commandId === "first",
        );
        expect((first?.input as FactoryFeedCandidateAdmitInput | undefined)?.instructions).toBe(
          "Keep it short.",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("coalesces dismissals per reviewed revision and direction", () =>
    Effect.gen(function* () {
      const h = yield* makeFeedHarness();
      const dismissal = (
        command: string,
        overrides: Partial<FactoryFeedCandidateDismissInput>,
      ) => ({
        environmentId,
        input: {
          commandId: CommandId.make(command),
          projectId,
          sourceId: feedSourceId,
          itemKey: feedItemKey,
          expectedRevision: "revision-1",
          dismissed: true,
          ...overrides,
        } satisfies FactoryFeedCandidateDismissInput,
      });
      const pending = [
        dismissal("dismiss", {}),
        dismissal("dismiss-again", { note: "same decision" }),
        dismissal("restore", { dismissed: false }),
        dismissal("dismiss-edited", { expectedRevision: "revision-2" }),
      ].map((value) => h.atoms.setFeedCandidateDismissed.run(h.registry, value));
      for (let index = 0; index < 3; index++) yield* Queue.take(h.entered);
      yield* Deferred.succeed(h.release, undefined);
      const results = yield* Effect.promise(() => Promise.all(pending));
      expect(results.every(AsyncResult.isSuccess)).toBe(true);
      expect(h.calls).toHaveLength(3);
    }).pipe(Effect.scoped),
  );
});

const expectGuarded = Effect.fn("TestFactory.expectGuarded")(function* <W>(
  h: {
    readonly registry: AtomRegistry.AtomRegistry;
    readonly release: Deferred.Deferred<void>;
    readonly calls: ReadonlyArray<FeedCall>;
  },
  command: {
    readonly permissionAtom: (environmentId: EnvironmentId | null) => Atom.Atom<boolean>;
    readonly run: (
      registry: AtomRegistry.AtomRegistry,
      input: { readonly environmentId: EnvironmentId; readonly input: W },
    ) => Promise<AsyncResult.AsyncResult<unknown, unknown>>;
  },
  input: W,
  required: ReadonlyArray<AuthEnvironmentScope>,
) {
  // Each missing grant alone must deny, naming the grant that is absent.
  for (const missing of required) {
    const granted = required.filter((scope) => scope !== missing);
    h.registry.set(sessions(environmentId), AsyncResult.success(sessionWith(granted)));
    expect(h.registry.get(command.permissionAtom(environmentId))).toBe(false);
    const denied = yield* Effect.promise(() => command.run(h.registry, { environmentId, input }));
    expect(AsyncResult.isFailure(denied)).toBe(true);
    if (AsyncResult.isFailure(denied)) {
      expect(Cause.squash(denied.cause)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
    }
  }
  expect(h.calls).toHaveLength(0);
  h.registry.set(sessions(environmentId), AsyncResult.success(sessionWith(required)));
  expect(h.registry.get(command.permissionAtom(environmentId))).toBe(true);
  yield* Deferred.succeed(h.release, undefined);
  const accepted = yield* Effect.promise(() => command.run(h.registry, { environmentId, input }));
  expect(AsyncResult.isSuccess(accepted)).toBe(true);
  expect(h.calls).toHaveLength(1);
});

describe("Factory feed permissions", () => {
  it.effect("requires settings write to bind or unbind a source, since the server fetches it", () =>
    Effect.gen(function* () {
      const bindHarness = yield* makeFeedHarness();
      yield* expectGuarded(
        bindHarness,
        bindHarness.atoms.bindFeedSource,
        {
          commandId: CommandId.make("bind"),
          projectId,
          url: "https://feeds.example.test/tasks.xml",
        } satisfies FactoryFeedSourceBindInput,
        [AuthSettingsWriteScope],
      );
      const unbindHarness = yield* makeFeedHarness();
      yield* expectGuarded(
        unbindHarness,
        unbindHarness.atoms.unbindFeedSource,
        {
          commandId: CommandId.make("unbind"),
          projectId,
          sourceId: feedSourceId,
        } satisfies FactoryFeedSourceUnbindInput,
        [AuthSettingsWriteScope],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("requires operate to check a feed now or change a dismissal", () =>
    Effect.gen(function* () {
      const refreshHarness = yield* makeFeedHarness();
      yield* expectGuarded(
        refreshHarness,
        refreshHarness.atoms.refreshFeedSource,
        { projectId, sourceId: feedSourceId } satisfies FactoryFeedSourceRefreshInput,
        [AuthOrchestrationOperateScope],
      );
      const dismissHarness = yield* makeFeedHarness();
      yield* expectGuarded(
        dismissHarness,
        dismissHarness.atoms.setFeedCandidateDismissed,
        {
          commandId: CommandId.make("dismiss"),
          projectId,
          sourceId: feedSourceId,
          itemKey: feedItemKey,
          expectedRevision: "revision-1",
          dismissed: true,
        } satisfies FactoryFeedCandidateDismissInput,
        [AuthOrchestrationOperateScope],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("requires both operate and source-control write to admit a candidate", () =>
    Effect.gen(function* () {
      const h = yield* makeFeedHarness();
      yield* expectGuarded(h, h.atoms.admitFeedCandidate, admitInput("admit"), [
        AuthOrchestrationOperateScope,
        AuthSourceControlWriteScope,
      ]);
    }).pipe(Effect.scoped),
  );
});

const researchProtocolId = FactoryResearchProtocolId.make("protocol-1");
const researchProtocol: FactoryResearchProtocol = {
  id: researchProtocolId,
  projectId,
  repository: readinessRepository,
  baseCommit: "b".repeat(40),
  hypothesis: "A smaller batch lowers validation loss.",
  runCommand: "uv run train.py",
  evaluators: [{ path: "prepare.py", blobOid: "p0" }],
  metric: { name: "val_bpb", linePrefix: "val_bpb:", direction: "lower", minimumEffect: 0.01 },
  budget: { maxRuns: 3, maxRunMinutes: 10, expiresAt: "2026-11-01T00:00:00.000Z" },
  revision: "protocol-revision-1",
  sealedAt: fetchedAt,
};
const researchFinding: FactoryResearchFinding = {
  protocolId: researchProtocolId,
  protocolRevision: researchProtocol.revision,
  status: "supported",
  reasons: [],
  selectedCommit: "c".repeat(40),
  baselineValue: 0.95,
  exploreValue: 0.93,
  verifyValue: 0.93,
  baselineThreadId: ThreadId.make("baseline-thread"),
  exploreThreadId: ThreadId.make("explore-thread"),
  verifyThreadId: ThreadId.make("verify-thread"),
  revision: "finding-revision-1",
};
const researchTask: FactoryIssueTask = {
  projectId,
  threadId: ThreadId.make("research-thread"),
  status: "preparing",
  baseRef: "b".repeat(40),
  createdAt: fetchedAt,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};

const researchReadResult = (
  input: FactoryResearchProtocolReadInput,
  observedAt: string,
): FactoryResearchProtocolReadResult => ({
  repository: readinessRepository,
  protocol: { ...researchProtocol, id: input.protocolId, projectId: input.projectId },
  runs: [],
  finding: { ...researchFinding, protocolId: input.protocolId },
  fetchedAt: observedAt,
});

function sealInput(command: string, overrides: Partial<FactoryResearchProtocolSealInput> = {}) {
  const input: FactoryResearchProtocolSealInput = {
    commandId: CommandId.make(command),
    projectId,
    expectedRepositoryKey: readinessRepository.canonicalKey,
    hypothesis: researchProtocol.hypothesis,
    runCommand: researchProtocol.runCommand,
    evaluatorPaths: ["prepare.py"],
    metric: researchProtocol.metric,
    budget: researchProtocol.budget,
    ...overrides,
  };
  return input;
}

function launchInput(command: string, overrides: Partial<FactoryResearchRunLaunchInput> = {}) {
  const input: FactoryResearchRunLaunchInput = {
    commandId: CommandId.make(command),
    projectId,
    expectedRepositoryKey: readinessRepository.canonicalKey,
    protocolId: researchProtocolId,
    expectedProtocolRevision: researchProtocol.revision,
    role: "explore",
    modelSelection: researchTask.modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...overrides,
  };
  return input;
}

function researchAdmitInput(
  command: string,
  overrides: Partial<FactoryResearchImplementationAdmitInput> = {},
) {
  const input: FactoryResearchImplementationAdmitInput = {
    commandId: CommandId.make(command),
    projectId,
    expectedRepositoryKey: readinessRepository.canonicalKey,
    protocolId: researchProtocolId,
    expectedFindingRevision: researchFinding.revision,
    modelSelection: researchTask.modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...overrides,
  };
  return input;
}

const makeResearchHarness = Effect.fn("TestFactory.makeResearchHarness")(function* (
  grants: ReadonlyArray<AuthEnvironmentScope> = [
    AuthOrchestrationOperateScope,
    AuthSourceControlWriteScope,
  ],
  failCommands = false,
) {
  const entered = yield* Queue.unbounded<FeedCall>();
  const release = yield* Deferred.make<void>();
  const calls: FeedCall[] = [];
  const read =
    (environment: EnvironmentId, method: string, respond: (input: never) => unknown) =>
    (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method, environmentId: environment, input });
        return respond(input as never);
      });
  // Commands hold until the test releases them so overlap is observable.
  const held =
    (environment: EnvironmentId, method: string, respond: (input: never) => unknown) =>
    (input: unknown) =>
      Effect.gen(function* () {
        const call = { method, environmentId: environment, input };
        calls.push(call);
        yield* Queue.offer(entered, call);
        yield* Deferred.await(release);
        if (failCommands) return yield* new FactoryResearchError({ reason: "protocol-changed" });
        return respond(input as never);
      });
  const h = yield* makeEnvironmentHarness(
    (id) => ({
      [WS_METHODS.factoryListResearchProtocols]: read(
        id,
        WS_METHODS.factoryListResearchProtocols,
        () => ({ repository: readinessRepository, protocols: [researchProtocol], fetchedAt }),
      ),
      [WS_METHODS.factoryReadResearchProtocol]: read(
        id,
        WS_METHODS.factoryReadResearchProtocol,
        (input: FactoryResearchProtocolReadInput) => researchReadResult(input, fetchedAt),
      ),
      [WS_METHODS.factorySealResearchProtocol]: held(
        id,
        WS_METHODS.factorySealResearchProtocol,
        () => ({ repository: readinessRepository, protocol: researchProtocol }),
      ),
      [WS_METHODS.factoryLaunchResearchRun]: held(
        id,
        WS_METHODS.factoryLaunchResearchRun,
        (input: FactoryResearchRunLaunchInput) => ({
          repository: readinessRepository,
          protocolId: input.protocolId,
          role: input.role,
          projectId: input.projectId,
          threadId: researchTask.threadId,
          task: researchTask,
          resumed: false,
        }),
      ),
      [WS_METHODS.factoryAcceptCommit]: held(id, WS_METHODS.factoryAcceptCommit, () => ({
        acceptance: null,
        liveHeadSha: null,
        current: false,
      })),
      [WS_METHODS.factoryAdmitResearchImplementation]: held(
        id,
        WS_METHODS.factoryAdmitResearchImplementation,
        (input: FactoryResearchImplementationAdmitInput) => ({
          repository: readinessRepository,
          protocolId: input.protocolId,
          projectId: input.projectId,
          threadId: researchTask.threadId,
          task: researchTask,
          resumed: false,
        }),
      ),
    }),
    grants,
  );
  return { ...h, entered, release, calls };
});

const researchReads = (calls: ReadonlyArray<FeedCall>, method: string) =>
  calls.filter((call) => call.method === method).length;

describe("Factory research queries", () => {
  it.effect(
    "reads the list and each protocol through their own requests, and again on refresh",
    () =>
      Effect.gen(function* () {
        // Read access alone must be enough: a protocol and its finding are evidence, not a command.
        const h = yield* makeResearchHarness([AuthOrchestrationReadScope]);
        const list = h.atoms.listResearchProtocols({ environmentId, input: { projectId } });
        const target = { environmentId, input: { projectId, protocolId: researchProtocolId } };
        const protocol = h.atoms.readResearchProtocol(target);
        expect(h.atoms.readResearchProtocol(target)).toBe(protocol);
        const otherProtocol = h.atoms.readResearchProtocol({
          environmentId,
          input: { projectId, protocolId: FactoryResearchProtocolId.make("protocol-2") },
        });
        const otherEnvironment = h.atoms.readResearchProtocol({
          environmentId: otherEnvironmentId,
          input: target.input,
        });
        yield* AtomRegistry.mount(h.registry, list);
        yield* AtomRegistry.getResult(h.registry, list, { suspendOnWaiting: true });
        for (const atom of [protocol, otherProtocol, otherEnvironment]) {
          yield* AtomRegistry.mount(h.registry, atom);
          yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
        }
        expect(h.calls).toEqual([
          {
            method: WS_METHODS.factoryListResearchProtocols,
            environmentId,
            input: { projectId } satisfies FactoryResearchProtocolListInput,
          },
          { method: WS_METHODS.factoryReadResearchProtocol, environmentId, input: target.input },
          {
            method: WS_METHODS.factoryReadResearchProtocol,
            environmentId,
            input: { projectId, protocolId: "protocol-2" },
          },
          {
            method: WS_METHODS.factoryReadResearchProtocol,
            environmentId: otherEnvironmentId,
            input: target.input,
          },
        ]);
        const first = yield* AtomRegistry.getResult(h.registry, protocol, {
          suspendOnWaiting: true,
        });
        expect(first.finding.revision).toBe(researchFinding.revision);
        expect(h.calls).toHaveLength(4);
        h.registry.refresh(protocol);
        yield* AtomRegistry.getResult(h.registry, protocol, { suspendOnWaiting: true });
        expect(researchReads(h.calls, WS_METHODS.factoryReadResearchProtocol)).toBe(4);
      }).pipe(Effect.scoped),
  );
});

describe("Factory research commands", () => {
  it.effect("coalesces one sealing attempt per command id and project", () =>
    Effect.gen(function* () {
      const h = yield* makeResearchHarness();
      const targets = [
        { environmentId, input: sealInput("seal") },
        { environmentId, input: sealInput("seal", { hypothesis: "A retry with other words." }) },
        { environmentId, input: sealInput("other-attempt") },
        {
          environmentId,
          input: sealInput("seal", { projectId: ProjectId.make("other-project") }),
        },
        { environmentId: otherEnvironmentId, input: sealInput("seal") },
      ];
      const pending = targets.map((value) => h.atoms.sealResearchProtocol.run(h.registry, value));
      const dispatched: FeedCall[] = [];
      for (let index = 0; index < 4; index++) dispatched.push(yield* Queue.take(h.entered));
      expect(dispatched.map(({ environmentId: id }) => id).sort()).toEqual(
        [environmentId, environmentId, environmentId, otherEnvironmentId].sort(),
      );
      yield* Deferred.succeed(h.release, undefined);
      const results = yield* Effect.promise(() => Promise.all(pending));
      expect(results.every(AsyncResult.isSuccess)).toBe(true);
      expect(results[1]).toEqual(results[0]);
      expect(h.calls).toHaveLength(4);
      expect(h.calls.every(({ method }) => method === WS_METHODS.factorySealResearchProtocol)).toBe(
        true,
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "coalesces one reviewed launch without conflating protocols, roles, revisions or environments",
    () =>
      Effect.gen(function* () {
        const h = yield* makeResearchHarness();
        const targets = [
          { environmentId, input: launchInput("first", { instructions: "Try a smaller batch." }) },
          { environmentId, input: launchInput("duplicate", { instructions: "Other words." }) },
          { environmentId, input: launchInput("verify", { role: "verify" }) },
          {
            environmentId,
            input: launchInput("replaced", { expectedProtocolRevision: "protocol-revision-2" }),
          },
          {
            environmentId,
            input: launchInput("other-protocol", {
              protocolId: FactoryResearchProtocolId.make("protocol-2"),
            }),
          },
          { environmentId: otherEnvironmentId, input: launchInput("other-environment") },
        ];
        const pending = targets.map((value) => h.atoms.launchResearchRun.run(h.registry, value));
        const dispatched: FeedCall[] = [];
        for (let index = 0; index < 5; index++) dispatched.push(yield* Queue.take(h.entered));
        expect(
          dispatched.map(({ input }) => (input as FactoryResearchRunLaunchInput).commandId).sort(),
        ).toEqual(["first", "other-environment", "other-protocol", "replaced", "verify"]);
        yield* Deferred.succeed(h.release, undefined);
        const results = yield* Effect.promise(() => Promise.all(pending));
        expect(results.every(AsyncResult.isSuccess)).toBe(true);
        expect(results[1]).toEqual(results[0]);
        expect(
          h.calls.filter(({ method }) => method === WS_METHODS.factoryLaunchResearchRun),
        ).toHaveLength(5);
        expect(
          h.calls.find(
            ({ input }) =>
              (input as FactoryResearchRunLaunchInput).commandId === "other-environment",
          )?.environmentId,
        ).toBe(otherEnvironmentId);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "coalesces one admission per reviewed finding revision without conflating protocols or environments",
    () =>
      Effect.gen(function* () {
        const h = yield* makeResearchHarness();
        const targets = [
          { environmentId, input: researchAdmitInput("first", { instructions: "Keep it small." }) },
          { environmentId, input: researchAdmitInput("duplicate", { instructions: "Other." }) },
          {
            environmentId,
            input: researchAdmitInput("re-evidenced", {
              expectedFindingRevision: "finding-revision-2",
            }),
          },
          {
            environmentId,
            input: researchAdmitInput("other-protocol", {
              protocolId: FactoryResearchProtocolId.make("protocol-2"),
            }),
          },
          { environmentId: otherEnvironmentId, input: researchAdmitInput("other-environment") },
        ];
        const pending = targets.map((value) =>
          h.atoms.admitResearchImplementation.run(h.registry, value),
        );
        const dispatched: FeedCall[] = [];
        for (let index = 0; index < 4; index++) dispatched.push(yield* Queue.take(h.entered));
        expect(
          dispatched
            .map(({ input }) => (input as FactoryResearchImplementationAdmitInput).commandId)
            .sort(),
        ).toEqual(["first", "other-environment", "other-protocol", "re-evidenced"]);
        yield* Deferred.succeed(h.release, undefined);
        const results = yield* Effect.promise(() => Promise.all(pending));
        expect(results.every(AsyncResult.isSuccess)).toBe(true);
        expect(results[1]).toEqual(results[0]);
        expect(h.calls).toHaveLength(4);
      }).pipe(Effect.scoped),
  );

  it.effect("requires operate to seal a protocol, and read alone is not enough", () =>
    Effect.gen(function* () {
      const h = yield* makeResearchHarness();
      h.registry.set(
        sessions(environmentId),
        AsyncResult.success(sessionWith([AuthOrchestrationReadScope])),
      );
      expect(h.registry.get(h.atoms.sealResearchProtocol.permissionAtom(environmentId))).toBe(
        false,
      );
      yield* expectGuarded(h, h.atoms.sealResearchProtocol, sealInput("seal"), [
        AuthOrchestrationOperateScope,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("requires both operate and source-control write to launch a run", () =>
    Effect.gen(function* () {
      const h = yield* makeResearchHarness();
      yield* expectGuarded(h, h.atoms.launchResearchRun, launchInput("launch"), [
        AuthOrchestrationOperateScope,
        AuthSourceControlWriteScope,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("requires both operate and source-control write to admit an implementation", () =>
    Effect.gen(function* () {
      const h = yield* makeResearchHarness();
      yield* expectGuarded(h, h.atoms.admitResearchImplementation, researchAdmitInput("admit"), [
        AuthOrchestrationOperateScope,
        AuthSourceControlWriteScope,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("requires both operate and source-control write to accept a commit", () =>
    Effect.gen(function* () {
      const h = yield* makeResearchHarness();
      yield* expectGuarded(
        h,
        h.atoms.acceptCommit,
        {
          projectId,
          threadId: researchTask.threadId,
          expectedHeadSha: "c".repeat(40),
          evidenceRefs: [],
        } satisfies FactoryAcceptCommitInput,
        [AuthOrchestrationOperateScope, AuthSourceControlWriteScope],
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "reads only the affected protocol again once a launch or admission settles, even a failed one: %s",
    (failCommands) =>
      Effect.gen(function* () {
        const h = yield* makeResearchHarness(undefined, failCommands);
        const changed = h.atoms.readResearchProtocol({
          environmentId,
          input: { projectId, protocolId: researchProtocolId },
        });
        const untouched = h.atoms.readResearchProtocol({
          environmentId,
          input: { projectId, protocolId: FactoryResearchProtocolId.make("protocol-2") },
        });
        for (const atom of [changed, untouched]) {
          yield* AtomRegistry.mount(h.registry, atom);
          yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
        }
        const reads = (protocolId: string) =>
          h.calls.filter(
            (call) =>
              call.method === WS_METHODS.factoryReadResearchProtocol &&
              (call.input as FactoryResearchProtocolReadInput).protocolId === protocolId,
          ).length;
        expect([reads("protocol-1"), reads("protocol-2")]).toEqual([1, 1]);

        const launching = h.atoms.launchResearchRun.run(h.registry, {
          environmentId,
          input: launchInput("launch"),
        });
        yield* Queue.take(h.entered);
        yield* Deferred.succeed(h.release, undefined);
        const launched = yield* Effect.promise(() => launching);
        expect(AsyncResult.isFailure(launched)).toBe(failCommands);
        yield* AtomRegistry.getResult(h.registry, changed, { suspendOnWaiting: true });
        expect([reads("protocol-1"), reads("protocol-2")]).toEqual([2, 1]);

        const admitting = h.atoms.admitResearchImplementation.run(h.registry, {
          environmentId,
          input: researchAdmitInput("admit", {
            protocolId: FactoryResearchProtocolId.make("protocol-2"),
          }),
        });
        yield* Queue.take(h.entered);
        const admitted = yield* Effect.promise(() => admitting);
        expect(AsyncResult.isFailure(admitted)).toBe(failCommands);
        yield* AtomRegistry.getResult(h.registry, untouched, { suspendOnWaiting: true });
        expect([reads("protocol-1"), reads("protocol-2")]).toEqual([2, 2]);
      }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "reads the protocol list again once a seal settles, even a failed one: %s",
    (failCommands) =>
      Effect.gen(function* () {
        const h = yield* makeResearchHarness(undefined, failCommands);
        const list = h.atoms.listResearchProtocols({ environmentId, input: { projectId } });
        yield* AtomRegistry.mount(h.registry, list);
        yield* AtomRegistry.getResult(h.registry, list, { suspendOnWaiting: true });
        expect(researchReads(h.calls, WS_METHODS.factoryListResearchProtocols)).toBe(1);

        const sealing = h.atoms.sealResearchProtocol.run(h.registry, {
          environmentId,
          input: sealInput("seal"),
        });
        yield* Queue.take(h.entered);
        yield* Deferred.succeed(h.release, undefined);
        const sealed = yield* Effect.promise(() => sealing);
        expect(AsyncResult.isFailure(sealed)).toBe(failCommands);
        yield* AtomRegistry.getResult(h.registry, list, { suspendOnWaiting: true });
        expect(researchReads(h.calls, WS_METHODS.factoryListResearchProtocols)).toBe(2);
      }).pipe(Effect.scoped),
  );
});
