import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryRepository } from "./factory.ts";

export const FactoryReadinessOverrideId = Schema.String.pipe(
  Schema.brand("FactoryReadinessOverrideId"),
);
export type FactoryReadinessOverrideId = typeof FactoryReadinessOverrideId.Type;
export const FACTORY_READINESS_OVERRIDE_REASON_MAX_CHARS = 1024;

/**
 * A human's visible, revocable decision about one edge. `force-not-ready` disputes a blocker the
 * tracker reports as accepted. `waive` retires a tombstone (deleted, inaccessible, moved or
 * unverified blocker) that nothing in the tracker can fix; it never applies to a blocker that is
 * open or closed without acceptance, which the tracker must resolve. An override binds to the
 * resolution the person saw and lapses when that resolution changes.
 */
export const FactoryReadinessOverrideKind = Schema.Literals(["force-not-ready", "waive"]);
export type FactoryReadinessOverrideKind = typeof FactoryReadinessOverrideKind.Type;

export const FactoryReadinessOverride = Schema.Struct({
  id: FactoryReadinessOverrideId,
  kind: FactoryReadinessOverrideKind,
  targetHost: TrimmedNonEmptyString,
  targetId: PositiveInt,
  // Opaque digest of the edge resolution the reviewer saw. Compare it; never parse it.
  boundFingerprint: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
  // Derived on read: `lapsed` when the current fingerprint no longer matches.
  status: Schema.Literals(["active", "lapsed", "revoked"]),
});
export type FactoryReadinessOverride = typeof FactoryReadinessOverride.Type;

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
  // Opaque digest of this edge's observed resolution; an override binds to it.
  fingerprint: TrimmedNonEmptyString,
  // The active override applied to this edge, if any. Lapsed and revoked overrides are listed
  // on the readiness result but never applied.
  override: Schema.NullOr(FactoryReadinessOverrideId),
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
  "overridden-not-ready",
]);
export type FactoryReadinessReason = typeof FactoryReadinessReason.Type;

/**
 * Derived on every read from observed evidence; never stored and never an input to starting
 * work. Blocked outranks unknown, which outranks ready.
 */
export const FactoryReadiness = Schema.Struct({
  status: FactoryReadinessStatus,
  reasons: Schema.Array(FactoryReadinessReason),
  // `override` when a `ready` verdict depends on at least one active waiver.
  basis: Schema.NullOr(Schema.Literals(["source", "override"])),
  edges: Schema.Array(FactoryReadinessEdge),
  overrides: Schema.Array(FactoryReadinessOverride),
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

export const FactoryReadinessOverrideSetInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  issueNumber: PositiveInt,
  targetHost: TrimmedNonEmptyString,
  targetId: PositiveInt,
  // The fingerprint the reviewer saw; a changed resolution refuses the override.
  expectedFingerprint: FactoryReadinessEdge.fields.fingerprint,
  kind: FactoryReadinessOverrideKind,
  reason: TrimmedNonEmptyString.check(
    Schema.isMaxLength(FACTORY_READINESS_OVERRIDE_REASON_MAX_CHARS),
  ),
});
export type FactoryReadinessOverrideSetInput = typeof FactoryReadinessOverrideSetInput.Type;
export const FactoryReadinessOverrideRevokeInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  issueNumber: PositiveInt,
  overrideId: FactoryReadinessOverrideId,
});
export type FactoryReadinessOverrideRevokeInput = typeof FactoryReadinessOverrideRevokeInput.Type;

/** One child of a parent issue, in the tracker's recorded order. */
export const FactoryFrontierChild = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  url: Schema.String,
  // Shown so a person can see what is claimed; never a readiness input.
  assignees: Schema.Array(Schema.String),
  // Null only for closed children; failed observations produce unknown readiness.
  readiness: Schema.NullOr(FactoryReadiness),
});
export type FactoryFrontierChild = typeof FactoryFrontierChild.Type;

export const FactoryIssueFrontierReadInput = Schema.Struct({
  projectId: ProjectId,
  parentIssueNumber: PositiveInt,
});
export type FactoryIssueFrontierReadInput = typeof FactoryIssueFrontierReadInput.Type;
/**
 * A read-only composition of per-child verdicts in source order. It is a planning view: there
 * is no next-ready pointer, no batch start and no ordering authority.
 */
export const FactoryIssueFrontierReadResult = Schema.Struct({
  repository: FactoryRepository,
  parentIssueNumber: PositiveInt,
  parentTitle: Schema.String,
  // True only when every sub-issue page was read and the count equals `sub_issues_summary.total`.
  complete: Schema.Boolean,
  summaryTotal: Schema.NullOr(NonNegativeInt),
  children: Schema.Array(FactoryFrontierChild),
  observedAt: IsoDateTime,
});
export type FactoryIssueFrontierReadResult = typeof FactoryIssueFrontierReadResult.Type;
