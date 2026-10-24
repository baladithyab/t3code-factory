import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProjectId, RuntimeMode } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { FACTORY_DEFAULT_RUNTIME_MODE, type FactoryIssueFilter } from "./factoryIssues";

/**
 * What the user chose for this inbox. It outlives the model and branch picker routes that sit
 * on top of the inbox, so those routes edit it rather than owning a copy.
 */
export interface FactoryInboxSelection {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly filter: FactoryIssueFilter;
  /** Null until the user picks one; the project's default applies until then. */
  readonly modelSelection: ModelSelection | null;
  /** Null starts from the project's current local HEAD. */
  readonly baseRef: string | null;
  readonly runtimeMode: RuntimeMode;
}

const INITIAL_SELECTION: FactoryInboxSelection = {
  environmentId: null,
  projectId: null,
  filter: "open",
  modelSelection: null,
  baseRef: null,
  runtimeMode: FACTORY_DEFAULT_RUNTIME_MODE,
};

export const factoryInboxSelectionAtom = Atom.make<FactoryInboxSelection>(INITIAL_SELECTION).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-factory-inbox-selection"),
);

export function useFactoryInboxSelection(): FactoryInboxSelection {
  return useAtomValue(factoryInboxSelectionAtom);
}

export function updateFactoryInboxSelection(patch: Partial<FactoryInboxSelection>): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) => ({ ...current, ...patch }));
}

/** A different project has different models, branches, and a different repository. */
export function selectFactoryInboxProject(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) =>
    current.environmentId === environmentId && current.projectId === projectId
      ? current
      : {
          ...current,
          environmentId,
          projectId,
          modelSelection: null,
          baseRef: null,
        },
  );
}
