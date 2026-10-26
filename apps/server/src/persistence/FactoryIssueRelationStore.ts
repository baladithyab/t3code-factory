import {
  CommandId,
  FactoryIssueError,
  FactoryReadinessEdge,
  FactoryReadinessOverride,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Subject = Schema.Struct({ canonicalKey: Schema.String, issueNumber: PositiveInt });
type Subject = typeof Subject.Type;
const Edge = Schema.Struct({
  ...Subject.fields,
  targetHost: Schema.String,
  targetId: PositiveInt,
  targetRepository: Schema.String,
  targetNumber: PositiveInt,
  firstObservedAt: IsoDateTime,
  lastObservedAt: IsoDateTime,
  status: FactoryReadinessEdge.fields.status,
  tombstonedAt: Schema.NullOr(IsoDateTime),
});
export type StoredEdge = typeof Edge.Type;
const Override = Schema.Struct({
  ...Subject.fields,
  id: FactoryReadinessOverride.fields.id,
  kind: FactoryReadinessOverride.fields.kind,
  targetHost: FactoryReadinessOverride.fields.targetHost,
  targetId: FactoryReadinessOverride.fields.targetId,
  boundFingerprint: FactoryReadinessOverride.fields.boundFingerprint,
  reason: FactoryReadinessOverride.fields.reason,
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
  requestCommandId: CommandId,
});
export type StoredOverride = typeof Override.Type;
const Observation = Schema.Struct({
  ...Subject.fields,
  observedAt: Schema.NullOr(IsoDateTime),
  complete: Schema.Literals([0, 1]),
  listedCount: NonNegativeInt,
  summaryTotal: Schema.NullOr(NonNegativeInt),
  failure: Schema.NullOr(Schema.String),
  lastAttemptAt: IsoDateTime,
});
type Observation = typeof Observation.Type;
type Target = Pick<StoredEdge, "targetHost" | "targetId" | "targetRepository" | "targetNumber">;
type Tombstone = Pick<StoredEdge, "targetHost" | "targetId"> & {
  readonly status: Exclude<StoredEdge["status"], "present">;
};
export class FactoryIssueRelationStore extends Context.Service<
  FactoryIssueRelationStore,
  {
    readonly getObservation: (
      subject: Subject,
    ) => Effect.Effect<Option.Option<Observation>, FactoryIssueError>;
    readonly listEdges: (subject: {
      readonly canonicalKey: string;
      readonly issueNumber?: number;
    }) => Effect.Effect<readonly StoredEdge[], FactoryIssueError>;
    readonly recordComplete: (input: {
      readonly subject: Subject;
      readonly observedAt: string;
      readonly listedCount: number;
      readonly summaryTotal: number;
      readonly present: readonly Target[];
      readonly tombstones: readonly Tombstone[];
    }) => Effect.Effect<void, FactoryIssueError>;
    readonly recordFailure: (input: {
      readonly subject: Subject;
      readonly observedAt: string;
      readonly failure: string;
    }) => Effect.Effect<void, FactoryIssueError>;
    readonly listOverrides: (
      subject: Subject,
    ) => Effect.Effect<readonly StoredOverride[], FactoryIssueError>;
    readonly findOverrideCommand: (
      commandId: CommandId,
    ) => Effect.Effect<Option.Option<StoredOverride>, FactoryIssueError>;
    readonly setOverride: (row: StoredOverride) => Effect.Effect<StoredOverride, FactoryIssueError>;
    readonly revokeOverride: (
      input: Subject & { readonly overrideId: StoredOverride["id"]; readonly revokedAt: string },
    ) => Effect.Effect<void, FactoryIssueError>;
  }
>()("t3/persistence/FactoryIssueRelationStore") {}

const isFactoryIssueError = Schema.is(FactoryIssueError);
const persistenceError = (cause: unknown) =>
  isFactoryIssueError(cause)
    ? cause
    : new FactoryIssueError({ reason: "persistence-failure", cause });
const decodeObservations = Schema.decodeUnknownEffect(Schema.Array(Observation));
const decodeEdges = Schema.decodeUnknownEffect(Schema.Array(Edge));
const decodeOverrides = Schema.decodeUnknownEffect(Schema.Array(Override));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const overrideColumns = sql.literal(`override_id AS id, canonical_key AS canonicalKey,
    issue_number AS issueNumber, target_host AS targetHost, target_id AS targetId, kind,
    bound_fingerprint AS boundFingerprint, reason, request_command_id AS requestCommandId,
    created_at AS createdAt, revoked_at AS revokedAt`);
  const listOverrides = Effect.fn("FactoryIssueRelationStore.listOverrides")(function* (
    subject: Subject,
  ) {
    return yield* decodeOverrides(
      yield* sql`SELECT ${overrideColumns} FROM factory_issue_readiness_overrides
        WHERE canonical_key = ${subject.canonicalKey} AND issue_number = ${subject.issueNumber}
        ORDER BY created_at, rowid`,
    );
  }, Effect.mapError(persistenceError));
  const findOverrideCommand = Effect.fn("FactoryIssueRelationStore.findOverrideCommand")(function* (
    commandId: CommandId,
  ) {
    const rows = yield* decodeOverrides(
      yield* sql`SELECT ${overrideColumns} FROM factory_issue_readiness_overrides
        WHERE request_command_id = ${commandId}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const setOverride = Effect.fn("FactoryIssueRelationStore.setOverride")(function* (
    row: StoredOverride,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* findOverrideCommand(row.requestCommandId);
        if (Option.isSome(existing)) {
          if (
            existing.value.canonicalKey !== row.canonicalKey ||
            existing.value.issueNumber !== row.issueNumber
          )
            return yield* new FactoryIssueError({ reason: "invalid-response" });
          return existing.value;
        }
        yield* sql`UPDATE factory_issue_readiness_overrides SET revoked_at = ${row.createdAt}
          WHERE canonical_key = ${row.canonicalKey} AND issue_number = ${row.issueNumber}
          AND target_host = ${row.targetHost} AND target_id = ${row.targetId} AND revoked_at IS NULL`;
        yield* sql`INSERT INTO factory_issue_readiness_overrides
          (override_id, canonical_key, issue_number, target_host, target_id, kind,
          bound_fingerprint, reason, request_command_id, created_at, revoked_at)
          VALUES (${row.id}, ${row.canonicalKey}, ${row.issueNumber}, ${row.targetHost},
          ${row.targetId}, ${row.kind}, ${row.boundFingerprint}, ${row.reason},
          ${row.requestCommandId}, ${row.createdAt}, NULL)`;
        return row;
      }),
    );
  }, Effect.mapError(persistenceError));
  const revokeOverride = Effect.fn("FactoryIssueRelationStore.revokeOverride")(function* (
    input: Parameters<FactoryIssueRelationStore["Service"]["revokeOverride"]>[0],
  ) {
    const rows = yield* sql`UPDATE factory_issue_readiness_overrides
      SET revoked_at = COALESCE(revoked_at, ${input.revokedAt})
      WHERE override_id = ${input.overrideId} AND canonical_key = ${input.canonicalKey}
      AND issue_number = ${input.issueNumber} RETURNING override_id`;
    if (rows.length === 0) return yield* new FactoryIssueError({ reason: "invalid-response" });
  }, Effect.mapError(persistenceError));
  const getObservation = Effect.fn("FactoryIssueRelationStore.getObservation")(function* (
    subject: Subject,
  ) {
    const rows = yield* decodeObservations(
      yield* sql`SELECT canonical_key AS canonicalKey,
      issue_number AS issueNumber, observed_at AS observedAt, complete, listed_count AS listedCount,
      summary_total AS summaryTotal, failure, last_attempt_at AS lastAttemptAt
      FROM factory_issue_relation_observations WHERE canonical_key = ${subject.canonicalKey} AND issue_number = ${subject.issueNumber}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const listEdges = Effect.fn("FactoryIssueRelationStore.listEdges")(function* (
    subject: Parameters<FactoryIssueRelationStore["Service"]["listEdges"]>[0],
  ) {
    return yield* decodeEdges(
      yield* sql`SELECT canonical_key AS canonicalKey, issue_number AS issueNumber,
      target_host AS targetHost, target_id AS targetId, target_repository AS targetRepository,
      target_number AS targetNumber, first_observed_at AS firstObservedAt, last_observed_at AS lastObservedAt,
      status, tombstoned_at AS tombstonedAt FROM factory_issue_relation_edges
      WHERE canonical_key = ${subject.canonicalKey}
      AND (${subject.issueNumber ?? null} IS NULL OR issue_number = ${subject.issueNumber ?? null})
      ORDER BY issue_number, first_observed_at, target_host, target_id`,
    );
  }, Effect.mapError(persistenceError));
  const recordComplete = Effect.fn("FactoryIssueRelationStore.recordComplete")(function* (
    input: Parameters<FactoryIssueRelationStore["Service"]["recordComplete"]>[0],
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const { subject, observedAt } = input;
        for (const edge of input.present) {
          yield* sql`INSERT INTO factory_issue_relation_edges
          (canonical_key, issue_number, target_host, target_id, target_repository, target_number,
          first_observed_at, last_observed_at, status, tombstoned_at)
          VALUES (${subject.canonicalKey}, ${subject.issueNumber}, ${edge.targetHost}, ${edge.targetId},
          ${edge.targetRepository}, ${edge.targetNumber}, ${observedAt}, ${observedAt}, 'present', NULL)
          ON CONFLICT (canonical_key, issue_number, target_host, target_id) DO UPDATE SET
          target_repository = excluded.target_repository, target_number = excluded.target_number,
          last_observed_at = excluded.last_observed_at, status = 'present', tombstoned_at = NULL`;
        }
        for (const edge of input.tombstones) {
          yield* sql`UPDATE factory_issue_relation_edges SET status = ${edge.status}, tombstoned_at = ${observedAt}
          WHERE canonical_key = ${subject.canonicalKey} AND issue_number = ${subject.issueNumber}
          AND target_host = ${edge.targetHost} AND target_id = ${edge.targetId}`;
        }
        yield* sql`INSERT INTO factory_issue_relation_observations
        (canonical_key, issue_number, observed_at, complete, listed_count, summary_total, failure, last_attempt_at)
        VALUES (${subject.canonicalKey}, ${subject.issueNumber}, ${observedAt}, 1, ${input.listedCount}, ${input.summaryTotal}, NULL, ${observedAt})
        ON CONFLICT (canonical_key, issue_number) DO UPDATE SET observed_at = excluded.observed_at,
        complete = 1, listed_count = excluded.listed_count, summary_total = excluded.summary_total,
        failure = NULL, last_attempt_at = excluded.last_attempt_at`;
      }),
    );
  }, Effect.mapError(persistenceError));
  const recordFailure = Effect.fn("FactoryIssueRelationStore.recordFailure")(function* (
    input: Parameters<FactoryIssueRelationStore["Service"]["recordFailure"]>[0],
  ) {
    // Only a complete listing establishes or refreshes the comparison baseline. A failed
    // attempt has its own timestamp, including when no complete baseline exists yet.
    yield* sql`INSERT INTO factory_issue_relation_observations
      (canonical_key, issue_number, observed_at, complete, listed_count, summary_total, failure, last_attempt_at)
      VALUES (${input.subject.canonicalKey}, ${input.subject.issueNumber}, NULL, 0, 0, NULL, ${input.failure}, ${input.observedAt})
      ON CONFLICT (canonical_key, issue_number) DO UPDATE SET failure = excluded.failure, last_attempt_at = excluded.last_attempt_at`;
  }, Effect.mapError(persistenceError));
  return FactoryIssueRelationStore.of({
    getObservation,
    listEdges,
    recordComplete,
    recordFailure,
    listOverrides,
    findOverrideCommand,
    setOverride,
    revokeOverride,
  });
});
export const layer = Layer.effect(FactoryIssueRelationStore, make);
