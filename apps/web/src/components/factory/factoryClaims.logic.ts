import {
  FactoryOriginKey,
  type EnvironmentId,
  type FactoryClaim,
  type FactoryClaimListResult,
  type FactoryIssueTask,
  type ProjectId,
} from "@t3tools/contracts";

/**
 * Origin keys are compared across environments, so this is the server's encoding byte for byte
 * (`apps/server/src/factory/FactoryOriginKey.ts` owns the definition). Each component escapes
 * `%`, `|`, `#` and `:` so a locator or item key can never forge a neighbouring field; slashes and
 * every other character pass through untouched.
 */
function escapeOriginComponent(value: string): string {
  return value.replace(
    /[%|#:]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

export function originKeyForIssue(repositoryKey: string, issueNumber: number): FactoryOriginKey {
  return FactoryOriginKey.make(`github:${escapeOriginComponent(repositoryKey)}#${issueNumber}`);
}

export function originKeyForFeedItem(
  repositoryKey: string,
  locator: string,
  itemKey: string,
): FactoryOriginKey {
  return FactoryOriginKey.make(
    `feed:${escapeOriginComponent(repositoryKey)}|${escapeOriginComponent(locator)}|${escapeOriginComponent(itemKey)}`,
  );
}

/**
 * `copied-database`: every environment holds the same thread, which is what a copied database
 * looks like. `duplicate-execution`: at least two different threads exist for one origin, so the
 * work runs more than once.
 */
export type FactoryClaimConflictKind = "duplicate-execution" | "copied-database";

export interface FactoryClaimConflict {
  readonly kind: FactoryClaimConflictKind;
  /** Every environment that holds a claim for the origin, in the order they were supplied. */
  readonly environments: ReadonlyArray<EnvironmentId>;
}

/**
 * Origins claimed in two or more environments. An environment that did not answer is simply absent
 * from the map, so this never reports "no conflict" for an origin it could not see; callers list
 * unreadable environments separately. Claims never merge, so nothing here picks a winner.
 */
export function claimConflicts(
  claimsByEnvironment: ReadonlyMap<EnvironmentId, FactoryClaimListResult>,
): ReadonlyMap<FactoryOriginKey, FactoryClaimConflict> {
  const holders = new Map<FactoryOriginKey, Map<EnvironmentId, Set<string>>>();
  for (const [environmentId, result] of claimsByEnvironment) {
    for (const claim of result.claims) {
      let byEnvironment = holders.get(claim.originKey);
      if (byEnvironment === undefined) {
        byEnvironment = new Map();
        holders.set(claim.originKey, byEnvironment);
      }
      let threads = byEnvironment.get(environmentId);
      if (threads === undefined) {
        threads = new Set();
        byEnvironment.set(environmentId, threads);
      }
      threads.add(claim.threadId);
    }
  }
  const conflicts = new Map<FactoryOriginKey, FactoryClaimConflict>();
  for (const [originKey, byEnvironment] of holders) {
    if (byEnvironment.size < 2) continue;
    const distinctThreads = new Set<string>();
    for (const threads of byEnvironment.values()) {
      for (const thread of threads) distinctThreads.add(thread);
    }
    conflicts.set(originKey, {
      kind: distinctThreads.size === 1 ? "copied-database" : "duplicate-execution",
      environments: [...byEnvironment.keys()],
    });
  }
  return conflicts;
}

export type FactoryClaimProvenance = "this-environment" | "another-environment" | "unknown";

/**
 * Provenance is what the row recorded when it was written; ownership is whoever answers for it.
 * `answeringEnvironmentId` is the environment that returned the claim, never a guess by the
 * client. Rows written before provenance existed carry no value and stay unknown.
 */
export function claimProvenance(
  claim: Pick<FactoryClaim, "admittedBy">,
  answeringEnvironmentId: EnvironmentId,
): FactoryClaimProvenance {
  if (claim.admittedBy === null) return "unknown";
  return claim.admittedBy === answeringEnvironmentId ? "this-environment" : "another-environment";
}

export function describeClaimProvenance(provenance: FactoryClaimProvenance): string {
  switch (provenance) {
    case "this-environment":
      return "Admitted by this environment.";
    case "another-environment":
      return "Admitted by another environment. This database was copied or restored; this environment answers for the claim now.";
    case "unknown":
      return "Provenance unknown. The claim was recorded before provenance tracking.";
  }
}

export interface FactoryClaimElsewhere {
  readonly environmentId: EnvironmentId;
  readonly claim: FactoryClaim;
}

/** Claims for the origin held by any environment other than the one that would start the work. */
export function claimsElsewhere(
  claimsByEnvironment: ReadonlyMap<EnvironmentId, FactoryClaimListResult>,
  originKey: FactoryOriginKey,
  environmentId: EnvironmentId,
): ReadonlyArray<FactoryClaimElsewhere> {
  const elsewhere: FactoryClaimElsewhere[] = [];
  for (const [holder, result] of claimsByEnvironment) {
    if (holder === environmentId) continue;
    for (const claim of result.claims) {
      if (claim.originKey === originKey) elsewhere.push({ environmentId: holder, claim });
    }
  }
  return elsewhere;
}

/** The answering environment's own claim behind a row's task, matched by origin and thread. */
export function claimForTask(
  result: FactoryClaimListResult | undefined,
  originKey: FactoryOriginKey,
  task: Pick<FactoryIssueTask, "threadId"> | null,
): FactoryClaim | null {
  if (result === undefined || task === null) return null;
  return (
    result.claims.find(
      (claim) => claim.originKey === originKey && claim.threadId === task.threadId,
    ) ?? null
  );
}

type EnvironmentLabel = (environmentId: EnvironmentId) => string;

export interface FactoryClaimConflictPresentation {
  readonly badge: string;
  readonly detail: string;
}

export function describeClaimConflict(
  conflict: FactoryClaimConflict,
  labelOf: EnvironmentLabel,
): FactoryClaimConflictPresentation {
  const labels = conflict.environments.map(labelOf).join(", ");
  const badge = `Claimed in ${conflict.environments.length} environments`;
  return conflict.kind === "copied-database"
    ? {
        badge,
        detail: `${labels} hold the same thread, which looks like a copied database. Nothing merges; the environment that answers for the thread owns the work.`,
      }
    : {
        badge,
        detail: `${labels} each started their own thread for this origin, so the work runs more than once. Nothing merges; decide which attempt to keep.`,
      };
}

/**
 * The Start and Admit dialogs warn but never block: a claim elsewhere may be a stale copy, and the
 * server still guards this environment's own claim.
 */
export function describeClaimsElsewhere(
  elsewhere: ReadonlyArray<FactoryClaimElsewhere>,
  labelOf: EnvironmentLabel,
): string | null {
  if (elsewhere.length === 0) return null;
  const holders = elsewhere.map(
    ({ environmentId, claim }) => `${labelOf(environmentId)} (${claim.status})`,
  );
  return `Already claimed in ${holders.join(", ")}. Starting here begins a separate attempt in this environment; nothing merges.`;
}

export interface FactoryClaimRowPresentation {
  readonly conflict: FactoryClaimConflictPresentation | null;
  /** Older records in the answering environment that already claim this origin more than once. */
  readonly duplicates: FactoryClaimConflictPresentation | null;
  readonly provenance: string | null;
  readonly acceptedCommit?: {
    readonly shortSha: string;
    readonly acceptedAt: string;
  };
  readonly acceptedArtifact?: {
    readonly shortSha: string;
    readonly acceptedAt: string;
  };
}

/**
 * What one row shows about its origin. The provenance line needs the row's own task, so an origin
 * with no task here, or whose claim list has not answered, shows no provenance rather than a guess.
 */
export function factoryClaimRowPresentation(input: {
  readonly claimsByEnvironment: ReadonlyMap<EnvironmentId, FactoryClaimListResult>;
  readonly conflicts: ReadonlyMap<FactoryOriginKey, FactoryClaimConflict>;
  readonly environmentId: EnvironmentId;
  readonly originKey: FactoryOriginKey;
  readonly task: Pick<FactoryIssueTask, "threadId"> | null;
  readonly labelOf: EnvironmentLabel;
}): FactoryClaimRowPresentation {
  const conflict = input.conflicts.get(input.originKey);
  const result = input.claimsByEnvironment.get(input.environmentId);
  const claim = claimForTask(result, input.originKey, input.task);
  const sameOrigin = result?.claims.filter((entry) => entry.originKey === input.originKey) ?? [];
  return {
    conflict: conflict === undefined ? null : describeClaimConflict(conflict, input.labelOf),
    duplicates: sameOrigin.some((entry) => entry.originConflict)
      ? {
          badge: "Claimed more than once",
          detail: `${input.labelOf(input.environmentId)} holds ${sameOrigin.length} older claims for this origin. Nothing is merged and further admissions are refused; review the conflicting tasks.`,
        }
      : null,
    provenance:
      claim === null || result === undefined
        ? null
        : describeClaimProvenance(claimProvenance(claim, result.environmentId)),
    ...(claim?.acceptance == null || claim.baseRef === null
      ? {}
      : {
          acceptedCommit: {
            shortSha: claim.acceptance.headSha.slice(0, 7),
            acceptedAt: claim.acceptance.acceptedAt,
          },
        }),
    ...(claim?.artifactAcceptance == null
      ? {}
      : {
          acceptedArtifact: {
            shortSha: claim.artifactAcceptance.sha256.slice(0, 7),
            acceptedAt: claim.artifactAcceptance.acceptedAt,
          },
        }),
  };
}

/** The owning checkout's title when a task lives in another checkout of the same repository. */
export function claimOwnerTitle(
  task: Pick<FactoryIssueTask, "projectId"> | null,
  selectedProjectId: ProjectId,
  projectTitleById: ReadonlyMap<ProjectId, string>,
): string | null {
  if (task === null || task.projectId === selectedProjectId) return null;
  return projectTitleById.get(task.projectId) ?? "another project";
}

export interface FactoryClaimEnvironmentFacts {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly claimsSupported: boolean;
  readonly canRead: boolean;
}

export interface FactoryClaimProjectFacts {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly repositoryKey: string | null;
}

export interface FactoryClaimTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export type FactoryClaimsUnavailableReason = "offline" | "unsupported" | "no-access" | "failed";

export interface FactoryClaimsUnavailable {
  readonly environmentId: EnvironmentId;
  readonly reason: FactoryClaimsUnavailableReason;
}

/**
 * One request per environment that holds a checkout of the same repository. The claim list is
 * repository-wide inside an environment, so a second checkout there adds nothing. The selected
 * environment is always asked first; every other environment that has a matching checkout but
 * cannot answer is reported as unreadable instead of being treated as having no claims.
 */
export function planClaimTargets(input: {
  readonly current: FactoryClaimTarget & { readonly repositoryKey: string | null };
  readonly environments: ReadonlyArray<FactoryClaimEnvironmentFacts>;
  readonly projects: ReadonlyArray<FactoryClaimProjectFacts>;
}): {
  readonly targets: ReadonlyArray<FactoryClaimTarget>;
  readonly unavailable: ReadonlyArray<FactoryClaimsUnavailable>;
} {
  const targets: FactoryClaimTarget[] = [
    { environmentId: input.current.environmentId, projectId: input.current.projectId },
  ];
  const unavailable: FactoryClaimsUnavailable[] = [];
  const repositoryKey = input.current.repositoryKey?.toLowerCase() ?? null;
  if (repositoryKey === null) return { targets, unavailable };
  for (const environment of input.environments) {
    if (environment.environmentId === input.current.environmentId) continue;
    const project = input.projects.find(
      (candidate) =>
        candidate.environmentId === environment.environmentId &&
        candidate.repositoryKey?.toLowerCase() === repositoryKey,
    );
    if (project === undefined) continue;
    if (!environment.connected) {
      unavailable.push({ environmentId: environment.environmentId, reason: "offline" });
    } else if (!environment.claimsSupported) {
      unavailable.push({ environmentId: environment.environmentId, reason: "unsupported" });
    } else if (!environment.canRead) {
      unavailable.push({ environmentId: environment.environmentId, reason: "no-access" });
    } else {
      targets.push({ environmentId: environment.environmentId, projectId: project.id });
    }
  }
  return { targets, unavailable };
}

const UNAVAILABLE_LABELS: Record<FactoryClaimsUnavailableReason, string> = {
  offline: "offline",
  unsupported: "server needs an update",
  "no-access": "no read access",
  failed: "request failed",
};

/**
 * Environments that may hold claims but did not answer. This is never worded as "no claims": an
 * origin can be claimed in an environment this client could not read.
 */
export function describeUnavailableClaims(
  unavailable: ReadonlyArray<FactoryClaimsUnavailable>,
  labelOf: EnvironmentLabel,
): string | null {
  if (unavailable.length === 0) return null;
  const list = unavailable
    .map(({ environmentId, reason }) => `${labelOf(environmentId)} (${UNAVAILABLE_LABELS[reason]})`)
    .join(", ");
  return `Claims could not be read from ${list}. An origin may be claimed there too.`;
}
