import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryRepository } from "./factory.ts";

/** Observations older than this are shown as stale; clients age `observedAt` against it. */
export const FACTORY_READINESS_TTL_MS = 10 * 60 * 1000;

/**
 * How one direct blocker resolves. `accepted` is the tracker's own terminal-success signal
 * (closed with `state_reason: completed`, or a merged pull request); Factory keeps no
 * acceptance ledger of its own. Closed for any other reason never counts as accepted.
 */
export const FactoryReadinessEdgeResolution = Schema.Literals([
  "accepted",
  "open",
  "closed-unaccepted",
  "deleted",
  "inaccessible",
  "moved",
  "unverified",
]);
export type FactoryReadinessEdgeResolution = typeof FactoryReadinessEdgeResolution.Type;

export const FactoryReadinessEdge = Schema.Struct({
  // GitHub's database id. Numbers are repository-local and reusable, so the id is the identity
  // and the repository/number pair is only a locator.
  targetId: PositiveInt,
  targetHost: TrimmedNonEmptyString,
  targetRepository: TrimmedNonEmptyString,
  targetNumber: PositiveInt,
  targetUrl: Schema.String,
  title: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.Literals(["open", "closed"])),
  stateReason: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(IsoDateTime),
  resolution: FactoryReadinessEdgeResolution,
  // `present` edges came from the latest complete listing; the rest are tombstones resolved by a
  // direct read of the former blocker. Rows are never deleted.
  status: Schema.Literals([
    "present",
    "removed-at-source",
    "deleted",
    "inaccessible",
    "moved",
    "unverified",
  ]),
  firstObservedAt: IsoDateTime,
  lastObservedAt: IsoDateTime,
});
export type FactoryReadinessEdge = typeof FactoryReadinessEdge.Type;

export const FactoryReadinessStatus = Schema.Literals([
  "ready",
  "blocked",
  "unknown",
  "not-applicable",
]);
export type FactoryReadinessStatus = typeof FactoryReadinessStatus.Type;

export const FactoryReadinessReason = Schema.Literals([
  "closed-subject",
  "open-blocker",
  "unaccepted-blocker",
  "deleted-blocker",
  "inaccessible-blocker",
  "moved-blocker",
  "unverified-blocker",
  "partial-listing",
  "summary-missing",
  "truncated-response",
  "invalid-response",
  "authentication",
  "rate-limited",
  "remote-failure",
  "cycle",
]);
export type FactoryReadinessReason = typeof FactoryReadinessReason.Type;

/**
 * Derived on every read from observed evidence; never stored and never an input to starting
 * work. Blocked outranks unknown, which outranks ready.
 */
export const FactoryReadiness = Schema.Struct({
  status: FactoryReadinessStatus,
  reasons: Schema.Array(FactoryReadinessReason),
  edges: Schema.Array(FactoryReadinessEdge),
  // True only when every page was read, nothing was truncated, every item decoded, and the
  // listed count equals the tracker's `total_blocked_by`.
  complete: Schema.Boolean,
  listedCount: NonNegativeInt,
  summaryTotal: Schema.NullOr(NonNegativeInt),
  observedAt: IsoDateTime,
});
export type FactoryReadiness = typeof FactoryReadiness.Type;

export const FactoryIssueReadinessReadInput = Schema.Struct({
  projectId: ProjectId,
  issueNumber: PositiveInt,
});
export type FactoryIssueReadinessReadInput = typeof FactoryIssueReadinessReadInput.Type;
export const FactoryIssueReadinessReadResult = Schema.Struct({
  repository: FactoryRepository,
  issueNumber: PositiveInt,
  readiness: FactoryReadiness,
});
export type FactoryIssueReadinessReadResult = typeof FactoryIssueReadinessReadResult.Type;
