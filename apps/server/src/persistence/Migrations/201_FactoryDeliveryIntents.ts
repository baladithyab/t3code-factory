import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE factory_delivery_intents (
    id TEXT PRIMARY KEY,
    origin_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    acceptance_id TEXT NOT NULL,
    repository_json TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    payload_json TEXT NOT NULL,
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
  // One live delivery per origin and kind. Confirmed counts as live (one PR per origin), and so
  // does unknown: a possibly-sent delivery blocks a second grant until it is reconciled.
  yield* sql`CREATE UNIQUE INDEX factory_delivery_intents_live
    ON factory_delivery_intents (origin_key, kind)
    WHERE status IN ('pending', 'sending', 'confirmed', 'unknown')`;
  yield* sql`CREATE INDEX factory_delivery_intents_thread ON factory_delivery_intents (thread_id)`;
});
