import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign keys: deleting a project or thread must keep the brief, its launch guard and the
  // acceptance as provenance. The tables are additive, so older binaries ignore them on rollback.
  yield* sql`CREATE TABLE factory_knowledge_briefs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    brief_json TEXT NOT NULL,
    request_command_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    superseded_by TEXT
  )`;
  yield* sql`CREATE INDEX factory_knowledge_briefs_project ON factory_knowledge_briefs (project_id)`;
  yield* sql`CREATE TABLE factory_knowledge_launches (
    thread_id TEXT PRIMARY KEY NOT NULL,
    brief_id TEXT NOT NULL,
    request_command_id TEXT NOT NULL UNIQUE,
    intent_json TEXT NOT NULL,
    origin_key TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
    superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1))
  )`;
  // One live task per brief; a restart retires the deleted attempt in the same transaction.
  yield* sql`CREATE UNIQUE INDEX factory_knowledge_launches_origin
    ON factory_knowledge_launches (origin_key) WHERE superseded = 0`;
  yield* sql`CREATE TABLE factory_knowledge_acceptances (
    id TEXT PRIMARY KEY NOT NULL,
    brief_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    accepted_at TEXT NOT NULL,
    accepted_by TEXT NOT NULL,
    superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1))
  )`;
  // Write-once per brief: a second acceptance has to retire the first explicitly.
  yield* sql`CREATE UNIQUE INDEX factory_knowledge_acceptances_brief
    ON factory_knowledge_acceptances (brief_id) WHERE superseded = 0`;
});
