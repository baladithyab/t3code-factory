import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

import FactoryMigration193 from "./Migrations/193_FactoryIssueLaunches.ts";
import FactoryMigration194 from "./Migrations/194_ProjectCoordinators.ts";
import FactoryMigration195 from "./Migrations/195_FactoryFeeds.ts";
import FactoryMigration196 from "./Migrations/196_FactoryIssueRelations.ts";
import FactoryMigration197 from "./Migrations/197_FactoryReadinessOverrides.ts";
import FactoryMigration198 from "./Migrations/198_FactoryResearch.ts";
import FactoryMigration199 from "./Migrations/199_FactoryClaims.ts";
import FactoryMigration200 from "./Migrations/200_FactoryAcceptances.ts";
import FactoryMigration201 from "./Migrations/201_FactoryDeliveryIntents.ts";
import FactoryMigration202 from "./Migrations/202_FactoryKnowledge.ts";
import FactoryMigration203 from "./Migrations/203_FactoryArtifactDeliveries.ts";

const legacyFactoryMigrations = [
  [69, "FactoryIssueLaunches", FactoryMigration193],
  [70, "ProjectCoordinators", FactoryMigration194],
  [71, "FactoryFeeds", FactoryMigration195],
  [72, "FactoryIssueRelations", FactoryMigration196],
  [73, "FactoryReadinessOverrides", FactoryMigration197],
  [74, "FactoryResearch", FactoryMigration198],
  [75, "FactoryClaims", FactoryMigration199],
  [200, "FactoryAcceptances", FactoryMigration200],
  [201, "FactoryDeliveryIntents", FactoryMigration201],
  [202, "FactoryKnowledge", FactoryMigration202],
  [203, "FactoryArtifactDeliveries", FactoryMigration203],
] as const;

const legacyFactoryDatabase = (throughId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 68 });
    for (const [id, name, migration] of legacyFactoryMigrations) {
      if (id > throughId) continue;
      yield* migration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      if (id === 69) {
        yield* sql`INSERT INTO factory_issue_launches
        (thread_id, canonical_key, issue_number, request_command_id, intent_json)
        VALUES ('legacy-thread', 'github.com/owner/repo', 1, 'legacy-command', '{}')`;
      }
    }
  });

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("adds unset delivery destinations without guessing or rewriting legacy pins", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 203 });
      const snapshot = JSON.stringify({ baseRef: "a".repeat(40) });
      yield* sql`INSERT INTO factory_issue_launches
        (thread_id, canonical_key, issue_number, request_command_id, intent_json)
        VALUES ('thread', 'github.com/owner/repo', 1, 'launch', ${snapshot})`;
      yield* sql`INSERT INTO factory_acceptances
        (id, origin_key, thread_id, project_id, head_sha, base_ref, base_sha, accepted_at, accepted_by, evidence_json)
        VALUES ('acceptance', 'origin', 'thread', 'project', 'head', 'snapshot', 'snapshot', 'at', 'env', '[]')`;
      yield* sql`INSERT INTO factory_delivery_intents
        (id, origin_key, thread_id, project_id, kind, acceptance_id, repository_json, base_ref, base_sha,
         head_sha, payload_json, payload_digest, granted_by, granted_at, request_command_id, status, updated_at)
        VALUES ('delivery', 'origin', 'thread', 'project', 'publish-pr', 'acceptance', '{}', 'snapshot', 'snapshot',
          'head', '{}', 'digest', 'env', 'at', 'grant', 'pending', 'at')`;
      yield* runMigrations();
      assert.deepEqual(yield* sql`SELECT intent_json FROM factory_issue_launches`, [
        { intent_json: snapshot },
      ]);
      assert.deepEqual(
        yield* sql`SELECT base_ref, base_sha, head_sha, base_branch FROM factory_acceptances`,
        [{ base_ref: "snapshot", base_sha: "snapshot", head_sha: "head", base_branch: null }],
      );
      assert.deepEqual(
        yield* sql`SELECT base_ref, base_sha, head_sha, base_branch, payload_digest, status FROM factory_delivery_intents`,
        [
          {
            base_ref: "snapshot",
            base_sha: "snapshot",
            head_sha: "head",
            base_branch: null,
            payload_digest: "digest",
            status: "pending",
          },
        ],
      );
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect(
    "upgrades known legacy Factory histories without replaying their schema or losing data",
    () =>
      Effect.forEach([69, 75, 203], (throughId) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* legacyFactoryDatabase(throughId);
          yield* runMigrations();
          assert.deepStrictEqual(yield* history, migrationManifest);
          assert.deepStrictEqual(yield* sql`SELECT thread_id FROM factory_issue_launches`, [
            { thread_id: "legacy-thread" },
          ]);
          assert.strictEqual(
            (yield* sql`SELECT name FROM sqlite_master WHERE name = 'peer_environment_links'`)
              .length,
            1,
          );
          assert.deepStrictEqual(yield* runMigrations(), []);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
  );

  it.effect("refuses an unrecognized legacy Factory history without rewriting it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* legacyFactoryDatabase(75);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (200, 'UnrecognizedMigration')`;
      const before = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(
        (yield* sql`SELECT name FROM sqlite_master WHERE name = 'peer_environment_links'`).length,
        0,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
