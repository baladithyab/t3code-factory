import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import { createFactoryEnvironmentAtoms } from "@t3tools/client-runtime/state/factory";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useContext } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations, environmentSummaries } from "./presentation";

export const factoryEnvironment = createFactoryEnvironmentAtoms(connectionAtomRuntime);

/**
 * A server advertises `factoryFeeds` only when it implements the protocol; older servers omit it,
 * which this treats as unsupported rather than as an empty source list.
 */
const factoryFeedEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.environmentIdsAtom).filter(
    (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryFeeds === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null && arrayElementsEqual(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-factory-feed-environment-ids"));

const factoryFeedsSupportedAtom = Atom.make(
  (get) => get(factoryFeedEnvironmentIdsAtom).length > 0,
).pipe(Atom.withLabel("web-factory-feeds-supported"));

export function useFactoryFeedsSupported(): boolean {
  return useAtomValue(factoryFeedsSupportedAtom);
}

/**
 * Research protocols are read and launched per checkout, so the sidebar only offers them once an
 * environment advertises `factoryResearch`; older servers omit it and would reject the methods.
 */
const factoryResearchEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.environmentIdsAtom).filter(
    (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryResearch === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null && arrayElementsEqual(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-factory-research-environment-ids"));

const factoryResearchSupportedAtom = Atom.make(
  (get) => get(factoryResearchEnvironmentIdsAtom).length > 0,
).pipe(Atom.withLabel("web-factory-research-supported"));

export function useFactoryResearchSupported(): boolean {
  return useAtomValue(factoryResearchSupportedAtom);
}

const factoryKnowledgeEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.environmentIdsAtom).filter(
    (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryKnowledge === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null && arrayElementsEqual(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-factory-knowledge-environment-ids"));

const factoryKnowledgeSupportedAtom = Atom.make(
  (get) => get(factoryKnowledgeEnvironmentIdsAtom).length > 0,
).pipe(Atom.withLabel("web-factory-knowledge-supported"));

export function useFactoryKnowledgeSupported(): boolean {
  return useAtomValue(factoryKnowledgeSupportedAtom);
}

/**
 * Readiness is requested from one environment at a time, so support is read per environment: an
 * older server omits `factoryReadiness`, and asking it would fail with an unknown method.
 */
const factoryReadinessSupportedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryReadiness === true,
  ).pipe(Atom.withLabel(`web-factory-readiness-supported:${environmentId}`)),
);

export function useFactoryReadinessSupported(environmentId: EnvironmentId): boolean {
  return useAtomValue(factoryReadinessSupportedAtom(environmentId));
}

/**
 * A claim list is requested from one environment at a time, so support is read per environment:
 * an older server omits `factoryClaims` and would reject the method.
 */
const factoryClaimsSupportedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryClaims === true,
  ).pipe(Atom.withLabel(`web-factory-claims-supported:${environmentId}`)),
);

export function useFactoryClaimsSupported(environmentId: EnvironmentId): boolean {
  return useAtomValue(factoryClaimsSupportedAtom(environmentId));
}

export interface FactoryClaimListTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const FactoryClaimTargetsKey = Schema.fromJsonString(
  Schema.Array(Schema.Tuple([EnvironmentId, ProjectId])),
);
const decodeFactoryClaimTargetsKey = Schema.decodeUnknownOption(FactoryClaimTargetsKey);

/**
 * The list is keyed by its targets, so renders that rebuild an equal list read the same atom
 * instead of a new one whose fresh snapshot would schedule another render.
 */
const factoryClaimListsAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    Option.getOrElse(decodeFactoryClaimTargetsKey(key), () => []).map(
      ([environmentId, projectId]) => ({
        environmentId,
        result: get(factoryEnvironment.listClaims({ environmentId, input: { projectId } })),
      }),
    ),
  ).pipe(Atom.withLabel(`web-factory-claim-lists:${key}`)),
);

/**
 * One claim list per target, with a refresh that observes every target again. Nothing refreshes on
 * a timer: a claim another environment just admitted appears only on an explicit refresh.
 */
export function useFactoryClaimLists(targets: ReadonlyArray<FactoryClaimListTarget>) {
  const registry = useContext(RegistryContext);
  const lists = useAtomValue(
    factoryClaimListsAtom(
      JSON.stringify(targets.map(({ environmentId, projectId }) => [environmentId, projectId])),
    ),
  );
  const refresh = () => {
    for (const { environmentId, projectId } of targets) {
      registry.refresh(factoryEnvironment.listClaims({ environmentId, input: { projectId } }));
    }
  };
  return { lists, refresh };
}
