import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryFeedSourceId,
  FactoryResearchProtocolId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryRepository,
  type FactoryResearchProtocol,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import { type FactoryFeedLaunchIntent } from "../persistence/FactoryFeedStore.ts";
import { type FactoryLaunchIntent } from "../persistence/FactoryIssueLaunches.ts";
import { type FactoryResearchLaunchIntent } from "../persistence/FactoryResearchStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Claims from "./FactoryClaimsService.ts";
import {
  feedItemOriginKey,
  githubIssueOriginKey,
  researchRunOriginKey,
} from "./FactoryOriginKey.ts";
import { type FactoryLaunchCore } from "./FactoryTaskLaunch.ts";

const at = "2026-10-25T00:00:00.000Z";
const owner = ProjectId.make("owner");
const caller = ProjectId.make("another-checkout");
const environmentId = EnvironmentId.make("answering-environment");
const copiedFrom = EnvironmentId.make("original-environment");
const repository: FactoryRepository = {
  provider: "github",
  host: "github.com",
  repository: "owner/repo",
  canonicalKey: "github.com/owner/repo",
  url: "https://github.com/owner/repo",
};
const core = (id: string): typeof FactoryLaunchCore.Type => ({
  projectId: owner,
  workspaceRoot: "/owner-repo",
  requestCommandId: CommandId.make(`request:${id}`),
  commandId: CommandId.make(`command:${id}`),
  threadId: ThreadId.make(id),
  messageId: MessageId.make(`message:${id}`),
  baseRef: "a".repeat(40),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  prompt: "Frozen snapshot",
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  previousThreadId: null,
});
const protocol: FactoryResearchProtocol = {
  id: FactoryResearchProtocolId.make("protocol:claims"),
  projectId: owner,
  repository,
  baseCommit: "a".repeat(40),
  hypothesis: "Lower loss",
  runCommand: "python train.py",
  evaluators: [{ path: "prepare.py", blobOid: "blob" }],
  metric: { name: "loss", linePrefix: "loss:", direction: "lower", minimumEffect: 0.01 },
  budget: { maxRuns: 3, maxRunMinutes: 5, expiresAt: "2099-01-01T00:00:00.000Z" },
  revision: "sealed",
  sealedAt: at,
};
const dependencies = Layer.mergeAll(
  Sqlite.layerMemory,
  Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
  Layer.mock(Projects.ProjectService)({
    getById: (id) =>
      Effect.succeed(
        Option.some({
          id,
          title: "Factory",
          workspaceRoot: id === caller ? "/second-repo" : "/owner-repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        }),
      ),
  }),
  Layer.succeed(Identities.RepositoryIdentityResolver, {
    resolve: () =>
      Effect.succeed({
        canonicalKey: repository.canonicalKey,
        provider: "github",
        rootPath: "/second-repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:owner/repo.git",
        },
      }),
  }),
  Layer.mock(Git.GitVcsDriver)({
    execute: () =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "git@github.com:owner/repo.git",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  }),
  Layer.mock(Threads.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(id === "research" ? liveThreadShell(id) : null),
  }),
  Layer.mock(Receipts.CommandReceiptStoreV2)({
    getByCommandId: () => Effect.succeed(Option.none()),
  }),
);
const layer = Claims.layer.pipe(Layer.provideMerge(dependencies));

it.effect(
  "lists all current repository origins, conflicts and provenance with shared task statuses",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const issue: FactoryLaunchIntent = {
        ...core("issue"),
        repository,
        admittedBy: environmentId,
        issue: {
          number: 12,
          title: "Task",
          body: null,
          state: "open",
          url: `${repository.url}/issues/12`,
          labels: [],
          updatedAt: at,
          task: null,
        },
      };
      const issueKey = githubIssueOriginKey(repository.canonicalKey, 12);
      for (const [id, superseded, canonicalKey] of [
        ["issue", 0, repository.canonicalKey],
        ["superseded", 1, repository.canonicalKey],
        ["unrelated", 0, "github.com/other/repo"],
      ] as const) {
        const intent = {
          ...issue,
          ...core(id),
          admittedBy: environmentId,
          repository: { ...repository, canonicalKey },
        };
        yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key, superseded)
        VALUES (${intent.threadId}, ${canonicalKey}, 12, ${intent.requestCommandId}, ${JSON.stringify(intent)}, ${githubIssueOriginKey(canonicalKey, 12)}, ${superseded})`;
      }
      const feed: FactoryFeedLaunchIntent = {
        ...core("feed"),
        repository,
        admittedBy: copiedFrom,
        sourceId: FactoryFeedSourceId.make("source"),
        itemKey: "atom:X",
        revision: "d1",
        title: "Feed task",
        snapshot: {
          feed: "https://news.example/feed",
          title: "Task",
          content: "Body",
          link: null,
          publishedAt: null,
        },
      };
      const feedKey = feedItemOriginKey(repository.canonicalKey, feed.snapshot.feed, feed.itemKey);
      for (const [id, conflict] of [
        ["feed", 0],
        ["feed-conflict", 1],
      ] as const) {
        const intent = {
          ...feed,
          ...core(id),
          admittedBy: copiedFrom,
          sourceId: FactoryFeedSourceId.make(id),
        };
        yield* sql`INSERT INTO factory_feed_launches (thread_id, source_id, item_key, request_command_id, intent_json, origin_key, origin_conflict, accepted)
        VALUES (${intent.threadId}, ${intent.sourceId}, ${intent.itemKey}, ${intent.requestCommandId}, ${JSON.stringify(intent)}, ${feedKey}, ${conflict}, 1)`;
      }
      const research: FactoryResearchLaunchIntent = {
        ...core("research"),
        protocolId: protocol.id,
        protocolRevision: protocol.revision,
        role: "explore",
        protocol,
        instructions: null,
        launchedByThreadId: null,
        finding: null,
      };
      const researchKey = researchRunOriginKey(protocol.id, research.role);
      yield* sql`INSERT INTO factory_research_launches (thread_id, protocol_id, role, request_command_id, intent_json, origin_key, created_at)
      VALUES (${research.threadId}, ${protocol.id}, ${research.role}, ${research.requestCommandId}, ${JSON.stringify(research)}, NULL, ${at})`;
      yield* sql`INSERT INTO factory_feed_launches (thread_id, source_id, item_key, request_command_id, intent_json)
      VALUES ('unreadable', 'unreadable', 'unreadable', 'unreadable', 'not json')`;
      const result = yield* (yield* Claims.FactoryClaimsService).list({ projectId: caller });
      assert.equal(result.environmentId, environmentId);
      assert.deepEqual(result.repository, repository);
      assert.equal(result.claims.length, 4);
      assert.deepInclude(result.claims, {
        originKey: issueKey,
        origin: "github-issue",
        projectId: owner,
        workspaceRoot: "/owner-repo",
        threadId: issue.threadId,
        status: "launching",
        baseRef: issue.baseRef,
        createdAt: at,
        creationSource: "web",
        admittedBy: environmentId,
        originConflict: false,
      });
      assert.deepInclude(result.claims, {
        originKey: feedKey,
        origin: "feed-item",
        projectId: owner,
        workspaceRoot: "/owner-repo",
        threadId: ThreadId.make("feed-conflict"),
        status: "missing",
        baseRef: feed.baseRef,
        createdAt: at,
        creationSource: "web",
        admittedBy: copiedFrom,
        originConflict: true,
      });
      assert.deepInclude(result.claims, {
        originKey: researchKey,
        origin: "research-run",
        projectId: owner,
        workspaceRoot: "/owner-repo",
        threadId: research.threadId,
        status: "running",
        baseRef: research.baseRef,
        createdAt: at,
        creationSource: "web",
        admittedBy: null,
        originConflict: false,
      });
      assert.isString(result.fetchedAt);
    }).pipe(Effect.provide(layer)),
);
