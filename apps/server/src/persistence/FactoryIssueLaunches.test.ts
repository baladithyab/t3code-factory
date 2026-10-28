import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Launches from "./FactoryIssueLaunches.ts";
import * as Sqlite from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { issueOriginKey } from "../factory/FactoryOriginKey.ts";

const github = SourceControlProviderKind.make("github");
const key = { canonicalKey: "github.com/owner/repo", issueNumber: 7 };
const intent = (
  id: string,
  previousThreadId: ThreadId | null = null,
): Launches.FactoryLaunchIntent => ({
  repository: {
    provider: github,
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: key.canonicalKey,
    url: "https://github.com/owner/repo",
  },
  issue: {
    number: 7,
    title: "Task",
    body: null,
    state: "open",
    url: "https://github.com/owner/repo/issues/7",
    labels: [],
    updatedAt: "2026-10-23T00:00:00.000Z",
    task: null,
  },
  projectId: ProjectId.make(`project:${id}`),
  workspaceRoot: `/repo/${id}`,
  requestCommandId: CommandId.make(`request:${id}`),
  commandId: CommandId.make(`launch:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  messageId: MessageId.make(`message:${id}`),
  baseRef: "a".repeat(40),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  prompt: `Original prompt ${id}`,
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-23T00:00:00.000Z",
  previousThreadId,
});
const layer = Launches.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "SQL reservation chooses one immutable intent across independent repository instances",
  () =>
    Effect.gen(function* () {
      const first = yield* Launches.FactoryIssueLaunches;
      const second = yield* Launches.FactoryIssueLaunches.pipe(Effect.provide(Launches.layer));
      const [a, b] = yield* Effect.all([first.reserve(intent("a")), second.reserve(intent("b"))], {
        concurrency: "unbounded",
      });
      assert.deepEqual(a, b);
      assert.deepEqual(Option.getOrThrow(yield* second.get(key)), a);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 1);
      const rows = yield* sql`SELECT origin_key FROM factory_issue_launches`;
      assert.equal(rows[0]?.origin_key, issueOriginKey(github, key.canonicalKey, key.issueNumber));
      assert.isUndefined(a.intent.admittedBy);
    }).pipe(Effect.provide(layer)),
);

it.effect("restarts compare-and-swap the previous attempt and preserve provenance", () =>
  Effect.gen(function* () {
    const store = yield* Launches.FactoryIssueLaunches;
    const original = yield* store.reserve(intent("original"));
    yield* store.accept(original.intent.threadId);
    const [a, b] = yield* Effect.all(
      [
        store.reserve(intent("restart-a", original.intent.threadId)),
        store.reserve(intent("restart-b", original.intent.threadId)),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(a, b);
    assert.notEqual(a.intent.threadId, original.intent.threadId);
    assert.equal(a.intent.previousThreadId, original.intent.threadId);
    assert.equal(a.accepted, 0);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT thread_id, accepted, superseded FROM factory_issue_launches`;
    assert.equal(rows.length, 2);
    assert.deepInclude(rows, { thread_id: original.intent.threadId, accepted: 1, superseded: 1 });
    // Repeating a previously used command is not another explicit restart authorization.
    const replay = yield* store.reserve({
      ...intent("replayed", a.intent.threadId),
      requestCommandId: original.intent.requestCommandId,
    });
    assert.equal(replay.intent.threadId, a.intent.threadId);
    assert.equal((yield* sql`SELECT * FROM factory_issue_launches`).length, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a command-id conflict rolls back replacement rather than losing the current binding",
  () =>
    Effect.gen(function* () {
      const store = yield* Launches.FactoryIssueLaunches;
      const original = yield* store.reserve(intent("original"));
      const other = intent("other");
      yield* store.reserve({ ...other, issue: { ...other.issue, number: 8 } });
      const result = yield* store.reserve({
        ...intent("replacement", original.intent.threadId),
        requestCommandId: other.requestCommandId,
      });
      assert.equal(result.intent.threadId, original.intent.threadId);
      assert.equal(
        Option.getOrThrow(yield* store.get(key)).intent.threadId,
        original.intent.threadId,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("075 backfills legacy issue keys without requiring admission provenance", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 74 });
    const legacy = intent("legacy");
    yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json)
      VALUES (${legacy.threadId}, ${key.canonicalKey}, ${key.issueNumber}, ${legacy.requestCommandId}, ${JSON.stringify(legacy)})`;
    yield* runMigrations();
    const rows = yield* sql`SELECT origin_key FROM factory_issue_launches`;
    assert.equal(rows[0]?.origin_key, issueOriginKey(github, key.canonicalKey, key.issueNumber));
    const stored = Option.getOrThrow(yield* (yield* Launches.FactoryIssueLaunches).get(key));
    assert.deepEqual(stored.intent, legacy);
    assert.isUndefined(stored.intent.admittedBy);
  }).pipe(
    Effect.provide(
      Launches.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
    ),
  ),
);
