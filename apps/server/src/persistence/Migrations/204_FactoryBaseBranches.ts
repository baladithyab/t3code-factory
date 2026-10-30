import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Legacy launch snapshots lost the reviewed branch. A matching SHA cannot reconstruct it.
  yield* sql`ALTER TABLE factory_acceptances ADD COLUMN base_branch TEXT`;
  yield* sql`ALTER TABLE factory_delivery_intents ADD COLUMN base_branch TEXT`;
});
