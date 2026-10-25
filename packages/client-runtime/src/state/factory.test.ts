import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  CommandId,
  EnvironmentId,
  ProjectCoordinatorError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
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
  const makeSupervisor = Effect.fn("TestFactory.makeSupervisor")(function* (id: EnvironmentId) {
    const rpcSession = {
      client: {
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
      },
    } as unknown as RpcSession;
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
    registry.set(sessions(id), AsyncResult.success(sessionWith([AuthOrchestrationOperateScope])));
  }
  return { atoms: createFactoryEnvironmentAtoms(runtime), registry, entered, release, calls };
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
