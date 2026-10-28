import {
  FactoryIssueError,
  FactoryOriginKey,
  type FactoryClaim,
  type FactoryClaimListInput,
  type FactoryClaimListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { FactoryFeedLaunchIntent } from "../persistence/FactoryFeedStore.ts";
import { FactoryLaunchIntent } from "../persistence/FactoryIssueLaunches.ts";
import { FactoryResearchLaunchIntent } from "../persistence/FactoryResearchStore.ts";
import {
  feedItemOriginKey,
  githubIssueOriginKey,
  researchRunOriginKey,
} from "./FactoryOriginKey.ts";
import * as TaskLaunch from "./FactoryTaskLaunch.ts";

const columns = {
  originKey: Schema.NullOr(FactoryOriginKey),
  accepted: Schema.Literals([0, 1]),
  originConflict: Schema.Literals([0, 1]),
  acceptedHeadSha: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Schema.String),
};
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Union([
      Schema.Struct({
        ...columns,
        origin: Schema.Literal("github-issue"),
        intent: Schema.fromJsonString(FactoryLaunchIntent),
      }),
      Schema.Struct({
        ...columns,
        origin: Schema.Literal("feed-item"),
        intent: Schema.fromJsonString(FactoryFeedLaunchIntent),
      }),
      Schema.Struct({
        ...columns,
        origin: Schema.Literal("research-run"),
        intent: Schema.fromJsonString(FactoryResearchLaunchIntent),
      }),
    ]),
  ),
);

export class FactoryClaimsService extends Context.Service<
  FactoryClaimsService,
  {
    readonly list: (
      input: FactoryClaimListInput,
    ) => Effect.Effect<FactoryClaimListResult, FactoryIssueError>;
  }
>()("t3/factory/FactoryClaimsService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* ServerEnvironmentIdentity;
  const resolve = yield* TaskLaunch.makeRepositoryResolver;
  const inspect = yield* TaskLaunch.makeInspector({
    span: "FactoryClaimsService",
    error: (reason, cause) =>
      new FactoryIssueError({ reason, ...(cause === undefined ? {} : { cause }) }),
  });
  // A thread has at most one live acceptance (unique per origin), so a subquery cannot fan rows out.
  const acceptance = (table: string) =>
    sql.literal(`(SELECT head_sha FROM factory_acceptances WHERE thread_id = ${table}.thread_id AND superseded = 0) AS acceptedHeadSha,
      (SELECT accepted_at FROM factory_acceptances WHERE thread_id = ${table}.thread_id AND superseded = 0) AS acceptedAt`);
  const list = Effect.fn("FactoryClaimsService.list")(function* (input: FactoryClaimListInput) {
    const { repository } = yield* resolve(input.projectId);
    const rows = yield* sql`
      SELECT 'github-issue' AS origin, origin_key AS originKey, intent_json AS intent, accepted, 0 AS originConflict, ${acceptance("factory_issue_launches")}
      FROM factory_issue_launches WHERE superseded = 0
        AND json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.repository.canonicalKey') = ${repository.canonicalKey}
      UNION ALL
      SELECT 'feed-item', origin_key, intent_json, accepted, origin_conflict, ${acceptance("factory_feed_launches")}
      FROM factory_feed_launches WHERE superseded = 0
        AND json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.repository.canonicalKey') = ${repository.canonicalKey}
      UNION ALL
      SELECT 'research-run', origin_key, intent_json, accepted, 0, ${acceptance("factory_research_launches")}
      FROM factory_research_launches WHERE superseded = 0
        AND json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.protocol.repository.canonicalKey') = ${repository.canonicalKey}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError((cause) => new FactoryIssueError({ reason: "persistence-failure", cause })),
    );
    const claims = yield* Effect.forEach(
      rows,
      Effect.fn("FactoryClaimsService.present")(function* (row): Effect.fn.Return<
        FactoryClaim,
        FactoryIssueError
      > {
        const { intent } = row;
        const originKey =
          row.originKey ??
          (row.origin === "github-issue"
            ? githubIssueOriginKey(row.intent.repository.canonicalKey, row.intent.issue.number)
            : row.origin === "feed-item"
              ? feedItemOriginKey(
                  row.intent.repository.canonicalKey,
                  row.intent.snapshot.feed,
                  row.intent.itemKey,
                )
              : researchRunOriginKey(row.intent.protocolId, row.intent.role));
        const { task } = yield* inspect(row);
        return {
          originKey,
          origin: row.origin,
          projectId: intent.projectId,
          workspaceRoot: intent.workspaceRoot,
          threadId: intent.threadId,
          status: task.status,
          baseRef: intent.baseRef,
          createdAt: intent.createdAt,
          creationSource: intent.creationSource,
          admittedBy: intent.admittedBy ?? null,
          originConflict: row.originConflict === 1,
          acceptance:
            row.acceptedHeadSha === null || row.acceptedAt === null
              ? null
              : { headSha: row.acceptedHeadSha, acceptedAt: row.acceptedAt },
        };
      }),
    );
    claims.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.threadId.localeCompare(b.threadId),
    );
    return {
      environmentId: yield* environment.getEnvironmentId,
      repository,
      claims,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  return FactoryClaimsService.of({ list });
});
export const layer = Layer.effect(FactoryClaimsService, make);
