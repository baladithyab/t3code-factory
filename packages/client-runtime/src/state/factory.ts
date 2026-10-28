import {
  WS_METHODS,
  type EnvironmentId,
  type FactoryResearchProtocolId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createFactoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const coordinatorsGet = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:factory:coordinators:get",
    tag: WS_METHODS.projectCoordinatorsGet,
    staleTimeMs: 0,
  });
  const coordinatorsList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:factory:coordinators:list",
    tag: WS_METHODS.projectCoordinatorsList,
    staleTimeMs: 0,
  });
  // Observed blocker evidence for one issue. `staleTimeMs: 0` makes every mount observe again and
  // a refresh re-observe, since the server derives readiness on each read rather than caching it.
  const readIssueReadiness = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:factory:issue-readiness",
    tag: WS_METHODS.factoryReadIssueReadiness,
    staleTimeMs: 0,
  });
  // An override changes the verdict the server derives, and a failed response can still follow a
  // persisted change, so every outcome observes the issue again rather than trusting local state.
  const refreshIssueReadiness = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId; readonly issueNumber: number };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(
        readIssueReadiness({
          environmentId: target.environmentId,
          input: { projectId: target.input.projectId, issueNumber: target.input.issueNumber },
        }),
      );
    });
  // The protocol, its runs and the derived finding are read together so the reviewer never sees a
  // finding paired with runs from another read. Every mount and refresh observes again because the
  // server derives acceptability and the finding on each read rather than storing them.
  const listResearchProtocols = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:factory:research-protocols",
    tag: WS_METHODS.factoryListResearchProtocols,
    staleTimeMs: 0,
  });
  const readResearchProtocol = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:factory:research-protocol",
    tag: WS_METHODS.factoryReadResearchProtocol,
    staleTimeMs: 0,
  });
  // A launch or admission can persist a run or a reserved intent before a failed response, so every
  // outcome reads the protocol again rather than trusting what the page last showed.
  const refreshResearchProtocol = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: {
        readonly projectId: ProjectId;
        readonly protocolId: FactoryResearchProtocolId;
      };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(
        readResearchProtocol({
          environmentId: target.environmentId,
          input: { projectId: target.input.projectId, protocolId: target.input.protocolId },
        }),
      );
    });
  // The live head and `current` are derived from the worktree on every read, so an accepted commit
  // that has since moved must show as stale on mount and refresh, never from a cached result.
  const readAcceptance = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:factory:acceptance",
    tag: WS_METHODS.factoryReadAcceptance,
    staleTimeMs: 0,
  });
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:issues",
      tag: WS_METHODS.factoryListIssues,
      staleTimeMs: 0,
    }),
    readIssueReadiness,
    // Claims are read from every connected environment that holds a checkout of the repository, so
    // a page can compare them. Every mount and refresh observes again: a claim another environment
    // just admitted must show up on the explicit Refresh, never from a cached list.
    listClaims: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:claims",
      tag: WS_METHODS.factoryListClaims,
      staleTimeMs: 0,
    }),
    readAcceptance,
    // The head the reviewer saw is part of the key: accepting a different head is a different
    // decision and never joins an in-flight request. A failed response can still follow a persisted
    // acceptance, so every outcome reads the task's acceptance again.
    acceptCommit: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:accept-commit",
      tag: WS_METHODS.factoryAcceptCommit,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.threadId, input.expectedHeadSha]),
      },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(
            readAcceptance({
              environmentId,
              input: { projectId: input.projectId, threadId: input.threadId },
            }),
          );
        }),
    }),
    // Read-only composition of a parent's sub-issues. Each read re-observes every child, so it is
    // fetched only while its panel is open and again on an explicit refresh, never inbox-wide.
    readIssueFrontier: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:issue-frontier",
      tag: WS_METHODS.factoryReadIssueFrontier,
      staleTimeMs: 0,
    }),
    // Coalesces one reviewed decision on one edge. The fingerprint is the resolution the reviewer
    // saw, so a later review of a changed edge is never merged into an earlier request.
    setIssueReadinessOverride: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:set-issue-readiness-override",
      tag: WS_METHODS.factorySetIssueReadinessOverride,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.issueNumber,
            input.targetHost,
            input.targetId,
            input.kind,
            input.expectedFingerprint,
          ]),
      },
      onSettled: refreshIssueReadiness,
    }),
    revokeIssueReadinessOverride: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:revoke-issue-readiness-override",
      tag: WS_METHODS.factoryRevokeIssueReadinessOverride,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.issueNumber, input.overrideId]),
      },
      onSettled: refreshIssueReadiness,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:start-issue",
      tag: WS_METHODS.factoryStartIssue,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.expectedRepositoryKey,
            input.issueNumber,
            input.expectedIssueRevision,
          ]),
      },
    }),
    listFeedSources: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:feed-sources",
      tag: WS_METHODS.factoryListFeedSources,
      staleTimeMs: 0,
    }),
    listFeedCandidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:feed-candidates",
      tag: WS_METHODS.factoryListFeedCandidates,
      staleTimeMs: 0,
    }),
    readFeedCandidate: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:feed-candidate",
      tag: WS_METHODS.factoryReadFeedCandidate,
      staleTimeMs: 0,
    }),
    bindFeedSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:bind-feed-source",
      tag: WS_METHODS.factoryBindFeedSource,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.url]),
      },
    }),
    unbindFeedSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:unbind-feed-source",
      tag: WS_METHODS.factoryUnbindFeedSource,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.sourceId]),
      },
    }),
    refreshFeedSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:refresh-feed-source",
      tag: WS_METHODS.factoryRefreshFeedSource,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.sourceId]),
      },
    }),
    setFeedCandidateDismissed: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:set-feed-candidate-dismissed",
      tag: WS_METHODS.factorySetFeedCandidateDismissed,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.sourceId,
            input.itemKey,
            input.expectedRevision,
            input.dismissed,
          ]),
      },
    }),
    admitFeedCandidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:admit-feed-candidate",
      tag: WS_METHODS.factoryAdmitFeedCandidate,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.expectedRepositoryKey,
            input.sourceId,
            input.itemKey,
            input.expectedRevision,
          ]),
      },
    }),
    listResearchProtocols,
    readResearchProtocol,
    // Sealing hashes the base commit's evaluators server-side. One command id is one sealing
    // attempt, so only a retry of the same attempt coalesces; two distinct protocols never do.
    sealResearchProtocol: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:seal-research-protocol",
      tag: WS_METHODS.factorySealResearchProtocol,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.commandId]),
      },
      // The new protocol has no read of its own yet; the list is what changed, even after a
      // failed response that followed a persisted seal.
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(
            listResearchProtocols({ environmentId, input: { projectId: input.projectId } }),
          );
        }),
    }),
    // A launch spends one run of the sealed budget. The revision the reviewer saw is part of the
    // key so a launch against a replaced protocol is never merged into an earlier request.
    launchResearchRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:launch-research-run",
      tag: WS_METHODS.factoryLaunchResearchRun,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.protocolId,
            input.role,
            input.expectedProtocolRevision,
          ]),
      },
      onSettled: refreshResearchProtocol,
    }),
    // The finding revision is the evidence the reviewer approved; a different revision is a
    // different decision and never joins an in-flight admission.
    admitResearchImplementation: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:admit-research-implementation",
      tag: WS_METHODS.factoryAdmitResearchImplementation,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.protocolId,
            input.expectedFindingRevision,
          ]),
      },
      onSettled: refreshResearchProtocol,
    }),
    coordinatorsGet,
    coordinatorsList,
    coordinatorsEnsure: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:coordinators:ensure",
      tag: WS_METHODS.projectCoordinatorsEnsure,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.expectedThreadId]),
      },
      // A failed response can still follow a persisted binding or an accepted launch.
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(
            coordinatorsGet({ environmentId, input: { projectId: input.projectId } }),
          );
          registry.refresh(coordinatorsList({ environmentId, input: {} }));
        }),
    }),
  };
}

// Review text must expose hidden characters without deleting task content or making a literal
// backslash escape indistinguishable from a control character.
export function factoryIssueReviewText(value: string): string {
  return value.replace(/(?![\t\n])[\p{Cc}\p{Cf}\p{Cs}\\]/gu, (character) => {
    if (character === "\\") return "\\\\";
    let escaped = "";
    for (let index = 0; index < character.length; index += 1) {
      escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    return escaped;
  });
}
