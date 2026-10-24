import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign key: deleting a project/thread must retain issue provenance and the restart guard.
  // Older binaries can leave this additive table untouched when rolling back.
  yield* sql`
    CREATE TABLE factory_issue_launches (
      thread_id TEXT PRIMARY KEY NOT NULL,
      canonical_key TEXT NOT NULL,
      issue_number INTEGER NOT NULL CHECK (issue_number > 0),
      request_command_id TEXT NOT NULL UNIQUE,
      intent_json TEXT NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
      superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX factory_issue_launches_current
    ON factory_issue_launches (canonical_key, issue_number) WHERE superseded = 0
  `;
});
