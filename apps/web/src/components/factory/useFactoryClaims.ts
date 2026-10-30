import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryClaimListResult,
  type FactoryOriginKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useFactoryClaimLists, useFactoryClaimsSupported } from "../../state/factory";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  claimConflicts,
  describeUnavailableClaims,
  planClaimTargets,
  type FactoryClaimConflict,
  type FactoryClaimsUnavailable,
} from "./factoryClaims.logic";

export interface FactoryClaimsView {
  /** Only environments that answered. An absent environment is unknown, never "no claims". */
  readonly claimsByEnvironment: ReadonlyMap<EnvironmentId, FactoryClaimListResult>;
  readonly conflicts: ReadonlyMap<FactoryOriginKey, FactoryClaimConflict>;
  /** Wording for environments that may hold claims but did not answer, or null when all did. */
  readonly unavailableNote: string | null;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  /** Observes every environment again; claims never refresh on their own. */
  readonly refresh: () => void;
}

/**
 * Claims for the selected checkout's repository across every connected environment that holds a
 * checkout of it. Null while the selected environment does not advertise `factoryClaims`, so older
 * servers show no claim UI at all rather than a half-informed one.
 */
export function useFactoryClaims(input: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
}): FactoryClaimsView | null {
  const { environmentId, project } = input;
  const supported = useFactoryClaimsSupported(environmentId);
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const readableIds = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);

  const plan = planClaimTargets({
    current: {
      environmentId,
      projectId: project.id,
      repositoryKey: project.repositoryIdentity?.canonicalKey ?? null,
    },
    environments: environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connected: environment.connection.phase === "connected",
      claimsSupported: environment.serverConfig?.environment.capabilities.factoryClaims === true,
      canRead: readableIds.has(environment.environmentId),
    })),
    projects: allProjects.map((candidate) => ({
      environmentId: candidate.environmentId,
      id: candidate.id,
      repositoryKey: candidate.repositoryIdentity?.canonicalKey ?? null,
    })),
  });
  const { lists, refresh } = useFactoryClaimLists(supported ? plan.targets : []);

  const claimsByEnvironment = new Map<EnvironmentId, FactoryClaimListResult>();
  const failed: FactoryClaimsUnavailable[] = [];
  for (const { environmentId: target, result } of lists) {
    // A failed refetch keeps the previous success in the result; stale claims would read as
    // current, so a failure is reported as unreadable and its old data is dropped.
    if (result._tag === "Failure") {
      failed.push({ environmentId: target, reason: "failed" });
      continue;
    }
    const value = Option.getOrNull(AsyncResult.value(result));
    if (value !== null) claimsByEnvironment.set(target, value);
  }

  if (!supported) return null;
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  return {
    claimsByEnvironment,
    conflicts: claimConflicts(claimsByEnvironment),
    unavailableNote: describeUnavailableClaims([...plan.unavailable, ...failed], labelOf),
    labelOf,
    refresh,
  };
}
