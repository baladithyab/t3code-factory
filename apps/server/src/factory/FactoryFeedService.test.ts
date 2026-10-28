import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type FactoryFeedCandidateAdmitInput,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as Factory from "./FactoryFeedService.ts";
import * as FeedFetch from "./FeedFetch.ts";
import * as Store from "../persistence/FactoryFeedStore.ts";
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
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { feedItemOriginKey } from "./FactoryOriginKey.ts";
import { issueTrackersLayer } from "./IssueTrackerProviderRegistry.testkit.ts";

const environmentId = EnvironmentId.make("feed-environment");

const projectId = ProjectId.make("factory-feed-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const baseRef = "a".repeat(40);
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
const feed = (body: string, link = "https://news.example.org/item") =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title><entry><id>X</id><title>Task</title><content>${body}</content><updated>2026-10-24T00:00:00Z</updated><link href="${link}"/></entry></feed>`;
const bind = { commandId: CommandId.make("bind"), projectId, url: "https://news.example.org/feed" };
const admission = (
  sourceId: FactoryFeedCandidateAdmitInput["sourceId"],
  revision: string,
  command = "admit",
): FactoryFeedCandidateAdmitInput => ({
  commandId: CommandId.make(command),
  projectId,
  expectedRepositoryKey: "github.com/owner/factory",
  sourceId,
  itemKey: "atom:X",
  expectedRevision: revision,
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
});
function harness(
  response: () => Response,
  options: {
    readonly resolveCommit?: Git.GitVcsDriver["Service"]["resolveCommit"];
    readonly origin?: string;
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
      openSession: () => Effect.die("Feed tests never execute a provider"),
    },
  ]);
  const orchestrator = Replay.layerWithRegistry({ name: "factory-feeds" }, registry, {
    databaseLayer: database,
    runEffectWorker: false,
  });
  const receipts = Receipts.layer.pipe(Layer.provide(database));
  const threads = Threads.layer.pipe(
    Layer.provide(Layer.mergeAll(orchestrator, settings, receipts)),
  );
  const external = Layer.mergeAll(
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.succeed(Identities.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(identity),
    }),
    issueTrackersLayer(),
    Layer.succeed(Favicons.ProjectFaviconResolver, {
      resolvePath: () => Effect.succeed(null),
      invalidate: () => Effect.void,
    }),
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (root) => Effect.succeed(root),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => HttpClientResponse.fromWeb(request, response())),
      ),
    ),
    Layer.mock(Git.GitVcsDriver)({
      resolveCommit: options.resolveCommit ?? (() => Effect.succeed({ commitSha: baseRef })),
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: options.origin ?? "git@github.com:owner/factory.git",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: () => Effect.succeed(false),
      createWorktree: () => Effect.never,
      hasCommit: () => Effect.succeed(true),
    }),
    Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(Terminal.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(SetupRunner.ProjectSetupScriptRunner)({ runForThread: () => Effect.never }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateBranchName: () => Effect.succeed({ branch: "feed-intake" }),
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
    FeedFetch.layer.pipe(Layer.provide(external)),
    database,
  );
  return Layer.mergeAll(Factory.layer.pipe(Layer.provide(dependencies)), dependencies).pipe(
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "factory-feed-test-" })),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );
}
const seed = Effect.gen(function* () {
  yield* (yield* Projects.ProjectService).create({
    commandId: CommandId.make("create"),
    projectId,
    title: "Factory",
    workspaceRoot: "/repo",
    defaultModelSelection: modelSelection,
    scripts: [],
  });
  return yield* Factory.FactoryFeedService;
});

it.effect(
  "second checkout's admit resumes the first checkout's thread and keeps one current claim",
  () =>
    Effect.gen(function* () {
      const factory = yield* seed;
      const secondProjectId = ProjectId.make("factory-feed-second-checkout");
      yield* (yield* Projects.ProjectService).create({
        commandId: CommandId.make("create-second"),
        projectId: secondProjectId,
        title: "Second checkout",
        workspaceRoot: "/second-repo",
        defaultModelSelection: modelSelection,
        scripts: [],
      });
      const first = yield* factory.bindSource(bind);
      const second = yield* factory.bindSource({
        ...bind,
        projectId: secondProjectId,
        commandId: CommandId.make("bind-second"),
      });
      const firstItem = (yield* factory.readCandidate({
        projectId,
        sourceId: first.source.id,
        itemKey: "atom:X",
      })).candidate;
      const secondItem = (yield* factory.readCandidate({
        projectId: secondProjectId,
        sourceId: second.source.id,
        itemKey: "atom:X",
      })).candidate;
      const t1 = yield* factory.admitCandidate(admission(first.source.id, firstItem.revision));
      const resumed = yield* factory.admitCandidate({
        ...admission(second.source.id, secondItem.revision, "admit-second"),
        projectId: secondProjectId,
      });
      assert.isTrue(resumed.resumed);
      assert.equal(resumed.threadId, t1.threadId);
      assert.equal(resumed.projectId, projectId);
      assert.equal(resumed.sourceId, second.source.id);
      assert.equal(resumed.itemKey, secondItem.itemKey);
      const listed = yield* factory.listCandidates({ projectId: secondProjectId });
      assert.equal(listed.candidates[0]?.task?.threadId, t1.threadId);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT * FROM factory_feed_launches WHERE superseded = 0`).length,
        1,
      );
    }).pipe(Effect.provide(harness(() => new Response(feed("reviewed d1 text"))))),
);

it.effect(
  "bind a fixture feed and refresh (item X, digest d1); republish X with an edited body and unchanged updated, refresh (ordinal 2, d2); admit(d1) fails before resolveCommit; admit(d2) launches one worktree thread; replay returns the same thread",
  () => {
    let body = "reviewed d1 text";
    let commits = 0;
    let requests = 0;
    return Effect.gen(function* () {
      const factory = yield* seed;
      const { source } = yield* factory.bindSource(bind);
      yield* TestClock.adjust("60 seconds");
      yield* factory.refreshSource({ projectId, sourceId: source.id });
      const d1 = (yield* factory.readCandidate({
        projectId,
        sourceId: source.id,
        itemKey: "atom:X",
      })).candidate;
      body = "edited d2 text";
      yield* TestClock.adjust("60 seconds");
      yield* factory.refreshSource({ projectId, sourceId: source.id });
      const d2 = (yield* factory.readCandidate({
        projectId,
        sourceId: source.id,
        itemKey: "atom:X",
      })).candidate;
      assert.equal(d2.ordinal, 2);
      assert.notEqual(d1.revision, d2.revision);
      assert.equal(
        (yield* factory.admitCandidate(admission(source.id, d1.revision)).pipe(Effect.flip)).reason,
        "candidate-changed",
      );
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM factory_feed_launches`).length, 0);
      assert.equal(commits, 0);
      const result = yield* factory.admitCandidate({
        ...admission(source.id, d2.revision),
        instructions: "Add a regression test",
      });
      const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
        result.threadId,
      );
      assert.equal(projection.messages.length, 1);
      assert.deepEqual(projection.runs[0]?.workspacePreparation, {
        type: "worktree",
        baseRef,
        startFromOrigin: false,
      });
      assert.include(JSON.stringify(projection.messages), "edited d2 text");
      assert.include(JSON.stringify(projection.messages), "Reviewer instructions:");
      assert.equal(result.task.baseRef, baseRef);
      const stored = Option.getOrThrow(
        yield* (yield* Store.FactoryFeedStore).get(
          feedItemOriginKey(identity.canonicalKey, bind.url, "atom:X"),
        ),
      );
      assert.equal(stored.intent.revision, d2.revision);
      assert.equal(stored.intent.admittedBy, environmentId);
      assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 0);
      assert.equal((yield* sql`SELECT * FROM factory_feed_launches`).length, 1);
      const replay = yield* factory.admitCandidate(admission(source.id, d2.revision));
      assert.equal(replay.threadId, result.threadId);
      assert.isTrue(replay.resumed);
      assert.equal(commits, 1);
      assert.equal(requests, 3);
    }).pipe(
      Effect.provide(
        harness(
          () => {
            requests += 1;
            return new Response(feed(body));
          },
          {
            resolveCommit: () => {
              commits += 1;
              return Effect.succeed({ commitSha: baseRef });
            },
          },
        ),
      ),
    );
  },
);
it.effect(
  "absence is not deletion; revision-bound dismissal reopens after an edit; tombstones retract",
  () => {
    let xml = feed("first");
    return Effect.gen(function* () {
      const factory = yield* seed;
      const { source } = yield* factory.bindSource(bind);
      const target = { projectId, sourceId: source.id, itemKey: "atom:X" };
      const original = (yield* factory.readCandidate(target)).candidate;
      yield* factory.setCandidateDismissed({
        ...target,
        commandId: CommandId.make("dismiss"),
        expectedRevision: original.revision,
        dismissed: true,
      });
      xml = '<feed xmlns="http://www.w3.org/2005/Atom"/>';
      yield* TestClock.adjust("60 seconds");
      yield* factory.refreshSource(target);
      assert.deepInclude((yield* factory.readCandidate(target)).candidate, {
        inWindow: false,
        disposition: "dismissed",
      });
      xml = feed("edited");
      yield* TestClock.adjust("60 seconds");
      yield* factory.refreshSource(target);
      assert.deepInclude((yield* factory.readCandidate(target)).candidate, {
        disposition: "open",
        ordinal: 2,
      });
      xml =
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:at="http://purl.org/atompub/tombstones/1.0"><at:deleted-entry ref="X"/></feed>';
      yield* TestClock.adjust("60 seconds");
      yield* factory.refreshSource(target);
      assert.equal(
        (yield* factory.admitCandidate(admission(source.id, original.revision)).pipe(Effect.flip))
          .reason,
        "candidate-retracted",
      );
    }).pipe(Effect.provide(harness(() => new Response(xml))));
  },
);
it.effect("own-repository issue links cannot bypass the Issues inbox", () =>
  Effect.gen(function* () {
    const factory = yield* seed;
    const { source } = yield* factory.bindSource(bind);
    const candidate = (yield* factory.readCandidate({
      projectId,
      sourceId: source.id,
      itemKey: "atom:X",
    })).candidate;
    assert.equal(
      (yield* factory.admitCandidate(admission(source.id, candidate.revision)).pipe(Effect.flip))
        .reason,
      "forge-issue-source",
    );
  }).pipe(
    Effect.provide(
      harness(() => new Response(feed("body", "https://github.com/owner/factory/issues/42?x=1")), {
        resolveCommit: () => Effect.die("Forge guard must precede git"),
      }),
    ),
  ),
);
it.effect(
  "unbind blocks refresh/admission, rebind reuses the source, admitted tasks survive unbind",
  () =>
    Effect.gen(function* () {
      const factory = yield* seed;
      const { source } = yield* factory.bindSource(bind);
      const target = { projectId, sourceId: source.id, itemKey: "atom:X" };
      const candidate = (yield* factory.readCandidate(target)).candidate;
      yield* factory.unbindSource({ ...target, commandId: CommandId.make("unbind") });
      assert.equal(
        (yield* factory.refreshSource(target).pipe(Effect.flip)).reason,
        "source-suspended",
      );
      assert.equal(
        (yield* factory.admitCandidate(admission(source.id, candidate.revision)).pipe(Effect.flip))
          .reason,
        "source-suspended",
      );
      yield* TestClock.adjust("60 seconds");
      assert.equal(
        (yield* factory.bindSource({ ...bind, commandId: CommandId.make("rebind") })).source.id,
        source.id,
      );
      const result = yield* factory.admitCandidate(admission(source.id, candidate.revision));
      yield* factory.unbindSource({ ...target, commandId: CommandId.make("unbind-again") });
      assert.equal(
        (yield* factory.admitCandidate(admission(source.id, "ignored"))).threadId,
        result.threadId,
      );
    }).pipe(Effect.provide(harness(() => new Response(feed("body"))))),
);
it.effect("failed fetch retains validators, honours Retry-After, and 410 suspends visibly", () => {
  let status = 200;
  return Effect.gen(function* () {
    const factory = yield* seed;
    const { source } = yield* factory.bindSource(bind);
    status = 503;
    yield* TestClock.adjust("60 seconds");
    assert.equal(
      (yield* factory.refreshSource({ projectId, sourceId: source.id }).pipe(Effect.flip)).reason,
      "feed-unavailable",
    );
    const stored = Option.getOrThrow(yield* (yield* Store.FactoryFeedStore).getSource(source.id));
    assert.equal(stored.etag, '"v1"');
    assert.isNotNull(stored.lastError);
    assert.equal(stored.nextAllowedAt, "1970-01-01T00:03:00.000Z");
    assert.equal(
      (yield* factory.refreshSource({ projectId, sourceId: source.id }).pipe(Effect.flip)).reason,
      "refresh-throttled",
    );
    status = 410;
    yield* TestClock.adjust("120 seconds");
    yield* factory.refreshSource({ projectId, sourceId: source.id }).pipe(Effect.flip);
    assert.equal((yield* factory.listSources({ projectId })).sources[0]?.status, "suspended");
  }).pipe(
    Effect.provide(
      harness(
        () =>
          new Response(status === 200 ? feed("body") : null, {
            status,
            headers: { etag: status === 200 ? '"v1"' : '"bad"', "retry-after": "120" },
          }),
      ),
    ),
  );
});

it.effect(
  "deleted tasks require a new command and revision-bound restart; concurrent restarts keep one attempt",
  () =>
    Effect.gen(function* () {
      const factory = yield* seed;
      const { source } = yield* factory.bindSource(bind);
      const candidate = (yield* factory.readCandidate({
        projectId,
        sourceId: source.id,
        itemKey: "atom:X",
      })).candidate;
      const input = admission(source.id, candidate.revision);
      const first = yield* factory.admitCandidate(input);
      const threads = yield* Threads.ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete"),
        threadId: first.threadId,
      });
      assert.equal(
        (yield* factory.admitCandidate({ ...input, restartDeleted: true }).pipe(Effect.flip))
          .reason,
        "deleted-task",
      );
      assert.equal(
        (yield* factory
          .admitCandidate({ ...input, commandId: CommandId.make("unconfirmed") })
          .pipe(Effect.flip)).reason,
        "deleted-task",
      );
      assert.equal(
        (yield* factory
          .admitCandidate({
            ...input,
            commandId: CommandId.make("stale"),
            restartDeleted: true,
            expectedRevision: "old",
          })
          .pipe(Effect.flip)).reason,
        "candidate-changed",
      );
      const [a, b] = yield* Effect.all(
        [
          factory.admitCandidate({
            ...input,
            commandId: CommandId.make("restart-a"),
            restartDeleted: true,
          }),
          factory.admitCandidate({
            ...input,
            commandId: CommandId.make("restart-b"),
            restartDeleted: true,
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(a.threadId, b.threadId);
      assert.notEqual(a.threadId, first.threadId);
      assert.equal(
        (yield* (yield* SqlClient.SqlClient)`SELECT * FROM factory_feed_launches`).length,
        2,
      );
    }).pipe(Effect.provide(harness(() => new Response(feed("body"))))),
);

it.effect("a reserved feed task cannot exceed the retrying caller's authority", () =>
  Effect.gen(function* () {
    const factory = yield* seed;
    const { source } = yield* factory.bindSource(bind);
    const candidate = (yield* factory.readCandidate({
      projectId,
      sourceId: source.id,
      itemKey: "atom:X",
    })).candidate;
    const first = yield* factory.admitCandidate({
      ...admission(source.id, candidate.revision),
      runtimeMode: "full-access",
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE factory_feed_launches SET accepted = 0 WHERE thread_id = ${first.threadId}`;
    const refusal = yield* factory.admitCandidate(admission(source.id, "ignored", "limited")).pipe(
      Effect.provideService(DispatchModeLimit, {
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
      Effect.flip,
    );
    assert.equal(refusal.reason, "launch-authority");
    assert.equal(
      (yield* (yield* Threads.ThreadManagementService).getThreadProjection(first.threadId)).messages
        .length,
      1,
    );
  }).pipe(Effect.provide(harness(() => new Response(feed("body"))))),
);

it.effect("a refresh racing base resolution cannot reserve the stale reviewed revision", () => {
  let concurrentEdit = Effect.void;
  return Effect.gen(function* () {
    const factory = yield* seed;
    const { source } = yield* factory.bindSource(bind);
    const target = { projectId, sourceId: source.id, itemKey: "atom:X" };
    const candidate = (yield* factory.readCandidate(target)).candidate;
    const store = yield* Store.FactoryFeedStore;
    concurrentEdit = store
      .observe({
        sourceId: source.id,
        at: "1970-01-01T00:00:01.000Z",
        nextAllowedAt: "1970-01-01T00:01:01.000Z",
        title: "News",
        etag: null,
        lastModified: null,
        items: [
          {
            ...candidate,
            revision: "edited-concurrently",
            content: "Changed during git resolution",
            disposition: "open",
          },
        ],
      })
      .pipe(Effect.asVoid, Effect.orDie);
    assert.equal(
      (yield* factory.admitCandidate(admission(source.id, candidate.revision)).pipe(Effect.flip))
        .reason,
      "candidate-changed",
    );
    assert.equal(
      (yield* (yield* SqlClient.SqlClient)`SELECT * FROM factory_feed_launches`).length,
      0,
    );
  }).pipe(
    Effect.provide(
      harness(() => new Response(feed("body")), {
        resolveCommit: () => concurrentEdit.pipe(Effect.as({ commitSha: baseRef })),
      }),
    ),
  );
});

it.effect(
  "an own-repository Atom identity cannot be hidden behind another forge's alternate link",
  () =>
    Effect.gen(function* () {
      const factory = yield* seed;
      const { source } = yield* factory.bindSource(bind);
      const itemKey = "atom:https://github.com/owner/factory/issues/42";
      const candidate = (yield* factory.readCandidate({ projectId, sourceId: source.id, itemKey }))
        .candidate;
      assert.equal(
        (yield* factory
          .admitCandidate({ ...admission(source.id, candidate.revision), itemKey })
          .pipe(Effect.flip)).reason,
        "forge-issue-source",
      );
    }).pipe(
      Effect.provide(
        harness(
          () =>
            new Response(
              feed("body", "https://github.com/other/repo/issues/7").replace(
                "<id>X</id>",
                "<id>https://github.com/owner/factory/issues/42</id>",
              ),
            ),
          { resolveCommit: () => Effect.die("Forge identity guard must precede git") },
        ),
      ),
    ),
);

it.effect(
  "a GitLab project's candidates read without a repository and admission is refused unsupported-provider",
  () =>
    Effect.gen(function* () {
      const factory = yield* seed;
      const { source } = yield* factory.bindSource(bind);
      const listed = yield* factory.listCandidates({ projectId });
      assert.isNull(listed.repository);
      const candidate = listed.candidates[0]!;
      const refused = yield* factory
        .admitCandidate({
          ...admission(source.id, candidate.revision),
          expectedRepositoryKey: "gitlab.com/group/factory",
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "unsupported-provider");
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT thread_id FROM factory_feed_launches`, []);
    }).pipe(
      Effect.provide(
        harness(() => new Response(feed("reviewed text")), {
          origin: "https://gitlab.com/group/factory.git",
          resolveCommit: () => Effect.die("An unsupported repository must be refused before git"),
        }),
      ),
    ),
);
