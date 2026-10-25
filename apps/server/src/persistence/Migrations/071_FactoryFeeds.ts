import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign keys: deleting projects or threads must retain review and restart provenance.
  // Older binaries can leave these additive tables untouched when rolling back.
  yield* sql`CREATE TABLE factory_feed_sources (
    source_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    locator TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
    etag TEXT,
    last_modified TEXT,
    last_checked_at TEXT,
    next_allowed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    request_command_id TEXT NOT NULL UNIQUE,
    UNIQUE (project_id, locator)
  )`;
  yield* sql`CREATE TABLE factory_feed_items (
    source_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    title TEXT,
    content TEXT,
    link TEXT,
    published_at TEXT,
    revision TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    in_window INTEGER NOT NULL CHECK (in_window IN (0, 1)),
    disposition TEXT NOT NULL CHECK (disposition IN ('open', 'dismissed', 'retracted', 'unreviewable')),
    dismissed_revision TEXT,
    dismissal_note TEXT,
    forge_host TEXT,
    forge_repository TEXT,
    forge_issue_number INTEGER,
    PRIMARY KEY (source_id, item_key)
  )`;
  yield* sql`CREATE TABLE factory_feed_item_revisions (
    source_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    revision TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (source_id, item_key, ordinal)
  )`;
  yield* sql`CREATE TABLE factory_feed_launches (
    thread_id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    request_command_id TEXT NOT NULL UNIQUE,
    intent_json TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
    superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1))
  )`;
  yield* sql`CREATE UNIQUE INDEX factory_feed_launches_current
    ON factory_feed_launches (source_id, item_key) WHERE superseded = 0`;
});
