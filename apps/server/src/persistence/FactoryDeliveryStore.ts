import {
  FactoryDeliveryError,
  FactoryDeliveryIntent,
  FactoryDeliveryPayload,
  FactoryRepository,
  type FactoryDeliveryKind,
  type FactoryDeliveryStatus,
  type FactoryOriginKey,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Remote = Schema.Struct({ number: Schema.Int, url: Schema.String });
const StoredIntent = FactoryDeliveryIntent.mapFields((fields) => ({
  ...fields,
  repository: Schema.fromJsonString(FactoryRepository),
  payload: Schema.fromJsonString(FactoryDeliveryPayload),
  remote: Schema.NullOr(Schema.fromJsonString(Remote)),
}));
const decodeIntents = Schema.decodeUnknownEffect(Schema.Array(StoredIntent));
const encodeRepository = Schema.encodeEffect(Schema.fromJsonString(FactoryRepository));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(FactoryDeliveryPayload));
const encodeRemote = Schema.encodeEffect(Schema.fromJsonString(Remote));
const isDeliveryError = Schema.is(FactoryDeliveryError);
const persistenceError = (cause: unknown) =>
  isDeliveryError(cause)
    ? cause
    : new FactoryDeliveryError({ reason: "persistence-failure", cause });

export interface FactoryDeliverySettlement {
  readonly status: FactoryDeliveryStatus;
  readonly remote?: { readonly number: number; readonly url: string };
  readonly failure: string | null;
  readonly updatedAt: string;
}

export class FactoryDeliveryStore extends Context.Service<
  FactoryDeliveryStore,
  {
    readonly get: (
      id: string,
    ) => Effect.Effect<Option.Option<FactoryDeliveryIntent>, FactoryDeliveryError>;
    readonly getByCommand: (
      commandId: string,
    ) => Effect.Effect<Option.Option<FactoryDeliveryIntent>, FactoryDeliveryError>;
    /** The live intent (pending, sending, confirmed or unknown) of an origin and kind. */
    readonly getLive: (
      originKey: FactoryOriginKey,
      kind: FactoryDeliveryKind,
    ) => Effect.Effect<Option.Option<FactoryDeliveryIntent>, FactoryDeliveryError>;
    /** Newest first. */
    readonly listByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<FactoryDeliveryIntent>, FactoryDeliveryError>;
    /** Every intent of a project, for resolving an intent id the caller names. */
    readonly getInProject: (
      projectId: ProjectId,
      id: string,
    ) => Effect.Effect<Option.Option<FactoryDeliveryIntent>, FactoryDeliveryError>;
    /**
     * The single-use grant. Inside one transaction: replay by request command id, refuse a live
     * intent for the origin and kind, run `recheck`, insert the intent `pending` and run
     * `enqueue`. The intent and its effect row commit together or not at all.
     */
    readonly grant: (
      intent: FactoryDeliveryIntent,
      steps: {
        readonly recheck: Effect.Effect<void, FactoryDeliveryError>;
        readonly enqueue: Effect.Effect<void, FactoryDeliveryError>;
      },
    ) => Effect.Effect<
      { readonly intent: FactoryDeliveryIntent; readonly created: boolean },
      FactoryDeliveryError
    >;
    /** Compare-and-swap `pending` to `sending`; false when another executor already moved it. */
    readonly markSending: (
      id: string,
      updatedAt: string,
    ) => Effect.Effect<boolean, FactoryDeliveryError>;
    readonly settle: (
      id: string,
      settlement: FactoryDeliverySettlement,
    ) => Effect.Effect<Option.Option<FactoryDeliveryIntent>, FactoryDeliveryError>;
    /** A `sending` row at startup lost its response: it becomes `unknown`, never `pending`. */
    readonly recoverInterrupted: (updatedAt: string) => Effect.Effect<number, FactoryDeliveryError>;
  }
>()("t3/persistence/FactoryDeliveryStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(`id, origin_key AS originKey, thread_id AS threadId,
    project_id AS projectId, kind, acceptance_id AS acceptanceId, repository_json AS repository,
    base_ref AS baseRef, base_sha AS baseSha, head_sha AS headSha, payload_json AS payload,
    payload_digest AS payloadDigest, granted_by AS grantedBy, granted_at AS grantedAt,
    request_command_id AS requestCommandId, status, remote_json AS remote, failure,
    updated_at AS updatedAt`);
  const get = Effect.fn("FactoryDeliveryStore.get")(function* (id: string) {
    const rows = yield* decodeIntents(
      yield* sql`SELECT ${columns} FROM factory_delivery_intents WHERE id = ${id}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const getInProject = Effect.fn("FactoryDeliveryStore.getInProject")(function* (
    projectId: ProjectId,
    id: string,
  ) {
    const rows = yield* decodeIntents(
      yield* sql`SELECT ${columns} FROM factory_delivery_intents
        WHERE id = ${id} AND project_id = ${projectId}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const getByCommand = Effect.fn("FactoryDeliveryStore.getByCommand")(function* (
    commandId: string,
  ) {
    const rows = yield* decodeIntents(
      yield* sql`SELECT ${columns} FROM factory_delivery_intents WHERE request_command_id = ${commandId}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const getLive = Effect.fn("FactoryDeliveryStore.getLive")(function* (
    originKey: FactoryOriginKey,
    kind: FactoryDeliveryKind,
  ) {
    const rows = yield* decodeIntents(
      yield* sql`SELECT ${columns} FROM factory_delivery_intents
        WHERE origin_key = ${originKey} AND kind = ${kind}
          AND status IN ('pending', 'sending', 'confirmed', 'unknown')`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const listByThread = Effect.fn("FactoryDeliveryStore.listByThread")(function* (
    threadId: ThreadId,
  ) {
    return yield* decodeIntents(
      yield* sql`SELECT ${columns} FROM factory_delivery_intents
        WHERE thread_id = ${threadId} ORDER BY granted_at DESC, id DESC`,
    );
  }, Effect.mapError(persistenceError));
  const grant = Effect.fn("FactoryDeliveryStore.grant")(function* (
    intent: FactoryDeliveryIntent,
    steps: {
      readonly recheck: Effect.Effect<void, FactoryDeliveryError>;
      readonly enqueue: Effect.Effect<void, FactoryDeliveryError>;
    },
  ) {
    const repository = yield* encodeRepository(intent.repository);
    const payload = yield* encodePayload(intent.payload);
    // A merge targets a pull request that already exists, so its remote is known at grant.
    const remote = intent.remote === null ? null : yield* encodeRemote(intent.remote);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const replay = yield* getByCommand(intent.requestCommandId);
        if (Option.isSome(replay)) {
          // A command id names one grant: reusing it for another target or payload is refused
          // rather than answered with someone else's intent.
          if (
            replay.value.threadId !== intent.threadId ||
            replay.value.projectId !== intent.projectId ||
            replay.value.kind !== intent.kind
          )
            return yield* new FactoryDeliveryError({ reason: "intent-not-found" });
          if (replay.value.payloadDigest !== intent.payloadDigest)
            return yield* new FactoryDeliveryError({ reason: "payload-changed" });
          return { intent: replay.value, created: false };
        }
        if (Option.isSome(yield* getLive(intent.originKey, intent.kind)))
          return yield* new FactoryDeliveryError({ reason: "already-delivering" });
        yield* steps.recheck;
        // The partial unique index arbitrates a concurrent grant that slipped between the read
        // above and this insert; the loser reads its own row back as absent.
        yield* sql`INSERT INTO factory_delivery_intents
          (id, origin_key, thread_id, project_id, kind, acceptance_id, repository_json, base_ref,
           base_sha, head_sha, payload_json, payload_digest, granted_by, granted_at,
           request_command_id, status, remote_json, failure, updated_at)
          VALUES (${intent.id}, ${intent.originKey}, ${intent.threadId}, ${intent.projectId},
            ${intent.kind}, ${intent.acceptanceId}, ${repository}, ${intent.baseRef},
            ${intent.baseSha}, ${intent.headSha}, ${payload}, ${intent.payloadDigest},
            ${intent.grantedBy}, ${intent.grantedAt}, ${intent.requestCommandId}, 'pending',
            ${remote}, NULL, ${intent.updatedAt})
          ON CONFLICT DO NOTHING`;
        const stored = yield* getByCommand(intent.requestCommandId);
        if (Option.isNone(stored))
          return yield* new FactoryDeliveryError({ reason: "already-delivering" });
        yield* steps.enqueue;
        return { intent: stored.value, created: true };
      }),
    );
  }, Effect.mapError(persistenceError));
  const markSending = Effect.fn("FactoryDeliveryStore.markSending")(function* (
    id: string,
    updatedAt: string,
  ) {
    const rows = yield* sql<{ readonly id: string }>`UPDATE factory_delivery_intents
      SET status = 'sending', updated_at = ${updatedAt}
      WHERE id = ${id} AND status = 'pending' RETURNING id`;
    return rows.length === 1;
  }, Effect.mapError(persistenceError));
  const settle = Effect.fn("FactoryDeliveryStore.settle")(function* (
    id: string,
    settlement: FactoryDeliverySettlement,
  ) {
    const remote = settlement.remote === undefined ? null : yield* encodeRemote(settlement.remote);
    // `confirmed` is terminal: a late reconcile or a retried execute never rewrites it. A
    // settlement without a remote keeps the one set at grant, which a merge needs to retry.
    yield* sql`UPDATE factory_delivery_intents
      SET status = ${settlement.status}, remote_json = COALESCE(${remote}, remote_json),
        failure = ${settlement.failure}, updated_at = ${settlement.updatedAt}
      WHERE id = ${id} AND status <> 'confirmed'`;
    return yield* get(id);
  }, Effect.mapError(persistenceError));
  const recoverInterrupted = Effect.fn("FactoryDeliveryStore.recoverInterrupted")(function* (
    updatedAt: string,
  ) {
    const rows = yield* sql<{ readonly id: string }>`UPDATE factory_delivery_intents
      SET status = 'unknown', failure = 'server restarted during send', updated_at = ${updatedAt}
      WHERE status = 'sending' RETURNING id`;
    return rows.length;
  }, Effect.mapError(persistenceError));
  return FactoryDeliveryStore.of({
    get,
    getByCommand,
    getLive,
    listByThread,
    getInProject,
    grant,
    markSending,
    settle,
    recoverInterrupted,
  });
});
export const layer = Layer.effect(FactoryDeliveryStore, make);
