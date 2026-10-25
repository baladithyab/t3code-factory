import {
  FactoryIssue,
  FactoryIssueError,
  FactoryRepository,
  PositiveInt,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { FactoryLaunchCore } from "../factory/FactoryTaskLaunch.ts";

export const FactoryLaunchIntent = Schema.Struct({
  repository: FactoryRepository,
  // Frozen durable snapshot. Rows written before content revisions decode unchanged, and new rows
  // keep the shape older binaries read. A revision belongs to live read/list results, never here.
  issue: Schema.Struct({
    number: FactoryIssue.fields.number,
    title: FactoryIssue.fields.title,
    body: FactoryIssue.fields.body,
    state: FactoryIssue.fields.state,
    url: FactoryIssue.fields.url,
    labels: FactoryIssue.fields.labels,
    updatedAt: FactoryIssue.fields.updatedAt,
    // Always null here; retained because older binaries require the key.
    task: FactoryIssue.fields.task,
  }),
  ...FactoryLaunchCore.fields,
});
export type FactoryLaunchIntent = typeof FactoryLaunchIntent.Type;

const Binding = Schema.Struct({
  intent: Schema.fromJsonString(FactoryLaunchIntent),
  accepted: Schema.Literals([0, 1]),
});
export type FactoryIssueBinding = typeof Binding.Type;
const Key = Schema.Struct({ canonicalKey: Schema.String, issueNumber: PositiveInt });
type Key = typeof Key.Type;

export class FactoryIssueLaunches extends Context.Service<
  FactoryIssueLaunches,
  {
    readonly get: (
      key: Key,
    ) => Effect.Effect<Option.Option<FactoryIssueBinding>, FactoryIssueError>;
    readonly reserve: (
      intent: FactoryLaunchIntent,
    ) => Effect.Effect<FactoryIssueBinding, FactoryIssueError>;
    readonly accept: (threadId: ThreadId) => Effect.Effect<void, FactoryIssueError>;
  }
>()("t3/persistence/FactoryIssueLaunches") {}

const isFactoryIssueError = Schema.is(FactoryIssueError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const find = SqlSchema.findOneOption({
    Request: Key,
    Result: Binding,
    execute: ({ canonicalKey, issueNumber }) => sql`
      SELECT intent_json AS intent, accepted FROM factory_issue_launches
      WHERE canonical_key = ${canonicalKey} AND issue_number = ${issueNumber} AND superseded = 0
    `,
  });
  const encode = Schema.encodeEffect(Schema.fromJsonString(FactoryLaunchIntent));
  const persistenceError = (cause: unknown) =>
    isFactoryIssueError(cause)
      ? cause
      : new FactoryIssueError({ reason: "persistence-failure", cause });
  const get = Effect.fn("FactoryIssueLaunches.get")((key: Key) =>
    find(key).pipe(Effect.mapError(persistenceError)),
  );
  const reserve = Effect.fn("FactoryIssueLaunches.reserve")(function* (
    intent: FactoryLaunchIntent,
  ) {
    const json = yield* encode(intent).pipe(Effect.mapError(persistenceError));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const key = {
            canonicalKey: intent.repository.canonicalKey,
            issueNumber: intent.issue.number,
          };
          const current = yield* find(key);
          if (Option.isSome(current)) {
            if (current.value.intent.threadId !== intent.previousThreadId) return current.value;
            // A replay of an earlier restart must not authorize yet another attempt.
            const used = yield* sql`SELECT thread_id FROM factory_issue_launches
          WHERE request_command_id = ${intent.requestCommandId}`;
            if (used.length > 0) return current.value;
            yield* sql`UPDATE factory_issue_launches SET superseded = 1
          WHERE thread_id = ${intent.previousThreadId} AND superseded = 0`;
          } else if (intent.previousThreadId !== null) {
            return yield* new FactoryIssueError({ reason: "persistence-failure" });
          }
          yield* sql`INSERT INTO factory_issue_launches
        (thread_id, canonical_key, issue_number, request_command_id, intent_json)
        VALUES (${intent.threadId}, ${key.canonicalKey}, ${key.issueNumber}, ${intent.requestCommandId}, ${json})
        ON CONFLICT DO NOTHING`;
          const winner = yield* find(key);
          if (Option.isNone(winner))
            return yield* new FactoryIssueError({ reason: "persistence-failure" });
          return winner.value;
        }),
      )
      .pipe(Effect.mapError(persistenceError));
  });
  const accept = Effect.fn("FactoryIssueLaunches.accept")((threadId: ThreadId) =>
    sql`UPDATE factory_issue_launches SET accepted = 1 WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(persistenceError),
    ),
  );
  return FactoryIssueLaunches.of({ get, reserve, accept });
});
export const layer = Layer.effect(FactoryIssueLaunches, make);
