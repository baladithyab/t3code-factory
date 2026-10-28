import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE factory_acceptances (
    id TEXT PRIMARY KEY,
    origin_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    accepted_by TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    superseded INTEGER NOT NULL DEFAULT 0
  )`;
  // Write-once per origin: a second acceptance has to retire the first explicitly.
  yield* sql`CREATE UNIQUE INDEX factory_acceptances_origin
    ON factory_acceptances (origin_key) WHERE superseded = 0`;
  yield* sql`CREATE INDEX factory_acceptances_thread ON factory_acceptances (thread_id)`;
});
