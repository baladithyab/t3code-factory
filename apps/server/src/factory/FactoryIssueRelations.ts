import {
  FactoryIssueError,
  FactoryReadinessReason,
  FactoryReadinessOverrideId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  type FactoryIssueFrontierReadInput,
  type FactoryIssueFrontierReadResult,
  type FactoryFrontierChild,
  type FactoryIssueReadinessReadInput,
  type FactoryIssueReadinessReadResult,
  type FactoryReadiness,
  type FactoryReadinessEdge,
  type FactoryReadinessOverride,
  type FactoryReadinessOverrideSetInput,
  type FactoryReadinessOverrideRevokeInput,
  type FactoryRepository,
} from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import {
  gitHubApiUrls,
  isRateLimited,
  type GitHubApiError,
} from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Store from "../persistence/FactoryIssueRelationStore.ts";
import { makeRepositoryResolver } from "./FactoryTaskLaunch.ts";

const Subject = Schema.Struct({
  id: PositiveInt,
  state: Schema.Literals(["open", "closed"]),
  pull_request: Schema.optional(Schema.Unknown),
  issue_dependencies_summary: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        total_blocked_by: Schema.optional(NonNegativeInt),
      }),
    ),
  ),
});
const Blocker = Schema.Struct({
  id: PositiveInt,
  number: PositiveInt,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  state_reason: Schema.NullOr(Schema.String),
  closed_at: Schema.NullOr(IsoDateTime),
  repository: Schema.Struct({
    full_name: Schema.String.check(
      Schema.isPattern(/^(?!\.{1,2}\/)[a-zA-Z0-9_.-]+\/(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/),
    ),
  }),
  pull_request: Schema.optional(
    Schema.Struct({ merged_at: Schema.optional(Schema.NullOr(IsoDateTime)) }),
  ),
});
const Parent = Schema.Struct({
  title: Schema.String,
  sub_issues_summary: Schema.optional(Schema.NullOr(Schema.Struct({ total: NonNegativeInt }))),
});
const Child = Schema.Struct({
  id: PositiveInt,
  number: PositiveInt,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  assignees: Schema.Array(Schema.Struct({ login: Schema.String })),
  repository: Blocker.fields.repository,
});
const TargetIdentity = Schema.Struct({ id: PositiveInt });
class ObservationFailure extends Schema.TaggedError<ObservationFailure>()(
  "FactoryRelationObservationFailure",
  {
    reason: FactoryReadinessReason,
    status: Schema.optional(Schema.Number),
  },
) {}
const statusFailure = (status: number) =>
  new ObservationFailure({
    status,
    reason:
      status === 404
        ? "inaccessible-blocker"
        : status === 301
          ? "moved-blocker"
          : status === 401
            ? "authentication"
            : status === 429
              ? "rate-limited"
              : "remote-failure",
  });
function requestFailure(error: GitHubApiError): ObservationFailure {
  switch (error._tag) {
    case "GitHubCliMissingError":
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubCliFailedError":
    case "GitHubApiAuthenticationError":
      return new ObservationFailure({ reason: "authentication" });
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return new ObservationFailure({ reason: "rate-limited" });
    case "GitHubApiNotFoundError":
      return statusFailure(404);
    case "GitHubApiResponseError":
      return statusFailure(error.status);
    case "GitHubApiRequestError":
      return new ObservationFailure({ reason: "remote-failure" });
  }
}

type Completeness = Pick<
  FactoryReadiness,
  "complete" | "listedCount" | "summaryTotal" | "observedAt"
> & {
  readonly reasons: readonly FactoryReadinessReason[];
};
type EdgeEvidence = Omit<FactoryReadinessEdge, "fingerprint" | "override">;
function encodeEdgeResolution(
  subject: { readonly canonicalKey: string; readonly issueNumber: number },
  edge: EdgeEvidence,
) {
  // The versioned preimage preserves nulls and excludes observation timestamps so refreshes
  // alone cannot lapse a decision. Changing this encoding requires a new version.
  return new TextEncoder().encode(
    JSON.stringify([
      "t3.factory.edge-resolution/1",
      subject.canonicalKey,
      subject.issueNumber,
      edge.targetHost,
      edge.targetId,
      edge.resolution,
      edge.state,
      edge.stateReason,
      edge.closedAt,
      edge.status,
    ]),
  );
}
function deriveReadiness(
  subject: "open" | "not-applicable" | "unknown",
  evidence: readonly FactoryReadinessEdge[],
  completeness: Completeness,
  storedOverrides: readonly Store.StoredOverride[],
): FactoryReadiness {
  const current = new Map(evidence.map((edge) => [`${edge.targetHost}/${edge.targetId}`, edge]));
  const active = new Map<string, FactoryReadinessOverride>();
  const overrides = storedOverrides.map((row): FactoryReadinessOverride => {
    const key = `${row.targetHost}/${row.targetId}`;
    const status =
      row.revokedAt !== null
        ? "revoked"
        : current.get(key)?.fingerprint === row.boundFingerprint
          ? "active"
          : "lapsed";
    const override: FactoryReadinessOverride = {
      id: row.id,
      kind: row.kind,
      targetHost: row.targetHost,
      targetId: row.targetId,
      boundFingerprint: row.boundFingerprint,
      reason: row.reason,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      status,
    };
    if (status === "active") active.set(key, override);
    return override;
  });
  const edges = evidence.map((edge) => ({
    ...edge,
    override: active.get(`${edge.targetHost}/${edge.targetId}`)?.id ?? null,
  }));
  if (subject === "not-applicable")
    return {
      ...completeness,
      edges,
      overrides,
      basis: null,
      status: "not-applicable",
      reasons: ["closed-subject"],
    };
  const reasons = new Set(completeness.reasons);
  let blocked = false;
  let waived = false;
  for (const edge of edges) {
    if (edge.status === "removed-at-source") continue;
    const override = active.get(`${edge.targetHost}/${edge.targetId}`);
    if (override?.kind === "force-not-ready") {
      blocked = true;
      reasons.add("overridden-not-ready");
      continue;
    }
    if (override?.kind === "waive") {
      waived = true;
      continue;
    }
    switch (edge.resolution) {
      case "open":
        blocked = true;
        reasons.add("open-blocker");
        break;
      case "closed-unaccepted":
        blocked = true;
        reasons.add("unaccepted-blocker");
        break;
      case "deleted":
        blocked = true;
        reasons.add("deleted-blocker");
        break;
      case "inaccessible":
        reasons.add("inaccessible-blocker");
        break;
      case "moved":
        reasons.add("moved-blocker");
        break;
      case "unverified":
        reasons.add("unverified-blocker");
        break;
      case "accepted":
        break;
    }
  }
  const status =
    completeness.complete && blocked
      ? "blocked"
      : !completeness.complete || subject === "unknown" || reasons.size > 0
        ? "unknown"
        : "ready";
  return {
    ...completeness,
    edges,
    overrides,
    reasons: [...reasons],
    status,
    basis: status === "ready" ? (waived ? "override" : "source") : null,
  };
}

function resolution(blocker: typeof Blocker.Type): FactoryReadinessEdge["resolution"] {
  if (blocker.pull_request !== undefined) {
    if (blocker.pull_request.merged_at != null) return "accepted";
  } else if (blocker.state === "closed" && blocker.state_reason === "completed") return "accepted";
  return blocker.state === "open" ? "open" : "closed-unaccepted";
}
function storedEvidence(edge: Store.StoredEdge): EdgeEvidence {
  return {
    ...edge,
    targetUrl: `https://${edge.targetHost}/${edge.targetRepository}/issues/${edge.targetNumber}`,
    title: null,
    state: null,
    stateReason: null,
    closedAt: null,
    resolution:
      edge.status === "present" || edge.status === "removed-at-source" ? "unverified" : edge.status,
  };
}
function includesSubjectCycle(
  subject: number,
  repository: FactoryRepository,
  edges: readonly Store.StoredEdge[],
) {
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    if (
      edge.status !== "present" ||
      edge.targetHost !== repository.host ||
      edge.targetRepository.toLowerCase() !== repository.repository.toLowerCase()
    )
      continue;
    const targets = adjacency.get(edge.issueNumber) ?? [];
    targets.push(edge.targetNumber);
    adjacency.set(edge.issueNumber, targets);
  }
  const pending = [...(adjacency.get(subject) ?? [])];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const target = pending.pop();
    if (target === undefined) break;
    if (target === subject) return true;
    if (visited.has(target)) continue;
    visited.add(target);
    pending.push(...(adjacency.get(target) ?? []));
  }
  return false;
}

// A Link may point anywhere. Only follow pages of the same endpoint on this API host.
function nextPage(link: string | undefined, api: string, endpoint: string): string | null {
  if (link === undefined) return null;
  for (const part of link.split(",")) {
    if (!/;\s*rel="[^"]*\bnext\b[^"]*"/.test(part)) continue;
    const href = /^\s*<([^>]+)>/.exec(part)?.[1];
    const url = href === undefined ? null : URL.parse(href, `${api}/`);
    const expected = new URL(`${api}/${endpoint}`);
    if (
      url === null ||
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.get("per_page") !== "100" ||
      !/^[1-9]\d*$/.test(url.searchParams.get("page") ?? "")
    )
      return "invalid";
    return `${endpoint}${url.search}`;
  }
  return null;
}

export class FactoryIssueRelations extends Context.Service<
  FactoryIssueRelations,
  {
    readonly read: (
      input: FactoryIssueReadinessReadInput,
    ) => Effect.Effect<FactoryIssueReadinessReadResult, FactoryIssueError>;
    readonly setOverride: (
      input: FactoryReadinessOverrideSetInput,
    ) => Effect.Effect<FactoryIssueReadinessReadResult, FactoryIssueError>;
    readonly revokeOverride: (
      input: FactoryReadinessOverrideRevokeInput,
    ) => Effect.Effect<FactoryIssueReadinessReadResult, FactoryIssueError>;
    readonly readFrontier: (
      input: FactoryIssueFrontierReadInput,
    ) => Effect.Effect<FactoryIssueFrontierReadResult, FactoryIssueError>;
  }
>()("t3/factory/FactoryIssueRelations") {}

const make = Effect.gen(function* () {
  const github = yield* GitHubRest.GitHubRest;
  const store = yield* Store.FactoryIssueRelationStore;
  const resolve = yield* makeRepositoryResolver;
  const crypto = yield* Crypto.Crypto;
  const fingerprintEdge = Effect.fn("FactoryIssueRelations.fingerprintEdge")(function* (
    subject: { readonly canonicalKey: string; readonly issueNumber: number },
    edge: EdgeEvidence,
  ): Effect.fn.Return<FactoryReadinessEdge> {
    const fingerprint = yield* crypto
      .digest("SHA-256", encodeEdgeResolution(subject, edge))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return { ...edge, fingerprint, override: null };
  });
  const storedFingerprint = Effect.fn("FactoryIssueRelations.storedFingerprint")(
    (edge: Store.StoredEdge) => fingerprintEdge(edge, storedEvidence(edge)),
  );
  const request = Effect.fn("FactoryIssueRelations.request")(function* (
    host: string,
    path: string,
  ) {
    const response = yield* github
      .rest({ host, path, operation: "FactoryIssueRelations.read" })
      .pipe(Effect.mapError(requestFailure));
    if (isRateLimited(response)) return yield* new ObservationFailure({ reason: "rate-limited" });
    if (response.status !== 200) return yield* statusFailure(response.status);
    if (response.truncated) return yield* new ObservationFailure({ reason: "truncated-response" });
    if (response.invalidUtf8) return yield* new ObservationFailure({ reason: "invalid-response" });
    return response;
  });
  const decodeSubject = Schema.decodeUnknownEffect(Schema.fromJsonString(Subject));
  const decodePage = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Schema.Unknown)),
  );
  const decodeBlocker = Schema.decodeUnknownOption(Blocker);
  const decodeTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(TargetIdentity));
  const invalidResponse = () => new ObservationFailure({ reason: "invalid-response" });
  const readRepositoryIssue = Effect.fn("FactoryIssueRelations.readRepositoryIssue")(function* (
    repository: FactoryRepository,
    input: Pick<FactoryIssueReadinessReadInput, "issueNumber">,
  ) {
    const subject = { canonicalKey: repository.canonicalKey, issueNumber: input.issueNumber };
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const result = (readiness: FactoryReadiness): FactoryIssueReadinessReadResult => ({
      repository,
      issueNumber: input.issueNumber,
      readiness,
    });
    let edges: FactoryReadinessEdge[] = [];
    const overrides = yield* store.listOverrides(subject);
    const observe = Effect.gen(function* () {
      const stored = yield* store.listEdges(subject);
      edges = yield* Effect.forEach(stored, storedFingerprint);
      const response = yield* request(
        repository.host,
        `repos/${repository.repository}/issues/${input.issueNumber}`,
      );
      const issue = yield* decodeSubject(response.body).pipe(Effect.mapError(invalidResponse));
      if (issue.state === "closed" || issue.pull_request !== undefined)
        return result(
          deriveReadiness(
            "not-applicable",
            [],
            {
              complete: false,
              listedCount: 0,
              summaryTotal: null,
              observedAt,
              reasons: [],
            },
            overrides,
          ),
        );
      const summaryTotal = issue.issue_dependencies_summary?.total_blocked_by ?? null;
      if (summaryTotal === null)
        return yield* new ObservationFailure({ reason: "summary-missing" });
      const endpoint = `repos/${repository.repository}/issues/${input.issueNumber}/dependencies/blocked_by`;
      let path: string | null = `${endpoint}?per_page=100&page=1`;
      const seen = new Set<string>();
      const present = new Map<number, FactoryReadinessEdge>();
      const previous = new Map(stored.map((edge) => [`${edge.targetHost}/${edge.targetId}`, edge]));
      const reasons = new Set<FactoryReadinessReason>();
      let listedCount = 0;
      while (path !== null && seen.size < 5) {
        if (seen.has(path) || path === "invalid") {
          reasons.add("partial-listing");
          break;
        }
        seen.add(path);
        const page = yield* request(repository.host, path).pipe(Effect.result);
        if (page._tag === "Failure") {
          reasons.add(page.failure.reason);
          break;
        }
        const decoded = yield* decodePage(page.success.body).pipe(
          Effect.mapError(invalidResponse),
          Effect.result,
        );
        if (decoded._tag === "Failure") {
          reasons.add(decoded.failure.reason);
          break;
        }
        listedCount += decoded.success.length;
        for (const value of decoded.success) {
          const blocker = decodeBlocker(value);
          if (Option.isNone(blocker)) {
            reasons.add("invalid-response");
            continue;
          }
          const item = blocker.value;
          if (present.has(item.id)) reasons.add("invalid-response");
          present.set(
            item.id,
            yield* fingerprintEdge(subject, {
              targetId: item.id,
              targetHost: repository.host,
              targetRepository: item.repository.full_name,
              targetNumber: item.number,
              targetUrl: item.html_url,
              title: item.title,
              state: item.state,
              stateReason: item.state_reason,
              closedAt: item.closed_at,
              resolution: resolution(item),
              status: "present",
              firstObservedAt:
                previous.get(`${repository.host}/${item.id}`)?.firstObservedAt ?? observedAt,
              lastObservedAt: observedAt,
            }),
          );
        }
        path = nextPage(page.success.headers.link, gitHubApiUrls(repository.host).rest, endpoint);
      }
      if (path !== null || listedCount !== summaryTotal) reasons.add("partial-listing");
      const complete = reasons.size === 0;
      const tombstones: Parameters<
        Store.FactoryIssueRelationStore["Service"]["recordComplete"]
      >[0]["tombstones"][number][] = [];
      if (complete) {
        for (const edge of stored) {
          if (
            edge.status !== "present" ||
            (edge.targetHost === repository.host && present.has(edge.targetId))
          )
            continue;
          const target = yield* request(
            edge.targetHost,
            `repos/${edge.targetRepository}/issues/${edge.targetNumber}`,
          ).pipe(
            Effect.flatMap((answer) =>
              decodeTarget(answer.body).pipe(Effect.mapError(invalidResponse)),
            ),
            Effect.result,
          );
          let status: Exclude<Store.StoredEdge["status"], "present">;
          if (target._tag === "Success")
            status = target.success.id === edge.targetId ? "removed-at-source" : "unverified";
          else {
            status =
              target.failure.status === 410
                ? "deleted"
                : target.failure.status === 404
                  ? "inaccessible"
                  : target.failure.status === 301
                    ? "moved"
                    : "unverified";
            if (status === "unverified") reasons.add(target.failure.reason);
          }
          tombstones.push({ targetHost: edge.targetHost, targetId: edge.targetId, status });
        }
        yield* store.recordComplete({
          subject,
          observedAt,
          listedCount,
          summaryTotal,
          present: [...present.values()],
          tombstones,
        });
        edges = yield* Effect.forEach(yield* store.listEdges(subject), (edge) => {
          const observed = present.get(edge.targetId);
          return observed === undefined ? storedFingerprint(edge) : Effect.succeed(observed);
        });
      } else {
        yield* store.recordFailure({ subject, observedAt, failure: [...reasons].join(",") });
        // Partial data can explain uncertainty, but it cannot remove a previously observed edge.
        edges = [
          ...present.values(),
          ...(yield* Effect.forEach(
            stored.filter((edge) => !present.has(edge.targetId)),
            storedFingerprint,
          )),
        ];
      }
      if (
        includesSubjectCycle(
          input.issueNumber,
          repository,
          yield* store.listEdges({ canonicalKey: repository.canonicalKey }),
        )
      )
        reasons.add("cycle");
      return result(
        deriveReadiness(
          "open",
          edges,
          {
            complete,
            listedCount,
            summaryTotal,
            observedAt,
            reasons: [...reasons],
          },
          overrides,
        ),
      );
    });
    return yield* observe.pipe(
      Effect.catch((error) => {
        const reason =
          error._tag === "FactoryRelationObservationFailure" ? error.reason : "remote-failure";
        return store.recordFailure({ subject, observedAt, failure: reason }).pipe(
          Effect.catch(() => Effect.void),
          Effect.as(
            result(
              deriveReadiness(
                "unknown",
                edges,
                {
                  complete: false,
                  listedCount: 0,
                  summaryTotal: null,
                  observedAt,
                  reasons: [reason],
                },
                overrides,
              ),
            ),
          ),
        );
      }),
    );
  });
  const read = Effect.fn("FactoryIssueRelations.read")(function* (
    input: FactoryIssueReadinessReadInput,
  ) {
    const { repository } = yield* resolve(input.projectId);
    return yield* readRepositoryIssue(repository, input);
  });
  const setOverride = Effect.fn("FactoryIssueRelations.setOverride")(function* (
    input: FactoryReadinessOverrideSetInput,
  ) {
    const { repository } = yield* resolve(input.projectId);
    const existing = yield* store.findOverrideCommand(input.commandId);
    if (Option.isSome(existing)) {
      if (
        existing.value.canonicalKey !== repository.canonicalKey ||
        existing.value.issueNumber !== input.issueNumber
      )
        return yield* new FactoryIssueError({ reason: "invalid-response" });
      return yield* readRepositoryIssue(repository, input);
    }
    const observed = yield* readRepositoryIssue(repository, input);
    const edge = observed.readiness.edges.find(
      (item) => item.targetHost === input.targetHost && item.targetId === input.targetId,
    );
    if (edge === undefined) return yield* new FactoryIssueError({ reason: "invalid-response" });
    if (edge.fingerprint !== input.expectedFingerprint)
      return yield* new FactoryIssueError({ reason: "readiness-changed" });
    if (
      !observed.readiness.complete ||
      observed.readiness.status === "not-applicable" ||
      (input.kind === "force-not-ready"
        ? edge.resolution !== "accepted"
        : edge.status === "present" ||
          edge.status === "removed-at-source" ||
          !["deleted", "inaccessible", "moved", "unverified"].includes(edge.resolution))
    )
      return yield* new FactoryIssueError({ reason: "override-not-allowed" });
    yield* store.setOverride({
      canonicalKey: observed.repository.canonicalKey,
      issueNumber: input.issueNumber,
      id: FactoryReadinessOverrideId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
      kind: input.kind,
      targetHost: input.targetHost,
      targetId: input.targetId,
      boundFingerprint: edge.fingerprint,
      reason: input.reason,
      requestCommandId: input.commandId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      revokedAt: null,
    });
    return yield* readRepositoryIssue(repository, input);
  });
  const revokeOverride = Effect.fn("FactoryIssueRelations.revokeOverride")(function* (
    input: FactoryReadinessOverrideRevokeInput,
  ) {
    const { repository } = yield* resolve(input.projectId);
    yield* store.revokeOverride({
      canonicalKey: repository.canonicalKey,
      issueNumber: input.issueNumber,
      overrideId: input.overrideId,
      revokedAt: DateTime.formatIso(yield* DateTime.now),
    });
    return yield* readRepositoryIssue(repository, input);
  });
  const decodeParent = Schema.decodeUnknownEffect(Schema.fromJsonString(Parent));
  const decodeChild = Schema.decodeUnknownOption(Child);
  const readFrontier = Effect.fn("FactoryIssueRelations.readFrontier")(function* (
    input: FactoryIssueFrontierReadInput,
  ): Effect.fn.Return<FactoryIssueFrontierReadResult, FactoryIssueError> {
    const { repository } = yield* resolve(input.projectId);
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const parentPath = `repos/${repository.repository}/issues/${input.parentIssueNumber}`;
    const parent = yield* request(repository.host, parentPath).pipe(
      Effect.flatMap((response) =>
        decodeParent(response.body).pipe(Effect.mapError(invalidResponse)),
      ),
      Effect.mapError(
        (cause) =>
          new FactoryIssueError({
            reason:
              cause.reason === "authentication" || cause.reason === "rate-limited"
                ? cause.reason
                : cause.reason === "invalid-response"
                  ? "invalid-response"
                  : "remote-failure",
            cause,
          }),
      ),
    );
    const summaryTotal = parent.sub_issues_summary?.total ?? null;
    const endpoint = `${parentPath}/sub_issues`;
    let path: string | null = `${endpoint}?per_page=100&page=1`;
    const seenPages = new Set<string>();
    const seenChildren = new Set<number>();
    const children: (typeof Child.Type)[] = [];
    let complete = summaryTotal !== null;
    while (path !== null && seenPages.size < 5) {
      if (path === "invalid" || seenPages.has(path)) {
        complete = false;
        break;
      }
      seenPages.add(path);
      const page = yield* request(repository.host, path).pipe(Effect.result);
      if (page._tag === "Failure") {
        complete = false;
        break;
      }
      const decoded = yield* decodePage(page.success.body).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        complete = false;
        break;
      }
      for (const value of decoded.success) {
        const item = decodeChild(value);
        if (Option.isNone(item) || seenChildren.has(item.value.id)) {
          complete = false;
          continue;
        }
        seenChildren.add(item.value.id);
        children.push(item.value);
      }
      path = nextPage(page.success.headers.link, gitHubApiUrls(repository.host).rest, endpoint);
    }
    complete = complete && path === null && children.length === summaryTotal;
    const frontier = yield* Effect.forEach(
      children,
      Effect.fn("FactoryIssueRelations.readFrontierChild")(
        function* (child): Effect.fn.Return<FactoryFrontierChild> {
          let readiness: FactoryReadiness | null = null;
          if (child.state === "open") {
            const unknown = deriveReadiness(
              "unknown",
              [],
              {
                complete: false,
                listedCount: 0,
                summaryTotal: null,
                observedAt,
                reasons: ["remote-failure"],
              },
              [],
            );
            // Native sub-issues may belong to a different repository; issue numbers alone
            // cannot identify which subject's evidence and overrides to read.
            const childRepository: FactoryRepository = {
              ...repository,
              repository: child.repository.full_name,
              canonicalKey: `${repository.host}/${child.repository.full_name.toLowerCase()}`,
              url: `https://${repository.host}/${child.repository.full_name}`,
            };
            readiness = yield* readRepositoryIssue(childRepository, {
              issueNumber: child.number,
            }).pipe(
              Effect.map((result) => result.readiness),
              Effect.orElseSucceed(() => unknown),
            );
          }
          return {
            number: child.number,
            title: child.title,
            state: child.state,
            url: child.html_url,
            assignees: child.assignees.map((assignee) => assignee.login),
            readiness,
          };
        },
      ),
      { concurrency: 1 },
    );
    return {
      repository,
      parentIssueNumber: input.parentIssueNumber,
      parentTitle: parent.title,
      complete,
      summaryTotal,
      children: frontier,
      observedAt,
    };
  });
  return FactoryIssueRelations.of({ read, setOverride, revokeOverride, readFrontier });
});
export const layer = Layer.effect(FactoryIssueRelations, make);
