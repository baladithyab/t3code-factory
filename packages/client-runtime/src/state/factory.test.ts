import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  CommandId,
  EnvironmentId,
  FactoryFeedSourceId,
  ProjectCoordinatorError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type FactoryFeedCandidate,
  type FactoryFeedCandidateAdmitInput,
  type FactoryFeedCandidateDismissInput,
  type FactoryFeedSource,
  type FactoryFeedSourceBindInput,
  type FactoryFeedSourceRefreshInput,
  type FactoryFeedSourceUnbindInput,
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
