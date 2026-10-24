import { useAtomValue } from "@effect/atom-react";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import { createFactoryEnvironmentAtoms } from "@t3tools/client-runtime/state/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations, environmentSummaries } from "./presentation";

export const factoryEnvironment = createFactoryEnvironmentAtoms(connectionAtomRuntime);

/**
 * A server advertises `factoryIssues` only when it implements the protocol; older servers omit it,
 * which this treats as unsupported rather than as an empty inbox.
 */
export const factoryIssueEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.environmentIdsAtom).filter(
    (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryIssues === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null && arrayElementsEqual(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-factory-issue-environment-ids"));

const factoryIssuesSupportedAtom = Atom.make(
  (get) => get(factoryIssueEnvironmentIdsAtom).length > 0,
).pipe(Atom.withLabel("web-factory-issues-supported"));

export function useFactoryIssuesSupported(): boolean {
  return useAtomValue(factoryIssuesSupportedAtom);
}

export function useFactoryIssueEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(factoryIssueEnvironmentIdsAtom);
}
