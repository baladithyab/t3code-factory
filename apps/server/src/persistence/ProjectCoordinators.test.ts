import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import * as Coordinators from "./ProjectCoordinators.ts";
import * as Sqlite from "./Sqlite.ts";

const projectId = ProjectId.make("project:coordinator");
const intent = (
  id: string,
  previousThreadId: ThreadId | null = null,
  project: ProjectId = projectId,
): Coordinators.ProjectCoordinatorIntent => ({
  projectId: project,
  workspaceRoot: `/repo/${id}`,
  requestCommandId: CommandId.make(`request:${id}`),
  commandId: CommandId.make(`launch:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  messageId: MessageId.make(`message:${id}`),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  prompt: `Read-only orientation for ${id}`,
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-24T00:00:00.000Z",
  previousThreadId,
});
const layer = Coordinators.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("passive reads return no binding without reserving anything", () =>
  Effect.gen(function* () {
    const store = yield* Coordinators.ProjectCoordinators;
    assert.isTrue(Option.isNone(yield* store.get(projectId)));
    assert.isTrue(Option.isNone(yield* store.getByRequest(CommandId.make("request:absent"))));
    assert.deepEqual(yield* store.list(), []);
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* sql`SELECT * FROM project_coordinators`, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("concurrent repository instances choose one frozen first intent", () =>
  Effect.gen(function* () {
    const first = yield* Coordinators.ProjectCoordinators;
    const second = yield* Coordinators.ProjectCoordinators.pipe(Effect.provide(Coordinators.layer));
    const left = intent("left");
    const right = {
      ...intent("right"),
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-5" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      creationSource: "mcp",
    } satisfies Coordinators.ProjectCoordinatorIntent;
    const [a, b] = yield* Effect.all([first.reserve(left), second.reserve(right)], {
      concurrency: "unbounded",
    });
    assert.deepEqual(a, b);
    assert.deepEqual(a.intent, a.intent.threadId === left.threadId ? left : right);
    assert.equal(a.accepted, 0);
    assert.equal(a.superseded, 0);
    assert.deepEqual(Option.getOrThrow(yield* second.get(projectId)), a);
    assert.deepEqual(yield* second.list(), [a]);
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* sql`SELECT * FROM project_coordinators`).length, 1);
    // A loser did not reserve its request ID; it may only observe the winning binding.
    const loser = a.intent.requestCommandId === left.requestCommandId ? right : left;
    assert.isTrue(Option.isNone(yield* second.getByRequest(loser.requestCommandId)));
    assert.deepEqual(yield* second.reserve(loser), a);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "concurrent same-request retries retain original IDs, modes and prompt after acceptance",
  () =>
    Effect.gen(function* () {
      const store = yield* Coordinators.ProjectCoordinators;
      const original = intent("original");
      const changed = {
        ...intent("mutated"),
        requestCommandId: original.requestCommandId,
        runtimeMode: "full-access",
        interactionMode: "plan",
        creationSource: "mcp",
      } satisfies Coordinators.ProjectCoordinatorIntent;
      const [a, b] = yield* Effect.all([store.reserve(original), store.reserve(changed)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(a, b);
      yield* store.accept(a.intent.threadId);
      yield* store.accept(a.intent.threadId);
      const reopened = yield* Coordinators.ProjectCoordinators.pipe(
        Effect.provide(Coordinators.layer),
      );
      const replay = yield* reopened.reserve(changed);
      assert.deepEqual(replay, { ...a, accepted: 1 });
      assert.deepEqual(
        Option.getOrThrow(yield* reopened.getByRequest(original.requestCommandId)),
        replay,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM project_coordinators`).length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "replaying a superseded request returns its own binding without another replacement",
  () =>
    Effect.gen(function* () {
      const store = yield* Coordinators.ProjectCoordinators;
      const original = yield* store.reserve(intent("original"));
      yield* store.accept(original.intent.threadId);
      const replacement = yield* store.reserve(intent("replacement", original.intent.threadId));
      const latest = yield* store.reserve(intent("latest", replacement.intent.threadId));
      const replay = yield* store.reserve({
        ...intent("changed-replay", latest.intent.threadId),
        requestCommandId: original.intent.requestCommandId,
      });
      assert.deepEqual(replay, { ...original, accepted: 1, superseded: 1 });
      assert.deepEqual(
        Option.getOrThrow(yield* store.getByRequest(replacement.intent.requestCommandId)),
        { ...replacement, superseded: 1 },
      );
      assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)), latest);
      assert.deepEqual(yield* store.list(), [latest]);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM project_coordinators`).length, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect("concurrent CAS replacements and stale callers cannot supersede a newer generation", () =>
  Effect.gen(function* () {
    const first = yield* Coordinators.ProjectCoordinators;
    const second = yield* Coordinators.ProjectCoordinators.pipe(Effect.provide(Coordinators.layer));
    const original = yield* first.reserve(intent("original"));
    yield* first.accept(original.intent.threadId);
    const [a, b] = yield* Effect.all(
      [
        first.reserve(intent("replacement-a", original.intent.threadId)),
        second.reserve(intent("replacement-b", original.intent.threadId)),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(a, b);
    assert.notEqual(a.intent.threadId, original.intent.threadId);
    assert.equal(a.intent.previousThreadId, original.intent.threadId);
    const latest = yield* first.reserve(intent("latest", a.intent.threadId));
    assert.deepEqual(yield* second.reserve(intent("stale", original.intent.threadId)), latest);
    assert.deepEqual(yield* second.reserve(intent("first-create-again")), latest);
    assert.deepEqual(yield* second.list(), [latest]);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT thread_id, accepted, superseded FROM project_coordinators`;
    assert.equal(rows.length, 3);
    assert.deepInclude(rows, { thread_id: original.intent.threadId, accepted: 1, superseded: 1 });
    assert.deepInclude(rows, { thread_id: a.intent.threadId, accepted: 0, superseded: 1 });
    assert.deepInclude(rows, { thread_id: latest.intent.threadId, accepted: 0, superseded: 0 });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a non-null predecessor without any current binding fails without reserving the request",
  () =>
    Effect.gen(function* () {
      const store = yield* Coordinators.ProjectCoordinators;
      const unknown = intent("unknown", ThreadId.make("thread:absent"));
      const failure = yield* Effect.flip(store.reserve(unknown));
      assert.equal(failure.reason, "binding-changed");
      assert.isTrue(Option.isNone(yield* store.get(projectId)));
      assert.isTrue(Option.isNone(yield* store.getByRequest(unknown.requestCommandId)));
      assert.deepEqual(yield* store.list(), []);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a request used by another project conflicts even after its original binding is superseded",
  () =>
    Effect.gen(function* () {
      const store = yield* Coordinators.ProjectCoordinators;
      const original = yield* store.reserve(intent("original"));
      yield* store.reserve(intent("replacement", original.intent.threadId));
      const other = yield* store.reserve(intent("other", null, ProjectId.make("project:other")));
      const failure = yield* Effect.flip(
        store.reserve({
          ...intent("conflict", other.intent.threadId, other.intent.projectId),
          requestCommandId: original.intent.requestCommandId,
        }),
      );
      assert.equal(failure.reason, "command-conflict");
      assert.deepEqual(Option.getOrThrow(yield* store.get(other.intent.projectId)), other);
      assert.equal(
        Option.getOrThrow(yield* store.getByRequest(original.intent.requestCommandId)).superseded,
        1,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM project_coordinators`).length, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "concurrent cross-project request reuse commits exactly one project and rejects the other",
  () =>
    Effect.gen(function* () {
      const first = yield* Coordinators.ProjectCoordinators;
      const second = yield* Coordinators.ProjectCoordinators.pipe(
        Effect.provide(Coordinators.layer),
      );
      const a = intent("a");
      const b = {
        ...intent("b", null, ProjectId.make("project:other")),
        requestCommandId: a.requestCommandId,
      };
      const results = yield* Effect.forEach(
        [first.reserve(a), second.reserve(b)],
        (operation) =>
          operation.pipe(
            Effect.match({ onSuccess: (binding) => binding, onFailure: (error) => error }),
          ),
        { concurrency: "unbounded" },
      );
      const winners = results.filter((result) => "intent" in result);
      const conflicts = results.filter((result) => "reason" in result);
      assert.equal(winners.length, 1);
      assert.equal(conflicts.length, 1);
      const winner = winners[0];
      const conflict = conflicts[0];
      if (winner === undefined || conflict === undefined)
        return assert.fail("Expected one winner and one conflict");
      assert.equal(conflict.reason, "command-conflict");
      assert.deepEqual(yield* first.list(), [winner]);
      const losingProjectId = winner.intent.projectId === a.projectId ? b.projectId : a.projectId;
      assert.isTrue(Option.isNone(yield* first.get(losingProjectId)));
      assert.deepEqual(Option.getOrThrow(yield* first.getByRequest(a.requestCommandId)), winner);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an insert constraint failure rolls back CAS superseding and preserves both projects",
  () =>
    Effect.gen(function* () {
      const store = yield* Coordinators.ProjectCoordinators;
      const original = yield* store.reserve(intent("original"));
      const other = yield* store.reserve(intent("other", null, ProjectId.make("project:other")));
      const candidate = {
        ...intent("bad-replacement", original.intent.threadId),
        threadId: other.intent.threadId,
      };
      const failure = yield* Effect.flip(store.reserve(candidate));
      assert.equal(failure.reason, "persistence-failure");
      assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)), original);
      assert.deepEqual(Option.getOrThrow(yield* store.get(other.intent.projectId)), other);
      assert.isTrue(Option.isNone(yield* store.getByRequest(candidate.requestCommandId)));
      assert.equal((yield* store.list()).length, 2);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM project_coordinators WHERE superseded = 1`).length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "SQL constraints enforce current-project, global request and lifecycle flag invariants",
  () =>
    Effect.gen(function* () {
      const store = yield* Coordinators.ProjectCoordinators;
      const original = yield* store.reserve(intent("original"));
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.flip(sql`
      INSERT INTO project_coordinators (thread_id, project_id, request_command_id, intent_json)
      VALUES ('thread:duplicate-project', ${projectId}, 'request:duplicate-project', ${JSON.stringify(intent("duplicate-project"))})
    `);
      yield* Effect.flip(sql`
      INSERT INTO project_coordinators (thread_id, project_id, request_command_id, intent_json, superseded)
      VALUES ('thread:duplicate-request', 'project:other', ${original.intent.requestCommandId}, ${JSON.stringify(intent("duplicate-request"))}, 1)
    `);
      yield* Effect.flip(
        sql`UPDATE project_coordinators SET accepted = 2 WHERE thread_id = ${original.intent.threadId}`,
      );
      yield* Effect.flip(
        sql`UPDATE project_coordinators SET superseded = -1 WHERE thread_id = ${original.intent.threadId}`,
      );
      assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)), original);
      assert.equal((yield* sql`SELECT * FROM project_coordinators`).length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "migration 194 is empty and additive; legacy SQL and deletion leave coordinator provenance intact",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 193 });
      const original = intent("legacy-project");
      // These are the existing project/thread writes, unchanged by coordinator persistence.
      yield* sql`
      INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Legacy project', '/repo/legacy', '[]', ${original.createdAt}, ${original.createdAt})
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${original.threadId}, ${projectId}, 'Legacy thread', 'codex', 'approval-required', 'default', ${original.createdAt}, ${original.createdAt}, '{}')
    `;
      yield* runMigrations({ toMigrationInclusive: 194 });
      assert.deepEqual(yield* sql`SELECT * FROM project_coordinators`, []);
      assert.deepEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 194`,
        [{ name: "ProjectCoordinators" }],
      );
      yield* Effect.gen(function* () {
        const store = yield* Coordinators.ProjectCoordinators;
        const reserved = yield* store.reserve(original);
        yield* store.accept(original.threadId);
        const replacement = yield* store.reserve(intent("replacement", original.threadId));
        // Simulate an older binary's ordinary lifecycle SQL with the additive table left in place.
        yield* sql`UPDATE projection_projects SET title = 'Renamed by older code' WHERE project_id = ${projectId}`;
        assert.deepEqual(
          yield* sql`SELECT title FROM projection_projects WHERE project_id = ${projectId}`,
          [{ title: "Renamed by older code" }],
        );
        yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE project_id = ${projectId}`;
        yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
        assert.deepEqual(Option.getOrThrow(yield* store.getByRequest(original.requestCommandId)), {
          ...reserved,
          accepted: 1,
          superseded: 1,
        });
        assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)), replacement);
        assert.deepEqual(yield* store.reserve(original), {
          ...reserved,
          accepted: 1,
          superseded: 1,
        });
        assert.deepEqual(yield* sql`PRAGMA foreign_key_list(project_coordinators)`, []);
        assert.equal((yield* sql`SELECT * FROM project_coordinators`).length, 2);
      }).pipe(Effect.provide(Coordinators.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("late acceptance of a superseded launch does not accept its replacement", () =>
  Effect.gen(function* () {
    const store = yield* Coordinators.ProjectCoordinators;
    const original = yield* store.reserve(intent("original"));
    const replacement = yield* store.reserve(intent("replacement", original.intent.threadId));
    yield* store.accept(original.intent.threadId);
    assert.deepEqual(
      Option.getOrThrow(yield* store.getByRequest(original.intent.requestCommandId)),
      {
        ...original,
        accepted: 1,
        superseded: 1,
      },
    );
    assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)), replacement);
    assert.deepEqual(yield* store.reserve(replacement.intent), replacement);
  }).pipe(Effect.provide(layer)),
);
