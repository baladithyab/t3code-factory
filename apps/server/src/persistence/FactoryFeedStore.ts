import {
  CommandId,
  FactoryFeedCandidate,
  FactoryFeedError,
  FactoryFeedSource,
  FactoryFeedSourceId,
  FactoryRepository,
  type FactoryOriginKey,
  ProjectId,
  ThreadId,
  type FactoryFeedCandidateDismissInput,
  type FactoryFeedCandidateListInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import { FactoryLaunchCore } from "../factory/FactoryTaskLaunch.ts";
import { feedItemOriginKey } from "../factory/FactoryOriginKey.ts";

const Source = Schema.Struct({
  ...FactoryFeedSource.fields,
  etag: Schema.NullOr(Schema.String),
  lastModified: Schema.NullOr(Schema.String),
});
export type StoredSource = typeof Source.Type;
const Item = FactoryFeedCandidate.mapFields(Struct.omit(["task"]));
export type StoredItem = typeof Item.Type;
export type Observation = Pick<
  StoredItem,
  "itemKey" | "title" | "content" | "link" | "publishedAt" | "revision" | "forgeReference"
> & {
  readonly disposition: "open" | "unreviewable" | "retracted";
};
export const FactoryFeedLaunchIntent = Schema.Struct({
  repository: FactoryRepository,
  sourceId: FactoryFeedSourceId,
  itemKey: Schema.String,
  revision: Schema.String,
  title: Schema.String,
  snapshot: Schema.Struct({
    feed: Schema.String,
    title: Schema.NullOr(Schema.String),
    content: Schema.NullOr(Schema.String),
    link: Schema.NullOr(Schema.String),
    publishedAt: FactoryFeedCandidate.fields.publishedAt,
  }),
  ...FactoryLaunchCore.fields,
});
export type FactoryFeedLaunchIntent = typeof FactoryFeedLaunchIntent.Type;
const Binding = Schema.Struct({
  intent: Schema.fromJsonString(FactoryFeedLaunchIntent),
  accepted: Schema.Literals([0, 1]),
  originConflict: Schema.Literals([0, 1]),
});
export type FactoryFeedBinding = typeof Binding.Type;
const decodeSources = Schema.decodeUnknownEffect(Schema.Array(Source));
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding));
const encodeIntent = Schema.encodeEffect(Schema.fromJsonString(FactoryFeedLaunchIntent));
const ItemRow = Schema.Struct({
  ...Struct.omit(Item.fields, ["inWindow", "forgeReference"]),
  inWindow: Schema.Literals([0, 1]),
  forgeHost: Schema.NullOr(Schema.String),
  forgeRepository: Schema.NullOr(Schema.String),
  forgeIssueNumber: Schema.NullOr(Schema.Number),
});
const decodeItems = Schema.decodeUnknownEffect(Schema.Array(ItemRow));
type Key = Pick<StoredItem, "sourceId" | "itemKey">;
type Check = {
  readonly sourceId: FactoryFeedSourceId;
  readonly at: string;
  readonly nextAllowedAt: string;
};
type Observe = Check & {
  readonly title: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly items: readonly Observation[];
};

export class FactoryFeedStore extends Context.Service<
  FactoryFeedStore,
  {
    readonly bind: (input: {
      readonly id: FactoryFeedSourceId;
      readonly projectId: ProjectId;
      readonly locator: string;
      readonly commandId: CommandId;
      readonly at: string;
    }) => Effect.Effect<StoredSource, FactoryFeedError>;
    readonly unbind: (
      sourceId: FactoryFeedSourceId,
    ) => Effect.Effect<StoredSource, FactoryFeedError>;
    readonly listSources: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly StoredSource[], FactoryFeedError>;
    readonly getSource: (
      sourceId: FactoryFeedSourceId,
    ) => Effect.Effect<Option.Option<StoredSource>, FactoryFeedError>;
    readonly claimFetch: (input: Check) => Effect.Effect<StoredSource, FactoryFeedError>;
    readonly observe: (input: Observe) => Effect.Effect<StoredSource, FactoryFeedError>;
    readonly notModified: (input: Check) => Effect.Effect<StoredSource, FactoryFeedError>;
    readonly failed: (
      input: Check & { readonly error: string; readonly suspend: boolean },
    ) => Effect.Effect<void, FactoryFeedError>;
    readonly listItems: (
      input: FactoryFeedCandidateListInput,
    ) => Effect.Effect<readonly StoredItem[], FactoryFeedError>;
    readonly getItem: (key: Key) => Effect.Effect<Option.Option<StoredItem>, FactoryFeedError>;
    readonly setDismissed: (
      input: FactoryFeedCandidateDismissInput,
    ) => Effect.Effect<StoredItem, FactoryFeedError>;
    readonly get: (
      originKey: FactoryOriginKey,
    ) => Effect.Effect<Option.Option<FactoryFeedBinding>, FactoryFeedError>;
    readonly reserve: (
      intent: FactoryFeedLaunchIntent,
    ) => Effect.Effect<FactoryFeedBinding, FactoryFeedError>;
    readonly accept: (threadId: ThreadId) => Effect.Effect<void, FactoryFeedError>;
  }
>()("t3/persistence/FactoryFeedStore") {}

const isFeedError = Schema.is(FactoryFeedError);
const persistenceError = (cause: unknown) =>
  isFeedError(cause) ? cause : new FactoryFeedError({ reason: "persistence-failure", cause });
export const assertAdmissible = Effect.fn("FactoryFeedStore.assertAdmissible")((
  item: StoredItem,
  expectedRevision: string,
): Effect.Effect<void, FactoryFeedError> => {
  if (item.disposition !== "open")
    return Effect.fail(
      new FactoryFeedError({
        reason:
          item.disposition === "dismissed"
            ? "candidate-dismissed"
            : item.disposition === "retracted"
              ? "candidate-retracted"
              : "candidate-unreviewable",
      }),
    );
  return item.revision === expectedRevision
    ? Effect.void
    : Effect.fail(new FactoryFeedError({ reason: "candidate-changed" }));
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sourceColumns =
    sql.literal(`source_id AS id, project_id AS projectId, locator, title, status, etag,
    last_modified AS lastModified, last_checked_at AS lastCheckedAt, next_allowed_at AS nextAllowedAt,
    last_error AS lastError, created_at AS createdAt`);
  const itemColumns =
    sql.literal(`i.source_id AS sourceId, i.item_key AS itemKey, i.title, i.content, i.link,
    i.published_at AS publishedAt, i.revision, i.ordinal, i.first_seen_at AS firstSeenAt,
    i.last_seen_at AS lastSeenAt, i.in_window AS inWindow, i.disposition, i.dismissal_note AS dismissalNote,
    i.forge_host AS forgeHost, i.forge_repository AS forgeRepository, i.forge_issue_number AS forgeIssueNumber`);
  const itemsFromRows = Effect.fn("FactoryFeedStore.decodeItems")(function* (rows: unknown) {
    return (yield* decodeItems(rows)).map(
      ({ inWindow, forgeHost, forgeRepository, forgeIssueNumber, ...row }): StoredItem => ({
        ...row,
        inWindow: inWindow === 1,
        forgeReference:
          forgeHost !== null && forgeRepository !== null && forgeIssueNumber !== null
            ? { host: forgeHost, repository: forgeRepository, issueNumber: forgeIssueNumber }
            : null,
      }),
    );
  });
  const getSource = Effect.fn("FactoryFeedStore.getSource")(function* (
    sourceId: FactoryFeedSourceId,
  ) {
    const rows =
      yield* sql`SELECT ${sourceColumns} FROM factory_feed_sources WHERE source_id = ${sourceId}`;
    const decoded = yield* decodeSources(rows);
    return Option.fromNullishOr(decoded[0]);
  }, Effect.mapError(persistenceError));
  const requireSource = Effect.fn("FactoryFeedStore.requireSource")(function* (
    sourceId: FactoryFeedSourceId,
  ) {
    const source = yield* getSource(sourceId);
    if (Option.isNone(source)) return yield* new FactoryFeedError({ reason: "missing-source" });
    return source.value;
  });
  const listSources = Effect.fn("FactoryFeedStore.listSources")(function* (projectId: ProjectId) {
    return yield* decodeSources(
      yield* sql`
      SELECT ${sourceColumns} FROM factory_feed_sources WHERE project_id = ${projectId} ORDER BY created_at, source_id`,
    );
  }, Effect.mapError(persistenceError));
  const bind = Effect.fn("FactoryFeedStore.bind")(function* (
    input: Parameters<FactoryFeedStore["Service"]["bind"]>[0],
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO factory_feed_sources (source_id, project_id, locator, status, created_at, request_command_id)
        VALUES (${input.id}, ${input.projectId}, ${input.locator}, 'active', ${input.at}, ${input.commandId})
        ON CONFLICT (project_id, locator) DO UPDATE SET status = 'active'`;
        const rows = yield* decodeSources(
          yield* sql`
        SELECT ${sourceColumns} FROM factory_feed_sources WHERE project_id = ${input.projectId} AND locator = ${input.locator}`,
        );
        const source = rows[0];
        if (source === undefined)
          return yield* new FactoryFeedError({ reason: "persistence-failure" });
        return source;
      }),
    );
  }, Effect.mapError(persistenceError));
  const unbind = Effect.fn("FactoryFeedStore.unbind")(function* (sourceId: FactoryFeedSourceId) {
    yield* sql`UPDATE factory_feed_sources SET status = 'suspended' WHERE source_id = ${sourceId}`;
    return yield* requireSource(sourceId);
  }, Effect.mapError(persistenceError));
  const getItem = Effect.fn("FactoryFeedStore.getItem")(function* (key: Key) {
    const items = yield* itemsFromRows(
      yield* sql`SELECT ${itemColumns} FROM factory_feed_items i
      WHERE i.source_id = ${key.sourceId} AND i.item_key = ${key.itemKey}`,
    );
    return Option.fromNullishOr(items[0]);
  }, Effect.mapError(persistenceError));
  const listItems = Effect.fn("FactoryFeedStore.listItems")(function* (
    input: FactoryFeedCandidateListInput,
  ) {
    return yield* itemsFromRows(
      yield* sql`SELECT ${itemColumns} FROM factory_feed_items i
      JOIN factory_feed_sources s ON s.source_id = i.source_id WHERE s.project_id = ${input.projectId}
      AND (${input.sourceId ?? null} IS NULL OR i.source_id = ${input.sourceId ?? null})
      AND (${input.disposition ?? "open"} = 'all' OR i.disposition = ${input.disposition ?? "open"})
      ORDER BY i.last_seen_at DESC, i.source_id, i.item_key`,
    );
  }, Effect.mapError(persistenceError));
  const claimFetch = Effect.fn("FactoryFeedStore.claimFetch")(function* (input: Check) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const source = yield* requireSource(input.sourceId);
        if (source.status !== "active")
          return yield* new FactoryFeedError({ reason: "source-suspended" });
        if (source.nextAllowedAt !== null && source.nextAllowedAt > input.at)
          return yield* new FactoryFeedError({ reason: "refresh-throttled" });
        yield* sql`UPDATE factory_feed_sources SET next_allowed_at = ${input.nextAllowedAt} WHERE source_id = ${input.sourceId}`;
        return source;
      }),
    );
  }, Effect.mapError(persistenceError));
  const observe = Effect.fn("FactoryFeedStore.observe")(function* (input: Observe) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE factory_feed_items SET in_window = 0 WHERE source_id = ${input.sourceId}`;
        for (const item of input.items) {
          const existing = yield* getItem({ sourceId: input.sourceId, itemKey: item.itemKey });
          // Retraction must not let a later restore admit an unreviewable preview.
          if (
            Option.isSome(existing) &&
            (existing.value.revision === item.revision || item.disposition === "retracted")
          ) {
            yield* sql`UPDATE factory_feed_items SET in_window = 1, last_seen_at = ${input.at},
            disposition = CASE WHEN disposition = 'unreviewable' THEN 'unreviewable'
              WHEN ${item.disposition} = 'retracted' THEN 'retracted' ELSE disposition END
            WHERE source_id = ${input.sourceId} AND item_key = ${item.itemKey}`;
            continue;
          }
          const ordinal = Option.isSome(existing) ? existing.value.ordinal + 1 : 1;
          yield* sql`INSERT INTO factory_feed_items
          (source_id, item_key, title, content, link, published_at, revision, ordinal, first_seen_at,
           last_seen_at, in_window, disposition, dismissed_revision, dismissal_note, forge_host, forge_repository, forge_issue_number)
          VALUES (${input.sourceId}, ${item.itemKey}, ${item.title}, ${item.content}, ${item.link}, ${item.publishedAt},
            ${item.revision}, ${ordinal}, ${input.at}, ${input.at}, 1, ${item.disposition}, NULL, NULL,
            ${item.forgeReference?.host ?? null}, ${item.forgeReference?.repository ?? null}, ${item.forgeReference?.issueNumber ?? null})
          ON CONFLICT (source_id, item_key) DO UPDATE SET
            title = excluded.title, content = excluded.content, link = excluded.link, published_at = excluded.published_at,
            revision = excluded.revision, ordinal = excluded.ordinal, last_seen_at = excluded.last_seen_at, in_window = 1,
            disposition = CASE WHEN excluded.disposition = 'unreviewable' THEN 'unreviewable'
              WHEN factory_feed_items.disposition = 'retracted' THEN 'retracted' ELSE excluded.disposition END,
            dismissed_revision = NULL, dismissal_note = NULL, forge_host = excluded.forge_host,
            forge_repository = excluded.forge_repository, forge_issue_number = excluded.forge_issue_number`;
          yield* sql`INSERT INTO factory_feed_item_revisions (source_id, item_key, ordinal, revision, observed_at)
          VALUES (${input.sourceId}, ${item.itemKey}, ${ordinal}, ${item.revision}, ${input.at})`;
        }
        yield* sql`UPDATE factory_feed_sources SET title = ${input.title}, etag = ${input.etag}, last_modified = ${input.lastModified},
        last_checked_at = ${input.at}, next_allowed_at = ${input.nextAllowedAt}, last_error = NULL WHERE source_id = ${input.sourceId}`;
        return yield* requireSource(input.sourceId);
      }),
    );
  }, Effect.mapError(persistenceError));
  const notModified = Effect.fn("FactoryFeedStore.notModified")(function* (input: Check) {
    yield* sql`UPDATE factory_feed_sources SET last_checked_at = ${input.at}, next_allowed_at = ${input.nextAllowedAt}, last_error = NULL
      WHERE source_id = ${input.sourceId}`;
    return yield* requireSource(input.sourceId);
  }, Effect.mapError(persistenceError));
  const failed = Effect.fn("FactoryFeedStore.failed")(
    (input: Check & { readonly error: string; readonly suspend: boolean }) =>
      sql`UPDATE factory_feed_sources SET last_checked_at = ${input.at}, next_allowed_at = ${input.nextAllowedAt}, last_error = ${input.error},
      status = CASE WHEN ${input.suspend ? 1 : 0} = 1 THEN 'suspended' ELSE status END WHERE source_id = ${input.sourceId}`.pipe(
        Effect.asVoid,
        Effect.mapError(persistenceError),
      ),
  );
  const setDismissed = Effect.fn("FactoryFeedStore.setDismissed")(function* (
    input: FactoryFeedCandidateDismissInput,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const item = yield* getItem(input);
        if (Option.isNone(item))
          return yield* new FactoryFeedError({ reason: "missing-candidate" });
        if (item.value.revision !== input.expectedRevision)
          return yield* new FactoryFeedError({ reason: "candidate-changed" });
        if (item.value.disposition === "unreviewable")
          return yield* new FactoryFeedError({ reason: "candidate-unreviewable" });
        yield* sql`UPDATE factory_feed_items SET disposition = ${input.dismissed ? "dismissed" : "open"},
        dismissed_revision = ${input.dismissed ? input.expectedRevision : null}, dismissal_note = ${input.dismissed ? (input.note ?? null) : null}
        WHERE source_id = ${input.sourceId} AND item_key = ${input.itemKey}`;
        return {
          ...item.value,
          disposition: input.dismissed ? ("dismissed" as const) : ("open" as const),
          dismissalNote: input.dismissed ? (input.note ?? null) : null,
        };
      }),
    );
  }, Effect.mapError(persistenceError));
  const get = Effect.fn("FactoryFeedStore.get")(function* (originKey: FactoryOriginKey) {
    const rows = yield* decodeBindings(
      yield* sql`
      SELECT intent_json AS intent, accepted, MAX(origin_conflict) OVER () AS originConflict FROM factory_feed_launches
      WHERE origin_key = ${originKey} AND superseded = 0 ORDER BY origin_conflict, thread_id LIMIT 1`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const reserve = Effect.fn("FactoryFeedStore.reserve")(function* (
    intent: FactoryFeedLaunchIntent,
  ) {
    const json = yield* encodeIntent(intent);
    const originKey = feedItemOriginKey(
      intent.repository.canonicalKey,
      intent.snapshot.feed,
      intent.itemKey,
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const conflicts = yield* sql`SELECT thread_id FROM factory_feed_launches
          WHERE origin_key = ${originKey} AND superseded = 0 AND origin_conflict = 1 LIMIT 1`;
        if (conflicts.length > 0) return yield* new FactoryFeedError({ reason: "origin-conflict" });
        const current = yield* get(originKey);
        if (Option.isSome(current)) {
          if (current.value.intent.threadId !== intent.previousThreadId) return current.value;
          const used =
            yield* sql`SELECT thread_id FROM factory_feed_launches WHERE request_command_id = ${intent.requestCommandId}`;
          if (used.length > 0) return current.value;
        } else if (intent.previousThreadId !== null)
          return yield* new FactoryFeedError({ reason: "persistence-failure" });
        const source = yield* requireSource(intent.sourceId);
        if (source.status !== "active")
          return yield* new FactoryFeedError({ reason: "source-suspended" });
        const item = yield* getItem(intent);
        if (Option.isNone(item))
          return yield* new FactoryFeedError({ reason: "missing-candidate" });
        yield* assertAdmissible(item.value, intent.revision);
        if (Option.isSome(current))
          yield* sql`UPDATE factory_feed_launches SET superseded = 1
        WHERE thread_id = ${intent.previousThreadId} AND superseded = 0`;
        yield* sql`INSERT INTO factory_feed_launches (thread_id, source_id, item_key, request_command_id, intent_json, origin_key)
        VALUES (${intent.threadId}, ${intent.sourceId}, ${intent.itemKey}, ${intent.requestCommandId}, ${json}, ${originKey}) ON CONFLICT DO NOTHING`;
        const winner = yield* get(originKey);
        if (Option.isNone(winner))
          return yield* new FactoryFeedError({ reason: "persistence-failure" });
        return winner.value;
      }),
    );
  }, Effect.mapError(persistenceError));
  const accept = Effect.fn("FactoryFeedStore.accept")((threadId: ThreadId) =>
    sql`
    UPDATE factory_feed_launches SET accepted = 1 WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(persistenceError),
    ),
  );
  return FactoryFeedStore.of({
    bind,
    unbind,
    listSources,
    getSource,
    claimFetch,
    observe,
    notModified,
    failed,
    listItems,
    getItem,
    setDismissed,
    get,
    reserve,
    accept,
  });
});
export const layer = Layer.effect(FactoryFeedStore, make);
