import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Store from "../persistence/FactoryAcceptanceStore.ts";
import { type FactoryLaunchIntent } from "../persistence/FactoryIssueLaunches.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Acceptance from "./FactoryAcceptanceService.ts";
import { issueOriginKey } from "./FactoryOriginKey.ts";

const at = "2026-10-27T00:00:00.000Z";
const environmentId = EnvironmentId.make("claim-holder");
const projectId = ProjectId.make("project");
const claimed = ThreadId.make("claimed");
const unclaimed = ThreadId.make("unclaimed");
const gone = ThreadId.make("gone");
const first = "1".repeat(40);
const second = "2".repeat(40);
const base = "b".repeat(40);

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

const harness = () => {
  const worktree = { head: first };
  const git = Layer.mock(Git.GitVcsDriver)({
    execute: ({ args }) => {
      const revision = args[2];
      const stdout =
        revision === "HEAD^{commit}" ? worktree.head : revision === "main^{commit}" ? base : null;
      if (stdout === null) return Effect.die(`Unexpected git arguments: ${JSON.stringify(args)}`);
      return Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: `${stdout}\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  });
  const dependencies = Layer.mergeAll(
    Sqlite.layerMemory,
    git,
    NodeCrypto.layer,
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === gone
            ? null
            : {
                ...liveThreadShell(id),
                projectId,
                worktreePath: id === unclaimed ? null : "/worktree",
              },
        ),
    }),
  );
  const layer = Acceptance.layer.pipe(
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(dependencies),
  );
  return { worktree, layer };
};
const seedClaim = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key)
    VALUES (${claimed}, ${intent.repository.canonicalKey}, 7, ${intent.requestCommandId}, ${JSON.stringify(intent)},
      ${issueOriginKey(intent.repository.provider, intent.repository.canonicalKey, 7)})`;
});
const accept = Effect.fn("AcceptanceTest.accept")(function* (
  expectedHeadSha: string,
  threadId: ThreadId = claimed,
  supersede?: boolean,
) {
  const service = yield* Acceptance.FactoryAcceptanceService;
  return yield* service.acceptCommit({
    projectId,
    threadId,
    expectedHeadSha,
    evidenceRefs: ["ci:run/1"],
    ...(supersede === undefined ? {} : { supersede }),
  });
});
const read = Effect.fn("AcceptanceTest.read")(function* (threadId: ThreadId = claimed) {
  const service = yield* Acceptance.FactoryAcceptanceService;
  return yield* service.read({ projectId, threadId });
});
const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT head_sha, base_sha, accepted_by FROM factory_acceptances`;
});

it.effect("accepting pins the observed head, the resolved base and the claim holder", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* seedClaim;
    const accepted = yield* accept(first);
    assert.equal(accepted.current, true);
    assert.equal(accepted.liveHeadSha, first);
    assert.deepInclude(accepted.acceptance, {
      originKey: issueOriginKey(intent.repository.provider, intent.repository.canonicalKey, 7),
      threadId: claimed,
      projectId,
      headSha: first,
      baseRef: "main",
      baseSha: base,
      acceptedBy: environmentId,
      evidenceRefs: ["ci:run/1"],
    });
    assert.deepEqual(yield* read(), accepted);
    assert.deepEqual(yield* rows, [
      { head_sha: first, base_sha: base, accepted_by: environmentId },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("a stale expected head is refused without writing a row", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* seedClaim;
    const refused = yield* accept(second).pipe(Effect.flip);
    assert.equal(refused.reason, "head-moved");
    assert.deepEqual(yield* rows, []);
    assert.equal((yield* read()).acceptance, null);
  }).pipe(Effect.provide(layer));
});

it.effect("a second acceptance is refused and leaves the first untouched", () => {
  const { worktree, layer } = harness();
  return Effect.gen(function* () {
    yield* seedClaim;
    yield* accept(first);
    worktree.head = second;
    const refused = yield* accept(second).pipe(Effect.flip);
    assert.equal(refused.reason, "already-accepted");
    assert.deepEqual(yield* rows, [
      { head_sha: first, base_sha: base, accepted_by: environmentId },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("re-accepting after the head moved supersedes the first record", () => {
  const { worktree, layer } = harness();
  return Effect.gen(function* () {
    yield* seedClaim;
    yield* accept(first);
    worktree.head = second;
    const again = yield* accept(second, claimed, true);
    assert.equal(again.current, true);
    assert.equal(again.acceptance?.headSha, second);
    assert.equal((yield* read()).acceptance?.headSha, second);
    const sql = yield* SqlClient.SqlClient;
    const live = yield* sql`SELECT head_sha FROM factory_acceptances WHERE superseded = 0`;
    assert.deepEqual(live, [{ head_sha: second }]);
  }).pipe(Effect.provide(layer));
});

it.effect("a read after the head moves reports the acceptance as no longer current", () => {
  const { worktree, layer } = harness();
  return Effect.gen(function* () {
    yield* seedClaim;
    yield* accept(first);
    worktree.head = second;
    const moved = yield* read();
    assert.equal(moved.current, false);
    assert.equal(moved.liveHeadSha, second);
    assert.equal(moved.acceptance?.headSha, first);
  }).pipe(Effect.provide(layer));
});

it.effect("only a claimed thread with a live worktree can be accepted", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* seedClaim;
    assert.equal(
      (yield* accept(first, unclaimed).pipe(Effect.flip)).reason,
      "worktree-unavailable",
    );
    assert.equal((yield* accept(first, gone).pipe(Effect.flip)).reason, "unknown-thread");
    assert.equal((yield* read(gone).pipe(Effect.flip)).reason, "unknown-thread");
    const loose = ThreadId.make("loose");
    assert.equal((yield* accept(first, loose).pipe(Effect.flip)).reason, "not-a-factory-task");
    assert.deepEqual(yield* rows, []);
  }).pipe(Effect.provide(layer));
});
