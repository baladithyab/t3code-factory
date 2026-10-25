import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  MessageId,
  ProjectCoordinatorError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProjectCoordinatorEnsureInput,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Coordinator from "./ProjectCoordinatorService.ts";
import * as Bindings from "../persistence/ProjectCoordinators.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "./ProjectService.ts";
import * as Identities from "./RepositoryIdentityResolver.ts";
import * as Enrichment from "./ProjectEnrichmentService.ts";
import * as Favicons from "./ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ManagedFolders from "./ManagedProjectFolders.ts";
import * as CloneTracker from "./ProjectCloneTracker.ts";
import * as SetupTracker from "./WorktreeSetupTracker.ts";
import * as SetupRunner from "./ProjectSetupScriptRunner.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as Settings from "../serverSettings.ts";
import * as Config from "../config.ts";
import * as Runtime from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";

const projectId = ProjectId.make("coordinator-project");
const secondProjectId = ProjectId.make("coordinator-second-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const input = (command: string): ProjectCoordinatorEnsureInput => ({
  commandId: CommandId.make(command),
  projectId,
  expectedThreadId: null,
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
});

function harness(
  options: {
    readonly beforeFolder?: Effect.Effect<void, ManagedFolders.ScratchFolderError>;
    readonly afterPreparation?: Effect.Effect<void>;
  } = {},
) {
  const database = Sqlite.layerMemory;
  const settings = Settings.layerTest();
  const registry = Registry.layerFromAdapters([
    {
      instanceId: modelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Coordinator tests never execute a provider"),
    },
  ]);
  const orchestrator = Replay.layerWithRegistry({ name: "project-coordinator" }, registry, {
    databaseLayer: database,
    runEffectWorker: false,
  });
  const receipts = Receipts.layer.pipe(Layer.provide(database));
  const threads = Threads.layer.pipe(
    Layer.provide(Layer.mergeAll(orchestrator, settings, receipts)),
  );
  const setupTracker = Layer.effect(
    SetupTracker.WorktreeSetupTracker,
    Effect.gen(function* () {
      const tracker = yield* SetupTracker.WorktreeSetupTracker;
      const release = yield* Deferred.make<void>();
      return SetupTracker.WorktreeSetupTracker.of({
        ...tracker,
        // Root threads have no setup script; hold the preparation observer before release instead.
        stageStatus: (threadId, stageId, status, detail) =>
          stageId === "setup-script" &&
          status === "running" &&
          options.afterPreparation === undefined
            ? Deferred.await(release)
            : tracker.stageStatus(threadId, stageId, status, detail),
        finish: (...args) =>
          tracker.finish(...args).pipe(Effect.tap(options.afterPreparation ?? Effect.void)),
      });
    }),
  ).pipe(Layer.provide(SetupTracker.layer));
  const external = Layer.mergeAll(
    Layer.succeed(Identities.RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    Layer.succeed(Favicons.ProjectFaviconResolver, {
      resolvePath: () => Effect.succeed(null),
      invalidate: () => Effect.void,
    }),
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (root) => Effect.succeed(root),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({ isRepository: () => Effect.succeed(false) }),
    Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(Terminal.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(SetupRunner.ProjectSetupScriptRunner)({
      runForThread: () => Effect.die("Root coordinator launches must not run setup scripts"),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateBranchName: () => Effect.succeed({ branch: "coordinator" }),
    }),
    ProviderRegistryMock.layer(),
    settings,
    setupTracker,
    ThreadCommands.layer,
    IdAllocator.layer,
  );
  const enrichment = Enrichment.layer.pipe(Layer.provide(external));
  const projects = Runtime.layerProjectService.pipe(
    Layer.provide(Layer.mergeAll(enrichment, external, database)),
  );
  const folders = Layer.mock(ManagedFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/projects",
    isScratchProject: () => Effect.succeed(false),
    folderForThread: () => (options.beforeFolder ?? Effect.void).pipe(Effect.as(Option.none())),
  });
  const launcher = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(projects, folders, threads, receipts, external)),
  );
  const dependencies = Layer.mergeAll(
    projects,
    folders,
    launcher,
    threads,
    receipts,
    orchestrator,
    external,
    Bindings.layer.pipe(Layer.provide(database)),
    database,
  );
  return Layer.mergeAll(Coordinator.layer.pipe(Layer.provide(dependencies)), dependencies).pipe(
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "coordinator-test-" })),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const seed = Effect.gen(function* () {
  const projects = yield* Projects.ProjectService;
  for (const [id, root] of [
    [projectId, "/repo"],
    [secondProjectId, "/second-repo"],
  ] as const) {
    yield* projects.create({
      commandId: CommandId.make(`create:${id}`),
      projectId: id,
      title: 'Factory "quoted" project',
      workspaceRoot: root,
      defaultModelSelection: modelSelection,
      scripts: [],
    });
  }
});
const savedIntent = (key: string): Bindings.ProjectCoordinatorIntent => ({
  projectId,
  workspaceRoot: "/repo",
  requestCommandId: CommandId.make(`${key}:request`),
  commandId: CommandId.make(`${key}:launch`),
  threadId: ThreadId.make(`${key}:thread`),
  messageId: MessageId.make(`${key}:message`),
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  prompt: "Frozen original orientation",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-24T00:00:00.000Z",
  previousThreadId: null,
});
const launchInput = (
  intent: Bindings.ProjectCoordinatorIntent,
): ThreadLaunch.ThreadLaunchInput => ({
  commandId: intent.commandId,
  threadId: intent.threadId,
  projectId: intent.projectId,
  title: "Original orchestrator",
  modelSelection: intent.modelSelection,
  runtimeMode: intent.runtimeMode,
  interactionMode: intent.interactionMode,
  workspaceStrategy: { type: "root" },
  initialMessage: { messageId: intent.messageId, text: intent.prompt, attachments: [] },
  createdBy: intent.createdBy,
  creationSource: intent.creationSource,
});

it.effect("passive reads do not reserve a coordinator or create a conversation", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Coordinator.ProjectCoordinatorService;
    assert.isNull((yield* service.get({ projectId })).coordinator);
    assert.deepEqual((yield* service.list()).coordinators, []);
    assert.deepEqual(yield* (yield* Bindings.ProjectCoordinators).list(), []);
    assert.deepEqual(
      yield* (yield* Threads.ThreadManagementService).listProjectThreads({
        projectId,
        includeSubagents: true,
      }),
      [],
    );
  }).pipe(Effect.provide(harness())),
);

it.effect("explicit create runs one frozen orientation; reopen and reads send nothing", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Coordinator.ProjectCoordinatorService;
    const threads = yield* Threads.ThreadManagementService;
    const store = yield* Bindings.ProjectCoordinators;
    const first = yield* service.ensure({ ...input("create"), creationSource: "mcp" });
    assert.isFalse(first.resumed);
    assert.isTrue(first.coordinator.current);
    assert.equal(first.coordinator.status, "preparing");
    const binding = Option.getOrThrow(yield* store.get(projectId));
    assert.equal(binding.accepted, 1);
    assert.equal(binding.intent.createdBy, "user");
    assert.equal(binding.intent.creationSource, "mcp");
    const before = yield* threads.getThreadProjection(first.coordinator.threadId);
    assert.equal(before.thread.title, 'Factory "quoted" project orchestrator');
    assert.isNull(before.thread.worktreePath);
    assert.equal(before.messages.length, 1);
    assert.equal(before.messages[0]?.id, binding.intent.messageId);
    assert.equal(before.messages[0]?.text, binding.intent.prompt);
    assert.include(
      binding.intent.prompt,
      JSON.stringify({ title: 'Factory "quoted" project', workspaceRoot: "/repo" }),
    );
    assert.include(binding.intent.prompt, "read-only orientation");
    assert.include(binding.intent.prompt, "Do not edit files, start workers");
    const reopened = yield* service.ensure({
      ...input("reopen"),
      modelSelection: { ...modelSelection, model: "other-model" },
      runtimeMode: "full-access",
      creationSource: "mobile",
    });
    assert.equal(reopened.coordinator.threadId, first.coordinator.threadId);
    assert.deepEqual(reopened.coordinator.modelSelection, modelSelection);
    assert.equal(reopened.coordinator.runtimeMode, "approval-required");
    assert.isTrue(reopened.resumed);
    yield* service.get({ projectId });
    yield* service.list();
    const after = yield* threads.getThreadProjection(first.coordinator.threadId);
    assert.equal(after.messages.length, 1);
    assert.equal(after.runs.length, 1);
    assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)).intent, binding.intent);
  }).pipe(Effect.provide(harness())),
);

it.effect("concurrent first creates share one winner while its launch is suspended", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* seed;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const first = yield* service
        .ensure(input("first"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* service
        .ensure({
          ...input("second"),
          modelSelection: { ...modelSelection, model: "losing-model" },
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const winner = yield* Fiber.join(first);
      const loser = yield* Fiber.join(second);
      assert.isFalse(winner.resumed);
      assert.isTrue(loser.resumed);
      assert.equal(loser.coordinator.threadId, winner.coordinator.threadId);
      assert.deepEqual(loser.coordinator.modelSelection, modelSelection);
      const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
        winner.coordinator.threadId,
      );
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      assert.equal((yield* (yield* Bindings.ProjectCoordinators).list()).length, 1);
    }).pipe(
      Effect.provide(
        harness({
          beforeFolder: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        }),
      ),
    );
  }),
);

it.effect.each(["reservation", "thread", "message", "response"] as const)(
  "a reconstructed service resumes after %s using the exact saved IDs and one message",
  (stage) =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Bindings.ProjectCoordinators;
      const threads = yield* Threads.ThreadManagementService;
      const intent = savedIntent("restart");
      yield* store.reserve(intent);
      if (stage === "thread") {
        yield* threads.dispatch({
          type: "thread.create",
          commandId: intent.commandId,
          threadId: intent.threadId,
          projectId,
          title: "Original orchestrator",
          modelSelection,
          runtimeMode: intent.runtimeMode,
          interactionMode: intent.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      if (stage === "message" || stage === "response")
        yield* (yield* ThreadLaunch.ThreadLaunchService).launch(launchInput(intent));
      if (stage === "response") yield* store.accept(intent.threadId);
      const resumed = yield* Effect.gen(function* () {
        const fresh = yield* Coordinator.ProjectCoordinatorService;
        return yield* fresh.ensure({
          ...input("restart:request"),
          modelSelection: { ...modelSelection, model: "changed-after-restart" },
          runtimeMode: "full-access",
          creationSource: "mcp",
        });
      }).pipe(Effect.provide(Coordinator.layer.pipe(Layer.provide(ThreadLaunch.layer))));
      assert.equal(resumed.coordinator.threadId, intent.threadId);
      assert.isTrue(resumed.resumed);
      const projection = yield* threads.getThreadProjection(intent.threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.messages[0]?.id, intent.messageId);
      assert.equal(projection.messages[0]?.text, intent.prompt);
      assert.equal(projection.runs.length, 1);
      assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)).intent, intent);
      assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 1);
    }).pipe(Effect.provide(harness())),
);

it.effect("failed and archived coordinators stay inspectable without replacement or rerun", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Coordinator.ProjectCoordinatorService;
    const threads = yield* Threads.ThreadManagementService;
    const first = yield* service.ensure(input("failure"));
    const threadId = first.coordinator.threadId;
    const projection = yield* threads.getThreadProjection(threadId);
    const run = projection.runs[0];
    if (run === undefined) return yield* Effect.die("Expected the orientation run");
    yield* threads.dispatch({
      type: "prepared-run.fail",
      commandId: CommandId.make("fail-preparation"),
      threadId,
      runId: run.id,
      failure: makeProviderFailure({
        message: "Setup failed",
        class: "validation_error",
        retryable: false,
      }),
    });
    assert.equal((yield* service.get({ projectId })).coordinator?.status, "failed");
    const failed = yield* service.ensure({ ...input("reopen-failed"), replaceRetired: true });
    assert.equal(failed.coordinator.threadId, threadId);
    assert.equal(failed.coordinator.status, "failed");
    yield* threads.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    const archived = yield* service.ensure({ ...input("reopen-archived"), replaceRetired: true });
    assert.equal(archived.coordinator.threadId, threadId);
    assert.equal(archived.coordinator.status, "archived");
    assert.equal((yield* threads.getThreadProjection(threadId)).messages.length, 1);
    assert.equal((yield* (yield* Bindings.ProjectCoordinators).list()).length, 1);
  }).pipe(Effect.provide(harness())),
);

it.effect(
  "missing replacement requires the reviewed predecessor and historical replay stays historical",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const threads = yield* Threads.ThreadManagementService;
      const first = yield* service.ensure(input("generation-one"));
      const predecessor = first.coordinator.threadId;
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-one"),
        threadId: predecessor,
      });
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "missing");
      assert.equal(
        (yield* service.ensure(input("unconfirmed")).pipe(Effect.flip)).reason,
        "retired-coordinator",
      );
      assert.equal(
        (yield* service.ensure({ ...input("unreviewed"), replaceRetired: true }).pipe(Effect.flip))
          .reason,
        "binding-changed",
      );
      assert.equal(
        (yield* service
          .ensure({
            ...input("wrong-predecessor"),
            replaceRetired: true,
            expectedThreadId: ThreadId.make("not-current"),
          })
          .pipe(Effect.flip)).reason,
        "binding-changed",
      );
      const replacement = yield* service.ensure({
        ...input("generation-two"),
        replaceRetired: true,
        expectedThreadId: predecessor,
      });
      assert.notEqual(replacement.coordinator.threadId, predecessor);
      assert.isFalse(replacement.resumed);
      const replay = yield* service.ensure({
        ...input("generation-one"),
        replaceRetired: true,
        expectedThreadId: replacement.coordinator.threadId,
      });
      assert.equal(replay.coordinator.threadId, predecessor);
      assert.isFalse(replay.coordinator.current);
      assert.equal(replay.coordinator.status, "missing");
      assert.isTrue(replay.resumed);
      assert.equal(
        (yield* service
          .ensure({
            ...input("stale-replacement"),
            replaceRetired: true,
            expectedThreadId: predecessor,
          })
          .pipe(Effect.flip)).reason,
        "binding-changed",
      );
      assert.equal(
        (yield* service.list()).coordinators[0]?.threadId,
        replacement.coordinator.threadId,
      );
      const store = yield* Bindings.ProjectCoordinators;
      assert.equal((yield* store.list()).length, 1);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT thread_id FROM project_coordinators`).length, 2);
      assert.equal(
        (yield* threads.getThreadProjection(replacement.coordinator.threadId)).messages.length,
        1,
      );
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "accepted provenance without a shell is missing, but an unaccepted reservation is launching",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const store = yield* Bindings.ProjectCoordinators;
      const intent = savedIntent("no-shell");
      yield* store.reserve(intent);
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "launching");
      yield* store.accept(intent.threadId);
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "missing");
      assert.equal(
        (yield* service.ensure(input("do-not-recreate")).pipe(Effect.flip)).reason,
        "retired-coordinator",
      );
      assert.isNull(
        yield* (yield* Threads.ThreadManagementService).getThreadShell(intent.threadId),
      );
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "an accepted launch receipt with a missing shell is not an interrupted first launch",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const intent = savedIntent("receipt-only");
      yield* (yield* Bindings.ProjectCoordinators).reserve(intent);
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId: intent.commandId,
        threadId: intent.threadId,
        commandType: "thread.create",
        acceptedAt: yield* DateTime.now,
        resultSequence: 0,
        status: "accepted",
        error: null,
      });
      const service = yield* Coordinator.ProjectCoordinatorService;
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "missing");
      assert.equal(
        (yield* service.ensure(input("receipt-reopen")).pipe(Effect.flip)).reason,
        "retired-coordinator",
      );
      assert.isNull(
        yield* (yield* Threads.ThreadManagementService).getThreadShell(intent.threadId),
      );
    }).pipe(Effect.provide(harness())),
);

it.effect.each(["thread.create", "message.dispatch"] as const)(
  "a rejected %s receipt retires the launch until a fresh reviewed replacement",
  (commandType) =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Bindings.ProjectCoordinators;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const threads = yield* Threads.ThreadManagementService;
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      const intent = savedIntent(`rejected-${commandType}`);
      yield* store.reserve(intent);
      if (commandType === "message.dispatch") {
        yield* threads.dispatch({
          type: "thread.create",
          commandId: intent.commandId,
          threadId: intent.threadId,
          projectId,
          title: "Original orchestrator",
          modelSelection,
          runtimeMode: intent.runtimeMode,
          interactionMode: intent.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const created = Option.getOrThrow(yield* receipts.getByCommandId(intent.commandId));
        assert.equal(created.status, "accepted");
        assert.equal(created.commandType, "thread.create");
        assert.equal(created.threadId, intent.threadId);
      }
      const rejected = {
        commandId:
          commandType === "thread.create"
            ? intent.commandId
            : CommandId.make(`${intent.commandId}:initial-message`),
        threadId: intent.threadId,
        commandType,
        acceptedAt: yield* DateTime.now,
        resultSequence: 0,
        status: "rejected",
        error: "Projection read failed before command acceptance",
      } satisfies Receipts.CommandReceiptV2;
      assert.isTrue(yield* receipts.insertIfAbsent(rejected));
      assert.deepEqual(
        Option.getOrThrow(yield* receipts.getByCommandId(rejected.commandId)),
        rejected,
      );
      const launchFailure = yield* (yield* ThreadLaunch.ThreadLaunchService)
        .launch(launchInput(intent))
        .pipe(Effect.flip);
      assert.equal(launchFailure._tag, "ThreadLaunchError");
      if (launchFailure._tag !== "ThreadLaunchError") return yield* Effect.die(launchFailure);
      assert.equal(
        launchFailure.operation,
        commandType === "thread.create" ? "create-thread" : "dispatch-message",
      );
      assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 0);

      const retired = (yield* service.get({ projectId })).coordinator;
      assert.isNotNull(retired);
      assert.equal(retired.threadId, intent.threadId);
      assert.equal(retired.status, "missing");
      assert.isTrue(retired.current);
      assert.deepEqual((yield* service.list()).coordinators, [retired]);
      assert.equal(
        (yield* service.ensure(input("unconfirmed-rejection")).pipe(Effect.flip)).reason,
        "retired-coordinator",
      );
      for (const expectedThreadId of [null, ThreadId.make("unrelated-thread")]) {
        assert.equal(
          (yield* service
            .ensure({
              ...input(`unreviewed-rejection:${expectedThreadId}`),
              replaceRetired: true,
              expectedThreadId,
            })
            .pipe(Effect.flip)).reason,
          "binding-changed",
        );
      }
      const replayInput = {
        ...input(intent.requestCommandId),
        replaceRetired: true,
        expectedThreadId: intent.threadId,
      };
      const replayBefore = yield* service.ensure(replayInput);
      assert.deepEqual(replayBefore.coordinator, retired);
      assert.isTrue(replayBefore.resumed);
      assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)).intent, intent);
      const replacement = yield* service.ensure({
        ...input("fresh-rejected-replacement"),
        replaceRetired: true,
        expectedThreadId: intent.threadId,
      });
      assert.notEqual(replacement.coordinator.threadId, intent.threadId);
      assert.isTrue(replacement.coordinator.current);
      assert.isFalse(replacement.resumed);
      const current = Option.getOrThrow(yield* store.get(projectId));
      assert.equal(current.intent.threadId, replacement.coordinator.threadId);
      assert.equal(current.intent.previousThreadId, intent.threadId);
      assert.equal(current.accepted, 1);
      const replayAfter = yield* service.ensure({
        ...replayInput,
        expectedThreadId: replacement.coordinator.threadId,
      });
      assert.equal(replayAfter.coordinator.threadId, intent.threadId);
      assert.equal(replayAfter.coordinator.status, "missing");
      assert.isFalse(replayAfter.coordinator.current);
      assert.isTrue(replayAfter.resumed);
      assert.deepEqual(Option.getOrThrow(yield* store.getByRequest(intent.requestCommandId)), {
        intent,
        accepted: 0,
        superseded: 1,
      });
      assert.deepEqual(
        Option.getOrThrow(yield* receipts.getByCommandId(rejected.commandId)),
        rejected,
      );
      if (commandType === "thread.create") {
        assert.isNull(yield* threads.getThreadShell(intent.threadId));
        assert.isTrue(
          Option.isNone(
            yield* receipts.getByCommandId(CommandId.make(`${intent.commandId}:initial-message`)),
          ),
        );
      } else {
        const original = yield* threads.getThreadProjection(intent.threadId);
        assert.deepEqual(original.messages, []);
        assert.deepEqual(original.runs, []);
      }
      const projection = yield* threads.getThreadProjection(current.intent.threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.messages[0]?.id, current.intent.messageId);
      assert.equal(projection.messages[0]?.text, current.intent.prompt);
      assert.equal(projection.runs.length, 1);
      for (const commandId of [
        current.intent.commandId,
        CommandId.make(`${current.intent.commandId}:initial-message`),
      ]) {
        const receipt = Option.getOrThrow(yield* receipts.getByCommandId(commandId));
        assert.equal(receipt.status, "accepted");
        assert.equal(receipt.threadId, current.intent.threadId);
      }
      assert.deepEqual((yield* service.list()).coordinators, [replacement.coordinator]);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT thread_id FROM project_coordinators`).length, 2);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "a reused request cannot move to another project and reviewed nonexistent bindings fail",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Coordinator.ProjectCoordinatorService;
      yield* service.ensure(input("shared-command"));
      assert.equal(
        (yield* service
          .ensure({ ...input("shared-command"), projectId: secondProjectId })
          .pipe(Effect.flip)).reason,
        "command-conflict",
      );
      assert.isNull((yield* service.get({ projectId: secondProjectId })).coordinator);
      assert.equal(
        (yield* service
          .ensure({
            ...input("nonexistent-binding"),
            projectId: secondProjectId,
            expectedThreadId: ThreadId.make("unknown"),
            replaceRetired: true,
          })
          .pipe(Effect.flip)).reason,
        "binding-changed",
      );
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "deleted and unknown projects cannot be revived, and list excludes tombstoned owners",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const first = yield* service.ensure(input("before-delete"));
      yield* (yield* Projects.ProjectService).delete({
        commandId: CommandId.make("delete-project"),
        projectId,
        force: true,
      });
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "missing");
      assert.deepEqual((yield* service.list()).coordinators, []);
      assert.equal(
        (yield* service.ensure(input("before-delete")).pipe(Effect.flip)).reason,
        "missing-project",
      );
      assert.equal(
        (yield* service
          .ensure({
            ...input("revive"),
            expectedThreadId: first.coordinator.threadId,
            replaceRetired: true,
          })
          .pipe(Effect.flip)).reason,
        "missing-project",
      );
      assert.equal(
        (yield* service
          .ensure({ ...input("unknown"), projectId: ProjectId.make("unknown") })
          .pipe(Effect.flip)).reason,
        "missing-project",
      );
      assert.equal((yield* (yield* Bindings.ProjectCoordinators).list()).length, 1);
    }).pipe(Effect.provide(harness())),
);

it.effect.each(["disabled", "unknown"] as const)(
  "provider %s preflight refuses before reservation",
  (kind) =>
    Effect.gen(function* () {
      yield* seed;
      if (kind === "disabled")
        yield* (yield* Settings.ServerSettingsService).updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
          },
        });
      const refused = yield* (yield* Coordinator.ProjectCoordinatorService)
        .ensure({
          ...input("provider-refusal"),
          modelSelection:
            kind === "unknown"
              ? { ...modelSelection, instanceId: ProviderInstanceId.make("unknown") }
              : modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "provider-unavailable");
      assert.deepEqual(yield* (yield* Bindings.ProjectCoordinators).list(), []);
    }).pipe(Effect.provide(harness())),
);

it.effect.each(["runtime", "interaction"] as const)(
  "new intent cannot exceed the caller's %s ceiling",
  (mode) =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const refusal = yield* service
        .ensure({
          ...input("limited"),
          runtimeMode: mode === "runtime" ? "full-access" : "approval-required",
          interactionMode: mode === "interaction" ? "default" : "plan",
        })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "plan",
          }),
          Effect.flip,
        );
      assert.equal(refusal.reason, "launch-authority");
      assert.deepEqual(yield* (yield* Bindings.ProjectCoordinators).list(), []);
    }).pipe(Effect.provide(harness())),
);

it.effect.each(["reservation", "thread"] as const)(
  "resume after %s checks stored modes, not lowered request modes or a spoofed creation source",
  (stage) =>
    Effect.gen(function* () {
      yield* seed;
      const intent = { ...savedIntent("high-authority"), runtimeMode: "full-access" } as const;
      const store = yield* Bindings.ProjectCoordinators;
      yield* store.reserve(intent);
      const threads = yield* Threads.ThreadManagementService;
      if (stage === "thread") {
        yield* threads.dispatch({
          type: "thread.create",
          commandId: intent.commandId,
          threadId: intent.threadId,
          projectId,
          title: "Original orchestrator",
          modelSelection,
          runtimeMode: intent.runtimeMode,
          interactionMode: intent.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: intent.createdBy,
          creationSource: intent.creationSource,
        });
      }
      const service = yield* Coordinator.ProjectCoordinatorService;
      const refused = yield* service
        .ensure({ ...input("limited-resume"), creationSource: "web" })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
          Effect.flip,
        );
      assert.equal(refused.reason, "launch-authority");
      assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 0);
      if (stage === "thread") {
        const projection = yield* threads.getThreadProjection(intent.threadId);
        assert.deepEqual(projection.messages, []);
        assert.deepEqual(projection.runs, []);
      } else {
        assert.isNull(yield* threads.getThreadShell(intent.threadId));
      }
      const resumed = yield* service.ensure(input("authorized-resume"));
      assert.equal(resumed.coordinator.runtimeMode, "full-access");
      const inspected = yield* service.ensure(input("read-existing")).pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "approval-required",
          interactionMode: "plan",
        }),
      );
      assert.equal(inspected.coordinator.threadId, intent.threadId);
      assert.equal(
        (yield* (yield* Threads.ThreadManagementService).getThreadProjection(intent.threadId))
          .messages.length,
        1,
      );
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "an interrupted launch keeps its reservation and retry sends the original orientation once",
  () =>
    Effect.gen(function* () {
      let refuseFolder = true;
      yield* Effect.gen(function* () {
        yield* seed;
        const service = yield* Coordinator.ProjectCoordinatorService;
        const failed = yield* service.ensure(input("interrupted-launch")).pipe(Effect.flip);
        assert.equal(failed.reason, "launch-failed");
        assert.notInclude(failed.message, "private provider details");
        const store = yield* Bindings.ProjectCoordinators;
        const reserved = Option.getOrThrow(yield* store.get(projectId));
        assert.equal(reserved.accepted, 0);
        assert.equal((yield* service.get({ projectId })).coordinator?.status, "launching");
        refuseFolder = false;
        const retried = yield* service.ensure({
          ...input("interrupted-launch"),
          modelSelection: { ...modelSelection, model: "different-retry-model" },
          runtimeMode: "full-access",
        });
        assert.isTrue(retried.resumed);
        assert.equal(retried.coordinator.threadId, reserved.intent.threadId);
        const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
          retried.coordinator.threadId,
        );
        assert.equal(projection.messages.length, 1);
        assert.equal(projection.messages[0]?.text, reserved.intent.prompt);
        assert.equal(projection.messages[0]?.id, reserved.intent.messageId);
        assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 1);
      }).pipe(
        Effect.provide(
          harness({
            beforeFolder: Effect.suspend(() =>
              refuseFolder
                ? Effect.fail(
                    new ManagedFolders.ScratchFolderError({
                      folder: "/private",
                      cause: new Error("private provider details"),
                    }),
                  )
                : Effect.void,
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "separate service instances resume the durable concurrent winner, not their requested settings",
  () =>
    Effect.gen(function* () {
      const atFolder = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* seed;
        const service = yield* Coordinator.ProjectCoordinatorService;
        const first = yield* service
          .ensure(input("first-instance"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(atFolder);
        const second = yield* Effect.gen(function* () {
          const otherInstance = yield* Coordinator.ProjectCoordinatorService;
          return yield* otherInstance.ensure({
            ...input("second-instance"),
            modelSelection: { ...modelSelection, model: "not-the-winner" },
          });
        }).pipe(Effect.provide(Coordinator.layer), Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        const winner = yield* Fiber.join(first);
        const resumed = yield* Fiber.join(second);
        assert.equal(resumed.coordinator.threadId, winner.coordinator.threadId);
        assert.deepEqual(resumed.coordinator.modelSelection, modelSelection);
        assert.isTrue(resumed.resumed);
        const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
          winner.coordinator.threadId,
        );
        assert.equal(projection.messages.length, 1);
        assert.equal(projection.runs.length, 1);
      }).pipe(
        Effect.provide(
          harness({
            beforeFolder: Deferred.succeed(atFolder, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          }),
        ),
      );
    }),
);

it.effect("a moved workspace cannot mutate an interrupted frozen launch", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Bindings.ProjectCoordinators;
    const intent = savedIntent("moved-workspace");
    yield* store.reserve(intent);
    yield* (yield* Projects.ProjectService).update({
      commandId: CommandId.make("move-project"),
      projectId,
      workspaceRoot: "/moved",
    });
    const refused = yield* (yield* Coordinator.ProjectCoordinatorService)
      .ensure(input("resume-moved"))
      .pipe(Effect.flip);
    assert.equal(refused.reason, "binding-changed");
    assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 0);
    assert.isNull(yield* (yield* Threads.ThreadManagementService).getThreadShell(intent.threadId));
  }).pipe(Effect.provide(harness())),
);

it.effect.each(["reservation", "thread"] as const)(
  "a moved workspace retires an interrupted %s until a fresh reviewed replacement",
  (stage) =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Bindings.ProjectCoordinators;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const threads = yield* Threads.ThreadManagementService;
      const intent = savedIntent(`moved-${stage}`);
      yield* store.reserve(intent);
      if (stage === "thread") {
        yield* threads.dispatch({
          type: "thread.create",
          commandId: intent.commandId,
          threadId: intent.threadId,
          projectId,
          title: "Original orchestrator",
          modelSelection,
          runtimeMode: intent.runtimeMode,
          interactionMode: intent.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "launching");
      yield* (yield* Projects.ProjectService).update({
        commandId: CommandId.make(`move-${stage}`),
        projectId,
        workspaceRoot: "/moved",
      });
      const retired = (yield* service.get({ projectId })).coordinator;
      assert.isNotNull(retired);
      assert.equal(retired.status, "missing");
      assert.equal(retired.threadId, intent.threadId);
      assert.deepEqual((yield* service.list()).coordinators, [retired]);
      assert.equal(
        (yield* service.ensure(input("unconfirmed-move")).pipe(Effect.flip)).reason,
        "binding-changed",
      );
      for (const expectedThreadId of [null, ThreadId.make("unrelated-thread")]) {
        assert.equal(
          (yield* service
            .ensure({
              ...input(`unreviewed-move:${expectedThreadId}`),
              replaceRetired: true,
              expectedThreadId,
            })
            .pipe(Effect.flip)).reason,
          "binding-changed",
        );
      }
      const replayInput = {
        ...input(intent.requestCommandId),
        replaceRetired: true,
        expectedThreadId: intent.threadId,
      };
      const beforeReplacement = yield* service.ensure(replayInput);
      assert.deepEqual(beforeReplacement.coordinator, retired);
      assert.isTrue(beforeReplacement.resumed);
      assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)).intent, intent);
      assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 0);
      const replacement = yield* service.ensure({
        ...input("fresh-moved-replacement"),
        replaceRetired: true,
        expectedThreadId: intent.threadId,
      });
      assert.notEqual(replacement.coordinator.threadId, intent.threadId);
      assert.isFalse(replacement.resumed);
      const current = Option.getOrThrow(yield* store.get(projectId));
      assert.equal(current.intent.workspaceRoot, "/moved");
      assert.equal(current.intent.previousThreadId, intent.threadId);
      assert.equal(current.accepted, 1);
      const historical = yield* service.ensure(replayInput);
      assert.equal(historical.coordinator.threadId, intent.threadId);
      assert.equal(historical.coordinator.status, "missing");
      assert.isFalse(historical.coordinator.current);
      assert.isTrue(historical.resumed);
      const original = Option.getOrThrow(yield* store.getByRequest(intent.requestCommandId));
      assert.deepEqual(original.intent, intent);
      assert.equal(original.accepted, 0);
      assert.equal(original.superseded, 1);
      if (stage === "thread") {
        const projection = yield* threads.getThreadProjection(intent.threadId);
        assert.deepEqual(projection.messages, []);
        assert.deepEqual(projection.runs, []);
      } else {
        assert.isNull(yield* threads.getThreadShell(intent.threadId));
      }
      const projection = yield* threads.getThreadProjection(replacement.coordinator.threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.messages[0]?.id, current.intent.messageId);
      assert.equal(projection.messages[0]?.text, current.intent.prompt);
      assert.equal(projection.runs.length, 1);
      assert.deepEqual((yield* service.list()).coordinators, [replacement.coordinator]);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT thread_id FROM project_coordinators`).length, 2);
    }).pipe(Effect.provide(harness())),
);

it.effect("moving a workspace preserves an accepted coordinator without reorientation", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Coordinator.ProjectCoordinatorService;
    const first = yield* service.ensure(input("accepted-before-move"));
    yield* (yield* Projects.ProjectService).update({
      commandId: CommandId.make("move-accepted-project"),
      projectId,
      workspaceRoot: "/moved",
    });
    assert.deepEqual((yield* service.get({ projectId })).coordinator, first.coordinator);
    assert.deepEqual((yield* service.list()).coordinators, [first.coordinator]);
    const reopened = yield* service.ensure({
      ...input("reopen-after-move"),
      replaceRetired: true,
      expectedThreadId: first.coordinator.threadId,
    });
    assert.deepEqual(reopened.coordinator, first.coordinator);
    assert.isTrue(reopened.resumed);
    const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
      first.coordinator.threadId,
    );
    assert.equal(projection.messages.length, 1);
    assert.equal(projection.runs.length, 1);
    assert.equal((yield* (yield* Bindings.ProjectCoordinators).list()).length, 1);
  }).pipe(Effect.provide(harness())),
);

it.effect.each([
  { status: "preparing", change: "workspace move" },
  { status: "running", change: "lower runtime ceiling" },
  { status: "idle", change: "lower interaction ceiling" },
  { status: "idle", change: "provider disable" },
] as const)(
  "an unacknowledged $status coordinator resumes without bootstrap after $change",
  ({ status, change }) =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Bindings.ProjectCoordinators;
      const threads = yield* Threads.ThreadManagementService;
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      let refuseAccept = true;
      const service = yield* Coordinator.ProjectCoordinatorService.pipe(
        Effect.provide(Layer.fresh(Coordinator.layer)),
        Effect.provideService(Bindings.ProjectCoordinators, {
          ...store,
          accept: (threadId) =>
            Effect.suspend(() =>
              refuseAccept
                ? Effect.fail(new ProjectCoordinatorError({ reason: "persistence-failure" }))
                : store.accept(threadId),
            ),
        }),
      );
      const originalInput = {
        ...input("accepted-before-ack"),
        runtimeMode: "full-access",
      } as const;
      const failure = yield* service.ensure(originalInput).pipe(Effect.flip);
      assert.equal(failure.reason, "persistence-failure");
      refuseAccept = false;
      const binding = Option.getOrThrow(yield* store.get(projectId));
      const { intent } = binding;
      assert.equal(binding.accepted, 0);
      assert.equal(binding.superseded, 0);
      assert.equal(intent.requestCommandId, originalInput.commandId);
      const acceptedReceipts: Array<Receipts.CommandReceiptV2> = [];
      for (const [commandId, commandType] of [
        [intent.commandId, "thread.create"],
        [CommandId.make(`${intent.commandId}:initial-message`), "message.dispatch"],
      ] as const) {
        const receipt = Option.getOrThrow(yield* receipts.getByCommandId(commandId));
        assert.equal(receipt.status, "accepted");
        assert.equal(receipt.commandId, commandId);
        assert.equal(receipt.commandType, commandType);
        assert.equal(receipt.threadId, intent.threadId);
        assert.isNull(receipt.error);
        acceptedReceipts.push(receipt);
      }
      const launched = yield* threads.getThreadProjection(intent.threadId);
      assert.equal(launched.messages.length, 1);
      assert.equal(launched.messages[0]?.id, intent.messageId);
      assert.equal(launched.messages[0]?.text, intent.prompt);
      assert.equal(launched.runs.length, 1);
      const run = launched.runs[0];
      if (run === undefined) return yield* Effect.die("Expected the accepted orientation run");
      if (status !== "preparing") {
        yield* threads.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make("release-before-ack"),
          threadId: intent.threadId,
          runId: run.id,
        });
      }
      if (status === "idle") {
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt-before-ack"),
          threadId: intent.threadId,
          runId: run.id,
        });
      }
      if (change === "workspace move") {
        yield* (yield* Projects.ProjectService).update({
          commandId: CommandId.make("move-before-ack"),
          projectId,
          workspaceRoot: "/moved",
        });
      }
      if (change === "provider disable") {
        yield* (yield* Settings.ServerSettingsService).updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
          },
        });
      }
      const coordinator = (yield* service.get({ projectId })).coordinator;
      assert.isNotNull(coordinator);
      assert.equal(coordinator.threadId, intent.threadId);
      assert.equal(coordinator.status, status);
      assert.isTrue(coordinator.current);
      assert.deepEqual((yield* service.list()).coordinators, [coordinator]);
      assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 0);
      const before = yield* threads.getThreadProjection(intent.threadId);
      yield* Effect.gen(function* () {
        for (const request of [
          { ...input("reopen-before-ack"), expectedThreadId: intent.threadId },
          {
            ...input("do-not-replace-live"),
            expectedThreadId: intent.threadId,
            replaceRetired: true,
          },
          originalInput,
        ]) {
          const reopened = yield* service.ensure(request);
          assert.deepEqual(reopened.coordinator, coordinator);
          assert.isTrue(reopened.resumed);
        }
      }).pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: change === "lower runtime ceiling" ? "approval-required" : "full-access",
          interactionMode: change === "lower interaction ceiling" ? "plan" : "default",
        }),
      );
      assert.deepEqual(yield* threads.getThreadProjection(intent.threadId), before);
      assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)).intent, intent);
      assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 1);
      assert.deepEqual(
        Option.getOrThrow(yield* store.getByRequest(originalInput.commandId)).intent,
        intent,
      );
      for (const receipt of acceptedReceipts) {
        assert.deepEqual(
          Option.getOrThrow(yield* receipts.getByCommandId(receipt.commandId)),
          receipt,
        );
      }
      assert.deepEqual((yield* service.list()).coordinators, [coordinator]);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT thread_id FROM project_coordinators`).length, 1);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "local run lifecycle distinguishes preparing, running and idle without reorientation",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const threads = yield* Threads.ThreadManagementService;
      const first = yield* service.ensure(input("lifecycle"));
      const threadId = first.coordinator.threadId;
      assert.equal(first.coordinator.status, "preparing");
      const run = (yield* threads.getThreadProjection(threadId)).runs[0];
      if (run === undefined) return yield* Effect.die("Expected the orientation run");
      yield* threads.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make("release-orientation"),
        threadId,
        runId: run.id,
      });
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "running");
      assert.equal((yield* service.list()).coordinators[0]?.status, "running");
      yield* threads.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-before-provider"),
        threadId,
        runId: run.id,
      });
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "idle");
      const reopened = yield* service.ensure(input("open-idle"));
      assert.equal(reopened.coordinator.threadId, threadId);
      assert.equal(reopened.coordinator.status, "idle");
      assert.equal((yield* threads.getThreadProjection(threadId)).messages.length, 1);
      assert.equal((yield* threads.getThreadProjection(threadId)).runs.length, 1);
    }).pipe(Effect.provide(harness())),
);

it.effect("resume schedules an admitted orientation interrupted before preparation", () =>
  Effect.gen(function* () {
    const prepared = yield* Deferred.make<void>();
    return yield* Effect.gen(function* () {
      yield* seed;
      const store = yield* Bindings.ProjectCoordinators;
      const threads = yield* Threads.ThreadManagementService;
      const service = yield* Coordinator.ProjectCoordinatorService;
      const intent = savedIntent("unscheduled-orientation");
      yield* store.reserve(intent);
      yield* threads.dispatch({
        type: "thread.create",
        commandId: intent.commandId,
        threadId: intent.threadId,
        projectId,
        title: "Original orchestrator",
        modelSelection,
        runtimeMode: intent.runtimeMode,
        interactionMode: intent.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: intent.createdBy,
        creationSource: intent.creationSource,
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${intent.commandId}:initial-message`),
        threadId: intent.threadId,
        messageId: intent.messageId,
        text: intent.prompt,
        attachments: [],
        modelSelection,
        dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
        createdBy: intent.createdBy,
        creationSource: intent.creationSource,
      });
      const before = yield* threads.getThreadProjection(intent.threadId);
      assert.equal(before.runs[0]?.status, "preparing");
      assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 0);
      const reopened = yield* service.ensure({
        ...input("resume-unscheduled-orientation"),
        expectedThreadId: intent.threadId,
      });
      assert.equal(reopened.coordinator.threadId, intent.threadId);
      assert.isTrue(reopened.resumed);
      yield* Deferred.await(prepared);
      assert.equal((yield* service.get({ projectId })).coordinator?.status, "running");
      const after = yield* threads.getThreadProjection(intent.threadId);
      assert.equal(after.runs.length, 1);
      assert.equal(after.runs[0]?.id, before.runs[0]?.id);
      assert.deepEqual(after.messages, before.messages);
      assert.equal(after.messages[0]?.id, intent.messageId);
      assert.equal(after.messages[0]?.text, intent.prompt);
      assert.equal(Option.getOrThrow(yield* store.get(projectId)).accepted, 1);
    }).pipe(
      Effect.provide(
        harness({
          afterPreparation: Deferred.succeed(prepared, undefined).pipe(Effect.as(undefined)),
        }),
      ),
    );
  }),
);
