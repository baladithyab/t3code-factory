import {
  FactoryClaim,
  FactoryIssueError,
  FactoryOriginKey,
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
import { FactoryKnowledgeLaunchIntent } from "../persistence/FactoryKnowledgeStore.ts";
import { FactoryResearchLaunchIntent } from "../persistence/FactoryResearchStore.ts";
import {
  feedItemOriginKey,
  issueOriginKey,
  knowledgeBriefOriginKey,
  researchRunOriginKey,
} from "./FactoryOriginKey.ts";
import * as TaskLaunch from "./FactoryTaskLaunch.ts";

const columns = {
  originKey: Schema.NullOr(FactoryOriginKey),
  accepted: Schema.Literals([0, 1]),
  originConflict: Schema.Literals([0, 1]),
  acceptedHeadSha: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Schema.String),
  artifactSha256: Schema.NullOr(Schema.String),
  artifactAcceptedAt: Schema.NullOr(Schema.String),
};
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Union([
      Schema.Struct({
        ...columns,
        origin: Schema.Literal("issue"),
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
      Schema.Struct({
        ...columns,
        origin: Schema.Literal("knowledge-brief"),
        intent: Schema.fromJsonString(FactoryKnowledgeLaunchIntent),
      }),
    ]),
  ),
);
const isClaimOrigin = Schema.is(FactoryClaim.fields.origin);

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
  const inspectKnowledge = yield* TaskLaunch.makeStatusInspector({
    error: (reason, cause) =>
      new FactoryIssueError({ reason, ...(cause === undefined ? {} : { cause }) }),
  });
  const inspect = yield* TaskLaunch.makeInspector({
    span: "FactoryClaimsService",
    error: (reason, cause) =>
      new FactoryIssueError({ reason, ...(cause === undefined ? {} : { cause }) }),
  });
  // A thread has at most one live acceptance (unique per origin), so a subquery cannot fan rows out.
  // The artifact columns exist only for knowledge rows; the UNION needs every branch to carry them.
  const acceptance = (table: string) =>
    sql.literal(`(SELECT head_sha FROM factory_acceptances WHERE thread_id = ${table}.thread_id AND superseded = 0) AS acceptedHeadSha,
      (SELECT accepted_at FROM factory_acceptances WHERE thread_id = ${table}.thread_id AND superseded = 0) AS acceptedAt,
      NULL AS artifactSha256, NULL AS artifactAcceptedAt`);
  const artifactAcceptance = sql.literal(`NULL AS acceptedHeadSha, NULL AS acceptedAt,
      (SELECT sha256 FROM factory_knowledge_acceptances WHERE brief_id = factory_knowledge_launches.brief_id AND superseded = 0) AS artifactSha256,
      (SELECT accepted_at FROM factory_knowledge_acceptances WHERE brief_id = factory_knowledge_launches.brief_id AND superseded = 0) AS artifactAcceptedAt`);
  const list = Effect.fn("FactoryClaimsService.list")(function* (input: FactoryClaimListInput) {
    const { repository } = yield* resolve(input.projectId);
    const rows = yield* sql`
      SELECT 'issue' AS origin, origin_key AS originKey, intent_json AS intent, accepted, 0 AS originConflict, ${acceptance("factory_issue_launches")}
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
      UNION ALL
      SELECT 'knowledge-brief', origin_key, intent_json, accepted, 0, ${artifactAcceptance}
      FROM factory_knowledge_launches WHERE superseded = 0
        AND json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.projectId') = ${input.projectId}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError((cause) => new FactoryIssueError({ reason: "persistence-failure", cause })),
    );
    const presented = yield* Effect.forEach(
      rows,
      Effect.fn("FactoryClaimsService.present")(function* (row): Effect.fn.Return<
        FactoryClaim | null,
        FactoryIssueError
      > {
        const { intent } = row;
        // An issue claim's origin is the provider frozen into its intent at admission.
        const origin =
          row.origin === "issue" ? `${row.intent.repository.provider}-issue` : row.origin;
        if (!isClaimOrigin(origin)) {
          // A host the contract has no origin for is left out rather than mislabelled, and one
          // such row does not fail the list.
          yield* Effect.logWarning("factory claim skipped: no claim origin for its issue host", {
            threadId: intent.threadId,
            origin,
          });
          return null;
        }
        const originKey =
          row.originKey ??
          (row.origin === "issue"
            ? issueOriginKey(
                row.intent.repository.provider,
                row.intent.repository.canonicalKey,
                row.intent.issue.number,
              )
            : row.origin === "feed-item"
              ? feedItemOriginKey(
                  row.intent.repository.canonicalKey,
                  row.intent.snapshot.feed,
                  row.intent.itemKey,
                )
              : row.origin === "research-run"
                ? researchRunOriginKey(row.intent.protocolId, row.intent.role)
                : knowledgeBriefOriginKey(row.intent.briefId));
        const status =
          row.origin === "knowledge-brief"
            ? (yield* inspectKnowledge(row)).status
            : (yield* inspect(row)).task.status;
        return {
          originKey,
          origin,
          projectId: intent.projectId,
          workspaceRoot: intent.workspaceRoot,
          threadId: intent.threadId,
          status,
          baseRef: row.origin === "knowledge-brief" ? null : row.intent.baseRef,
          createdAt: intent.createdAt,
          creationSource: intent.creationSource,
          admittedBy: intent.admittedBy ?? null,
          originConflict: row.originConflict === 1,
          acceptance:
            row.acceptedHeadSha === null || row.acceptedAt === null
              ? null
              : { headSha: row.acceptedHeadSha, acceptedAt: row.acceptedAt },
          artifactAcceptance:
            row.artifactSha256 === null || row.artifactAcceptedAt === null
              ? null
              : { sha256: row.artifactSha256, acceptedAt: row.artifactAcceptedAt },
        };
      }),
    );
    const claims = presented.filter((claim) => claim !== null);
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
