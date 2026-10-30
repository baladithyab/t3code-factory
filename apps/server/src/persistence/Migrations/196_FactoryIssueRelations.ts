import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign keys: removing a project must not erase evidence of a deleted blocker.
  // Older binaries can leave these additive tables untouched when rolling back.
  yield* sql`CREATE TABLE factory_issue_relation_observations (
    canonical_key TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    observed_at TEXT,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    listed_count INTEGER NOT NULL,
    summary_total INTEGER,
    failure TEXT,
    last_attempt_at TEXT NOT NULL,
    PRIMARY KEY (canonical_key, issue_number),
    CHECK ((complete = 0 AND observed_at IS NULL) OR (complete = 1 AND observed_at IS NOT NULL))
  )`;
  yield* sql`CREATE TABLE factory_issue_relation_edges (
    canonical_key TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    target_host TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    target_repository TEXT NOT NULL,
    target_number INTEGER NOT NULL,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('present', 'removed-at-source', 'deleted', 'inaccessible', 'moved', 'unverified')),
    tombstoned_at TEXT,
    PRIMARY KEY (canonical_key, issue_number, target_host, target_id)
  )`;
});
