import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Pin this encoding here: changing a runtime helper must not rewrite migration history.
  const escaped = (column: string) =>
    sql.literal(
      `replace(replace(replace(replace(${column}, '%', '%25'), '|', '%7C'), '#', '%23'), ':', '%3A')`,
    );
  yield* sql`ALTER TABLE factory_feed_launches ADD COLUMN origin_key TEXT`;
  yield* sql`ALTER TABLE factory_feed_launches ADD COLUMN origin_conflict INTEGER NOT NULL DEFAULT 0`;
  yield* sql`WITH origins AS (
    SELECT thread_id,
      json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.repository.canonicalKey') AS repository,
      json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.snapshot.feed') AS locator,
      json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.itemKey') AS item
    FROM factory_feed_launches
  ) UPDATE factory_feed_launches SET origin_key = (
    SELECT 'feed:' || ${escaped("repository")} || '|' || ${escaped("locator")} || '|' || ${escaped("item")}
    FROM origins WHERE origins.thread_id = factory_feed_launches.thread_id
      AND typeof(repository) = 'text' AND length(repository) > 0
      AND typeof(locator) = 'text' AND length(locator) > 0
      AND typeof(item) = 'text' AND length(item) > 0
  )`;
  // Keep every legacy attempt visible. A deterministic tie-break prevents equal timestamps
  // from defeating the partial unique index, without merging or transferring either claim.
  yield* sql`WITH ranked AS (
    SELECT thread_id, row_number() OVER (
      PARTITION BY origin_key
      ORDER BY json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.createdAt'), thread_id
    ) AS position FROM factory_feed_launches WHERE superseded = 0 AND origin_key IS NOT NULL
  ) UPDATE factory_feed_launches SET origin_conflict = 1
    WHERE thread_id IN (SELECT thread_id FROM ranked WHERE position > 1)`;
  yield* sql`CREATE UNIQUE INDEX factory_feed_launches_origin
    ON factory_feed_launches (origin_key) WHERE superseded = 0 AND origin_conflict = 0`;
  yield* sql`ALTER TABLE factory_issue_launches ADD COLUMN origin_key TEXT`;
  yield* sql`WITH origins AS (
    SELECT thread_id,
      json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.repository.canonicalKey') AS repository,
      json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.issue.number') AS number
    FROM factory_issue_launches
  ) UPDATE factory_issue_launches SET origin_key = (
    SELECT 'github:' || ${escaped("repository")} || '#' || number FROM origins
    WHERE origins.thread_id = factory_issue_launches.thread_id
      AND typeof(repository) = 'text' AND length(repository) > 0
      AND typeof(number) = 'integer' AND number > 0
  )`;
  yield* sql`ALTER TABLE factory_research_launches ADD COLUMN origin_key TEXT`;
  yield* sql`WITH origins AS (
    SELECT thread_id,
      json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.protocolId') AS protocol,
      json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.role') AS role
    FROM factory_research_launches
  ) UPDATE factory_research_launches SET origin_key = (
    SELECT 'research:' || ${escaped("protocol")} || ':' || ${escaped("role")} FROM origins
    WHERE origins.thread_id = factory_research_launches.thread_id
      AND typeof(protocol) = 'text' AND length(protocol) > 0
      AND role IN ('explore', 'verify', 'implementation')
  )`;
});
