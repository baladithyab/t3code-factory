import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign keys: project/thread deletion must retain request replay and binding provenance.
  // Older binaries can leave this additive table untouched when rolling back.
  yield* sql`
    CREATE TABLE project_coordinators (
      thread_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      request_command_id TEXT NOT NULL UNIQUE,
      intent_json TEXT NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
      superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX project_coordinators_current
    ON project_coordinators (project_id) WHERE superseded = 0
  `;
});
