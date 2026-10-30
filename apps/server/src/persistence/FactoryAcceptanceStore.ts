import {
  FactoryAcceptance,
  FactoryAcceptanceError,
  FactoryOriginKey,
  type FactoryRepository,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { feedItemOriginKey, issueOriginKey } from "../factory/FactoryOriginKey.ts";
import { FactoryFeedLaunchIntent } from "./FactoryFeedStore.ts";
import { FactoryLaunchIntent } from "./FactoryIssueLaunches.ts";

const StoredAcceptance = FactoryAcceptance.mapFields((fields) => ({
  ...fields,
  evidenceRefs: Schema.fromJsonString(Schema.Array(Schema.String)),
}));
const decodeAcceptances = Schema.decodeUnknownEffect(Schema.Array(StoredAcceptance));
const encodeEvidenceRefs = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeOrigins = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Union([
      Schema.Struct({
        origin: Schema.Literal("issue"),
        originKey: Schema.NullOr(FactoryOriginKey),
        intent: Schema.fromJsonString(FactoryLaunchIntent),
      }),
      Schema.Struct({
        origin: Schema.Literal("feed-item"),
        originKey: Schema.NullOr(FactoryOriginKey),
        intent: Schema.fromJsonString(FactoryFeedLaunchIntent),
      }),
    ]),
  ),
);
const isAcceptanceError = Schema.is(FactoryAcceptanceError);
const persistenceError = (cause: unknown) =>
  isAcceptanceError(cause)
    ? cause
    : new FactoryAcceptanceError({ reason: "persistence-failure", cause });

export interface FactoryAcceptanceOrigin {
  readonly originKey: FactoryOriginKey;
  readonly baseRef: string;
  readonly baseBranch: string | null;
  // The repository the claim was admitted against; deliveries are pinned to it.
  readonly repository: FactoryRepository;
}

export class FactoryAcceptanceStore extends Context.Service<
  FactoryAcceptanceStore,
  {
    /** The live claim's origin for a thread, or none when the thread holds no live claim. */
    readonly resolveOrigin: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<FactoryAcceptanceOrigin>, FactoryAcceptanceError>;
    readonly getByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<FactoryAcceptance>, FactoryAcceptanceError>;
    readonly getByOrigin: (
      originKey: FactoryOriginKey,
    ) => Effect.Effect<Option.Option<FactoryAcceptance>, FactoryAcceptanceError>;
    /**
     * Write-once per origin: fails with `already-accepted` while a live row exists, unless the
     * caller asks to retire it in the same transaction.
     */
    readonly insert: (
      acceptance: FactoryAcceptance,
      options?: { readonly supersede?: boolean },
    ) => Effect.Effect<FactoryAcceptance, FactoryAcceptanceError>;
  }
>()("t3/persistence/FactoryAcceptanceStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const resolveOrigin = Effect.fn("FactoryAcceptanceStore.resolveOrigin")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* decodeOrigins(
      yield* sql`
        SELECT 'issue' AS origin, origin_key AS originKey, intent_json AS intent
        FROM factory_issue_launches WHERE thread_id = ${threadId} AND superseded = 0
        UNION ALL
        SELECT 'feed-item', origin_key, intent_json
        FROM factory_feed_launches WHERE thread_id = ${threadId} AND superseded = 0
      `,
    );
    const row = rows[0];
    if (row === undefined) return Option.none<FactoryAcceptanceOrigin>();
    // Rows admitted before origin keys were recorded derive the same key the claims list shows.
    const originKey =
      row.originKey ??
      (row.origin === "issue"
        ? issueOriginKey(
            row.intent.repository.provider,
            row.intent.repository.canonicalKey,
            row.intent.issue.number,
          )
        : feedItemOriginKey(
            row.intent.repository.canonicalKey,
            row.intent.snapshot.feed,
            row.intent.itemKey,
          ));
    return Option.some({
      originKey,
      baseRef: row.intent.baseRef,
      baseBranch: row.intent.baseBranch ?? null,
      repository: row.intent.repository,
    });
  }, Effect.mapError(persistenceError));
  const columns = sql.literal(`id, origin_key AS originKey, thread_id AS threadId,
    project_id AS projectId, head_sha AS headSha, base_ref AS baseRef, base_branch AS baseBranch, base_sha AS baseSha,
    accepted_at AS acceptedAt, accepted_by AS acceptedBy, evidence_json AS evidenceRefs`);
  const getByThread = Effect.fn("FactoryAcceptanceStore.getByThread")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* decodeAcceptances(
      yield* sql`SELECT ${columns} FROM factory_acceptances
        WHERE thread_id = ${threadId} AND superseded = 0`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const getByOrigin = Effect.fn("FactoryAcceptanceStore.getByOrigin")(function* (
    originKey: FactoryOriginKey,
  ) {
    const rows = yield* decodeAcceptances(
      yield* sql`SELECT ${columns} FROM factory_acceptances
        WHERE origin_key = ${originKey} AND superseded = 0`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const insert = Effect.fn("FactoryAcceptanceStore.insert")(function* (
    acceptance: FactoryAcceptance,
    options?: { readonly supersede?: boolean },
  ) {
    const evidence = yield* encodeEvidenceRefs(acceptance.evidenceRefs);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (Option.isSome(yield* getByOrigin(acceptance.originKey))) {
          if (options?.supersede !== true)
            return yield* new FactoryAcceptanceError({ reason: "already-accepted" });
          yield* sql`UPDATE factory_acceptances SET superseded = 1
            WHERE origin_key = ${acceptance.originKey} AND superseded = 0`;
        }
        // The partial unique index is the arbiter when another writer wins between the read and
        // this insert; the loser reads its own row back as absent.
        yield* sql`INSERT INTO factory_acceptances
          (id, origin_key, thread_id, project_id, head_sha, base_ref, base_branch, base_sha, accepted_at, accepted_by, evidence_json)
          VALUES (${acceptance.id}, ${acceptance.originKey}, ${acceptance.threadId}, ${acceptance.projectId},
            ${acceptance.headSha}, ${acceptance.baseRef}, ${acceptance.baseBranch ?? null}, ${acceptance.baseSha}, ${acceptance.acceptedAt},
            ${acceptance.acceptedBy}, ${evidence})
          ON CONFLICT DO NOTHING`;
        const stored = yield* getByOrigin(acceptance.originKey);
        if (Option.isNone(stored) || stored.value.id !== acceptance.id)
          return yield* new FactoryAcceptanceError({ reason: "already-accepted" });
        return stored.value;
      }),
    );
  }, Effect.mapError(persistenceError));
  return FactoryAcceptanceStore.of({ resolveOrigin, getByThread, getByOrigin, insert });
});
export const layer = Layer.effect(FactoryAcceptanceStore, make);
