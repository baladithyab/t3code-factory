import {
  CommandId,
  EnvironmentId,
  FactoryKnowledgeAcceptance,
  FactoryKnowledgeBrief,
  FactoryKnowledgeError,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { knowledgeBriefOriginKey } from "../factory/FactoryOriginKey.ts";

/**
 * The general launch core: a knowledge task has no repository and no base commit, so it is a
 * sibling of `FactoryLaunchCore` rather than a loosened copy of it. The frozen brief lives in
 * `prompt`; `briefRevision` records which revision the reviewer admitted.
 */
export const FactoryKnowledgeLaunchIntent = Schema.Struct({
  briefId: Schema.String,
  briefRevision: Schema.String,
  title: Schema.String,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  requestCommandId: CommandId,
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  prompt: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  admittedBy: Schema.optionalKey(EnvironmentId),
  previousThreadId: Schema.NullOr(ThreadId),
});
export type FactoryKnowledgeLaunchIntent = typeof FactoryKnowledgeLaunchIntent.Type;

const Binding = Schema.Struct({
  intent: Schema.fromJsonString(FactoryKnowledgeLaunchIntent),
  accepted: Schema.Literals([0, 1]),
});
export type FactoryKnowledgeBinding = typeof Binding.Type;
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding));
const encodeIntent = Schema.encodeEffect(Schema.fromJsonString(FactoryKnowledgeLaunchIntent));
const encodeBrief = Schema.encodeEffect(Schema.fromJsonString(FactoryKnowledgeBrief));
const BriefRows = Schema.Array(
  Schema.Struct({
    brief: Schema.fromJsonString(FactoryKnowledgeBrief),
    supersededBy: Schema.NullOr(Schema.String),
  }),
);
const decodeBriefs = Schema.decodeUnknownEffect(BriefRows);
const decodeAcceptances = Schema.decodeUnknownEffect(Schema.Array(FactoryKnowledgeAcceptance));

const isKnowledgeError = Schema.is(FactoryKnowledgeError);
const persistenceError = (cause: unknown) =>
  isKnowledgeError(cause)
    ? cause
    : new FactoryKnowledgeError({ reason: "persistence-failure", cause });

export class FactoryKnowledgeStore extends Context.Service<
  FactoryKnowledgeStore,
  {
    /**
     * Replays by `requestCommandId`. `supersedes` marks the older brief replaced in the same
     * transaction and is refused when that brief is unknown, foreign, or already replaced.
     */
    readonly createBrief: (
      brief: FactoryKnowledgeBrief,
      options: { readonly requestCommandId: CommandId; readonly supersedes: string | null },
    ) => Effect.Effect<FactoryKnowledgeBrief, FactoryKnowledgeError>;
    readonly listBriefs: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly FactoryKnowledgeBrief[], FactoryKnowledgeError>;
    readonly getBrief: (
      briefId: string,
    ) => Effect.Effect<Option.Option<FactoryKnowledgeBrief>, FactoryKnowledgeError>;
    /** The live launch for a brief, if any. */
    readonly getLaunch: (
      briefId: string,
    ) => Effect.Effect<Option.Option<FactoryKnowledgeBinding>, FactoryKnowledgeError>;
    readonly listLaunches: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly FactoryKnowledgeBinding[], FactoryKnowledgeError>;
    /**
     * Reserves the single live launch for the brief. The existing live binding wins; a restart
     * (`previousThreadId`) retires its predecessor, once per request command.
     */
    readonly reserve: (
      intent: FactoryKnowledgeLaunchIntent,
    ) => Effect.Effect<FactoryKnowledgeBinding, FactoryKnowledgeError>;
    readonly accept: (threadId: ThreadId) => Effect.Effect<void, FactoryKnowledgeError>;
    readonly getAcceptance: (
      briefId: string,
    ) => Effect.Effect<Option.Option<FactoryKnowledgeAcceptance>, FactoryKnowledgeError>;
    /**
     * Write-once per brief: fails with `already-accepted` while a live row exists, unless the
     * caller asks to retire it in the same transaction.
     */
    readonly insertAcceptance: (
      acceptance: FactoryKnowledgeAcceptance,
      options?: { readonly supersede?: boolean },
    ) => Effect.Effect<FactoryKnowledgeAcceptance, FactoryKnowledgeError>;
  }
>()("t3/persistence/FactoryKnowledgeStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const briefColumns = sql.literal("brief_json AS brief, superseded_by AS supersededBy");
  // The column, not the stored JSON, says whether a brief was replaced: the JSON is frozen at
  // creation.
  const withSuperseded = (rows: typeof BriefRows.Type) =>
    rows.map((row) => ({ ...row.brief, supersededBy: row.supersededBy }));
  const getBrief = Effect.fn("FactoryKnowledgeStore.getBrief")(function* (briefId: string) {
    const rows = withSuperseded(
      yield* decodeBriefs(
        yield* sql`SELECT ${briefColumns} FROM factory_knowledge_briefs WHERE id = ${briefId}`,
      ),
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const getBriefByCommand = Effect.fn("FactoryKnowledgeStore.getBriefByCommand")(function* (
    commandId: CommandId,
  ) {
    const rows = withSuperseded(
      yield* decodeBriefs(
        yield* sql`SELECT ${briefColumns} FROM factory_knowledge_briefs
          WHERE request_command_id = ${commandId}`,
      ),
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const listBriefs = Effect.fn("FactoryKnowledgeStore.listBriefs")(function* (
    projectId: ProjectId,
  ) {
    return withSuperseded(
      yield* decodeBriefs(
        yield* sql`SELECT ${briefColumns} FROM factory_knowledge_briefs
          WHERE project_id = ${projectId} ORDER BY created_at, rowid`,
      ),
    );
  }, Effect.mapError(persistenceError));
  const createBrief = Effect.fn("FactoryKnowledgeStore.createBrief")(function* (
    brief: FactoryKnowledgeBrief,
    options: { readonly requestCommandId: CommandId; readonly supersedes: string | null },
  ) {
    const json = yield* encodeBrief({ ...brief, supersededBy: null });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const replay = yield* getBriefByCommand(options.requestCommandId);
        if (Option.isSome(replay)) {
          if (replay.value.projectId !== brief.projectId)
            return yield* new FactoryKnowledgeError({ reason: "unknown-brief" });
          return replay.value;
        }
        if (options.supersedes !== null) {
          const older = yield* getBrief(options.supersedes);
          if (
            Option.isNone(older) ||
            older.value.projectId !== brief.projectId ||
            older.value.supersededBy !== null
          )
            return yield* new FactoryKnowledgeError({ reason: "unknown-brief" });
          yield* sql`UPDATE factory_knowledge_briefs SET superseded_by = ${brief.id}
            WHERE id = ${options.supersedes} AND superseded_by IS NULL`;
        }
        yield* sql`INSERT INTO factory_knowledge_briefs
          (id, project_id, revision, brief_json, request_command_id, created_at, created_by)
          VALUES (${brief.id}, ${brief.projectId}, ${brief.revision}, ${json},
            ${options.requestCommandId}, ${brief.createdAt}, ${brief.createdBy})`;
        const stored = yield* getBrief(brief.id);
        if (Option.isNone(stored))
          return yield* new FactoryKnowledgeError({ reason: "persistence-failure" });
        return stored.value;
      }),
    );
  }, Effect.mapError(persistenceError));

  const findLaunch = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Binding,
    execute: (briefId) => sql`
      SELECT intent_json AS intent, accepted FROM factory_knowledge_launches
      WHERE origin_key = ${knowledgeBriefOriginKey(briefId)} AND superseded = 0
    `,
  });
  const getLaunch = Effect.fn("FactoryKnowledgeStore.getLaunch")(
    (briefId: string) => findLaunch(briefId),
    Effect.mapError(persistenceError),
  );
  const listLaunches = Effect.fn("FactoryKnowledgeStore.listLaunches")(function* (
    projectId: ProjectId,
  ) {
    return yield* decodeBindings(
      yield* sql`SELECT launches.intent_json AS intent, launches.accepted AS accepted
        FROM factory_knowledge_launches AS launches
        JOIN factory_knowledge_briefs AS briefs ON briefs.id = launches.brief_id
        WHERE briefs.project_id = ${projectId} AND launches.superseded = 0
        ORDER BY briefs.created_at, briefs.rowid`,
    );
  }, Effect.mapError(persistenceError));
  const reserve = Effect.fn("FactoryKnowledgeStore.reserve")(function* (
    intent: FactoryKnowledgeLaunchIntent,
  ) {
    const json = yield* encodeIntent(intent);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* findLaunch(intent.briefId);
        if (Option.isSome(current)) {
          if (current.value.intent.threadId !== intent.previousThreadId) return current.value;
          // A replay of an earlier restart must not authorize yet another attempt.
          const used = yield* sql`SELECT thread_id FROM factory_knowledge_launches
            WHERE request_command_id = ${intent.requestCommandId}`;
          if (used.length > 0) return current.value;
          yield* sql`UPDATE factory_knowledge_launches SET superseded = 1
            WHERE thread_id = ${intent.previousThreadId} AND superseded = 0`;
        } else if (intent.previousThreadId !== null) {
          return yield* new FactoryKnowledgeError({ reason: "persistence-failure" });
        }
        yield* sql`INSERT INTO factory_knowledge_launches
          (thread_id, brief_id, request_command_id, intent_json, origin_key)
          VALUES (${intent.threadId}, ${intent.briefId}, ${intent.requestCommandId}, ${json},
            ${knowledgeBriefOriginKey(intent.briefId)})
          ON CONFLICT DO NOTHING`;
        const winner = yield* findLaunch(intent.briefId);
        if (Option.isNone(winner))
          return yield* new FactoryKnowledgeError({ reason: "persistence-failure" });
        return winner.value;
      }),
    );
  }, Effect.mapError(persistenceError));
  const accept = Effect.fn("FactoryKnowledgeStore.accept")(
    (threadId: ThreadId) =>
      sql`UPDATE factory_knowledge_launches SET accepted = 1 WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
      ),
    Effect.mapError(persistenceError),
  );

  const acceptanceColumns = sql.literal(`id, brief_id AS briefId, thread_id AS threadId,
    project_id AS projectId, artifact_path AS artifactPath, sha256, bytes,
    accepted_at AS acceptedAt, accepted_by AS acceptedBy`);
  const getAcceptance = Effect.fn("FactoryKnowledgeStore.getAcceptance")(function* (
    briefId: string,
  ) {
    const rows = yield* decodeAcceptances(
      yield* sql`SELECT ${acceptanceColumns} FROM factory_knowledge_acceptances
        WHERE brief_id = ${briefId} AND superseded = 0`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const insertAcceptance = Effect.fn("FactoryKnowledgeStore.insertAcceptance")(function* (
    acceptance: FactoryKnowledgeAcceptance,
    options?: { readonly supersede?: boolean },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (Option.isSome(yield* getAcceptance(acceptance.briefId))) {
          if (options?.supersede !== true)
            return yield* new FactoryKnowledgeError({ reason: "already-accepted" });
          yield* sql`UPDATE factory_knowledge_acceptances SET superseded = 1
            WHERE brief_id = ${acceptance.briefId} AND superseded = 0`;
        }
        // The partial unique index is the arbiter when another writer wins between the read and
        // this insert; the loser reads the winner back and is refused.
        yield* sql`INSERT INTO factory_knowledge_acceptances
          (id, brief_id, thread_id, project_id, artifact_path, sha256, bytes, accepted_at, accepted_by)
          VALUES (${acceptance.id}, ${acceptance.briefId}, ${acceptance.threadId}, ${acceptance.projectId},
            ${acceptance.artifactPath}, ${acceptance.sha256}, ${acceptance.bytes},
            ${acceptance.acceptedAt}, ${acceptance.acceptedBy})
          ON CONFLICT DO NOTHING`;
        const stored = yield* getAcceptance(acceptance.briefId);
        if (Option.isNone(stored) || stored.value.id !== acceptance.id)
          return yield* new FactoryKnowledgeError({ reason: "already-accepted" });
        return stored.value;
      }),
    );
  }, Effect.mapError(persistenceError));
  return FactoryKnowledgeStore.of({
    createBrief,
    listBriefs,
    getBrief,
    getLaunch,
    listLaunches,
    reserve,
    accept,
    getAcceptance,
    insertAcceptance,
  });
});
export const layer = Layer.effect(FactoryKnowledgeStore, make);
