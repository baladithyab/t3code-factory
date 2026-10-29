import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A sibling of factory_delivery_intents rather than nullable commit columns on it: 201's NOT NULL
// pins are what make a commit grant meaningful, SQLite cannot relax them additively, and an older
// binary must keep decoding every row of the table it knows.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE factory_artifact_deliveries (
    id TEXT PRIMARY KEY,
    origin_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    acceptance_id TEXT NOT NULL,
    brief_id TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    artifact_bytes INTEGER NOT NULL,
    repository_json TEXT NOT NULL,
    destination_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    body TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    request_command_id TEXT NOT NULL,
    status TEXT NOT NULL,
    remote_json TEXT,
    failure TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (request_command_id)
  )`;
  // One live delivery per origin, kind and destination: one accepted brief may reach distinct
  // issues, while a pending or unknown send to the same issue blocks a second grant until settled.
  yield* sql`CREATE UNIQUE INDEX factory_artifact_deliveries_live
    ON factory_artifact_deliveries (origin_key, kind, destination_key)
    WHERE status IN ('pending', 'sending', 'confirmed', 'unknown')`;
  yield* sql`CREATE INDEX factory_artifact_deliveries_thread ON factory_artifact_deliveries (thread_id)`;
});
