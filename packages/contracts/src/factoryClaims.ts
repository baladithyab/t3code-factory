import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryIssueTask, FactoryRepository } from "./factory.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";

/**
 * A comparable identity for an admitted origin across environments:
 * `github:<canonicalKey>#<n>`, `feed:<canonicalKey>|<locator>|<itemKey>`,
 * `research:<protocolId>:<role>`. Same key in two environments with different threads is
 * duplicate execution; with the same thread it is a copied database.
 */
export const FactoryOriginKey = Schema.String.pipe(Schema.brand("FactoryOriginKey"));
export type FactoryOriginKey = typeof FactoryOriginKey.Type;

export const FactoryClaim = Schema.Struct({
  originKey: FactoryOriginKey,
  origin: Schema.Literals(["github-issue", "feed-item", "research-run"]),
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  threadId: ThreadId,
  status: FactoryIssueTask.fields.status,
  baseRef: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  creationSource: OrchestrationV2CreationSource,
  // Provenance only: the environment whose guard chain wrote the row. Ownership is always the
  // answering environment; rows written before provenance was recorded carry null.
  admittedBy: Schema.NullOr(EnvironmentId),
  // A legacy duplicate group member (feed claims keyed before origin keys existed). Never merged;
  // further admissions against the group are refused.
  originConflict: Schema.Boolean,
});
export type FactoryClaim = typeof FactoryClaim.Type;

export const FactoryClaimListInput = Schema.Struct({ projectId: ProjectId });
export type FactoryClaimListInput = typeof FactoryClaimListInput.Type;
export const FactoryClaimListResult = Schema.Struct({
  environmentId: EnvironmentId,
  repository: FactoryRepository,
  claims: Schema.Array(FactoryClaim),
  fetchedAt: IsoDateTime,
});
export type FactoryClaimListResult = typeof FactoryClaimListResult.Type;
