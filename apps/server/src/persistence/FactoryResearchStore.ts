import {
  CommandId,
  FactoryResearchError,
  FactoryResearchFinding,
  FactoryResearchObservation,
  FactoryResearchProtocol,
  FactoryResearchProtocolId,
  FactoryResearchRunRole,
  ThreadId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { FactoryLaunchCore } from "../factory/FactoryTaskLaunch.ts";

export const FactoryResearchLaunchIntent = Schema.Struct({
  ...FactoryLaunchCore.fields,
  protocolId: FactoryResearchProtocolId,
  protocolRevision: Schema.String,
  role: FactoryResearchRunRole,
  protocol: FactoryResearchProtocol,
  instructions: Schema.NullOr(Schema.String),
  launchedByThreadId: Schema.NullOr(ThreadId),
  finding: Schema.NullOr(FactoryResearchFinding),
});
export type FactoryResearchLaunchIntent = typeof FactoryResearchLaunchIntent.Type;
const Binding = Schema.Struct({
  intent: Schema.fromJsonString(FactoryResearchLaunchIntent),
  accepted: Schema.Literals([0, 1]),
});
export type FactoryResearchBinding = typeof Binding.Type;
// Budget use is derived on read from the run lifecycle; the record time is kept as provenance.
const Evidence = FactoryResearchObservation.mapFields(
  ({ disposition: _disposition, elapsedMinutes, ...fields }) => ({
    ...fields,
    recordedAfterMinutes: elapsedMinutes,
  }),
);
export type StoredEvidence = typeof Evidence.Type;
export type RetainedArtifact = StoredEvidence["artifacts"][number] & {
  readonly content: Uint8Array | null;
};
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding));
const decodeProtocols = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ protocol: Schema.fromJsonString(FactoryResearchProtocol) })),
);
const decodeEvidence = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ evidence: Schema.fromJsonString(Evidence) })),
);
const encodeProtocol = Schema.encodeEffect(Schema.fromJsonString(FactoryResearchProtocol));
const encodeIntent = Schema.encodeEffect(Schema.fromJsonString(FactoryResearchLaunchIntent));
const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(Evidence));
const isResearchError = Schema.is(FactoryResearchError);
const persistenceError = (cause: unknown) =>
  isResearchError(cause)
    ? cause
    : new FactoryResearchError({ reason: "persistence-failure", cause });

export class FactoryResearchStore extends Context.Service<
  FactoryResearchStore,
  {
    readonly listProtocols: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly FactoryResearchProtocol[], FactoryResearchError>;
    readonly getProtocol: (
      id: FactoryResearchProtocolId,
    ) => Effect.Effect<Option.Option<FactoryResearchProtocol>, FactoryResearchError>;
    readonly getProtocolByCommand: (
      id: CommandId,
    ) => Effect.Effect<Option.Option<FactoryResearchProtocol>, FactoryResearchError>;
    readonly seal: (
      protocol: FactoryResearchProtocol,
      commandId: CommandId,
    ) => Effect.Effect<FactoryResearchProtocol, FactoryResearchError>;
    readonly getRun: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<FactoryResearchBinding>, FactoryResearchError>;
    readonly getRunByCommand: (
      commandId: CommandId,
    ) => Effect.Effect<Option.Option<FactoryResearchBinding>, FactoryResearchError>;
    readonly listRuns: (
      protocolId: FactoryResearchProtocolId,
    ) => Effect.Effect<readonly FactoryResearchBinding[], FactoryResearchError>;
    readonly getImplementation: (
      protocolId: FactoryResearchProtocolId,
    ) => Effect.Effect<Option.Option<FactoryResearchBinding>, FactoryResearchError>;
    readonly reserve: (
      intent: FactoryResearchLaunchIntent,
      recheck: Effect.Effect<void, FactoryResearchError>,
    ) => Effect.Effect<FactoryResearchBinding, FactoryResearchError>;
    readonly accept: (threadId: ThreadId) => Effect.Effect<void, FactoryResearchError>;
    readonly getEvidence: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<StoredEvidence>, FactoryResearchError>;
    readonly listEvidence: (
      protocolId: FactoryResearchProtocolId,
    ) => Effect.Effect<readonly StoredEvidence[], FactoryResearchError>;
    readonly recordEvidence: (
      evidence: StoredEvidence,
      artifacts: readonly RetainedArtifact[],
      pin: Effect.Effect<void, FactoryResearchError>,
    ) => Effect.Effect<void, FactoryResearchError>;
  }
>()("t3/persistence/FactoryResearchStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const getProtocol = Effect.fn("FactoryResearchStore.getProtocol")(function* (
    id: FactoryResearchProtocolId,
  ) {
    const rows = yield* decodeProtocols(
      yield* sql`SELECT protocol_json AS protocol FROM factory_research_protocols WHERE protocol_id = ${id}`,
    );
    return Option.fromNullishOr(rows[0]?.protocol);
  }, Effect.mapError(persistenceError));
  const getProtocolByCommand = Effect.fn("FactoryResearchStore.getProtocolByCommand")(function* (
    id: CommandId,
  ) {
    const rows = yield* decodeProtocols(
      yield* sql`SELECT protocol_json AS protocol FROM factory_research_protocols WHERE request_command_id = ${id}`,
    );
    return Option.fromNullishOr(rows[0]?.protocol);
  }, Effect.mapError(persistenceError));
  const listProtocols = Effect.fn("FactoryResearchStore.listProtocols")(function* (
    projectId: ProjectId,
  ) {
    return (yield* decodeProtocols(
      yield* sql`SELECT protocol_json AS protocol FROM factory_research_protocols WHERE project_id = ${projectId} ORDER BY sealed_at, protocol_id`,
    )).map((row) => row.protocol);
  }, Effect.mapError(persistenceError));
  const seal = Effect.fn("FactoryResearchStore.seal")(function* (
    protocol: FactoryResearchProtocol,
    commandId: CommandId,
  ) {
    const json = yield* encodeProtocol(protocol);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO factory_research_protocols (protocol_id, canonical_key, project_id, request_command_id, protocol_json, revision, sealed_at)
        VALUES (${protocol.id}, ${protocol.repository.canonicalKey}, ${protocol.projectId}, ${commandId}, ${json}, ${protocol.revision}, ${protocol.sealedAt}) ON CONFLICT (request_command_id) DO NOTHING`;
        const result = yield* getProtocolByCommand(commandId);
        if (Option.isNone(result))
          return yield* new FactoryResearchError({ reason: "persistence-failure" });
        if (result.value.projectId !== protocol.projectId)
          return yield* new FactoryResearchError({ reason: "missing-protocol" });
        return result.value;
      }),
    );
  }, Effect.mapError(persistenceError));
  const getRun = Effect.fn("FactoryResearchStore.getRun")(function* (threadId: ThreadId) {
    return Option.fromNullishOr(
      (yield* decodeBindings(
        yield* sql`SELECT intent_json AS intent, accepted FROM factory_research_launches WHERE thread_id = ${threadId}`,
      ))[0],
    );
  }, Effect.mapError(persistenceError));
  const getRunByCommand = Effect.fn("FactoryResearchStore.getRunByCommand")(function* (
    commandId: CommandId,
  ) {
    return Option.fromNullishOr(
      (yield* decodeBindings(
        yield* sql`SELECT intent_json AS intent, accepted FROM factory_research_launches WHERE request_command_id = ${commandId}`,
      ))[0],
    );
  }, Effect.mapError(persistenceError));
  const listRuns = Effect.fn("FactoryResearchStore.listRuns")(function* (
    protocolId: FactoryResearchProtocolId,
  ) {
    return yield* decodeBindings(
      yield* sql`SELECT intent_json AS intent, accepted FROM factory_research_launches WHERE protocol_id = ${protocolId} AND superseded = 0 ORDER BY created_at, thread_id`,
    );
  }, Effect.mapError(persistenceError));
  const getImplementation = Effect.fn("FactoryResearchStore.getImplementation")(function* (
    protocolId: FactoryResearchProtocolId,
  ) {
    return Option.fromNullishOr(
      (yield* decodeBindings(
        yield* sql`SELECT intent_json AS intent, accepted FROM factory_research_launches WHERE protocol_id = ${protocolId} AND role = 'implementation' AND superseded = 0`,
      ))[0],
    );
  }, Effect.mapError(persistenceError));
  const reserve = Effect.fn("FactoryResearchStore.reserve")(function* (
    intent: FactoryResearchLaunchIntent,
    recheck: Effect.Effect<void, FactoryResearchError>,
  ) {
    const json = yield* encodeIntent(intent);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const replay = yield* getRunByCommand(intent.requestCommandId);
        if (Option.isSome(replay)) {
          // Same check as the service's first replay read: a concurrent request reusing this
          // command id for another role must be refused, never handed that role's binding.
          if (
            replay.value.intent.protocolId !== intent.protocolId ||
            replay.value.intent.projectId !== intent.projectId ||
            replay.value.intent.role !== intent.role
          )
            return yield* new FactoryResearchError({ reason: "missing-run" });
          return replay.value;
        }
        if (intent.role === "implementation") {
          const current = yield* getImplementation(intent.protocolId);
          if (Option.isSome(current) && current.value.intent.threadId !== intent.previousThreadId)
            return current.value;
          if (Option.isNone(current) && intent.previousThreadId !== null)
            return yield* new FactoryResearchError({ reason: "deleted-task" });
        } else {
          const runs = yield* sql<{
            readonly count: number;
          }>`SELECT count(*) AS count FROM factory_research_launches
          WHERE protocol_id = ${intent.protocolId} AND superseded = 0 AND role IN ('explore', 'verify')`;
          if ((runs[0]?.count ?? 0) >= intent.protocol.budget.maxRuns)
            return yield* new FactoryResearchError({ reason: "budget-exhausted" });
        }
        // The caller derives the finding again under the same transaction as the reservation.
        yield* recheck;
        if (intent.previousThreadId !== null)
          yield* sql`UPDATE factory_research_launches SET superseded = 1 WHERE thread_id = ${intent.previousThreadId} AND superseded = 0`;
        yield* sql`INSERT INTO factory_research_launches (thread_id, protocol_id, role, request_command_id, intent_json, launched_by_thread_id, created_at)
        VALUES (${intent.threadId}, ${intent.protocolId}, ${intent.role}, ${intent.requestCommandId}, ${json}, ${intent.launchedByThreadId}, ${intent.createdAt})`;
        return { intent, accepted: 0 as const };
      }),
    );
  }, Effect.mapError(persistenceError));
  const accept = Effect.fn("FactoryResearchStore.accept")((threadId: ThreadId) =>
    sql`UPDATE factory_research_launches SET accepted = 1 WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(persistenceError),
    ),
  );
  const getEvidence = Effect.fn("FactoryResearchStore.getEvidence")(function* (threadId: ThreadId) {
    return Option.fromNullishOr(
      (yield* decodeEvidence(
        yield* sql`SELECT evidence_json AS evidence FROM factory_research_evidence WHERE thread_id = ${threadId}`,
      ))[0]?.evidence,
    );
  }, Effect.mapError(persistenceError));
  const listEvidence = Effect.fn("FactoryResearchStore.listEvidence")(function* (
    protocolId: FactoryResearchProtocolId,
  ) {
    return (yield* decodeEvidence(
      yield* sql`SELECT e.evidence_json AS evidence FROM factory_research_evidence e JOIN factory_research_launches l ON l.thread_id = e.thread_id WHERE l.protocol_id = ${protocolId} AND l.superseded = 0 ORDER BY e.recorded_at, e.thread_id`,
    )).map((row) => row.evidence);
  }, Effect.mapError(persistenceError));
  const recordEvidence = Effect.fn("FactoryResearchStore.recordEvidence")(function* (
    evidence: StoredEvidence,
    artifacts: readonly RetainedArtifact[],
    pin: Effect.Effect<void, FactoryResearchError>,
  ) {
    const json = yield* encodeEvidence(evidence);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (Option.isNone(yield* getRun(evidence.threadId)))
          return yield* new FactoryResearchError({ reason: "missing-run" });
        if (Option.isSome(yield* getEvidence(evidence.threadId)))
          return yield* new FactoryResearchError({ reason: "evidence-already-recorded" });
        // A losing concurrent writer must never move the winning evidence's retention ref.
        yield* pin;
        yield* sql`INSERT INTO factory_research_evidence (thread_id, evidence_json, recorded_at) VALUES (${evidence.threadId}, ${json}, ${evidence.recordedAt})`;
        for (const artifact of artifacts) {
          yield* sql`INSERT INTO factory_research_artifacts (thread_id, path, line, sha256, bytes, retention, content)
          VALUES (${evidence.threadId}, ${artifact.path}, ${artifact.line}, ${artifact.sha256}, ${artifact.bytes}, ${artifact.retention}, ${artifact.content}) ON CONFLICT DO NOTHING`;
        }
      }),
    );
  }, Effect.mapError(persistenceError));
  return FactoryResearchStore.of({
    listProtocols,
    getProtocol,
    getProtocolByCommand,
    seal,
    getRun,
    getRunByCommand,
    listRuns,
    getImplementation,
    reserve,
    accept,
    getEvidence,
    listEvidence,
    recordEvidence,
  });
});
export const layer = Layer.effect(FactoryResearchStore, make);
