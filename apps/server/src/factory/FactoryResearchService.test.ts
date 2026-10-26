import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type FactoryResearchProtocol,
  type FactoryResearchRunLaunchInput,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import * as Factory from "./FactoryResearchService.ts";
import * as Store from "../persistence/FactoryResearchStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Enrichment from "../project/ProjectEnrichmentService.ts";
import * as Favicons from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as CloneTracker from "../project/ProjectCloneTracker.ts";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";
import * as SetupRunner from "../project/ProjectSetupScriptRunner.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
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

const projectId = ProjectId.make("research-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const B = "b".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const identity: RepositoryIdentity = {
  canonicalKey: "github.com/owner/factory",
  provider: "github",
  rootPath: "/repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:owner/factory.git",
  },
  origin: {
    canonicalKey: "github.com/owner/factory",
    remoteUrl: "git@github.com:owner/factory.git",
  },
};
const sealInput = {
  commandId: CommandId.make("seal"),
  projectId,
  expectedRepositoryKey: identity.canonicalKey,
  hypothesis: "The change lowers validation bits per byte.",
  runCommand: "python train.py",
  evaluatorPaths: ["prepare.py"],
  metric: {
    name: "validation bpb",
    linePrefix: "val_bpb:",
    direction: "lower" as const,
    minimumEffect: 0.01,
  },
  budget: { maxRuns: 10, maxRunMinutes: 5, expiresAt: "2099-01-01T00:00:00.000Z" },
};
const launchInput = (
  protocol: FactoryResearchProtocol,
  command: string,
): FactoryResearchRunLaunchInput => ({
  commandId: CommandId.make(command),
  projectId,
  expectedRepositoryKey: identity.canonicalKey,
  protocolId: protocol.id,
  expectedProtocolRevision: protocol.revision,
  role: "explore",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
});
const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-research-test-" });
  const commits: string[] = [];
  const gitCalls: string[][] = [];
  const database = Sqlite.layerMemory;
  const settings = Settings.layerTest();
  const registry = Registry.layerFromAdapters([
    {
      instanceId: modelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Research tests never execute a provider"),
    },
  ]);
  const orchestrator = Replay.layerWithRegistry({ name: "factory-research" }, registry, {
    databaseLayer: database,
    runEffectWorker: false,
  });
  const receipts = Receipts.layer.pipe(Layer.provide(database));
  const threads = Threads.layer.pipe(
    Layer.provide(Layer.mergeAll(orchestrator, settings, receipts)),
  );
  const external = Layer.mergeAll(
    Layer.succeed(Identities.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(identity),
    }),
    Layer.succeed(Favicons.ProjectFaviconResolver, {
      resolvePath: () => Effect.succeed(null),
      invalidate: () => Effect.void,
    }),
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (value) => Effect.succeed(value),
    }),
    Layer.mock(Git.GitVcsDriver)({
      resolveCommit: ({ revision }) =>
        Effect.sync(() => {
          commits.push(revision);
          return { commitSha: revision === "HEAD" ? B : revision };
        }),
      execute: ({ args }) => {
        gitCalls.push([...args]);
        const key = JSON.stringify(args);
        let stdout: string;
        if (key === JSON.stringify(["remote", "get-url", "--", "origin"]))
          stdout = "git@github.com:owner/factory.git";
        else if (
          key === JSON.stringify(["rev-parse", "--verify", `${B}:prepare.py`]) ||
          key === JSON.stringify(["rev-parse", "--verify", `${C1}:prepare.py`])
        )
          stdout = "p0";
        else if (key === JSON.stringify(["rev-parse", "--verify", `${C2}:prepare.py`]))
          stdout = "p1";
        else if (
          [B, C1, C2].some(
            (commit) => key === JSON.stringify(["merge-base", "--is-ancestor", B, commit]),
          )
        )
          stdout = "";
        else if (
          args.length === 3 &&
          args[0] === "update-ref" &&
          args[1]?.startsWith("refs/t3/research/") &&
          [B, C1, C2].includes(args[2] ?? "")
        )
          stdout = "";
        else return Effect.die(`Unexpected git arguments: ${key}`);
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: () => Effect.succeed(false),
      hasCommit: () => Effect.succeed(true),
      createWorktree: ({ refName }) =>
        fs.makeTempDirectory({ directory: root }).pipe(
          Effect.orDie,
          Effect.map((worktreePath) => ({
            worktree: { path: worktreePath, refName: "research-fixture", headSha: refName },
          })),
        ),
    }),
    Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(Terminal.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(SetupRunner.ProjectSetupScriptRunner)({
      runForThread: () => Effect.succeed({ status: "no-script" }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateBranchName: () => Effect.succeed({ branch: "research-fixture" }),
    }),
    ProviderRegistryMock.layer(),
    settings,
    SetupTracker.layer,
    ThreadCommands.layer,
    IdAllocator.layer,
  );
  const enrichment = Enrichment.layer.pipe(Layer.provide(external));
  const projects = Runtime.layerProjectService.pipe(
    Layer.provide(Layer.mergeAll(enrichment, external, database)),
  );
  const folders = ManagedFolders.layer.pipe(Layer.provide(Layer.mergeAll(projects, external)));
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
    Store.layer.pipe(Layer.provide(database)),
    database,
  );
  const layer = Layer.mergeAll(Factory.layer.pipe(Layer.provide(dependencies)), dependencies).pipe(
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "factory-research-config-" })),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, commits, gitCalls };
});
const seed = Effect.gen(function* () {
  yield* (yield* Projects.ProjectService).create({
    commandId: CommandId.make("create"),
    projectId,
    title: "Research",
    workspaceRoot: "/repo",
    defaultModelSelection: modelSelection,
    scripts: [],
  });
  const factory = yield* Factory.FactoryResearchService;
  return { factory, protocol: (yield* factory.sealProtocol(sealInput)).protocol };
});
const writeLog = Effect.fn("ResearchTest.writeLog")(function* (threadId: ThreadId, text: string) {
  const threads = yield* Threads.ThreadManagementService;
  yield* threads.streamStoredEventsFrom({ threadId }).pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "run.updated" &&
        (stored.commandId?.endsWith(":release") === true ||
          stored.event.payload.status === "failed"),
    ),
    Stream.runHead,
  );
  const shell = yield* threads.getThreadShell(threadId);
  assert.isNotNull(shell?.worktreePath);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(shell!.worktreePath!, "run.log"), text);
});
const evidenceInput = (threadId: ThreadId, commit: string) => ({
  projectId,
  threadId,
  commit,
  citations: [{ path: "run.log", line: 2 }],
  missing: [],
});
const record = Effect.fn("ResearchTest.record")(function* (
  threadId: ThreadId,
  commit: string,
  value: string,
) {
  yield* writeLog(threadId, `measurement\nval_bpb: ${value}\n`);
  return yield* (yield* Factory.FactoryResearchService).recordEvidence(
    evidenceInput(threadId, commit),
    threadId,
  );
});

it.effect(
  "seal on B with prepare.py p0; C2 evaluator-changed, C1 acceptable server value stays 0.95 after overwrite; verification-missing cannot admit; only the run thread records",
  () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Effect.gen(function* () {
        const { factory, protocol } = yield* seed;
        const baseline = yield* factory.launchRun(launchInput(protocol, "baseline"));
        yield* record(baseline.threadId, B, "1.000000");
        const R = yield* factory.launchRun(launchInput(protocol, "R"));
        const c1 = (yield* record(R.threadId, C1, "0.950000")).observation;
        const changed = yield* factory.launchRun(launchInput(protocol, "changed"));
        const c2 = (yield* record(changed.threadId, C2, "0.900000")).observation;
        assert.equal(c2.disposition, "evaluator-changed");
        assert.equal(c1.disposition, "acceptable");
        assert.equal(c1.metricValue, 0.95);
        const expectedHash = yield* (yield* Crypto.Crypto)
          .digest("SHA-256", new TextEncoder().encode("measurement\nval_bpb: 0.950000\n"))
          .pipe(Effect.map(Hex.encode), Effect.orDie);
        assert.equal(c1.artifacts[0]?.sha256, expectedHash);
        yield* writeLog(R.threadId, "changed\nval_bpb: 0.100000\n");
        const current = yield* factory.readProtocol({ projectId, protocolId: protocol.id });
        assert.deepEqual(current.runs.find((run) => run.threadId === R.threadId)?.observation, c1);
        assert.equal(current.finding.status, "unknown");
        assert.deepEqual(current.finding.reasons, ["verification-missing"]);
        const beforeCommits = test.commits.length;
        const refusal = yield* factory
          .admitImplementation({
            ...launchInput(protocol, "admit"),
            expectedFindingRevision: current.finding.revision,
          })
          .pipe(Effect.flip);
        assert.equal(refusal.reason, "finding-not-supported");
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT * FROM factory_research_launches WHERE role = 'implementation'`)
            .length,
          0,
        );
        assert.equal(test.commits.length, beforeCommits);
        assert.equal(
          (yield* factory
            .recordEvidence(evidenceInput(R.threadId, C1), ThreadId.make("other"))
            .pipe(Effect.flip)).reason,
          "not-run-thread",
        );
        assert.equal(
          (yield* factory
            .recordEvidence(evidenceInput(R.threadId, C1), R.threadId)
            .pipe(Effect.flip)).reason,
          "evidence-already-recorded",
        );
        const stored = Option.getOrThrow(
          yield* (yield* Store.FactoryResearchStore).getEvidence(R.threadId),
        );
        assert.notProperty(stored, "disposition");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "baseline, explore and independent web verification support implementation on C1; commands replay once",
  () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Effect.gen(function* () {
        const { factory, protocol } = yield* seed;
        assert.equal(
          (yield* factory.sealProtocol({ ...sealInput, hypothesis: "ignored replay" })).protocol.id,
          protocol.id,
        );
        assert.equal(test.commits.length, 1);
        const baseline = yield* factory.launchRun(launchInput(protocol, "baseline"));
        yield* record(baseline.threadId, B, "1.000000");
        const explore = yield* factory.launchRun({
          ...launchInput(protocol, "explore"),
          creationSource: "mcp",
          launchedByThreadId: ThreadId.make("producer"),
        });
        yield* record(explore.threadId, C1, "0.950000");
        const verifyInput = {
          ...launchInput(protocol, "verify"),
          role: "verify" as const,
          targetCommit: C1,
        };
        assert.equal(
          (yield* factory.launchRun({ ...verifyInput, creationSource: "mcp" }).pipe(Effect.flip))
            .reason,
          "verify-requires-user",
        );
        assert.equal(
          (yield* factory
            .launchRun({ ...verifyInput, launchedByThreadId: explore.threadId })
            .pipe(Effect.flip)).reason,
          "verification-not-independent",
        );
        assert.equal(
          (yield* factory
            .launchRun({ ...verifyInput, launchedByThreadId: ThreadId.make("producer") })
            .pipe(Effect.flip)).reason,
          "verification-not-independent",
        );
        const verify = yield* factory.launchRun(verifyInput);
        yield* record(verify.threadId, C1, "0.960000");
        const view = yield* factory.readProtocol({ projectId, protocolId: protocol.id });
        assert.equal(view.finding.status, "supported");
        const admitted = yield* factory.admitImplementation({
          ...launchInput(protocol, "admit"),
          expectedFindingRevision: view.finding.revision,
          instructions: "Implement with tests.",
        });
        assert.equal(admitted.task.baseRef, C1);
        const replay = yield* factory.admitImplementation({
          ...launchInput(protocol, "admit"),
          expectedFindingRevision: view.finding.revision,
        });
        assert.equal(replay.threadId, admitted.threadId);
        assert.isTrue(replay.resumed);
        assert.equal((yield* factory.launchRun(verifyInput)).threadId, verify.threadId);
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT * FROM factory_research_launches`).length, 4);
        const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
          admitted.threadId,
        );
        assert.equal(projection.thread.createdBy, "user");
        assert.include(JSON.stringify(projection.messages), "Supported finding");
        assert.include(JSON.stringify(projection.messages), "factory_record_research_evidence");
        assert.equal((yield* factory.listProtocols({ projectId })).protocols.length, 1);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "favourable over-budget evidence cannot support a finding; protocol expiry and run cap refuse launches",
  () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Effect.gen(function* () {
        const { factory, protocol } = yield* seed;
        const baseline = yield* factory.launchRun(launchInput(protocol, "baseline"));
        yield* record(baseline.threadId, B, "1.0");
        const explore = yield* factory.launchRun(launchInput(protocol, "slow"));
        yield* TestClock.adjust("6 minutes");
        assert.equal(
          (yield* record(explore.threadId, C1, "0.01")).observation.disposition,
          "over-budget",
        );
        const view = yield* factory.readProtocol({ projectId, protocolId: protocol.id });
        assert.equal(view.finding.status, "unknown");
        assert.equal(
          (yield* factory
            .admitImplementation({
              ...launchInput(protocol, "admit"),
              expectedFindingRevision: view.finding.revision,
            })
            .pipe(Effect.flip)).reason,
          "finding-not-supported",
        );
        const capped = (yield* factory.sealProtocol({
          ...sealInput,
          commandId: CommandId.make("capped"),
          budget: { ...sealInput.budget, maxRuns: 1 },
        })).protocol;
        yield* factory.launchRun(launchInput(capped, "one"));
        assert.equal(
          (yield* factory.launchRun(launchInput(capped, "two")).pipe(Effect.flip)).reason,
          "budget-exhausted",
        );
        const expired = (yield* factory.sealProtocol({
          ...sealInput,
          commandId: CommandId.make("expired"),
          budget: { ...sealInput.budget, expiresAt: "1970-01-01T00:00:01.000Z" },
        })).protocol;
        assert.equal(
          (yield* factory.launchRun(launchInput(expired, "past")).pipe(Effect.flip)).reason,
          "protocol-expired",
        );
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("citation containment rejects escapes and invalid lines remain inadmissible", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    yield* Effect.gen(function* () {
      const { factory, protocol } = yield* seed;
      const run = yield* factory.launchRun(launchInput(protocol, "citation"));
      yield* writeLog(run.threadId, "one line");
      assert.equal(
        (yield* factory
          .recordEvidence(
            { ...evidenceInput(run.threadId, C1), citations: [{ path: "../outside", line: 1 }] },
            run.threadId,
          )
          .pipe(Effect.flip)).reason,
        "citation-outside-worktree",
      );
      const result = yield* factory.recordEvidence(evidenceInput(run.threadId, C1), run.threadId);
      assert.equal(result.observation.disposition, "citation-invalid");
      assert.isNull(result.observation.metricValue);
      assert.isNull(result.observation.artifacts[0]?.lineText);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "uncleared effect, stale finding and undeclared rule cannot promote; large artifacts retain digests",
  () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Effect.gen(function* () {
        const { factory, protocol } = yield* seed;
        assert.equal(
          (yield* factory
            .launchRun({ ...launchInput(protocol, "stale"), expectedProtocolRevision: "stale" })
            .pipe(Effect.flip)).reason,
          "protocol-changed",
        );
        assert.equal(
          (yield* factory
            .launchRun({
              ...launchInput(protocol, "missing-target"),
              role: "verify",
              targetCommit: C1,
            })
            .pipe(Effect.flip)).reason,
          "verify-target-missing",
        );
        const baseline = yield* factory.launchRun(launchInput(protocol, "baseline"));
        yield* record(baseline.threadId, B, "1.0");
        const explore = yield* factory.launchRun(launchInput(protocol, "explore"));
        yield* writeLog(explore.threadId, `${"x".repeat(300_000)}\nval_bpb: 0.95\n`);
        const observation = (yield* factory.recordEvidence(
          evidenceInput(explore.threadId, C1),
          explore.threadId,
        )).observation;
        assert.equal(observation.artifacts[0]?.retention, "digest-only");
        assert.equal(observation.metricValue, 0.95);
        const sql = yield* SqlClient.SqlClient;
        assert.deepInclude(
          (yield* sql`SELECT retention, content FROM factory_research_artifacts WHERE thread_id = ${explore.threadId}`)[0],
          { retention: "digest-only", content: null },
        );
        const prior = (yield* factory.readProtocol({ projectId, protocolId: protocol.id })).finding;
        const verify = yield* factory.launchRun({
          ...launchInput(protocol, "verify"),
          role: "verify",
          targetCommit: C1,
        });
        yield* record(verify.threadId, C1, "0.999");
        const current = (yield* factory.readProtocol({ projectId, protocolId: protocol.id }))
          .finding;
        assert.equal(current.status, "unsupported");
        assert.deepEqual(current.reasons, ["effect-below-minimum"]);
        assert.equal(
          (yield* factory
            .admitImplementation({
              ...launchInput(protocol, "admit"),
              expectedFindingRevision: prior.revision,
            })
            .pipe(Effect.flip)).reason,
          "finding-changed",
        );
        const undeclared = (yield* factory.sealProtocol({
          ...sealInput,
          commandId: CommandId.make("undeclared"),
          metric: { ...sealInput.metric, minimumEffect: null },
        })).protocol;
        assert.deepEqual(
          (yield* factory.readProtocol({ projectId, protocolId: undeclared.id })).finding.reasons,
          ["rule-not-declared"],
        );
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
