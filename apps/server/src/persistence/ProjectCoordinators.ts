import {
  CommandId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  ProjectCoordinatorError,
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

export const ProjectCoordinatorIntent = Schema.Struct({
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
  previousThreadId: Schema.NullOr(ThreadId),
});
export type ProjectCoordinatorIntent = typeof ProjectCoordinatorIntent.Type;

const Binding = Schema.Struct({
  intent: Schema.fromJsonString(ProjectCoordinatorIntent),
  accepted: Schema.Literals([0, 1]),
  superseded: Schema.Literals([0, 1]),
});
export type ProjectCoordinatorBinding = typeof Binding.Type;

export class ProjectCoordinators extends Context.Service<
  ProjectCoordinators,
  {
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<ProjectCoordinatorBinding>, ProjectCoordinatorError>;
    readonly getByRequest: (
      commandId: CommandId,
    ) => Effect.Effect<Option.Option<ProjectCoordinatorBinding>, ProjectCoordinatorError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProjectCoordinatorBinding>,
      ProjectCoordinatorError
    >;
    readonly reserve: (
      intent: ProjectCoordinatorIntent,
    ) => Effect.Effect<ProjectCoordinatorBinding, ProjectCoordinatorError>;
    readonly accept: (threadId: ThreadId) => Effect.Effect<void, ProjectCoordinatorError>;
  }
>()("t3/persistence/ProjectCoordinators") {}

const isProjectCoordinatorError = Schema.is(ProjectCoordinatorError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const findCurrent = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: Binding,
    execute: (projectId) => sql`
      SELECT intent_json AS intent, accepted, superseded FROM project_coordinators
      WHERE project_id = ${projectId} AND superseded = 0
    `,
  });
  const findRequest = SqlSchema.findOneOption({
    Request: CommandId,
    Result: Binding,
    execute: (commandId) => sql`
      SELECT intent_json AS intent, accepted, superseded FROM project_coordinators
      WHERE request_command_id = ${commandId}
    `,
  });
  const findAllCurrent = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Binding,
    execute: () => sql`
      SELECT intent_json AS intent, accepted, superseded FROM project_coordinators
      WHERE superseded = 0 ORDER BY project_id
    `,
  });
  const encode = Schema.encodeEffect(Schema.fromJsonString(ProjectCoordinatorIntent));
  const persistenceError = (cause: unknown) =>
    isProjectCoordinatorError(cause)
      ? cause
      : new ProjectCoordinatorError({ reason: "persistence-failure", cause });
  const get = Effect.fn("ProjectCoordinators.get")((projectId: ProjectId) =>
    findCurrent(projectId).pipe(Effect.mapError(persistenceError)),
  );
  const getByRequest = Effect.fn("ProjectCoordinators.getByRequest")((commandId: CommandId) =>
    findRequest(commandId).pipe(Effect.mapError(persistenceError)),
  );
  const list = Effect.fn("ProjectCoordinators.list")(() =>
    findAllCurrent(undefined).pipe(Effect.mapError(persistenceError)),
  );
  const reserve = Effect.fn("ProjectCoordinators.reserve")((intent: ProjectCoordinatorIntent) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Request identity precedes the current binding, including after replacement or deletion.
          const replay = yield* findRequest(intent.requestCommandId);
          if (Option.isSome(replay)) {
            if (replay.value.intent.projectId !== intent.projectId) {
              return yield* new ProjectCoordinatorError({ reason: "command-conflict" });
            }
            return replay.value;
          }
          const current = yield* findCurrent(intent.projectId);
          if (Option.isSome(current)) {
            if (current.value.intent.threadId !== intent.previousThreadId) return current.value;
          } else if (intent.previousThreadId !== null) {
            return yield* new ProjectCoordinatorError({ reason: "binding-changed" });
          }
          const json = yield* encode(intent);
          if (Option.isSome(current)) {
            yield* sql`
            UPDATE project_coordinators SET superseded = 1
            WHERE thread_id = ${current.value.intent.threadId} AND superseded = 0
          `;
          }
          // A constraint failure must roll back superseding, never silently lose the current row.
          yield* sql`
          INSERT INTO project_coordinators
            (thread_id, project_id, request_command_id, intent_json)
          VALUES (${intent.threadId}, ${intent.projectId}, ${intent.requestCommandId}, ${json})
        `;
          const winner = yield* findCurrent(intent.projectId);
          if (Option.isNone(winner)) {
            return yield* new ProjectCoordinatorError({ reason: "persistence-failure" });
          }
          return winner.value;
        }),
      )
      .pipe(Effect.mapError(persistenceError)),
  );
  const accept = Effect.fn("ProjectCoordinators.accept")((threadId: ThreadId) =>
    sql`UPDATE project_coordinators SET accepted = 1 WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(persistenceError),
    ),
  );
  return ProjectCoordinators.of({ get, getByRequest, list, reserve, accept });
});

export const layer = Layer.effect(ProjectCoordinators, make);
