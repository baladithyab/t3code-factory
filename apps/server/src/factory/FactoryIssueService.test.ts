import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  GitCommandError,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2CreationSource,
  ThreadId,
  SourceControlProviderKind,
  type FactoryIssueStartInput,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import {
  IssueTrackerProviderError,
  type IssueTrackerProviderApi,
  type TrackerIssue,
} from "@t3tools/source-control-core/server/IssueTrackerProvider";
import { fakeIssueTracker, issueTrackersLayer } from "./IssueTrackerProviderRegistry.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import * as Factory from "./FactoryIssueService.ts";
import * as Launches from "../persistence/FactoryIssueLaunches.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import { repositoryIdentitiesLayer } from "../project/RepositoryIdentityResolver.testkit.ts";
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
import * as Recovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { issueOriginKey } from "./FactoryOriginKey.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";

const environmentId = EnvironmentId.make("issue-environment");

const projectId = ProjectId.make("factory-project");
const secondProjectId = ProjectId.make("factory-second-checkout");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const baseRef = "a".repeat(40);
const issue: TrackerIssue = {
  number: 12,
  title: "Implement issue intake",
  body: "Untrusted issue text",
  state: "open",
  url: "https://github.com/owner/factory/issues/12",
  labels: ["feature"],
  updatedAt: "2026-10-23T00:00:00.000Z",
};
const identity: RepositoryIdentity = {
  canonicalKey: "github.com/upstream/root",
  provider: "github",
  rootPath: "/repo",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "git@github.com:upstream/root.git",
  },
  origin: {
    canonicalKey: "github.com/owner/factory",
    remoteUrl: "git@github.com:Owner/Factory.git",
  },
};
const startInput = (command: string): Omit<FactoryIssueStartInput, "expectedIssueRevision"> => ({
  commandId: CommandId.make(command),
  projectId,
  issueNumber: 12,
  modelSelection,
  expectedRepositoryKey: "github.com/owner/factory",
  runtimeMode: "approval-required",
  interactionMode: "default",
});
// Never matches live content. Refusals before the issue read and saved-task resumes ignore it.
const unreviewed = "unreviewed";
/** A start request for the revision the public read presents for review. */
const reviewedInput = (
  command: string,
  overrides: Partial<Pick<FactoryIssueStartInput, "projectId" | "issueNumber">> = {},
) =>
  Effect.gen(function* () {
    const target = { projectId, issueNumber: 12, ...overrides };
    const reviewed = yield* (yield* Factory.FactoryIssueService).read(target);
    return {
      ...startInput(command),
      ...target,
      expectedIssueRevision: reviewed.issue.revision,
    } satisfies FactoryIssueStartInput;
  });
const remoteIssue = (current: () => TrackerIssue): Partial<IssueTrackerProviderApi> => ({
  getIssue: () => Effect.sync(current),
  listIssues: () => Effect.sync(() => ({ issues: [current()], nextPage: null })),
});
const fakeTracker = (
  overrides: Partial<IssueTrackerProviderApi> = {},
): IssueTrackerProviderApi => ({
  ...fakeIssueTracker("github"),
  getIssue: () => Effect.succeed(issue),
  listIssues: () => Effect.succeed({ issues: [issue], nextPage: null }),
  ...overrides,
});

function harness(
  options: {
    readonly tracker?: Partial<IssueTrackerProviderApi>;
    readonly trackers?: ReadonlyArray<IssueTrackerProviderApi>;
    readonly resolve?: Identities.RepositoryIdentityResolver["Service"]["resolve"];
    readonly refine?: Identities.RepositoryIdentityResolverOptions["refine"];
    readonly resolveCommit?: Git.GitVcsDriver["Service"]["resolveCommit"];
    readonly execute?: Git.GitVcsDriver["Service"]["execute"];
    readonly runForThread?: SetupRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
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
      openSession: () => Effect.die("Factory tests never execute a provider"),
    },
  ]);
  const orchestrator = Replay.layerWithRegistry({ name: "factory-issues" }, registry, {
    databaseLayer: database,
    runEffectWorker: false,
  });
  const receipts = Receipts.layer.pipe(Layer.provide(database));
  const threads = Threads.layer.pipe(
    Layer.provide(Layer.mergeAll(orchestrator, settings, receipts)),
  );
  const external = Layer.mergeAll(
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    repositoryIdentitiesLayer(options.resolve ?? (() => Effect.succeed(identity)), {
      ...(options.refine ? { refine: options.refine } : {}),
    }),
    Layer.succeed(Favicons.ProjectFaviconResolver, {
      resolvePath: () => Effect.succeed(null),
      invalidate: () => Effect.void,
    }),
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (root) => Effect.succeed(root),
    }),
    issueTrackersLayer(options.trackers ?? [fakeTracker(options.tracker)]),
    Layer.mock(Git.GitVcsDriver)({
      resolveCommit: options.resolveCommit ?? (() => Effect.succeed({ commitSha: baseRef })),
      execute:
        options.execute ??
        (({ cwd }) =>
          (options.resolve ?? (() => Effect.succeed(identity)))(cwd, { refresh: true }).pipe(
            Effect.map((resolved) => ({
              exitCode: ChildProcessSpawner.ExitCode(resolved === null ? 2 : 0),
              stdout: resolved?.origin?.remoteUrl ?? resolved?.locator.remoteUrl ?? "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
          )),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: () => Effect.succeed(false),
      // Hold preparation at the external process boundary; no provider or filesystem work runs.
      createWorktree: () => Effect.never,
      hasCommit: () => Effect.succeed(true),
    }),
    Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(Terminal.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(SetupRunner.ProjectSetupScriptRunner)({
      runForThread: options.runForThread ?? (() => Effect.never),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateBranchName: () => Effect.succeed({ branch: "issue-intake" }),
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
    Launches.layer.pipe(Layer.provide(database)),
    database,
  );
  return {
    dependencies,
    layer: Layer.mergeAll(Factory.layer.pipe(Layer.provide(dependencies)), dependencies).pipe(
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "factory-test-" })),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
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
      title: "Factory",
      workspaceRoot: root,
      defaultModelSelection: modelSelection,
      scripts: [],
    });
  }
});

it.effect("uses the fork origin and preserves the tracker's empty-page continuation", () => {
  const requests: Array<Parameters<IssueTrackerProviderApi["listIssues"]>[0]> = [];
  return Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const result = yield* factory.list({ projectId, page: 2, state: "all" });
    assert.equal(result.repository.canonicalKey, "github.com/owner/factory");
    assert.deepEqual(result.issues, []);
    assert.equal(result.nextPage, 3);
    assert.equal(result.capabilities.displayName, "GitHub");
    assert.deepInclude(requests[0], {
      cwd: "/repo",
      repository: "owner/factory",
      host: "github.com",
      page: 2,
      state: "all",
    });
  }).pipe(
    Effect.provide(
      harness({
        tracker: {
          listIssues: (input) => {
            requests.push(input);
            return Effect.succeed({ issues: [], nextPage: 3 });
          },
        },
      }).layer,
    ),
  );
});

it.effect(
  "lists GitLab capabilities and starts a nested GitLab issue with its own origin key",
  () => {
    const repository = "group/subgroup/project";
    const canonicalKey = `gitlab.com/${repository}`;
    const tracker = fakeIssueTracker(
      "gitlab",
      remoteIssue(() => ({
        ...issue,
        url: `https://${canonicalKey}/-/issues/12`,
      })),
    );
    return Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const listed = yield* factory.list({ projectId });
      assert.deepEqual(listed.capabilities, { provider: "gitlab", ...tracker.capabilities });
      assert.deepInclude(listed.repository, {
        provider: tracker.kind,
        repository,
        canonicalKey,
        url: `https://${canonicalKey}`,
      });
      const read = yield* factory.read({ projectId, issueNumber: 12 });
      assert.deepEqual(read.capabilities, listed.capabilities);
      const started = yield* factory.start({
        ...startInput("gitlab-start"),
        expectedRepositoryKey: canonicalKey,
        expectedIssueRevision: read.issue.revision,
      });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT origin_key FROM factory_issue_launches`;
      assert.equal(rows[0]?.origin_key, `gitlab:${canonicalKey}#12`);
      const { messages } = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
        started.threadId,
      );
      assert.include(messages[0]?.text ?? "", "this GitLab issue");
      assert.notInclude(messages[0]?.text ?? "", "this GitHub issue");
    }).pipe(
      Effect.provide(
        harness({
          trackers: [tracker],
          resolve: () =>
            Effect.succeed({
              canonicalKey,
              provider: "gitlab",
              rootPath: "/repo",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: `https://${canonicalKey}.git`,
              },
            }),
        }).layer,
      ),
    );
  },
);

it.effect("rejects a provider without an issue tracker", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    assert.equal(
      (yield* factory.list({ projectId }).pipe(Effect.flip)).reason,
      "unsupported-provider",
    );
    assert.equal(
      (yield* factory.read({ projectId, issueNumber: 12 }).pipe(Effect.flip)).reason,
      "unsupported-provider",
    );
    assert.equal(
      (yield* factory
        .start({ ...startInput("unsupported"), expectedIssueRevision: unreviewed })
        .pipe(Effect.flip)).reason,
      "unsupported-provider",
    );
  }).pipe(Effect.provide(harness({ trackers: [] }).layer)),
);

it.effect.each(["before-reservation", "before-resume"] as const)(
  "rejects a provider change at %s even when the canonical key stays the same",
  (phase) => {
    const canonicalKey = "forge.example/owner/project";
    let provider = "github";
    return Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const reviewed = yield* factory.read({ projectId, issueNumber: 12 });
      const input = {
        ...startInput("provider-change"),
        expectedRepositoryKey: canonicalKey,
        expectedIssueRevision: reviewed.issue.revision,
      };
      const sql = yield* SqlClient.SqlClient;
      if (phase === "before-resume") {
        const first = yield* factory.start(input);
        yield* sql`UPDATE factory_issue_launches SET accepted = 0 WHERE thread_id = ${first.threadId}`;
        provider = "gitlab";
      }
      assert.equal((yield* factory.start(input).pipe(Effect.flip)).reason, "repository-changed");
      const rows = yield* sql`SELECT thread_id FROM factory_issue_launches`;
      assert.equal(rows.length, phase === "before-reservation" ? 0 : 1);
    }).pipe(
      Effect.provide(
        harness({
          trackers: [fakeTracker(), fakeIssueTracker("gitlab")],
          refine: (remote) => Effect.succeed({ ...remote, provider }),
          resolve: () =>
            Effect.succeed({
              canonicalKey,
              provider,
              rootPath: "/repo",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: `https://${canonicalKey}.git`,
              },
            }),
          resolveCommit: () =>
            Effect.sync(() => {
              if (phase === "before-reservation") provider = "gitlab";
              return { commitSha: baseRef };
            }),
        }).layer,
      ),
    );
  },
);

it.effect(
  "concurrent starts from different checkouts persist one thread, run and initial prompt",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const reviewed = yield* reviewedInput("first");
      const results = yield* Effect.all(
        [
          factory.start(reviewed),
          factory.start({
            ...reviewed,
            commandId: CommandId.make("second"),
            projectId: secondProjectId,
          }),
        ],
        { concurrency: "unbounded" },
      );
      const first = results[0];
      const second = results[1];
      assert.equal(first.threadId, second.threadId);
      assert.equal(first.projectId, second.projectId);
      assert.equal(first.task.baseRef, baseRef);
      const threads = yield* Threads.ThreadManagementService;
      const projection = yield* threads.getThreadProjection(first.threadId);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.messages.length, 1);
      const binding = Option.getOrThrow(
        yield* (yield* Launches.FactoryIssueLaunches).get({
          canonicalKey: first.repository.canonicalKey,
          issueNumber: issue.number,
        }),
      );
      assert.equal(binding.intent.admittedBy, environmentId);
      const sql = yield* SqlClient.SqlClient;
      const rows =
        yield* sql`SELECT origin_key FROM factory_issue_launches WHERE thread_id = ${first.threadId}`;
      assert.equal(
        rows[0]?.origin_key,
        issueOriginKey(first.repository.provider, first.repository.canonicalKey, issue.number),
      );
      const again = yield* factory.start({
        ...startInput("third"),
        expectedIssueRevision: unreviewed,
        modelSelection: { ...modelSelection, model: "different" },
      });
      assert.equal(again.threadId, first.threadId);
      assert.isTrue(again.resumed);
      assert.equal((yield* threads.getThreadProjection(first.threadId)).messages.length, 1);
    }).pipe(Effect.provide(harness().layer)),
);

it.effect.each(["reservation", "thread", "message", "response"] as const)(
  "recovers after $0 with stable original parameters and no second prompt",
  (crashAfter) =>
    Effect.gen(function* () {
      yield* seed;
      const launches = yield* Launches.FactoryIssueLaunches;
      const threads = yield* Threads.ThreadManagementService;
      const intent: Launches.FactoryLaunchIntent = {
        repository: {
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          repository: "owner/factory",
          canonicalKey: "github.com/owner/factory",
          url: "https://github.com/owner/factory",
        },
        issue: {
          number: 12,
          title: issue.title,
          body: issue.body,
          state: "open",
          url: issue.url,
          labels: [],
          updatedAt: issue.updatedAt,
          task: null,
        },
        projectId,
        workspaceRoot: "/repo",
        requestCommandId: CommandId.make("original-request"),
        commandId: CommandId.make("original-launch"),
        threadId: ThreadId.make("original-thread"),
        messageId: MessageId.make("original-message"),
        baseRef,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        prompt: "Original immutable prompt",
        createdBy: "user",
        creationSource: "web",
        createdAt: issue.updatedAt,
        previousThreadId: null,
      };
      yield* launches.reserve(intent);
      if (crashAfter !== "reservation")
        yield* threads.dispatch({
          type: "thread.create",
          commandId: intent.commandId,
          threadId: intent.threadId,
          projectId,
          title: `#12 ${issue.title}`,
          modelSelection,
          runtimeMode: intent.runtimeMode,
          interactionMode: intent.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      if (crashAfter === "message" || crashAfter === "response")
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${intent.commandId}:initial-message`),
          threadId: intent.threadId,
          messageId: intent.messageId,
          text: intent.prompt,
          attachments: [],
          modelSelection,
          dispatchMode: {
            type: "defer_start",
            workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
          },
          createdBy: "user",
          creationSource: "web",
        });
      if (crashAfter === "response") yield* launches.accept(intent.threadId);
      // A newly constructed feature service reads SQLite, not an in-memory factory lock/cache.
      const fresh = yield* Factory.FactoryIssueService.pipe(Effect.provide(Factory.layer));
      const result = yield* fresh.start({
        ...startInput("retry"),
        expectedIssueRevision: unreviewed,
        baseRef: "changed",
        modelSelection: { ...modelSelection, model: "changed" },
      });
      assert.equal(result.threadId, intent.threadId);
      assert.isTrue(result.resumed);
      const projection = yield* threads.getThreadProjection(intent.threadId);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.messages[0]?.id, intent.messageId);
      assert.equal(projection.messages[0]?.text, intent.prompt);
      assert.equal(projection.runs[0]?.modelSelection.model, modelSelection.model);
      assert.equal(projection.runs[0]?.workspacePreparation?.type, "worktree");
    }).pipe(Effect.provide(harness().layer)),
);

it.effect(
  "a deleted thread needs explicit restart and simultaneous restarts retain one new attempt",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const threads = yield* Threads.ThreadManagementService;
      const first = yield* factory.start(yield* reviewedInput("original"));
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete"),
        threadId: first.threadId,
      });
      assert.equal((yield* factory.list({ projectId })).issues[0]?.task?.status, "missing");
      assert.equal(
        (yield* factory.start(yield* reviewedInput("unconfirmed")).pipe(Effect.flip)).reason,
        "deleted-task",
      );
      const restart = { ...(yield* reviewedInput("restart-a")), restartDeleted: true };
      const [a, b] = yield* Effect.all(
        [
          factory.start(restart),
          factory.start({ ...restart, commandId: CommandId.make("restart-b") }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(a.threadId, b.threadId);
      assert.notEqual(a.threadId, first.threadId);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT thread_id, superseded FROM factory_issue_launches`;
      assert.equal(rows.length, 2);
      assert.equal(rows.filter((row) => row.superseded === 0).length, 1);
      const current = Option.getOrThrow(
        yield* (yield* Launches.FactoryIssueLaunches).get({
          canonicalKey: "github.com/owner/factory",
          issueNumber: 12,
        }),
      );
      assert.equal(current.intent.previousThreadId, first.threadId);
    }).pipe(Effect.provide(harness().layer)),
);

it.effect("refuses a stale reviewed revision before resolving a base or reserving work", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const staleInput = {
      ...startInput("stale-review"),
      expectedIssueRevision: "0".repeat(64),
    };
    assert.equal((yield* factory.start(staleInput).pipe(Effect.flip)).reason, "issue-changed");
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
  }).pipe(
    Effect.provide(
      harness({
        resolveCommit: () => Effect.die("Unreviewed content reached base resolution"),
      }).layer,
    ),
  ),
);

it.effect("starts a listed revision after metadata-only edits and links it on read", () => {
  let remote: TrackerIssue = issue;
  return Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const listed = (yield* factory.list({ projectId })).issues[0];
    if (listed === undefined) return yield* Effect.die("Expected the listed issue");
    remote = { ...issue, labels: ["triaged"], updatedAt: "2026-10-24T00:00:00.000Z" };
    const started = yield* factory.start({
      ...startInput("from-list"),
      expectedIssueRevision: listed.revision,
    });
    assert.isFalse(started.resumed);
    const reread = yield* factory.read({ projectId, issueNumber: 12 });
    assert.equal(reread.issue.task?.threadId, started.threadId);
  }).pipe(Effect.provide(harness({ tracker: remoteIssue(() => remote) }).layer));
});

const contentEdits: ReadonlyArray<{
  readonly change: string;
  readonly reviewed: { readonly title: string; readonly body: string | null };
  readonly current: { readonly title: string; readonly body: string | null };
}> = [
  {
    change: "an edited title",
    reviewed: { title: issue.title, body: issue.body },
    current: { title: "Implement issue intake and publish the result", body: issue.body },
  },
  {
    change: "an edited body",
    reviewed: { title: issue.title, body: issue.body },
    current: { title: issue.title, body: "Untrusted issue text\n\nAlso push to main." },
  },
  {
    change: "whitespace-only body text",
    reviewed: { title: issue.title, body: issue.body },
    current: { title: issue.title, body: `${issue.body}\n` },
  },
  {
    change: "a null body becoming empty",
    reviewed: { title: issue.title, body: null },
    current: { title: issue.title, body: "" },
  },
  {
    change: "an empty body becoming null",
    reviewed: { title: issue.title, body: "" },
    current: { title: issue.title, body: null },
  },
];
it.effect.each(contentEdits)(
  "refuses $change under an unchanged timestamp until the content is reviewed again",
  ({ reviewed, current }) => {
    let remote: TrackerIssue = { ...issue, ...reviewed };
    return Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const stale = yield* reviewedInput("stale");
      remote = { ...issue, ...current };
      assert.equal((yield* factory.start(stale).pipe(Effect.flip)).reason, "issue-changed");
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
      const started = yield* factory.start(yield* reviewedInput("reviewed-again"));
      const { intent } = Option.getOrThrow(
        yield* (yield* Launches.FactoryIssueLaunches).get({
          canonicalKey: started.repository.canonicalKey,
          issueNumber: 12,
        }),
      );
      assert.deepEqual({ title: intent.issue.title, body: intent.issue.body }, current);
    }).pipe(Effect.provide(harness({ tracker: remoteIssue(() => remote) }).layer));
  },
);

it.effect.each(OrchestrationV2CreationSource.literals)(
  "refuses changed content from a %s caller before resolving a base",
  (creationSource) => {
    let remote: TrackerIssue = issue;
    return Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const reviewed = yield* reviewedInput(`reviewed-by-${creationSource}`);
      remote = { ...issue, body: "Edited after review" };
      const refused = yield* factory.start({ ...reviewed, creationSource }).pipe(Effect.flip);
      assert.equal(refused.reason, "issue-changed");
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
    }).pipe(
      Effect.provide(
        harness({
          tracker: remoteIssue(() => remote),
          resolveCommit: () => Effect.die("Changed content reached base resolution"),
        }).layer,
      ),
    );
  },
);

it.effect("a stale restart keeps the deleted task bound until content is re-reviewed", () => {
  let remote: TrackerIssue = issue;
  return Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const threads = yield* Threads.ThreadManagementService;
    const reviewed = yield* reviewedInput("original");
    const first = yield* factory.start(reviewed);
    yield* threads.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId: first.threadId,
    });
    remote = { ...issue, body: "Rewritten after the task was deleted" };
    const stale = yield* factory
      .start({ ...reviewed, commandId: CommandId.make("stale-restart"), restartDeleted: true })
      .pipe(Effect.flip);
    assert.equal(stale.reason, "issue-changed");
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT thread_id, superseded FROM factory_issue_launches`;
    assert.equal(rows.length, 1);
    assert.deepInclude(rows, { thread_id: first.threadId, superseded: 0 });
    const restarted = yield* factory.start({
      ...(yield* reviewedInput("re-reviewed-restart")),
      restartDeleted: true,
    });
    assert.isFalse(restarted.resumed);
    assert.notEqual(restarted.threadId, first.threadId);
  }).pipe(Effect.provide(harness({ tracker: remoteIssue(() => remote) }).layer));
});

it.effect.each(["github.com", "github.com:8443"])(
  "a pre-revision saved intent resumes against %s without changing its prompt or base",
  (host) =>
    Effect.gen(function* () {
      yield* seed;
      const savedBase = "b".repeat(40);
      const threadId = ThreadId.make("legacy-thread");
      // The row exactly as written before issue revisions existed.
      const legacyIntent = JSON.stringify({
        repository: {
          provider: "github",
          host: "github.com",
          repository: "owner/factory",
          canonicalKey: "github.com/owner/factory",
          url: "https://github.com/owner/factory",
        },
        issue: {
          number: 12,
          title: issue.title,
          body: issue.body,
          state: "open",
          url: issue.url,
          labels: ["feature"],
          updatedAt: issue.updatedAt,
          task: null,
        },
        projectId,
        workspaceRoot: "/repo",
        requestCommandId: "legacy-request",
        commandId: "legacy-launch",
        threadId,
        messageId: "legacy-message",
        baseRef: savedBase,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        prompt: "Legacy immutable prompt",
        createdBy: "user",
        creationSource: "web",
        createdAt: issue.updatedAt,
        previousThreadId: null,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO factory_issue_launches
      (thread_id, canonical_key, issue_number, request_command_id, intent_json)
      VALUES (${threadId}, ${"github.com/owner/factory"}, 12, 'legacy-request', ${legacyIntent})`;
      const factory = yield* Factory.FactoryIssueService;
      assert.equal((yield* factory.list({ projectId })).repository.host, host);
      const result = yield* factory.start({
        ...startInput("after-upgrade"),
        expectedIssueRevision: unreviewed,
        baseRef: "changed",
      });
      assert.equal(result.threadId, threadId);
      assert.isTrue(result.resumed);
      const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
        threadId,
      );
      assert.deepEqual(
        projection.messages.map((message) => message.text),
        ["Legacy immutable prompt"],
      );
      const preparation = projection.runs[0]?.workspacePreparation;
      assert.equal(preparation?.type === "worktree" ? preparation.baseRef : undefined, savedBase);
    }).pipe(
      Effect.provide(
        harness({
          execute: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: `https://${host}/owner/factory.git`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
          tracker: { getIssue: () => Effect.die("A saved intent must not read the live issue") },
        }).layer,
      ),
    ),
);

it.effect("admits the matched snapshot when GitHub changes during base resolution", () =>
  Effect.gen(function* () {
    const atBase = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let remote: TrackerIssue = { ...issue, body: "Reviewed body" };
    yield* Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const pending = yield* factory
        .start(yield* reviewedInput("reviewed"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(atBase);
      remote = { ...issue, body: "Edited after the reviewed read" };
      yield* Deferred.succeed(release, undefined);
      const started = yield* Fiber.join(pending);
      assert.isFalse(started.resumed);
      const { messages } = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
        started.threadId,
      );
      const prompt = messages[0]?.text ?? "";
      assert.include(prompt, "Reviewed body");
      assert.notInclude(prompt, "Edited after the reviewed read");
    }).pipe(
      Effect.provide(
        harness({
          tracker: remoteIssue(() => remote),
          resolveCommit: () =>
            Deferred.succeed(atBase, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ commitSha: baseRef }),
            ),
        }).layer,
      ),
    );
  }),
);

it.effect("a slower start of older reviewed content resumes the newer admitted task", () =>
  Effect.gen(function* () {
    const olderAtBase = yield* Deferred.make<void>();
    const releaseOlder = yield* Deferred.make<void>();
    let remote: TrackerIssue = { ...issue, body: "Older reviewed body" };
    let baseResolutions = 0;
    yield* Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const older = yield* factory
        .start(yield* reviewedInput("older-review"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(olderAtBase);
      remote = { ...issue, body: "Newer reviewed body" };
      const newer = yield* factory.start(yield* reviewedInput("newer-review"));
      assert.isFalse(newer.resumed);
      yield* Deferred.succeed(releaseOlder, undefined);
      const late = yield* Fiber.join(older);
      assert.isTrue(late.resumed);
      assert.equal(late.threadId, newer.threadId);
      const { messages } = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
        newer.threadId,
      );
      assert.equal(messages.length, 1);
      assert.include(messages[0]?.text ?? "", "Newer reviewed body");
      assert.notInclude(messages[0]?.text ?? "", "Older reviewed body");
    }).pipe(
      Effect.provide(
        harness({
          tracker: remoteIssue(() => remote),
          resolveCommit: () =>
            baseResolutions++ === 0
              ? Deferred.succeed(olderAtBase, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseOlder)),
                  Effect.as({ commitSha: baseRef }),
                )
              : Effect.succeed({ commitSha: baseRef }),
        }).layer,
      ),
    );
  }),
);

it.effect("refuses a closed issue without reserving work", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const rejected = { ...startInput("rejected"), expectedIssueRevision: unreviewed };
    assert.equal((yield* factory.start(rejected).pipe(Effect.flip)).reason, "closed-issue");
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
  }).pipe(
    Effect.provide(
      harness({
        tracker: { getIssue: () => Effect.succeed({ ...issue, state: "closed" }) },
      }).layer,
    ),
  ),
);

it.effect("closed issues still open their existing task without another launch", () => {
  let closed = false;
  return Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const first = yield* factory.start(yield* reviewedInput("open"));
    closed = true;
    const again = yield* factory.start(yield* reviewedInput("closed"));
    assert.equal(again.threadId, first.threadId);
    assert.isTrue(again.resumed);
  }).pipe(
    Effect.provide(
      harness({
        tracker: remoteIssue(() => ({ ...issue, state: closed ? "closed" : "open" })),
      }).layer,
    ),
  );
});

it.effect("rejects a non-trackable fork rather than falling back to its GitHub upstream", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    assert.equal(
      (yield* factory.list({ projectId }).pipe(Effect.flip)).reason,
      "unsupported-provider",
    );
  }).pipe(
    Effect.provide(
      harness({
        resolve: () =>
          Effect.succeed({
            ...identity,
            origin: {
              canonicalKey: "bitbucket.org/owner/factory",
              remoteUrl: "git@bitbucket.org:owner/factory.git",
            },
          }),
      }).layer,
    ),
  ),
);

it.effect.each([
  { remoteReason: "unauthenticated", reason: "authentication" },
  { remoteReason: "missing-tool", reason: "authentication" },
  { remoteReason: "rate-limited", reason: "rate-limited" },
  { remoteReason: "not-found", reason: "remote-failure" },
  { remoteReason: "failed", reason: "remote-failure" },
  { remoteReason: "invalid-response", reason: "invalid-response" },
  { remoteReason: "truncated-response", reason: "invalid-response" },
  { remoteReason: "not-an-issue", reason: "not-an-issue" },
] as const)("maps tracker $remoteReason to $reason", ({ remoteReason, reason }) =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    assert.equal((yield* factory.list({ projectId }).pipe(Effect.flip)).reason, reason);
  }).pipe(
    Effect.provide(
      harness({
        tracker: {
          listIssues: () =>
            Effect.fail(
              new IssueTrackerProviderError({
                provider: SourceControlProviderKind.make("github"),
                operation: "issues.list",
                reason: remoteReason,
                detail: "Test failure",
              }),
            ),
        },
      }).layer,
    ),
  ),
);

it.effect("an incomplete stored launch cannot exceed a retrying MCP caller's ceiling", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const first = yield* factory.start({
      ...(yield* reviewedInput("powerful")),
      runtimeMode: "full-access",
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE factory_issue_launches SET accepted = 0 WHERE thread_id = ${first.threadId}`;
    const refused = yield* factory.start(yield* reviewedInput("limited")).pipe(
      Effect.provideService(DispatchModeLimit, {
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
      Effect.flip,
    );
    assert.equal(refused.reason, "launch-authority");
    assert.equal(
      (yield* (yield* Threads.ThreadManagementService).getThreadProjection(first.threadId)).runs
        .length,
      1,
    );
  }).pipe(Effect.provide(harness().layer)),
);

it.effect("keeps preparation failures and archived threads on their original task", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const threads = yield* Threads.ThreadManagementService;
    const first = yield* factory.start(yield* reviewedInput("setup"));
    const projection = yield* threads.getThreadProjection(first.threadId);
    const run = projection.runs[0];
    if (run === undefined) return yield* Effect.die("Expected the initial run");
    yield* threads.dispatch({
      type: "prepared-run.fail",
      commandId: CommandId.make("setup-failure"),
      threadId: first.threadId,
      runId: run.id,
      failure: makeProviderFailure({
        message: "Setup failed",
        class: "validation_error",
        retryable: false,
      }),
    });
    assert.equal((yield* factory.list({ projectId })).issues[0]?.task?.status, "failed");
    const reopened = yield* factory.start({
      ...(yield* reviewedInput("setup-reopen")),
      restartDeleted: true,
    });
    assert.equal(reopened.threadId, first.threadId);
    assert.equal(reopened.task.status, "failed");
    yield* threads.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId: first.threadId,
    });
    const archived = yield* factory.start(yield* reviewedInput("archive-open"));
    assert.equal(archived.threadId, first.threadId);
    assert.equal(archived.task.status, "archived");
    assert.equal((yield* threads.getThreadProjection(first.threadId)).messages.length, 1);
  }).pipe(Effect.provide(harness().layer)),
);

it.effect("refuses an unresolved local base without leaving a reservation", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    assert.equal(
      (yield* factory
        .start({ ...(yield* reviewedInput("bad-base")), baseRef: "missing" })
        .pipe(Effect.flip)).reason,
      "invalid-base-ref",
    );
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
  }).pipe(
    Effect.provide(
      harness({
        resolveCommit: () =>
          Effect.fail(
            new GitCommandError({
              operation: "resolveCommit",
              command: "git",
              cwd: "/repo",
              detail: "missing ref",
            }),
          ),
      }).layer,
    ),
  ),
);

it.effect("refuses a remote change between issue read and reservation", () => {
  let moved = false;
  return Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    assert.equal(
      (yield* factory.start(yield* reviewedInput("remote-race")).pipe(Effect.flip)).reason,
      "repository-changed",
    );
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
  }).pipe(
    Effect.provide(
      harness({
        resolve: () =>
          Effect.succeed(
            moved
              ? {
                  ...identity,
                  origin: {
                    canonicalKey: "github.com/owner/other",
                    remoteUrl: "git@github.com:owner/other.git",
                  },
                }
              : identity,
          ),
        resolveCommit: () => {
          moved = true;
          return Effect.succeed({ commitSha: baseRef });
        },
      }).layer,
    ),
  );
});

it.effect("uses the resolved repository when there is no differing origin", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    assert.equal(
      (yield* factory.list({ projectId })).repository.canonicalKey,
      "github.com/upstream/root",
    );
  }).pipe(
    Effect.provide(
      harness({
        resolve: () =>
          Effect.succeed({
            canonicalKey: identity.canonicalKey,
            provider: "github",
            rootPath: "/repo",
            locator: identity.locator,
          }),
      }).layer,
    ),
  ),
);

it.effect("refuses an upstream-only project instead of importing upstream issues", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    assert.equal(
      (yield* factory.list({ projectId }).pipe(Effect.flip)).reason,
      "missing-repository",
    );
  }).pipe(
    Effect.provide(
      harness({
        resolve: () =>
          Effect.succeed({
            canonicalKey: identity.canonicalKey,
            provider: "github",
            rootPath: "/repo",
            locator: identity.locator,
          }),
        execute: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(2),
            stdout: "",
            stderr: "No such remote",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        tracker: {
          listIssues: () => Effect.die("A project without origin must not read upstream issues"),
        },
      }).layer,
    ),
  ),
);

it.effect("reports missing projects and missing repository identity explicitly", () =>
  Effect.gen(function* () {
    const factory = yield* Factory.FactoryIssueService;
    assert.equal((yield* factory.list({ projectId }).pipe(Effect.flip)).reason, "missing-project");
    yield* seed;
    assert.equal(
      (yield* factory.list({ projectId }).pipe(Effect.flip)).reason,
      "missing-repository",
    );
  }).pipe(Effect.provide(harness({ resolve: () => Effect.succeed(null) }).layer)),
);

it.effect("server restart retains a same-run and same-worktree preparation retry", () =>
  Effect.gen(function* () {
    const setupPath = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const threads = yield* Threads.ThreadManagementService;
      const first = yield* factory.start(yield* reviewedInput("before-restart"));
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("bind-worktree"),
        threadId: first.threadId,
        branch: "factory-issue",
        worktreePath: "/repo-worktree",
      });
      const before = yield* threads.getThreadProjection(first.threadId);
      const run = before.runs[0];
      if (run === undefined) return yield* Effect.die("Expected initial run");
      const recovery = yield* Recovery.ProviderRuntimeRecoveryService.pipe(
        Effect.provide(
          Recovery.layer.pipe(Layer.provide(Layer.merge(Projections.layer, Outbox.layer))),
        ),
      );
      yield* recovery.reconcile("startup");
      yield* Effect.gen(function* () {
        const restartedFactory = yield* Factory.FactoryIssueService;
        const reopened = yield* restartedFactory.start(yield* reviewedInput("after-restart"));
        assert.equal(reopened.threadId, first.threadId);
        assert.equal(reopened.task.status, "failed");
        const launcher = yield* ThreadLaunch.ThreadLaunchService;
        yield* launcher.retryPreparation({
          commandId: CommandId.make("retry-setup"),
          threadId: first.threadId,
          runId: run.id,
        });
        assert.equal(yield* Deferred.await(setupPath), "/repo-worktree");
        const after = yield* threads.getThreadProjection(first.threadId);
        assert.equal(after.thread.worktreePath, before.thread.worktreePath);
        assert.equal(after.runs.length, 1);
        assert.equal(after.messages.length, 1);
        assert.equal(after.runs[0]?.id, run.id);
        assert.equal(after.runs[0]?.status, "preparing");
        assert.equal(after.messages[0]?.id, before.messages[0]?.id);
      }).pipe(
        Effect.provide(Layer.fresh(Factory.layer.pipe(Layer.provideMerge(ThreadLaunch.layer)))),
      );
    }).pipe(
      Effect.provide(
        harness({
          runForThread: (input) =>
            Deferred.succeed(setupPath, input.worktreePath).pipe(Effect.andThen(Effect.never)),
        }).layer,
      ),
    );
  }),
);

it.effect(
  "rejects a stale inbox repository precondition before reading or reserving its issue",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const result = yield* factory
        .start({
          ...startInput("stale-inbox"),
          expectedIssueRevision: unreviewed,
          expectedRepositoryKey: "github.com/owner/previous",
        })
        .pipe(Effect.flip);
      assert.equal(result.reason, "repository-changed");
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
    }).pipe(
      Effect.provide(
        harness({
          tracker: { getIssue: () => Effect.die("A stale repository must not fetch issues") },
        }).layer,
      ),
    ),
);

it.effect("public command reuse cannot attach another issue to an earlier launch receipt", () =>
  Effect.gen(function* () {
    yield* seed;
    const factory = yield* Factory.FactoryIssueService;
    const store = yield* Launches.FactoryIssueLaunches;
    const originalInput = yield* reviewedInput("shared-public-command");
    const original = yield* factory.start(originalInput);
    const originalBinding = Option.getOrThrow(
      yield* store.get({
        canonicalKey: original.repository.canonicalKey,
        issueNumber: 12,
      }),
    );
    assert.notEqual(originalBinding.intent.commandId, originalInput.commandId);
    const separateInput = yield* reviewedInput("separate-public-command", { issueNumber: 13 });
    const conflict = yield* factory
      .start({
        ...originalInput,
        issueNumber: 13,
        expectedIssueRevision: separateInput.expectedIssueRevision,
      })
      .pipe(Effect.flip);
    assert.equal(conflict.reason, "persistence-failure");
    assert.isTrue(
      Option.isNone(
        yield* store.get({
          canonicalKey: original.repository.canonicalKey,
          issueNumber: 13,
        }),
      ),
    );
    const separate = yield* factory.start(separateInput);
    const separateBinding = Option.getOrThrow(
      yield* store.get({
        canonicalKey: separate.repository.canonicalKey,
        issueNumber: 13,
      }),
    );
    assert.notEqual(separate.threadId, original.threadId);
    assert.notEqual(separateBinding.intent.commandId, originalBinding.intent.commandId);
    const replay = yield* factory.start(originalInput);
    assert.equal(replay.threadId, original.threadId);
    assert.isTrue(replay.resumed);
    assert.deepEqual(
      Option.getOrThrow(
        yield* store.get({
          canonicalKey: original.repository.canonicalKey,
          issueNumber: 12,
        }),
      ).intent,
      originalBinding.intent,
    );
  }).pipe(
    Effect.provide(
      harness({
        tracker: { getIssue: (input) => Effect.succeed({ ...issue, number: input.number }) },
      }).layer,
    ),
  ),
);

it.effect.each(["disabled", "unknown"] as const)(
  "refuses a %s provider before reserving the issue",
  (kind) =>
    Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      const settings = yield* Settings.ServerSettingsService;
      if (kind === "disabled")
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
          },
        });
      const refused = yield* factory
        .start({
          ...(yield* reviewedInput("provider-refusal")),
          modelSelection:
            kind === "unknown"
              ? { ...modelSelection, instanceId: ProviderInstanceId.make("misspelled-provider") }
              : modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "provider-unavailable");
      assert.instanceOf(refused.cause, Threads.ThreadManagementProviderInstanceDisabledError);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: true } } },
        },
      });
      const started = yield* factory.start(yield* reviewedInput("provider-corrected"));
      assert.isFalse(started.resumed);
      assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 1);
    }).pipe(Effect.provide(harness().layer)),
);

it.effect(
  "an orphan reservation with no thread requires explicit restart from another checkout",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Launches.FactoryIssueLaunches;
      const owner = projectId;
      const reserved = yield* store.reserve({
        repository: {
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          repository: "owner/factory",
          canonicalKey: "github.com/owner/factory",
          url: "https://github.com/owner/factory",
        },
        issue: {
          number: 12,
          title: issue.title,
          body: issue.body,
          state: "open",
          url: issue.url,
          labels: [],
          updatedAt: issue.updatedAt,
          task: null,
        },
        projectId: owner,
        workspaceRoot: "/repo",
        requestCommandId: CommandId.make("orphan-request"),
        commandId: CommandId.make("orphan-launch"),
        threadId: ThreadId.make("orphan-thread"),
        messageId: MessageId.make("orphan-message"),
        baseRef,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        prompt: "Original orphan prompt",
        createdBy: "user",
        creationSource: "web",
        createdAt: issue.updatedAt,
        previousThreadId: null,
      });
      const projects = yield* Projects.ProjectService;
      yield* projects.delete({ commandId: CommandId.make("remove-owner"), projectId: owner });
      const factory = yield* Factory.FactoryIssueService;
      const listed = yield* factory.list({ projectId: secondProjectId });
      assert.equal(listed.issues[0]?.task?.status, "missing");
      const input = yield* reviewedInput("orphan-restart", { projectId: secondProjectId });
      assert.equal((yield* factory.start(input).pipe(Effect.flip)).reason, "deleted-task");
      const restarted = yield* factory.start({ ...input, restartDeleted: true });
      assert.equal(restarted.projectId, secondProjectId);
      assert.notEqual(restarted.threadId, reserved.intent.threadId);
      const binding = Option.getOrThrow(
        yield* store.get({ canonicalKey: restarted.repository.canonicalKey, issueNumber: 12 }),
      );
      assert.equal(binding.intent.previousThreadId, reserved.intent.threadId);
    }).pipe(Effect.provide(harness().layer)),
);

it.effect.each([
  {
    stdout: "git@github.com:Owner/Rewritten.git\n",
    exitCode: 0,
    truncated: false,
    expected: "github.com/owner/rewritten",
  },
  {
    stdout: "/local/repository\n",
    exitCode: 0,
    truncated: false,
    expected: "unsupported-provider",
  },
  {
    stdout: "git@gitlab.com:owner/repo.git\n",
    exitCode: 0,
    truncated: false,
    expected: "unsupported-provider",
  },
  {
    stdout: "git@github.com:owner/truncated.git",
    exitCode: 0,
    truncated: true,
    expected: "missing-repository",
  },
  {
    stdout: "git@github.com:owner/stale.git",
    exitCode: 2,
    truncated: false,
    expected: "missing-repository",
  },
])(
  "uses expanded origin output or refuses $expected without upstream fallback",
  ({ stdout, exitCode, truncated, expected }) =>
    Effect.gen(function* () {
      yield* seed;
      const factory = yield* Factory.FactoryIssueService;
      if (expected.startsWith("github.com/")) {
        assert.equal((yield* factory.list({ projectId })).repository.canonicalKey, expected);
      } else {
        assert.equal((yield* factory.list({ projectId }).pipe(Effect.flip)).reason, expected);
      }
    }).pipe(
      Effect.provide(
        harness({
          resolve: () =>
            Effect.succeed({
              ...identity,
              origin: { canonicalKey: "gh/owner/rewritten", remoteUrl: "gh:owner/rewritten" },
            }),
          execute: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(exitCode),
              stdout,
              stderr: "",
              stdoutTruncated: truncated,
              stderrTruncated: false,
            }),
        }).layer,
      ),
    ),
);
