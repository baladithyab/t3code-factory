import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign keys: thread deletion must preserve evidence and approval provenance.
  // Older binaries can leave these additive tables untouched on rollback.
  yield* sql`CREATE TABLE factory_research_protocols (
    protocol_id TEXT PRIMARY KEY NOT NULL,
    canonical_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    request_command_id TEXT NOT NULL UNIQUE,
    protocol_json TEXT NOT NULL,
    revision TEXT NOT NULL,
    sealed_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX factory_research_protocols_project ON factory_research_protocols (project_id, sealed_at)`;
  yield* sql`CREATE TABLE factory_research_launches (
    thread_id TEXT PRIMARY KEY NOT NULL,
    protocol_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('explore', 'verify', 'implementation')),
    request_command_id TEXT NOT NULL UNIQUE,
    intent_json TEXT NOT NULL,
    launched_by_thread_id TEXT,
    accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
    superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX factory_research_launches_protocol ON factory_research_launches (protocol_id, created_at)`;
  yield* sql`CREATE UNIQUE INDEX factory_research_launches_implementation
    ON factory_research_launches (protocol_id, role) WHERE superseded = 0 AND role = 'implementation'`;
  yield* sql`CREATE TABLE factory_research_evidence (
    thread_id TEXT PRIMARY KEY NOT NULL,
    evidence_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE factory_research_artifacts (
    thread_id TEXT NOT NULL,
    path TEXT NOT NULL,
    line INTEGER NOT NULL CHECK (line > 0),
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    retention TEXT NOT NULL CHECK (retention IN ('inline', 'digest-only')),
    content BLOB,
    PRIMARY KEY (thread_id, path, line)
  )`;
});
