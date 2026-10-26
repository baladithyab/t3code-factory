import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign keys: project removal must not erase human decisions. Older binaries can
  // leave this additive table untouched on rollback without losing override history.
  yield* sql`CREATE TABLE factory_issue_readiness_overrides (
    override_id TEXT PRIMARY KEY NOT NULL,
    canonical_key TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    target_host TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('force-not-ready', 'waive')),
    bound_fingerprint TEXT NOT NULL,
    reason TEXT NOT NULL,
    request_command_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX factory_issue_readiness_overrides_active_edge
    ON factory_issue_readiness_overrides (canonical_key, issue_number, target_host, target_id)
    WHERE revoked_at IS NULL`;
});
